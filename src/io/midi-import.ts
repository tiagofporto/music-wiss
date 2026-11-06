import { Fraction } from '../model/fraction';
import { decompose, durationValue } from '../model/duration';
import type { Fifths } from '../model/key';
import type { Clef } from '../model/pitch';
import { spellMidi } from '../model/pitch';
import type { Part, Score, TimeSignature } from '../model/score';
import { emptyMeasure, INSTRUMENTS, measureCapacity, newId, setChange } from '../model/score';
import type { LogicalEvent } from '../model/sequence';
import { normalizeMeasures, writeLogical } from '../model/sequence';
import type { ImportResult } from './musicxml-import';

/**
 * Lê um arquivo MIDI padrão (.mid, formatos 0 e 1) e monta uma partitura editável.
 *
 * O MIDI guarda quando cada tecla foi apertada, não a escrita. Para virar
 * partitura, os tempos são arredondados para a grade de semicolcheias
 * (tercinas ficam aproximadas), cada trilha vira um instrumento
 * (canal 10, percussão, fica de fora) e notas que se sobrepõem vão para a 2ª voz.
 */

interface RawNote {
  start: number; // ticks
  end: number;
  midi: number;
  velocity: number;
}

interface RawTrack {
  name: string;
  program: number | null;
  channel: number | null;
  notes: RawNote[];
}

interface Meta<T> {
  tick: number;
  value: T;
}

export interface MidiFile {
  format: number;
  ticksPerQuarter: number;
  tracks: RawTrack[];
  tempos: Array<Meta<number>>; // bpm da semínima
  timeSignatures: Array<Meta<TimeSignature>>;
  keys: Array<Meta<Fifths>>;
}

