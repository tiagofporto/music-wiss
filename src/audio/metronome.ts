import { Fraction } from '../model/fraction';
import type { Score, TimeSignature } from '../model/score';
import { effectiveTimeSignature } from '../model/score';
import { perform } from './sequencer';

/**
 * Metrônomo do Music Wiss: cliques que seguem a fórmula de compasso de cada
 * compasso (inclusive mudanças no meio da música e repetições), com padrões
 * rítmicos, contagem antes de começar e andamento de estudo.
 */

export type ClickLevel = 'accent' | 'beat' | 'sub';

export type MetroPattern = 'tempos' | 'primeiro' | 'colcheias' | 'tercinas' | 'semicolcheias' | 'contratempo';

export const PATTERNS: Array<{ id: MetroPattern; name: string; hint: string }> = [
  { id: 'tempos', name: 'Tempos', hint: 'um clique por tempo, o 1º mais forte' },
  { id: 'primeiro', name: 'Só o 1º', hint: 'só o primeiro tempo de cada compasso' },
  { id: 'colcheias', name: 'Colcheias', hint: 'tempo dividido em 2' },
  { id: 'tercinas', name: 'Tercinas', hint: 'tempo dividido em 3' },
  { id: 'semicolcheias', name: 'Semicolcheias', hint: 'tempo dividido em 4' },
  { id: 'contratempo', name: 'Contratempo', hint: 'clique entre os tempos' },
];

export interface MetroSettings {
  /** Andamento de estudo em semínimas por minuto; null = o da partitura. */
  bpm: number | null;
  pattern: MetroPattern;
  /** 0–1 */
  volume: number;
  /** Um compasso de contagem antes de começar. */
  countIn: boolean;
  /** Tocar as notas da partitura junto com os cliques. */
  withScore: boolean;
  /** Metrônomo ligado ao apertar Ouvir. */
  on: boolean;
  /** Aba Editar (PDF/foto, sem partitura escrita): andamento e compasso escolhidos à mão. */
  docBpm: number;
  docTs: string;
}

/** Fórmulas de compasso oferecidas para ler PDFs e fotos. */
export const DOC_TIME_SIGNATURES = ['2/4', '3/4', '4/4', '2/2', '3/8', '6/8', '9/8', '12/8', '5/4', '7/8'];

/** Lê "6/8" como fórmula de compasso (cai em 4/4 se for estranho). */
export function parseTimeSig(v: string): TimeSignature {
  const m = /^(\d{1,2})\/(1|2|4|8|16)$/.exec(v.trim());
  const beats = m ? Number(m[1]) : 0;
  return m && beats >= 1 && beats <= 16 ? { beats, beatType: Number(m[2]) } : { beats: 4, beatType: 4 };
}

export const DEFAULT_SETTINGS: MetroSettings = { bpm: null, pattern: 'tempos', volume: 0.7, countIn: true, withScore: true, on: false, docBpm: 80, docTs: '4/4' };

export const MIN_BPM = 30;
export const MAX_BPM = 240;

export function clampBpm(v: number): number {
  return Math.round(Math.max(MIN_BPM, Math.min(MAX_BPM, Number.isFinite(v) ? v : 96)));
}

