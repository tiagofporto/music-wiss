import { collectNotes } from '../audio/sequencer';
import { Fraction } from '../model/fraction';
import type { Score } from '../model/score';
import { effectiveTimeSignature, measureCapacity } from '../model/score';

/** Resolução do arquivo: pulsos (ticks) por semínima. */
export const TICKS_PER_QUARTER = 480;

const toTicks = (f: Fraction) => Math.round(f.toNumber() * 4 * TICKS_PER_QUARTER);

function varLen(n: number): number[] {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}

function u32(n: number) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function text(s: string): number[] {
  return [...new TextEncoder().encode(s)];
}

interface TrackEvent {
  tick: number;
  /** ordem dentro do mesmo tick: desligar notas antes de ligar as próximas */
  order: number;
  data: number[];
}

function track(events: TrackEvent[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const e of events) {
    body.push(...varLen(e.tick - last), ...e.data);
    last = e.tick;
  }
  body.push(0x00, 0xff, 0x2f, 0x00); // fim da trilha
  return [...text('MTrk'), ...u32(body.length), ...body];
}

/**
 * Gera um arquivo MIDI padrão (formato 1): uma trilha de tempo/compasso e
 * uma trilha por instrumento, com o programa General MIDI de cada um.
 */
export function exportMidi(score: Score): Uint8Array {
  const { notes, end } = collectNotes(score);

  // trilha 0: título, andamento e fórmulas de compasso
  const conductor: TrackEvent[] = [];
  const title = text(score.title);
  conductor.push({ tick: 0, order: 0, data: [0xff, 0x03, ...varLen(title.length), ...title] });
  const mpq = Math.round(60_000_000 / score.tempo);
  conductor.push({ tick: 0, order: 1, data: [0xff, 0x51, 0x03, (mpq >> 16) & 0xff, (mpq >> 8) & 0xff, mpq & 0xff] });
  let t = Fraction.ZERO;
  let prev = '';
  for (let mi = 0; t.lt(end) || mi === 0; mi++) {
    const ts = effectiveTimeSignature(score, mi);
    const key = `${ts.beats}/${ts.beatType}`;
    if (key !== prev) {
      conductor.push({ tick: toTicks(t), order: 2, data: [0xff, 0x58, 0x04, ts.beats, Math.log2(ts.beatType), 24, 8] });
      prev = key;
    }
    t = t.add(measureCapacity(ts));
  }

  // canais: 0–15 sem o 9 (percussão)
  const channels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
  const tracks = score.parts.map((part, pi) => {
    const ch = channels[pi % channels.length];
    const name = text(part.name);
    const events: TrackEvent[] = [
      { tick: 0, order: 0, data: [0xff, 0x03, ...varLen(name.length), ...name] },
      { tick: 0, order: 1, data: [0xc0 | ch, part.midiProgram & 0x7f] },
    ];
    for (const n of notes.filter((x) => x.partIndex === pi)) {
      const midi = Math.max(0, Math.min(127, n.midi));
      const on = toTicks(n.start);
      const off = Math.max(on + 1, toTicks(n.start.add(n.length)));
      events.push({ tick: on, order: 3, data: [0x90 | ch, midi, n.velocity] });
      events.push({ tick: off, order: 2, data: [0x80 | ch, midi, 0] });
    }
    return track(events);
  });

  const header = [...text('MThd'), ...u32(6), 0, 1, 0, tracks.length + 1, (TICKS_PER_QUARTER >> 8) & 0xff, TICKS_PER_QUARTER & 0xff];
  return new Uint8Array([...header, ...track(conductor), ...tracks.flat()]);
}
