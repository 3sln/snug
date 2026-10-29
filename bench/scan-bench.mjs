// P1.4 -- the D005 gate. Four ways to answer "is this valid Bindle CBOR":
//
//   gen    the kin-generated JS scanner        gen/js/snug/cbor/scan.mjs
//   hand   a hand-written JS scanner, same algorithm   bench/scan-hand.mjs
//   wasm   the same kin source as Rust -> wasm32, INCLUDING the copy of the
//          input into linear memory     .cache/snug-wasm/... (kin/scripts/wasm-build)
//   cbor   cbor.mjs decode (builds the values; context only)  bench/baseline/cbor-3sln.mjs
//
//     node bench/scan-bench.mjs <wasm path> [rounds]
//
// Method: every input is checked first (each variant must give the expected
// code: cbor.mjs's); then warm-up rounds; then ROUNDS rounds in which the
// variants run in a rotating order, each timing a batch of calls sized to take
// ~20 ms; the reported figure is the MEDIAN over rounds of time per call.
import { readFileSync } from 'node:fs';
import { decode, encode, CBORFault, BindleDecimal } from './baseline/cbor-3sln.mjs';
import { scan, scanOptions, codeName } from '../gen/js/snug/cbor/scan.mjs';
import { scanHand } from './scan-hand.mjs';

const [wasmPath, roundsArg] = process.argv.slice(2);
const ROUNDS = Number(roundsArg ?? 15);

import { inputs, BIG, DEF, ANY } from './scan-inputs.mjs';

// ---------------------------------------------------------------- variants
const o = new Int32Array(16);
// A host fills the options array once per options object and reuses it (the
// scanner only writes its output and scratch slots), as an adapter would.
let lastOpt = null;
const setOpts = opt => { if (opt !== lastOpt) { lastOpt = opt; scanOptions(o, opt.top === 'any' ? 1 : 0, opt.cose ? 1 : 0, opt.maxBytes, opt.maxDepth, opt.maxEntries, opt.maxItems); } };
let wasm = null;
if (wasmPath) {
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath));
  const ex = instance.exports, cap = ex.snug_cap(), ptr = ex.snug_buf();
  const view = () => new Uint8Array(ex.memory.buffer, ptr, cap);
  let mem = view();
  wasm = (bytes, opt) => {
    if (mem.buffer !== ex.memory.buffer) mem = view();
    mem.set(bytes);
    return ex.snug_scan(bytes.length, opt.top === 'any' ? 1 : 0, opt.cose ? 1 : 0, opt.maxBytes, opt.maxDepth, opt.maxEntries, opt.maxItems);
  };
}
const codeOf = (fn) => { try { fn(); return 0; } catch (e) { if (e instanceof CBORFault) return e.code; throw e; } };
const variants = {
  gen: (bytes, opt) => { setOpts(opt); return scan(bytes, o); },
  hand: (bytes, opt) => scanHand(bytes, opt),
  ...(wasm ? { wasm } : {}),
  cbor: (bytes, opt) => { try { decode(bytes, opt); return 0; } catch (e) { if (e instanceof CBORFault) return e.code; throw e; } },
};
const names = Object.keys(variants);
const toName = (v, c) => (v === 'cbor' ? (c === 0 ? 'ok' : c) : codeName(c));

// ---------------------------------------------------------------- answers checked
for (const inp of inputs) {
  const list = inp.many ?? [inp.bytes];
  const want = list.map(b => { const c = codeOf(() => decode(b, inp.opt)); return c === 0 ? 'ok' : c; });
  if (!inp.many && want[0] !== 'ok') throw new Error(`${inp.name}: cbor.mjs refuses it (${want[0]})`);
  for (const v of names) list.forEach((b, i) => {
    const got = toName(v, variants[v](b, inp.opt));
    if (got !== want[i]) throw new Error(`${inp.name}: ${v} answers ${got}, cbor.mjs ${want[i]}`);
  });
}

// ---------------------------------------------------------------- timing
function batch(fn, inp, reps) {
  const list = inp.many ?? [inp.bytes], opt = inp.opt;
  let sink = 0;
  // CPU TIME of this process, not wall time: the machine is shared and
  // loaded, and on-CPU time is what a scanner costs.
  const t0 = process.cpuUsage();
  for (let r = 0; r < reps; r++) for (let i = 0; i < list.length; i++) sink += fn(list[i], opt);
  const t1 = process.cpuUsage(t0);
  return [(t1.user + t1.system) / 1000, sink];
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const results = [];
for (const inp of inputs) {
  const reps = {};
  for (const v of names) {        // size a batch to ~20 ms
    let k = 1, ms = 0;
    while ((ms = batch(variants[v], inp, k)[0]) < 10) k *= 2;
    reps[v] = Math.max(1, Math.round(k * 40 / ms));
  }
  for (let w = 0; w < 3; w++) for (const v of names) batch(variants[v], inp, reps[v]);
  const per = Object.fromEntries(names.map(v => [v, []]));
  for (let r = 0; r < ROUNDS; r++) {
    const order = names.map((_, i) => names[(i + r) % names.length]);
    for (const v of order) per[v].push(batch(variants[v], inp, reps[v])[0] / reps[v]);
  }
  const row = { input: inp.name, bytes: (inp.many ?? [inp.bytes]).reduce((s, b) => s + b.length, 0) };
  for (const v of names) { row[v] = median(per[v]); row[v + 'Min'] = Math.min(...per[v]); }
  results.push(row);
}

const fmt = ms => (ms >= 1 ? `${ms.toFixed(2)} ms` : `${(ms * 1000).toFixed(1)} µs`);
console.log(`| input | ${names.join(' | ')} | gen / hand | gen / wasm |`);
console.log(`| --- | ${names.map(() => '---:').join(' | ')} | ---: | ---: |`);
for (const r of results) {
  console.log(`| ${r.input} | ${names.map(v => fmt(r[v])).join(' | ')} | ${(r.gen / r.hand).toFixed(2)}x | ${r.wasm ? (r.gen / r.wasm).toFixed(2) + 'x' : '-'} |`);
}
console.log(`\nmin over rounds:`);
for (const r of results) console.log(`| ${r.input} | ${names.map(v => fmt(r[v + 'Min'])).join(' | ')} | ${(r.genMin / r.handMin).toFixed(2)}x | ${r.wasm ? (r.genMin / r.wasmMin).toFixed(2) + 'x' : '-'} |`);
console.log(`\n(process CPU time per call; median (and min) of ${ROUNDS} interleaved rounds per input, each round ~40 ms of CPU per variant, after 3 warm-up rounds; all answers checked against cbor.mjs first)`);
console.log(JSON.stringify(results));
