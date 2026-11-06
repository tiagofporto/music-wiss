import './ui/style.css';
import { Editor, TUPLET_NORMAL } from './editor/editor';
import { AudioEngine } from './audio/engine';
import { connectMidi } from './input/midi-input';
import type { MidiNote } from './input/midi-input';
import { loadStoredSoundFont, storeSoundFont, forgetSoundFont } from './audio/soundfont-store';
import { schedule } from './audio/sequencer';
import { DURATION_NAMES_PT, DURATION_ORDER } from './model/duration';
import type { Fifths } from './model/key';
import { keyName } from './model/key';
import { pitchLabel, spellMidi, toMidi } from './model/pitch';
import type { Step } from './model/pitch';
import type { Score } from './model/score';
import type { Articulation, Dynamic } from './model/score';
import { ARTICULATION_NAMES_PT, ARTICULATIONS, barMark, DYNAMICS, createScore, effectiveKey, effectiveTimeSignature, INSTRUMENTS, MAX_VOICES, migrateScore } from './model/score';
import { describeValidation, validateVoice } from './model/validation';
import { Fraction } from './model/fraction';
import { DYNAMIC_GLYPH, renderScore } from './render/renderer';
import type { Session } from '@supabase/supabase-js';
import * as cloud from './cloud/cloud';
import type { AssistantAnswer, CloudDoc, CloudScoreRow, Role, ShareLink } from './cloud/cloud';
import { cloudConfig, configFromBuild, saveCloudConfig, validateConfig } from './cloud/config';
import { describeForAssistant } from './ai/describe';
import type { RenderResult, RenderTheme } from './render/renderer';
import type { Command } from './ui/commands';
import { DURATION_GLYPH, DURATION_KEYS, GLYPH, SHORTCUTS } from './ui/commands';
import { ICON } from './ui/icons';
import { exportMusicXml } from './io/musicxml-export';
import { importMusicXml, readMusicXmlFile } from './io/musicxml-import';
import { importMidi } from './io/midi-import';
import type { Annotation, AnnotationTool, LayerState, TextRequest } from './annotate/annotations';
import { ANNOTATION_COLORS, AnnotationLayer, STAMP_FONT_EMOJI, STAMP_FONT_MONO, STAMP_GROUPS, stampTakesColor } from './annotate/annotations';
import type { OpenDocument } from './doc/document';
import { exportAnnotatedPdf, imageType, isPdf, openDocument, pagesAsJpeg } from './doc/document';
import type { StoredDoc } from './doc/doc-store';
import { deleteDoc, docId, listDocs, loadDoc, saveDoc } from './doc/doc-store';
import type { Transcription } from './ai/transcription';
import { transcriptionToScore } from './ai/transcription';
import { exportMidi } from './io/midi';

const STORAGE_KEY = 'music-wiss:score';
const THEME_KEY = 'music-wiss:theme';

// ---------------------------------------------------------------- estado

const editor = new Editor(loadSaved() ?? demoScore());
const engine = new AudioEngine();
let midiLink: { disconnect: () => void } | null = null;
let midiDevices: string[] = [];
let soundLoading: string | null = null;
let lastRender: RenderResult | null = null;
let playing: { timers: number[]; time: number | null } | null = null;

// ---------------------------------------------------------------- DOM

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand"><img src="/favicon.svg" alt="" /><span>Music Wiss</span></div>
    <div class="spacer"></div>
    <button class="icon-btn" data-act="palette" title="Paleta de comandos (Ctrl+K)">${ICON.search}<span>Comandos</span><span class="kbd">Ctrl K</span></button>
    <button class="icon-btn" data-act="new" title="Nova partitura">${ICON.plus}<span>Nova</span></button>
    <div class="menu">
      <button class="icon-btn" data-act="file-menu" aria-haspopup="true" title="Abrir e exportar">${ICON.download}<span>Arquivo</span></button>
      <div class="menu-list" hidden>
        <button data-act="open">${ICON.upload}<span>Abrir…</span><small>MusicXML, MIDI, PDF, foto, .wiss.json</small></button>
        <button data-act="docs">${ICON.doc}<span>Documentos recentes</span><small>PDFs e fotos com marcações</small></button>
        <button data-act="save">${ICON.download}<span>Salvar</span><small>.wiss.json · Ctrl S</small></button>
        <hr />
        <button data-act="export-pdf"><span class="fmt">PDF</span><span>Exportar PDF</span><small>para imprimir</small></button>
        <button data-act="export-xml"><span class="fmt">XML</span><span>Exportar MusicXML</span><small>abre em outros programas</small></button>
        <button data-act="export-midi"><span class="fmt">MID</span><span>Exportar MIDI</span><small>sequenciadores e DAWs</small></button>
      </div>
    </div>
    <button class="icon-btn mark-btn" data-act="mark" title="Marcar por cima da partitura (M)">${ICON.pen}<span>Marcar</span></button>
    <button class="icon-btn" data-act="assistant" title="Assistente: harmonizar e revisar">${ICON.sparkle}<span>Assistente</span></button>
    <button class="icon-btn cloud-btn" data-act="cloud" title="Nuvem: conta, partituras e compartilhar">${ICON.cloud}<span>Nuvem</span><span class="cloud-dot" hidden></span></button>
    <button class="icon-btn" data-act="sound" title="Som, volumes e teclado MIDI">${ICON.speaker}<span>Som</span><span class="midi-led" hidden></span></button>
    <button class="icon-btn" data-act="theme" title="Tema claro/escuro"></button>
    <button class="icon-btn primary" data-act="play" title="Tocar (Espaço)"></button>
  </header>

  <main class="stage">
    <article class="sheet">
      <div class="sheet-head">
        <input class="sheet-title" data-field="title" spellcheck="false" aria-label="Título" />
        <div class="sheet-meta">
          <label class="tempo"><span class="smufl" style="font-size:20px"></span> = <input data-field="tempo" type="number" min="20" max="300" aria-label="Andamento" /></label>
          <input class="composer" data-field="composer" placeholder="Compositor" aria-label="Compositor" />
        </div>
      </div>
      <div class="score" tabindex="0" aria-label="Partitura"></div>
      <div class="empty-hint" hidden>
        Aperte <span class="kbd">N</span> para começar a escrever e use as letras
        <span class="kbd">A</span>–<span class="kbd">G</span> para as notas.
        As figuras ficam nos números <span class="kbd">1</span>–<span class="kbd">6</span>.
        Veja todos os atalhos com <span class="kbd">?</span>.
      </div>
    </article>
    <section class="doc-view" hidden aria-label="Documento">
      <div class="doc-head">
        <div class="doc-name"></div>
        <div class="doc-actions">
          <button class="icon-btn" data-act="doc-analyze">${ICON.sparkle}<span>Ler e analisar com IA</span></button>
          <button class="icon-btn" data-act="doc-export">${ICON.download}<span>Baixar com marcações</span></button>
          <button class="icon-btn" data-act="doc-close">Voltar à partitura</button>
        </div>
      </div>
      <div class="doc-pages"></div>
    </section>
  </main>
  <div class="annot-bar" role="toolbar" aria-label="Marcações" hidden></div>
  <div class="annot-pop" hidden></div>

  <aside class="status" aria-live="polite"></aside>
  <section class="expr-panel" aria-label="Expressão" hidden></section>
  <nav class="dock" aria-label="Ferramentas de escrita"></nav>

  <div class="overlay" data-overlay="palette" hidden>
    <div class="panel palette">
      <input placeholder="Buscar comando, figura, tonalidade..." />
      <ul></ul>
    </div>
  </div>
  <div class="overlay" data-overlay="new" hidden>
    <form class="panel dialog">
      <h2>Nova partitura</h2>
      <div class="form-grid">
        <label class="wide">Título<input name="title" value="Sem título" /></label>
        <label>Compositor<input name="composer" /></label>
        <fieldset class="wide instruments"><legend>Instrumentos</legend>${INSTRUMENTS.map((i) => `<label class="pick"><input type="checkbox" name="instrument" value="${i.id}" ${i.id === 'piano' ? 'checked' : ''} /><span>${i.name}</span></label>`).join('')}</fieldset>
        <label>Fórmula de compasso<select name="time">${['4/4', '3/4', '2/4', '6/8', '9/8', '12/8', '5/4', '2/2'].map((t) => `<option>${t}</option>`).join('')}</select></label>
        <label>Tonalidade<select name="key">${Array.from({ length: 15 }, (_, i) => i - 7).map((f) => `<option value="${f}" ${f === 0 ? 'selected' : ''}>${keyName(f as Fifths)}</option>`).join('')}</select></label>
        <label>Andamento (semínima)<input name="tempo" type="number" value="96" min="20" max="300" /></label>
      </div>
      <div class="dialog-actions">
        <button type="button" class="icon-btn" data-close>Cancelar</button>
        <button type="submit" class="icon-btn primary">Criar</button>
      </div>
    </form>
  </div>
  <div class="overlay" data-overlay="help" hidden>
    <div class="panel dialog">
      <h2>Atalhos</h2>
      <dl class="shortcuts">${SHORTCUTS.map(([k, d]) => `<dt><span class="kbd">${k}</span></dt><dd>${d}</dd>`).join('')}</dl>
      <div class="dialog-actions"><button type="button" class="icon-btn" data-close>Fechar</button></div>
    </div>
  </div>
  <div class="overlay" data-overlay="sound" hidden>
    <div class="panel dialog sound-panel">
      <h2>Som</h2>
      <div class="sound-body"></div>
      <div class="dialog-actions"><button type="button" class="icon-btn" data-close>Fechar</button></div>
    </div>
  </div>
  <div class="overlay" data-overlay="cloud" hidden>
    <div class="panel dialog cloud-panel">
      <h2>Nuvem</h2>
      <div class="cloud-body"></div>
      <div class="dialog-actions"><button type="button" class="icon-btn" data-close>Fechar</button></div>
    </div>
  </div>
  <div class="overlay" data-overlay="assistant" hidden>
    <div class="panel dialog assistant-panel">
      <h2>Assistente</h2>
      <div class="assistant-body"></div>
      <div class="dialog-actions"><button type="button" class="icon-btn" data-close>Fechar</button></div>
    </div>
  </div>
  <div class="overlay" data-overlay="analysis" hidden>
    <div class="panel dialog assistant-panel">
      <h2>Ler e analisar</h2>
      <div class="analysis-body"></div>
      <div class="dialog-actions"><button type="button" class="icon-btn" data-close>Fechar</button></div>
    </div>
  </div>
  <div class="overlay" data-overlay="docs" hidden>
    <div class="panel dialog assistant-panel">
      <h2>Documentos recentes</h2>
      <div class="docs-body"></div>
      <div class="dialog-actions"><button type="button" class="icon-btn" data-close>Fechar</button></div>
    </div>
  </div>
  <div class="overlay" data-overlay="confirm" hidden>
    <div class="panel dialog confirm-panel" role="alertdialog" aria-modal="true">
      <h2></h2>
      <p class="confirm-msg"></p>
      <div class="dialog-actions">
        <button type="button" class="icon-btn" data-confirm="cancel">Cancelar</button>
        <button type="button" class="icon-btn danger" data-confirm="ok"></button>
      </div>
    </div>
  </div>
  <div class="toast"></div>
  <input type="file" accept=".sf2,.sf3" hidden data-soundfont />
  <input type="file" accept=".json,.musicxml,.xml,.mxl,.mid,.midi,.pdf,.jpg,.jpeg,.png,.webp,application/json,application/xml,audio/midi,application/pdf,image/*" hidden data-file />
  <div class="drop-hint" hidden>Solte o arquivo para abrir</div>
