import type { AudioEngine } from '../audio/engine';
import { METRO_BUS } from '../audio/engine';
import type { MetroPattern } from '../audio/metronome';
import { beatsOf, clampBpm, DOC_TIME_SIGNATURES, MAX_BPM, MIN_BPM, PATTERNS } from '../audio/metronome';
import type { OpenDocument } from '../doc/document';
import { readDocument } from './analyze';
import type { ReadingMap, ReadMeasure } from './model';
import { barClicks, blockers, bpmFor, flagShapes, mergeWithNext, openFlags, playOrder, sanitizeMap, splitMeasure, tempoAt, totalSeconds, tsAt } from './model';

/**
 * Painel "Ler e tocar" da aba Editar: analisa o PDF/foto, mostra o que foi
 * reconhecido para revisar e corrigir e, depois de confirmado, toca o
 * metrônomo seguindo os compassos, com o compasso atual destacado na página.
 */

export interface ReaderHost {
  engine: AudioEngine;
  toast(msg: string): void;
  /** Documento aberto e o mapa guardado com ele. */
  current(): { doc: OpenDocument; map: ReadingMap | null } | null;
  save(map: ReadingMap | null): void;
  /** As caixas das páginas (.doc-page), na ordem. */
  pages(): HTMLElement[];
  /** O painel abriu/fechou: a área das páginas muda de largura. */
  relayout(): void;
  /** Número grande da contagem (o mesmo do metrônomo). */
  countEl: HTMLElement;
  /** Outro som do app vai começar: pare o resto. */
  stopOthers(): void;
}

interface Prefs {
  follow: boolean;
  speed: number;
  fixedBpm: number;
  volume: number;
  countIn: boolean;
  pattern: MetroPattern;
}

const PREFS_KEY = 'music-wiss:reading';
const DEFAULT_PREFS: Prefs = { follow: true, speed: 1, fixedBpm: 80, volume: 0.75, countIn: true, pattern: 'tempos' };

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      follow: typeof raw.follow === 'boolean' ? raw.follow : DEFAULT_PREFS.follow,
      speed: typeof raw.speed === 'number' ? Math.max(0.25, Math.min(2, raw.speed)) : DEFAULT_PREFS.speed,
      fixedBpm: typeof raw.fixedBpm === 'number' ? clampBpm(raw.fixedBpm) : DEFAULT_PREFS.fixedBpm,
      volume: typeof raw.volume === 'number' ? Math.max(0, Math.min(1, raw.volume)) : DEFAULT_PREFS.volume,
      countIn: typeof raw.countIn === 'boolean' ? raw.countIn : DEFAULT_PREFS.countIn,
      pattern: PATTERNS.some((p) => p.id === raw.pattern) ? (raw.pattern as MetroPattern) : DEFAULT_PREFS.pattern,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmtTime = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

type View = 'intro' | 'busy' | 'error' | 'review' | 'play';

export class ReadingPanel {
  readonly el: HTMLElement;
  private view: View = 'intro';
  private map: ReadingMap | null = null;
  private selected = -1;
  private error = '';
  private progress = '';
  private cancelRead = false;
  private prefs = loadPrefs();
  /** Reprodução em andamento. */
  private run: {
    timer: number;
    timers: number[];
    order: number[];
    pos: number;
    nextAt: number;
    /** Índice do compasso que está tocando agora. */
    now: number;
  } | null = null;
  private paused = false;
  /** Onde a reprodução recomeça (compasso escolhido na página). */
  private startAt = 0;

