/**
 * Leitor e tocador de SoundFont 2 (.sf2) e SoundFont 3 (.sf3, amostras em Ogg Vorbis).
 *
 * Lê a estrutura RIFF (presets → instrumentos → amostras), escolhe a zona certa
 * pela nota e intensidade e toca com Web Audio, aplicando afinação, laço (loop),
 * envelope de volume, atenuação, filtro e pan definidos no arquivo.
 */

export interface SfSample {
  name: string;
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
  sampleRate: number;
  originalPitch: number;
  pitchCorrection: number;
  type: number;
}

/** Geradores (parâmetros) de uma zona, pelo número do gerador SF2. */
export type Gens = Map<number, number>;

export interface SfZone {
  gens: Gens;
  keyLo: number;
  keyHi: number;
  velLo: number;
  velHi: number;
}

export interface SfInstrument {
  name: string;
  global: Gens | null;
  zones: Array<SfZone & { sample: number }>;
}

export interface SfPreset {
  name: string;
  program: number;
  bank: number;
  global: Gens | null;
  zones: Array<SfZone & { instrument: number }>;
}

export interface SoundFont {
  name: string;
  presets: SfPreset[];
  instruments: SfInstrument[];
  samples: SfSample[];
  /** amostras de 16 bits (SF2) */
  pcm: Int16Array | null;
  /** dados brutos do bloco de amostras (SF3: cada amostra é um Ogg) */
  raw: Uint8Array;
  compressed: boolean;
}

// números dos geradores usados
export const G = {
  startAddrsOffset: 0,
  endAddrsOffset: 1,
  startloopAddrsOffset: 2,
  endloopAddrsOffset: 3,
  startAddrsCoarseOffset: 4,
  endAddrsCoarseOffset: 12,
  initialFilterFc: 8,
  pan: 17,
  delayVolEnv: 33,
  attackVolEnv: 34,
  holdVolEnv: 35,
  decayVolEnv: 36,
  sustainVolEnv: 37,
  releaseVolEnv: 38,
  instrument: 41,
  keyRange: 43,
  velRange: 44,
  startloopAddrsCoarseOffset: 45,
  initialAttenuation: 48,
  endloopAddrsCoarseOffset: 50,
  coarseTune: 51,
  fineTune: 52,
  sampleID: 53,
  sampleModes: 54,
  scaleTuning: 56,
  overridingRootKey: 58,
} as const;

const DEFAULTS: Record<number, number> = {
  [G.initialFilterFc]: 13500,
  [G.delayVolEnv]: -12000,
  [G.attackVolEnv]: -12000,
  [G.holdVolEnv]: -12000,
  [G.decayVolEnv]: -12000,
  [G.sustainVolEnv]: 0,
  [G.releaseVolEnv]: -12000,
  [G.scaleTuning]: 100,
  [G.overridingRootKey]: -1,
};

interface Chunk {
  id: string;
  type?: string;
  start: number;
  size: number;
}

function fourcc(v: DataView, o: number): string {
  return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
}

function readChunks(v: DataView, start: number, end: number): Chunk[] {
  const out: Chunk[] = [];
  let o = start;
  while (o + 8 <= end) {
    const id = fourcc(v, o);
    const size = v.getUint32(o + 4, true);
    const c: Chunk = { id, start: o + 8, size };
    if (id === 'LIST' || id === 'RIFF') {
      c.type = fourcc(v, o + 8);
      c.start = o + 12;
      c.size = size - 4;
    }
    out.push(c);
    o += 8 + size + (size % 2);
  }
  return out;
}

