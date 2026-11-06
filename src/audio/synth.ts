import { midiToFrequency } from '../model/pitch';

/**
 * Sintetizador simples em Web Audio para retorno imediato ao digitar e para a
 * reprodução. Pensado para ser trocado depois por um player de soundfont (SF2/SF3)
 * mantendo a mesma interface.
 */
export interface Instrument {
  play(midi: number, when: number, duration: number, velocity?: number): void;
  now(): number;
  stopAll(): void;
}

export class WebAudioSynth implements Instrument {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private active = new Set<AudioScheduledSourceNode>();

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const comp = this.ctx.createDynamicsCompressor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  now(): number {
    return this.ensure().currentTime;
  }

  play(midi: number, when: number, duration: number, velocity = 0.8): void {
    const ctx = this.ensure();
    const freq = midiToFrequency(midi);
    const start = Math.max(when, ctx.currentTime);
    const end = start + Math.max(duration, 0.05);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(8000, freq * 6);
    filter.Q.value = 0.7;

    const env = ctx.createGain();
    const peak = 0.35 * velocity;
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + 0.012);
    env.gain.exponentialRampToValueAtTime(peak * 0.55, start + 0.25);
    env.gain.setValueAtTime(peak * 0.55, Math.max(start + 0.25, end - 0.02));
    env.gain.exponentialRampToValueAtTime(0.0001, end + 0.25);

    filter.connect(env).connect(this.master!);

    const partials: Array<[OscillatorType, number, number]> = [
      ['triangle', 1, 1],
      ['sine', 2, 0.25],
      ['sine', 3, 0.08],
    ];
    for (const [type, mult, gain] of partials) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g).connect(filter);
      osc.start(start);
      osc.stop(end + 0.3);
      this.active.add(osc);
      osc.onended = () => this.active.delete(osc);
    }
  }

  stopAll(): void {
    for (const o of this.active) {
      try {
        o.stop();
      } catch {
        /* já parado */
      }
    }
    this.active.clear();
  }
}
