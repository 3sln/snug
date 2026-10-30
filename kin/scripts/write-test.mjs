// `bb write-test`: the kin writer primitives (snug.write.*) on JS and Rust.
//
//   node kin/scripts/write-test.mjs <rust write-test binary> [cases] [seed]
//
// 1. Heads: put-head on seeded (major, argument, capacity, position), JS == Rust,
//    and every written head equals an independent BigInt encoding.
// 2. Floats: float-width/put-float on boundaries (subnormals of every width,
//    width edges, ±0, NaN payloads, ±∞, 2^53 ± 1) and seeded bit patterns,
//    JS == Rust; every accepted pattern equals cbor.mjs's encode of the number
//    and is accepted by the scanner; every refusal is one cbor.mjs refuses.
// 3. Integers: put-int on seeded magnitudes (0..140 bytes, leading zeros),
//    JS == Rust, equal to cbor.mjs's encode of the bigint, bignum refusals.
// 4. key-after and close-map on seeded pair tables (in order, shuffled,
//    duplicates, short scratch, small budgets, broken tables), JS == Rust,
//    and every sorted result equals an independent sort of the pairs.
// 5. Writer streams: seeded values driven through the Rust Writer and the JS
//    Writer as typed calls, keys shuffled; the bytes equal encode(value);
//    misuse streams fail with the same code on both.
// 6. Robustness: random arguments (negative positions, tiny buffers, junk
//    tables): no panic, no throw, JS == Rust.
import { spawnSync } from 'node:child_process';
import { putHead, keyAfter } from '../../gen/js/snug/write/out.mjs';
import { floatWidth, putFloat } from '../../gen/js/snug/write/float.mjs';
import { intLen, putInt } from '../../gen/js/snug/write/int.mjs';
import { closeMap, S_BUDGET, S_COMPARES } from '../../gen/js/snug/write/map.mjs';
import { encode } from '../../host/js/src/encode.mjs';
import { scan } from '../../host/js/src/scan.mjs';
import { Writer } from '../../host/js/src/writer.mjs';
import * as baseline from '../../bench/baseline/cbor-3sln.mjs';
import { createRandom, randomValue, randomMap, randomString } from '../../host/js/test/corpus.mjs';

