import {
  Accidental,
  Beam,
  BarlineType,
  Dot,
  Formatter,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Stem,
  Tuplet,
  Voice,
} from 'vexflow/bravura';
import type { Fraction } from '../model/fraction';
import type { MusicEvent, Score, Staff } from '../model/score';
import { allStaves, effectiveKey, effectiveTimeSignature, eventValue, MAX_VOICES, measureCapacity, voiceLength } from '../model/score';
import { VEX_DURATION } from '../model/duration';
import { vexKey } from '../model/key';
import type { Clef, Pitch } from '../model/pitch';
import { clefMiddle, diatonicIndex, fromDiatonicIndex } from '../model/pitch';
import { measureStarts } from '../model/sequence';
import { validateVoice } from '../model/validation';
import type { Position } from '../editor/editor';

/**
 * Motor de layout + desenho. O VexFlow cuida de hastes, barras de colcheia,
 * acidentes, quiálteras e glifos SMuFL (fonte Bravura); este módulo cuida do
 * layout da página: sistemas com várias pautas, largura de cada compasso,
 * quebra de linha e justificação.
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
  /** trecho selecionado (índices lógicos [from, to)) numa pauta/voz */
  selection: { pos: Position; from: number; to: number } | null;
  /** momento tocando agora, em semibreves desde o início */
  playingTime: number | null;
  cursor: { pos: Position; index: number } | null;
  theme: RenderTheme;
  /** Desenha num canvas (para o PDF) em vez de SVG, com esta escala de pixels. */
  canvas?: { element: HTMLCanvasElement; scale: number };
}

export interface CursorBox {
  x: number;
  y: number;
  height: number;
}

