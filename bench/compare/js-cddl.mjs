// P7.8 part 2 (and the validate half of part 4): CDDL validation in a JS host.
//
//     node bench/compare/js-cddl.mjs [--quick] [--json=results/cddl.json]
//
// Validators: snug JS (public Schema API: schema.validate), snug wasm (host/wasm VM; Program loaded once per schema;
// input copied into linear memory per call), the `cddl` crate 0.10.7 as wasm (rust/cddl-wasm; input copied per call),
// @cbortech/cbor's CDDL validator (JS, over CBOR bytes) and cddl.js (CDDL -> Zod; cbor2 decode then safeParse; a
// deliberate CDDL subset with Zod semantics, see README). Each in its own isolate (cddl-worker.mjs). Verdicts are
// checked against the expected verdict outside timing; a disagreeing cell is marked "!".
import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { environment, ensureGcFlags, median, fmt } from './lib.mjs';
import { studyCases, workloadCases } from './cddl-cases.mjs';

await ensureGcFlags();
const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const JSON_OUT = args.find(a => a.startsWith('--json='))?.slice(7);
const ROUNDS = QUICK ? 3 : 7, TARGET = QUICK ? 10 : 25, SLOW_MS = 3000;
const GROUPS = ['snug-js', 'snug-wasm', 'crate-wasm', 'cbortech', 'cddl.js'];
const workers = new Map(GROUPS.map(g => [g, new Worker(new URL('./cddl-worker.mjs', import.meta.url), { workerData: { group: g } })]));
const call = (g, msg) => new Promise((res, rej) => { const w = workers.get(g); w.once('message', m => m.ok ? res(m) : rej(new Error(`${g}: ${m.error}`))); w.postMessage(msg); });

const env = environment({ quick: QUICK, rounds: ROUNDS, targetMs: TARGET });
console.log(JSON.stringify(env));
const cases = [...studyCases(), ...workloadCases()];
const reports = Object.fromEntries(await Promise.all(GROUPS.map(async g => [g, (await call(g, { cmd: 'load' })).report])));
const rows = cases.map((c, i) => ({ id: c.id, rule: c.rule, valid: c.valid, bytes: c.list.reduce((n, b) => n + b.length, 0), items: c.list.length,
  cells: Object.fromEntries(GROUPS.map(g => [g, { ...reports[g][i] }])) }));

// Time row by row; within a row the validators interleave over rounds in a rotating order.
for (const r of rows) {
  const timed = GROUPS.filter(g => r.cells[g].status === 'ok');
  for (const g of timed) {
    const cell = r.cells[g];
    cell.n = (await call(g, { cmd: 'calibrate', id: r.id, targetMs: TARGET })).n;
    cell.samples = [];
  }
  for (let k = 0; k < ROUNDS; k++) for (let o = 0; o < timed.length; o++) {
    const g = timed[(k + o) % timed.length], cell = r.cells[g];
    if (cell.samples.length && cell.samples[0] > SLOW_MS && cell.samples.length >= 3) continue; // very slow: 3 samples are enough
    cell.samples.push((await call(g, { cmd: 'sample', id: r.id, n: cell.n })).ms);
  }
  for (const g of timed) { const c = r.cells[g]; c.med = median(c.samples); c.min = Math.min(...c.samples); }
  const show = g => { const c = r.cells[g]; return c.med !== undefined ? `${fmt(c.med)}${c.agrees ? '' : ' !'}` : c.status; };
  console.log(`${r.id.padEnd(28)} ${String(r.bytes).padStart(8)} B ${r.valid ? 'valid  ' : 'invalid'} | ${GROUPS.map(g => `${g}=${show(g)}`).join(' | ')}${r.cells['snug-js'].extra?.units !== undefined ? ` | units ${r.cells['snug-js'].extra.units}` : ''}`);
}
for (const r of rows) for (const g of GROUPS) { const c = r.cells[g]; if (c.note || !c.agrees && c.status === 'ok') console.log(`  ${r.id} ${g}: ${c.status}${c.status === 'ok' ? ` verdict ${c.verdict} (expected ${r.valid})` : ''}${c.note ? ` - ${c.note}` : ''}`); }
env.loadEnd = environment().load;
console.log(`load at end: ${env.loadEnd}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ env, groups: GROUPS, rows }, (k, v) => k === 'samples' ? v.map(x => +x.toPrecision(5)) : v, 1));
for (const w of workers.values()) await w.terminate();