/** Lê as preferências guardadas, ignorando valores estranhos. */
export function parseSettings(raw: string | null): MetroSettings {
  try {
    const s = raw ? (JSON.parse(raw) as Partial<MetroSettings>) : {};
    return {
      bpm: typeof s.bpm === 'number' ? clampBpm(s.bpm) : null,
      pattern: PATTERNS.some((p) => p.id === s.pattern) ? (s.pattern as MetroPattern) : DEFAULT_SETTINGS.pattern,
      volume: typeof s.volume === 'number' ? Math.max(0, Math.min(1, s.volume)) : DEFAULT_SETTINGS.volume,
      countIn: typeof s.countIn === 'boolean' ? s.countIn : DEFAULT_SETTINGS.countIn,
      withScore: typeof s.withScore === 'boolean' ? s.withScore : DEFAULT_SETTINGS.withScore,
      on: typeof s.on === 'boolean' ? s.on : DEFAULT_SETTINGS.on,
      docBpm: typeof s.docBpm === 'number' ? clampBpm(s.docBpm) : DEFAULT_SETTINGS.docBpm,
      docTs: typeof s.docTs === 'string' && DOC_TIME_SIGNATURES.includes(s.docTs) ? s.docTs : DEFAULT_SETTINGS.docTs,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Pulsação do compasso: 4/4 tem 4 tempos de semínima; 6/8, 9/8 e 12/8 são
 * compostos (tempos de semínima pontuada); 2/2 tem 2 tempos de mínima.
 */
export function beatsOf(ts: TimeSignature): { count: number; unit: Fraction } {
  if (ts.beatType >= 8 && ts.beats > 3 && ts.beats % 3 === 0) {
    return { count: ts.beats / 3, unit: new Fraction(3, ts.beatType) };
  }
  return { count: ts.beats, unit: new Fraction(1, ts.beatType) };
}

export interface MeasureClick {
  /** Posição dentro do compasso, em semibreves. */
  offset: Fraction;
  level: ClickLevel;
  /** Tempo (0 = primeiro) a que o clique pertence. */
  beat: number;
}

/** Cliques de um compasso com o padrão escolhido. */
export function clicksForMeasure(ts: TimeSignature, pattern: MetroPattern): MeasureClick[] {
  const { count, unit } = beatsOf(ts);
  const compound = !unit.eq(new Fraction(1, ts.beatType));
  const out: MeasureClick[] = [];
  const split = pattern === 'colcheias' || pattern === 'contratempo' ? 2 : pattern === 'tercinas' ? 3 : pattern === 'semicolcheias' ? 4 : 1;
  // compasso composto: a divisão natural é em 3 (as colcheias de 6/8)
  const subs = compound && (pattern === 'colcheias' || pattern === 'tercinas') ? 3 : split;
  for (let b = 0; b < count; b++) {
    const start = unit.mul(new Fraction(b, 1));
    if (pattern === 'primeiro' && b > 0) continue;
    if (pattern === 'contratempo') {
      if (b === 0) out.push({ offset: start, level: 'accent', beat: b });
      out.push({ offset: start.add(unit.div(new Fraction(2, 1))), level: 'beat', beat: b });
      continue;
    }
    out.push({ offset: start, level: b === 0 ? 'accent' : 'beat', beat: b });
    for (let s = 1; s < subs; s++) out.push({ offset: start.add(unit.mul(new Fraction(s, subs))), level: 'sub', beat: b });
  }
  return out;
}

export interface Click {
  /** Segundos desde o início (a contagem fica antes do zero, em negativo). */
  at: number;
  level: ClickLevel;
  beat: number;
  /** Quantos tempos tem o compasso. */
  beats: number;
  /** Compasso escrito (0 = primeiro); -1 = contagem. */
  measure: number;
}

/** Segundos por semibreve num andamento (semínimas por minuto). */
export const secondsPerWholeAt = (bpm: number) => (60 / bpm) * 4;

/**
 * Cliques para a partitura inteira (repetições desdobradas), a partir de um
 * ponto escrito. Com contagem, um compasso de cliques vem antes do zero.
 */
export function buildClicks(score: Score, opts: { from?: Fraction; bpm: number; pattern: MetroPattern; countIn: boolean }): { clicks: Click[]; leadIn: number; total: number } {
  const from = opts.from ?? Fraction.ZERO;
  const spw = secondsPerWholeAt(opts.bpm);
  const { measures, end } = perform(score);
  const seg = measures.find((m) => from.gte(m.written) && from.lt(m.written.add(m.length)));
  const playedFrom = seg ? seg.played.add(from.sub(seg.written)) : end;
  const offset = playedFrom.toNumber();
  const clicks: Click[] = [];
  // o fim é o fim do último compasso (os cliques continuam até a barra final)
  const last = measures[measures.length - 1];
  const stop = last ? last.played.add(last.length) : end;
  for (const m of measures) {
    const ts = effectiveTimeSignature(score, m.measure);
    const beats = beatsOf(ts).count;
    for (const c of clicksForMeasure(ts, opts.pattern)) {
      if (!c.offset.lt(m.length)) continue;
      const at = m.played.add(c.offset);
      if (at.lt(playedFrom) || !at.lt(stop)) continue;
      clicks.push({ at: (at.toNumber() - offset) * spw, level: c.level, beat: c.beat, beats, measure: m.measure });
    }
  }
  let leadIn = 0;
  if (opts.countIn) {
    const first = seg ?? measures[0];
    const ts = effectiveTimeSignature(score, first?.measure ?? 0);
    const { count, unit } = beatsOf(ts);
    const beatSec = unit.toNumber() * spw;
    leadIn = count * beatSec;
    for (let b = 0; b < count; b++) clicks.push({ at: -leadIn + b * beatSec, level: b === 0 ? 'accent' : 'beat', beat: b, beats: count, measure: -1 });
    clicks.sort((a, b) => a.at - b.at);
  }
  return { clicks, leadIn, total: Math.max(0, (stop.toNumber() - offset) * spw) };
}

/** Cliques de um compasso solto (metrônomo sem partitura), em segundos desde o início do compasso. */
export function freeBar(ts: TimeSignature, bpm: number, pattern: MetroPattern): { clicks: Array<Omit<Click, 'measure'>>; length: number } {
  const spw = secondsPerWholeAt(bpm);
  const beats = beatsOf(ts).count;
  return {
    clicks: clicksForMeasure(ts, pattern).map((c) => ({ at: c.offset.toNumber() * spw, level: c.level, beat: c.beat, beats })),
    length: (ts.beats / ts.beatType) * spw,
  };
}

/** Andamento a partir dos toques (média dos últimos intervalos; recomeça após 2 s parado). */
export function tapTempo(taps: number[]): number | null {
  const recent: number[] = [];
  for (let i = taps.length - 1; i > 0 && recent.length < 6; i--) {
    const gap = taps[i] - taps[i - 1];
    if (gap > 2000 || gap <= 0) break;
    recent.push(gap);
  }
  if (!recent.length) return null;
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  return clampBpm(60000 / avg);
}

/** A partitura no andamento de estudo (sem mexer na original). */
export function atTempo(score: Score, bpm: number | null): Score {
  return bpm && bpm !== score.tempo ? { ...score, tempo: bpm } : score;
}
