// bb vm-test's cases (sections 1-4 of kin/scripts/vm-test.mjs), shared with
// bb vmsession-test (P6.2), which runs every one of them through the resumable
// session as well. Building them is deterministic in (MUTATIONS, SEED, SCHEMAS).
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compile } from '../../host/js/src/compile.mjs';
import { vmVerify, vmVerifyWords } from '../../gen/js/snug/program/verify.mjs';
import { vmScratchWords, vmScratchWordsSlow, vmScratchInit, vmValidate, vmValidateSpan } from '../../gen/js/snug/vm/api.mjs';
import { scanCb, scanOptions, scanProfile, errorOffset, itemsScanned, codeName } from '../../gen/js/snug/cbor/scan.mjs';
import { buildDetCases, optWords } from './det-cases.mjs';
import { buildCases, hex } from './scan-cases.mjs';
import { assembledCases } from './vm-cases.mjs';
import { Program as HostProgram } from '../../host/js/src/schema.mjs';
import { encode, decode } from '../../bench/baseline/cbor-3sln.mjs';
import { compile as pegCompile, check as pegCheck, decode as pegDecode } from '../../corpus/tools/peg-oracle.mjs';
import { pegSchemas } from './vm-peg-gen.mjs';
import { addExtCases } from './ext-cases.mjs';

export const unhex = h => Uint8Array.from(Buffer.from(h, 'hex'));
// limits words (program.md §12.3): 0..7, word 8 the VM's generic/schedule bits, word 9 the profile flags (D120)
export const LIM = (top, cose, mb = -1, md = -1, me = -1, mi = -1, bn = -1, bu = -1, pf = 0) => [top, cose, mb, md, me, mi, bn, bu, 0, pf];

