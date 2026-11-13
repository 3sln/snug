// bb rscan-test: the RESUMABLE scanner (kin/rscan.kin, P6.1) against the
// recursive one (kin/scan.kin, itself held to cbor.mjs by bb scan-test).
//
//     node kin/scripts/rscan-test.mjs <rust-rscan-binary> [mutations] [seed]
//
// Every case of bb scan-test's list (vectors, fixed edge cases, seeded
// mutations) is run through the resumable scanner under several window
// policies; each run must give the recursive scanner's code, error offset and
// item count. Policies (`max_chunk`, `quantum`):
//   whole        the whole message as one window, no yields
//   1-byte       every window as small as the scanner allows (1 byte or its NEED)
//   random 7 / 300 / 4096   window sizes drawn from a seeded xorshift32
//   tiny quanta  yields after 1..3 work units, on random and whole windows
// plus, for every case of at most 48 bytes, a split at EVERY offset (window
// [0, k), then the rest). Each new window starts exactly at the offset asked
// for, so nothing before it is available: the key arena is exercised. A
// window is a fresh COPY of its bytes, and a sample of runs goes through a
// throwing out-of-bounds trap. The same runs go through the Rust build (debug,
// overflow checks on): JS and Rust must agree on code, offset, items and the
// number of steps, with no panic.
import { spawnSync } from 'node:child_process';
import { scan, scanOptions, scanProfile, errorOffset, itemsScanned, codeName } from '../../gen/js/snug/cbor/scan.mjs';
import { buildDetCases } from './det-cases.mjs';
import { rscanInit, rscanStep, rscanNeedOffset, rscanNeedLength, rscanPosition, rscanScratchLen,
  RS_NEED, RS_YIELD } from '../../gen/js/snug/cbor/rscan.mjs';
import { buildCases, hex } from './scan-cases.mjs';

const [rustBin, mutArg, seedArg] = process.argv.slice(2);
const MUTATIONS = Number(mutArg ?? 20000), SEED = Number(seedArg ?? 1);
const clamp = n => Math.min(n, 0x7fffffff);
const optArr = opt => [opt.top === 'any' ? 1 : 0, opt.cose ? 1 : 0, clamp(opt.maxBytes), clamp(opt.maxDepth), clamp(opt.maxEntries), clamp(opt.maxItems)];

function recursive(bytes, opt) {
  const o = new Int32Array(16);
  scanOptions(o, ...optArr(opt));
  scanProfile(o, opt.flags ?? 0);
  const c = scan(bytes, o);
  return { code: c, offset: errorOffset(o), items: itemsScanned(o) };
}

const trapped = b => new Proxy(b, { get(t, k) {
  if (typeof k === 'string' && /^-?[0-9]+$/.test(k)) { const i = Number(k); if (i < 0 || i >= t.length) throw new Error(`out-of-bounds read w[${i}] of ${t.length}`); return t[i]; }
  const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; } });

/** The resumable scanner under a window policy; `windows` overrides the policy with a fixed first cut. */
function resumable(bytes, opt, maxChunk, quantum, seed, { firstCut = -1, trap = false } = {}) {
  const o = new Int32Array(16), oa = optArr(opt);
  scanOptions(o, ...oa);
  scanProfile(o, opt.flags ?? 0);
  const total = bytes.length;
  const s = new Int32Array(rscanScratchLen(oa[3], Math.min(total, oa[2])));
  rscanInit(o, s, total, quantum);
  let x = seed >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  const pick = (base, need) => {
    if (maxChunk === 0) return total - base;
    return Math.min(Math.max(need, 1 + (rnd() % maxChunk)), total - base);
  };
  let base = 0, len = firstCut >= 0 ? firstCut : pick(0, 1), steps = 0;
  for (;;) {
    if (++steps > 10 * total + 1000) return { code: -99, offset: -1, items: -1, steps };
    let w = bytes.slice(base, base + len);
    if (trap) w = trapped(w);
    const r = rscanStep(w, o, s, 0, base);
    if (r === RS_NEED) {
      base = rscanNeedOffset(s);
      const need = rscanNeedLength(s);
      len = firstCut >= 0 ? total - base : pick(base, need);
      if (len < need) return { code: -98, offset: -1, items: -1, steps };
    } else if (r === RS_YIELD) {
      base = rscanPosition(s);
      len = firstCut >= 0 ? total - base : pick(base, 1);
    } else return { code: r, offset: errorOffset(o), items: itemsScanned(o), steps };
  }
}