const [bin, nArg = '3000', seedArg = '1'] = process.argv.slice(2);
const N = Number(nArg), SEED = Number(seedArg);
const hex = b => Buffer.from(b).toString('hex');
const unhex = h => new Uint8Array(Buffer.from(h, 'hex'));
let failed = false;
const ok = (good, msg) => { console.log(`  ${good ? 'ok  ' : 'FAIL'} ${msg}`); if (!good) failed = true; };
function rust(lines) {
  const r = spawnSync(bin, { input: lines.join('\n') + '\n', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('write-test binary failed: ' + r.stderr);
  return r.stdout.toString().trimEnd().split('\n');
}
function compare(name, lines, js) {
  const rs = rust(lines);
  let same = 0, shown = 0;
  for (let i = 0; i < lines.length; i++) {
    if (rs[i] === js[i]) same++;
    else if (shown++ < 3) console.log(`    differs: ${lines[i].slice(0, 100)}\n      js ${js[i]?.slice(0, 120)}\n      rs ${rs[i]?.slice(0, 120)}`);
  }
  const panics = rs.filter(s => s === 'PANIC').length;
  ok(same === lines.length && panics === 0, `${name}: ${same}/${lines.length} identical across hosts, ${panics} Rust panics`);
  return rs;
}
const r = createRandom(SEED);
const i32 = x => x | 0;
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer), LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const bitsOf = x => { f64[0] = x; return LE ? [i32(u32[1]), i32(u32[0])] : [i32(u32[0]), i32(u32[1])]; };
const numberOf = (hi, lo) => { if (LE) { u32[1] = hi >>> 0; u32[0] = lo >>> 0; } else { u32[0] = hi >>> 0; u32[1] = lo >>> 0; } return f64[0]; };

// ---------------------------------------------------------------- 1. heads
{
  const ARGS = [0n, 1n, 23n, 24n, 255n, 256n, 65535n, 65536n, 2n ** 32n - 1n, 2n ** 32n, 2n ** 53n, 2n ** 63n, 2n ** 64n - 1n];
  const lines = [], js = [];
  let truth = 0, checked = 0;
  for (let i = 0; i < N; i++) {
    const arg = r.chance(0.5) ? r.pick(ARGS) + BigInt(r.int(3)) - 1n : BigInt.asUintN(64, BigInt(r.int(2 ** 32)) << BigInt(r.int(40)));
    const a = BigInt.asUintN(64, arg), hi = i32(Number(a >> 32n)), lo = i32(Number(a & 0xffffffffn));
    const major = r.int(8), cap = r.chance(0.3) ? r.int(12) : 12, at = r.chance(0.05) ? -1 : r.int(Math.min(cap, 3) + 2);
    const b = new Uint8Array(Math.max(cap, 0));
    const ans = putHead(b, at, major, hi, lo);
    lines.push(`H ${at} ${cap} ${major} ${hi} ${lo}`);
    js.push(`h ${ans} ${hex(b)}`);
    if (ans >= 0) {
      checked++;
      const n = a < 24n ? 0 : a < 256n ? 1 : a < 65536n ? 2 : a < 2n ** 32n ? 4 : 8;
      const want = [major * 32 + (n === 0 ? Number(a) : n === 1 ? 24 : n === 2 ? 25 : n === 4 ? 26 : 27)];
      for (let k = n - 1; k >= 0; k--) want.push(Number((a >> BigInt(8 * k)) & 255n));
      if (hex(b.subarray(at, ans)) === hex(want) && ans === at + want.length) truth++;
    }
  }
  compare('put-head', lines, js);
  ok(truth === checked, `put-head: ${truth}/${checked} written heads equal an independent shortest encoding`);
}

// ---------------------------------------------------------------- 2. floats
{
  const specials = [0, -0, NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), 2 ** 53 - 1, 2 ** 53 + 2, 2 ** 52 + 0.5, 0.5, 1.5, 65504, 65505, 65520, 2 ** -14, 2 ** -24, 2 ** -25, 3 * 2 ** -25,
    2 ** -15, 2 ** -24 * 1023, 2 ** -126, 2 ** -127, 2 ** -149, 2 ** -150, 3 * 2 ** -150, 2 ** -149 * 3, 2 ** -1074, 2 ** -1022, Number.MIN_VALUE, Number.MAX_VALUE, 3.4028234663852886e38,
    3.4028235677973366e38, 1.1, 1e-7, 5.960464477539063e-8, 0.00006103515625, 100000.5, 1e300, -1e-300, 2 ** 1023, 2 ** 127, 2 ** 128, 2 ** 15 + 0.5, 2 ** 16 + 0.5];
  const pats = [];
  for (const x of specials) { pats.push(bitsOf(x)); pats.push(bitsOf(-x)); }
  for (const nan of [[0x7ff00000, 1], [0x7ff80000, 0], [i32(0xfff00000), 0x10], [0x7fffffff, -1]]) pats.push(nan.map(i32));
  // every float16 and every float32 exponent, with random fractions, and neighbours
  for (let e = -30; e <= 135; e++) for (let k = 0; k < 4; k++) {
    const x = (1 + r.int(1024) / 1024) * 2 ** e;
    pats.push(bitsOf(x)); pats.push(bitsOf(Math.fround(x * (1 + 2 ** -20))));
  }
  for (let e = -160; e <= -120; e++) pats.push(bitsOf((1 + r.int(8) / 8) * 2 ** e));
  for (let i = 0; i < N; i++) pats.push([i32(r.int(2 ** 32)), i32(r.int(2 ** 32))]);
  for (let i = 0; i < N / 4; i++) { // low-entropy mantissas (narrow widths) at random exponents
    const e = 1023 + r.int(300) - 150, hi = (r.chance(0.5) ? 0x80000000 : 0) | (e << 20) | (r.int(1 << 10) << 10);
    pats.push([i32(hi), r.chance(0.5) ? 0 : i32(r.int(8) << 29)]);
  }
  const lines = [], js = [];
  let agree = 0, accepted = 0, refused = 0, refusedOk = 0;
  for (const [hi, lo] of pats) {
    const cap = r.chance(0.2) ? r.int(10) : 9, at = cap === 9 ? 0 : r.int(cap + 1);
    const b = new Uint8Array(cap), w = floatWidth(hi, lo), ans = putFloat(b, at, hi, lo);
    lines.push(`F ${at} ${cap} ${hi} ${lo}`);
    js.push(`f ${w} ${ans} ${hex(b)}`);
    const x = numberOf(hi, lo);
    if (w < 0) {
      refused++;
      try { baseline.encode(x); if (Number.isSafeInteger(x) && !Object.is(x, -0)) refusedOk++; } catch (e) { if (e.code === 'float') refusedOk++; }
    } else if (ans >= 0) {
      accepted++;
      const bytes = b.subarray(at, ans);
      let good = hex(bytes) === hex(baseline.encode(x)) && ans - at === w + 1;
      try { scan(bytes, { top: 'any' }); } catch { good = false; }
      if (good) agree++;
    }
  }
  compare('float-width/put-float', lines, js);
  ok(agree === accepted, `floats: ${agree}/${accepted} written floats equal cbor.mjs's encoding and pass the scanner`);
  ok(refusedOk === refused, `floats: ${refusedOk}/${refused} refusals are numbers cbor.mjs encodes as integers or refuses (float)`);
}

