/**
 * Google Drive: salvar partituras na pasta "Music Wiss" do Drive do usuário e
 * abrir arquivos do Drive no app.
 *
 * - Login: Google Identity Services, fluxo de token (sem servidor). O token fica
 *   só na memória e vale cerca de 1 hora; nada vai para o banco nem para o
 *   localStorage.
 * - Escopo drive.file: o app só enxerga os arquivos que ele mesmo criou ou que
 *   o usuário escolheu no seletor do Google. Não é um escopo sensível.
 * - Abrir: Google Picker + files.get?alt=media.
 * - Configuração: VITE_GOOGLE_CLIENT_ID, VITE_GOOGLE_API_KEY e VITE_GOOGLE_APP_ID
 *   no build, ou colados em Minhas partituras > Google Drive. São valores
 *   públicos por natureza (ficam restritos aos domínios do app no Google Cloud).
 */

export interface DriveConfig {
  clientId: string;
  apiKey: string;
  /** Número do projeto no Google Cloud (o Picker pede). */
  appId: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
}

/** Onde um arquivo do Music Wiss está no Drive, e como estava quando salvamos. */
export interface DriveLink {
  id: string;
  modifiedTime: string;
}

export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const FOLDER_NAME = 'Music Wiss';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FIELDS = 'id,name,mimeType,modifiedTime,size';

/** Tipos que o seletor mostra: os mesmos que "Abrir…" aceita do aparelho. */
export const OPEN_MIME = [
  'application/json',
  'application/vnd.recordare.musicxml+xml',
  'application/vnd.recordare.musicxml',
  'application/xml',
  'text/xml',
  'audio/midi',
  'audio/mid',
  'audio/x-midi',
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/octet-stream',
];

// ---------------------------------------------------------------- configuração

const CONFIG_KEY = 'music-wiss:drive-config';

export function driveConfig(): DriveConfig | null {
  const env = import.meta.env as Record<string, string | undefined>;
  if (env.VITE_GOOGLE_CLIENT_ID && env.VITE_GOOGLE_API_KEY && env.VITE_GOOGLE_APP_ID) {
    return { clientId: env.VITE_GOOGLE_CLIENT_ID, apiKey: env.VITE_GOOGLE_API_KEY, appId: env.VITE_GOOGLE_APP_ID };
  }
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const c = raw ? (JSON.parse(raw) as DriveConfig) : null;
    return c?.clientId && c.apiKey && c.appId ? c : null;
  } catch {
    return null;
  }
}

export function driveConfigFromBuild(): boolean {
  const env = import.meta.env as Record<string, string | undefined>;
  return !!(env.VITE_GOOGLE_CLIENT_ID && env.VITE_GOOGLE_API_KEY && env.VITE_GOOGLE_APP_ID);
}

export function saveDriveConfig(c: DriveConfig | null): void {
  try {
    if (c) localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
    else localStorage.removeItem(CONFIG_KEY);
  } catch {
    /* sem armazenamento */
  }
  token = null;
  folderId = null;
}

/** Confere o formato antes de tentar conectar. Recusa a chave secreta do cliente. */
export function validateDriveConfig(c: DriveConfig): string | null {
  if (/^GOCSPX-/.test(c.clientId) || /^GOCSPX-/.test(c.apiKey)) return 'Essa é a chave secreta do cliente. Ela nunca deve ir para o app: use o ID do cliente e a chave de API.';
  if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(c.clientId)) return 'O ID do cliente termina em .apps.googleusercontent.com';
  if (!/^AIza[0-9A-Za-z_-]{30,}$/.test(c.apiKey)) return 'A chave de API começa com AIza';
  if (!/^\d{6,}$/.test(c.appId)) return 'O número do projeto tem só dígitos (página inicial do Google Cloud)';
  return null;
}

// ---------------------------------------------------------------- partes puras

