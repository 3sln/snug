// P7.8 part 4: snug's wasm build vs snug's generated JS, same inputs, in Node. Every wasm call copies its input into
// linear memory (timed); the copy alone is reported too.
//
//     node bench/compare/wasm.mjs [--quick] [--json=results/wasm.json]
//
// Rows: scan (profile check only; JS gen/js scanner vs wasm snug_scan), decode (JS scan + JS build vs wasm scan + the
// same JS build: wasm has no value builder), validate (the VM against each workload's schema from cddl-cases.mjs;
// low-level vm-validate with a reused scratch on both sides, as bench/VM.md does).
import { writeFileSync } from 'node:fs';
import { bench, fmt, environment, ensureGcFlags } from './lib.mjs';
import { snugWasm } from './wasm-load.mjs';
import { workloads } from './workloads.mjs';
import { workloadCases } from './cddl-cases.mjs';
import { scan } from '../../host/js/src/scan.mjs';
import { build } from '../../host/js/src/build.mjs';
import { decode } from '../../host/js/src/index.mjs';
import { compile } from '../../host/js/src/compile.mjs';
import { Program } from '../../host/js/src/schema.mjs';
import { vmVerify, vmVerifyWords } from '../../gen/js/snug/program/verify.mjs';
import { vmScratchWords, vmScratchInit, vmValidate } from '../../gen/js/snug/vm/api.mjs';

await ensureGcFlags();
const QUICK = process.argv.includes('--quick');
const JSON_OUT = process.argv.find(a => a.startsWith('--json='))?.slice(7);
const OPTS = QUICK ? { rounds: 3, targetMs: 10, warm: 1 } : { rounds: 9, targetMs: 25, warm: 3 };
const w = await snugWasm();
if (!w) { console.log('snug wasm not built (run-rust.sh)'); process.exit(3); }
const env = environment({ ...OPTS, wasmBytes: w.size });
console.log(JSON.stringify(env));
const lim = v => v ?? -1;
const limitWords = o => Int32Array.of(o.top === 'map' ? 0 : 1, o.cose ? 1 : 0, lim(o.maxBytes), lim(o.maxDepth), lim(o.maxEntries), lim(o.maxItems), -1, -1);
const out = new Int32Array(8 + 2 * 257);
const rows = [];
const cases = workloadCases();
console.log('| workload | bytes | scan JS | scan wasm (incl. copy) | copy alone | decode JS | wasm scan + JS build | validate JS (VM) | validate wasm (VM, incl. copy) |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const wl of workloads()) {
  const list = wl.seq ? wl.bytes : [wl.bytes];
  if (list.some(b => b.length > w.cap)) { console.log(`| ${wl.name} | ${wl.size} | input larger than the wasm buffer |`); continue; }
  const o = wl.opts;
  const c = cases.find(x => x.id === `workload:${wl.id}`);
  const k = compile(c.text, { limits: { budget: 0x7fffffff, items: 1 << 24, entries: 1 << 24 } });
  const prog = new Program(k.program, k.pool, { verify: vmVerify, verifyWords: vmVerifyWords });
  const rule = k.rules.indexOf(c.rule);
  const S = new Int32Array(vmScratchWords(prog.P, rule, prog.P[16]) + 4096); vmScratchInit(S, prog.P[16]);
  const L = limitWords(o);
  w.load(prog.P, prog.B);
  const mem = () => new Uint8Array(w.cap); // a same-size plain copy target, for "copy alone"
  const target = mem();
  const expect = JSON.stringify(list.map(b => decode(b, o)), (key, v) => typeof v === 'bigint' ? v.toString() : ArrayBuffer.isView(v) ? Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) : v);
  const same = r => JSON.stringify(r, (key, v) => typeof v === 'bigint' ? v.toString() : ArrayBuffer.isView(v) ? Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) : v) === expect;
  const zero = r => { if (!r.every(x => x === 0)) throw new Error(`${wl.id}: refused`); };
  const ops = [
    { name: 'scan-js', fn: () => list.map(b => { scan(b, o); return 0; }), check: zero },
    { name: 'scan-wasm', fn: () => list.map(b => w.scan(b, o)), check: zero },
    { name: 'copy', fn: () => list.map(b => { target.set(b); return 0; }) },
    { name: 'decode-js', fn: () => list.map(b => decode(b, o)), check: r => { if (!same(r)) throw new Error('decode answer'); } },
    { name: 'decode-wasm', fn: () => list.map(b => { const code = w.scan(b, o); if (code) throw new Error(`wasm scan ${code}`); return build(b, o); }), check: r => { if (!same(r)) throw new Error('decode answer'); } },
    { name: 'validate-js', fn: () => list.map(b => vmValidate(prog.P, prog.B, rule, b, L, S, out)), check: zero },
    { name: 'validate-wasm', fn: () => list.map(b => w.validate(rule, b, L)), check: zero },
  ];
  const res = Object.fromEntries(bench(ops, OPTS).map(r => [r.name, r]));
  rows.push({ id: wl.id, name: wl.name, size: wl.size, res });
  const f = n => fmt(res[n].med);
  console.log(`| ${wl.name} | ${wl.size} | ${f('scan-js')} | ${f('scan-wasm')} | ${f('copy')} | ${f('decode-js')} | ${f('decode-wasm')} | ${f('validate-js')} | ${f('validate-wasm')} |`);
}
env.loadEnd = environment().load;
console.log(`load at end: ${env.loadEnd}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ env, rows }, null, 1));
