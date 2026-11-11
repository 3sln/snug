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
import { scan, scanCb, scanOptions, scanProfile, errorOffset, codeName } from '../../gen/js/snug/cbor/scan.mjs';
import { buildDetCases, optWords, DDEF } from './det-cases.mjs';
import { loadCbor2, acceptanceDiff, encodeDiff } from './det-diff.mjs';
import { encode as snugEncode } from '../../host/js/src/encode.mjs';
import { Tagged as SnugTagged } from '../../host/js/src/values.mjs';
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
// ---------------------------------------------------------------- the profile options (P7.1, D120-D125)
// The deterministic vectors (hand-written codes and offsets, and the Bindle code of the same bytes), fixed edge
// cases of the new rules and seeded cases under random profile flags: JS == the vector, JS == Rust (code and
// offset), and the deterministic preset against cbor2 (kin/scripts/det-diff.mjs).
const DET_MUT = Math.max(2000, Math.round(MUTATIONS * 2 / 3));
const dc = buildDetCases(DET_MUT, SEED, { valid: true });
// The profile options need the walk's scratch past o's 16 words and a canonical buffer (D264): a marked map's
// duplicate check (an EC-sensitive key, D263) can need them under any profile. Grown on CODE_SCRATCH (22).
let o2 = new Int32Array(16 + 64), cb2 = new Uint8Array(64);
const detRun = (bytes, opt) => {
  for (;;) {
    scanOptions(o2, ...optWords(opt)); scanProfile(o2, opt.flags);
    const c = scanCb(bytes, o2, cb2);
    if (c !== 22) return { code: c, name: codeName(c), offset: errorOffset(o2) };
    const nw = o2[13], nb = o2[14];
    if (nw > o2.length) o2 = new Int32Array(Math.max(nw, 2 * o2.length));
    if (nb > cb2.length) cb2 = new Uint8Array(Math.max(nb, 2 * cb2.length));
  }
};
const dj = dc.cases.map(c => detRun(c.bytes, c.opt));
let detVec = 0, detFail = 0;
dc.cases.forEach((c, i) => {
  if (!c.want) return;
  detVec++;
  if (dj[i].name !== c.want.code || (c.want.offset !== undefined && dj[i].offset !== c.want.offset)) { detFail++; fail(`${c.label}: JS ${dj[i].name}@${dj[i].offset}, vector ${c.want.code}@${c.want.offset}`); }
});
console.log(`  ${detFail ? 'FAIL' : 'ok  '} profile options: ${detVec - detFail}/${detVec} deterministic vectors (and their Bindle column) give the hand-written code and offset; ${dc.nFixed} fixed and ${DET_MUT} seeded cases under random profile flags`);
const detCounts = {};
for (const g of dj) detCounts[g.name] = (detCounts[g.name] ?? 0) + 1;
console.log(`  info profile-option codes: ${Object.entries(detCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (rustBin) {
  const input = dc.cases.map(c => [...optWords(c.opt), c.bytes.length ? hex(c.bytes) : '', c.opt.flags].join(' ')).join('\n') + '\n';
  const p = spawnSync(rustBin, [], { input, maxBuffer: 1 << 30, encoding: 'utf8' });
  const lines = p.stdout.trim().split('\n');
  let agree = 0;
  if (p.status !== 0 || lines.length !== dc.cases.length) fail(`Rust profile-option run: status ${p.status}, ${lines.length} of ${dc.cases.length} lines`);
  lines.forEach((line, i) => {
    if (line === 'PANIC') { fail(`${dc.cases[i].label}: Rust PANICKED`); return; }
    const [code, off] = line.split(' ').map(Number);
    if (code !== dj[i].code || off !== dj[i].offset) fail(`${dc.cases[i].label}: JS ${dj[i].code}@${dj[i].offset}, Rust ${code}@${off}`); else agree++;
  });
  console.log(`  ${agree === dc.cases.length ? 'ok  ' : 'FAIL'} profile options JS == Rust (debug): ${agree}/${dc.cases.length} cases, code and offset, no panic`);
}
const cbor2 = await loadCbor2();
if (cbor2) {
  const isDef = o => o.flags === DDEF.flags && o.top === 'any' && !o.cose && o.maxBytes === DDEF.maxBytes && o.maxDepth === DDEF.maxDepth && o.maxEntries === DDEF.maxEntries && o.maxItems === DDEF.maxItems;
  const pool = [...dc.cases.filter(c => isDef(c.opt)), ...cases.map(c => ({ label: c.label, bytes: c.bytes, opt: DDEF }))];
  const ad = acceptanceDiff(cbor2, pool, b => { const g = detRun(b, DDEF); return { code: g.name, offset: g.offset }; });
  for (const u of ad.unexplained.slice(0, 20)) fail(`cbor2: unexplained ${u}`);
  console.log(`  ${ad.unexplained.length ? 'FAIL' : 'ok  '} deterministic preset vs cbor2 (CDE + rejectDuplicateKeys/LongLoundNaN): ${ad.agree}/${ad.compared} same verdict; the rest by documented class: ${Object.entries(ad.classes).map(([k, v]) => `${k} ${v}`).join(', ')}; ${ad.unexplained.length} unexplained`);
  const ed = encodeDiff(cbor2, v => snugEncode(v), 4000, SEED, { Tagged: SnugTagged });
  for (const d of ed.differ.slice(0, 20)) fail(`cbor2 encode: ${d}`);
  console.log(`  ${ed.differ.length ? 'FAIL' : 'ok  '} encode (deterministic preset) == cbor2 encode({cde: true}): ${ed.equal}/${ed.values} seeded values byte for byte (${ed.tags} holding tags of any number)`);
} else console.log('  SKIP cbor2 differential (bench/compare/node_modules/cbor2 not installed)');

if (fails) { console.log(`  FAIL ${fails} failure(s)`); process.exit(1); }
console.log('  ok   generated JS and Rust agree with cbor.mjs on every case');
