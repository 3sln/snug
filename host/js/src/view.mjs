// Views and a cursor over CHECKED CBOR (architecture §16, owner decision D026;
// first slice, DEVLOG P5.2, D050-D054), under any profile (D120).
//
//   view(bytes, { schema, rule, borrow, directories, ...decodeOptions }) -> View
//
// Opening a view runs the full check first: the profile scanner, or, when a
// schema is given, the schema VM (one fused pass: profile + schema). Nothing
// is read before the check accepts, and nothing is ever re-checked: every
// navigation step is a kin primitive (snug.nav.walk) whose early exits and
// binary searches are sound only because the check proved the key order.
//
// Ownership (§16.2). By default the view OWNS its bytes: they are copied at
// open (the check runs on the copy), so later writes to the caller's buffer
// cannot falsify it. `borrow: true` skips the copy; the caller then promises
// not to modify the buffer for as long as any View, Cursor or alias from it
// is used (a broken promise gives wrong answers, never an out-of-bounds read:
// the primitives bound every step). SharedArrayBuffer-backed input is refused
// either way. `bytes()` and `raw()` are zero-copy aliases: into the caller's
// buffer when borrowed, into the view's private copy when owned -- read-only
// by contract (JS has no read-only Uint8Array); `copyBytes()` always copies.
//
// Index (§16.4, private until measured; D053). `directories: true` lets the
// view build, on first use of an array or map with at least 8 children, a
// directory of child offsets (one word per child) held by the view's message
// state (never the VM scratch); map lookups then binary-search it and array
// access is O(1). Without it, lookups are linear with an early exit.
import { navInit, navHead, navSkip, navLength, navChild, navFind, navDir, navDirFind,
  N_MAJOR, N_AI, N_HI, N_LO, N_STEPS, NAV_WORDS, NAV_NOT_FOUND } from '../../../gen/js/snug/nav/walk.mjs';
import { scan } from './scan.mjs';
import { build } from './build.mjs';
import { TYPED_BY_TAG } from './values.mjs';
import { profileFlags, keysOf } from './profiles.mjs';
import { Writer } from './writer.mjs';
import { validateOptions, selectOptions } from './options.mjs';

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const DIRECTORY_MIN = 8;
const isShared = b => typeof SharedArrayBuffer === 'function' && b.buffer instanceof SharedArrayBuffer;

// ------------------------------------------------------------------ message state

class Message {
  constructor(b, opts) {
    this.b = b; this.end = b.length;
    this.o = new Int32Array(NAV_WORDS);
    navInit(this.o, 0x7fffffff);
    this.cose = opts.cose === true;
    this.objects = opts.objects;
    this.schema = opts.schema;
    this.keys = keysOf(profileFlags(opts));
    this.profile = { wire: opts.wire, keys: opts.keys, tags: opts.tags, floats: opts.floats,
      undefinedValue: opts.undefinedValue, noncharacters: opts.noncharacters };
    this.limits = { ...this.profile, maxBytes: opts.maxBytes, maxDepth: opts.maxDepth, maxEntries: opts.maxEntries,
      maxItems: opts.maxItems, maxBignumBytes: opts.maxBignumBytes, budget: opts.budget, cose: this.cose };
    this.dirs = opts.directories === true ? new Map() : null;
    this.dirWords = 0;
  }
  head(p) { return navHead(this.b, this.o, p, this.end); }
  // Each operation is charged from zero: the step budget bounds one walk, not the view's lifetime.
  skip(p) { this.o[N_STEPS] = 0; return ok(navSkip(this.b, this.o, p, this.end)); }
  /** The child directory of the container at p (count n known), or null. */
  dir(p, n) {
    if (this.dirs === null || n < DIRECTORY_MIN) return null;
    let d = this.dirs.get(p);
    if (d === undefined) {
      d = new Int32Array(n);
      this.o[N_STEPS] = 0;
      if (navDir(this.b, this.o, p, d, this.end) !== n) throw new Error('snug: view directory inconsistent');
      this.dirs.set(p, d); this.dirWords += n;
    }
    return d;
  }
}

