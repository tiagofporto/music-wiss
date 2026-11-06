import type { RealtimeChannel, Session, SupabaseClient } from '@supabase/supabase-js';
import type { Score } from '../model/score';
import type { Transcription } from '../ai/transcription';
import { cloudConfig } from './config';

/**
 * Partituras na nuvem (Supabase): conta, salvar/abrir, compartilhar por link e
 * avisos em tempo real quando outra pessoa salva a mesma partitura.
 * O cliente do Supabase é carregado só quando a nuvem é usada.
 */

export type Role = 'owner' | 'edit' | 'view';

export interface CloudScoreRow {
  id: string;
  owner_id: string;
  title: string;
  version: number;
  updated_at: string;
}

export interface CloudDoc {
  id: string;
  version: number;
  role: Role;
}

/** Link de compartilhamento: #s=<id>.<token>.<papel> */
export interface ShareLink {
  scoreId: string;
  token: string;
  role: 'view' | 'edit';
}

let client: SupabaseClient | null = null;
let clientKey = '';

export async function supabase(): Promise<SupabaseClient | null> {
  const cfg = cloudConfig();
  if (!cfg) return null;
  const k = `${cfg.url}|${cfg.key}`;
  if (client && clientKey === k) return client;
  const { createClient } = await import('@supabase/supabase-js');
  client = createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true } });
  clientKey = k;
  return client;
}

/** Mensagens de erro do Supabase em português, quando dá para reconhecer. */
export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  if (/Invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
  if (/Email not confirmed/i.test(msg)) return 'Confirme o e-mail pelo link que enviamos antes de entrar.';
  if (/User already registered/i.test(msg)) return 'Esse e-mail já tem conta. Use Entrar.';
  if (/Password should be/i.test(msg)) return 'A senha precisa ter pelo menos 6 caracteres.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Sem conexão com a nuvem. Verifique a internet e a URL do projeto.';
  if (/row-level security|permission denied/i.test(msg)) return 'Você não tem permissão para isso nesta partitura.';
  return msg || 'Erro desconhecido';
}

// ---------------------------------------------------------------- conta

export async function getSession(): Promise<Session | null> {
  const sb = await supabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session;
}

export async function onAuthChange(fn: (session: Session | null) => void): Promise<void> {
  const sb = await supabase();
  sb?.auth.onAuthStateChange((_event, session) => fn(session));
}

export async function signIn(email: string, password: string): Promise<void> {
  const sb = await need();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendlyError(error));
}

/** Cria a conta. Devolve true se já entrou; false se precisa confirmar o e-mail. */
export async function signUp(email: string, password: string): Promise<boolean> {
  const sb = await need();
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
  if (error) throw new Error(friendlyError(error));
  return !!data.session;
}

export async function signOut(): Promise<void> {
  const sb = await supabase();
  await sb?.auth.signOut();
}

async function need(): Promise<SupabaseClient> {
  const sb = await supabase();
  if (!sb) throw new Error('A nuvem não está configurada.');
  return sb;
}

// ---------------------------------------------------------------- partituras

export async function listScores(): Promise<{ mine: CloudScoreRow[]; shared: Array<CloudScoreRow & { role: Role }> }> {
  const sb = await need();
  const { data: auth } = await sb.auth.getUser();
  const uid = auth.user?.id;
  const { data, error } = await sb.from('scores').select('id, owner_id, title, version, updated_at').order('updated_at', { ascending: false }).limit(200);
  if (error) throw new Error(friendlyError(error));
  const rows = (data ?? []) as CloudScoreRow[];
  const { data: members } = await sb.from('score_members').select('score_id, role').eq('user_id', uid ?? '');
  const roles = new Map((members ?? []).map((m: { score_id: string; role: Role }) => [m.score_id, m.role]));
  return {
    mine: rows.filter((r) => r.owner_id === uid),
    shared: rows.filter((r) => r.owner_id !== uid).map((r) => ({ ...r, role: roles.get(r.id) ?? 'view' })),
  };
}

export async function createScore(score: Score): Promise<CloudDoc> {
  const sb = await need();
  const { data, error } = await sb.from('scores').insert({ title: score.title, data: score }).select('id, version').single();
  if (error) throw new Error(friendlyError(error));
  return { id: data.id, version: data.version, role: 'owner' };
}

export class ConflictError extends Error {}

/**
 * Salva por cima só se ninguém salvou antes (mesma versão).
 * Se outra pessoa salvou no meio, lança ConflictError.
 */
export async function saveScore(doc: CloudDoc, score: Score): Promise<number> {
  const sb = await need();
  const { data, error } = await sb
    .from('scores')
    .update({ title: score.title, data: score })
    .eq('id', doc.id)
    .eq('version', doc.version)
    .select('version');
  if (error) throw new Error(friendlyError(error));
  if (!data?.length) throw new ConflictError('Outra pessoa salvou esta partitura antes.');
  return data[0].version as number;
}

export async function loadScore(id: string): Promise<{ score: Score; version: number; ownerId: string; title: string }> {
  const sb = await need();
  const { data, error } = await sb.from('scores').select('data, version, owner_id, title').eq('id', id).single();
  if (error) throw new Error(friendlyError(error));
  return { score: data.data as Score, version: data.version, ownerId: data.owner_id, title: data.title };
}

export async function deleteScore(id: string): Promise<void> {
  const sb = await need();
  const { error } = await sb.from('scores').delete().eq('id', id);
  if (error) throw new Error(friendlyError(error));
}

/** Papel do usuário atual numa partitura. */
export async function roleFor(id: string, ownerId: string): Promise<Role> {
  const sb = await need();
  const { data: auth } = await sb.auth.getUser();
  if (auth.user?.id === ownerId) return 'owner';
  const { data } = await sb.from('score_members').select('role').eq('score_id', id).eq('user_id', auth.user?.id ?? '').maybeSingle();
  return (data?.role as Role) ?? 'view';
}

