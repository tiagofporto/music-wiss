import type { DurationType } from '../model/duration';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Atalhos padrão do Music Wiss (esquema próprio). */
export const DURATION_KEYS: Record<string, DurationType> = {
  '1': 'whole',
  '2': 'half',
  '3': 'quarter',
  '4': 'eighth',
  '5': '16th',
  '6': '32nd',
};

/** Glifos SMuFL (fonte Bravura) para cada figura. */
export const DURATION_GLYPH: Record<DurationType, string> = {
  whole: '',
  half: '',
  quarter: '',
  eighth: '',
  '16th': '',
  '32nd': '',
};

export const GLYPH = {
  sharp: '',
  flat: '',
  natural: '',
  dot: '',
  restQuarter: '',
  tie: '',
};

export const SHORTCUTS: Array<[string, string]> = [
  ['N', 'Liga/desliga o modo de escrita'],
  ['A – G', 'Escreve a nota (Lá, Si, Dó, Ré, Mi, Fá, Sol)'],
  ['Shift + A – G', 'Acrescenta a nota ao acorde'],
  ['1 – 6', 'Semibreve, mínima, semínima, colcheia, semicolcheia, fusa'],
  ['.', 'Ponto de aumento'],
  ['0', 'Pausa'],
  ['+ / −', 'Sustenido / bemol na nota selecionada'],
  ['↑ / ↓', 'Sobe / desce um semitom'],
  ['Ctrl + ↑ / ↓', 'Sobe / desce uma oitava'],
  ['T', 'Ligadura de prolongamento'],
  ['← / →', 'Move o cursor'],
  ['Backspace', 'Apaga a nota antes do cursor'],
  ['Espaço', 'Toca / para'],
  ['Ctrl + Z / Ctrl + Y', 'Desfaz / refaz'],
  ['Ctrl + K', 'Paleta de comandos'],
  ['?', 'Esta lista'],
];
