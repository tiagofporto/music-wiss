import { describe, expect, it } from 'vitest';
import { atTempo, beatsOf, buildClicks, clampBpm, clicksForMeasure, freeBar, parseSettings, tapTempo } from '../src/audio/metronome';
import { Editor } from '../src/editor/editor';
import { Fraction } from '../src/model/fraction';
import type { Step } from '../src/model/pitch';
import { createScore, setBarMark, setChange } from '../src/model/score';

/** Uma semibreve (ou o compasso cheio) por compasso. */
function wholes(steps: Step[], ts = { beats: 4, beatType: 4 }, tempo = 120): Editor {
  const ed = new Editor(createScore({ instrumentId: 'flute', timeSignature: ts, tempo }));
  ed.toggleInputMode(true);
  ed.setDuration(ts.beats === 4 && ts.beatType === 4 ? 'whole' : 'quarter');
  for (const s of steps) ed.insertStep(s);
  return ed;
}

const levels = (cs: Array<{ level: string }>) => cs.map((c) => c.level[0]).join('');

describe('metrônomo: pulsação do compasso', () => {
  it('simples e composto', () => {
    expect(beatsOf({ beats: 4, beatType: 4 })).toMatchObject({ count: 4 });
    expect(beatsOf({ beats: 3, beatType: 4 }).count).toBe(3);
    expect(beatsOf({ beats: 2, beatType: 2 }).unit.toNumber()).toBe(0.5);
    const six = beatsOf({ beats: 6, beatType: 8 });
    expect(six.count).toBe(2);
    expect(six.unit.toNumber()).toBe(3 / 8);
    expect(beatsOf({ beats: 12, beatType: 8 }).count).toBe(4);
    expect(beatsOf({ beats: 3, beatType: 8 }).count).toBe(3);
  });

  it('padrões rítmicos num 4/4', () => {
    const ts = { beats: 4, beatType: 4 };
    expect(levels(clicksForMeasure(ts, 'tempos'))).toBe('abbb');
    expect(levels(clicksForMeasure(ts, 'primeiro'))).toBe('a');
    expect(levels(clicksForMeasure(ts, 'colcheias'))).toBe('asbsbsbs');
    expect(clicksForMeasure(ts, 'tercinas')).toHaveLength(12);
    expect(clicksForMeasure(ts, 'semicolcheias')).toHaveLength(16);
    const off = clicksForMeasure(ts, 'contratempo');
    expect(off.map((c) => c.offset.toNumber())).toEqual([0, 0.125, 0.375, 0.625, 0.875]);
  });

  it('6/8 marca duas pulsações e divide em 3', () => {
    const ts = { beats: 6, beatType: 8 };
    expect(levels(clicksForMeasure(ts, 'tempos'))).toBe('ab');
    const c = clicksForMeasure(ts, 'colcheias');
    expect(levels(c)).toBe('assbss');
    expect(c.map((x) => x.offset.toNumber() * 8)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('metrônomo junto com a partitura', () => {
  it('um clique por tempo no andamento escolhido', () => {
    const ed = wholes(['C', 'D']);
    const { clicks, leadIn, total } = buildClicks(ed.score, { bpm: 120, pattern: 'tempos', countIn: false });
    expect(leadIn).toBe(0);
    expect(clicks.map((c) => c.at)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(clicks.map((c) => c.measure)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(total).toBe(4);
    // andamento de estudo mais lento: tudo estica
    expect(buildClicks(ed.score, { bpm: 60, pattern: 'tempos', countIn: false }).clicks[1].at).toBe(1);
  });

  it('contagem de um compasso antes do começo', () => {
    const ed = wholes(['C']);
    const { clicks, leadIn } = buildClicks(ed.score, { bpm: 120, pattern: 'tempos', countIn: true });
    expect(leadIn).toBe(2);
    expect(clicks.slice(0, 4).map((c) => [c.at, c.measure, c.level[0]])).toEqual([
      [-2, -1, 'a'],
      [-1.5, -1, 'b'],
      [-1, -1, 'b'],
      [-0.5, -1, 'b'],
    ]);
    expect(clicks[4]).toMatchObject({ at: 0, measure: 0, level: 'accent' });
  });

  it('começa do meio, a partir do cursor', () => {
    const ed = wholes(['C', 'D', 'E']);
    const { clicks } = buildClicks(ed.score, { from: new Fraction(1, 1), bpm: 120, pattern: 'tempos', countIn: false });
    expect(clicks[0]).toMatchObject({ at: 0, measure: 1, level: 'accent' });
    expect(clicks).toHaveLength(8);
  });

  it('segue a mudança de compasso no meio da música', () => {
    const ed = wholes(['C', 'D', 'E']);
    setChange(ed.score, 1, { timeSignature: { beats: 3, beatType: 4 } });
    const { clicks } = buildClicks(ed.score, { bpm: 120, pattern: 'tempos', countIn: false });
    const second = clicks.filter((c) => c.measure === 1);
    expect(second).toHaveLength(3);
    expect(second.every((c) => c.beats === 3)).toBe(true);
    expect(second[0].level).toBe('accent');
  });

  it('acompanha as repetições', () => {
    const ed = wholes(['C', 'D']);
    setBarMark(ed.score, 0, { repeatStart: true });
    setBarMark(ed.score, 1, { repeatEnd: true });
    const { clicks } = buildClicks(ed.score, { bpm: 120, pattern: 'primeiro', countIn: false });
    expect(clicks.map((c) => c.measure)).toEqual([0, 1, 0, 1]);
    expect(clicks.map((c) => c.at)).toEqual([0, 2, 4, 6]);
  });
});

describe('metrônomo: ajustes', () => {
  it('compasso solto para o metrônomo sem partitura', () => {
    const bar = freeBar({ beats: 3, beatType: 4 }, 90, 'tempos');
    expect(bar.length).toBeCloseTo(2, 5);
    expect(bar.clicks.map((c) => Number(c.at.toFixed(3)))).toEqual([0, 0.667, 1.333]);
  });

  it('andamento pelo toque', () => {
    expect(tapTempo([1000])).toBeNull();
    expect(tapTempo([0, 500, 1000, 1500])).toBe(120);
    // parou mais de 2 s: conta só os toques novos
    expect(tapTempo([0, 500, 5000, 6000])).toBe(60);
    expect(tapTempo([0, 100])).toBe(240);
  });

  it('limites e preferências guardadas', () => {
    expect(clampBpm(10)).toBe(30);
    expect(clampBpm(400)).toBe(240);
    expect(clampBpm(Number.NaN)).toBe(96);
    expect(parseSettings(null)).toMatchObject({ bpm: null, pattern: 'tempos', countIn: true, withScore: true, on: false });
    expect(parseSettings('{"bpm":500,"pattern":"xyz","volume":3}')).toMatchObject({ bpm: 240, pattern: 'tempos', volume: 1 });
    expect(parseSettings('nada')).toMatchObject({ pattern: 'tempos' });
  });

  it('andamento de estudo não altera a partitura', () => {
    const s = createScore({ tempo: 96 });
    expect(atTempo(s, 60).tempo).toBe(60);
    expect(s.tempo).toBe(96);
    expect(atTempo(s, null)).toBe(s);
  });
});
