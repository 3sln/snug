// bb vmsession-test: the resumable session (P6.2) against the buffer driver --
// the D030 condition. Every vm-test case (corpus, oracle generator, mutations,
// fast-path stress, assembled; validateAt span cases excepted: a session is a
// whole message) and a session stress set (kin/scripts/vmsession-cases.mjs)
// must give vm-validate's ENTIRE out array (code, subcode, offset, budget
// used, items, path) under:
//   * whole windows (no quantum), 1-byte windows, random windows of 1..7 /
//     1..300 / 1..4096 bytes, whole windows under tiny quanta (1-3 units);
//   * a split at every offset for inputs of at most 48 bytes;
//   * random budgets that stop it part-way (stress set: three per case under
//     two policies; vm-test cases: a sample), the generic path forced and
//     the legacy schedule 1 (samples);
// with the windows starting EXACTLY where asked (fresh copies), vms-keep never
// past a need nor going back, no step answering a range it was given;
// JS behind throwing out-of-bounds traps on P, B, the window and every
// session array (a sample); sessions interleaved step by step on one Program;
// and the debug Rust build giving JS's answers, without a panic.
//
//     node kin/scripts/vmsession-test.mjs <rust-vmsession-binary> [mutations] [seed] [schemas] [stress]
import { spawnSync } from 'node:child_process';
import { compile } from '../../host/js/src/compile.mjs';
import { vmScratchWords, vmScratchInit, vmValidateV } from '../../gen/js/snug/vm/api.mjs';
import { extFor, testControls } from './ext-cases.mjs';
import { controlEntries } from '../../host/js/src/ext.mjs';
import { buildVmCases } from './vm-allcases.mjs';
import { sessionCases } from './vmsession-cases.mjs';
import { runSession, sessionSteps, runUnknown } from './vmsession-run.mjs';
import { hex } from './scan-cases.mjs';
import { Program as HostProgram, Schema as HostSchema } from '../../host/js/src/schema.mjs';
import { validateHandleSync, bufferHandle } from '../../host/js/src/sources.mjs';
import { vmVerify, vmVerifyWords } from '../../gen/js/snug/program/verify.mjs';

const [rustBin, mutArg, seedArg, schemaArg, stressArg] = process.argv.slice(2);
const MUTATIONS = Number(mutArg ?? 20000), SEED = Number(seedArg ?? 1), SCHEMAS = Number(schemaArg ?? 400), STRESS = Number(stressArg ?? 60);
let fails = 0;
const fail = msg => { if (fails < 40) console.log('  FAIL ' + msg); fails++; };

// ---------------------------------------------------------------- cases
const t0 = performance.now();
const { programs, cases: vmCases } = buildVmCases({ MUTATIONS, SEED, SCHEMAS, fail, valid: true });
const cases = vmCases.filter(c => !c.span).map(c => ({ ...c, vm: true }));
const nSpan = vmCases.length - cases.length;
const stressProg = new Map();
for (const c of sessionCases(STRESS, SEED)) {
  if (!stressProg.has(c.cddl)) {
    const k = compile(c.cddl, { limits: { items: 1 << 20, entries: 1 << 20 } });
    programs.push({ P: k.program, B: k.pool, label: c.cddl });
    stressProg.set(c.cddl, { prog: programs.length - 1, rule: k.rules.indexOf('r') });
  }
  const { prog, rule } = stressProg.get(c.cddl);
  cases.push({ prog, rule, lim: c.lim, bytes: c.bytes, label: c.label, stress: true });
}
// fixed cases: a tag-4 pair whose content array passes maxItems, split across windows, under the Bindle tag set with
// keys of any kind (the session's canonical copy planted the array's head and the pair check read the planted byte:
// decimal at 0 where the buffer driver says too_many_items at 1; the 10x run, seed 1005)
{
  const k = compile('r = any', {});
  programs.push({ P: k.program, B: k.pool, label: 'r = any (fixed cases)' });
  const prog = programs.length - 1, rule = k.rules.indexOf('r');
  for (const [h, lim] of [['c48221196ab3', [1, 0, -1, -1, -1, 1, -1, -1, 0, 2]],
    ['a4181845c756adefb3182138fb1827c48221196ab3f97c00fa7fc00000', [1, 0, 36, 4, 5, 7, -1, -1, 0, 2]]])
    cases.push({ prog, rule, lim, bytes: Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16))), label: `fixed ${h.slice(0, 16)}`, stress: true });
}

