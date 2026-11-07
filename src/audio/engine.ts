import { midiToFrequency } from '../model/pitch';
import { parseSoundFont, SoundFontPlayer } from './soundfont';
import { timbreFor } from './timbres';

export interface NoteRequest {
  /** canal de mixagem (id da parte) */
  bus: string;
  program: number;
  midi: number;
  /** instante no relógio do áudio (segundos) */
  when: number;
  duration: number;
  /** intensidade MIDI 1–127 */
  velocity: number;
}

/**
 * Motor de som: um canal por instrumento (volume e mudo) e volume geral.
 * Toca com o SoundFont carregado, se houver; senão, com timbres sintetizados.
 */
/** Canal de mixagem do metrônomo. */
export const METRO_BUS = '__metro';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses = new Map<string, GainNode>();
  /** cada reprodução passa por estes nós; parar = silenciar e trocar */
  private sessions = new Map<string, GainNode>();
  private player: SoundFontPlayer | null = null;
  private masterVolume = 0.8;
  private busLevels = new Map<string, number>();

  get soundFontName(): string | null {
    return this.player?.sf.name ?? null;
  }

  get context(): AudioContext {
    return this.ensure();
  }

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterVolume;
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  now(): number {
    return this.ensure().currentTime;
  }

  setMasterVolume(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.02);
  }

  /** Volume (0–1) de um canal; mudo = 0. */
  setBus(bus: string, volume: number, muted = false): void {
    const level = muted ? 0 : Math.max(0, Math.min(1, volume));
    this.busLevels.set(bus, level);
    const g = this.buses.get(bus);
    if (g && this.ctx) g.gain.setTargetAtTime(level, this.ctx.currentTime, 0.02);
  }

  private session(bus: string): GainNode {
    let s = this.sessions.get(bus);
    if (s) return s;
    const ctx = this.ensure();
    let b = this.buses.get(bus);
    if (!b) {
      b = ctx.createGain();
      b.gain.value = this.busLevels.get(bus) ?? 0.8;
      b.connect(this.master!);
      this.buses.set(bus, b);
    }
    s = ctx.createGain();
    s.connect(b);
    this.sessions.set(bus, s);
    return s;
  }

  /** Carrega um SoundFont (.sf2/.sf3). Lança erro se o arquivo for inválido. */
  async loadSoundFont(bytes: Uint8Array, name: string, programs: number[] = []): Promise<string> {
    const sf = parseSoundFont(bytes, name.replace(/\.sf[23]$/i, ''));
    if (!sf.presets.length) throw new Error('O SoundFont não tem instrumentos');
    const player = new SoundFontPlayer(sf, this.ensure());
    await player.preload(programs);
    this.player = player;
    return sf.name;
  }

  /** Prepara as amostras dos instrumentos que vão tocar (SF3 precisa decodificar). */
  async prepare(programs: number[]): Promise<void> {
    await this.player?.preload(programs);
  }

  clearSoundFont(): void {
    this.player = null;
  }

  play(n: NoteRequest): void {
    const ctx = this.ensure();
    const dest = this.session(n.bus);
    const when = Math.max(n.when, ctx.currentTime);
    const dur = Math.max(0.05, n.duration);
    const vel = Math.max(1, Math.min(127, n.velocity));
    if (this.player) {
      const release = this.player.start(dest, n.program, n.midi, vel, when);
      release(when + dur);
      return;
    }
    this.synth(dest, n.program, n.midi, when, dur, vel / 127);
  }

  private synth(dest: AudioNode, program: number, midi: number, start: number, dur: number, velocity: number): void {
    const ctx = this.ctx!;
    const t = timbreFor(program);
    const freq = midiToFrequency(midi);
    const end = start + dur;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(12000, freq * t.brightness * (0.6 + velocity * 0.6));
    filter.Q.value = 0.7;

    const env = ctx.createGain();
    const peak = 0.3 * t.gain * velocity;
    const sus = Math.max(0.0001, peak * t.sustain);
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + t.attack);
    if (t.sustain > 0) {
      env.gain.setTargetAtTime(sus, start + t.attack, t.decay / 3);
      env.gain.setTargetAtTime(0, end, t.release / 4);
    } else {
      // nota que morre sozinha; ao soltar, abafa
      env.gain.setTargetAtTime(0.0001, start + t.attack, t.decay / 2.5 * (midi < 60 ? 1.4 : 1));
      env.gain.setTargetAtTime(0, end, t.release / 4);
    }
    filter.connect(env).connect(dest);

    let lfo: OscillatorNode | null = null;
    let lfoGain: GainNode | null = null;
    if (t.vibrato) {
      lfo = ctx.createOscillator();
      lfo.frequency.value = 5.2;
      lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(0, start);
      lfoGain.gain.linearRampToValueAtTime(t.vibrato, start + 0.35);
      lfo.connect(lfoGain);
      lfo.start(start);
      lfo.stop(end + t.release + 0.1);
    }
    const stopAt = end + t.release + 0.1;
    for (const [type, mult, gain] of t.partials) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq * mult;
      if (lfoGain) lfoGain.connect(osc.detune);
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g).connect(filter);
      osc.start(start);
      osc.stop(stopAt);
    }
  }

  /**
   * Clique do metrônomo (canal próprio "__metro", com volume próprio).
   * O 1º tempo é mais agudo e forte; as subdivisões, mais suaves.
   */
  click(when: number, level: 'accent' | 'beat' | 'sub'): void {
    const ctx = this.ensure();
    const dest = this.session(METRO_BUS);
    const t = Math.max(when, ctx.currentTime);
    const [freq, peak] = level === 'accent' ? [1760, 0.9] : level === 'beat' ? [1245, 0.62] : [988, 0.3];
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.002);
    env.gain.exponentialRampToValueAtTime(0.001, t + (level === 'sub' ? 0.04 : 0.065));
    env.connect(dest);
    // corpo (seno) + estalo (quadrada curtinha), parecido com um bloco de madeira
    const body = ctx.createOscillator();
    body.frequency.value = freq;
    body.connect(env);
    const tick = ctx.createOscillator();
    tick.type = 'square';
    tick.frequency.value = freq * 2.01;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.12, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
    tick.connect(tg).connect(env);
    body.start(t);
    tick.start(t);
    body.stop(t + 0.09);
    tick.stop(t + 0.02);
  }

  /** Para tudo o que está tocando ou agendado. */
  stopAll(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const s of this.sessions.values()) {
      s.gain.setTargetAtTime(0, t, 0.015);
      setTimeout(() => s.disconnect(), 200);
    }
    this.sessions.clear();
  }
}
