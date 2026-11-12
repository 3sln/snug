// P9.14 (D334): CPU per budget unit of the ABNF engine's worst inputs, against the VM's own
// reference row measured alongside (D191's rule: each kind of metered work costs no more
// CPU per unit than the VM's worst walk -- the six-way choice of maps, generic dispatch).
// CPU time (process.cpuUsage), best of rounds: the machine may be shared.
//     node bench/abnf-calib.mjs [--quick]
import { encode } from './baseline/cbor-3sln.mjs';
import { compile } from '../host/js/src/compile.mjs';
import { vmScratchInit, vmValidate } from '../gen/js/snug/vm/api.mjs';
import * as K from '../gen/js/snug/abnf.mjs';
import os from 'node:os';

const quick = process.argv.includes('--quick');
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
function best(fn) {
  fn();
  let n = 1;   // repeat a short call until a round takes >= 20 ms (warm, above the timer's grain)
  for (;;) { const t = cpu(); for (let i = 0; i < n; i++) fn(); const d = cpu() - t; if (d >= 20 || n >= 1 << 16) break; n *= 4; }
  let m = 1e99;
  for (let r = 0; r < (quick ? 3 : 7); r++) { const t = cpu(); for (let i = 0; i < n; i++) fn(); m = Math.min(m, (cpu() - t) / n); }
  return m;
}
const te = new TextEncoder();
const item = s => { const b = te.encode(s), n = b.length; return Uint8Array.from([0x7a, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...b]); };

// the VM's reference row (bench/vm-calib.mjs)
const six = ['r = [* msg]', 'msg = a / b / c / d / e / f', ...'abcdef'.split('').map(k => `${k} = { kind: "${k}", v: ${({ a: 'uint', b: 'tstr', c: 'bool', d: '[* int]', e: '{ * tstr => int }', f: 'bstr' })[k]} }`)].join('\n');
const BIG = { budget: 0x7fffffff, items: 1 << 24, entries: 1 << 24, inputBytes: 0x7fffffff };
const c = compile(six, { limits: BIG });
const P = c.program, B = c.pool, S = new Int32Array(P[40] + 64); vmScratchInit(S, P[16]);
const out = new Int32Array(600), msgs = encode(Array.from({ length: 24000 }, (_, i) => ({ kind: 'a', v: i })), { maxItems: 1 << 24 });
const vmMs = best(() => vmValidate(P, B, 0, msgs, Int32Array.of(1, 0, -1, -1, -1, -1, -1, -1, 0), S, out));
const vmUnits = out[3];

let m = new Int32Array(1 << 12);
function abnf(grammar, input, room, mode = 0) {
  const a = item(grammar), t = new Int32Array(K.abnfWords(a.length));
  if (K.abnfPrep(a, 0, a.length, t) !== 0) throw new Error(grammar);
  const b = item(input);
  const go = () => {
    for (;;) {
      const r = K.abnfRun(t, mode, b, 0, b.length, m, room, -1);
      if (r === -1 && K.abnfMore(m) > m.length) { m = new Int32Array(K.abnfMore(m)); continue; }
      return r;
    }
  };
  const r = go();   // grows the scratch once, outside the warm timing
  const ms = best(go);
  // cold: as the hosts run it after giving a large scratch back -- a first scratch from
  // abnfScratchWords (32 words a byte), grown (a rerun each) to kin's suggestion only past
  // that, with the allocations; none of it charged
  const cold = best(() => { m = new Int32Array(K.abnfScratchWords(t, b.length, -1)); go(); });
  const u = r === -1 ? room : r >= 0 ? r : -2 - r;
  return { r, ms, cold, u };
}
const D = 2250000;
const rows = [
  ['ambiguous a = a a / "x", 200 x', 'a\na = a a / "x"', 'x'.repeat(200)],
  ['ambiguous with "", 200 x', 'a\na = a a / "x" / ""', 'x'.repeat(200)],
  ['right recursion, 3000 x', 'a\na = "x" a / ""', 'x'.repeat(3000)],
  ['left recursion, 60000 x', 'a\na = a "x" / ""', 'x'.repeat(60000)],
  ['nested nullable stars, 20000 x', '*(*(*(*"x")))', 'x'.repeat(20000)],
  ['1000*2000("x" / "x" "x"), 1500 x', '1000*2000("x" / "x" "x")', 'x'.repeat(1500)],
  ['300 alternatives, 3000 ~', 'a\na = ' + Array.from({ length: 300 }, (_, i) => `%x${(i % 64 + 32).toString(16)}`).join(' / ') + ' a / ""', '~'.repeat(3000)],
  ['date-time (RFC 3339), 4000 dates', 'd *("," d)\nd = date-time\ndate-time = full-date "T" full-time\nfull-date = 4DIGIT "-" 2DIGIT "-" 2DIGIT\nfull-time = 2DIGIT ":" 2DIGIT ":" 2DIGIT ["." 1*DIGIT] ("Z" / ("+" / "-") 2DIGIT ":" 2DIGIT)\nDIGIT = %x30-39', Array.from({ length: 4000 }, () => '2013-03-21T20:04:00.5+01:00').join(',')],
  ['long literal choice', '1*("abcdefgh" / "abcdefgi" / "abcdefgj")', 'abcdefgj'.repeat(5000)],
  ['deep nesting, 2000 a', 'x\nx = ' + '('.repeat(256) + '*"a"' + ')'.repeat(256), 'a'.repeat(2000)],
];
const env = { load: os.loadavg().map(x => x.toFixed(1)).join(' '), cpu: os.cpus()[0].model, node: process.version };
console.log(JSON.stringify(env));
const vmNs = vmMs * 1e6 / vmUnits;
console.log(`VM reference (six-way choice of maps, 24k msgs): ${vmUnits} units, ${vmMs.toFixed(1)} ms, ${vmNs.toFixed(1)} ns/unit`);
let worst = 0;
for (const [name, g, s] of rows) {
  const { r, ms, cold, u } = abnf(g, s, D);
  const ns = ms * 1e6 / Math.max(u, 1);
  worst = Math.max(worst, ns / vmNs);
  console.log(`${name}: ${r === -1 ? 'budget' : r >= 0 ? 'match' : 'refused'} ${u} units, ${ms.toFixed(1)} ms, ${ns.toFixed(1)} ns/unit (${(ns / vmNs).toFixed(2)} x VM); cold ${cold.toFixed(1)} ms`);
}
console.log(`worst ratio ${worst.toFixed(2)} (target <= 1)`);
