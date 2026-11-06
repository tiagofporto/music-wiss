/**
 * Marcações à mão livre por cima de uma página (partitura ou PDF):
 * caneta, marca-texto e notas de texto. As coordenadas são guardadas como
 * fração da LARGURA da página (x e y), então as marcações acompanham o zoom.
 */

export type AnnotationTool = 'move' | 'pen' | 'highlight' | 'text' | 'stamp' | 'erase';

export interface StrokeMark {
  kind: 'pen' | 'highlight';
  color: string;
  /** Espessura em fração da largura. */
  width: number;
  /** x0, y0, x1, y1, ... */
  points: number[];
}

export interface TextMark {
  kind: 'text';
  color: string;
  x: number;
  y: number;
  /** Tamanho da letra em fração da largura. */
  size: number;
  text: string;
}

/** Selo: um símbolo (seta, forma, nota musical, emoji de atenção) centrado em (x, y). */
export interface StampMark {
  kind: 'stamp';
  symbol: string;
  color: string;
  x: number;
  y: number;
  /** Altura em fração da largura. */
  size: number;
}

export type Annotation = StrokeMark | TextMark | StampMark;

export const ANNOTATION_COLORS = ['#e4572e', '#2e6fe4', '#2f9e55', '#1d1f1c', '#f2c12e'];

/**
 * Selos. Os do primeiro grupo são desenhados na cor escolhida (setas e formas
 * para circular ou apontar); os outros são emojis coloridos de atenção.
 */
export const STAMP_GROUPS: Array<{ name: string; symbols: string[] }> = [
  { name: 'Setas', symbols: ['→', '←', '↑', '↓', '↗', '↘', '↙', '↖'] },
  { name: 'Formas', symbols: ['○', '□', '◇', '△', '●', '■'] },
  { name: 'Música', symbols: ['♪', '♫', '♩', '♬', '𝄐', '𝄞'] },
  { name: 'Atenção', symbols: ['⚠️', '❗', '❓', '⭐', '👀', '✅', '❌', '🔁', '🎵', '🎶', '👉', '👈', '👆', '👇', '🔴', '🟡', '🟢', '🔵', '⭕', '🔲'] },
];

/** O símbolo é desenhado na cor da caneta (não é emoji colorido)? */
export function stampTakesColor(symbol: string): boolean {
  return STAMP_GROUPS.slice(0, 3).some((g) => g.symbols.includes(symbol));
}

export const STAMP_FONT_MONO = "'Segoe UI Symbol', 'Apple Symbols', 'Noto Sans Symbols 2', 'Noto Sans Symbols', 'DejaVu Sans', 'Noto Music', Bravura, sans-serif";
export const STAMP_FONT_EMOJI = "'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', 'Segoe UI Symbol', sans-serif";

const STAMP_SYMBOLS = new Set(STAMP_GROUPS.flatMap((g) => g.symbols));

const round = (n: number) => Math.round(n * 10000) / 10000;

