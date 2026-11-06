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
import type { RenderResult, RenderTheme } from './render/renderer';
import type { Command } from './ui/commands';
import { DURATION_GLYPH, DURATION_KEYS, GLYPH, SHORTCUTS } from './ui/commands';
import { ICON } from './ui/icons';
import { exportMusicXml } from './io/musicxml-export';
import { importMusicXml, readMusicXmlFile } from './io/musicxml-import';
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
        <button data-act="open">${ICON.upload}<span>Abrir…</span><small>MusicXML, .mxl, .wiss.json</small></button>
        <button data-act="save">${ICON.download}<span>Salvar</span><small>.wiss.json · Ctrl S</small></button>
        <hr />
        <button data-act="export-pdf"><span class="fmt">PDF</span><span>Exportar PDF</span><small>para imprimir</small></button>
        <button data-act="export-xml"><span class="fmt">XML</span><span>Exportar MusicXML</span><small>abre em outros programas</small></button>
        <button data-act="export-midi"><span class="fmt">MID</span><span>Exportar MIDI</span><small>sequenciadores e DAWs</small></button>
      </div>
    </div>
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
  </main>

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
  <div class="toast"></div>
  <input type="file" accept=".sf2,.sf3" hidden data-soundfont />
  <input type="file" accept=".json,.musicxml,.xml,.mxl,application/json,application/xml" hidden data-file />
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
  hintEl.hidden = editor.events().length > 0 || editor.inputMode;
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
    { id: 'open', label: 'Abrir arquivo (MusicXML, .mxl, .wiss.json)…', hint: 'Ctrl O', run: () => $<HTMLInputElement>('[data-file]').click() },
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
    { id: 'demo', label: 'Carregar exemplo', run: () => editor.load(demoScore()) },
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
      editor.load(migrateScore(data.score as Score));
      toast('Partitura aberta');
      return;
    }
    const { score, warnings } = importMusicXml(readMusicXmlFile(name, bytes));
    editor.load(score);
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
  if (muteNextSound) muteNextSound = false;
  else sound(change.sounded);
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
    case 'file-menu': return toggleMenu();
    case 'open': closeMenu(); return $<HTMLInputElement>('[data-file]').click();
    case 'save': closeMenu(); return exportJson();
    case 'export-pdf': closeMenu(); return void exportPdfFile();
    case 'export-xml': closeMenu(); return exportXml();
    case 'export-midi': closeMenu(); return exportMid();
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
  if (!lastRender) return;
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
