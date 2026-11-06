import { jsPDF } from 'jspdf';
import type { Score } from '../model/score';
import { renderScore } from '../render/renderer';

/**
 * Gera um PDF A4 da partitura: título na primeira página, sistemas distribuídos
 * pelas páginas sem cortar nenhum ao meio e número de página no rodapé.
 * A música é desenhada num canvas em alta resolução (fonte Bravura) e colada no PDF.
 */

const PAGE_W = 210; // mm
const PAGE_H = 297;
const MARGIN = 15;
const RENDER_WIDTH = 760; // largura do desenho em px (vira 180 mm)
const SCALE = 3; // pixels por px: ~300 dpi no papel

const PRINT_THEME = { ink: '#111111', muted: '#555555', accent: '#111111', playing: '#111111', warn: 'transparent' };

export async function exportPdf(score: Score): Promise<Blob> {
  await document.fonts.load('30px Bravura');
  const canvas = document.createElement('canvas');
  const result = renderScore(document.createElement('div'), score, {
    width: RENDER_WIDTH,
    selection: null,
    playingTime: null,
    cursor: null,
    theme: PRINT_THEME,
    canvas: { element: canvas, scale: SCALE },
  });

  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const mmPerPx = (PAGE_W - MARGIN * 2) / RENDER_WIDTH;

  // cabeçalho
  pdf.setFont('times', 'bold');
  pdf.setFontSize(22);
  pdf.text(score.title || 'Sem título', PAGE_W / 2, MARGIN + 10, { align: 'center' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  if (score.composer) pdf.text(score.composer, PAGE_W - MARGIN, MARGIN + 20, { align: 'right' });
  pdf.text(`Semínima = ${score.tempo}`, MARGIN, MARGIN + 20);

  let y = MARGIN + 26;
  let page = 1;
  for (const sys of result.systems) {
    const hPx = sys.bottom - sys.top;
    const hMm = hPx * mmPerPx;
    if (y + hMm > PAGE_H - MARGIN - 8 && y > MARGIN + 1) {
      pdf.addPage();
      page += 1;
      y = MARGIN;
    }
    const slice = document.createElement('canvas');
    slice.width = Math.round(RENDER_WIDTH * SCALE);
    slice.height = Math.round(hPx * SCALE);
    const sctx = slice.getContext('2d')!;
    sctx.fillStyle = '#ffffff';
    sctx.fillRect(0, 0, slice.width, slice.height);
    sctx.drawImage(canvas, 0, Math.round(sys.top * SCALE), slice.width, slice.height, 0, 0, slice.width, slice.height);
    pdf.addImage(slice.toDataURL('image/png'), 'PNG', MARGIN, y, PAGE_W - MARGIN * 2, hMm, undefined, 'FAST');
    y += hMm;
  }

  // rodapé com numeração
  pdf.setFontSize(8);
  pdf.setTextColor(120);
  for (let p = 1; p <= page; p++) {
    pdf.setPage(p);
    pdf.text(`${p} / ${page}`, PAGE_W / 2, PAGE_H - 8, { align: 'center' });
    pdf.text('Music Wiss', PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' });
  }
  return pdf.output('blob');
}