// ---------------------------------------------------------------- the oracle
const out = new Int32Array(8 + 2 * 257);
let scratch = new Int32Array(0), markCap = 0, bvs = new Int32Array(512), bcb = new Uint8Array(1024);
function buffer(c, lim) {
  const { P, B } = programs[c.prog];
  const cap = Math.max(markCap, P[16], 1);
  const need = vmScratchWords(P, c.rule, cap);
  if (cap > markCap || need > scratch.length) { scratch = new Int32Array(Math.max(need, scratch.length)); markCap = cap; vmScratchInit(scratch, cap); }
  const x = extFor(P, B);
  // the buffer driver with valid-CBOR support (P8.4): its canonical path's buffers grown on -5
  let code;
  for (;;) {
    code = vmValidateV(P, B, c.rule, c.bytes, lim, scratch, out, x || (() => -2), bvs, bcb);
    if (code !== -5) break;
    if (out[5] > bvs.length) bvs = new Int32Array(Math.max(out[5], 2 * bvs.length));
    if (out[6] > bcb.length) bcb = new Uint8Array(Math.max(out[6], 2 * bcb.length));
    if (out[7] > scratch.length) { const g = new Int32Array(out[7]); g.set(scratch); scratch = g; }
  }
  return code < 0 ? `ERR ${code}` : Array.from(out.slice(0, 8 + 2 * out[6])).join(' ');
}
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

// ---------------------------------------------------------------- runs
let st = (SEED * 2654435761) >>> 0 || 1;
const rnd = n => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st % n; };
const runs = [];   // {ci, lim, policy, want, rust}
const counts = { whole: 0, byte: 0, rnd7: 0, rnd300: 0, rnd4096: 0, quanta: 0, split: 0, budget: 0, generic: 0, sched1: 0 };
cases.forEach((c, ci) => {
  const lim0 = Int32Array.from([...c.lim.slice(0, 8), c.lim[8] ?? 0, c.lim[9] ?? 0, c.lim[10] ?? -1]);
  const want0 = buffer(c, lim0);
  const n = c.bytes.length;
  const add = (lim, want, policy, tag, rust) => { runs.push({ ci, lim, want, policy, rust }); counts[tag]++; };
  add(lim0, want0, { kind: 0, w: 0, q: 0, seed: 1, k: 0 }, 'whole', false);
  add(lim0, want0, { kind: 1, w: 1, q: 0, seed: 1, k: 0 }, 'byte', true);
  add(lim0, want0, { kind: 2, w: 7, q: 1 + rnd(3), seed: 1 + rnd(1 << 30), k: 0 }, 'rnd7', true);
  add(lim0, want0, { kind: 2, w: 300, q: 0, seed: 1 + rnd(1 << 30), k: 0 }, 'rnd300', false);
  add(lim0, want0, { kind: 2, w: 4096, q: rnd(4), seed: 1 + rnd(1 << 30), k: 0 }, 'rnd4096', true);
  add(lim0, want0, { kind: 0, w: 0, q: 1 + rnd(3), seed: 1, k: 0 }, 'quanta', true);
  if (n <= 48) for (let k = 1; k < n; k++) add(lim0, want0, { kind: 3, w: 0, q: k % 3 === 0 ? 1 : 0, seed: 1, k }, 'split', n <= 24);
  // budgets stopping part-way
  const nb = c.stress ? 3 : (ci % 5 === 0 ? 1 : 0);
  if (nb > 0) {
    const free = Int32Array.from(lim0); free[7] = -1;
    const full = buffer(c, free).split(' ');
    const used = full[0].startsWith('ERR') ? 0 : Number(full[3]);
    for (let j = 0; j < nb; j++) {
      const lb = Int32Array.from(lim0); lb[7] = rnd(used + 2);
      const wb = buffer(c, lb);
      add(lb, wb, { kind: 2, w: 7, q: rnd(3), seed: 1 + rnd(1 << 30), k: 0 }, 'budget', true);
      if (c.stress) add(lb, wb, { kind: 1, w: 1, q: 0, seed: 1, k: 0 }, 'budget', false);
    }
  }
  if (ci % 7 === 0) { const lg = Int32Array.from(lim0); lg[8] |= 1; add(lg, buffer(c, lg), { kind: 2, w: 5, q: 1, seed: 1 + rnd(1 << 30), k: 0 }, 'generic', true); }
  if (ci % 11 === 0) { const l1 = Int32Array.from(lim0); l1[8] |= 2; add(l1, buffer(c, l1), { kind: 2, w: 9, q: 0, seed: 1 + rnd(1 << 30), k: 0 }, 'sched1', true); }
});

