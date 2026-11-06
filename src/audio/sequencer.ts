import { Fraction } from '../model/fraction';
import { toMidi } from '../model/pitch';
import type { Score } from '../model/score';
import { MAX_VOICES } from '../model/score';
import { readLogical } from '../model/sequence';

export interface ScheduledNote {
  midi: number;
  /** segundos desde o ponto de partida */
  start: number;
  duration: number;
  /** programa General MIDI do instrumento */
  program: number;
}

export interface PlaybackPlan {
  notes: ScheduledNote[];
  /** Momentos em que algo começa: `at` em segundos desde a partida, `time` em semibreves desde o início da música. */
  steps: Array<{ at: number; time: number }>;
  total: number;
}

/** Segundos que dura uma semibreve no andamento da partitura (andamento em semínimas). */
export function secondsPerWhole(score: Score): number {
  return (60 / score.tempo) * 4;
}

/** Uma nota a tocar, em semibreves desde o início da música. */
export interface TimedNote {
  partIndex: number;
  midi: number;
  start: Fraction;
  length: Fraction;
  velocity: number;
}

/**
 * Varre a partitura (todas as pautas e vozes) em ordem cronológica e gera as
 * notas a tocar, juntando notas ligadas e aplicando a transposição do instrumento.
 * Também devolve todos os momentos em que algum evento começa.
 */
export function collectNotes(score: Score): { notes: TimedNote[]; onsets: Fraction[]; end: Fraction } {
  const notes: TimedNote[] = [];
  const onsets = new Map<string, Fraction>();
  let end = Fraction.ZERO;
  score.parts.forEach((part, partIndex) => {
    for (const staff of part.staves) {
      for (let v = 0; v < MAX_VOICES; v++) {
        let t = Fraction.ZERO;
        const open = new Map<number, TimedNote>(); // notas ligadas esperando continuação
        for (const ev of readLogical(staff, v)) {
          onsets.set(t.toString(), t);
          for (const n of ev.notes) {
            const midi = toMidi(n.pitch) + part.transposition;
            const cont = open.get(midi);
            if (cont) {
              cont.length = cont.length.add(ev.length);
              open.delete(midi);
              if (n.tieToNext) open.set(midi, cont);
              continue;
            }
            const tn: TimedNote = { partIndex, midi, start: t, length: ev.length, velocity: 80 };
            notes.push(tn);
            if (n.tieToNext) open.set(midi, tn);
          }
          t = t.add(ev.length);
        }
        if (t.gt(end)) end = t;
      }
    }
  });
  notes.sort((a, b) => a.start.compare(b.start) || a.midi - b.midi);
  return { notes, onsets: [...onsets.values()].sort((a, b) => a.compare(b)), end };
}

/** Plano de reprodução a partir de um momento (em semibreves). */
export function schedule(score: Score, from: Fraction = Fraction.ZERO): PlaybackPlan {
  const spw = secondsPerWhole(score);
  const offset = from.toNumber();
  const { notes, onsets, end } = collectNotes(score);
  const playable = notes
    .filter((n) => n.start.gte(from))
    .map((n) => ({
      midi: n.midi,
      start: (n.start.toNumber() - offset) * spw,
      duration: n.length.toNumber() * spw,
      program: score.parts[n.partIndex].midiProgram,
    }));
  const steps = onsets.filter((t) => t.gte(from)).map((t) => ({ at: (t.toNumber() - offset) * spw, time: t.toNumber() }));
  return { notes: playable, steps, total: Math.max(0, (end.toNumber() - offset) * spw) };
}
