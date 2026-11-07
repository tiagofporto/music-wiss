/**
 * Leitura óptica da estrutura da partitura (OMR simples, feito no próprio
 * navegador): acha as pautas de 5 linhas, os sistemas, as barras de compasso
 * e as cabeças de nota pretas numa imagem da página. Funciona igual para PDF
 * digital (desenhado num canvas) e para partitura escaneada ou foto.
 *
 * O que NÃO faz: ler durações, pausas, claves ou alturas com segurança. Essas
 * partes ficam como "pistas" (contagem de cabeças de nota) e a pessoa revisa.
 *
 * Tudo aqui é função pura sobre um bitmap, para poder testar sem navegador.
 */

export interface Bitmap {
  width: number;
  height: number;
  /** 1 = tinta, 0 = papel; linha a linha. */
  ink: Uint8Array;
}

/** Converte RGBA (ImageData) em tinta/papel, com limiar automático (Otsu). */
export function binarize(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Bitmap {
  const n = width * height;
  const lum = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    // fundo transparente conta como papel branco
    const v = Math.round((0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) * a + 255 * (1 - a));
    lum[i] = v;
    hist[v]++;
  }
  const t = otsu(hist, n);
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) ink[i] = lum[i] < t ? 1 : 0;
  return { width, height, ink };
}

export function otsu(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 160;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t + 1;
    }
  }
  // páginas quase brancas: não deixa o limiar subir demais (sujeira vira tinta)
  return Math.min(threshold, 200);
}

export interface StaffLines {
  /** y do centro de cada uma das 5 linhas, de cima para baixo. */
  lines: number[];
  /** Distância média entre linhas (o "espaço"). */
  space: number;
  /** Espessura média das linhas. */
  thickness: number;
  x0: number;
  x1: number;
}

interface Line {
  y: number;
  thickness: number;
  x0: number;
  x1: number;
}

/** Maior trecho de tinta numa linha, tolerando falhas pequenas (scan). */
function longestRun(bm: Bitmap, y: number, gap: number): { len: number; x0: number; x1: number } {
  const row = y * bm.width;
  let best = { len: 0, x0: 0, x1: 0 };
  let start = -1;
  let last = -1;
  for (let x = 0; x < bm.width; x++) {
    if (!bm.ink[row + x]) continue;
    if (start < 0 || x - last > gap + 1) start = x;
    last = x;
    if (last - start + 1 > best.len) best = { len: last - start + 1, x0: start, x1: last };
  }
  return best;
}

/** Linhas horizontais longas (candidatas a linha de pauta). */
export function findLines(bm: Bitmap, minFraction = 0.12): Line[] {
  const min = bm.width * minFraction;
  const rows: Array<{ y: number; x0: number; x1: number } | null> = [];
  for (let y = 0; y < bm.height; y++) {
    const r = longestRun(bm, y, 3);
    rows.push(r.len >= min ? { y, x0: r.x0, x1: r.x1 } : null);
  }
  const out: Line[] = [];
  for (let y = 0; y < rows.length; y++) {
    if (!rows[y]) continue;
    let end = y;
    while (end + 1 < rows.length && rows[end + 1]) end++;
    const group = rows.slice(y, end + 1) as Array<{ x0: number; x1: number }>;
    // linhas muito grossas são faixas pretas (borda escura do scan), não pauta
    if (end - y + 1 <= Math.max(6, bm.height / 300)) {
      out.push({
        y: (y + end) / 2,
        thickness: end - y + 1,
        x0: Math.min(...group.map((g) => g.x0)),
        x1: Math.max(...group.map((g) => g.x1)),
      });
    }
    y = end;
  }
  return out;
}

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Agrupa as linhas em pautas de 5 com espaçamento regular. */
export function findStaves(bm: Bitmap): StaffLines[] {
  const lines = findLines(bm);
  const staves: StaffLines[] = [];
  let i = 0;
  while (i + 4 < lines.length) {
    const five = lines.slice(i, i + 5);
    const gaps = five.slice(1).map((l, k) => l.y - five[k].y);
    const m = median(gaps);
    const regular = m >= 4 && gaps.every((g) => Math.abs(g - m) <= Math.max(1.5, m * 0.25));
    if (regular) {
      staves.push({
        lines: five.map((l) => l.y),
        space: m,
        thickness: median(five.map((l) => l.thickness)),
        x0: median(five.map((l) => l.x0)),
        x1: median(five.map((l) => l.x1)),
      });
      i += 5;
    } else i++;
  }
  return staves;
}