/** Every vm-test case: {programs: [{P, B, label}], cases: [{prog, rule, lim, bytes, label, check, span?, identity?, corpus?, oracle?}], ...}. */
export function buildVmCases({ MUTATIONS, SEED, SCHEMAS, fail, valid = false }) {
const programs = [];     // {P, B, label}
const cases = [];        // {prog, rule, lim, bytes, label, check(out) -> string|null, span?}
function addProgram(P, B, label) {
  // format 2.0 (P8.5): the verifier's marks and its PEG working area (vm-verify-words)
  const m0 = Math.max(P[16], 1);
  const S = new Int32Array(Math.max(48 + 2 * m0 + 64, vmVerifyWords(P, m0) + 16)); S[16] = 1; S[17] = m0;
  const v = vmVerify(P, B, S);
  if (v !== 0) fail(`${label}: vm-verify refused the Program (word ${S[35]}, check ${S[36]})`);
  for (let r = 0; r < P[15]; r++) for (const m of [0, P[16] + 5]) if (vmScratchWords(P, r, m) !== vmScratchWordsSlow(P, r, m)) fail(`${label}: scratch words of rule ${r} differ from the chain formula`);
  programs.push({ P, B, label });
  return programs.length - 1;
}

// ---------------------------------------------------------------- 1. program-2 §12's worked examples
// (format 1's program.md §15 Program and its out words were retired with format 1, P8.5:
// its group choice `{kind: "a", x: int // kind: "b", ? y: [* tstr]}` now fails the
// document under the default literal RFC cut, D301, as the guide documents)
const W12 = [
  // [rule text, options, hex, expected out-word prefix or check]
  ['r = [* uint, uint]', {}, '8101', o => o.startsWith('33 0 0 ') && o.endsWith(' 1 1 0 0 1') ? null : `want missing [1], got ${o}`],
  ['r = {? (a: int, b: int), * tstr => any}', { cuts: 'branch' }, 'a1616101', o => o.startsWith('0 ') ? null : `want valid (rule A), got ${o}`],
  ['r = {? (a: int, b: int), * tstr => any}', {}, 'a1616101', o => /^33 0 0 \d+ \d+ 1 1 0 1 \d+$/.test(o) ? null : `want missing b (rfc), got ${o}`],
  ['r = {? (a: int, b: int), * tstr => any}', { cuts: 'branch' }, 'a161616178', o => /^35 46 0 \d+ \d+ 1 1 0 1 \d+$/.test(o) ? null : `want value (subcode cut, D342) at a (rule A), got ${o}`],
  ['r = {kind: "a", x: int // kind: "b", y: tstr}', {}, 'a26179617a646b696e646162', o => o.startsWith('35 ') ? null : `want the RFC cut's value at kind, got ${o}`],
  ['r = {kind: "a", x: int // kind: "b", y: tstr}', { cuts: 'branch' }, 'a26179617a646b696e646162', o => o.startsWith('0 ') ? null : `want valid (rule A), got ${o}`],
];
for (const [text, opts, h, check] of W12) {
  const c = compile(text, opts);
  const pi = addProgram(c.program, c.pool, `program-2 §12: ${text} ${JSON.stringify(opts)}`);
  cases.push({ prog: pi, rule: c.rules.indexOf('r'), lim: LIM(1, 0), bytes: unhex(h), label: `program-2 §12 ${text} ${opts.cuts ?? 'rfc'} ${h}`, check });
}

// ---------------------------------------------------------------- 2. profile identity
const anyC = compile('r = any', { limits: { depth: 256, inputBytes: 0x7fffffff, entries: 1 << 24, items: 1 << 24, budget: 0x7fffffff } });
const anyP = addProgram(anyC.program, anyC.pool, 'any');
const sc = buildCases(MUTATIONS, SEED);
// The scanner with its scratch and canonical buffer (P8.4, D264), grown on CODE_SCRATCH (22).
let o16 = new Int32Array(16 + 64), scb = new Uint8Array(64);
function scan(bytes, o) {
  for (;;) {
    const c = scanCb(bytes, o16, scb);
    if (c !== 22) return c;
    const keep = o16.slice(0, 16);
    if (o16[13] > o16.length) { o16 = new Int32Array(Math.max(o16[13], 2 * o16.length)); o16.set(keep); }
    if (o16[14] > scb.length) scb = new Uint8Array(Math.max(o16[14], 2 * scb.length));
  }
}
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
// shapes live (any keys, the standard tags, tags of any number (D180, live content for some, 64-bit ones too, `#6`
// for the rest), undefined, the unassigned simple values (D284), every float), limits word 9 = the flags: the scanner's code,
// offset and item count under the same flags.
const LIVE2 = `r = v
v = [* v] / { * any => v } / int / integer / float / tstr / bstr / bool / null / undefined /
    tdate / time / eb64url / eb64legacy / eb16 / encoded-cbor / uri / cbor-any /
    #6.24(bytes .cbor v) / #6.4([int, integer]) / #6.40([[* uint], [* v] / typed]) / typed / bstr .cbor v /
    float16 .ge 0.0 / (-1.0 .. 1.0) / (1.5 .. 100000.0) /
    #6.5(v) / #6.18(v) / #6.61(v) / #6.1000(v) / #6.65(bstr) / #6.4294967294(v) / #6.4294967296(v) /
    #6.18446744073709551614(v) / #6 / simple
; D284: every unassigned simple value
simple = ${[...Array(256).keys()].filter(n => n < 20 || n > 31).map(n => `#7.${n}`).join(' / ')}
typed = #6.69(bstr) / #6.70(bstr) / #6.71(bstr) / #6.72(bstr) / #6.77(bstr) / #6.78(bstr) /
        #6.79(bstr) / #6.84(bstr) / #6.85(bstr) / #6.86(bstr)`;
const live2C = compile(LIVE2, { limits: { depth: 256, inputBytes: 0x7fffffff, entries: 1 << 24, items: 1 << 24, budget: 0x7fffffff, width: 1024 } });
const live2P = addProgram(live2C.program, live2C.pool, 'live profile options');
const live2Rule = live2C.rules.indexOf('r');
const dc = buildDetCases(Math.max(1500, Math.round(MUTATIONS / 2)), SEED, { valid });
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
const corpusOracle = [];
for (const file of ['study', 'adversarial', 'audit-2026-11-04', 'numbers', 'heads', 'regressions']) {
  const j = JSON.parse(readFileSync(new URL(`../../corpus/conformance/${file}.json`, import.meta.url)));
  for (const su of j.suites) {
    corpus.suites++;
    if (su.phase === 'later') { corpus.later++; continue; }
    const text = su.cddl ?? readFileSync(new URL(`../../corpus/${su.cddlFile}`, import.meta.url), 'utf8');
    let c = null, err = null;
    const copt = su.options?.cuts ? { cuts: su.options.cuts } : {};
    try { c = compile(text, copt); } catch (e) { err = e; }
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
      cases.push({ prog: pi, rule, lim: LIM(1, opt.cose ? 1 : 0, -1, -1, -1, opt.maxItems ?? -1, -1, -1, opt.wire === 'deterministic' ? 122 : opt.wire === 'valid' ? 378 : 0), bytes: unhex(k.hex),
        label: `${file}: ${su.name} [${k.hex.slice(0, 40)}]`, corpus: true,
        check: o => { const ok = o.split(' ')[0] === '0'; return ok === k.expect ? null : `verdict ${ok}, expected ${k.expect} (out ${o})`; } });
      // the PEG oracle in both cut modes (P8.5, D279): the same suite's Program in each mode,
      // the oracle's verdict where it has one (its own profile-free decoder: only where the
      // corpus case is valid CBOR under the case's profile do the two agree by construction)
      corpusOracle.push({ file, su, k, text, opt });
    }
  }
}

