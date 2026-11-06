import { Fraction } from '../model/fraction';
import { toMidi } from '../model/pitch';
import type { Dynamic, Marks, Score, Staff } from '../model/score';
import { MAX_VOICES, playOrder } from '../model/score';
import { measureStarts, readLogical } from '../model/sequence';

export interface ScheduledNote {
  midi: number;
  /** segundos desde o ponto de partida */
  start: number;
  duration: number;
  /** programa General MIDI do instrumento */
  program: number;
  /** parte (instrumento) de onde vem a nota */
  partIndex: number;
  /** intensidade MIDI (1–127) */
  velocity: number;
  /** fração da duração que soa (staccato = 0,5) */
  gate: number;
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
  /** quanto da duração soa (staccato < 1) */
  gate: number;
}

/** Intensidade MIDI de cada dinâmica. */
export const DYNAMIC_VELOCITY: Record<Dynamic, number> = {
  ppp: 20, pp: 33, p: 49, mp: 64, mf: 80, f: 96, ff: 112, fff: 124, fp: 96, sfz: 112,
};
/** fp e sfz atacam forte só naquela nota; depois vale isto (fp = piano, sfz = volta ao anterior) */
const AFTER: Partial<Record<Dynamic, Dynamic | null>> = { fp: 'p', sfz: null };
const DEFAULT_VELOCITY = DYNAMIC_VELOCITY.mf;
const DEFAULT_GATE = 0.92;

function articulate(marks: Marks | undefined, velocity: number): { velocity: number; gate: number } {
  let gate = DEFAULT_GATE;
  for (const a of marks?.articulations ?? []) {
    if (a === 'staccato') gate = Math.min(gate, 0.5);
    else if (a === 'staccatissimo') gate = Math.min(gate, 0.3);
    else if (a === 'tenuto') gate = Math.max(gate, 1);
    else if (a === 'accent') velocity += 18;
    else if (a === 'marcato') velocity += 26;
  }
  return { velocity: Math.max(1, Math.min(127, velocity)), gate };
}

/** Dinâmica em vigor ao longo de uma pauta (todas as vozes). */
function dynamicsTimeline(staff: Staff): Array<{ t: Fraction; velocity: number }> {
  const marks: Array<{ t: Fraction; dyn: Dynamic }> = [];
  for (let v = 0; v < MAX_VOICES; v++) {
    let t = Fraction.ZERO;
    for (const ev of readLogical(staff, v)) {
      if (ev.marks?.dynamic) marks.push({ t, dyn: ev.marks.dynamic });
      t = t.add(ev.length);
    }
  }
  marks.sort((a, b) => a.t.compare(b.t));
  const out: Array<{ t: Fraction; velocity: number }> = [];
  let current = DEFAULT_VELOCITY;
  for (const m of marks) {
    const after = AFTER[m.dyn];
    if (after === undefined) current = DYNAMIC_VELOCITY[m.dyn];
    else if (after) current = DYNAMIC_VELOCITY[after];
    out.push({ t: m.t, velocity: current });
  }
  return out;
}

function velocityAt(timeline: Array<{ t: Fraction; velocity: number }>, t: Fraction): number {
  let v = DEFAULT_VELOCITY;
  for (const m of timeline) {
    if (m.t.gt(t)) break;
    v = m.velocity;
  }
  return v;
}

/**
 * Todas as notas da partitura em ordem de tempo escrito (sem desdobrar repetições),
 * com notas ligadas fundidas numa só, transposição aplicada, intensidade pelas
 * dinâmicas e articulações.
 * Também devolve todos os momentos em que algum evento começa.
 */