const POLICIES = [[0, 0], [1, 0], [7, 0], [300, 0], [4096, 0], [7, 1], [300, 3], [0, 2]];
const { cases, nVectors, nFixed } = buildCases(MUTATIONS, SEED);
// Maps aimed at the key arena: nested maps with long text keys (longer than
// many windows), and keys out of order or repeated at every level.
{
  let x = (SEED * 2654435761) >>> 0 || 1;
  const rnd = n => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
  const head = (major, n) => n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : [major << 5 | 25, n >> 8, n & 255];
  const keyBytes = k => { const t = Buffer.from(k, 'utf8'); return [...head(3, t.length), ...t]; };
  const cmp = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };
  const map = depth => {
    const n = rnd(5);
    let keys = [];
    for (let i = 0; i < n; i++) { const len = rnd(4) === 0 ? 100 + rnd(400) : rnd(12); keys.push(keyBytes(String.fromCharCode(97 + rnd(3)).repeat(len) + (rnd(3) ? 'é' : ''))); }
    keys.sort(cmp);
    keys = keys.filter((k, i) => i === 0 || cmp(keys[i - 1], k) !== 0);
    const mode = rnd(8);
    if (mode === 0 && keys.length > 1) { const i = rnd(keys.length - 1); [keys[i], keys[i + 1]] = [keys[i + 1], keys[i]]; }
    if (mode === 1 && keys.length > 0) { const i = rnd(keys.length); keys.splice(i, 0, keys[i]); }
    const out = head(5, keys.length);
    for (const k of keys) { out.push(...k); out.push(...(depth < 4 && rnd(2) ? map(depth + 1) : head(0, rnd(30)))); }
    return out;
  };
  for (let i = 0; i < 600; i++) cases.push({ label: `arena map ${i}`, bytes: Uint8Array.from(map(0)), opt: { top: 'map', cose: false, maxBytes: 1_500_000, maxDepth: 32, maxEntries: 65_536, maxItems: 131_072 } });
}
// The profile options (P7.1, D120): the deterministic vectors, their fixed edge cases and seeded cases under random
// profile flags (kin/scripts/det-cases.mjs), through every policy as well.
const DET_MUT = Math.max(1500, Math.round(MUTATIONS / 2));
const dc = buildDetCases(DET_MUT, SEED, { valid: true });
for (const c of dc.cases) cases.push(c);
let fails = 0, runs = 0, everyRuns = 0, trapRuns = 0;
const fail = m => { if (fails < 30) console.log('  FAIL ' + m); fails++; };
// P8.4 (D266): the resumable scanner hands a valid-CBOR handle, or one with an EC-sensitive key (whose
// duplicates need EC forms: the recursive scanner then needs its buffer, scratch), to the session: scratch (22)
// is right for a valid-CBOR profile, where the recursive scanner says scratch, or where it refuses (later)
const same = (a, b, opt = {}) => (a.code === 22 && (b.code === 22 || b.code !== 0 || ((opt.flags ?? 0) & 256) !== 0))
  || (a.code === b.code && a.offset === b.offset && a.items === b.items);