const t1 = performance.now();
const js = runs.map(r => {
  const c = cases[r.ci], { P, B } = programs[c.prog];
  try { const x = runSession(P, B, c.rule, r.lim, c.bytes, r.policy); return x.error ? 'E ' + x.error : x.out; }
  catch (e) { return 'THROW ' + e.message; }
});
const tJs = performance.now() - t1;
let agree = 0;
const desc = r => `${cases[r.ci].label} policy ${JSON.stringify(r.policy)} lim[7]=${r.lim[7]} lim[8]=${r.lim[8]} [${hex(cases[r.ci].bytes).slice(0, 60)}]`;
runs.forEach((r, i) => { if (js[i] === r.want) agree++; else fail(`${desc(r)}: buffer ${r.want} | session ${js[i]}`); });

// JS bounds: a sample behind traps
let guarded = 0, trapFails = 0;
runs.forEach((r, i) => {
  const c = cases[r.ci];
  if (!(i % 9 === 0 && c.bytes.length <= 2048 && r.policy.kind !== 0)) return;
  guarded++;
  const { P, B } = programs[c.prog];
  let g;
  try { const x = runSession(P, B, c.rule, r.lim, c.bytes, r.policy, { guard }); g = x.error ? 'E ' + x.error : x.out; }
  catch (e) { g = 'THROW ' + e.message; }
  if (g !== r.want) { trapFails++; fail(`${desc(r)}: trapped ${g} vs ${r.want}`); }
});

// interleaved sessions on one Program: three at a time, one step each in turn
let inter = 0, interFails = 0;
for (let i = 0; i + 2 < runs.length; i += 3 * 97) {
  const group = [runs[i], runs[i + 1], runs[i + 2]].map(r => ({ ...r, policy: { ...r.policy, kind: 2, w: 5, q: 1 } }));
  if (new Set(group.map(r => cases[r.ci].prog)).size !== 1) continue;
  const its = group.map(r => { const c = cases[r.ci], { P, B } = programs[c.prog]; return sessionSteps(P, B, c.rule, r.lim, c.bytes, r.policy); });
  const res = group.map(() => null);
  let live = 3;
  while (live > 0) for (let k = 0; k < 3; k++) {
    if (res[k] !== null) continue;
    const x = its[k].next();
    if (x.done) { res[k] = x.value.error ? 'E ' + x.value.error : x.value.out; live--; }
  }
  group.forEach((r, k) => { inter++; if (res[k] !== r.want) { interFails++; fail(`${desc(r)}: interleaved ${res[k]} vs ${r.want}`); } });
}

