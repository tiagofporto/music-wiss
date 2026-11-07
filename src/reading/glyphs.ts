import type { TextItem } from './text';

/**
 * PDFs digitais feitos por editores que usam fontes musicais padrão (SMuFL:
 * Bravura, Leland, Petaluma… — MuseScore 4, Dorico, Music Wiss e outros)
 * guardam cada símbolo como um caractere. Aqui eles viram notas e pausas com
 * altura exata. O que não vem como caractere (vigas das colcheias, hastes,
 * ligaduras) não dá para ler: a duração das notas pretas fica como estimativa.
 */

/** Separa os itens de texto em símbolos (o PDF junta "♯ 3" num item só). */
export function splitGlyphs(items: TextItem[]): TextItem[] {
  const out: TextItem[] = [];
  for (const it of items) {
    const chars = [...it.str];
    if (!chars.some(isSmufl)) {
      out.push(it);
      continue;
    }
    // cada pedaço entre espaços vira um item, com x proporcional à posição
    let i = 0;
    for (const tok of it.str.split(/(\s+)/)) {
      const len = [...tok].length;
      if (tok.trim()) out.push({ str: tok, x: it.x + (it.w * i) / Math.max(1, chars.length), y: it.y, w: (it.w * len) / Math.max(1, chars.length), h: it.h });
      i += len;
    }
  }
  return out;
}

export const isSmufl = (ch: string) => {
  const c = ch.codePointAt(0)!;
  return c >= 0xe000 && c <= 0xf8ff;
};

const HEADS: Record<number, number> = { 0xe0a0: 8, 0xe0a2: 4, 0xe0a3: 2, 0xe0a4: 1 };
const RESTS: Record<number, number> = { 0xe4e1: 16, 0xe4e2: 8, 0xe4e3: 4, 0xe4e4: 2, 0xe4e5: 1, 0xe4e6: 0.5, 0xe4e7: 0.25, 0xe4e8: 0.125, 0xe4e9: 0.0625 };
/** Bandeirolas: quantas divisões por 2 a nota preta tem. */
const FLAGS: Record<number, number> = { 0xe240: 1, 0xe241: 1, 0xe242: 2, 0xe243: 2, 0xe244: 3, 0xe245: 3, 0xe246: 4, 0xe247: 4 };
const CLEFS: Record<number, 'G' | 'F' | 'C'> = { 0xe050: 'G', 0xe052: 'G', 0xe053: 'G', 0xe062: 'F', 0xe05c: 'C' };
const DOT = 0xe1e7;
const SHARP = 0xe262;
const FLAT = 0xe260;
const NATURAL = 0xe261;
const TUPLET_DIGIT = (c: number) => c >= 0xe880 && c <= 0xe889;

export interface StaffBand {
  lines: number[];
  space: number;
}

export interface GlyphEvent {
  x: number;
  kind: 'note' | 'rest';
  /** Duração em semínimas; null quando não dá para saber (nota preta com viga). */
  quarters: number | null;
  /** Nota preta sem bandeirola: semínima ou menor (depende das vigas). */
  blackGuess: boolean;
  /** Ex.: "Ré4", "Sol4+Si4" (acorde) ou "pausa ♩". */
  label: string;
}

export interface StaffContent {
  clef: 'G' | 'F' | 'C' | null;
  /** Armadura: + sustenidos, − bemóis. */
  fifths: number;
  events: GlyphEvent[];
  tuplets: number;
}

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const PT: Record<string, string> = { C: 'Dó', D: 'Ré', E: 'Mi', F: 'Fá', G: 'Sol', A: 'Lá', B: 'Si' };
/** Grau diatônico da linha de baixo de cada clave (C0 = 0). */
const BOTTOM_LINE: Record<'G' | 'F' | 'C', number> = { G: 4 * 7 + 2, F: 2 * 7 + 4, C: 3 * 7 + 3 };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = [...SHARP_ORDER].reverse();

