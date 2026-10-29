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
import { decode, encode, CBORFault, BindleDecimal, NDArray } from '../../bench/baseline/cbor-3sln.mjs';
import { scan, scanOptions, errorOffset, codeName } from '../../gen/js/snug/cbor/scan.mjs';
// The hand-written P1.4 yardstick is held to the same arbiter, so the
// benchmark compares two correct scanners.
import { scanHand } from '../../bench/scan-hand.mjs';

const [rustBin, mutArg, seedArg] = process.argv.slice(2);
const MUTATIONS = Number(mutArg ?? 30000), SEED = Number(seedArg ?? 1);
const hex = b => Buffer.from(b).toString('hex');
const unhex = h => { if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error(`bad hex ${h}`); return new Uint8Array(Buffer.from(h, 'hex')); };
const DEF = { top: 'map', cose: false, maxBytes: 1_500_000, maxDepth: 32, maxEntries: 65_536, maxItems: 131_072 };
const ANY = { ...DEF, top: 'any' };

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

// ---------------------------------------------------------------- cases
const cases = [];  // {label, bytes, opt, want?}
const add = (label, bytes, opt, want) => cases.push({ label, bytes, opt, want });

const profile = JSON.parse(readFileSync(new URL('../../corpus/cbor-vectors/cbor-profile.json', import.meta.url)));
for (const v of profile.accept) add(`profile ${v.name}`, unhex(v.hex), ANY, 'ok');
for (const v of profile.refuse) add(`profile ${v.name}`, unhex(v.hex), ANY, v.code);
const oracle = JSON.parse(readFileSync(new URL('../../corpus/cbor-vectors/cbor-cborg-oracle.json', import.meta.url)));
for (const c of oracle.cases) add(`oracle ${c.origin}`, unhex(c.hex), ANY, undefined);
const nVectors = cases.length;

