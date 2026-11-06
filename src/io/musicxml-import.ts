import { strFromU8, unzipSync } from 'fflate';
import { Fraction } from '../model/fraction';
import type { Duration, DurationType } from '../model/duration';
import { decompose, decomposeApprox, durationValue } from '../model/duration';
import type { Fifths } from '../model/key';
import type { Alter, Clef, Step } from '../model/pitch';
import type { Articulation, Dynamic, Marks, Note, Part, Score, TimeSignature, Tuplet } from '../model/score';
import { chordText } from '../model/chords';
import { DYNAMICS, emptyMeasure, setBarMark, tidyMarks, INSTRUMENTS, MAX_VOICES, measureCapacity, newId, setChange } from '../model/score';
import type { LogicalEvent } from '../model/sequence';
import { normalizeMeasures, writeLogical } from '../model/sequence';

/**
 * Lê MusicXML (score-partwise, .musicxml/.xml ou compactado .mxl) e monta uma
 * partitura do Music Wiss. Importa notas, pausas, acordes, até 4 vozes por pauta,
 * várias pautas, ligaduras, quiálteras, mudanças de compasso/tonalidade, andamento,
 * dinâmicas, articulações, letra (1ª estrofe), cifras, repetições e casas de 1ª/2ª vez.
 */

export interface ImportResult {
  score: Score;
  /** Avisos sobre o que não pôde ser importado. */
  warnings: string[];
}

const TYPES: Record<string, DurationType> = {
  whole: 'whole', half: 'half', quarter: 'quarter', eighth: 'eighth', '16th': '16th', '32nd': '32nd',
};

const STEPS = new Set(['C', 'D', 'E', 'F', 'G', 'A', 'B']);

const ART_FROM_XML: Record<string, Articulation> = {
  staccato: 'staccato',
  staccatissimo: 'staccatissimo',
  spiccato: 'staccatissimo',
  tenuto: 'tenuto',
  accent: 'accent',
  'strong-accent': 'marcato',
};

/** Marcas de uma <note>: articulações, fermata e letra (estrofe 1). */
function noteMarks(el: Element): Marks {
  const marks: Marks = {};
  const arts: Articulation[] = [];
  for (const n of children(el, 'notations')) {
    for (const a of children(n, 'articulations')) {
      for (const x of Array.from(a.children)) if (ART_FROM_XML[x.tagName]) arts.push(ART_FROM_XML[x.tagName]);
    }
    if (child(n, 'fermata')) arts.push('fermata');
  }
  if (arts.length) marks.articulations = arts;
  const lyric = children(el, 'lyric').find((l) => (l.getAttribute('number') ?? '1') === '1') ?? children(el, 'lyric')[0];
  const t = lyric ? children(lyric, 'text').map((x) => x.textContent ?? '').join('').trim() : '';
  if (t) {
    const syl = text(lyric!, 'syllabic');
    marks.lyric = syl === 'begin' || syl === 'middle' ? `${t}-` : t;
  }
  return marks;
}

/** Abre .mxl (zip) ou texto MusicXML. */
export function readMusicXmlFile(name: string, data: Uint8Array): string {
  if (name.toLowerCase().endsWith('.mxl') || (data[0] === 0x50 && data[1] === 0x4b)) {
    const files = unzipSync(data);
    const container = files['META-INF/container.xml'];
    let path: string | undefined;
    if (container) path = /full-path="([^"]+)"/.exec(strFromU8(container))?.[1];
    path ??= Object.keys(files).find((f) => !f.startsWith('META-INF') && /\.(xml|musicxml)$/i.test(f));
    if (!path || !files[path]) throw new Error('Arquivo .mxl sem partitura dentro');
    return strFromU8(files[path]);
  }
  return new TextDecoder().decode(data);
}

const child = (el: Element, name: string): Element | null => {
  for (const c of Array.from(el.children)) if (c.tagName === name) return c;
  return null;
};
const children = (el: Element, name: string): Element[] => Array.from(el.children).filter((c) => c.tagName === name);
const text = (el: Element | null, name: string): string | null => {
  const c = el ? child(el, name) : null;
  return c?.textContent?.trim() ?? null;
};
const num = (el: Element | null, name: string): number | null => {
  const t = text(el, name);
  return t === null || t === '' || Number.isNaN(Number(t)) ? null : Number(t);
};

