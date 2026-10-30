// bb compile-test: the CDDL compiler, JS and Rust, on the conformance corpus.
//
//     node kin/scripts/compile-test.mjs <rust-compile-test-binary> [corruptions per program] [seed]
//
// Gates (each prints ok/FAIL; exit 1 on any FAIL):
//   1. every schema of corpus/conformance/{study,adversarial}.json and
//      corpus/cddl-study/contracts/*.cddl compiles on BOTH hosts, except the
//      suites that expect a refusal (study `schemaError`, adversarial
//      `snugSchemaError`), which must fail with that code family (the text
//      before ':'); `phase: "later"` suites are not held to an expectation;
//   2. cross-host identity: the same Program words and pool bytes, or the
//      same error (code, line, column, rule), from JS and Rust (SPEC §7);
//   3. program.md §15's worked example compiles to exactly its 286 words and
//      14-byte pool (read from docs/program.md, so the document is the oracle);
//   4. the structural verifier (program.md §11) accepts every compiled
//      Program on both hosts, refuses seeded corruptions that are invalid by
//      construction, and on random corruptions never crashes and agrees
//      across hosts.
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compile, SchemaError } from '../../host/js/src/compile.mjs';
import { vmVerify } from '../../gen/js/snug/program/verify.mjs';

const [rustBin, corrArg, seedArg] = process.argv.slice(2);
const CORRUPTIONS = Number(corrArg ?? 40), SEED = Number(seedArg ?? 7);
const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
let fails = 0;
const fail = (msg) => { fails++; if (fails <= 40) console.log(`  FAIL ${msg}`); };
const hex = b => Buffer.from(b).toString('hex');
const wordsHex = P => Array.from(P, w => (w >>> 0).toString(16).padStart(8, '0')).join('');

// ---------------------------------------------------------------- the corpus
const cases = [];
const study = JSON.parse(read('corpus/conformance/study.json'));
for (const s of study.suites)
  cases.push({ label: `study ${s.name}`, text: s.cddl ?? read('corpus/' + s.cddlFile), want: s.schemaError, later: s.phase === 'later' });
const adv = JSON.parse(read('corpus/conformance/adversarial.json'));
for (const s of adv.suites)
  cases.push({ label: `adversarial ${s.name}`, text: s.cddl, want: s.snugSchemaError });
for (const f of readdirSync(new URL('corpus/cddl-study/contracts/', root)).sort())
  cases.push({ label: `contract ${f}`, text: read('corpus/cddl-study/contracts/' + f) });
const family = w => w === undefined ? undefined : w.split(':')[0].trim();

function jsCompile(text) {
  try {
    const { program, pool } = compile(text);
    return { ok: true, program, pool };
  } catch (e) {
    if (e instanceof SchemaError) return { ok: false, code: e.code, line: e.line, column: e.column, rule: e.rule ?? '-' };
    return { crash: String(e && e.stack || e) };
  }
}
function verifyJs(P, B, cap = Math.max(P[16] ?? 1, 1)) {
  const S = new Int32Array(48 + 2 * Math.max(cap, 1) + 16);
  S[17] = Math.max(cap, 1);
  try { return [vmVerify(P, B, S), S[35], S[36]]; } catch (e) { return ['CRASH ' + e.message]; }
}

// ---------------------------------------------------------------- run both hosts
const js = cases.map(c => jsCompile(c.text));
const rustIn = cases.map(c => `0 ${hex(Buffer.from(c.text, 'utf8'))}`).join('\n') + '\n';
const rr = spawnSync(rustBin, [], { input: rustIn, maxBuffer: 1 << 30 });
if (rr.status !== 0) { console.log(`  FAIL the Rust binary exited ${rr.status}: ${rr.stderr}`); process.exit(1); }
const rust = rr.stdout.toString().trimEnd().split('\n');
if (rust.length !== cases.length) { console.log(`  FAIL Rust answered ${rust.length} of ${cases.length} cases`); process.exit(1); }