// ---------------------------------------------------------------- 3b. the PEG oracle differential (P8.5, D279)
// generated schemas (kin/scripts/vm-peg-gen.mjs) and the corpus, in both cut modes:
// the VM's verdict == corpus/tools/peg-oracle.mjs's wherever the oracle decides. Values
// are deterministic encodings (the deterministic preset) or, a third of them, maps with
// their pairs in any order (the valid preset: the canonical path and T's sort).
const diff = { schemas: 0, compiled: 0, refused: 0, oracleRefused: 0, unknown: 0, cases: 0, refusals: {}, corpus: 0, corpusUnknown: 0 };
const progCache = new Map();
function progFor(text, cuts, label) {
  const key = cuts + '\u0000' + text;
  if (progCache.has(key)) return progCache.get(key);
  let c = null;
  try { c = compile(text, { cuts }); } catch (e) { diff.refused++; diff.refusals[e.code ?? e.message] = (diff.refusals[e.code ?? e.message] ?? 0) + 1; }
  const r = c ? { pi: addProgram(c.program, c.pool, label), rules: c.rules } : null;
  progCache.set(key, r);
  return r;
}
for (const { cddl, values } of pegSchemas(SCHEMAS, 8, SEED * 7919 + 1)) {
  diff.schemas++;
  const os = pegCompile(cddl);
  if (os.error) { diff.oracleRefused++; continue; }
  for (const cuts of ['rfc', 'branch']) {
    const pr = progFor(cddl, cuts, `peg oracle (${cuts}): ${cddl}`);
    if (!pr) continue;
    if (cuts === 'rfc') diff.compiled++;
    for (const { bytes, shuffled } of values) {
      let want;
      try { want = pegCheck(os, 'r', pegDecode(bytes), { cuts, steps: 200000 }); } catch { want = 'unknown'; }
      if (want === 'unknown') { diff.unknown++; continue; }
      diff.cases++;
      cases.push({ prog: pr.pi, rule: pr.rules.indexOf('r'), lim: LIM(1, 0, -1, -1, -1, -1, -1, -1, shuffled ? 378 : 122), bytes,
        label: `peg oracle (${cuts}): ${cddl.replace(/\n/g, '; ')} [${hex(bytes).slice(0, 40)}]`, oracle: true,
        check: o => { const ok = o.split(' ')[0] === '0'; return ok === want ? null : `VM ${ok}, oracle ${want} (out ${o})`; } });
    }
  }
}
for (const { file, su, k, text, opt } of corpusOracle) {
  if (opt.cose || opt.wire === 'deterministic' || opt.maxItems !== undefined) continue;
  const os = pegCompile(text);
  if (os.error) continue;
  for (const cuts of ['rfc', 'branch']) {
    let want;
    try { want = pegCheck(os, k.rule, pegDecode(unhex(k.hex)), { cuts, steps: 200000 }); } catch { want = 'unknown'; }
    if (want === 'unknown') { diff.corpusUnknown++; continue; }
    const pr = progFor(text, cuts, `corpus (${cuts}): ${file}: ${su.name}`);
    if (!pr) continue;
    const rule = pr.rules.indexOf(k.rule);
    if (rule < 0) continue;
    diff.corpus++;
    // the valid preset: the oracle decodes any valid CBOR with any keys and no Bindle rules
    cases.push({ prog: pr.pi, rule, lim: LIM(1, 0, -1, -1, -1, -1, -1, -1, 378), bytes: unhex(k.hex),
      label: `corpus vs peg oracle (${cuts}): ${file}: ${su.name} [${k.hex.slice(0, 40)}]`, oracle: true,
      check: o => { const w = o.split(' '); const ok = w[0] === '0';
        // a profile refusal the oracle's decoder does not make (an application tag rule, a simple value) is not a group verdict
        if (!ok && Number(w[0]) < 32) return null;
        return ok === want ? null : `VM ${ok}, oracle ${want} (out ${o})`; } });
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

// ---------------------------------------------------------------- 3d. the group arena (P8.5, program-2 §9.4)
// A2 arrays, T maps (sorted under the valid preset), recursion (chunks): inputs that outgrow the
// default lease (the buffer route grows S and runs again, the session suspends with VMS_GROW),
// and explicit arena limits (limits word 10) at and around each push: `group_limit` (44), or
// the verdict. JS == Rust == session (bb vmsession-test) hold them to one schedule.
{
  let st = (SEED * 40503) >>> 0 || 1;
  const rnd = n => { st ^= st << 13; st ^= st >>> 17; st ^= st << 5; return (st >>> 0) % n; };
  const enc = v => Uint8Array.from((function e(x) {
    const h = (m, n) => n < 24 ? [m * 32 + n] : n < 256 ? [m * 32 + 24, n] : n < 65536 ? [m * 32 + 25, n >> 8, n & 255] : [m * 32 + 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
    if (typeof x === 'number') return x < 0 ? h(1, -1 - x) : h(0, x);
    if (typeof x === 'string') { const b = [...new TextEncoder().encode(x)]; return h(3, b.length).concat(b); }
    if (Array.isArray(x)) return h(4, x.length).concat(...x.map(e));
    const pairs = [...x.entries()];
    return h(5, pairs.length).concat(...pairs.map(([k, v]) => e(k).concat(e(v))));
  })(v));
  const shapes = [
    ['r = { * (int => int // tstr => tstr) }', n => new Map(Array.from({ length: n }, (_, i) => (i % 3 ? [i, i] : ['k' + i, 'v'])))],
    ['r = { int => int, int => 6, * int => any }', n => new Map(Array.from({ length: n }, (_, i) => [i, i % 7 === 0 ? 6 : i]))],
    ['r = [ (* int, tstr) // (* int) ]', n => [...Array.from({ length: n }, (_, i) => i), ...(n % 2 ? ['t'] : [])]],
    ['r = [ g ]\ng = (uint, ? g)', n => Array.from({ length: n }, (_, i) => i)],
    ['r = [ g ]\ng = (uint, ? g, tstr)', n => [...Array.from({ length: n }, (_, i) => i), ...Array.from({ length: n - (n % 3 === 0 ? 1 : 0) }, () => 's')]],
    ['r = [* { * (int => int // tstr => tstr) }]', n => Array.from({ length: Math.max(1, n >> 4) }, (_, j) => new Map(Array.from({ length: 16 }, (_, i) => [i + j, i])))],
  ];
  for (const [text, gen] of shapes) {
    const c = compile(text, { limits: { items: 1 << 20, entries: 1 << 20, depth: 256 } });
    const pi = addProgram(c.program, c.pool, `arena: ${text}`);
    const rule = c.rules.indexOf('r');
    for (const n of [0, 1, 5, 40, 700, 3000]) {
      let v = gen(n);
      if (v instanceof Map && rnd(2)) v = new Map([...v.entries()].reverse());   // unsorted keys: the valid preset's T sort
      const bytes = enc(v);
      for (const gw of [-1, 0, 3, 17, 64, 300, 4096]) {
        cases.push({ prog: pi, rule, lim: [...LIM(1, 0, -1, -1, -1, -1, -1, -1, 378), gw], bytes, label: `arena: ${text} n ${n} groupWords ${gw}`,
          check: o => { const w = o.split(' '); return (w[0] === '0' || Number(w[0]) >= 32) ? null : `unexpected profile code ${o}`; } });
      }
    }
  }
}

// ---------------------------------------------------------------- 3e. large T maps (D323)
// Valid maps of 1k-30k pairs whose PEG program makes them T (a choice of non-literal
// members under a REP), table / mixed / struct shapes, both cut modes, keys in order and
// reversed (the valid preset's T sort): each must be accepted, a 3,000-pair one within
// the default budget, and the units used must stay below 8 n log2 n (D323: the
// non-literal members' cursors; before them a 3,000-pair table cost 9.1 M units).
// The oracle confirms the 1,000-pair verdicts in both modes.
const large = { cases: 0, oracle: 0 };
{
  const h = (m, n) => n < 24 ? [m * 32 + n] : n < 256 ? [m * 32 + 24, n] : n < 65536 ? [m * 32 + 25, n >> 8, n & 255] : [m * 32 + 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const item = x => typeof x === 'number' ? h(0, x) : (b => h(3, b.length).concat(b))([...new TextEncoder().encode(x)]);
  const shapes = [
    ['table', 'r = {* (tstr => uint // tstr => tstr)}', i => (i % 2 ? i : 'v'), false],
    ['mixed', 'r = { a: uint, * (tstr => uint // tstr => tstr) }', i => (i % 3 ? i : 'v'), true],
    ['struct', 'r = { ? k00000: uint, * ("t" => uint // tstr => any) }', i => i, false],
  ];
  for (const [name, text, val, withA] of shapes) for (const cuts of ['rfc', 'branch']) for (const n of [1000, 3000, 10000, 30000]) {
    const big = n > 3000;
    const c = compile(text, { cuts, limits: big ? { items: 1 << 20, entries: 1 << 20, budget: 1 << 30 } : { items: 1 << 20, entries: 1 << 20 } });
    const pi = addProgram(c.program, c.pool, `large T map: ${name} ${cuts} n ${n}`);
    const pairs = Array.from({ length: n }, (_, i) => [item(`k${String(i).padStart(5, '0')}`), item(val(i))]);
    if (withA) pairs.push([item('a'), item(1)]);
    pairs.sort((a, b) => { for (let i = 0; i < Math.min(a[0].length, b[0].length); i++) if (a[0][i] !== b[0][i]) return a[0][i] - b[0][i]; return a[0].length - b[0].length; });
    const orders = big ? [((n / 10000) | 0) % 2 ? 'reversed' : 'sorted'] : ['sorted', 'reversed'];
    for (const order of orders) {
      const ps = order === 'reversed' ? [...pairs].reverse() : pairs;
      const bytes = Uint8Array.from([...h(5, ps.length), ...ps.flatMap(([k, v]) => [...k, ...v])]);
      if (n === 1000) {
        const os = pegCompile(text);
        let o; try { o = pegCheck(os, 'r', pegDecode(bytes), { cuts, steps: 1e8 }); } catch { o = 'unknown'; }
        large.oracle++;
        if (o !== true) fail(`large T map ${name} ${cuts} ${order}: the oracle says ${o}`);
      }
      const bound = 8 * n * Math.log2(n);
      large.cases++;
      cases.push({ prog: pi, rule: c.rules.indexOf('r'), lim: [...LIM(1, 0, -1, -1, -1, -1, -1, -1, 378), -1], bytes, label: `large T map: ${name} ${cuts} ${order} n ${n}`,
        check: o => { const w = o.split(' '); if (w[0] !== '0') return `refused: ${o.slice(0, 40)}`; return Number(w[3]) <= bound ? null : `units ${w[3]} > 8 n log2 n = ${bound | 0}`; } });
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
return { programs, cases, sc, corpus, diff, nAsm, asmStart, nIdentity, nExt, large };
}
