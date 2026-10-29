// A HAND-WRITTEN JavaScript CBOR profile scanner: the same algorithm as the
// kin source (kin/scan.kin and helpers, docs/scanner.md) -- same checks, same
// order, same integer-only float and UTF-8 tests -- written the way a person
// writes a FAST JS scanner: the head argument, item counter and limits in
// module-level variables rather than an Int32Array, the common head paths
// inlined, hot loops over locals, refusals as negative returns (an earlier
// draft threw a code instead; V8's throw cost made refusal-heavy inputs ~9x
// slower, see bench/SCAN.md). No error offsets (cbor.mjs reports none; the kin
// scanner records them, which is work this one does not do).
//
// It exists only as the D005 yardstick (P1.4: generated JS must be no worse
// than 1.25x this). bb scan-test holds it to cbor.mjs's code on every case,
// and bench/scan-bench.mjs checks its answers again before timing it.
//
//     scanHand(bytes, {top, cose, maxBytes, maxDepth, maxEntries, maxItems}) -> 0 | code

const TRUNCATED = 1, NON_SHORTEST = 2, INDEFINITE = 3, MALFORMED = 4, KEY_TYPE = 5, KEY_ORDER = 6,
  DUPLICATE_KEY = 7, TEXT = 8, FLOAT = 9, SIMPLE = 10, TAG = 11, BIGNUM = 12, DECIMAL = 13, TYPED_ARRAY = 14,
  NDARRAY = 15, TRAILING = 16, DEPTH = 17, TOO_MANY_ENTRIES = 18, TOO_MANY_ITEMS = 19, TOO_LARGE = 20, NOT_MAP = 21;

let items = 0, maxDepth = 0, maxEntries = 0, maxItems = 0, cose = false;
let hi = 0, lo = 0, cs = 0;  // last head argument (two 32-bit halves); last tag content start

const be16 = (b, p) => (b[p] << 8) | b[p + 1];
const be32 = (b, p) => (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];

/** The head at pos (byte present, ai >= 24): sets hi/lo; the position after it, or -code. */
function readArg(b, pos, ai) {
  const left = b.length - pos - 1;
  switch (ai) {
    case 24: if (left < 1) return -TRUNCATED; lo = b[pos + 1]; if (lo < 24) return -NON_SHORTEST; hi = 0; return pos + 2;
    case 25: if (left < 2) return -TRUNCATED; lo = be16(b, pos + 1); if (lo < 256) return -NON_SHORTEST; hi = 0; return pos + 3;
    case 26: if (left < 4) return -TRUNCATED; lo = be32(b, pos + 1); if ((lo >>> 16) === 0) return -NON_SHORTEST; hi = 0; return pos + 5;
    case 27: if (left < 8) return -TRUNCATED; hi = be32(b, pos + 1); lo = be32(b, pos + 5); if (hi === 0) return -NON_SHORTEST; return pos + 9;
    case 31: return -INDEFINITE;
    default: return -MALFORMED;
  }
}

const lowZero = (x, k) => k === 0 || (x & (-1 >>> (32 - k))) === 0;
const lowZero64 = (h, l, k) => (k <= 32 ? lowZero(l, k) : l === 0 && lowZero(h, k - 32));
function f16(h) {
  const e = (h >> 10) & 31, f = h & 1023;
  if (e === 31) return FLOAT;
  if (e === 0) return f === 0 ? FLOAT : 0;
  const x = e - 15;
  if (x < 0) return 0;
  return x >= 10 || lowZero(f, 10 - x) ? FLOAT : 0;
}
function f32(w) {
  const e = (w >> 23) & 255, m = w & 0x7fffff;
  if (e === 255) return FLOAT;
  if (e === 0) return m === 0 ? FLOAT : 0;
  const x = e - 127;
  if (x >= 0 && x <= 52 && (x >= 23 || lowZero(m, 23 - x))) return FLOAT;
  if (x >= -14 && x <= 15) return lowZero(m, 13) ? NON_SHORTEST : 0;
  if (x >= -24 && x <= -15 && lowZero(m, -1 - x)) return NON_SHORTEST;
  return 0;
}
function f64(h, l) {
  const e = (h >> 20) & 2047, mh = h & 0xfffff;
  if (e === 2047) return FLOAT;
  if (e === 0) return mh === 0 && l === 0 ? FLOAT : 0;
  const x = e - 1023;
  if (x >= 0 && x <= 52 && lowZero64(mh, l, 52 - x)) return FLOAT;
  if (x >= -126 && x <= 127) return lowZero(l, 29) ? NON_SHORTEST : 0;
  if (x >= -149 && x <= -127 && lowZero64(mh, l, -97 - x)) return NON_SHORTEST;
  return 0;
}
function float(b, pos, ai) {
  const w = ai === 25 ? 2 : ai === 26 ? 4 : 8;
  if (b.length - pos - 1 < w) return -TRUNCATED;
  const c = ai === 25 ? f16(be16(b, pos + 1)) : ai === 26 ? f32(be32(b, pos + 1)) : f64(be32(b, pos + 1), be32(b, pos + 5));
  return c === 0 ? pos + 1 + w : -c;
}

