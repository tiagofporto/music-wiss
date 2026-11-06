/**
 * Entrada por teclado MIDI (Web MIDI). Junta as teclas apertadas quase ao mesmo
 * tempo num acorde e avisa quando cada nota é tocada (para soar na hora).
 */

export interface MidiNote {
  midi: number;
  velocity: number;
}

/**
 * Agrupa notas que chegam dentro de uma janela curta. A primeira tecla abre a
 * janela; quando ela fecha, o acorde é entregue. Uma tecla que chega depois,
 * enquanto alguma do acorde ainda está apertada, vira `late` (para somar ao
 * acorde já escrito em vez de criar outro).
 */
export class ChordGrouper {
  private pending: MidiNote[] = [];
  private timer: unknown = null;
  private held = new Set<number>();
  private lastChordHeld = false;

  constructor(
    private onChord: (notes: MidiNote[], late: boolean) => void,
    readonly windowMs = 60,
    private clock: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    },
  ) {}

  noteOn(n: MidiNote): void {
    const late = !this.pending.length && this.held.size > 0 && this.lastChordHeld;
    this.held.add(n.midi);
    if (late) {
      this.onChord([n], true);
      return;
    }
    if (this.pending.some((p) => p.midi === n.midi)) return;
    this.pending.push(n);
    if (!this.timer) this.timer = this.clock.set(() => this.flush(), this.windowMs);
  }

  noteOff(midi: number): void {
    this.held.delete(midi);
    if (!this.held.size) this.lastChordHeld = false;
  }

  flush(): void {
    if (this.timer) this.clock.clear(this.timer);
    this.timer = null;
    if (!this.pending.length) return;
    const notes = this.pending.sort((a, b) => a.midi - b.midi);
    this.pending = [];
    this.lastChordHeld = this.held.size > 0;
    this.onChord(notes, false);
  }

  reset(): void {
    if (this.timer) this.clock.clear(this.timer);
    this.timer = null;
    this.pending = [];
    this.held.clear();
    this.lastChordHeld = false;
  }
}

/** Interpreta uma mensagem MIDI crua. Nota com intensidade 0 conta como soltar. */
export function parseMidiMessage(data: ArrayLike<number>): { type: 'on' | 'off'; midi: number; velocity: number } | null {
  if (data.length < 3) return null;
  const cmd = data[0] & 0xf0;
  if (cmd === 0x90 && data[2] > 0) return { type: 'on', midi: data[1], velocity: data[2] };
  if (cmd === 0x80 || cmd === 0x90) return { type: 'off', midi: data[1], velocity: 0 };
  return null;
}

export interface MidiInputEvents {
  /** cada tecla apertada (para tocar o som na hora) */
  onNoteOn(n: MidiNote): void;
  onNoteOff?(midi: number): void;
  /** acorde agrupado (para escrever na partitura) */
  onChord(notes: MidiNote[], late: boolean): void;
  /** aparelhos conectados mudaram */
  onDevices(names: string[]): void;
}


/** Liga o Web MIDI. Devolve uma mensagem de erro em português, ou null se deu certo. */
export async function connectMidi(events: MidiInputEvents): Promise<{ error: string | null; disconnect: () => void }> {
  const nav = navigator as Partial<Navigator>;
  if (!nav.requestMIDIAccess) {
    return { error: 'Este navegador não tem Web MIDI. Use Chrome, Edge ou Opera no computador.', disconnect: () => undefined };
  }
  let access: MIDIAccess;
  try {
    access = await nav.requestMIDIAccess.call(navigator);
  } catch {
    return { error: 'O navegador não liberou o acesso ao MIDI.', disconnect: () => undefined };
  }
  const grouper = new ChordGrouper((notes, late) => events.onChord(notes, late));
  const bind = () => {
    const names: string[] = [];
    access.inputs.forEach((input) => {
      names.push(input.name || 'Teclado MIDI');
      input.onmidimessage = (e) => {
        if (!e.data) return;
        const m = parseMidiMessage(e.data);
        if (!m) return;
        if (m.type === 'on') {
          events.onNoteOn(m);
          grouper.noteOn(m);
        } else {
          grouper.noteOff(m.midi);
          events.onNoteOff?.(m.midi);
        }
      };
    });
    events.onDevices(names);
  };
  bind();
  access.onstatechange = bind;
  return {
    error: null,
    disconnect: () => {
      access.onstatechange = null;
      access.inputs.forEach((i) => (i.onmidimessage = null));
      grouper.reset();
      events.onDevices([]);
    },
  };
}
