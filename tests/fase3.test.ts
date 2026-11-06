import { describe, expect, it, vi } from 'vitest';
import { findPreset, G, parseSoundFont, voicesFor } from '../src/audio/soundfont';
import { timbreFor } from '../src/audio/timbres';
import { schedule } from '../src/audio/sequencer';
import { ChordGrouper, parseMidiMessage } from '../src/input/midi-input';
import type { MidiNote } from '../src/input/midi-input';
import { spellMidi, toMidi, pitchLabel } from '../src/model/pitch';
import { Editor } from '../src/editor/editor';
import { tinySf2 } from './helpers/sf2';
import { createScore } from '../src/model/score';

describe('SoundFont', () => {
  it('lê presets, instrumentos e amostras', () => {
    const sf = parseSoundFont(tinySf2(), 'teste.sf2');
    expect(sf.name).toBe('Banco de teste');
    expect(sf.compressed).toBe(false);
    expect(sf.presets).toHaveLength(1);
    expect(sf.presets[0]).toMatchObject({ name: 'Piano Teste', program: 0, bank: 0 });
    expect(sf.instruments[0].zones).toHaveLength(2);
    expect(sf.instruments[0].global?.get(G.initialAttenuation)).toBe(30);
    expect(sf.samples.map((s) => s.name)).toEqual(['Grave', 'Aguda']);
    expect(sf.samples[0]).toMatchObject({ originalPitch: 48, pitchCorrection: -3, sampleRate: 22050 });
    expect(sf.pcm?.length).toBe(200);
  });

  it('escolhe a zona pela nota e combina os parâmetros', () => {
    const sf = parseSoundFont(tinySf2());
    const preset = findPreset(sf, 0)!;
    const low = voicesFor(sf, preset, 50, 100);
    expect(low).toHaveLength(1);
    expect(low[0].sample).toBe(0);
    expect(low[0].gen(G.initialAttenuation)).toBe(30); // herdado do global
    expect(low[0].gen(G.sampleModes)).toBe(1);
    expect(low[0].gen(G.overridingRootKey)).toBe(-1); // padrão
    const high = voicesFor(sf, preset, 80, 100);
    expect(high[0].sample).toBe(1);
    expect(high[0].gen(G.initialAttenuation)).toBe(60); // local vence o global
    expect(high[0].gen(G.overridingRootKey)).toBe(72);
  });

  it('cai no primeiro preset quando o programa não existe', () => {
    const sf = parseSoundFont(tinySf2());
    expect(findPreset(sf, 40)?.name).toBe('Piano Teste');
  });

  it('recusa arquivos que não são SoundFont', () => {
    expect(() => parseSoundFont(new Uint8Array(40))).toThrow(/não é um SoundFont/);
  });
});

describe('timbres internos', () => {
  it('cada família tem um timbre próprio', () => {
    expect(timbreFor(0).sustain).toBe(0); // piano morre sozinho
    expect(timbreFor(19)).not.toBe(timbreFor(0)); // órgão
    expect(timbreFor(40).vibrato).toBeGreaterThan(0); // violino
    expect(timbreFor(52)).not.toBe(timbreFor(48)); // coro ≠ cordas
    expect(timbreFor(73)).not.toBe(timbreFor(71)); // flauta ≠ clarinete
  });
});

describe('reprodução', () => {
  it('o plano leva o instrumento e a intensidade', () => {
    const editor = new Editor(createScore({ instrumentIds: ['piano', 'flute'] }));
    editor.toggleInputMode(true);
    editor.insertStep('C');
    const plan = schedule(editor.score);
    expect(plan.notes[0]).toMatchObject({ partIndex: 0, program: 0, velocity: 80 });
  });
});

describe('grafia de notas vindas do teclado MIDI', () => {
  const name = (midi: number, fifths = 0) => pitchLabel(spellMidi(midi, fifths));
  it('usa as notas da escala', () => {
    expect(spellMidi(66, 1)).toEqual({ step: 'F', alter: 1, octave: 4 }); // Fá# em Sol
    expect(spellMidi(70, -1)).toEqual({ step: 'B', alter: -1, octave: 4 }); // Si♭ em Fá
    expect(spellMidi(60, 0)).toEqual({ step: 'C', alter: 0, octave: 4 });
  });
  it('fora da escala, sustenido em tom de sustenido e bemol em tom de bemol', () => {
    expect(spellMidi(61, 0)).toMatchObject({ step: 'C', alter: 1 });
    expect(spellMidi(61, -2)).toMatchObject({ step: 'D', alter: -1 });
    expect(name(63, 2)).toBe(pitchLabel({ step: 'D', alter: 1, octave: 4 }));
  });
  it('acerta a oitava de Si# e Dó♭', () => {
    expect(spellMidi(60, 7)).toEqual({ step: 'B', alter: 1, octave: 3 }); // Dó# maior tem Si#
    expect(spellMidi(71, -7)).toEqual({ step: 'C', alter: -1, octave: 5 }); // Dó♭ maior
    for (let m = 21; m <= 108; m++) for (let f = -7; f <= 7; f++) expect(toMidi(spellMidi(m, f))).toBe(m);
  });
});

describe('teclado MIDI', () => {
  it('lê mensagens de nota', () => {
    expect(parseMidiMessage([0x90, 60, 100])).toEqual({ type: 'on', midi: 60, velocity: 100 });
    expect(parseMidiMessage([0x93, 60, 0])).toMatchObject({ type: 'off', midi: 60 });
    expect(parseMidiMessage([0x80, 60, 40])).toMatchObject({ type: 'off' });
    expect(parseMidiMessage([0xb0, 64, 127])).toBeNull();
  });

  it('teclas juntas viram acorde; tecla atrasada soma ao acorde', () => {
    vi.useFakeTimers();
    const got: Array<[number[], boolean]> = [];
    const g = new ChordGrouper((notes: MidiNote[], late) => got.push([notes.map((n) => n.midi), late]), 50);
    g.noteOn({ midi: 64, velocity: 90 });
    g.noteOn({ midi: 60, velocity: 90 });
    vi.advanceTimersByTime(30);
    g.noteOn({ midi: 67, velocity: 90 });
    vi.advanceTimersByTime(60);
    expect(got).toEqual([[[60, 64, 67], false]]);
    g.noteOn({ midi: 72, velocity: 90 }); // ainda segurando o acorde
    expect(got[1]).toEqual([[72], true]);
    for (const m of [60, 64, 67, 72]) g.noteOff(m);
    g.noteOn({ midi: 62, velocity: 90 }); // nova nota depois de soltar tudo
    vi.advanceTimersByTime(60);
    expect(got[2]).toEqual([[62], false]);
    vi.useRealTimers();
  });
});

describe('editor: acordes do teclado MIDI', () => {
  it('insere o acorde inteiro e soma notas atrasadas', () => {
    const editor = new Editor(createScore({ instrumentIds: ['piano'] }));
    editor.toggleInputMode(true);
    editor.insertChord([spellMidi(67), spellMidi(60), spellMidi(64)]);
    let ev = editor.events()[0];
    expect(ev.notes.map((n) => toMidi(n.pitch))).toEqual([60, 64, 67]);
    expect(editor.cursor).toBe(1);
    editor.addPitchesToPrevious([spellMidi(72), spellMidi(64)]);
    ev = editor.events()[0];
    expect(ev.notes.map((n) => toMidi(n.pitch))).toEqual([60, 64, 67, 72]);
    editor.undo();
    expect(editor.events()[0].notes).toHaveLength(3);
  });
});
