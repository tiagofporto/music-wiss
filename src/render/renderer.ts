import {
  Accidental,
  Beam,
  BarlineType,
  Dot,
  Formatter,
  Renderer,
  Stave,
  StaveNote,
  StaveTie,
  Voice,
} from 'vexflow/bravura';
import type { MusicEvent, Score, Staff } from '../model/score';
import { effectiveTimeSignature } from '../model/score';
import { VEX_DURATION } from '../model/duration';
import { vexKey } from '../model/key';
import type { Pitch } from '../model/pitch';
import { validateStaff } from '../model/validation';

/**
 * Motor de layout + desenho. O VexFlow cuida de hastes, barras de colcheia,
 * acidentes e glifos SMuFL (fonte Bravura); este módulo cuida do layout da
 * página: largura de cada compasso, quebra de linha e justificação.
 */

export interface RenderTheme {
  ink: string;
  muted: string;
  accent: string;
  playing: string;
  warn: string;
}

export interface RenderOptions {
  width: number;
  /** índice lógico do evento selecionado (destacado) */
  selected: number | null;
  /** índice lógico do evento tocando agora */
  playing: number | null;
  cursor: number;
  showCursor: boolean;
  theme: RenderTheme;
}

export interface CursorBox {
  x: number;
  y: number;
  height: number;
}

export interface RenderResult {
  height: number;
  cursor: CursorBox | null;
  /** caixas de clique por evento lógico */
  hits: Array<{ index: number; x: number; y: number; w: number; h: number }>;
}

const STAVE_HEIGHT = 40; // altura das 5 linhas no VexFlow (espaço de 10px)
const SYSTEM_GAP = 110;
const TOP = 30;
const MARGIN_X = 24;
const MIN_MEASURE = 130;

const VEX_CLEF = { treble: 'treble', bass: 'bass', alto: 'alto', tenor: 'tenor' } as const;

function vexKeyOf(p: Pitch): string {
  const acc = { [-2]: 'bb', [-1]: 'b', 0: '', 1: '#', 2: '##' }[p.alter];
  return `${p.step.toLowerCase()}${acc}/${p.octave}`;
}

interface BuiltMeasure {
  notes: StaveNote[];
  voice: Voice;
  /** índice lógico de cada nota */
  logical: number[];
  events: MusicEvent[];
  emptyRest: boolean;
}

function buildMeasure(score: Score, staff: Staff, mi: number, logicalOf: Map<string, number>, theme: RenderTheme): BuiltMeasure {
  const measure = staff.measures[mi];
  const ts = effectiveTimeSignature(score, staff, mi);
  const events = measure.voices[0]?.events ?? [];
  const clef = VEX_CLEF[staff.clef];
  const notes: StaveNote[] = [];
  const logical: number[] = [];
  const restKey = { treble: 'b/4', bass: 'd/3', alto: 'c/4', tenor: 'a/3' }[staff.clef];

  for (const e of events) {
    const base = { duration: VEX_DURATION[e.duration.type], dots: e.duration.dots, clef };
    const note =
      e.kind === 'rest'
        ? new StaveNote({ ...base, keys: [restKey], type: 'r' })
        : new StaveNote({ ...base, keys: sortedNotes(e).map((n) => vexKeyOf(n.pitch)), autoStem: true });
    note.setStyle({ fillStyle: theme.ink, strokeStyle: theme.ink });
    note.setLedgerLineStyle({ strokeStyle: theme.ink, lineWidth: 1.4 });
    if (e.duration.dots) Dot.buildAndAttach([note], { all: true });
    notes.push(note);
    logical.push(logicalOf.get(e.fragmentOf ?? e.id) ?? -1);
  }

  let emptyRest = false;
  if (notes.length === 0) {
    const rest = new StaveNote({ keys: [restKey], duration: 'w', type: 'r', alignCenter: true, clef });
    rest.setStyle({ fillStyle: theme.muted, strokeStyle: theme.muted });
    notes.push(rest);
    logical.push(-1);
    emptyRest = true;
  }

  const voice = new Voice({ numBeats: ts.beats, beatValue: ts.beatType }).setMode(Voice.Mode.SOFT);
  voice.addTickables(notes);
  Accidental.applyAccidentals([voice], vexKey(score.keyFifths));
  return { notes, voice, logical, events, emptyRest };
}

function sortedNotes(e: MusicEvent) {
  if (e.kind !== 'chord') return [];
  return [...e.notes].sort((a, b) => a.pitch.octave * 7 + 'CDEFGAB'.indexOf(a.pitch.step) - (b.pitch.octave * 7 + 'CDEFGAB'.indexOf(b.pitch.step)));
}

