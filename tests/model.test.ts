import { describe, expect, it } from 'vitest';
import { Fraction } from '../src/model/fraction';
import { decompose, dur, durationValue } from '../src/model/duration';
import { keyAlter } from '../src/model/key';
import { diatonicIndex, nearestOctave, pitch, staffPosition, toMidi, transposeSemitone } from '../src/model/pitch';
import { createScore } from '../src/model/score';
import { readLogical } from '../src/model/sequence';
import { validateStaff } from '../src/model/validation';
import { Editor } from '../src/editor/editor';

describe('Fraction', () => {
  it('soma tercinas sem erro de arredondamento', () => {
    const third = new Fraction(1, 12);
    expect(third.add(third).add(third).eq(new Fraction(1, 4))).toBe(true);
  });
  it('reduz e normaliza sinal', () => {
    const f = new Fraction(6, -8);
    expect(f.num).toBe(-3);
    expect(f.den).toBe(4);
  });
});

describe('Pitch', () => {
  it('Dó# e Réb têm o mesmo MIDI mas posições diferentes na pauta', () => {
    const cs = pitch('C', 4, 1);
    const db = pitch('D', 4, -1);
    expect(toMidi(cs)).toBe(61);
    expect(toMidi(db)).toBe(61);
    expect(staffPosition(cs, 'treble')).not.toBe(staffPosition(db, 'treble'));
  });
  it('posição vertical é por grau diatônico, não por semitom', () => {
    expect(staffPosition(pitch('E', 4), 'treble')).toBe(0); // 1ª linha
    expect(staffPosition(pitch('F', 5), 'treble')).toBe(8); // 5ª linha
    expect(staffPosition(pitch('C', 4), 'treble')).toBe(-2); // linha suplementar
    expect(staffPosition(pitch('C', 4, 1), 'treble')).toBe(-2); // Dó# na mesma altura que Dó
    expect(staffPosition(pitch('G', 2), 'bass')).toBe(0);
    expect(staffPosition(pitch('C', 4), 'alto')).toBe(4); // linha do meio
  });
  it('Si#3 é escrito na oitava 3 mas soa como Dó4', () => {
    expect(toMidi(pitch('B', 3, 1))).toBe(60);
    expect(diatonicIndex(pitch('B', 3, 1))).toBeLessThan(diatonicIndex(pitch('C', 4)));
  });
  it('escolhe a oitava mais próxima da nota anterior', () => {
    expect(nearestOctave('B', pitch('C', 4))).toBe(3);
    expect(nearestOctave('D', pitch('C', 4))).toBe(4);
    expect(nearestOctave('G', pitch('C', 5))).toBe(4);
    expect(nearestOctave('E', null)).toBe(4);
  });
  it('transposição por semitom escolhe uma grafia válida', () => {
    expect(transposeSemitone(pitch('E', 4), 1)).toEqual(pitch('F', 4));
    expect(transposeSemitone(pitch('C', 4), 1)).toEqual(pitch('C', 4, 1));
    expect(transposeSemitone(pitch('C', 4), -1)).toEqual(pitch('B', 3));
    expect(transposeSemitone(pitch('D', 4), -1)).toEqual(pitch('D', 4, -1));
  });
});

describe('Armadura', () => {
  it('Sol maior tem Fá#, Fá maior tem Si♭', () => {
    expect(keyAlter(1, 'F')).toBe(1);
    expect(keyAlter(1, 'C')).toBe(0);
    expect(keyAlter(-1, 'B')).toBe(-1);
    expect(keyAlter(-1, 'E')).toBe(0);
  });
});

describe('Durações', () => {
  it('ponto de aumento soma metade', () => {
    expect(durationValue(dur('quarter', 1)).eq(new Fraction(3, 8))).toBe(true);
    expect(durationValue(dur('half', 2)).eq(new Fraction(7, 8))).toBe(true);
  });
  it('decompõe frações em figuras', () => {
    expect(decompose(new Fraction(3, 8))).toEqual([dur('quarter', 1)]);
    expect(decompose(new Fraction(5, 8))).toEqual([dur('half'), dur('eighth')]);
  });
});

