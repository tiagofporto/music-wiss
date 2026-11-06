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

/**
 * Varre a partitura (todas as pautas e vozes) em ordem cronológica e gera as
 * notas a tocar, juntando notas ligadas e aplicando a transposição do instrumento.
 */
export function schedule(score: Score, from: Fraction = Fraction.ZERO): PlaybackPlan {
  const spw = secondsPerWhole(score);
  const offset = from.toNumber();
  const notes: ScheduledNote[] = [];
  const times = new Set<number>();
  let end = 0;

  for (const part of score.parts) {
    for (const staff of part.staves) {
      for (let v = 0; v < MAX_VOICES; v++) {
        const events = readLogical(staff, v);
        let t = Fraction.ZERO;
        const open = new Map<number, ScheduledNote>(); // notas ligadas esperando continuação
        for (const ev of events) {
          const len = ev.length.toNumber() * spw;
          if (t.gte(from)) {
            times.add(t.toNumber());
            for (const n of ev.notes) {
              const midi = toMidi(n.pitch) + part.transposition;
              const cont = open.get(midi);
              if (cont) {
                cont.duration += len;
                open.delete(midi);
                if (n.tieToNext) open.set(midi, cont);
                continue;
              }
              const sn = { midi, start: (t.toNumber() - offset) * spw, duration: len, program: part.midiProgram };
              notes.push(sn);
              if (n.tieToNext) open.set(midi, sn);
            }
          }
          t = t.add(ev.length);
        }
        end = Math.max(end, t.toNumber());
      }
    }
  }

  const steps = [...times].sort((a, b) => a - b).map((time) => ({ at: (time - offset) * spw, time }));
  return { notes, steps, total: Math.max(0, (end - offset) * spw) };
}