  constructor(private host: ReaderHost) {
    this.el = document.createElement('aside');
    this.el.className = 'rd-panel';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Ler e tocar com metrônomo');
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('change', (e) => this.onChange(e));
    this.el.addEventListener('input', (e) => this.onInput(e));
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).matches('input[type="number"]')) (e.target as HTMLInputElement).blur();
    });
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  get isPlaying(): boolean {
    return !!this.run;
  }

  /** Espaço no modo tocar: toca/pausa. Devolve true se usou a tecla. */
  key(): boolean {
    if (this.view !== 'play') return false;
    this.toggle();
    return true;
  }

  /** Abre o painel com o documento atual (retoma a leitura guardada, se houver). */
  show() {
    const cur = this.host.current();
    if (!cur) return;
    this.map = cur.map ? sanitizeMap(cur.map) : null;
    this.view = this.map ? (this.map.confirmed ? 'play' : 'review') : 'intro';
    this.selected = -1;
    this.startAt = 0;
    this.el.hidden = false;
    document.body.classList.add('reading-open');
    this.host.relayout();
    this.render();
    this.decorate();
    (this.el.querySelector<HTMLElement>('[data-rd="close"]'))?.focus({ preventScroll: true });
  }

  hide() {
    this.stop();
    this.cancelRead = true;
    this.el.hidden = true;
    document.body.classList.remove('reading-open');
    this.host.pages().forEach((p) => p.querySelector('.rd-layer')?.remove());
    this.host.relayout();
  }

  /** Documento trocou ou fechou. */
  reset() {
    if (this.open) this.hide();
    this.map = null;
  }

  // ------------------------------------------------------------ análise

  private async analyze() {
    const cur = this.host.current();
    if (!cur) return;
    this.stop();
    this.view = 'busy';
    this.cancelRead = false;
    this.progress = 'Preparando…';
    this.render();
    try {
      const map = await readDocument(
        cur.doc,
        (p, n) => {
          this.progress = n > 1 ? `Lendo página ${p} de ${n}…` : 'Lendo a página…';
          const el = this.el.querySelector('.rd-progress');
          if (el) el.textContent = this.progress;
        },
        () => this.cancelRead,
      );
      if (this.cancelRead) return;
      this.map = map;
      this.selected = -1;
      this.view = 'review';
      this.host.save(map);
      const found = map.measures.length;
      this.host.toast(found ? `Achei ${found} compassos. Confira antes de tocar.` : 'Não achei pautas nesta partitura.');
    } catch (err) {
      if (this.cancelRead) return;
      this.error = (err as Error).message || 'Não consegui ler esta partitura.';
      this.view = 'error';
    }
    this.render();
    this.decorate();
  }

  // ------------------------------------------------------------ eventos

  private onClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-rd]');
    if (!el) return;
    const map = this.map;
    const i = this.selected;
    const m = map && i >= 0 ? map.measures[i] : null;
    switch (el.dataset.rd) {
      case 'close':
        return this.hide();
      case 'analyze':
        return void this.analyze();
      case 'cancel':
        this.cancelRead = true;
        this.view = this.map ? 'review' : 'intro';
        return this.render();
      case 'goto':
        return this.select(Number(el.dataset.i), true);
      case 'prev':
        return this.select(Math.max(0, i - 1), true);
      case 'next':
        return this.select(Math.min((map?.measures.length ?? 1) - 1, i + 1), true);
      case 'ok':
        if (m) m.ok = !m.ok;
        return this.changed();
      case 'skip':
        if (m) m.skip = !m.skip;
        if (map) flagShapes(map.measures, map.initialTs.value);
        return this.changed();
      case 'merge':
        if (map && i >= 0 && !mergeWithNext(map, i)) this.host.toast('Só dá para juntar com o próximo compasso da mesma linha.');
        return this.changed();
      case 'split':
        if (map && i >= 0) splitMeasure(map, i);
        return this.changed();
      case 'confirm': {
        if (!map) return;
        const b = blockers(map);
        if (b.length) return this.host.toast(b[0]);
        map.confirmed = true;
        this.view = 'play';
        this.startAt = 0;
        this.host.save(map);
        this.render();
        return this.decorate();
      }
      case 'review':
        this.stop();
        if (map) map.confirmed = false;
        this.view = 'review';
        if (map) this.host.save(map);
        this.render();
        return this.decorate();
      case 'play':
        return this.toggle();
      case 'stop':
        this.stop();
        this.paused = false;
        this.startAt = 0;
        return this.render();
      case 'follow':
        this.prefs.follow = el.dataset.v === '1';
        return this.savePrefs();
      case 'bpm-step': {
        const d = Number(el.dataset.d);
        if (this.prefs.follow) this.prefs.speed = Math.max(0.25, Math.min(2, Math.round((this.prefs.speed + d / 100) * 100) / 100));
        else this.prefs.fixedBpm = clampBpm(this.prefs.fixedBpm + d);
        return this.savePrefs();
      }
    }
  }

  private onChange(e: Event) {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const k = el.dataset.rdf;
    const map = this.map;
    if (!k) return;
    if (k === 'countIn' || k === 'pattern') {
      if (k === 'countIn') this.prefs.countIn = (el as HTMLInputElement).checked;
      else this.prefs.pattern = el.value as MetroPattern;
      return this.savePrefs();
    }
    if (!map) return;
    const m = this.selected >= 0 ? map.measures[this.selected] : null;
    if (k === 'initialTs') map.initialTs = { value: el.value || null, source: el.value ? 'user' : null };
    else if (k === 'initialBpm') {
      const v = Number(el.value);
      map.initialTempo = v > 0 ? { bpm: clampBpm(v), label: map.initialTempo.label, source: 'user' } : { bpm: null, label: '', source: null };
    } else if (k === 'ts' && m) {
      m.ts = el.value || undefined;
      m.tsSource = el.value ? 'user' : undefined;
    } else if (k === 'tempo' && m) {
      const v = Number(el.value);
      m.tempo = v > 0 ? { kind: 'set', bpm: clampBpm(v), label: `♩ = ${clampBpm(v)}`, source: 'user' } : undefined;
      m.flags = m.flags.filter((f) => !['tempo-word', 'gradual', 'rubato', 'fermata'].includes(f.kind) || !(v > 0));
    } else if (k === 'beats' && m) {
      const v = Number(el.value);
      m.beats = v > 0 ? Math.min(32, Math.round(v * 2) / 2) : undefined;
      if (m.beats) m.ok = true;
    }
    flagShapes(map.measures, map.initialTs.value);
    this.changed();
  }

  private onInput(e: Event) {
    const el = e.target as HTMLInputElement;
    if (el.dataset.rdf === 'volume') {
      this.prefs.volume = Number(el.value);
      this.host.engine.setBus(METRO_BUS, this.prefs.volume);
      this.savePrefs(false);
    } else if (el.dataset.rdf === 'speed') {
      if (this.prefs.follow) this.prefs.speed = Number(el.value) / 100;
      else this.prefs.fixedBpm = clampBpm(Number(el.value));
      this.savePrefs(false);
      this.renderTempoReadout();
    }
  }

  private savePrefs(rerender = true) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      /* sem armazenamento */
    }
    if (rerender) this.render();
  }

  private changed() {
    if (this.map) this.host.save(this.map);
    if (this.map && this.selected >= this.map.measures.length) this.selected = this.map.measures.length - 1;
    this.render();
    this.decorate();
  }

  /** Escolhe um compasso (na lista ou clicando na página). */
  select(index: number, scroll = false) {
    if (!this.map || !this.map.measures[index]) return;
    if (this.view === 'play') {
      this.startAt = index;
      if (this.run) this.restartAt(index);
      else this.render();
    } else {
      this.selected = index;
      this.render();
    }
    this.decorate();
    if (scroll) this.scrollTo(index);
    if (this.view === 'review') this.el.querySelector<HTMLElement>('.rd-measure-edit')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ------------------------------------------------------------ página

  /** Desenha as caixas dos compassos por cima das páginas. */
  decorate() {
    const pages = this.host.pages();
    pages.forEach((p) => p.querySelector('.rd-layer')?.remove());
    if (!this.open || !this.map || this.view === 'intro' || this.view === 'busy') return;
    const flagged = new Set(openFlags(this.map).map((f) => f.index));
    const now = this.run?.now ?? -1;
    let n = 0;
    const numbers = new Map<number, number>();
    this.map.measures.forEach((m, i) => !m.skip && numbers.set(i, ++n));
    pages.forEach((pageEl, pi) => {
      const layer = document.createElement('div');
      layer.className = `rd-layer ${this.view}`;
      layer.innerHTML = this.map!.measures.map((m, i) => {
        if (m.page !== pi) return '';
        const cls = ['rd-m', m.skip ? 'skip' : '', flagged.has(i) ? 'warn' : '', m.ok ? 'ok' : '', i === this.selected && this.view === 'review' ? 'sel' : '', i === now ? 'now' : '', this.view === 'play' && !this.run && i === this.startAt ? 'start' : '']
          .filter(Boolean)
          .join(' ');
        const label = m.skip ? 'ignorado' : `Compasso ${numbers.get(i)}${flagged.has(i) ? ' — precisa de atenção' : ''}`;
        return `<button type="button" class="${cls}" data-i="${i}" style="left:${m.box.x * 100}%;top:${m.box.y * 100}%;width:${m.box.w * 100}%;height:${m.box.h * 100}%" aria-label="${label}" title="${label}"><span>${m.skip ? '×' : numbers.get(i)}</span></button>`;
      }).join('');
      layer.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('.rd-m');
        if (b) this.select(Number(b.dataset.i));
      });
      pageEl.appendChild(layer);
    });
  }

  private setNow(index: number) {
    if (!this.run) return;
    this.run.now = index;
    for (const b of document.querySelectorAll<HTMLElement>('.rd-layer .rd-m.now')) b.classList.remove('now');
    const box = document.querySelector<HTMLElement>(`.rd-layer .rd-m[data-i="${index}"]`);
    box?.classList.add('now');
    const nums = this.numbers();
    const label = this.el.querySelector('.rd-now');
    if (label) label.innerHTML = `Compasso <b>${nums.get(index) ?? '–'}</b> de ${nums.size}`;
    const bpm = this.el.querySelector('.rd-now-bpm');
    if (bpm && this.map) bpm.textContent = `${bpmFor(this.map, index, this.prefs)} BPM · ${this.tsLabel(index)}`;
    if (box) this.keepVisible(box);
  }

  private keepVisible(box: HTMLElement) {
    const r = box.getBoundingClientRect();
    const top = 90;
    if (r.top < top || r.bottom > window.innerHeight - 40) {
      window.scrollTo({ top: window.scrollY + r.top - window.innerHeight * 0.3, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }

  private scrollTo(index: number) {
    const box = document.querySelector<HTMLElement>(`.rd-layer .rd-m[data-i="${index}"]`);
    if (box) this.keepVisible(box);
  }

  private numbers(): Map<number, number> {
    const out = new Map<number, number>();
    let n = 0;
    this.map?.measures.forEach((m, i) => !m.skip && out.set(i, ++n));
    return out;
  }

  private tsLabel(index: number) {
    const t = this.map ? tsAt(this.map, index) : { beats: 4, beatType: 4 };
    return `${t.beats}/${t.beatType}`;
  }

  // ------------------------------------------------------------ tocar

  private toggle() {
    if (this.run) return this.pause();
    this.play(this.startAt);
  }

  private play(from: number) {
    const map = this.map;
    if (!map) return;
    const order = playOrder(map, from);
    if (!order.length) return this.host.toast('Não há compassos para tocar a partir daqui.');
    this.host.stopOthers();
    const engine = this.host.engine;
    engine.setBus(METRO_BUS, this.prefs.volume);
    let t = engine.now() + 0.12;
    const run = { timer: 0, timers: [] as number[], order, pos: 0, nextAt: t, now: -1 };
    this.run = run;
    this.paused = false;
    // contagem: um compasso da fórmula do primeiro, no andamento dele
    if (this.prefs.countIn) {
      const first = order[0];
      const ts = tsAt(map, first);
      const { count, unit } = beatsOf(ts);
      const beat = unit.toNumber() * 4 * (60 / bpmFor(map, first, this.prefs));
      for (let b = 0; b < count; b++) {
        engine.click(t + b * beat, b === 0 ? 'accent' : 'beat');
        this.later(t + b * beat, () => this.count(b + 1, count));
      }
      t += count * beat;
      this.later(t, () => this.count(0, 0));
    }
    run.nextAt = t;
    const tick = () => {
      if (this.run !== run) return;
      while (run.pos < run.order.length && run.nextAt < engine.now() + 0.35) {
        const index = run.order[run.pos];
        const bar = barClicks(map, index, this.prefs);
        const start = run.nextAt;
        for (const c of bar.clicks) {
          engine.click(start + c.at, c.level);
          if (c.level !== 'sub') this.later(start + c.at, () => this.beat(c.beat, bar.beats));
        }
        this.later(start, () => this.setNow(index));
        run.nextAt = start + bar.length;
        run.pos++;
      }
      if (run.pos >= run.order.length) {
        clearInterval(run.timer);
        this.later(run.nextAt + 0.05, () => {
          if (this.run !== run) return;
          this.stop();
          this.startAt = 0;
          this.render();
          this.host.toast('Fim da partitura.');
        });
      }
    };
    tick();
    run.timer = window.setInterval(tick, 60);
    this.render();
    this.decorate();
  }

  /** Agenda algo na tela para quando o som chegar (relógio do áudio → timer). */
  private later(when: number, fn: () => void) {
    const run = this.run;
    if (!run) return;
    const ms = (when - this.host.engine.now()) * 1000;
    run.timers.push(window.setTimeout(() => this.run === run && fn(), Math.max(0, ms)));
    if (run.timers.length > 400) run.timers.splice(0, 200);
  }

  private beat(beat: number, beats: number) {
    const dots = this.el.querySelector('.rd-beats');
    if (!dots) return;
    if (dots.children.length !== beats) dots.innerHTML = Array.from({ length: beats }, (_, i) => `<i class="${i === 0 ? 'first' : ''}"></i>`).join('');
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === beat));
  }

  private count(n: number, total: number) {
    const el = this.host.countEl;
    el.textContent = n ? String(n) : '';
    el.classList.toggle('show', n > 0);
    if (n) {
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }
    const label = this.el.querySelector('.rd-now');
    if (label && n) label.textContent = `Contando ${n} de ${total}…`;
  }

  private pause() {
    const run = this.run;
    if (!run) return;
    // recomeça do compasso que estava tocando
    this.startAt = run.now >= 0 ? run.now : run.order[0];
    this.halt();
    this.paused = true;
    this.render();
    this.decorate();
  }

  private restartAt(index: number) {
    this.halt();
    this.play(index);
    this.decorate();
  }

  /** Para tudo (som, timers, destaque). */
  stop() {
    if (!this.run) return;
    this.halt();
    this.paused = false;
    this.decorate();
  }

  private halt() {
    const run = this.run;
    if (!run) return;
    clearInterval(run.timer);
    run.timers.forEach((t) => clearTimeout(t));
    this.run = null;
    this.host.engine.stopAll();
    this.count(0, 0);
    for (const b of document.querySelectorAll<HTMLElement>('.rd-layer .rd-m.now')) b.classList.remove('now');
  }

  // ------------------------------------------------------------ tela

  private renderTempoReadout() {
    const out = this.el.querySelector('.rd-tempo-out');
    if (!out || !this.map) return;
    const first = playOrder(this.map, this.startAt)[0] ?? 0;
    out.textContent = this.prefs.follow ? `${Math.round(this.prefs.speed * 100)}% · ${bpmFor(this.map, first, this.prefs)} BPM` : `${this.prefs.fixedBpm} BPM`;
    const dur = this.el.querySelector('.rd-dur');
    if (dur) dur.textContent = `Duração: ${fmtTime(totalSeconds(this.map, this.prefs, this.startAt))}`;
  }

  render() {
    const head = `<header class="rd-head"><h2>Ler e tocar</h2><button type="button" class="rd-x" data-rd="close" aria-label="Fechar o painel de leitura" title="Fechar (Esc)">×</button></header>`;
    let body = '';
    if (this.view === 'intro') body = this.introHtml();
    else if (this.view === 'busy')
      body = `<div class="rd-busy"><div class="rd-spinner" aria-hidden="true"></div><p class="rd-progress" role="status">${esc(this.progress)}</p><button type="button" class="icon-btn" data-rd="cancel">Cancelar</button></div>`;
    else if (this.view === 'error')
      body = `<div class="rd-error" role="alert"><b>Não deu para ler.</b><p>${esc(this.error)}</p><button type="button" class="icon-btn primary" data-rd="analyze">Tentar de novo</button></div>`;
    else if (this.view === 'review') body = this.reviewHtml();
    else body = this.playHtml();
    this.el.innerHTML = head + `<div class="rd-body">${body}</div>`;
    this.el.classList.toggle('playing', !!this.run);
    if (this.view === 'play') this.renderTempoReadout();
  }

  private introHtml() {
    return `
      <p class="rd-lead">O app procura na partitura aberta as <b>pautas</b>, as <b>barras de compasso</b>, a <b>fórmula de compasso</b> e o <b>andamento</b>. Em PDF digital lê também as <b>notas e pausas</b>. Depois você confere tudo e toca com o metrônomo, com o compasso atual destacado.</p>
      <ul class="rd-facts">
        <li><b>PDF digital</b> (exportado de um editor de partituras): lê o texto e os símbolos musicais.</li>
        <li><b>Escaneado ou foto</b>: acha pautas e barras pela imagem. Andamento e fórmula você confirma.</li>
        <li>Tudo acontece no seu aparelho: o arquivo não é enviado.</li>
      </ul>
      <button type="button" class="icon-btn primary rd-cta" data-rd="analyze">Analisar a partitura</button>`;
  }

  private reviewHtml() {
    const map = this.map!;
    const real = map.measures.filter((m) => !m.skip);
    const kinds = new Set(map.pages.map((p) => p.kind));
    const kindText = kinds.has('digital') && kinds.size === 1 ? 'PDF digital' : kinds.has('image') ? 'Foto/imagem' : kinds.has('digital') ? 'PDF misto (digital e escaneado)' : 'PDF escaneado';
    const withNotes = real.filter((m) => m.content).length;
    const flags = openFlags(map);
    const nums = this.numbers();
    const b = blockers(map);
    const src = (s: string | null, ok: string) => (s === 'text' ? `<span class="rd-src ok">${ok}</span>` : s === 'word' ? '<span class="rd-src warn">estimado</span>' : s === 'user' ? '<span class="rd-src">você escolheu</span>' : '<span class="rd-src bad">não identificado</span>');
    const tsOptions = (cur: string | null | undefined, empty: string) =>
      `<option value="">${empty}</option>` + [...new Set([...DOC_TIME_SIGNATURES, ...(cur ? [cur] : [])])].map((t) => `<option ${t === cur ? 'selected' : ''}>${t}</option>`).join('');
    const sel = this.selected >= 0 ? map.measures[this.selected] : null;
    return `
      <div class="rd-summary">
        <span class="rd-chip">${kindText}</span>
        <span class="rd-chip">${real.length} compasso${real.length === 1 ? '' : 's'} em ${map.pages.reduce((a, p) => a + p.systems, 0)} linha(s)</span>
        <span class="rd-chip">${withNotes ? `notas lidas em ${withNotes}` : 'notas: só contagem'}</span>
      </div>
      ${map.notes.length ? `<ul class="rd-notes">${map.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <div class="rd-fields">
        <label><span>Fórmula de compasso ${src(map.initialTs.source, 'lida no PDF')}</span>
          <select data-rdf="initialTs" ${map.initialTs.value ? '' : 'class="need"'}>${tsOptions(map.initialTs.value, 'Escolha…')}</select></label>
        <label><span>Andamento inicial (BPM) ${src(map.initialTempo.source, 'lido no PDF')}</span>
          <input type="number" inputmode="numeric" min="${MIN_BPM}" max="${MAX_BPM}" data-rdf="initialBpm" value="${map.initialTempo.bpm ?? ''}" placeholder="ex.: 80" ${map.initialTempo.bpm ? '' : 'class="need"'} /></label>
        ${map.initialTempo.label ? `<small class="rd-hint">Escrito: “${esc(map.initialTempo.label)}”</small>` : ''}
      </div>
      <section class="rd-flags">
        <h3>${flags.length ? `Precisa de atenção (${flags.length})` : 'Nada duvidoso encontrado'}</h3>
        ${flags.length ? `<ul>${flags.slice(0, 40).map((f) => `<li><button type="button" data-rd="goto" data-i="${f.index}"><b>Compasso ${nums.get(f.index)}</b> ${esc(f.flag.text)}</button></li>`).join('')}</ul>` : '<p class="rd-hint">Mesmo assim, dê uma olhada nos compassos destacados na página.</p>'}
      </section>
      ${sel ? this.measureHtml(sel, nums.get(this.selected) ?? 0, tsOptions) : '<p class="rd-hint rd-tip">Toque num compasso na página para ver o que foi lido e corrigir.</p>'}
      <footer class="rd-foot">
        ${b.length ? `<p class="rd-block" role="status">${b.map(esc).join(' ')}</p>` : ''}
        <button type="button" class="icon-btn primary" data-rd="confirm" ${b.length ? 'aria-disabled="true"' : ''}>Confirmar e tocar</button>
        <button type="button" class="link-btn" data-rd="analyze">Analisar de novo</button>
      </footer>`;
  }

  private measureHtml(m: ReadMeasure, num: number, tsOptions: (cur: string | null | undefined, empty: string) => string) {
    const map = this.map!;
    const i = this.selected;
    const ts = tsAt(map, i);
    const unitQ = beatsOf(ts).unit.toNumber() * 4;
    const read = m.content
      ? `<p><b>Lido:</b> ${esc(m.content.summary || '—')}</p><p class="rd-hint">${m.content.fullRest ? 'Compasso inteiro de pausa.' : `Soma: ${m.content.exact ? '' : 'até '}${Math.round((m.content.quarters / unitQ) * 100) / 100} tempo(s)${m.content.exact ? '' : ' (notas pretas sem bandeirola podem ser colcheias com viga)'}`}${m.content.tuplets ? ' · tem quiáltera' : ''}</p>`
      : `<p class="rd-hint">${m.noteHeads ? `${m.noteHeads} cabeça(s) de nota preta encontradas. Durações, pausas e notas brancas não são lidas em imagem.` : 'Nenhuma nota preta encontrada (pode ter pausas ou notas brancas).'}</p>`;
    const written = m.tempo && m.tempo.source !== 'user' ? `<small class="rd-hint">Escrito: “${esc(m.tempo.label)}”</small>` : '';
    return `
      <section class="rd-measure-edit" aria-label="Compasso selecionado">
        <div class="rd-mhead">
          <button type="button" class="rd-nav" data-rd="prev" aria-label="Compasso anterior">‹</button>
          <h3>${m.skip ? 'Ignorado' : `Compasso ${num}`} <small>página ${m.page + 1}, linha ${m.system + 1}</small></h3>
          <button type="button" class="rd-nav" data-rd="next" aria-label="Próximo compasso">›</button>
        </div>
        ${m.flags.length ? `<ul class="rd-mflags">${m.flags.map((f) => `<li>${esc(f.text)}</li>`).join('')}</ul>` : ''}
        ${read}
        <div class="rd-grid">
          <label><span>Tempos neste compasso</span><input type="number" min="0.5" max="32" step="0.5" data-rdf="beats" value="${m.beats ?? ''}" placeholder="cheio (${beatsOf(ts).count})" /></label>
          <label><span>Fórmula muda aqui</span><select data-rdf="ts">${tsOptions(m.ts, 'não muda')}</select></label>
          <label><span>Andamento muda aqui</span><input type="number" min="${MIN_BPM}" max="${MAX_BPM}" data-rdf="tempo" value="${m.tempo?.kind === 'set' && m.tempo.bpm ? m.tempo.bpm : ''}" placeholder="segue ${tempoAt(map, Math.max(0, i - 1))}" /></label>
        </div>
        ${written}
        <div class="rd-actions">
          <button type="button" class="icon-btn small ${m.ok ? 'on' : ''}" data-rd="ok" aria-pressed="${!!m.ok}">${m.ok ? 'Conferido ✓' : 'Está certo'}</button>
          <button type="button" class="icon-btn small" data-rd="merge" title="A barra do fim não é barra de verdade">Juntar com o próximo</button>
          <button type="button" class="icon-btn small" data-rd="split" title="Faltou achar uma barra no meio">Dividir em dois</button>
          <button type="button" class="icon-btn small" data-rd="skip">${m.skip ? 'Voltar a contar' : 'Não é compasso'}</button>
        </div>
      </section>`;
  }

  private playHtml() {
    const map = this.map!;
    const nums = this.numbers();
    const playing = !!this.run;
    const startNum = nums.get(this.startAt) ?? 1;
    const p = this.prefs;
    const changes = map.measures.filter((m) => !m.skip && m.tempo?.kind === 'set').length;
    const gradual = map.measures.filter((m) => !m.skip && (m.tempo?.kind === 'gradual' || m.tempo?.kind === 'rubato' || m.tempo?.kind === 'fermata')).length;
    return `
      <div class="rd-stage">
        <p class="rd-now" aria-live="polite">${playing ? 'Tocando…' : this.paused ? `Pausado no compasso ${startNum}` : `Começa no compasso ${startNum} de ${nums.size}`}</p>
        <div class="rd-beats" aria-hidden="true"></div>
        <p class="rd-now-bpm">${this.tsLabel(this.startAt)}</p>
      </div>
      <div class="rd-transport">
        <button type="button" class="rd-play ${playing ? 'playing' : ''}" data-rd="play" aria-label="${playing ? 'Pausar' : this.paused ? 'Continuar' : 'Tocar'}">${playing ? '❚❚' : '▶'}</button>
        <button type="button" class="rd-stop" data-rd="stop" aria-label="Parar e voltar ao começo">■</button>
      </div>
      <p class="rd-hint rd-tip">Toque num compasso na página para começar dali.</p>
      <fieldset class="rd-mode">
        <legend>Andamento</legend>
        <div class="rd-seg" role="radiogroup">
          <button type="button" role="radio" aria-checked="${p.follow}" data-rd="follow" data-v="1">Seguir a partitura</button>
          <button type="button" role="radio" aria-checked="${!p.follow}" data-rd="follow" data-v="0">BPM fixo</button>
        </div>
        <div class="rd-tempo">
          <button type="button" class="metro-step" data-rd="bpm-step" data-d="-5" aria-label="Mais devagar">−</button>
          <output class="rd-tempo-out"></output>
          <button type="button" class="metro-step" data-rd="bpm-step" data-d="5" aria-label="Mais rápido">+</button>
        </div>
        <input type="range" data-rdf="speed" aria-label="${p.follow ? 'Velocidade em relação à partitura' : 'Batidas por minuto'}" ${p.follow ? `min="25" max="200" step="5" value="${Math.round(p.speed * 100)}"` : `min="${MIN_BPM}" max="${MAX_BPM}" step="1" value="${p.fixedBpm}"`} />
        <small class="rd-hint">${p.follow ? (changes ? `Segue as ${changes} mudança(s) de andamento escritas, na velocidade escolhida.` : 'A partitura não tem mudança de andamento marcada.') : 'Ignora as mudanças escritas: o mesmo BPM do começo ao fim.'}${gradual ? ` ${gradual} trecho(s) com rit./rall./fermata/rubato: o clique não acompanha essas variações.` : ''}</small>
      </fieldset>
      <label class="metro-vol rd-vol"><span>Volume</span><input type="range" min="0" max="1" step="0.05" data-rdf="volume" value="${p.volume}" aria-label="Volume do metrônomo" /></label>
      <div class="rd-row">
        <label class="metro-check"><input type="checkbox" data-rdf="countIn" ${p.countIn ? 'checked' : ''} /><span>Contar um compasso antes</span></label>
        <label class="rd-pattern"><span>Clique</span><select data-rdf="pattern">${PATTERNS.map((x) => `<option value="${x.id}" ${x.id === p.pattern ? 'selected' : ''}>${x.name}</option>`).join('')}</select></label>
      </div>
      <p class="rd-dur rd-hint"></p>
      <p class="rd-hint">Repetições, casas 1 e 2 e D.C./D.S. não são seguidas: toca na ordem em que os compassos aparecem.</p>
      <button type="button" class="link-btn" data-rd="review">Voltar à revisão</button>`;
  }
}