export interface Hit {
  pos: Position;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderResult {
  height: number;
  cursor: CursorBox | null;
  /** caixas de clique por evento lógico */
  hits: Hit[];
  /** faixa vertical de cada sistema (linha de pautas), para paginar */
  systems: Array<{ top: number; bottom: number }>;
}

const STAFF_GAP = 82; // distância entre pautas do mesmo instrumento
const PART_GAP = 100; // distância entre instrumentos
const SYSTEM_EXTRA = 70; // espaço depois de cada sistema
const TOP = 24;
const MARGIN_X = 18;
const MIN_MEASURE = 120;
const VOICE_COLORS_ALPHA = ['', 'cc', 'cc', 'cc'];

const VEX_CLEF: Record<Clef, string> = { treble: 'treble', bass: 'bass', alto: 'alto', tenor: 'tenor' };

function vexKeyOf(p: Pitch): string {
  const acc = { [-2]: 'bb', [-1]: 'b', 0: '', 1: '#', 2: '##' }[p.alter];
  return `${p.step.toLowerCase()}${acc}/${p.octave}`;
}

/** Posição da pausa: no meio da pauta, ou deslocada para cima/baixo com várias vozes. */
function restKey(clef: Clef, voiceIndex: number, multi: boolean): string {
  const mid = diatonicIndex(clefMiddle(clef));
  const shift = !multi ? 0 : voiceIndex % 2 === 0 ? 2 : -2;
  return vexKeyOf(fromDiatonicIndex(mid + shift));
}

function sortedNotes(e: MusicEvent) {
  if (e.kind !== 'chord') return [];
  return [...e.notes].sort((a, b) => diatonicIndex(a.pitch) - diatonicIndex(b.pitch));
}

interface StaffRef {
  staff: Staff;
  partIndex: number;
  staffIndex: number;
}

interface BuiltVoice {
  voiceIndex: number;
  notes: StaveNote[];
  voice: Voice;
  /** índice lógico de cada nota (-1 = pausa de compasso vazio) */
  logical: number[];
  events: Array<MusicEvent | null>;
  /** início de cada nota, em semibreves desde o começo */
  onsets: number[];
  ends: number[];
  tuplets: Tuplet[];
  beams: Beam[];
  full: boolean;
}

interface BuiltStaffMeasure {
  ref: StaffRef;
  voices: BuiltVoice[];
}

/** Mapa id do evento → índice lógico, por voz (pedaços ligados apontam para o original). */
function logicalIndex(staff: Staff, voiceIndex: number): Map<string, number> {
  const map = new Map<string, number>();
  let i = 0;
  for (const m of staff.measures) {
    for (const e of m.voices[voiceIndex]?.events ?? []) {
      if (e.kind === 'rest' && e.filler) continue;
      if (e.fragmentOf && map.has(e.fragmentOf)) continue;
      map.set(e.id, i++);
    }
  }
  return map;
}

type LogicalMaps = Map<Staff, Map<string, number>[]>;

function buildStaffMeasure(
  score: Score,
  ref: StaffRef,
  mi: number,
  start: Fraction,
  maps: LogicalMaps,
  theme: RenderTheme,
): BuiltStaffMeasure {
  const { staff } = ref;
  const measure = staff.measures[mi];
  const ts = effectiveTimeSignature(score, mi);
  const clef = VEX_CLEF[staff.clef];
  const voicesWithContent = measure.voices.map((v, i) => (v.events.length ? i : -1)).filter((i) => i >= 0);
  const multi = voicesWithContent.length > 1 || voicesWithContent.some((i) => i > 0);
  const built: BuiltVoice[] = [];

  for (let vi = 0; vi < Math.max(1, measure.voices.length); vi++) {
    const events = measure.voices[vi]?.events ?? [];
    if (!events.length && vi > 0) continue;
    const notes: StaveNote[] = [];
    const logical: number[] = [];
    const evs: Array<MusicEvent | null> = [];
    const onsets: number[] = [];
    const ends: number[] = [];
    const map = maps.get(staff)![vi];
    let t = start;
    const stemDir = multi ? (vi % 2 === 0 ? Stem.UP : Stem.DOWN) : undefined;
    const ink = vi === 0 ? theme.ink : theme.ink + VOICE_COLORS_ALPHA[vi];

    for (const e of events) {
      const base = { duration: VEX_DURATION[e.duration.type], dots: e.duration.dots, clef };
      const note =
        e.kind === 'rest'
          ? new StaveNote({ ...base, keys: [restKey(staff.clef, vi, multi)], type: 'r' })
          : new StaveNote({ ...base, keys: sortedNotes(e).map((n) => vexKeyOf(n.pitch)), autoStem: stemDir === undefined, ...(stemDir !== undefined ? { stemDirection: stemDir } : {}) });
      // pausas provisórias das vozes 2–4 ficam invisíveis (só ocupam o tempo)
      const color = e.kind === 'rest' && e.auto && vi > 0 ? 'transparent' : e.kind === 'rest' && e.placeholder ? theme.muted : ink;
      note.setStyle({ fillStyle: color, strokeStyle: color });
      note.setLedgerLineStyle({ strokeStyle: theme.ink, lineWidth: 1.4 });
      if (e.duration.dots) Dot.buildAndAttach([note], { all: true });
      notes.push(note);
      logical.push(map.get(e.fragmentOf ?? e.id) ?? -1);
      evs.push(e);
      onsets.push(t.toNumber());
      t = t.add(eventValue(e));
      ends.push(t.toNumber());
    }

    if (!notes.length) {
      const rest = new StaveNote({ keys: [restKey(staff.clef, 0, false)], duration: 'w', type: 'r', alignCenter: true, clef });
      rest.setStyle({ fillStyle: theme.muted, strokeStyle: theme.muted });
      notes.push(rest);
      logical.push(-1);
      evs.push(null);
      onsets.push(start.toNumber());
      ends.push(start.toNumber());
    }

    // quiálteras: agrupa notas consecutivas com o mesmo tuplet.id (antes de entrarem na voz)
    const tuplets: Tuplet[] = [];
    for (let i = 0; i < evs.length; ) {
      const tp = evs[i]?.tuplet;
      if (!tp) {
        i++;
        continue;
      }
      let j = i;
      while (j < evs.length && evs[j]?.tuplet?.id === tp.id) j++;
      const tuplet = new Tuplet(notes.slice(i, j), { numNotes: tp.actual, notesOccupied: tp.normal, bracketed: true, ratioed: false });
      tuplet.setStyle({ fillStyle: ink, strokeStyle: ink });
      tuplets.push(tuplet);
      i = j;
    }

    const voice = new Voice({ numBeats: ts.beats, beatValue: ts.beatType }).setMode(Voice.Mode.SOFT);
    voice.addTickables(notes);
    const full = validateVoice(measure, ts, vi).state === 'complete';
    built.push({ voiceIndex: vi, notes, voice, logical, events: evs, onsets, ends, tuplets, beams: [], full });
  }

  Accidental.applyAccidentals(
    built.map((b) => b.voice),
    vexKey(effectiveKey(score, mi)),
  );
  return { ref, voices: built };
}

function beamAll(b: BuiltStaffMeasure, tsString: string, theme: RenderTheme) {
  for (const v of b.voices) {
    if (!v.events.some((e) => e?.kind === 'chord')) continue;
    v.beams = Beam.generateBeams(v.notes, { groups: Beam.getDefaultBeamGroups(tsString), maintainStemDirections: b.voices.length > 1 });
    for (const beam of v.beams) beam.setStyle({ fillStyle: theme.ink, strokeStyle: theme.ink });
  }
}

/** Largura do cabeçalho (clave, armadura, fórmula) no começo de um compasso. */
function headerWidth(score: Score, mi: number, firstInLine: boolean, clefs: Clef[]): number {
  let max = 0;
  for (const clef of clefs) {
    const s = new Stave(0, 0, 500);
    decorate(s, score, mi, firstInLine, clef);
    max = Math.max(max, s.getNoteStartX() - s.getX());
  }
  return firstInLine ? max : Math.max(0, max - 10);
}

function timeChanges(score: Score, mi: number): boolean {
  if (mi === 0) return true;
  const a = effectiveTimeSignature(score, mi);
  const b = effectiveTimeSignature(score, mi - 1);
  return a.beats !== b.beats || a.beatType !== b.beatType;
}

function keyChanges(score: Score, mi: number): boolean {
  return mi > 0 && effectiveKey(score, mi) !== effectiveKey(score, mi - 1);
}

/** Acrescenta clave/armadura/fórmula conforme a posição do compasso. */
function decorate(stave: Stave, score: Score, mi: number, firstInLine: boolean, clef: Clef) {
  const ts = effectiveTimeSignature(score, mi);
  if (firstInLine) {
    stave.addClef(VEX_CLEF[clef]);
    stave.addKeySignature(vexKey(effectiveKey(score, mi)));
  } else if (keyChanges(score, mi)) {
    stave.addKeySignature(vexKey(effectiveKey(score, mi)), vexKey(effectiveKey(score, mi - 1)));
  }
  if (timeChanges(score, mi)) stave.addTimeSignature(`${ts.beats}/${ts.beatType}`);
}

export function renderScore(container: HTMLElement, score: Score, opts: RenderOptions): RenderResult {
  if (!opts.canvas) container.innerHTML = '';
  const { theme } = opts;
  const refs: StaffRef[] = allStaves(score).map(({ staff, partIndex, staffIndex }) => ({ staff, partIndex, staffIndex }));
  const measureCount = refs[0].staff.measures.length;
  const starts = measureStarts(score, measureCount);
  const maps: LogicalMaps = new Map(refs.map((r) => [r.staff, Array.from({ length: MAX_VOICES }, (_, v) => logicalIndex(r.staff, v))]));
  const clefs = refs.map((r) => r.staff.clef);
  const showNames = score.parts.length > 1;
  const nameWidth = showNames ? Math.max(...score.parts.map((p) => p.name.length)) * 7 + 16 : 0;

  // 1ª passada: largura mínima de cada compasso (considerando todas as pautas)
  const minWidths = Array.from({ length: measureCount }, (_, mi) => {
    const built = refs.map((r) => buildStaffMeasure(score, r, mi, starts[mi], maps, theme));
    const formatter = new Formatter();
    const all = built.flatMap((b) => b.voices.map((v) => v.voice));
    for (const b of built) formatter.joinVoices(b.voices.map((v) => v.voice));
    const w = formatter.preCalculateMinTotalWidth(all);
    return Math.max(MIN_MEASURE, w * 1.3 + 44);
  });

  const usable = Math.max(300, opts.width - MARGIN_X * 2);

  // quebra de linha gulosa
  const systems: number[][] = [];
  let line: number[] = [];
  let lineW = 0;
  for (let mi = 0; mi < measureCount; mi++) {
    const avail = usable - (systems.length === 0 ? nameWidth : 0);
    const w = minWidths[mi] + headerWidth(score, mi, line.length === 0, clefs);
    if (line.length > 0 && lineW + w > avail) {
      systems.push(line);
      line = [];
      lineW = minWidths[mi] + headerWidth(score, mi, true, clefs);
    } else {
      lineW += w;
    }
    line.push(mi);
  }
  if (line.length) systems.push(line);

  // posição vertical de cada pauta dentro do sistema
  const offsets: number[] = [];
  let off = 0;
  refs.forEach((r, i) => {
    if (i > 0) off += r.partIndex === refs[i - 1].partIndex ? STAFF_GAP : PART_GAP;
    offsets.push(off);
  });
  const systemHeight = off + 40 + SYSTEM_EXTRA + 40;

  const height = TOP + systems.length * systemHeight + 10;
  const renderer = opts.canvas
    ? new Renderer(opts.canvas.element, Renderer.Backends.CANVAS)
    : new Renderer(container as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(opts.width, height);
  const ctx = renderer.getContext();
  if (opts.canvas) (ctx as unknown as { resize(w: number, h: number, dpr: number): void }).resize(opts.width, height, opts.canvas.scale);
  ctx.setFillStyle(theme.ink);
  ctx.setStrokeStyle(theme.ink);

  /** Notas desenhadas, por pauta+voz, na ordem da música. */
  const drawn = new Map<string, Array<{ note: StaveNote; logical: number; event: MusicEvent | null; mi: number; full: boolean; stave: Stave }>>();
  const staveAt = new Map<string, Stave>(); // `${refIndex}:${mi}`
  const hits: Hit[] = [];
  const posKey = (r: StaffRef, v: number) => `${r.partIndex}:${r.staffIndex}:${v}`;
  const sel = opts.selection;
  const inSel = (r: StaffRef, v: number, li: number) =>
    !!sel && sel.pos.partIndex === r.partIndex && sel.pos.staffIndex === r.staffIndex && sel.pos.voiceIndex === v && li >= sel.from && li < sel.to;

  systems.forEach((sys, si) => {
    const top = TOP + si * systemHeight;
    const left = MARGIN_X + (si === 0 ? nameWidth : 0);
    const avail = usable - (si === 0 ? nameWidth : 0);
    const widths = sys.map((mi, k) => minWidths[mi] + headerWidth(score, mi, k === 0, clefs));
    const naturalW = widths.reduce((a, b) => a + b, 0);
    const isLast = si === systems.length - 1;
    // justifica: estica proporcionalmente, exceto a última linha se estiver curta
    const scale = isLast && naturalW < avail * 0.7 ? 1 : avail / naturalW;
    let x = left;
    const firstStaves: Stave[] = [];
    const lastStaves: Stave[] = [];

    sys.forEach((mi, k) => {
      const w = widths[k] * scale;
      const ts = effectiveTimeSignature(score, mi);
      const staves = refs.map((r, ri) => {
        const stave = new Stave(x, top + offsets[ri], w);
        decorate(stave, score, mi, k === 0, r.staff.clef);
        if (k === 0 && ri === 0 && mi > 0) stave.setMeasure(mi + 1);
        if (mi === measureCount - 1) stave.setEndBarType(BarlineType.END);
        else if (keyChanges(score, mi + 1)) stave.setEndBarType(BarlineType.DOUBLE);
        stave.setStyle({ strokeStyle: theme.muted, fillStyle: theme.ink });
        stave.setContext(ctx).draw();
        staveAt.set(`${ri}:${mi}`, stave);
        return stave;
      });
      if (k === 0) firstStaves.push(...staves);
      if (k === sys.length - 1) lastStaves.push(...staves);

      // barras atravessando as pautas do mesmo instrumento
      for (const part of groupByPart(refs)) {
        if (part.length < 2) continue;
        const c = new StaveConnector(staves[part[0]], staves[part[part.length - 1]]);
        c.setType(mi === measureCount - 1 ? 'boldDoubleRight' : 'singleRight');
        c.setStyle({ strokeStyle: theme.muted, fillStyle: theme.ink });
        c.setContext(ctx).draw();
      }

      const built = refs.map((r) => buildStaffMeasure(score, r, mi, starts[mi], maps, theme));
      const tsString = `${ts.beats}/${ts.beatType}`;
      built.forEach((b) => beamAll(b, tsString, theme));

      // destaques (seleção e reprodução)
      built.forEach((b) =>
        b.voices.forEach((v) =>
          v.notes.forEach((n, i) => {
            const li = v.logical[i];
            if (li < 0) return;
            const playingNow = opts.playingTime !== null && v.onsets[i] <= opts.playingTime + 1e-9 && opts.playingTime < v.ends[i] - 1e-9;
            if (playingNow) n.setStyle({ fillStyle: theme.playing, strokeStyle: theme.playing });
            else if (inSel(b.ref, v.voiceIndex, li)) n.setStyle({ fillStyle: theme.accent, strokeStyle: theme.accent });
          }),
        ),
      );

      // um formatador para todas as pautas: notas simultâneas ficam alinhadas na vertical
      const formatter = new Formatter();
      for (const b of built) formatter.joinVoices(b.voices.map((v) => v.voice));
      const startX = Math.max(...staves.map((s) => s.getNoteStartX())) + 8;
      staves.forEach((s) => s.setNoteStartX(startX));
      const available = staves[0].getNoteEndX() - startX - 20;
      formatter.format(
        built.flatMap((b) => b.voices.map((v) => v.voice)),
        Math.max(40, available),
      );

      built.forEach((b, ri) => {
        const stave = staves[ri];
        for (const v of b.voices) {
          v.voice.draw(ctx, stave);
          for (const beam of v.beams) beam.setContext(ctx).draw();
          for (const t of v.tuplets) t.setContext(ctx).draw();
          const key = posKey(b.ref, v.voiceIndex);
          if (!drawn.has(key)) drawn.set(key, []);
          v.notes.forEach((n, i) => {
            const li = v.logical[i];
            drawn.get(key)!.push({ note: n, logical: li, event: v.events[i], mi, full: v.full, stave });
            if (li >= 0) {
              const bb = n.getBoundingBox();
              hits.push({
                pos: { partIndex: b.ref.partIndex, staffIndex: b.ref.staffIndex, voiceIndex: v.voiceIndex },
                index: li,
                x: bb.getX() - 4,
                y: stave.getYForLine(0) - 22,
                w: bb.getW() + 8,
                h: 40 + 44,
              });
            }
          });
        }
        // compasso cheio demais ou faltando (exceto o último, que está sendo escrito)
        const v0 = refs[ri].staff.measures[mi].voices[0];
        const laterContent = refs[ri].staff.measures.slice(mi + 1).some((m) => m.voices[0]?.events.length);
        if (laterContent && v0 && voiceLength(v0).lt(measureCapacity(ts))) {
          ctx.save();
          ctx.setFillStyle(theme.warn);
          ctx.fillRect(stave.getX() + 2, stave.getYForLine(4) + 14, w - 4, 3);
          ctx.restore();
        }
      });
      x += w;
    });

    // conectores no começo do sistema: linha única e chave do piano
    if (firstStaves.length > 1) {
      const c = new StaveConnector(firstStaves[0], firstStaves[firstStaves.length - 1]);
      c.setType('singleLeft');
      c.setStyle({ strokeStyle: theme.muted, fillStyle: theme.ink });
      c.setContext(ctx).draw();
    }
    for (const part of groupByPart(refs)) {
      const p = score.parts[refs[part[0]].partIndex];
      const a = firstStaves[part[0]];
      const b = firstStaves[part[part.length - 1]];
      if (part.length > 1) {
        const brace = new StaveConnector(a, b);
        brace.setType('brace');
        brace.setStyle({ strokeStyle: theme.ink, fillStyle: theme.ink });
        brace.setContext(ctx).draw();
      }
      if (si === 0 && showNames) {
        ctx.save();
        ctx.setFont('Manrope, sans-serif', 12, 'bold');
        ctx.setFillStyle(theme.ink);
        const midY = (a.getYForLine(0) + b.getYForLine(4)) / 2 + 4;
        ctx.fillText(p.name, MARGIN_X, midY);
        ctx.restore();
      }
    }
    void lastStaves;
  });

  for (const list of drawn.values()) drawTies(ctx, list, theme);

  const systemBounds = systems.map((_, si) => {
    const top = TOP + si * systemHeight;
    return { top: Math.max(0, top - 10), bottom: Math.min(height, top + systemHeight - SYSTEM_EXTRA + 30) };
  });
  return { height, cursor: opts.cursor ? cursorBox(opts.cursor, refs, drawn, staveAt, posKey) : null, hits, systems: systemBounds };
}

function groupByPart(refs: StaffRef[]): number[][] {
  const groups: number[][] = [];
  refs.forEach((r, i) => {
    if (i > 0 && refs[i - 1].partIndex === r.partIndex) groups[groups.length - 1].push(i);
    else groups.push([i]);
  });
  return groups;
}

function drawTies(
  ctx: ReturnType<Renderer['getContext']>,
  notes: Array<{ note: StaveNote; event: MusicEvent | null }>,
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
}

function cursorBox(
  cursor: { pos: Position; index: number },
  refs: StaffRef[],
  drawn: Map<string, Array<{ note: StaveNote; logical: number; mi: number; full: boolean; stave: Stave }>>,
  staveAt: Map<string, Stave>,
  posKey: (r: StaffRef, v: number) => string,
): CursorBox | null {
  const ri = refs.findIndex((r) => r.partIndex === cursor.pos.partIndex && r.staffIndex === cursor.pos.staffIndex);
  if (ri < 0) return null;
  const box = (x: number, stave: Stave): CursorBox => ({ x, y: stave.getYForLine(0) - 18, height: 40 + 36 });
  const list = (drawn.get(posKey(refs[ri], cursor.pos.voiceIndex)) ?? []).filter((n) => n.logical >= 0);
  const target = list.find((n) => n.logical === cursor.index);
  if (target) return box(target.note.getAbsoluteX() - 8, target.stave);
  // depois do último evento da voz
  const last = list[list.length - 1];
  if (!last) {
    const s = staveAt.get(`${ri}:0`);
    return s ? box(s.getNoteStartX() + 6, s) : null;
  }
  if (last.full) {
    const next = staveAt.get(`${ri}:${last.mi + 1}`);
    if (next) return box(next.getNoteStartX() + 6, next);
  }
  return box(last.note.getAbsoluteX() + last.note.getWidth() + 14, last.stave);
}
