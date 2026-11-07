import type { Annotation } from '../annotate/annotations';
import { annotationsSvg } from '../annotate/annotations';

/**
 * Documento aberto para ler e marcar: um PDF (várias páginas) ou uma foto/imagem
 * de partitura (uma página). O PDF é desenhado com o pdf.js, carregado só quando
 * um PDF é aberto e rodando na própria página (sem worker separado), o que
 * também funciona na versão de um arquivo só.
 */

export interface DocPage {
  /** Tamanho da página em pontos (1/72 pol). */
  width: number;
  height: number;
  /** Desenha a página num canvas com a largura dada (em pixels CSS). */
  render(canvas: HTMLCanvasElement, cssWidth: number): Promise<void>;
  /** Texto da página (só PDF digital), em pontos com y para baixo. */
  text?(): Promise<Array<{ str: string; x: number; y: number; w: number; h: number }>>;
  /** Como a página é feita: área coberta por imagens (0–1) e quantos desenhos vetoriais tem. */
  inspect?(): Promise<{ imageArea: number; vectorOps: number }>;
}

/** Limites para abrir: arquivos maiores travariam o navegador no celular. */
export const MAX_DOC_BYTES = 60 * 1024 * 1024;
export const MAX_DOC_PAGES = 200;

/** Erro com mensagem pronta para mostrar. */
export class DocError extends Error {
  constructor(
    public code: 'too-big' | 'too-many-pages' | 'password' | 'invalid' | 'empty' | 'unknown-type' | 'image',
    message: string,
  ) {
    super(message);
  }
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** Traduz os erros do pdf.js em mensagens claras. */
export function pdfError(err: unknown): DocError {
  const name = (err as { name?: string })?.name ?? '';
  const msg = String((err as { message?: string })?.message ?? err);
  if (name === 'PasswordException' || /password/i.test(msg)) {
    return new DocError('password', 'Este PDF está protegido por senha. Abra no leitor de PDF, salve uma cópia sem senha e tente de novo.');
  }
  if (name === 'InvalidPDFException' || name === 'FormatError' || /invalid pdf|bad xref|structure/i.test(msg)) {
    return new DocError('invalid', 'Este arquivo não é um PDF válido ou está corrompido. Tente exportar o PDF de novo.');
  }
  return new DocError('invalid', `Não consegui abrir este PDF (${msg.slice(0, 80)}).`);
}

export interface OpenDocument {
  name: string;
  kind: 'pdf' | 'image';
  pages: DocPage[];
  destroy(): void;
}

let pdfjsReady: Promise<typeof import('pdfjs-dist')> | null = null;

async function pdfjs() {
  pdfjsReady ??= (async () => {
    const [lib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs')]);
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return lib;
  })();
  return pdfjsReady;
}

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

export function imageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return null;
}

export async function openDocument(name: string, bytes: Uint8Array): Promise<OpenDocument> {
  if (!bytes.length) throw new DocError('empty', 'O arquivo está vazio.');
  if (bytes.length > MAX_DOC_BYTES) throw new DocError('too-big', `Arquivo grande demais (${mb(bytes.length)}). O limite é ${mb(MAX_DOC_BYTES)}: divida o PDF ou reduza a resolução.`);
  if (isPdf(bytes)) {
    const lib = await pdfjs();
    // o pdf.js fica com o buffer: passa uma cópia
    const loading = lib.getDocument({ data: bytes.slice() });
    let doc: Awaited<typeof loading.promise>;
    try {
      doc = await loading.promise;
    } catch (err) {
      void loading.destroy();
      throw pdfError(err);
    }
    if (!doc.numPages) throw new DocError('empty', 'Este PDF não tem páginas.');
    if (doc.numPages > MAX_DOC_PAGES) {
      void loading.destroy();
      throw new DocError('too-many-pages', `PDF com ${doc.numPages} páginas: o limite é ${MAX_DOC_PAGES}. Separe só a música que você vai ler.`);
    }
    const OPS = lib.OPS;
    const pages: DocPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      let task: { cancel(): void; promise: Promise<void> } | null = null;
      pages.push({
        width: vp.width,
        height: vp.height,
        async render(canvas, cssWidth) {
          task?.cancel();
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const viewport = page.getViewport({ scale: (cssWidth / vp.width) * dpr });
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          canvas.style.width = `${cssWidth}px`;
          canvas.style.height = `${(cssWidth * vp.height) / vp.width}px`;
          const t = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport });
          task = t;
          try {
            await t.promise;
          } catch (err) {
            if ((err as { name?: string })?.name !== 'RenderingCancelledException') throw err;
          }
        },
        async text() {
          const content = await page.getTextContent();
          const out: Array<{ str: string; x: number; y: number; w: number; h: number }> = [];
          for (const it of content.items) {
            if (!('str' in it) || !it.str.trim()) continue;
            const [a, b, c, d, e, f] = it.transform as number[];
            const [x, y] = vp.convertToViewportPoint(e, f);
            const h = it.height || Math.hypot(c, d) || Math.hypot(a, b);
            out.push({ str: it.str, x, y, w: it.width, h });
          }
          return out;
        },
        async inspect() {
          // acompanha a matriz de transformação até cada imagem desenhada
          const ops = await page.getOperatorList();
          let ctm = [1, 0, 0, 1, 0, 0];
          const stack: number[][] = [];
          let area = 0;
          let vectorOps = 0;
          const mul = (m: number[], n: number[]) => [
            n[0] * m[0] + n[1] * m[2],
            n[0] * m[1] + n[1] * m[3],
            n[2] * m[0] + n[3] * m[2],
            n[2] * m[1] + n[3] * m[3],
            n[4] * m[0] + n[5] * m[2] + m[4],
            n[4] * m[1] + n[5] * m[3] + m[5],
          ];
          for (let k = 0; k < ops.fnArray.length; k++) {
            const fn = ops.fnArray[k];
            if (fn === OPS.save) stack.push(ctm);
            else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
            else if (fn === OPS.transform) ctm = mul(ctm, ops.argsArray[k] as number[]);
            else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
              area += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / (vp.width * vp.height);
            } else if (fn === OPS.constructPath) vectorOps++;
          }
          return { imageArea: Math.min(1, area), vectorOps };
        },
      });
    }
    return { name, kind: 'pdf', pages, destroy: () => void loading.destroy() };
  }
  const type = imageType(bytes);
  if (!type) throw new DocError('unknown-type', 'Abra um PDF, uma imagem (JPG/PNG), um MIDI ou um MusicXML');
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => {
    throw new DocError('image', 'Não consegui ler esta imagem (arquivo estragado ou formato não suportado).');
  });
  return {
    name,
    kind: 'image',
    pages: [
      {
        width: img.naturalWidth,
        height: img.naturalHeight,
        async render(canvas, cssWidth) {
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.round(cssWidth * dpr);
          canvas.height = Math.round((cssWidth * dpr * img.naturalHeight) / img.naturalWidth);
          canvas.style.width = `${cssWidth}px`;
          canvas.style.height = `${(cssWidth * img.naturalHeight) / img.naturalWidth}px`;
          canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        },
      },
    ],
    destroy: () => URL.revokeObjectURL(url),
  };
}