function str(v: DataView, o: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = v.getUint8(o + i);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** Lê um arquivo .sf2/.sf3. Lança erro se o arquivo não for um SoundFont. */
export function parseSoundFont(bytes: Uint8Array, fileName = 'SoundFont'): SoundFont {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || fourcc(v, 0) !== 'RIFF' || fourcc(v, 8) !== 'sfbk') {
    throw new Error('Este arquivo não é um SoundFont (.sf2 / .sf3)');
  }
  const top = readChunks(v, 12, Math.min(bytes.byteLength, 8 + v.getUint32(4, true)));
  const list = (t: string) => top.find((c) => c.id === 'LIST' && c.type === t);
  const info = list('INFO');
  const sdta = list('sdta');
  const pdta = list('pdta');
  if (!sdta || !pdta) throw new Error('SoundFont incompleto');

  let name = fileName;
  let version = 2;
  if (info) {
    for (const c of readChunks(v, info.start, info.start + info.size)) {
      if (c.id === 'INAM') name = str(v, c.start, c.size) || name;
      if (c.id === 'ifil') version = v.getUint16(c.start, true);
    }
  }
  const smpl = readChunks(v, sdta.start, sdta.start + sdta.size).find((c) => c.id === 'smpl');
  const raw = smpl ? bytes.subarray(smpl.start, smpl.start + smpl.size) : new Uint8Array();

  const p: Record<string, Chunk> = {};
  for (const c of readChunks(v, pdta.start, pdta.start + pdta.size)) p[c.id] = c;
  for (const id of ['phdr', 'pbag', 'pgen', 'inst', 'ibag', 'igen', 'shdr']) {
    if (!p[id]) throw new Error(`SoundFont sem o bloco ${id}`);
  }

  const records = <T>(c: Chunk, size: number, read: (o: number) => T): T[] => {
    const n = Math.floor(c.size / size);
    return Array.from({ length: n }, (_, i) => read(c.start + i * size));
  };
  const phdr = records(p.phdr, 38, (o) => ({ name: str(v, o, 20), program: v.getUint16(o + 20, true), bank: v.getUint16(o + 22, true), bag: v.getUint16(o + 24, true) }));
  const pbag = records(p.pbag, 4, (o) => v.getUint16(o, true));
  const pgen = records(p.pgen, 4, (o) => ({ op: v.getUint16(o, true), amount: o }));
  const inst = records(p.inst, 22, (o) => ({ name: str(v, o, 20), bag: v.getUint16(o + 20, true) }));
  const ibag = records(p.ibag, 4, (o) => v.getUint16(o, true));
  const igen = records(p.igen, 4, (o) => ({ op: v.getUint16(o, true), amount: o }));
  const shdr = records(p.shdr, 46, (o) => ({
    name: str(v, o, 20),
    start: v.getUint32(o + 20, true),
    end: v.getUint32(o + 24, true),
    loopStart: v.getUint32(o + 28, true),
    loopEnd: v.getUint32(o + 32, true),
    sampleRate: v.getUint32(o + 36, true),
    originalPitch: v.getUint8(o + 40),
    pitchCorrection: v.getInt8(o + 41),
    type: v.getUint16(o + 44, true),
  }));

  /** Lê os geradores de uma bolsa (bag); faixas de nota/intensidade vêm como 2 bytes. */
  const gensOf = (gens: Array<{ op: number; amount: number }>, from: number, to: number): Gens => {
    const m: Gens = new Map();
    for (let i = from; i < to && i < gens.length; i++) {
      const { op, amount } = gens[i];
      if (op === G.keyRange || op === G.velRange) m.set(op, v.getUint8(amount + 2) | (v.getUint8(amount + 3) << 8));
      else if (op === G.instrument || op === G.sampleID || op === G.sampleModes) m.set(op, v.getUint16(amount + 2, true));
      else m.set(op, v.getInt16(amount + 2, true));
    }
    return m;
  };
  const zoneOf = (gens: Gens): SfZone => {
    const kr = gens.get(G.keyRange);
    const vr = gens.get(G.velRange);
    return { gens, keyLo: kr !== undefined ? kr & 0xff : 0, keyHi: kr !== undefined ? kr >> 8 : 127, velLo: vr !== undefined ? vr & 0xff : 0, velHi: vr !== undefined ? vr >> 8 : 127 };
  };

  const instruments: SfInstrument[] = inst.slice(0, -1).map((ins, i) => {
    const out: SfInstrument = { name: ins.name, global: null, zones: [] };
    for (let b = ins.bag; b < inst[i + 1].bag; b++) {
      const gens = gensOf(igen, ibag[b], ibag[b + 1] ?? igen.length);
      if (gens.has(G.sampleID)) out.zones.push({ ...zoneOf(gens), sample: gens.get(G.sampleID)! });
      else if (b === ins.bag) out.global = gens;
    }
    return out;
  });

  const presets: SfPreset[] = phdr.slice(0, -1).map((ph, i) => {
    const out: SfPreset = { name: ph.name, program: ph.program, bank: ph.bank, global: null, zones: [] };
    for (let b = ph.bag; b < phdr[i + 1].bag; b++) {
      const gens = gensOf(pgen, pbag[b], pbag[b + 1] ?? pgen.length);
      if (gens.has(G.instrument)) out.zones.push({ ...zoneOf(gens), instrument: gens.get(G.instrument)! });
      else if (b === ph.bag) out.global = gens;
    }
    return out;
  });

  const samples: SfSample[] = shdr.slice(0, -1);
  const compressed = version >= 3 || samples.some((s) => s.type & 0x10);
  const pcm = compressed ? null : new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.byteLength & ~1)));
  return { name, presets, instruments, samples, pcm, raw, compressed };
}

