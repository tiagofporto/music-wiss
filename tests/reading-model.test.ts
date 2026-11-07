import { describe, expect, it } from 'vitest';
import type { PageInput, PlayOptions } from '../src/reading/model';
import { barClicks, blockers, buildReadingMap, mergeWithNext, openFlags, splitMeasure, tempoAt, totalSeconds, tsAt } from '../src/reading/model';
import type { FoundMeasure, PageStructure } from '../src/reading/raster';
import type { TextItem } from '../src/reading/text';
import { parseMetronomeMark, parseTempoMarks, parseTimeSignatures } from '../src/reading/text';

const t = (str: string, x: number, y: number, h = 12): TextItem => ({ str, x, y, w: str.length * h * 0.5, h });

describe('texto de PDF digital', () => {
  it('lê o sinal de metrônomo em várias formas (em semínimas por minuto)', () => {
    expect(parseMetronomeMark('♩ = 92')?.bpm).toBe(92);
    expect(parseMetronomeMark(' = 120')?.bpm).toBe(120);
    expect(parseMetronomeMark('Semínima = 76')?.bpm).toBe(76);
    expect(parseMetronomeMark('𝅗𝅥 = 60')?.bpm).toBe(120); // mínima = 60
    expect(parseMetronomeMark('♩. = 60')?.bpm).toBe(90); // semínima pontuada (6/8)
    expect(parseMetronomeMark('♪ = 160')?.bpm).toBe(80);
    expect(parseMetronomeMark('♩ = c. 100')?.bpm).toBe(100);
    expect(parseMetronomeMark('♩ = 96-104')?.bpm).toBe(100);
    expect(parseMetronomeMark('Opus 23 = 2')).toBeNull();
    expect(parseMetronomeMark('x = 92')).toBeNull();
  });

  it('separa número, palavra, mudança gradual, volta ao tempo e rubato', () => {
    const marks = parseTempoMarks([t('Allegro', 10, 20), t('rit.', 300, 200), t('a tempo', 400, 300), t('Tempo I', 10, 400), t('rubato', 10, 500)]);
    expect(marks.map((m) => m.kind)).toEqual(['word', 'gradual', 'return', 'return', 'rubato']);
    expect(marks[0].bpm).toBe(132);
    expect(marks[0].confidence).toBeLessThan(0.5);
    expect(marks[1].bpm).toBeNull();
  });

  it('junta "♩" e "= 92" que o PDF guarda separados', () => {
    const marks = parseTempoMarks([t('♩', 40, 50), t('= 92', 52, 50)]);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ kind: 'set', bpm: 92 });
  });

  it('fórmula de compasso: números empilhados dentro da pauta', () => {
    const staff = { lines: [100, 112, 124, 136, 148], space: 12 };
    const found = parseTimeSignatures([t('3', 80, 124, 22), t('4', 80, 148, 22), t('3', 300, 80)], [staff]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ beats: 3, beatType: 4 });
    // dígitos SMuFL e o "C" de compasso comum
    expect(parseTimeSignatures([t('', 80, 124, 22), t('', 80, 148, 22)], [staff])[0]).toMatchObject({ beats: 6, beatType: 8 });
    expect(parseTimeSignatures([t('', 80, 136, 22)], [staff])[0]).toMatchObject({ beats: 4, beatType: 4 });
  });
});

/** Página falsa: uma linha de música com n compassos (larguras dadas). */
function page(widths: number[], heads: number[], text: TextItem[] = [], kind: PageInput['kind'] = 'digital'): PageInput {
  let x = 50;
  const measures: FoundMeasure[] = widths.map((w, i) => {
    const m: FoundMeasure = { system: 0, x0: x, x1: x + w, top: 76, bottom: 172, confidence: 1, noteHeads: heads[i], heavyEnd: i === widths.length - 1, firstInSystem: i === 0 };
    x += w;
    return m;
  });
  const staff = { lines: [100, 112, 124, 136, 148], space: 12, thickness: 2, x0: 50, x1: x };
  const structure: PageStructure = {
    width: 1000,
    height: 1400,
    staves: [staff],
    systems: [{ staves: [staff], barlines: [], x0: 50, x1: x, top: 100, bottom: 148 }],
    measures,
    heads: [],
  };
  return { kind, structure, text };
}

const OPTS: PlayOptions = { follow: true, fixedBpm: 100, speed: 1, pattern: 'tempos' };

