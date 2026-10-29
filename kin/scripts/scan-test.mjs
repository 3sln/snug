// bb scan-test: the generated CBOR profile scanner, JS and Rust, against
// cbor.mjs (bench/baseline/cbor-3sln.mjs, the read-only arbiter).
//
//     node kin/scripts/scan-test.mjs <rust-scan-binary> [mutations] [seed]
//
// Cases, each with decode options:
//   1. corpus/cbor-vectors/cbor-profile.json: accept -> 0, refuse -> its code;
//   2. corpus/cbor-vectors/cbor-cborg-oracle.json: cbor.mjs's own verdict;
//   3. fixed edge cases (resource bounds at and one past each limit, cose,
//      top-level map, precedence on multiply-invalid inputs);
//   4. SEEDED MUTATIONS: random profile values encoded by cbor.mjs, then 1..3
//      mutations each (bit flips, special head bytes, inserts, deletes,
//      truncation, slice duplication), plus random short byte strings, under
//      random options including small limits.
// Every case: the expected code is cbor.mjs's CBORFault code ('ok' when it
// accepts) -- named vectors must also agree with cbor.mjs -- and BOTH the
// generated JS and the Rust build must return it, with the same error offset
// on JS and Rust. Prints ok/FAIL lines; exits 1 on any failure.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { decode, CBORFault } from '../../bench/baseline/cbor-3sln.mjs';
import { buildCases, hex, DEF, ANY } from './scan-cases.mjs';
import { scan, scanOptions, errorOffset, codeName } from '../../gen/js/snug/cbor/scan.mjs';
// The hand-written P1.4 yardstick is held to the same arbiter, so the
// benchmark compares two correct scanners.
import { scanHand } from '../../bench/scan-hand.mjs';

const [rustBin, mutArg, seedArg] = process.argv.slice(2);
const MUTATIONS = Number(mutArg ?? 30000), SEED = Number(seedArg ?? 1);

function baseline(bytes, opt) {
  try { decode(bytes, opt); return 'ok'; }
  catch (e) { if (e instanceof CBORFault) return e.code; throw e; }
}
const o = new Int32Array(16);
const clamp = n => Math.min(n, 0x7fffffff);
function generated(bytes, opt) {
  scanOptions(o, opt.top === 'any' ? 1 : 0, opt.cose ? 1 : 0, clamp(opt.maxBytes), clamp(opt.maxDepth), clamp(opt.maxEntries), clamp(opt.maxItems));
  const c = scan(bytes, o);
  return { code: c, name: codeName(c), offset: errorOffset(o) };
}

const { cases, nVectors, nFixed, profile, oracle } = buildCases(MUTATIONS, SEED);

// ---------------------------------------------------------------- run
let fails = 0;
const fail = (msg) => { if (fails < 40) console.log('  FAIL ' + msg); fails++; };
const js = [];
const t0 = performance.now();
for (const c of cases) {
  const want = baseline(c.bytes, c.opt);
  if (c.want !== undefined && c.want !== want) fail(`${c.label}: the vector says ${c.want}, cbor.mjs says ${want}`);
  c.want = want;
  const g = generated(c.bytes, c.opt);
  js.push(g);
  if (g.name !== want) fail(`${c.label} [${hex(c.bytes).slice(0, 80)}] ${JSON.stringify(c.opt)}: JS ${g.name}, cbor.mjs ${want}`);
  if ((g.code === 0) !== (g.offset === -1)) fail(`${c.label}: JS offset ${g.offset} with code ${g.code}`);
}
const tJs = performance.now() - t0;
let handOk = 0;
for (const c of cases) {
  const h = codeName(scanHand(c.bytes, c.opt));
  if (h !== c.want) fail(`${c.label} [${hex(c.bytes).slice(0, 80)}] ${JSON.stringify(c.opt)}: hand-written JS ${h}, cbor.mjs ${c.want}`);
  else handOk++;
}

// JS never reads out of bounds: re-run cases with the input behind a Proxy
// that throws on any index read outside 0..length-1 (an out-of-bounds read of
// a Uint8Array is a silent `undefined`, so it has to be made loud to be seen).
let guarded = 0;
for (const c of cases) {
  if (c.bytes.length > 4096 || guarded >= 20000) continue;
  const raw = c.bytes;
  const trap = new Proxy(raw, { get(t, k) {
    if (typeof k === 'string' && /^-?[0-9]+$/.test(k)) { const i = Number(k); if (i < 0 || i >= t.length) throw new Error(`out-of-bounds read b[${i}] of ${t.length}`); return t[i]; }
    const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; } });
  try { const g = generated(trap, c.opt); if (g.name !== c.want) fail(`${c.label}: guarded JS ${g.name}`); }
  catch (e) { fail(`${c.label} [${hex(raw).slice(0, 80)}]: ${e.message}`); }
  guarded++;
}
const counts = {};
for (const c of cases) counts[c.want] = (counts[c.want] ?? 0) + 1;