/** Nome da nota pela posição na pauta, clave e armadura. */
export function pitchName(step: number, clef: 'G' | 'F' | 'C', fifths: number, accidental: number | null): string {
  const d = BOTTOM_LINE[clef] + step;
  const letter = LETTERS[((d % 7) + 7) % 7];
  const octave = Math.floor(d / 7);
  let alter = 0;
  if (fifths > 0 && SHARP_ORDER.slice(0, fifths).includes(letter)) alter = 1;
  if (fifths < 0 && FLAT_ORDER.slice(0, -fifths).includes(letter)) alter = -1;
  if (accidental !== null) alter = accidental;
  return `${PT[letter]}${alter > 0 ? '♯' : alter < 0 ? '♭' : ''}${octave}`;
}

const REST_NAMES: Record<string, string> = { '16': 'pausa longa', '8': 'pausa breve', '4': 'pausa de semibreve', '2': 'pausa de mínima', '1': 'pausa de semínima', '0.5': 'pausa de colcheia', '0.25': 'pausa de semicolcheia', '0.125': 'pausa de fusa', '0.0625': 'pausa de semifusa' };

/**
 * Notas e pausas de uma pauta entre x0 e x1. clef/fifths vêm do começo do
 * sistema (o primeiro compasso de cada linha traz clave e armadura).
 */
export function readStaff(
  glyphs: TextItem[],
  staff: StaffBand,
  x0: number,
  x1: number,
  carry: { clef: StaffContent['clef']; fifths: number },
  /** Outras pautas do sistema: cada símbolo fica com a pauta mais perto. */
  system: StaffBand[] = [staff],
): StaffContent {
  const s = staff.space;
  const mid = (b: StaffBand) => (b.lines[0] + b.lines[4]) / 2;
  const nearest = (y: number) => system.reduce((best, b) => (Math.abs(mid(b) - y) < Math.abs(mid(best) - y) ? b : best), staff);
  const near = glyphs.filter((g) => g.x >= x0 - 2 && g.x < x1 && g.y > staff.lines[0] - s * 6 && g.y < staff.lines[4] + s * 6 && nearest(g.y) === staff);
  let clef = carry.clef;
  let fifths = carry.fifths;
  const heads: Array<{ x: number; y: number; q: number; dots: number }> = [];
  const rests: Array<{ x: number; q: number; dots: number }> = [];
  const flags: Array<{ x: number; n: number }> = [];
  const accs: Array<{ x: number; y: number; alter: number }> = [];
  let tuplets = 0;
  let keyAccs: number[] = [];
  let seenNoteOrTs = false;
  for (const g of near.sort((a, b) => a.x - b.x)) {
    const cps = [...g.str].map((c) => c.codePointAt(0)!);
    const dots = cps.filter((c) => c === DOT).length;
    for (const c of cps) {
      // o glifo pode estar na pauta de baixo do sistema: só conta o que está nesta
      const inBand = g.y > staff.lines[0] - s * 4.5 && g.y < staff.lines[4] + s * 4.5;
      if (!inBand) continue;
      if (CLEFS[c]) clef = CLEFS[c];
      else if (HEADS[c]) {
        heads.push({ x: g.x, y: g.y, q: HEADS[c], dots });
        seenNoteOrTs = true;
      } else if (RESTS[c]) {
        rests.push({ x: g.x, q: RESTS[c], dots });
        seenNoteOrTs = true;
      } else if (FLAGS[c]) flags.push({ x: g.x, n: FLAGS[c] });
      else if (TUPLET_DIGIT(c)) tuplets++;
      else if (c >= 0xe080 && c <= 0xe08b) seenNoteOrTs = true;
      else if (c === SHARP || c === FLAT || c === NATURAL) {
        const alter = c === SHARP ? 1 : c === FLAT ? -1 : 0;
        // antes da primeira nota e da fórmula: armadura
        if (!seenNoteOrTs && clef && heads.length === 0) keyAccs.push(alter);
        else accs.push({ x: g.x, y: g.y, alter });
      }
    }
  }
  if (keyAccs.length) {
    const n = keyAccs.filter((a) => a !== 0).length;
    fifths = keyAccs.every((a) => a > 0) ? n : keyAccs.every((a) => a < 0) ? -n : fifths;
    keyAccs = [];
  }
  // cabeças no mesmo x formam um acorde
  heads.sort((a, b) => a.x - b.x || b.y - a.y);
  const chords: Array<typeof heads> = [];
  for (const h of heads) {
    const c = chords[chords.length - 1];
    if (c && Math.abs(c[0].x - h.x) <= s * 0.9) c.push(h);
    else chords.push([h]);
  }
  const events: GlyphEvent[] = [];
  for (const c of chords) {
    const q = Math.max(...c.map((h) => h.q));
    const dots = Math.max(...c.map((h) => h.dots));
    const flag = flags.find((f) => f.x > c[0].x - s * 0.5 && f.x < c[0].x + s * 2.5);
    const names = c.map((h) => {
      const step = Math.round(((staff.lines[4] - h.y) / s) * 2);
      const acc = accs.find((a) => a.x < h.x && h.x - a.x < s * 2.5 && Math.abs(a.y - h.y) < s * 0.3);
      return clef ? pitchName(step, clef, fifths, acc ? acc.alter : null) : `pos. ${step}`;
    });
    const black = q === 1;
    let quarters: number | null = q * (dots ? 2 - 0.5 ** dots : 1);
    if (black && flag) quarters = (dots ? 2 - 0.5 ** dots : 1) / 2 ** flag.n;
    const blackGuess = black && !flag;
    events.push({ x: c[0].x, kind: 'note', quarters: blackGuess ? quarters : quarters, blackGuess, label: names.reverse().join('+') });
  }
  for (const r of rests) {
    events.push({ x: r.x, kind: 'rest', quarters: r.q * (r.dots ? 2 - 0.5 ** r.dots : 1), blackGuess: false, label: REST_NAMES[String(r.q)] ?? 'pausa' });
  }
  events.sort((a, b) => a.x - b.x);
  return { clef, fifths, events, tuplets };
}