// ---------------------------------------------------------------- compartilhar

export function shareUrl(link: ShareLink): string {
  return `${location.origin}${location.pathname}#s=${link.scoreId}.${link.token}.${link.role}`;
}

export function parseShareHash(hash: string): ShareLink | null {
  const m = /[#&]s=([0-9a-f-]{36})\.([0-9a-f]{32})\.(view|edit)\b/.exec(hash);
  return m ? { scoreId: m[1], token: m[2], role: m[3] as 'view' | 'edit' } : null;
}

/** Cria (ou reaproveita) o link de ver/editar de uma partitura sua. */
export async function createShareLink(scoreId: string, role: 'view' | 'edit'): Promise<string> {
  const sb = await need();
  const { data: existing } = await sb.from('score_shares').select('token').eq('score_id', scoreId).eq('role', role).limit(1);
  let token = existing?.[0]?.token as string | undefined;
  if (!token) {
    const { data, error } = await sb.from('score_shares').insert({ score_id: scoreId, role }).select('token').single();
    if (error) throw new Error(friendlyError(error));
    token = data.token as string;
  }
  return shareUrl({ scoreId, token, role });
}

/** Desativa os links (quem já entrou continua; remova pelo painel). */
export async function revokeShareLinks(scoreId: string): Promise<void> {
  const sb = await need();
  const { error } = await sb.from('score_shares').delete().eq('score_id', scoreId);
  if (error) throw new Error(friendlyError(error));
}

/** Entra numa partitura por link (vira membro com o papel do link). */
export async function joinByLink(link: ShareLink): Promise<void> {
  const sb = await need();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) throw new Error('Entre na sua conta para abrir o link.');
  // dono abrindo o próprio link: nada a fazer
  const { data: own } = await sb.from('scores').select('owner_id').eq('id', link.scoreId).maybeSingle();
  if (own?.owner_id === auth.user.id) return;
  const { data: current } = await sb.from('score_members').select('role').eq('score_id', link.scoreId).eq('user_id', auth.user.id).maybeSingle();
  if (current?.role === 'edit' || current?.role === link.role) return; // já tem esse acesso (ou maior)
  const row = { score_id: link.scoreId, user_id: auth.user.id, role: link.role, via_token: link.token };
  const { error } = current
    ? await sb.from('score_members').update({ role: link.role, via_token: link.token }).eq('score_id', link.scoreId).eq('user_id', auth.user.id)
    : await sb.from('score_members').insert(row);
  if (error) throw new Error(/row-level security/i.test(error.message) ? 'Este link não vale mais. Peça um novo para quem compartilhou.' : friendlyError(error));
}

// ---------------------------------------------------------------- tempo real

export interface LiveHandlers {
  /** outra pessoa salvou uma versão nova */
  onRemote(row: { data: Score; version: number; title: string }): void;
  /** quem está com a partitura aberta agora */
  onPresence(people: string[]): void;
}

export async function joinLive(scoreId: string, me: string, h: LiveHandlers): Promise<() => void> {
  const sb = await need();
  const channel: RealtimeChannel = sb.channel(`score:${scoreId}`, { config: { presence: { key: me + ':' + Math.random().toString(36).slice(2, 7) } } });
  channel
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'scores', filter: `id=eq.${scoreId}` }, (payload) => {
      const row = payload.new as { data: Score; version: number; title: string };
      if (row?.data) h.onRemote(row);
    })
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<{ name: string }>();
      const names = new Set<string>();
      for (const list of Object.values(state)) for (const p of list) names.add(p.name);
      h.onPresence([...names]);
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await channel.track({ name: me });
    });
  return () => {
    void sb.removeChannel(channel);
  };
}

// ---------------------------------------------------------------- assistente

export interface AssistantAnswer {
  summary: string;
  chords: Array<{ index: number; symbol: string }>;
  issues: Array<{ measure: number; message: string }>;
}

async function invokeAssistant(body: Record<string, unknown>): Promise<unknown> {
  const sb = await need();
  const { data, error } = await sb.functions.invoke('assistente', { body });
  if (error) {
    // a função devolve { error } com a explicação
    const ctx = (error as { context?: Response }).context;
    let detail = '';
    try {
      detail = ctx ? ((await ctx.json()) as { error?: string }).error ?? '' : '';
    } catch {
      /* corpo não é JSON */
    }
    throw new Error(detail || 'O assistente não respondeu. Ele precisa estar publicado no Supabase (função "assistente").');
  }
  return data;
}

export async function askAssistant(task: 'harmonizar' | 'revisar', scoreText: string, style: string): Promise<AssistantAnswer> {
  const a = (await invokeAssistant({ task, score: scoreText, style })) as Partial<AssistantAnswer>;
  return { summary: a.summary ?? '', chords: a.chords ?? [], issues: a.issues ?? [] };
}

/**
 * Lê páginas de partitura (imagens JPEG em base64) e devolve a transcrição
 * e uma análise para edição.
 */
export async function askTranscription(images: string[], hint: string): Promise<Transcription> {
  const t = (await invokeAssistant({ task: 'transcrever', images, hint })) as Partial<Transcription>;
  return {
    summary: t.summary ?? '',
    title: t.title ?? '',
    composer: t.composer ?? '',
    tempo: t.tempo ?? 96,
    beats: t.beats ?? 4,
    beatType: t.beatType ?? 4,
    keyFifths: t.keyFifths ?? 0,
    parts: t.parts ?? [],
    issues: t.issues ?? [],
    suggestions: t.suggestions ?? [],
  };
}