let compiled = 0, refusedAsExpected = 0, identical = 0, verified = 0;
const programs = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i], j = js[i], r = rust[i];
  if (j.crash) { fail(`${c.label}: JS threw a non-SchemaError: ${j.crash.split('\n')[0]}`); continue; }
  if (r === 'PANIC') { fail(`${c.label}: Rust panicked`); continue; }
  const f = r.split(' ');
  // identity
  if (j.ok) {
    const same = f[0] === 'ok' && f[2] === wordsHex(j.program) && (f[3] ?? '') === hex(j.pool);
    if (!same) fail(`${c.label}: JS and Rust Programs differ (${f[0]})`); else identical++;
    if (f[1] !== '0') fail(`${c.label}: the Rust verifier refused the Program (${f[1]})`);
    const v = verifyJs(j.program, j.pool);
    if (v[0] !== 0) fail(`${c.label}: the JS verifier refused the Program (${v.join(' ')})`); else verified++;
    programs.push({ label: c.label, P: j.program, B: j.pool });
  } else {
    const same = f[0] === 'err' && f[1] === j.code && Number(f[2]) === j.line && Number(f[3]) === j.column && f.slice(4).join(' ') === j.rule;
    if (!same) fail(`${c.label}: JS ${j.code} ${j.line}:${j.column} ${j.rule} vs Rust ${r}`); else identical++;
  }
  // expectations
  const want = family(c.want);
  if (c.later) continue;
  if (want !== undefined) {
    if (j.ok) fail(`${c.label}: expected a refusal (${want}), but it compiled`);
    else if (j.code !== want) fail(`${c.label}: expected ${want}, got ${j.code} at ${j.line}:${j.column}`);
    else refusedAsExpected++;
  } else if (!j.ok) fail(`${c.label}: did not compile: ${j.code} at ${j.line}:${j.column} (rule ${j.rule})`);
  else compiled++;
}
const expectRefusals = cases.filter(c => !c.later && c.want !== undefined).length;
const expectCompile = cases.filter(c => !c.later && c.want === undefined).length;
console.log(`  ${compiled === expectCompile ? 'ok  ' : 'FAIL'} ${compiled}/${expectCompile} schemas compile on both hosts`);
console.log(`  ${refusedAsExpected === expectRefusals ? 'ok  ' : 'FAIL'} ${refusedAsExpected}/${expectRefusals} expected refusals, with the expected code family`);
console.log(`  ${identical === cases.length ? 'ok  ' : 'FAIL'} ${identical}/${cases.length} identical across hosts (Programs byte for byte, errors field for field)`);
console.log(`  ${verified === programs.length ? 'ok  ' : 'FAIL'} ${verified}/${programs.length} Programs accepted by the verifier (JS and Rust)`);

// ---------------------------------------------------------------- the worked example
{
  const md = read('docs/program.md');
  const block = md.slice(md.indexOf('### 15.2 The Program (286 words)'), md.indexOf('Derived values:'));
  const want = new Array(286).fill(undefined);
  for (const line of block.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || line.trim().startsWith('7..14')) continue;
    const at = Number(m[1]);
    if (at === 30) { want[30] = 0; want[31] = 0; continue; }
    let k = 0;
    for (const t of m[2].split(/\s+/)) {
      if (!/^(-?\d+|0x[0-9a-f]+|0b[01]+)$/.test(t)) break;
      want[at + k++] = t.startsWith('-') ? -Number(t.slice(1)) : Number(t);
    }
  }
  // Words 7..14 are SOURCE_KEY, host-filled (the listing shows k0..k7): compared separately below.
  for (let k = 7; k < 15; k++) want[k] = undefined;
  const pool = block.match(/B\[[^\n]*/g);
  const wantPool = '72' + '6178' + '6179' + '646b696e64' + '6161' + '6162';
  const j = jsCompile('r = { kind: "a", x: int // kind: "b", ? y: [* tstr] }');
  const rex = spawnSync(rustBin, [], { input: `0 ${hex(Buffer.from('r = { kind: "a", x: int // kind: "b", ? y: [* tstr] }'))}\n` }).stdout.toString().trim().split(' ');
  const missing = want.some((w, i) => w === undefined && (i < 7 || i > 14));
  const okJs = j.ok && j.program.length === 286 && want.every((w, i) => w === undefined || j.program[i] === w) && hex(j.pool) === wantPool;
  const rw = rex[2] ?? '';
  const okRust = rex[0] === 'ok' && want.every((w, i) => w === undefined || rw.slice(8 * i, 8 * i + 8) === (w >>> 0).toString(16).padStart(8, '0')) && rex[3] === wantPool && j.ok && rw === wordsHex(j.program);
  if (missing || !pool) fail('could not read the worked example from docs/program.md');
  console.log(`  ${okJs && okRust && !missing ? 'ok  ' : 'FAIL'} program.md §15: ${j.ok ? j.program.length : 'no'} words, ${j.ok ? j.pool.length : 'no'}-byte pool, exactly as listed (JS ${okJs ? 'yes' : 'NO'}, Rust ${okRust ? 'yes' : 'NO'})`);
  if (!(okJs && okRust)) fails++;
}

