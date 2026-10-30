// bb vm-test: the validator VM (P3.4) on generated JS and a DEBUG Rust build.
//
//     node kin/scripts/vm-test.mjs <rust-vm-binary> [mutations] [seed]
//
// Sections (each prints ok/FAIL):
//   1. program.md §15: the worked Program (transcribed from the document) and
//      its worked executions give exactly the document's out words; the
//      compiler's Program for the same schema is bit-identical to it.
//   2. Profile identity: the VM against `any` gives the scanner's code, error
//      offset and item count on every scan-test input (vectors, fixed edge
//      cases, seeded mutations under random options).
//   3. Conformance: every case of corpus/conformance/{study,adversarial}.json
//      whose schema compiles has the expected verdict. Suites marked
//      schemaError / snugSchemaError are compile-refusal checks, not VM cases
//      (counted separately); phase "later" suites are skipped as the corpus says.
//   4. Assembled programs (kin/scripts/vm-cases.mjs): hand-shaped Programs and
//      inputs with expected reason/path/offset, incl. hostile ones.
//   5. JS == Rust on every case: the whole out array (verdict, reason,
//      subcode, offset, budget used, items, path), no panic; JS re-run on a
//      sample behind throwing out-of-bounds traps on P, B, input and scratch.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compile } from '../../host/js/src/compile.mjs';
import { vmVerify } from '../../gen/js/snug/program/verify.mjs';
import { vmScratchWords, vmScratchWordsSlow, vmScratchInit, vmValidate, vmValidateSpan } from '../../gen/js/snug/vm/api.mjs';
import { scan, scanOptions, errorOffset, itemsScanned, codeName } from '../../gen/js/snug/cbor/scan.mjs';
import { buildCases, hex } from './scan-cases.mjs';
import { EXAMPLE_P, EXAMPLE_B } from './vm-example.mjs';
import { assembledCases } from './vm-cases.mjs';
import { Program as HostProgram } from '../../host/js/src/schema.mjs';
import { encode, decode } from '../../bench/baseline/cbor-3sln.mjs';
import { compile as oracleCompile, check as oracleCheck } from '../../corpus/tools/oracle.mjs';
import { oracleSchemas } from './vm-oracle-gen.mjs';

const [rustBin, mutArg, seedArg, schemaArg] = process.argv.slice(2);
const MUTATIONS = Number(mutArg ?? 20000), SEED = Number(seedArg ?? 1), SCHEMAS = Number(schemaArg ?? 400);
let fails = 0;
const fail = msg => { if (fails < 60) console.log('  FAIL ' + msg); fails++; };
const unhex = h => Uint8Array.from(Buffer.from(h, 'hex'));

// ---------------------------------------------------------------- programs and the JS runner
export const programs = [];     // {P, B, label}
const cases = [];               // {prog, rule, lim, bytes, label, check(out) -> string|null, span?}
function addProgram(P, B, label) {
  const S = new Int32Array(48 + 2 * Math.max(P[16], 1) + 64); S[16] = 1; S[17] = Math.max(P[16], 1);
  const v = vmVerify(P, B, S);
  if (v !== 0) fail(`${label}: vm-verify refused the Program (word ${S[35]}, check ${S[36]})`);
  for (let r = 0; r < P[15]; r++) for (const m of [0, P[16] + 5]) if (vmScratchWords(P, r, m) !== vmScratchWordsSlow(P, r, m)) fail(`${label}: scratch words of rule ${r} differ from the chain formula`);
  programs.push({ P, B, label });
  return programs.length - 1;
}
let scratch = new Int32Array(0), markCap = 0;
const out = new Int32Array(8 + 2 * 257);
function runJs(c, trap = false, generic = false) {
  const { P, B } = programs[c.prog];
  const cap = Math.max(markCap, P[16]);
  const need = vmScratchWords(P, c.rule, cap);
  if (cap > markCap || need > scratch.length) { scratch = new Int32Array(Math.max(need, scratch.length)); markCap = cap; vmScratchInit(scratch, cap); }
  let p = P, b = B, input = c.bytes, s = scratch;
  if (trap) { p = guard(P, 'P'); b = guard(B, 'B'); input = guard(c.bytes, 'input'); s = guard(scratch, 'S'); }
  const lim = Int32Array.from([...c.lim, generic ? 1 : 0]);   // word 8 bit 0: force the generic path (D044)
  const code = c.span
    ? vmValidateSpan(p, b, c.rule, input, c.span[0], c.span[1], c.span[2], c.span[3], lim, s, out)
    : vmValidate(p, b, c.rule, input, lim, s, out);
  if (code < 0) return `ERR ${code}`;
  return Array.from(out.slice(0, 8 + 2 * out[6])).join(' ');
}
// a typed array behind a Proxy that throws on any index outside 0..length-1
function guard(arr, name) {
  return new Proxy(arr, {
    get(t, k) {
      if (typeof k === 'string' && /^-?[0-9]+$/.test(k)) { const i = Number(k); if (i < 0 || i >= t.length) throw new Error(`out-of-bounds read ${name}[${i}] of ${t.length}`); return t[i]; }
      const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) {
      if (typeof k === 'string' && /^-?[0-9]+$/.test(k)) { const i = Number(k); if (i < 0 || i >= t.length) throw new Error(`out-of-bounds write ${name}[${i}] of ${t.length}`); t[i] = v; return true; }
      t[k] = v; return true;
    } });
}
const LIM = (top, cose, mb = -1, md = -1, me = -1, mi = -1, bn = -1, bu = -1) => [top, cose, mb, md, me, mi, bn, bu];

