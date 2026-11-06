import { toMidi } from '../model/pitch';
import type { Score } from '../model/score';
import type { LogicalEvent } from '../model/sequence';
import { readLogical } from '../model/sequence';

export interface ScheduledNote {
  midi: number;
  /** segundos desde o início */
  start: number;
  duration: number;
  /** índice do evento lógico (para destacar durante a reprodução) */
  eventIndex: number;
}

/** Segundos que dura uma semibreve no andamento da partitura (andamento em semínimas). */
export function secondsPerWhole(score: Score): number {
  return (60 / score.tempo) * 4;
}

/**
 * Varre a partitura em ordem cronológica e gera as notas a tocar (NoteOn/NoteOff),
 * juntando notas ligadas e aplicando a transposição do instrumento.
 */
export function schedule(score: Score, fromEvent = 0): { notes: ScheduledNote[]; onsets: number[]; total: number } {
  const spw = secondsPerWhole(score);
  const notes: ScheduledNote[] = [];
  let onsets: number[] = [];
  let total = 0;

  for (const part of score.parts) {
    for (const staff of part.staves) {
      const events: LogicalEvent[] = readLogical(staff);
      let t = 0;
      const partOnsets: number[] = [];
      const open = new Map<number, ScheduledNote>(); // notas ligadas esperando continuação
      events.forEach((ev, i) => {
        partOnsets.push(t);
        const len = ev.length.toNumber() * spw;
        if (i >= fromEvent) {
          for (const n of ev.notes) {
            const midi = toMidi(n.pitch) + part.transposition;
            const cont = open.get(midi);
            if (cont) {
              cont.duration += len;
              open.delete(midi);
              if (n.tieToNext) open.set(midi, cont);
              continue;
            }
            const sn = { midi, start: t, duration: len, eventIndex: i };
            notes.push(sn);
            if (n.tieToNext) open.set(midi, sn);
          }
        }
        t += len;
      });
      total = Math.max(total, t);
      if (partOnsets.length > onsets.length) onsets = partOnsets;
    }
  }

  const offset = onsets[fromEvent] ?? 0;
  return {
    notes: notes.map((n) => ({ ...n, start: n.start - offset })),
    onsets: onsets.map((o) => o - offset),
    total: total - offset,
  };
}