describe('mapa da leitura', () => {
  it('PDF digital: lê fórmula e andamento e fica pronto para revisar', () => {
    const map = buildReadingMap([page([200, 200, 200, 200], [4, 4, 4, 4], [t('♩ = 96', 60, 60), t('3', 80, 124, 22), t('4', 80, 148, 22)])]);
    expect(map.measures).toHaveLength(4);
    expect(map.initialTs).toEqual({ value: '3/4', source: 'text' });
    expect(map.initialTempo).toMatchObject({ bpm: 96, source: 'text' });
    expect(blockers(map)).toEqual([]);
    expect(map.confirmed).toBe(false);
  });

  it('escaneado: não inventa andamento nem fórmula; pede para informar', () => {
    const map = buildReadingMap([page([200, 200, 200], [4, 4, 4], [], 'scanned')]);
    expect(map.initialTempo.bpm).toBeNull();
    expect(map.initialTs.value).toBeNull();
    expect(blockers(map)).toEqual(['Escolha a fórmula de compasso.', 'Informe o andamento inicial.']);
    expect(map.notes.join(' ')).toMatch(/escaneado, foto/);
  });

  it('mudanças de andamento e de compasso no meio da música', () => {
    const map = buildReadingMap([
      page([200, 200, 200, 200], [4, 4, 4, 4], [t('♩ = 80', 60, 60), t('4', 80, 124, 22), t('4', 80, 148, 22), t('♩ = 120', 470, 60), t('3', 660, 124, 22), t('4', 660, 148, 22)]),
    ]);
    expect([0, 1, 2, 3].map((i) => tempoAt(map, i))).toEqual([80, 80, 120, 120]);
    expect([0, 1, 2, 3].map((i) => tsAt(map, i).beats)).toEqual([4, 4, 4, 3]);
  });

  it('palavra de andamento vira estimativa com aviso', () => {
    const map = buildReadingMap([page([200, 200, 200], [4, 4, 4], [t('Andante', 60, 60)])]);
    expect(map.initialTempo).toMatchObject({ bpm: 84, source: 'word' });
    expect(map.notes.join(' ')).toMatch(/estimado/);
  });

  it('"rit." fica destacado e não muda o número sozinho', () => {
    const map = buildReadingMap([page([200, 200, 200], [4, 4, 4], [t('♩ = 100', 60, 60), t('rit.', 300, 60)])]);
    expect(map.measures[1].flags.map((f) => f.kind)).toContain('gradual');
    expect(tempoAt(map, 2)).toBe(100);
    expect(openFlags(map).some((f) => f.flag.kind === 'gradual')).toBe(true);
  });

  it('anacruse provável e compasso estreito demais ficam marcados', () => {
    const map = buildReadingMap([page([120, 200, 200, 60, 200], [1, 4, 4, 4, 4])]);
    expect(map.measures[0].flags.map((f) => f.kind)).toContain('pickup');
    expect(map.measures[3].flags.map((f) => f.kind)).toContain('irregular');
  });

  it('juntar e dividir compassos corrige barras erradas', () => {
    const map = buildReadingMap([page([200, 100, 100, 200], [4, 2, 2, 4])]);
    expect(mergeWithNext(map, 1)).toBe(true);
    expect(map.measures).toHaveLength(3);
    expect(map.measures[1].noteHeads).toBe(4);
    expect(splitMeasure(map, 1)).toBe(true);
    expect(map.measures).toHaveLength(4);
  });
});

describe('cliques sincronizados com o mapa', () => {
  const base = () => {
    const map = buildReadingMap([page([200, 200, 200, 200], [4, 4, 4, 4], [t('♩ = 60', 60, 60), t('4', 80, 124, 22), t('4', 80, 148, 22), t('♩ = 120', 470, 60)])]);
    return map;
  };

  it('um clique por tempo, o 1º acentuado, na duração certa', () => {
    const bar = barClicks(base(), 0, OPTS);
    expect(bar.length).toBeCloseTo(4);
    expect(bar.clicks.map((c) => c.at)).toEqual([0, 1, 2, 3]);
    expect(bar.clicks[0].level).toBe('accent');
  });

  it('segue as mudanças de andamento ou mantém BPM fixo', () => {
    const map = base();
    expect(totalSeconds(map, OPTS)).toBeCloseTo(4 + 4 + 2 + 2);
    expect(totalSeconds(map, { ...OPTS, follow: false, fixedBpm: 60 })).toBeCloseTo(16);
    expect(totalSeconds(map, { ...OPTS, speed: 0.5 })).toBeCloseTo(24);
  });

  it('anacruse de 1 tempo: só o último tempo, sem acento', () => {
    const map = base();
    map.measures[0].beats = 1;
    const bar = barClicks(map, 0, OPTS);
    expect(bar.length).toBeCloseTo(1);
    expect(bar.clicks).toEqual([{ at: 0, level: 'beat', beat: 3 }]);
  });

  it('compasso ignorado não toca; 6/8 bate em dois', () => {
    const map = base();
    map.measures[1].skip = true;
    expect(totalSeconds(map, OPTS)).toBeCloseTo(4 + 2 + 2);
    map.initialTs.value = '6/8';
    expect(barClicks(map, 0, OPTS).clicks.map((c) => c.at)).toEqual([0, 1.5]);
  });
});
