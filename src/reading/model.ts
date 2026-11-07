import { Fraction } from '../model/fraction';
import type { TimeSignature } from '../model/score';
import type { ClickLevel, MetroPattern } from '../audio/metronome';
import { beatsOf, clampBpm, clicksForMeasure, parseTimeSig } from '../audio/metronome';
import type { MeasureReading } from './glyphs';
import { isSmufl, readStaff, splitGlyphs, summarize } from './glyphs';
import type { PageStructure } from './raster';
import type { TempoText, TextItem, TimeSigText } from './text';
import { parseTempoMarks, parseTimeSignatures } from './text';

/**
 * Mapa da leitura de um PDF/foto: os compassos achados na página, com fórmula,
 * andamento e avisos. É o que a pessoa revisa e corrige antes de tocar.
 * Tudo aqui é JSON simples (fica guardado junto com o documento).
 */

export type PageKind = 'digital' | 'scanned' | 'image';

export interface ReadingPage {
  kind: PageKind;
  /** Achou texto que dá para ler (só PDF digital). */
  hasText: boolean;
  systems: number;
}

export type FlagKind = 'pickup' | 'irregular' | 'barline' | 'gradual' | 'fermata' | 'rubato' | 'tempo-word' | 'empty' | 'tuplet' | 'duration';

export interface Flag {
  kind: FlagKind;
  text: string;
}

export interface TempoMark {
  kind: 'set' | 'gradual' | 'return' | 'fermata' | 'rubato';
  bpm: number | null;
  label: string;
  source: 'text' | 'word' | 'user';
}

export interface ReadMeasure {
  id: string;
  page: number;
  /** Sistema (linha de música) na página. */
  system: number;
  /** Caixa na página, em frações (0–1) da largura/altura. */
  box: { x: number; y: number; w: number; h: number };
  noteHeads: number;
  /** Notas e pausas lidas dos símbolos do PDF digital (fontes SMuFL). */
  content?: {
    summary: string;
    quarters: number;
    exact: boolean;
    notes: number;
    rests: number;
    tuplets: number;
    /** Compasso inteiro de pausa. */
    fullRest: boolean;
  };
  /** Confiança das barras (0–1). */
  confidence: number;
  heavyEnd: boolean;
  /** Fórmula que começa aqui ("3/4"), se mudou neste compasso. */
  ts?: string;
  tsSource?: 'text' | 'user';
  /** Andamento escrito neste compasso. */
  tempo?: TempoMark;
  /** Duração em tempos, quando o compasso não é cheio (anacruse, irregular). */
  beats?: number;
  /** Não é compasso de verdade (barra achada por engano etc.). */
  skip?: boolean;
  flags: Flag[];
  /** A pessoa conferiu este compasso. */
  ok?: boolean;
}

export interface ReadingMap {
  version: 1;
  pages: ReadingPage[];
  measures: ReadMeasure[];
  initialTempo: { bpm: number | null; label: string; source: 'text' | 'word' | 'user' | null };
  initialTs: { value: string | null; source: 'text' | 'user' | null };
  /** Avisos gerais (página escaneada sem texto etc.). */
  notes: string[];
  confirmed: boolean;
  createdAt: number;
}

