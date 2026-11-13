// bb compile2-test: the format 2.0 compiler and verifier (P8.5 phase 1, D270;
// docs/program-2.md), JS and Rust, compile-only (the VM is unchanged until
// phase 2).
//
//     node kin/scripts/compile2-test.mjs <rust-compile2-test-binary> [corruptions per program] [seed]
//
// Gates (each prints ok/FAIL; exit 1 on any FAIL):
//   1. every schema of corpus/conformance/{study,adversarial,audit-2026-11-04}.json and
//      corpus/cddl-study/contracts/*.cddl compiles on BOTH hosts in BOTH cut modes, except
//      the study suites that expect a refusal (`schemaError`), which must fail with that
//      code family; the adversarial `snugSchemaError` suites name withdrawn refusals
//      (map_overlap, map_group_occurrence, map_cut: D275) and must now compile; `phase:
//      "later"` suites are not held to an expectation;
//   2. the RFC corpus (corpus/conformance/rfc/rfc*.json): no withdrawn refusal remains;
//      the outcomes against each suite's recorded compileObservation are listed;
//   3. architecture §20.15's probe schemas (read from docs/architecture.md) compile, and
//      the remaining refusals hold (left recursion, `n*m` with m < n, keyless map entries,
//      the PEG node limit), with the withdrawn ones compiling;
//   4. JS == Rust: Program words, pool bytes and warnings (code, line, column, rule), or
//      the same error (code, line, column, rule);
//   5. vm-verify (format 2.0) accepts every compiled Program on both hosts, refuses 1.x
//      Programs (check C_VERSION) and seeded corruptions, and on random corruptions never
//      crashes and agrees across hosts;
//   6. SOURCE_KEY = SHA-256 of program-2 §1's preimage (version element 2, cuts and
//      groupWords appended to the limits), recomputed independently; the effective cut
//      mode is in the preimage whether given or defaulted (D301: no option = 'rfc');
//      'reference' is no longer a cut mode (no alias);
//   7. outcomes do not depend on the starting arena size;
//   8. the tier census of the corpus (arrays A0/A1/A2, maps F/S/T), printed against the
//      design's syntactic census (architecture §20.5);
//   9. semantics, before the phase 2 VM exists: a test-only reference interpreter of the
//      compiled Programs (kin/scripts/peg2-ref.mjs, §20.2's `run`) gives §20.15's verdicts
//      on its probes and the independent oracle's (corpus/tools/peg-oracle.mjs) on every
//      corpus case it can decide, in both cut modes;
//  10. warning W8 (D301): a map choice whose alternatives start with the same literal cut
//      key warns under the default RFC cut, never under `cuts: 'branch'`, and not for the
//      documented working forms (a type choice of maps, `=>` discriminators).
//
// Cut modes are numbered as kin's option word 20: 0 'rfc' (the default), 1 'branch'.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compile, SchemaError, SNUG_VERSION } from '../../host/js/src/compile.mjs';
import { vmVerify, vmVerifyWords } from '../../gen/js/snug/program/verify.mjs';

const [rustBin, corrArg, seedArg] = process.argv.slice(2);
const CORRUPTIONS = Number(corrArg ?? 24), SEED = Number(seedArg ?? 7);
const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
let fails = 0;
const fail = (msg) => { fails++; if (fails <= 60) console.log(`  FAIL ${msg}`); };
const hex = b => Buffer.from(b).toString('hex');
const wordsHex = P => Array.from(P, w => (w >>> 0).toString(16).padStart(8, '0')).join('');
const WITHDRAWN = new Set(['map_overlap', 'map_group_occurrence', 'map_cut']);
const C_VERSION = 25;

// ---------------------------------------------------------------- cases
const cases = [];
const study = JSON.parse(read('corpus/conformance/study.json'));
for (const s of study.suites)
  cases.push({ label: `study ${s.name}`, text: s.cddl ?? read('corpus/' + s.cddlFile), want: s.schemaError, later: s.phase === 'later' });
const adv = JSON.parse(read('corpus/conformance/adversarial.json'));
for (const s of adv.suites)
  cases.push({ label: `adversarial ${s.name}`, text: s.cddl, withdrawn: s.snugSchemaError });
for (const s of JSON.parse(read('corpus/conformance/audit-2026-11-04.json')).suites)
  cases.push({ label: `audit ${s.name}`, text: s.cddl, want: s.snugSchemaError });
for (const f of readdirSync(new URL('corpus/cddl-study/contracts/', root)).sort())
  cases.push({ label: `contract ${f}`, text: read('corpus/cddl-study/contracts/' + f) });
const rfcFiles = readdirSync(new URL('corpus/conformance/rfc/', root)).filter(f => /^rfc\d+\.json$/.test(f)).sort();
const rfcCases = [];
for (const f of rfcFiles)
  for (const s of JSON.parse(read('corpus/conformance/rfc/' + f)).suites ?? [])
    if (s.cddl) rfcCases.push({ label: `rfc ${f} ${s.name ?? s.id}`, text: s.cddl, observed: s.compileObservation });
const family = w => w === undefined ? undefined : w.split(':')[0].trim();

