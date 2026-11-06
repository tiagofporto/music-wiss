/**
 * Guarda o SoundFont escolhido no IndexedDB do navegador, para não precisar
 * carregar de novo a cada visita. Qualquer falha (modo anônimo, cota) é ignorada.
 */
const DB = 'music-wiss';
const STORE = 'soundfonts';
const KEY = 'current';

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
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

export async function storeSoundFont(name: string, bytes: Uint8Array): Promise<void> {
  await run('readwrite', (s) => s.put({ name, bytes: new Blob([bytes as BlobPart]) }, KEY));
}

export async function loadStoredSoundFont(): Promise<{ name: string; bytes: Uint8Array } | null> {
  const v = (await run('readonly', (s) => s.get(KEY))) as { name: string; bytes: Blob } | null | undefined;
  if (!v?.bytes) return null;
  try {
    return { name: v.name, bytes: new Uint8Array(await v.bytes.arrayBuffer()) };
  } catch {
    return null;
  }
}

export async function forgetSoundFont(): Promise<void> {
  await run('readwrite', (s) => s.delete(KEY));
}
