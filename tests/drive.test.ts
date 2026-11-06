// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { buildMultipart, changedSince, driveConfig, driveError, DriveError, kindOf, quoteQuery, safeName, saveDriveConfig, validateDriveConfig } from '../src/cloud/drive';
import { toEntry } from '../src/library/library';
import { createScore } from '../src/model/score';

const good = { clientId: '123456789012-abc123def.apps.googleusercontent.com', apiKey: 'AIzaSyA1234567890abcdefghijklmnopqrstu', appId: '123456789012' };

describe('Google Drive: configuração', () => {
  beforeEach(() => localStorage.clear());

  it('aceita os três valores públicos', () => {
    expect(validateDriveConfig(good)).toBeNull();
  });

  it('recusa a chave secreta do cliente', () => {
    expect(validateDriveConfig({ ...good, apiKey: 'GOCSPX-abcdefghijklmnop' })).toMatch(/secreta/);
    expect(validateDriveConfig({ ...good, clientId: 'GOCSPX-abc' })).toMatch(/secreta/);
  });

  it('explica o formato de cada campo', () => {
    expect(validateDriveConfig({ ...good, clientId: 'meu-app' })).toMatch(/googleusercontent/);
    expect(validateDriveConfig({ ...good, apiKey: 'xyz' })).toMatch(/AIza/);
    expect(validateDriveConfig({ ...good, appId: 'music-wiss' })).toMatch(/dígitos/);
  });

  it('guarda e apaga a configuração colada', () => {
    expect(driveConfig()).toBeNull();
    saveDriveConfig(good);
    expect(driveConfig()).toEqual(good);
    saveDriveConfig(null);
    expect(driveConfig()).toBeNull();
  });
});

describe('Google Drive: partes puras', () => {
  it('monta o corpo multipart com metadados e conteúdo', async () => {
    const blob = buildMultipart({ name: 'Ave Maria.wiss.json', parents: ['p1'] }, new Blob(['{"a":1}'], { type: 'application/json' }), 'XYZ');
    const text = await new Promise<string>((ok) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.readAsText(blob);
    });
    expect(text).toBe(
      '--XYZ\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"Ave Maria.wiss.json","parents":["p1"]}\r\n' +
        '--XYZ\r\nContent-Type: application/json\r\n\r\n{"a":1}\r\n--XYZ--',
    );
  });

  it('escapa aspas e barras na busca', () => {
    expect(quoteQuery("Music Wiss")).toBe("'Music Wiss'");
    expect(quoteQuery("Ana's \\ song")).toBe("'Ana\\'s \\\\ song'");
  });

  it('detecta quando o arquivo mudou no Drive', () => {
    const link = { id: 'f1', modifiedTime: '2026-11-06T20:00:00.000Z' };
    expect(changedSince(link, { id: 'f1', name: 'x', mimeType: '', modifiedTime: '2026-11-06T20:00:00.000Z' })).toBe(false);
    expect(changedSince(link, { id: 'f1', name: 'x', mimeType: '', modifiedTime: '2026-11-06T21:30:00.000Z' })).toBe(true);
    expect(changedSince(undefined, { id: 'f1', name: 'x', mimeType: '', modifiedTime: 'z' })).toBe(false);
    expect(changedSince(link, null)).toBe(false);
  });

  it('reconhece o tipo pelo nome', () => {
    expect(kindOf({ name: 'Hino.wiss.json', mimeType: 'application/json' })).toBe('score');
    expect(kindOf({ name: 'Hino.musicxml', mimeType: 'application/octet-stream' })).toBe('xml');
    expect(kindOf({ name: 'Hino.mxl', mimeType: '' })).toBe('xml');
    expect(kindOf({ name: 'hino.MID', mimeType: 'audio/midi' })).toBe('midi');
    expect(kindOf({ name: 'scan', mimeType: 'application/pdf' })).toBe('pdf');
    expect(kindOf({ name: 'foto.heic', mimeType: 'image/heic' })).toBe('image');
  });

  it('limpa nomes de arquivo', () => {
    expect(safeName('  Ave/Maria\\ 2  ')).toBe('Ave Maria 2');
    expect(safeName('')).toBe('Sem título');
  });

  it('traduz os erros mais comuns', () => {
    expect(driveError(new DriveError('x', 401))).toMatch(/expirou/);
    expect(driveError(new DriveError('x', 404))).toMatch(/não existe/);
    expect(driveError(new DriveError('User rate limit exceeded', 403))).toMatch(/esperar/);
    expect(driveError(new Error('popup_closed'))).toMatch(/janela/);
    expect(driveError(new Error('Failed to fetch'))).toMatch(/conexão/);
  });
});

describe('Biblioteca: onde a partitura está guardada', () => {
  it('mantém o vínculo com a conta e o Drive ao salvar de novo', () => {
    const s = createScore();
    s.title = 'Prelúdio';
    const first = { ...toEntry(s, null, 1), cloudId: 'c1', drive: { json: { id: 'f1', modifiedTime: 't' } } };
    const again = toEntry(s, first, 2);
    expect(again.cloudId).toBe('c1');
    expect(again.drive?.json?.id).toBe('f1');
    expect(again.createdAt).toBe(1);
    expect(again.updatedAt).toBe(2);
  });
});
