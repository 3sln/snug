// bb vm-test's cases (sections 1-4 of kin/scripts/vm-test.mjs), shared with
// bb vmsession-test (P6.2), which runs every one of them through the resumable
// session as well. Building them is deterministic in (MUTATIONS, SEED, SCHEMAS).
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compile } from '../../host/js/src/compile.mjs';
import { vmVerify } from '../../gen/js/snug/program/verify.mjs';
import { vmScratchWords, vmScratchWordsSlow, vmScratchInit, vmValidate, vmValidateSpan } from '../../gen/js/snug/vm/api.mjs';
import { scan, scanOptions, scanProfile, errorOffset, itemsScanned, codeName } from '../../gen/js/snug/cbor/scan.mjs';
import { buildDetCases, optWords } from './det-cases.mjs';
import { buildCases, hex } from './scan-cases.mjs';
import { EXAMPLE_P, EXAMPLE_B } from './vm-example.mjs';
import { assembledCases } from './vm-cases.mjs';
import { Program as HostProgram } from '../../host/js/src/schema.mjs';
import { encode, decode } from '../../bench/baseline/cbor-3sln.mjs';
import { compile as oracleCompile, check as oracleCheck } from '../../corpus/tools/oracle.mjs';
import { oracleSchemas } from './vm-oracle-gen.mjs';
import { addExtCases } from './ext-cases.mjs';

export const unhex = h => Uint8Array.from(Buffer.from(h, 'hex'));
// limits words (program.md §12.3): 0..7, word 8 the VM's generic/schedule bits, word 9 the profile flags (D120)
export const LIM = (top, cose, mb = -1, md = -1, me = -1, mi = -1, bn = -1, bu = -1, pf = 0) => [top, cose, mb, md, me, mi, bn, bu, 0, pf];