// ---------------------------------------------------------------- arena-size independence
// The arena only grows by retry (D033): the outcome must not depend on where
// it starts. Each corpus schema from the smallest arena (many retries) and
// from a 4 Mi-word one (none) must give the same code and the same words.
{
  const M = await import('../../gen/js/snug/compile/main.mjs');
  const A = await import('../../gen/js/snug/compile/arena.mjs');
  const enc = new TextEncoder(), dec = new TextDecoder();
  const run = (text, start) => {
    const bytes = enc.encode(text), opt = new Int32Array(M.OPT_WORDS).fill(-1);
    let fl = new Int32Array(0), words = start, retries = 0;
    for (;;) {
      const h = new Int32Array(words);
      const code = M.compileSchema(bytes, opt, fl, h);
      if (code === A.ERR_ARENA) { words *= 2; retries++; continue; }
      if (code === A.ERR_NEED_FLOATS) {
        const n = M.floatRequests(h), f = new Int32Array(1 + 2 * n), dv = new DataView(new ArrayBuffer(8)); f[0] = n;
        for (let i = 0; i < n; i++) { dv.setFloat64(0, Number(dec.decode(bytes.subarray(M.floatRequestStart(h, i), M.floatRequestEnd(h, i))))); f[1 + 2 * i] = dv.getInt32(0); f[2 + 2 * i] = dv.getInt32(4); }
        fl = f; continue;
      }
      if (code !== 0) return { key: `err ${code} ${M.errorLine(h)} ${M.errorColumn(h)}`, retries };
      const p = M.outProgramAt(h);
      return { key: wordsHex(h.subarray(p, p + M.outProgramWords(h))), retries };
    }
  };
  let same = 0, retried = 0;
  for (const c of cases) {
    const small = run(c.text, A.ARENA_MIN_WORDS), big = run(c.text, 1 << 22);
    if (small.retries > 0) retried++;
    if (small.key === big.key) same++; else fail(`${c.label}: the outcome depends on the arena size`);
  }
  console.log(`  ${same === cases.length ? 'ok  ' : 'FAIL'} ${same}/${cases.length} outcomes independent of the starting arena size (${retried} needed retries)`);
}

