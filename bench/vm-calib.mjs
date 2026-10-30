// P3.6 budget calibration (bench/VM.md "Budget"): CPU per budget unit by
// event kind, the worst budget-bounded inputs found, and the units valid
// benchmark messages need. CPU time, best of rounds (shared machine).
//     node bench/vm-calib.mjs [budget] [--s1]   (default 2 300 000, D046; schedule 2, D045, is the default; --s1: legacy schedule 1)
import { readFileSync } from 'node:fs';
import { encode } from './baseline/cbor-3sln.mjs';
import { inputs } from './scan-inputs.mjs';
import { compile } from '../host/js/src/compile.mjs';
import { vmScratchInit, vmValidate } from '../gen/js/snug/vm/api.mjs';

const S1 = process.argv.includes('--s1') ? 2 : 0;   // limits word 8 bit 1: legacy schedule 1
const BUDGET = Number(process.argv.slice(2).find(a => !a.startsWith('--')) ?? 2_300_000);
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
function best(fn) {
  fn();
  let n = 1;
  for (;;) { const t = cpu(); for (let i = 0; i < n; i++) fn(); const d = cpu() - t; if (d >= 60 || n >= 1 << 20) break; n = d < 1 ? n * 16 : Math.max(n * 2, Math.ceil(n * 60 / d)); }
  let m = 1e99; for (let r = 0; r < 5; r++) { const t = cpu(); for (let i = 0; i < n; i++) fn(); m = Math.min(m, (cpu() - t) / n); }
  return m;
}
const src = n => readFileSync(new URL(`../corpus/cddl-study/contracts/${n}`, import.meta.url), 'utf8');
const BIG = { budget: 0x7fffffff, items: 1 << 24, entries: 1 << 24, inputBytes: 0x7fffffff };
function vm(text, rule = 'r') {
  const c = compile(text, { limits: BIG });
  const P = c.program, B = c.pool, S = new Int32Array(P[40] + 64); vmScratchInit(S, P[16]);
  const out = new Int32Array(600), r = c.rules.indexOf(rule);
  return (bytes, budget = -1, generic = 0) => { vmValidate(P, B, r, bytes, Int32Array.of(1, 0, -1, -1, -1, -1, -1, budget, generic | S1), S, out); return [out[0], out[3]]; };
}
const rows = [];
function kind(label, text, bytes, rule = 'r') {
  const v = vm(text, rule);
  const [code, units] = v(bytes);
  const t = best(() => v(bytes));
  const tg = best(() => v(bytes, -1, 1));
  rows.push({ label, code, units, t, ns: t * 1e6 / units, nsg: tg * 1e6 / units });
  console.log(`${label.padEnd(64).slice(0, 64)} code ${String(code).padStart(2)} units ${String(units).padStart(9)} ${t.toFixed(3).padStart(8)} ms  ${(t * 1e6 / units).toFixed(1).padStart(5)} ns/unit  (generic ${(tg * 1e6 / units).toFixed(1)})`);
}
console.log(`# CPU per unit by event kind (unlimited budget)${S1 ? ' -- LEGACY SCHEDULE 1' : ' -- schedule 2 (D045)'}`);
const te = new TextEncoder();
const ints = Array.from({ length: 120000 }, (_, i) => i * 7 - 300000);
kind('dead walk: 120k ints under any', 'r = any', encode(ints, { maxEntries: 1 << 20 }));
kind('dead walk: nested maps under any', 'r = any', inputs.find(i => i.name.startsWith('nested')).bytes);
kind('[* int] (fast streak)', 'r = [* int]', encode(ints, { maxEntries: 1 << 20 }));
kind('[* tstr] short (fast streak)', 'r = [* tstr]', encode(Array.from({ length: 100000 }, (_, i) => 'k' + i), { maxEntries: 1 << 20 }));
kind('{docs: [* {* tstr => any}]} (fast table)', 'r = { docs: [* { * tstr => any }] }', inputs.find(i => i.name.startsWith('nested')).bytes);
const recs = Array.from({ length: 10000 }, (_, i) => ({ id: i, kind: 'note', title: 'A small benchmark document', meta: { owner: 'person', size: 128, active: true }, body: 'x'.repeat(35) }));
kind('struct records (fast struct)', 'r = [* { id: uint, kind: tstr, title: tstr, meta: { owner: tstr, size: uint, active: bool }, body: tstr }]', encode(recs, { maxEntries: 1 << 20, maxItems: 1 << 24 }));
const six = ['r = [* msg]', 'msg = a / b / c / d / e / f', ...'abcdef'.split('').map(k => `${k} = { kind: "${k}", v: ${({ a: 'uint', b: 'tstr', c: 'bool', d: '[* int]', e: '{ * tstr => int }', f: 'bstr' })[k]} }`)].join('\n');
kind('six-way choice of maps, 24k msgs (generic)', six, encode(Array.from({ length: 24000 }, (_, i) => ({ kind: 'a', v: i })), { maxItems: 1 << 24 }));
const twenty = ['r = [* msg]', 'msg = ' + Array.from({ length: 20 }, (_, i) => 'm' + i).join(' / '), ...Array.from({ length: 20 }, (_, i) => `m${i} = { kind: ${i}, v: uint, ? w: tstr, ? x: bool }`)].join('\n');
kind('20-way choice of maps, late discriminator (generic)', twenty, encode(Array.from({ length: 8000 }, (_, i) => ({ v: i, kind: 19 })), { maxItems: 1 << 24 }));
const open100 = ['r = [* msg]', 'msg = ' + Array.from({ length: 40 }, (_, i) => 'o' + i).join(' / '), ...Array.from({ length: 40 }, (_, i) => `o${i} = { t${i}: uint, * tstr => any }`)].join('\n');
kind('40 open map types, no discriminator (generic)', open100, encode(Array.from({ length: 4000 }, (_, i) => ({ a: i, b: 'x', c: i })), { maxItems: 1 << 24 }));
const mixed = ['r = [* msg]', 'msg = ' + Array.from({ length: 20 }, (_, i) => 'x' + i).join(' / '), ...Array.from({ length: 20 }, (_, i) => `x${i} = { kind: ${i}, ? w: tstr, * tstr => any }`)].join('\n');
kind('20-way mixed maps (literal + wildcard), late discriminator', mixed, encode(Array.from({ length: 6000 }, (_, i) => ({ a: i, b: 'x', w: 'y', kind: 19 })), { maxItems: 1 << 24 }));
kind('absorb factor { ? (a: int, b: int), * tstr => any }', 'r = [* { ? (a: int, b: int), * tstr => any }]', encode(Array.from({ length: 20000 }, (_, i) => ({ a: i, c: 'x', d: i })), { maxItems: 1 << 24 }));
kind('AND per element [* ((tstr .size (1..9)) .and (tstr .regexp "[a-z]+"))]', 'r = [* ((tstr .size (1..9)) .and (tstr .regexp "[a-z]+"))]', encode(Array.from({ length: 50000 }, () => 'abcdefg'), { maxEntries: 1 << 20 }));
kind('array of 6-way struct choices, discriminator first', six.replace('v: uint', 'v: uint').replace(/kind: "(\w)", v:/g, 'a: "$1", v:'), encode(Array.from({ length: 24000 }, (_, i) => ({ a: 'f', v: new Uint8Array(1) })), { maxItems: 1 << 24 }));
const reqs = Array.from({ length: 12000 }, () => ({ method: 'presign', args: { key: 'k', operation: 'read', range: { start: 0, end: 5 } } }));
kind('12k object-storage requests (choices, generic)', 'r = [* request]\n' + src('object-storage-v1.cddl'), encode(reqs, { maxItems: 1 << 24, maxEntries: 1 << 20 }));
kind('regexp (a|b|ab|ba)*c over 200k code points', 'r = tstr .regexp "(a|b|ab|ba)*c"', encode('ab'.repeat(100000)));
kind('regexp 200-position class run', 'r = tstr .regexp "[a-z]{0,200}[0-9]"', encode('abcdefghij'.repeat(20)));
kind('contract object-storage request (generic choice)', src('object-storage-v1.cddl'), encode({ method: 'put', args: { key: 'k', data: new Uint8Array(10), condition: { absent: true } } }), 'request');
kind('litset of 200 text literals', `r = [* (${Array.from({ length: 200 }, (_, i) => `"lit${i}"`).join(' / ')})]`, encode(Array.from({ length: 20000 }, (_, i) => 'lit' + (i % 200)), { maxEntries: 1 << 20 }));
kind('wide array automaton [* (uint, tstr, bool, null)]', 'r = [* (uint, tstr, bool, null)]', encode(Array.from({ length: 40000 }, (_, i) => [i, 'x', true, null][i % 4]), { maxEntries: 1 << 20 }));

