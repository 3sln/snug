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
import { vmScratchWords, vmScratchWordsSlow, vmScratchInit, vmValidate, vmValidateSpan, vmValidateX, vmValidateSpanX } from '../../gen/js/snug/vm/api.mjs';
import { extFor, testControls } from './ext-cases.mjs';
import { controlEntries } from '../../host/js/src/ext.mjs';
import { scan, scanOptions, errorOffset, itemsScanned, codeName } from '../../gen/js/snug/cbor/scan.mjs';
import { buildCases, hex } from './scan-cases.mjs';
import { EXAMPLE_P, EXAMPLE_B } from './vm-example.mjs';
import { assembledCases } from './vm-cases.mjs';
import { Program as HostProgram } from '../../host/js/src/schema.mjs';
import { encode, decode } from '../../bench/baseline/cbor-3sln.mjs';
import { compile as oracleCompile, check as oracleCheck } from '../../corpus/tools/oracle.mjs';
import { oracleSchemas } from './vm-oracle-gen.mjs';

import { buildVmCases, LIM, unhex } from './vm-allcases.mjs';
const [rustBin, mutArg, seedArg, schemaArg] = process.argv.slice(2);
const MUTATIONS = Number(mutArg ?? 20000), SEED = Number(seedArg ?? 1), SCHEMAS = Number(schemaArg ?? 400);
let fails = 0;
const fail = msg => { if (fails < 60) console.log('  FAIL ' + msg); fails++; };