export interface PageInput {
  kind: PageKind;
  structure: PageStructure;
  /** Texto da página na mesma escala da imagem (vazio em scan e foto). */
  text: TextItem[];
}

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Monta o mapa a partir do que foi achado em cada página. */
export function buildReadingMap(pages: PageInput[]): ReadingMap {
  const measures: ReadMeasure[] = [];
  const tempos: Array<{ t: TempoText; measure: number }> = [];
  const sigs: Array<{ t: TimeSigText; measure: number }> = [];
  const notes: string[] = [];

  pages.forEach((p, pi) => {
    const st = p.structure;
    const base = measures.length;
    st.measures.forEach((m, mi) => {
      measures.push({
        id: `p${pi + 1}s${m.system + 1}m${mi + 1}`,
        page: pi,
        system: m.system,
        box: { x: m.x0 / st.width, y: m.top / st.height, w: (m.x1 - m.x0) / st.width, h: (m.bottom - m.top) / st.height },
        noteHeads: m.noteHeads,
        confidence: Math.round(m.confidence * 100) / 100,
        heavyEnd: m.heavyEnd,
        flags: [],
      });
    });
    if (!p.text.length) return;
    const glyphs = splitGlyphs(p.text);
    if (glyphs.some((g) => [...g.str].some(isSmufl))) {
      // clave e armadura passam de um compasso para o seguinte na mesma pauta
      const carry = new Map<string, { clef: 'G' | 'F' | 'C' | null; fifths: number }>();
      st.measures.forEach((m, mi) => {
        const sys = st.systems[m.system];
        const staves = sys.staves.map((band, k) => {
          const key = `${m.system}:${k}`;
          const c = readStaff(glyphs, band, m.x0, m.x1, carry.get(key) ?? { clef: null, fifths: 0 }, sys.staves);
          carry.set(key, { clef: c.clef, fifths: c.fifths });
          return c;
        });
        const sum = summarize(staves);
        if (sum) measures[base + mi].content = contentOf(sum);
      });
    }
    const pageMeasures = st.measures.map((m, k) => ({ m, k: base + k }));
    // andamento: vale para o compasso logo abaixo/à direita do texto
    for (const t of parseTempoMarks(p.text)) {
      const sys = st.systems.findIndex((s) => t.y < s.bottom && t.y > s.top - (s.bottom - s.top + 40) * 1.5);
      const target =
        sys >= 0
          ? pageMeasures.filter(({ m }) => m.system === sys).find(({ m }) => t.x < m.x1) ?? pageMeasures.filter(({ m }) => m.system === sys).pop()
          : // texto acima de tudo (título): vale para o primeiro compasso da página
            t.y < (st.systems[0]?.top ?? Infinity)
            ? pageMeasures[0]
            : undefined;
      if (target) tempos.push({ t, measure: target.k });
    }
    for (const t of parseTimeSignatures(glyphs, st.staves)) {
      const target = pageMeasures.find(({ m }) => t.y > m.top && t.y < m.bottom && t.x >= m.x0 - 4 && t.x < m.x1);
      if (target) sigs.push({ t, measure: target.k });
    }
  });

  // fórmulas: a primeira vira a inicial; as outras são mudanças
  let initialTs: ReadingMap['initialTs'] = { value: null, source: null };
  let lastTs: string | null = null;
  for (const { t, measure } of sigs) {
    const v = `${t.beats}/${t.beatType}`;
    if (!initialTs.value && measure <= firstReal(measures)) {
      initialTs = { value: v, source: 'text' };
      lastTs = v;
      continue;
    }
    if (!initialTs.value) {
      initialTs = { value: v, source: 'text' };
      lastTs = v;
    }
    // fórmula repetida no começo de cada sistema não é mudança
    if (v !== lastTs) {
      measures[measure].ts = v;
      measures[measure].tsSource = 'text';
      lastTs = v;
    }
  }

  // andamento inicial: o primeiro número de metrônomo; senão uma palavra (estimativa)
  let initialTempo: ReadingMap['initialTempo'] = { bpm: null, label: '', source: null };
  const first = firstReal(measures);
  for (const { t, measure } of tempos) {
    const atStart = measure <= first;
    if (atStart && (t.kind === 'set' || t.kind === 'word') && (initialTempo.source !== 'text' || !initialTempo.bpm)) {
      if (t.kind === 'set' || initialTempo.source === null) initialTempo = { bpm: t.bpm, label: t.label, source: t.kind === 'set' ? 'text' : 'word' };
      continue;
    }
    if (atStart && initialTempo.source && (t.kind === 'set' || t.kind === 'word')) continue;
    const m = measures[measure];
    const kind = t.kind === 'word' ? 'set' : t.kind;
    // marca mais forte ganha: número > palavra > aviso
    if (m.tempo && m.tempo.kind === 'set' && m.tempo.source === 'text') continue;
    m.tempo = { kind, bpm: t.bpm, label: t.label, source: t.kind === 'word' ? 'word' : 'text' };
    if (t.kind === 'word') m.flags.push({ kind: 'tempo-word', text: `"${t.label}" não diz o número exato; usei ${t.bpm} como estimativa. Confira.` });
    if (t.kind === 'gradual') m.flags.push({ kind: 'gradual', text: `"${t.label}": muda o andamento aos poucos. O metrônomo não acompanha isso sozinho; marque um novo andamento se quiser.` });
    if (t.kind === 'fermata') m.flags.push({ kind: 'fermata', text: 'Fermata: a nota se prolonga à vontade. O metrônomo segue o tempo escrito.' });
    if (t.kind === 'rubato') m.flags.push({ kind: 'rubato', text: `"${t.label}": tempo livre. O metrônomo não tem como acompanhar com precisão.` });
  }
  if (initialTempo.source === 'word') notes.push(`Andamento inicial estimado a partir de "${initialTempo.label}". Confira o número.`);

  // compassos estranhos: anacruse, largura fora do normal, barra duvidosa, soma que não fecha
  flagShapes(measures, initialTs.value);

  if (!pages.length || !measures.length) notes.push('Não encontrei pautas de 5 linhas. A página pode estar torta, borrada ou ser só texto.');
  const scanned = pages.filter((p) => p.kind !== 'digital').length;
  if (scanned) {
    const what = scanned === pages.length ? 'A música está em imagem' : `${scanned} página(s) têm a música em imagem`;
    notes.push(
      `${what} (escaneado, foto ou exportado como figura): pautas e barras foram achadas pela imagem, e só o texto que o PDF tiver de verdade foi lido. Confira com mais atenção.`,
    );
  }
  if (!initialTs.value && measures.length) notes.push('Não consegui ler a fórmula de compasso. Escolha a certa antes de tocar.');
  if (!initialTempo.bpm && measures.length) notes.push('Não achei o andamento (♩ = …). Informe as batidas por minuto antes de tocar.');

  return {
    version: 1,
    pages: pages.map((p) => ({ kind: p.kind, hasText: p.text.length > 0, systems: p.structure.systems.length })),
    measures,
    initialTempo,
    initialTs,
    notes,
    confirmed: false,
    createdAt: Date.now(),
  };
}

