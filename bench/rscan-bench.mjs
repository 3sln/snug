// P6.1 -- the §17.4 question: what does the resumable walk cost?
//
//   rec      the recursive generated scanner (gen/js/snug/cbor/scan.mjs), as P1.4's "gen"
//   rs-whole the resumable scanner (gen/js/snug/cbor/rscan.mjs) fed the whole buffer
//            as ONE window (the buffer path if there were only one walk)
//   rs-64K / rs-16K / rs-1K   the resumable scanner fed windows of that size from a
//            JS host loop over an in-memory buffer (zero-copy subarray views): the
//            cost of the blob-handle / stream path without any I/O. Each window
//            starts at the offset the scanner asks for and is max(size, its need).
//   wasm-rec / wasm-rs   the same two walks as Rust -> wasm32 over one window,
//            including the copy into linear memory
//
//     node bench/rscan-bench.mjs <wasm path> [rounds]
//
// Same method as P1.4 (bench/scan-bench.mjs): answers checked first, then
// CPU-time medians over interleaved rounds after warm-up.
import { readFileSync } from 'node:fs';
import { scan, scanOptions, codeName } from '../gen/js/snug/cbor/scan.mjs';
import { rscanInit, rscanStep, rscanNeedOffset, rscanNeedLength, rscanScratchLen, RS_NEED } from '../gen/js/snug/cbor/rscan.mjs';
import { inputs } from './scan-inputs.mjs';

const [wasmPath, roundsArg] = process.argv.slice(2);
const ROUNDS = Number(roundsArg ?? 15);
const oa = opt => [opt.top === 'any' ? 1 : 0, opt.cose ? 1 : 0, opt.maxBytes, opt.maxDepth, opt.maxEntries, opt.maxItems];

const o = new Int32Array(16);
let lastOpt = null;
const setOpts = opt => { if (opt !== lastOpt) { lastOpt = opt; scanOptions(o, ...oa(opt)); } };
// One session's scratch, reused across calls (sized for the largest input).
const s = new Int32Array(rscanScratchLen(32, 1_500_000));
function resumable(bytes, opt, chunk) {
  setOpts(opt);
  const total = bytes.length;
  rscanInit(o, s, total, 0);
  let base = 0, len = chunk === 0 ? total : Math.min(chunk, total);
  for (;;) {
    const r = rscanStep(bytes.subarray(base, base + len), o, s, 0, base);
    if (r !== RS_NEED) return r;
    base = rscanNeedOffset(s);
    len = Math.min(Math.max(chunk, rscanNeedLength(s)), total - base);
  }
}
let wasm = null;
if (wasmPath) {
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath));
  const ex = instance.exports, ptr = ex.snug_buf(), cap = ex.snug_cap();
  let mem = new Uint8Array(ex.memory.buffer, ptr, cap);
  const put = b => { if (mem.buffer !== ex.memory.buffer) mem = new Uint8Array(ex.memory.buffer, ptr, cap); mem.set(b); };
  wasm = {
    'wasm-rec': (b, opt) => { put(b); return ex.snug_scan(b.length, ...oa(opt)); },
    'wasm-rs': (b, opt) => { put(b); return ex.snug_rscan(b.length, ...oa(opt)); },
  };
}
const variants = {
  rec: (b, opt) => { setOpts(opt); return scan(b, o); },
  'rs-whole': (b, opt) => resumable(b, opt, 0),
  'rs-64K': (b, opt) => resumable(b, opt, 65536),
  'rs-16K': (b, opt) => resumable(b, opt, 16384),
  'rs-1K': (b, opt) => resumable(b, opt, 1024),
  ...(wasm ?? {}),
};
const names = Object.keys(variants);

for (const inp of inputs) {
  for (const b of inp.many ?? [inp.bytes]) {
    const want = variants.rec(b, inp.opt);
    for (const v of names) if (variants[v](b, inp.opt) !== want) throw new Error(`${inp.name}: ${v} answers ${codeName(variants[v](b, inp.opt))}, rec ${codeName(want)}`);
  }
}
function batch(fn, inp, reps) {
  const list = inp.many ?? [inp.bytes], opt = inp.opt;
  let sink = 0;
  const t0 = process.cpuUsage();
  for (let r = 0; r < reps; r++) for (let i = 0; i < list.length; i++) sink += fn(list[i], opt);
  const t1 = process.cpuUsage(t0);
  return [(t1.user + t1.system) / 1000, sink];
}
const median = a => { const x = [...a].sort((p, q) => p - q); return x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2; };
const rows = [];
for (const inp of inputs) {
  const reps = {};
  for (const v of names) { let k = 1, ms; while ((ms = batch(variants[v], inp, k)[0]) < 10) k *= 2; reps[v] = Math.max(1, Math.round(k * 40 / ms)); }
  for (let w = 0; w < 3; w++) for (const v of names) batch(variants[v], inp, reps[v]);
  const per = Object.fromEntries(names.map(v => [v, []]));
  for (let r = 0; r < ROUNDS; r++) for (const v of names.map((_, i) => names[(i + r) % names.length])) per[v].push(batch(variants[v], inp, reps[v])[0] / reps[v]);
  const row = { input: inp.name };
  for (const v of names) row[v] = median(per[v]);
  rows.push(row);
}
const fmt = ms => (ms >= 1 ? `${ms.toFixed(2)} ms` : `${(ms * 1000).toFixed(1)} µs`);
console.log(`| input | ${names.join(' | ')} | rs-whole / rec |${wasm ? ' wasm-rs / wasm-rec |' : ''}`);
console.log(`| --- | ${names.map(() => '---:').join(' | ')} | ---: |${wasm ? ' ---: |' : ''}`);
for (const r of rows) console.log(`| ${r.input} | ${names.map(v => fmt(r[v])).join(' | ')} | ${(r['rs-whole'] / r.rec).toFixed(2)}x |${wasm ? ` ${(r['wasm-rs'] / r['wasm-rec']).toFixed(2)}x |` : ''}`);
console.log(`\n(process CPU time per call; median of ${ROUNDS} interleaved rounds, ~40 ms of CPU per variant per round, after 3 warm-up rounds; every variant's answer checked against rec first)`);
