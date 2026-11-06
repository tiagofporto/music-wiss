import { Fraction } from './fraction';
import type { Duration } from './duration';
import { durationValue } from './duration';
import type { Fifths } from './key';
import type { Clef, Pitch } from './pitch';
import type { Annotation } from '../annotate/annotations';

/**
 * Modelo de dados hierárquico:
 * Score → Part → Staff → Measure → Voice → Event (Chord | Rest) → Note
 */

export interface TimeSignature {
  beats: number;
  beatType: number;
}

export interface Note {
  id: string;
  pitch: Pitch;
  /** Ligadura de prolongamento para a próxima nota de mesma altura. */
  tieToNext: boolean;
}

/** Quiáltera: `actual` notas no tempo de `normal` (tercina = 3 no tempo de 2). */
export interface Tuplet {
  id: string;
  actual: number;
  normal: number;
}

/** Dinâmicas (intensidade a partir deste evento). */
export type Dynamic = 'ppp' | 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff' | 'fff' | 'fp' | 'sfz';
export const DYNAMICS: Dynamic[] = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'fp', 'sfz'];

export type Articulation = 'staccato' | 'staccatissimo' | 'tenuto' | 'accent' | 'marcato' | 'fermata';
export const ARTICULATIONS: Articulation[] = ['staccato', 'staccatissimo', 'tenuto', 'accent', 'marcato', 'fermata'];
export const ARTICULATION_NAMES_PT: Record<Articulation, string> = {
  staccato: 'Staccato',
  staccatissimo: 'Staccatissimo',
  tenuto: 'Tenuto',
  accent: 'Acento',
  marcato: 'Marcato',
  fermata: 'Fermata',
};

/** Marcas de expressão e texto presas a um evento. */
export interface Marks {
  dynamic?: Dynamic;
  articulations?: Articulation[];
  /** Sílaba da letra (estrofe 1). Terminada em "-" = a palavra continua na próxima nota. */
  lyric?: string;
  /** Cifra (ex.: "C", "Am7", "G/B"). */
  chordSymbol?: string;
}

export function cloneMarks(m: Marks | undefined): Marks | undefined {
  if (!m) return undefined;
  const out: Marks = { ...m };
  if (m.articulations) out.articulations = [...m.articulations];
  return out;
}

/** Remove campos vazios; devolve undefined se não sobrou nada. */
export function tidyMarks(m: Marks | undefined): Marks | undefined {
  if (!m) return undefined;
  const out: Marks = {};
  if (m.dynamic) out.dynamic = m.dynamic;
  if (m.articulations?.length) out.articulations = ARTICULATIONS.filter((a) => m.articulations!.includes(a));
  if (m.lyric?.trim()) out.lyric = m.lyric.trim();
  if (m.chordSymbol?.trim()) out.chordSymbol = m.chordSymbol.trim();
  return Object.keys(out).length ? out : undefined;
}

interface EventBase {
  id: string;
  /** Só no primeiro pedaço de uma nota dividida. */
  marks?: Marks;
  duration: Duration;
  /** Eventos com o mesmo tuplet.id formam um grupo que nunca é dividido. */
  tuplet?: Tuplet;
  /**
   * Quando uma nota atravessa a barra de compasso ela é dividida em pedaços
   * ligados. Todos os pedaços guardam o id do evento original aqui.
   */
  fragmentOf?: string;
}

export interface ChordEvent extends EventBase {
  kind: 'chord';
  notes: Note[];
}

export interface RestEvent extends EventBase {
  kind: 'rest';
  /** Pausa provisória de uma quiáltera: a próxima nota digitada ocupa o lugar dela. */
  placeholder?: boolean;
  /** Pausa criada só para completar o compasso antes de uma quiáltera que não cabia (some ao reorganizar). */
  filler?: boolean;
  /** Pausa criada automaticamente ao levar o cursor para uma voz/pauta mais curta. */
  auto?: boolean;
}

export type MusicEvent = ChordEvent | RestEvent;

export interface Voice {
  events: MusicEvent[];
}

export type Barline = 'single' | 'double' | 'final' | 'repeat-start' | 'repeat-end';

export interface Measure {
  id: string;
  /** Até 4 vozes independentes (polifonia). */
  voices: Voice[];
  barline: Barline;
}

export interface Staff {
  id: string;
  clef: Clef;
  measures: Measure[];
}

export interface Part {
  id: string;
  name: string;
  instrument: string;
  /** Programa General MIDI (0–127). */
  midiProgram: number;
  /** Transposição em semitons entre o escrito e o som real (Si♭ = -2). */
  transposition: number;
  /** Volume na reprodução (0–1, padrão 0,8). */
  volume?: number;
  /** Sem som na reprodução. */
  muted?: boolean;
  staves: Staff[];
}

/** Mudança de fórmula de compasso e/ou tonalidade a partir de um compasso (vale para todas as pautas). */
export interface MeasureChange {
  measure: number;
  timeSignature?: TimeSignature;
  keyFifths?: Fifths;
}

