import type { Score } from '../model/score';

/**
 * Minhas partituras: cada partitura criada ou aberta no Music Wiss fica
 * guardada neste navegador (IndexedDB), para ver, abrir de novo e apagar.
 * Qualquer falha de armazenamento (modo anônimo, cota) é ignorada.
 */

export interface LibraryEntry {
  id: string;
  title: string;
  composer: string;
  /** Resumo para a lista: "Piano, Voz · 12 compassos". */
  summary: string;
  notes: number;
  createdAt: number;
  updatedAt: number;
  score: Score;
}

/** Partitura nova e vazia, ainda sem título: não vale a pena guardar. */
export function isBlank(score: Score): boolean {
  return (!score.title || score.title === 'Sem título') && countNotes(score) === 0 && !score.annotations?.length;
}

export function countNotes(score: Score): number {
  let n = 0;
  for (const part of score.parts)
    for (const staff of part.staves)
      for (const m of staff.measures)
        for (const v of m.voices) for (const e of v.events) if (e.kind === 'chord') n++;
  return n;
}

export function toEntry(score: Score, previous?: LibraryEntry | null, now = Date.now()): LibraryEntry {
  const measures = Math.max(0, ...score.parts.map((p) => p.staves[0]?.measures.length ?? 0));
  const names = [...new Set(score.parts.map((p) => p.name))];
  const parts = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
  return {
    id: score.id,
    title: score.title || 'Sem título',
    composer: score.composer || '',
    summary: `${parts} · ${measures} ${measures === 1 ? 'compasso' : 'compassos'}`,
    notes: countNotes(score),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    score: JSON.parse(JSON.stringify(score)) as Score,
  };
}

/** Busca por título ou compositor (sem diferença de acento e maiúsculas), mais recentes primeiro. */
export function filterLibrary(list: LibraryEntry[], query = ''): LibraryEntry[] {
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const q = norm(query.trim());
  return list.filter((e) => !q || norm(`${e.title} ${e.composer}`).includes(q)).sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------------------------------------------------------------- IndexedDB

const DB = 'music-wiss-library';
const STORE = 'scores';

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

export async function listLibrary(): Promise<LibraryEntry[]> {
  return filterLibrary((await run<LibraryEntry[]>('readonly', (s) => s.getAll())) ?? []);
}

export async function getEntry(id: string): Promise<LibraryEntry | null> {
  return (await run<LibraryEntry>('readonly', (s) => s.get(id))) ?? null;
}

/** Guarda (ou atualiza) a partitura. Partituras novas e vazias não entram. */
export async function saveToLibrary(score: Score): Promise<void> {
  if (isBlank(score)) return;
  const prev = await getEntry(score.id);
  await run('readwrite', (s) => s.put(toEntry(score, prev)));
}

export async function putEntry(entry: LibraryEntry): Promise<void> {
  await run('readwrite', (s) => s.put(entry));
}

export async function deleteFromLibrary(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}