// ---------------------------------------------------------------- unknown length (D085)
// Every case again as a stream whose length the session is never told: drain mode
// must give the buffer's whole out array (code, offset, budget, items, path) under
// random chunking and quanta; fail-fast never accepts what the buffer refuses nor
// refuses what it accepts (only its code may differ, and only when it answers early).
const uruns = [];   // {ci, lim, want, policy, ff, rust}
const ucounts = { whole: 0, byte: 0, rnd7: 0, rnd300: 0, split: 0, budget: 0, failfast: 0 };
cases.forEach((c, ci) => {
  const lim0 = Int32Array.from([...c.lim.slice(0, 8), c.lim[8] ?? 0, c.lim[9] ?? 0, c.lim[10] ?? -1]);
  const want0 = buffer(c, lim0), n = c.bytes.length;
  const add = (lim, want, policy, tag, rust, ff = false) => { uruns.push({ ci, lim, want, policy, ff, rust }); ucounts[tag]++; };
  add(lim0, want0, { kind: 0, w: 0, q: 0, seed: 1, k: 0 }, 'whole', ci % 3 === 0);
  add(lim0, want0, { kind: 1, w: 1, q: 0, seed: 1, k: 0 }, 'byte', ci % 3 === 1);
  add(lim0, want0, { kind: 2, w: 7, q: rnd(3), seed: 1 + rnd(1 << 30), k: 0 }, 'rnd7', ci % 3 === 2);
  add(lim0, want0, { kind: 2, w: 300, q: rnd(2), seed: 1 + rnd(1 << 30), k: 0 }, 'rnd300', false);
  if (n <= 24) for (let k = 1; k < n; k += 1 + rnd(3)) add(lim0, want0, { kind: 3, w: 0, q: 0, seed: 1, k }, 'split', false);
  if (ci % 5 === 0) {
    const free = Int32Array.from(lim0); free[7] = -1;
    const full = buffer(c, free).split(' '), used = full[0].startsWith('ERR') ? 0 : Number(full[3]);
    const lb = Int32Array.from(lim0); lb[7] = rnd(used + 2);
    add(lb, buffer(c, lb), { kind: 2, w: 7, q: rnd(3), seed: 1 + rnd(1 << 30), k: 0 }, 'budget', ci % 10 === 0);
  }
  add(lim0, want0, { kind: 2, w: 9, q: rnd(2), seed: 1 + rnd(1 << 30), k: 0 }, 'failfast', ci % 4 === 0, true);
});
const tU = performance.now();
const ujs = uruns.map(r => {
  const c = cases[r.ci], { P, B } = programs[c.prog];
  try { const x = runUnknown(P, B, c.rule, r.lim, c.bytes, r.policy, { failFast: r.ff }); return x.error ? 'E ' + x.error : x.out; }
  catch (e) { return 'THROW ' + e.message; }
});
const tUjs = performance.now() - tU;
let uagree = 0, ffRuns = 0, ffEarly = 0, ffSameCode = 0, ffBad = 0;
const code0 = o => o.split(' ')[0];
uruns.forEach((r, i) => {
  if (!r.ff) { if (ujs[i] === r.want) uagree++; else fail(`unknown ${desc(r)}: buffer ${r.want} | drain ${ujs[i]}`); return; }
  ffRuns++;
  const g = ujs[i];
  if (g.startsWith('E') || g.startsWith('THROW')) { ffBad++; fail(`fail-fast ${desc(r)}: ${g}`); return; }
  const acceptB = code0(r.want) === '0', acceptF = code0(g) === '0';
  if (acceptB !== acceptF) { ffBad++; fail(`fail-fast ${desc(r)}: buffer ${r.want} | fail-fast ${g}`); return; }
  if (acceptF && g !== r.want) { ffBad++; fail(`fail-fast accepted differently ${desc(r)}: ${g} vs ${r.want}`); return; }
  if (g !== r.want) ffEarly++; else ffSameCode++;
});
// a sample behind traps
let uguarded = 0, utrapFails = 0;
uruns.forEach((r, i) => {
  const c = cases[r.ci];
  if (r.ff || !(i % 11 === 0 && c.bytes.length <= 2048 && r.policy.kind !== 0)) return;
  uguarded++;
  const { P, B } = programs[c.prog];
  let g;
  try { const x = runUnknown(P, B, c.rule, r.lim, c.bytes, r.policy, { guard }); g = x.error ? 'E ' + x.error : x.out; }
  catch (e) { g = 'THROW ' + e.message; }
  if (g !== r.want) { utrapFails++; fail(`unknown ${desc(r)}: trapped ${g} vs ${r.want}`); }
});