function firstReal(measures: ReadMeasure[]): number {
  const i = measures.findIndex((m) => !m.skip);
  return i < 0 ? 0 : i;
}

function contentOf(r: MeasureReading): NonNullable<ReadMeasure['content']> {
  const shown = r.events.slice(0, 8).map((e) => e.label);
  return {
    summary: shown.join(', ') + (r.events.length > 8 ? ` … (+${r.events.length - 8})` : ''),
    quarters: Math.round(r.quarters * 1000) / 1000,
    exact: r.exact,
    notes: r.notes,
    rests: r.rests,
    tuplets: r.tuplets,
    fullRest: r.fullRest,
  };
}

/** Duração do compasso cheio, em semínimas. */
const capacityQuarters = (ts: string | null) => {
  const t = parseTimeSig(ts ?? '4/4');
  return (t.beats / t.beatType) * 4;
};

/** Marca anacruse provável, compassos com largura estranha, barras duvidosas e somas que não fecham. */
export function flagShapes(measures: ReadMeasure[], initialTs: string | null = null) {
  for (const m of measures) m.flags = m.flags.filter((f) => !['pickup', 'irregular', 'barline', 'empty', 'tuplet', 'duration'].includes(f.kind));
  const real = measures.filter((m) => !m.skip);
  // largura comparada só com compassos do mesmo sistema (cada linha tem um espaçamento)
  const bySystem = new Map<string, ReadMeasure[]>();
  for (const m of real) {
    const k = `${m.page}:${m.system}`;
    bySystem.set(k, [...(bySystem.get(k) ?? []), m]);
  }
  const allHeads = median(real.map((m) => m.noteHeads).filter((n) => n > 0));
  for (const [, list] of bySystem) {
    // o primeiro compasso da linha leva clave e armadura: fica fora da mediana
    const widths = list.slice(1).map((m) => m.box.w);
    const w = median(widths.length ? widths : list.map((m) => m.box.w));
    list.forEach((m, i) => {
      const ratio = m.box.w / (w || m.box.w);
      if (i > 0 && (ratio < 0.4 || ratio > 2.2)) {
        m.flags.push({ kind: 'irregular', text: `Compasso ${ratio < 1 ? 'bem mais estreito' : 'bem mais largo'} que os vizinhos: pode ser barra a mais ou a menos, ou compasso irregular.` });
      }
    });
  }
  const first = real[0];
  if (first && real.length > 2) {
    const sys = real.filter((m) => m.page === first.page && m.system === first.system);
    const others = sys.slice(1).map((m) => m.noteHeads);
    const typical = median(others.length ? others : [allHeads]);
    if (!first.content && typical >= 2 && first.noteHeads > 0 && first.noteHeads <= typical / 2) {
      first.flags.push({ kind: 'pickup', text: `Pode ser anacruse: tem ${first.noteHeads} cabeça(s) de nota, contra ${Math.round(typical)} nos outros. Diga quantos tempos ela tem.` });
    }
  }
  // soma das figuras lidas do PDF digital × fórmula de compasso
  let ts = initialTs;
  real.forEach((m, i) => {
    if (m.ts) ts = m.ts;
    const c = m.content;
    if (!c || !ts || c.fullRest) return;
    if (c.tuplets) m.flags.push({ kind: 'tuplet', text: 'Tem quiáltera: a soma das figuras não foi conferida. O metrônomo segue o compasso escrito.' });
    const cap = capacityQuarters(ts);
    const t = parseTimeSig(ts);
    const unitQ = (beatsOf(t).unit.toNumber() * 4) || 1;
    const fmt = (q: number) => `${Math.round((q / unitQ) * 100) / 100} tempo(s)`;
    if (c.tuplets || Math.abs(c.quarters - cap) < 0.01) return;
    // notas pretas sem bandeirola podem ser colcheias com viga: a soma é só o máximo
    if (!c.exact && c.quarters > cap) return;
    const short = c.quarters < cap;
    if (i === 0 && short) {
      if (!m.flags.some((f) => f.kind === 'pickup')) {
        m.flags.push({ kind: 'pickup', text: `Anacruse: as figuras somam ${c.exact ? '' : 'no máximo '}${fmt(c.quarters)}, e o compasso pede ${fmt(cap)}. Confira quantos tempos ela tem.` });
      }
      return;
    }
    if (i === real.length - 1 && short && real[0].flags.some((f) => f.kind === 'pickup')) {
      m.flags.push({ kind: 'duration', text: `Último compasso incompleto (${fmt(c.quarters)}): costuma completar a anacruse.` });
      return;
    }
    m.flags.push({ kind: 'duration', text: `As figuras somam ${c.exact ? '' : 'no máximo '}${fmt(c.quarters)}, mas ${ts} pede ${fmt(cap)}. Pode ser compasso irregular, mudança de fórmula ou leitura errada.` });
  });
  for (const m of real) {
    if (m.confidence < 0.7) m.flags.push({ kind: 'barline', text: 'Não tenho certeza se uma das barras deste compasso é barra mesmo (pode ser haste de nota).' });
    if (!m.content && allHeads >= 2 && m.noteHeads === 0) m.flags.push({ kind: 'empty', text: 'Não achei notas pretas aqui: pode ser pausa, nota longa (branca) ou um compasso que não existe.' });
  }
}