/** Tira pontos quase em linha reta (menos dados para guardar), mantendo o desenho. */
export function simplify(points: number[], tolerance = 0.0015): number[] {
  if (points.length <= 4) return points.map(round);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i += 2) pts.push([points[i], points[i + 1]]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bestD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  pts.forEach((p, i) => keep[i] && out.push(round(p[0]), round(p[1])));
  return out;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Caminho SVG em pixels para uma página com a largura dada. */
export function pathData(points: number[], width: number): string {
  if (points.length < 2) return '';
  const p = (i: number) => `${(points[i] * width).toFixed(1)} ${(points[i + 1] * width).toFixed(1)}`;
  if (points.length === 2) return `M${p(0)} l0.1 0`; // um ponto vira um pinguinho
  let d = `M${p(0)}`;
  for (let i = 2; i < points.length; i += 2) d += ` L${p(i)}`;
  return d;
}

/** A marcação passa perto do ponto (x, y)? (tudo em fração da largura) */
export function hits(a: Annotation, x: number, y: number, tolerance = 0.012): boolean {
  if (a.kind === 'stamp') return Math.abs(x - a.x) <= a.size / 2 + tolerance && Math.abs(y - a.y) <= a.size / 2 + tolerance;
  if (a.kind === 'text') {
    const w = a.text.length * a.size * 0.55;
    return x >= a.x - tolerance && x <= a.x + w + tolerance && y >= a.y - a.size - tolerance && y <= a.y + tolerance;
  }
  const tol = tolerance + a.width / 2;
  const pts = a.points;
  if (pts.length === 2) return Math.hypot(x - pts[0], y - pts[1]) <= tol;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    if (distToSegment(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= tol) return true;
  }
  return false;
}

/** A marcação de cima (a última desenhada) que passa perto do ponto, ou -1. */
export function hitIndex(list: Annotation[], x: number, y: number): number {
  for (let i = list.length - 1; i >= 0; i--) if (hits(list[i], x, y)) return i;
  return -1;
}

/** Cópia da marcação deslocada (dx, dy). */
export function translate(a: Annotation, dx: number, dy: number): Annotation {
  if (a.kind === 'text' || a.kind === 'stamp') return { ...a, x: round(a.x + dx), y: round(a.y + dy) };
  return { ...a, points: a.points.map((v, i) => round(v + (i % 2 ? dy : dx))) };
}

/** Caixa que envolve a marcação: [x0, y0, x1, y1]. */
export function bounds(a: Annotation): [number, number, number, number] {
  if (a.kind === 'stamp') return [a.x - a.size / 2, a.y - a.size / 2, a.x + a.size / 2, a.y + a.size / 2];
  if (a.kind === 'text') return [a.x, a.y - a.size, a.x + a.text.length * a.size * 0.55, a.y + a.size * 0.25];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < a.points.length; i += 2) {
    x0 = Math.min(x0, a.points[i]);
    x1 = Math.max(x1, a.points[i]);
    y0 = Math.min(y0, a.points[i + 1]);
    y1 = Math.max(y1, a.points[i + 1]);
  }
  const h = a.width / 2;
  return [x0 - h, y0 - h, x1 + h, y1 + h];
}

/** Aumenta ou diminui selo/texto (fator), dentro de limites. */
export function resize(a: Annotation, factor: number): Annotation {
  if (a.kind === 'stamp') return { ...a, size: round(Math.max(0.015, Math.min(0.25, a.size * factor))) };
  if (a.kind === 'text') return { ...a, size: round(Math.max(0.008, Math.min(0.08, a.size * factor))) };
  return { ...a, width: round(Math.max(0.001, Math.min(0.05, a.width * factor))) };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Desenha as marcações num <svg> do tamanho da página. */
export function annotationsSvg(list: Annotation[], width: number): string {
  return list
    .map((a, i) => {
      if (a.kind === 'stamp') {
        // setas e formas: forma de texto (U+FE0E), na cor escolhida; o resto, emoji colorido
        const mono = stampTakesColor(a.symbol);
        const font = mono ? STAMP_FONT_MONO : STAMP_FONT_EMOJI;
        return `<text data-i="${i}" x="${(a.x * width).toFixed(1)}" y="${(a.y * width).toFixed(1)}" fill="${a.color}" font-size="${(a.size * width).toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-family="${font}">${esc(mono ? `${a.symbol}\uFE0E` : a.symbol)}</text>`;
      }
      if (a.kind === 'text') {
        return `<text data-i="${i}" x="${(a.x * width).toFixed(1)}" y="${(a.y * width).toFixed(1)}" fill="${a.color}" font-size="${(a.size * width).toFixed(1)}" font-family="Manrope, system-ui, sans-serif" font-weight="600">${esc(a.text)}</text>`;
      }
      const hl = a.kind === 'highlight';
      return `<path data-i="${i}" d="${pathData(a.points, width)}" fill="none" stroke="${a.color}" stroke-width="${(a.width * width).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"${hl ? ' stroke-opacity="0.35" style="mix-blend-mode:multiply"' : ''}/>`;
    })
    .join('');
}

/** Confere dados vindos de arquivo/nuvem antes de desenhar. */
export function sanitizeAnnotations(raw: unknown): Annotation[] {
  if (!Array.isArray(raw)) return [];
  const color = (c: unknown) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : ANNOTATION_COLORS[0]);
  const num = (n: unknown, d: number) => (typeof n === 'number' && Number.isFinite(n) ? n : d);
  const out: Annotation[] = [];
  for (const a of raw as Array<Record<string, unknown>>) {
    if (a?.kind === 'stamp' && typeof a.symbol === 'string' && STAMP_SYMBOLS.has(a.symbol)) {
      out.push({ kind: 'stamp', symbol: a.symbol, color: color(a.color), x: num(a.x, 0), y: num(a.y, 0), size: Math.max(0.015, Math.min(0.25, num(a.size, 0.04))) });
    } else if (a?.kind === 'text' && typeof a.text === 'string' && a.text.trim()) {
      out.push({ kind: 'text', color: color(a.color), x: num(a.x, 0), y: num(a.y, 0), size: num(a.size, 0.02), text: a.text.slice(0, 500) });
    } else if ((a?.kind === 'pen' || a?.kind === 'highlight') && Array.isArray(a.points) && a.points.length >= 2) {
      const pts = (a.points as unknown[]).filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
      if (pts.length >= 2) out.push({ kind: a.kind, color: color(a.color), width: num(a.width, 0.003), points: pts.slice(0, 20000 - (pts.length % 2)) });
    }
  }
  return out;
}