// ---------------------------------------------------------------- 3. integers
{
  const lines = [], js = [];
  let agree = 0, accepted = 0, big = 0, bigOk = 0;
  for (let i = 0; i < N; i++) {
    const len = r.chance(0.3) ? r.int(10) : r.int(141), lead = r.chance(0.2) ? r.int(4) : 0;
    const m = new Uint8Array(lead + len);
    for (let k = lead; k < m.length; k++) m[k] = r.int(256);
    if (len && r.chance(0.5)) m[lead] = 1 + r.int(255);
    const neg = r.int(2), need = intLen(m, 0, m.length);
    const cap = r.chance(0.2) ? r.int(140) : 140, at = r.int(Math.min(cap, 4) + 1);
    const b = new Uint8Array(cap), ans = putInt(b, at, neg, m, 0, m.length);
    lines.push(`I ${at} ${cap} ${neg} ${hex(m)}`);
    js.push(`i ${need} ${ans} ${hex(b)}`);
    const arg = m.length ? BigInt('0x' + hex(m)) : 0n, value = neg ? -1n - arg : arg;
    if (ans >= 0) {
      accepted++;
      if (hex(b.subarray(at, ans)) === hex(baseline.encode(value)) && ans - at === need) agree++;
    } else if (need < 0) {
      big++;
      try { baseline.encode(value); } catch (e) { if (e.code === 'bignum') bigOk++; }
    }
  }
  compare('put-int', lines, js);
  ok(agree === accepted, `put-int: ${agree}/${accepted} written integers equal cbor.mjs's encoding (and int-len)`);
  ok(bigOk === big, `put-int: ${bigOk}/${big} bignum refusals are cbor.mjs's`);
}

