// P7.9: `snug/view` over wasm (the public entry is view.mjs; this module is internal:
// it also mints the Views of the sequence reader's checked messages, P7.13w). The view owns a copy of the message in linear
// memory (an allocation per open view; the native default also copies) and
// the check runs there. Every navigation step is a call into wasm (the kin
// nav primitives, snug.nav.walk): kind/length/get/at/skip are fine-grained
// calls, and scalars are read from linear memory (TextDecoder over a
// subarray of it). Two batched calls are offered as well:
//
//   view.path(...steps)   one call follows a chain of keys/indexes (SDK extra)
//   entries()             one call per page of 64 children (default;
//                         `{ batch: false }` at open gives the fine-grained walk)
//
// Differences from the native view, forced by linear memory: bytes(), raw()
// and typedView() copy (an alias into wasm memory is detached whenever memory
// grows, and its storage is freed with the view); `borrow` is accepted and
// ignored (the bytes must be in linear memory); a view's memory is freed by a
// FinalizationRegistry, so it is held until the JS objects are collected, or
// at once by view.release() (SDK extra).
//
// Profiles (D120, D123): the check runs under the view's profile flags; kinds
// 'tagged' and 'undefined', keys of any kind (decoded by the native builder;
// lookups encode the key with the native Writer under the view's profile, as
// the native view does), tag/content()/isUndefined(); options through the
// native validator (D150).
//
// D215 / review 2026-11-04 #3 (P7.13w): View and Cursor keep their state in private
// fields and refuse construction outside this module (a brand on its private Message
// class), so no public field or constructor reaches unchecked bytes.
import * as rt from './runtime.mjs';
import { innerOf } from './schema.mjs';
import { resolveLimits } from '../../js/src/limits.mjs';
import { SnugFault } from '../../js/src/fault.mjs';
import { validationFault } from '../../js/src/public-errors.mjs';
import { build } from '../../js/src/build.mjs';
import { TYPED_BY_TAG } from '../../js/src/values.mjs';
import { validateOptions, selectOptions } from '../../js/src/options.mjs';
import { profileFlags, codecTop, keysOf, validOk } from '../../js/src/profiles.mjs';
import { Writer } from '../../js/src/writer.mjs';

const N_MAJOR = 0, N_AI = 1, N_HI = 2, N_LO = 3, NAV_NOT_FOUND = -3;
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const DIRECTORY_MIN = 8;
const PAGE = 64;
const I32_MAX = 0x7fffffff;
const clamp = n => (n > I32_MAX ? I32_MAX : n);
const isShared = b => typeof SharedArrayBuffer === 'function' && b.buffer instanceof SharedArrayBuffer;

const messages = new FinalizationRegistry(({ allocs, gen }) => {
  if (gen === rt.generation && rt.x) for (const [p, n] of allocs) rt.x.sdk_free(p, n);
});

let viewParts = null;   // View's private state, for this module only (set in View's static block)

