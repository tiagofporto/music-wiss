import { describe, expect, it, vi } from 'vitest';
import { addDoc, addItem, addScore, createEvent, formatEventDate, moveItem, removeItem, sortEvents } from '../src/perform/events';
import { pdfFileName, shareMessage, sharePdfToWhatsApp, whatsappUrl } from '../src/perform/share';
import { createScore } from '../src/model/score';

describe('eventos (repertório)', () => {
  it('cria evento com dados limpos', () => {
    const ev = createEvent('  Missa de domingo ', '2026-11-08', ' Matriz ');
    expect(ev.name).toBe('Missa de domingo');
    expect(ev.place).toBe('Matriz');
    expect(ev.date).toBe('2026-11-08');
    expect(createEvent('', 'ontem').date).toBe('');
    expect(createEvent('').name).toBe('Evento');
  });

  it('adiciona uma cópia e atualiza sem duplicar', () => {
    const ev = createEvent('Casamento');
    const score = createScore({ title: 'Ave Maria' } as never);
    expect(addScore(ev, score, 1018, 1)).toBe(true);
    score.title = 'Ave Maria (Schubert)';
    expect(addScore(ev, score, 900, 2)).toBe(false);
    expect(ev.items).toHaveLength(1);
    expect(ev.items[0].title).toBe('Ave Maria (Schubert)');
    expect(ev.items[0].layoutWidth).toBe(900);
    // é cópia: mudar a original não muda o evento
    score.title = 'outra';
    expect(ev.items[0].score?.title).toBe('Ave Maria (Schubert)');
  });

  it('carrega PDF/foto do aparelho sem duplicar e com as marcações', () => {
    const ev = createEvent('Missa');
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const marks = { 0: [{ kind: 'text', x: 0.1, y: 0.1, text: 'oi', color: '#000', size: 0.02 }] } as never;
    expect(addDoc(ev, 'abc', { name: 'Hino 12.pdf', bytes, marks })).toBe(true);
    expect(ev.items[0].title).toBe('Hino 12');
    expect(ev.items[0].doc?.marks[0]).toHaveLength(1);
    expect(addDoc(ev, 'abc', { name: 'Hino 12.pdf', bytes, marks: {} })).toBe(false);
    expect(ev.items).toHaveLength(1);
    expect(ev.items[0].doc?.marks[0]).toBeUndefined();
    // copiar para outro evento
    const other = createEvent('Ensaio');
    expect(addItem(other, ev.items[0])).toBe(true);
    expect(other.items[0].id).not.toBe(ev.items[0].id);
    expect(other.items[0].doc?.name).toBe('Hino 12.pdf');
    // trocar uma partitura por um documento com a mesma chave não deixa sobra
    const s = createScore();
    addScore(other, { ...s, id: 'abc' }, 900);
    expect(other.items[0].doc).toBeUndefined();
    expect(other.items[0].score).toBeDefined();
  });

  it('reordena e remove', () => {
    const ev = createEvent('Show');
    for (const t of ['A', 'B', 'C']) {
      const s = createScore({ title: t } as never);
      s.title = t;
      addScore(ev, s, 1000);
    }
    moveItem(ev, ev.items[2].id, -1);
    expect(ev.items.map((i) => i.title)).toEqual(['A', 'C', 'B']);
    moveItem(ev, ev.items[0].id, -1); // já é o primeiro
    expect(ev.items.map((i) => i.title)).toEqual(['A', 'C', 'B']);
    removeItem(ev, ev.items[1].id);
    expect(ev.items.map((i) => i.title)).toEqual(['A', 'B']);
  });

  it('ordena: próximos primeiro, depois sem data, depois passados', () => {
    const mk = (name: string, date: string) => ({ ...createEvent(name, date) });
    const list = [mk('passado', '2026-01-01'), mk('sem data', ''), mk('depois', '2026-12-20'), mk('logo', '2026-11-10')];
    expect(sortEvents(list, '2026-11-06').map((e) => e.name)).toEqual(['logo', 'depois', 'sem data', 'passado']);
  });

  it('formata a data em português', () => {
    expect(formatEventDate('')).toBe('');
    expect(formatEventDate('2026-11-08')).toMatch(/08/);
  });
});

describe('compartilhar pelo WhatsApp', () => {
  it('monta mensagem, link e nome do arquivo', () => {
    expect(shareMessage('Hino', 'https://x/y')).toContain('https://x/y');
    expect(whatsappUrl('a b')).toBe('https://wa.me/?text=a%20b');
    expect(pdfFileName('Ave/Maria: 2')).toBe('AveMaria 2.pdf');
    expect(pdfFileName('')).toBe('partitura.pdf');
  });

  it('sem compartilhar arquivos: baixa o PDF e abre o WhatsApp', async () => {
    const download = vi.fn();
    const open = vi.fn();
    const res = await sharePdfToWhatsApp(new Blob(['%PDF']), 'Hino', undefined, download, open);
    expect(res).toBe('fallback');
    expect(download).toHaveBeenCalledWith('Hino.pdf', expect.any(Blob));
    expect(open.mock.calls[0][0]).toMatch(/^https:\/\/wa\.me\/\?text=/);
  });

  it('com compartilhar arquivos (celular): manda o PDF anexado', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { share, canShare: () => true });
    const download = vi.fn();
    const res = await sharePdfToWhatsApp(new Blob(['%PDF']), 'Hino', undefined, download, vi.fn());
    expect(res).toBe('shared');
    expect(share.mock.calls[0][0].files[0].name).toBe('Hino.pdf');
    expect(download).not.toHaveBeenCalled();
    // cancelou na folha de compartilhar: não baixa nada
    share.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'AbortError' }));
    expect(await sharePdfToWhatsApp(new Blob(['%PDF']), 'Hino', undefined, download, vi.fn())).toBe('cancelled');
    expect(download).not.toHaveBeenCalled();
  });
});
