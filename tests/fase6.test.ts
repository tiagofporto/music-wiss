// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { perform } from '../src/audio/sequencer';
import { Editor } from '../src/editor/editor';
import { exportMidi } from '../src/io/midi';
import { importMidi, parseMidi } from '../src/io/midi-import';
import { createScore } from '../src/model/score';
import type { Step } from '../src/model/pitch';
import { pitch } from '../src/model/pitch';
import { readLogical } from '../src/model/sequence';
import type { Annotation } from '../src/annotate/annotations';
import { annotationsSvg, hits, pathData, sanitizeAnnotations, simplify } from '../src/annotate/annotations';
import type { Transcription } from '../src/ai/transcription';
import { parseVoice, transcriptionToScore } from '../src/ai/transcription';

function song(): Editor {
  const ed = new Editor(createScore({ instrumentId: 'flute', keyFifths: 1, timeSignature: { beats: 3, beatType: 4 }, tempo: 84 }));
  ed.toggleInputMode(true);
  ed.setDuration('quarter');
  for (const s of ['G', 'A', 'B'] as Step[]) ed.insertStep(s);
  ed.setDuration('half');
  ed.toggleDot();
  ed.insertStep('F'); // Fá# na armadura de Sol
  ed.toggleDot();
  ed.setDuration('eighth');
  for (const s of ['E', 'D', 'C', 'B', 'A', 'G'] as Step[]) ed.insertStep(s);
  return ed;
}

describe('importar MIDI', () => {
  it('lê cabeçalho, andamento, compasso e tonalidade', () => {
    const f = parseMidi(exportMidi(song().score));
    expect(f.tempos[0].value).toBeCloseTo(84);
    expect(f.timeSignatures[0].value).toEqual({ beats: 3, beatType: 4 });
    expect(f.keys[0].value).toBe(1);
    expect(f.tracks[0].notes).toHaveLength(10);
  });

  it('ida e volta: as mesmas notas, figuras e escrita', () => {
    const ed = song();
    const { score, warnings } = importMidi(exportMidi(ed.score), 'Teste');
    expect(warnings).toEqual([]);
    expect(score.tempo).toBe(84);
    expect(score.keyFifths).toBe(1);
    expect(score.parts[0].instrument).toBe('flute');
    const sig = (s: typeof score) => readLogical(s.parts[0].staves[0]).map((e) => `${e.notes.map((n) => n.pitch.step + n.pitch.alter + n.pitch.octave).join('+') || 'r'}:${e.length.toString()}`);
    expect(sig(score)).toEqual(sig(ed.score));
    expect(perform(score).notes.map((n) => n.midi)).toEqual(perform(ed.score).notes.map((n) => n.midi));
  });

  it('piano vai para duas pautas e acordes ficam juntos', () => {
    const ed = new Editor(createScore({ instrumentId: 'piano' }));
    ed.toggleInputMode(true);
    ed.setDuration('half');
    ed.insertChord([pitch('C', 4), pitch('E', 4), pitch('G', 4)]);
    const { score } = importMidi(exportMidi(ed.score));
    expect(score.parts[0].staves.map((s) => s.clef)).toEqual(['treble', 'bass']);
    const top = readLogical(score.parts[0].staves[0]);
    expect(top[0].notes.map((n) => n.pitch.step)).toEqual(['C', 'E', 'G']);
    expect(top[0].length.toString()).toBe('1/2');
  });

  it('recusa o que não é MIDI', () => {
    expect(() => importMidi(new TextEncoder().encode('não sou midi nenhum'))).toThrow(/MIDI/);
  });
});