export interface MeasureReading {
  /** Notas e pausas da pauta de cima (resumo para mostrar). */
  events: GlyphEvent[];
  /** Duração lida, em semínimas, ou o máximo possível se houver notas pretas sem bandeirola. */
  quarters: number;
  /** A duração é exata (não há nota preta que possa ser colcheia com viga). */
  exact: boolean;
  notes: number;
  rests: number;
  tuplets: number;
  /** Só uma pausa de semibreve: compasso inteiro de pausa (vale qualquer fórmula). */
  fullRest: boolean;
}

/** Junta as pautas de um compasso: a duração vale pela pauta mais confiável. */
export function summarize(staves: StaffContent[]): MeasureReading | null {
  const withEvents = staves.filter((s) => s.events.length);
  if (!withEvents.length) return null;
  const dur = (c: StaffContent) => c.events.reduce((a, e) => a + (e.quarters ?? 0), 0);
  const exact = (c: StaffContent) => c.events.every((e) => !e.blackGuess) && !c.tuplets;
  // prefere a pauta com duração exata; senão a de cima
  const isFullRest = (c: StaffContent) => c.events.length === 1 && c.events[0].kind === 'rest' && c.events[0].quarters === 4;
  const real = withEvents.filter((c) => !isFullRest(c));
  const best = real.find(exact) ?? real[0] ?? withEvents[0];
  return {
    fullRest: !real.length,
    events: withEvents[0].events,
    quarters: dur(best),
    exact: exact(best),
    notes: staves.reduce((a, s) => a + s.events.filter((e) => e.kind === 'note').length, 0),
    rests: staves.reduce((a, s) => a + s.events.filter((e) => e.kind === 'rest').length, 0),
    tuplets: staves.reduce((a, s) => a + s.tuplets, 0),
  };
}