export function collectNotes(score: Score): { notes: TimedNote[]; onsets: Fraction[]; end: Fraction } {
  const notes: TimedNote[] = [];
  const onsets = new Map<string, Fraction>();
  let end = Fraction.ZERO;
  score.parts.forEach((part, partIndex) => {
    for (const staff of part.staves) {
      const dyn = dynamicsTimeline(staff);
      for (let v = 0; v < MAX_VOICES; v++) {
        let t = Fraction.ZERO;
        const open = new Map<number, TimedNote>(); // notas ligadas esperando continuação
        for (const ev of readLogical(staff, v)) {
          onsets.set(t.toString(), t);
          const d = ev.marks?.dynamic;
          const base = d && AFTER[d] !== undefined ? DYNAMIC_VELOCITY[d] : velocityAt(dyn, t);
          const { velocity, gate } = articulate(ev.marks, base);
          for (const n of ev.notes) {
            const midi = toMidi(n.pitch) + part.transposition;
            const cont = open.get(midi);
            if (cont) {
              cont.length = cont.length.add(ev.length);
              cont.gate = gate;
              open.delete(midi);
              if (n.tieToNext) open.set(midi, cont);
              continue;
            }
            const tn: TimedNote = { partIndex, midi, start: t, length: ev.length, velocity, gate };
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

/** Um compasso na ordem de execução: onde está na escrita e quando toca. */
export interface PlayedMeasure {
  measure: number;
  written: Fraction;
  played: Fraction;
  length: Fraction;
}

/**
 * A música como ela soa: repetições e casas desdobradas.
 * `notes` ficam em tempo de execução (semibreves desde o início da execução).
 */
export function perform(score: Score): { notes: TimedNote[]; measures: PlayedMeasure[]; end: Fraction } {
  const { notes, end } = collectNotes(score);
  const count = score.parts[0]?.staves[0]?.measures.length ?? 0;
  const starts = measureStarts(score, count + 1);
  // só até o último compasso com conteúdo
  let last = 0;
  while (last < count && starts[last].lt(end)) last++;
  const measures: PlayedMeasure[] = [];
  let played = Fraction.ZERO;
  for (const mi of playOrder(score, last)) {
    const length = starts[mi + 1].sub(starts[mi]);
    measures.push({ measure: mi, written: starts[mi], played, length });
    played = played.add(length);
  }
  const out: TimedNote[] = [];
  for (const m of measures) {
    const to = m.written.add(m.length);
    const shift = m.played.sub(m.written);
    for (const n of notes) {
      if (n.start.gte(m.written) && n.start.lt(to)) out.push({ ...n, start: n.start.add(shift) });
    }
  }
  let total = played;
  const tail = measures[measures.length - 1];
  if (tail && tail.measure === last - 1) {
    const used = end.sub(tail.written);
    if (used.lt(tail.length)) total = tail.played.add(used);
  }
  return { notes: out, measures, end: total };
}

/** Plano de reprodução a partir de um momento escrito (em semibreves). */
export function schedule(score: Score, from: Fraction = Fraction.ZERO): PlaybackPlan {
  const spw = secondsPerWhole(score);
  const { notes, measures, end } = perform(score);
  const { onsets } = collectNotes(score);
  const seg = measures.find((m) => from.gte(m.written) && from.lt(m.written.add(m.length)));
  const playedFrom = seg ? seg.played.add(from.sub(seg.written)) : end;
  const offset = playedFrom.toNumber();
  const playable = notes
    .filter((n) => n.start.gte(playedFrom))
    .map((n) => ({
      midi: n.midi,
      start: (n.start.toNumber() - offset) * spw,
      duration: n.length.toNumber() * spw,
      gate: n.gate,
      program: score.parts[n.partIndex].midiProgram,
      partIndex: n.partIndex,
      velocity: n.velocity,
    }));
  const steps: PlaybackPlan['steps'] = [];
  for (const m of measures) {
    const to = m.written.add(m.length);
    for (const o of onsets) {
      if (o.lt(m.written) || !o.lt(to)) continue;
      const at = m.played.add(o.sub(m.written));
      if (at.gte(playedFrom)) steps.push({ at: (at.toNumber() - offset) * spw, time: o.toNumber() });
    }
  }
  return { notes: playable, steps, total: Math.max(0, (end.toNumber() - offset) * spw) };
}
