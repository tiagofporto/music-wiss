// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { collectNotes, perform, schedule } from '../src/audio/sequencer';
import { Editor } from '../src/editor/editor';
import { Fraction } from '../src/model/fraction';
import { exportMidi } from '../src/io/midi';
import { exportMusicXml } from '../src/io/musicxml-export';
import { importMusicXml } from '../src/io/musicxml-import';
import { chordText, displayChord, parseChordSymbol } from '../src/model/chords';
import type { Score } from '../src/model/score';
import { createScore, playOrder, setBarMark } from '../src/model/score';
import type { Step } from '../src/model/pitch';
import { readLogical } from '../src/model/sequence';

/** Partitura em 4/4 com uma semibreve por compasso: C, D, E, F... */
function wholes(steps: Step[]): Editor {
  const ed = new Editor(createScore({ instrumentId: 'flute' }));
  ed.toggleInputMode(true);
  ed.setDuration('whole');
  for (const s of steps) ed.insertStep(s);
  return ed;
}
const melody = (score: Score) => perform(score).notes.map((n) => n.midi);

describe('repetições', () => {
  it('sem marcas, toca em ordem', () => {
    const s = wholes(['C', 'D', 'E']).score;
    expect(playOrder(s, 3)).toEqual([0, 1, 2]);
  });

  it('|: A B :| C toca A B A B C', () => {
    const s = wholes(['C', 'D', 'E']).score;
    setBarMark(s, 0, { repeatStart: true });
    setBarMark(s, 1, { repeatEnd: true });
    expect(playOrder(s, 3)).toEqual([0, 1, 0, 1, 2]);
  });

  it('sem início de repetição, volta para o começo', () => {
    const s = wholes(['C', 'D', 'E']).score;
    setBarMark(s, 1, { repeatEnd: true });
    expect(playOrder(s, 3)).toEqual([0, 1, 0, 1, 2]);
  });

  it('casas de 1ª e 2ª vez', () => {
    const s = wholes(['C', 'D', 'E', 'F']).score;
    setBarMark(s, 1, { repeatEnd: true, ending: 1 });
    setBarMark(s, 2, { ending: 2 });
    expect(playOrder(s, 4)).toEqual([0, 1, 0, 2, 3]);
  });

  it('duas repetições seguidas', () => {
    const s = wholes(['C', 'D', 'E', 'F']).score;
    setBarMark(s, 0, { repeatEnd: true });
    setBarMark(s, 1, { repeatStart: true });
    setBarMark(s, 2, { repeatEnd: true });
    expect(playOrder(s, 4)).toEqual([0, 0, 1, 2, 1, 2, 3]);
  });

  it('a reprodução e o MIDI seguem as repetições', () => {
    const ed = wholes(['C', 'D', 'E']);
    setBarMark(ed.score, 1, { repeatEnd: true });
    expect(melody(ed.score)).toEqual([72, 74, 72, 74, 76]); // a 1ª nota fica perto da linha do meio (Dó5)
  });
});

describe('dinâmicas e articulações no som', () => {
  it('dinâmica vale dali para frente; sfz só na nota', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.toggleInputMode(true);
    for (const s of ['C', 'D', 'E', 'F'] as Step[]) ed.insertStep(s);
    ed.setCursor(1);
    ed.setDynamic('pp');
    ed.setCursor(3);
    ed.setDynamic('sfz');
    const v = collectNotes(ed.score).notes.map((n) => n.velocity);
    expect(v).toEqual([33, 33, 112, 33]);
  });

  it('staccato encurta e acento reforça', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.toggleInputMode(true);
    ed.insertStep('C');
    ed.toggleArticulation('staccato');
    ed.insertStep('D');
    ed.toggleArticulation('accent');
    const [a, b] = collectNotes(ed.score).notes;
    expect(a.gate).toBe(0.5);
    expect(b.velocity).toBe(80 + 18);
    // staccato e staccatissimo não ficam juntos
    ed.setCursor(1);
    ed.toggleArticulation('staccatissimo');
    expect(ed.events()[0].marks?.articulations).toEqual(['staccatissimo']);
    ed.toggleArticulation('staccatissimo');
    expect(ed.events()[0].marks).toBeUndefined();
  });

  it('schedule mostra o tempo escrito ao tocar a repetição', () => {
    const ed = wholes(['C', 'D']);
    setBarMark(ed.score, 1, { repeatEnd: true });
    const plan = schedule(ed.score);
    expect(plan.steps.map((s) => s.time)).toEqual([0, 1, 0, 1]);
    // começando do 2º compasso: toca D, depois C D da repetição
    expect(schedule(ed.score, new Fraction(1)).notes.map((n) => n.midi)).toEqual([74, 72, 74]);
  });
});

