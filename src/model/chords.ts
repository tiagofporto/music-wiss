import type { Alter, Step } from './pitch';

/**
 * Cifras: texto livre como o músico escreve ("Am7", "F#m7b5", "G/B", "Bbmaj7"),
 * interpretado só para exportar (MusicXML <harmony>) e para mostrar ♭/♯.
 */
export interface ParsedChord {
  root: { step: Step; alter: Alter };
  /** o que vem depois da fundamental, como escrito ("m7", "maj7", "") */
  suffix: string;
  /** valor do elemento <kind> do MusicXML */
  kind: string;
  bass?: { step: Step; alter: Alter };
}

/** sufixo → <kind> do MusicXML (o sufixo original vai no atributo text) */
const KINDS: Array<[RegExp, string]> = [
  [/^$/, 'major'],
  [/^(maj|M|Δ)$/, 'major'],
  [/^(m|min|-)$/, 'minor'],
  [/^(aug|\+|\+5)$/, 'augmented'],
  [/^(dim|°|o)$/, 'diminished'],
  [/^7$/, 'dominant'],
  [/^(maj7|M7|Δ7|Δ)$/, 'major-seventh'],
  [/^(m7|min7|-7)$/, 'minor-seventh'],
  [/^(dim7|°7|o7)$/, 'diminished-seventh'],
  [/^(m7b5|m7\(b5\)|ø|ø7)$/, 'half-diminished'],
  [/^(aug7|\+7|7#5|7\(#5\))$/, 'augmented-seventh'],
  [/^(m\(maj7\)|mmaj7|mM7|m\(M7\))$/, 'major-minor'],
  [/^6$/, 'major-sixth'],
  [/^(m6|min6)$/, 'minor-sixth'],
  [/^9$/, 'dominant-ninth'],
  [/^(maj9|M9)$/, 'major-ninth'],
  [/^(m9|min9)$/, 'minor-ninth'],
  [/^11$/, 'dominant-11th'],
  [/^(m11|min11)$/, 'minor-11th'],
  [/^13$/, 'dominant-13th'],
  [/^(maj13|M13)$/, 'major-13th'],
  [/^(m13|min13)$/, 'minor-13th'],
  [/^sus2$/, 'suspended-second'],
  [/^(sus|sus4)$/, 'suspended-fourth'],
  [/^5$/, 'power'],
];

const NOTE = /^([A-Ga-g])(##|#|♯|bb|b|♭|x)?/;

function readNote(s: string): { note: { step: Step; alter: Alter }; rest: string } | null {
  const m = NOTE.exec(s);
  if (!m) return null;
  const acc = m[2] ?? '';
  const alter = (acc === '#' || acc === '♯' ? 1 : acc === '##' || acc === 'x' ? 2 : acc === 'b' || acc === '♭' ? -1 : acc === 'bb' ? -2 : 0) as Alter;
  return { note: { step: m[1].toUpperCase() as Step, alter }, rest: s.slice(m[0].length) };
}

export function parseChordSymbol(text: string): ParsedChord | null {
  const t = text.trim();
  const head = readNote(t);
  if (!head) return null;
  let suffix = head.rest;
  let bass: ParsedChord['bass'];
  const slash = suffix.lastIndexOf('/');
  if (slash >= 0) {
    const b = readNote(suffix.slice(slash + 1));
    if (b && !b.rest) {
      bass = b.note;
      suffix = suffix.slice(0, slash);
    }
  }
  const kind = KINDS.find(([re]) => re.test(suffix))?.[1] ?? 'other';
  return { root: head.note, suffix, kind, ...(bass ? { bass } : {}) };
}

/** Sufixo padrão para cada <kind> (quando o arquivo não traz o texto). */
const KIND_TEXT: Record<string, string> = {
  major: '', minor: 'm', augmented: '+', diminished: 'dim', dominant: '7', 'major-seventh': 'maj7',
  'minor-seventh': 'm7', 'diminished-seventh': 'dim7', 'augmented-seventh': '+7', 'half-diminished': 'm7b5',
  'major-minor': 'm(maj7)', 'major-sixth': '6', 'minor-sixth': 'm6', 'dominant-ninth': '9', 'major-ninth': 'maj9',
  'minor-ninth': 'm9', 'dominant-11th': '11', 'minor-11th': 'm11', 'dominant-13th': '13', 'major-13th': 'maj13',
  'minor-13th': 'm13', 'suspended-second': 'sus2', 'suspended-fourth': 'sus4', power: '5', none: 'N.C.',
};

const ACC: Record<number, string> = { [-2]: 'bb', [-1]: 'b', 0: '', 1: '#', 2: '##' };

/** Monta o texto da cifra a partir das partes do MusicXML. */
export function chordText(root: { step: string; alter: number }, kind: string, kindText: string | null, bass?: { step: string; alter: number }): string {
  const suffix = kindText ?? KIND_TEXT[kind] ?? '';
  return `${root.step}${ACC[root.alter] ?? ''}${suffix}${bass ? `/${bass.step}${ACC[bass.alter] ?? ''}` : ''}`;
}

/** Texto para mostrar: b/# viram ♭/♯ nas notas (não mexe em "b5" do sufixo? mexe: "m7♭5" é a grafia usual). */
export function displayChord(text: string): string {
  return text.replace(/([A-G])bb/g, '$1𝄫').replace(/([A-G])b/g, '$1♭').replace(/#/g, '♯').replace(/b(\d)/g, '♭$1');
}