/** Imagem integral: soma de tinta em qualquer retângulo em tempo constante. */
export class Integral {
  readonly w: number;
  readonly h: number;
  private readonly s: Uint32Array;
  constructor(bm: Bitmap, mask?: (x: number, y: number) => boolean) {
    this.w = bm.width;
    this.h = bm.height;
    const W = bm.width + 1;
    this.s = new Uint32Array(W * (bm.height + 1));
    for (let y = 0; y < bm.height; y++) {
      let row = 0;
      for (let x = 0; x < bm.width; x++) {
        row += bm.ink[y * bm.width + x] && !(mask && mask(x, y)) ? 1 : 0;
        this.s[(y + 1) * W + x + 1] = this.s[y * W + x + 1] + row;
      }
    }
  }
  /** Tinta no retângulo [x0, x1) × [y0, y1). */
  sum(x0: number, y0: number, x1: number, y1: number): number {
    x0 = Math.max(0, Math.min(this.w, Math.round(x0)));
    x1 = Math.max(0, Math.min(this.w, Math.round(x1)));
    y0 = Math.max(0, Math.min(this.h, Math.round(y0)));
    y1 = Math.max(0, Math.min(this.h, Math.round(y1)));
    if (x1 <= x0 || y1 <= y0) return 0;
    const W = this.w + 1;
    return this.s[y1 * W + x1] - this.s[y0 * W + x1] - this.s[y1 * W + x0] + this.s[y0 * W + x0];
  }
  density(x0: number, y0: number, x1: number, y1: number): number {
    const area = Math.max(1, (Math.round(x1) - Math.round(x0)) * (Math.round(y1) - Math.round(y0)));
    return this.sum(x0, y0, x1, y1) / area;
  }
}

export interface Barline {
  x: number;
  /** Largura do grupo (barra dupla/final é mais larga). */
  width: number;
  /** 0–1: quão certo é que é barra (e não haste de nota). */
  confidence: number;
}

/** Barras de compasso de uma pauta: colunas de tinta que cobrem a pauta inteira. */
export function findBarlines(bm: Bitmap, staff: StaffLines, integral = new Integral(bm)): Barline[] {
  const top = staff.lines[0] - staff.thickness / 2;
  const bottom = staff.lines[4] + staff.thickness / 2;
  const height = bottom - top;
  const s = staff.space;
  const cols: number[] = [];
  for (let x = Math.round(staff.x0); x <= staff.x1; x++) {
    if (integral.sum(x, top, x + 1, bottom) >= height * 0.92) cols.push(x);
  }
  // colunas vizinhas formam um grupo (linha grossa, barra dupla ou final)
  const groups: Array<{ x0: number; x1: number }> = [];
  for (const x of cols) {
    const g = groups[groups.length - 1];
    if (g && x - g.x1 <= Math.max(2, s * 0.8)) g.x1 = x;
    else groups.push({ x0: x, x1: x });
  }
  const out: Barline[] = [];
  for (const g of groups) {
    const x = (g.x0 + g.x1) / 2;
    const width = g.x1 - g.x0 + 1;
    // a borda esquerda do sistema não é barra de compasso
    if (x - staff.x0 < s * 0.6) continue;
    // muito largo para barra: é um borrão ou um acorde grosso
    if (width > s * 1.4) continue;
    // haste: tem cabeça de nota encostada no alto ou embaixo dela
    const headNear = (y: number) =>
      Math.max(
        integral.density(g.x0 - s * 1.25, y - s * 0.45, g.x0 - 1, y + s * 0.45),
        integral.density(g.x1 + 2, y - s * 0.45, g.x1 + s * 1.25, y + s * 0.45),
      );
    let stemLike = 0;
    for (const y of [staff.lines[0] - s * 0.5, staff.lines[0], staff.lines[4], staff.lines[4] + s * 0.5]) stemLike = Math.max(stemLike, headNear(y));
    // barra passa da pauta só se for de sistema; haste passa muito (vai até a cabeça)
    const above = integral.sum(g.x0, top - s * 3, g.x1 + 1, top - s * 0.5) / Math.max(1, width * s * 2.5);
    const below = integral.sum(g.x0, bottom + s * 0.5, g.x1 + 1, bottom + s * 3) / Math.max(1, width * s * 2.5);
    const sticksOut = Math.max(above, below) > 0.9 && Math.min(above, below) < 0.2;
    // fórmula de compasso e acordes: tinta dos dois lados, em cima E embaixo
    const lineFrac = Math.min(0.5, (5 * staff.thickness) / height);
    const mid = staff.lines[2];
    const side = (xa: number, xb: number) =>
      Math.min(integral.density(xa, top, xb, mid) - lineFrac, integral.density(xa, mid, xb, bottom) - lineFrac);
    const crowded = Math.max(side(g.x0 - s * 0.6, g.x0 - s * 0.15), side(g.x1 + s * 0.15, g.x1 + s * 0.6));
    if (crowded > 0.22) continue;
    let confidence = 1;
    if (stemLike > 0.45) confidence -= 0.75;
    if (sticksOut) confidence -= 0.3;
    if (confidence < 0.3) continue;
    out.push({ x, width, confidence: Math.max(0, Math.min(1, confidence)) });
  }
  return out;
}