class Message {
  #brand = true;
  static is(m) { return m !== null && typeof m === 'object' && #brand in m; }
  constructor(ptr, n, opts) {
    this.ptr = ptr; this.end = n; this.gen = rt.generation;
    this.allocs = [[ptr, Math.max(n, 1)]];
    this.cose = opts.cose === true; this.objects = opts.objects; this.schema = opts.schema;
    this.batch = opts.batch !== false;
    this.keys = keysOf(profileFlags(opts));
    this.profile = { wire: opts.wire, keys: opts.keys, tags: opts.tags, floats: opts.floats,
      undefinedValue: opts.undefinedValue, noncharacters: opts.noncharacters };
    this.limits = { ...this.profile, maxBytes: opts.maxBytes, maxDepth: opts.maxDepth, maxEntries: opts.maxEntries,
      maxItems: opts.maxItems, maxBignumBytes: opts.maxBignumBytes, budget: opts.budget, cose: this.cose };
    this.dirs = opts.directories === true ? new Map() : null;
    this.dirWords = 0;
    this.unsorted = false;
    this.token = {};
    messages.register(this, { allocs: this.allocs, gen: this.gen }, this.token);
  }
  live() { if (this.gen !== rt.generation || this.allocs === null) throw new Error('snug wasm view: released, or the instance was reset'); }
  /** nav-head: content start; the head words are at rt.i32[rt.NAV + ...]. */
  head(p) { this.live(); return rt.x.sdk_nav_head(this.ptr, this.end, p); }
  skip(p) { this.live(); return ok(rt.x.sdk_nav_skip(this.ptr, this.end, p)); }
  byte(i) { return rt.u8[this.ptr + i]; }
  sub(s, e) { return rt.u8.subarray(this.ptr + s, this.ptr + e); }
  dir(p, n) {
    if (this.dirs === null || n < DIRECTORY_MIN) return null;
    let d = this.dirs.get(p);
    if (d === undefined) {
      d = rt.x.sdk_alloc(4 * n) >>> 0; rt.refresh();
      this.allocs.push([d, 4 * n]);
      if (rt.x.sdk_nav_dir(this.ptr, this.end, p, d, n) !== n) throw new Error('snug: view directory inconsistent');
      this.dirs.set(p, d); this.dirWords += n;
    }
    return d;
  }
  release() {
    if (this.allocs === null) return;
    if (this.gen === rt.generation) for (const [p, n] of this.allocs) rt.x.sdk_free(p, n);
    this.allocs = null; messages.unregister(this.token);
  }
}

function ok(r) {
  if (r >= 0) return r;
  if (r === NAV_NOT_FOUND) return -1;
  throw new Error(`snug view: navigation failed (${r})`);
}
const nv = i => rt.i32[rt.NAV + i];
// The tag whose kind a tag head has (D180): its number, or -2 (no known tag) beyond 32 bits.
const ruleTag = () => (nv(N_HI) === 0 ? nv(N_LO) >>> 0 : -2);

function kindAt(m, p) {
  m.head(p);
  const major = nv(N_MAJOR);
  switch (major) {
    case 0: case 1: return 'int';
    case 2: return 'bytes';
    case 3: return 'text';
    case 4: return 'array';
    case 5: return 'map';
    case 6: { const t = ruleTag(); return t === 2 || t === 3 ? 'int' : t === 4 ? 'decimal' : t === 40 ? 'ndarray' : TYPED_BY_TAG.has(t) ? 'typed' : 'tagged'; }
    default: { const ai = nv(N_AI); return ai === 20 || ai === 21 ? 'bool' : ai === 22 ? 'null' : ai === 23 ? 'undefined' : ai < 20 || ai === 24 ? 'simple' : 'float'; }
  }
}
function lengthAt(m, p) {
  const c = m.head(p), major = nv(N_MAJOR);
  if (major >= 2 && major <= 5) return nv(N_LO);
  if (major === 6) { const info = TYPED_BY_TAG.get(ruleTag()); if (info) { m.head(c); return nv(N_LO) / info.size; } }
  return undefined;
}
function textOf(m, start, n) {
  const u = rt.u8, b = m.ptr + start;
  if (n <= 8) {
    let s = '';
    for (let i = b, end = b + n; i < end; i++) { const c = u[i]; if (c >= 128) return decoder.decode(u.subarray(b, b + n)); s += String.fromCharCode(c); }
    return s;
  }
  return decoder.decode(u.subarray(b, b + n));
}
function want(ok, what) { if (!ok) throw new TypeError(`snug view: not ${what}`); }
function bigintAt(m, p) {
  const c = m.head(p), major = nv(N_MAJOR);
  if (major === 0 || major === 1) {
    const n = (BigInt(nv(N_HI) >>> 0) << 32n) | BigInt(nv(N_LO) >>> 0);
    return major === 0 ? n : -1n - n;
  }
  const tag = ruleTag();
  want(major === 6 && (tag === 2 || tag === 3), 'an integer');
  const s = m.head(c), n = nv(N_LO);
  let v = 0n;
  for (let i = s; i < s + n; i++) v = (v << 8n) | BigInt(m.byte(i));
  return tag === 2 ? v : -1n - v;
}
function safeAt(m, p) {
  m.head(p);
  const major = nv(N_MAJOR);
  if (major !== 0 && major !== 1) return undefined;
  const hi = nv(N_HI) >>> 0;
  if (hi > 0x1fffff) return undefined;
  const n = hi * 4294967296 + (nv(N_LO) >>> 0);
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
const intAt = (m, p) => { const n = safeAt(m, p); return n !== undefined ? n : bigintAt(m, p); };
function textAt(m, p) { const c = m.head(p); want(nv(N_MAJOR) === 3, 'text'); return textOf(m, c, nv(N_LO)); }
function boolAt(m, p) { m.head(p); want(nv(N_MAJOR) === 7 && (nv(N_AI) === 20 || nv(N_AI) === 21), 'a bool'); return nv(N_AI) === 21; }
function isNullAt(m, p) { m.head(p); return nv(N_MAJOR) === 7 && nv(N_AI) === 22; }
// D284: a simple value's number (kind 'simple')
function simpleAt(m, p) { want(kindAt(m, p) === 'simple', 'a simple value'); return nv(N_AI) === 24 ? nv(N_LO) : nv(N_AI); }
function payloadAt(m, p) {
  const c = m.head(p);
  if (nv(N_MAJOR) === 2) return [c, c + nv(N_LO)];
  want(nv(N_MAJOR) === 6 && TYPED_BY_TAG.has(ruleTag()), 'bytes');
  const s = m.head(c);
  return [s, s + nv(N_LO)];
}
/** The decoded key at q: text, an integer, or (any key kind) the key's value as the builder makes it. */
function keyAt(m, q) {
  const c = m.head(q), major = nv(N_MAJOR);
  if (major === 3) return textOf(m, c, nv(N_LO));
  if (major <= 1) return intAt(m, q);
  return build(m.sub(q, m.skip(q)).slice(), { objects: m.objects });
}

/** The encoded lookup key written into the wasm key scratch at `at`: [start, end) there, or null. */
function encodeKey(key, cose, at = 0, m) {
  if (typeof key === 'string') {
    const len = key.length;
    if (len < 24) {
      const k = rt.kbuf(at + 1 + len), u = rt.u8; let i = 0;
      for (; i < len; i++) { const c = key.charCodeAt(i); if (c >= 128) break; u[k + at + 1 + i] = c; }
      if (i === len) { u[k + at] = 0x60 | len; return [at, at + 1 + len]; }
    }
    const max = 9 + key.length * 3, k = rt.kbuf(at + max), u = rt.u8;
    const { written } = encoder.encodeInto(key, u.subarray(k + at + 9, k + at + max));
    let h;
    if (written < 24) h = 1; else if (written < 256) h = 2; else if (written < 65536) h = 3; else h = 5;
    const s = k + at + 9 - h;
    if (h === 1) u[s] = 0x60 | written;
    else if (h === 2) { u[s] = 0x78; u[s + 1] = written; }
    else if (h === 3) { u[s] = 0x79; u[s + 1] = written >> 8; u[s + 2] = written & 255; }
    else { u[s] = 0x7a; u[s + 1] = written >>> 24; u[s + 2] = (written >> 16) & 255; u[s + 3] = (written >> 8) & 255; u[s + 4] = written & 255; }
    return [s - k, at + 9 + written];
  }
  if ((cose || (m !== undefined && m.keys !== 0)) && (typeof key === 'bigint' || (typeof key === 'number' && Number.isSafeInteger(key) && !Object.is(key, -0)))) {
    let n = BigInt(key), major = 0;
    if (n < 0n) { major = 1; n = -1n - n; }
    if (n >= 1n << 64n) return null;
    const k = rt.kbuf(at + 9), u = rt.u8, mm = major << 5;
    if (n < 24n) { u[k + at] = mm | Number(n); return [at, at + 1]; }
    const w = n < 256n ? 1 : n < 65536n ? 2 : n < 4294967296n ? 4 : 8;
    u[k + at] = mm | (w === 1 ? 24 : w === 2 ? 25 : w === 4 ? 26 : 27);
    for (let i = w; i >= 1; i--) { u[k + at + i] = Number(n & 255n); n >>= 8n; }
    return [at, at + 1 + w];
  }
  if (m !== undefined && m.keys >= 2) {
    // any key kind: the key's deterministic encoding under the view's profile (an unencodable key finds nothing)
    let b;
    try { b = new Writer({ ...m.profile, keysSorted: false }).value(key).finish(); } catch { return null; }
    const k = rt.kbuf(at + b.length);
    rt.u8.set(b, k + at);
    return [at, at + b.length];
  }
  return null;
}
function badKey(key, m) {
  if (m.keys < 2 && typeof key !== 'string' && typeof key !== 'number' && typeof key !== 'bigint') throw new TypeError('snug view: a map key is a string or an integer here');
}
function findIn(m, p, n, key, cose) {
  const span = encodeKey(key, cose, 0, m);
  if (span === null) { badKey(key, m); return -1; }
  // keys out of canonical order (valid CBOR, P8.4): every key compared, no directory search
  if (m.unsorted) return ok(rt.x.sdk_nav_find_any(m.ptr, m.end, p, span[0], span[1]));
  const d = m.dir(p, n);
  return ok(d !== null ? rt.x.sdk_nav_dir_find(m.ptr, m.end, d, n, span[0], span[1]) : rt.x.sdk_nav_find(m.ptr, m.end, p, span[0], span[1]));
}
function elementIn(m, p, n, i) {
  if (!Number.isInteger(i)) throw new TypeError('snug view: an index is an integer');
  if (i < 0 || i >= n) return -1;
  const d = m.dir(p, n);
  if (d !== null) return rt.i32[(d >>> 2) + i];
  return ok(rt.x.sdk_nav_child(m.ptr, m.end, p, i));
}
function valueAt(m, p, depth) {
  const e = m.skip(p);
  return build(m.sub(p, e), { cose: m.cose && depth === 0, objects: m.objects });
}

let entPtr = 0, entCap = 0, entGen = -1;
function entryWords(n) {
  if (n > entCap || entGen !== rt.generation) {
    if (entCap > 0 && entGen === rt.generation) rt.x.sdk_free(entPtr, 8 * entCap);
    entCap = Math.max(n, 64, 2 * entCap); entPtr = rt.x.sdk_alloc(8 * entCap) >>> 0; entGen = rt.generation; rt.refresh();
  }
  return entPtr;
}

export class View {
  #m; #p; #d;
  constructor(m, p, depth) {
    if (!Message.is(m)) throw new TypeError('snug view: open a View with view()');
    this.#m = m; this.#p = p; this.#d = depth;
  }
  static { viewParts = v => (v !== null && typeof v === 'object' && #m in v ? [v.#m, v.#p, v.#d] : null); }
  get kind() { return kindAt(this.#m, this.#p); }
  get length() { return lengthAt(this.#m, this.#p); }
  get offset() { return this.#p; }
  get depth() { return this.#d; }
  get borrowed() { return false; }
  get(key) {
    const m = this.#m, p = this.#p;
    m.head(p); want(nv(N_MAJOR) === 5, 'a map');
    const r = findIn(m, p, nv(N_LO), key, m.cose && this.#d === 0);
    return r < 0 ? undefined : new View(m, r, this.#d + 1);
  }
  at(i) {
    const m = this.#m, p = this.#p;
    m.head(p); want(nv(N_MAJOR) === 4, 'an array');
    const r = elementIn(m, p, nv(N_LO), i);
    return r < 0 ? undefined : new View(m, r, this.#d + 1);
  }
  /** SDK extra: follow keys (strings, or integer labels at a cose root) and indexes (numbers into arrays) in ONE
   * wasm call; a View, or undefined when a step misses or meets the wrong kind. */
  path(...steps) {
    const m = this.#m; m.live();
    const n = steps.length, sp = rt.x.sdk_steps(3 * n) >>> 0; rt.refresh();
    let at = 0;
    for (let k = 0; k < n; k++) {
      const s = steps[k], w = (sp >>> 2) + 3 * k;
      if (typeof s === 'number' && !(m.cose && this.#d === 0 && k === 0)) {
        if (!Number.isInteger(s)) throw new TypeError('snug view: an index is an integer');
        rt.i32[w] = 0; rt.i32[w + 1] = s; rt.i32[w + 2] = 0;
      } else {
        const span = encodeKey(s, m.cose && this.#d === 0 && k === 0, at, m);
        if (span === null) { badKey(s, m); return undefined; }
        rt.i32[w] = 1; rt.i32[w + 1] = span[0]; rt.i32[w + 2] = span[1]; at = span[1];
      }
    }
    const r = rt.x.sdk_nav_path(m.ptr, m.end, this.#p, n);
    if (r === NAV_NOT_FOUND) return undefined;
    return new View(m, ok(r), this.#d + n);
  }
  *entries() {
    const m = this.#m, c = m.head(this.#p), major = nv(N_MAJOR), n = nv(N_LO), d = this.#d + 1;
    want(major === 4 || major === 5, 'an array or map');
    if (m.batch) {
      // pages of up to PAGE children per call: early exits stay cheap, long walks amortise the boundary
      let q = c;
      for (let i = 0; i < n;) {
        const k = Math.min(PAGE, n - i), w = entryWords(k);
        q = ok(rt.x.sdk_nav_page(m.ptr, m.end, q, k, major === 5 ? 1 : 0, w));
        const pos = rt.i32.slice(w >>> 2, (w >>> 2) + 2 * k);   // copied: a later call may grow memory
        for (let j = 0; j < k; j++, i++) yield [major === 4 ? i : keyAt(m, pos[2 * j]), new View(m, pos[2 * j + 1], d)];
      }
      return;
    }
    let q = c;
    for (let i = 0; i < n; i++) {
      if (major === 4) { yield [i, new View(m, q, d)]; q = m.skip(q); continue; }
      const v = m.skip(q), key = keyAt(m, q);
      yield [key, new View(m, v, d)];
      q = m.skip(v);
    }
  }
  *keys() { for (const [k] of this.entries()) yield k; }
  *values() { for (const [, v] of this.entries()) yield v; }
  number() { return numberAt(this.#m, this.#p, this); }
  bigint() { return bigintAt(this.#m, this.#p); }
  int() { want(kindAt(this.#m, this.#p) === 'int', 'an integer'); return intAt(this.#m, this.#p); }
  text() { return textAt(this.#m, this.#p); }
  bool() { return boolAt(this.#m, this.#p); }
  isNull() { return isNullAt(this.#m, this.#p); }
  isUndefined() { this.#m.head(this.#p); return nv(N_MAJOR) === 7 && nv(N_AI) === 23; }
  simple() { return simpleAt(this.#m, this.#p); }
  /** A tagged item's tag number (any tag, including 2/3/4/40 and typed arrays; a bigint beyond 2^53 - 1), else
   * undefined. */
  get tag() {
    this.#m.head(this.#p);
    if (nv(N_MAJOR) !== 6) return undefined;
    const hi = nv(N_HI) >>> 0, lo = nv(N_LO) >>> 0;
    return hi <= 0x1fffff ? hi * 4294967296 + lo : (BigInt(hi) << 32n) | BigInt(lo);
  }
  /** A View of a tagged item's content. */
  content() {
    const m = this.#m, c = m.head(this.#p);
    want(nv(N_MAJOR) === 6, 'a tagged item');
    return new View(m, c, this.#d + 1);
  }
  /** A copy (an alias into linear memory would not survive memory growth). */
  bytes() { const [s, e] = payloadAt(this.#m, this.#p); return this.#m.sub(s, e).slice(); }
  copyBytes() { return this.bytes(); }
  typedView() {
    const m = this.#m;
    m.head(this.#p); const tag = nv(N_LO);
    want(kindAt(m, this.#p) === 'typed', 'a typed array');
    const [s, e] = payloadAt(m, this.#p), info = TYPED_BY_TAG.get(tag), size = info.size;
    const copy = m.sub(s, e).slice(), dv = new DataView(copy.buffer);
    const get = {
      69: i => dv.getUint16(i * 2, true), 70: i => dv.getUint32(i * 4, true), 71: i => dv.getBigUint64(i * 8, true),
      72: i => dv.getInt8(i), 77: i => dv.getInt16(i * 2, true), 78: i => dv.getInt32(i * 4, true),
      79: i => dv.getBigInt64(i * 8, true), 84: i => half(dv.getUint16(i * 2, true)), 85: i => dv.getFloat32(i * 4, true),
      86: i => dv.getFloat64(i * 8, true) }[tag];
    const length = (e - s) / size;
    return Object.freeze({ tag, length, get: i => { if (!Number.isInteger(i) || i < 0 || i >= length) throw new RangeError('snug view: typed index out of range'); return get(i); } });
  }
  typed() { want(kindAt(this.#m, this.#p) === 'typed', 'a typed array'); return this.value(); }
  decimal() { want(kindAt(this.#m, this.#p) === 'decimal', 'a decimal'); return this.value(); }
  ndarray() { want(kindAt(this.#m, this.#p) === 'ndarray', 'an ndarray'); return this.value(); }
  raw() { return this.#m.sub(this.#p, this.#m.skip(this.#p)).slice(); }
  value() { return valueAt(this.#m, this.#p, this.#d); }
  cursor() { return new Cursor(this); }
  validateAt(rule, options = {}) {
    validateOptions(options, 'viewSpan');
    const m = this.#m, s = options.schema ?? m.schema;
    if (!s) throw new TypeError('snug view: validateAt needs a schema');
    const e = m.skip(this.#p), inner = innerOf(s.program), ri = s.ruleIndex(rule);
    try {
      return inner.runAt(ri, m.ptr, m.end, { ...m.limits, cose: m.cose && this.#d === 0, top: 'any' }, { start: this.#p, end: e, depth: this.#d, items: 0 });
    } catch (err) { rt.lost(err); }
  }
  /** SDK extra: free the message's linear memory now (every View and Cursor of it becomes unusable). */
  release() { this.#m.release(); }
}

function half(h) {
  const exp = (h >>> 10) & 31, frac = h & 1023;
  if (exp === 31) return frac ? NaN : (h & 32768 ? -Infinity : Infinity);
  return (h & 32768 ? -1 : 1) * (exp === 0 ? frac * 2 ** -24 : (1 + frac / 1024) * 2 ** (exp - 15));
}

export class Cursor {
  #m; #base; #p; #k; #f; #n;
  constructor(view) {
    const parts = viewParts(view);
    if (parts === null) throw new TypeError('snug view: a Cursor is made from a View');
    this.#m = parts[0]; this.#base = parts[2];
    this.#p = parts[1]; this.#k = -1;
    this.#f = new Int32Array(24); this.#n = 0;
  }
  get depth() { return this.#base + this.#n; }
  get offset() { return this.#p; }
  get kind() { return kindAt(this.#m, this.#p); }
  get length() { return lengthAt(this.#m, this.#p); }
  get key() {
    if (this.#n === 0) return undefined;
    return this.#k >= 0 ? keyAt(this.#m, this.#k) : this.#f[4 * this.#n - 3];
  }
  keyIs(s) {
    if (this.#k < 0) return false;
    const m = this.#m, e = m.skip(this.#k), span = encodeKey(s, false, 0, undefined);
    if (span === null || e - this.#k !== span[1] - span[0]) return false;
    const u = rt.u8, k = rt.kbuf(0);
    for (let i = 0; i < e - this.#k; i++) if (u[m.ptr + this.#k + i] !== u[k + span[0] + i]) return false;
    return true;
  }
  enter() {
    const m = this.#m, c = m.head(this.#p), major = nv(N_MAJOR), n = nv(N_LO);
    if ((major !== 4 && major !== 5) || n === 0) return false;
    if (4 * (this.#n + 1) > this.#f.length) { const g = new Int32Array(this.#f.length * 2); g.set(this.#f); this.#f = g; }
    const f = 4 * this.#n;
    this.#f[f] = this.#p; this.#f[f + 1] = 0; this.#f[f + 2] = n; this.#f[f + 3] = this.#k;
    this.#n++;
    if (major === 5) { this.#k = c; this.#p = m.skip(c); } else { this.#k = -1; this.#p = c; }
    return true;
  }
  next() {
    if (this.#n === 0) return false;
    const f = 4 * (this.#n - 1), i = this.#f[f + 1] + 1;
    if (i >= this.#f[f + 2]) return false;
    const m = this.#m;
    const c = m.head(this.#p), major = nv(N_MAJOR);
    const q = major <= 1 || major === 7 ? c : major <= 3 ? c + nv(N_LO) : m.skip(this.#p);
    this.#f[f + 1] = i;
    if (this.#k >= 0) { this.#k = q; this.#p = m.skip(q); } else this.#p = q;
    return true;
  }
  up() {
    if (this.#n === 0) return false;
    this.#n--;
    const f = 4 * this.#n;
    this.#p = this.#f[f]; this.#k = this.#f[f + 3];
    return true;
  }
  find(key) {
    const m = this.#m;
    m.head(this.#p); if (nv(N_MAJOR) !== 5) return false;
    const n = nv(N_LO), c = m.head(this.#p);
    const v = findIn(m, this.#p, n, key, m.cose && this.depth === 0);
    if (v < 0) return false;
    let q = c, i = 0;
    for (; i < n; i++) { const e = m.skip(q); if (e === v) break; q = m.skip(e); }
    if (4 * (this.#n + 1) > this.#f.length) { const g = new Int32Array(this.#f.length * 2); g.set(this.#f); this.#f = g; }
    const f = 4 * this.#n;
    this.#f[f] = this.#p; this.#f[f + 1] = i; this.#f[f + 2] = n; this.#f[f + 3] = this.#k;
    this.#n++; this.#k = q; this.#p = v;
    return true;
  }
  number() { return numberAt(this.#m, this.#p, this.view()); }
  bigint() { return bigintAt(this.#m, this.#p); }
  int() {
    const m = this.#m; m.head(this.#p);
    const major = nv(N_MAJOR);
    if (major === 0 && nv(N_HI) === 0 && nv(N_LO) >= 0) return nv(N_LO);
    if (major === 1 && nv(N_HI) === 0 && nv(N_LO) >= 0) return -1 - nv(N_LO);
    want(kindAt(m, this.#p) === 'int', 'an integer'); return intAt(m, this.#p);
  }
  text() { return textAt(this.#m, this.#p); }
  bool() { return boolAt(this.#m, this.#p); }
  isNull() { return isNullAt(this.#m, this.#p); }
  simple() { return simpleAt(this.#m, this.#p); }
  view() { return new View(this.#m, this.#p, this.depth); }
  value() { return valueAt(this.#m, this.#p, this.depth); }
}

/** Open a checked view: the bytes are copied into linear memory and checked there (the schema VM with a schema,
 * else the profile scanner). Options as the native view's, plus `batch` (default true). */
export function view(bytes, opts = {}) {
  // `batch` (SDK extra) is checked here; every other key by the native validator
  let rest = opts;
  if (opts !== null && typeof opts === 'object' && Object.hasOwn(opts, 'batch')) {
    const { batch, ...others } = opts;
    rest = others;
    if (opts.batch !== undefined && typeof opts.batch !== 'boolean') throw new TypeError('Invalid options.batch option.');
  }
  validateOptions(rest, 'view');
  if (!(bytes instanceof Uint8Array)) throw new TypeError('snug view: bytes must be a Uint8Array');
  if (isShared(bytes)) throw new TypeError('snug view: SharedArrayBuffer-backed input is refused (architecture §16.2)');
  rt.ready();
  const n = bytes.length;
  let ptr, r;
  try {
    ptr = rt.x.sdk_alloc(Math.max(n, 1)) >>> 0; rt.refresh();
    rt.u8.set(bytes, ptr);
    if (opts.schema) {
      if (typeof opts.rule !== 'string') throw new TypeError('snug view: a schema needs a rule');
      r = innerOf(opts.schema.program).runAt(opts.schema.ruleIndex(opts.rule), ptr, n, selectOptions(opts, 'validation'));
    } else {
      const o = selectOptions(opts, 'decode'), top = codecTop(o), limits = resolveLimits(o);
      const code = rt.x.sdk_scan(ptr, n, top === 'any' ? 1 : 0, o.cose === true ? 1 : 0, clamp(limits.maxBytes), clamp(limits.maxDepth), clamp(limits.maxEntries), clamp(limits.maxItems), profileFlags(o));
      if (code !== 0) r = { code };
    }
  } catch (e) {
    if (ptr !== undefined && rt.x && !(e instanceof WebAssembly.RuntimeError || e instanceof RangeError)) rt.x.sdk_free(ptr, Math.max(n, 1));
    rt.lost(e);
  }
  if (r && r.code !== undefined) { rt.x.sdk_free(ptr, Math.max(n, 1)); throw new SnugFault(rt.codeName(r.code)); }
  if (r && !r.ok) { rt.x.sdk_free(ptr, Math.max(n, 1)); throw validationFault(r); }
  // Valid input that is not its own deterministic form is read through its canonical copy (P8.4, D262), as the
  // native view: offsets are positions in it, raw() its canonical encodings, map order the wire's.
  const c = rt.lastCopy();
  let m;
  if (c.bytes) {
    rt.x.sdk_free(ptr, Math.max(n, 1));
    const cn = c.bytes.length;
    try { ptr = rt.x.sdk_alloc(Math.max(cn, 1)) >>> 0; rt.refresh(); rt.u8.set(c.bytes, ptr); } catch (e) { rt.lost(e); }
    m = new Message(ptr, cn, opts);
  } else m = new Message(ptr, n, opts);
  m.unsorted = c.unsorted;
  return new View(m, 0, 0);
}
/** INTERNAL (D215, P7.13w): the View of message bytes the caller has just CHECKED under
 *  `opts` -- the sequence reader, from its session's verdict -- copied into linear memory
 *  like any view's (`borrowed` is ignored: linear memory cannot borrow a JS chunk). No
 *  package entry exports this: never a public trusted opener (§16.2, V1/V2). */
/** The profile options of a checked message's options (the sequence reader's: no schema, no limits). */
const profileOptions = opts => Object.fromEntries(Object.entries(selectOptions(opts, 'decode'))
  .filter(([k, v]) => v !== undefined && k !== 'schema' && k !== 'rule'));
export function mintView(bytes, opts, _borrowed) {
  rt.ready();
  const n = bytes.length;
  let ptr;
  try { ptr = rt.x.sdk_alloc(Math.max(n, 1)) >>> 0; rt.refresh(); rt.u8.set(bytes, ptr); }
  catch (e) { rt.lost(e); }
  // A valid-CBOR message that is not its own deterministic form is read through its canonical copy (P8.4, D262), as
  // the native mintView: the profile scanner over the checked bytes, the check's limits not re-applied.
  const o = profileOptions(opts), flags = profileFlags(o);
  if (!validOk(flags)) return new View(new Message(ptr, n, opts), 0, 0);
  let code;
  try { code = rt.x.sdk_scan(ptr, n, 1, o.cose === true ? 1 : 0, clamp(n), I32_MAX, I32_MAX, I32_MAX, flags); }
  catch (e) { rt.lost(e); }
  if (code !== 0) { rt.x.sdk_free(ptr, Math.max(n, 1)); throw new SnugFault(rt.codeName(code)); }
  const c = rt.lastCopy();
  let m;
  if (c.bytes) {
    rt.x.sdk_free(ptr, Math.max(n, 1));
    const cn = c.bytes.length;
    try { ptr = rt.x.sdk_alloc(Math.max(cn, 1)) >>> 0; rt.refresh(); rt.u8.set(c.bytes, ptr); } catch (e) { rt.lost(e); }
    m = new Message(ptr, cn, opts);
  } else m = new Message(ptr, n, opts);
  m.unsorted = c.unsorted;
  return new View(m, 0, 0);
}
/** Directory words a view's message holds (for measurements). */
export function directoryWords(v) { return viewParts(v)[0].dirWords; }