describe('marcações', () => {
  it('simplifica traços retos sem perder as pontas', () => {
    const pts: number[] = [];
    for (let i = 0; i <= 50; i++) pts.push(i / 100, 0.2 + i / 1000);
    const out = simplify(pts);
    expect(out.length).toBe(4);
    expect(out.slice(0, 2)).toEqual([0, 0.2]);
    expect(out.slice(2)).toEqual([0.5, 0.25]);
  });

  it('a borracha acha traço e texto perto do ponto', () => {
    const pen: Annotation = { kind: 'pen', color: '#e4572e', width: 0.003, points: [0.1, 0.1, 0.5, 0.1] };
    const txt: Annotation = { kind: 'text', color: '#e4572e', x: 0.6, y: 0.3, size: 0.02, text: 'respira' };
    expect(hits(pen, 0.3, 0.105)).toBe(true);
    expect(hits(pen, 0.3, 0.2)).toBe(false);
    expect(hits(txt, 0.62, 0.29)).toBe(true);
    expect(hits(txt, 0.62, 0.4)).toBe(false);
  });

  it('desenha em escala e escapa o texto', () => {
    const svg = annotationsSvg([{ kind: 'text', color: '#000', x: 0.5, y: 0.5, size: 0.02, text: '<b>' }], 1000);
    expect(svg).toContain('x="500.0"');
    expect(svg).toContain('&lt;b&gt;');
    expect(pathData([0.1, 0.2, 0.3, 0.4], 100)).toBe('M10.0 20.0 L30.0 40.0');
  });

  it('descarta dados estranhos vindos de arquivo', () => {
    const list = sanitizeAnnotations([
      { kind: 'pen', color: 'javascript:alert(1)', width: 0.003, points: [0, 0, 1, 1] },
      { kind: 'text', text: '' },
      { kind: 'bomba' },
      'x',
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].color).toBe('#e4572e');
  });

  it('ficam na partitura e o Ctrl+Z desfaz', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    const mark: Annotation = { kind: 'pen', color: '#2e6fe4', width: 0.003, points: [0, 0, 0.1, 0.1] };
    ed.setAnnotations([mark]);
    expect(ed.score.annotations).toEqual([mark]);
    ed.undo();
    expect(ed.score.annotations).toBeUndefined();
  });
});

describe('transcrição da IA', () => {
  const base: Transcription = {
    summary: 'ok', title: 'Asa Branca', composer: 'Luiz Gonzaga', tempo: 100, beats: 2, beatType: 4, keyFifths: 0,
    parts: [], issues: [], suggestions: [],
  };

  it('lê notas, acordes, pontos, ligaduras, pausas e tercinas', () => {
    const { measures, bad } = parseVoice('C4/8 D4/8 E4/q | F#4/8. Bb3/16 C4+E4+G4/q~ | C4+E4+G4/q r/q | 3[C5/8 D5/8 E5/8] r/q | nada');
    expect(bad).toEqual(['nada']);
    expect(measures[1].map((e) => e.notes.map((n) => `${n.pitch.step}${n.pitch.alter}${n.pitch.octave}`).join('+'))).toEqual(['F14', 'B-13', 'C04+E04+G04']);
    expect(measures[1][0].duration).toEqual({ type: 'eighth', dots: 1 });
    expect(measures[1][2].notes.every((n) => n.tieToNext)).toBe(true);
    expect(measures[3][0].tuplet).toMatchObject({ actual: 3, normal: 2 });
    expect(measures[3][0].length.toString()).toBe('1/12');
  });

  it('monta a partitura, completa compasso curto e trata anacruse', () => {
    const { score, warnings } = transcriptionToScore({
      ...base,
      parts: [{ name: 'Voz', instrument: 'voice', staves: [{ clef: 'treble', voices: ['G4/8 A4/8 | B4/q B4/8 | C5/h'] }] }],
    });
    expect(score.title).toBe('Asa Branca');
    expect(score.timeSignature).toEqual({ beats: 2, beatType: 4 });
    const ev = readLogical(score.parts[0].staves[0]);
    // anacruse: pausa de semínima antes do G A
    expect(ev[0].kind).toBe('rest');
    expect(ev[0].length.toString()).toBe('1/4');
    expect(ev.filter((e) => e.kind === 'chord').map((e) => e.notes[0].pitch.step)).toEqual(['G', 'A', 'B', 'B', 'C']);
    expect(warnings.some((w) => /compasso 2/.test(w))).toBe(true);
    expect(perform(score).notes).toHaveLength(5);
  });

  it('piano com duas pautas e instrumento desconhecido', () => {
    const { score } = transcriptionToScore({
      ...base,
      parts: [{ name: 'Piano', instrument: 'xilofone', staves: [{ clef: 'treble', voices: ['C5/h'] }, { clef: 'bass', voices: ['C3/h', 'G2/h'] }] }],
    });
    expect(score.parts[0].instrument).toBe('piano');
    expect(score.parts[0].staves.map((s) => s.clef)).toEqual(['treble', 'bass']);
    expect(readLogical(score.parts[0].staves[1], 1)[0].notes[0].pitch).toMatchObject({ step: 'G', octave: 2 });
  });

  it('recusa transcrição vazia', () => {
    expect(() => transcriptionToScore(base)).toThrow(/vazia/);
  });
});