export interface NoteHead {
  x: number;
  y: number;
  /** Posição na pauta em meios-espaços a partir da linha de baixo (0 = 5ª linha, 2 = 4ª…). */
  step: number;
}

/**
 * Cabeças de nota pretas: manchas ovais cheias do tamanho de um espaço, depois
 * de tirar as linhas da pauta. Brancas (mínima, semibreve) não entram.
 */
export function findNoteHeads(staff: StaffLines, x0: number, x1: number, integral: Integral): NoteHead[] {
  const s = staff.space;
  const hw = s * 0.55;
  const hh = s * 0.4;
  const step = Math.max(1, Math.round(s / 5));
  const cands: Array<NoteHead & { d: number }> = [];
  const yTop = staff.lines[0] - s * 3;
  const yBottom = staff.lines[4] + s * 3;
  for (let y = yTop; y <= yBottom; y += step) {
    for (let x = x0 + hw; x <= x1 - hw; x += step) {
      const d = integral.density(x - hw, y - hh, x + hw, y + hh);
      if (d < 0.78) continue;
      // viga (barra de colcheias) é longa: o vizinho dos dois lados também é cheio
      const left = integral.density(x - hw - s, y - hh, x - hw, y + hh);
      const right = integral.density(x + hw, y - hh, x + hw + s, y + hh);
      if (left > 0.6 && right > 0.6) continue;
      // a cabeça é baixa: acima e abaixo dela quase não há tinta (fora a haste)
      const up = integral.density(x - hw, y - hh - s * 0.45, x + hw, y - hh);
      const down = integral.density(x - hw, y + hh, x + hw, y + hh + s * 0.45);
      if (up > 0.55 && down > 0.55) continue;
      cands.push({ x, y, d, step: Math.round(((staff.lines[4] - y) / s) * 2) });
    }
  }
  // supressão de vizinhos: fica a mais cheia em cada região
  cands.sort((a, b) => b.d - a.d);
  const kept: Array<NoteHead & { d: number }> = [];
  for (const c of cands) {
    if (kept.some((k) => Math.abs(k.x - c.x) < s * 0.9 && Math.abs(k.y - c.y) < s * 0.7)) continue;
    kept.push(c);
  }
  return kept.map(({ x, y, step: st }) => ({ x, y, step: st })).sort((a, b) => a.x - b.x || a.y - b.y);
}

