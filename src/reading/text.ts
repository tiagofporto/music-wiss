/**
 * Texto de PDFs digitais: andamentos ("♩ = 92", "Allegro", "rit.", "a tempo")
 * e fórmulas de compasso escritas como texto (fontes musicais SMuFL ou
 * números). PDF escaneado não tem texto: nesse caso nada daqui é usado e a
 * pessoa informa os valores na revisão.
 */

export interface TextItem {
  str: string;
  /** Canto esquerdo da linha de base, em pixels da imagem da página (y para baixo). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TempoKind = 'set' | 'word' | 'gradual' | 'return' | 'fermata' | 'rubato';

export interface TempoText {
  kind: TempoKind;
  /** Semínimas por minuto (null quando não dá para saber o valor). */
  bpm: number | null;
  /** O que estava escrito, para mostrar na revisão. */
  label: string;
  x: number;
  y: number;
  confidence: number;
}

/** Figuras do sinal de metrônomo, em semínimas. */
const NOTE_UNITS: Array<[RegExp, number]> = [
  [/[\u{1D15D}]|semibreve|whole/iu, 4],
  [/[\u{1D15E}\u{1D157}]|(?<!se)m[ií]nima|half/iu, 2],
  [/[\u{1D160}\u{1D16E}♪]|colcheia|eighth/iu, 0.5],
  [/[\u{1D15F}\u{1D158}♩]|sem[ií]nima|quarter|\bq\b/iu, 1],
];

/** Termos de andamento com um valor típico (só uma estimativa). */
export const TEMPO_WORDS: Array<[RegExp, number, string]> = [
  [/\bgrave\b/i, 40, 'Grave'],
  [/\blargo\b/i, 50, 'Largo'],
  [/\blarghetto\b/i, 63, 'Larghetto'],
  [/\blento\b/i, 56, 'Lento'],
  [/\badagio\b/i, 70, 'Adagio'],
  [/\bandantino\b/i, 92, 'Andantino'],
  [/\bandante\b/i, 84, 'Andante'],
  [/\bmoderato\b/i, 108, 'Moderato'],
  [/\ballegretto\b/i, 116, 'Allegretto'],
  [/\ballegro\b/i, 132, 'Allegro'],
  [/\bvivace\b/i, 160, 'Vivace'],
  [/\bpresto\b/i, 180, 'Presto'],
  [/\bprestissimo\b/i, 200, 'Prestissimo'],
];

const GRADUAL = /\b(rit\.?|ritard\.?|ritardando|rall\.?|rallentando|accel\.?|accelerando|stringendo|allargando|calando|morendo|smorzando)(?=\s|$|\.)/i;
const RETURN = /\b(a\s+tempo|tempo\s+(i|1|primo)|tempo\s+primo)\b/i;
const RUBATO = /\brubato\b|\bad\s+lib(itum)?\.?|\bcolla\s+voce\b|\bsenza\s+(tempo|misura)\b/i;
const FERMATA = /[\u{1D110}-]/u;

/** Junta pedaços de texto da mesma linha (o pdf.js separa "♩" de "= 92"). */
export function joinLines(items: TextItem[]): TextItem[] {
  const sorted = items.filter((i) => i.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: TextItem[][] = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l[0].y - it.y) <= Math.max(l[0].h, it.h) * 0.6 && it.x - (l[l.length - 1].x + l[l.length - 1].w) < Math.max(it.h, 8) * 3);
    if (line) line.push(it);
    else lines.push([it]);
  }
  return lines.map((l) => {
    l.sort((a, b) => a.x - b.x);
    const last = l[l.length - 1];
    return {
      str: l.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim(),
      x: l[0].x,
      y: Math.max(...l.map((i) => i.y)),
      w: last.x + last.w - l[0].x,
      h: Math.max(...l.map((i) => i.h)),
    };
  });
}

/** Lê "♩ = 92", "♩. = 60", "Semínima = 120", "q = c. 80" (o valor fica em semínimas por minuto). */
export function parseMetronomeMark(str: string): { bpm: number; label: string } | null {
  const m = /(.{0,24}?)\s*=\s*(?:c(?:a|irca)?\.?\s*)?(\d{2,3})(?:\s*[-–]\s*(\d{2,3}))?/iu.exec(str);
  if (!m) return null;
  const before = m[1];
  const unit = NOTE_UNITS.find(([re]) => re.test(before));
  if (!unit) return null;
  // ponto de aumento logo depois da figura
  const dotted = /[.·]\s*$/u.test(before.replace(/\s+$/, '')) && !/\b(c|ca)\.$/i.test(before.trim());
  const value = m[3] ? (Number(m[2]) + Number(m[3])) / 2 : Number(m[2]);
  const bpm = Math.round(value * unit[1] * (dotted ? 1.5 : 1));
  if (bpm < 20 || bpm > 400) return null;
  return { bpm, label: m[0].trim() };
}