/** A primitive's answer: a position, NAV_NOT_FOUND as -1; anything else is a broken invariant (bytes changed under a
 * borrowed view, or a bug), never a silent miss. */
function ok(r) {
  if (r >= 0) return r;
  if (r === NAV_NOT_FOUND) return -1;
  throw new Error(`snug view: navigation failed (${r}); were borrowed bytes modified?`);
}

// ------------------------------------------------------------------ scalar readers (shared by View and Cursor)

// The tag whose kind a tag head has (D180): its number, or -2 (no known tag) beyond 32 bits.
const ruleTag = o => (o[N_HI] === 0 ? o[N_LO] >>> 0 : -2);

function kindAt(m, p) {
  m.head(p);
  const o = m.o, major = o[N_MAJOR];
  switch (major) {
    case 0: case 1: return 'int';
    case 2: return 'bytes';
    case 3: return 'text';
    case 4: return 'array';
    case 5: return 'map';
    case 6: { const t = ruleTag(o); return t === 2 || t === 3 ? 'int' : t === 4 ? 'decimal' : t === 40 ? 'ndarray' : TYPED_BY_TAG.has(t) ? 'typed' : 'tagged'; }
    default: { const ai = o[N_AI]; return ai === 20 || ai === 21 ? 'bool' : ai === 22 ? 'null' : ai === 23 ? 'undefined' : 'float'; }
  }
}

function lengthAt(m, p) {
  const c = m.head(p), o = m.o, major = o[N_MAJOR];
  if (major >= 2 && major <= 5) return o[N_LO];
  if (major === 6) {
    const info = TYPED_BY_TAG.get(ruleTag(o));
    if (info) { m.head(c); return m.o[N_LO] / info.size; }
  }
  return undefined;
}

function textOf(b, start, n) {
  if (n <= 8) {
    let s = '';
    for (let i = start, end = start + n; i < end; i++) {
      const c = b[i];
      if (c >= 128) return decoder.decode(b.subarray(start, start + n));
      s += String.fromCharCode(c);
    }
    return s;
  }
  return decoder.decode(b.subarray(start, start + n));
}

function want(ok, what) { if (!ok) throw new TypeError(`snug view: not ${what}`); }

/** The integer at p as [major 0|1 or tag 2|3, hi, lo] read into m.o; returns a bigint. */
function bigintAt(m, p) {
  const c = m.head(p), o = m.o, major = o[N_MAJOR];
  if (major === 0 || major === 1) {
    const n = (BigInt(o[N_HI] >>> 0) << 32n) | BigInt(o[N_LO] >>> 0);
    return major === 0 ? n : -1n - n;
  }
  const tag = ruleTag(o);
  want(major === 6 && (tag === 2 || tag === 3), 'an integer');
  const s = m.head(c), n = m.o[N_LO];
  let v = 0n;
  for (let i = s; i < s + n; i++) v = (v << 8n) | BigInt(m.b[i]);
  return tag === 2 ? v : -1n - v;
}

/** A safe integer as a number, else undefined (the head is left in m.o). */
function safeAt(m, p) {
  m.head(p);
  const o = m.o, major = o[N_MAJOR];
  if (major !== 0 && major !== 1) return undefined;
  const hi = o[N_HI] >>> 0;
  if (hi > 0x1fffff) return undefined;
  const n = hi * 4294967296 + (o[N_LO] >>> 0);
  if (major === 0) return n;
  return n < MAX_SAFE ? -1 - n : undefined;
}

function numberAt(m, p, v) {
  const k = kindAt(m, p);
  if (k === 'float') return v.value();
  want(k === 'int', 'a number');
  const n = safeAt(m, p);
  if (n === undefined) throw new RangeError('snug view: integer outside ±(2^53-1); use bigint()');
  return n;
}

function intAt(m, p) {
  const n = safeAt(m, p);
  return n !== undefined ? n : bigintAt(m, p);
}

function textAt(m, p) {
  const c = m.head(p);
  want(m.o[N_MAJOR] === 3, 'text');
  return textOf(m.b, c, m.o[N_LO]);
}