/** Corpo multipart/related do Drive: metadados em JSON + conteúdo. */
export function buildMultipart(meta: Record<string, unknown>, content: Blob, boundary: string): Blob {
  return new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${content.type || 'application/octet-stream'}\r\n\r\n`,
    content,
    `\r\n--${boundary}--`,
  ]);
}

/** Texto entre aspas simples para a busca do Drive (q=...). */
export function quoteQuery(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** O arquivo mudou no Drive depois do nosso último salvamento? */
export function changedSince(link: DriveLink | undefined, remote: DriveFile | null): boolean {
  return !!(link && remote && remote.modifiedTime !== link.modifiedTime);
}

/** Tipo de arquivo pelo nome, para mostrar na lista. */
export function kindOf(f: Pick<DriveFile, 'name' | 'mimeType'>): 'score' | 'xml' | 'midi' | 'pdf' | 'image' | 'other' {
  const n = f.name.toLowerCase();
  if (n.endsWith('.wiss.json') || (n.endsWith('.json') && f.mimeType === 'application/json')) return 'score';
  if (/\.(musicxml|mxl|xml)$/.test(n)) return 'xml';
  if (/\.midi?$/.test(n)) return 'midi';
  if (n.endsWith('.pdf') || f.mimeType === 'application/pdf') return 'pdf';
  if (/^image\//.test(f.mimeType)) return 'image';
  return 'other';
}

/** Nome de arquivo seguro no Drive (sem barras nem caracteres de controle). */
export function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || 'Sem título';
}

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** Mensagem em português para o que deu errado. */
export function driveError(err: unknown): string {
  if (err instanceof DriveError) {
    if (err.status === 401) return 'A permissão do Google expirou. Tente de novo e aceite no Google.';
    if (err.status === 403) return /quota|rate/i.test(err.message) ? 'O Google pediu para esperar um pouco. Tente de novo em instantes.' : 'O Google não deixou o Music Wiss usar este arquivo.';
    if (err.status === 404) return 'Esse arquivo não existe mais no Drive (ou o Music Wiss não tem acesso a ele).';
    return err.message;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/popup_closed|popup_failed_to_open|access_denied/i.test(msg)) return 'A janela do Google foi fechada ou bloqueada. Toque de novo e aceite o acesso.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Sem conexão com o Google. Verifique a internet.';
  if (/script/i.test(msg)) return 'Não foi possível carregar o Google aqui. O Drive funciona no app publicado (não na versão de teste).';
  return msg || 'Erro desconhecido';
}

// ---------------------------------------------------------------- scripts do Google

/* Tipos mínimos do que usamos das bibliotecas do Google (carregadas por <script>). */
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}
interface TokenClient {
  requestAccessToken(o?: { prompt?: string }): void;
}
interface GoogleNS {
  accounts: {
    oauth2: {
      initTokenClient(o: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type?: string; message?: string }) => void }): TokenClient;
      revoke(token: string, done?: () => void): void;
    };
  };
  picker?: PickerNS;
}
interface PickerNS {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (id?: string) => DocsView;
  ViewId: { DOCS: string };
  Action: { PICKED: string; CANCEL: string };
  Feature: { NAV_HIDDEN: string };
}
interface DocsView {
  setMimeTypes(m: string): DocsView;
  setIncludeFolders(b: boolean): DocsView;
  setMode?(m: unknown): DocsView;
}
interface PickerBuilder {
  addView(v: DocsView): PickerBuilder;
  setOAuthToken(t: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setLocale(l: string): PickerBuilder;
  setTitle(t: string): PickerBuilder;
  setCallback(fn: (d: { action: string; docs?: Array<{ id: string; name: string; mimeType: string; lastEditedUtc?: number }> }) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}
type W = Window & { google?: GoogleNS; gapi?: { load(name: string, cb: () => void | { callback: () => void; onerror: () => void }): void } };

const scripts = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scripts.delete(src);
        s.remove();
        reject(new Error('Não carregou o script do Google'));
      };
      document.head.appendChild(s);
    });
    scripts.set(src, p);
  }
  return p;
}

const GSI = 'https://accounts.google.com/gsi/client';
const GAPI = 'https://apis.google.com/js/api.js';

/**
 * Carrega as bibliotecas do Google antes do clique. O pedido de permissão abre
 * uma janela, e o navegador só deixa abrir se for logo depois de um clique.
 */
export function prepareDrive(): Promise<void> {
  if (!driveConfig()) return Promise.resolve();
  return Promise.all([loadScript(GSI), loadScript(GAPI)]).then(() => undefined);
}

// ---------------------------------------------------------------- token

let token: { value: string; expires: number } | null = null;
let tokenClient: TokenClient | null = null;
let tokenClientFor = '';
let pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;

export function driveConnected(now = Date.now()): boolean {
  return !!token && token.expires > now + 60_000;
}

function need(): DriveConfig {
  const c = driveConfig();
  if (!c) throw new DriveError('O Google Drive ainda não está configurado neste Music Wiss.');
  return c;
}

/** Pede (ou reaproveita) o token. Chame direto de um clique. */
export async function connect(): Promise<string> {
  if (driveConnected()) return token!.value;
  const cfg = need();
  await loadScript(GSI);
  const g = (window as W).google;
  if (!g?.accounts?.oauth2) throw new Error('Não carregou o script do Google');
  if (!tokenClient || tokenClientFor !== cfg.clientId) {
    tokenClient = g.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: SCOPE,
      callback: (r) => {
        const p = pending;
        pending = null;
        if (!p) return;
        if (r.error || !r.access_token) return p.reject(new Error(r.error || 'access_denied'));
        token = { value: r.access_token, expires: Date.now() + (r.expires_in ?? 3600) * 1000 };
        p.resolve(r.access_token);
      },
      error_callback: (e) => {
        const p = pending;
        pending = null;
        p?.reject(new Error(e.type || e.message || 'popup_closed'));
      },
    });
    tokenClientFor = cfg.clientId;
  }
  pending?.reject(new Error('popup_closed'));
  return new Promise<string>((resolve, reject) => {
    pending = { resolve, reject };
    tokenClient!.requestAccessToken({ prompt: '' });
  });
}

export function disconnect(): void {
  const t = token?.value;
  token = null;
  folderId = null;
  const g = (window as W).google;
  if (t && g?.accounts?.oauth2) g.accounts.oauth2.revoke(t);
}

// ---------------------------------------------------------------- chamadas

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch autenticado: refaz o token uma vez em 401 e espera um pouco em 429/5xx. */
async function call(url: string, init: RequestInit = {}, tries = 0): Promise<Response> {
  const t = await connect();
  const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${t}` } });
  if (res.ok) return res;
  if (res.status === 401 && tries === 0) {
    token = null;
    return call(url, init, tries + 1);
  }
  const text = await res.text().catch(() => '');
  const rate = res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit|userRateLimit|quota/i.test(text));
  if (rate && tries < 3) {
    await sleep(500 * 2 ** tries);
    return call(url, init, tries + 1);
  }
  let msg = text;
  try {
    msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
  } catch {
    /* texto puro */
  }
  throw new DriveError(msg || `Erro ${res.status} no Google Drive`, res.status);
}