/** UTF-8 + noncharacters over b[i..end): true when valid. */
function text(b, i, end) {
  while (i < end) {
    const c = b[i];
    if (c < 0x80) { i++; continue; }
    if (c < 0xc2) return false;
    if (c < 0xe0) {
      if (i + 1 >= end || (b[i + 1] & 0xc0) !== 0x80) return false;
      i += 2;
    } else if (c < 0xf0) {
      if (i + 2 >= end) return false;
      const c1 = b[i + 1], c2 = b[i + 2];
      if ((c === 0xe0 && c1 < 0xa0) || (c === 0xed && c1 > 0x9f) || (c1 & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80) return false;
      const cp = ((c & 15) << 12) | ((c1 & 63) << 6) | (c2 & 63);
      if ((cp >= 0xfdd0 && cp <= 0xfdef) || cp >= 0xfffe) return false;
      i += 3;
    } else if (c < 0xf5) {
      if (i + 3 >= end) return false;
      const c1 = b[i + 1], c2 = b[i + 2], c3 = b[i + 3];
      if ((c === 0xf0 && c1 < 0x90) || (c === 0xf4 && c1 > 0x8f) || (c1 & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80 || (c3 & 0xc0) !== 0x80) return false;
      const cp = ((c & 7) << 18) | ((c1 & 63) << 12) | ((c2 & 63) << 6) | (c3 & 63);
      if ((cp & 0xfffe) === 0xfffe) return false;
      i += 4;
    } else return false;
  }
  return true;
}

function compare(b, s1, e1, s2, e2) {
  const l1 = e1 - s1, l2 = e2 - s2, m = l1 < l2 ? l1 : l2;
  for (let i = 0; i < m; i++) { const d = b[s1 + i] - b[s2 + i]; if (d !== 0) return d; }
  return l1 - l2;
}

/** depth, length vs remaining (n or 2n bytes), entries: 0 or -code. */
function enter(b, p, depth, pairs) {
  if (depth >= maxDepth) return -DEPTH;
  if (hi !== 0 || lo < 0 || (pairs ? lo > (b.length - p) >>> 1 : lo > b.length - p)) return -TRUNCATED;
  if (lo > maxEntries) return -TOO_MANY_ENTRIES;
  return 0;
}

/** A tag's byte-string content at p: its end (start in cs), or -code. */
function bytesContent(b, p, notBytes) {
  if (p >= b.length) return -TRUNCATED;
  const ib = b[p], ai = ib & 31;
  if (ib >> 5 !== 2) return -notBytes;
  let q = p + 1;
  if (ai < 24) { hi = 0; lo = ai; } else { q = readArg(b, p, ai); if (q < 0) return q; }
  if (hi !== 0 || lo < 0 || lo > b.length - q) return -TRUNCATED;
  cs = q;
  return q + lo;
}

const TYPED_SIZE = new Int8Array(87);
for (const t of [72]) TYPED_SIZE[t] = 1;
for (const t of [69, 77, 84]) TYPED_SIZE[t] = 2;
for (const t of [70, 78, 85]) TYPED_SIZE[t] = 4;
for (const t of [71, 79, 86]) TYPED_SIZE[t] = 8;

function mod10(b, s, e) { let r = 0; for (let i = s; i < e; i++) r = (r * 256 + b[i]) % 10; return r; }
const headSize = ai => (ai < 24 ? 1 : ai === 24 ? 2 : ai === 25 ? 3 : ai === 26 ? 5 : 9);
function smallArg(b, x) {
  const ai = b[x] & 31;
  return ai < 24 ? ai : ai === 24 ? b[x + 1] : ai === 25 ? be16(b, x + 1) : ai === 26 ? be32(b, x + 1) : be32(b, x + 5);
}

let second = 0;
/** Tag 4 / 40 content [x, y] at p: the end (second element start in `second`), or -code. */
function pair(b, p, depth, shapeCode) {
  if (p >= b.length) return -TRUNCATED;
  if (b[p] !== 0x82) return -shapeCode;
  if (++items > maxItems) return -TOO_MANY_ITEMS;
  hi = 0; lo = 2;
  const r = enter(b, p + 1, depth + 1, false);
  if (r < 0) return r;
  const q1 = item(b, p + 1, depth + 2);
  if (q1 < 0) return q1;
  const q2 = item(b, q1, depth + 2);
  if (q2 < 0) return q2;
  second = q1;
  return q2;
}

function decimal(b, p, depth) {
  const end = pair(b, p, depth, DECIMAL);
  if (end < 0) return end;
  const q1 = second, eb = b[p + 1], eai = eb & 31;
  if (eb >> 5 !== 1 || !(eai <= 24 || (eai === 25 && be16(b, p + 2) <= 1023))) return -DECIMAL;
  const ib = b[q1], major = ib >> 5, ai = ib & 31;
  if (major <= 1) {
    let r = ai >= 24 ? mod10(b, q1 + 1, end) : ai % 10;
    if (major === 1) r = (r + 1) % 10;
    return (major === 0 && ai === 0) || r === 0 ? -DECIMAL : end;
  }
  if (ib === 0xc2 || ib === 0xc3) {
    let r = mod10(b, q1 + 1 + headSize(b[q1 + 1] & 31), end);
    if (ib === 0xc3) r = (r + 1) % 10;
    return r === 0 ? -DECIMAL : end;
  }
  return -DECIMAL;
}

function ndarray(b, p, depth) {
  const end = pair(b, p, depth, NDARRAY);
  if (end < 0) return end;
  const q1 = second, db = b[q1];
  let count = -1;
  if (db >> 5 === 4) count = smallArg(b, q1);
  else if (db === 0xd8) { const size = TYPED_SIZE[b[q1 + 1]] | 0; if (size) count = (smallArg(b, q1 + 2) / size) | 0; }
  if (count < 0) return -NDARRAY;
  const sb = b[p + 1];
  if (sb >> 5 !== 4) return -NDARRAY;
  const k = smallArg(b, p + 1);
  if (k < 1 || k > 8) return -NDARRAY;
  let x = p + 1 + headSize(sb & 31), prod = 1;
  for (let j = 0; j < k; j++) {
    const xb = b[x], xai = xb & 31;
    if (xb >> 5 !== 0 || xai === 27) return -NDARRAY;
    const d = smallArg(b, x);
    if (d <= 0 || d > ((count / prod) | 0)) return -NDARRAY;
    prod *= d; x += headSize(xai);
  }
  return prod === count ? end : -NDARRAY;
}

function typed(b, p, tag, size) {
  const end = bytesContent(b, p, TYPED_ARRAY);
  if (end < 0) return end;
  const start = cs;
  if ((end - start) % size !== 0) return -TYPED_ARRAY;
  if (tag === 84) {
    for (let i = start; i < end; i += 2) { const h1 = b[i + 1]; if ((h1 & 124) === 124 && ((h1 & 3) | b[i]) !== 0) return -TYPED_ARRAY; }
  } else if (tag === 85) {
    for (let i = start; i < end; i += 4) { const s3 = b[i + 3], s2 = b[i + 2]; if ((s3 & 127) === 127 && s2 >= 128 && ((s2 & 127) | b[i + 1] | b[i]) !== 0) return -TYPED_ARRAY; }
  } else if (tag === 86) {
    for (let i = start; i < end; i += 8) {
      const t7 = b[i + 7], t6 = b[i + 6];
      if ((t7 & 127) === 127 && t6 >= 240 && ((t6 & 15) | b[i + 5] | b[i + 4] | b[i + 3] | b[i + 2] | b[i + 1] | b[i]) !== 0) return -TYPED_ARRAY;
    }
  }
  return end;
}

function tag(b, p, depth) {
  if (depth >= maxDepth) return -DEPTH;
  if (hi !== 0) return -TAG;
  const t = lo;
  if (t === 2 || t === 3) {
    const end = bytesContent(b, p, BIGNUM);
    if (end < 0) return end;
    const len = end - cs;
    return len < 9 || b[cs] === 0 || len > 128 ? -BIGNUM : end;
  }
  if (t === 4) return decimal(b, p, depth);
  if (t === 40) return ndarray(b, p, depth);
  const size = t >= 0 && t < 87 ? TYPED_SIZE[t] : 0;
  return size === 0 ? -TAG : typed(b, p, t, size);
}

function array(b, p, depth) {
  const r = enter(b, p, depth, false);
  if (r < 0) return r;
  const count = lo, inner = depth + 1;
  for (let i = 0; i < count; i++) { p = item(b, p, inner); if (p < 0) return p; }
  return p;
}

function map(b, p, depth) {
  const r = enter(b, p, depth, true);
  if (r < 0) return r;
  const count = lo, c0 = cose && depth === 0, inner = depth + 1, n = b.length;
  let prevStart = -1, prevEnd = -1;
  for (let k = 0; k < count; k++) {
    const start = p;
    if (start >= n) return -TRUNCATED;
    const km = b[start] >> 5;
    if (km !== 3 && !(c0 && km <= 1)) return -KEY_TYPE;
    p = item(b, start, inner);
    if (p < 0) return p;
    if (km <= 1 && (b[start] & 31) === 27) {
      const h = be32(b, start + 1), l = be32(b, start + 5);
      if (km === 0 ? !(h >= 0 && h <= 0x1fffff) : !(h >= 0 && (h < 0x1fffff || (h === 0x1fffff && l !== -1)))) return -KEY_TYPE;
    }
    if (prevStart >= 0) {
      const order = compare(b, prevStart, prevEnd, start, p);
      if (order === 0) return -DUPLICATE_KEY;
      if (order > 0) return -KEY_ORDER;
    }
    prevStart = start; prevEnd = p;
    p = item(b, p, inner);
    if (p < 0) return p;
  }
  return p;
}

function item(b, pos, depth) {
  if (++items > maxItems) return -TOO_MANY_ITEMS;
  const n = b.length;
  if (pos >= n) return -TRUNCATED;
  const ib = b[pos], major = ib >> 5, ai = ib & 31;
  let p = pos + 1;
  if (ai < 24) { hi = 0; lo = ai; }
  else if (major === 7 && ai >= 25 && ai <= 27) return float(b, pos, ai);
  else { p = readArg(b, pos, ai); if (p < 0) return p; }
  switch (major) {
    case 0: case 1: return p;
    case 2: return hi !== 0 || lo < 0 || lo > n - p ? -TRUNCATED : p + lo;
    case 3: {
      if (hi !== 0 || lo < 0 || lo > n - p) return -TRUNCATED;
      const end = p + lo;
      return text(b, p, end) ? end : -TEXT;
    }
    case 4: return array(b, p, depth);
    case 5: return map(b, p, depth);
    case 6: return tag(b, p, depth);
    default: return ai >= 20 && ai <= 22 ? p : -SIMPLE;
  }
}

const DEFAULTS = { top: 'map', cose: false, maxBytes: 1_500_000, maxDepth: 32, maxEntries: 65_536, maxItems: 131_072 };
export function scanHand(bytes, o = DEFAULTS) {
  const n = bytes.length;
  items = 0; cose = o.cose === true;
  maxDepth = o.maxDepth ?? 32; maxEntries = o.maxEntries ?? 65_536; maxItems = o.maxItems ?? 131_072;
  if (n > (o.maxBytes ?? 1_500_000)) return TOO_LARGE;
  if (o.top !== 'any' && (n === 0 || bytes[0] >> 5 !== 5)) return NOT_MAP;
  const r = item(bytes, 0, 0);
  if (r < 0) return -r;
  return r !== n ? TRAILING : 0;
}
