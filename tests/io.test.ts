// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { Editor } from '../src/editor/editor';
import { exportMidi } from '../src/io/midi';
import { exportMusicXml } from '../src/io/musicxml-export';
import { importMusicXml, readMusicXmlFile } from '../src/io/musicxml-import';
import { createScore, effectiveKey, effectiveTimeSignature } from '../src/model/score';
import type { Score } from '../src/model/score';
import { readLogical } from '../src/model/sequence';
import { collectNotes } from '../src/audio/sequencer';

/** Piano a duas mãos com tercina, ligadura na barra, voz 2 e troca de tom. */
function sample(): Score {
  const ed = new Editor(createScore({ title: 'Teste & cia', composer: 'Tiago', tempo: 80, instrumentIds: ['piano', 'clarinet'], keyFifths: 1, timeSignature: { beats: 3, beatType: 4 } }));
  ed.toggleInputMode(true);
  ed.insertPitch({ step: 'D', alter: 0, octave: 4 });
  ed.setDuration('eighth');
  ed.insertTuplet(3);
  for (const s of ['E', 'F', 'G'] as const) ed.insertStep(s);
  ed.setDuration('half');
  ed.insertStep('A'); // cruza a barra: ligadura
  ed.addToChord('C');
  ed.setDuration('quarter');
  ed.insertStep('B');
  ed.setCursor(1);
  ed.setVoice(1);
  ed.setDuration('half');
  ed.insertStep('C');
  ed.setVoice(0);
  ed.moveStaff(1);
  ed.setCursor(0);
  ed.insertStep('G');
  ed.setDuration('whole');
  ed.setCursor(ed.events().length);
  ed.setKeyHere(-2);
  ed.moveStaff(1); // clarinete
  ed.setDuration('quarter');
  ed.insertStep('C');
  return ed.score;
}

/** Notas de cada compasso, por pauta e voz (pausas de preenchimento não contam). */
const summary = (score: Score) =>
  score.parts.map((p) =>
    p.staves.map((st) =>
      st.measures.map((m) =>
        [0, 1].map((v) =>
          (m.voices[v]?.events ?? [])
            .filter((e) => e.kind === 'chord')
            .map((e) => `${e.kind === 'chord' ? e.notes.map((n) => `${n.pitch.step}${n.pitch.alter}${n.pitch.octave}${n.tieToNext ? '~' : ''}`).join('+') : ''}:${e.duration.type}${e.duration.dots ? '.' : ''}${e.tuplet ? 't' : ''}`)
            .join(' '),
        ),
      ),
    ),
  );

