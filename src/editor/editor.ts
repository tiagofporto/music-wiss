import { Fraction } from '../model/fraction';
import type { Duration, DurationType } from '../model/duration';
import { DURATION_ORDER, durationValue } from '../model/duration';
import { keyAlter } from '../model/key';
import type { Alter, Pitch, Step } from '../model/pitch';
import { clefMiddle, nearestOctave, transposeOctave, transposeSemitone } from '../model/pitch';
import type { Score, Staff } from '../model/score';
import { newId } from '../model/score';
import type { LogicalEvent } from '../model/sequence';
import { readLogical, writeLogical } from '../model/sequence';

export type EditorListener = (change: EditorChange) => void;

export interface EditorChange {
  /** Nota que deve soar como retorno ao usuário (inserção ou mudança de altura). */
  sounded?: Pitch[];
}

/**
 * Estado de edição e comandos de entrada de notas. Não sabe nada de DOM:
 * a camada de UI traduz teclas em chamadas destes métodos.
 *
 * O cursor é um índice na sequência lógica da voz: 0 = antes do primeiro evento,
 * n = depois do último. O evento "selecionado" é o imediatamente antes do cursor.
 */
export class Editor {
  score: Score;
  partIndex = 0;
  staffIndex = 0;
  voiceIndex = 0;
  cursor = 0;
  inputMode = false;
  duration: Duration = { type: 'quarter', dots: 0 };
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
    return this.score.parts[this.partIndex].staves[this.staffIndex];
  }

  events(): LogicalEvent[] {
    return readLogical(this.staff, this.voiceIndex);
  }

  selected(): LogicalEvent | null {
    return this.events()[this.cursor - 1] ?? null;
  }

  /** Última nota antes do cursor, usada para escolher a oitava da próxima. */
  private previousPitch(events: LogicalEvent[]): Pitch | null {
    for (let i = this.cursor - 1; i >= 0; i--) {
      const n = events[i].notes[0];
      if (n) return n.pitch;
    }
    return null;
  }

  private commit(events: LogicalEvent[], change: EditorChange = {}): void {
    writeLogical(this.score, this.staff, events, this.voiceIndex);
    this.emit(change);
  }

  private snapshot(): void {
    this.undoStack.push(JSON.stringify({ score: this.score, cursor: this.cursor }));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify({ score: this.score, cursor: this.cursor }));
    this.restore(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify({ score: this.score, cursor: this.cursor }));
    this.restore(next);
  }

  private restore(json: string): void {
    const data = JSON.parse(json) as { score: Score; cursor: number };
    this.score = data.score;
    this.cursor = data.cursor;
    this.emit();
  }

  /** Troca a partitura inteira (nova partitura, abrir arquivo). */
  load(score: Score): void {
    this.score = score;
    this.partIndex = 0;
    this.staffIndex = 0;
    this.voiceIndex = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.cursor = this.events().length;
    this.emit();
  }

  /** Alterações de metadados (título, andamento...) que devem poder ser desfeitas. */
  mutate(fn: (score: Score) => void): void {
    this.snapshot();
    fn(this.score);
    this.commit(this.events());
  }

  toggleInputMode(force?: boolean): void {
    this.inputMode = force ?? !this.inputMode;
    this.emit();
  }

  setDuration(type: DurationType): void {
    this.duration = { type, dots: 0 };
    this.emit();
  }

  toggleDot(): void {
    // em modo de entrada o ponto vale para a próxima nota; fora dele, para a nota selecionada
    if (!this.inputMode && this.selected()) {
      this.changeSelected((ev) => {
        const dots = ev.duration.dots ? 0 : 1;
        ev.duration = { ...ev.duration, dots };
        ev.length = durationValue(ev.duration);
      });
      return;
    }
    this.duration = { ...this.duration, dots: this.duration.dots ? 0 : 1 };
    this.emit();
  }

  /** Insere uma nota pela letra (A–G). A armadura define o acidente padrão. */
  insertStep(step: Step): void {
    const events = this.events();
    // sem nota anterior, a referência é a linha do meio da clave (Si4 na de Sol, Ré3 na de Fá)
    const octave = nearestOctave(step, this.previousPitch(events) ?? clefMiddle(this.staff.clef));
    const p: Pitch = { step, octave, alter: keyAlter(this.score.keyFifths, step) };
    this.insertPitch(p);
  }

  insertPitch(p: Pitch): void {
    this.snapshot();
    const events = this.events();
    events.splice(this.cursor, 0, {
      id: newId('c'),
      kind: 'chord',
      duration: { ...this.duration },
      length: durationValue(this.duration),
      notes: [{ id: newId('n'), pitch: p, tieToNext: false }],
    });
    this.cursor += 1;
    this.commit(events, { sounded: [p] });
  }

  /** Acrescenta uma nota (por letra) ao acorde selecionado, acima da nota mais aguda. */
  addToChord(step: Step): void {
    const sel = this.selected();
    if (!sel || sel.kind !== 'chord') return this.insertStep(step);
    const top = sel.notes[sel.notes.length - 1].pitch;
    let octave = top.octave;
    const steps: Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
    if (steps.indexOf(step) <= steps.indexOf(top.step)) octave += 1;
    const p: Pitch = { step, octave, alter: keyAlter(this.score.keyFifths, step) };
    this.changeSelected((ev) => {
      ev.notes.push({ id: newId('n'), pitch: p, tieToNext: false });
    }, [p]);
  }

  insertRest(): void {
    this.snapshot();
    const events = this.events();
    events.splice(this.cursor, 0, {
      id: newId('r'),
      kind: 'rest',
      duration: { ...this.duration },
      length: durationValue(this.duration),
      notes: [],
    });
    this.cursor += 1;
    this.commit(events);
  }

  deleteBackward(): void {
    if (this.cursor === 0) return;
    this.snapshot();
    const events = this.events();
    events.splice(this.cursor - 1, 1);
    this.cursor -= 1;
    this.commit(events);
  }

  deleteForward(): void {
    const events = this.events();
    if (this.cursor >= events.length) return;
    this.snapshot();
    events.splice(this.cursor, 1);
    this.commit(events);
  }

  moveCursor(delta: number): void {
    const n = this.events().length;
    this.cursor = Math.min(n, Math.max(0, this.cursor + delta));
    const sel = this.selected();
    this.emit({ sounded: sel?.notes.map((x) => x.pitch) });
  }

  setCursor(index: number): void {
    this.cursor = Math.min(this.events().length, Math.max(0, index));
    this.emit();
  }

  /** Define o acidente de todas as notas do evento selecionado. */
  setAlter(alter: Alter): void {
    this.changeSelected((ev) => {
      for (const n of ev.notes) n.pitch = { ...n.pitch, alter };
    });
  }

  /** + / − : sobe ou desce um acidente (♭ → ♮ → ♯), limitado ao dobrado. */
  shiftAlter(dir: 1 | -1): void {
    this.changeSelected((ev) => {
      for (const n of ev.notes) {
        const alter = Math.max(-2, Math.min(2, n.pitch.alter + dir)) as Alter;
        n.pitch = { ...n.pitch, alter };
      }
    });
  }

  transposeSelected(kind: 'semitone' | 'octave', dir: 1 | -1): void {
    this.changeSelected((ev) => {
      for (const n of ev.notes) {
        n.pitch = kind === 'octave' ? transposeOctave(n.pitch, dir) : transposeSemitone(n.pitch, dir);
      }
    });
  }

  toggleTie(): void {
    this.changeSelected((ev) => {
      const on = !ev.notes.every((n) => n.tieToNext);
      for (const n of ev.notes) n.tieToNext = on;
    });
  }

  /** Muda a figura do evento selecionado (fora do modo de entrada). */
  setSelectedDuration(type: DurationType): void {
    this.changeSelected((ev) => {
      ev.duration = { type, dots: ev.duration.dots };
      ev.length = durationValue(ev.duration);
    });
  }

  /** Divide/dobra a figura atual (atalhos [ e ]). */
  stepDuration(dir: 1 | -1): void {
    const i = DURATION_ORDER.indexOf(this.duration.type) + dir;
    if (i < 0 || i >= DURATION_ORDER.length) return;
    this.setDuration(DURATION_ORDER[i]);
  }

  private changeSelected(fn: (ev: LogicalEvent) => void, sounded?: Pitch[]): void {
    const events = this.events();
    const ev = events[this.cursor - 1];
    if (!ev) return;
    this.snapshot();
    fn(ev);
    this.commit(events, { sounded: sounded ?? (ev.kind === 'chord' ? ev.notes.map((n) => n.pitch) : undefined) });
  }

  /** Duração total já escrita na voz, em semibreves. */
  totalLength(): Fraction {
    return Fraction.sum(this.events().map((e) => e.length));
  }
}
