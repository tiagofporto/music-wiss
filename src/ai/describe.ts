import { Fraction } from '../model/fraction';
import { DURATION_NAMES_PT } from '../model/duration';
import { keyName } from '../model/key';
import type { Pitch } from '../model/pitch';
import type { Score } from '../model/score';
import { effectiveKey, effectiveTimeSignature, measureCapacity } from '../model/score';
import { readLogical } from '../model/sequence';

const ACC: Record<number, string> = { [-2]: 'bb', [-1]: 'b', 0: '', 1: '#', 2: '##' };
const pitchText = (p: Pitch) => `${p.step}${ACC[p.alter]}${p.octave}`;

/**
 * Texto compacto da partitura para o assistente: cabeçalho, a voz escolhida com
 * cada evento numerado (#n = índice lógico, o mesmo usado pelo editor) e, como
 * contexto, as outras pautas do mesmo jeito (sem números).
 */
export function describeForAssistant(score: Score, target: { partIndex: number; staffIndex: number; voiceIndex: number }): string {
  const lines: string[] = [];
  lines.push(`Título: ${score.title}`);
  lines.push(`Andamento: semínima = ${score.tempo}`);
  const ts0 = effectiveTimeSignature(score, 0);
  lines.push(`Compasso inicial: ${ts0.beats}/${ts0.beatType}; tonalidade: ${keyName(effectiveKey(score, 0))} (${score.keyFifths} na armadura)`);
  for (const c of score.changes ?? []) {
    lines.push(`Mudança no compasso ${c.measure + 1}: ${c.timeSignature ? `${c.timeSignature.beats}/${c.timeSignature.beatType} ` : ''}${c.keyFifths !== undefined ? keyName(c.keyFifths) : ''}`);
  }
  score.parts.forEach((part, pi) => {
    part.staves.forEach((staff, si) => {
      for (let v = 0; v < 4; v++) {
        const events = readLogical(staff, v);
        if (!events.some((e) => e.kind === 'chord')) continue;
        const isTarget = pi === target.partIndex && si === target.staffIndex && v === target.voiceIndex;
        lines.push('');
        lines.push(`${isTarget ? '>>> VOZ ALVO: ' : ''}${part.name}${part.staves.length > 1 ? ` pauta ${si + 1}` : ''} voz ${v + 1} (clave ${staff.clef}${part.transposition ? `, soa ${part.transposition} semitons do escrito` : ''})`);
        let t = Fraction.ZERO;
        let mi = 0;
        let mStart = Fraction.ZERO;
        let row: string[] = [];
        const flush = () => {
          if (row.length) lines.push(`c${mi + 1}: ${row.join(' | ')}`);
          row = [];
        };
        events.forEach((e, i) => {
          while (t.gte(mStart.add(measureCapacity(effectiveTimeSignature(score, mi))))) {
            flush();
            mStart = mStart.add(measureCapacity(effectiveTimeSignature(score, mi)));
            mi++;
          }
          const what = e.kind === 'rest' ? 'pausa' : e.notes.map((n) => pitchText(n.pitch)).join('+');
          const fig = `${DURATION_NAMES_PT[e.duration.type]}${e.duration.dots ? ' pontuada' : ''}${e.tuplet ? ` (${e.tuplet.actual}:${e.tuplet.normal})` : ''}`;
          const extra = e.marks?.chordSymbol ? ` [cifra ${e.marks.chordSymbol}]` : '';
          row.push(`${isTarget ? `#${i} ` : ''}${what} ${fig}${extra}`);
          t = t.add(e.length);
        });
        flush();
      }
    });
  });
  return lines.join('\n');
}
