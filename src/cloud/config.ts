/**
 * Onde está o backend (Supabase). Vem das variáveis do build
 * (VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY, ver .env.example) ou,
 * se não houver, do que o usuário colar no painel Nuvem (guardado neste navegador).
 * A chave publicável é pública por natureza: quem protege os dados é a RLS do banco.
 */
export interface CloudConfig {
  url: string;
  key: string;
}

const KEY = 'music-wiss:cloud-config';

export function cloudConfig(): CloudConfig | null {
  const env = import.meta.env as Record<string, string | undefined>;
  if (env.VITE_SUPABASE_URL && env.VITE_SUPABASE_PUBLISHABLE_KEY) {
    return { url: env.VITE_SUPABASE_URL, key: env.VITE_SUPABASE_PUBLISHABLE_KEY };
  }
  try {
    const raw = localStorage.getItem(KEY);
    const c = raw ? (JSON.parse(raw) as CloudConfig) : null;
    return c?.url && c.key ? c : null;
  } catch {
    return null;
  }
}

/** A configuração veio do build (não dá para trocar pela tela). */
export function configFromBuild(): boolean {
  const env = import.meta.env as Record<string, string | undefined>;
  return !!(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_PUBLISHABLE_KEY);
}

export function saveCloudConfig(c: CloudConfig | null): void {
  try {
    if (c) localStorage.setItem(KEY, JSON.stringify(c));
    else localStorage.removeItem(KEY);
  } catch {
    /* sem armazenamento */
  }
}

/** Confere o formato antes de tentar conectar. */
export function validateConfig(url: string, key: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return 'A URL precisa começar com https://';
  } catch {
    return 'URL inválida';
  }
  if (key.length < 20) return 'Chave muito curta';
  if (/^sb_secret_/.test(key) || jwtRole(key) === 'service_role') return 'Essa é a chave secreta. Use a chave publicável (anon/publishable).';
  return null;
}

/** Papel gravado numa chave antiga em formato JWT (anon ou service_role). */
function jwtRole(key: string): string | null {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(json) as { role?: string }).role ?? null;
  } catch {
    return null;
  }
}