let rustLine = '  SKIP Rust (no binary given)';
if (rustBin) {
  const input = cases.map(c => [c.opt.top === 'any' ? 1 : 0, c.opt.cose ? 1 : 0, clamp(c.opt.maxBytes), clamp(c.opt.maxDepth),
    clamp(c.opt.maxEntries), clamp(c.opt.maxItems), hex(c.bytes)].join(' ')).join('\n') + '\n';
  const t1 = performance.now();
  const p = spawnSync(rustBin, [], { input, maxBuffer: 1 << 30, encoding: 'utf8' });
  const tRs = performance.now() - t1;
  if (p.status !== 0) { fail(`the Rust binary exited ${p.status}: ${p.stderr}`); }
  const lines = p.stdout.trim().split('\n');
  if (lines.length !== cases.length) fail(`Rust answered ${lines.length} of ${cases.length} cases`);
  let agree = 0;
  lines.forEach((line, i) => {
    const c = cases[i], g = js[i];
    if (line === 'PANIC') { fail(`${c.label} [${hex(c.bytes).slice(0, 80)}]: Rust PANICKED`); return; }
    const [code, off] = line.split(' ').map(Number);
    if (codeName(code) !== c.want) fail(`${c.label} [${hex(c.bytes).slice(0, 80)}] ${JSON.stringify(c.opt)}: Rust ${codeName(code)}, cbor.mjs ${c.want}`);
    else if (code !== g.code || off !== g.offset) fail(`${c.label}: JS ${g.code}@${g.offset}, Rust ${code}@${off}`);
    else agree++;
  });
  rustLine = `  ${agree === cases.length ? 'ok  ' : 'FAIL'} Rust (debug, overflow checks on): ${agree}/${cases.length} cases with cbor.mjs's code and JS's offset, no panic (${(tRs / 1000).toFixed(1)} s)`;
}
// The wasm build (kin/scripts/wasm-build), when given: the same cases through
// the same kin source compiled Rust -> wasm32, code and offset.
let wasmLine = '  SKIP wasm (SNUG_SCAN_WASM not set)';
if (process.env.SNUG_SCAN_WASM) {
  const { instance } = await WebAssembly.instantiate(readFileSync(process.env.SNUG_SCAN_WASM));
  const ex = instance.exports, ptr = ex.snug_buf(), cap = ex.snug_cap();
  let agree = 0, tried = 0;
  cases.forEach((c, i) => {
    if (c.bytes.length > cap) return;
    tried++;
    new Uint8Array(ex.memory.buffer, ptr, cap).set(c.bytes);
    const code = ex.snug_scan(c.bytes.length, c.opt.top === 'any' ? 1 : 0, c.opt.cose ? 1 : 0, clamp(c.opt.maxBytes),
      clamp(c.opt.maxDepth), clamp(c.opt.maxEntries), clamp(c.opt.maxItems));
    const off = ex.snug_err();
    if (codeName(code) !== c.want) fail(`${c.label}: wasm ${codeName(code)}, cbor.mjs ${c.want}`);
    else if (code !== js[i].code || off !== js[i].offset) fail(`${c.label}: JS ${js[i].code}@${js[i].offset}, wasm ${code}@${off}`);
    else agree++;
  });
  wasmLine = `  ${agree === tried ? 'ok  ' : 'FAIL'} wasm (release, Rust -> wasm32): ${agree}/${tried} cases with cbor.mjs's code and JS's offset`;
}
console.log(`  cases: ${nVectors} vectors (${profile.accept.length} accept + ${profile.refuse.length} refuse profile, ${oracle.cases.length} cborg oracle), ${nFixed} fixed edge cases, ${MUTATIONS} seeded mutations (seed ${SEED})`);
console.log(`  expected codes: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  ${fails ? 'FAIL' : 'ok  '} JS: ${cases.length - js.filter((g, i) => g.name !== cases[i].want).length}/${cases.length} cases with cbor.mjs's code (${(tJs / 1000).toFixed(1)} s incl. cbor.mjs)`);
console.log(`  ${handOk === cases.length ? 'ok  ' : 'FAIL'} bench/scan-hand.mjs (the P1.4 yardstick): ${handOk}/${cases.length} cases with cbor.mjs's code`);
console.log(`  ${fails ? 'FAIL' : 'ok  '} JS bounds: ${guarded} cases re-run with a throwing out-of-bounds trap on the input`);
console.log(rustLine);
console.log(wasmLine);
if (fails) { console.log(`  FAIL ${fails} failure(s)`); process.exit(1); }
console.log('  ok   generated JS and Rust agree with cbor.mjs on every case');