/** Preset para um programa General MIDI: banco 0, depois qualquer banco, depois o primeiro. */
export function findPreset(sf: SoundFont, program: number, bank = 0): SfPreset | undefined {
  return (
    sf.presets.find((p) => p.program === program && p.bank === bank) ??
    sf.presets.find((p) => p.program === program && p.bank !== 128) ??
    sf.presets.find((p) => p.bank === 0) ??
    sf.presets[0]
  );
}

export interface VoiceParams {
  sample: number;
  /** parâmetros finais já somados (instrumento + preset) */
  gen: (op: number) => number;
}

/** Zonas (amostras) que tocam uma nota numa intensidade, com os geradores combinados. */
export function voicesFor(sf: SoundFont, preset: SfPreset, key: number, vel: number): VoiceParams[] {
  const out: VoiceParams[] = [];
  const inRange = (z: SfZone) => key >= z.keyLo && key <= z.keyHi && vel >= z.velLo && vel <= z.velHi;
  for (const pz of preset.zones) {
    if (!inRange(pz)) continue;
    const ins = sf.instruments[pz.instrument];
    if (!ins) continue;
    for (const iz of ins.zones) {
      if (!inRange(iz) || !sf.samples[iz.sample]) continue;
      const gen = (op: number) => {
        // nível do instrumento: valor absoluto (local > global > padrão)
        const base = iz.gens.get(op) ?? ins.global?.get(op) ?? DEFAULTS[op] ?? 0;
        // nível do preset: soma (local > global), exceto faixas e endereços
        const add = op === G.keyRange || op === G.velRange || op === G.sampleID || op === G.sampleModes || op === G.overridingRootKey || op <= 4 || op === 12 || op === 45 || op === 50
          ? 0
          : (pz.gens.get(op) ?? preset.global?.get(op) ?? 0);
        return base + add;
      };
      out.push({ sample: iz.sample, gen });
    }
  }
  return out;
}

const tc = (timecents: number) => Math.pow(2, timecents / 1200);

/**
 * Tocador de SoundFont em Web Audio. Converte cada amostra em AudioBuffer
 * (decodificando o Ogg no caso do SF3) e guarda em cache.
 */
export class SoundFontPlayer {
  private buffers = new Map<number, AudioBuffer | Promise<AudioBuffer | null> | null>();

  constructor(
    readonly sf: SoundFont,
    private ctx: BaseAudioContext,
  ) {}

  private buffer(index: number): AudioBuffer | null {
    const cached = this.buffers.get(index);
    if (cached instanceof AudioBuffer) return cached;
    if (cached === null || cached instanceof Promise) return null;
    const s = this.sf.samples[index];
    if (this.sf.compressed) {
      const ogg = this.sf.raw.slice(s.start, s.end);
      const p = this.ctx
        .decodeAudioData(ogg.buffer)
        .then((b) => {
          this.buffers.set(index, b);
          return b;
        })
        .catch(() => {
          this.buffers.set(index, null);
          return null;
        });
      this.buffers.set(index, p);
      return null;
    }
    const pcm = this.sf.pcm!;
    const len = Math.max(0, Math.min(s.end, pcm.length) - s.start);
    if (!len) {
      this.buffers.set(index, null);
      return null;
    }
    const b = this.ctx.createBuffer(1, len, Math.max(3000, Math.min(384000, s.sampleRate || 44100)));
    const ch = b.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = pcm[s.start + i] / 32768;
    this.buffers.set(index, b);
    return b;
  }