// Fixed edge cases: expected = cbor.mjs; the comment says what each probes.
const nest = (n, inner = '80') => '81'.repeat(n) + inner;
const fixed = [
  // depth: 32 levels accepted, 33 refused; a tag is a level
  [nest(31), ANY], [nest(32), ANY], ['a16161' + nest(31), DEF], ['a16161' + nest(30), DEF],
  [nest(32, 'c482200f'), ANY], [nest(32, 'd85540'), ANY], [nest(32, 'c249010000000000000000'), ANY],
  [nest(31, 'c249010000000000000000'), ANY], [nest(31, 'c482200f'), ANY], [nest(30, 'c482200f'), ANY],
  [nest(31, 'd8288281018101'), ANY], [nest(30, 'd8288281018101'), ANY],
  // limits at and one past
  ['8a' + '00'.repeat(10), { ...ANY, maxEntries: 9 }], ['8a' + '00'.repeat(10), { ...ANY, maxEntries: 10 }],
  ['a2616100616200', { ...DEF, maxEntries: 1 }], ['a2616100616200', { ...DEF, maxEntries: 2 }],
  ['83' + '00'.repeat(3), { ...ANY, maxItems: 3 }], ['83' + '00'.repeat(3), { ...ANY, maxItems: 4 }],
  ['d84540', { ...ANY, maxItems: 1 }], ['d84540', { ...ANY, maxItems: 0 }],
  ['c249010000000000000000', { ...ANY, maxItems: 1 }],
  ['c482200f', { ...ANY, maxItems: 3 }], ['c482200f', { ...ANY, maxItems: 4 }],
  ['c482200f', { ...ANY, maxDepth: 1 }], ['c482200f', { ...ANY, maxDepth: 2 }], ['c482200f', { ...ANY, maxEntries: 1 }],
  ['d8288281028202034000', { ...ANY, maxItems: 6 }],
  ['d82882810244d84500', { ...ANY, maxDepth: 2 }], ['d82882810244d84500', { ...ANY, maxDepth: 3 }],
  ['00', { ...ANY, maxDepth: 0 }], ['80', { ...ANY, maxDepth: 0 }], ['c0', { ...ANY, maxDepth: 0 }],
  ['00', { ...ANY, maxItems: 0 }], ['', { ...ANY, maxItems: 0 }], ['', ANY],
  ['0000', { ...ANY, maxBytes: 1 }], ['00', { ...ANY, maxBytes: 1 }], ['00', { ...ANY, maxBytes: 0 }],
  ['9a00010001' + '00'.repeat(65537), ANY], ['9a00010000' + '00'.repeat(65536), ANY],
  ['83' + ('9a00010000' + '00'.repeat(65536)).repeat(2) + '00', ANY],
  // length bombs
  ...['5bffffffffffffffff', '9bffffffffffffffff', 'bbffffffffffffffff', '7bffffffffffffffff', '5a7fffffff',
      '9a7fffffff', 'ba7fffffff', 'd8565a7fffffff', 'c25a7fffffff', 'b9ffff', 'b8ff00'].map(h => [h, ANY]),
  // top-level map
  ['80', DEF], ['01', DEF], ['', DEF], ['00', DEF], ['a0', DEF], ['a0', { ...DEF, maxBytes: 0 }], ['a000', DEF],
  // cose
  ['a301260445' + '6b69642d31' + '10' + '782c' + '61'.repeat(44), { ...DEF, cose: true }],
  ['a1a1010202', { ...DEF, cose: true }], ['a16161a10102', { ...DEF, cose: true }],
  ['a20201010102', { ...DEF, cose: true }], ['a201010102', { ...DEF, cose: true }],
  ['a11b002000000000000001', { ...DEF, cose: true }], ['a11b002000000000000000' + '00', { ...DEF, cose: true }],
  ['a11b001fffffffffffff00', { ...DEF, cose: true }], ['a13b001ffffffffffffe00', { ...DEF, cose: true }],
  ['a13b001fffffffffffff00', { ...DEF, cose: true }], ['a13b001ffffffffffffd00', { ...DEF, cose: true }],
  ['a1c24901000000000000000000', { ...DEF, cose: true }], ['a1f900', { ...DEF, cose: true }],
  ['a10100', DEF], ['a1200100', { ...DEF, cose: true }], ['81a10100', { ...ANY, cose: true }],
  // precedence on multiply-invalid inputs (review C16)
  ['c498020f', ANY], ['c4980220' + '0f', ANY], ['c48200180' + '0', ANY], ['fa40000000', ANY], ['1c', ANY],
  ['fa7fc00000', ANY], ['fb3ff0000000000000', ANY], ['fb7ff8000000000000', ANY], ['f97e00', ANY],
  ['f818', ANY], ['f817', ANY], ['f820', ANY], ['ff', ANY], ['5f', ANY], ['7f', ANY], ['9f', ANY], ['bf', ANY],
  ['dc', ANY], ['fc', ANY], ['1d', ANY], ['3e', ANY],
  ['c2', ANY], ['c240', ANY], ['c25f', ANY], ['c2580801', ANY], ['c24900' + '00'.repeat(8), ANY],
  ['c2588100' + 'ff'.repeat(128), ANY], ['c25880' + 'ff'.repeat(128), ANY], ['c25881' + 'ff'.repeat(129), ANY],
  ['c4', ANY], ['c482', ANY], ['c48220', ANY], ['c4822000', ANY], ['c482200a', ANY], ['c4822014', ANY],
  ['c48200' + '0f', ANY], ['c4823903ff01', ANY], ['c4823904000f', ANY], ['c482390400' + '0f', ANY],
  ['c482201b8ac7230489e80000', ANY], ['c482201b8ac7230489e80001', ANY], ['c48220c249010000000000000000', ANY],
  ['c48220c349010000000000000009', ANY], ['c48220c34901000000000000000a', ANY], ['c48220c249010000000000000014', ANY],
  ['c4822029', ANY], ['c4822033', ANY], ['c48220f93e00', ANY], ['c482f93e000f', ANY], ['c4822061', ANY],
  ['c48220c482200f', ANY], ['c4826161', ANY], ['c48320200f', ANY],
  ['d828', ANY], ['d82882', ANY], ['d8288281018101', ANY], ['d8288281028101', ANY], ['d8288280' + '80', ANY],
  ['d82882810044d84500', ANY], ['d82882810244d8450000', ANY], ['d8288281024400000000', ANY],
  ['d828828102d84540', ANY], ['d82882890101010101010101018101', ANY], ['d828828801010101010101018101', ANY],
  ['d8288281fb3ff800000000000081', ANY], ['d82882811b001fffffffffffff80', ANY], ['d82882811b002000000000000080', ANY],
  ['d8288282190100190100' + '80', ANY], ['d82882821a000100001a0001000080', ANY],
  ['d8288281028201c482200f', ANY], ['d828828102c249010000000000000000', ANY], ['d82882810281d8288281018101', ANY],
  ['d84541', ANY], ['d8454100', ANY], ['d846430000', ANY], ['d8476800000000000000', ANY], ['d84844', ANY],
  ['d854420000', ANY], ['d854427e00', ANY], ['d854427c00', ANY], ['d854427e7c', ANY], ['d85442007e', ANY],
  ['d85544', ANY], ['d855440000c07f', ANY], ['d855440000807f', ANY], ['d8554400000080', ANY], ['d855440100807f', ANY],
  ['d85648000000000000f87f', ANY], ['d85648000000000000f07f', ANY], ['d85648010000000000f07f', ANY],
  ['d85648000000000000f0ff', ANY], ['d85648000000000000f8ff', ANY],
  ['d840', ANY], ['d8404100', ANY], ['d844', ANY], ['d850', ANY],
  ['d84d4100', ANY], ['d85344', ANY], ['d857', ANY], ['c1', ANY], ['c0', ANY], ['c5', ANY], ['d9d9f7', ANY],
  ['db0000000100000000', ANY], ['db8000000000000000', ANY], ['da00010000', ANY],
  ['a2616100616100', ANY], ['a2616200616100', ANY], ['a26161006162', ANY], ['a1616101' + '02', ANY],
  ['a1010202', ANY], ['a1f4f5', ANY], ['a2616100', ANY], ['a2', ANY], ['a1', ANY], ['a161', ANY],
  ['a16180', ANY], ['a2626161006162' + '00', ANY], ['a2616100626161' + '00', ANY],
  ['62c3', ANY], ['62c328', ANY], ['63eda080', ANY], ['63efbfbe', ANY], ['63efb790', ANY], ['63efb7af', ANY],
  ['63efb7b0', ANY], ['64f09fbfbe', ANY], ['64f48fbfbf', ANY], ['64f4908080', ANY], ['62c080', ANY], ['63e08080', ANY],
  ['64f0808080', ANY], ['61ff', ANY], ['6180', ANY], ['63efbbbf', ANY], ['64f3b08080', ANY], ['63ee8080', ANY],
];
for (const [h, opt] of fixed) add(`fixed ${h.slice(0, 40)}${h.length > 40 ? '…' : ''} ${JSON.stringify(opt)}`, unhex(h), opt, undefined);
add('fixed 1,500,001 zero bytes', new Uint8Array(1_500_001), ANY, undefined);
add('fixed 1,500,000 bytes map', (() => { const b = new Uint8Array(1_500_000); b.set(unhex('a1616159ffff')); return b; })(), DEF, undefined);
const nFixed = cases.length - nVectors;