/** Fórmula que vale num compasso. */
export function tsAt(map: ReadingMap, index: number): TimeSignature {
  let v = map.initialTs.value ?? '4/4';
  for (let i = 0; i <= index && i < map.measures.length; i++) if (map.measures[i].ts && !map.measures[i].skip) v = map.measures[i].ts!;
  return parseTimeSig(v);
}

/** Andamento escrito que vale num compasso (semínimas por minuto). */
export function tempoAt(map: ReadingMap, index: number): number {
  const initial = map.initialTempo.bpm ?? 80;
  let bpm = initial;
  for (let i = 0; i <= index && i < map.measures.length; i++) {
    const t = map.measures[i].tempo;
    if (!t || map.measures[i].skip) continue;
    if (t.kind === 'set' && t.bpm) bpm = t.bpm;
    else if (t.kind === 'return' && /tempo\s+(i|1|primo)/i.test(t.label)) bpm = initial;
  }
  return bpm;
}

/** O que falta para poder tocar (sem isso, não começa). */
export function blockers(map: ReadingMap): string[] {
  const out: string[] = [];
  if (!map.measures.some((m) => !m.skip)) out.push('Nenhum compasso encontrado.');
  if (!map.initialTs.value) out.push('Escolha a fórmula de compasso.');
  if (!map.initialTempo.bpm) out.push('Informe o andamento inicial.');
  return out;
}

/** Avisos ainda não conferidos. */
export function openFlags(map: ReadingMap): Array<{ index: number; flag: Flag }> {
  const out: Array<{ index: number; flag: Flag }> = [];
  map.measures.forEach((m, index) => !m.skip && !m.ok && m.flags.forEach((flag) => out.push({ index, flag })));
  return out;
}

/** Junta um compasso com o próximo do mesmo sistema (barra achada por engano). */
export function mergeWithNext(map: ReadingMap, index: number): boolean {
  const a = map.measures[index];
  const b = map.measures[index + 1];
  if (!a || !b || a.page !== b.page || a.system !== b.system) return false;
  const x1 = Math.max(a.box.x + a.box.w, b.box.x + b.box.w);
  a.box = { x: Math.min(a.box.x, b.box.x), y: Math.min(a.box.y, b.box.y), w: x1 - Math.min(a.box.x, b.box.x), h: Math.max(a.box.h, b.box.h) };
  a.noteHeads += b.noteHeads;
  if (a.content && b.content) {
    a.content = { ...a.content, summary: `${a.content.summary}, ${b.content.summary}`, quarters: a.content.quarters + b.content.quarters, exact: a.content.exact && b.content.exact, notes: a.content.notes + b.content.notes, rests: a.content.rests + b.content.rests, tuplets: a.content.tuplets + b.content.tuplets, fullRest: a.content.fullRest && b.content.fullRest };
  } else a.content = a.content ?? b.content;
  a.heavyEnd = b.heavyEnd;
  a.confidence = Math.min(1, Math.max(a.confidence, b.confidence));
  a.tempo ??= b.tempo;
  a.ts ??= b.ts;
  map.measures.splice(index + 1, 1);
  flagShapes(map.measures, map.initialTs.value);
  return true;
}