const show = v => `${codeName(v.code)}@${v.offset} items ${v.items}`;
const rustLines = [], rustWant = [];
const t0 = performance.now();
cases.forEach((c, ci) => {
  if (c.bytes.length > 4096 && ci % 8) return;  // the big edge cases: a sample of policies
  const want = recursive(c.bytes, c.opt);
  // P9.13 WP3 (S6): a case with a written-down verdict (det-cases' vectors and depth boundaries)
  // holds the recursive scan to it too, so a wrong rule shared by both scanners still fails here
  if (c.want && typeof c.want === 'object' && want.code !== 22 && (codeName(want.code) !== c.want.code || (c.want.offset !== undefined && want.offset !== c.want.offset)))
    fail(`${c.label}: recursive ${show(want)}, the vector says ${c.want.code}@${c.want.offset}`);
  POLICIES.forEach(([mc, q], pi) => {
    if (c.bytes.length > 4096 && mc === 1) return;  // 1-byte windows over 1.5 MB: covered by smaller cases
    const seed = (ci * 31 + pi * 7 + SEED) >>> 0;
    const trap = ci % 5 === 0 && c.bytes.length <= 4096;
    const got = resumable(c.bytes, c.opt, mc, q, seed, { trap });
    runs++; if (trap) trapRuns++;
    if (!same(got, want, c.opt)) fail(`${c.label} [${hex(c.bytes).slice(0, 60)}] policy ${mc}/${q}: resumable ${show(got)}, recursive ${show(want)}`);
    if (c.bytes.length <= 4096) { rustLines.push([...optArr(c.opt), mc, q, seed, hex(c.bytes), c.opt.flags ?? 0].join(' ')); rustWant.push({ ...got, label: c.label, mc, q }); }
  });
  if (c.bytes.length <= 48) for (let k = 0; k <= c.bytes.length; k++) {
    let got;
    try { got = resumable(c.bytes, c.opt, 0, 0, 1, { firstCut: k, trap: true }); } catch (e) { fail(`${c.label} cut ${k}: ${e.message}`); continue; }
    everyRuns++;
    if (!same(got, want, c.opt)) fail(`${c.label} [${hex(c.bytes)}] cut at ${k}: resumable ${show(got)}, recursive ${show(want)}`);
  }
});
const tJs = performance.now() - t0;
console.log(`  cases: ${cases.length} (${nVectors} vectors, ${nFixed} fixed, ${MUTATIONS} mutations, seed ${SEED}; profile options: ${dc.nVectors} vector runs, ${dc.nFixed} fixed, ${DET_MUT} seeded under random flags); policies max_chunk/quantum ${POLICIES.map(p => p.join('/')).join(', ')}`);
console.log(`  ${fails ? 'FAIL' : 'ok  '} JS resumable == recursive (code, offset, items): ${runs} policy runs (${trapRuns} behind an out-of-bounds trap) + ${everyRuns} split-at-every-offset runs (${(tJs / 1000).toFixed(1)} s)`);

if (rustBin) {
  const p = spawnSync(rustBin, [], { input: rustLines.join('\n') + '\n', maxBuffer: 1 << 30, encoding: 'utf8' });
  if (p.status !== 0) fail(`the Rust binary exited ${p.status}: ${p.stderr}`);
  const lines = p.stdout.trim() === '' ? [] : p.stdout.trim().split('\n');
  // P9.13 WP3 (B2): one answer per run, no more and no fewer (a short answer used to pass)
  if (lines.length !== rustLines.length) fail(`the Rust binary answered ${lines.length} line(s) for ${rustLines.length} runs`);
  let agree = 0;
  lines.forEach((line, i) => {
    const w = rustWant[i];
    if (line === 'PANIC') { fail(`${w.label} policy ${w.mc}/${w.q}: Rust PANICKED`); return; }
    const [code, offset, items, steps] = line.split(' ').map(Number);
    if (code !== w.code || offset !== w.offset || items !== w.items || steps !== w.steps)
      fail(`${w.label} policy ${w.mc}/${w.q}: JS ${show(w)} in ${w.steps} steps, Rust ${code}@${offset} items ${items} in ${steps} steps`);
    else agree++;
  });
  if (agree !== rustLines.length) fail(`Rust resumable: ${agree}/${rustLines.length} runs identical to JS`);
  console.log(`  ${agree === rustLines.length ? 'ok  ' : 'FAIL'} Rust resumable (debug, overflow checks on): ${agree}/${rustLines.length} runs identical to JS (code, offset, items, steps), no panic`);
} else console.log('  SKIP Rust (no binary given)');
if (fails) { console.log(`  FAIL ${fails} failure(s)`); process.exit(1); }
console.log('  ok   the resumable scanner matches the recursive one under every window split and yield quantum');
