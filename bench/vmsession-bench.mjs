// P6.2 -- the resumable validator session vs the buffer driver (architecture
// §17.6 (a) and (b), D030's question for the VM):
//
//   buffer    vm-validate over the whole buffer (the recursive driver)
//   s-whole   the session given the whole buffer as ONE window (no quantum)
//   s-64K / s-16K / s-1K   the session fed windows of that size by a JS host
//             loop over an in-memory buffer (zero-copy subarray views; each window
//             starts where the session asks and is max(size, its need))
//   s-whole-q the whole buffer under the default work quantum (64 Ki units),
//             yields resumed at once (scheduling cost without any I/O)
//
// Inputs and schemas: bench/VM.md section 2 (the P1.4 inputs, budget unlimited).
// Session arrays are allocated once per schema and re-initialised per call
// (vms-init), as a pooled host would. Verdicts and the whole out array are
// checked against the buffer driver outside the timed loops. CPU time
// (process.cpuUsage), iteration count calibrated to >= 100 ms, median of 7.
//
//     node bench/vmsession-bench.mjs [--quick]
import { compile } from '../host/js/src/compile.mjs';
import { vmScratchWords, vmScratchInit, vmValidate } from '../gen/js/snug/vm/api.mjs';
import { vmsWords, vmsArena, vmsInit, vmsStep, vmsNeedOffset, vmsNeedLength, vmsPosition } from '../gen/js/snug/vm/session.mjs';
import { inputs } from './scan-inputs.mjs';

const QUICK = process.argv.includes('--quick');
const REPS = QUICK ? 5 : 11, MIN_MS = QUICK ? 30 : 100;
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
function measureAll(fns) {
  // interleaved rounds: every variant once per round, so load drift on a shared
  // machine falls on all of them alike; median of REPS rounds per variant
  const ns = fns.map(fn => {
    fn(); fn();
    let n = 1;
    for (;;) { const t = cpu(); for (let i = 0; i < n; i++) fn(); const d = cpu() - t; if (d >= MIN_MS / 4 || n >= 1 << 22) return n; n = d < 1 ? n * 16 : Math.max(n * 2, Math.ceil(n * MIN_MS / 4 / d)); }
  });
  const per = fns.map(() => []);
  for (let r = 0; r < REPS; r++) fns.forEach((fn, k) => { const t = cpu(); for (let i = 0; i < ns[k]; i++) fn(); per[k].push((cpu() - t) / ns[k]); });
  return per.map(a => { a.sort((x, y) => x - y); return a[a.length >> 1]; });
}
const fmt = ms => ms >= 1 ? `${ms.toFixed(2)} ms` : ms >= 0.001 ? `${(ms * 1000).toFixed(1)} µs` : `${(ms * 1e6).toFixed(0)} ns`;

const permissive = {
  'vectors': 'r = any',
  'RPC put, 287 B': 'r = { * tstr => any }',
  'RPC put with 1 MiB bstr': 'r = { method: tstr, args: { key: tstr, data: bstr, * tstr => any }, * tstr => any }',
  '120,000-int array': 'r = { v: [* int] }',
  '1 MiB typed arrays': 'r = { f32: #6.85(bstr), f64: #6.86(bstr), i16: #6.77(bstr) }',
  'nested maps': 'r = { docs: [* { * tstr => any }] }',
};
const BIGL = { budget: 0x7fffffff, items: 1 << 24, entries: 1 << 24 };

function setup(text, maxLen) {
  const c = compile(text, { limits: BIGL });
  const P = c.program, B = c.pool;
  const S = new Int32Array(vmScratchWords(P, 0, P[16])); vmScratchInit(S, P[16]);
  const SS = new Int32Array(vmsWords(P));
  const lim0 = Int32Array.of(1, 0, 0x7fffffff, -1, -1, -1, -1, -1);
  const KA = new Uint8Array(vmsArena(P, lim0, maxLen));
  const SSS = new Int32Array(vmScratchWords(P, 0, P[16])); vmScratchInit(SSS, P[16]);
  const out = new Int32Array(8 + 2 * 257), out2 = new Int32Array(8 + 2 * 257);
  return {
    buffer(bytes, lim) { return vmValidate(P, B, 0, bytes, lim, S, out); },
    session(bytes, lim, chunk, quantum) {
      const total = bytes.length;
      vmsInit(P, B, 0, lim, SSS, SS, KA, total, quantum);
      let base = 0, len = chunk === 0 ? total : Math.min(chunk, total);
      for (;;) {
        const r = vmsStep(P, B, bytes.subarray(base, base + len), SSS, SS, KA, out2, base);
        if (r >= 0) return r;
        if (r === -64) { base = vmsNeedOffset(SS); len = Math.min(Math.max(chunk === 0 ? total : chunk, vmsNeedLength(SS)), total - base); }
        else if (r === -65) { const at = vmsPosition(SS); if (at < base || at >= base + len) { base = at; len = Math.min(chunk === 0 ? total - at : chunk, total - at); } }
        else throw new Error(`vms-step ${r}`);
      }
    },
    outs: () => [Array.from(out.slice(0, 8 + 2 * out[6])).join(' '), Array.from(out2.slice(0, 8 + 2 * out2[6])).join(' ')],
  };
}

const variants = [['buffer', 0, -1], ['s-whole', 0, 0], ['s-whole-q', 0, 65536], ['s-64K', 65536, 0], ['s-16K', 16384, 0], ['s-1K', 1024, 0]];
console.log(`# P6.2 session vs buffer driver, median CPU per call (Node ${process.version})`);
console.log(`${'input'.padEnd(44)} ${'schema'.padEnd(28)} | ${variants.map(v => v[0].padStart(10)).join(' | ')} | 1K/buffer`);
for (const inp of inputs) {
  const key = Object.keys(permissive).find(k => inp.name.startsWith(k));
  const list = inp.many ?? [inp.bytes];
  const maxLen = Math.max(...list.map(b => b.length));
  for (const text of [...new Set(['r = any', permissive[key]])]) {
    const js = setup(text, maxLen);
    const lim = Int32Array.of(inp.opt.top === 'any' ? 1 : 0, 0, 0x7fffffff, -1, -1, -1, -1, -1);
    for (const b of list) for (const [name, chunk, q] of variants.slice(1)) {
      js.buffer(b, lim); js.session(b, lim, chunk, q);
      const [x, y] = js.outs();
      if (x !== y) throw new Error(`${inp.name} ${text} ${name}: buffer ${x} session ${y}`);
    }
    const t = measureAll(variants.map(([, chunk, q]) => q < 0
      ? () => { for (const b of list) js.buffer(b, lim); }
      : () => { for (const b of list) js.session(b, lim, chunk, q); }));
    console.log(`${inp.name.slice(0, 44).padEnd(44)} ${text.slice(0, 28).padEnd(28)} | ${t.map(x => fmt(x).padStart(10)).join(' | ')} | ${(t[5] / t[0]).toFixed(2)}x  (whole ${(t[1] / t[0]).toFixed(2)}x, 64K ${(t[3] / t[0]).toFixed(2)}x)`);
  }
}
