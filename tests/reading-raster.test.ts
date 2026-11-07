import { describe, expect, it } from 'vitest';
import { analyzePage, binarize, findStaves } from '../src/reading/raster';
import type { Bitmap } from '../src/reading/raster';

/** Página desenhada à mão: pautas, barras, cabeças de nota com haste. */
export class Paper implements Bitmap {
  ink: Uint8Array;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.ink = new Uint8Array(width * height);
  }
  rect(x0: number, y0: number, x1: number, y1: number) {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(this.height, Math.round(y1)); y++)
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(this.width, Math.round(x1)); x++) this.ink[y * this.width + x] = 1;
  }
  ellipse(cx: number, cy: number, rx: number, ry: number) {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) this.ink[y * this.width + x] = 1;
  }
  /** Pauta com 5 linhas; devolve o y da linha de cima. */
  staff(top: number, x0: number, x1: number, space = 12) {
    for (let i = 0; i < 5; i++) this.rect(x0, top + i * space - 1, x1, top + i * space + 1);
  }
  bar(x: number, top: number, bottom: number, w = 2) {
    this.rect(x - w / 2, top - 1, x + w / 2, bottom + 1);
  }
  /** Semínima: cabeça cheia + haste para cima. step 0 = linha de baixo. */
  note(x: number, staffTop: number, step: number, space = 12) {
    const y = staffTop + 4 * space - (step * space) / 2;
    this.ellipse(x, y, space * 0.62, space * 0.45);
    this.rect(x + space * 0.55, y - space * 3.5, x + space * 0.55 + 1.5, y);
  }
}

/** Uma pauta (melodia) com 4 compassos de 4 semínimas, e um primeiro compasso curto. */
function melody(pickup = false) {
  const p = new Paper(900, 260);
  const top = 60;
  p.staff(top, 40, 860);
  p.bar(40, top, top + 48); // início do sistema
  const bars = pickup ? [140, 320, 500, 680, 860] : [245, 450, 655, 860];
  bars.forEach((x, i) => p.bar(x, top, top + 48, i === bars.length - 1 ? 6 : 2));
  let a = 40 + 50; // depois da clave
  bars.forEach((b, i) => {
    const n = pickup && i === 0 ? 1 : 4;
    const span = (b - a - 20) / n;
    for (let k = 0; k < n; k++) p.note(a + 14 + k * span, top, 2 + ((k + i) % 5));
    a = b;
  });
  return p;
}

describe('leitura óptica (estrutura)', () => {
  it('acha as 5 linhas da pauta e o espaço entre elas', () => {
    const staves = findStaves(melody());
    expect(staves).toHaveLength(1);
    expect(staves[0].space).toBeCloseTo(12, 0);
    expect(Math.abs(staves[0].lines[0] - 60)).toBeLessThanOrEqual(1);
  });

  it('acha os compassos entre as barras, sem confundir hastes com barras', () => {
    const page = analyzePage(melody());
    expect(page.systems).toHaveLength(1);
    expect(page.measures).toHaveLength(4);
    expect(page.measures.map((m) => Math.round(m.x1))).toEqual([245, 450, 655, 860]);
    expect(page.measures[3].heavyEnd).toBe(true);
    expect(page.measures[0].heavyEnd).toBe(false);
  });

  it('conta as cabeças de nota pretas de cada compasso', () => {
    const page = analyzePage(melody());
    expect(page.measures.map((m) => m.noteHeads)).toEqual([4, 4, 4, 4]);
  });

  it('o primeiro compasso curto (anacruse) aparece com menos notas', () => {
    const page = analyzePage(melody(true));
    expect(page.measures).toHaveLength(5);
    expect(page.measures[0].noteHeads).toBe(1);
  });

  it('junta as duas pautas do piano num sistema só', () => {
    const p = new Paper(900, 400);
    for (const top of [60, 160]) p.staff(top, 40, 860);
    // linha que liga as pautas no começo e barras atravessando as duas
    p.bar(40, 60, 208);
    for (const x of [300, 580, 860]) {
      p.bar(x, 60, 108);
      p.bar(x, 160, 208);
    }
    const page = analyzePage(p);
    expect(page.systems).toHaveLength(1);
    expect(page.systems[0].staves).toHaveLength(2);
    expect(page.measures).toHaveLength(3);
  });

  it('separa sistemas diferentes (uma pauta cada)', () => {
    const p = new Paper(900, 400);
    for (const top of [40, 240]) {
      p.staff(top, 40, 860);
      p.bar(40, top, top + 48);
      for (const x of [450, 860]) p.bar(x, top, top + 48);
    }
    const page = analyzePage(p);
    expect(page.systems).toHaveLength(2);
    expect(page.measures.map((m) => m.system)).toEqual([0, 0, 1, 1]);
  });

  it('binariza imagem colorida (scan cinza) com limiar automático', () => {
    const w = 4;
    const rgba = new Uint8ClampedArray(w * 4);
    [240, 30, 230, 60].forEach((v, i) => rgba.set([v, v, v, 255], i * 4));
    expect([...binarize(rgba, w, 1).ink]).toEqual([0, 1, 0, 1]);
  });

  it('página sem partitura não inventa pautas', () => {
    const p = new Paper(600, 400);
    p.rect(50, 50, 550, 52); // um sublinhado só
    expect(analyzePage(p).measures).toHaveLength(0);
  });
});