function boolAt(m, p) {
  m.head(p);
  const o = m.o;
  want(o[N_MAJOR] === 7 && (o[N_AI] === 20 || o[N_AI] === 21), 'a bool');
  return o[N_AI] === 21;
}

function isNullAt(m, p) { m.head(p); return m.o[N_MAJOR] === 7 && m.o[N_AI] === 22; }

/** [start, end) of a byte string's content, or of a typed array's little-endian payload. */
function payloadAt(m, p) {
  const c = m.head(p), o = m.o;
  if (o[N_MAJOR] === 2) return [c, c + o[N_LO]];
  want(o[N_MAJOR] === 6 && TYPED_BY_TAG.has(ruleTag(o)), 'bytes');
  const s = m.head(c);
  return [s, s + m.o[N_LO]];
}

/** The decoded key at q: text, an integer, or (any key kind) the key's value as the builder makes it. */
function keyAt(m, q) {
  const c = m.head(q), o = m.o, major = o[N_MAJOR];
  if (major === 3) return textOf(m.b, c, o[N_LO]);
  if (major <= 1) return intAt(m, q);
  return build(m.b.subarray(q, m.skip(q)), { objects: m.objects });
}

// The encoded form of a lookup key, in a reused scratch (synchronous use only).
let keyBuf = new Uint8Array(64);
function encodeKey(key, cose, m) {
  if (typeof key === 'string') {
    // short ASCII keys (the common case) without the encoder
    const len = key.length;
    if (len < 24) {
      let i = 0;
      for (; i < len; i++) { const c = key.charCodeAt(i); if (c >= 128) break; keyBuf[1 + i] = c; }
      if (i === len) { keyBuf[0] = 0x60 | len; return [0, 1 + len]; }
    }
    const max = 9 + key.length * 3;
    if (keyBuf.length < max) keyBuf = new Uint8Array(Math.max(max, keyBuf.length * 2));
    // Write after a 9-byte gap, then place the head right before the text.
    const { written } = encoder.encodeInto(key, keyBuf.subarray(9));
    let h;
    if (written < 24) h = 1; else if (written < 256) h = 2; else if (written < 65536) h = 3; else h = 5;
    const s = 9 - h;
    if (h === 1) keyBuf[s] = 0x60 | written;
    else if (h === 2) { keyBuf[s] = 0x78; keyBuf[s + 1] = written; }
    else if (h === 3) { keyBuf[s] = 0x79; keyBuf[s + 1] = written >> 8; keyBuf[s + 2] = written & 255; }
    else { keyBuf[s] = 0x7a; keyBuf[s + 1] = written >>> 24; keyBuf[s + 2] = (written >> 16) & 255; keyBuf[s + 3] = (written >> 8) & 255; keyBuf[s + 4] = written & 255; }
    return [s, 9 + written];
  }
  if ((cose || (m !== undefined && m.keys !== 0)) && (typeof key === 'bigint' || (typeof key === 'number' && Number.isSafeInteger(key) && !Object.is(key, -0)))) {
    let n = BigInt(key), major = 0;
    if (n < 0n) { major = 1; n = -1n - n; }
    if (n >= 1n << 64n) return null;
    const m = major << 5;
    if (n < 24n) { keyBuf[0] = m | Number(n); return [0, 1]; }
    const w = n < 256n ? 1 : n < 65536n ? 2 : n < 4294967296n ? 4 : 8;
    keyBuf[0] = m | (w === 1 ? 24 : w === 2 ? 25 : w === 4 ? 26 : 27);
    for (let i = w; i >= 1; i--) { keyBuf[i] = Number(n & 255n); n >>= 8n; }
    return [0, 1 + w];
  }
  if (m !== undefined && m.keys >= 2) {
    // any key kind: the key's deterministic encoding under the view's profile (an unencodable key finds nothing)
    let b;
    try { b = new Writer({ ...m.profile, keysSorted: false }).value(key).finish(); } catch { return null; }
    if (keyBuf.length < b.length) keyBuf = new Uint8Array(Math.max(b.length, keyBuf.length * 2));
    keyBuf.set(b, 0);
    return [0, b.length];
  }
  return null;
}

