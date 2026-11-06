import { Fraction } from './fraction';
import { decompose, durationValue } from './duration';
import type { Duration } from './duration';
import type { ChordEvent, MusicEvent, Note, Score, Staff } from './score';
import { effectiveTimeSignature, emptyMeasure, measureCapacity, newId } from './score';

/**
 * Visão "lógica" de uma voz: a sequência de notas como o usuário pensa nelas,
 * sem as divisões que as barras de compasso impõem. Uma semínima pontuada que
 * cruza a barra é UM evento lógico, embora fique como duas notas ligadas.
 */
export interface LogicalEvent {
  id: string;
  kind: 'chord' | 'rest';
  /** Figura escolhida pelo usuário (para mostrar na barra de ferramentas). */
  duration: Duration;
  length: Fraction;
  notes: Note[];
}

export function readLogical(staff: Staff, voiceIndex = 0): LogicalEvent[] {
  const out: LogicalEvent[] = [];
  for (const m of staff.measures) {
    for (const e of m.voices[voiceIndex]?.events ?? []) {
      const last = out[out.length - 1];
      if (e.fragmentOf && last && last.id === e.fragmentOf) {
        last.length = last.length.add(durationValue(e.duration));
        if (e.kind === 'chord') last.notes = cloneNotes(e.notes); // o último pedaço manda na ligadura
        continue;
      }
      out.push({
        id: e.fragmentOf ?? e.id,
        kind: e.kind,
        duration: e.duration,
        length: durationValue(e.duration),
        notes: e.kind === 'chord' ? cloneNotes(e.notes) : [],
      });
    }
  }
  // a figura "do usuário" de um evento dividido é a que soma o total, se existir
  for (const ev of out) {
    const parts = decompose(ev.length);
    if (parts.length === 1) ev.duration = parts[0];
  }
  return out;
}

/**
 * Reescreve a voz distribuindo os eventos lógicos pelos compassos. Uma nota que
 * não cabe no que sobra do compasso é dividida em figuras válidas ligadas entre si.
 * Depois do último compasso cheio sempre sobra um compasso livre para continuar digitando.
 */
export function writeLogical(score: Score, staff: Staff, events: LogicalEvent[], voiceIndex = 0): void {
  for (const m of staff.measures) {
    if (m.voices[voiceIndex]) m.voices[voiceIndex].events = [];
  }

  let mi = 0;
  let used = Fraction.ZERO;
  const ensure = (i: number) => {
    while (staff.measures.length <= i) staff.measures.push(emptyMeasure());
    const m = staff.measures[i];
    while (m.voices.length <= voiceIndex) m.voices.push({ events: [] });
    return m;
  };

  for (const ev of events) {
    let remaining = ev.length;
    let first = true;
    while (!remaining.isZero()) {
      const cap = measureCapacity(effectiveTimeSignature(score, staff, mi));
      let space = cap.sub(used);
      if (space.isZero()) {
        mi += 1;
        used = Fraction.ZERO;
        continue;
      }
      const take = remaining.lte(space) ? remaining : space;
      const figures = take.eq(ev.length) && durationValue(ev.duration).eq(take) ? [ev.duration] : decompose(take);
      for (const d of figures) {
        const isLastPiece = remaining.sub(durationValue(d)).isZero();
        ensure(mi).voices[voiceIndex].events.push(makePiece(ev, d, first, isLastPiece));
        first = false;
        remaining = remaining.sub(durationValue(d));
        used = used.add(durationValue(d));
      }
      space = cap.sub(used);
      if (space.isZero()) {
        mi += 1;
        used = Fraction.ZERO;
      }
    }
  }

  // corta compassos sobrando: o último fica livre (ou incompleto) para continuar digitando
  const keep = mi + 1;
  const otherVoicesBusy = (i: number) =>
    staff.measures[i].voices.some((v, vi) => vi !== voiceIndex && v.events.length > 0);
  while (staff.measures.length > keep && !otherVoicesBusy(staff.measures.length - 1)) staff.measures.pop();
  ensure(keep - 1);
}

function makePiece(ev: LogicalEvent, d: Duration, first: boolean, last: boolean): MusicEvent {
  const id = first ? ev.id : newId('f');
  const fragmentOf = first ? undefined : ev.id;
  if (ev.kind === 'rest') return { kind: 'rest', id, duration: d, ...(fragmentOf ? { fragmentOf } : {}) };
  const chord: ChordEvent = {
    kind: 'chord',
    id,
    duration: d,
    notes: ev.notes.map((n) => ({ ...n, pitch: { ...n.pitch }, id: first ? n.id : newId('n'), tieToNext: last ? n.tieToNext : true })),
  };
  if (fragmentOf) chord.fragmentOf = fragmentOf;
  return chord;
}

function cloneNotes(notes: Note[]): Note[] {
  return notes.map((n) => ({ ...n, pitch: { ...n.pitch } }));
}

/** Posição (início) de cada evento lógico em frações de semibreve. */
export function logicalOnsets(events: LogicalEvent[]): Fraction[] {
  const out: Fraction[] = [];
  let t = Fraction.ZERO;
  for (const e of events) {
    out.push(t);
    t = t.add(e.length);
  }
  return out;
}
