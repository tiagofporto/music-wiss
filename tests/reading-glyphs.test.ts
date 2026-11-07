import { describe, expect, it } from 'vitest';
import { pitchName, readStaff, splitGlyphs, summarize } from '../src/reading/glyphs';
import type { TextItem } from '../src/reading/text';
import { DocError, pdfError } from '../src/doc/document';

const staff = { lines: [100, 110, 120, 130, 140], space: 10 };
const g = (str: string, x: number, y: number): TextItem => ({ str, x, y, w: 8, h: 20 });
/** y de uma posição na pauta (0 = linha de baixo, 1 = espaço acima…). */
const at = (step: number) => 140 - step * 5;

describe('símbolos SMuFL de PDF digital', () => {
  it('nome da nota pela clave, posição e armadura', () => {
    expect(pitchName(0, 'G', 0, null)).toBe('Mi4');
    expect(pitchName(-1, 'G', 0, null)).toBe('Ré4');
    expect(pitchName(1, 'G', 1, null)).toBe('Fá♯4'); // Sol maior
    expect(pitchName(1, 'G', 1, 0)).toBe('Fá4'); // bequadro
    expect(pitchName(0, 'F', 0, null)).toBe('Sol2');
  });

  it('separa "♯ 3" que o PDF junta num item só', () => {
    const parts = splitGlyphs([{ str: ' ', x: 100, y: 120, w: 30, h: 20 }]);
    expect(parts.map((p) => p.str)).toEqual(['', '']);
    expect(parts[1].x).toBeGreaterThan(parts[0].x);
  });

  it('lê notas, acorde, pausa, ponto e bandeirola com as durações', () => {
    const glyphs = [
      g('', 10, at(1)), // clave de sol
      g('', 60, at(-1)), // Ré4 semínima
      g('', 90, at(2)), // Sol4 mínima pontuada
      g('', 90, at(4)), // + Si4 (acorde)
      g('', 130, at(3)), // Lá4 com bandeirola de colcheia
      g('', 136, at(3) - 30),
      g('', 160, at(4)), // pausa de colcheia
    ];
    const c = readStaff(glyphs, staff, 0, 200, { clef: null, fifths: 0 });
    expect(c.clef).toBe('G');
    expect(c.events.map((e) => e.label)).toEqual(['Ré4', 'Si4+Sol4', 'Lá4', 'pausa de colcheia']);
    expect(c.events.map((e) => e.quarters)).toEqual([1, 3, 0.5, 0.5]);
    expect(c.events[0].blackGuess).toBe(true); // sem bandeirola: pode ter viga
    const sum = summarize([c])!;
    expect(sum.quarters).toBe(5);
    expect(sum.exact).toBe(false);
  });

  it('pausa de semibreve sozinha é o compasso inteiro', () => {
    const c = readStaff([g('', 60, at(6))], staff, 0, 200, { clef: 'G', fifths: 0 });
    expect(summarize([c])!.fullRest).toBe(true);
  });

  it('armadura no começo do sistema', () => {
    const glyphs = [g('', 10, at(1)), g('', 30, at(8)), g('', 38, at(5)), g('', 80, at(3))];
    const c = readStaff(glyphs, staff, 0, 200, { clef: null, fifths: 0 });
    expect(c.fifths).toBe(2);
    expect(c.events[0].label).toBe('Lá4');
  });
});

describe('erros ao abrir PDF', () => {
  it('senha, arquivo quebrado e outros viram mensagens claras', () => {
    expect(pdfError({ name: 'PasswordException', message: 'No password given' })).toMatchObject({ code: 'password' });
    expect(pdfError({ name: 'InvalidPDFException', message: 'Invalid PDF structure.' })).toMatchObject({ code: 'invalid' });
    expect(pdfError(new Error('x')).message).toMatch(/Não consegui abrir/);
    expect(new DocError('too-big', 'grande')).toBeInstanceOf(Error);
  });
});