/** The value position of `key` in the map at p (with n pairs), or -1. */
function findIn(m, p, n, key, cose) {
  const span = encodeKey(key, cose, m);
  if (span === null) {
    if (m.keys < 2 && typeof key !== 'string' && typeof key !== 'number' && typeof key !== 'bigint') throw new TypeError('snug view: a map key is a string or an integer here');
    return -1;
  }
  const d = m.dir(p, n);
  m.o[N_STEPS] = 0;
  return ok(d !== null ? navDirFind(m.b, m.o, d, n, keyBuf, span[0], span[1], m.end) : navFind(m.b, m.o, p, keyBuf, span[0], span[1], m.end));
}

function elementIn(m, p, n, i) {
  if (!Number.isInteger(i)) throw new TypeError('snug view: an index is an integer');
  if (i < 0 || i >= n) return -1;
  const d = m.dir(p, n);
  if (d !== null) return d[i];
  m.o[N_STEPS] = 0;
  return ok(navChild(m.b, m.o, p, i, m.end));
}

function valueAt(m, p, depth) {
  const e = m.skip(p);
  return build(m.b.subarray(p, e), { cose: m.cose && depth === 0, objects: m.objects });
}

// ------------------------------------------------------------------ View

/** An item of a checked message. Immutable; cheap (message + offset + depth). */
export class View {
  constructor(m, p, depth) { this._m = m; this._p = p; this._d = depth; }
  /** 'int' | 'float' | 'bytes' | 'text' | 'bool' | 'null' | 'undefined' | 'array' | 'map' | 'decimal' | 'ndarray' |
   * 'typed' | 'tagged' (any other tag the profile admits, D121, D180) */
  get kind() { return kindAt(this._m, this._p); }
  /** Entries of an array or map, bytes of a bytes/text item, elements of a typed array; else undefined. */
  get length() { return lengthAt(this._m, this._p); }
  /** Offset of this item in the message, and its depth (the root is 0). */
  get offset() { return this._p; }
  get depth() { return this._d; }
  /** Was the message borrowed (true) or copied at open (false)? */
  get borrowed() { return this._m.borrowed; }

  /** The value under `key` in a map, or undefined: a string; an integer (number or bigint) when the profile admits
   * integer keys (or in the top-level map of a cose view); any value with keys 'any', compared by its encoding. */
  get(key) {
    const m = this._m, p = this._p;
    m.head(p); want(m.o[N_MAJOR] === 5, 'a map');
    const r = findIn(m, p, m.o[N_LO], key, m.cose && this._d === 0);
    return r < 0 ? undefined : new View(m, r, this._d + 1);
  }
  /** Element i of an array, or undefined. */
  at(i) {
    const m = this._m, p = this._p;
    m.head(p); want(m.o[N_MAJOR] === 4, 'an array');
    const r = elementIn(m, p, m.o[N_LO], i);
    return r < 0 ? undefined : new View(m, r, this._d + 1);
  }
  /** [key, View] per map entry in encoded-key order, or [index, View] per array element. */
  *entries() {
    const m = this._m, c = m.head(this._p), major = m.o[N_MAJOR], n = m.o[N_LO], d = this._d + 1;
    want(major === 4 || major === 5, 'an array or map');
    let q = c;
    for (let i = 0; i < n; i++) {
      if (major === 4) { yield [i, new View(m, q, d)]; q = m.skip(q); continue; }
      const v = m.skip(q), key = keyAt(m, q);
      yield [key, new View(m, v, d)];
      q = m.skip(v);
    }
  }
  /** Map keys (decoded) or array indices. */
  *keys() { for (const [k] of this.entries()) yield k; }
  /** Views of the values (map) or elements (array). */
  *values() { for (const [, v] of this.entries()) yield v; }

