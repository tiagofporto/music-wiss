import { Fraction } from '../model/fraction';
import type { DurationType } from '../model/duration';
import type { Clef } from '../model/pitch';
import type { Articulation, MusicEvent, Part, Score } from '../model/score';
import { parseChordSymbol } from '../model/chords';
import { barMark, effectiveKey, effectiveTimeSignature, eventValue, measureCapacity } from '../model/score';

/**
 * Exporta a partitura em MusicXML 4.0 (score-partwise), o formato aberto que
 * praticamente todo programa de notação lê.
 */

const TYPE: Record<DurationType, string> = {
  whole: 'whole', half: 'half', quarter: 'quarter', eighth: 'eighth', '16th': '16th', '32nd': '32nd',
};

const CLEF: Record<Clef, { sign: string; line: number }> = {
  treble: { sign: 'G', line: 2 },
  bass: { sign: 'F', line: 4 },
  alto: { sign: 'C', line: 3 },
  tenor: { sign: 'C', line: 4 },
};

/** Graus diatônicos de cada transposição cromática dentro da oitava (0 a -11). */
const DIATONIC: Record<number, number> = { 0: 0, [-1]: -1, [-2]: -1, [-3]: -2, [-4]: -2, [-5]: -3, [-6]: -4, [-7]: -4, [-8]: -5, [-9]: -5, [-10]: -6, [-11]: -6 };

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function lcm(a: number, b: number): number {
  const g = (x: number, y: number): number => (y ? g(y, x % y) : x);
  return (a / g(a, b)) * b;
}

/** Menor número de divisões por semínima que torna todas as durações inteiras. */
function computeDivisions(score: Score): number {
  let div = 1;
  for (const part of score.parts) {
    for (const staff of part.staves) {
      for (const m of staff.measures) {
        for (const v of m.voices) {
          for (const e of v.events) div = lcm(div, eventValue(e).mul(new Fraction(4)).den);
        }
      }
    }
  }
  return div;
}

function transposeXml(semitones: number): string {
  if (!semitones) return '';
  const octave = semitones < 0 ? Math.ceil(semitones / 12) : Math.floor(semitones / 12);
  const rem = semitones - octave * 12;
  const diatonic = rem <= 0 ? DIATONIC[rem] : -DIATONIC[-rem];
  return `<transpose><diatonic>${diatonic}</diatonic><chromatic>${rem}</chromatic>${octave ? `<octave-change>${octave}</octave-change>` : ''}</transpose>`;
}

