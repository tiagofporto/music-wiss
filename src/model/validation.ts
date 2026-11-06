import { Fraction } from './fraction';
import type { Measure, Score, Staff, TimeSignature } from './score';
import { effectiveTimeSignature, measureCapacity, voiceLength } from './score';

export type MeasureState = 'empty' | 'incomplete' | 'complete' | 'overflow';

export interface MeasureValidation {
  state: MeasureState;
  capacity: Fraction;
  filled: Fraction;
  /** capacidade - preenchido (negativo se excedeu). */
  remaining: Fraction;
}

/**
 * Compara a soma das durações de uma voz com a fórmula de compasso.
 * Tudo em frações exatas: 3 tercinas de colcheia = 1/4 sem erro de arredondamento.
 */
export function validateVoice(measure: Measure, ts: TimeSignature, voiceIndex = 0): MeasureValidation {
  const capacity = measureCapacity(ts);
  const filled = voiceLength(measure.voices[voiceIndex]);
  const remaining = capacity.sub(filled);
  let state: MeasureState;
  if (filled.isZero()) state = 'empty';
  else if (remaining.isZero()) state = 'complete';
  else if (remaining.gt(Fraction.ZERO)) state = 'incomplete';
  else state = 'overflow';
  return { state, capacity, filled, remaining };
}

export function validateStaff(score: Score, staff: Staff, voiceIndex = 0): MeasureValidation[] {
  return staff.measures.map((m, i) => validateVoice(m, effectiveTimeSignature(score, i), voiceIndex));
}

export function describeValidation(v: MeasureValidation): string {
  switch (v.state) {
    case 'empty':
      return 'vazio';
    case 'complete':
      return 'completo';
    case 'incomplete':
      return `incompleto, falta ${v.remaining}`;
    case 'overflow':
      return `excedido em ${v.remaining.mul(new Fraction(-1))}`;
  }
}