export interface System {
  staves: StaffLines[];
  /** Barras que valem para o sistema (consenso entre as pautas). */
  barlines: Barline[];
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

/**
 * Junta pautas em sistemas: pautas ligadas por uma linha vertical na esquerda,
 * ou com as barras nos mesmos lugares (piano, coro, orquestra).
 */
export function findSystems(bm: Bitmap, staves: StaffLines[], integral = new Integral(bm)): System[] {
  const bars = staves.map((st) => findBarlines(bm, st, integral));
  const systems: System[] = [];
  let cur: number[] = [];
  const flush = () => {
    if (!cur.length) return;
    const sts = cur.map((i) => staves[i]);
    const s = median(sts.map((st) => st.space));
    // barra do sistema: aparece na maioria das pautas (tolerância de meio espaço)
    const all = cur.flatMap((i) => bars[i].map((b) => ({ ...b, staff: i })));
    all.sort((a, b) => a.x - b.x);
    const merged: Barline[] = [];
    for (let k = 0; k < all.length; ) {
      let j = k;
      while (j + 1 < all.length && all[j + 1].x - all[k].x <= s * 0.6) j++;
      const group = all.slice(k, j + 1);
      const staffCount = new Set(group.map((g) => g.staff)).size;
      const share = staffCount / cur.length;
      if (share >= (cur.length === 2 ? 1 : 0.6)) {
        merged.push({
          x: median(group.map((g) => g.x)),
          width: Math.max(...group.map((g) => g.width)),
          confidence: Math.min(1, (group.reduce((a, g) => a + g.confidence, 0) / group.length) * (0.6 + 0.4 * share)),
        });
      }
      k = j + 1;
    }
    // piano/coro com barras atravessando o espaço entre as pautas: quem não atravessa é haste
    let finalBars = merged;
    if (sts.length > 1) {
      const spans = (x: number) =>
        sts.slice(1).every((st, k) => {
          const a = sts[k].lines[4];
          const b = st.lines[0];
          return integral.sum(x - 2, a, x + 3, b) >= (b - a) * 0.85;
        });
      const spanning = merged.filter((b) => spans(b.x));
      if (spanning.length >= Math.max(1, merged.length / 2)) finalBars = spanning;
    }
    systems.push({
      staves: sts,
      barlines: finalBars,
      x0: median(sts.map((st) => st.x0)),
      x1: median(sts.map((st) => st.x1)),
      top: sts[0].lines[0],
      bottom: sts[sts.length - 1].lines[4],
    });
    cur = [];
  };
  for (let i = 0; i < staves.length; i++) {
    if (!cur.length) {
      cur.push(i);
      continue;
    }
    const prev = staves[cur[cur.length - 1]];
    const st = staves[i];
    const s = (prev.space + st.space) / 2;
    const gapTop = prev.lines[4];
    const gapBottom = st.lines[0];
    // linha vertical ligando as pautas logo no começo do sistema
    let linked = false;
    for (let x = Math.round(Math.min(prev.x0, st.x0) - s * 0.6); x <= Math.max(prev.x0, st.x0) + s * 0.6 && !linked; x++) {
      if (integral.sum(x - 1, gapTop, x + 2, gapBottom) >= (gapBottom - gapTop) * 0.9) linked = true;
    }
    // ou barras nos mesmos x
    if (!linked && bars[i].length >= 2 && bars[cur[cur.length - 1]].length >= 2) {
      const a = bars[cur[cur.length - 1]].map((b) => b.x);
      const hit = bars[i].filter((b) => a.some((x) => Math.abs(x - b.x) <= s * 0.6)).length;
      linked = hit / Math.max(bars[i].length, a.length) >= 0.7 && gapBottom - gapTop < s * 12;
    }
    if (linked) cur.push(i);
    else {
      flush();
      cur.push(i);
    }
  }
  flush();
  return systems;
}

export interface FoundMeasure {
  system: number;
  /** Caixa em pixels da página. */
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** Confiança das barras das duas pontas (a mais fraca). */
  confidence: number;
  noteHeads: number;
  /** Barra do fim é dupla ou final (mais larga). */
  heavyEnd: boolean;
  /** Primeiro compasso do sistema (tem clave, armadura e talvez fórmula). */
  firstInSystem: boolean;
}

export interface PageStructure {
  width: number;
  height: number;
  staves: StaffLines[];
  systems: System[];
  measures: FoundMeasure[];
  heads: NoteHead[];
}

/** Estrutura de uma página: pautas, sistemas, compassos e cabeças de nota. */
export function analyzePage(bm: Bitmap): PageStructure {
  const staves = findStaves(bm);
  const integral = new Integral(bm);
  const systems = findSystems(bm, staves, integral);
  // segunda imagem integral sem as linhas da pauta (para achar cabeças de nota)
  const lineRows = new Uint8Array(bm.height);
  for (const st of staves) {
    for (const ly of st.lines) {
      for (let y = Math.floor(ly - st.thickness / 2 - 0.5); y <= Math.ceil(ly + st.thickness / 2 + 0.5); y++) if (y >= 0 && y < bm.height) lineRows[y] = 1;
    }
  }
  const noLines = new Integral(bm, (x, y) => {
    if (!lineRows[y]) return false;
    // tira a linha só onde não há tinta logo acima e abaixo (não corta cabeças)
    const up = y > 1 && bm.ink[(y - 2) * bm.width + x];
    const down = y < bm.height - 2 && bm.ink[(y + 2) * bm.width + x];
    return !(up && down);
  });
  const measures: FoundMeasure[] = [];
  const heads: NoteHead[] = [];
  systems.forEach((sys, si) => {
    const s = median(sys.staves.map((st) => st.space));
    const xs = sys.barlines.map((b) => b.x);
    const edges = [sys.x0, ...xs];
    if (sys.x1 - (xs[xs.length - 1] ?? sys.x0) > s * 2) edges.push(sys.x1);
    for (let k = 0; k + 1 < edges.length; k++) {
      const a = edges[k];
      const b = edges[k + 1];
      if (b - a < s * 1.5) continue;
      const confA = k === 0 ? 1 : sys.barlines[k - 1].confidence;
      const endBar = sys.barlines[k];
      const confB = endBar ? endBar.confidence : 0.5;
      let count = 0;
      for (const st of sys.staves) {
        const found = findNoteHeads(st, a + s * 0.4, b - s * 0.4, noLines);
        count += found.length;
        heads.push(...found);
      }
      measures.push({
        system: si,
        x0: a,
        x1: b,
        top: sys.top - s * 2,
        bottom: sys.bottom + s * 2,
        confidence: Math.min(confA, confB),
        noteHeads: count,
        heavyEnd: !!endBar && endBar.width > Math.max(3, s * 0.35),
        firstInSystem: k === 0,
      });
    }
  });
  return { width: bm.width, height: bm.height, staves, systems, measures, heads };
}
