import { Fraction } from './fraction';
import { decompose, durationValue } from './duration';
import type { Duration } from './duration';
import type { ChordEvent, Marks, MusicEvent, Note, Score, Staff, Tuplet } from './score';
import { allStaves, cloneMarks, effectiveTimeSignature, emptyMeasure, eventValue, MAX_VOICES, measureCapacity, newId } from './score';

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
  tuplet?: Tuplet;
  placeholder?: boolean;
  auto?: boolean;
  marks?: Marks;
}

export function logicalLength(e: { duration: Duration; tuplet?: Tuplet }): Fraction {
  const v = durationValue(e.duration);
  return e.tuplet ? v.mul(new Fraction(e.tuplet.normal, e.tuplet.actual)) : v;
}

export function readLogical(staff: Staff, voiceIndex = 0): LogicalEvent[] {
  const out: LogicalEvent[] = [];
  for (const m of staff.measures) {
    for (const e of m.voices[voiceIndex]?.events ?? []) {
      if (e.kind === 'rest' && e.filler) continue;
      const last = out[out.length - 1];
      if (e.fragmentOf && last && last.id === e.fragmentOf) {
        last.length = last.length.add(eventValue(e));
        if (e.kind === 'chord') last.notes = cloneNotes(e.notes); // o último pedaço manda na ligadura
        continue;
      }
      const ev: LogicalEvent = {
        id: e.fragmentOf ?? e.id,
        kind: e.kind,
        duration: e.duration,
        length: eventValue(e),
        notes: e.kind === 'chord' ? cloneNotes(e.notes) : [],
      };
      if (e.tuplet) ev.tuplet = { ...e.tuplet };
      if (e.marks) ev.marks = cloneMarks(e.marks);
      if (e.kind === 'rest' && e.placeholder) ev.placeholder = true;
      if (e.kind === 'rest' && e.auto) ev.auto = true;
      out.push(ev);
    }
  }
  // a figura "do usuário" de um evento dividido é a que soma o total, se existir
  for (const ev of out) {
    if (ev.tuplet) continue;
    const parts = decompose(ev.length);
    if (parts.length === 1) ev.duration = parts[0];
  }
  return out;
}

/** Comprimento total de um grupo de quiáltera a partir do evento i. */
function tupletRemaining(events: LogicalEvent[], i: number): Fraction {
  const id = events[i].tuplet!.id;
  let total = Fraction.ZERO;
  for (let k = i; k < events.length && events[k].tuplet?.id === id; k++) total = total.add(events[k].length);
  return total;
}

/**
 * Reescreve a voz distribuindo os eventos lógicos pelos compassos. Uma nota que
 * não cabe no que sobra do compasso é dividida em figuras válidas ligadas entre si.
 * Quiálteras nunca são divididas: se o grupo não cabe, o resto do compasso
 * recebe pausas e o grupo começa no compasso seguinte.
 * Não ajusta o número de compassos das outras pautas: chame normalizeMeasures depois.
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
  const advanceIfFull = () => {
    if (measureCapacity(effectiveTimeSignature(score, mi)).sub(used).lte(Fraction.ZERO)) {
      mi += 1;
      used = Fraction.ZERO;
    }
  };

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    if (ev.tuplet) {
      const space = measureCapacity(effectiveTimeSignature(score, mi)).sub(used);
      const isGroupStart = events[i - 1]?.tuplet?.id !== ev.tuplet.id;
      if (isGroupStart && tupletRemaining(events, i).gt(space) && !used.isZero() && space.gt(Fraction.ZERO)) {
        for (const d of decompose(space)) {
          ensure(mi).voices[voiceIndex].events.push({ kind: 'rest', id: newId('r'), duration: d, filler: true });
        }
        mi += 1;
        used = Fraction.ZERO;
      }
      const e: MusicEvent =
        ev.kind === 'rest'
          ? { kind: 'rest', id: ev.id, duration: ev.duration, tuplet: { ...ev.tuplet }, ...(ev.placeholder ? { placeholder: true } : {}) }
          : { kind: 'chord', id: ev.id, duration: ev.duration, tuplet: { ...ev.tuplet }, notes: cloneNotes(ev.notes) };
      if (ev.marks) e.marks = cloneMarks(ev.marks);
      ensure(mi).voices[voiceIndex].events.push(e);
      used = used.add(ev.length);
      advanceIfFull();
      continue;
    }

    let remaining = ev.length;
    let first = true;
    while (!remaining.isZero()) {
      const cap = measureCapacity(effectiveTimeSignature(score, mi));
      const space = cap.sub(used);
      if (space.lte(Fraction.ZERO)) {
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
      advanceIfFull();
    }
  }
  ensure(mi);
}

/**
 * Deixa todas as pautas com o mesmo número de compassos: o suficiente para o
 * conteúdo de todas as vozes, mais um compasso livre no fim para continuar escrevendo.
 */