// ---------------------------------------------------------------- SOURCE_KEY
// program.md §13.3, recomputed independently: the baseline codec encodes the
// preimage with the default effective limits, node:crypto hashes it.
{
  const { encode } = await import('../../bench/baseline/cbor-3sln.mjs');
  const { createHash } = await import('node:crypto');
  const { SNUG_VERSION } = await import('../../host/js/src/compile.mjs');
  const LIMITS = [262144, 64, 65536, 1024, 64, 256, 256, 256, 1048576, 8388608, 10000000, 32, 1500000, 65536, 131072, 128, 4000000];
  let good = 0, n = 0;
  for (const c of cases.slice(0, 60)) {
    let p; try { p = compile(c.text).program; } catch { continue; }
    n++;
    const pre = encode(['snug/program-key', 1, SNUG_VERSION, 0, LIMITS, new Uint8Array(Buffer.from(c.text, 'utf8'))]);
    const d = createHash('sha256').update(pre).digest();
    if ([0, 1, 2, 3, 4, 5, 6, 7].every(i => p[7 + i] === d.readInt32BE(4 * i))) good++;
    else fail(`${c.label}: SOURCE_KEY is not SHA-256 of the §13.3 preimage`);
  }
  console.log(`  ${good === n ? 'ok  ' : 'FAIL'} ${good}/${n} SOURCE_KEYs equal SHA-256 of program.md §13.3's preimage (baseline encoder, node:crypto)`);
}

// ---------------------------------------------------------------- normaliser structure
// Targeted reads of the Program for policies a verdict test would not show
// directly (D034): merged and sorted interval lists, LITSETs, the key table.
{
  const leafAt = (P, l) => P[43] + 8 * l;
  const ints = (P, l) => { const o = leafAt(P, l), out = []; for (let i = 0; i < P[o + 3]; i++) { const q = P[55] + 6 * (P[o + 2] + i); out.push(`${P[q + 2]}..${P[q + 5]}`); } return out.join(' '); };
  const litset = (P, B, l) => { const o = leafAt(P, l), out = []; for (let i = 0; i < P[o + 3]; i++) { const q = P[57] + 2 * (P[o + 2] + i); out.push(hex(B.subarray(P[q], P[q] + P[q + 1]))); } return out.join(' '); };
  const keys = (P, B) => { const out = []; for (let i = 0; i < P[18]; i++) { const q = P[46] + 2 * i; out.push(hex(B.subarray(P[q], P[q] + P[q + 1]))); } return out.join(' '); };
  const checks = [
    ['r = 15 / 0 / 9 / 3 / 12 / 6', c => c.program[16] === 1 && ints(c.program, 0) === '0..0 3..3 6..6 9..9 12..12 15..15'],
    ['r = 0..3 / 4..6 / 10 / 7', c => c.program[16] === 1 && ints(c.program, 0) === '0..7 10..10'],
    ['r = ' + Array.from({ length: 300 }, (_, i) => String((i * 7919) % 1000 * 3)).join(' / '), c => c.program[16] === 1 && c.program[leafAt(c.program, 0) + 3] === 300],
    ['r = "b" / "a" / "c" / "a"', c => (c.program[c.program[43]] & 255) === 7 && litset(c.program, c.pool, 0) === '6161 6162 6163'],
    ['r = { b: int, a: int, c: int }', c => keys(c.program, c.pool) === '6161 6162 6163'],
    ['r = float16 / float32 / float64', c => c.program[16] === 1 && (c.program[c.program[43]] & 255) === 4 && (c.program[c.program[43]] >> 8) === 7],
  ];
  let good = 0;
  for (const [t, ok] of checks) {
    let c; try { c = compile(t); } catch (e) { fail(`structure ${JSON.stringify(t.slice(0, 40))}: ${e.code ?? e}`); continue; }
    if (ok(c)) good++; else fail(`structure ${JSON.stringify(t.slice(0, 40))}: unexpected Program shape`);
  }
  console.log(`  ${good === checks.length ? 'ok  ' : 'FAIL'} ${good}/${checks.length} normaliser structure checks (merged intervals, LITSETs, key order)`);
}

