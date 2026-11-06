/**
 * Marcações à mão livre por cima de uma página (partitura ou PDF):
 * caneta, marca-texto e notas de texto. As coordenadas são guardadas como
 * fração da LARGURA da página (x e y), então as marcações acompanham o zoom.
 */

export type AnnotationTool = 'pen' | 'highlight' | 'text' | 'erase';

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

export type Annotation = StrokeMark | TextMark;

export const ANNOTATION_COLORS = ['#e4572e', '#2e6fe4', '#2f9e55', '#1d1f1c', '#f2c12e'];

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

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Desenha as marcações num <svg> do tamanho da página. */
export function annotationsSvg(list: Annotation[], width: number): string {
  return list
    .map((a, i) => {
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
    if (a?.kind === 'text' && typeof a.text === 'string' && a.text.trim()) {
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
}

/**
 * Camada de desenho sobre um elemento (a página). Lê e grava as marcações
 * pelos callbacks; quem chama decide onde guardar (partitura, PDF...).
 */
export class AnnotationLayer {
  readonly svg: SVGSVGElement;
  private drawing: StrokeMark | null = null;
  private live: SVGPathElement | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly state: LayerState,
    private readonly get: () => Annotation[],
    private readonly set: (list: Annotation[]) => void,
    private readonly askText: (at: { x: number; y: number; clientX: number; clientY: number }) => Promise<string | null>,
  ) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('annot-layer');
    host.appendChild(this.svg);
    this.svg.addEventListener('pointerdown', (e) => this.down(e));
    this.svg.addEventListener('pointermove', (e) => this.move(e));
    this.svg.addEventListener('pointerup', (e) => this.up(e));
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
  }

  draw() {
    const w = this.width;
    const h = this.host.clientHeight || w;
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.setAttribute('width', String(w));
    this.svg.setAttribute('height', String(h));
    this.svg.innerHTML = annotationsSvg(this.get(), w);
    this.live = null;
  }

  private at(e: PointerEvent) {
    const r = this.svg.getBoundingClientRect();
    const w = r.width || 1;
    return { x: (e.clientX - r.left) / w, y: (e.clientY - r.top) / w };
  }

  private down(e: PointerEvent) {
    if (!this.svg.classList.contains('active') || e.button !== 0) return;
    e.preventDefault();
    const p = this.at(e);
    const tool = this.state.tool;
    if (tool === 'erase') {
      this.svg.setPointerCapture(e.pointerId);
      this.eraseAt(p.x, p.y);
      this.drawing = { kind: 'pen', color: '', width: 0, points: [] }; // marca "apagando" enquanto arrasta
      return;
    }
    if (tool === 'text') {
      void this.askText({ ...p, clientX: e.clientX, clientY: e.clientY }).then((t) => {
        if (!t?.trim()) return;
        this.set([...this.get(), { kind: 'text', color: this.state.color, x: round(p.x), y: round(p.y + 0.012), size: 0.018, text: t.trim() }]);
        this.draw();
      });
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
    if (!this.drawing) return;
    const p = this.at(e);
    if (this.state.tool === 'erase') {
      this.eraseAt(p.x, p.y);
      return;
    }
    // várias amostras por quadro deixam o traço mais liso
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ce of events.length ? events : [e]) {
      const q = this.at(ce);
      this.drawing.points.push(q.x, q.y);
    }
    this.paintLive();
  }

  private up(_e: PointerEvent) {
    const d = this.drawing;
    this.drawing = null;
    if (!d || this.state.tool === 'erase') return;
    d.points = simplify(d.points);
    this.set([...this.get(), d]);
    this.draw();
  }

  private cancel() {
    this.drawing = null;
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