// ---------------------------------------------------------------- seeded mutations
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const r = rng(SEED);
const ri = n => Math.floor(r() * n);
const pick = a => a[ri(a.length)];
const TEXTS = ['', 'a', 'b', 'ab', 'é', '水', '😀', 'key', 'x'.repeat(30), '﻿', 'Ω≈ç', 'z'];
function randomValue(depth) {
  const k = ri(depth > 3 ? 9 : 14);
  switch (k) {
    case 0: return ri(30);
    case 1: return -ri(1000) - 1;
    case 2: return pick([255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1, -(2 ** 53 - 1)]);
    case 3: return pick([2n ** 64n - 1n, -(2n ** 64n), 2n ** 64n, -(2n ** 64n) - 1n, 2n ** 100n, 2n ** 53n]);
    case 4: return pick([1.5, -4.1, 1.1, 1e300, 5.960464477539063e-8, 3.4028234663852886e38, 1e20, 0.5, 65504.5, 1e-40]);
    case 5: return pick(TEXTS);
    case 6: return new Uint8Array(ri(12)).map(() => ri(256));
    case 7: return pick([true, false, null]);
    case 8: return pick([BindleDecimal.from('1.5'), BindleDecimal.from('-0.001'), BindleDecimal.from('123456789012345678901234567.1')]);
    case 9: case 10: { const a = []; for (let i = ri(5); i > 0; i--) a.push(randomValue(depth + 1)); return a; }
    case 11: case 12: { const m = {}; for (let i = ri(5); i > 0; i--) m[pick(TEXTS) + ri(3)] = randomValue(depth + 1); return m; }
    default: {
      const t = ri(6);
      if (t === 0) return new Float64Array([1.5, -0, Infinity].slice(0, ri(4)));
      if (t === 1) return new Float32Array([2.5, -1].slice(0, ri(3)));
      if (t === 2) return new Int16Array([1, -2, 3].slice(0, ri(4)));
      if (t === 3) return new Uint32Array([7, 8]);
      if (t === 4) return new NDArray([2, 2], [1, 2, 3, 4]);
      return new NDArray([3], new Uint16Array([1, 2, 3]));
    }
  }
}
const SPECIAL = [0x00, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1f, 0x20, 0x38, 0x3b, 0x40, 0x41, 0x58, 0x5f, 0x60, 0x61,
  0x78, 0x7f, 0x80, 0x81, 0x82, 0x98, 0x9f, 0xa0, 0xa1, 0xb8, 0xbf, 0xc0, 0xc2, 0xc3, 0xc4, 0xc5, 0xd8, 0xd9, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xff, 0x7c, 0x7e, 0xed, 0xef, 0xbe, 0xf0, 0xf4, 0x28, 0x45, 0x55, 0x56];
