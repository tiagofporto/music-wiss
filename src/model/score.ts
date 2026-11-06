import { Fraction } from './fraction';
import type { Duration } from './duration';
import { durationValue } from './duration';
import type { Fifths } from './key';
import type { Clef, Pitch } from './pitch';

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

interface EventBase {
  id: string;
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
  staves: Staff[];
}

/** Mudança de fórmula de compasso e/ou tonalidade a partir de um compasso (vale para todas as pautas). */
export interface MeasureChange {
  measure: number;
  timeSignature?: TimeSignature;
  keyFifths?: Fifths;
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
  parts: Part[];
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
