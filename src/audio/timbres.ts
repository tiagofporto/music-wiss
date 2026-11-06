/**
 * Timbres sintetizados por família de instrumento (General MIDI), usados quando
 * não há SoundFont carregado. Não imitam amostras reais, mas deixam piano,
 * cordas, sopros, metais, órgão e cordas dedilhadas reconhecíveis entre si.
 */
export interface Timbre {
  /** parciais: [forma de onda, múltiplo da frequência, ganho] */
  partials: Array<[OscillatorType, number, number]>;
  attack: number;
  /** tempo até cair ao nível de sustentação */
  decay: number;
  /** nível de sustentação (0–1); 0 = a nota morre sozinha (piano, violão) */
  sustain: number;
  release: number;
  /** corte do filtro como múltiplo da frequência */
  brightness: number;
  /** vibrato em centésimos (0 = sem) */
  vibrato: number;
  gain: number;
}

const PIANO: Timbre = { partials: [['triangle', 1, 1], ['sine', 2, 0.35], ['sine', 3, 0.12], ['sine', 4, 0.05]], attack: 0.005, decay: 1.6, sustain: 0, release: 0.25, brightness: 7, vibrato: 0, gain: 0.9 };
const ORGAN: Timbre = { partials: [['sine', 0.5, 0.5], ['sine', 1, 1], ['sine', 2, 0.6], ['sine', 3, 0.3], ['sine', 4, 0.2]], attack: 0.02, decay: 0.05, sustain: 1, release: 0.08, brightness: 12, vibrato: 0, gain: 0.45 };
const PLUCK: Timbre = { partials: [['sawtooth', 1, 0.5], ['triangle', 1, 0.6], ['sine', 2, 0.2]], attack: 0.003, decay: 0.9, sustain: 0, release: 0.15, brightness: 5, vibrato: 0, gain: 0.8 };
const BASS: Timbre = { partials: [['triangle', 1, 1], ['sine', 2, 0.3]], attack: 0.01, decay: 1.2, sustain: 0.2, release: 0.15, brightness: 4, vibrato: 0, gain: 1 };
const STRINGS: Timbre = { partials: [['sawtooth', 1, 0.6], ['sawtooth', 1.003, 0.4], ['sine', 2, 0.1]], attack: 0.09, decay: 0.3, sustain: 0.85, release: 0.3, brightness: 5, vibrato: 12, gain: 0.5 };
const BRASS: Timbre = { partials: [['sawtooth', 1, 0.8], ['square', 1, 0.15], ['sine', 2, 0.2]], attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.12, brightness: 6, vibrato: 4, gain: 0.5 };
const REED: Timbre = { partials: [['square', 1, 0.55], ['sine', 3, 0.2], ['sine', 2, 0.1]], attack: 0.04, decay: 0.15, sustain: 0.85, release: 0.1, brightness: 5, vibrato: 6, gain: 0.5 };
const FLUTE: Timbre = { partials: [['sine', 1, 1], ['triangle', 2, 0.12], ['sine', 3, 0.05]], attack: 0.06, decay: 0.15, sustain: 0.85, release: 0.12, brightness: 8, vibrato: 10, gain: 0.7 };
const VOICE: Timbre = { partials: [['triangle', 1, 0.8], ['sine', 2, 0.35], ['sine', 3, 0.2], ['sine', 5, 0.08]], attack: 0.1, decay: 0.2, sustain: 0.85, release: 0.2, brightness: 4, vibrato: 18, gain: 0.6 };
const MALLET: Timbre = { partials: [['sine', 1, 1], ['sine', 4, 0.25], ['sine', 10, 0.05]], attack: 0.002, decay: 0.7, sustain: 0, release: 0.2, brightness: 12, vibrato: 0, gain: 0.9 };
const LEAD: Timbre = { partials: [['sawtooth', 1, 0.6], ['square', 1.005, 0.3]], attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.1, brightness: 6, vibrato: 0, gain: 0.4 };

/** Timbre para um programa General MIDI (0–127), pela família. */
export function timbreFor(program: number): Timbre {
  const family = Math.floor(Math.max(0, Math.min(127, program)) / 8);
  switch (family) {
    case 0: return PIANO; // pianos
    case 1: return MALLET; // percussão cromática
    case 2: return ORGAN;
    case 3: return PLUCK; // violões e guitarras
    case 4: return BASS;
    case 5: return STRINGS; // cordas
    case 6: return program === 52 || program === 53 || program === 54 ? VOICE : STRINGS; // conjuntos e coro
    case 7: return BRASS;
    case 8: return REED; // palhetas (sax, oboé, clarinete…)
    case 9: return FLUTE;
    default: return LEAD;
  }
}
