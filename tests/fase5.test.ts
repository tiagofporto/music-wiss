// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeForAssistant } from '../src/ai/describe';
import { ConflictError, parseShareHash, saveScore, shareUrl } from '../src/cloud/cloud';
import { saveCloudConfig, validateConfig } from '../src/cloud/config';
import { Editor } from '../src/editor/editor';
import { createScore } from '../src/model/score';
import type { Step } from '../src/model/pitch';

// Supabase falso: guarda a última atualização e responde com as linhas que o teste mandar.
const fake = vi.hoisted(() => ({ rows: [] as unknown[], filters: [] as Array<[string, unknown]>, patch: null as unknown }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const q = {
        update(p: unknown) {
          fake.patch = p;
          return q;
        },
        eq(col: string, v: unknown) {
          fake.filters.push([col, v]);
          return q;
        },
        select: () => Promise.resolve({ data: fake.rows, error: null }),
      };
      return q;
    },
  }),
}));

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('links de compartilhamento', () => {
  it('monta e lê o link', () => {
    const url = shareUrl({ scoreId: ID, token: TOKEN, role: 'edit' });
    expect(url).toMatch(new RegExp(`#s=${ID}\\.${TOKEN}\\.edit$`));
    expect(parseShareHash(new URL(url).hash)).toEqual({ scoreId: ID, token: TOKEN, role: 'edit' });
  });
  it('recusa links incompletos ou com papel estranho', () => {
    expect(parseShareHash('')).toBeNull();
    expect(parseShareHash(`#s=${ID}.${TOKEN}.owner`)).toBeNull();
    expect(parseShareHash(`#s=${ID}.abc.view`)).toBeNull();
  });
});

describe('configuração da nuvem', () => {
  it('aceita URL https e chave publicável', () => {
    expect(validateConfig('https://abc.supabase.co', 'sb_publishable_1234567890abcdefgh')).toBeNull();
  });
  it('recusa URL sem https e chave secreta', () => {
    expect(validateConfig('http://abc.supabase.co', 'sb_publishable_1234567890abcdefgh')).toMatch(/https/);
    expect(validateConfig('https://abc.supabase.co', 'sb_secret_1234567890abcdefghij')).toMatch(/secreta/);
    const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role })).replace(/=+$/, '')}.assinatura`;
    expect(validateConfig('https://abc.supabase.co', jwt('service_role'))).toMatch(/secreta/);
    expect(validateConfig('https://abc.supabase.co', jwt('anon'))).toBeNull();
  });
});

describe('salvar na nuvem', () => {
  beforeEach(() => {
    saveCloudConfig({ url: 'https://abc.supabase.co', key: 'sb_publishable_1234567890abcdefgh' });
    fake.filters = [];
  });
  it('só grava por cima da mesma versão e devolve a nova', async () => {
    fake.rows = [{ version: 8 }];
    const score = createScore({ instrumentId: 'flute' });
    expect(await saveScore({ id: ID, version: 7, role: 'owner' }, score)).toBe(8);
    expect(fake.filters).toEqual([
      ['id', ID],
      ['version', 7],
    ]);
    expect(fake.patch).toMatchObject({ title: score.title });
  });
  it('avisa conflito quando outra pessoa salvou antes', async () => {
    fake.rows = [];
    await expect(saveScore({ id: ID, version: 7, role: 'edit' }, createScore({ instrumentId: 'flute' }))).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('editor e colaboração', () => {
  function melody(): Editor {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.toggleInputMode(true);
    for (const s of ['C', 'D', 'E', 'F', 'G'] as Step[]) ed.insertStep(s);
    return ed;
  }

  it('versão de outra pessoa entra avisando que é remota e Ctrl+Z volta a minha', () => {
    const ed = melody();
    const mine = JSON.stringify(ed.score);
    const changes: Array<boolean | undefined> = [];
    ed.onChange((c) => changes.push(c.remote));
    const other = createScore({ instrumentId: 'flute' });
    other.title = 'Da outra pessoa';
    ed.replaceScore(other);
    expect(ed.score.title).toBe('Da outra pessoa');
    expect(changes).toEqual([true]);
    ed.undo();
    expect(JSON.stringify(ed.score)).toBe(mine);
  });

  it('cifras do assistente entram de uma vez (um só desfazer)', () => {
    const ed = melody();
    ed.setTexts('chordSymbol', [
      [0, 'C'],
      [2, 'Am7'],
      [4, 'G7'],
    ]);
    expect(ed.events().map((e) => e.marks?.chordSymbol)).toEqual(['C', undefined, 'Am7', undefined, 'G7']);
    ed.undo();
    expect(ed.events().every((e) => !e.marks?.chordSymbol)).toBe(true);
  });
});

describe('resumo para o assistente', () => {
  it('numera os eventos da voz alvo com o índice do editor', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.toggleInputMode(true);
    ed.setDuration('half');
    for (const s of ['C', 'D', 'E'] as Step[]) ed.insertStep(s);
    ed.setText('chordSymbol', 0, 'C');
    const text = describeForAssistant(ed.score, { partIndex: 0, staffIndex: 0, voiceIndex: 0 });
    expect(text).toContain('>>> VOZ ALVO');
    expect(text).toMatch(/c1: #0 C5 Mínima \[cifra C\] \| #1 D5 Mínima/);
    expect(text).toMatch(/c2: #2 E5 Mínima/);
  });
});
