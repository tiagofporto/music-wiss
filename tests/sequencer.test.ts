import { describe, expect, it } from 'vitest';
import { schedule } from '../src/audio/sequencer';
import { Fraction } from '../src/model/fraction';
import { createScore } from '../src/model/score';
import { Editor } from '../src/editor/editor';

describe('Sequenciador', () => {
  it('converte durações em segundos pelo andamento', () => {
    const ed = new Editor(createScore({ tempo: 120, instrumentId: 'flute' }));
    ed.insertStep('C');
    ed.insertStep('D');
    const { notes } = schedule(ed.score);
    expect(notes.map((n) => [n.start, n.duration])).toEqual([[0, 0.5], [0.5, 0.5]]);
  });

  it('nota dividida na barra soa como uma nota só', () => {
    const ed = new Editor(createScore({ tempo: 60, instrumentId: 'flute' }));
    ed.toggleInputMode(true);
    ed.setDuration('half');
    ed.insertStep('C');
    ed.toggleDot();
    ed.insertStep('E'); // mínima pontuada a partir do 3º tempo: cruza a barra
    const { notes } = schedule(ed.score);
    expect(notes).toHaveLength(2);
    expect(notes[1].duration).toBe(3);
  });

  it('aplica a transposição do instrumento', () => {
    const ed = new Editor(createScore({ instrumentId: 'clarinet' }));
    ed.insertStep('D');
    expect(schedule(ed.score).notes[0].midi).toBe(72); // Ré5 escrito soa Dó5
  });

  it('toca as duas pautas do piano juntas e começa do ponto pedido', () => {
    const ed = new Editor(createScore({ tempo: 60 })); // piano
    ed.insertStep('C');
    ed.insertStep('D');
    ed.moveStaff(1);
    ed.setCursor(0);
    ed.setDuration('half');
    ed.insertStep('C');
    const all = schedule(ed.score);
    expect(all.notes.filter((n) => n.start === 0)).toHaveLength(2);
    const fromBeat2 = schedule(ed.score, new Fraction(1, 4));
    expect(fromBeat2.notes).toHaveLength(1);
    expect(fromBeat2.notes[0].start).toBe(0);
  });
});