// ---------------------------------------------------------------- hosts: JS sources == Rust validate_blob
const hostRuns = [];   // {ci, chunk, quantum, js}
const hostProgs = new Map();
const render = r => r.ok ? 'ok' : `${r.reason}|${r.subcode ?? ''}|${r.offset}|${r.path.map(x => typeof x === 'number' ? String(x) : x === '*' || x === '#tag' || x === 'cbor' ? x : JSON.stringify(String(x))).join('/')}`;
cases.forEach((c, ci) => {
  if (!(c.corpus || c.stress || c.ext) || c.lim.slice(2, 8).some(x => x !== -1) || (c.lim[8] ?? 0) !== 0 || (c.lim[9] ?? 0) !== 0) return;
  if (!hostProgs.has(c.prog)) {
    let hp = null; try { hp = new HostProgram(programs[c.prog].P, programs[c.prog].B, { verify: vmVerify, verifyWords: vmVerifyWords, controls: controlEntries(testControls) }); } catch { hp = null; }
    hostProgs.set(c.prog, hp);
  }
  const hp = hostProgs.get(c.prog);
  if (!hp) return;
  const schema = new HostSchema(hp), rule = schema.program.P[42] !== undefined ? c.rule : 0;
  const names = []; const td = new TextDecoder();
  for (let i = 0; i < hp.P[15]; i++) { const at = hp.P[42] + 5 * i; names.push(td.decode(hp.B.subarray(hp.P[at], hp.P[at] + hp.P[at + 1]))); }
  const opts = { top: c.lim[0] === 0 ? 'map' : 'any', cose: c.lim[1] === 1 };
  for (const [chunk, quantum] of [[1, 0], [5, 2], [4096, 0]]) {
    let js;
    try { js = render(validateHandleSync(schema, bufferHandle(c.bytes), names[rule], opts, { chunk, quantum })); }
    catch (e) { js = 'THROW ' + e.message; }
    const want = render(hp.result(hp.run(rule, c.bytes, opts)));
    if (js !== want) fail(`${c.label}: JS host session ${js} | JS host validate ${want}`);
    hostRuns.push({ ci, chunk, quantum, js });
  }
});