// architecture §20.15's probe schemas, from the document itself
const arch = read('docs/architecture.md');
const probeBlock = arch.slice(arch.indexOf('### 20.15 Probe record'), arch.indexOf('### 20.16'));
const probes = [...new Set([...probeBlock.matchAll(/^\| [A-Z]\d\d\.\d \| `([^`]*)` \|/gm)].map(m => m[1].replace(/; /g, '\n')))];

// remaining refusals and withdrawn ones (program-2 §3, arch §20.11)
const REFUSALS = [
  ['r = [g]\ng = (? int, g)', 'group_recursion'],
  ['r = {g}\ng = (? a: int, g)', 'group_recursion'],
  ['r = [g]\ng = (g // int)', 'group_recursion'],
  ['r = [g]\ng = (* (? int), h)\nh = (int, g // g)', 'group_recursion'],
  ['r = [* g0]\ng0 = (g0, 0*0 g0)', 'group_recursion'],
  ['r = [3*2 int]', 'syntax'],
  ['r = {tstr}', 'map_key'],
  ['r = {~t}\nt = #6.1(int)', 'map_key'],
  ['r = [' + Array.from({ length: 1100 }, () => 'int').join(', ') + ']', 'limit_peg_nodes'],
  ['r = [' + Array.from({ length: 300 }, () => 'int').join(', ') + ']', 'limit_array_positions'],
];
const NOW_COMPILE = [
  'r = {int => int, int => 6}', 'r = {* tstr => any, ? a: int}', 'r = {* tstr ^=> uint, * any => any}',
  'r = {h\'01\': int}', 'r = {1.5: int}', 'r = {18446744073709551616: int}', 'r = [g]\ng = (0, ? g, 1)',
  'r = {rater-value, ? conf-value, * ext-value}\nrater-value = (rater: text)\nconf-value = (confidence: uint)\next-value = (text => any)',
  'r = {2*2 (+ tstr => int)}', 'r = [int, ~r]', 'r = {a: int, ? ~r}', 'r = [* ~t]\nt = #6.1(int)',
  // D349: a dead self-reference after a member in a map group (its Program must verify)
  'r = { ? g }\ng = ("k" => true, 0*0 g)', 'r = { * g }\ng = ("k" => true, 0*0 g)', 'r = { ? g }\ng = (* "k" => true, 0*0 g)',
  'r = { ? g }\ng = ("k" => true, 0*0 (1 => int, g))',
];

// ---------------------------------------------------------------- JS and Rust runners
function jsRun(text, cuts, gw) {
  try {
    const opts = cuts === undefined ? {} : { cuts: cuts ? 'branch' : 'rfc' };
    if (gw >= 0) opts.groupWords = gw;
    const c = compile(text, opts);
    return { ok: true, program: c.program, pool: c.pool, warnings: c.warnings };
  } catch (e) {
    if (e instanceof SchemaError) return { ok: false, code: e.code, line: e.line, column: e.column, rule: e.rule ?? '-' };
    return { crash: String(e && e.stack || e) };
  }
}
function warnKey(ws) {
  if (!ws.length) return '-';
  return ws.map(w => `${w.code},${w.line},${w.column},${w.rule === null ? '-' : hex(Buffer.from(w.rule, 'utf8'))}`).join(';');
}
function verifyJs(P, B, cap) {
  const nl = P.length > 16 ? Math.min(Math.max(P[16], 0), 1 << 20) : 0;
  const m = Math.max(cap, nl, 1);
  try {
    const S = new Int32Array(Math.max(vmVerifyWords(P, m), 48) + 16);
    S[16] = 1; S[17] = m;
    return [vmVerify(P, B, S), S[35], S[36]];
  } catch (e) { return ['CRASH ' + e.message]; }
}
function rustRun(lines) {
  const rr = spawnSync(rustBin, [], { input: lines.join('\n') + '\n', maxBuffer: 1 << 30 });
  if (rr.status !== 0) { console.log(`  FAIL the Rust binary exited ${rr.status}: ${rr.stderr}`); process.exit(1); }
  const out = rr.stdout.toString().trimEnd().split('\n');
  if (out.length !== lines.length) { console.log(`  FAIL Rust answered ${out.length} of ${lines.length}`); process.exit(1); }
  return out;
}
const cline = (text, cuts, gw) => `C 0 ${cuts} ${gw} ${hex(Buffer.from(text, 'utf8'))}`;

// Run a list of {text, cuts, gw} on both hosts; returns [{js, rust, same}].
function both(items) {
  const js = items.map(it => jsRun(it.text, it.cuts, it.gw));
  const rust = rustRun(items.map(it => cline(it.text, it.cuts, it.gw)));
  return items.map((it, i) => {
    const j = js[i], r = rust[i];
    if (j.crash) return { j, r, same: false, why: `JS threw a non-SchemaError: ${j.crash.split('\n')[0]}` };
    if (r === 'PANIC') return { j, r, same: false, why: 'Rust panicked' };
    const f = r.split(' ');
    if (j.ok) {
      const same = f[0] === 'ok' && f[2] === wordsHex(j.program) && (f[3] ?? '') === hex(j.pool) && (f[4] ?? '') === warnKey(j.warnings);
      return { j, r, f, same, why: same ? '' : `JS and Rust differ (${f[0]}${f[0] === 'ok' && f[2] === wordsHex(j.program) ? ', warnings or pool' : ''})` };
    }
    const same = f[0] === 'err' && f[1] === j.code && Number(f[2]) === j.line && Number(f[3]) === j.column && f.slice(4).join(' ') === j.rule;
    return { j, r, f, same, why: same ? '' : `JS ${j.code} ${j.line}:${j.column} ${j.rule} vs Rust ${r}` };
  });
}

// ---------------------------------------------------------------- 1, 4, 5: the corpus, both modes
const programs = [];
let identical = 0, total = 0, verified = 0, nverify = 0;
const tally = { compiled: 0, expectCompile: 0, refused: 0, expectRefuse: 0, withdrawn: 0, withdrawnTotal: 0 };
const warnCount = {};
for (const cuts of [0, 1]) {
  const res = both(cases.map(c => ({ text: c.text, cuts, gw: -1 })));
  res.forEach(({ j, f, same, why }, i) => {
    const c = cases[i];
    total++;
    if (same) identical++; else fail(`${c.label} [cuts ${cuts}]: ${why}`);
    if (j.crash) return;
    if (j.ok) {
      nverify++;
      const v = verifyJs(j.program, j.pool, j.program[16]);
      if (v[0] !== 0) fail(`${c.label} [cuts ${cuts}]: the JS verifier refused the Program (${v.join(' ')})`);
      else if (f && f[1] !== '0') fail(`${c.label} [cuts ${cuts}]: the Rust verifier refused the Program (${f[1]})`);
      else verified++;
      if (cuts === 0) {
        programs.push({ label: c.label, P: j.program, B: j.pool });
        for (const w of j.warnings) warnCount[w.code] = (warnCount[w.code] ?? 0) + 1;
      }
    }
    if (cuts !== 0 || c.later) return;
    const want = family(c.want);
    if (c.withdrawn !== undefined) {
      tally.withdrawnTotal++;
      if (!WITHDRAWN.has(family(c.withdrawn))) fail(`${c.label}: expects ${c.withdrawn}, not a withdrawn refusal`);
      else if (j.ok) tally.withdrawn++;
      else fail(`${c.label}: a withdrawn refusal (${c.withdrawn}) still refuses: ${j.code} ${j.line}:${j.column}`);
    } else if (want !== undefined) {
      tally.expectRefuse++;
      if (j.ok) fail(`${c.label}: expected a refusal (${want}), but it compiled`);
      else if (j.code !== want) fail(`${c.label}: expected ${want}, got ${j.code} at ${j.line}:${j.column}`);
      else tally.refused++;
    } else {
      tally.expectCompile++;
      if (!j.ok) fail(`${c.label}: did not compile: ${j.code} at ${j.line}:${j.column} (rule ${j.rule})`);
      else tally.compiled++;
    }
  });
}
console.log(`  ${tally.compiled === tally.expectCompile ? 'ok  ' : 'FAIL'} ${tally.compiled}/${tally.expectCompile} corpus schemas compile on both hosts`);
console.log(`  ${tally.withdrawn === tally.withdrawnTotal ? 'ok  ' : 'FAIL'} ${tally.withdrawn}/${tally.withdrawnTotal} suites expecting a withdrawn refusal (map_overlap, map_group_occurrence, map_cut) now compile`);
console.log(`  ${tally.refused === tally.expectRefuse ? 'ok  ' : 'FAIL'} ${tally.refused}/${tally.expectRefuse} remaining expected refusals, with the expected code family`);

// ---------------------------------------------------------------- 2: the RFC corpus
{
  const res = both(rfcCases.map(c => ({ text: c.text, cuts: 0, gw: -1 })));
  let ok = 0, stillRefused = 0, nowCompile = 0, sameRefusal = 0, newRefusal = 0, withdrawnLeft = 0;
  const changes = [];
  res.forEach(({ j, f, same, why }, i) => {
    const c = rfcCases[i];
    total++;
    if (same) identical++; else fail(`${c.label}: ${why}`);
    if (j.crash) return;
    const obs = c.observed ?? {};
    if (j.ok) {
      ok++; nverify++;
      const v = verifyJs(j.program, j.pool, j.program[16]);
      if (v[0] !== 0 || (f && f[1] !== '0')) fail(`${c.label}: the verifier refused the Program (${v.join(' ')} / ${f && f[1]})`); else verified++;
      programs.push({ label: c.label, P: j.program, B: j.pool });
      if (obs.ok === false) { nowCompile++; changes.push(`${c.label}: was ${obs.code}, now compiles`); }
    } else {
      stillRefused++;
      if (WITHDRAWN.has(j.code)) { withdrawnLeft++; fail(`${c.label}: withdrawn refusal ${j.code}`); }
      if (obs.ok === false && obs.code === j.code) sameRefusal++;
      else { newRefusal++; changes.push(`${c.label}: ${obs.ok ? 'compiled' : obs.code} -> ${j.code} ${j.line}:${j.column}`); }
    }
  });
  console.log(`  ${withdrawnLeft === 0 ? 'ok  ' : 'FAIL'} RFC corpus: ${ok}/${rfcCases.length} compile (${nowCompile} newly), ${stillRefused} refused (${sameRefusal} as observed before, ${newRefusal} different), no withdrawn refusal left`);
  for (const ch of changes) console.log(`       ${ch}`);
}

// ---------------------------------------------------------------- 3: probes and refusals
{
  const items = [];
  for (const t of probes) for (const cuts of [0, 1]) items.push({ text: t, cuts, gw: -1, kind: 'probe' });
  for (const [t, code] of REFUSALS) items.push({ text: t, cuts: 0, gw: -1, kind: 'refusal', code });
  for (const t of NOW_COMPILE) items.push({ text: t, cuts: 0, gw: -1, kind: 'now' });
  const res = both(items);
  let pgood = 0, rgood = 0, ngood = 0;
  res.forEach(({ j, f, same, why }, i) => {
    const it = items[i];
    total++;
    if (same) identical++; else fail(`${it.kind} ${JSON.stringify(it.text.slice(0, 60))}: ${why}`);
    if (j.crash) return;
    if (j.ok) {
      nverify++;
      const v = verifyJs(j.program, j.pool, j.program[16]);
      if (v[0] !== 0 || (f && f[1] !== '0')) fail(`${it.kind} ${JSON.stringify(it.text.slice(0, 60))}: verifier refused (${v.join(' ')})`); else verified++;
      if (it.cuts === 0) programs.push({ label: `${it.kind} ${it.text.slice(0, 40)}`, P: j.program, B: j.pool });
    }
    if (it.kind === 'probe') { if (j.ok) pgood++; else fail(`probe ${JSON.stringify(it.text)} [cuts ${it.cuts}]: ${j.code} ${j.line}:${j.column}`); }
    if (it.kind === 'refusal') { if (!j.ok && j.code === it.code) rgood++; else fail(`refusal ${JSON.stringify(it.text.slice(0, 60))}: want ${it.code}, got ${j.ok ? 'a Program' : j.code}`); }
    if (it.kind === 'now') { if (j.ok) ngood++; else fail(`withdrawn ${JSON.stringify(it.text.slice(0, 60))}: ${j.code} ${j.line}:${j.column}`); }
  });
  console.log(`  ${pgood === 2 * probes.length ? 'ok  ' : 'FAIL'} ${pgood}/${2 * probes.length} architecture §20.15 probe schemas compile (both cut modes)`);
  console.log(`  ${rgood === REFUSALS.length ? 'ok  ' : 'FAIL'} ${rgood}/${REFUSALS.length} remaining refusals (left recursion, n*m with m < n, keyless map entries, PEG node and position limits)`);
  console.log(`  ${ngood === NOW_COMPILE.length ? 'ok  ' : 'FAIL'} ${ngood}/${NOW_COMPILE.length} formerly refused schemas compile and verify on both hosts (overlap, cuts on typesets and non-text keys, group occurrence, centre recursion, recursive unwrap, dead self-references D349)`);
}
console.log(`  ${identical === total ? 'ok  ' : 'FAIL'} ${identical}/${total} identical across hosts (Programs, pools and warnings byte for byte; errors field for field)`);
console.log(`  ${verified === nverify ? 'ok  ' : 'FAIL'} ${verified}/${nverify} Programs accepted by vm-verify (format 2.0) on JS and Rust`);

// ---------------------------------------------------------------- 5: corruptions
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const rnd = rng(SEED), ri = n => Math.floor(rnd() * n);
const sure = [], random = [];
const seen = new Set();
for (const { label, P, B } of programs) {
  const key = wordsHex(P.slice(15)); if (seen.has(key)) continue; seen.add(key);
  const mut = (f) => { const Q = Int32Array.from(P); const C = Uint8Array.from(B); const r = f(Q, C); return r ?? { P: Q, B: C }; };
  const sec = (Q, k) => Q[42 + k];
  sure.push([label + ' magic', mut(Q => { Q[0] ^= 1; })]);
  sure.push([label + ' format 1.0', mut(Q => { Q[1] = 1; }), C_VERSION]);
  sure.push([label + ' format 1.1', mut(Q => { Q[1] = 0x00010001; }), C_VERSION]);
  sure.push([label + ' format 2.1', mut(Q => { Q[1] = 0x00010002; }), C_VERSION]);
  sure.push([label + ' words', mut(Q => { Q[3] += 1; })]);
  sure.push([label + ' truncated', mut(Q => ({ P: Q.slice(0, Q.length - 1), B }))]);
  sure.push([label + ' pool', mut((Q, C) => ({ P: Q, B: Uint8Array.from([...C, 0]) }))]);
  sure.push([label + ' scratch max', mut(Q => { Q[40] += 1; })]);
  sure.push([label + ' R_ITEM_MAX', mut(Q => { Q[29] += 1; })]);
  sure.push([label + ' RECLEAF_MAX', mut(Q => { Q[62] += 1; })]);
  sure.push([label + ' ACT_SUM', mut(Q => { Q[63] += 1; })]);
  sure.push([label + ' arena cap', mut(Q => { Q[41] = (1 << 24) + 1; })]);
  sure.push([label + ' FLAGS arena', mut(Q => { Q[6] ^= 64; })]);
  if (P[16] > 0) sure.push([label + ' mask', mut(Q => { const at = Q[43] + 8 * ri(Q[16]) + 1; Q[at] ^= 0x1000; })]);
  if (P[19] > 0) {
    const g = ri(P[19]);
    const po = P[P[47] + g];
    sure.push([label + ' peg tier', mut(Q => { Q[po + 3] ^= 1; })]);
    sure.push([label + ' peg depth', mut(Q => { Q[po + 6] += 1; })]);
    sure.push([label + ' peg n_calls', mut(Q => { Q[po + 8] += 1; })]);
    sure.push([label + ' peg memo', mut(Q => { Q[po + 5] = 1; })]);
    sure.push([label + ' peg d word', mut(Q => { Q[po + 9 + 4] = 0; })]);
    sure.push([label + ' peg op', mut(Q => { Q[po + 9] = 8; })]);
    if (P[po + 1] > 1) sure.push([label + ' peg node twice', mut(Q => { const nk = Q[po + 2]; if (nk > 1) { const kb = po + 9 + 5 * Q[po + 1]; Q[kb + 1] = Q[kb]; } else { Q[po + 9] = 6; Q[po + 10] = Q[po + 1]; } })]);
  }
  if (P[21] > 0) {
    const a = ri(P[21]), ao = P[P[51] + a];
    sure.push([label + ' array first', mut(Q => { Q[ao + 4] ^= 1 << 31; })]);
    if (P[ao] > 0) sure.push([label + ' array follow', mut(Q => { const w = Q[ao + 1]; Q[ao + 4 + w + Q[ao] + ri(Q[ao] * w)] ^= 1; })]);
    sure.push([label + ' array peg', mut(Q => { Q[ao + 2] = Q[19]; })]);
  }
  if (P[20] > 0) {
    const m = ri(P[20]), mo = P[P[49] + m];
    if (P[mo + 1] > 0) sure.push([label + ' map class', mut(Q => { const e = mo + 8 + 5 * ri(Q[mo + 1]); Q[e + 3] = Q[e + 3] === 0 ? 2 : 0; })]);
    sure.push([label + ' map slot_words', mut(Q => { Q[mo + 4] += 1; })]);
    sure.push([label + ' map rec_words', mut(Q => { Q[mo + 5] += 1; })]);
    sure.push([label + ' map flags', mut(Q => { Q[mo + 7] ^= 1; })]);
    sure.push([label + ' map key_ts', mut(Q => { Q[mo + 3] = Q[mo + 3] < 0 ? 0 : -1; })]);
  }
  for (let k = 0; k < CORRUPTIONS; k++) {
    random.push([label + ' random ' + k, mut(Q => {
      const n = 1 + ri(3);
      for (let q = 0; q < n; q++) {
        const at = ri(Q.length), kind = ri(4);
        Q[at] = kind === 0 ? Q[at] + 1 : kind === 1 ? Q[at] - 1 : kind === 2 ? ri(65536) - 32768 : (Q[at] ^ (1 << ri(31)));
      }
    })]);
  }
}
{
  const all = [...sure, ...random];
  const capOf = P => Math.min(Math.max(P[16] ?? 1, 1), 1 << 20);
  const vr = rustRun(all.map(([, m]) => `V ${wordsHex(m.P)} ${hex(m.B)} ${capOf(m.P)}`));
  let refused = 0, agree = 0, crashes = 0, versions = 0, nversions = 0;
  all.forEach(([label, m, wantCheck], i) => {
    const jv = verifyJs(m.P, m.B, capOf(m.P));
    const r = vr[i];
    if (typeof jv[0] === 'string' || r === 'PANIC') {
      crashes++; fail(`${label}: the verifier crashed (${jv[0]} / ${r})`);
      if (process.env.SNUG_DUMP) writeFileSync(process.env.SNUG_DUMP, `V ${wordsHex(m.P)} ${hex(m.B)} ${capOf(m.P)}\n`, { flag: 'a' });
      return;
    }
    if (r === `v ${jv[0]} ${jv[1]} ${jv[2]}`) agree++; else fail(`${label}: JS verify ${jv.join(' ')} vs Rust ${r}`);
    if (i < sure.length) {
      if (jv[0] !== 0) refused++; else fail(`${label}: an invalid Program was accepted`);
      if (wantCheck !== undefined) { nversions++; if (jv[0] === -1 && jv[2] === wantCheck) versions++; else fail(`${label}: refused with ${jv.join(' ')}, not check ${wantCheck}`); }
    }
  });
  console.log(`  ${refused === sure.length ? 'ok  ' : 'FAIL'} ${refused}/${sure.length} seeded invalid Programs refused (header, PEG, map and array fields)`);
  console.log(`  ${versions === nversions ? 'ok  ' : 'FAIL'} ${versions}/${nversions} format 1.0 / 1.1 / 2.1 Programs refused with C_VERSION (D084 major-version rule)`);
  console.log(`  ${crashes === 0 && agree === all.length ? 'ok  ' : 'FAIL'} ${random.length} random corruptions: no crash, ${agree}/${all.length} verdicts identical across hosts`);
}

// ---------------------------------------------------------------- 6: SOURCE_KEY
{
  const { encode } = await import('../../bench/baseline/cbor-3sln.mjs');
  const { createHash } = await import('node:crypto');
  const LIMITS = [262144, 64, 65536, 1024, 1024, 256, 256, 256, 1048576, 8388608, 10000000, 32, 1500000, 65536, 131072, 128, 2250000];
  let good = 0, n = 0;
  for (const c of cases.slice(0, 60)) {
    for (const [cuts, gw] of [[0, -1], [1, -1], [0, 65536]]) {
      const j = jsRun(c.text, cuts, gw);
      if (!j.ok) continue;
      n++;
      const pre = encode(['snug/program-key', 2, SNUG_VERSION, 0, [...LIMITS, cuts, gw], new Uint8Array(Buffer.from(c.text, 'utf8')), [], [], 0]);
      const d = createHash('sha256').update(pre).digest();
      if ([0, 1, 2, 3, 4, 5, 6, 7].every(i => j.program[7 + i] === d.readInt32BE(4 * i))) good++;
      else fail(`${c.label} [cuts ${cuts}, groupWords ${gw}]: SOURCE_KEY is not SHA-256 of program-2 §1's preimage`);
      if (gw >= 0 && j.program[41] !== gw) fail(`${c.label}: LIM_GROUP_WORDS ${j.program[41]} is not the groupWords option`);
      if (((j.program[6] >> 5) & 1) !== cuts) fail(`${c.label}: FLAGS bit 5 is not the cut mode`);
      if (cuts === 0 && gw < 0) {
        // D301: no option is 'rfc', and the default's effective mode (0) is in the preimage
        const d0 = jsRun(c.text, undefined, -1);
        if (!d0.ok || wordsHex(d0.program) !== wordsHex(j.program)) fail(`${c.label}: the default cut mode is not 'rfc'`);
      }
    }
  }
  try { compile('r = {a: int}', { cuts: 'reference' }); fail(`cuts: 'reference' was accepted (D301: no alias)`); }
  catch (e) { if (!(e instanceof TypeError)) fail(`cuts: 'reference' threw ${e}, not a TypeError`); }
  console.log(`  ${good === n ? 'ok  ' : 'FAIL'} ${good}/${n} SOURCE_KEYs equal SHA-256 of program-2 §1's preimage (cuts, groupWords; baseline encoder, node:crypto)`);
}

