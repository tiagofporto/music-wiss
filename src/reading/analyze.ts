import type { OpenDocument } from '../doc/document';
import type { PageInput, PageKind, ReadingMap } from './model';
import { buildReadingMap } from './model';
import { analyzePage, binarize } from './raster';

/** Largura da imagem analisada: ~2× uma página A4 em 100%, o bastante para o espaço da pauta ter ~15 px. */
const ANALYSIS_WIDTH = 1700;
/** Acima disso a análise fica lenta demais no celular. */
export const MAX_READ_PAGES = 40;

/**
 * Lê o documento aberto, página por página, no próprio navegador (nada é
 * enviado para servidor): desenha cada página num canvas, acha a estrutura
 * (pautas, barras, compassos, cabeças de nota) e, no PDF digital, o texto.
 */
export async function readDocument(doc: OpenDocument, onProgress?: (page: number, total: number) => void, isCancelled?: () => boolean): Promise<ReadingMap> {
  if (doc.pages.length > MAX_READ_PAGES) {
    throw new Error(`Este documento tem ${doc.pages.length} páginas; a leitura vai até ${MAX_READ_PAGES}. Separe a música num PDF menor.`);
  }
  const inputs: PageInput[] = [];
  for (let i = 0; i < doc.pages.length; i++) {
    if (isCancelled?.()) throw new Error('cancelado');
    onProgress?.(i + 1, doc.pages.length);
    const page = doc.pages[i];
    const canvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    await page.render(canvas, ANALYSIS_WIDTH / dpr);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // deixa o navegador respirar entre as páginas (a tela não congela)
    await new Promise((r) => setTimeout(r, 0));
    const structure = analyzePage(binarize(img.data, img.width, img.height));
    let kind: PageKind = doc.kind === 'image' ? 'image' : 'digital';
    let text: PageInput['text'] = [];
    if (doc.kind === 'pdf') {
      const info = (await page.inspect?.()) ?? { imageArea: 0, vectorOps: 0 };
      // música colada como imagem (scan, foto ou exportação em imagem): escaneada.
      // O texto de verdade que o PDF tiver (título, andamento) continua valendo.
      if (info.imageArea > 0.2 && info.vectorOps < 80) kind = 'scanned';
      const scale = canvas.width / page.width;
      const raw = (await page.text?.()) ?? [];
      text = raw.map((t) => ({ str: t.str, x: t.x * scale, y: t.y * scale, w: t.w * scale, h: t.h * scale }));
    }
    inputs.push({ kind, structure, text });
    canvas.width = canvas.height = 0;
  }
  return buildReadingMap(inputs);
}
