import './ui/style.css';
import { Editor } from './editor/editor';
import { WebAudioSynth } from './audio/synth';
import { schedule } from './audio/sequencer';
import { DURATION_NAMES_PT, DURATION_ORDER } from './model/duration';
import type { Fifths } from './model/key';
import { keyName } from './model/key';
import { pitchLabel, toMidi } from './model/pitch';
import type { Step } from './model/pitch';
import type { Score } from './model/score';
import { createScore, effectiveTimeSignature, INSTRUMENTS } from './model/score';
import { describeValidation, validateStaff } from './model/validation';
import { renderScore } from './render/renderer';
import type { RenderResult, RenderTheme } from './render/renderer';
import type { Command } from './ui/commands';
import { DURATION_GLYPH, DURATION_KEYS, GLYPH, SHORTCUTS } from './ui/commands';
import { ICON } from './ui/icons';

const STORAGE_KEY = 'music-wiss:score';
const THEME_KEY = 'music-wiss:theme';

// ---------------------------------------------------------------- estado

const editor = new Editor(loadSaved() ?? demoScore());
const synth = new WebAudioSynth();
let lastRender: RenderResult | null = null;
let playing: { timers: number[]; index: number | null } | null = null;

// ---------------------------------------------------------------- DOM

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand"><img src="/favicon.svg" alt="" /><span>Music Wiss</span></div>
    <div class="spacer"></div>
    <button class="icon-btn" data-act="palette" title="Paleta de comandos (Ctrl+K)">${ICON.search}<span>Comandos</span><span class="kbd">Ctrl K</span></button>
    <button class="icon-btn" data-act="new" title="Nova partitura">${ICON.plus}<span>Nova</span></button>
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
  </main>

  <aside class="status" aria-live="polite"></aside>
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
        <label>Instrumento<select name="instrument">${INSTRUMENTS.map((i) => `<option value="${i.id}">${i.name}</option>`).join('')}</select></label>
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
  <div class="toast"></div>
  <input type="file" accept=".json,application/json" hidden data-file />
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
    selected: editor.cursor > 0 ? editor.cursor - 1 : null,
    playing: playing?.index ?? null,
    cursor: editor.cursor,
    showCursor: editor.inputMode && !playing,
    theme: renderTheme(),
  });
  if (lastRender.cursor) {
    const c = document.createElement('div');
    c.className = 'caret';
    Object.assign(c.style, { left: `${lastRender.cursor.x}px`, top: `${lastRender.cursor.y}px`, height: `${lastRender.cursor.height}px` });
    scoreEl.appendChild(c);
  }
  hintEl.hidden = editor.events().length > 0 || editor.inputMode;
  renderDock();
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
  `;
}

function renderStatus() {
  const staff = editor.staff;
  const score = editor.score;
  const validations = validateStaff(score, staff);
  const { measure } = cursorMeasure();
  const v = validations[measure];
  const ts = effectiveTimeSignature(score, staff, measure);
  const sel = editor.selected();
  const selText = sel ? (sel.kind === 'rest' ? 'Pausa' : sel.notes.map((n) => pitchLabel(n.pitch)).join(' + ')) : '—';
  statusEl.innerHTML = `
    <span class="chip"><span class="led ${v?.state ?? ''}"></span>Compasso <b>${measure + 1}</b> · ${ts.beats}/${ts.beatType} · ${v ? describeValidation(v) : ''}</span>
    <span class="chip">Selecionado <b>${selText}</b>${sel ? ` · ${DURATION_NAMES_PT[sel.duration.type]}${sel.duration.dots ? ' pontuada' : ''}` : ''}</span>
    <span class="chip">${keyName(score.keyFifths)} · ${score.parts[0].name}</span>
  `;
}

/** Compasso onde está o cursor: o do próximo evento, ou o último compasso (sempre livre ou incompleto). */
function cursorMeasure(): { measure: number } {
  const events = editor.events();
  const ms = editor.staff.measures;
  const next = events[editor.cursor];
  if (!next) return { measure: ms.length - 1 };
  const i = ms.findIndex((m) => m.voices[0]?.events.some((e) => e.id === next.id));
  return { measure: Math.max(0, i) };
}

// ---------------------------------------------------------------- áudio

function sound(pitches: { step: Step; alter: number; octave: number }[] | undefined) {
  if (!pitches?.length || playing) return;
  const t = synth.now();
  const transp = editor.score.parts[0].transposition;
  for (const p of pitches) synth.play(toMidi(p as never) + transp, t, 0.45, 0.7);
}

function togglePlay() {
  if (playing) return stopPlayback();
  const from = editor.cursor >= editor.events().length ? 0 : editor.cursor;
  const { notes, onsets, total } = schedule(editor.score, from);
  if (!notes.length) return toast('Nada para tocar ainda');
  const t0 = synth.now() + 0.08;
  for (const n of notes) synth.play(n.midi, t0 + n.start, n.duration * 0.95);
  playing = { timers: [], index: null };
  onsets.forEach((o, i) => {
    if (i < from) return;
    playing!.timers.push(window.setTimeout(() => {
      if (!playing) return;
      playing.index = i;
      render();
    }, (o + 0.08) * 1000));
  });
  playing.timers.push(window.setTimeout(stopPlayback, (total + 0.4) * 1000));
  updatePlayButton();
  render();
}

function stopPlayback() {
  if (!playing) return;
  playing.timers.forEach((t) => clearTimeout(t));
  playing = null;
  synth.stopAll();
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

  const key = e.key;
  const lower = key.toLowerCase();
  let handled = true;

  if (lower === 'n' && !mod) editor.toggleInputMode();
  else if (key === 'Escape') editor.toggleInputMode(false);
  else if (key === ' ') togglePlay();
  else if (key === '?') openOverlay('help');
  else if (DURATION_KEYS[key] && !mod) {
    if (editor.inputMode) editor.setDuration(DURATION_KEYS[key]);
    else editor.setSelectedDuration(DURATION_KEYS[key]);
  } else if (key === '.') editor.toggleDot();
  else if (key === '0' && editor.inputMode) editor.insertRest();
  else if (LETTERS[lower] && !mod && editor.inputMode) {
    if (e.shiftKey) editor.addToChord(LETTERS[lower]);
    else editor.insertStep(LETTERS[lower]);
  } else if (key === '+' || key === '=') editor.shiftAlter(1);
  else if (key === '-' || key === '_') editor.shiftAlter(-1);
  else if (lower === 't' && !mod) editor.toggleTie();
  else if (key === 'ArrowLeft') editor.moveCursor(-1);
  else if (key === 'ArrowRight') editor.moveCursor(1);
  else if (key === 'ArrowUp') editor.transposeSelected(mod ? 'octave' : 'semitone', 1);
  else if (key === 'ArrowDown') editor.transposeSelected(mod ? 'octave' : 'semitone', -1);
  else if (key === 'Backspace') editor.deleteBackward();
  else if (key === 'Delete') editor.deleteForward();
  else if (key === '[') editor.stepDuration(-1);
  else if (key === ']') editor.stepDuration(1);
  else if (key === 'Home') editor.setCursor(0);
  else if (key === 'End') editor.setCursor(editor.events().length);
  else handled = false;

  if (handled) e.preventDefault();
}

// ---------------------------------------------------------------- paleta de comandos

function commands(): Command[] {
  const list: Command[] = [
    { id: 'mode', label: editor.inputMode ? 'Sair do modo de escrita' : 'Entrar no modo de escrita', hint: 'N', run: () => editor.toggleInputMode() },
    { id: 'play', label: playing ? 'Parar reprodução' : 'Tocar a partir do cursor', hint: 'Espaço', run: togglePlay },
    { id: 'new', label: 'Nova partitura…', run: () => openOverlay('new') },
    { id: 'save', label: 'Salvar arquivo (.json)', hint: 'Ctrl S', run: exportJson },
    { id: 'open', label: 'Abrir arquivo (.json)…', run: () => $<HTMLInputElement>('[data-file]').click() },
    { id: 'theme', label: 'Alternar tema claro/escuro', run: () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') },
    { id: 'help', label: 'Ver atalhos de teclado', hint: '?', run: () => openOverlay('help') },
    { id: 'undo', label: 'Desfazer', hint: 'Ctrl Z', run: () => editor.undo() },
    { id: 'redo', label: 'Refazer', hint: 'Ctrl Y', run: () => editor.redo() },
    { id: 'tie', label: 'Ligadura de prolongamento', hint: 'T', run: () => editor.toggleTie() },
    { id: 'sharp', label: 'Sustenido', hint: '+', run: () => editor.setAlter(1) },
    { id: 'flat', label: 'Bemol', hint: '−', run: () => editor.setAlter(-1) },
    { id: 'natural', label: 'Bequadro (natural)', run: () => editor.setAlter(0) },
    { id: 'demo', label: 'Carregar exemplo', run: () => editor.load(demoScore()) },
  ];
  DURATION_ORDER.forEach((type, i) =>
    list.push({ id: `dur-${type}`, label: `Figura: ${DURATION_NAMES_PT[type]}`, hint: String(i + 1), run: () => (editor.inputMode ? editor.setDuration(type) : editor.setSelectedDuration(type)) }),
  );
  for (let f = -7; f <= 7; f++) {
    list.push({ id: `key${f}`, label: `Tonalidade: ${keyName(f as Fifths)}`, run: () => editor.mutate((s) => (s.keyFifths = f as Fifths)) });
  }
  for (const t of ['4/4', '3/4', '2/4', '6/8', '9/8', '12/8', '5/4', '2/2']) {
    const [beats, beatType] = t.split('/').map(Number);
    list.push({ id: `ts${t}`, label: `Fórmula de compasso: ${t}`, run: () => editor.mutate((s) => (s.timeSignature = { beats, beatType })) });
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

function exportJson() {
  const blob = new Blob([JSON.stringify({ format: 'music-wiss', version: 1, score: editor.score }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${editor.score.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'partitura'}.wiss.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Arquivo salvo');
}

async function importJson(file: File) {
  try {
    const data = JSON.parse(await file.text());
    if (data?.format !== 'music-wiss' || !data.score?.parts) throw new Error();
    editor.load(data.score as Score);
    toast('Partitura aberta');
  } catch {
    toast('Arquivo inválido');
  }
}

function loadSaved(): Score | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Score) : null;
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
  const score = createScore({ title: 'Primeira melodia', composer: 'Music Wiss', tempo: 100, timeSignature: { beats: 3, beatType: 4 }, keyFifths: 1 });
  const ed = new Editor(score);
  const melody: Array<[Step, '2' | '3' | '4', boolean?]> = [
    ['D', '3'], ['G', '3'], ['A', '4'], ['B', '4'],
    ['C', '3'], ['B', '3'], ['A', '3'],
    ['G', '4'], ['A', '4'], ['B', '3'], ['D', '3', true],
    ['G', '2'],
  ];
  for (const [step, d] of melody) {
    ed.setDuration(DURATION_KEYS[d]);
    ed.insertStep(step);
  }
  ed.setDuration('quarter');
  ed.insertRest();
  return ed.score;
}

// ---------------------------------------------------------------- eventos

editor.onChange((change) => {
  sound(change.sounded);
  autosave();
  render();
});

window.addEventListener('keydown', onKey);
window.addEventListener('resize', () => render());

app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act], [data-dur], [data-cmd], [data-close]');
  if (!el) return;
  if (el.dataset.close !== undefined) return closeOverlays();
  if (el.dataset.cmd) return runCommand(el.dataset.cmd);
  if (el.dataset.dur) {
    const type = el.dataset.dur as (typeof DURATION_ORDER)[number];
    return editor.inputMode ? editor.setDuration(type) : editor.setSelectedDuration(type);
  }
  switch (el.dataset.act) {
    case 'mode': return editor.toggleInputMode();
    case 'play': return togglePlay();
    case 'new': return openOverlay('new');
    case 'palette': return openPalette();
    case 'theme': return applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    case 'dot': return editor.toggleDot();
    case 'rest': return editor.inputMode ? editor.insertRest() : undefined;
    case 'flat': return editor.setAlter(-1);
    case 'sharp': return editor.setAlter(1);
    case 'natural': return editor.setAlter(0);
    case 'tie': return editor.toggleTie();
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
  editor.load(
    createScore({
      title: String(f.get('title') || 'Sem título'),
      composer: String(f.get('composer') || ''),
      instrumentId: String(f.get('instrument')),
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
  if (file) void importJson(file);
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
  if (!lastRender) return;
  const rect = scoreEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const hit = lastRender.hits.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
  if (hit) {
    editor.setCursor(hit.index + 1);
    sound(editor.selected()?.notes.map((n) => n.pitch));
  }
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