/**
 * Marcas de estrutura num compasso (valem para todas as pautas):
 * início/fim de repetição e casa de 1ª/2ª vez.
 */
export interface BarMark {
  measure: number;
  repeatStart?: boolean;
  repeatEnd?: boolean;
  /** Casa (volta): 1 = toca só na 1ª vez, 2 = só na 2ª. */
  ending?: 1 | 2;
}

export interface Score {
  id: string;
  title: string;
  composer: string;
  /** Batidas por minuto da semínima. */
  tempo: number;
  timeSignature: TimeSignature;
  keyFifths: Fifths;
  /** Mudanças no meio da música, ordenadas por compasso. O compasso 0 usa os valores acima. */
  changes: MeasureChange[];
  /** Repetições e casas, ordenadas por compasso. */
  bars?: BarMark[];
  /** Marcações à mão por cima da página (caneta, marca-texto, texto). */
  annotations?: Annotation[];
  parts: Part[];
}

export function barMark(score: Score, measure: number): BarMark {
  return score.bars?.find((b) => b.measure === measure) ?? { measure };
}

/** Altera as marcas de um compasso (remove a entrada se ficar vazia). */
export function setBarMark(score: Score, measure: number, patch: Partial<Omit<BarMark, 'measure'>>): void {
  const bars = (score.bars ??= []);
  let b = bars.find((x) => x.measure === measure);
  if (!b) {
    b = { measure };
    bars.push(b);
  }
  Object.assign(b, patch);
  for (const k of ['repeatStart', 'repeatEnd', 'ending'] as const) if (!b[k]) delete b[k];
  score.bars = bars.filter((x) => x.repeatStart || x.repeatEnd || x.ending).sort((a, c) => a.measure - c.measure);
}

/**
 * Ordem em que os compassos tocam, desdobrando as repetições:
 * |: A B :| toca A B A B; com casas, a 1ª toca só na primeira vez e a 2ª só na segunda.
 * Sem início de repetição, volta para o começo (ou para o fim da repetição anterior).
 */
export function playOrder(score: Score, measureCount: number): number[] {
  const order: number[] = [];
  let sectionStart = 0;
  let pass = 1;
  let prevEnding: number | undefined;
  const repeated = new Set<number>();
  let i = 0;
  let guard = 0;
  while (i < measureCount && guard++ < measureCount * 4 + 16) {
    const b = barMark(score, i);
    if (b.repeatStart && !(pass === 2 && i === sectionStart)) {
      sectionStart = i;
      pass = 1;
    }
    if (pass === 2 && prevEnding === 2 && !b.ending) pass = 1;
    prevEnding = b.ending;
    if (b.ending && b.ending !== pass) {
      i++;
      continue;
    }
    order.push(i);
    if (b.repeatEnd && !repeated.has(i)) {
      repeated.add(i);
      pass = 2;
      prevEnding = undefined;
      i = sectionStart;
      continue;
    }
    if (b.repeatEnd) {
      pass = b.ending === 1 ? 2 : 1;
      sectionStart = i + 1;
    }
    i++;
  }
  return order;
}

export const MAX_VOICES = 4;

let counter = 0;
export function newId(prefix = 'e'): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function measureCapacity(ts: TimeSignature): Fraction {
  return new Fraction(ts.beats, ts.beatType);
}

export function eventValue(e: MusicEvent): Fraction {
  const v = durationValue(e.duration);
  return e.tuplet ? v.mul(new Fraction(e.tuplet.normal, e.tuplet.actual)) : v;
}

export function voiceLength(v: Voice | undefined): Fraction {
  if (!v) return Fraction.ZERO;
  return Fraction.sum(v.events.map(eventValue));
}

/** Fórmula de compasso em vigor num compasso. */
export function effectiveTimeSignature(score: Score, measureIndex: number): TimeSignature {
  let ts = score.timeSignature;
  for (const c of score.changes ?? []) {
    if (c.measure > measureIndex) break;
    if (c.timeSignature) ts = c.timeSignature;
  }
  return ts;
}

/** Tonalidade em vigor num compasso. */
export function effectiveKey(score: Score, measureIndex: number): Fifths {
  let key = score.keyFifths;
  for (const c of score.changes ?? []) {
    if (c.measure > measureIndex) break;
    if (c.keyFifths !== undefined) key = c.keyFifths;
  }
  return key;
}