export interface LayerState {
  tool: AnnotationTool;
  color: string;
  /** Selo escolhido para a ferramenta "selo". */
  stamp: string;
}

export interface TextRequest {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  /** Texto atual, ao corrigir uma nota de texto. */
  initial?: string;
}

/**
 * Camada de desenho sobre um elemento (a página). Lê e grava as marcações
 * pelos callbacks; quem chama decide onde guardar (partitura, PDF...).
 *
 * Ferramenta "mover": clique numa marcação para selecioná-la e arraste para
 * levá-la a outro lugar; duplo clique num texto corrige o texto; Delete apaga;
 * + e − mudam o tamanho.
 */
export class AnnotationLayer {
  readonly svg: SVGSVGElement;
  private drawing: StrokeMark | null = null;
  private erasing = false;
  private live: SVGPathElement | null = null;
  /** Marcação selecionada (ferramenta mover). */
  selected = -1;
  private drag: { index: number; startX: number; startY: number; dx: number; dy: number } | null = null;
  /** Para reconhecer o duplo clique (o desenho é refeito entre os cliques). */
  private lastTap = { index: -1, time: 0 };

  constructor(
    private readonly host: HTMLElement,
    private readonly state: LayerState,
    private readonly get: () => Annotation[],
    private readonly set: (list: Annotation[]) => void,
    private readonly askText: (req: TextRequest) => Promise<string | null>,
    private readonly onSelect: (index: number) => void = () => {},
  ) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('annot-layer');
    host.appendChild(this.svg);
    this.svg.addEventListener('pointerdown', (e) => this.down(e));
    this.svg.addEventListener('pointermove', (e) => this.move(e));
    this.svg.addEventListener('pointerup', () => this.up());
    this.svg.addEventListener('pointercancel', () => this.cancel());
    this.draw();
  }

  get width(): number {
    return this.host.clientWidth || 1;
  }

  /** Liga/desliga a captura do mouse (desligada: dá para clicar na partitura). */
  setActive(on: boolean) {
    this.svg.classList.toggle('active', on);
    this.svg.dataset.tool = this.state.tool;
    if (!on || this.state.tool !== 'move') this.select(-1);
  }

  draw() {
    const w = this.width;
    const h = this.host.clientHeight || w;
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.setAttribute('width', String(w));
    this.svg.setAttribute('height', String(h));
    const list = this.get();
    if (this.selected >= list.length) this.selected = -1;
    this.svg.innerHTML = annotationsSvg(list, w) + this.selectionBox(list, w);
    this.live = null;
  }

  private selectionBox(list: Annotation[], w: number): string {
    const a = list[this.selected];
    if (!a) return '';
    const [x0, y0, x1, y1] = bounds(a);
    const pad = 6;
    return `<rect class="annot-sel" x="${(x0 * w - pad).toFixed(1)}" y="${(y0 * w - pad).toFixed(1)}" width="${((x1 - x0) * w + pad * 2).toFixed(1)}" height="${((y1 - y0) * w + pad * 2).toFixed(1)}" rx="6" fill="none"/>`;
  }

  private select(i: number) {
    if (i !== this.selected) {
      this.selected = i;
      this.draw();
    }
    this.onSelect(i);
  }

  /** Apaga a marcação selecionada. */
  deleteSelected(): boolean {
    const list = this.get();
    if (!list[this.selected]) return false;
    const i = this.selected;
    this.selected = -1;
    this.set(list.filter((_, k) => k !== i));
    this.draw();
    this.onSelect(-1);
    return true;
  }

  /** Aumenta (fator > 1) ou diminui a marcação selecionada. */
  resizeSelected(factor: number): boolean {
    const list = this.get();
    if (!list[this.selected]) return false;
    this.set(list.map((a, k) => (k === this.selected ? resize(a, factor) : a)));
    this.draw();
    return true;
  }

  /** Move a selecionada um pouquinho (setas do teclado). */
  nudgeSelected(dx: number, dy: number): boolean {
    const list = this.get();
    if (!list[this.selected]) return false;
    this.set(list.map((a, k) => (k === this.selected ? translate(a, dx, dy) : a)));
    this.draw();
    return true;
  }

  /** Troca a cor da selecionada. */
  recolorSelected(color: string): boolean {
    const list = this.get();
    const a = list[this.selected];
    if (!a || (a.kind === 'stamp' && !stampTakesColor(a.symbol))) return false;
    this.set(list.map((x, k) => (k === this.selected ? { ...x, color } : x)));
    this.draw();
    return true;
  }

  private at(e: { clientX: number; clientY: number }) {
    const r = this.svg.getBoundingClientRect();
    const w = r.width || 1;
    return { x: (e.clientX - r.left) / w, y: (e.clientY - r.top) / w };
  }

  private down(e: PointerEvent) {
    if (!this.svg.classList.contains('active') || e.button !== 0) return;
    e.preventDefault();
    const p = this.at(e);
    const tool = this.state.tool;
    const list = this.get();
    if (tool === 'move') {
      const i = hitIndex(list, p.x, p.y);
      const now = performance.now();
      const double = i >= 0 && this.lastTap.index === i && now - this.lastTap.time < 450;
      this.lastTap = { index: i, time: now };
      if (double && list[i].kind === 'text') {
        this.select(i);
        return void this.editText(i, e);
      }
      this.select(i);
      if (i >= 0) {
        this.svg.setPointerCapture(e.pointerId);
        this.drag = { index: i, startX: p.x, startY: p.y, dx: 0, dy: 0 };
      }
      return;
    }
    if (tool === 'erase') {
      this.svg.setPointerCapture(e.pointerId);
      this.erasing = true;
      this.eraseAt(p.x, p.y);
      return;
    }
    if (tool === 'text') {
      // clicar num texto que já existe corrige o texto
      const hit = hitIndex(list, p.x, p.y);
      if (hit >= 0 && list[hit].kind === 'text') return void this.editText(hit, e);
      void this.askText({ ...p, clientX: e.clientX, clientY: e.clientY }).then((t) => {
        if (!t?.trim()) return;
        this.set([...this.get(), { kind: 'text', color: this.state.color, x: round(p.x), y: round(p.y + 0.012), size: 0.018, text: t.trim() }]);
        this.draw();
      });
      return;
    }
    if (tool === 'stamp') {
      const symbol = this.state.stamp;
      // formas e setas desenham menores que os emojis: começam maiores
      this.set([...list, { kind: 'stamp', symbol, color: this.state.color, x: round(p.x), y: round(p.y), size: stampTakesColor(symbol) ? 0.06 : 0.045 }]);
      this.draw();
      return;
    }
    this.svg.setPointerCapture(e.pointerId);
    const hl = tool === 'highlight';
    this.drawing = { kind: tool, color: hl ? (this.state.color === '#1d1f1c' ? '#f2c12e' : this.state.color) : this.state.color, width: hl ? 0.018 : 0.0028, points: [p.x, p.y] };
    this.live = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.svg.appendChild(this.live);
    this.paintLive();
  }

  private move(e: PointerEvent) {
    if (this.drag) {
      const p = this.at(e);
      this.drag.dx = p.x - this.drag.startX;
      this.drag.dy = p.y - this.drag.startY;
      // arrasta só o desenho (sem gravar) até soltar
      const w = this.width;
      const t = `translate(${(this.drag.dx * w).toFixed(1)} ${(this.drag.dy * w).toFixed(1)})`;
      this.svg.querySelector(`[data-i="${this.drag.index}"]`)?.setAttribute('transform', t);
      this.svg.querySelector('.annot-sel')?.setAttribute('transform', t);
      return;
    }
    if (this.erasing) {
      const p = this.at(e);
      this.eraseAt(p.x, p.y);
      return;
    }
    if (!this.drawing) return;
    // várias amostras por quadro deixam o traço mais liso
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ce of events.length ? events : [e]) {
      const q = this.at(ce);
      this.drawing.points.push(q.x, q.y);
    }
    this.paintLive();
  }

  private up() {
    if (this.drag) {
      const { index, dx, dy } = this.drag;
      this.drag = null;
      if (Math.abs(dx) + Math.abs(dy) > 0.001) {
        this.set(this.get().map((a, k) => (k === index ? translate(a, dx, dy) : a)));
      }
      this.draw();
      return;
    }
    if (this.erasing) {
      this.erasing = false;
      return;
    }
    const d = this.drawing;
    this.drawing = null;
    if (!d) return;
    d.points = simplify(d.points);
    this.set([...this.get(), d]);
    this.draw();
  }

  private cancel() {
    this.drawing = null;
    this.drag = null;
    this.erasing = false;
    this.draw();
  }

  private async editText(index: number, e: { clientX: number; clientY: number }) {
    const a = this.get()[index];
    if (a?.kind !== 'text') return;
    const t = await this.askText({ x: a.x, y: a.y, clientX: e.clientX, clientY: e.clientY, initial: a.text });
    if (t === null) return;
    const list = this.get();
    if (!t.trim()) this.set(list.filter((_, k) => k !== index));
    else if (t.trim() !== a.text) this.set(list.map((x, k) => (k === index ? { ...a, text: t.trim() } : x)));
    this.draw();
  }

  private paintLive() {
    const d = this.drawing;
    if (!d || !this.live) return;
    const w = this.width;
    this.live.setAttribute('d', pathData(d.points, w));
    this.live.setAttribute('fill', 'none');
    this.live.setAttribute('stroke', d.color);
    this.live.setAttribute('stroke-width', String(d.width * w));
    this.live.setAttribute('stroke-linecap', 'round');
    this.live.setAttribute('stroke-linejoin', 'round');
    if (d.kind === 'highlight') this.live.setAttribute('stroke-opacity', '0.35');
  }

  private eraseAt(x: number, y: number) {
    const list = this.get();
    const keep = list.filter((a) => !hits(a, x, y));
    if (keep.length !== list.length) {
      this.set(keep);
      this.draw();
    }
  }
}