export function normalizeMeasures(score: Score): void {
  let needed = 1;
  for (const { staff } of allStaves(score)) {
    staff.measures.forEach((m, i) => {
      for (const v of m.voices) {
        if (!v.events.length) continue;
        const full = Fraction.sum(v.events.map(eventValue)).gte(measureCapacity(effectiveTimeSignature(score, i)));
        needed = Math.max(needed, full ? i + 2 : i + 1);
      }
    });
  }
  for (const { staff } of allStaves(score)) {
    while (staff.measures.length < needed) staff.measures.push(emptyMeasure());
    staff.measures.length = needed;
    for (const m of staff.measures) {
      // remove vozes extras vazias do fim
      while (m.voices.length > 1 && !m.voices[m.voices.length - 1].events.length) m.voices.pop();
    }
  }
}

/** Redistribui todas as vozes de todas as pautas (depois de mudar fórmula de compasso, por ex.). */
export function reflowAll(score: Score): void {
  const snapshot = allStaves(score).map(({ staff }) => ({
    staff,
    voices: Array.from({ length: MAX_VOICES }, (_, v) => readLogical(staff, v)),
  }));
  for (const { staff, voices } of snapshot) {
    voices.forEach((events, v) => {
      if (v === 0 || events.length) writeLogical(score, staff, events, v);
    });
  }
  normalizeMeasures(score);
}

/** Momento (em semibreves) em que começa cada compasso. */
export function measureStarts(score: Score, count: number): Fraction[] {
  const out: Fraction[] = [];
  let t = Fraction.ZERO;
  for (let i = 0; i < count; i++) {
    out.push(t);
    t = t.add(measureCapacity(effectiveTimeSignature(score, i)));
  }
  return out;
}

/**
 * Completa a sequência com pausas até o momento `time`, para que uma voz
 * (ou outra pauta) comece exatamente onde o cursor estava.
 */
export function padTo(events: LogicalEvent[], time: Fraction): void {
  const total = Fraction.sum(events.map((e) => e.length));
  if (!total.lt(time)) return;
  for (const d of decompose(time.sub(total))) {
    events.push({ id: newId('r'), kind: 'rest', duration: d, length: durationValue(d), notes: [], auto: true });
  }
}

function makePiece(ev: LogicalEvent, d: Duration, first: boolean, last: boolean): MusicEvent {
  const id = first ? ev.id : newId('f');
  const fragmentOf = first ? undefined : ev.id;
  const marks = first && ev.marks ? { marks: cloneMarks(ev.marks) } : {};
  if (ev.kind === 'rest') return { kind: 'rest', id, duration: d, ...marks, ...(fragmentOf ? { fragmentOf } : {}), ...(ev.auto ? { auto: true } : {}) };
  const chord: ChordEvent = {
    kind: 'chord',
    id,
    duration: d,
    notes: ev.notes.map((n) => ({ ...n, pitch: { ...n.pitch }, id: first ? n.id : newId('n'), tieToNext: last ? n.tieToNext : true })),
    ...marks,
  };
  if (fragmentOf) chord.fragmentOf = fragmentOf;
  return chord;
}

export function cloneNotes(notes: Note[]): Note[] {
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