// ---------------------------------------------------------------- 4. keys and maps
const encKey = k => encode(k, { top: 'any' });
const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
{
  const lines = [], js = [];
  for (let i = 0; i < N / 2; i++) {
    const a = encKey(randomString(r, 6)), b = r.chance(0.2) ? a : encKey(randomString(r, 6));
    const buf = new Uint8Array([...a, ...b]);
    let ps = 0, pe = a.length, ks = a.length, ke = buf.length;
    if (r.chance(0.1)) { ps = r.int(buf.length + 2) - 1; pe = r.int(buf.length + 2); ks = r.int(buf.length + 2); ke = r.int(buf.length + 3); }
    lines.push(`K ${hex(buf)} ${ps} ${pe} ${ks} ${ke}`);
    js.push(`k ${keyAfter(buf, ps, pe, ks, ke)}`);
  }
  compare('key-after', lines, js);
}
{
  const lines = [], js = [];
  let sortedOk = 0, sortedN = 0, dups = 0, dupOk = 0, overBound = 0;
  for (let i = 0; i < N; i++) {
    const n = r.chance(0.1) ? r.int(300) : r.int(12);
    const pairs = [];
    const seen = new Set();
    for (let k = 0; k < n; k++) {
      let key = r.chance(0.05) && pairs.length ? pairs[r.int(pairs.length)][0] : encKey(r.chance(0.5) ? 'k' + r.int(50) : randomString(r, 5));
      if (r.chance(0.02)) key = encKey(r.int(100) - 50); // cose labels sort too
      const val = encode(randomValue(r, { maxDepth: 1 }), { top: 'any' });
      pairs.push([key, val]);
      seen.add(hex(key));
    }
    const dup = seen.size !== pairs.length;
    const prefix = r.int(3), buf = [];
    for (let k = 0; k < prefix; k++) buf.push(r.int(256));
    const t = [];
    for (const [k, v] of pairs) { t.push(buf.length); buf.push(...k); t.push(buf.length); buf.push(...v); }
    const mend = buf.length;
    for (let k = 0, extra = r.int(3); k < extra; k++) buf.push(r.int(256));
    const size = mend - (t.length ? t[0] : mend);
    let tmpcap = r.chance(0.1) ? r.int(size + 1) : size, xcap = r.chance(0.1) ? r.int(2 * n + 1) : 2 * n;
    const budget = r.chance(0.1) ? r.int(4 * n + 1) : 0x7fffffff;
    let broken = false;
    if (r.chance(0.05) && t.length) { const d = r.int(5) - 2; t[r.int(t.length)] += d; broken = d !== 0; } // a broken (or shifted) table
    const b = Uint8Array.from(buf), tmp = new Uint8Array(tmpcap), x = new Int32Array(xcap), s = new Int32Array(4);
    s[S_BUDGET] = budget;
    const ans = closeMap(b, Int32Array.from(t), 0, t.length >> 1, mend, tmp, x, s);
    lines.push(`M ${hex(buf)} ${mend} ${tmpcap} ${xcap} ${budget} ${t.join(' ')}`.trimEnd());
    js.push(`m ${ans} ${s[S_COMPARES]} ${hex(b)}`);
    const pn = t.length >> 1;
    if (ans === 0 && s[S_COMPARES] > Math.max(0, pn - 1) + pn * Math.ceil(Math.log2(Math.max(pn, 1)))) overBound++;
    if (ans === 0 && !broken) {
      sortedN++;
      const want = [...pairs].sort((p, q) => cmpBytes(p[0], q[0]));
      const flat = Uint8Array.from([...buf.slice(0, t.length ? t[0] : mend), ...want.flatMap(([k, v]) => [...k, ...v]), ...buf.slice(mend)]);
      if (!dup && hex(flat) === hex(b)) sortedOk++;
    } else if (ans === -7) { dups++; if (dup) dupOk++; }
  }
  compare('close-map', lines, js);
  ok(sortedOk === sortedN, `close-map: ${sortedOk}/${sortedN} sorted maps equal an independent sort of their pairs`);
  ok(dupOk === dups, `close-map: ${dupOk}/${dups} duplicate_key answers have a duplicate key`);
  ok(overBound === 0, `close-map: ${overBound} closes charged more than n - 1 + n ceil(log2 n) comparisons`);
}

// ---------------------------------------------------------------- 5. writer streams
function strip(v) { // the Rust Writer is minimal: no typed arrays, decimals, ndarrays
  if (Array.isArray(v)) return v.map(strip);
  if (v instanceof Uint8Array) return v;
  if (v && typeof v === 'object') {
    if (ArrayBuffer.isView(v) || Object.getPrototypeOf(v) !== null && Object.getPrototypeOf(v) !== Object.prototype) return null;
    const o = Object.create(null); for (const k of Object.keys(v)) o[k] = strip(v[k]); return o;
  }
  return v;
}
const utf8 = s => hex(new TextEncoder().encode(s));
function ops(v, out, rr) {
  if (typeof v === 'number') {
    if (Number.isSafeInteger(v) && !Object.is(v, -0)) ops(BigInt(v), out, rr);
    else { const [hi, lo] = bitsOf(v); out.push(`f${hi},${lo}`); }
  } else if (typeof v === 'bigint') {
    const arg = v < 0n ? -1n - v : v; let h = arg.toString(16); if (h.length & 1) h = '0' + h;
    out.push((v < 0n ? 'q' : 'p') + h);
  } else if (typeof v === 'string') out.push('t' + utf8(v));
  else if (typeof v === 'boolean') out.push(v ? 'T' : 'F');
  else if (v === null) out.push('N');
  else if (v instanceof Uint8Array) out.push('b' + hex(v));
  else if (Array.isArray(v)) { out.push('a' + v.length); for (const x of v) ops(x, out, rr); out.push('e'); }
  else { const ks = rr.shuffle(Object.keys(v)); out.push('m' + ks.length); for (const k of ks) { out.push('k' + utf8(k)); ops(v[k], out, rr); } out.push('e'); }
}
function jsWriter(list) {
  const w = new Writer({ keysSorted: list[0] === 'S' });
  try {
    for (const op of list) {
      if (op === 'S') continue;
      const c = op[0], rest = op.slice(1);
      if (c === 'a') w.beginArray(Number(rest)); else if (c === 'm') w.beginMap(Number(rest)); else if (c === 'e') w.end();
      else if (c === 'k') w.key(Buffer.from(rest, 'hex').toString('utf8')); else if (c === 't') w.text(Buffer.from(rest, 'hex').toString('utf8'));
      else if (c === 'b') w.bytes(unhex(rest)); else if (c === 'p') w.int(rest ? BigInt('0x' + rest) : 0n); else if (c === 'q') w.int(-1n - (rest ? BigInt('0x' + rest) : 0n));
      else if (c === 'f') { const [hi, lo] = rest.split(',').map(Number); w.float(numberOf(hi, lo)); }
      else if (c === 'T') w.bool(true); else if (c === 'F') w.bool(false); else if (c === 'N') w.null();
    }
    return 'w ' + hex(w.finish());
  } catch (e) { return 'w fail ' + e.code; }
}
{
  const rr = createRandom(SEED + 500);
  const lines = [], js = [];
  let equal = 0, total = 0;
  for (let i = 0; i < N; i++) {
    const v = strip(i % 2 ? randomMap(rr, { maxDepth: 4 }) : randomValue(rr, { maxDepth: 4 }));
    let want; try { want = 'w ' + hex(encode(v, { top: 'any' })); } catch (e) { want = 'w fail ' + e.code; }
    const list = []; ops(v, list, rr);
    lines.push('W ' + list.join(' '));
    const got = jsWriter(list);
    js.push(got);
    total++; if (got === want) equal++;
  }
  // misuse streams: drop, duplicate or insert one op; and keysSorted streams with shuffled keys
  for (let i = 0; i < N / 2; i++) {
    const v = strip(randomMap(rr, { maxDepth: 3 }));
    const list = []; ops(v, list, rr);
    const k = rr.int(list.length), mode = rr.int(4);
    if (mode === 0) list.splice(k, 1); else if (mode === 1) list.splice(k, 0, list[k]); else if (mode === 2) list.splice(k, 0, rr.pick(['e', 'N', 'k61', 'a0', 'm0', 'T']));
    else list.unshift('S');
    lines.push('W ' + list.join(' '));
    js.push(jsWriter(list));
  }
  compare('Writer streams (typed calls, shuffled keys, misuse)', lines, js);
  ok(equal === total, `Writer streams: ${equal}/${total} JS Writer outputs equal encode(value)`);
}