`;

const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
const scoreEl = $<HTMLDivElement>('.score');
const dockEl = $<HTMLElement>('.dock');
const statusEl = $<HTMLElement>('.status');
const hintEl = $<HTMLElement>('.empty-hint');
const titleInput = $<HTMLInputElement>('[data-field="title"]');
const composerInput = $<HTMLInputElement>('[data-field="composer"]');
const tempoInput = $<HTMLInputElement>('[data-field="tempo"]');

// ---------------------------------------------------------------- tema

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  safeSet(THEME_KEY, theme);
  $('[data-act="theme"]').innerHTML = theme === 'dark' ? ICON.sun : ICON.moon;
  render();
}

function renderTheme(): RenderTheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { ink: v('--ink'), muted: v('--muted'), accent: v('--accent'), playing: v('--play'), warn: v('--warn') };
}

// ---------------------------------------------------------------- render

function render() {
  const score = editor.score;
  if (document.activeElement !== titleInput) titleInput.value = score.title;
  if (document.activeElement !== composerInput) composerInput.value = score.composer;
  if (document.activeElement !== tempoInput) tempoInput.value = String(score.tempo);

  const width = scoreEl.clientWidth || 900;
  lastRender = renderScore(scoreEl, score, {
    width,
    selection: playing ? null : (() => {
      const r = editor.range();
      return r ? { pos: editor.pos, from: r[0], to: r[1] } : null;
    })(),
    playingTime: playing?.time ?? null,
    cursor: editor.inputMode && !playing ? { pos: editor.pos, index: editor.cursor } : null,
    theme: renderTheme(),
  });
  if (lastRender.cursor) {
    const c = document.createElement('div');
    c.className = 'caret';
    Object.assign(c.style, { left: `${lastRender.cursor.x}px`, top: `${lastRender.cursor.y}px`, height: `${lastRender.cursor.height}px` });
    scoreEl.appendChild(c);
  }
  hintEl.hidden = editor.events().length > 0 || editor.inputMode || marking;
  attachScoreLayer();
  renderDock();
  renderExpr();
  placeEntry();
  renderStatus();
}

function renderDock() {
  const d = editor.duration;
  const sel = editor.selected();
  const alter = sel?.notes[0]?.pitch.alter;
  const durBtn = DURATION_ORDER.map((type, i) => {
    const on = editor.inputMode ? d.type === type : sel?.duration.type === type;
    return `<button data-dur="${type}" class="${on ? 'on' : ''}" title="${DURATION_NAMES_PT[type]} (${i + 1})"><span class="smufl">${DURATION_GLYPH[type]}</span><small>${i + 1}</small></button>`;
  }).join('');
  const dotOn = editor.inputMode ? d.dots > 0 : (sel?.duration.dots ?? 0) > 0;
  dockEl.innerHTML = `
    <button class="mode ${editor.inputMode ? 'on' : ''}" data-act="mode" title="Modo de escrita (N)"><span class="dot"></span>${editor.inputMode ? 'Escrevendo' : 'Escrever'}<small>N</small></button>
    <span class="sep"></span>
    ${durBtn}
    <button data-act="dot" class="${dotOn ? 'on' : ''}" title="Ponto de aumento (.)"><span class="smufl">${GLYPH.dot}</span><small>.</small></button>
    <button data-act="rest" title="Pausa (0)"><span class="smufl">${GLYPH.restQuarter}</span><small>0</small></button>
    <span class="sep"></span>
    <button data-act="flat" class="${alter === -1 ? 'on' : ''}" title="Bemol (−)"><span class="smufl">${GLYPH.flat}</span><small>−</small></button>
    <button data-act="natural" class="${alter === 0 && sel?.kind === 'chord' ? 'on' : ''}" title="Natural"><span class="smufl">${GLYPH.natural}</span></button>
    <button data-act="sharp" class="${alter === 1 ? 'on' : ''}" title="Sustenido (+)"><span class="smufl">${GLYPH.sharp}</span><small>+</small></button>
    <button data-act="tie" class="${sel?.notes.length && sel.notes.every((n) => n.tieToNext) ? 'on' : ''}" title="Ligadura (T)"><span class="smufl">${GLYPH.tie}</span><small>T</small></button>
    <button data-act="tuplet" title="Tercina (Shift+3)"><span class="tuplet-ico">3</span><small>⇧3</small></button>
    <button data-act="expr" class="expr-btn ${exprOpen ? 'on' : ''}" title="Dinâmicas, articulações, letra, cifras e repetições"><span class="smufl">${DYNAMIC_GLYPH.mf}</span><small>mais</small></button>
    <span class="sep"></span>
    <div class="voices" role="group" aria-label="Voz">${Array.from({ length: MAX_VOICES }, (_, v) => `<button data-voice="${v}" class="voice v${v} ${editor.pos.voiceIndex === v ? 'on' : ''}" title="Voz ${v + 1} (Alt+${v + 1})">${v + 1}</button>`).join('')}</div>
  `;
}

function renderStatus() {
  const score = editor.score;
  const measure = editor.cursorMeasure();
  const ts = effectiveTimeSignature(score, measure);
  const m = editor.staff.measures[measure];
  const v = m ? validateVoice(m, ts, editor.pos.voiceIndex) : null;
  const evs = editor.selectedEvents();
  const sel = evs.length === 1 ? evs[0] : null;
  const selText = evs.length > 1
    ? `${evs.length} eventos`
    : sel ? (sel.kind === 'rest' ? (sel.placeholder ? 'Espaço da quiáltera' : 'Pausa') : sel.notes.map((n) => pitchLabel(n.pitch)).join(' + ')) : '—';
  const part = score.parts[editor.pos.partIndex];
  const staffName = part.staves.length > 1 ? ` · pauta ${editor.pos.staffIndex + 1}` : '';
  statusEl.innerHTML = `
    <span class="chip"><span class="led ${v?.state ?? ''}"></span>Compasso <b>${measure + 1}</b> · ${ts.beats}/${ts.beatType} · ${v ? describeValidation(v) : ''}</span>
    <span class="chip">Selecionado <b>${selText}</b>${sel ? ` · ${DURATION_NAMES_PT[sel.duration.type]}${sel.duration.dots ? ' pontuada' : ''}${sel.tuplet ? ` (${sel.tuplet.actual}:${sel.tuplet.normal})` : ''}` : ''}</span>
    <span class="chip"><b>${part.name}</b>${staffName} · voz ${editor.pos.voiceIndex + 1} · ${keyName(effectiveKey(score, measure))}</span>
  `;
}

// ---------------------------------------------------------------- áudio

function sound(pitches: { step: Step; alter: number; octave: number }[] | undefined) {
  if (!pitches?.length || playing) return;
  const t = engine.now();
  const part = editor.score.parts[editor.pos.partIndex];
  syncMixer();
  for (const p of pitches) {
    engine.play({ bus: part.id, program: part.midiProgram, midi: toMidi(p as never) + part.transposition, when: t, duration: 0.45, velocity: 90 });
  }
}

/** Passa volume e mudo de cada instrumento para o motor de som. */
function syncMixer() {
  for (const part of editor.score.parts) engine.setBus(part.id, part.volume ?? 0.8, part.muted);
}

function togglePlay() {
  if (playing) return stopPlayback();
  const atEnd = editor.cursor >= editor.events().length;
  const from = atEnd ? Fraction.ZERO : editor.cursorTime();
  const { notes, steps, total } = schedule(editor.score, from);
  if (!notes.length) return toast('Nada para tocar ainda');
  syncMixer();
  const parts = editor.score.parts;
  const t0 = engine.now() + 0.08;
  for (const n of notes) {
    engine.play({ bus: parts[n.partIndex].id, program: n.program, midi: n.midi, when: t0 + n.start, duration: n.duration * n.gate, velocity: n.velocity });
  }
  const state = { timers: [] as number[], time: null as number | null };
  playing = state;
  for (const step of steps) {
    state.timers.push(window.setTimeout(() => {
      if (playing !== state) return;
      state.time = step.time;
      render();
    }, (step.at + 0.08) * 1000));
  }
  state.timers.push(window.setTimeout(stopPlayback, (total + 0.4) * 1000));
  updatePlayButton();
  render();
}

function stopPlayback() {
  if (!playing) return;
  playing.timers.forEach((t) => clearTimeout(t));
  playing = null;
  engine.stopAll();
  updatePlayButton();
  render();
}

function updatePlayButton() {
  $('[data-act="play"]').innerHTML = playing ? `${ICON.stop}<span>Parar</span>` : `${ICON.play}<span>Tocar</span>`;
}

// ---------------------------------------------------------------- teclado

const LETTERS: Record<string, Step> = { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E', f: 'F', g: 'G' };

function onKey(e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  const typing = target.matches('input, select, textarea');
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    return openPalette();
  }
  if (typing || anyOverlayOpen()) return;
  if (docView) return onDocKey(e, mod);
  if (e.key.toLowerCase() === 'm' && !mod && !e.altKey) {
    e.preventDefault();
    return toggleMarking();
  }
  if (marking) {
    if (e.key === 'Escape') return toggleMarking(false);
    if (onAnnotKey(e, mod)) return e.preventDefault();
    if (!mod) return; // letras e setas não editam a partitura enquanto marca
  }

  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    return e.shiftKey ? editor.redo() : editor.undo();
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    return editor.redo();
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    return exportJson();
  }
  if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    return $<HTMLInputElement>('[data-file]').click();
  }
  if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    return editor.selectAll();
  }
  if (mod && e.key.toLowerCase() === 'c') {
    const n = editor.copy();
    if (n) toast(`${n} ${n === 1 ? 'evento copiado' : 'eventos copiados'}`);
    return e.preventDefault();
  }
  if (mod && e.key.toLowerCase() === 'x') {
    const n = editor.cut();
    if (n) toast(`${n} ${n === 1 ? 'evento recortado' : 'eventos recortados'}`);
    return e.preventDefault();
  }
  if (mod && e.key.toLowerCase() === 'v') {
    if (!editor.paste()) toast('Nada copiado ainda');
    return e.preventDefault();
  }

  const key = e.key;
  const lower = key.toLowerCase();
  const digit = /^Digit(\d)$/.exec(e.code)?.[1];
  let handled = true;

  // Alt + 1–4: voz | Shift + 2,3,5,6,7: quiálteras | Alt + ↑/↓: pauta
  if (e.altKey && digit && Number(digit) >= 1 && Number(digit) <= MAX_VOICES) editor.setVoice(Number(digit) - 1);
  else if (e.shiftKey && !mod && digit && TUPLET_NORMAL[Number(digit)]) tuplet(Number(digit));
  else if (e.altKey && key === 'ArrowUp') editor.moveStaff(-1);
  else if (e.altKey && key === 'ArrowDown') editor.moveStaff(1);
  else if (lower === 'n' && !mod) editor.toggleInputMode();
  else if (key === 'Escape') {
    if (editor.hasRange()) editor.clearSelection();
    else editor.toggleInputMode(false);
  } else if (key === ' ') togglePlay();
  else if (key === '?') openOverlay('help');
  else if (DURATION_KEYS[key] && !mod) {
    if (editor.inputMode) editor.setDuration(DURATION_KEYS[key]);
    else editor.setSelectedDuration(DURATION_KEYS[key]);
  } else if (key === '.') editor.toggleDot();
  else if (key === '0' && editor.inputMode) editor.insertRest();
  else if (LETTERS[lower] && !mod && !e.altKey && editor.inputMode) {
    if (e.shiftKey) editor.addToChord(LETTERS[lower]);
    else editor.insertStep(LETTERS[lower]);
  } else if (key === '+' || key === '=') editor.shiftAlter(1);
  else if (key === '-' || key === '_') editor.shiftAlter(-1);
  else if (lower === 't' && !mod) editor.toggleTie();
  else if (lower === 's' && !mod && !e.altKey) editor.toggleArticulation(e.shiftKey ? 'staccatissimo' : 'staccato');
  else if (lower === 'v' && !mod && !e.altKey) editor.toggleArticulation(e.shiftKey ? 'marcato' : 'accent');
  else if (lower === 'u' && !mod && !e.altKey) editor.toggleArticulation('tenuto');
  else if (lower === 'l' && !mod && !e.altKey) openEntry('lyric');
  else if (lower === 'h' && !mod && !e.altKey) openEntry('chordSymbol');
  else if (key === 'ArrowLeft') editor.moveCursor(-1, e.shiftKey);
  else if (key === 'ArrowRight') editor.moveCursor(1, e.shiftKey);
  else if (key === 'ArrowUp') editor.transposeSelected(mod ? 'octave' : 'semitone', 1);
  else if (key === 'ArrowDown') editor.transposeSelected(mod ? 'octave' : 'semitone', -1);
  else if (key === 'Backspace') editor.deleteBackward();
  else if (key === 'Delete') editor.deleteForward();
  else if (key === '[') editor.stepDuration(-1);
  else if (key === ']') editor.stepDuration(1);
  else if (key === 'Home') editor.setCursor(0, e.shiftKey);
  else if (key === 'End') editor.setCursor(editor.events().length, e.shiftKey);
  else handled = false;

  if (handled) e.preventDefault();
}

function tuplet(n: number) {
  const err = editor.insertTuplet(n);
  if (err) toast(err);
}

// ---------------------------------------------------------------- paleta de comandos

function commands(): Command[] {
  const list: Command[] = [
    { id: 'mode', label: editor.inputMode ? 'Sair do modo de escrita' : 'Entrar no modo de escrita', hint: 'N', run: () => editor.toggleInputMode() },
    { id: 'play', label: playing ? 'Parar reprodução' : 'Tocar a partir do cursor', hint: 'Espaço', run: togglePlay },
    { id: 'new', label: 'Nova partitura…', run: () => openOverlay('new') },
    { id: 'save', label: 'Salvar arquivo (.wiss.json)', hint: 'Ctrl S', run: exportJson },
    { id: 'open', label: 'Abrir arquivo (MusicXML, MIDI, PDF, foto, .wiss.json)…', hint: 'Ctrl O', run: () => $<HTMLInputElement>('[data-file]').click() },
    { id: 'export-pdf', label: 'Exportar PDF', run: () => void exportPdfFile() },
    { id: 'export-xml', label: 'Exportar MusicXML', run: exportXml },
    { id: 'export-midi', label: 'Exportar MIDI', run: exportMid },
    { id: 'sound', label: 'Som: volumes, SoundFont e teclado MIDI…', run: openSound },
    { id: 'midi', label: midiLink ? 'Desconectar teclado MIDI' : 'Conectar teclado MIDI', run: () => void toggleMidi() },
    { id: 'lyric', label: 'Escrever letra na nota selecionada', hint: 'L', run: () => openEntry('lyric') },
    { id: 'chord-symbol', label: 'Escrever cifra na nota selecionada', hint: 'H', run: () => openEntry('chordSymbol') },
    { id: 'repeat-start', label: `Início de repetição (compasso ${editor.selectionMeasure() + 1})`, run: () => editor.toggleBar('repeatStart') },
    { id: 'repeat-end', label: `Fim de repetição (compasso ${editor.selectionMeasure() + 1})`, run: () => editor.toggleBar('repeatEnd') },
    { id: 'ending1', label: `Casa de 1ª vez (compasso ${editor.selectionMeasure() + 1})`, run: () => editor.toggleBar('ending1') },
    { id: 'ending2', label: `Casa de 2ª vez (compasso ${editor.selectionMeasure() + 1})`, run: () => editor.toggleBar('ending2') },
    ...DYNAMICS.map((d) => ({ id: `dyn-${d}`, label: `Dinâmica: ${d}`, run: () => editor.setDynamic(d) })),
    ...ARTICULATIONS.map((a) => ({ id: `art-${a}`, label: `Articulação: ${ARTICULATION_NAMES_PT[a]}`, hint: ART_KEYS[a], run: () => editor.toggleArticulation(a) })),
    { id: 'mark', label: marking ? 'Parar de marcar' : 'Marcar por cima da partitura (caneta, marca-texto, texto)', hint: 'M', run: () => toggleMarking() },
    { id: 'docs', label: 'Documentos recentes (PDF e fotos com marcações)…', run: () => void openRecentDocs() },
    ...(doc ? [{ id: 'doc-show', label: `Voltar ao documento: ${doc.name}`, run: showDocView }] : []),
    { id: 'cloud', label: 'Nuvem: entrar, minhas partituras, compartilhar…', run: openCloud },
    { id: 'assistant', label: 'Assistente: harmonizar ou revisar…', run: openAssistant },
    { id: 'theme', label: 'Alternar tema claro/escuro', run: () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') },
    { id: 'help', label: 'Ver atalhos de teclado', hint: '?', run: () => openOverlay('help') },
    { id: 'undo', label: 'Desfazer', hint: 'Ctrl Z', run: () => editor.undo() },
    { id: 'redo', label: 'Refazer', hint: 'Ctrl Y', run: () => editor.redo() },
    { id: 'tie', label: 'Ligadura de prolongamento', hint: 'T', run: () => editor.toggleTie() },
    { id: 'copy', label: 'Copiar seleção', hint: 'Ctrl C', run: () => editor.copy() },
    { id: 'cut', label: 'Recortar seleção', hint: 'Ctrl X', run: () => editor.cut() },
    { id: 'paste', label: 'Colar no cursor', hint: 'Ctrl V', run: () => editor.paste() },
    { id: 'all', label: 'Selecionar tudo (voz atual)', hint: 'Ctrl A', run: () => editor.selectAll() },
    { id: 'staff-up', label: 'Ir para a pauta de cima', hint: 'Alt ↑', run: () => editor.moveStaff(-1) },
    { id: 'staff-down', label: 'Ir para a pauta de baixo', hint: 'Alt ↓', run: () => editor.moveStaff(1) },
    { id: 'remove-part', label: 'Remover o instrumento atual', run: () => editor.removePart() },
    { id: 'sharp', label: 'Sustenido', hint: '+', run: () => editor.setAlter(1) },
    { id: 'flat', label: 'Bemol', hint: '−', run: () => editor.setAlter(-1) },
    { id: 'natural', label: 'Bequadro (natural)', run: () => editor.setAlter(0) },
    { id: 'demo', label: 'Carregar exemplo', run: () => openLocal(demoScore()) },
  ];
  DURATION_ORDER.forEach((type, i) =>
    list.push({ id: `dur-${type}`, label: `Figura: ${DURATION_NAMES_PT[type]}`, hint: String(i + 1), run: () => (editor.inputMode ? editor.setDuration(type) : editor.setSelectedDuration(type)) }),
  );
  for (let v = 0; v < MAX_VOICES; v++) {
    list.push({ id: `voice${v}`, label: `Voz ${v + 1}`, hint: `Alt ${v + 1}`, run: () => editor.setVoice(v) });
  }
  const tupletNames: Record<number, string> = { 2: 'Duína', 3: 'Tercina', 4: 'Quartina', 5: 'Quintina', 6: 'Sextina', 7: 'Septina', 9: 'Nonina' };
  for (const n of Object.keys(TUPLET_NORMAL).map(Number)) {
    list.push({ id: `tuplet${n}`, label: `Quiáltera: ${tupletNames[n]} (${n}:${TUPLET_NORMAL[n]})`, hint: `Shift ${n}`, run: () => tuplet(n) });
  }
  const here = `a partir do compasso ${editor.cursorMeasure() + 1}`;
  for (let f = -7; f <= 7; f++) {
    list.push({ id: `key${f}`, label: `Tonalidade: ${keyName(f as Fifths)} (${here})`, run: () => editor.setKeyHere(f as Fifths) });
  }
  for (const t of ['4/4', '3/4', '2/4', '6/8', '9/8', '12/8', '5/4', '7/8', '2/2']) {
    const [beats, beatType] = t.split('/').map(Number);
    list.push({ id: `ts${t}`, label: `Fórmula de compasso: ${t} (${here})`, run: () => editor.setTimeSignatureHere({ beats, beatType }) });
  }
  for (const inst of INSTRUMENTS) {
    list.push({ id: `add-${inst.id}`, label: `Adicionar instrumento: ${inst.name}`, run: () => editor.addPart(inst.id) });
  }
  return list;
}

let paletteIndex = 0;
function openPalette() {
  const ov = openOverlay('palette');
  const input = ov.querySelector('input')!;
  input.value = '';
  paletteIndex = 0;
  fillPalette('');
  input.focus();
}

function normalize(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function filteredCommands(q: string) {
  const words = normalize(q).split(/\s+/).filter(Boolean);
  return commands().filter((c) => words.every((w) => normalize(c.label).includes(w)));
}

function fillPalette(q: string) {
  const ul = $('[data-overlay="palette"] ul');
  const items = filteredCommands(q).slice(0, 40);
  paletteIndex = Math.min(paletteIndex, Math.max(0, items.length - 1));
  ul.innerHTML = items
    .map((c, i) => `<li data-cmd="${c.id}" class="${i === paletteIndex ? 'active' : ''}"><span>${c.label}</span>${c.hint ? `<span class="kbd">${c.hint}</span>` : ''}</li>`)
    .join('') || '<li><span class="hint">Nenhum comando encontrado</span></li>';
}

function runCommand(id: string) {
  closeOverlays();
  commands().find((c) => c.id === id)?.run();
}

// ---------------------------------------------------------------- overlays

function openOverlay(name: string): HTMLElement {
  closeOverlays();
  const ov = $(`[data-overlay="${name}"]`);
  ov.hidden = false;
  return ov;
}

function closeOverlays() {
  app.querySelectorAll<HTMLElement>('.overlay').forEach((o) => (o.hidden = true));
  scoreEl.focus({ preventScroll: true });
}

function anyOverlayOpen() {
  return [...app.querySelectorAll<HTMLElement>('.overlay')].some((o) => !o.hidden);
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('.toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------------------------------------------------------------- arquivos

function fileBase(): string {
  return editor.score.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'partitura';
}

/**
 * Quando a página roda dentro do visualizador do claude.ai, downloads passam
 * pela capacidade "downloads" (o usuário confirma). Fora dele, link normal.
 */
interface DownloadsApi {
  save(req: { filename: string; data: Blob | Uint8Array }): Promise<unknown>;
}
let downloadsApi: DownloadsApi | null = null;
const hostClaude = (window as unknown as { claude?: { use(name: string): Promise<unknown> } }).claude;
hostClaude?.use('downloads').then((d) => (downloadsApi = d as DownloadsApi | null)).catch(() => undefined);
const HOST_EXTENSIONS = new Set(['pdf', 'json', 'zip', 'txt']);

/** Entrega um arquivo ao usuário (download no navegador). */
async function download(name: string, blob: Blob) {
  if (downloadsApi) {
    let filename = name;
    let data: Blob | Uint8Array = blob;
    const ext = name.split('.').pop()!.toLowerCase();
    if (!HOST_EXTENSIONS.has(ext)) {
      // o visualizador só aceita alguns formatos: .musicxml e .mid vão dentro de um .zip
      const { zipSync } = await import('fflate');
      data = zipSync({ [name]: new Uint8Array(await blob.arrayBuffer()) });
      filename = `${name}.zip`;
    }
    try {
      await downloadsApi.save({ filename, data });
    } catch (err) {
      if ((err as { code?: string }).code !== 'declined') toast('Não foi possível salvar o arquivo aqui');
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function exportJson() {
  const blob = new Blob([JSON.stringify({ format: 'music-wiss', version: 1, score: editor.score }, null, 2)], { type: 'application/json' });
  download(`${fileBase()}.wiss.json`, blob);
  toast('Arquivo salvo');
}

function exportXml() {
  download(`${fileBase()}.musicxml`, new Blob([exportMusicXml(editor.score)], { type: 'application/vnd.recordare.musicxml+xml' }));
  toast('MusicXML exportado');
}

function exportMid() {
  download(`${fileBase()}.mid`, new Blob([exportMidi(editor.score)], { type: 'audio/midi' }));
  toast('MIDI exportado');
}

async function exportPdfFile() {
  toast('Gerando PDF…');
  try {
    const { exportPdf } = await import('./io/pdf');
    download(`${fileBase()}.pdf`, await exportPdf(editor.score));
    toast('PDF exportado');
  } catch (err) {
    console.error(err);
    toast('Não foi possível gerar o PDF');
  }
}

/** Abre .wiss.json, .musicxml, .xml ou .mxl. */
async function openFile(file: File) {
  stopPlayback();
  const name = file.name.toLowerCase();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (name.endsWith('.json')) {
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (data?.format !== 'music-wiss' || !data.score?.parts) throw new Error('Este .json não é uma partitura do Music Wiss');
      openLocal(migrateScore(data.score as Score));
      toast('Partitura aberta');
      return;
    }
    if (/\.midi?$/.test(name) || (bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64)) {
      const { score, warnings } = importMidi(bytes, file.name.replace(/\.midi?$/i, ''));
      openLocal(score);
      toast(warnings.length ? `MIDI aberto. ${warnings[0]}` : 'MIDI aberto: aperte Espaço para tocar');
      if (warnings.length) console.info('Avisos da importação:', warnings);
      return;
    }
    if (isPdf(bytes) || imageType(bytes)) {
      toast('Abrindo…');
      await openDoc(file.name, bytes);
      return;
    }
    const { score, warnings } = importMusicXml(readMusicXmlFile(name, bytes));
    openLocal(score);
    toast(warnings.length ? `Partitura aberta. ${warnings[0]}` : 'Partitura aberta');
    if (warnings.length) console.info('Avisos da importação:', warnings);
  } catch (err) {
    toast(err instanceof Error && err.message ? err.message : 'Arquivo inválido');
  }
}

function loadSaved(): Score | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? migrateScore(JSON.parse(raw) as Score) : null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* armazenamento indisponível */
  }
}

let saveTimer = 0;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => safeSet(STORAGE_KEY, JSON.stringify(editor.score)), 400);
}

function demoScore(): Score {
  const score = createScore({ title: 'Primeira melodia', composer: 'Music Wiss', tempo: 92, timeSignature: { beats: 3, beatType: 4 }, keyFifths: 1, instrumentId: 'piano' });
  const ed = new Editor(score);
  ed.toggleInputMode(true);
  const notes = (list: Array<[Step | 'r', DurationKey]>) => {
    for (const [step, d] of list) {
      ed.setDuration(DURATION_KEYS[d]);
      if (step === 'r') ed.insertRest();
      else ed.insertStep(step);
    }
  };
  // mão direita (com uma tercina no 3º compasso), começando no Ré4
  ed.setDuration('quarter');
  ed.insertPitch({ step: 'D', alter: 0, octave: 4 });
  notes([ ['G', '3'], ['A', '4'], ['B', '4'], ['C', '3'], ['B', '3'], ['A', '3']]);
  ed.setDuration('eighth');
  ed.insertTuplet(3);
  notes([['G', '4'], ['A', '4'], ['G', '4'], ['B', '3'], ['D', '3'], ['G', '2'], ['r', '3']]);
  // mão esquerda: acordes em mínimas pontuadas
  ed.moveStaff(1);
  ed.setCursor(0);
  for (const [root, third] of [['G', 'D'], ['C', 'E'], ['D', 'F'], ['G', 'D']] as Array<[Step, Step]>) {
    ed.setDuration('half');
    ed.toggleDot();
    ed.insertStep(root);
    ed.addToChord(third);
  }
  ed.moveStaff(-1); // sai da mão esquerda: as pausas provisórias do fim somem
  return ed.score;
}

type DurationKey = '1' | '2' | '3' | '4' | '5' | '6';

// ---------------------------------------------------------------- eventos

/** a próxima mudança já soou pelo teclado MIDI */
let muteNextSound = false;

editor.onChange((change) => {
  if (change.annotations) {
    // só marcações: não redesenha a partitura (mantém o arrasto e a seleção)
    scheduleCloudSave();
    autosave();
    scoreLayer?.draw();
    return;
  }
  if (muteNextSound) muteNextSound = false;
  else if (!change.remote) sound(change.sounded);
  if (!change.remote) scheduleCloudSave();
  autosave();
  render();
});

window.addEventListener('keydown', onKey);
window.addEventListener('resize', () => render());

app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act], [data-dur], [data-cmd], [data-close], [data-voice]');
  if (!el) return;
  if (el.dataset.close !== undefined) return closeOverlays();
  if (el.dataset.cmd) return runCommand(el.dataset.cmd);
  if (el.dataset.voice) return editor.setVoice(Number(el.dataset.voice));
  if (el.dataset.dur) {
    const type = el.dataset.dur as (typeof DURATION_ORDER)[number];
    return editor.inputMode ? editor.setDuration(type) : editor.setSelectedDuration(type);
  }
  switch (el.dataset.act) {
    case 'mode': return editor.toggleInputMode();
    case 'play': return togglePlay();
    case 'new': return openOverlay('new');
    case 'palette': return openPalette();
    case 'sound': return openSound();
    case 'cloud': return openCloud();
    case 'assistant': return openAssistant();
    case 'cloud-save': return void cloudSaveNew();
    case 'cloud-open': return void cloudOpen(el.dataset.id!);
    case 'cloud-delete': return void cloudDelete(el.dataset.id!, el.dataset.title ?? '');
    case 'cloud-share': return void cloudShare(el.dataset.role as 'view' | 'edit');
    case 'cloud-revoke': return void cloudRevoke();
    case 'cloud-detach': return cloudDetach(true);
    case 'cloud-signout': return void cloudSignOut();
    case 'cloud-reconfig': return cloudReconfigure();
    case 'cloud-tab': cloudTab = el.dataset.tab as 'in' | 'up'; return renderCloud();
    case 'ai-run': return void runAssistant();
    case 'ai-apply': return applyAssistant();
    case 'expr': return toggleExpr();
    case 'dyn': return editor.setDynamic(el.dataset.value as Dynamic);
    case 'art': return editor.toggleArticulation(el.dataset.value as Articulation);
    case 'lyric': return openEntry('lyric');
    case 'chord-symbol': return openEntry('chordSymbol');
    case 'bar': return editor.toggleBar(el.dataset.value as 'repeatStart' | 'repeatEnd' | 'ending1' | 'ending2');
    case 'load-sf': return $<HTMLInputElement>('[data-soundfont]').click();
    case 'clear-sf': return clearSoundFont();
    case 'midi': return void toggleMidi();
    case 'mute': return toggleMute(Number(el.dataset.part));
    case 'theme': return applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    case 'dot': return editor.toggleDot();
    case 'rest': return editor.inputMode ? editor.insertRest() : undefined;
    case 'flat': return editor.setAlter(-1);
    case 'sharp': return editor.setAlter(1);
    case 'natural': return editor.setAlter(0);
    case 'tie': return editor.toggleTie();
    case 'tuplet': return tuplet(3);
    case 'mark': return toggleMarking();
    case 'annot-tool': return setAnnotTool(el.dataset.tool as BarTool);
    case 'annot-color': return setAnnotColor(el.dataset.color!);
    case 'annot-undo': return annotUndo();
    case 'annot-clear': return void annotClear();
    case 'annot-pop': return toggleAnnotPop(el.dataset.pop as 'stamp' | 'pos');
    case 'annot-stamp': return setStamp(el.dataset.stamp!);
    case 'annot-pos': return setBarPos(el.dataset.pos as BarPos);
    case 'annot-size': return annotResize(Number(el.dataset.f));
    case 'annot-delete': return annotDelete();
    case 'annot-done': return docView ? closeDocView() : toggleMarking(false);
    case 'docs': closeMenu(); return void openRecentDocs();
    case 'doc-open': return void reopenDoc(el.dataset.id!);
    case 'doc-forget': return void forgetDoc(el.dataset.id!);
    case 'doc-close': return closeDocView();
    case 'doc-show': return showDocView();
    case 'doc-export': return void exportDoc();
    case 'doc-analyze': return openAnalysis();
    case 'an-run': return void runAnalysis();
    case 'an-open': return applyAnalysis(false);
    case 'an-play': return applyAnalysis(true);
    case 'file-menu': return toggleMenu();
    case 'open': closeMenu(); return $<HTMLInputElement>('[data-file]').click();
    case 'save': closeMenu(); return exportJson();
    case 'export-pdf': closeMenu(); return void exportPdfFile();
    case 'export-xml': closeMenu(); return exportXml();
    case 'export-midi': closeMenu(); return exportMid();
  }
});

document.addEventListener('pointerdown', (e) => {
  if (annotPop && !(e.target as HTMLElement).closest('.annot-pop, [data-act="annot-pop"]')) {
    annotPop = null;
    renderAnnotBar();
  }
});

app.querySelectorAll<HTMLElement>('.overlay').forEach((ov) =>
  ov.addEventListener('mousedown', (e) => {
    if (e.target === ov) closeOverlays();
  }),
);

const paletteInput = $<HTMLInputElement>('[data-overlay="palette"] input');
paletteInput.addEventListener('input', () => {
  paletteIndex = 0;
  fillPalette(paletteInput.value);
});
paletteInput.addEventListener('keydown', (e) => {
  const items = filteredCommands(paletteInput.value).slice(0, 40);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    paletteIndex = (paletteIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length);
    fillPalette(paletteInput.value);
    $('[data-overlay="palette"] li.active')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (items[paletteIndex]) runCommand(items[paletteIndex].id);
  } else if (e.key === 'Escape') {
    closeOverlays();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && anyOverlayOpen()) closeOverlays();
});

$<HTMLFormElement>('[data-overlay="new"] form').addEventListener('submit', (e) => {
  e.preventDefault();
  stopPlayback();
  const f = new FormData(e.target as HTMLFormElement);
  const [beats, beatType] = String(f.get('time')).split('/').map(Number);
  openLocal(
    createScore({
      title: String(f.get('title') || 'Sem título'),
      composer: String(f.get('composer') || ''),
      instrumentIds: f.getAll('instrument').map(String).length ? f.getAll('instrument').map(String) : ['piano'],
      timeSignature: { beats, beatType },
      keyFifths: Number(f.get('key')) as Fifths,
      tempo: Number(f.get('tempo')) || 96,
    }),
  );
  closeOverlays();
  editor.toggleInputMode(true);
});

$<HTMLInputElement>('[data-file]').addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void openFile(file);
  (e.target as HTMLInputElement).value = '';
});

titleInput.addEventListener('change', () => editor.mutate((s) => (s.title = titleInput.value.trim() || 'Sem título')));
composerInput.addEventListener('change', () => editor.mutate((s) => (s.composer = composerInput.value.trim())));
tempoInput.addEventListener('change', () => {
  const t = Math.min(300, Math.max(20, Number(tempoInput.value) || 96));
  editor.mutate((s) => (s.tempo = t));
});
for (const input of [titleInput, composerInput, tempoInput]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
}

scoreEl.addEventListener('mousedown', (e) => {
  if (!lastRender || marking) return;
  const rect = scoreEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const hit = lastRender.hits.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
  if (hit) editor.clickEvent(hit.pos, hit.index, e.shiftKey);
  else editor.clearSelection();
});

// menu Arquivo
const menuList = $<HTMLElement>('.menu-list');
function toggleMenu() {
  menuList.hidden = !menuList.hidden;
}
function closeMenu() {
  menuList.hidden = true;
}
document.addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('.menu')) closeMenu();
});

// arrastar e soltar arquivos na janela
const dropHint = $<HTMLElement>('.drop-hint');
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dropHint.hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) dropHint.hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropHint.hidden = true;
  const file = e.dataTransfer?.files[0];
  if (file) void openFile(file);
});

// ---------------------------------------------------------------- som: painel, SoundFont e MIDI

function openSound() {
  renderSound();
  openOverlay('sound');
}

function renderSound() {
  const body = $('.sound-body');
  const sf = engine.soundFontName;
  const master = Math.round(masterVolume * 100);
  const parts = editor.score.parts.map((p, i) => {
    const vol = Math.round((p.volume ?? 0.8) * 100);
    return `<div class="mix-row ${p.muted ? 'muted' : ''}">
      <span class="mix-name">${escapeHtml(p.name)}</span>
      <input type="range" min="0" max="100" value="${vol}" data-part-vol="${i}" aria-label="Volume de ${escapeHtml(p.name)}" />
      <span class="mix-val">${vol}</span>
      <button type="button" class="icon-btn small ${p.muted ? 'on' : ''}" data-act="mute" data-part="${i}" aria-pressed="${!!p.muted}">${p.muted ? 'Sem som' : 'Mudo'}</button>
    </div>`;
  }).join('');
  body.innerHTML = `
    <section>
      <h3>Volumes</h3>
      <div class="mix-row master">
        <span class="mix-name">Geral</span>
        <input type="range" min="0" max="100" value="${master}" data-master aria-label="Volume geral" />
        <span class="mix-val">${master}</span><span></span>
      </div>
      ${parts}
    </section>
    <section>
      <h3>Instrumentos</h3>
      <p class="sound-src">${soundLoading ? `Carregando <b>${escapeHtml(soundLoading)}</b>…` : sf ? `Tocando com o SoundFont <b>${escapeHtml(sf)}</b>.` : 'Tocando com os <b>timbres internos</b> (sintetizados, um por família de instrumento).'}</p>
      <p class="sound-note">Para som de instrumentos gravados, carregue um arquivo SoundFont (.sf2 ou .sf3), por exemplo o GeneralUser GS ou o FluidR3_GM, gratuitos. Ele fica guardado neste navegador.</p>
      <div class="sound-actions">
        <button type="button" class="icon-btn" data-act="load-sf">${ICON.upload}<span>Carregar SoundFont…</span></button>
        ${sf ? '<button type="button" class="icon-btn" data-act="clear-sf"><span>Voltar aos timbres internos</span></button>' : ''}
      </div>
    </section>
    <section>
      <h3>Teclado MIDI</h3>
      <p class="sound-src">${midiLink ? (midiDevices.length ? `Conectado: <b>${midiDevices.map(escapeHtml).join(', ')}</b>.` : 'Esperando um teclado. Ligue o cabo USB.') : 'Desconectado.'}</p>
      <p class="sound-note">No modo de escrita (N), cada tecla vira uma nota com a figura escolhida; teclas apertadas juntas viram acorde. Fora do modo de escrita, o teclado só toca.</p>
      <div class="sound-actions">
        <button type="button" class="icon-btn ${midiLink ? '' : 'primary'}" data-act="midi">${ICON.keyboard}<span>${midiLink ? 'Desconectar' : 'Conectar teclado MIDI'}</span></button>
      </div>
    </section>
  `;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const MASTER_KEY = 'music-wiss:volume';
let masterVolume = Number(safeGet(MASTER_KEY) ?? 0.8);
if (!Number.isFinite(masterVolume)) masterVolume = 0.8;
engine.setMasterVolume(masterVolume);

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

$('.sound-body').addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  const v = Number(el.value) / 100;
  const label = el.nextElementSibling as HTMLElement | null;
  if (label) label.textContent = el.value;
  if (el.dataset.master !== undefined) {
    masterVolume = v;
    engine.setMasterVolume(v);
    safeSet(MASTER_KEY, String(v));
  } else if (el.dataset.partVol !== undefined) {
    const part = editor.score.parts[Number(el.dataset.partVol)];
    if (!part) return;
    part.volume = v;
    engine.setBus(part.id, v, part.muted);
  }
});
// grava o volume do instrumento (com desfazer) só ao soltar o controle
$('.sound-body').addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.partVol === undefined) return;
  const i = Number(el.dataset.partVol);
  const v = Number(el.value) / 100;
  editor.mutate((s) => (s.parts[i].volume = v));
  renderSound();
});

function toggleMute(i: number) {
  if (!editor.score.parts[i]) return;
  editor.mutate((s) => (s.parts[i].muted = !s.parts[i].muted));
  syncMixer();
  renderSound();
}

async function useSoundFont(bytes: Uint8Array, name: string, store: boolean) {
  soundLoading = name;
  renderSound();
  try {
    const loaded = await engine.loadSoundFont(bytes, name, editor.score.parts.map((p) => p.midiProgram));
    if (store) void storeSoundFont(name, bytes);
    toast(`SoundFont carregado: ${loaded}`);
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Não deu para ler o SoundFont');
  } finally {
    soundLoading = null;
    renderSound();
  }
}

function clearSoundFont() {
  engine.clearSoundFont();
  void forgetSoundFont();
  toast('Voltando aos timbres internos');
  renderSound();
}

$<HTMLInputElement>('[data-soundfont]').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) await useSoundFont(new Uint8Array(await file.arrayBuffer()), file.name, true);
});

// SoundFont guardado de uma visita anterior (carrega quando o usuário tocar algo pela primeira vez,
// porque o navegador só libera o áudio depois de um clique ou tecla)
let storedSoundFontPending = true;
async function restoreSoundFont() {
  if (!storedSoundFontPending) return;
  storedSoundFontPending = false;
  const stored = await loadStoredSoundFont();
  if (stored && !engine.soundFontName) await useSoundFont(stored.bytes, stored.name, false);
}
window.addEventListener('pointerdown', () => void restoreSoundFont(), { once: true });
window.addEventListener('keydown', () => void restoreSoundFont(), { once: true });

async function toggleMidi() {
  if (midiLink) {
    midiLink.disconnect();
    midiLink = null;
    updateMidiLed();
    renderSound();
    return;
  }
  const result = await connectMidi({
    onNoteOn: (n) => midiSound(n),
    onChord: (notes, late) => midiWrite(notes, late),
    onDevices: (names) => {
      midiDevices = names;
      updateMidiLed();
      if (!$('[data-overlay="sound"]').hidden) renderSound();
    },
  });
  if (result.error) {
    toast(result.error);
    return;
  }
  midiLink = result;
  toast(midiDevices.length ? `Teclado MIDI conectado: ${midiDevices[0]}` : 'MIDI ligado. Conecte um teclado.');
  updateMidiLed();
  renderSound();
}

function updateMidiLed() {
  const led = $('.midi-led');
  led.hidden = !midiLink;
  led.classList.toggle('live', midiDevices.length > 0);
}

/** Toca a tecla na hora, com o som do instrumento atual. */
function midiSound(n: MidiNote) {
  const part = editor.score.parts[editor.pos.partIndex];
  syncMixer();
  engine.play({ bus: part.id, program: part.midiProgram, midi: n.midi, when: engine.now(), duration: 0.6, velocity: n.velocity });
}

/** No modo de escrita, escreve a nota/acorde (convertendo do som real para o escrito). */
function midiWrite(notes: MidiNote[], late: boolean) {
  if (!editor.inputMode || playing || anyOverlayOpen()) return;
  const part = editor.score.parts[editor.pos.partIndex];
  const fifths = effectiveKey(editor.score, editor.cursorMeasure());
  const pitches = notes.map((n) => spellMidi(n.midi - part.transposition, fifths));
  muteNextSound = true;
  if (late) editor.addPitchesToPrevious(pitches);
  else editor.insertChord(pitches);
  muteNextSound = false;
}

// ---------------------------------------------------------------- expressão: dinâmicas, articulações, texto, repetições

const ART_KEYS: Partial<Record<Articulation, string>> = { staccato: 'S', staccatissimo: 'Shift S', accent: 'V', marcato: 'Shift V', tenuto: 'U' };
const ART_GLYPH: Record<Articulation, string> = {
  staccato: '', staccatissimo: '', tenuto: '', accent: '', marcato: '', fermata: '',
};
const exprEl = $<HTMLElement>('.expr-panel');
let exprOpen = false;

function toggleExpr(force?: boolean) {
  exprOpen = force ?? !exprOpen;
  render();
}

function renderExpr() {
  exprEl.hidden = !exprOpen;
  if (!exprOpen) return;
  const sel = editor.selectedEvents();
  const first = sel[0];
  const dyn = first?.marks?.dynamic;
  const hasArt = (a: Articulation) => sel.length > 0 && sel.every((e) => e.marks?.articulations?.includes(a));
  const bar = barMark(editor.score, editor.selectionMeasure());
  const mNo = editor.selectionMeasure() + 1;
  exprEl.innerHTML = `
    <div class="expr-group" role="group" aria-label="Dinâmicas">
      <span class="expr-label">Dinâmica</span>
      ${DYNAMICS.map((d) => `<button data-act="dyn" data-value="${d}" class="${dyn === d ? 'on' : ''}" title="${d}"><span class="smufl dyn">${DYNAMIC_GLYPH[d]}</span></button>`).join('')}
    </div>
    <div class="expr-group" role="group" aria-label="Articulações">
      <span class="expr-label">Articulação</span>
      ${ARTICULATIONS.map((a) => `<button data-act="art" data-value="${a}" class="${hasArt(a) ? 'on' : ''}" title="${ARTICULATION_NAMES_PT[a]}${ART_KEYS[a] ? ` (${ART_KEYS[a]})` : ''}"><span class="smufl art">${ART_GLYPH[a]}</span></button>`).join('')}
    </div>
    <div class="expr-group" role="group" aria-label="Texto">
      <span class="expr-label">Texto</span>
      <button data-act="lyric" class="text-btn" title="Letra (L)">Letra<small>L</small></button>
      <button data-act="chord-symbol" class="text-btn" title="Cifra (H)">Cifra<small>H</small></button>
    </div>
    <div class="expr-group" role="group" aria-label="Repetições no compasso ${mNo}">
      <span class="expr-label">Compasso ${mNo}</span>
      <button data-act="bar" data-value="repeatStart" class="${bar.repeatStart ? 'on' : ''}" title="Início de repetição"><span class="smufl art"></span></button>
      <button data-act="bar" data-value="repeatEnd" class="${bar.repeatEnd ? 'on' : ''}" title="Fim de repetição"><span class="smufl art"></span></button>
      <button data-act="bar" data-value="ending1" class="text-btn ${bar.ending === 1 ? 'on' : ''}" title="Casa de 1ª vez">1ª</button>
      <button data-act="bar" data-value="ending2" class="text-btn ${bar.ending === 2 ? 'on' : ''}" title="Casa de 2ª vez">2ª</button>
    </div>
  `;
}

// ---- letra e cifra: caixa de texto em cima da nota

type EntryKind = 'lyric' | 'chordSymbol';
let entry: { kind: EntryKind; index: number } | null = null;
const entryInput = document.createElement('input');
entryInput.className = 'text-entry';
entryInput.spellcheck = false;
entryInput.autocomplete = 'off';
entryInput.hidden = true;
scoreEl.parentElement!.appendChild(entryInput);

function openEntry(kind: EntryKind) {
  const events = editor.events();
  if (!events.length) return toast('Escreva algumas notas primeiro');
  let index = Math.max(0, (editor.range()?.[0] ?? editor.cursor - 1));
  if (kind === 'lyric') index = nextIndex(index, 0, kind) ?? index;
  goTo(kind, index);
}

/** Próximo evento que pode receber o texto (letra só em notas; cifra também em pausas). */
function nextIndex(from: number, dir: 1 | -1 | 0, kind: EntryKind): number | null {
  const events = editor.events();
  for (let i = from + dir; i >= 0 && i < events.length; i += dir || 1) {
    const ev = events[i];
    if (ev.kind === 'chord' || (kind === 'chordSymbol' && !ev.auto)) return i;
  }
  return null;
}

function goTo(kind: EntryKind, index: number) {
  entry = { kind, index };
  editor.clickEvent({ ...editor.pos }, index);
  entryInput.value = editor.events()[index]?.marks?.[kind] ?? '';
  entryInput.placeholder = kind === 'lyric' ? 'sí-la-ba' : 'Am7';
  entryInput.dataset.kind = kind;
  entryInput.hidden = false;
  placeEntry();
  entryInput.focus();
  entryInput.select();
}

function placeEntry() {
  if (!entry || !lastRender) return;
  const hit = lastRender.hits.find(
    (h) => h.index === entry!.index && h.pos.partIndex === editor.pos.partIndex && h.pos.staffIndex === editor.pos.staffIndex && h.pos.voiceIndex === editor.pos.voiceIndex,
  );
  if (!hit) return;
  const x = scoreEl.offsetLeft + hit.x + hit.w / 2;
  const y = scoreEl.offsetTop + (entry.kind === 'lyric' ? hit.y + hit.h + 4 : hit.y - 30);
  Object.assign(entryInput.style, { left: `${x}px`, top: `${y}px` });
}

function saveEntry() {
  if (!entry) return;
  editor.setText(entry.kind, entry.index, entryInput.value);
}

function closeEntry() {
  entry = null;
  entryInput.hidden = true;
  scoreEl.focus({ preventScroll: true });
}

entryInput.addEventListener('keydown', (e) => {
  if (!entry) return;
  const kind = entry.kind;
  const advance = (dir: 1 | -1, suffix = '') => {
    if (suffix && !entryInput.value.trim()) return;
    entryInput.value = entryInput.value.replace(/-+$/, '') + suffix;
    saveEntry();
    const next = nextIndex(entry!.index, dir, kind);
    if (next === null) return closeEntry();
    goTo(kind, next);
  };
  if (e.key === 'Enter') {
    e.preventDefault();
    saveEntry();
    closeEntry();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeEntry();
  } else if (e.key === ' ' || (e.key === 'Tab' && !e.shiftKey)) {
    e.preventDefault();
    advance(1);
  } else if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    advance(-1);
  } else if (e.key === '-' && kind === 'lyric') {
    // hífen: a palavra continua na próxima nota
    e.preventDefault();
    advance(1, '-');
  }
});
entryInput.addEventListener('blur', () => {
  // clicar fora salva o que foi digitado
  setTimeout(() => {
    if (entry && document.activeElement !== entryInput) {
      saveEntry();
      closeEntry();
    }
  }, 0);
});

// ---------------------------------------------------------------- nuvem: conta, partituras, compartilhar, tempo real

const CLOUD_DOC_KEY = 'music-wiss:cloud-doc';
let session: Session | null = null;
let cloudDoc: CloudDoc | null = loadCloudDoc();
let cloudTab: 'in' | 'up' = 'in';
let cloudList: { mine: CloudScoreRow[]; shared: Array<CloudScoreRow & { role: Role }> } | null = null;
let cloudListError = '';
let cloudBusy = '';
let cloudMsg = '';
/** O que foi digitado nos formulários (sobrevive ao redesenho do painel). */
const cloudDraft = { url: '', key: '', email: '' };
let lastShareUrl = '';
let pendingLink: ShareLink | null = null;
let people: string[] = [];
let stopLive: (() => void) | null = null;
let saveTimerCloud = 0;
let saving = false;
let dirty = false;
let saveError = '';
let warnedViewOnly = false;

function loadCloudDoc(): CloudDoc | null {
  try {
    const raw = localStorage.getItem(CLOUD_DOC_KEY);
    return raw ? (JSON.parse(raw) as CloudDoc) : null;
  } catch {
    return null;
  }
}

function setCloudDoc(doc: CloudDoc | null) {
  cloudDoc = doc;
  if (doc) safeSet(CLOUD_DOC_KEY, JSON.stringify(doc));
  else {
    try {
      localStorage.removeItem(CLOUD_DOC_KEY);
    } catch {
      /* sem armazenamento */
    }
  }
  updateCloudChip();
}

/** Abre uma partitura que não está na nuvem (arquivo, nova, exemplo). */
function openLocal(score: Score) {
  cloudDetach(false);
  closeDocView();
  editor.load(score);
}

function openCloud() {
  renderCloud();
  openOverlay('cloud');
  if (session && !cloudList) void refreshList();
}

function updateCloudChip() {
  const dot = $('.cloud-dot');
  const label = $('.cloud-btn span:not(.cloud-dot)');
  dot.hidden = !session;
  let state = 'on';
  let text = 'Nuvem';
  if (session && cloudDoc) {
    if (saveError) [state, text] = ['error', 'Erro ao salvar'];
    else if (saving || dirty) [state, text] = ['busy', cloudDoc.role === 'view' ? 'Só leitura' : 'Salvando…'];
    else [state, text] = ['ok', cloudDoc.role === 'view' ? 'Só leitura' : people.length > 1 ? `Salvo · ${people.length} online` : 'Salvo'];
  }
  dot.className = `cloud-dot ${state}`;
  label.textContent = text;
}

function renderCloud() {
  const body = $('.cloud-body');
  const cfg = cloudConfig();
  if (!cfg) {
    body.innerHTML = `
      <p>Para guardar partituras na nuvem, entrar com uma conta e compartilhar, o Music Wiss usa um projeto <b>Supabase</b>.</p>
      <p class="sound-note">Crie as tabelas com o arquivo <code>supabase/migrations</code> do repositório e cole aqui a URL e a chave publicável do projeto (Project Settings → API).</p>
      <form class="cloud-form" data-form="config">
        <label>URL do projeto<input name="url" placeholder="https://xxxx.supabase.co" value="${escapeHtml(cloudDraft.url)}" required /></label>
        <label>Chave publicável<input name="key" placeholder="sb_publishable_… ou anon" value="${escapeHtml(cloudDraft.key)}" required /></label>
        <div class="cloud-actions"><button class="icon-btn primary" type="submit">Conectar</button></div>
      </form>
      ${cloudMsg ? `<p class="cloud-msg">${escapeHtml(cloudMsg)}</p>` : ''}`;
    return;
  }
  if (!session) {
    body.innerHTML = `
      ${pendingLink ? '<p class="cloud-msg info">Entre na sua conta para abrir a partitura que compartilharam com você.</p>' : ''}
      <div class="cloud-tabs" role="tablist">
        <button type="button" data-act="cloud-tab" data-tab="in" class="${cloudTab === 'in' ? 'on' : ''}">Entrar</button>
        <button type="button" data-act="cloud-tab" data-tab="up" class="${cloudTab === 'up' ? 'on' : ''}">Criar conta</button>
      </div>
      <form class="cloud-form" data-form="${cloudTab === 'in' ? 'signin' : 'signup'}">
        <label>E-mail<input name="email" type="email" autocomplete="email" value="${escapeHtml(cloudDraft.email)}" required /></label>
        <label>Senha<input name="password" type="password" minlength="6" autocomplete="${cloudTab === 'in' ? 'current-password' : 'new-password'}" required /></label>
        <div class="cloud-actions">
          <button class="icon-btn primary" type="submit" ${cloudBusy ? 'disabled' : ''}>${cloudBusy || (cloudTab === 'in' ? 'Entrar' : 'Criar conta')}</button>
          ${configFromBuild() ? '' : '<button type="button" class="link-btn" data-act="cloud-reconfig">Trocar projeto</button>'}
        </div>
      </form>
      ${cloudMsg ? `<p class="cloud-msg">${escapeHtml(cloudMsg)}</p>` : ''}`;
    return;
  }

  const email = session.user.email ?? 'conta';
  const roleName: Record<Role, string> = { owner: 'sua', edit: 'pode editar', view: 'só ver' };
  const here = cloudDoc
    ? `<p>Esta partitura está na nuvem (${roleName[cloudDoc.role]}). ${saveError ? `<b class="warn">${escapeHtml(saveError)}</b>` : saving || dirty ? 'Salvando…' : 'Tudo salvo.'}</p>
       ${people.length ? `<p class="sound-note">Abertas agora: ${people.map(escapeHtml).join(', ')}</p>` : ''}
       <div class="cloud-actions">
         ${cloudDoc.role === 'owner' ? `
           <button type="button" class="icon-btn" data-act="cloud-share" data-role="view">Link para ver</button>
           <button type="button" class="icon-btn" data-act="cloud-share" data-role="edit">Link para editar</button>
           <button type="button" class="link-btn" data-act="cloud-revoke">Desativar links</button>` : ''}
         <button type="button" class="link-btn" data-act="cloud-detach">Parar de sincronizar</button>
       </div>
       ${lastShareUrl ? `<label class="share-url">Link copiado (envie para quem vai abrir)<input readonly value="${escapeHtml(lastShareUrl)}" /></label>` : ''}`
    : `<p>Esta partitura está só neste navegador.</p>
       <div class="cloud-actions"><button type="button" class="icon-btn primary" data-act="cloud-save" ${cloudBusy ? 'disabled' : ''}>${cloudBusy || 'Salvar na nuvem'}</button></div>`;
  const row = (r: CloudScoreRow, extra = '') => `
    <li class="${cloudDoc?.id === r.id ? 'current' : ''}">
      <span class="cloud-title">${escapeHtml(r.title)}</span>
      <small>${new Date(r.updated_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}${extra}</small>
      <button type="button" class="icon-btn small" data-act="cloud-open" data-id="${r.id}">Abrir</button>
      ${extra ? '' : `<button type="button" class="link-btn danger" data-act="cloud-delete" data-id="${r.id}" data-title="${escapeHtml(r.title)}">Apagar</button>`}
    </li>`;
  const list = cloudList
    ? `<section><h3>Minhas partituras</h3>${cloudList.mine.length ? `<ul class="cloud-list">${cloudList.mine.map((r) => row(r)).join('')}</ul>` : '<p class="sound-note">Nenhuma ainda.</p>'}</section>
       ${cloudList.shared.length ? `<section><h3>Compartilhadas comigo</h3><ul class="cloud-list">${cloudList.shared.map((r) => row(r, ` · ${roleName[r.role]}`)).join('')}</ul></section>` : ''}`
    : `<p class="sound-note">${cloudListError ? escapeHtml(cloudListError) : 'Carregando suas partituras…'}</p>`;
  body.innerHTML = `
    <p class="cloud-user">Conectado como <b>${escapeHtml(email)}</b> <button type="button" class="link-btn" data-act="cloud-signout">Sair</button></p>
    <section><h3>Esta partitura</h3>${here}</section>
    ${list}
    ${cloudMsg ? `<p class="cloud-msg">${escapeHtml(cloudMsg)}</p>` : ''}`;
}

$('.cloud-body').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const data = new FormData(form);
  cloudMsg = '';
  if (form.dataset.form === 'config') {
    const url = String(data.get('url')).trim().replace(/\/+$/, '');
    const key = String(data.get('key')).trim();
    Object.assign(cloudDraft, { url, key });
    const problem = validateConfig(url, key);
    if (problem) {
      cloudMsg = problem;
      return renderCloud();
    }
    saveCloudConfig({ url, key });
    await initCloud();
    return renderCloud();
  }
  const email = String(data.get('email')).trim();
  cloudDraft.email = email;
  const password = String(data.get('password'));
  cloudBusy = form.dataset.form === 'signin' ? 'Entrando…' : 'Criando…';
  renderCloud();
  try {
    if (form.dataset.form === 'signin') await cloud.signIn(email, password);
    else if (!(await cloud.signUp(email, password))) cloudMsg = 'Conta criada! Confirme pelo link que enviamos ao seu e-mail e depois entre.';
  } catch (err) {
    cloudMsg = err instanceof Error ? err.message : String(err);
  }
  cloudBusy = '';
  renderCloud();
});

function cloudReconfigure() {
  saveCloudConfig(null);
  session = null;
  cloudDetach(false);
  renderCloud();
  updateCloudChip();
}

async function refreshList() {
  cloudListError = '';
  try {
    cloudList = await cloud.listScores();
  } catch (err) {
    cloudListError = err instanceof Error ? err.message : String(err);
  }
  if (!$('[data-overlay="cloud"]').hidden) renderCloud();
}

async function cloudSaveNew() {
  cloudBusy = 'Salvando…';
  renderCloud();
  try {
    const doc = await cloud.createScore(editor.score);
    setCloudDoc(doc);
    await startLive();
    toast('Partitura salva na nuvem');
    void refreshList();
  } catch (err) {
    cloudMsg = err instanceof Error ? err.message : String(err);
  }
  cloudBusy = '';
  renderCloud();
}

async function cloudOpen(id: string) {
  try {
    const r = await cloud.loadScore(id);
    const role = await cloud.roleFor(id, r.ownerId);
    cloudDetach(false);
    editor.load(migrateScore(r.score));
    setCloudDoc({ id, version: r.version, role });
    await startLive();
    closeOverlays();
    toast(role === 'view' ? `Aberta só para ver: ${r.title}` : `Aberta: ${r.title}`);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}

async function cloudDelete(id: string, title: string) {
  if (!confirm(`Apagar "${title}" da nuvem? Quem tem o link também perde o acesso. Não dá para desfazer.`)) return;
  try {
    await cloud.deleteScore(id);
    if (cloudDoc?.id === id) cloudDetach(false);
    toast('Apagada da nuvem (a cópia aberta aqui continua)');
    void refreshList();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}

async function cloudShare(role: 'view' | 'edit') {
  if (!cloudDoc) return;
  try {
    lastShareUrl = await cloud.createShareLink(cloudDoc.id, role);
    try {
      await navigator.clipboard.writeText(lastShareUrl);
      toast(role === 'edit' ? 'Link para editar copiado' : 'Link para ver copiado');
    } catch {
      toast('Copie o link abaixo');
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
  renderCloud();
  const input = app.querySelector<HTMLInputElement>('.share-url input');
  input?.select();
}

async function cloudRevoke() {
  if (!cloudDoc) return;
  try {
    await cloud.revokeShareLinks(cloudDoc.id);
    lastShareUrl = '';
    toast('Links desativados. Quem já entrou continua com acesso.');
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
  renderCloud();
}

function cloudDetach(notify: boolean) {
  stopLive?.();
  stopLive = null;
  people = [];
  clearTimeout(saveTimerCloud);
  dirty = false;
  saveError = '';
  lastShareUrl = '';
  warnedViewOnly = false;
  if (cloudDoc && notify) toast('Esta cópia não sincroniza mais com a nuvem');
  setCloudDoc(null);
  if (!$('[data-overlay="cloud"]').hidden) renderCloud();
}

async function cloudSignOut() {
  cloudDetach(false);
  await cloud.signOut();
  session = null;
  cloudList = null;
  renderCloud();
  updateCloudChip();
}

function scheduleCloudSave() {
  if (!cloudDoc || !session) return;
  if (cloudDoc.role === 'view') {
    if (!warnedViewOnly) toast('Você só pode ver esta partitura: as mudanças ficam só neste navegador.');
    warnedViewOnly = true;
    return;
  }
  dirty = true;
  updateCloudChip();
  clearTimeout(saveTimerCloud);
  saveTimerCloud = window.setTimeout(() => void cloudSaveNow(), 1500);
}

async function cloudSaveNow() {
  if (!cloudDoc || saving) return;
  saving = true;
  dirty = false;
  updateCloudChip();
  const doc = cloudDoc;
  try {
    const version = await cloud.saveScore(doc, editor.score);
    if (cloudDoc === doc) setCloudDoc({ ...doc, version });
    saveError = '';
  } catch (err) {
    if (err instanceof cloud.ConflictError) {
      // alguém salvou no meio: fica a versão da nuvem; Ctrl+Z volta para a sua
      try {
        const r = await cloud.loadScore(doc.id);
        editor.replaceScore(migrateScore(r.score));
        setCloudDoc({ ...doc, version: r.version });
        toast('Outra pessoa salvou ao mesmo tempo. Carreguei a versão dela; Ctrl+Z traz a sua de volta.');
        saveError = '';
      } catch (e2) {
        saveError = e2 instanceof Error ? e2.message : String(e2);
      }
    } else {
      saveError = err instanceof Error ? err.message : String(err);
      dirty = true;
    }
  }
  saving = false;
  updateCloudChip();
  if (!$('[data-overlay="cloud"]').hidden) renderCloud();
  if (dirty && !saveError) scheduleCloudSave();
}

async function startLive() {
  stopLive?.();
  stopLive = null;
  if (!cloudDoc || !session) return;
  const me = session.user.email?.split('@')[0] ?? 'alguém';
  const docId = cloudDoc.id;
  try {
    stopLive = await cloud.joinLive(docId, me, {
      onRemote(row) {
        if (!cloudDoc || cloudDoc.id !== docId || row.version <= cloudDoc.version) return;
        if (dirty || saving) return; // o próximo salvamento resolve (conflito)
        editor.replaceScore(migrateScore(row.data));
        setCloudDoc({ ...cloudDoc, version: row.version });
        toast('Atualizada por outra pessoa');
      },
      onPresence(list) {
        people = list;
        updateCloudChip();
        if (!$('[data-overlay="cloud"]').hidden) renderCloud();
      },
    });
  } catch {
    /* sem tempo real: continua salvando normalmente */
  }
}

/** Abre a partitura de um link #s=... (depois de entrar na conta). */
async function openPendingLink() {
  if (!pendingLink || !session) return;
  const link = pendingLink;
  pendingLink = null;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    await cloud.joinByLink(link);
    await cloudOpen(link.scoreId);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}

async function initCloud() {
  pendingLink = cloud.parseShareHash(location.hash) ?? pendingLink;
  updateCloudChip();
  if (!cloudConfig()) {
    if (pendingLink) {
      cloudMsg = 'Este link é de uma partitura na nuvem, mas este Music Wiss ainda não está ligado a um projeto.';
      openCloud();
    }
    return;
  }
  try {
    session = await cloud.getSession();
  } catch {
    session = null;
  }
  await cloud.onAuthChange((s) => {
    const changed = (s?.user.id ?? null) !== (session?.user.id ?? null);
    session = s;
    if (!changed) return;
    cloudList = null;
    updateCloudChip();
    if (s) {
      void refreshList();
      void openPendingLink();
      if (cloudDoc) void startLive();
    } else {
      stopLive?.();
    }
    if (!$('[data-overlay="cloud"]').hidden) renderCloud();
  });
  updateCloudChip();
  if (pendingLink) {
    if (session) await openPendingLink();
    else openCloud();
  } else if (session && cloudDoc) {
    // volta a sincronizar a partitura que estava aberta; pega a versão nova se houver
    try {
      const r = await cloud.loadScore(cloudDoc.id);
      if (r.version > cloudDoc.version) {
        editor.replaceScore(migrateScore(r.score));
        setCloudDoc({ ...cloudDoc, version: r.version });
      }
      await startLive();
    } catch {
      cloudDetach(false);
    }
  }
}
window.addEventListener('hashchange', () => {
  const link = cloud.parseShareHash(location.hash);
  if (!link) return;
  pendingLink = link;
  if (session) void openPendingLink();
  else openCloud();
});

// ---------------------------------------------------------------- assistente (IA)

let aiBusy = false;
let aiAnswer: AssistantAnswer | null = null;
let aiError = '';
let aiTask: 'harmonizar' | 'revisar' = 'harmonizar';
let aiStyle = '';

function openAssistant() {
  renderAssistant();
  openOverlay('assistant');
}

function renderAssistant() {
  const body = $('.assistant-body');
  if (!cloudConfig() || !session) {
    body.innerHTML = `<p>O assistente usa IA no servidor e precisa que você esteja conectado à nuvem.</p>
      <div class="cloud-actions"><button type="button" class="icon-btn primary" data-act="cloud">Abrir Nuvem</button></div>`;
    return;
  }
  const part = editor.score.parts[editor.pos.partIndex];
  const where = `${part.name}${part.staves.length > 1 ? `, pauta ${editor.pos.staffIndex + 1}` : ''}, voz ${editor.pos.voiceIndex + 1}`;
  const a = aiAnswer;
  body.innerHTML = `
    <form class="cloud-form" data-form="ai">
      <div class="cloud-tabs" role="radiogroup">
        <label class="${aiTask === 'harmonizar' ? 'on' : ''}"><input type="radio" name="task" value="harmonizar" ${aiTask === 'harmonizar' ? 'checked' : ''} />Harmonizar</label>
        <label class="${aiTask === 'revisar' ? 'on' : ''}"><input type="radio" name="task" value="revisar" ${aiTask === 'revisar' ? 'checked' : ''} />Revisar</label>
      </div>
      <p class="sound-note">${aiTask === 'harmonizar' ? `Sugere cifras para a melodia em <b>${escapeHtml(where)}</b>. Você vê antes e decide se aplica.` : 'Procura notas fora da extensão, saltos difíceis, compassos incompletos e grafias estranhas.'}</p>
      ${aiTask === 'harmonizar' ? `<label>Estilo (opcional)<input name="style" value="${escapeHtml(aiStyle)}" placeholder="ex.: bossa nova, hino, pop simples" /></label>` : ''}
      <div class="cloud-actions"><button type="button" class="icon-btn primary" data-act="ai-run" ${aiBusy ? 'disabled' : ''}>${aiBusy ? 'Pensando…' : 'Pedir ao assistente'}</button></div>
    </form>
    ${aiError ? `<p class="cloud-msg">${escapeHtml(aiError)}</p>` : ''}
    ${a ? `<section class="ai-answer">
      <p>${escapeHtml(a.summary)}</p>
      ${a.chords.length ? `<p class="ai-chords">${a.chords.map((c) => `<span>#${c.index} <b>${escapeHtml(c.symbol)}</b></span>`).join('')}</p>
        <div class="cloud-actions"><button type="button" class="icon-btn primary" data-act="ai-apply">Aplicar ${a.chords.length} cifras</button></div>` : ''}
      ${a.issues.length ? `<ul class="ai-issues">${a.issues.map((i) => `<li><b>Compasso ${i.measure}</b> ${escapeHtml(i.message)}</li>`).join('')}</ul>` : ''}
    </section>` : ''}`;
}

$('.assistant-body').addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.name === 'task') {
    aiTask = el.value as 'harmonizar' | 'revisar';
    aiAnswer = null;
    renderAssistant();
  } else if (el.name === 'style') aiStyle = el.value;
});
$('.assistant-body').addEventListener('submit', (e) => {
  e.preventDefault();
  void runAssistant();
});

async function runAssistant() {
  const styleInput = app.querySelector<HTMLInputElement>('.assistant-body [name="style"]');
  if (styleInput) aiStyle = styleInput.value;
  aiBusy = true;
  aiError = '';
  aiAnswer = null;
  renderAssistant();
  try {
    aiAnswer = await cloud.askAssistant(aiTask, describeForAssistant(editor.score, editor.pos), aiStyle);
  } catch (err) {
    aiError = err instanceof Error ? err.message : String(err);
  }
  aiBusy = false;
  renderAssistant();
}

function applyAssistant() {
  if (!aiAnswer?.chords.length) return;
  const n = editor.events().length;
  const valid = aiAnswer.chords.filter((c) => Number.isInteger(c.index) && c.index >= 0 && c.index < n && c.symbol.trim());
  editor.setTexts('chordSymbol', valid.map((c) => [c.index, c.symbol.trim().slice(0, 24)]));
  toast(`${valid.length} cifras aplicadas (Ctrl+Z desfaz)`);
  closeOverlays();
}

// ---------------------------------------------------------------- marcações (partitura e documentos)

type BarPos = 'top' | 'left' | 'right' | 'bottom';
type BarTool = AnnotationTool | 'hand';
const ANNOT_PREFS_KEY = 'music-wiss:annot-prefs';

interface AnnotPrefs {
  tool: AnnotationTool;
  color: string;
  stamp: string;
  pos: BarPos;
  marking: boolean;
}

function loadAnnotPrefs(): AnnotPrefs {
  const d: AnnotPrefs = { tool: 'pen', color: ANNOTATION_COLORS[0], stamp: '→', pos: 'top', marking: false };
  try {
    const p = JSON.parse(localStorage.getItem(ANNOT_PREFS_KEY) ?? '{}') as Partial<AnnotPrefs>;
    const tools: AnnotationTool[] = ['move', 'pen', 'highlight', 'text', 'stamp', 'erase'];
    return {
      tool: tools.includes(p.tool as AnnotationTool) ? (p.tool as AnnotationTool) : d.tool,
      color: ANNOTATION_COLORS.includes(p.color ?? '') ? p.color! : d.color,
      stamp: STAMP_GROUPS.some((g) => g.symbols.includes(p.stamp ?? '')) ? p.stamp! : d.stamp,
      pos: (['top', 'left', 'right', 'bottom'] as BarPos[]).includes(p.pos as BarPos) ? (p.pos as BarPos) : d.pos,
      marking: !!p.marking,
    };
  } catch {
    return d;
  }
}

const annotPrefs = loadAnnotPrefs();
const annotState: LayerState = { tool: annotPrefs.tool, color: annotPrefs.color, stamp: annotPrefs.stamp };
let barPos: BarPos = annotPrefs.pos;
let annotHand = false;
let marking = false;
let scoreLayer: AnnotationLayer | null = null;
/** Marcação selecionada na partitura (sobrevive ao redesenho). */
let scoreSelected = -1;
let annotSelected = -1;
let annotPop: 'stamp' | 'pos' | null = null;
const annotBar = $<HTMLElement>('.annot-bar');
const annotPopEl = $<HTMLElement>('.annot-pop');

function saveAnnotPrefs() {
  safeSet(ANNOT_PREFS_KEY, JSON.stringify({ tool: annotState.tool, color: annotState.color, stamp: annotState.stamp, pos: barPos, marking }));
}

function attachScoreLayer() {
  scoreLayer = new AnnotationLayer(
    scoreEl,
    annotState,
    () => editor.score.annotations ?? [],
    (list) => editor.setAnnotations(list),
    askAnnotText,
    (i) => {
      scoreSelected = i;
      setAnnotSelected(i);
    },
  );
  scoreLayer.setActive(marking && !annotHand);
  if (marking && annotState.tool === 'move' && scoreSelected >= 0) {
    scoreLayer.selected = scoreSelected;
    scoreLayer.draw();
  }
  scoreEl.classList.toggle('marking', marking);
}

function toggleMarking(on = !marking) {
  if (on && editor.inputMode) editor.toggleInputMode(false);
  marking = on;
  scoreSelected = -1;
  annotSelected = -1;
  if (on) annotHand = false;
  annotPop = null;
  saveAnnotPrefs();
  renderAnnotBar();
  render();
  if (on) toast('Marcando: desenhe por cima. M ou Concluir para voltar a editar.');
}

/** Camadas onde a ferramenta age agora (partitura ou páginas do documento). */
function activeLayers(): AnnotationLayer[] {
  if (docView) return docLayers;
  return marking && scoreLayer ? [scoreLayer] : [];
}

function selectedLayer(): AnnotationLayer | null {
  return activeLayers().find((l) => l.selected >= 0) ?? null;
}

function setAnnotSelected(i: number) {
  if ((i >= 0) === (annotSelected >= 0)) {
    annotSelected = i;
    return;
  }
  annotSelected = i;
  renderAnnotBar();
}

const BAR_POS_LABEL: Record<BarPos, string> = { top: 'No topo', left: 'À esquerda', right: 'À direita', bottom: 'Embaixo' };

function renderAnnotBar() {
  const show = marking || !!docView;
  annotBar.hidden = !show;
  app.classList.toggle('annot-on', show);
  for (const p of ['top', 'left', 'right', 'bottom'] as BarPos[]) app.classList.toggle(`bar-${p}`, show && barPos === p);
  annotBar.className = `annot-bar pos-${barPos}`;
  $('.mark-btn').classList.toggle('on', marking);
  if (!show) {
    annotPop = null;
    renderAnnotPop();
    return;
  }
  const tools: Array<[BarTool, string, string]> = [
    ...(docView ? ([['hand', ICON.hand, 'Rolar a página (H)']] as Array<[BarTool, string, string]>) : []),
    ['move', ICON.move, 'Mover: arraste uma marcação; duplo clique corrige texto (V)'],
    ['pen', ICON.pen, 'Caneta (P)'],
    ['highlight', ICON.highlight, 'Marca-texto (R)'],
    ['text', ICON.text, 'Texto: clique para escrever ou para corrigir um texto (T)'],
    ['erase', ICON.eraser, 'Borracha: passe por cima (E)'],
  ];
  const current: BarTool = annotHand ? 'hand' : annotState.tool;
  const btn = ([t, ico, label]: [BarTool, string, string]) =>
    `<button type="button" data-act="annot-tool" data-tool="${t}" class="${current === t ? 'on' : ''}" title="${label}" aria-pressed="${current === t}">${ico}</button>`;
  const sel = annotSelected >= 0 && annotState.tool === 'move' && !annotHand;
  annotBar.innerHTML = `
    ${tools.map(btn).join('')}
    <span class="stamp-group">
      <button type="button" data-act="annot-tool" data-tool="stamp" class="stamp-btn ${current === 'stamp' ? 'on' : ''}" title="Selo: clique na página para colocar (S)" aria-pressed="${current === 'stamp'}"><span class="stamp-glyph" style="font-family:${stampTakesColor(annotState.stamp) ? STAMP_FONT_MONO : STAMP_FONT_EMOJI}">${escapeHtml(stampTakesColor(annotState.stamp) ? `${annotState.stamp}\uFE0E` : annotState.stamp)}</span></button>
      <button type="button" data-act="annot-pop" data-pop="stamp" class="more ${annotPop === 'stamp' ? 'on' : ''}" title="Escolher o selo: setas, formas, notas musicais, atenção" aria-expanded="${annotPop === 'stamp'}">▾</button>
    </span>
    <span class="sep"></span>
    ${ANNOTATION_COLORS.map((c) => `<button type="button" data-act="annot-color" data-color="${c}" class="swatch ${annotState.color === c ? 'on' : ''}" style="--c:${c}" title="${sel ? 'Mudar a cor da marcação selecionada' : 'Cor'}" aria-pressed="${annotState.color === c}"></button>`).join('')}
    ${sel ? `<span class="sep"></span>
    <button type="button" data-act="annot-size" data-f="0.8" title="Diminuir (−)">A−</button>
    <button type="button" data-act="annot-size" data-f="1.25" title="Aumentar (+)">A+</button>
    <button type="button" data-act="annot-delete" title="Apagar a selecionada (Delete)">${ICON.eraser}</button>` : ''}
    <span class="sep"></span>
    <button type="button" data-act="annot-undo" title="Desfazer (Ctrl Z)">${ICON.undo}</button>
    <button type="button" data-act="annot-clear" class="text-btn" title="Apagar todas as marcações ${docView ? 'do documento' : 'da partitura'}">Limpar tudo</button>
    <button type="button" data-act="annot-pop" data-pop="pos" class="${annotPop === 'pos' ? 'on' : ''}" title="Lugar da barra: ${BAR_POS_LABEL[barPos]}" aria-expanded="${annotPop === 'pos'}">${ICON.layout}</button>
    ${docView ? '' : '<button type="button" data-act="annot-done" class="text-btn strong">Concluir</button>'}`;
  renderAnnotPop();
}

function renderAnnotPop() {
  annotPopEl.hidden = !annotPop;
  if (!annotPop) return;
  if (annotPop === 'stamp') {
    annotPopEl.innerHTML = STAMP_GROUPS.map(
      (g) => `<div class="pop-group"><small>${g.name}</small><div class="pop-grid">${g.symbols
        .map((s) => {
          const mono = stampTakesColor(s);
          return `<button type="button" data-act="annot-stamp" data-stamp="${escapeHtml(s)}" class="${annotState.stamp === s ? 'on' : ''}" title="Selo ${escapeHtml(s)}" style="font-family:${mono ? STAMP_FONT_MONO : STAMP_FONT_EMOJI};${mono ? `color:${annotState.color}` : ''}">${escapeHtml(mono ? `${s}\uFE0E` : s)}</button>`;
        })
        .join('')}</div></div>`,
    ).join('');
  } else {
    annotPopEl.innerHTML = `<div class="pop-group"><small>Lugar da barra</small>${(['top', 'left', 'right', 'bottom'] as BarPos[])
      .map((p) => `<button type="button" data-act="annot-pos" data-pos="${p}" class="pos-choice ${barPos === p ? 'on' : ''}" aria-pressed="${barPos === p}"><span class="pos-ico pos-ico-${p}"></span>${BAR_POS_LABEL[p]}</button>`)
      .join('')}</div>`;
  }
  // abre ao lado do botão, dentro da tela
  const anchor = annotBar.querySelector<HTMLElement>(`[data-pop="${annotPop}"]`);
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const pw = annotPopEl.offsetWidth;
  const ph = annotPopEl.offsetHeight;
  let x = r.left;
  let y = r.bottom + 8;
  if (barPos === 'bottom') y = r.top - ph - 8;
  if (barPos === 'left') [x, y] = [r.right + 8, r.top];
  if (barPos === 'right') [x, y] = [r.left - pw - 8, r.top];
  x = Math.max(8, Math.min(window.innerWidth - pw - 8, x));
  y = Math.max(8, Math.min(window.innerHeight - ph - 8, y));
  annotPopEl.style.left = `${x}px`;
  annotPopEl.style.top = `${y}px`;
}

function toggleAnnotPop(which: 'stamp' | 'pos') {
  annotPop = annotPop === which ? null : which;
  renderAnnotBar();
}

function setBarPos(p: BarPos) {
  barPos = p;
  annotPop = null;
  saveAnnotPrefs();
  renderAnnotBar();
  if (docView) void renderDocPages(true);
  else render();
  toast(`Barra de marcações: ${BAR_POS_LABEL[p].toLowerCase()}`);
}

function setStamp(s: string) {
  annotState.stamp = s;
  annotPop = null;
  setAnnotTool('stamp');
}

function setAnnotTool(t: BarTool) {
  annotHand = t === 'hand';
  if (t !== 'hand') annotState.tool = t;
  annotSelected = -1;
  scoreSelected = -1;
  saveAnnotPrefs();
  renderAnnotBar();
  scoreLayer?.setActive(marking && !annotHand);
  docLayers.forEach((l) => l.setActive(!annotHand));
}

function setAnnotColor(c: string) {
  annotState.color = c;
  saveAnnotPrefs();
  // com algo selecionado, a cor vale para ele
  if (selectedLayer()?.recolorSelected(c)) return renderAnnotBar();
  if (annotHand) setAnnotTool(annotState.tool);
  renderAnnotBar();
}

function annotResize(f: number) {
  selectedLayer()?.resizeSelected(f);
}

function annotDelete() {
  selectedLayer()?.deleteSelected();
}

function annotUndo() {
  if (docView) {
    const last = docUndo.pop();
    if (!last || !docStored) return;
    for (const { page, list } of last) {
      docStored.marks[page] = list;
      docLayers[page]?.draw();
    }
    persistDoc();
    return;
  }
  editor.undo();
}

function countMarks(): number {
  if (docView) return Object.values(docStored?.marks ?? {}).reduce((n, l) => n + l.length, 0);
  return editor.score.annotations?.length ?? 0;
}

async function annotClear() {
  const n = countMarks();
  const where = docView ? 'deste documento' : 'desta partitura';
  if (!n) return toast(`Não há marcações ${where} para apagar`);
  const ok = await askConfirm(
    'Limpar tudo?',
    `Todas as ${n === 1 ? '' : `${n} `}marcações ${where} serão apagadas${docView ? `, em todas as ${doc?.pages.length ?? 1} páginas` : ''}. As notas da partitura não mudam. Se mudar de ideia, Ctrl+Z (ou o botão desfazer) traz tudo de volta.`,
    `Apagar ${n === 1 ? 'a marcação' : `as ${n} marcações`}`,
  );
  if (!ok) return;
  if (docView && docStored) {
    docUndo.push(Object.entries(docStored.marks).map(([k, v]) => ({ page: Number(k), list: v })));
    docStored.marks = {};
    persistDoc();
    docLayers.forEach((l) => l.draw());
  } else {
    editor.setAnnotations([]);
  }
  toast('Marcações apagadas. Ctrl+Z desfaz.');
}

/** Teclas enquanto marca (na partitura ou no documento). */
function onAnnotKey(e: KeyboardEvent, mod: boolean): boolean {
  const k = e.key;
  if (mod && k.toLowerCase() === 'z' && !e.shiftKey) {
    annotUndo();
    return true;
  }
  if (mod) return false;
  const layer = selectedLayer();
  if (layer) {
    const step = e.shiftKey ? 0.02 : 0.004;
    if (k === 'Delete' || k === 'Backspace') return layer.deleteSelected();
    if (k === '+' || k === '=') return layer.resizeSelected(1.15);
    if (k === '-' || k === '_') return layer.resizeSelected(1 / 1.15);
    if (k === 'ArrowLeft') return layer.nudgeSelected(-step, 0);
    if (k === 'ArrowRight') return layer.nudgeSelected(step, 0);
    if (k === 'ArrowUp') return layer.nudgeSelected(0, -step);
    if (k === 'ArrowDown') return layer.nudgeSelected(0, step);
  }
  const tools: Record<string, BarTool> = { v: 'move', p: 'pen', r: 'highlight', t: 'text', s: 'stamp', e: 'erase', ...(docView ? { h: 'hand' } : {}) };
  const t = tools[k.toLowerCase()];
  if (t && !e.altKey) {
    setAnnotTool(t);
    return true;
  }
  return false;
}

/** Caixinha para digitar (ou corrigir) uma nota de texto onde a pessoa clicou. */
function askAnnotText(at: TextRequest): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.className = 'annot-input';
    input.placeholder = at.initial ? 'Corrija e aperte Enter (vazio apaga)' : 'Escreva e aperte Enter';
    input.value = at.initial ?? '';
    input.style.left = `${Math.min(at.clientX, window.innerWidth - 240)}px`;
    input.style.top = `${at.clientY - 14}px`;
    input.style.color = annotState.color;
    document.body.appendChild(input);
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(input.value);
      else if (e.key === 'Escape') finish(null);
    });
    input.addEventListener('blur', () => finish(at.initial !== undefined ? null : input.value));
    input.focus();
    input.select();
  });
}

/** Pergunta de confirmação no estilo do app (sem a caixa do navegador). */
function askConfirm(title: string, message: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ov = openOverlay('confirm');
    ov.querySelector('h2')!.textContent = title;
    ov.querySelector('.confirm-msg')!.textContent = message;
    const ok = ov.querySelector<HTMLButtonElement>('[data-confirm="ok"]')!;
    ok.textContent = okLabel;
    const cancel = ov.querySelector<HTMLButtonElement>('[data-confirm="cancel"]')!;
    const done = (v: boolean) => {
      ok.onclick = cancel.onclick = null;
      observer.disconnect();
      closeOverlays();
      resolve(v);
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    // fechado por Esc ou clique fora = cancelar
    const observer = new MutationObserver(() => ov.hidden && done(false));
    observer.observe(ov, { attributes: true, attributeFilter: ['hidden'] });
    cancel.focus();
  });
}

// ---------------------------------------------------------------- documentos (PDF e fotos)

let doc: OpenDocument | null = null;
let docStored: StoredDoc | null = null;
let docView = false;
let docLayers: AnnotationLayer[] = [];
/** Cada passo do desfazer pode mexer em várias páginas (ex.: Limpar tudo). */
let docUndo: Array<Array<{ page: number; list: Annotation[] }>> = [];
const OPEN_DOC_KEY = 'music-wiss:open-doc';
let docSaveTimer = 0;
let docRenderToken = 0;
const docViewEl = $<HTMLElement>('.doc-view');
const docPagesEl = $<HTMLElement>('.doc-pages');

async function openDoc(name: string, bytes: Uint8Array) {
  stopPlayback();
  const opened = await openDocument(name, bytes);
  if (docView) flushDoc(); // grava o documento anterior antes de trocar
  doc?.destroy();
  doc = opened;
  const id = await docId(bytes);
  docStored = (await loadDoc(id)) ?? { id, name, bytes, marks: {}, updatedAt: Date.now() };
  docStored.name = name;
  docUndo = [];
  analysis = null;
  analysisError = '';
  persistDoc(0);
  safeSet(OPEN_DOC_KEY, id);
  showDocView(true);
  const n = opened.pages.length;
  const marked = Object.values(docStored.marks).some((l) => l.length);
  toast(
    marked
      ? `Suas marcações voltaram${docStored.view ? ' e a página está onde você parou' : ''}. Use Mover para ajustar ou corrigir.`
      : `${opened.kind === 'pdf' ? `PDF com ${n} ${n === 1 ? 'página' : 'páginas'}` : 'Imagem aberta'}. Marque por cima ou peça para a IA ler.`,
  );
}

function showDocView(restore = false) {
  if (!doc) return;
  if (marking) marking = false;
  docView = true;
  annotHand = false;
  annotSelected = -1;
  $('.sheet').hidden = true;
  docViewEl.hidden = false;
  app.classList.add('doc-mode');
  $('.doc-name').textContent = doc.name;
  renderAnnotBar();
  void renderDocPages(false, restore);
}

function closeDocView() {
  if (!docView) return;
  saveDocScroll();
  try {
    localStorage.removeItem(OPEN_DOC_KEY);
  } catch {
    /* sem armazenamento */
  }
  docView = false;
  annotSelected = -1;
  docViewEl.hidden = true;
  $('.sheet').hidden = false;
  app.classList.remove('doc-mode');
  docLayers = [];
  docPagesEl.innerHTML = '';
  renderAnnotBar();
  render();
}

/**
 * Desenha as páginas. keepScroll mantém o ponto da leitura (ao redimensionar
 * ou mudar a barra de lugar); restore volta para onde a pessoa parou.
 */
async function renderDocPages(keepScroll = false, restore = false) {
  if (!doc || !docStored) return;
  const token = ++docRenderToken;
  const docTop = () => docPagesEl.getBoundingClientRect().top + window.scrollY;
  const oldHeight = docPagesEl.scrollHeight;
  const ratio = keepScroll && oldHeight ? (window.scrollY - docTop()) / oldHeight : null;
  const width = Math.min(1000, Math.max(280, docPagesEl.clientWidth - 8));
  docPagesEl.innerHTML = '';
  docLayers = [];
  const stored = docStored;
  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages[i];
    const box = document.createElement('div');
    box.className = 'doc-page';
    box.style.width = `${width}px`;
    box.style.height = `${(width * page.height) / page.width}px`;
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    docPagesEl.appendChild(box);
    const layer = new AnnotationLayer(
      box,
      annotState,
      () => stored.marks[i] ?? [],
      (list) => {
        docUndo.push([{ page: i, list: stored.marks[i] ?? [] }]);
        stored.marks[i] = list;
        persistDoc();
      },
      askAnnotText,
      (sel) => {
        // só uma marcação selecionada por vez, entre todas as páginas
        if (sel >= 0) docLayers.forEach((l) => l !== layer && l.selected >= 0 && ((l.selected = -1), l.draw()));
        setAnnotSelected(sel >= 0 ? sel : docLayers.some((l) => l.selected >= 0) ? 0 : -1);
      },
    );
    layer.setActive(!annotHand);
    docLayers.push(layer);
  }
  if (ratio !== null) window.scrollTo(0, docTop() + ratio * docPagesEl.scrollHeight);
  else if (restore && stored.view) window.scrollTo(0, docTop() + stored.view.scroll * docPagesEl.scrollHeight);
  else window.scrollTo(0, 0);
  // desenha as páginas uma por vez (as primeiras aparecem logo)
  for (let i = 0; i < doc.pages.length; i++) {
    if (token !== docRenderToken) return;
    const box = docPagesEl.children[i] as HTMLElement | undefined;
    const canvas = box?.querySelector('canvas');
    if (!canvas) return;
    try {
      await doc.pages[i].render(canvas, width);
    } catch (err) {
      console.error(err);
    }
  }
}

/** Grava o documento logo depois da mudança (vários ajustes seguidos viram uma gravação só). */
function persistDoc(delay = 500) {
  if (!docStored || docSaveTimer) return; // já tem gravação marcada: ela leva o estado mais novo
  docSaveTimer = window.setTimeout(() => {
    docSaveTimer = 0;
    if (docStored) void saveDoc({ ...docStored, updatedAt: Date.now() });
  }, delay);
}

function onDocKey(e: KeyboardEvent, mod: boolean) {
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    return annotUndo();
  }
  if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    return $<HTMLInputElement>('[data-file]').click();
  }
  if (e.key === 'Escape') {
    if (annotPop) {
      annotPop = null;
      return renderAnnotBar();
    }
    return closeDocView();
  }
  if (onAnnotKey(e, mod)) e.preventDefault();
}

/** Guarda em que ponto do documento a pessoa estava (para voltar ali). */
function saveDocScroll() {
  if (!docView || !docStored) return;
  const h = docPagesEl.scrollHeight;
  if (!h) return;
  const top = docPagesEl.getBoundingClientRect().top + window.scrollY;
  docStored.view = { scroll: Math.max(0, (window.scrollY - top) / h) };
  persistDoc();
}
let docScrollTimer = 0;
window.addEventListener('scroll', () => {
  if (!docView) return;
  clearTimeout(docScrollTimer);
  docScrollTimer = window.setTimeout(saveDocScroll, 400);
});
/** Grava já (sem esperar), ao sair ou trocar de aba. */
function flushDoc() {
  if (!docStored) return;
  saveDocScroll();
  clearTimeout(docSaveTimer);
  docSaveTimer = 0;
  void saveDoc({ ...docStored, updatedAt: Date.now() });
}
window.addEventListener('pagehide', flushDoc);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushDoc());

/** Ao voltar ao app, reabre o documento que estava aberto, no mesmo ponto. */
async function resumeOpenDoc() {
  let id: string | null = null;
  try {
    id = localStorage.getItem(OPEN_DOC_KEY);
  } catch {
    /* sem armazenamento */
  }
  if (!id || cloud.parseShareHash(location.hash)) return;
  const d = await loadDoc(id);
  if (!d) return;
  try {
    await openDoc(d.name, d.bytes);
  } catch {
    /* documento não abre mais: segue na partitura */
  }
}

async function exportDoc() {
  if (!doc || !docStored) return;
  toast('Gerando PDF com as marcações…');
  try {
    const blob = await exportAnnotatedPdf(doc, docStored.marks);
    download(`${doc.name.replace(/\.[^.]+$/, '')} (marcado).pdf`, blob);
    toast('PDF com marcações baixado');
  } catch (err) {
    console.error(err);
    toast('Não foi possível gerar o PDF');
  }
}

async function openRecentDocs() {
  const body = $('.docs-body');
  openOverlay('docs');
  body.innerHTML = '<p class="sound-note">Carregando…</p>';
  const list = await listDocs();
  body.innerHTML = list.length
    ? `<p class="sound-note">Ficam guardados neste navegador, com as marcações de cada página.</p>
       <ul class="cloud-list">${list
         .map(
           (d) => `<li class="${docStored?.id === d.id ? 'current' : ''}"><span class="cloud-title">${escapeHtml(d.name)}</span>
             <small>${new Date(d.updatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</small>
             <button type="button" class="icon-btn small" data-act="doc-open" data-id="${d.id}">Abrir</button>
             <button type="button" class="link-btn danger" data-act="doc-forget" data-id="${d.id}">Remover</button></li>`,
         )
         .join('')}</ul>`
    : '<p>Nenhum documento ainda. Abra um PDF ou uma foto de partitura pelo menu Arquivo → Abrir.</p>';
}

async function reopenDoc(id: string) {
  const d = await loadDoc(id);
  closeOverlays();
  if (!d) return toast('Não encontrei este documento');
  try {
    await openDoc(d.name, d.bytes);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}

async function forgetDoc(id: string) {
  await deleteDoc(id);
  if (docStored?.id === id) {
    closeDocView();
    doc?.destroy();
    doc = null;
    docStored = null;
  }
  void openRecentDocs();
}

// ---------------------------------------------------------------- ler e analisar (IA)

let analysis: { t: Transcription; score: Score; warnings: string[] } | null = null;
let analysisBusy = false;
let analysisError = '';
let analysisPages = '';
let analysisHint = '';

function openAnalysis() {
  if (!doc) return;
  if (!analysisPages) analysisPages = doc.pages.length > 1 ? `1-${Math.min(4, doc.pages.length)}` : '1';
  renderAnalysis();
  openOverlay('analysis');
}

/** "1-3, 5" → [0, 1, 2, 4] (no máximo 4 páginas que existem). */
function pickPages(text: string, count: number): number[] {
  const out: number[] = [];
  for (const part of text.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= count && !out.includes(i - 1)) out.push(i - 1);
  }
  return out.slice(0, 4);
}

function renderAnalysis() {
  const body = $('.analysis-body');
  if (!cloudConfig() || !session) {
    body.innerHTML = `<p>A leitura com IA roda no servidor do Music Wiss e precisa que você esteja conectado à nuvem.</p>
      <p class="sound-note">Enquanto isso, dá para marcar por cima do documento e baixar o PDF com as marcações.</p>
      <div class="cloud-actions"><button type="button" class="icon-btn primary" data-act="cloud">Abrir Nuvem</button></div>`;
    return;
  }
  const n = doc?.pages.length ?? 0;
  const a = analysis;
  const parts = a ? a.score.parts.map((p) => `${escapeHtml(p.name)} (${p.staves.length === 1 ? '1 pauta' : `${p.staves.length} pautas`})`).join(', ') : '';
  body.innerHTML = `
    <p class="sound-note">A IA lê as páginas, transcreve as notas e aponta o que vale revisar. Funciona melhor com partitura impressa e foto reta e nítida; manuscritos saem aproximados.</p>
    <div class="cloud-form">
      ${n > 1 ? `<label>Páginas (até 4 por vez, de ${n})<input name="pages" value="${escapeHtml(analysisPages)}" placeholder="1-4" /></label>` : ''}
      <label>Observação (opcional)<input name="hint" value="${escapeHtml(analysisHint)}" placeholder="ex.: é para coral; o 2º sistema está apagado" /></label>
      <div class="cloud-actions"><button type="button" class="icon-btn primary" data-act="an-run" ${analysisBusy ? 'disabled' : ''}>${analysisBusy ? 'Lendo a partitura… (pode levar 1–2 min)' : a ? 'Ler de novo' : 'Ler e analisar'}</button></div>
    </div>
    ${analysisError ? `<p class="cloud-msg">${escapeHtml(analysisError)}</p>` : ''}
    ${a ? `<section class="ai-answer">
      <p>${escapeHtml(a.t.summary)}</p>
      ${a.score.parts.length ? `<p class="sound-note"><b>${escapeHtml(a.score.title)}</b>${a.score.composer ? ` · ${escapeHtml(a.score.composer)}` : ''} · ${a.score.timeSignature.beats}/${a.score.timeSignature.beatType} · ${escapeHtml(keyName(a.score.keyFifths))} · ${a.score.parts[0].staves[0].measures.length - 1} compassos · ${parts}</p>` : ''}
      ${a.t.issues.length ? `<h3 class="an-h">Para conferir</h3><ul class="ai-issues">${a.t.issues.map((i) => `<li><b>Compasso ${i.measure}</b> ${escapeHtml(i.message)}</li>`).join('')}</ul>` : ''}
      ${a.t.suggestions.length ? `<h3 class="an-h">Sugestões de edição</h3><ul class="ai-issues">${a.t.suggestions.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''}
      ${a.warnings.length ? `<ul class="ai-issues muted">${a.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
      ${a.score.parts.length ? `<div class="cloud-actions">
        <button type="button" class="icon-btn primary" data-act="an-open">Abrir como partitura editável</button>
        <button type="button" class="icon-btn" data-act="an-play">${ICON.play}<span>Abrir e tocar</span></button>
      </div>
      <p class="sound-note">A partitura atual é substituída (salve antes se precisar). O documento continua em Arquivo → Documentos recentes.</p>` : ''}
    </section>` : ''}`;
}

$('.analysis-body').addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.name === 'pages') analysisPages = el.value;
  if (el.name === 'hint') analysisHint = el.value;
});

async function runAnalysis() {
  if (!doc) return;
  const pages = pickPages(analysisPages || '1', doc.pages.length);
  if (!pages.length) {
    analysisError = 'Escolha as páginas, por exemplo 1-3.';
    return renderAnalysis();
  }
  analysisBusy = true;
  analysisError = '';
  renderAnalysis();
  try {
    const images = await pagesAsJpeg(doc, pages);
    const t = await cloud.askTranscription(images, analysisHint);
    if (!t.parts.length) {
      analysis = { t, score: editor.score, warnings: [] };
      analysis.score = { ...editor.score, parts: [] };
    } else {
      const { score, warnings } = transcriptionToScore(t);
      analysis = { t, score, warnings };
    }
  } catch (err) {
    analysisError = err instanceof Error ? err.message : String(err);
  }
  analysisBusy = false;
  if (!$('[data-overlay="analysis"]').hidden) renderAnalysis();
  else if (analysis && !analysisError) toast('A leitura terminou: abra "Ler e analisar" para ver');
}

function applyAnalysis(play: boolean) {
  if (!analysis?.score.parts.length) return;
  closeOverlays();
  openLocal(analysis.score);
  toast(play ? 'Tocando a transcrição' : 'Partitura aberta: confira os compassos apontados');
  if (play) togglePlay();
}

let docResizeTimer = 0;
window.addEventListener('resize', () => {
  if (!docView) return;
  clearTimeout(docResizeTimer);
  docResizeTimer = window.setTimeout(() => void renderDocPages(true), 200);
});

// ---------------------------------------------------------------- início

let savedTheme: string | null = null;
try {
  savedTheme = localStorage.getItem(THEME_KEY);
} catch {
  /* sem armazenamento */
}
const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
updatePlayButton();
// espera a fonte SMuFL carregar antes do primeiro desenho
document.fonts.load('30px Bravura').finally(() => applyTheme(savedTheme === 'dark' || (!savedTheme && prefersDark) ? 'dark' : 'light'));
applyTheme(savedTheme === 'dark' || (!savedTheme && prefersDark) ? 'dark' : 'light');
void initCloud();
if (annotPrefs.marking) toggleMarking(true);
void resumeOpenDoc();