function clefFrom(el: Element): Clef {
  const sign = text(el, 'sign');
  const line = num(el, 'line');
  if (sign === 'F') return 'bass';
  if (sign === 'C') return line === 4 ? 'tenor' : 'alto';
  return 'treble';
}

/** Instrumento mais parecido pelo programa MIDI ou pelo nome. */
function guessInstrument(name: string, program: number | null, staves: number) {
  const byProgram = program !== null ? INSTRUMENTS.find((i) => i.midiProgram === program && i.clefs.length === staves) : undefined;
  const lower = name.toLowerCase();
  const byName = INSTRUMENTS.find((i) => lower.includes(i.name.toLowerCase().split(' ')[0]) || lower.includes(i.id));
  return byProgram ?? byName;
}

interface VoiceBuild {
  events: LogicalEvent[];
  /** até onde a voz já foi preenchida (semibreves desde o início) */
  filled: Fraction;
}

export function importMusicXml(xml: string): ImportResult {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.tagName === 'parsererror' || doc.getElementsByTagName('parsererror').length) {
    throw new Error('Arquivo MusicXML inválido');
  }
  if (root.tagName === 'score-timewise') throw new Error('MusicXML "timewise" ainda não é suportado');
  if (root.tagName !== 'score-partwise') throw new Error('Isto não parece um arquivo MusicXML');

  const warnings = new Set<string>();
  const title = text(child(root, 'work'), 'work-title') ?? text(root, 'movement-title') ?? 'Sem título';
  const composer =
    children(child(root, 'identification') ?? root, 'creator').find((c) => c.getAttribute('type') === 'composer')?.textContent?.trim() ?? '';

  const partInfo = new Map<string, { name: string; program: number | null }>();
  for (const sp of Array.from(child(root, 'part-list')?.getElementsByTagName('score-part') ?? [])) {
    const program = num(sp.getElementsByTagName('midi-instrument')[0] ?? null, 'midi-program');
    partInfo.set(sp.getAttribute('id') ?? '', { name: text(sp, 'part-name') ?? 'Instrumento', program: program !== null ? program - 1 : null });
  }

  const score: Score = {
    id: newId('s'),
    title,
    composer,
    tempo: 96,
    timeSignature: { beats: 4, beatType: 4 },
    keyFifths: 0,
    changes: [],
    parts: [],
  };
  let tempoSet = false;
  const measureStarts: Fraction[] = [Fraction.ZERO];
  const tsByMeasure: TimeSignature[] = [];
  const keyByMeasure: Fifths[] = [];
  const partVoices: VoiceBuild[][][] = [];

  children(root, 'part').forEach((partEl, pi) => {
    const info = partInfo.get(partEl.getAttribute('id') ?? '') ?? { name: `Instrumento ${pi + 1}`, program: null };
    const measures = children(partEl, 'measure');
    // descobre o número de pautas e as claves antes de montar o instrumento
    let staves = 1;
    const clefs: Clef[] = [];
    let transposition = 0;
    const firstAttrs = measures[0] ? children(measures[0], 'attributes') : [];
    for (const a of firstAttrs) {
      staves = num(a, 'staves') ?? staves;
      for (const c of children(a, 'clef')) clefs[(Number(c.getAttribute('number') ?? 1) || 1) - 1] = clefFrom(c);
      const tr = child(a, 'transpose');
      if (tr) transposition = (num(tr, 'chromatic') ?? 0) + 12 * (num(tr, 'octave-change') ?? 0);
    }
    if (staves > 2) warnings.add('Instrumentos com mais de 2 pautas foram reduzidos a 2.');
    staves = Math.min(Math.max(staves, 1), 2);
    const preset = guessInstrument(info.name, info.program, staves);
    const part: Part = {
      id: newId('p'),
      name: info.name,
      instrument: preset?.id ?? 'custom',
      midiProgram: info.program ?? preset?.midiProgram ?? 0,
      transposition,
      staves: Array.from({ length: staves }, (_, si) => ({ id: newId('st'), clef: clefs[si] ?? (si === 1 ? 'bass' : 'treble'), measures: [emptyMeasure()] })),
    };
    score.parts.push(part);

    const voices: VoiceBuild[][] = Array.from({ length: staves }, () => Array.from({ length: MAX_VOICES }, () => ({ events: [], filled: Fraction.ZERO })));
    partVoices.push(voices);
    const voiceMap = new Map<string, number>(); // `${staff}:${voz do arquivo}` → 0..3
    const nextVoice = Array.from({ length: staves }, () => 0);
    let divisions = 1;
    let ts: TimeSignature = score.timeSignature;
    let key: Fifths = 0;
    let measureStart = Fraction.ZERO;
    const tupletGroups = new Map<string, { tuplet: Tuplet; left: number }>();
    // dinâmica/cifra lidas antes da nota, esperando a próxima nota da pauta
    const pending = Array.from({ length: staves }, () => ({} as Marks));
    const staffOf = (el: Element) => Math.min(staves, Math.max(1, num(el, 'staff') ?? 1)) - 1;

    let openEnding: { n: 1 | 2; from: number } | null = null;
    measures.forEach((mEl, mi) => {
      let pos = Fraction.ZERO; // posição dentro do compasso
      let maxPos = Fraction.ZERO;
      let lastEvent = new Map<string, LogicalEvent>();

      for (const el of Array.from(mEl.children)) {
        switch (el.tagName) {
          case 'attributes': {
            divisions = num(el, 'divisions') ?? divisions;
            const k = child(el, 'key');
            if (k) key = Math.max(-7, Math.min(7, num(k, 'fifths') ?? 0)) as Fifths;
            const t = child(el, 'time');
            if (t) {
              const beats = Number((text(t, 'beats') ?? '4').split('+').reduce((a, b) => a + Number(b), 0));
              const beatType = num(t, 'beat-type') ?? 4;
              if (beats > 0 && [1, 2, 4, 8, 16, 32].includes(beatType)) ts = { beats, beatType };
              else warnings.add('Fórmulas de compasso incomuns foram trocadas por 4/4.');
            }
            break;
          }
          case 'barline': {
            if (pi !== 0) break;
            const loc = el.getAttribute('location') ?? 'right';
            const rep = child(el, 'repeat')?.getAttribute('direction');
            if (rep === 'forward') setBarMark(score, mi, { repeatStart: true });
            if (rep === 'backward') setBarMark(score, mi, { repeatEnd: true });
            const end = child(el, 'ending');
            const n = Number((end?.getAttribute('number') ?? '').split(/[ ,]/)[0]);
            if (end && loc === 'left' && end.getAttribute('type') === 'start') {
              if (n === 1 || n === 2) openEnding = { n, from: mi };
              else warnings.add('Casas além da 2ª vez foram ignoradas.');
            }
            if (end && loc === 'right' && end.getAttribute('type') !== 'start') {
              if (openEnding) for (let k = openEnding.from; k <= mi; k++) setBarMark(score, k, { ending: openEnding.n });
              openEnding = null;
            }
            break;
          }
          case 'harmony': {
            const rootEl = child(el, 'root');
            const step = text(rootEl, 'root-step');
            if (!step) break;
            const kindEl = child(el, 'kind');
            const bassEl = child(el, 'bass');
            const bassStep = text(bassEl, 'bass-step');
            pending[staffOf(el)].chordSymbol = chordText(
              { step, alter: num(rootEl, 'root-alter') ?? 0 },
              kindEl?.textContent?.trim() ?? 'major',
              kindEl?.getAttribute('text') ?? null,
              bassStep ? { step: bassStep, alter: num(bassEl, 'bass-alter') ?? 0 } : undefined,
            );
            break;
          }
          case 'direction':
          case 'sound': {
            if (el.tagName === 'direction') {
              const dyn = el.getElementsByTagName('dynamics')[0];
              const name = dyn?.children[0]?.tagName as Dynamic | undefined;
              if (name && DYNAMICS.includes(name)) pending[staffOf(el)].dynamic = name;
              else if (name) warnings.add('Algumas dinâmicas incomuns foram ignoradas.');
            }
            const snd = el.tagName === 'sound' ? el : el.getElementsByTagName('sound')[0];
            const tempo = snd ? Number(snd.getAttribute('tempo')) : NaN;
            if (!tempoSet && tempo > 0) {
              score.tempo = Math.round(Math.min(300, Math.max(20, tempo)));
              tempoSet = true;
            }
            break;
          }
          case 'backup':
            pos = pos.sub(new Fraction(num(el, 'duration') ?? 0, divisions * 4));
            if (pos.lt(Fraction.ZERO)) pos = Fraction.ZERO;
            break;
          case 'forward':
            pos = pos.add(new Fraction(num(el, 'duration') ?? 0, divisions * 4));
            if (pos.gt(maxPos)) maxPos = pos;
            break;
          case 'note': {
            if (child(el, 'grace')) {
              warnings.add('Apojaturas (grace notes) ainda não são suportadas e foram ignoradas.');
              break;
            }
            if (child(el, 'cue')) break;
            const staffNo = Math.min(staves, Math.max(1, num(el, 'staff') ?? 1)) - 1;
            const voiceKey = `${staffNo}:${text(el, 'voice') ?? '1'}`;
            if (!voiceMap.has(voiceKey)) {
              if (nextVoice[staffNo] >= MAX_VOICES) {
                warnings.add('Pautas com mais de 4 vozes: as vozes extras foram ignoradas.');
                break;
              }
              voiceMap.set(voiceKey, nextVoice[staffNo]++);
            }
            const vi = voiceMap.get(voiceKey)!;
            const vb = voices[staffNo][vi];
            const isChord = !!child(el, 'chord');
            const pitchEl = child(el, 'pitch');
            const tieStart = children(el, 'tie').some((t) => t.getAttribute('type') === 'start');
            const note: Note | null = pitchEl ? readPitch(pitchEl, tieStart) : null;

            if (isChord) {
              const prev = lastEvent.get(voiceKey);
              if (prev && note) {
                prev.kind = 'chord';
                prev.notes.push(note);
              }
              break;
            }

            const raw = num(el, 'duration');
            const typeName = text(el, 'type');
            const tmEl = child(el, 'time-modification');
            let length = raw !== null ? new Fraction(raw, divisions * 4) : null;
            const dotCount = children(el, 'dot').length;
            let duration: Duration | null = typeName && TYPES[typeName] ? { type: TYPES[typeName], dots: Math.min(dotCount, 1) } : null;
            const isMeasureRest = !note && child(el, 'rest')?.getAttribute('measure') === 'yes';
            if (isMeasureRest || (!length && !duration)) length = measureCapacity(ts);
            if (!length) length = durationValue(duration!);

            // tercinas e outras quiálteras
            let tuplet: Tuplet | undefined;
            if (tmEl) {
              const actual = num(tmEl, 'actual-notes') ?? 3;
              const normal = num(tmEl, 'normal-notes') ?? 2;
              const gkey = `${staffNo}:${vi}`;
              let g = tupletGroups.get(gkey);
              const starts = Array.from(el.getElementsByTagName('tuplet')).some((t) => t.getAttribute('type') === 'start');
              if (!g || g.left <= 0 || starts || g.tuplet.actual !== actual) {
                g = { tuplet: { id: newId('t'), actual, normal }, left: actual };
                tupletGroups.set(gkey, g);
              }
              tuplet = g.tuplet;
              // conta quantas "unidades" da quiáltera a nota ocupa
              const unit = duration ? durationValue({ type: duration.type, dots: 0 }) : null;
              const units = unit ? Math.max(1, Math.round(length.mul(new Fraction(actual, normal)).div(unit).toNumber())) : 1;
              g.left -= units;
              if (!duration) {
                const base = decompose(length.mul(new Fraction(actual, normal)));
                duration = base.length === 1 ? base[0] : null;
                if (!duration) tuplet = undefined;
              }
            } else {
              tupletGroups.delete(`${staffNo}:${vi}`);
            }

            const start = measureStart.add(pos);
            // espaço vazio antes da nota (outra voz começando no meio do compasso)
            if (vb.filled.lt(start)) pushRests(vb, start.sub(vb.filled), true);

            if (length.lt(new Fraction(1, 32))) {
              warnings.add('Notas menores que a fusa foram ignoradas.');
            } else if (vb.filled.gt(start)) {
              warnings.add('Algumas notas sobrepostas na mesma voz foram ignoradas.');
            } else {
              const kind = note ? 'chord' : 'rest';
              const invisible = !note && el.getAttribute('print-object') === 'no';
              const exact = duration && (tuplet ? true : durationValue(duration).eq(length));
              const figures = exact ? [duration!] : decomposeApprox(length);
              const marks = tidyMarks({ ...pending[staffNo], ...noteMarks(el) });
              pending[staffNo] = {};
              figures.forEach((d, fi) => {
                const last = fi === figures.length - 1;
                const ev: LogicalEvent = {
                  id: newId(kind === 'rest' ? 'r' : 'c'),
                  kind,
                  duration: d,
                  length: tuplet ? length! : durationValue(d),
                  notes: note ? [{ ...note, id: newId('n'), pitch: { ...note.pitch }, tieToNext: last ? note.tieToNext : true }] : [],
                  ...(tuplet ? { tuplet } : {}),
                  ...(invisible ? { auto: true } : {}),
                  ...(fi === 0 && marks ? { marks } : {}),
                };
                vb.events.push(ev);
                lastEvent.set(voiceKey, ev);
              });
              vb.filled = start.add(length);
            }
            pos = pos.add(length);
            if (pos.gt(maxPos)) maxPos = pos;
            break;
          }
        }
      }

      // guarda fórmula/tonalidade do compasso (a do 1º instrumento manda)
      if (pi === 0) {
        tsByMeasure[mi] = ts;
        keyByMeasure[mi] = key;
      }
      const cap = measureCapacity(tsByMeasure[mi] ?? ts);
      if (maxPos.lt(cap) && mi === 0 && maxPos.gt(Fraction.ZERO)) {
        // anacruse: as notas vão para o fim do 1º compasso, com pausas antes
        warnings.add('O compasso de anacruse foi completado com pausas no início.');
        const gap = cap.sub(maxPos);
        for (const staffVoices of voices) {
          for (const vb of staffVoices) {
            if (!vb.events.length) continue;
            vb.events.unshift(...restEvents(gap, false));
            vb.filled = vb.filled.add(gap);
          }
        }
      }
      measureStart = measureStart.add(cap);
      if (pi === 0) measureStarts[mi + 1] = measureStart;
      lastEvent = new Map();

      // a voz 1 de cada pauta é completada até a barra, para as notas não "andarem"
      for (const staffVoices of voices) {
        const v0 = staffVoices[0];
        if (v0.filled.lt(measureStart)) pushRests(v0, measureStart.sub(v0.filled), true);
      }
    });
  });

  if (!score.parts.length) throw new Error('A partitura não tem instrumentos');

  score.timeSignature = tsByMeasure[0] ?? score.timeSignature;
  score.keyFifths = keyByMeasure[0] ?? 0;
  for (let mi = 1; mi < tsByMeasure.length; mi++) {
    setChange(score, mi, { timeSignature: tsByMeasure[mi], keyFifths: keyByMeasure[mi] });
  }

  score.parts.forEach((part, pi) => {
    part.staves.forEach((staff, si) => {
      partVoices[pi][si].forEach((vb, vi) => {
        // tira as pausas dos compassos vazios do fim (só completavam compassos)
        let t = Fraction.ZERO;
        let lastNoteEnd = Fraction.ZERO;
        for (const e of vb.events) {
          t = t.add(e.length);
          if (e.kind === 'chord') lastNoteEnd = t;
        }
        const cutoff = measureStarts.find((s) => s.gte(lastNoteEnd)) ?? lastNoteEnd;
        const isTrailing = (e: LogicalEvent) => e.kind === 'rest' && (e.auto || t.sub(e.length).gte(cutoff));
        while (vb.events.length && isTrailing(vb.events[vb.events.length - 1])) {
          t = t.sub(vb.events.pop()!.length);
        }
        if (!vb.events.some((e) => e.kind === 'chord')) vb.events = [];
        if (vi === 0 || vb.events.length) writeLogical(score, staff, vb.events, vi);
      });
    });
  });
  normalizeMeasures(score);
  return { score, warnings: [...warnings] };
}

function readPitch(el: Element, tieStart: boolean): Note | null {
  const step = text(el, 'step')?.toUpperCase();
  const octave = num(el, 'octave');
  if (!step || !STEPS.has(step) || octave === null) return null;
  const alter = Math.max(-2, Math.min(2, Math.round(num(el, 'alter') ?? 0))) as Alter;
  return { id: newId('n'), pitch: { step: step as Step, alter, octave }, tieToNext: tieStart };
}

function restEvents(gap: Fraction, auto: boolean): LogicalEvent[] {
  return decomposeApprox(gap).map((d) => ({ id: newId('r'), kind: 'rest' as const, duration: d, length: durationValue(d), notes: [], ...(auto ? { auto: true } : {}) }));
}

function pushRests(vb: VoiceBuild, gap: Fraction, auto: boolean) {
  vb.events.push(...restEvents(gap, auto));
  vb.filled = vb.filled.add(gap);
}
