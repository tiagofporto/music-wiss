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
  ['S / Shift + S', 'Staccato / staccatissimo'],
  ['V / Shift + V', 'Acento / marcato'],
  ['U', 'Tenuto'],
  ['L', 'Letra: Espaço vai para a próxima nota, hífen separa sílabas, Enter termina'],
  ['H', 'Cifra (ex.: Am7, G/B): Espaço vai para o próximo evento'],
  ['Shift + 3', 'Tercina (Shift + 2, 5, 6, 7: outras quiálteras)'],
  ['Alt + 1 – 4', 'Escreve na voz 1, 2, 3 ou 4'],
  ['Alt + ↑ / ↓', 'Vai para a pauta de cima / de baixo'],
  ['← / →', 'Move o cursor'],
  ['Shift + ← / →', 'Seleciona um trecho (ou Shift + clique)'],
  ['Ctrl + C / X / V', 'Copia, recorta e cola'],
  ['Ctrl + A', 'Seleciona a voz inteira'],
  ['Backspace', 'Apaga a nota antes do cursor'],
  ['Espaço', 'Toca / para'],
  ['Ctrl + Z / Ctrl + Y', 'Desfaz / refaz'],
  ['Ctrl + K', 'Paleta de comandos'],
  ['Ctrl + O / Ctrl + S', 'Abre (MusicXML, MIDI, PDF, foto, .wiss.json) / salva'],
  ['M', 'Marcar por cima da partitura (de novo: voltar a editar)'],
  ['V P R T S E', 'Ao marcar: mover, caneta, marca-texto, texto, selo, borracha'],
  ['Delete / + − / setas', 'Ao marcar, com algo selecionado: apaga / tamanho / ajusta a posição'],
  ['?', 'Esta lista'],
];