// ---------------------------------------------------------------- 7: arena-size independence
{
  const M = await import('../../gen/js/snug/compile/main.mjs');
  const A = await import('../../gen/js/snug/compile/arena.mjs');
  const enc = new TextEncoder(), dec = new TextDecoder();
  const run = (text, start) => {
    const bytes = enc.encode(text), opt = new Int32Array(M.OPT_WORDS).fill(-1);
    opt[M.OPT_REGEXP] = 0;
    let fl = new Int32Array(0), words = start, retries = 0;
    for (;;) {
      const h = new Int32Array(words);
      const code = M.compileSchema(bytes, opt, fl, new Int32Array(0), h);
      if (code === A.ERR_ARENA) { words *= 2; retries++; continue; }
      if (code === A.ERR_NEED_FLOATS) {
        const n = M.floatRequests(h), f = new Int32Array(1 + 2 * n), dv = new DataView(new ArrayBuffer(8)); f[0] = n;
        for (let i = 0; i < n; i++) { dv.setFloat64(0, Number(dec.decode(bytes.subarray(M.floatRequestStart(h, i), M.floatRequestEnd(h, i))))); f[1 + 2 * i] = dv.getInt32(0); f[2 + 2 * i] = dv.getInt32(4); }
        fl = f; continue;
      }
      if (code !== 0) return { key: `err ${code} ${M.errorLine(h)} ${M.errorColumn(h)}`, retries };
      const p = M.outProgramAt(h);
      const ws = []; for (let i = 0; i < M.warningCount(h); i++) ws.push(`${M.warningCode(h, i)}@${M.warningOffset(h, i)}`);
      return { key: wordsHex(h.subarray(p, p + M.outProgramWords(h))) + ' ' + ws.join(','), retries };
    }
  };
  let same = 0, retried = 0;
  for (const c of cases) {
    const small = run(c.text, A.ARENA_MIN_WORDS), big = run(c.text, 1 << 22);
    if (small.retries > 0) retried++;
    if (small.key === big.key) same++; else fail(`${c.label}: the outcome depends on the arena size`);
  }
  console.log(`  ${same === cases.length ? 'ok  ' : 'FAIL'} ${same}/${cases.length} outcomes (Programs and warnings) independent of the starting arena size (${retried} needed retries)`);
}

