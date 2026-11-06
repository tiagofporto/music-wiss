import type { Annotation } from '../annotate/annotations';
import { sanitizeAnnotations } from '../annotate/annotations';

/**
 * Guarda no navegador (IndexedDB) os documentos abertos e as marcações de cada
 * página, para voltar a eles depois. Qualquer falha (modo anônimo, cota) é ignorada.
 */

export interface StoredDoc {
  id: string;
  name: string;
  bytes: Uint8Array;
  marks: Record<number, Annotation[]>;
  updatedAt: number;
  /** Onde a pessoa parou: rolagem como fração da altura das páginas. */
  view?: { scroll: number };
}

const DB = 'music-wiss-docs';
const STORE = 'docs';
const MAX_DOCS = 12;

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Identificador estável do arquivo: o mesmo PDF reaberto recupera as marcações. */
export async function docId(bytes: Uint8Array): Promise<string> {
  try {
    const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(hash).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // sem crypto.subtle (página sem https): tamanho + amostra
    let h = bytes.length;
    for (let i = 0; i < bytes.length; i += Math.max(1, Math.floor(bytes.length / 4096))) h = (h * 31 + bytes[i]) >>> 0;
    return `x${bytes.length.toString(16)}${h.toString(16)}`;
  }
}

export async function loadDoc(id: string): Promise<StoredDoc | null> {
  const d = await run<StoredDoc>('readonly', (s) => s.get(id));
  if (!d) return null;
  const marks: Record<number, Annotation[]> = {};
  for (const [k, v] of Object.entries(d.marks ?? {})) marks[Number(k)] = sanitizeAnnotations(v);
  return { ...d, marks };
}

export async function saveDoc(doc: StoredDoc): Promise<void> {
  await run('readwrite', (s) => s.put(doc));
  // mantém só os mais recentes
  const all = await listDocs();
  for (const old of all.slice(MAX_DOCS)) await run('readwrite', (s) => s.delete(old.id));
}

export async function listDocs(): Promise<Array<{ id: string; name: string; updatedAt: number }>> {
  const all = (await run<StoredDoc[]>('readonly', (s) => s.getAll())) ?? [];
  return all.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDoc(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}