// ---------------------------------------------------------------- 1. §15
const ex = addProgram(EXAMPLE_P, EXAMPLE_B, 'program.md §15');
const want15 = [['a26179816170646b696e646162', '0 0 0 64 6 0 0 0'], ['a1646b696e646161', '33 0 0 47 3 1 1 0 1 0'],
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

// ---------------------------------------------------------------- 4. assembled
const asmStart = cases.length;
for (const a of assembledCases()) {
  const pi = a.prog !== undefined ? a.prog : (a.prog = addProgram(a.P, a.B, a.label));
  for (const k of a.cases) cases.push({ prog: pi, rule: k.rule ?? 0, lim: k.lim ?? LIM(1, 0), bytes: k.bytes, span: k.span, label: `${a.label}: ${k.label ?? hex(k.bytes).slice(0, 40)}`, check: k.check });
}
const nAsm = cases.length - asmStart;

// ---------------------------------------------------------------- run JS
const t0 = performance.now();
const js = cases.map(c => { try { return runJs(c); } catch (e) { return 'THROW ' + e.message; } });
const tJs = performance.now() - t0;
const stats = { identity: [0, 0], corpus: [0, 0], oracle: [0, 0], other: [0, 0] };
cases.forEach((c, i) => {
  const which = c.identity ? 'identity' : c.corpus ? 'corpus' : c.oracle ? 'oracle' : 'other';
  stats[which][1]++;
  const r = js[i].startsWith('THROW') || js[i].startsWith('ERR') ? js[i] : c.check(js[i]);
  if (r) fail(`${c.label}: JS ${r}`); else stats[which][0]++;
});
// fast paths == the generic path (D044): every case again with them off
let genericAgree = 0;
cases.forEach((c, i) => {
  let g; try { g = runJs(c, false, true); } catch (e) { g = 'THROW ' + e.message; }
  if (g === js[i]) genericAgree++; else fail(`${c.label}: fast ${js[i]} | generic ${g}`);
});
// JS bounds: a sample behind traps
let guarded = 0, trapFails = 0;
cases.forEach((c, i) => {
  if (c.bytes.length > 2048 || guarded >= 6000) return;
  if (!(c.corpus || c.oracle || i >= asmStart || i % 7 === 0)) return;
  guarded++;
  try { const g = runJs(c, true); if (g !== js[i]) { trapFails++; fail(`${c.label}: trapped JS ${g} vs ${js[i]}`); } }
  catch (e) { trapFails++; fail(`${c.label} [${hex(c.bytes).slice(0, 60)}]: ${e.message}`); }
});

// epochs: a sample re-run with the scratch's epoch just below EPOCH_MAX, so
// the marks are zeroed and epochs restart mid-validation (§12.1)
let epochRuns = 0, epochFails = 0;
cases.forEach((c, i) => {
  if (i % 11 !== 0 || c.bytes.length > 4096) return;
  runJs(c);   // size the scratch for this program
  scratch[16] = Math.max(scratch[16], 0x7ffffff0 - 3 - (i % 5));   // VM_EPOCH is monotone (§12.1)
  const g = runJs(c);
  epochRuns++;
  if (g !== js[i]) { epochFails++; fail(`${c.label}: near-overflow epoch gives ${g} vs ${js[i]}`); }
});

// ---------------------------------------------------------------- run Rust
let rustLine = '  SKIP Rust (no binary given)', hostLine = '  SKIP hosts';
if (rustBin) {
  const lines = programs.map(p => `prog ${Array.from(p.P).join(',')} ${p.B.length ? hex(p.B) : '-'}`);
  for (const c of cases) {
    const h = c.bytes.length ? hex(c.bytes) : '-';
    lines.push(c.span ? `span ${c.prog} ${c.rule} ${c.span.join(' ')} ${c.lim.join(' ')} ${h}` : `case ${c.prog} ${c.rule} ${c.lim.join(' ')} ${h}`);
  }
  // host-rendering parity: corpus and assembled cases with default limits
  const hostCases = [];
  cases.forEach((c, i) => {
    if (c.span || !(c.corpus || i >= asmStart) || c.lim.slice(2).some(x => x !== -1)) return;
    hostCases.push(i);
    lines.push(`host ${c.prog} ${c.rule} ${c.lim[0] === 0 ? 1 : 0} ${c.lim[1]} ${c.bytes.length ? hex(c.bytes) : '-'}`);
  });
  const t1 = performance.now();
  const p = spawnSync(rustBin, [], { input: lines.join('\n') + '\n', maxBuffer: 1 << 30, encoding: 'utf8' });
  const tRs = performance.now() - t1;
  if (p.status !== 0) fail(`the Rust binary exited ${p.status}: ${p.stderr.slice(0, 400)}`);
  const all = p.stdout.trim().split('\n');
  const rs = all.slice(0, cases.length), hs = all.slice(cases.length);
  if (rs.length !== cases.length) fail(`Rust answered ${rs.length} of ${cases.length} cases`);
  const hostProgs = new Map();
  let hostAgree = 0;
  hostCases.forEach((i, k) => {
    const c = cases[i];
    if (!hostProgs.has(c.prog)) hostProgs.set(c.prog, new HostProgram(programs[c.prog].P, programs[c.prog].B, { verify: vmVerify }));
    const hp = hostProgs.get(c.prog);
    const r = hp.result(hp.run(c.rule, c.bytes, { top: c.lim[0] === 0 ? 'map' : 'any', cose: c.lim[1] === 1 }));
    const t = r.ok ? 'ok' : `${r.reason}|${r.subcode ?? ''}|${r.offset}|${r.path.map(x => typeof x === 'number' ? String(x) : x === '*' || x === '#tag' || x === 'cbor' ? x : JSON.stringify(String(x))).join('/')}`;
    if (t === hs[k]) hostAgree++; else fail(`${c.label}: JS host ${t} | Rust host ${hs[k]}`);
  });
  hostLine = `  ${hostAgree === hostCases.length ? 'ok  ' : 'FAIL'} hosts: JS Schema rendering == Rust snug::schema on ${hostAgree}/${hostCases.length} corpus and assembled cases (reason, subcode, offset, path from the key table)`;
  let agree = 0;
  rs.forEach((line, i) => {
    if (line === 'PANIC') { fail(`${cases[i].label} [${hex(cases[i].bytes).slice(0, 60)}]: Rust PANICKED`); return; }
    if (line !== js[i]) { fail(`${cases[i].label}: JS ${js[i]} | Rust ${line}`); return; }
    agree++;
  });
  rustLine = `  ${agree === cases.length ? 'ok  ' : 'FAIL'} JS == Rust (debug, overflow checks on): ${agree}/${cases.length} cases, whole out array (code, subcode, offset, budget used, items, path), no panic (${(tRs / 1000).toFixed(1)} s)`;
}

// ---------------------------------------------------------------- run wasm
let wasmLine = '  SKIP wasm (SNUG_VM_WASM not set)';
if (process.env.SNUG_VM_WASM) {
  const { instance } = await WebAssembly.instantiate(readFileSync(process.env.SNUG_VM_WASM));
  const ex = instance.exports, mem = ex.memory;
  const cap = ex.snug_cap();
  let loaded = -1, agree = 0, tried = 0;
  cases.forEach((c, i) => {
    if (c.span || c.bytes.length > cap) return;
    if (loaded !== c.prog) {
      const { P, B } = programs[c.prog];
      new Int32Array(mem.buffer, ex.snug_prog_buf(), P.length).set(P);
      new Uint8Array(mem.buffer, ex.snug_pool_buf(), B.length).set(B);
      if (ex.snug_vm_load(P.length, B.length) !== 0) { fail(`wasm: load ${programs[c.prog].label}`); return; }
      loaded = c.prog;
    }
    tried++;
    new Uint8Array(mem.buffer, ex.snug_buf(), c.bytes.length).set(c.bytes);
    new Int32Array(mem.buffer, ex.snug_lim_buf(), 8).set(c.lim);
    const code = ex.snug_vm_validate(c.bytes.length, c.rule);
    const o = new Int32Array(mem.buffer, ex.snug_out_buf(), 8 + 2 * 257);
    const got = code < 0 ? `ERR ${code}` : Array.from(o.slice(0, 8 + 2 * o[6])).join(' ');
    if (got === js[i]) agree++; else fail(`${c.label}: JS ${js[i]} | wasm ${got}`);
  });
  wasmLine = `  ${agree === tried ? 'ok  ' : 'FAIL'} JS == wasm (release, Rust -> wasm32): ${agree}/${tried} cases, whole out array`;
}

const line = (ok, s) => console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${s}`);
line(stats.identity[0] === stats.identity[1], `profile identity: ${stats.identity[0]}/${stats.identity[1]} runs give the scanner's code, offset and items, through the VM against \`any\` and against a schema that keeps everything live (${sc.nVectors} vectors, ${sc.nFixed} fixed, ${MUTATIONS} mutations seed ${SEED})`);
line(stats.corpus[0] === stats.corpus[1], `conformance: ${stats.corpus[0]}/${stats.corpus[1]} cases with the expected verdict, from ${corpus.compiled} compiled suites of ${corpus.suites} (${corpus.later} phase-later skipped)`);
console.log(`  info refusal suites: ${corpus.refusedOk} refused by the compiler as expected; ${corpus.refusedNot.length} compiled anyway (compiler's gate)`);
if (corpus.notCompiled.length) { console.log(`  info ${corpus.notCompiled.length} suites did not compile (not VM cases):`); for (const s of corpus.notCompiled.slice(0, 40)) console.log('       ' + s); }
line(stats.oracle[0] === stats.oracle[1], `oracle differential (D022): ${stats.oracle[0]}/${stats.oracle[1]} values agree with corpus/tools/oracle.mjs on ${diff.compiled} compiled schemas of ${diff.schemas} generated (seed ${SEED}); ${diff.unknown} oracle-unknown skipped`);
console.log(`  info compiler refused ${diff.refused} generated schemas: ${Object.entries(diff.refusals).map(([k, v]) => `${k} ${v}`).join(', ')}; oracle refused ${diff.oracleRefused}`);
line(stats.other[0] === stats.other[1], `§15 and assembled programs: ${stats.other[0]}/${stats.other[1]} cases (${nAsm} assembled)`);
line(genericAgree === cases.length, `fast paths == generic path (D044): ${genericAgree}/${cases.length} cases give the same whole out array with the fast paths forced off`);
line(epochFails === 0, `epochs: ${epochRuns} cases re-run from an epoch just below the restart threshold give the same out array`);
line(trapFails === 0, `JS bounds: ${guarded} cases re-run behind throwing out-of-bounds traps on P, B, input and scratch`);
console.log(rustLine);
console.log(hostLine);
console.log(wasmLine);
console.log(`  info ${programs.length} programs verified by vm-verify; JS ran ${cases.length} cases in ${(tJs / 1000).toFixed(1)} s`);
if (fails) { console.log(`  FAIL ${fails} failure(s)`); process.exit(1); }
console.log('  ok   vm-test');