// ---------------------------------------------------------------- 6. robustness
{
  const rr = createRandom(SEED + 900), lines = [], js = [];
  const junkInt = () => rr.pick([-1, -(2 ** 31), 2 ** 31 - 1, 0, 1, rr.int(64), -rr.int(64)]);
  for (let i = 0; i < N; i++) {
    const kind = rr.int(4), cap = rr.int(12), at = junkInt();
    if (kind === 0) { const b = new Uint8Array(cap), m = junkInt(), hi = junkInt(), lo = junkInt(); const a = putHead(b, at, m, hi, lo); lines.push(`H ${at} ${cap} ${m} ${hi} ${lo}`); js.push(`h ${a} ${hex(b)}`); }
    else if (kind === 1) { const b = new Uint8Array(cap), hi = junkInt(), lo = junkInt(); const w = floatWidth(hi, lo), a = putFloat(b, at, hi, lo); lines.push(`F ${at} ${cap} ${hi} ${lo}`); js.push(`f ${w} ${a} ${hex(b)}`); }
    else if (kind === 2) { const b = new Uint8Array(cap), m = new Uint8Array(rr.int(12)).map(() => rr.int(256)); const l = intLen(m, 0, m.length), a = putInt(b, at, 1, m, 0, m.length); lines.push(`I ${at} ${cap} 1 ${hex(m)}`); js.push(`i ${l} ${a} ${hex(b)}`); }
    else {
      const buf = new Uint8Array(rr.int(30)).map(() => rr.int(256)), n = rr.int(5), t = [];
      for (let k = 0; k < 2 * n; k++) t.push(junkInt());
      const mend = junkInt(), tmpcap = rr.int(40), xcap = rr.int(12), s = new Int32Array(4); s[S_BUDGET] = 1000;
      const b = buf.slice(), a = closeMap(b, Int32Array.from(t), 0, n, mend, new Uint8Array(tmpcap), new Int32Array(xcap), s);
      lines.push(`M ${hex(buf)} ${mend} ${tmpcap} ${xcap} 1000 ${t.join(' ')}`.trimEnd()); js.push(`m ${a} ${s[S_COMPARES]} ${hex(b)}`);
    }
  }
  compare('robustness (junk arguments)', lines, js);
}

if (failed) { console.log('  FAIL write-test'); process.exit(1); }
console.log('  ok   write-test');