/** Mapa id do evento → índice lógico (pedaços ligados apontam para o original). */
function logicalIndex(staff: Staff): Map<string, number> {
  const map = new Map<string, number>();
  let i = 0;
  for (const m of staff.measures) {
    for (const e of m.voices[0]?.events ?? []) {
      if (e.fragmentOf && map.has(e.fragmentOf)) continue;
      map.set(e.id, i++);
    }
  }
  return map;
}

export function renderScore(container: HTMLElement, score: Score, opts: RenderOptions): RenderResult {
  container.innerHTML = '';
  const staff = score.parts[0].staves[0];
  const { theme } = opts;
  const logicalOf = logicalIndex(staff);
  const totalLogical = logicalOf.size;
  const validations = validateStaff(score, staff);

  // 1ª passada: largura mínima de cada compasso
  const minWidths = staff.measures.map((_, mi) => {
    const b = buildMeasure(score, staff, mi, logicalOf, theme);
    const w = new Formatter().joinVoices([b.voice]).preCalculateMinTotalWidth([b.voice]);
    return Math.max(MIN_MEASURE, w * 1.35 + 48);
  });
  const header = headerWidth(score, staff);
  const usable = Math.max(300, opts.width - MARGIN_X * 2);

  // quebra de linha gulosa
  const systems: number[][] = [];
  let line: number[] = [];
  let lineW = 0;
  staff.measures.forEach((_, mi) => {
    const extra = line.length === 0 ? header.full : mi > 0 && changesTime(score, staff, mi) ? 30 : 0;
    const w = minWidths[mi] + extra;
    if (line.length > 0 && lineW + w > usable) {
      systems.push(line);
      line = [];
      lineW = 0;
      lineW += minWidths[mi] + header.full;
    } else {
      lineW += w;
    }
    line.push(mi);
  });
  if (line.length) systems.push(line);

  const height = TOP + systems.length * SYSTEM_GAP + 20;
  const renderer = new Renderer(container as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(opts.width, height);
  const ctx = renderer.getContext();
  ctx.setFillStyle(theme.ink);
  ctx.setStrokeStyle(theme.ink);

  const allNotes: Array<{ note: StaveNote; logical: number; event: MusicEvent | null }> = [];
  const hits: RenderResult['hits'] = [];
  const staves: Array<{ stave: Stave; built: BuiltMeasure; mi: number }> = [];

  systems.forEach((sys, si) => {
    const y = TOP + si * SYSTEM_GAP;
    const naturalW = sys.reduce((acc, mi, k) => acc + minWidths[mi] + (k === 0 ? header.full : 0), 0);
    const isLast = si === systems.length - 1;
    // justifica: estica proporcionalmente, exceto a última linha se estiver curta
    const scale = isLast && naturalW < usable * 0.75 ? 1 : usable / naturalW;
    let x = MARGIN_X;
    sys.forEach((mi, k) => {
      const ts = effectiveTimeSignature(score, staff, mi);
      const first = k === 0;
      const w = (minWidths[mi] + (first ? header.full : 0)) * scale;
      const stave = new Stave(x, y, w);
      if (first) {
        stave.addClef(VEX_CLEF[staff.clef]).addKeySignature(vexKey(score.keyFifths));
        if (mi === 0 || changesTime(score, staff, mi)) stave.addTimeSignature(`${ts.beats}/${ts.beatType}`);
        if (mi > 0) stave.setMeasure(mi + 1);
      } else if (changesTime(score, staff, mi)) {
        stave.addTimeSignature(`${ts.beats}/${ts.beatType}`);
      }
      if (mi === staff.measures.length - 1) stave.setEndBarType(BarlineType.END);
      stave.setStyle({ strokeStyle: theme.muted, fillStyle: theme.ink });
      stave.setContext(ctx).draw();

      const built = buildMeasure(score, staff, mi, logicalOf, theme);
      built.notes.forEach((n, i) => {
        const li = built.logical[i];
        if (li >= 0 && li === opts.playing) n.setStyle({ fillStyle: theme.playing, strokeStyle: theme.playing });
        else if (li >= 0 && li === opts.selected) n.setStyle({ fillStyle: theme.accent, strokeStyle: theme.accent });
      });
      const ts2 = `${ts.beats}/${ts.beatType}`;
      const beamable = built.notes.filter((_, i) => built.events[i]?.kind === 'chord');
      const beams = beamable.length ? Beam.generateBeams(built.notes, { groups: Beam.getDefaultBeamGroups(ts2) }) : [];
      const available = stave.getNoteEndX() - stave.getNoteStartX() - 24;
      stave.setNoteStartX(stave.getNoteStartX() + 8);
      new Formatter().joinVoices([built.voice]).format([built.voice], Math.max(40, available));
      built.voice.draw(ctx, stave);
      for (const b of beams) {
        b.setStyle({ fillStyle: theme.ink, strokeStyle: theme.ink });
        b.setContext(ctx).draw();
      }

      if (validations[mi].state === 'incomplete' && mi < staff.measures.length - 1) {
        ctx.save();
        ctx.setFillStyle(theme.warn);
        ctx.fillRect(stave.getX() + 2, y + 38, w - 4, 3);
        ctx.restore();
      }

      built.notes.forEach((n, i) => {
        const li = built.logical[i];
        allNotes.push({ note: n, logical: li, event: built.events[i] ?? null });
        if (li >= 0) {
          const bb = n.getBoundingBox();
          hits.push({ index: li, x: bb.getX() - 4, y: y + 20, w: bb.getW() + 8, h: STAVE_HEIGHT + 40 });
        }
      });
      staves.push({ stave, built, mi });
      x += w;
    });
  });

  drawTies(ctx, allNotes, staves, theme);

  return { height, cursor: opts.showCursor ? cursorBox(opts.cursor, totalLogical, allNotes, staves) : null, hits };
}

function changesTime(score: Score, staff: Staff, mi: number): boolean {
  if (mi === 0) return true;
  const a = effectiveTimeSignature(score, staff, mi);
  const b = effectiveTimeSignature(score, staff, mi - 1);
  return a.beats !== b.beats || a.beatType !== b.beatType;
}

function headerWidth(score: Score, staff: Staff): { full: number } {
  const s = new Stave(0, 0, 500);
  s.addClef(VEX_CLEF[staff.clef]).addKeySignature(vexKey(score.keyFifths)).addTimeSignature(`${score.timeSignature.beats}/${score.timeSignature.beatType}`);
  return { full: s.getNoteStartX() - s.getX() };
}

function drawTies(
  ctx: ReturnType<Renderer['getContext']>,
  notes: Array<{ note: StaveNote; event: MusicEvent | null }>,
  staves: Array<{ stave: Stave }>,
  theme: RenderTheme,
) {
  const chords = notes.filter((n) => n.event?.kind === 'chord');
  for (let i = 0; i < chords.length - 1; i++) {
    const a = chords[i];
    const b = chords[i + 1];
    if (a.event?.kind !== 'chord' || b.event?.kind !== 'chord') continue;
    const an = sortedNotes(a.event);
    const bn = sortedNotes(b.event);
    const first: number[] = [];
    const last: number[] = [];
    an.forEach((n, ai) => {
      if (!n.tieToNext) return;
      const bi = bn.findIndex((m) => m.pitch.step === n.pitch.step && m.pitch.octave === n.pitch.octave);
      if (bi >= 0) {
        first.push(ai);
        last.push(bi);
      }
    });
    if (!first.length) continue;
    const sameLine = a.note.getStave()?.getY() === b.note.getStave()?.getY();
    const draw = (t: StaveTie) => {
      t.setStyle({ fillStyle: theme.ink, strokeStyle: theme.ink });
      t.setContext(ctx).draw();
    };
    if (sameLine) {
      draw(new StaveTie({ firstNote: a.note, lastNote: b.note, firstIndexes: first, lastIndexes: last }));
    } else {
      draw(new StaveTie({ firstNote: a.note, lastNote: null, firstIndexes: first, lastIndexes: first }));
      draw(new StaveTie({ firstNote: null, lastNote: b.note, firstIndexes: last, lastIndexes: last }));
    }
  }
  void staves;
}

function cursorBox(
  cursor: number,
  total: number,
  notes: Array<{ note: StaveNote; logical: number }>,
  staves: Array<{ stave: Stave; built: BuiltMeasure }>,
): CursorBox | null {
  const box = (x: number, stave: Stave): CursorBox => ({ x, y: stave.getYForLine(0) - 18, height: STAVE_HEIGHT + 36 });
  if (cursor < total) {
    const target = notes.find((n) => n.logical === cursor);
    if (!target) return null;
    return box(target.note.getAbsoluteX() - 8, target.note.getStave()!);
  }
  // depois do último evento: no compasso livre do fim, ou logo após a última nota
  const lastStave = staves[staves.length - 1];
  if (!lastStave) return null;
  if (lastStave.built.emptyRest) return box(lastStave.stave.getNoteStartX() + 6, lastStave.stave);
  const lastNote = lastStave.built.notes[lastStave.built.notes.length - 1];
  return box(lastNote.getAbsoluteX() + lastNote.getWidth() + 14, lastStave.stave);
}