// ---------------------------------------------------------------- profiles (architecture §5.3)
// [profile, schema, expected code or 'ok']. Profiles only refuse; whatever a
// profile accepts compiles to the same Program under `full` (checked below).
const PROFILE_CASES = [
  ['bindle', '$x /= int\nr = [* $x]', 'profile'],
  ['bindle', 'r = [* $undefined]', 'profile'],
  ['bindle', 'r = {a: int, $$more}', 'profile'],
  ['bindle', 'r = bstr .cborseq [* int]', 'profile'],
  ['bindle', 'base = [int]\nr = [~base]', 'profile'],
  ['bindle', 'r = {"a" ^ => int}', 'profile'],
  ['bindle', 'l<T> = [* T] / [T, l<T>]\nr = l<int>', 'profile'],
  ['bindle', 'r = {bstr => int}', 'profile'],
  ['bindle', "r = {h'00': int}", 'profile'],
  ['bindle', 'r = {uint => int, tstr => any}', 'ok'],
  ['bindle', 'pair<A,B> = (A, B)\nlist<T> = [* T]\nr = [pair<uint, list<tstr>>]', 'ok'],
  ['bindle', 'r = tstr .regexp "[a-z]+"', 'ok'],
  ['bindle', 'n = {v: int, ? k: [* n]}\nr = n', 'ok'],
  ['bus', 'r = tstr .regexp "a"', 'profile'],
  ['bus', 'r = tstr', 'profile'],
  ['bus', 'r = [* int]', 'profile'],
  ['bus', 'r = {* tstr .size 1 => int}', 'profile'],
  ['bus', 'n = {v: int, ? k: [0*2 n]}\nr = n', 'profile'],
  ['bus', 'r = any', 'profile'],
  ['bus', 'r = [#4]', 'profile'],
  ['bus', 'r = bstr .cbor int', 'profile'],
  ['bus', 'r = ' + '"' + 'x'.repeat(17000) + '"', 'limit_schema_bytes'],
  ['bus', 'r = tstr .size (0..10)', 'ok'],
  ['bus', 'r = [0*10 int, ? bool]', 'ok'],
  ['bus', 'r = {a: int, ? b: tstr .size 3, 1*4 uint => bstr .size (0..8)}', 'ok'],
  ['bus', 'r = (bstr .size (0..64)) .cbor [int, tstr .size 1]', 'ok'],
  ['bus', 'r = int / float / bool / null / #6.1(int) / 0..9 / "a" / h\'00\'', 'ok'],
];
{
  const pin = PROFILE_CASES.map(([p, t]) => `${{ full: 0, bindle: 1, bus: 2 }[p]} ${hex(Buffer.from(t, 'utf8'))}`).join('\n') + '\n';
  const pr = spawnSync(rustBin, [], { input: pin, maxBuffer: 1 << 30 }).stdout.toString().trimEnd().split('\n');
  let good = 0;
  PROFILE_CASES.forEach(([p, t, want], i) => {
    let got, prog;
    try { const c = compile(t, { profile: p }); got = 'ok'; prog = c; } catch (e) { got = e instanceof SchemaError ? e.code : 'CRASH ' + e; }
    const r = pr[i].split(' ');
    const rgot = r[0] === 'ok' ? 'ok' : r[1];
    let same = got === rgot && (got !== 'ok' || r[2] === wordsHex(prog.program));
    // what a profile accepts means the same as under full (only the PROFILE header word differs)
    if (got === 'ok') {
      const full = compile(t, { profile: 'full' });
      const a = Int32Array.from(prog.program), b = Int32Array.from(full.program);
      // PROFILE (word 5) and SOURCE_KEY (7..14, which hashes the profile and limits) may differ.
      for (const w of [5, 7, 8, 9, 10, 11, 12, 13, 14]) { a[w] = 0; b[w] = 0; }
      if (wordsHex(a) !== wordsHex(b) || hex(prog.pool) !== hex(full.pool)) { same = false; fail(`profile ${p} ${JSON.stringify(t.slice(0, 50))}: differs from full`); }
    }
    if (got === want && same) good++;
    else fail(`profile ${p} ${JSON.stringify(t.slice(0, 50))}: want ${want}, JS ${got}, Rust ${rgot}`);
  });
  console.log(`  ${good === PROFILE_CASES.length ? 'ok  ' : 'FAIL'} ${good}/${PROFILE_CASES.length} profile cases (bindle, bus) on both hosts; accepted ones identical to full`);
}