const worst = rows.reduce((a, b) => (b.ns > a.ns ? b : a));
console.log(`\n# worst ns/unit: ${worst.ns.toFixed(1)} (${worst.label}); a ${BUDGET} budget costs up to ~${(worst.ns * BUDGET / 1e6).toFixed(1)} ms there`);
console.log(`# budget for 50 ms at that rate: ~${Math.floor(50e6 / worst.ns)} units`);

console.log('\n# units of valid benchmark messages (unlimited budget)');
const valid = [
  ['RPC put 287 B :: { * tstr => any }', 'r = { * tstr => any }', inputs.find(i => i.name.startsWith('RPC put,')).bytes],
  ['120k ints :: { v: [* int] }', 'r = { v: [* int] }', inputs.find(i => i.name.startsWith('120,000')).bytes],
  ['nested maps 1.1 MB :: { docs: [* { * tstr => any }] }', 'r = { docs: [* { * tstr => any }] }', inputs.find(i => i.name.startsWith('nested')).bytes],
  ['1 MiB typed arrays :: tags', 'r = { f32: #6.85(bstr), f64: #6.86(bstr), i16: #6.77(bstr) }', inputs.find(i => i.name.startsWith('1 MiB typed')).bytes],
  ['struct records (10k) :: struct', 'r = [* { id: uint, kind: tstr, title: tstr, meta: { owner: tstr, size: uint, active: bool }, body: tstr }]', encode(recs, { maxEntries: 1 << 20, maxItems: 1 << 24 })],
  ['1.5 MB of ints :: [* int]', 'r = [* int]', encode(Array.from({ length: 300000 }, (_, i) => i * 3), { maxEntries: 1 << 20, maxItems: 1 << 24 })],
  ['1.5 MB of short maps :: [* { * tstr => int }]', 'r = [* { * tstr => int }]', encode(Array.from({ length: 50000 }, (_, i) => ({ a: i, b: i, c: i, d: 1 })), { maxEntries: 1 << 20, maxItems: 1 << 24 })],
];
for (const [label, text, bytes] of valid) {
  const v = vm(text); const [code, units] = v(bytes); const t = best(() => v(bytes));
  console.log(`${label.padEnd(56)} ${String(bytes.length).padStart(8)} B  code ${code}  units ${String(units).padStart(9)}  ${t.toFixed(2).padStart(7)} ms  ${units <= BUDGET ? 'fits' : 'EXCEEDS'} ${BUDGET}`);
}
