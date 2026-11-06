import { describe, expect, it } from 'vitest';
import { countNotes, filterLibrary, isBlank, toEntry } from '../src/library/library';
import { createScore } from '../src/model/score';
import { Editor } from '../src/editor/editor';

describe('minhas partituras', () => {
  it('não guarda partitura nova vazia e sem título', () => {
    const s = createScore();
    s.title = 'Sem título';
    expect(isBlank(s)).toBe(true);
    s.title = 'Hino';
    expect(isBlank(s)).toBe(false);
  });

  it('conta notas e resume', () => {
    const ed = new Editor(createScore({ title: 'Teste' }));
    ed.toggleInputMode(true);
    ed.insertStep('C');
    ed.insertStep('D');
    expect(countNotes(ed.score)).toBe(2);
    const e = toEntry(ed.score, null, 10);
    expect(e.summary).toMatch(/Piano · 1 compasso/);
    expect(e.notes).toBe(2);
    expect(toEntry(ed.score, e, 20).createdAt).toBe(10);
  });

  it('busca sem acento e ordena pelas mais recentes', () => {
    const mk = (title: string, composer: string, t: number) => ({ ...toEntry({ ...createScore(), title, composer }, null, t) });
    const list = [mk('Ave Maria', 'Schubert', 1), mk('Canção', 'Tiago', 3), mk('Hino', '', 2)];
    expect(filterLibrary(list).map((e) => e.title)).toEqual(['Canção', 'Hino', 'Ave Maria']);
    expect(filterLibrary(list, 'cancao').map((e) => e.title)).toEqual(['Canção']);
    expect(filterLibrary(list, 'SCHU').map((e) => e.title)).toEqual(['Ave Maria']);
  });
});
