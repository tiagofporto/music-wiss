/**
 * Fração racional imutável e sempre reduzida.
 * Usada para todas as durações musicais, evitando erros de ponto flutuante
 * (1/3 + 1/3 + 1/3 precisa ser exatamente 1).
 */
export class Fraction {
  readonly num: number;
  readonly den: number;

  constructor(num: number, den = 1) {
    if (!Number.isInteger(num) || !Number.isInteger(den)) {
      throw new Error(`Fração precisa de inteiros: ${num}/${den}`);
    }
    if (den === 0) throw new Error('Denominador zero');
    if (den < 0) {
      num = -num;
      den = -den;
    }
    const g = gcd(Math.abs(num), den) || 1;
    this.num = num / g;
    this.den = den / g;
  }

  static readonly ZERO = new Fraction(0, 1);

  add(o: Fraction): Fraction {
    return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(o: Fraction): Fraction {
    return new Fraction(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  mul(o: Fraction): Fraction {
    return new Fraction(this.num * o.num, this.den * o.den);
  }

  div(o: Fraction): Fraction {
    if (o.num === 0) throw new Error('Divisão por zero');
    return new Fraction(this.num * o.den, this.den * o.num);
  }

  /** -1 se menor, 0 se igual, 1 se maior. */
  compare(o: Fraction): -1 | 0 | 1 {
    const d = this.num * o.den - o.num * this.den;
    return d < 0 ? -1 : d > 0 ? 1 : 0;
  }

  eq(o: Fraction): boolean {
    return this.compare(o) === 0;
  }
  lt(o: Fraction): boolean {
    return this.compare(o) < 0;
  }
  lte(o: Fraction): boolean {
    return this.compare(o) <= 0;
  }
  gte(o: Fraction): boolean {
    return this.compare(o) >= 0;
  }
  gt(o: Fraction): boolean {
    return this.compare(o) > 0;
  }
  isZero(): boolean {
    return this.num === 0;
  }

  toNumber(): number {
    return this.num / this.den;
  }

  toString(): string {
    return `${this.num}/${this.den}`;
  }

  static sum(list: Fraction[]): Fraction {
    return list.reduce((acc, f) => acc.add(f), Fraction.ZERO);
  }
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}
