/**
 * Altura musical guardada como a escrita: letra + acidente + oitava.
 * Dó# e Réb soam igual (mesmo MIDI) mas são notas diferentes na partitura.
 */
export type Step = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
/** -2 = dobrado bemol, -1 = bemol, 0 = natural, 1 = sustenido, 2 = dobrado sustenido */
export type Alter = -2 | -1 | 0 | 1 | 2;
export type Clef = 'treble' | 'bass' | 'alto' | 'tenor';

export interface Pitch {
  step: Step;
  alter: Alter;
  /** Oitava científica: Dó central = C4. */
  octave: number;
}

export const STEPS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_SEMITONES: Record<Step, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export const STEP_NAMES_PT: Record<Step, string> = {
  C: 'Dó', D: 'Ré', E: 'Mi', F: 'Fá', G: 'Sol', A: 'Lá', B: 'Si',
};

export function pitch(step: Step, octave: number, alter: Alter = 0): Pitch {
  return { step, alter, octave };
}

/** Número MIDI (C4 = 60). */
export function toMidi(p: Pitch): number {
  return (p.octave + 1) * 12 + STEP_SEMITONES[p.step] + p.alter;
}

/** Índice diatônico absoluto: conta graus da escala, ignora acidentes. C4 = 28. */
export function diatonicIndex(p: Pitch): number {
  return p.octave * 7 + STEPS.indexOf(p.step);
}

export function fromDiatonicIndex(index: number, alter: Alter = 0): Pitch {
  const octave = Math.floor(index / 7);
  const step = STEPS[((index % 7) + 7) % 7];
  return { step, alter, octave };
}

/** Nota que fica na linha de baixo (1ª linha) de cada clave. */
const CLEF_BOTTOM_LINE: Record<Clef, Pitch> = {
  treble: pitch('E', 4),
  bass: pitch('G', 2),
  alto: pitch('F', 3),
  tenor: pitch('D', 3),
};

/**
 * Posição vertical na pauta, em meios-espaços acima da 1ª linha.
 * 0 = 1ª linha, 1 = 1º espaço, 2 = 2ª linha ... 8 = 5ª linha.
 * Calculada por grau diatônico, por isso Dó e Dó# ficam na mesma altura.
 */
export function staffPosition(p: Pitch, clef: Clef): number {
  return diatonicIndex(p) - diatonicIndex(CLEF_BOTTOM_LINE[clef]);
}

/** Nota da linha do meio (3ª linha) de cada clave. */
export function clefMiddle(clef: Clef): Pitch {
  return fromDiatonicIndex(diatonicIndex(CLEF_BOTTOM_LINE[clef]) + 4);
}

/**
 * Escolhe a oitava de `step` mais próxima da nota anterior (no máximo
 * uma quarta de distância), como um músico faria ao digitar uma melodia.
 */
export function nearestOctave(step: Step, previous: Pitch | null, fallbackOctave = 4): number {
  if (!previous) return fallbackOctave;
  const prev = diatonicIndex(previous);
  const s = STEPS.indexOf(step);
  let best = previous.octave;
  let bestDist = Infinity;
  for (const oct of [previous.octave - 1, previous.octave, previous.octave + 1]) {
    const dist = Math.abs(oct * 7 + s - prev);
    if (dist < bestDist) {
      bestDist = dist;
      best = oct;
    }
  }
  return best;
}

/** Sobe/desce um semitom preferindo sustenido ao subir e bemol ao descer. */
export function transposeSemitone(p: Pitch, dir: 1 | -1): Pitch {
  const target = toMidi(p) + dir;
  const preferred: Alter = dir === 1 ? 1 : -1;
  // preferência: nota natural, depois o acidente da direção (mesma letra antes da vizinha), depois o contrário
  const candidates: Pitch[] = [];
  for (const alter of [0, preferred, -preferred] as Alter[]) {
    for (const delta of [0, dir, -dir]) {
      const c = { ...fromDiatonicIndex(diatonicIndex(p) + delta), alter };
      if (toMidi(c) === target) candidates.push(c);
    }
  }
  return candidates[0] ?? p;
}

export function transposeOctave(p: Pitch, dir: 1 | -1): Pitch {
  return { ...p, octave: p.octave + dir };
}

export function pitchLabel(p: Pitch): string {
  const acc = { [-2]: '𝄫', [-1]: '♭', 0: '', 1: '♯', 2: '𝄪' }[p.alter];
  return `${STEP_NAMES_PT[p.step]}${acc}${p.octave}`;
}

export function pitchesEqual(a: Pitch, b: Pitch): boolean {
  return a.step === b.step && a.alter === b.alter && a.octave === b.octave;
}

/** Frequência em Hz com afinação Lá4 = 440. */
export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const SHARP_SPELLING: Array<[Step, Alter]> = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
const FLAT_SPELLING: Array<[Step, Alter]> = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];

/**
 * Escreve um número MIDI como nota, de acordo com a tonalidade (armadura em quintas):
 * usa primeiro as notas da escala (Fá# em Sol maior, Si♭ em Fá maior) e, fora dela,
 * sustenidos em tons de sustenido e bemóis em tons de bemol.
 */
export function spellMidi(midi: number, fifths = 0): Pitch {
  const pc = ((midi % 12) + 12) % 12;
  const sharps = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const flats = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  // notas da escala nesta tonalidade
  for (const step of STEPS) {
    let alter = 0;
    if (fifths > 0 && sharps.indexOf(step) < fifths) alter = 1;
    if (fifths < 0 && flats.indexOf(step) < -fifths) alter = -1;
    if ((STEP_SEMITONES[step] + alter + 12) % 12 === pc) {
      return withOctave(step, alter as Alter, midi);
    }
  }
  const [step, alter] = (fifths < 0 ? FLAT_SPELLING : SHARP_SPELLING)[pc];
  return withOctave(step, alter, midi);
}

function withOctave(step: Step, alter: Alter, midi: number): Pitch {
  // a oitava segue a letra (Si# 3 soa como Dó 4; Dó♭ 5 soa como Si 4)
  const octave = Math.floor((midi - STEP_SEMITONES[step] - alter) / 12) - 1;
  return { step, alter, octave };
}
