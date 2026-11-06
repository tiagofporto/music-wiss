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

interface EventBase {
  id: string;
  duration: Duration;
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
}

export type MusicEvent = ChordEvent | RestEvent;

export interface Voice {
  events: MusicEvent[];
}

export type Barline = 'single' | 'double' | 'final' | 'repeat-start' | 'repeat-end';

export interface Measure {
  id: string;
  /** Muda a fórmula de compasso a partir deste compasso. */
  timeSignature?: TimeSignature;
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

export interface Score {
  id: string;
  title: string;
  composer: string;
  /** Batidas por minuto da semínima. */
  tempo: number;
  timeSignature: TimeSignature;
  keyFifths: Fifths;
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
  return durationValue(e.duration);
}

export function voiceLength(v: Voice | undefined): Fraction {
  if (!v) return Fraction.ZERO;
  return Fraction.sum(v.events.map(eventValue));
}

/** Fórmula de compasso em vigor em cada compasso da pauta. */
export function effectiveTimeSignature(score: Score, staff: Staff, measureIndex: number): TimeSignature {
  for (let i = measureIndex; i >= 0; i--) {
    const ts = staff.measures[i]?.timeSignature;
    if (ts) return ts;
  }
  return score.timeSignature;
}

export function emptyMeasure(): Measure {
  return { id: newId('m'), voices: [{ events: [] }], barline: 'single' };
}

export interface InstrumentPreset {
  id: string;
  name: string;
  clef: Clef;
  midiProgram: number;
  transposition: number;
}

export const INSTRUMENTS: InstrumentPreset[] = [
  { id: 'piano', name: 'Piano', clef: 'treble', midiProgram: 0, transposition: 0 },
  { id: 'flute', name: 'Flauta', clef: 'treble', midiProgram: 73, transposition: 0 },
  { id: 'violin', name: 'Violino', clef: 'treble', midiProgram: 40, transposition: 0 },
  { id: 'voice', name: 'Voz', clef: 'treble', midiProgram: 52, transposition: 0 },
  { id: 'viola', name: 'Viola', clef: 'alto', midiProgram: 41, transposition: 0 },
  { id: 'cello', name: 'Violoncelo', clef: 'bass', midiProgram: 42, transposition: 0 },
  { id: 'trombone', name: 'Trombone', clef: 'bass', midiProgram: 57, transposition: 0 },
  { id: 'clarinet', name: 'Clarinete em Si♭', clef: 'treble', midiProgram: 71, transposition: -2 },
  { id: 'guitar', name: 'Violão', clef: 'treble', midiProgram: 24, transposition: -12 },
];

export interface NewScoreOptions {
  title?: string;
  composer?: string;
  tempo?: number;
  timeSignature?: TimeSignature;
  keyFifths?: Fifths;
  instrumentId?: string;
}

export function createScore(opts: NewScoreOptions = {}): Score {
  const preset = INSTRUMENTS.find((i) => i.id === opts.instrumentId) ?? INSTRUMENTS[0];
  return {
    id: newId('s'),
    title: opts.title ?? 'Sem título',
    composer: opts.composer ?? '',
    tempo: opts.tempo ?? 96,
    timeSignature: opts.timeSignature ?? { beats: 4, beatType: 4 },
    keyFifths: opts.keyFifths ?? 0,
    parts: [
      {
        id: newId('p'),
        name: preset.name,
        instrument: preset.id,
        midiProgram: preset.midiProgram,
        transposition: preset.transposition,
        staves: [{ id: newId('st'), clef: preset.clef, measures: [emptyMeasure()] }],
      },
    ],
  };
}
