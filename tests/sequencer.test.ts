import { describe, expect, it } from 'vitest';
import { schedule } from '../src/audio/sequencer';
import { createScore } from '../src/model/score';
import { Editor } from '../src/editor/editor';

describe('Sequenciador', () => {
  it('converte durações em segundos pelo andamento', () => {
    const ed = new Editor(createScore({ tempo: 120 }));
    ed.insertStep('C');
    ed.insertStep('D');
    const { notes } = schedule(ed.score);
    expect(notes.map((n) => [n.start, n.duration])).toEqual([[0, 0.5], [0.5, 0.5]]);
  });

  it('nota dividida na barra soa como uma nota só', () => {
    const ed = new Editor(createScore({ tempo: 60 }));
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
});