class Reader {
  pos = 0;
  constructor(private readonly b: Uint8Array) {}
  get done() {
    return this.pos >= this.b.length;
  }
  u8() {
    if (this.pos >= this.b.length) throw new Error('Arquivo MIDI cortado');
    return this.b[this.pos++];
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  u32() {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }
  str(n: number) {
    return String.fromCharCode(...this.bytes(n));
  }
  bytes(n: number) {
    if (this.pos + n > this.b.length) throw new Error('Arquivo MIDI cortado');
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  varLen() {
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.u8();
      n = (n << 7) | (c & 0x7f);
      if (!(c & 0x80)) return n;
    }
    throw new Error('Número inválido no arquivo MIDI');
  }
}

/** Lê os bytes do arquivo (sem interpretar como partitura). */
export function parseMidi(data: Uint8Array): MidiFile {
  const r = new Reader(data);
  if (data.length < 14 || r.str(4) !== 'MThd') throw new Error('Isto não parece um arquivo MIDI');
  const headerLen = r.u32();
  const format = r.u16();
  const trackCount = r.u16();
  const division = r.u16();
  r.bytes(headerLen - 6);
  if (division & 0x8000) throw new Error('MIDI com tempo em SMPTE ainda não é suportado');
  if (format > 1) throw new Error('MIDI formato 2 ainda não é suportado');

  const out: MidiFile = { format, ticksPerQuarter: division || 480, tracks: [], tempos: [], timeSignatures: [], keys: [] };
  for (let t = 0; t < trackCount && !r.done; t++) {
    const id = r.str(4);
    const len = r.u32();
    const end = r.pos + len;
    if (id !== 'MTrk') {
      r.pos = end;
      continue;
    }
    // em formato 0, tudo vem numa trilha: separamos por canal
    const byChannel = new Map<number, RawTrack>();
    let name = '';
    const open = new Map<number, RawNote[]>(); // canal*128+nota → notas abertas
    let tick = 0;
    let status = 0;
    const trackFor = (ch: number) => {
      let tr = byChannel.get(ch);
      if (!tr) byChannel.set(ch, (tr = { name: '', program: null, channel: ch, notes: [] }));
      return tr;
    };
    const noteOff = (ch: number, key: number) => {
      const list = open.get(ch * 128 + key);
      const n = list?.shift();
      if (n) n.end = tick;
    };
    while (r.pos < end) {
      tick += r.varLen();
      let b = r.u8();
      if (b === 0xff) {
        const type = r.u8();
        const data = r.bytes(r.varLen());
        if (type === 0x03 && !name) name = new TextDecoder('latin1').decode(data).trim();
        else if (type === 0x51 && data.length === 3) out.tempos.push({ tick, value: 60_000_000 / ((data[0] << 16) | (data[1] << 8) | data[2]) });
        else if (type === 0x58 && data.length >= 2) out.timeSignatures.push({ tick, value: { beats: data[0], beatType: 2 ** data[1] } });
        else if (type === 0x59 && data.length >= 1) out.keys.push({ tick, value: Math.max(-7, Math.min(7, (data[0] << 24) >> 24)) as Fifths });
        else if (type === 0x2f) break;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        r.bytes(r.varLen());
        continue;
      }
      if (b & 0x80) status = b;
      else {
        if (!status) throw new Error('Arquivo MIDI inválido');
        r.pos--; // running status: este byte já é dado
        b = status;
      }
      const kind = b & 0xf0;
      const ch = b & 0x0f;
      const d1 = r.u8();
      const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : r.u8();
      if (kind === 0x90 && d2 > 0) {
        const n: RawNote = { start: tick, end: -1, midi: d1, velocity: d2 };
        trackFor(ch).notes.push(n);
        const k = ch * 128 + d1;
        open.set(k, [...(open.get(k) ?? []), n]);
      } else if (kind === 0x80 || kind === 0x90) noteOff(ch, d1);
      else if (kind === 0xc0) {
        const tr = trackFor(ch);
        if (tr.program === null) tr.program = d1;
      }
    }
    r.pos = end;
    for (const list of open.values()) for (const n of list) n.end = tick; // sem note-off: vai até o fim
    for (const tr of byChannel.values()) {
      tr.notes = tr.notes.filter((n) => n.end > n.start);
      if (!tr.notes.length) continue;
      tr.name = name;
      out.tracks.push(tr);
    }
  }
  for (const list of [out.tempos, out.timeSignatures, out.keys] as Array<Array<Meta<unknown>>>) list.sort((a, b) => a.tick - b.tick);
  return out;
}

/** Instrumento do Music Wiss mais parecido com um programa General MIDI. */
function presetFor(program: number, name: string): string {
  const n = name.toLowerCase();
  const byName: Array<[RegExp, string]> = [
    [/piano|teclado|keys/, 'piano'], [/flaut|flute/, 'flute'], [/violin|violino/, 'violin'], [/viola\b/, 'viola'],
    [/cello|violoncelo/, 'cello'], [/voz|voice|vocal|soprano|alto|tenor|baixo vocal|melod/, 'voice'], [/guitar|viol[aã]o/, 'guitar'],
    [/bass|contrabaixo/, 'bass'], [/organ|[oó]rg[aã]o/, 'organ'], [/trumpet|trompete/, 'trumpet'], [/trombone/, 'trombone'],
    [/clarinet/, 'clarinet'], [/sax/, 'sax-alto'],
  ];
  for (const [re, id] of byName) if (re.test(n)) return id;
  if (program <= 7) return 'piano';
  if (program >= 16 && program <= 23) return 'organ';
  if (program >= 24 && program <= 31) return 'guitar';
  if (program >= 32 && program <= 39) return 'bass';
  if (program === 40 || program === 44 || program === 45 || program === 48 || program === 49) return 'violin';
  if (program === 41) return 'viola';
  if (program === 42 || program === 43) return 'cello';
  if (program >= 52 && program <= 54) return 'voice';
  if (program === 56 || program === 59) return 'trumpet';
  if (program >= 57 && program <= 58) return 'trombone';
  if (program >= 64 && program <= 67) return 'sax-alto';
  if (program === 71) return 'clarinet';
  if (program >= 72 && program <= 79) return 'flute';
  return 'piano';
}

/** Grade de arredondamento: semicolcheia. */
const GRID = 16;

/**
 * Converte o MIDI em partitura.
 * Os tempos ficam na grade de semicolcheias; notas mais curtas viram semicolcheias.
 */
export function importMidi(data: Uint8Array, title = 'Sem título'): ImportResult {
  const file = parseMidi(data);
  const warnings = new Set<string>();
  const tpq = file.ticksPerQuarter;
  const toGrid = (tick: number) => Math.round((tick / tpq) * (GRID / 4));

  const ts0 = file.timeSignatures.find((t) => t.tick === 0)?.value ?? file.timeSignatures[0]?.value ?? { beats: 4, beatType: 4 };
  const key0 = file.keys.find((k) => k.tick === 0)?.value ?? file.keys[0]?.value ?? 0;
  const tempo = Math.round(file.tempos[0]?.value ?? 120);
  if (new Set(file.tempos.map((t) => Math.round(t.value))).size > 1) warnings.add('O andamento muda durante a música; usei o primeiro.');

  const score: Score = {
    id: newId('s'),
    title,
    composer: '',
    tempo: Math.max(20, Math.min(300, tempo)),
    timeSignature: ts0,
    keyFifths: key0,
    changes: [],
    parts: [],
  };

  // mudanças de compasso/tonalidade: só valem se caírem no início de um compasso
  const measureAt = (grid: number): number | null => {
    let m = 0;
    let at = 0;
    let ts = ts0;
    const tsList = file.timeSignatures.filter((t) => t.tick > 0).map((t) => ({ g: toGrid(t.tick), v: t.value }));
    while (at < grid) {
      const len = (GRID * ts.beats) / ts.beatType;
      at += len;
      m++;
      const next = tsList.find((t) => t.g === at);
      if (next) ts = next.v;
    }
    return at === grid ? m : null;
  };
  for (const t of file.timeSignatures) {
    if (t.tick === 0) continue;
    const m = measureAt(toGrid(t.tick));
    if (m === null) warnings.add('Uma mudança de compasso fora da barra foi ignorada.');
    else setChange(score, m, { timeSignature: t.value });
  }
  for (const k of file.keys) {
    if (k.tick === 0 || k.value === key0) continue;
    const m = measureAt(toGrid(k.tick));
    if (m !== null) setChange(score, m, { keyFifths: k.value });
  }

  let shortNotes = false;
  for (const tr of file.tracks) {
    if (tr.channel === 9) {
      warnings.add('A percussão (canal 10) ainda não é importada.');
      continue;
    }
    const preset = INSTRUMENTS.find((i) => i.id === presetFor(tr.program ?? 0, tr.name))!;
    const notes = tr.notes.map((n) => {
      const start = toGrid(n.start);
      let end = toGrid(n.end);
      if (end <= start) {
        end = start + 1;
        shortNotes = true;
      }
      return { start, end, midi: n.midi - preset.transposition, velocity: n.velocity };
    });
    const pitches = notes.map((n) => n.midi).sort((a, b) => a - b);
    const median = pitches[Math.floor(pitches.length / 2)];
    const low = pitches.filter((p) => p < 57).length;
    const high = pitches.filter((p) => p > 64).length;
    // duas pautas quando a música usa bem as duas regiões (piano, órgão)
    const grand = preset.clefs.length === 2 || (low > notes.length * 0.15 && high > notes.length * 0.15 && pitches[pitches.length - 1] - pitches[0] > 24);
    const clefs: Clef[] = grand ? ['treble', 'bass'] : [median >= 57 ? 'treble' : 'bass'];
    const part: Part = {
      id: newId('p'),
      name: tr.name || preset.name,
      instrument: preset.id,
      midiProgram: tr.program ?? preset.midiProgram,
      transposition: preset.transposition,
      staves: clefs.map((clef) => ({ id: newId('st'), clef, measures: [emptyMeasure()] })),
    };
    score.parts.push(part);
    part.staves.forEach((staff, si) => {
      const mine = grand ? notes.filter((n) => (si === 0 ? n.midi >= 60 : n.midi < 60)) : notes;
      const { voices, truncated } = toVoices(mine, score);
      if (truncated) warnings.add('Havia notas sobrepostas demais; algumas foram encurtadas.');
      voices.forEach((events, vi) => writeLogical(score, staff, events, vi));
    });
  }
  if (!score.parts.length) throw new Error('O arquivo MIDI não tem notas');
  if (shortNotes) warnings.add('Notas muito curtas viraram semicolcheias.');
  normalizeMeasures(score);
  return { score, warnings: [...warnings] };
}

interface GridNote {
  start: number;
  end: number;
  midi: number;
}

/**
 * Agrupa notas que começam juntas em acordes e reparte em vozes:
 * a voz 1 recebe tudo que não se sobrepõe; o que se sobrepõe vai para a voz 2.
 */
function toVoices(notes: GridNote[], score: Score): { voices: LogicalEvent[][]; truncated: boolean } {
  const byStart = new Map<number, GridNote[]>();
  for (const n of notes) byStart.set(n.start, [...(byStart.get(n.start) ?? []), n]);
  const starts = [...byStart.keys()].sort((a, b) => a - b);
  const voices: Array<{ end: number; chords: Array<{ start: number; end: number; midis: number[] }> }> = [];
  let truncated = false;
  for (const s of starts) {
    const group = byStart.get(s)!;
    // acorde = notas que começam juntas; dura o mesmo que a mais curta (o resto é cortado)
    const end = Math.min(...group.map((n) => n.end));
    const midis = [...new Set(group.map((n) => n.midi))].sort((a, b) => a - b);
    let v = voices.find((x) => x.end <= s);
    if (!v) {
      if (voices.length < 2) voices.push((v = { end: 0, chords: [] }));
      else {
        // sem voz livre: encurta a que termina primeiro
        v = voices.reduce((a, b) => (a.end <= b.end ? a : b));
        const last = v.chords[v.chords.length - 1];
        last.end = s;
        truncated = true;
      }
    }
    v.chords.push({ start: s, end, midis });
    v.end = end;
  }
  // limita cada acorde ao início do próximo na mesma voz
  const events = voices.map((v) => {
    const out: LogicalEvent[] = [];
    let t = 0;
    v.chords.forEach((c, i) => {
      const end = Math.min(c.end, v.chords[i + 1]?.start ?? Infinity);
      if (c.start > t) pushEvent(out, 'rest', c.start - t, []);
      const fifths = keyAt(score, c.start);
      pushEvent(out, 'chord', end - c.start, c.midis.map((m) => spellMidi(m, fifths)));
      t = end;
    });
    return out;
  });
  return { voices: events, truncated };
}

function keyAt(score: Score, grid: number): Fifths {
  // basta a tonalidade inicial e as mudanças por compasso
  let k = score.keyFifths;
  let at = 0;
  let m = 0;
  while (at <= grid && m < 10_000) {
    const ch = score.changes.find((c) => c.measure === m);
    if (ch?.keyFifths !== undefined) k = ch.keyFifths;
    const ts = [...score.changes].reverse().find((c) => c.measure <= m && c.timeSignature)?.timeSignature ?? score.timeSignature;
    at += measureCapacity(ts).toNumber() * GRID;
    m++;
  }
  return k;
}

function pushEvent(out: LogicalEvent[], kind: 'chord' | 'rest', gridLen: number, pitches: ReturnType<typeof spellMidi>[]) {
  const length = new Fraction(gridLen, GRID);
  if (kind === 'rest') {
    // pausas longas viram várias pausas (não se ligam pausas)
    for (const d of decompose(length)) out.push({ id: newId('r'), kind: 'rest', duration: d, length: durationValue(d), notes: [] });
    return;
  }
  const parts = decompose(length);
  out.push({
    id: newId('e'),
    kind: 'chord',
    duration: parts[0],
    length,
    notes: pitches.map((p) => ({ id: newId('n'), pitch: p, tieToNext: false })),
  });
}