let folderId: string | null = null;

/** Pasta "Music Wiss" no Drive: encontra ou cria. */
export async function ensureFolder(): Promise<string> {
  if (folderId) return folderId;
  const q = `name = ${quoteQuery(FOLDER_NAME)} and mimeType = ${quoteQuery(FOLDER_MIME)} and trashed = false`;
  const found = (await (await call(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive&pageSize=1`)).json()) as { files: Array<{ id: string }> };
  if (found.files?.[0]) return (folderId = found.files[0].id);
  const made = (await (
    await call(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    })
  ).json()) as { id: string };
  return (folderId = made.id);
}

/** Arquivos na pasta do Music Wiss, mais recentes primeiro. */
export async function listFiles(): Promise<DriveFile[]> {
  const folder = await ensureFolder();
  const q = `${quoteQuery(folder)} in parents and trashed = false`;
  const r = (await (await call(`${API}/files?q=${encodeURIComponent(q)}&orderBy=modifiedTime desc&pageSize=100&fields=files(${FIELDS})`)).json()) as { files: DriveFile[] };
  return r.files ?? [];
}

export async function getFile(id: string): Promise<DriveFile | null> {
  try {
    return (await (await call(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`)).json()) as DriveFile;
  } catch (err) {
    if (err instanceof DriveError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Salva no Drive. Com `id`, atualiza aquele arquivo; sem `id` (ou se ele sumiu),
 * cria um novo na pasta do Music Wiss.
 */
export async function upload(name: string, content: Blob, id?: string): Promise<DriveFile> {
  const boundary = `mw${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const headers = { 'Content-Type': `multipart/related; boundary=${boundary}` };
  if (id) {
    try {
      const res = await call(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=multipart&fields=${FIELDS}`, {
        method: 'PATCH',
        headers,
        body: buildMultipart({ name: safeName(name) }, content, boundary),
      });
      return (await res.json()) as DriveFile;
    } catch (err) {
      if (!(err instanceof DriveError && err.status === 404)) throw err;
    }
  }
  const parent = await ensureFolder();
  const res = await call(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, {
    method: 'POST',
    headers,
    body: buildMultipart({ name: safeName(name), mimeType: content.type || 'application/octet-stream', parents: [parent] }, content, boundary),
  });
  return (await res.json()) as DriveFile;
}

/** Baixa o conteúdo como File, pronto para os leitores do app. */
export async function download(f: Pick<DriveFile, 'id' | 'name' | 'mimeType'>): Promise<File> {
  if (f.mimeType.startsWith('application/vnd.google-apps.')) throw new DriveError('Arquivos do Google Docs, Planilhas e Apresentações não são partituras. Escolha um PDF, foto, MusicXML, MIDI ou .wiss.json.');
  const res = await call(`${API}/files/${encodeURIComponent(f.id)}?alt=media`);
  return new File([await res.blob()], f.name, { type: f.mimeType });
}

/** Abre o seletor do Google. Devolve o arquivo escolhido, ou null se cancelou. */
export async function pick(): Promise<DriveFile | null> {
  const cfg = need();
  const t = await connect();
  await loadScript(GAPI);
  const w = window as W;
  if (!w.google?.picker) {
    await new Promise<void>((resolve, reject) => {
      if (!w.gapi) return reject(new Error('Não carregou o script do Google'));
      w.gapi.load('picker', { callback: () => resolve(), onerror: () => reject(new Error('Não carregou o script do Google')) } as never);
    });
  }
  const P = w.google!.picker!;
  return new Promise<DriveFile | null>((resolve) => {
    const view = new P.DocsView(P.ViewId.DOCS).setMimeTypes(OPEN_MIME.join(',')).setIncludeFolders(true);
    new P.PickerBuilder()
      .addView(view)
      .setOAuthToken(t)
      .setDeveloperKey(cfg.apiKey)
      .setAppId(cfg.appId)
      .setLocale('pt-BR')
      .setTitle('Abrir do Google Drive')
      .setCallback((d) => {
        if (d.action === P.Action.PICKED && d.docs?.[0]) {
          const doc = d.docs[0];
          resolve({ id: doc.id, name: doc.name, mimeType: doc.mimeType, modifiedTime: doc.lastEditedUtc ? new Date(doc.lastEditedUtc).toISOString() : '' });
        } else if (d.action === P.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}