// ---------------------------------------------------------------- programs and the JS runner
const { programs, cases, sc, corpus, diff, nAsm, asmStart, nExt } = buildVmCases({ MUTATIONS, SEED, SCHEMAS, fail });
let scratch = new Int32Array(0), markCap = 0;
const out = new Int32Array(8 + 2 * 257);
function runJs(c, trap = false, generic = false, s1 = false) {
  const { P, B } = programs[c.prog];
  const cap = Math.max(markCap, P[16]);
  const need = vmScratchWords(P, c.rule, cap);
  if (cap > markCap || need > scratch.length) { scratch = new Int32Array(Math.max(need, scratch.length)); markCap = cap; vmScratchInit(scratch, cap); }
  let p = P, b = B, input = c.bytes, s = scratch;
  if (trap) { p = guard(P, 'P'); b = guard(B, 'B'); input = guard(c.bytes, 'input'); s = guard(scratch, 'S'); }
  const lim = Int32Array.from([...c.lim.slice(0, 8), (c.lim[8] ?? 0) | (generic ? 1 : 0) | (s1 ? 2 : 0), c.lim[9] ?? 0]);   // word 8: bit 0 generic (D044), bit 1 legacy schedule 1 (schedule 2, D045, is the default); word 9: the profile flags (D120)
  const x = extFor(P, B);   // P7.2: a Program using extension controls gets the test registry's predicates
  const code = x
    ? (c.span ? vmValidateSpanX(p, b, c.rule, input, c.span[0], c.span[1], c.span[2], c.span[3], lim, s, out, x)
      : vmValidateX(p, b, c.rule, input, lim, s, out, x))
    : c.span
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
// legacy schedule 1 (limits word 8 bit 1; schedule 2, D045, is the default):
// fast == generic exactly; and it changes nothing but the budget used (every other out word equal unless a run hit the budget)
let s2Agree = 0, s2Same = 0;
const js2 = cases.map(c => { try { return runJs(c, false, false, true); } catch (e) { return 'THROW ' + e.message; } });
cases.forEach((c, i) => {
  let g; try { g = runJs(c, false, true, true); } catch (e) { g = 'THROW ' + e.message; }
  if (g === js2[i]) s2Agree++; else fail(`${c.label}: schedule 1 fast ${js2[i]} | generic ${g}`);
  const a = js[i].split(' '), b = js2[i].split(' ');
  if (a[0] === '48' || b[0] === '48' || (a.length === b.length && a.every((x, k) => k === 3 || x === b[k]))) s2Same++;
  else fail(`${c.label}: schedule 1 changed more than the budget: ${js[i]} | ${js2[i]}`);
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
let rustLine = '  SKIP Rust (no binary given)', hostLine = '  SKIP hosts', rust2Line = '  SKIP schedule 1 Rust';
if (rustBin) {
  const lines = programs.map(p => `prog ${Array.from(p.P).join(',')} ${p.B.length ? hex(p.B) : '-'}`);
  const caseLine = (c, w8) => {
    const h = c.bytes.length ? hex(c.bytes) : '-';
    const l = [...c.lim.slice(0, 8), w8, c.lim[9] ?? 0].join(' ');
    return c.span ? `span ${c.prog} ${c.rule} ${c.span.join(' ')} ${l} ${h}` : `case ${c.prog} ${c.rule} ${l} ${h}`;
  };
  for (const c of cases) lines.push(caseLine(c, 0));
  for (const c of cases) lines.push(caseLine(c, 2));
  // host-rendering parity: corpus and assembled cases with default limits
  const hostCases = [];
  cases.forEach((c, i) => {
    if (c.span || !(c.corpus || c.ext || i >= asmStart) || c.lim.slice(2, 8).some(x => x !== -1) || (c.lim[9] ?? 0) !== 0) return;
    hostCases.push(i);
    lines.push(`host ${c.prog} ${c.rule} ${c.lim[0] === 0 ? 1 : 0} ${c.lim[1]} ${c.bytes.length ? hex(c.bytes) : '-'}`);
  });
  const t1 = performance.now();
  const p = spawnSync(rustBin, [], { input: lines.join('\n') + '\n', maxBuffer: 1 << 30, encoding: 'utf8' });
  const tRs = performance.now() - t1;
  if (p.status !== 0) fail(`the Rust binary exited ${p.status}: ${p.stderr.slice(0, 400)}`);
  const all = p.stdout.trim().split('\n');
  const rs = all.slice(0, cases.length), rs2 = all.slice(cases.length, 2 * cases.length), hs = all.slice(2 * cases.length);
  let agree2 = 0;
  rs2.forEach((line, i) => { if (line === js2[i]) agree2++; else fail(`${cases[i].label}: schedule 1 JS ${js2[i]} | Rust ${line}`); });
  rust2Line = `  ${agree2 === cases.length ? 'ok  ' : 'FAIL'} schedule 1 (legacy) JS == Rust: ${agree2}/${cases.length} cases`;
  if (all.length !== 2 * cases.length + hostCases.length) fail(`Rust answered ${all.length} lines, expected ${2 * cases.length + hostCases.length}`);
  const hostProgs = new Map();
  let hostAgree = 0;
  hostCases.forEach((i, k) => {
    const c = cases[i];
    if (!hostProgs.has(c.prog)) hostProgs.set(c.prog, new HostProgram(programs[c.prog].P, programs[c.prog].B, { verify: vmVerify, controls: controlEntries(testControls) }));
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
    // the wasm shim has no extension-control port (P7.2 open item): EXT Programs are not run there
    if (c.span || c.ext || c.bytes.length > cap) return;
    if (loaded !== c.prog) {
      const { P, B } = programs[c.prog];
      new Int32Array(mem.buffer, ex.snug_prog_buf(), P.length).set(P);
      new Uint8Array(mem.buffer, ex.snug_pool_buf(), B.length).set(B);
      if (ex.snug_vm_load(P.length, B.length) !== 0) { fail(`wasm: load ${programs[c.prog].label}`); return; }
      loaded = c.prog;
    }
    tried++;
    new Uint8Array(mem.buffer, ex.snug_buf(), c.bytes.length).set(c.bytes);
    new Int32Array(mem.buffer, ex.snug_lim_buf(), 10).set([...c.lim.slice(0, 8), 0, c.lim[9] ?? 0]);
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
line(stats.other[0] === stats.other[1], `§15, assembled and extension-control programs: ${stats.other[0]}/${stats.other[1]} cases (${nAsm} assembled, ${nExt} extension-control cases incl. ${cases.filter(c => c.ext && c.label.includes('fixed')).length} with fixed verdicts; they run in every section below except wasm)`);
line(genericAgree === cases.length, `fast paths == generic path (D044): ${genericAgree}/${cases.length} cases give the same whole out array with the fast paths forced off`);
line(s2Agree === cases.length, `legacy schedule 1 (word 8 bit 1): fast == generic on ${s2Agree}/${cases.length} cases`);
line(s2Same === cases.length, `schedule 1 vs the default schedule 2 (D045) changes only the budget used on ${s2Same}/${cases.length} cases (verdict, reason, offset, items, path equal unless either run hit the budget)`);
line(epochFails === 0, `epochs: ${epochRuns} cases re-run from an epoch just below the restart threshold give the same out array`);
line(trapFails === 0, `JS bounds: ${guarded} cases re-run behind throwing out-of-bounds traps on P, B, input and scratch`);
console.log(rustLine);
console.log(rust2Line);
console.log(hostLine);
console.log(wasmLine);
console.log(`  info ${programs.length} programs verified by vm-verify; JS ran ${cases.length} cases in ${(tJs / 1000).toFixed(1)} s`);
if (fails) { console.log(`  FAIL ${fails} failure(s)`); process.exit(1); }
console.log('  ok   vm-test');
