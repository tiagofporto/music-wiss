import { G } from '../../src/audio/soundfont';

// ------------------------------------------------------------ SF2 mínimo de teste

function chunk(id: string, body: Uint8Array): Uint8Array {
  const pad = body.length % 2;
  const out = new Uint8Array(8 + body.length + pad);
  out.set([...id].map((c) => c.charCodeAt(0)), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}
function list(type: string, parts: Uint8Array[]): Uint8Array {
  return chunk('LIST', concat([ascii(type), ...parts]));
}
function riff(type: string, parts: Uint8Array[]): Uint8Array {
  return chunk('RIFF', concat([ascii(type), ...parts]));
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function ascii(s: string, len = s.length): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < Math.min(len, s.length); i++) b[i] = s.charCodeAt(i);
  return b;
}
function rec(size: number, fill: (v: DataView, b: Uint8Array) => void): Uint8Array {
  const b = new Uint8Array(size);
  fill(new DataView(b.buffer), b);
  return b;
}
const gen = (op: number, amount: number) => rec(4, (v) => { v.setUint16(0, op, true); v.setInt16(2, amount, true); });
const range = (op: number, lo: number, hi: number) => rec(4, (v, b) => { v.setUint16(0, op, true); b[2] = lo; b[3] = hi; });

/** Piano (programa 0) com duas amostras: grave (0–59, raiz 48) e aguda (60–127, raiz 72, -6 dB). */
export function tinySf2(): Uint8Array {
  const pcm = new Int16Array(200).map((_, i) => Math.round(Math.sin(i / 3) * 10000));
  const phdr = concat([
    rec(38, (v, b) => { b.set(ascii('Piano Teste', 20)); v.setUint16(20, 0, true); v.setUint16(22, 0, true); v.setUint16(24, 0, true); }),
    rec(38, (v, b) => { b.set(ascii('EOP', 20)); v.setUint16(24, 1, true); }),
  ]);
  const pbag = concat([rec(4, (v) => v.setUint16(0, 0, true)), rec(4, (v) => v.setUint16(0, 1, true))]);
  const pgen = concat([gen(G.instrument, 0), gen(0, 0)]);
  const inst = concat([
    rec(22, (v, b) => { b.set(ascii('Piano', 20)); v.setUint16(20, 0, true); }),
    rec(22, (v, b) => { b.set(ascii('EOI', 20)); v.setUint16(20, 3, true); }),
  ]);
  // bolsa 0: global (atenuação 30 cB); bolsa 1: grave; bolsa 2: aguda
  const ibag = concat([0, 1, 4, 8].map((n) => rec(4, (v) => v.setUint16(0, n, true))));
  const igen = concat([
    gen(G.initialAttenuation, 30),
    range(G.keyRange, 0, 59), gen(G.sampleModes, 1), gen(G.sampleID, 0),
    range(G.keyRange, 60, 127), gen(G.initialAttenuation, 60), gen(G.overridingRootKey, 72), gen(G.sampleID, 1),
    gen(0, 0),
  ]);
  const sample = (name: string, start: number, end: number, pitch: number) =>
    rec(46, (v, b) => {
      b.set(ascii(name, 20));
      v.setUint32(20, start, true); v.setUint32(24, end, true);
      v.setUint32(28, start + 10, true); v.setUint32(32, end - 10, true);
      v.setUint32(36, 22050, true); b[40] = pitch; v.setInt8(41, -3);
    });
  const shdr = concat([sample('Grave', 0, 100, 48), sample('Aguda', 100, 200, 60), rec(46, (_, b) => b.set(ascii('EOS', 20)))]);
  return riff('sfbk', [
    list('INFO', [chunk('ifil', rec(4, (v) => v.setUint16(0, 2, true))), chunk('INAM', ascii('Banco de teste\0'))]),
    list('sdta', [chunk('smpl', new Uint8Array(pcm.buffer))]),
    list('pdta', [chunk('phdr', phdr), chunk('pbag', pbag), chunk('pgen', pgen), chunk('inst', inst), chunk('ibag', ibag), chunk('igen', igen), chunk('shdr', shdr)]),
  ]);
}