/** Divide um compasso em dois (faltou achar uma barra). */
export function splitMeasure(map: ReadingMap, index: number): boolean {
  const a = map.measures[index];
  if (!a) return false;
  const half = a.box.w / 2;
  const b: ReadMeasure = { ...a, content: undefined, id: `${a.id}b`, box: { ...a.box, x: a.box.x + half, w: half }, noteHeads: Math.floor(a.noteHeads / 2), tempo: undefined, ts: undefined, flags: [], ok: false, beats: undefined };
  a.box = { ...a.box, w: half };
  a.noteHeads -= b.noteHeads;
  a.heavyEnd = false;
  a.content = undefined;
  map.measures.splice(index + 1, 0, b);
  flagShapes(map.measures, map.initialTs.value);
  return true;
}

export interface PlayOptions {
  /** true: segue as mudanças de andamento escritas; false: BPM fixo. */
  follow: boolean;
  fixedBpm: number;
  /** Velocidade ao seguir a partitura (1 = 100%). */
  speed: number;
  pattern: MetroPattern;
}

export interface BarClicks {
  index: number;
  bpm: number;
  /** Duração do compasso em segundos. */
  length: number;
  beats: number;
  clicks: Array<{ at: number; level: ClickLevel; beat: number }>;
}

/** Andamento de um compasso conforme a escolha (seguir a partitura ou fixo). */
export function bpmFor(map: ReadingMap, index: number, opts: PlayOptions): number {
  return opts.follow ? clampBpm(tempoAt(map, index) * opts.speed) : clampBpm(opts.fixedBpm);
}

/** Cliques de um compasso, em segundos desde o começo dele. */
export function barClicks(map: ReadingMap, index: number, opts: PlayOptions): BarClicks {
  const ts = tsAt(map, index);
  const bpm = bpmFor(map, index, opts);
  const spw = (60 / bpm) * 4;
  const { count, unit } = beatsOf(ts);
  const full = new Fraction(ts.beats, ts.beatType);
  const m = map.measures[index];
  const beatsHere = m?.beats && m.beats > 0 ? m.beats : count;
  const length = unit.mul(new Fraction(Math.round(beatsHere * 2), 2));
  const all = clicksForMeasure(ts, opts.pattern);
  let clicks: BarClicks['clicks'];
  if (beatsHere < count) {
    // anacruse: são os últimos tempos do compasso (a contagem continua de onde parou)
    const start = full.sub(length);
    clicks = all.filter((c) => c.offset.gte(start)).map((c) => ({ at: c.offset.sub(start).toNumber() * spw, level: c.level, beat: c.beat }));
    // o primeiro clique da anacruse não é o "1": não acentua
    clicks = clicks.map((c) => ({ ...c, level: c.level === 'accent' ? 'beat' : c.level }));
  } else {
    clicks = all.map((c) => ({ at: c.offset.toNumber() * spw, level: c.level, beat: c.beat }));
    // compasso mais longo que a fórmula: tempos extras
    for (let b = count; b < beatsHere; b++) clicks.push({ at: unit.mul(new Fraction(b, 1)).toNumber() * spw, level: 'beat', beat: b });
  }
  return { index, bpm, length: length.toNumber() * spw, beats: Math.ceil(beatsHere), clicks };
}

/** Compassos tocáveis em ordem, a partir de um índice. */
export function playOrder(map: ReadingMap, from = 0): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i < map.measures.length; i++) if (!map.measures[i].skip) out.push(i);
  return out;
}

/** Duração total (segundos), para mostrar e testar. */
export function totalSeconds(map: ReadingMap, opts: PlayOptions, from = 0): number {
  return playOrder(map, from).reduce((a, i) => a + barClicks(map, i, opts).length, 0);
}

/** Lê um mapa guardado, descartando o que estiver estragado. */
export function sanitizeMap(raw: unknown): ReadingMap | null {
  const m = raw as ReadingMap | null;
  if (!m || m.version !== 1 || !Array.isArray(m.measures) || !Array.isArray(m.pages)) return null;
  return m;
}