describe('Compassos e validação', () => {
  it('detecta compasso incompleto, completo e excedido', () => {
    const score = createScore({ timeSignature: { beats: 3, beatType: 4 } });
    const staff = score.parts[0].staves[0];
    staff.measures[0].voices[0].events = [
      { kind: 'rest', id: 'a', duration: dur('half') },
    ];
    expect(validateStaff(score, staff)[0].state).toBe('incomplete');
    expect(validateStaff(score, staff)[0].remaining.toString()).toBe('1/4');
    staff.measures[0].voices[0].events.push({ kind: 'rest', id: 'b', duration: dur('quarter') });
    expect(validateStaff(score, staff)[0].state).toBe('complete');
    staff.measures[0].voices[0].events.push({ kind: 'rest', id: 'c', duration: dur('eighth') });
    expect(validateStaff(score, staff)[0].state).toBe('overflow');
  });

  it('cria compassos novos ao digitar e divide notas na barra com ligadura', () => {
    const ed = new Editor(createScore({ timeSignature: { beats: 3, beatType: 4 } }));
    ed.setDuration('half');
    ed.insertStep('C');
    ed.insertStep('D'); // mínima começando no 3º tempo: 1/4 + 1/4 ligadas
    const staff = ed.staff;
    expect(staff.measures.length).toBe(2);
    const [m1, m2] = staff.measures.map((m) => m.voices[0].events);
    expect(m1.map((e) => e.duration.type)).toEqual(['half', 'quarter']);
    expect(m2.map((e) => e.duration.type)).toEqual(['quarter']);
    expect(m1[1].kind === 'chord' && m1[1].notes[0].tieToNext).toBe(true);
    expect(m2[0].fragmentOf).toBe(m1[1].id);
    // na visão lógica continua sendo uma só mínima
    expect(readLogical(staff).map((e) => e.duration.type)).toEqual(['half', 'half']);
  });

  it('apagar uma nota reagrupa os pedaços ligados', () => {
    const ed = new Editor(createScore());
    ed.setDuration('quarter');
    ed.insertStep('C');
    ed.setDuration('whole');
    ed.insertStep('E'); // atravessa a barra
    ed.setCursor(1);
    ed.deleteBackward();
    const evs = ed.staff.measures[0].voices[0].events;
    expect(evs.length).toBe(1);
    expect(evs[0].duration.type).toBe('whole');
    expect(evs[0].kind === 'chord' && evs[0].notes[0].tieToNext).toBe(false);
  });

  it('nunca deixa compasso excedido depois de editar', () => {
    const ed = new Editor(createScore({ timeSignature: { beats: 6, beatType: 8 } }));
    for (const d of ['quarter', 'half', 'eighth', '16th', 'whole', 'quarter'] as const) {
      ed.setDuration(d);
      ed.insertStep('G');
    }
    const states = validateStaff(ed.score, ed.staff).map((v) => v.state);
    expect(states).not.toContain('overflow');
    expect(states.slice(0, -1).every((s) => s === 'complete')).toBe(true);
  });
});

describe('Editor', () => {
  it('usa a armadura ao digitar a letra', () => {
    const ed = new Editor(createScore({ keyFifths: 2 })); // Ré maior: Fá# e Dó#
    ed.insertStep('F');
    expect(ed.selected()?.notes[0].pitch).toEqual(pitch('F', 4, 1));
  });
  it('primeira nota fica perto do meio da pauta em qualquer clave', () => {
    const ed = new Editor(createScore({ instrumentId: 'cello' }));
    ed.insertStep('C');
    expect(ed.selected()?.notes[0].pitch).toEqual(pitch('C', 3));
  });
  it('+ e − mudam o acidente sem mudar a letra', () => {
    const ed = new Editor(createScore());
    ed.insertStep('D');
    ed.shiftAlter(-1);
    expect(ed.selected()?.notes[0].pitch).toEqual(pitch('D', 5, -1));
  });
  it('desfazer e refazer', () => {
    const ed = new Editor(createScore());
    ed.insertStep('C');
    ed.insertStep('D');
    ed.undo();
    expect(ed.events().length).toBe(1);
    ed.redo();
    expect(ed.events().length).toBe(2);
  });
  it('monta acordes', () => {
    const ed = new Editor(createScore());
    ed.insertStep('C');
    ed.addToChord('E');
    ed.addToChord('G');
    expect(ed.selected()?.notes.map((n) => n.pitch.step)).toEqual(['C', 'E', 'G']);
  });
});