// ---------------------------------------------------------------- verifier corruptions
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const rnd = rng(SEED), ri = n => Math.floor(rnd() * n);
const sure = [], random = [];
for (const { label, P, B } of programs) {
  const nl = P[16];
  const mut = (f) => { const Q = Int32Array.from(P); const C = Uint8Array.from(B); const r = f(Q, C); return r ?? { P: Q, B: C }; };
  // invalid by construction
  sure.push([label + ' magic', mut(Q => { Q[0] ^= 1; })]);
  sure.push([label + ' words', mut(Q => { Q[3] += 1; })]);
  sure.push([label + ' truncated', mut(Q => ({ P: Q.slice(0, Q.length - 1), B }))]);
  sure.push([label + ' pool', mut((Q, C) => ({ P: Q, B: Uint8Array.from([...C, 0]) }))]);
  sure.push([label + ' scratch max', mut(Q => { Q[40] += 1; })]);
  if (nl > 0) sure.push([label + ' mask', mut(Q => { const at = Q[43] + 8 * ri(nl) + 1; Q[at] ^= 0x1000; })]);
  if (Q => true) sure.push([label + ' section', mut(Q => { Q[42 + 1 + ri(19)] += 1; })]);
  if (P[15] > 0) sure.push([label + ' rule typeset', mut(Q => { Q[Q[42] + 2] = Q[17]; })]);
  if (P[17] > 0) sure.push([label + ' typeset index', mut(Q => { Q[Q[44] + ri(Q[17])] += 1; })]);
  // random words: never crash, same answer on both hosts
  for (let k = 0; k < CORRUPTIONS; k++) {
    random.push([label + ' random ' + k, mut(Q => {
      const n = 1 + ri(3);
      for (let q = 0; q < n; q++) {
        const at = ri(Q.length);
        const kind = ri(4);
        Q[at] = kind === 0 ? Q[at] + 1 : kind === 1 ? Q[at] - 1 : kind === 2 ? ri(65536) - 32768 : (Q[at] ^ (1 << ri(31)));
      }
    })]);
  }
}
const all = [...sure, ...random];
// The mark cap a host would use: N_LEAVES clamped to program.md's 2^20 (a host must not size memory from an
// unverified word).
const capOf = P => Math.min(Math.max(P[16] ?? 1, 1), 1 << 20);
const vin = all.map(([, m]) => `V ${wordsHex(m.P)} ${hex(m.B)} ${capOf(m.P)}`).join('\n') + '\n';
const vr = spawnSync(rustBin, [], { input: vin, maxBuffer: 1 << 30 }).stdout.toString().trimEnd().split('\n');
let refused = 0, agree = 0, crashes = 0;
all.forEach(([label, m], i) => {
  const jv = verifyJs(m.P, m.B, capOf(m.P));
  const r = vr[i];
  if (typeof jv[0] === 'string' || r === 'PANIC') { crashes++; fail(`${label}: the verifier crashed (${jv[0]} / ${r})`); return; }
  if (r === `v ${jv[0]} ${jv[1]} ${jv[2]}`) agree++; else fail(`${label}: JS verify ${jv.join(" ")} vs Rust ${r} (N_LEAVES ${m.P[16]}, len ${m.P.length})`);
  if (i < sure.length) { if (jv[0] !== 0) refused++; else fail(`${label}: an invalid Program was accepted`); }
});
console.log(`  ${refused === sure.length ? 'ok  ' : 'FAIL'} ${refused}/${sure.length} seeded invalid Programs refused`);
console.log(`  ${crashes === 0 && agree === all.length ? 'ok  ' : 'FAIL'} ${all.length - sure.length} random corruptions: no crash, ${agree}/${all.length} verdicts identical across hosts`);

if (fails) { console.log(`  FAIL ${fails} failure(s)`); process.exit(1); }
console.log('  ok   compile-test');