function mutate(b) {
  let a = Array.from(b);
  const times = 1 + ri(3);
  for (let t = 0; t < times; t++) {
    const i = ri(Math.max(a.length, 1));
    switch (ri(9)) {
      case 0: if (a.length) a[i] ^= 1 << ri(8); break;
      case 1: if (a.length) a[i] = ri(256); break;
      case 2: if (a.length) a[i] = pick(SPECIAL); break;
      case 3: a.splice(i, 1); break;
      case 4: a.splice(i, 0, pick(SPECIAL)); break;
      case 5: a = a.slice(0, i); break;
      case 6: { const j = ri(a.length + 1), k = Math.min(a.length, j + 1 + ri(6)); a.splice(i, 0, ...a.slice(j, k)); break; }
      case 7: a.push(...Array.from({ length: 1 + ri(3) }, () => ri(256))); break;
      default: if (a.length > 1) { const j = ri(a.length); [a[i], a[j]] = [a[j], a[i]]; }
    }
  }
  return Uint8Array.from(a);
}
// Structured random ITEMS at the byte level, aimed at the bit tests: floats
// with chosen exponents and a chosen number of low zero mantissa bits, every
// head width (shortest or not), text fragments around the UTF-8 edges,
// decimals, bignums, typed arrays with NaN-like patterns, ndarray shapes.
const bits = n => { let v = 0n; for (let i = 0; i < n; i++) v = (v << 1n) | BigInt(ri(2)); return v; };
function headBytes(major, v /* bigint */, width /* -1 shortest */) {
  const m = major << 5;
  let w = width;
  if (w < 0) w = v < 24n ? 0 : v < 256n ? 1 : v < 65536n ? 2 : v < 4294967296n ? 4 : 8;
  if (w === 0) return [m | Number(v & 31n)];
  const ai = { 1: 24, 2: 25, 4: 26, 8: 27 }[w], out = [m | ai];
  for (let i = w - 1; i >= 0; i--) out.push(Number((v >> BigInt(8 * i)) & 255n));
  return out;
}
function randInt() {
  const sizes = [0, 1, 2, 4, 8], w = pick(sizes), max = w === 0 ? 24n : 1n << BigInt(8 * w);
  let v = r() < 0.3 ? pick([0n, 1n, 9n, 10n, 23n, 24n, 255n, 256n, 1023n, 1024n, 65535n, 65536n, (1n << 32n) - 1n, (1n << 53n) - 1n, (1n << 53n), (1n << 53n) - 2n, (1n << 64n) - 1n]) : bits(Number(8 * Math.max(w, 1)));
  if (v >= max) v = v % max;
  return headBytes(ri(2), v, r() < 0.8 ? -1 : w);
}
// Unbiased exponents where a rule changes, per width: integral-float limits,
// the narrower width's normal and subnormal ranges.
const EDGES = { 16: [-25, -24, -15, -14, 0, 9, 10, 11, 15, 16],
  32: [-150, -149, -127, -126, -25, -24, -16, -15, -14, -13, -1, 0, 10, 15, 16, 22, 23, 24, 52, 53, 127],
  64: [-1023, -1022, -151, -150, -149, -148, -128, -127, -126, -125, -25, -24, -15, -14, -1, 0, 1, 23, 31, 32, 33, 51, 52, 53, 127, 128, 1023] };