/** Define (ou remove, se igual ao anterior) uma mudança a partir do compasso `measure`. */
export function setChange(score: Score, measure: number, patch: { timeSignature?: TimeSignature; keyFifths?: Fifths }): void {
  if (measure <= 0) {
    if (patch.timeSignature) score.timeSignature = patch.timeSignature;
    if (patch.keyFifths !== undefined) score.keyFifths = patch.keyFifths;
  } else {
    let c = score.changes.find((x) => x.measure === measure);
    if (!c) {
      c = { measure };
      score.changes.push(c);
      score.changes.sort((a, b) => a.measure - b.measure);
    }
    Object.assign(c, patch);
  }
  // limpa mudanças redundantes (iguais ao que já estava valendo)
  score.changes = score.changes.filter((c) => {
    const prevTs = effectiveTimeSignature({ ...score, changes: score.changes.filter((x) => x.measure < c.measure) }, c.measure);
    const prevKey = effectiveKey({ ...score, changes: score.changes.filter((x) => x.measure < c.measure) }, c.measure);
    if (c.timeSignature && c.timeSignature.beats === prevTs.beats && c.timeSignature.beatType === prevTs.beatType) delete c.timeSignature;
    if (c.keyFifths === prevKey) delete c.keyFifths;
    return c.timeSignature !== undefined || c.keyFifths !== undefined;
  });
}

/** Todas as pautas da partitura, na ordem de cima para baixo. */
export function allStaves(score: Score): Array<{ part: Part; staff: Staff; partIndex: number; staffIndex: number }> {
  const out: Array<{ part: Part; staff: Staff; partIndex: number; staffIndex: number }> = [];
  score.parts.forEach((part, partIndex) => part.staves.forEach((staff, staffIndex) => out.push({ part, staff, partIndex, staffIndex })));
  return out;
}

export function emptyMeasure(): Measure {
  return { id: newId('m'), voices: [{ events: [] }], barline: 'single' };
}

export interface InstrumentPreset {
  id: string;
  name: string;
  /** Uma clave por pauta (piano = Sol + Fá). */
  clefs: Clef[];
  midiProgram: number;
  transposition: number;
}

export const INSTRUMENTS: InstrumentPreset[] = [
  { id: 'piano', name: 'Piano', clefs: ['treble', 'bass'], midiProgram: 0, transposition: 0 },
  { id: 'flute', name: 'Flauta', clefs: ['treble'], midiProgram: 73, transposition: 0 },
  { id: 'violin', name: 'Violino', clefs: ['treble'], midiProgram: 40, transposition: 0 },
  { id: 'voice', name: 'Voz', clefs: ['treble'], midiProgram: 52, transposition: 0 },
  { id: 'viola', name: 'Viola', clefs: ['alto'], midiProgram: 41, transposition: 0 },
  { id: 'cello', name: 'Violoncelo', clefs: ['bass'], midiProgram: 42, transposition: 0 },
  { id: 'trombone', name: 'Trombone', clefs: ['bass'], midiProgram: 57, transposition: 0 },
  { id: 'clarinet', name: 'Clarinete em Si♭', clefs: ['treble'], midiProgram: 71, transposition: -2 },
  { id: 'organ', name: 'Órgão', clefs: ['treble', 'bass'], midiProgram: 19, transposition: 0 },
  { id: 'trumpet', name: 'Trompete em Si♭', clefs: ['treble'], midiProgram: 56, transposition: -2 },
  { id: 'sax-alto', name: 'Saxofone alto', clefs: ['treble'], midiProgram: 65, transposition: -9 },
  { id: 'bass', name: 'Contrabaixo', clefs: ['bass'], midiProgram: 32, transposition: -12 },
  { id: 'guitar', name: 'Violão', clefs: ['treble'], midiProgram: 24, transposition: -12 },
];

export interface NewScoreOptions {
  title?: string;
  composer?: string;
  tempo?: number;
  timeSignature?: TimeSignature;
  keyFifths?: Fifths;
  instrumentId?: string;
  /** Vários instrumentos, de cima para baixo. Tem prioridade sobre instrumentId. */
  instrumentIds?: string[];
}

export function createPart(instrumentId: string, measureCount = 1): Part {
  const preset = INSTRUMENTS.find((i) => i.id === instrumentId) ?? INSTRUMENTS[0];
  return {
    id: newId('p'),
    name: preset.name,
    instrument: preset.id,
    midiProgram: preset.midiProgram,
    transposition: preset.transposition,
    staves: preset.clefs.map((clef) => ({
      id: newId('st'),
      clef,
      measures: Array.from({ length: measureCount }, emptyMeasure),
    })),
  };
}

export function createScore(opts: NewScoreOptions = {}): Score {
  const ids = opts.instrumentIds?.length ? opts.instrumentIds : [opts.instrumentId ?? 'piano'];
  return {
    id: newId('s'),
    title: opts.title ?? 'Sem título',
    composer: opts.composer ?? '',
    tempo: opts.tempo ?? 96,
    timeSignature: opts.timeSignature ?? { beats: 4, beatType: 4 },
    keyFifths: opts.keyFifths ?? 0,
    changes: [],
    parts: ids.map((id) => createPart(id)),
  };
}

/** Atualiza partituras salvas em versões antigas. */
export function migrateScore(score: Score): Score {
  if (!score.changes) score.changes = [];
  for (const { staff } of allStaves(score)) {
    for (const m of staff.measures as Array<Measure & { timeSignature?: TimeSignature }>) delete m.timeSignature;
  }
  return score;
}