  /** An int as a number (RangeError outside ±(2^53-1)); a float as a number. */
  number() { return numberAt(this._m, this._p, this); }
  /** Any int (including tags 2/3) as a bigint. */
  bigint() { return bigintAt(this._m, this._p); }
  /** An int as a number when safe, else a bigint (build()'s choice). */
  int() { want(kindAt(this._m, this._p) === 'int', 'an integer'); return intAt(this._m, this._p); }
  text() { return textAt(this._m, this._p); }
  bool() { return boolAt(this._m, this._p); }
  isNull() { return isNullAt(this._m, this._p); }
  isUndefined() { const m = this._m; m.head(this._p); return m.o[N_MAJOR] === 7 && m.o[N_AI] === 23; }
  /** A tagged item's tag number (any tag, including 2/3/4/40 and typed arrays; a bigint beyond 2^53 - 1), else
   * undefined. */
  get tag() {
    const m = this._m; m.head(this._p);
    if (m.o[N_MAJOR] !== 6) return undefined;
    const hi = m.o[N_HI] >>> 0, lo = m.o[N_LO] >>> 0;
    return hi <= 0x1fffff ? hi * 4294967296 + lo : (BigInt(hi) << 32n) | BigInt(lo);
  }
  /** A View of a tagged item's content. */
  content() {
    const m = this._m, c = m.head(this._p);
    want(m.o[N_MAJOR] === 6, 'a tagged item');
    return new View(m, c, this._d + 1);
  }
  /** A byte string's content (or a typed array's little-endian payload) as a zero-copy alias; read-only by contract. */
  bytes() { const [s, e] = payloadAt(this._m, this._p); return this._m.b.subarray(s, e); }
  /** The same bytes, copied. */
  copyBytes() { const [s, e] = payloadAt(this._m, this._p); return this._m.b.slice(s, e); }
  /** A typed array as a portable accessor over its payload: { tag, length, get(i) } (little-endian reads; no alignment needed). */
  typedView() {
    const m = this._m;
    m.head(this._p); const tag = m.o[N_LO];
    want(kindAt(m, this._p) === 'typed', 'a typed array');
    const [s, e] = payloadAt(m, this._p), info = TYPED_BY_TAG.get(tag), size = info.size;
    const dv = new DataView(m.b.buffer, m.b.byteOffset + s, e - s);
    const get = {
      69: i => dv.getUint16(i * 2, true), 70: i => dv.getUint32(i * 4, true), 71: i => dv.getBigUint64(i * 8, true),
      72: i => dv.getInt8(i), 77: i => dv.getInt16(i * 2, true), 78: i => dv.getInt32(i * 4, true),
      79: i => dv.getBigInt64(i * 8, true), 84: i => half(dv.getUint16(i * 2, true)), 85: i => dv.getFloat32(i * 4, true),
      86: i => dv.getFloat64(i * 8, true) }[tag];
    const length = (e - s) / size;
    return Object.freeze({ tag, length, get: i => { if (!Number.isInteger(i) || i < 0 || i >= length) throw new RangeError('snug view: typed index out of range'); return get(i); } });
  }
  /** A typed array copied into an aligned native typed array (Float16Bytes where Float16Array is missing). */
  typed() { want(kindAt(this._m, this._p) === 'typed', 'a typed array'); return this.value(); }
  /** A decimal (tag 4) as the builder's Decimal. */
  decimal() { want(kindAt(this._m, this._p) === 'decimal', 'a decimal'); return this.value(); }
  /** An ndarray (tag 40) as the builder's NDArray. */
  ndarray() { want(kindAt(this._m, this._p) === 'ndarray', 'an ndarray'); return this.value(); }
  /** This item's canonical encoding: a zero-copy alias of its span (read-only by contract). */
  raw() { return this._m.b.subarray(this._p, this._m.skip(this._p)); }
  /** Materialise this subtree with the trusted builder (decode()'s values). */
  value() { return valueAt(this._m, this._p, this._d); }
  /** A mutable cursor starting at this item. */
  cursor() { return new Cursor(this); }
  /** Detached validation (§16.3): does this subtree's span match `rule` (and the profile) as its own document?
   * Says nothing about the ancestors. Uses the view's schema unless one is given. */
  validateAt(rule, options = {}) {
    validateOptions(options, 'viewSpan');
    const { schema } = options;
    const m = this._m, s = schema ?? m.schema;
    if (!s) throw new TypeError('snug view: validateAt needs a schema');
    const e = m.skip(this._p);
    return s.validateAt(m.b, this._p, e, rule, { ...m.limits, cose: m.cose && this._d === 0, top: 'any', depth: this._d });
  }
}