function randFloat() {
  const w = pick([16, 32, 64]), eb = { 16: 5, 32: 8, 64: 11 }[w], mb = { 16: 10, 32: 23, 64: 52 }[w];
  const emax = (1 << eb) - 1, bias = (1 << (eb - 1)) - 1;
  let e;
  if (r() < 0.1) e = pick([0, emax]);
  else if (r() < 0.6) e = Math.max(1, Math.min(emax - 1, bias + pick(EDGES[w])));
  else e = 1 + ri(emax - 1);
  const x = e - bias;
  // How many low mantissa bits are zero: random, or right at a threshold the
  // rules use for this exponent (+-1).
  const thresholds = [mb - x, mb - 13, mb - 23, mb - 10, mb - 29, -1 - x - (23 - mb), -97 - x - (52 - mb), 0, mb].filter(k => k >= 0 && k <= mb);
  let zeros = r() < 0.5 ? ri(mb + 1) : Math.max(0, Math.min(mb, pick(thresholds) + ri(3) - 1));
  let m = bits(mb) | 1n;
  m = (m >> BigInt(zeros)) << BigInt(zeros);
  if (zeros < mb && r() < 0.7) m |= 1n << BigInt(zeros);  // the lowest set bit exactly at the threshold
  if (r() < 0.05) m = 0n;
  const pattern = (BigInt(ri(2)) << BigInt(eb + mb)) | (BigInt(e) << BigInt(mb)) | m;
  const out = [{ 16: 0xf9, 32: 0xfa, 64: 0xfb }[w]];
  for (let i = w / 8 - 1; i >= 0; i--) out.push(Number((pattern >> BigInt(8 * i)) & 255n));
  return out;
}
const FRAG = [[0x41], [0xc3, 0xbc], [0xe6, 0xb0, 0xb4], [0xf0, 0x9f, 0x98, 0x80], [0xed, 0x9f, 0xbf], [0xed, 0xa0, 0x80],
  [0xef, 0xb7, 0x8f], [0xef, 0xb7, 0x90], [0xef, 0xb7, 0xaf], [0xef, 0xb7, 0xb0], [0xef, 0xbf, 0xbd], [0xef, 0xbf, 0xbe],
  [0xef, 0xbf, 0xbf], [0xf0, 0x9f, 0xbf, 0xbe], [0xf4, 0x8f, 0xbf, 0xbf], [0xf4, 0x8f, 0xbf, 0xbd], [0xf4, 0x90, 0x80, 0x80],
  [0xe0, 0x9f, 0xbf], [0xe0, 0xa0, 0x80], [0xf0, 0x8f, 0xbf, 0xbf], [0xf0, 0x90, 0x80, 0x80], [0xc1, 0xbf], [0xc2, 0x80],
  [0x80], [0xbf], [0xff], [0xc3], [0xe6, 0xb0], [0xf5, 0x80, 0x80, 0x80], [0xf3, 0xbf, 0xbf, 0xbe], [0x00], [0x7f]];
