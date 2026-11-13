// Session stress cases for bb vmsession-test (P6.2): shapes whose pieces cross
// windows in every way the resumable session handles -- long map keys (copied
// into the key arena), keys queried by LITSET and regexp key typesets, long
// texts under several regexps at once, LIT / LITSET on long strings, byte
// strings read twice (`.bits` with `.cbor`, `.cbor` with `.cborseq`), nested
// `.cbor`, float typed arrays with content tails, tag 4/40 pairs whose elements
// are framed, cose integer keys -- valid and broken (order, duplicates, bad
// UTF-8, truncation, bit flips), under random budgets and item limits.
//
//   sessionCases(n, seed) -> [{cddl, lim: [9 words], bytes: Uint8Array, label}]

function rng(seed) {
  let x = (seed >>> 0) || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  return { int: n => next() % n, pick: xs => xs[next() % xs.length], bool: (k = 2) => next() % k === 0 };
}

// ---------------------------------------------------------------- a raw deterministic encoder
const enc = new TextEncoder();
function head(major, n) {
  const m = major << 5;
  if (n < 24) return [m | n];
  if (n < 256) return [m | 24, n];
  if (n < 65536) return [m | 25, n >> 8, n & 255];
  return [m | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
const cat = parts => { const out = []; for (const p of parts) for (const x of p) out.push(x); return out; };
const uint = n => head(0, n);
const nint = n => head(1, n);           // -1 - n
const text = s => { const b = typeof s === 'string' ? Array.from(enc.encode(s)) : s; return cat([head(3, b.length), b]); };
const bytes = b => cat([head(2, b.length), b]);
const arr = items => cat([head(4, items.length), ...items]);
const tag = (t, c) => cat([head(6, t), c]);
function cmp(a, b) { const m = Math.min(a.length, b.length); for (let i = 0; i < m; i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; }
function map(pairs, R, fault) {
  // pairs [[keyBytes, valueBytes]] sorted by encoded key; faults swap or duplicate
  const ps = pairs.slice().sort((x, y) => cmp(x[0], y[0]));
  for (let i = ps.length - 1; i > 0; i--) if (cmp(ps[i][0], ps[i - 1][0]) === 0) ps.splice(i, 1);
  if (fault && ps.length >= 2 && R.bool(3)) { const i = R.int(ps.length - 1); [ps[i], ps[i + 1]] = [ps[i + 1], ps[i]]; }
  else if (fault && ps.length >= 1 && R.bool(3)) { const i = R.int(ps.length); ps.splice(i, 0, ps[i]); }
  return cat([head(5, ps.length), ...ps.map(([k, v]) => cat([k, v]))]);
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
function word(R, len, alpha = LETTERS) { let s = ''; for (let i = 0; i < len; i++) s += alpha[R.int(alpha.length)]; return s; }
function keyLen(R) { return R.pick([0, 1, 2, 5, 9, 23, 24, 30, 64, 100, 255, 256, 300, 700, 1500]); }
function badUtf8(R, b) { const c = b.slice(); if (c.length) c[R.int(c.length)] = R.pick([0xff, 0xc0, 0xed, 0x80, 0xf5]); return c; }

const LIT1 = 'a'.repeat(42), LIT2 = 'bbbb', LIT3 = 'c'.repeat(41) + '0';
const TLIT1 = 'x'.repeat(64), TLIT2 = 'yy', TLIT3 = 'z'.repeat(65) + '1';
const LIT = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const SHAPES = [
  // 0: nested maps with long keys (arena copies at several levels)
  ['r = { * tstr => int / r }', (R, F) => {
    const gen = depth => map(Array.from({ length: R.int(depth > 2 ? 3 : 6) }, () => {
      let k = text(word(R, keyLen(R)));
      if (F && R.bool(12)) k = text(badUtf8(R, Array.from(enc.encode(word(R, 1 + keyLen(R))))));
      return [k, depth < 3 && R.bool(3) ? gen(depth + 1) : uint(R.int(100000))];
    }), R, F);
    return gen(0);
  }],
  // 1: regexp key typeset and regexp values
  ['r = { * (tstr .regexp "[a-z]*") => [* tstr .regexp "(ab)*c?"] }', (R, F) =>
    map(Array.from({ length: R.int(5) }, () => [text(word(R, keyLen(R), F && R.bool(6) ? 'abZ' : LETTERS)),
      arr(Array.from({ length: R.int(4) }, () => text('ab'.repeat(R.pick([0, 1, 5, 40, 300])) + (R.bool() ? 'c' : '') + (F && R.bool(5) ? 'q' : ''))))]), R, F)],
  // 2: named keys among long ones
  ['r = { ? "alpha" => int, ? "beta" => tstr, * tstr => any }', (R, F) =>
    map([...(R.bool() ? [[text('alpha'), F && R.bool(4) ? text('x') : uint(3)]] : []),
      ...(R.bool() ? [[text('beta'), text(word(R, R.pick([0, 3, 400])))]] : []),
      ...Array.from({ length: R.int(4) }, () => [text(word(R, keyLen(R))), R.bool() ? uint(1) : text(word(R, R.pick([5, 900])))])], R, F)],
  // 3: a LITSET key typeset with long literals
  [`r = { * ("${LIT1}" / "${LIT2}" / "${LIT3}") => int }`, (R, F) =>
    map(Array.from({ length: R.int(4) }, () => [text(R.pick([LIT1, LIT2, LIT3, F ? 'a'.repeat(42 + R.int(2)) : LIT2])), uint(R.int(9))]), R, F)],
  // 4: LITSET and LIT on long texts
  [`r = [* ("${TLIT1}" / "${TLIT2}" / "${TLIT3}" / tstr .size 3)]`, (R, F) =>
    arr(Array.from({ length: R.int(6) }, () => text(R.pick([TLIT1, TLIT2, TLIT3, 'abc', F ? 'x'.repeat(63) + 'y' : TLIT1, F ? TLIT3.slice(0, -1) + '2' : TLIT2]))))],
  [`r = [* "${LIT}"]`, (R, F) => arr(Array.from({ length: R.int(5) }, () => text(F && R.bool(4) ? LIT.slice(0, -1) + 'X' : LIT)))],
  // 6: a byte string read twice: .bits and .cbor
  ['f = &(a: 0, b: 1, c: 9)\nr = [* (bstr .bits f / bstr .cbor [* int])]', (R, F) =>
    arr(Array.from({ length: R.int(4) }, () => R.bool()
      ? bytes(Array.from({ length: R.pick([0, 1, 2, 300]) }, (_, i) => i === 0 ? R.pick([1, 2, 3, F ? 255 : 0]) : (i === 1 ? R.pick([0, 2, F ? 8 : 0]) : 0)))
      : bytes(arr(Array.from({ length: R.int(200) }, () => uint(R.int(1000)))).concat(F && R.bool(3) ? [0xff] : []))))],
  // 7: .cbor and .cborseq on one byte string
  ['r = [* (bstr .cbor [* int] / bstr .cborseq [* tstr])]', (R, F) =>
    arr(Array.from({ length: R.int(4) }, () => R.bool()
      ? bytes(arr(Array.from({ length: R.int(100) }, () => uint(R.int(50000)))))
      : bytes(cat(Array.from({ length: R.int(30) }, () => text(word(R, R.pick([0, 3, 90])))).concat(F && R.bool(3) ? [[0xff]] : [])))))],
  // 8: nested .cbor
  ['r = bstr .cbor (bstr .cbor { * tstr => [* int] })', (R, F) =>
    bytes(bytes(map(Array.from({ length: R.int(4) }, () => [text(word(R, keyLen(R))), arr(Array.from({ length: R.int(50) }, () => F && R.bool(40) ? text('x') : uint(R.int(9))))]), R, F)))],
  // 9: float typed arrays with content tails
  ['r = [* (#6.85(bstr .size (0..4000)) / #6.86(bstr) / #6.84(bstr .size (0..64)))]', (R, F) =>
    arr(Array.from({ length: R.int(4) }, () => {
      const t = R.pick([84, 85, 86]), sz = { 84: 2, 85: 4, 86: 8 }[t];
      const n = R.pick([0, 1, 3, 40, 900]);
      const b = Array.from({ length: n * sz }, () => R.int(256));
      if (F && b.length && R.bool(3)) { const i = R.int(n) * sz; for (let j = 0; j < sz; j++) b[i + j] = 0xff; }
      return tag(t, bytes(F && R.bool(9) ? b.concat([1]) : b));
    }))],
  // 10: ndarrays whose shape and data cross windows
  ['r = [* #6.40([dims: [+ uint], data: #6.86(bstr) / [* number]])]', (R, F) =>
    arr(Array.from({ length: R.int(3) }, () => {
      const dims = Array.from({ length: 1 + R.int(3) }, () => 1 + R.int(9));
      let count = dims.reduce((a, b) => a * b, 1);
      if (F && R.bool(3)) count += 1;
      const data = R.bool() ? tag(86, bytes(Array.from({ length: count * 8 }, (_, i) => (i % 8 === 7 ? 0x3f : 0)))) : arr(Array.from({ length: count }, () => uint(R.int(5))));
      return tag(40, arr([arr(dims.map(uint)), data]));
    }))],
  // 11: decimals with bignum mantissas
  ['r = [* #6.4([int, integer])]', (R, F) =>
    arr(Array.from({ length: R.int(5) }, () => {
      const e = F && R.bool(5) ? uint(3) : nint(R.int(30));
      const m = R.bool() ? (F && R.bool(5) ? uint(10) : uint(1 + R.int(9) + 10 * R.int(100))) : tag(R.pick([2, 3]), bytes([1 + R.int(200), ...Array.from({ length: 8 + R.int(20) }, () => R.int(256))]));
      return tag(4, arr([e, m]));
    }))],
  // 12: several regexps on one long text
  ['r = [* (tstr .regexp "a*b" / tstr .regexp "[ab]*c" / tstr .size (0..3))]', (R, F) =>
    arr(Array.from({ length: R.int(5) }, () => text('a'.repeat(R.pick([0, 2, 70, 500])) + R.pick(['b', 'c', 'ab', 'ac', F ? 'x' : 'b']))))],
  // 13: everything dead under any, with long keys and long strings
  ['r = [* any]', (R, F) =>
    arr(Array.from({ length: R.int(4) }, () => map(Array.from({ length: R.int(5) }, () => [text(word(R, keyLen(R))), R.bool() ? text(word(R, R.pick([0, 400]))) : bytes(Array.from({ length: R.pick([3, 2000]) }, () => R.int(256)))]), R, F)))],
  // 14-16 (D350, P9.9): embedded refusals after byte strings whose bytes are malformed
  // heads (an indefinite uint, a break, a reserved ai, a cut head) or empty, under the
  // valid preset (word 9 = 378): the canonical path gives such content its own copy, and
  // a refusal at the end of the main copy must map to the input, not into that copy
  ['r = [* (bstr .size 1 / bstr .cbor uint)]', (R, F) => arr(Array.from({ length: 1 + R.int(4) }, () => bytes(badContent(R, F)))), 378],
  ['r = { * tstr => bstr / bstr .cbor uint }', (R, F) =>
    map(Array.from({ length: 1 + R.int(4) }, (_, i) => [text(LETTERS[i]), bytes(badContent(R, F))]), R, false), 378],
  ['r = [bstr, * bstr .cbor uint]', (R, F) => arr([bytes(badContent(R, true)), ...Array.from({ length: R.int(3) }, () => bytes(badContent(R, F)))]), 378],
];
function badContent(R, F) {
  return R.pick([[], [0x1f], [0xff], [0x1c], [0x18], [0x5f], [0x01], [0x18, 0x20], F ? [0x7f] : [0x02], F ? [] : [0x03]]);
}

/** n cases of each shape (valid, then faulty, bit-flipped, truncated), with random limits. */
export function sessionCases(n, seed) {
  const R = rng(seed * 2654435761 + 7);
  const out = [];
  SHAPES.forEach(([cddl, gen, pf], si) => {
    for (let k = 0; k < n; k++) {
      const F = k % 2 === 1;
      let b = Uint8Array.from(gen(R, F));
      if (F && R.bool(4) && b.length > 1) { b = b.slice(); const at = R.int(b.length); b[at] ^= 1 << R.int(8); }
      if (F && R.bool(5)) b = b.subarray(0, R.int(b.length + 1));
      const lim = [1, 0, -1, -1, -1, R.bool(6) ? R.int(400) : -1, -1, R.bool(4) ? 50 + R.int(6000) : -1, 0];
      if (pf !== undefined) lim.push(pf);
      out.push({ cddl, lim, bytes: b, label: `session shape ${si} #${k}` });
    }
  });
  // cose integer keys at the top level
  for (let k = 0; k < n; k++) {
    const pairs = Array.from({ length: R.int(6) }, () => [R.bool() ? uint(R.int(70000)) : nint(R.int(500)), text(word(R, R.pick([1, 300])))]);
    out.push({ cddl: 'r = { * int => tstr }', lim: [0, 1, -1, -1, -1, -1, -1, R.bool(4) ? 30 + R.int(800) : -1, 0], bytes: Uint8Array.from(map(pairs, R, k % 2 === 1)), label: `session cose #${k}` });
  }
  return out;
}
