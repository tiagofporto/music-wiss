import { Fraction } from '../model/fraction';
import type { DurationType } from '../model/duration';
import { decompose, durationValue } from '../model/duration';
import type { Fifths } from '../model/key';
import type { Alter, Clef, Pitch, Step } from '../model/pitch';
import type { Part, Score, TimeSignature } from '../model/score';
import { createPart, effectiveTimeSignature, emptyMeasure, INSTRUMENTS, measureCapacity, newId } from '../model/score';
import type { LogicalEvent } from '../model/sequence';
import { normalizeMeasures, writeLogical } from '../model/sequence';

/**
 * Transcrição feita pela IA a partir de um PDF ou foto, num formato de texto
 * simples que ela escreve bem e que aqui vira partitura editável.
 *
 * Cada voz é uma linha; compassos separados por "|"; eventos por espaço:
 *   C4/q       semínima Dó4          (w h q 8 16 32 = semibreve … fusa)
 *   F#4/8.     colcheia pontuada Fá#4 (# b ## bb; n = bequadro, só por clareza)
 *   C4+E4+G4/h acorde (mínima)
 *   r/q        pausa de semínima
 *   G4/h~      ligada à próxima
 *   3[C5/8 D5/8 E5/8]  tercina
 */

export interface TranscribedStaff {
  clef: Clef;
  voices: string[];
}

export interface TranscribedPart {
  name: string;
  instrument: string;
  staves: TranscribedStaff[];
}

export interface Transcription {
  summary: string;
  title: string;
  composer: string;
  tempo: number;
  beats: number;
  beatType: number;
  keyFifths: number;
  parts: TranscribedPart[];
  issues: Array<{ measure: number; message: string }>;
  suggestions: string[];
}