function partXml(score: Score, part: Part, divisions: number): string {
  const dur = (f: Fraction) => f.mul(new Fraction(4 * divisions)).toNumber();
  const measureCount = part.staves[0].measures.length;
  const out: string[] = [];
  // notas ligadas da nota anterior, por pauta+voz, para escrever o "stop"
  const tiedFrom = new Map<string, Set<string>>();
  // a sílaba anterior de cada voz terminou com hífen?
  const lyricState = new Map<string, boolean>();

  for (let mi = 0; mi < measureCount; mi++) {
    const ts = effectiveTimeSignature(score, mi);
    const key = effectiveKey(score, mi);
    const cap = measureCapacity(ts);
    const body: string[] = [];

    const attrs: string[] = [];
    if (mi === 0) attrs.push(`<divisions>${divisions}</divisions>`);
    if (mi === 0 || key !== effectiveKey(score, mi - 1)) attrs.push(`<key><fifths>${key}</fifths></key>`);
    const prevTs = mi > 0 ? effectiveTimeSignature(score, mi - 1) : null;
    if (!prevTs || prevTs.beats !== ts.beats || prevTs.beatType !== ts.beatType) {
      attrs.push(`<time><beats>${ts.beats}</beats><beat-type>${ts.beatType}</beat-type></time>`);
    }
    if (mi === 0) {
      if (part.staves.length > 1) attrs.push(`<staves>${part.staves.length}</staves>`);
      part.staves.forEach((st, si) => {
        const c = CLEF[st.clef];
        attrs.push(`<clef${part.staves.length > 1 ? ` number="${si + 1}"` : ''}><sign>${c.sign}</sign><line>${c.line}</line></clef>`);
      });
      const tr = transposeXml(part.transposition);
      if (tr) attrs.push(tr);
    }
    // repetição e casa abrindo o compasso
    const bar = barMark(score, mi);
    const prevBar = mi > 0 ? barMark(score, mi - 1) : null;
    const endingStarts = bar.ending && prevBar?.ending !== bar.ending;
    if (bar.repeatStart || endingStarts) {
      body.push(
        `<barline location="left">${bar.repeatStart ? '<bar-style>heavy-light</bar-style>' : ''}` +
          `${endingStarts ? `<ending number="${bar.ending}" type="start">${bar.ending}.</ending>` : ''}` +
          `${bar.repeatStart ? '<repeat direction="forward"/>' : ''}</barline>`,
      );
    }
    if (attrs.length) body.push(`<attributes>${attrs.join('')}</attributes>`);

    if (mi === 0 && part === score.parts[0]) {
      body.push(
        `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.tempo}</per-minute></metronome></direction-type><sound tempo="${score.tempo}"/></direction>`,
      );
    }

    let wroteVoice = false;
    part.staves.forEach((staff, si) => {
      const measure = staff.measures[mi];
      measure.voices.forEach((voice, vi) => {
        if (!voice.events.length && vi > 0) return;
        if (wroteVoice) body.push(`<backup><duration>${dur(cap)}</duration></backup>`);
        wroteVoice = true;
        const voiceNo = si * 4 + vi + 1;
        const staffXml = part.staves.length > 1 ? `<staff>${si + 1}</staff>` : '';
        let filled = Fraction.ZERO;

        if (!voice.events.length) {
          body.push(`<note><rest measure="yes"/><duration>${dur(cap)}</duration><voice>${voiceNo}</voice>${staffXml}</note>`);
          filled = cap;
        }

        const tieKey = `${si}:${vi}`;
        voice.events.forEach((e, ei) => {
          body.push(directionsXml(e, voiceNo, staffXml));
          body.push(noteXml(e, ei, voice.events, dur, voiceNo, staffXml, tiedFrom, tieKey, lyricState));
          filled = filled.add(eventValue(e));
        });
        // completa vozes curtas para o "backup" seguinte voltar ao início certo
        if (filled.lt(cap)) body.push(`<forward><duration>${dur(cap.sub(filled))}</duration><voice>${voiceNo}</voice>${staffXml}</forward>`);
      });
    });

    const nextBar = barMark(score, mi + 1);
    const endingStops = bar.ending && (nextBar.ending !== bar.ending || mi === measureCount - 1);
    if (bar.repeatEnd || endingStops || mi === measureCount - 1) {
      // a casa 1 fecha com traço para baixo; a 2 normalmente fica aberta
      const endingType = bar.ending === 1 || bar.repeatEnd ? 'stop' : 'discontinue';
      body.push(
        `<barline location="right">${bar.repeatEnd || mi === measureCount - 1 ? '<bar-style>light-heavy</bar-style>' : ''}` +
          `${endingStops ? `<ending number="${bar.ending}" type="${endingType}"/>` : ''}` +
          `${bar.repeatEnd ? '<repeat direction="backward"/>' : ''}</barline>`,
      );
    }
    out.push(`<measure number="${mi + 1}">${body.join('')}</measure>`);
  }
  return out.join('\n');
}

function noteXml(
  e: MusicEvent,
  index: number,
  events: MusicEvent[],
  dur: (f: Fraction) => number,
  voiceNo: number,
  staffXml: string,
  tiedFrom: Map<string, Set<string>>,
  tieKey: string,
  lyricState: Map<string, boolean>,
): string {
  const marks = e.marks;
  const arts = marks?.articulations ?? [];
  const artXml = arts.filter((a) => a !== 'fermata').map((a) => ART_XML[a]).join('');
  const markNotations = `${artXml ? `<articulations>${artXml}</articulations>` : ''}${arts.includes('fermata') ? '<fermata type="upright"/>' : ''}`;
  let lyricXml = '';
  if (marks?.lyric && e.kind === 'chord') {
    const cont = marks.lyric.endsWith('-');
    const prev = lyricState.get(tieKey) ?? false;
    const syllabic = prev ? (cont ? 'middle' : 'end') : cont ? 'begin' : 'single';
    const textValue = cont ? marks.lyric.slice(0, -1) : marks.lyric;
    lyricXml = `<lyric number="1"><syllabic>${syllabic}</syllabic><text>${esc(textValue)}</text></lyric>`;
    lyricState.set(tieKey, cont);
  }
  const d = dur(eventValue(e));
  const type = `<type>${TYPE[e.duration.type]}</type>${'<dot/>'.repeat(e.duration.dots)}`;
  const tm = e.tuplet ? `<time-modification><actual-notes>${e.tuplet.actual}</actual-notes><normal-notes>${e.tuplet.normal}</normal-notes></time-modification>` : '';
  const tupletMark = (): string => {
    if (!e.tuplet) return '';
    const prevSame = events[index - 1]?.tuplet?.id === e.tuplet.id;
    const nextSame = events[index + 1]?.tuplet?.id === e.tuplet.id;
    if (!prevSame) return `<tuplet type="start" bracket="yes"/>`;
    if (!nextSame) return `<tuplet type="stop"/>`;
    return '';
  };

  if (e.kind === 'rest') {
    tiedFrom.delete(tieKey);
    const t = tupletMark();
    // pausas provisórias das vozes 2–4 saem invisíveis, como no editor
    const hidden = e.auto && voiceNo % 4 !== 1 ? ' print-object="no"' : '';
    const n = `${t}${arts.includes('fermata') ? '<fermata type="upright"/>' : ''}`;
    return `<note${hidden}><rest/><duration>${d}</duration><voice>${voiceNo}</voice>${type}${tm}${staffXml}${n ? `<notations>${n}</notations>` : ''}</note>`;
  }

  const prevTied = tiedFrom.get(tieKey) ?? new Set<string>();
  const nextTied = new Set<string>();
  const notes = e.notes.map((n, ni) => {
    const id = `${n.pitch.step}${n.pitch.octave}`;
    const stop = prevTied.has(id);
    const start = n.tieToNext;
    if (start) nextTied.add(id);
    const ties = `${stop ? '<tie type="stop"/>' : ''}${start ? '<tie type="start"/>' : ''}`;
    const notations = [stop ? '<tied type="stop"/>' : '', start ? '<tied type="start"/>' : '', ni === 0 ? tupletMark() : '', ni === 0 ? markNotations : ''].join('');
    const alter = n.pitch.alter ? `<alter>${n.pitch.alter}</alter>` : '';
    return (
      `<note>${ni > 0 ? '<chord/>' : ''}<pitch><step>${n.pitch.step}</step>${alter}<octave>${n.pitch.octave}</octave></pitch>` +
      `<duration>${d}</duration>${ties}<voice>${voiceNo}</voice>${type}${tm}${staffXml}${notations ? `<notations>${notations}</notations>` : ''}${ni === 0 ? lyricXml : ''}</note>`
    );
  });
  tiedFrom.set(tieKey, nextTied);
  return notes.join('');
}

