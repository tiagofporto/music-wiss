import { describe, expect, it } from 'vitest';
import { Fraction } from '../src/model/fraction';
import { pitch } from '../src/model/pitch';
import { createScore, effectiveKey, effectiveTimeSignature, setChange } from '../src/model/score';
import { readLogical } from '../src/model/sequence';
import { validateStaff } from '../src/model/validation';
import { Editor } from '../src/editor/editor';

const steps = (ed: Editor) => ed.events().map((e) => (e.kind === 'rest' ? 'r' : e.notes.map((n) => n.pitch.step).join('')));

describe('Várias pautas e instrumentos', () => {
  it('piano tem duas pautas (Sol e Fá)', () => {
    const score = createScore({ instrumentId: 'piano' });
    expect(score.parts[0].staves.map((s) => s.clef)).toEqual(['treble', 'bass']);
  });

  it('todas as pautas ficam com o mesmo número de compassos', () => {
    const ed = new Editor(createScore({ instrumentIds: ['flute', 'cello'] }));
    ed.setDuration('whole');
    for (const s of ['C', 'D', 'E'] as const) ed.insertStep(s);
    const counts = ed.score.parts.map((p) => p.staves[0].measures.length);
    expect(counts).toEqual([4, 4]); // 3 cheios + 1 livre
  });

  it('trocar de pauta mantém o momento do cursor, e as pausas automáticas somem se nada for escrito', () => {
    const ed = new Editor(createScore({ instrumentId: 'piano' }));
    ed.setDuration('half');
    ed.insertStep('C');
    ed.insertStep('D');
    ed.insertStep('E'); // cursor no 3º tempo do compasso 2
    ed.moveStaff(1);
    expect(ed.pos.staffIndex).toBe(1);
    expect(ed.cursorTime().eq(new Fraction(3, 2))).toBe(true);
    ed.insertStep('G');
    expect(steps(ed)).toEqual(['r', 'G']); // pausa (pontuada, ligada na barra) até o ponto do cursor
    ed.moveStaff(-1);
    ed.moveStaff(1);
    expect(steps(ed)).toEqual(['r', 'G']); // nada se perde quando há nota depois
  });

  it('só passar por uma pauta vazia não deixa pausas para trás', () => {
    const ed = new Editor(createScore({ instrumentId: 'piano' }));
    ed.setDuration('whole');
    ed.insertStep('C');
    ed.insertStep('D');
    ed.moveStaff(1);
    expect(ed.events().every((e) => e.auto)).toBe(true); // pausas provisórias até o cursor
    ed.moveStaff(-1);
    expect(readLogical(ed.score.parts[0].staves[1], 0)).toHaveLength(0);
  });

  it('adicionar e remover instrumentos', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.insertStep('C');
    ed.addPart('cello');
    expect(ed.score.parts.map((p) => p.name)).toEqual(['Flauta', 'Violoncelo']);
    expect(ed.score.parts[1].staves[0].measures.length).toBe(ed.score.parts[0].staves[0].measures.length);
    ed.removePart(1);
    expect(ed.score.parts).toHaveLength(1);
  });
});

describe('Vozes', () => {
  it('a voz 2 começa no ponto do cursor e não mexe na voz 1', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.toggleInputMode(true);
    for (const s of ['C', 'D', 'E', 'F', 'G'] as const) ed.insertStep(s);
    ed.setCursor(4); // início do compasso 2
    ed.setVoice(1);
    ed.setDuration('half');
    ed.insertStep('A');
    expect(steps(ed)).toEqual(['r', 'A']);
    expect(readLogical(ed.staff, 0).length).toBe(5);
    const m2 = ed.staff.measures[1];
    expect(m2.voices[1].events.map((e) => e.duration.type)).toEqual(['half']);
  });
});

describe('Quiálteras', () => {
  it('tercina: três colcheias no tempo de duas', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.toggleInputMode(true);
    ed.setDuration('eighth');
    expect(ed.insertTuplet(3)).toBeNull();
    ed.insertStep('C');
    ed.insertStep('D');
    ed.insertStep('E');
    ed.setDuration('quarter');
    ed.insertStep('F');
    ed.insertStep('G');
    ed.insertStep('A');
    const v = validateStaff(ed.score, ed.staff)[0];
    expect(v.state).toBe('complete');
    const evs = ed.staff.measures[0].voices[0].events;
    expect(evs.slice(0, 3).every((e) => e.tuplet?.actual === 3 && e.tuplet.normal === 2)).toBe(true);
    expect(evs.slice(0, 3).every((e) => e.kind === 'chord')).toBe(true);
  });

  it('não deixa criar quiáltera que não cabe no compasso', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.setDuration('half');
    ed.insertStep('C');
    ed.insertStep('D');
    ed.insertStep('E'); // sobra meio compasso
    ed.setDuration('whole');
    // cursor no fim: compasso 2 já tem uma mínima, sobra 1/2; tercina de semibreves = 2
    expect(ed.insertTuplet(3)).toMatch(/não cabe/);
  });

  it('nunca divide uma quiáltera na barra: completa o compasso com pausas provisórias', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute', timeSignature: { beats: 2, beatType: 4 } }));
    ed.toggleInputMode(true);
    ed.insertStep('C');
    ed.setDuration('eighth');
    ed.insertTuplet(3);
    for (const s of ['D', 'E', 'F'] as const) ed.insertStep(s);
    // agora insere uma colcheia antes: a tercina passa a não caber no compasso 1
    ed.setCursor(0);
    ed.insertStep('B');
    const [m1, m2] = ed.staff.measures.map((m) => m.voices[0].events);
    expect(m1.some((e) => e.tuplet)).toBe(false);
    expect(m2.filter((e) => e.tuplet)).toHaveLength(3);
    // as pausas de preenchimento não fazem parte da música
    expect(steps(ed)).toEqual(['B', 'C', 'D', 'E', 'F']);
  });

  it('apagar uma nota da tercina deixa o espaço; apagar o espaço remove o grupo', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.toggleInputMode(true);
    ed.setDuration('eighth');
    ed.insertTuplet(3);
    for (const s of ['C', 'D', 'E'] as const) ed.insertStep(s);
    ed.deleteBackward();
    expect(ed.events().map((e) => e.placeholder ?? false)).toEqual([false, false, true]);
    ed.setCursor(3);
    ed.deleteBackward();
    expect(ed.events()).toHaveLength(0);
  });
});