const DUR: Record<string, DurationType> = { w: 'whole', h: 'half', q: 'quarter', '8': 'eighth', '16': '16th', '32': '32nd' };
const ACC: Record<string, Alter> = { '': 0, n: 0, '#': 1, '##': 2, x: 2, b: -1, bb: -2 };
const NOTE_RE = /^([A-G])(##|#|x|bb|b|n)?(-?\d)$/;
const EVENT_RE = /^(r|[A-G](?:##|#|x|bb|b|n)?-?\d(?:\+[A-G](?:##|#|x|bb|b|n)?-?\d)*)\/(w|h|q|8|16|32)(\.{0,2})(~?)$/;

export function parsePitch(tok: string): Pitch | null {
  const m = NOTE_RE.exec(tok);
  if (!m) return null;
  return { step: m[1] as Step, alter: ACC[m[2] ?? ''], octave: Number(m[3]) };
}

/** Lê uma linha de voz. Tokens que não entende são pulados (e listados). */
export function parseVoice(line: string): { measures: LogicalEvent[][]; bad: string[] } {
  const bad: string[] = [];
  const measures: LogicalEvent[][] = [];
  for (const chunk of line.split('|')) {
    const events: LogicalEvent[] = [];
    // separa tercinas "3[ ... ]" como um bloco
    const tokens = chunk.match(/\d\[[^\]]*\]|\S+/g) ?? [];
    for (const tok of tokens) {
      const tup = /^(\d)\[([^\]]*)\]$/.exec(tok);
      if (tup) {
        const actual = Number(tup[1]);
        const normal = actual === 3 ? 2 : actual === 5 || actual === 6 ? 4 : actual === 2 ? 3 : 0;
        const inner = tup[2].trim().split(/\s+/).map(readEvent);
        if (!normal || inner.some((e) => !e)) {
          bad.push(tok);
          continue;
        }
        const tuplet = { id: newId('t'), actual, normal };
        for (const e of inner as LogicalEvent[]) {
          e.tuplet = { ...tuplet };
          e.length = durationValue(e.duration).mul(new Fraction(normal, actual));
          events.push(e);
        }
        continue;
      }
      const e = readEvent(tok);
      if (e) events.push(e);
      else bad.push(tok);
    }
    if (events.length || chunk.trim()) measures.push(events);
  }
  return { measures, bad };
}

function readEvent(tok: string): LogicalEvent | null {
  const m = EVENT_RE.exec(tok.trim());
  if (!m) return null;
  const duration = { type: DUR[m[2]], dots: m[3].length };
  const tie = m[4] === '~';
  if (m[1] === 'r') return { id: newId('r'), kind: 'rest', duration, length: durationValue(duration), notes: [] };
  const pitches = m[1].split('+').map(parsePitch);
  if (pitches.some((p) => !p)) return null;
  return {
    id: newId('e'),
    kind: 'chord',
    duration,
    length: durationValue(duration),
    notes: (pitches as Pitch[]).map((p) => ({ id: newId('n'), pitch: p, tieToNext: tie })),
  };
}

const sum = (events: LogicalEvent[]) => Fraction.sum(events.map((e) => e.length));

const rests = (len: Fraction): LogicalEvent[] =>
  decompose(len).map((d) => ({ id: newId('r'), kind: 'rest' as const, duration: d, length: durationValue(d), notes: [] }));

/** Monta a partitura. Compassos curtos são completados com pausas e avisados. */
export function transcriptionToScore(t: Transcription): { score: Score; warnings: string[] } {
  const warnings = new Set<string>();
  const ts: TimeSignature = {
    beats: clampInt(t.beats, 1, 16, 4),
    beatType: [1, 2, 4, 8, 16].includes(t.beatType) ? t.beatType : 4,
  };
  const score: Score = {
    id: newId('s'),
    title: (t.title || 'Partitura transcrita').slice(0, 200),
    composer: (t.composer || '').slice(0, 200),
    tempo: clampInt(t.tempo, 20, 300, 96),
    timeSignature: ts,
    keyFifths: clampInt(t.keyFifths, -7, 7, 0) as Fifths,
    changes: [],
    parts: [],
  };
  const cap = measureCapacity(effectiveTimeSignature(score, 0));
  for (const tp of t.parts ?? []) {
    const preset = INSTRUMENTS.find((i) => i.id === tp.instrument) ?? INSTRUMENTS.find((i) => (tp.staves?.length ?? 1) > 1 ? i.id === 'piano' : i.id === 'voice')!;
    const base = createPart(preset.id);
    const staves = (tp.staves ?? []).slice(0, 4);
    if (!staves.length) continue;
    const part: Part = {
      ...base,
      name: (tp.name || preset.name).slice(0, 80),
      staves: staves.map((s) => ({ id: newId('st'), clef: (['treble', 'bass', 'alto', 'tenor'] as Clef[]).includes(s.clef) ? s.clef : 'treble', measures: [emptyMeasure()] })),
    };
    score.parts.push(part);
    staves.forEach((st, si) => {
      (st.voices ?? []).slice(0, 4).forEach((line, vi) => {
        const { measures, bad } = parseVoice(line);
        if (bad.length) warnings.add(`Alguns trechos não puderam ser lidos (ex.: "${bad[0]}").`);
        const events: LogicalEvent[] = [];
        measures.forEach((m, mi) => {
          const len = sum(m);
          if (len.lt(cap)) {
            if (mi === 0 && measures.length > 1 && m.length) {
              // anacruse: as pausas vêm antes
              events.push(...rests(cap.sub(len)), ...m);
              return;
            }
            if (mi < measures.length - 1 || m.length) warnings.add(`Compassos incompletos foram completados com pausas (ex.: compasso ${mi + 1}).`);
            events.push(...m, ...(m.length || mi < measures.length - 1 ? rests(cap.sub(len)) : []));
          } else {
            if (len.gt(cap)) warnings.add(`Alguns compassos tinham tempo demais (ex.: compasso ${mi + 1}); confira.`);
            events.push(...m);
          }
        });
        // tira pausas sobrando do fim
        while (events.length && events[events.length - 1].kind === 'rest' && !events[events.length - 1].tuplet) events.pop();
        writeLogical(score, part.staves[si], events, vi);
      });
    });
  }
  if (!score.parts.length) throw new Error('A transcrição veio vazia');
  normalizeMeasures(score);
  return { score, warnings: [...warnings] };
}

function clampInt(n: unknown, lo: number, hi: number, d: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d;
}