function randText() { const a = []; for (let i = ri(5); i > 0; i--) a.push(...pick(FRAG)); return [...headBytes(3, BigInt(a.length), -1), ...a]; }
function randBignumContent() {
  const len = r() < 0.7 ? 8 + ri(4) : pick([0, 1, 127, 128, 129, 9 + ri(120)]);
  const c = Array.from({ length: len }, () => ri(256));
  if (len && r() < 0.2) c[0] = 0; else if (len && c[0] === 0) c[0] = 1;
  if (len && r() < 0.5) c[len - 1] = ri(256);
  return [...headBytes(2, BigInt(len), r() < 0.9 ? -1 : 1), ...c];
}
function randDecimal() {
  const exp = r() < 0.7 ? headBytes(1, BigInt(pick([0, 1, 9, 23, 24, 255, 256, 1022, 1023, 1024, 65535, ri(2000)])), -1) : r() < 0.5 ? randInt() : randFloat();
  const k = ri(10);
  const mant = k < 5 ? randInt() : k < 8 ? [0xc2 + ri(2), ...randBignumContent()] : k < 9 ? randFloat() : randText();
  return [0xc4, r() < 0.95 ? 0x82 : pick([0x81, 0x83, 0x98]), ...exp, ...mant];
}
function randTyped(tag) {
  const t = tag ?? (r() < 0.8 ? pick([69, 70, 71, 72, 77, 78, 79, 84, 85, 86]) : 64 + ri(24));
  const size = { 69: 2, 70: 4, 71: 8, 72: 1, 77: 2, 78: 4, 79: 8, 84: 2, 85: 4, 86: 8 }[t] ?? 1;
  const n = r() < 0.85 ? size * ri(4) : ri(10);
  const c = Array.from({ length: n }, () => ri(256));
  for (let i = 0; i + size <= n; i += size) if (r() < 0.5) {
    if (size === 2) { c[i + 1] = (c[i + 1] & 0x80) | 0x7c | (r() < 0.5 ? 0 : ri(4)); if (r() < 0.5) c[i] = 0; }
    if (size === 4) { c[i + 3] = (c[i + 3] & 0x80) | 0x7f; c[i + 2] = 0x80 | (r() < 0.5 ? 0 : ri(128)); if (r() < 0.5) { c[i] = 0; c[i + 1] = 0; } }
    if (size === 8) { c[i + 7] = (c[i + 7] & 0x80) | 0x7f; c[i + 6] = 0xf0 | (r() < 0.5 ? 0 : ri(16)); if (r() < 0.5) for (let j = 0; j < 6; j++) c[i + j] = 0; }
  }
  return [0xd8, t, ...headBytes(2, BigInt(n), -1), ...c];
}
function randNd() {
  const dims = r() < 0.8 ? 1 + ri(3) : pick([0, 8, 9]);
  const shape = [];
  for (let i = 0; i < dims; i++) shape.push(r() < 0.9 ? BigInt(1 + ri(4)) : pick([0n, (1n << 32n) + 1n, 1n << 53n, (1n << 53n) - 1n]));
  const sh = [...headBytes(4, BigInt(dims), -1)];
  for (const d of shape) sh.push(...(r() < 0.95 ? headBytes(0, d, -1) : randFloat()));
  let count = shape.reduce((p, d) => p * d, 1n);
  if (r() < 0.3 || count > 20n) count = BigInt(ri(10));
  let data;
  if (r() < 0.5) { data = [...headBytes(4, count, -1)]; for (let i = 0n; i < count; i++) data.push(0x01); }
  else if (r() < 0.8) { const t = pick([69, 70, 72, 85, 86]); const size = { 69: 2, 70: 4, 72: 1, 85: 4, 86: 8 }[t]; data = [0xd8, t, ...headBytes(2, count * BigInt(size), -1), ...new Array(Number(count) * size).fill(0)]; }
  else data = pick([[0x40], [0xc2, ...randBignumContent()], [0xa0], randDecimal(), [0xd8, 0x28, 0x82, 0x81, 0x01, 0x81, 0x01]]);
  return [0xd8, 0x28, r() < 0.95 ? 0x82 : 0x81, ...sh, ...data];
}
function randItem(depth = 0) {
  switch (ri(depth > 2 ? 8 : 10)) {
    case 0: return randInt();
    case 1: return randFloat();
    case 2: return randText();
    case 3: return randDecimal();
    case 4: return [0xc2 + ri(2), ...randBignumContent()];
    case 5: return randTyped();
    case 6: return randNd();
    case 7: return pick([[0xf4], [0xf5], [0xf6], [0xf7], [0xf8, ri(256)], [0xe0 + ri(20)], [0xfc], [0xff], [0x5f, 0xff]]);
    case 8: { const n = ri(4), out = [...headBytes(4, BigInt(n), -1)]; for (let i = 0; i < n; i++) out.push(...randItem(depth + 1)); return out; }
    default: { const n = ri(4), out = [...headBytes(5, BigInt(n), -1)]; for (let i = 0; i < n; i++) { out.push(...(r() < 0.8 ? randText() : randInt())); out.push(...randItem(depth + 1)); } return out; }
  }
}

function randomOptions() {
  if (r() < 0.6) return r() < 0.8 ? ANY : DEF;
  return { top: r() < 0.75 ? 'any' : 'map', cose: r() < 0.3, maxBytes: r() < 0.8 ? 1_500_000 : ri(40),
    maxDepth: r() < 0.6 ? 32 : ri(5), maxEntries: r() < 0.6 ? 65_536 : ri(6), maxItems: r() < 0.6 ? 131_072 : ri(12) };
}
const seeds = [...profile.accept.map(v => unhex(v.hex)), ...oracle.cases.filter(c => c.accept).map(c => unhex(c.hex))];
for (let m = 0; m < MUTATIONS; m++) {
  let base;
  const k = r();
  if (k < 0.25) base = encode(randomValue(0), { cose: false });
  else if (k < 0.4) base = Uint8Array.from(randItem());
  else if (k < 0.6) base = Uint8Array.from(pick([randFloat, randFloat, randText, randDecimal, randTyped, randNd, randInt])());
  else if (k < 0.9) base = pick(seeds);
  else base = Uint8Array.from({ length: ri(10) }, () => (r() < 0.5 ? pick(SPECIAL) : ri(256)));
  add(`mutation ${m}`, r() < (k >= 0.25 && k < 0.6 ? 0.6 : 0.07) ? base : mutate(base), randomOptions(), undefined);
}

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