function half(h) {
  const exp = (h >>> 10) & 31, frac = h & 1023;
  if (exp === 31) return frac ? NaN : (h & 32768 ? -Infinity : Infinity);
  return (h & 32768 ? -1 : 1) * (exp === 0 ? frac * 2 ** -24 : (1 + frac / 1024) * 2 ** (exp - 15));
}

// ------------------------------------------------------------------ Cursor

/** A mutable position for allocation-free walks:
 *
 *     const c = v.cursor();
 *     if (c.enter()) do { c.key; c.kind; c.number(); } while (c.next());
 *     c.up();     // only after a successful enter()
 */
export class Cursor {
  constructor(view) {
    this._m = view._m; this._base = view._d;
    this._p = view._p; this._k = -1;            // current item, and its key's position (map entries) or -1
    this._f = new Int32Array(24); this._n = 0;  // frames: container, index, count, saved key position
  }
  get depth() { return this._base + this._n; }
  get offset() { return this._p; }
  get kind() { return kindAt(this._m, this._p); }
  get length() { return lengthAt(this._m, this._p); }
  /** The current entry's key (decoded), or its index in an array; undefined at the cursor's root. */
  get key() {
    if (this._n === 0) return undefined;
    return this._k >= 0 ? keyAt(this._m, this._k) : this._f[4 * this._n - 3];
  }
  /** Does the current entry's key equal this string, compared as encoded bytes (no allocation)? */
  keyIs(s) {
    if (this._k < 0) return false;
    const m = this._m, e = m.skip(this._k), span = encodeKey(s, false, undefined);
    if (span === null || e - this._k !== span[1] - span[0]) return false;
    for (let i = 0; i < e - this._k; i++) if (m.b[this._k + i] !== keyBuf[span[0] + i]) return false;
    return true;
  }
  /** Into the current array or map: to its first element (or first entry's value). False, and no move, when not a container or empty. */
  enter() {
    const m = this._m, c = m.head(this._p), major = m.o[N_MAJOR], n = m.o[N_LO];
    if ((major !== 4 && major !== 5) || n === 0) return false;
    if (4 * (this._n + 1) > this._f.length) { const g = new Int32Array(this._f.length * 2); g.set(this._f); this._f = g; }
    const f = 4 * this._n;
    this._f[f] = this._p; this._f[f + 1] = 0; this._f[f + 2] = n; this._f[f + 3] = this._k;
    this._n++;
    if (major === 5) { this._k = c; this._p = m.skip(c); } else { this._k = -1; this._p = c; }
    return true;
  }
  /** To the next sibling; false (no move) after the last one or at the cursor's root. */
  next() {
    if (this._n === 0) return false;
    const f = 4 * (this._n - 1), i = this._f[f + 1] + 1;
    if (i >= this._f[f + 2]) return false;
    const m = this._m;
    // the end of the current item: scalars and strings from their head, containers by a structural skip
    const c = m.head(this._p), major = m.o[N_MAJOR];
    const q = major <= 1 || major === 7 ? c : major <= 3 ? c + m.o[N_LO] : m.skip(this._p);
    this._f[f + 1] = i;
    if (this._k >= 0) { this._k = q; this._p = m.skip(q); } else this._p = q;
    return true;
  }
  /** Back to the enclosing container; false at the cursor's root. */
  up() {
    if (this._n === 0) return false;
    this._n--;
    const f = 4 * this._n;
    this._p = this._f[f]; this._k = this._f[f + 3];
    return true;
  }
  /** Within the current map, move to the entry with this key (true), or stay (false). */
  find(key) {
    const m = this._m;
    m.head(this._p); if (m.o[N_MAJOR] !== 5) return false;
    const n = m.o[N_LO], c = m.head(this._p);
    const v = findIn(m, this._p, n, key, m.cose && this.depth === 0);
    if (v < 0) return false;
    // the key ends where the value starts; find the key's start by walking (directory or sequential)
    let q = c, i = 0;
    const d = m.dir(this._p, n);
    if (d !== null) { let lo = 0, hi = n - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; const e = m.skip(d[mid]); if (e === v) { i = mid; q = d[mid]; break; } if (e < v) lo = mid + 1; else hi = mid - 1; } }
    else for (; i < n; i++) { const e = m.skip(q); if (e === v) break; q = m.skip(e); }
    if (4 * (this._n + 1) > this._f.length) { const g = new Int32Array(this._f.length * 2); g.set(this._f); this._f = g; }
    const f = 4 * this._n;
    this._f[f] = this._p; this._f[f + 1] = i; this._f[f + 2] = n; this._f[f + 3] = this._k;
    this._n++; this._k = q; this._p = v;
    return true;
  }
  number() { return numberAt(this._m, this._p, this.view()); }
  bigint() { return bigintAt(this._m, this._p); }
  int() {
    const m = this._m; m.head(this._p);
    const major = m.o[N_MAJOR];
    if (major === 0 && m.o[N_HI] === 0 && m.o[N_LO] >= 0) return m.o[N_LO];   // fast path: below 2^31
    if (major === 1 && m.o[N_HI] === 0 && m.o[N_LO] >= 0) return -1 - m.o[N_LO];
    want(kindAt(m, this._p) === 'int', 'an integer'); return intAt(m, this._p);
  }
  text() { return textAt(this._m, this._p); }
  bool() { return boolAt(this._m, this._p); }
  isNull() { return isNullAt(this._m, this._p); }
  /** A View of the current item (allocates one small object). */
  view() { return new View(this._m, this._p, this.depth); }
  value() { return valueAt(this._m, this._p, this.depth); }
}

