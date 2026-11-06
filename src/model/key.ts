import type { Alter, Step } from './pitch';

/** Armadura de clave em quintas: -7 (7 bemóis) .. 0 (Dó maior) .. 7 (7 sustenidos). */
export type Fifths = -7 | -6 | -5 | -4 | -3 | -2 | -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

const SHARP_ORDER: Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER: Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

const MAJOR_NAMES: Record<number, string> = {
  [-7]: 'Dób maior', [-6]: 'Solb maior', [-5]: 'Réb maior', [-4]: 'Láb maior',
  [-3]: 'Mib maior', [-2]: 'Sib maior', [-1]: 'Fá maior', 0: 'Dó maior',
  1: 'Sol maior', 2: 'Ré maior', 3: 'Lá maior', 4: 'Mi maior', 5: 'Si maior',
  6: 'Fá# maior', 7: 'Dó# maior',
};

/** Nome da tônica maior no formato que o VexFlow entende (ex.: "Bb", "F#"). */
const VEX_KEYS: Record<number, string> = {
  [-7]: 'Cb', [-6]: 'Gb', [-5]: 'Db', [-4]: 'Ab', [-3]: 'Eb', [-2]: 'Bb', [-1]: 'F',
  0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#',
};

/** Acidente que a armadura aplica a cada letra. */
export function keyAlter(fifths: Fifths, step: Step): Alter {
  if (fifths > 0 && SHARP_ORDER.slice(0, fifths).includes(step)) return 1;
  if (fifths < 0 && FLAT_ORDER.slice(0, -fifths).includes(step)) return -1;
  return 0;
}

export function keyName(fifths: Fifths): string {
  return MAJOR_NAMES[fifths];
}

export function vexKey(fifths: Fifths): string {
  return VEX_KEYS[fifths];
}