const ART_XML: Record<Exclude<Articulation, 'fermata'>, string> = {
  staccato: '<staccato/>',
  staccatissimo: '<staccatissimo/>',
  tenuto: '<tenuto/>',
  accent: '<accent/>',
  marcato: '<strong-accent type="up"/>',
};

const STEP_ALTER = (a: number) => (a ? `<root-alter>${a}</root-alter>` : '');

/** Dinâmica e cifra vêm antes da nota, como <direction> e <harmony>. */
function directionsXml(e: MusicEvent, voiceNo: number, staffXml: string): string {
  const m = e.marks;
  if (!m) return '';
  let out = '';
  if (m.chordSymbol) {
    const c = parseChordSymbol(m.chordSymbol);
    if (c) {
      const bass = c.bass ? `<bass><bass-step>${c.bass.step}</bass-step>${c.bass.alter ? `<bass-alter>${c.bass.alter}</bass-alter>` : ''}</bass>` : '';
      out += `<harmony><root><root-step>${c.root.step}</root-step>${STEP_ALTER(c.root.alter)}</root><kind text="${esc(c.suffix)}">${c.kind}</kind>${bass}${staffXml}</harmony>`;
    } else {
      out += `<direction placement="above"><direction-type><words>${esc(m.chordSymbol)}</words></direction-type><voice>${voiceNo}</voice>${staffXml}</direction>`;
    }
  }
  if (m.dynamic) {
    out += `<direction placement="below"><direction-type><dynamics><${m.dynamic}/></dynamics></direction-type><voice>${voiceNo}</voice>${staffXml}</direction>`;
  }
  return out;
}

export function exportMusicXml(score: Score): string {
  const divisions = computeDivisions(score);
  const partList = score.parts
    .map(
      (p, i) =>
        `<score-part id="P${i + 1}"><part-name>${esc(p.name)}</part-name>` +
        `<score-instrument id="P${i + 1}-I1"><instrument-name>${esc(p.name)}</instrument-name></score-instrument>` +
        `<midi-instrument id="P${i + 1}-I1"><midi-channel>${(i % 15) + 1 + (i % 15 >= 9 ? 1 : 0)}</midi-channel><midi-program>${p.midiProgram + 1}</midi-program></midi-instrument></score-part>`,
    )
    .join('');
  const parts = score.parts.map((p, i) => `<part id="P${i + 1}">\n${partXml(score, p, divisions)}\n</part>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
<work><work-title>${esc(score.title)}</work-title></work>
<identification>${score.composer ? `<creator type="composer">${esc(score.composer)}</creator>` : ''}<encoding><software>Music Wiss</software><encoding-date>${new Date().toISOString().slice(0, 10)}</encoding-date></encoding></identification>
<part-list>${partList}</part-list>
${parts}
</score-partwise>
`;
}