/** Every vm-test case: {programs: [{P, B, label}], cases: [{prog, rule, lim, bytes, label, check, span?, identity?, corpus?, oracle?}], ...}. */
export function buildVmCases({ MUTATIONS, SEED, SCHEMAS, fail }) {
const programs = [];     // {P, B, label}
const cases = [];        // {prog, rule, lim, bytes, label, check(out) -> string|null, span?}
function addProgram(P, B, label) {
  const S = new Int32Array(48 + 2 * Math.max(P[16], 1) + 64); S[16] = 1; S[17] = Math.max(P[16], 1);
  const v = vmVerify(P, B, S);
  if (v !== 0) fail(`${label}: vm-verify refused the Program (word ${S[35]}, check ${S[36]})`);
  for (let r = 0; r < P[15]; r++) for (const m of [0, P[16] + 5]) if (vmScratchWords(P, r, m) !== vmScratchWordsSlow(P, r, m)) fail(`${label}: scratch words of rule ${r} differ from the chain formula`);
  programs.push({ P, B, label });
  return programs.length - 1;
}

// ---------------------------------------------------------------- 1. §15
const ex = addProgram(EXAMPLE_P, EXAMPLE_B, 'program.md §15');
const want15 = [['a26179816170646b696e646162', '0 0 0 55 6 0 0 0'], ['a1646b696e646161', '33 0 0 47 3 1 1 0 1 0'],
  ['a261786131646b696e646161', null]];
for (const [h, w] of want15) cases.push({ prog: ex, rule: 0, lim: LIM(1, 0), bytes: unhex(h), label: `§15 ${h}`,
  check: o => (w === null ? (o.startsWith('32 0 3 ') && o.endsWith(' 1 1 0 1 0') ? null : `contrast ${o}`) : (o === w ? null : `got ${o}, document says ${w}`)) });
{
  const c = compile('r = { kind: "a", x: int // kind: "b", ? y: [* tstr] }');
  let d = 0; for (let i = 0; i < Math.max(c.program.length, EXAMPLE_P.length); i++) if (c.program[i] !== EXAMPLE_P[i] && !(i >= 7 && i <= 14)) d++;
  if (d || hex(c.pool) !== hex(EXAMPLE_B)) fail(`§15: the compiler's Program differs from the document in ${d} words`);
}

// ---------------------------------------------------------------- 2. profile identity
const anyC = compile('r = any', { limits: { depth: 256, inputBytes: 0x7fffffff, entries: 1 << 24, items: 1 << 24, budget: 0x7fffffff } });
const anyP = addProgram(anyC.program, anyC.pool, 'any');
const sc = buildCases(MUTATIONS, SEED);
const o16 = new Int32Array(16);
const clamp = n => Math.min(n, 0x7fffffff);
let nIdentity = 0;
for (const c of sc.cases) {
  const opt = c.opt;
  scanOptions(o16, opt.top === 'any' ? 1 : 0, opt.cose ? 1 : 0, clamp(opt.maxBytes), clamp(opt.maxDepth), clamp(opt.maxEntries), clamp(opt.maxItems));
  const code = scan(c.bytes, o16), off = errorOffset(o16), items = itemsScanned(o16);
  nIdentity++;
  cases.push({ prog: anyP, rule: 0, lim: LIM(opt.top === 'any' ? 1 : 0, opt.cose ? 1 : 0, clamp(opt.maxBytes), clamp(opt.maxDepth), clamp(opt.maxEntries), clamp(opt.maxItems)),
    bytes: c.bytes, label: `identity ${c.label}`, identity: true,
    check: o => { const w = o.split(' ').map(Number);
      if (w[0] !== code) return `VM ${w[0]} scanner ${code} (${codeName(code)})`;
      if (code !== 0 && w[2] !== off) return `offset VM ${w[2]} scanner ${off}`;
      if (w[4] !== items) return `items VM ${w[4]} scanner ${items}`;
      return null; } });
}

// 2b. the same inputs through a schema that keeps EVERYTHING live (maps,
// arrays, tags, decimals, ndarrays, typed arrays, embedded CBOR): profile
// errors must still win with the scanner's code and offset (D023), and
// every profile-valid input is accepted with the scanner's item count.
const LIVE = `r = v
v = [* v] / { * (tstr / int) => v } / int / integer / float / tstr / bstr / bool / null /
    #6.4([int, integer]) / #6.40([[* uint], [* v] / typed]) / typed / bstr .cbor v
typed = #6.69(bstr) / #6.70(bstr) / #6.71(bstr) / #6.72(bstr) / #6.77(bstr) / #6.78(bstr) /
        #6.79(bstr) / #6.84(bstr) / #6.85(bstr) / #6.86(bstr)`;
const liveC = compile(LIVE, { limits: { depth: 256, inputBytes: 0x7fffffff, entries: 1 << 24, items: 1 << 24, budget: 0x7fffffff } });
const liveP = addProgram(liveC.program, liveC.pool, 'live everything');
const liveRule = liveC.rules.indexOf('r');
for (const c of sc.cases) {
  const opt = c.opt;
  scanOptions(o16, opt.top === 'any' ? 1 : 0, opt.cose ? 1 : 0, clamp(opt.maxBytes), clamp(opt.maxDepth), clamp(opt.maxEntries), clamp(opt.maxItems));
  const code = scan(c.bytes, o16), off = errorOffset(o16), items = itemsScanned(o16);
  cases.push({ prog: liveP, rule: liveRule, lim: LIM(opt.top === 'any' ? 1 : 0, opt.cose ? 1 : 0, clamp(opt.maxBytes), clamp(opt.maxDepth), clamp(opt.maxEntries), clamp(opt.maxItems)),
    bytes: c.bytes, label: `live identity ${c.label}`, identity: true,
    check: o => { const w = o.split(' ').map(Number);
      if (w[0] !== code) return `VM ${w[0]} scanner ${code} (${codeName(code)})`;
      if (code !== 0 && w[2] !== off) return `offset VM ${w[2]} scanner ${off}`;
      if (w[4] !== items) return `items VM ${w[4]} scanner ${items}`;
      return null; } });
}

// 2c. the profile options (P7.1, D120): the deterministic vectors, fixed edge cases and seeded cases under random
// profile flags (kin/scripts/det-cases.mjs) through the VM against `any` and against a schema that keeps the new
// shapes live (any keys, the standard tags, undefined, every float), limits word 9 = the flags: the scanner's code,
// offset and item count under the same flags.
const LIVE2 = `r = v
v = [* v] / { * any => v } / int / integer / float / tstr / bstr / bool / null / undefined /
    tdate / time / eb64url / eb64legacy / eb16 / encoded-cbor / uri / cbor-any /
    #6.24(bytes .cbor v) / #6.4([int, integer]) / #6.40([[* uint], [* v] / typed]) / typed / bstr .cbor v /
    float16 .ge 0.0 / (-1.0 .. 1.0) / (1.5 .. 100000.0)
typed = #6.69(bstr) / #6.70(bstr) / #6.71(bstr) / #6.72(bstr) / #6.77(bstr) / #6.78(bstr) /
        #6.79(bstr) / #6.84(bstr) / #6.85(bstr) / #6.86(bstr)`;
const live2C = compile(LIVE2, { limits: { depth: 256, inputBytes: 0x7fffffff, entries: 1 << 24, items: 1 << 24, budget: 0x7fffffff } });
const live2P = addProgram(live2C.program, live2C.pool, 'live profile options');
const live2Rule = live2C.rules.indexOf('r');
const dc = buildDetCases(Math.max(1500, Math.round(MUTATIONS / 2)), SEED);
for (const c of dc.cases) {
  const opt = c.opt;
  scanOptions(o16, ...optWords(opt)); scanProfile(o16, opt.flags);
  const code = scan(c.bytes, o16), off = errorOffset(o16), items = itemsScanned(o16);
  const lim = LIM(...optWords(opt), -1, -1, opt.flags);
  for (const [prog, rule, tag] of [[anyP, 0, 'det identity'], [live2P, live2Rule, 'det live identity']])
    cases.push({ prog, rule, lim, bytes: c.bytes, label: `${tag} ${c.label}`, identity: true,
      check: o => { const w = o.split(' ').map(Number);
        if (w[0] !== code) return `VM ${w[0]} scanner ${code} (${codeName(code)})`;
        if (code !== 0 && w[2] !== off) return `offset VM ${w[2]} scanner ${off}`;
        if (w[4] !== items) return `items VM ${w[4]} scanner ${items}`;
        return null; } });
}

// ---------------------------------------------------------------- 3. conformance
const corpus = { suites: 0, compiled: 0, refusedOk: 0, refusedNot: [], notCompiled: [], later: 0, cases: 0 };
for (const file of ['study', 'adversarial']) {
  const j = JSON.parse(readFileSync(new URL(`../../corpus/conformance/${file}.json`, import.meta.url)));
  for (const su of j.suites) {
    corpus.suites++;
    if (su.phase === 'later') { corpus.later++; continue; }
    const text = su.cddl ?? readFileSync(new URL(`../../corpus/${su.cddlFile}`, import.meta.url), 'utf8');
    let c = null, err = null;
    try { c = compile(text); } catch (e) { err = e; }
    const refusal = su.snugSchemaError ?? su.schemaError;
    if (refusal) { if (c) corpus.refusedNot.push(`${file}: ${su.name}`); else corpus.refusedOk++; continue; }
    if (!c) { corpus.notCompiled.push(`${file}: ${su.name} -- ${err?.code ?? err?.message}`); continue; }
    corpus.compiled++;
    const pi = addProgram(c.program, c.pool, `${file}: ${su.name}`);
    for (const k of su.cases) {
      const rule = c.rules.indexOf(k.rule);
      if (rule < 0) { fail(`${file}: ${su.name}: no rule ${k.rule}`); continue; }
      corpus.cases++;
      const opt = su.options ?? {};
      cases.push({ prog: pi, rule, lim: LIM(1, opt.cose ? 1 : 0, -1, -1, -1, opt.maxItems ?? -1), bytes: unhex(k.hex),
        label: `${file}: ${su.name} [${k.hex.slice(0, 40)}]`, corpus: true,
        check: o => { const ok = o.split(' ')[0] === '0'; return ok === k.expect ? null : `verdict ${ok}, expected ${k.expect} (out ${o})`; } });
    }
  }
}

// ---------------------------------------------------------------- 3b. oracle differential (D022)
const diff = { schemas: 0, compiled: 0, refused: 0, oracleRefused: 0, unknown: 0, cases: 0, refusals: {} };
for (const { cddl, values } of oracleSchemas(SCHEMAS, 8, SEED * 7919 + 1)) {
  diff.schemas++;
  let c;
  try { c = compile(cddl); } catch (e) { diff.refused++; diff.refusals[e.code ?? e.message] = (diff.refusals[e.code ?? e.message] ?? 0) + 1; continue; }
  const os = oracleCompile(cddl);
  if (os.error) { diff.oracleRefused++; continue; }
  diff.compiled++;
  const pi = addProgram(c.program, c.pool, `oracle: ${cddl}`);
  for (const v of values) {
    let bytes; try { bytes = encode(v); } catch { continue; }
    const want = oracleCheck(os, 'r', decode(bytes, { top: 'any' }), { steps: 200000 });
    if (want === 'unknown') { diff.unknown++; continue; }
    diff.cases++;
    cases.push({ prog: pi, rule: c.rules.indexOf('r'), lim: LIM(1, 0), bytes, label: `oracle: ${cddl} [${hex(bytes).slice(0, 40)}]`, oracle: true,
      check: o => { const ok = o.split(' ')[0] === '0'; return ok === want ? null : `VM ${ok}, oracle ${want} (out ${o})`; } });
  }
}

// ---------------------------------------------------------------- 3c. fast-path stress (D044)
// shapes the fast paths take, with failures, profile errors, item limits and
// budgets landing at random points; the fast == generic comparison below and
// the JS == Rust == wasm comparison hold them to the generic path.
{
  let st = (SEED * 2654435761) >>> 0 || 1;
  const rnd = n => { st ^= st << 13; st ^= st >>> 17; st ^= st << 5; return (st >>> 0) % n; };
  const shapes = [
    ['r = [* int]', () => rnd(5) ? rnd(70000) - 35000 : choose(['x', 1.5, 1n << 70n, [1], null])],
    ['r = [* (0..100)]', () => rnd(6) ? rnd(100) : choose([101, -1, 'x', 1000000])],
    ['r = [* tstr .size (0..3)]', () => rnd(6) ? choose(['', 'a', 'ab', 'abc', 'é']) : choose(['abcd', 1, 'éé', [], 'ééé'])],
    ['r = { v: [* uint], w: [* tstr] }', null],
    ['r = [* { * tstr => int }]', null],
    ['r = { * tstr => any }', null],
    ['r = { * tstr => [* int] }', null],
    ['r = [* { a: uint, ? b: tstr, c: bool }]', null],
    ['r = { id: uint, ? m: { x: int, y: int }, tags: [* tstr] }', null],
  ];
  function choose(xs) { return xs[rnd(xs.length)]; }
  for (const [text, el] of shapes) {
    const c = compile(text, { limits: { items: 1 << 20, entries: 1 << 20 } });
    const pi = addProgram(c.program, c.pool, `stress: ${text}`);
    for (let k = 0; k < 400; k++) {
      let v;
      const len = rnd(4) ? rnd(40) : rnd(400);
      if (el) v = Array.from({ length: len }, el);
      else if (text.startsWith('r = { v:')) v = { v: Array.from({ length: len }, () => rnd(8) ? rnd(1000) : -1), w: Array.from({ length: rnd(20) }, () => rnd(8) ? 'ab' : 7) };
      else if (text.startsWith('r = [*')) v = Array.from({ length: rnd(30) }, () => Object.fromEntries(Array.from({ length: rnd(6) }, (_, i) => ['k' + i, rnd(8) ? rnd(100) : 'z'])));
      else if (text.includes('c: bool')) v = Array.from({ length: rnd(30) }, () => { const o = {}; if (rnd(9)) o.a = rnd(8) ? rnd(9) : 'x'; if (rnd(2)) o.b = rnd(6) ? 'b' : 0; if (rnd(9)) o.c = rnd(8) ? true : 1; if (!rnd(12)) o.z = 1; return o; });
      else if (text.includes('tags:')) { v = { id: rnd(7) ? rnd(99) : -3, tags: Array.from({ length: rnd(9) }, () => rnd(9) ? 't' : 5) }; if (rnd(2)) v.m = { x: rnd(5), y: rnd(9) ? 2 : 'y' }; if (!rnd(9)) delete v.id; }
      else if (text.includes('[* int]')) v = Object.fromEntries(Array.from({ length: rnd(12) }, (_, i) => ['k' + String.fromCharCode(97 + i), Array.from({ length: rnd(30) }, () => rnd(9) ? rnd(500) - 250 : 'q')]));
      else v = Object.fromEntries(Array.from({ length: rnd(40) }, (_, i) => ['k' + i, rnd(3) ? i : rnd(2) ? 'x' : [i, { a: i }]]));
      let bytes; try { bytes = encode(v, { maxItems: 1 << 20, maxEntries: 1 << 20 }); } catch { continue; }
      if (rnd(4) === 0 && bytes.length > 2) { bytes = Uint8Array.from(bytes); const at = 1 + rnd(bytes.length - 1); bytes[at] = rnd(3) ? bytes[at] ^ (1 << rnd(8)) : choose([0xff, 0x18, 0x5b, 0x7f, 0x61]); }
      if (rnd(5) === 0) bytes = bytes.subarray(0, rnd(bytes.length + 1));
      const lim = LIM(1, 0, -1, -1, -1, rnd(4) ? -1 : rnd(200), -1, rnd(3) ? -1 : rnd(3000));
      cases.push({ prog: pi, rule: c.rules.indexOf('r'), lim, bytes, label: `stress: ${text} #${k}`, check: () => null });
    }
  }
}

// ---------------------------------------------------------------- 3b. extension controls (P7.2)
const extStart = cases.length;
addExtCases({ compile, encode, addProgram, LIM, cases, seed: SEED });
const nExt = cases.length - extStart;

// ---------------------------------------------------------------- 4. assembled
const asmStart = cases.length;
for (const a of assembledCases()) {
  const pi = a.prog !== undefined ? a.prog : (a.prog = addProgram(a.P, a.B, a.label));
  for (const k of a.cases) cases.push({ prog: pi, rule: k.rule ?? 0, lim: [...(k.lim ?? LIM(1, 0)).slice(0, 8), 0], bytes: k.bytes, span: k.span, label: `${a.label}: ${k.label ?? hex(k.bytes).slice(0, 40)}`, check: k.check });
}
const nAsm = cases.length - asmStart;
return { programs, cases, sc, corpus, diff, nAsm, asmStart, nIdentity, nExt };
}