describe('MusicXML', () => {
  it('exporta um documento válido com cabeçalho, instrumentos e transposição', () => {
    const xml = exportMusicXml(sample());
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.querySelector('work-title')?.textContent).toBe('Teste & cia');
    expect(doc.querySelectorAll('part')).toHaveLength(2);
    expect(doc.querySelector('part staves')?.textContent).toBe('2');
    expect(doc.querySelectorAll('part')[1].querySelector('transpose chromatic')?.textContent).toBe('-2');
    expect(doc.querySelectorAll('time-modification').length).toBeGreaterThanOrEqual(3);
    expect(doc.querySelectorAll('tie[type="start"]').length).toBeGreaterThan(0);
  });

  it('ida e volta preserva notas, vozes, quiálteras, ligaduras e mudanças', () => {
    const original = sample();
    const { score } = importMusicXml(exportMusicXml(original));
    expect(score.title).toBe('Teste & cia');
    expect(score.composer).toBe('Tiago');
    expect(score.tempo).toBe(80);
    expect(score.parts.map((p) => p.name)).toEqual(['Piano', 'Clarinete em Si♭']);
    expect(score.parts[1].transposition).toBe(-2);
    expect(effectiveTimeSignature(score, 0)).toEqual({ beats: 3, beatType: 4 });
    expect(effectiveKey(score, 0)).toBe(1);
    const changeAt = original.changes[0].measure;
    expect(effectiveKey(score, changeAt)).toBe(-2);
    expect(summary(score)).toEqual(summary(original));
    // e soa igual
    const a = collectNotes(original).notes.map((n) => `${n.midi}@${n.start}+${n.length}`);
    const b = collectNotes(score).notes.map((n) => `${n.midi}@${n.start}+${n.length}`);
    expect(b).toEqual(a);
  });

  it('lê acordes, backup/forward, várias vozes e anacruse de outro programa', () => {
    const xml = `<?xml version="1.0"?>
<score-partwise version="3.1">
  <movement-title>Anacruse</movement-title>
  <part-list><score-part id="P1"><part-name>Flute</part-name><midi-instrument id="I"><midi-program>74</midi-program></midi-instrument></score-part></part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes><divisions>2</divisions><key><fifths>-1</fifths></key><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="1">
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>half</type></note>
      <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>half</type></note>
      <backup><duration>4</duration></backup>
      <forward><duration>2</duration></forward>
      <note><pitch><step>B</step><alter>-1</alter><octave>3</octave></pitch><duration>2</duration><voice>2</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;
    const { score, warnings } = importMusicXml(xml);
    expect(score.title).toBe('Anacruse');
    expect(score.parts[0].midiProgram).toBe(73);
    expect(score.parts[0].instrument).toBe('flute');
    expect(warnings.join(' ')).toMatch(/anacruse/);
    const staff = score.parts[0].staves[0];
    const v0 = readLogical(staff, 0).map((e) => (e.kind === 'rest' ? `r${e.length}` : e.notes.map((n) => n.pitch.step).join('')));
    expect(v0).toEqual(['r1/4', 'C', 'FA']);
    const v1 = readLogical(staff, 1).filter((e) => e.kind === 'chord');
    expect(v1[0].notes[0].pitch).toEqual({ step: 'B', alter: -1, octave: 3 });
    expect(effectiveKey(score, 0)).toBe(-1);
  });

  it('abre arquivos .mxl compactados', () => {
    const xml = exportMusicXml(createScore({ title: 'Zip' }));
    const zip = zipSync({
      'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="score/main.musicxml"/></rootfiles></container>'),
      'score/main.musicxml': strToU8(xml),
    });
    const text = readMusicXmlFile('teste.mxl', zip);
    expect(importMusicXml(text).score.title).toBe('Zip');
  });

  it('recusa arquivos que não são MusicXML', () => {
    expect(() => importMusicXml('<html><body/></html>')).toThrow(/MusicXML/);
    expect(() => importMusicXml('não é xml')).toThrow();
  });
});

describe('MIDI', () => {
  it('gera um arquivo formato 1 com uma trilha por instrumento', () => {
    const bytes = exportMidi(sample());
    const ascii = (i: number) => String.fromCharCode(...bytes.slice(i, i + 4));
    expect(ascii(0)).toBe('MThd');
    expect(bytes[9]).toBe(1); // formato 1
    expect(bytes[11]).toBe(3); // condutor + 2 instrumentos
    expect((bytes[12] << 8) | bytes[13]).toBe(480);
    // conta trilhas
    let i = 14;
    let tracks = 0;
    while (i < bytes.length) {
      expect(ascii(i)).toBe('MTrk');
      const len = (bytes[i + 4] << 24) | (bytes[i + 5] << 16) | (bytes[i + 6] << 8) | bytes[i + 7];
      i += 8 + len;
      tracks++;
    }
    expect(tracks).toBe(3);
    expect(i).toBe(bytes.length);
  });

  it('nota ligada vira uma nota só no MIDI', () => {
    const ed = new Editor(createScore({ instrumentId: 'flute' }));
    ed.toggleInputMode(true);
    ed.setDuration('half');
    ed.toggleDot();
    ed.insertStep('C');
    ed.insertStep('D'); // cruza a barra
    const bytes = [...exportMidi(ed.score)];
    const noteOns = bytes.filter((b, k) => b === 0x90 && bytes[k + 2] === 80).length;
    expect(noteOns).toBe(2);
  });
});