/** Andamentos escritos na página, de cima para baixo. */
export function parseTempoMarks(items: TextItem[]): TempoText[] {
  const out: TempoText[] = [];
  for (const line of joinLines(items)) {
    const s = line.str;
    const at = { x: line.x, y: line.y };
    const mark = parseMetronomeMark(s);
    if (mark) {
      out.push({ kind: 'set', bpm: mark.bpm, label: s.length <= 40 ? s : mark.label, ...at, confidence: 0.9 });
      continue;
    }
    if (RETURN.test(s)) {
      out.push({ kind: 'return', bpm: null, label: RETURN.exec(s)![0], ...at, confidence: 0.7 });
      continue;
    }
    if (GRADUAL.test(s)) {
      out.push({ kind: 'gradual', bpm: null, label: GRADUAL.exec(s)![0], ...at, confidence: 0.8 });
      continue;
    }
    if (RUBATO.test(s)) {
      out.push({ kind: 'rubato', bpm: null, label: RUBATO.exec(s)![0], ...at, confidence: 0.8 });
      continue;
    }
    // palavra só vale como andamento em texto curto (não no meio da letra da música)
    const word = s.length <= 40 ? TEMPO_WORDS.find(([re]) => re.test(s)) : undefined;
    if (word) {
      out.push({ kind: 'word', bpm: word[1], label: s, ...at, confidence: 0.35 });
      continue;
    }
    if (FERMATA.test(s)) out.push({ kind: 'fermata', bpm: null, label: 'fermata', ...at, confidence: 0.8 });
  }
  return out;
}

export interface TimeSigText {
  beats: number;
  beatType: number;
  x: number;
  /** y do meio da pauta onde está. */
  y: number;
  label: string;
}

/** Número em dígitos SMuFL (U+E080–E089) ou comuns. */
function digits(str: string): number | null {
  const t = str.replace(/\s+/g, '');
  if (!t) return null;
  let n = '';
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if (c >= 0xe080 && c <= 0xe089) n += String(c - 0xe080);
    else if (ch >= '0' && ch <= '9') n += ch;
    else return null;
  }
  return n.length <= 2 ? Number(n) : null;
}

/**
 * Fórmulas de compasso escritas como texto: dois números empilhados dentro
 * da pauta (em cima: tempos; embaixo: figura), ou os sinais C e C cortado.
 */
export function parseTimeSignatures(items: TextItem[], staves: Array<{ lines: number[]; space: number }>): TimeSigText[] {
  const out: TimeSigText[] = [];
  // centro vertical: glifo SMuFL fica centrado na linha de base; número comum fica acima dela
  const cy = (i: TextItem) => ([...i.str].some((c) => c.codePointAt(0)! >= 0xe000) ? i.y : i.y - i.h * 0.35);
  for (const st of staves) {
    const s = st.space;
    const mid = st.lines[2];
    const inside = items.filter((i) => cy(i) > st.lines[0] - s * 1.6 && cy(i) < st.lines[4] + s * 1.6);
    const used = new Set<TextItem>();
    for (const it of inside) {
      const c = it.str.trim();
      if (c === '\uE08A' || c === '\uE08B') {
        out.push({ beats: c === '\uE08A' ? 4 : 2, beatType: c === '\uE08A' ? 4 : 2, x: it.x, y: mid, label: c === '\uE08A' ? 'C' : '¢' });
        continue;
      }
      const n = digits(it.str);
      if (n === null || used.has(it)) continue;
      // o de baixo: mesmo x, entre 1,5 e 3,5 espaços abaixo
      const below = inside.find((o) => o !== it && !used.has(o) && Math.abs(o.x - it.x) < s * 3 && cy(o) - cy(it) > s * 1.2 && cy(o) - cy(it) < s * 3.6 && digits(o.str) !== null);
      if (!below) continue;
      const d = digits(below.str)!;
      if (n < 1 || n > 16 || ![1, 2, 4, 8, 16, 32].includes(d)) continue;
      used.add(it).add(below);
      out.push({ beats: n, beatType: d, x: Math.min(it.x, below.x), y: mid, label: `${n}/${d}` });
    }
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}
