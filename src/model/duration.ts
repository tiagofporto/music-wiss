import { Fraction } from './fraction';

/** Figuras rítmicas. O valor é a fração da semibreve. */
export type DurationType = 'whole' | 'half' | 'quarter' | 'eighth' | '16th' | '32nd';

export interface Duration {
  type: DurationType;
  /** Pontos de aumento (0, 1 ou 2). */
  dots: number;
}

export const DURATION_ORDER: readonly DurationType[] = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'];

const BASE: Record<DurationType, Fraction> = {
  whole: new Fraction(1, 1),
  half: new Fraction(1, 2),
  quarter: new Fraction(1, 4),
  eighth: new Fraction(1, 8),
  '16th': new Fraction(1, 16),
  '32nd': new Fraction(1, 32),
};

export const DURATION_NAMES_PT: Record<DurationType, string> = {
  whole: 'Semibreve', half: 'Mínima', quarter: 'Semínima',
  eighth: 'Colcheia', '16th': 'Semicolcheia', '32nd': 'Fusa',
};

/** Código de duração do VexFlow. */
export const VEX_DURATION: Record<DurationType, string> = {
  whole: 'w', half: 'h', quarter: 'q', eighth: '8', '16th': '16', '32nd': '32',
};

export function dur(type: DurationType, dots = 0): Duration {
  return { type, dots };
}

/** Valor da figura como fração da semibreve, considerando os pontos. */
export function durationValue(d: Duration): Fraction {
  // cada ponto soma metade do valor anterior: x * (2 - 1/2^dots)
  const base = BASE[d.type];
  const factor = new Fraction(2 ** (d.dots + 1) - 1, 2 ** d.dots);
  return base.mul(factor);
}

/**
 * Decompõe uma fração em figuras válidas (maiores primeiro), usada para
 * dividir uma nota que atravessa a barra de compasso em notas ligadas.
 * Usa ponto de aumento simples quando o resultado fica exato.
 */
export function decompose(value: Fraction): Duration[] {
  const out: Duration[] = [];
  let rest = value;
  while (!rest.isZero()) {
    let picked: Duration | null = null;
    for (const type of DURATION_ORDER) {
      for (const dots of [1, 0]) {
        const d = { type, dots };
        if (durationValue(d).lte(rest)) {
          picked = d;
          break;
        }
      }
      if (picked) break;
    }
    if (!picked) throw new Error(`Não dá para representar ${value} com figuras até a fusa`);
    out.push(picked);
    rest = rest.sub(durationValue(picked));
  }
  return out;
}