// ---------------------------------------------------------------- 8: tier census
{
  const tiers = P => {
    const t = { A0: 0, A1: 0, A2: 0, AR: 0, F: 0, S: 0, T: 0, TR: 0 };
    const pegAt = g => P[P[47] + g];
    for (let l = 0; l < P[16]; l++) {
      const o = P[43] + 8 * l, k = P[o] & 255;
      if (k === 14) { const ao = P[P[51] + P[o + 2]], po = pegAt(P[ao + 2]); if (P[po + 8] > 0) t.AR++; else t[['A0', 'A1', 'A2'][P[po + 3]]]++; }
      if (k === 15) { const mo = P[P[49] + P[o + 2]], po = pegAt(P[mo]); if (P[po + 8] > 0) t.TR++; else t[['F', 'S', 'T'][P[po + 3]]]++; }
    }
    return t;
  };
  const files = ['adversarial.json', 'study.json', ...rfcFiles.map(f => 'rfc/' + f)];
  const sum = { A0: 0, A1: 0, A2: 0, AR: 0, F: 0, S: 0, T: 0, TR: 0 }, seenText = new Set();
  let schemas = 0, refusedN = 0;
  const examples = { A1: [], A2: [], S: [], T: [] };
  for (const f of files) {
    for (const s of JSON.parse(read('corpus/conformance/' + f)).suites ?? []) {
      if (!s.cddl || seenText.has(s.cddl)) continue; seenText.add(s.cddl);
      const j = jsRun(s.cddl, 0, -1);
      if (!j.ok) { refusedN++; continue; }
      schemas++;
      const t = tiers(j.program);
      for (const k in sum) sum[k] += t[k];
      for (const k of ['A1', 'A2', 'S', 'T']) if (t[k] && examples[k].length < 4) examples[k].push(`${f}: ${s.name}`);
    }
  }
  console.log(`  info tier census (compiled Programs, ${schemas} distinct schemas of ${files.join(', ')}; ${refusedN} refused):`);
  console.log(`       arrays A0 ${sum.A0}, A1 ${sum.A1}, A2 ${sum.A2} (+ ${sum.AR} recursive, A2); maps F ${sum.F}, S ${sum.S}, T ${sum.T} (+ ${sum.TR} recursive, T)`);
  console.log(`       design (syntactic, architecture §20.5): arrays 799 A0 / 25 A1 / 0 A2 (+1 recursive); maps 61 F / 37 S / 26 T`);
  for (const k of ['A1', 'A2', 'S', 'T']) if (examples[k].length) console.log(`       ${k} e.g. ${examples[k].join('; ')}`);
  console.log(`  info warnings over the corpus (default rfc cut mode): ${Object.entries(warnCount).sort().map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
}

// ---------------------------------------------------------------- 9: semantics vs the oracle
{
  const ref = await import('./peg2-ref.mjs');
  const oracle = await import('../../corpus/tools/peg-oracle.mjs');
  const bytesOf = s => Uint8Array.from(Buffer.from(s.replace(/\s/g, ''), 'hex'));
  const head = (m, n) => {
    n = BigInt(n);
    if (n < 24n) return [m * 32 + Number(n)];
    const size = n < 256n ? 1 : n < 65536n ? 2 : n < 4294967296n ? 4 : 8;
    const out = [m * 32 + 24 + Math.log2(size)], b = [];
    for (let i = 0; i < size; i++, n >>= 8n) b.unshift(Number(n & 255n));
    return out.concat(b);
  };
  // §20.15's data notation (as the oracle's own test reads it), straight to bytes in wire order
  const diag = text => {
    let p = 0;
    const sp = () => { while (p < text.length && /\s/.test(text[p])) p++; };
    const item = () => {
      sp();
      if (text[p] === '[' || text[p] === '{') {
        const isMap = text[p++] === '{', close = isMap ? '}' : ']', out = []; let count = 0; sp();
        while (text[p] !== close) {
          out.push(...item()); sp();
          if (isMap) { p++; out.push(...item()); sp(); }
          count++; if (text[p] !== close) { p++; sp(); }
        }
        p++; return head(isMap ? 5 : 4, count).concat(out);
      }
      if (text[p] === '"') { const m = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(p)); p += m[0].length; const b = [...new TextEncoder().encode(JSON.parse(m[0]))]; return head(3, b.length).concat(b); }
      const h = /^h'([\da-fA-F ]*)'/.exec(text.slice(p));
      if (h) { p += h[0].length; const b = [...bytesOf(h[1])]; return head(2, b.length).concat(b); }
      const sm = /^(false|true|null)/.exec(text.slice(p));
      if (sm) { p += sm[0].length; return [{ false: 244, true: 245, null: 246 }[sm[0]]]; }
      const n = /^-?\d+/.exec(text.slice(p)); p += n[0].length;
      const v = BigInt(n[0]); return head(v < 0n ? 1 : 0, v < 0n ? -1n - v : v);
    };
    return Uint8Array.from(item());
  };
  const rows = probeBlock.split('\n').filter(l => /^\| [A-Z]\d\d\.\d \|/.test(l)).map(l => {
    const c = l.split('|').slice(1, -1).map(x => x.trim());
    return { id: c[0], cddl: c[1].slice(1, -1).replace(/;\s*/g, '\n'), data: c[2].slice(1, -1), branch: c[3] === '✓', rfc: c[4] === '✓' };
  });
  const compiled = new Map();
  const programOf = (text, cuts) => {
    const k = cuts + text;
    if (!compiled.has(k)) {
      const j = jsRun(text, cuts, -1);
      if (j.ok) { const v = verifyJs(j.program, j.pool, j.program[16]); if (v[0] !== 0) fail(`${JSON.stringify(text.slice(0, 60))} [cuts ${cuts}]: vm-verify refused (${v.join(' ')})`); }
      compiled.set(k, j.ok ? j : null);
    }
    return compiled.get(k);
  };
  let pAgree = 0, pTotal = 0;
  for (const r of rows) for (const cuts of [0, 1]) {
    pTotal++;
    const j = programOf(r.cddl, cuts);
    if (!j) { fail(`probe ${r.id}: does not compile`); continue; }
    const got = ref.check(j.program, j.pool, 'r', oracle.decode(diag(r.data)), { cuts: cuts ? 'branch' : 'rfc' });
    const want = cuts ? r.branch : r.rfc;
    if (got === want) pAgree++; else fail(`probe ${r.id} [${cuts ? 'branch' : 'rfc'}] ${r.cddl.replace(/\n/g, '; ')} on ${r.data}: Program says ${got}, §20.15 says ${want}`);
  }
  console.log(`  ${pAgree === pTotal ? 'ok  ' : 'FAIL'} ${pAgree}/${pTotal} §20.15 probe verdicts reproduced by the compiled Programs (reference interpreter; both cut modes)`);
  // Targeted regressions for the lowering (fold rows, cuts on non-text keys, recursion,
  // unwrap, saturation): the compiled Programs against the oracle, both modes.
  const TARGETED = [
    ['r = {2*2 (+ int => int)}', ['{1:1}', '{1:1,2:2}', '{}']],
    ['r = {2* int => int}', ['{1:1}', '{1:1,2:2}']],
    ['r = {0*3 (+ int => int)}', ['{}', '{1:1,2:2}']],
    ['r = {1*3 (+ int => int), * tstr => any}', ['{"a":1}', '{1:1,"a":2}']],
    ['r = {2*3 (+ tstr => int)}', ['{"a":1}', '{"a":1,"b":2}']],
    ['r = {16777216*16777216 (? a: int)}', ['{}', '{"a":1}', '{"a":"x"}']],
    ['r = [16777217*16777217 (? int)]', ['[]', '[1]', '["x"]']],
    ['r = [2*3 (+ uint)]', ['[1,2,3]', '[]']],
    ['r = {? (a: int)}', ['{"a":1}', '{"a":"x"}', '{}']],
    ['r = {? a: int}', ['{"a":1}', '{"a":"x"}', '{}']],
    ['r = {(a: int) // (), * tstr => any}', ['{"a":"x"}', '{"a":1}']],
    ['r = {? a: int, * tstr => any}', ['{"a":"x"}', '{"a":1}']],
    ['r = {* (a: int, b: int)}', ['{"a":1}', '{"a":1,"b":2}', '{}']],
    ["r = {h'01': int, * bstr => any}", ["{h'01':1}", "{h'01':\"x\"}", "{h'02':\"x\"}"]],
    ['r = {18446744073709551616: int, * any => any}', ['{"a":1}']],
    ['r = [g]\ng = (0, ? g, 1)', ['[0,0,1,1]', '[0,1,1]', '[0,1]', '[0,0,0,1,1,1]']],
    ['r = [g]\ng = (int, ? (tstr, g))', ['[1,"x",2]', '[1,"x"]', '[1,"x",2,"y",3]']],
    ['r = {g}\ng = (a: int, ? (b: int, g))', ['{"a":1}', '{"a":1,"b":2}']],
    ['r = [int, ? ~r]', ['[1]', '[1,2]', '[1,2,3]', '[1,"x"]']],
    ['r = {a: int, ? ~r}', ['{"a":1}']],
    ['r = [* ~t]\nt = #6.1(int)', ['[1,2]', '["x"]']],
    ['r = {? 1 => int, * int => tstr}', ['{1:1,2:"x"}', '{1:"x"}']],
    ['r = {* int ^=> int, * any => any}', ['{1:"x"}', '{"a":1}']],
    ['r = {kind: "a", x: int // kind: "b", ? y: [* tstr]}', ['{"kind":"b","y":["p"]}', '{"kind":"a"}', '{"kind":"b","x":1}']],
    ['r = [(int, tstr) // (int, int), * int]', ['[1,2,3]', '[1,"x",3]']],
    ['r = {(a: int, b: int) // (a: tstr), * tstr => any}', ['{"a":"x","b":1}', '{"a":1}']],
    // D301: the discriminated-union forms of docs/guide.md, both modes
    ['r = {kind: "a", x: int // kind: "b", y: tstr}', ['{"kind":"a","x":1}', '{"kind":"b","y":"z"}', '{"kind":"a","x":"z"}']],
    ['r = {kind: "a", x: int} / {kind: "b", y: tstr}', ['{"kind":"a","x":1}', '{"kind":"b","y":"z"}', '{"kind":"a","x":"z"}', '{"kind":"c"}']],
    ['r = {"kind" => "a", x: int // "kind" => "b", y: tstr}', ['{"kind":"a","x":1}', '{"kind":"b","y":"z"}', '{"kind":"a","x":"z"}', '{"kind":"c"}']],
    ['r = {id: tstr, token: tstr // id: tstr}', ['{"id":"a"}', '{"id":"a","token":"t"}']],
    ['r = {"id" => tstr, token: tstr // "id" => tstr}', ['{"id":"a"}', '{"id":"a","token":"t"}', '{"id":"a","token":1}']],
    ['r = {? (a: int, b: int), * tstr => any}', ['{"a":1}', '{"a":1,"b":2}', '{"c":1}']],
  ];
  for (const [text, data] of TARGETED) for (const cuts of [0, 1]) {
    pTotal++;
    const j = programOf(text, cuts), os = oracle.compile(text);
    if (!j || os.error) { fail(`targeted ${JSON.stringify(text)}: does not compile (snug ${!!j}, oracle ${os.error})`); continue; }
    let ok = true;
    for (const d of data) {
      const item = oracle.decode(diag(d)), mode = cuts ? 'branch' : 'rfc';
      const want = oracle.check(os, 'r', item, { cuts: mode }), got = ref.check(j.program, j.pool, 'r', item, { cuts: mode });
      if (want !== got || want === 'unknown') { ok = false; fail(`targeted ${JSON.stringify(text)} [${mode}] on ${d}: Program says ${got}, oracle says ${want}`); }
    }
    if (ok) pAgree++;
  }
  console.log(`  ${pAgree === pTotal ? 'ok  ' : 'FAIL'} ${pAgree}/${pTotal} probe and targeted-lowering schemas: every verdict of the compiled Programs as expected (§20.15 table, or the oracle)`);
  let agree = 0, decided = 0, unknown = 0;
  const suites = [...adv.suites, ...study.suites.filter(s => s.cddl), ...JSON.parse(read('corpus/conformance/audit-2026-11-04.json')).suites];
  for (const f of rfcFiles) suites.push(...(JSON.parse(read('corpus/conformance/rfc/' + f)).suites ?? []).filter(s => s.cddl));
  for (const s of suites) {
    if (!s.cases || !s.cases.length) continue;
    const os = oracle.compile(s.cddl);
    if (os.error) continue;
    for (const cuts of [0, 1]) {
      const j = programOf(s.cddl, cuts);
      if (!j) continue;
      for (const c of s.cases) {
        if (typeof c.hex !== 'string') continue;
        let item; try { item = oracle.decode(bytesOf(c.hex)); } catch { continue; }
        const mode = cuts ? 'branch' : 'rfc';
        const want = oracle.check(os, c.rule ?? 'r', item, { cuts: mode });
        const got = ref.check(j.program, j.pool, c.rule ?? 'r', item, { cuts: mode });
        if (want === 'unknown' || got === 'unknown') { unknown++; continue; }
        decided++;
        if (want === got) agree++; else fail(`${s.name} [${mode}] ${c.rule ?? 'r'} ${c.hex}: Program says ${got}, oracle says ${want}`);
      }
    }
  }
  console.log(`  ${agree === decided ? 'ok  ' : 'FAIL'} ${agree}/${decided} corpus verdicts of the compiled Programs equal the independent oracle's (both cut modes; ${unknown} undecided: regexps, extension controls, or the oracle's own unknowns)`);
}

// ---------------------------------------------------------------- 10: warning W8 (D301)
{
  const W8 = [
    // [schema, W8 positions under the default 'rfc' (line:column of the later alternative's member)]
    ['r = {kind: "a", x: int // kind: "b", y: tstr}', ['1:27']],
    ['r = {kind: "a", x: int // kind: "b", y: tstr // kind: "c"}', ['1:27', '1:49']],
    ['r = {id: tstr, token: tstr // id: tstr}', ['1:31']],
    ['r = {ga // gb}\nga = (kind: "a", x: int)\ngb = (kind: "b", y: tstr)', ['3:7']],
    ['r = {"kind" ^=> "a", x: int // "kind": "b", y: tstr}', ['1:32']],
    ['r = {t: int, (kind: "a", x: int // kind: "b", y: tstr)}', ['1:36']],
    ['r = {kind: "a", x: int} / {kind: "b", y: tstr}', []],
    ['r = {"kind" => "a", x: int // "kind" => "b", y: tstr}', []],
    ['r = {kind: "a", x: int // other: "b", y: tstr}', []],
    ['r = [kind: "a", x: int // kind: "b", y: tstr]', []],
  ];
  const items = [];
  for (const [t] of W8) for (const cuts of [0, 1]) items.push({ text: t, cuts, gw: -1 });
  const res = both(items);
  let good = 0;
  res.forEach(({ j, same, why }, i) => {
    const it = items[i], want = it.cuts === 0 ? W8[i >> 1][1] : [];
    if (!same) { fail(`W8 ${JSON.stringify(it.text)} [cuts ${it.cuts}]: ${why}`); return; }
    if (!j.ok) { fail(`W8 ${JSON.stringify(it.text)}: does not compile (${j.code})`); return; }
    const got = j.warnings.filter(w => w.code === 'W8').map(w => `${w.line}:${w.column}`);
    if (JSON.stringify(got) === JSON.stringify(want)) good++;
    else fail(`W8 ${JSON.stringify(it.text)} [${it.cuts ? 'branch' : 'rfc'}]: warned at ${got.join(', ') || 'nothing'}, want ${want.join(', ') || 'nothing'}`);
  });
  console.log(`  ${good === items.length ? 'ok  ' : 'FAIL'} ${good}/${items.length} W8 cases (D301: same leading cut key across map alternatives warns under 'rfc' only; JS == Rust)`);
}

if (fails) { console.log(`  FAIL ${fails} failure(s)`); process.exit(1); }
console.log('  ok   compile2-test');