  /** Prepara (decodifica) as amostras de alguns programas antes de tocar. */
  async preload(programs: number[]): Promise<void> {
    const waits: Promise<unknown>[] = [];
    for (const program of new Set(programs)) {
      const preset = findPreset(this.sf, program);
      if (!preset) continue;
      for (const pz of preset.zones) {
        for (const iz of this.sf.instruments[pz.instrument]?.zones ?? []) {
          this.buffer(iz.sample);
          const c = this.buffers.get(iz.sample);
          if (c instanceof Promise) waits.push(c);
        }
      }
    }
    await Promise.all(waits);
  }

  /** Começa uma nota; devolve uma função que a solta (release) num instante. */
  start(dest: AudioNode, program: number, key: number, velocity: number, when: number): (at: number) => void {
    const preset = findPreset(this.sf, program);
    if (!preset) return () => undefined;
    const ctx = this.ctx;
    const stops: Array<(at: number) => void> = [];
    for (const vp of voicesFor(this.sf, preset, key, velocity)) {
      const buf = this.buffer(vp.sample);
      if (!buf) continue;
      const s = this.sf.samples[vp.sample];
      const g = vp.gen;
      const root = g(G.overridingRootKey) >= 0 ? g(G.overridingRootKey) : s.originalPitch;
      const cents = (key - root) * g(G.scaleTuning) + g(G.coarseTune) * 100 + g(G.fineTune) + s.pitchCorrection;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = Math.pow(2, cents / 1200);
      const mode = g(G.sampleModes) & 3;
      if (mode === 1 || mode === 3) {
        const base = this.sf.compressed ? 0 : s.start;
        const ls = s.loopStart - base + g(G.startloopAddrsOffset) + g(G.startloopAddrsCoarseOffset) * 32768;
        const le = s.loopEnd - base + g(G.endloopAddrsOffset) + g(G.endloopAddrsCoarseOffset) * 32768;
        if (le > ls && ls >= 0 && le <= buf.length) {
          src.loop = true;
          src.loopStart = ls / buf.sampleRate;
          src.loopEnd = le / buf.sampleRate;
        }
      }
      const offset = Math.max(0, g(G.startAddrsOffset) + g(G.startAddrsCoarseOffset) * 32768) / buf.sampleRate;

      // atenuação (centibéis) e intensidade
      const atten = Math.pow(10, -Math.max(0, g(G.initialAttenuation)) / 200);
      const velGain = Math.pow(velocity / 127, 2);
      const peak = atten * velGain;
      const sustainLevel = peak * Math.pow(10, -Math.max(0, Math.min(1440, g(G.sustainVolEnv))) / 200);
      const delay = tc(g(G.delayVolEnv));
      const attack = Math.max(0.002, tc(g(G.attackVolEnv)));
      const hold = tc(g(G.holdVolEnv));
      const decay = Math.max(0.01, tc(g(G.decayVolEnv)));
      const release = Math.min(6, Math.max(0.03, tc(g(G.releaseVolEnv))));

      const env = ctx.createGain();
      const t0 = Math.max(when, ctx.currentTime) + delay;
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(peak, t0 + attack);
      env.gain.setValueAtTime(peak, t0 + attack + hold);
      env.gain.setTargetAtTime(sustainLevel, t0 + attack + hold, decay / 4);

      let node: AudioNode = src;
      const fc = g(G.initialFilterFc);
      if (fc < 13500) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = Math.min(20000, 8.176 * Math.pow(2, fc / 1200));
        node.connect(f);
        node = f;
      }
      node.connect(env);
      let out: AudioNode = env;
      const pan = g(G.pan);
      if (pan && 'createStereoPanner' in ctx) {
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, pan / 500));
        env.connect(p);
        out = p;
      }
      out.connect(dest);
      src.start(t0, offset);
      stops.push((at: number) => {
        const t = Math.max(at, t0 + 0.01);
        env.gain.cancelScheduledValues(t);
        env.gain.setValueAtTime(env.gain.value || sustainLevel, t);
        env.gain.setTargetAtTime(0, t, release / 4);
        src.stop(t + release + 0.05);
      });
    }
    return (at: number) => stops.forEach((s) => s(at));
  }
}