describe('Mudanças no meio da música', () => {
  it('fórmula de compasso a partir de um compasso reorganiza as notas', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.toggleInputMode(true);
    for (let i = 0; i < 8; i++) ed.insertStep('C');
    ed.setCursor(4); // compasso 2
    ed.setTimeSignatureHere({ beats: 2, beatType: 4 });
    expect(effectiveTimeSignature(ed.score, 0)).toEqual({ beats: 4, beatType: 4 });
    expect(effectiveTimeSignature(ed.score, 1)).toEqual({ beats: 2, beatType: 4 });
    const lens = ed.staff.measures.map((m) => m.voices[0].events.length);
    expect(lens.slice(0, 3)).toEqual([4, 2, 2]);
  });

  it('tonalidade nova vale a partir do compasso e define o acidente das letras', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.setDuration('whole');
    ed.insertStep('F');
    ed.setKeyHere(2); // Ré maior a partir do compasso 2
    ed.insertStep('F');
    expect(effectiveKey(ed.score, 0)).toBe(0);
    expect(effectiveKey(ed.score, 1)).toBe(2);
    expect(ed.selected()?.notes[0].pitch.alter).toBe(1);
  });

  it('mudança igual à anterior é descartada', () => {
    const score = createScore();
    setChange(score, 3, { keyFifths: 0 });
    expect(score.changes).toEqual([]);
  });
});

describe('Seleção, copiar e colar', () => {
  it('Shift+seta seleciona um trecho e os comandos valem para todo ele', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    for (const s of ['C', 'D', 'E'] as const) ed.insertStep(s);
    ed.moveCursor(-1, true);
    ed.moveCursor(-1, true);
    expect(ed.range()).toEqual([1, 3]);
    ed.transposeSelected('octave', 1);
    expect(ed.events().map((e) => e.notes[0].pitch.octave)).toEqual([5, 6, 6]);
  });

  it('copiar e colar duplica o trecho no cursor', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    for (const s of ['C', 'D'] as const) ed.insertStep(s);
    ed.selectAll();
    expect(ed.copy()).toBe(2);
    ed.setCursor(2);
    ed.paste();
    expect(steps(ed)).toEqual(['C', 'D', 'C', 'D']);
    ed.undo();
    expect(steps(ed)).toEqual(['C', 'D']);
  });

  it('recortar remove; colar sobre uma seleção substitui', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    for (const s of ['C', 'D', 'E'] as const) ed.insertStep(s);
    ed.setCursor(1);
    ed.moveCursor(-1, true);
    ed.cut(); // C
    expect(steps(ed)).toEqual(['D', 'E']);
    ed.setCursor(2);
    ed.moveCursor(-1, true); // seleciona E
    ed.paste();
    expect(steps(ed)).toEqual(['D', 'C']);
  });

  it('copiar parte de uma tercina leva o grupo inteiro', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.toggleInputMode(true);
    ed.setDuration('eighth');
    ed.insertTuplet(3);
    for (const s of ['C', 'D', 'E'] as const) ed.insertStep(s);
    ed.setCursor(2);
    ed.moveCursor(-1, true);
    expect(ed.copy()).toBe(3);
  });

  it('Shift+clique seleciona do evento atual até o clicado', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    for (const s of ['C', 'D', 'E', 'F'] as const) ed.insertStep(s);
    ed.clickEvent(ed.pos, 1);
    ed.clickEvent(ed.pos, 3, true);
    expect(ed.range()).toEqual([1, 4]);
    ed.clickEvent(ed.pos, 0, true);
    expect(ed.range()).toEqual([0, 2]);
  });

  it('nota digitada sobre uma seleção substitui o trecho', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    for (const s of ['C', 'D', 'E'] as const) ed.insertStep(s);
    ed.selectAll();
    ed.insertPitch(pitch('G', 4));
    expect(steps(ed)).toEqual(['G']);
  });
});
