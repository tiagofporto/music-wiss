import { Fraction } from '../model/fraction';
import type { Duration, DurationType } from '../model/duration';
import { DURATION_ORDER, durationValue } from '../model/duration';
import type { Fifths } from '../model/key';
import { keyAlter } from '../model/key';
import type { Alter, Pitch, Step } from '../model/pitch';
import { clefMiddle, diatonicIndex, toMidi, nearestOctave, transposeOctave, transposeSemitone } from '../model/pitch';
import type { Articulation, BarMark, Dynamic, Marks, Score, Staff, TimeSignature } from '../model/score';
import { allStaves, barMark, cloneMarks, createPart, setBarMark, tidyMarks, effectiveKey, effectiveTimeSignature, MAX_VOICES, measureCapacity, newId, setChange } from '../model/score';
import type { LogicalEvent } from '../model/sequence';
import { cloneNotes, logicalLength, normalizeMeasures, padTo, readLogical, reflowAll, writeLogical } from '../model/sequence';

export type EditorListener = (change: EditorChange) => void;

export interface EditorChange {
  /** a mudança veio de outra pessoa (colaboração): não salvar de volta na nuvem */
  remote?: boolean;
  /** Notas que devem soar como retorno ao usuário (inserção ou mudança de altura). */
  sounded?: Pitch[];
}

/** Onde o cursor está: instrumento, pauta dentro do instrumento e voz. */
export interface Position {
  partIndex: number;
  staffIndex: number;
  voiceIndex: number;
}

/** Normal de cada quiáltera: 3 no tempo de 2, 5 no tempo de 4... */
export const TUPLET_NORMAL: Record<number, number> = { 2: 3, 3: 2, 4: 3, 5: 4, 6: 4, 7: 4, 9: 8 };

/**
 * Estado de edição e comandos de entrada de notas. Não sabe nada de DOM:
 * a camada de UI traduz teclas em chamadas destes métodos.
 *
 * O cursor é um índice na sequência lógica da voz atual: 0 = antes do primeiro
 * evento, n = depois do último. Sem seleção de trecho, o evento "selecionado" é o
 * imediatamente antes do cursor. Com `anchor`, a seleção vai de anchor até o cursor.
 */
export class Editor {
  score: Score;
  pos: Position = { partIndex: 0, staffIndex: 0, voiceIndex: 0 };
  cursor = 0;
  anchor: number | null = null;
  inputMode = false;
  duration: Duration = { type: 'quarter', dots: 0 };
  clipboard: LogicalEvent[] | null = null;
  /** Evento onde começou uma seleção feita com Shift+clique. */
  private pivot = 0;
  private listeners: EditorListener[] = [];
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  constructor(score: Score) {
    this.score = score;
    this.cursor = this.events().length;
  }

  onChange(fn: EditorListener): void {
    this.listeners.push(fn);
  }

  private emit(change: EditorChange = {}): void {
    for (const fn of this.listeners) fn(change);
  }

  get staff(): Staff {
    return this.score.parts[this.pos.partIndex].staves[this.pos.staffIndex];
  }

  events(): LogicalEvent[] {
    return readLogical(this.staff, this.pos.voiceIndex);
  }

  // ------------------------------------------------------------ seleção

  hasRange(): boolean {
    return this.anchor !== null && this.anchor !== this.cursor;
  }

  /** Intervalo [início, fim) de eventos afetados pelos comandos. */
  range(): [number, number] | null {
    if (this.hasRange()) return [Math.min(this.anchor!, this.cursor), Math.max(this.anchor!, this.cursor)];
    if (this.cursor > 0) return [this.cursor - 1, this.cursor];
    return null;
  }

  /** Evento imediatamente antes do cursor (o "selecionado" sem trecho). */
  selected(): LogicalEvent | null {
    return this.events()[this.cursor - 1] ?? null;
  }

  selectedEvents(): LogicalEvent[] {
    const r = this.range();
    return r ? this.events().slice(r[0], r[1]) : [];
  }