// ------------------------------------------------------------------ open

/** Open a checked view. Options: schema + rule (validate with the schema VM, else the profile scanner), borrow,
 * directories, and the decode options (top, cose, maxBytes, maxDepth, maxEntries, maxItems, objects). Throws as
 * decode()/schema.decode() would when the bytes are refused. */
export function view(bytes, opts = {}) {
  validateOptions(opts, 'view');
  if (!(bytes instanceof Uint8Array)) throw new TypeError('snug view: bytes must be a Uint8Array');
  if (isShared(bytes)) throw new TypeError('snug view: SharedArrayBuffer-backed input is refused (architecture §16.2)');
  const borrowed = opts.borrow === true;
  const b = borrowed ? bytes : new Uint8Array(bytes);   // owned: the check runs on the private copy
  if (opts.schema) {
    if (typeof opts.rule !== 'string') throw new TypeError('snug view: a schema needs a rule');
    const r = opts.schema.validate(b, opts.rule, selectOptions(opts, 'validation'));
    if (!r.ok) { const e = new Error(`snug: ${r.reason}`); e.reason = r.reason; e.path = r.path; e.offset = r.offset; if (r.subcode) e.subcode = r.subcode; throw e; }
  } else scan(b, selectOptions(opts, 'decode'));
  const m = new Message(b, opts);
  m.borrowed = borrowed;
  return new View(m, 0, 0);
}

/** INTERNAL (D215): the View of bytes the caller has just CHECKED under `opts` -- the sequence
 * reader, from its session's verdict. No package entry exports this: it is a capability of
 * the modules that ran the check, never a public trusted opener (§16.2, V1/V2). */
export function mintView(b, opts, borrowed) {
  const m = new Message(b, opts);
  m.borrowed = borrowed;
  return new View(m, 0, 0);
}

/** Directory words a view's message holds (for measurements). */
export function directoryWords(v) { return v._m.dirWords; }
