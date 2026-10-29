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
  for (let k = 7; k < 15; k++) want[k] = 0;
  const pool = block.match(/B\[[^\n]*/g);
  const wantPool = '72' + '6178' + '6179' + '646b696e64' + '6161' + '6162';
  const j = jsCompile('r = { kind: "a", x: int // kind: "b", ? y: [* tstr] }');
  const rex = spawnSync(rustBin, [], { input: `0 ${hex(Buffer.from('r = { kind: "a", x: int // kind: "b", ? y: [* tstr] }'))}\n` }).stdout.toString().trim().split(' ');
  const missing = want.some(w => w === undefined);
  const okJs = j.ok && j.program.length === 286 && want.every((w, i) => j.program[i] === w) && hex(j.pool) === wantPool;
  const okRust = rex[0] === 'ok' && rex[2] === wordsHex(Int32Array.from(want)) && rex[3] === wantPool;
  if (missing || !pool) fail('could not read the worked example from docs/program.md');
  console.log(`  ${okJs && okRust && !missing ? 'ok  ' : 'FAIL'} program.md §15: ${j.ok ? j.program.length : 'no'} words, ${j.ok ? j.pool.length : 'no'}-byte pool, exactly as listed (JS ${okJs ? 'yes' : 'NO'}, Rust ${okRust ? 'yes' : 'NO'})`);
  if (!(okJs && okRust)) fails++;
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