/** Desenha página + marcações num canvas (para exportar ou mandar para a IA). */
async function flatten(page: DocPage, marks: Annotation[], pxWidth: number): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  // render() usa pixels CSS × devicePixelRatio; aqui queremos pixels exatos
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  await page.render(canvas, pxWidth / dpr);
  if (marks.length) {
    const w = canvas.width;
    const h = canvas.height;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${annotationsSvg(marks, w)}</svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    canvas.getContext('2d')!.drawImage(img, 0, 0);
  }
  return canvas;
}

/** Imagens JPEG (base64) das páginas, para a IA ler. */
export async function pagesAsJpeg(doc: OpenDocument, pages: number[], maxWidth = 1568): Promise<string[]> {
  const out: string[] = [];
  for (const i of pages) {
    const page = doc.pages[i];
    const w = Math.min(maxWidth, Math.max(800, page.width * 2));
    const canvas = await flatten(page, [], w);
    out.push(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
  }
  return out;
}

/** Novo PDF com as páginas e as marcações desenhadas por cima. */
export async function exportAnnotatedPdf(doc: OpenDocument, marks: Record<number, Annotation[]>): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  let pdf: InstanceType<typeof jsPDF> | null = null;
  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages[i];
    const orientation = page.width > page.height ? 'landscape' : 'portrait';
    const size: [number, number] = [page.width, page.height];
    if (!pdf) pdf = new jsPDF({ unit: 'pt', format: size, orientation });
    else pdf.addPage(size, orientation);
    const canvas = await flatten(page, marks[i] ?? [], Math.min(2400, page.width * 2.5));
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, page.width, page.height);
  }
  return pdf!.output('blob');
}