describe('marcas no modelo', () => {
  it('marcas ficam no começo de uma nota que cruza a barra', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.toggleInputMode(true);
    ed.setDuration('half');
    ed.toggleDot();
    ed.insertStep('C');
    ed.insertStep('D'); // mínima pontuada no 4º tempo: dividida na barra
    ed.toggleArticulation('tenuto');
    ed.setText('lyric', 1, 'lá');
    const staff = ed.score.parts[0].staves[0];
    const pieces = [...staff.measures[0].voices[0].events, ...staff.measures[1].voices[0].events].filter((e) => e.kind === 'chord');
    expect(pieces).toHaveLength(3);
    expect(pieces[1].marks).toEqual({ articulations: ['tenuto'], lyric: 'lá' });
    expect(pieces[2].marks).toBeUndefined();
    expect(readLogical(staff)[1].marks?.lyric).toBe('lá');
  });

  it('copiar e colar leva as marcas (sem compartilhar o objeto)', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.toggleInputMode(true);
    ed.insertStep('C');
    ed.setDynamic('f');
    ed.copy();
    ed.paste();
    ed.setCursor(2);
    ed.setDynamic('p');
    expect(ed.events().map((e) => e.marks?.dynamic)).toEqual(['f', 'p']);
  });

  it('marca de compasso some quando fica vazia', () => {
    const ed = wholes(['C', 'D']);
    ed.setCursor(1);
    ed.toggleBar('repeatEnd');
    expect(ed.score.bars).toEqual([{ measure: 0, repeatEnd: true }]);
    ed.toggleBar('repeatEnd');
    expect(ed.score.bars).toEqual([]);
    ed.undo();
    expect(ed.score.bars).toEqual([{ measure: 0, repeatEnd: true }]);
  });
});

describe('cifras', () => {
  it('interpreta fundamental, tipo e baixo', () => {
    expect(parseChordSymbol('Am7')).toEqual({ root: { step: 'A', alter: 0 }, suffix: 'm7', kind: 'minor-seventh' });
    expect(parseChordSymbol('Bbmaj7/D')).toMatchObject({ root: { step: 'B', alter: -1 }, kind: 'major-seventh', bass: { step: 'D', alter: 0 } });
    expect(parseChordSymbol('F#m7b5')?.kind).toBe('half-diminished');
    expect(parseChordSymbol('C7(#9)')?.kind).toBe('other');
    expect(parseChordSymbol('xyz')).toBeNull();
  });
  it('monta o texto a partir do MusicXML e mostra ♭/♯', () => {
    expect(chordText({ step: 'E', alter: -1 }, 'minor-seventh', null)).toBe('Ebm7');
    expect(chordText({ step: 'G', alter: 0 }, 'major', '', { step: 'B', alter: 0 })).toBe('G/B');
    expect(displayChord('Bbm7b5')).toBe('B♭m7♭5');
    expect(displayChord('F#7')).toBe('F♯7');
  });
});

describe('MusicXML e MIDI com expressão', () => {
  function rich(): Editor {
    const ed = new Editor(createScore({ instrumentId: 'voice', timeSignature: { beats: 2, beatType: 4 } }));
    ed.toggleInputMode(true);
    ed.setDuration('quarter');
    for (const s of ['C', 'D', 'E', 'F', 'G', 'A'] as Step[]) ed.insertStep(s);
    ed.setCursor(1);
    ed.setDynamic('mp');
    ed.toggleArticulation('staccato');
    ed.setText('lyric', 0, 'A-');
    ed.setText('lyric', 1, 'mor');
    ed.setText('chordSymbol', 0, 'Bbmaj7/D');
    ed.setText('chordSymbol', 2, 'F#m7b5');
    ed.setCursor(3);
    ed.toggleArticulation('fermata');
    ed.toggleArticulation('marcato');
    ed.toggleBar('repeatStart'); // compasso 2
    ed.setCursor(4);
    ed.toggleBar('repeatEnd');
    ed.toggleBar('ending1');
    ed.setCursor(6);
    ed.toggleBar('ending2');
    return ed;
  }

  it('exporta dinâmica, articulações, letra, cifra, repetições e casas', () => {
    const xml = exportMusicXml(rich().score);
    expect(xml).toContain('<dynamics><mp/></dynamics>');
    expect(xml).toContain('<articulations><staccato/></articulations>');
    expect(xml).toContain('<strong-accent type="up"/>');
    expect(xml).toContain('<fermata type="upright"/>');
    expect(xml).toContain('<lyric number="1"><syllabic>begin</syllabic><text>A</text></lyric>');
    expect(xml).toContain('<syllabic>end</syllabic><text>mor</text>');
    expect(xml).toContain('<root-step>B</root-step><root-alter>-1</root-alter></root><kind text="maj7">major-seventh</kind><bass><bass-step>D</bass-step></bass>');
    expect(xml).toContain('<repeat direction="forward"/>');
    expect(xml).toContain('<ending number="1" type="start">1.</ending>');
    expect(xml).toContain('<repeat direction="backward"/>');
    expect(xml).toContain('<ending number="2" type="start">2.</ending>');
  });

  it('ida e volta pelo MusicXML preserva tudo', () => {
    const ed = rich();
    const { score, warnings } = importMusicXml(exportMusicXml(ed.score));
    expect(warnings).toEqual([]);
    const marks = (s: Score) => readLogical(s.parts[0].staves[0]).map((e) => e.marks ?? null);
    expect(marks(score)).toEqual(marks(ed.score));
    expect(score.bars).toEqual(ed.score.bars);
    expect(melody(score)).toEqual(melody(ed.score));
  });

  it('o MIDI desdobra as repetições', () => {
    const ed = wholes(['C', 'D', 'E']);
    const plain = exportMidi(ed.score).length;
    setBarMark(ed.score, 1, { repeatEnd: true });
    expect(exportMidi(ed.score).length).toBeGreaterThan(plain);
  });
});