  /** Aumenta o intervalo para não cortar grupos de quiáltera ao meio. */
  private expandToTuplets(events: LogicalEvent[], [a, b]: [number, number]): [number, number] {
    while (a > 0 && events[a].tuplet && events[a - 1].tuplet?.id === events[a].tuplet!.id) a--;
    while (b < events.length && events[b - 1]?.tuplet && events[b].tuplet?.id === events[b - 1].tuplet!.id) b++;
    return [a, b];
  }

  selectAll(): void {
    this.anchor = 0;
    this.cursor = this.events().length;
    this.emit();
  }

  clearSelection(): void {
    if (this.anchor === null) return;
    this.anchor = null;
    this.emit();
  }

  // ------------------------------------------------------------ histórico

  private commit(events: LogicalEvent[], change: EditorChange = {}): void {
    writeLogical(this.score, this.staff, events, this.pos.voiceIndex);
    normalizeMeasures(this.score);
    this.emit(change);
  }

  private state(): string {
    return JSON.stringify({ score: this.score, cursor: this.cursor, pos: this.pos });
  }

  private snapshot(): void {
    this.undoStack.push(this.state());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.state());
    this.restore(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.state());
    this.restore(next);
  }

  private restore(json: string): void {
    const data = JSON.parse(json) as { score: Score; cursor: number; pos: Position };
    this.score = data.score;
    this.pos = data.pos;
    this.cursor = data.cursor;
    this.anchor = null;
    this.emit();
  }

  /** Troca a partitura inteira (nova partitura, abrir arquivo). */
  load(score: Score): void {
    this.score = score;
    this.pos = { partIndex: 0, staffIndex: 0, voiceIndex: 0 };
    this.undoStack = [];
    this.redoStack = [];
    this.anchor = null;
    this.duration = { type: 'quarter', dots: 0 };
    this.cursor = this.events().length;
    this.emit();
  }

  /** Alterações de metadados (título, andamento...) que devem poder ser desfeitas. */
  mutate(fn: (score: Score) => void): void {
    this.snapshot();
    fn(this.score);
    reflowAll(this.score);
    this.clampCursor();
    this.emit();
  }

  private clampCursor(): void {
    const n = this.events().length;
    this.cursor = Math.min(this.cursor, n);
    if (this.anchor !== null) this.anchor = Math.min(this.anchor, n);
  }

  // ------------------------------------------------------------ tempo e posição

  /** Momento do cursor, em semibreves desde o início. */
  cursorTime(events = this.events()): Fraction {
    return Fraction.sum(events.slice(0, this.cursor).map((e) => e.length));
  }

  /** Compasso que contém um momento. */
  measureAt(time: Fraction): number {
    let t = Fraction.ZERO;
    for (let i = 0; i < 10000; i++) {
      t = t.add(measureCapacity(effectiveTimeSignature(this.score, i)));
      if (time.lt(t)) return i;
    }
    return 0;
  }

  cursorMeasure(): number {
    return Math.min(this.measureAt(this.cursorTime()), this.staff.measures.length - 1);
  }

  /**
   * Muda de pauta/voz mantendo o momento do cursor. Se a voz de destino ainda não
   * chega até ali, ela é completada com pausas.
   */
  setPosition(pos: Partial<Position>): void {
    const time = this.cursorTime();
    this.stripAutoRests();
    const next = { ...this.pos, ...pos };
    if (!this.score.parts[next.partIndex]?.staves[next.staffIndex]) return;
    next.voiceIndex = Math.max(0, Math.min(MAX_VOICES - 1, next.voiceIndex));
    this.pos = next;
    this.anchor = null;
    const events = this.events();
    const total = Fraction.sum(events.map((e) => e.length));
    if (total.lt(time)) {
      this.snapshot();
      padTo(events, time);
      this.cursor = events.length;
      this.commit(events);
      return;
    }
    let t = Fraction.ZERO;
    let idx = events.length;
    for (let i = 0; i < events.length; i++) {
      if (t.gte(time)) {
        idx = i;
        break;
      }
      t = t.add(events[i].length);
    }
    this.cursor = idx;
    this.emit();
  }

  /**
   * Ao sair de uma voz, as pausas que foram criadas só para levar o cursor até
   * ali (e que continuam no fim, sem nada escrito depois) são removidas.
   */
  private stripAutoRests(): void {
    const events = this.events();
    let n = events.length;
    while (n > 0 && events[n - 1].auto) n--;
    if (n === events.length) return;
    writeLogical(this.score, this.staff, events.slice(0, n), this.pos.voiceIndex);
    normalizeMeasures(this.score);
  }

  /** Vai para a pauta de cima (-1) ou de baixo (+1), passando entre instrumentos. */
  moveStaff(dir: 1 | -1): void {
    const list = allStaves(this.score);
    const i = list.findIndex((s) => s.partIndex === this.pos.partIndex && s.staffIndex === this.pos.staffIndex);
    const target = list[i + dir];
    if (target) this.setPosition({ partIndex: target.partIndex, staffIndex: target.staffIndex, voiceIndex: 0 });
  }

  setVoice(voiceIndex: number): void {
    this.setPosition({ voiceIndex });
  }

  // ------------------------------------------------------------ modo e figuras

  toggleInputMode(force?: boolean): void {
    this.inputMode = force ?? !this.inputMode;
    this.anchor = null;
    this.emit();
  }

  setDuration(type: DurationType): void {
    this.duration = { type, dots: 0 };
    this.emit();
  }

  toggleDot(): void {
    // em modo de entrada o ponto vale para a próxima nota; fora dele, para a seleção
    if (!this.inputMode && this.range()) {
      const evs = this.selectedEvents().filter((e) => !e.tuplet);
      const dots = evs.every((e) => e.duration.dots) ? 0 : 1;
      this.changeRange((ev) => {
        if (ev.tuplet) return;
        ev.duration = { ...ev.duration, dots };
        ev.length = logicalLength(ev);
      });
      return;
    }
    this.duration = { ...this.duration, dots: this.duration.dots ? 0 : 1 };
    this.emit();
  }

  /** Muda a figura dos eventos selecionados (fora do modo de entrada). */
  setSelectedDuration(type: DurationType): void {
    this.changeRange((ev) => {
      if (ev.tuplet) return;
      ev.duration = { type, dots: ev.duration.dots };
      ev.length = logicalLength(ev);
    });
  }

  /** Divide/dobra a figura atual (atalhos [ e ]). */
  stepDuration(dir: 1 | -1): void {
    const i = DURATION_ORDER.indexOf(this.duration.type) + dir;
    if (i < 0 || i >= DURATION_ORDER.length) return;
    this.setDuration(DURATION_ORDER[i]);
  }

  // ------------------------------------------------------------ entrada de notas

  /** Última nota antes do cursor, usada para escolher a oitava da próxima. */
  private previousPitch(events: LogicalEvent[]): Pitch | null {
    for (let i = this.cursor - 1; i >= 0; i--) {
      const n = events[i].notes[0];
      if (n) return n.pitch;
    }
    return null;
  }

  /** Insere uma nota pela letra (A–G). A armadura em vigor define o acidente padrão. */
  insertStep(step: Step): void {
    const events = this.events();
    // sem nota anterior, a referência é a linha do meio da clave (Si4 na de Sol, Ré3 na de Fá)
    const octave = nearestOctave(step, this.previousPitch(events) ?? clefMiddle(this.staff.clef));
    const key = effectiveKey(this.score, this.cursorMeasure());
    this.insertPitch({ step, octave, alter: keyAlter(key, step) });
  }

  insertPitch(p: Pitch): void {
    this.insertEvent('chord', [{ id: newId('n'), pitch: p, tieToNext: false }], [p]);
  }

  /** Insere um acorde inteiro de uma vez (teclado MIDI). */
  insertChord(pitches: Pitch[]): void {
    if (!pitches.length) return;
    const sorted = [...pitches].sort((a, b) => diatonicIndex(a) - diatonicIndex(b));
    this.insertEvent('chord', sorted.map((p) => ({ id: newId('n'), pitch: p, tieToNext: false })), sorted);
  }

  /** Acrescenta notas ao acorde logo antes do cursor (teclas que chegaram um pouco depois). */
  addPitchesToPrevious(pitches: Pitch[]): void {
    if (!pitches.length || this.cursor === 0) return;
    const events = this.events();
    const ev = events[this.cursor - 1];
    if (ev.kind !== 'chord') return;
    const fresh = pitches.filter((p) => !ev.notes.some((n) => toMidi(n.pitch) === toMidi(p)));
    if (!fresh.length) return;
    this.snapshot();
    for (const p of fresh) ev.notes.push({ id: newId('n'), pitch: p, tieToNext: false });
    ev.notes.sort((a, b) => diatonicIndex(a.pitch) - diatonicIndex(b.pitch));
    this.commit(events, { sounded: fresh });
  }

  insertRest(): void {
    this.insertEvent('rest', []);
  }

  /**
   * Insere no cursor. Se o cursor está numa pausa provisória de quiáltera,
   * o novo evento toma o lugar dela (com a figura da quiáltera).
   */
  private insertEvent(kind: 'chord' | 'rest', notes: LogicalEvent['notes'], sounded?: Pitch[]): void {
    this.snapshot();
    const events = this.events();
    if (this.hasRange()) this.removeRange(events);
    this.anchor = null;
    const here = events[this.cursor];
    if (here?.placeholder) {
      events[this.cursor] = { ...here, id: newId(kind === 'rest' ? 'r' : 'c'), kind, notes, placeholder: undefined };
    } else {
      const ev: LogicalEvent = { id: newId(kind === 'rest' ? 'r' : 'c'), kind, duration: { ...this.duration }, length: durationValue(this.duration), notes };
      events.splice(this.cursor, 0, ev);
    }
    this.cursor += 1;
    this.commit(events, { sounded });
  }

  /**
   * Cria uma quiáltera (Ctrl+3 = tercina) com a figura atual: entram `actual`
   * pausas provisórias e o cursor fica na primeira; as próximas notas as substituem.
   */
  insertTuplet(actual: number): string | null {
    const normal = TUPLET_NORMAL[actual];
    if (!normal) return null;
    const events = this.events();
    const tuplet = { id: newId('t'), actual, normal };
    const d = { type: this.duration.type, dots: 0 };
    // a quiáltera precisa caber no que sobra do compasso
    const time = this.cursorTime(events);
    const mi = this.measureAt(time);
    let start = Fraction.ZERO;
    for (let i = 0; i < mi; i++) start = start.add(measureCapacity(effectiveTimeSignature(this.score, i)));
    const space = measureCapacity(effectiveTimeSignature(this.score, mi)).sub(time.sub(start));
    if (logicalLength({ duration: d, tuplet }).mul(new Fraction(actual)).gt(space)) {
      return 'A quiáltera não cabe no resto do compasso. Escolha uma figura menor.';
    }
    this.snapshot();
    const group: LogicalEvent[] = Array.from({ length: actual }, () => ({
      id: newId('r'),
      kind: 'rest' as const,
      duration: d,
      length: logicalLength({ duration: d, tuplet }),
      notes: [],
      tuplet,
      placeholder: true,
    }));
    events.splice(this.cursor, 0, ...group);
    this.anchor = null;
    this.commit(events);
    return null;
  }

  /** Acrescenta uma nota (por letra) ao acorde selecionado, acima da nota mais aguda. */
  addToChord(step: Step): void {
    const sel = this.selected();
    if (!sel || sel.kind !== 'chord') return this.insertStep(step);
    const top = sel.notes.reduce((a, b) => (diatonicIndex(b.pitch) > diatonicIndex(a.pitch) ? b : a)).pitch;
    const steps: Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
    const octave = steps.indexOf(step) <= steps.indexOf(top.step) ? top.octave + 1 : top.octave;
    const p: Pitch = { step, octave, alter: keyAlter(effectiveKey(this.score, this.cursorMeasure()), step) };
    this.anchor = null;
    this.changeRange((ev) => {
      ev.notes.push({ id: newId('n'), pitch: p, tieToNext: false });
    }, [p]);
  }

  // ------------------------------------------------------------ apagar

  /** Remove o trecho selecionado de `events` (ajustando o cursor). */
  private removeRange(events: LogicalEvent[]): void {
    const r = this.range();
    if (!r) return;
    const [a, b] = this.expandToTuplets(events, r);
    events.splice(a, b - a);
    this.cursor = a;
    this.anchor = null;
  }

  deleteBackward(): void {
    if (this.hasRange()) return this.deleteRange();
    if (this.cursor === 0) return;
    this.snapshot();
    const events = this.events();
    const ev = events[this.cursor - 1];
    if (ev.tuplet && ev.kind === 'chord') {
      // dentro de quiáltera, a nota vira pausa provisória para o grupo continuar completo
      events[this.cursor - 1] = { ...ev, kind: 'rest', notes: [], placeholder: true };
      this.cursor -= 1;
    } else if (ev.tuplet) {
      const [a, b] = this.expandToTuplets(events, [this.cursor - 1, this.cursor]);
      events.splice(a, b - a);
      this.cursor = a;
    } else {
      events.splice(this.cursor - 1, 1);
      this.cursor -= 1;
    }
    this.commit(events);
  }

  deleteForward(): void {
    if (this.hasRange()) return this.deleteRange();
    const events = this.events();
    if (this.cursor >= events.length) return;
    this.cursor += 1;
    this.deleteBackward();
  }

  deleteRange(): void {
    if (!this.range()) return;
    this.snapshot();
    const events = this.events();
    this.removeRange(events);
    this.commit(events);
  }

  // ------------------------------------------------------------ cursor

  moveCursor(delta: number, extend = false): void {
    const n = this.events().length;
    if (extend && this.anchor === null) this.anchor = this.cursor;
    if (!extend) this.anchor = null;
    this.cursor = Math.min(n, Math.max(0, this.cursor + delta));
    const sel = this.selected();
    this.emit({ sounded: extend ? undefined : sel?.notes.map((x) => x.pitch) });
  }

  setCursor(index: number, extend = false): void {
    if (extend && this.anchor === null) this.anchor = this.cursor;
    if (!extend) this.anchor = null;
    this.cursor = Math.min(this.events().length, Math.max(0, index));
    this.emit();
  }

  /** Clique numa nota: vai para a pauta/voz dela e seleciona. */
  clickEvent(pos: Position, index: number, extend = false): void {
    const samePlace = pos.partIndex === this.pos.partIndex && pos.staffIndex === this.pos.staffIndex && pos.voiceIndex === this.pos.voiceIndex;
    if (!samePlace) {
      this.pos = { ...pos };
      this.anchor = null;
      extend = false;
    }
    if (extend) {
      // seleciona do evento onde a seleção começou até o evento clicado, inclusive
      if (this.anchor === null) this.pivot = Math.max(0, this.cursor - 1);
      this.anchor = Math.min(this.pivot, index);
      this.cursor = Math.max(this.pivot, index) + 1;
    } else {
      this.anchor = null;
      this.pivot = index;
      this.cursor = index + 1;
    }
    this.clampCursor();
    this.emit({ sounded: extend ? undefined : this.selected()?.notes.map((n) => n.pitch) });
  }

  // ------------------------------------------------------------ alterações na seleção

  /** Define o acidente de todas as notas selecionadas. */
  setAlter(alter: Alter): void {
    this.changeRange((ev) => {
      for (const n of ev.notes) n.pitch = { ...n.pitch, alter };
    });
  }

  /** + / − : sobe ou desce um acidente (♭ → ♮ → ♯), limitado ao dobrado. */
  shiftAlter(dir: 1 | -1): void {
    this.changeRange((ev) => {
      for (const n of ev.notes) {
        const alter = Math.max(-2, Math.min(2, n.pitch.alter + dir)) as Alter;
        n.pitch = { ...n.pitch, alter };
      }
    });
  }

  transposeSelected(kind: 'semitone' | 'octave', dir: 1 | -1): void {
    this.changeRange((ev) => {
      for (const n of ev.notes) {
        n.pitch = kind === 'octave' ? transposeOctave(n.pitch, dir) : transposeSemitone(n.pitch, dir);
      }
    });
  }

  toggleTie(): void {
    const evs = this.selectedEvents().filter((e) => e.kind === 'chord');
    const on = !evs.every((ev) => ev.notes.every((n) => n.tieToNext));
    this.changeRange((ev) => {
      for (const n of ev.notes) n.tieToNext = on;
    });
  }

  private changeRange(fn: (ev: LogicalEvent) => void, sounded?: Pitch[]): void {
    const r = this.range();
    if (!r) return;
    const events = this.events();
    this.snapshot();
    const touched = events.slice(r[0], r[1]);
    touched.forEach(fn);
    const single = touched.length === 1 && touched[0].kind === 'chord' ? touched[0].notes.map((n) => n.pitch) : undefined;
    this.commit(events, { sounded: sounded ?? single });
  }

  // ------------------------------------------------------------ copiar e colar

  copy(): number {
    const r = this.range();
    if (!r) return 0;
    const events = this.events();
    const [a, b] = this.expandToTuplets(events, r);
    this.clipboard = events.slice(a, b).map((e) => ({ ...e, notes: cloneNotes(e.notes), tuplet: e.tuplet && { ...e.tuplet } }));
    return this.clipboard.length;
  }

  cut(): number {
    const n = this.copy();
    if (n) this.deleteRange();
    return n;
  }

  /** Cola no cursor (substituindo o trecho selecionado, se houver). */
  paste(): number {
    if (!this.clipboard?.length) return 0;
    this.snapshot();
    const events = this.events();
    if (this.hasRange()) this.removeRange(events);
    const tupletIds = new Map<string, string>();
    const items = this.clipboard.map((e) => {
      const tuplet = e.tuplet && { ...e.tuplet, id: tupletIds.get(e.tuplet.id) ?? tupletIds.set(e.tuplet.id, newId('t')).get(e.tuplet.id)! };
      return { ...e, id: newId('c'), notes: cloneNotes(e.notes).map((n) => ({ ...n, id: newId('n') })), tuplet, auto: undefined, marks: cloneMarks(e.marks) };
    });
    events.splice(this.cursor, 0, ...items);
    this.anchor = null; // colar de novo acrescenta outra cópia logo depois
    this.cursor += items.length;
    this.commit(events);
    return items.length;
  }

  // ------------------------------------------------------------ partitura

  /** Muda a fórmula de compasso a partir do compasso do cursor. */
  setTimeSignatureHere(ts: TimeSignature): void {
    const m = this.cursorMeasure();
    this.mutate((s) => setChange(s, m, { timeSignature: ts }));
  }

  // ------------------------------------------------------------ expressão e texto

  /** Compasso da nota selecionada (ou do cursor, sem seleção). */
  selectionMeasure(): number {
    const r = this.range();
    if (!r) return this.cursorMeasure();
    const events = this.events();
    let t = Fraction.ZERO;
    for (let i = 0; i < r[0]; i++) t = t.add(events[i].length);
    return Math.min(this.measureAt(t), this.staff.measures.length - 1);
  }

  private changeMarks(indices: number[], fn: (m: Marks, ev: LogicalEvent, index: number) => void): void {
    const events = this.events();
    const valid = indices.filter((i) => events[i]);
    if (!valid.length) return;
    this.snapshot();
    for (const i of valid) {
      const ev = events[i];
      const m = cloneMarks(ev.marks) ?? {};
      fn(m, ev, i);
      ev.marks = tidyMarks(m);
      if (!ev.marks) delete ev.marks;
    }
    this.commit(events);
  }

  private rangeIndices(): number[] {
    const r = this.range();
    if (!r) return [];
    return Array.from({ length: r[1] - r[0] }, (_, k) => r[0] + k);
  }

  /** Liga/desliga uma articulação nas notas selecionadas (fermata vale também para pausas). */
  toggleArticulation(a: Articulation): void {
    const events = this.events();
    const idx = this.rangeIndices().filter((i) => events[i].kind === 'chord' || a === 'fermata');
    if (!idx.length) return;
    const allHave = idx.every((i) => events[i].marks?.articulations?.includes(a));
    // staccato e staccatissimo (e acento e marcato) não andam juntos
    const rival: Partial<Record<Articulation, Articulation>> = { staccato: 'staccatissimo', staccatissimo: 'staccato', accent: 'marcato', marcato: 'accent' };
    this.changeMarks(idx, (m) => {
      const list = (m.articulations ?? []).filter((x) => x !== a && x !== rival[a]);
      m.articulations = allHave ? list : [...list, a];
    });
  }

  /** Põe a dinâmica no primeiro evento selecionado (de novo a mesma = tirar). */
  setDynamic(d: Dynamic | null): void {
    const idx = this.rangeIndices();
    if (!idx.length) return;
    const first = this.events()[idx[0]];
    const value = d && first.marks?.dynamic === d ? undefined : (d ?? undefined);
    this.changeMarks([idx[0]], (m) => {
      m.dynamic = value;
    });
  }

  /** Texto (letra ou cifra) de um evento da voz atual, pelo índice lógico. */
  setText(kind: 'lyric' | 'chordSymbol', index: number, value: string): void {
    const current = this.events()[index]?.marks?.[kind] ?? '';
    if (current === value.trim()) return;
    this.changeMarks([index], (m) => {
      m[kind] = value;
    });
  }

  /** Vários textos de uma vez (ex.: cifras sugeridas pelo assistente), num só passo de desfazer. */
  setTexts(kind: 'lyric' | 'chordSymbol', values: Array<[number, string]>): void {
    const map = new Map(values);
    this.changeMarks([...map.keys()], (m, _ev, i) => {
      m[kind] = map.get(i);
    });
  }

  /**
   * Troca a partitura por outra versão (vinda da nuvem ou de um colaborador),
   * mantendo a posição e permitindo desfazer para a versão local.
   */
  replaceScore(score: Score, change: EditorChange = { remote: true }): void {
    this.snapshot();
    this.score = score;
    const part = Math.min(this.pos.partIndex, score.parts.length - 1);
    const staff = Math.min(this.pos.staffIndex, score.parts[part].staves.length - 1);
    this.pos = { partIndex: part, staffIndex: staff, voiceIndex: this.pos.voiceIndex };
    this.anchor = null;
    this.clampCursor();
    this.emit(change);
  }

  /** Marca de repetição/casa no compasso da seleção (de novo a mesma = tirar). */
  toggleBar(kind: 'repeatStart' | 'repeatEnd' | 'ending1' | 'ending2'): void {
    const mi = this.selectionMeasure();
    const cur = barMark(this.score, mi);
    this.mutate((s) => {
      let patch: Partial<Omit<BarMark, 'measure'>>;
      if (kind === 'ending1') patch = { ending: cur.ending === 1 ? undefined : 1 };
      else if (kind === 'ending2') patch = { ending: cur.ending === 2 ? undefined : 2 };
      else patch = { [kind]: !cur[kind] };
      setBarMark(s, mi, patch);
    });
  }

  /** Muda a tonalidade a partir do compasso do cursor. */
  setKeyHere(fifths: Fifths): void {
    const m = this.cursorMeasure();
    this.mutate((s) => setChange(s, m, { keyFifths: fifths }));
  }

  addPart(instrumentId: string): void {
    this.mutate((s) => s.parts.push(createPart(instrumentId, this.staff.measures.length)));
  }

  removePart(partIndex = this.pos.partIndex): void {
    if (this.score.parts.length <= 1) return;
    this.mutate((s) => s.parts.splice(partIndex, 1));
    this.pos = { partIndex: Math.min(partIndex, this.score.parts.length - 1), staffIndex: 0, voiceIndex: 0 };
    this.clampCursor();
    this.emit();
  }

  /** Duração total já escrita na voz atual, em semibreves. */
  totalLength(): Fraction {
    return Fraction.sum(this.events().map((e) => e.length));
  }
}
