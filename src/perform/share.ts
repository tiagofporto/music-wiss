/**
 * Compartilhar o PDF da partitura pelo WhatsApp.
 *
 * No celular (e em navegadores com "compartilhar arquivos"), abre a folha de
 * compartilhamento do sistema com o PDF anexado: é só escolher o WhatsApp.
 * Onde isso não existe (a maioria dos computadores), o PDF é baixado e o
 * WhatsApp abre com a mensagem pronta; aí basta anexar o arquivo baixado.
 */

export function whatsappUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export function shareMessage(title: string, link?: string): string {
  return `🎼 ${title || 'Partitura'}${link ? `\n${link}` : ''}\n(enviado pelo Music Wiss)`;
}

export function pdfFileName(title: string): string {
  const base = (title || 'partitura').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60) || 'partitura';
  return `${base}.pdf`;
}

export type ShareResult = 'shared' | 'cancelled' | 'fallback';

export async function sharePdfToWhatsApp(
  pdf: Blob,
  title: string,
  link: string | undefined,
  download: (name: string, blob: Blob) => void,
  openUrl: (url: string) => void = (u) => window.open(u, '_blank', 'noopener'),
): Promise<ShareResult> {
  const name = pdfFileName(title);
  const text = shareMessage(title, link);
  const file = new File([pdf], name, { type: 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: title || 'Partitura', text });
      return 'shared';
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return 'cancelled';
      // falhou por outro motivo: segue para o plano B
    }
  }
  download(name, pdf);
  openUrl(whatsappUrl(text));
  return 'fallback';
}