// ---------------------------------------------------------------- Rust
let rustLine = '  SKIP Rust (no binary given)', hostLine = '  SKIP hosts', urustLine = '  SKIP unknown length Rust';
if (rustBin) {
  const lines = programs.map(p => `prog ${Array.from(p.P).join(',')} ${p.B.length ? hex(p.B) : '-'}`);
  const sel = [];
  runs.forEach((r, i) => {
    if (!r.rust) return;
    const c = cases[r.ci], pol = r.policy;
    sel.push(i);
    lines.push(`case ${c.prog} ${c.rule} ${Array.from(r.lim).join(' ')} ${pol.kind} ${pol.w} ${pol.q} ${pol.seed >>> 0} ${pol.k} ${c.bytes.length ? hex(c.bytes) : '-'}`);
  });
  const usel = [];
  uruns.forEach((r, i) => {
    if (!r.rust) return;
    const c = cases[r.ci], pol = r.policy;
    usel.push(i);
    lines.push(`ucase ${c.prog} ${c.rule} ${Array.from(r.lim).join(' ')} ${pol.kind} ${pol.w} ${pol.q} ${pol.seed >>> 0} ${pol.k} ${r.ff ? 1 : 0} ${c.bytes.length ? hex(c.bytes) : '-'}`);
  });
  for (const h of hostRuns) {
    const c = cases[h.ci];
    lines.push(`host ${c.prog} ${c.rule} ${c.lim[0] === 0 ? 1 : 0} ${c.lim[1]} ${h.chunk} ${h.quantum} ${c.bytes.length ? hex(c.bytes) : '-'}`);
  }
  const t2 = performance.now();
  const p = spawnSync(rustBin, [], { input: lines.join('\n') + '\n', maxBuffer: 1 << 30, encoding: 'utf8' });
  const tRs = performance.now() - t2;
  if (p.status !== 0) fail(`the Rust binary exited ${p.status}: ${p.stderr.slice(0, 400)}`);
  const all = p.stdout.trim().split('\n');
  const rs = all.slice(0, sel.length), urs = all.slice(sel.length, sel.length + usel.length), hs = all.slice(sel.length + usel.length);
  if (all.length !== sel.length + usel.length + hostRuns.length) fail(`Rust answered ${all.length} lines, expected ${sel.length + usel.length + hostRuns.length}`);
  let ua = 0;
  usel.forEach((i, k) => {
    if (urs[k] === 'PANIC') { fail(`unknown ${desc(uruns[i])}: Rust PANICKED`); return; }
    if (urs[k] !== ujs[i]) { fail(`unknown ${desc(uruns[i])}: JS ${ujs[i]} | Rust ${urs[k]}`); return; }
    ua++;
  });
  urustLine = `  ${ua === usel.length ? 'ok  ' : 'FAIL'} unknown length JS == Rust: ${ua}/${usel.length} drain and fail-fast runs, whole out array`;
  let ha = 0;
  hostRuns.forEach((h, k) => { if (hs[k] === h.js) ha++; else fail(`${cases[h.ci].label} chunk ${h.chunk} q ${h.quantum}: JS host ${h.js} | Rust host ${hs[k]}`); });
  hostLine = `  ${ha === hostRuns.length ? 'ok  ' : 'FAIL'} hosts: JS validateHandleSync == Rust snug::schema::validate_blob on ${ha}/${hostRuns.length} corpus and stress runs (chunks 1, 5 with quantum 2, 4096), both == Schema.validate`;
  let ra = 0, panics = 0;
  sel.forEach((i, k) => {
    if (rs[k] === 'PANIC') { panics++; fail(`${desc(runs[i])}: Rust PANICKED`); return; }
    if (rs[k] !== js[i]) { fail(`${desc(runs[i])}: JS ${js[i]} | Rust ${rs[k]}`); return; }
    ra++;
  });
  rustLine = `  ${ra === sel.length ? 'ok  ' : 'FAIL'} JS == Rust (debug, overflow checks on): ${ra}/${sel.length} session runs, whole out array, ${panics} panics (${(tRs / 1000).toFixed(1)} s)`;
}

const line = (ok, s) => console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${s}`);
const nStress = cases.filter(c => c.stress).length;
line(agree === runs.length, `session == buffer driver: ${agree}/${runs.length} runs give vm-validate's whole out array, over ${cases.length - nStress} vm-test cases (${MUTATIONS} mutations, ${SCHEMAS} oracle schemas, seed ${SEED}; ${nSpan} span cases are not sessions) and ${nStress} stress cases`);
console.log(`  info runs: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
line(trapFails === 0, `JS bounds: ${guarded} runs behind throwing out-of-bounds traps on P, B, window, scratch, session array, key arena, out`);
line(interFails === 0, `interleaved sessions: ${inter} sessions run three at a time, a step each in turn, on one Program`);
console.log(rustLine);
line(uagree === uruns.length - ffRuns, `unknown length (D085, drain): ${uagree}/${uruns.length - ffRuns} streams of an untold length give the buffer's whole out array (${Object.entries(ucounts).filter(([k]) => k !== 'failfast').map(([k, v]) => `${k} ${v}`).join(', ')}); ${uguarded} behind traps`);
line(ffBad === 0, `fail-fast: ${ffRuns - ffBad}/${ffRuns} streams accept iff the buffer accepts (${ffSameCode} with the buffer's out, ${ffEarly} refused early with another code or offset)`);
console.log(urustLine);
console.log(hostLine);
console.log(`  info ${programs.length} programs; JS ran ${runs.length} sessions in ${(tJs / 1000).toFixed(1)} s and ${uruns.length} unknown-length streams in ${(tUjs / 1000).toFixed(1)} s (all ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
if (fails) { console.log(`  FAIL ${fails} failure(s)`); process.exit(1); }
console.log('  ok   vmsession-test');
