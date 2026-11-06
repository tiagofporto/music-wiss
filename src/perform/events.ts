import type { Annotation } from '../annotate/annotations';
import type { Score } from '../model/score';
import { newId } from '../model/score';

/**
 * Eventos (apresentações, ensaios, missas, shows): cada um guarda uma lista de
 * partituras em ordem, para abrir rápido na aba Tocar. As partituras ficam
 * copiadas dentro do evento (funcionam sem internet e não mudam sozinhas);
 * adicionar de novo a mesma partitura atualiza a cópia.
 */

export interface EventItem {
  id: string;
  /** Partitura: Score.id; PDF/foto: código do arquivo. O mesmo item não entra duas vezes. */
  scoreId: string;
  title: string;
  /** Partitura editável (MusicXML, MIDI, .wiss.json ou a criada aqui). */
  score?: Score;
  /** PDF ou foto carregado como está, com as marcações que tinha. */
  doc?: EventDoc;
  /** Largura da folha quando foi salva (as marcações à mão dependem dela). */
  layoutWidth: number;
  savedAt: number;
}

export interface EventDoc {
  name: string;
  bytes: Uint8Array;
  marks: Record<number, Annotation[]>;
}

export interface PerformEvent {
  id: string;
  name: string;
  /** Data no formato AAAA-MM-DD (opcional). */
  date: string;
  place: string;
  items: EventItem[];
  updatedAt: number;
}

export function createEvent(name: string, date = '', place = ''): PerformEvent {
  return { id: newId('ev'), name: name.trim().slice(0, 120) || 'Evento', date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '', place: place.trim().slice(0, 120), items: [], updatedAt: Date.now() };
}

/** Põe a partitura no fim do evento, ou atualiza a cópia se ela já estiver lá. Devolve se era nova. */
export function addScore(ev: PerformEvent, score: Score, layoutWidth: number, now = Date.now()): boolean {
  const copy = JSON.parse(JSON.stringify(score)) as Score;
  return upsert(ev, { scoreId: score.id, title: score.title || 'Sem título', score: copy, layoutWidth }, now);
}

/** Põe um PDF ou foto no evento (o mesmo arquivo é atualizado, não duplicado). */
export function addDoc(ev: PerformEvent, key: string, doc: EventDoc, now = Date.now()): boolean {
  const title = doc.name.replace(/\.(pdf|jpe?g|png|webp)$/i, '') || 'Documento';
  return upsert(ev, { scoreId: key, title, doc: { name: doc.name, bytes: doc.bytes, marks: JSON.parse(JSON.stringify(doc.marks ?? {})) }, layoutWidth: 1018 }, now);
}

/** Copia um item (de outro evento ou do palco) para este evento. */
export function addItem(ev: PerformEvent, item: EventItem, now = Date.now()): boolean {
  const { id: _id, savedAt: _s, ...rest } = item;
  return upsert(ev, rest, now);
}

function upsert(ev: PerformEvent, data: Omit<EventItem, 'id' | 'savedAt'>, now: number): boolean {
  const existing = ev.items.find((i) => i.scoreId === data.scoreId);
  if (existing) {
    delete existing.score;
    delete existing.doc;
    Object.assign(existing, data, { savedAt: now });
  } else {
    ev.items.push({ id: newId('it'), ...data, savedAt: now });
  }
  ev.updatedAt = now;
  return !existing;
}

export function moveItem(ev: PerformEvent, itemId: string, delta: -1 | 1): void {
  const i = ev.items.findIndex((x) => x.id === itemId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ev.items.length) return;
  [ev.items[i], ev.items[j]] = [ev.items[j], ev.items[i]];
  ev.updatedAt = Date.now();
}

export function removeItem(ev: PerformEvent, itemId: string): void {
  ev.items = ev.items.filter((x) => x.id !== itemId);
  ev.updatedAt = Date.now();
}

/** Ordem da lista: próximos eventos primeiro (por data), depois sem data, depois os que já passaram. */
export function sortEvents(list: PerformEvent[], today = new Date().toISOString().slice(0, 10)): PerformEvent[] {
  const rank = (e: PerformEvent) => (!e.date ? 1 : e.date >= today ? 0 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? a.date.localeCompare(b.date) : rank(a) === 2 ? b.date.localeCompare(a.date) : b.updatedAt - a.updatedAt));
}

export function formatEventDate(date: string): string {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
}

// ---------------------------------------------------------------- IndexedDB

const DB = 'music-wiss-events';
const STORE = 'events';

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

export async function listEvents(): Promise<PerformEvent[]> {
  return sortEvents((await run<PerformEvent[]>('readonly', (s) => s.getAll())) ?? []);
}

export async function saveEvent(ev: PerformEvent): Promise<boolean> {
  return (await run('readwrite', (s) => s.put(ev))) !== null;
}

export async function deleteEvent(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}
