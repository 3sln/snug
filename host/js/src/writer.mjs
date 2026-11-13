// The Writer: typed calls straight to deterministic
// CBOR, with a grammar state machine. Every byte-level choice is a generated-core
// primitive (gen/js/snug/write: shortest heads, float widths by bit tests,
// integers and bignums from magnitude bytes, encoded-key comparison and the
// map-closing permutation); this host owns memory, host-value admissibility
// (lone surrogates, NaN, non-integers, classes) and the
// grammar. Semantics of value(v) are encode()'s (including its array policy).
import { SnugFault } from './fault.mjs';
import { resolveLimits } from './limits.mjs';
import { validateOptions, selectOptions } from './options.mjs';
import { profileFlags, strictArraysOf, keysOf, standardTags, anyTags, rfcFloats, undefinedOk, noncharactersOk } from './profiles.mjs';
import { Decimal, NDArray, Float16Bytes, Tagged, Simple, simpleOk, typedInfo, bignumOf } from './values.mjs';
import { copyTypedBytes } from './typed-bytes.mjs';
import { scan } from './scan.mjs';
import { WR_NEED, putHead, headLen, keyAfter } from '../../../gen/js/snug/write/out.mjs';
import { putFloat, putFloatRfc } from '../../../gen/js/snug/write/float.mjs';
import { stdAllowed, stdContentOk, stdInner } from '../../../gen/js/snug/cbor/stdtags.mjs';
import { typedSize } from '../../../gen/js/snug/cbor/tags.mjs';
import { putInt } from '../../../gen/js/snug/write/int.mjs';
import { closeMap, sortKeys, S_BUDGET } from '../../../gen/js/snug/write/map.mjs';

const MAX_SAFE = Number.MAX_SAFE_INTEGER, MAX_SAFE_N = BigInt(MAX_SAFE), U64 = 1n << 64n, U32 = 4294967296;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LITTLE_ENDIAN ? 1 : 0, LO = 1 - HI;
const f64 = new Float64Array(1), f64w = new Int32Array(f64.buffer);
const typedIncludes = Float64Array.prototype.includes;
const utf8 = new TextEncoder();
// Noncharacters U+FDD0..U+FDEF and U+xFFFE/U+xFFFF in every plane (encode.mjs's rule).
const NONCHARACTER = /[﷐-﷯￾￿]|[\uD83F\uD87F\uD8BF\uD8FF\uD93F\uD97F\uD9BF\uD9FF\uDA3F\uDA7F\uDABF\uDAFF\uDB3F\uDB7F\uDBBF\uDBFF][\uDFFE\uDFFF]/;
const scalarText = s => s.isWellFormed() && !NONCHARACTER.test(s);
const U64N = 1n << 64n;
const intKey = k => (typeof k === 'number' ? Number.isSafeInteger(k) && !Object.is(k, -0) : typeof k === 'bigint' && k >= -U64N && k < U64N);
const plainObject = v => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };
// The kin codes a writer primitive can answer (snug.cbor.codes), by cbor.mjs name.
const CODES = { 4: 'malformed', 5: 'key_type', 6: 'key_order', 7: 'duplicate_key', 9: 'float', 12: 'bignum' };
const MESSAGES = {
  malformed: 'The writer reached an inconsistent state.', key_order: 'Map keys were not supplied in order.',
  duplicate_key: 'A map has duplicate keys.', float: 'NaN, infinities, -0 and integral floats within the safe range are not encodable as floats.',
  bignum: 'Integer exceeds the bignum bound.',
  normalized: 'Two map keys are one key once a bignum is written as its integer.',
};
const MAX_BUDGET = 0x7fffffff;

// Frame kinds. The open frame is cached in #kind/#left; FAILED and DONE have
// #left 0, so every value call's single check catches them too.
const ROOT = 0, ARRAY = 1, MAP = 2, DONE = 3, FAILED = 4;

function typedPayload(v, info, fail, nanOk = false) {
  const raw = v instanceof Float16Bytes ? v.bytes : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  // The NaN rule is the Bindle tag set's (D265): above it (nanOk) any float element is written.
  if (info.tag >= 84 && !nanOk) { // NaN is refused in any payload; -0 and ±∞ are allowed here (encode.mjs).
    if (info.tag === 84) { for (let i = 0; i < raw.length; i += 2) { const h = LITTLE_ENDIAN || v instanceof Float16Bytes ? raw[i] | raw[i + 1] << 8 : raw[i] << 8 | raw[i + 1]; if ((h & 0x7c00) === 0x7c00 && (h & 0x3ff)) fail('typed_array', 'NaN is not allowed in a float array.'); } }
    else if (Object.hasOwn(v, 'length')) {
      // Retain the existing host-property behavior for unusual decorated views.
      for (let i = 0; i < v.length; i++) if (v[i] !== v[i]) fail('typed_array', 'NaN is not allowed in a float array.');
    } else if (typedIncludes.call(v, NaN)) fail('typed_array', 'NaN is not allowed in a float array.');
  }
  return raw;
}

/** Deterministic CBOR from typed calls. `new Writer({cose, keysSorted, strictArrays, limits})` (limit names may also be given at the
 * top level, as encode takes them). Values: uint, int, bigint, float, bool, null, undefined, simple, text, bytes, typed, decimal, ndarray,
 * value (any host value, encode's rules); containers: beginArray(n), beginMap(n), key(k), end(); finish() returns the
 * bytes once exactly one complete root has been written. Map keys may come in any order (sorted at end() by encoded
 * bytes) or, with keysSorted, must come in strictly increasing encoded order (checked at each key). Key kinds and
 * every other wire choice follow the profile options: `wire`, `keys`, `tags`, `floats`, `undefinedValue`,
 * `noncharacters`; integer labels in the top-level map with cose under keys 'text'. value() ignores extra array own properties unless strictArrays is true;
 * holes are refused in both modes; present undefined follows the wire profile. Malformed constructor options throw
 * TypeError; writing errors throw SnugFault and leave the writer failed for good. */
export class Writer {
  #buf = new Uint8Array(256); #pos = 0;
  #kind = ROOT; #left = 1; #depth = 0;
  #kinds = []; #lefts = []; #bases = [];   // saved frames; #bases: a map's first pair-table word
  #pairs = null; #np = 0; #base = 0;        // pair table: key start, key end per pair
  #tmp = null; #x = null; #s = null;        // close-map / sort-keys scratch (lazy)
  #kbuf = null; #kpos = 0; #xtop = 0;       // the walk's key scratch and order stack
  #mag = null;                              // bignum magnitude scratch (lazy)
  #items = 0; #code = '';
  #norms = 0; #nkey = [];                   // D348: bignums written as integers so far; per pair word, a key holding one
  #cose; #sorted; #maxDepth; #maxEntries; #maxItems; #maxBytes; #omitUndefined; #strictArrays;
  #options; #flags; #keys; #std; #anyTags; #rfc; #undef; #nonch;

  constructor(options = {}) {
    validateOptions(options, 'writer');
    const limits = resolveLimits(options.limits ? { ...selectOptions(options, 'limits'), ...selectOptions(options.limits, 'limits') } : options);
    this.#options = options;
    const flags = this.#flags = profileFlags(options);
    this.#keys = keysOf(flags); this.#std = standardTags(flags); this.#anyTags = anyTags(flags); this.#rfc = rfcFloats(flags);
    this.#undef = undefinedOk(flags); this.#nonch = noncharactersOk(flags);
    this.#cose = options.cose === true;
    this.#sorted = options.keysSorted === true;
    this.#omitUndefined = options.omitUndefined === true;
    this.#strictArrays = strictArraysOf(options) === true;
    this.#maxDepth = limits.maxDepth; this.#maxEntries = limits.maxEntries; this.#maxItems = limits.maxItems;
    const explicit = options.maxBytes ?? options.limits?.maxBytes;
    this.#maxBytes = explicit === undefined ? Infinity : limits.maxBytes;
  }

  // ------------------------------------------------------------------ failure and grammar

  #fail(code, message, subcode) {
    if (this.#kind !== FAILED) { this.#code = code; this.#kind = FAILED; this.#left = 0; }
    const e = new SnugFault(code, message);
    if (subcode) e.subcode = subcode;
    throw e;
  }
  /** A map's core refusal r over its n keys (pair table from base, key bytes in buf). duplicate_key gets the
   *  subcode `normalized` when a colliding key holds a bignum outside preferred serialization, written as its
   *  integer: such keys are one key in deterministic CBOR. Only on the failure path; no key data in the message. */
  #mapFail(r, buf, base, n) {
    if (-r === 7) {
      const groups = new Map(), t = this.#pairs;
      for (let i = 0; i < n; i++) {
        const w = base + 2 * i, k = '' + buf.subarray(t[w], t[w + 1]), g = groups.get(k), f = this.#nkey[w];
        if (g !== undefined && (g || f)) this.#normalized();
        groups.set(k, g || f);
      }
    }
    this.#kinCode(r);
  }
  #normalized() { this.#fail('duplicate_key', MESSAGES.normalized, 'normalized'); }
  #misuse(what) {
    if (this.#kind === FAILED) throw new SnugFault('writer_failed', 'The writer failed earlier and cannot be used.');
    if (this.#kind === DONE) this.#fail('grammar', 'The writer has finished.');
    if (what === 'key') {
      if (this.#kind !== MAP) this.#fail('grammar', 'A key is allowed only in a map.');
      if (this.#left === 0) this.#fail('grammar', 'The map already holds its declared number of pairs.');
      this.#fail('grammar', 'A map key needs a value before the next key.');
    }
    if (this.#kind === MAP && this.#left !== 0) this.#fail('grammar', 'A map value needs its key first.');
    if (this.#kind === ROOT) this.#fail('grammar', 'A writer holds exactly one root value.');
    this.#fail('grammar', 'The container already holds its declared number of items.');
  }
  /** One value slot in the open container (grammar only; the walk counts items). */
  #slot() {
    const left = this.#left;
    if (left === 0 || (this.#kind === MAP && (left & 1) === 0)) this.#misuse('value');
    this.#left = left - 1;
  }
  #count() { if (++this.#items > this.#maxItems) this.#fail('too_many_items', 'The message exceeds the item bound.'); }
  #kinCode(r) { const code = CODES[-r] ?? 'malformed'; this.#fail(code, MESSAGES[code] ?? 'Map keys must be valid text strings.'); }

  // ------------------------------------------------------------------ memory

  #ensure(need) {
    const want = this.#pos + need;
    if (want <= this.#buf.length) return;
    let size = this.#buf.length * 2; while (size < want) size *= 2;
    const next = new Uint8Array(size); next.set(this.#buf.subarray(0, this.#pos)); this.#buf = next;
  }
  #reservePayload(need) {
    // A large payload needs one allocation close to its known size rather
    // than rounding to a power of two (1 MiB plus a head used to take 2 MiB).
    // Keep a little room for subsequent map members, but size a root exactly.
    const want = this.#pos + need + (this.#pos <= 9 ? 0 : 256);
    if (want <= this.#buf.length) return;
    const size = Math.max(this.#buf.length * 2, want);
    const next = new Uint8Array(size); next.set(this.#buf.subarray(0, this.#pos)); this.#buf = next;
  }
  /** After a core write answered r < 0: grow for a short answer, else fail with its refusal. */
  #short(r) {
    const need = -r - WR_NEED;
    if (need <= 0) this.#kinCode(r);
    this.#ensure(need);
  }
  #head(major, hi, lo) {
    let p = putHead(this.#buf, this.#pos, major, hi, lo);
    if (p < 0) { this.#short(p); p = putHead(this.#buf, this.#pos, major, hi, lo); }
    this.#pos = p;
  }
  /** A head whose argument is a non-negative safe integer number. */
  #headN(major, n) {
    let p = putHead(this.#buf, this.#pos, major, n > 0xffffffff ? (n / U32) | 0 : 0, n | 0);
    if (p < 0) { this.#short(p); p = putHead(this.#buf, this.#pos, major, n > 0xffffffff ? (n / U32) | 0 : 0, n | 0); }
    this.#pos = p;
  }
  #raw(bytes, swap = 0) {
    if (bytes.length >= 4096 || swap > 1) { this.#rawPayload(bytes, swap); return; }
    this.#ensure(bytes.length); this.#buf.set(bytes, this.#pos); this.#pos += bytes.length;
  }
  #textBytes(bytes) { this.#ensure(bytes.length); this.#buf.set(bytes, this.#pos); this.#pos += bytes.length; }

  #rawPayload(bytes, swap) {
    this.#reservePayload(bytes.length);
    if (swap > 1) copyTypedBytes(this.#buf, this.#pos, bytes, swap, false);
    else this.#buf.set(bytes, this.#pos);
    this.#pos += bytes.length;
  }

  // ------------------------------------------------------------------ scalars (after #count)

  #intN(n) { if (n >= 0) this.#headN(0, n); else this.#headN(1, -1 - n); }
  #bigint(n, depth) {
    if (n >= -MAX_SAFE_N && n <= MAX_SAFE_N) { this.#intN(Number(n)); return; }
    const negative = n < 0n, arg = negative ? -1n - n : n;
    if (arg < U64) { this.#head(negative ? 1 : 0, Number(arg >> 32n) | 0, Number(arg & 0xffffffffn) | 0); return; }
    if (depth >= this.#maxDepth) this.#fail('depth', 'Nesting exceeds the depth bound.');
    // Magnitude bytes for kin (which decides the form and refuses beyond 128 bytes). A huge value is cut to 129
    // bytes: enough for the refusal, without copying the rest.
    let hex = arg.toString(16); if (hex.length & 1) hex = '0' + hex;
    const len = Math.min(hex.length >> 1, 129);
    if (this.#mag === null) this.#mag = new Uint8Array(129);
    const mag = this.#mag;
    for (let i = 0; i < len; i++) mag[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
    let p = putInt(this.#buf, this.#pos, negative ? 1 : 0, mag, 0, len);
    if (p < 0) { this.#short(p); p = putInt(this.#buf, this.#pos, negative ? 1 : 0, mag, 0, len); }
    this.#pos = p;
  }
  #float(v) {
    f64[0] = v;
    const hi = f64w[HI], lo = f64w[LO], put = this.#rfc ? putFloatRfc : putFloat;
    let p = put(this.#buf, this.#pos, hi, lo);
    if (p < 0) { this.#short(p); p = put(this.#buf, this.#pos, hi, lo); }
    this.#pos = p;
  }
  /** Text (code 'text') or a text key (code 'key_type'): UTF-8 with a shortest head. */
  #text(s, code) {
    const n = s.length;
    if (n <= 64) { // short ASCII written directly; anything else falls through
      const start = this.#pos;
      this.#ensure(2 + n);
      this.#headN(3, n);
      const buf = this.#buf; let p = this.#pos, i = 0;
      for (; i < n; i++) { const c = s.charCodeAt(i); if (c >= 128) break; buf[p++] = c; }
      if (i === n) { this.#pos = p; return; }
      this.#pos = start;
    }
    if (!(this.#nonch ? s.isWellFormed() : scalarText(s))) this.#fail(code, code === 'text' ? (this.#nonch ? 'Text must be well-formed Unicode.' : 'Text must be well-formed Unicode without noncharacters.') : 'Map keys must be valid text strings.');
    const max = 3 * n;
    if (this.#pos + 9 + max <= this.#buf.length) { // room for the worst case: encode in place, then fit the head
      const h = headLen(0, max), start = this.#pos;
      const { written } = utf8.encodeInto(s, this.#buf.subarray(start + h));
      const h2 = headLen(0, written);
      if (h2 !== h) this.#buf.copyWithin(start + h2, start + h, start + h + written);
      this.#headN(3, written); this.#pos += written;
      return;
    }
    const b = utf8.encode(s); this.#headN(3, b.length); this.#textBytes(b);
  }

  // ------------------------------------------------------------------ the walk (encode's rules)

  #walk(v, depth) {
    if (++this.#items > this.#maxItems) this.#fail('too_many_items', 'The message exceeds the item bound.');
    switch (typeof v) {
      case 'boolean': this.#head(7, 0, v ? 21 : 20); return;
      case 'number': {
        if (!Number.isSafeInteger(v) || Object.is(v, -0)) { this.#float(v); return; }
        // the integer head, inline (the hot path of integer-heavy bodies)
        const major = v < 0 ? 1 : 0, a = v < 0 ? -1 - v : v, hi = a > 0xffffffff ? (a / U32) | 0 : 0;
        let p = putHead(this.#buf, this.#pos, major, hi, a | 0);
        if (p < 0) { this.#short(p); p = putHead(this.#buf, this.#pos, major, hi, a | 0); }
        this.#pos = p;
        return;
      }
      case 'bigint': this.#bigint(v, depth); return;
      case 'string': this.#text(v, 'text'); return;
      case 'object': break;
      case 'undefined': if (this.#undef) { this.#head(7, 0, 23); return; }
      // fall through: undefined needs the profile's undefinedValue
      default: this.#fail('unsupported', 'Value type is not encodable under this profile.');
    }
    if (v === null) { this.#head(7, 0, 22); return; }
    if (v instanceof Uint8Array) { this.#headN(2, v.byteLength); this.#raw(v); return; }
    if (depth >= this.#maxDepth) this.#fail('depth', 'Nesting exceeds the depth bound.');
    const info = typedInfo(v);
    if (info) { const b = typedPayload(v, info, (c, m) => this.#fail(c, m), (this.#flags & 12) !== 0); this.#headN(6, info.tag); this.#headN(2, b.length); this.#raw(b, LITTLE_ENDIAN || v instanceof Float16Bytes ? 0 : info.size); return; }
    if (v instanceof Decimal) { this.#headN(6, 4); this.#walk([v.exponent, v.mantissa], depth + 1); return; }
    if (v instanceof NDArray) { this.#headN(6, 40); this.#walk([v.shape, v.data], depth + 1); return; }
    if (v instanceof Tagged) { this.#tagged(v, depth); return; }
    if (v instanceof Simple) { this.#simple(v.value); return; }
    if (Array.isArray(v)) {
      // D113: own-key enumeration is only needed for the strict/Bindle policy.
      if (Object.getPrototypeOf(v) !== Array.prototype || (this.#strictArrays && Reflect.ownKeys(v).length !== v.length + 1)) this.#fail('unsupported', 'Arrays must be dense with no extra properties.');
      if (v.length > this.#maxEntries) this.#fail('too_many_entries', 'An array exceeds the entry bound.');
      this.#headN(4, v.length);
      for (let i = 0; i < v.length; i++) {
        const value = v[i];
        if (value === undefined && !(i in v)) this.#fail('unsupported', 'Arrays must be dense with no extra properties.');
        this.#walk(value, depth + 1);
      }
      return;
    }
    const keys = [], values = [];
    if (v instanceof Map && (this.#keys !== 0 || (this.#cose && depth === 0))) {
      const kinds = this.#keys;
      for (const [k, value] of v) {
        if (kinds === 0 ? (typeof k === 'number' ? !Number.isSafeInteger(k) || Object.is(k, -0) : typeof k !== 'string')
          : kinds === 1 && typeof k !== 'string' && !intKey(k)) this.#fail('key_type', kinds === 1 ? 'Map keys must be text strings or integers.' : 'Map keys must be valid text strings.');
        keys.push(k); values.push(value);
      }
    } else {
      if (!plainObject(v)) this.#fail('unsupported', 'Value type is not encodable under this profile.');
      const omit = this.#omitUndefined;
      for (const k of Reflect.ownKeys(v)) {
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (omit && (typeof k !== 'string' || !d.enumerable)) continue;
        if (typeof k !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) this.#fail('unsupported', 'Objects must hold only enumerable data properties with text keys.');
        if (d.value === undefined && omit) continue;
        keys.push(k); values.push(d.value);
      }
    }
    const n = keys.length;
    if (n > this.#maxEntries) this.#fail('too_many_entries', 'A map exceeds the entry bound.');
    this.#headN(5, n);
    if (n === 0) return;
    if (n === 1) { this.#key(keys[0], depth); this.#count(); this.#walk(values[0], depth + 1); return; }
    // The keys are known before any value: encode them into the key scratch, let kin order them (sort-keys), then
    // write each pair in that order -- no value is ever moved. Keys are all checked before any is counted, as encode.
    const base = this.#np, xb = this.#xtop, kb0 = this.#kpos;
    this.#pairWords(base + 2 * n);
    const buf = this.#buf, pos = this.#pos;
    if (this.#kbuf === null) this.#kbuf = new Uint8Array(256);
    this.#buf = this.#kbuf; this.#pos = kb0;
    try {
      for (let i = 0; i < n; i++) {
        const ks = this.#pos, n0 = this.#norms;
        this.#key(keys[i], depth);
        this.#pairs[base + 2 * i] = ks; this.#pairs[base + 2 * i + 1] = this.#pos;
        this.#nkey[base + 2 * i] = this.#norms !== n0;
      }
    } finally { this.#kbuf = this.#buf; this.#kpos = this.#pos; this.#buf = buf; this.#pos = pos; }
    this.#np = base + 2 * n;
    this.#xWords(xb + 2 * n);
    if (this.#s === null) this.#s = new Int32Array(4);
    this.#s[0] = 0; this.#s[S_BUDGET] = MAX_BUDGET;
    const r = sortKeys(this.#kbuf, this.#pairs, base, n, this.#x, xb, this.#s);
    if (r !== 0) this.#mapFail(r, this.#kbuf, base, n);
    this.#xtop = xb + n;
    for (let i = 0; i < n; i++) {
      const j = this.#x[xb + i], t = this.#pairs, ks = t[base + 2 * j], len = t[base + 2 * j + 1] - ks;
      this.#ensure(len);
      const kb = this.#kbuf, out = this.#buf, p0 = this.#pos;
      for (let q = 0; q < len; q++) out[p0 + q] = kb[ks + q];
      this.#pos = p0 + len;
      this.#count();
      this.#walk(values[j], depth + 1);
    }
    this.#np = base; this.#xtop = xb; this.#kpos = kb0;
  }
  /** A map key in the walk, already admitted by the profile: text, an integer, or (any key kind) any value, encoded
   * by a separate walk whose items count toward this writer's bound. */
  #key(k, depth) {
    if (typeof k === 'string') { this.#text(k, 'key_type'); return; }
    if (typeof k === 'number' && Number.isSafeInteger(k) && !Object.is(k, -0)) { this.#intN(k); return; }
    if (typeof k === 'bigint' && k >= -U64N && k < U64N) { this.#bigint(k, depth + 1); return; }
    const b = this.#subValue(k, depth + 1);
    this.#ensure(b.length); this.#buf.set(b, this.#pos); this.#pos += b.length;
  }
  /** v encoded by a fresh walk at `depth` under this writer's options; its items, but for the one the caller counts,
   * are added to this writer's. Used for map keys that are containers, tags or other values. */
  #subValue(v, depth) {
    const sub = new Writer(this.#options);
    sub.#walk(v, depth);
    this.#norms += sub.#norms;
    this.#items += sub.#items - 1;
    if (this.#items > this.#maxItems) this.#fail('too_many_items', 'The message exceeds the item bound.');
    return sub.#buf.subarray(0, sub.#pos);
  }
  /** A tag outside the Bindle set: the tag number and its content are checked by the core after the content
   * is written (snug.cbor.stdtags, by the rule tag: the number; beyond 32 bits -2, or -1 for 2^64 - 1; a tag-24 payload by the
   * scanner under this profile). */
  #tagged(v, depth) {
    const t = v.tag, rule = typeof t === 'bigint' || t > 0xffffffff ? (t === 0xffffffffffffffffn ? -1 : -2) : t | 0;
    if ((t === 2 || t === 3) && v.value instanceof Uint8Array) {
      // a bignum outside preferred serialization decodes to a Tagged of its bytes (D342): written as its integer, in
      // preferred serialization (as Rust's Value::BigInt). D348: counted, for a key collision this makes.
      if (v.value.length < 9 || v.value[0] === 0) this.#norms++;
      this.#bigint(bignumOf(t, v.value), depth);
      return;
    }
    if ((t === 4 || t === 40) && (this.#flags & 12) !== 0) {
      // above the Bindle tag set a decimal fraction or ndarray outside Decimal's / NDArray's invariants decodes to a
      // Tagged (D265, D267): written as given, its content held to the RFC rules by the scanner
      const start = this.#pos;
      this.#headN(6, t);
      this.#walk(v.value, depth + 1);
      try { scan(this.#buf.subarray(start, this.#pos), { ...selectOptions(this.#options, 'decode'), top: 'any' }); }
      catch (e) { if (e instanceof SnugFault) this.#fail(e.code, 'The tag content does not satisfy its tag.'); throw e; }
      return;
    }
    if (!stdAllowed(this.#flags, rule, depth)) {
      if (t === 2 || t === 3 || t === 4 || t === 40 || typedSize(rule) > 0) this.#fail('tag', 'This tag has its own value type (a bigint, Decimal, NDArray or typed array).');
      this.#fail('tag', !this.#std ? 'Tagged values need the standard tag set or any tags (profile option tags).'
        : t === 55799 ? 'Tag 55799 is allowed only at the top level.' : this.#anyTags ? 'This tag is not allowed here.' : 'This tag is not in the standard set (profile option tags: \'any\').');
    }
    if (typeof t === 'bigint') this.#head(6, Number(t >> 32n) | 0, Number(t & 0xffffffffn) | 0);
    else this.#headN(6, t);
    const q = this.#pos;
    this.#walk(v.value, depth + 1);
    if (!stdContentOk(this.#buf, rule, q, this.#pos)) this.#fail('tag', 'The tag content does not satisfy its tag.');
    if (rule === 24) {
      try { scan(this.#buf.subarray(stdInner(this.#buf, q), this.#pos), { ...selectOptions(this.#options, 'decode'), top: 'any' }); }
      catch (e) { if (e instanceof SnugFault) this.#fail(e.code, 'A tag-24 payload must be one valid data item.'); throw e; }
    }
  }
  #xWords(words) {
    if (this.#x === null) this.#x = new Int32Array(Math.max(64, words));
    else if (words > this.#x.length) { const x = new Int32Array(Math.max(words, 2 * this.#x.length)); x.set(this.#x.subarray(0, this.#xtop)); this.#x = x; }
  }
  #pairWords(words) {
    if (this.#pairs === null) this.#pairs = new Int32Array(Math.max(64, words));
    else if (words > this.#pairs.length) { const t = new Int32Array(Math.max(words, 2 * this.#pairs.length)); t.set(this.#pairs.subarray(0, this.#np)); this.#pairs = t; }
  }
  /** Sort one map's n pairs (table from base, content ending here) through the core. */
  #close(base, n) {
    if (n < 2) return;
    if (this.#s === null) this.#s = new Int32Array(4);
    if (this.#tmp === null) this.#tmp = new Uint8Array(256);
    if (this.#x === null) this.#x = new Int32Array(64);
    this.#s[0] = 0; this.#s[S_BUDGET] = MAX_BUDGET;
    for (;;) {
      const r = closeMap(this.#buf, this.#pairs, base, n, this.#pos, this.#tmp, this.#x, this.#s);
      if (r === 0) return;
      const need = -r - WR_NEED;
      if (need < 0) this.#mapFail(r, this.#buf, base, n);
      if (2 * n > this.#x.length) this.#x = new Int32Array(Math.max(2 * n, 2 * this.#x.length));
      if (need > this.#tmp.length) this.#tmp = new Uint8Array(Math.max(need, 2 * this.#tmp.length));
    }
  }

  // ------------------------------------------------------------------ public values

  /** Any host value, by encode()'s rules (as one value in the open container). */
  value(v) { this.#slot(); this.#walk(v, this.#depth); return this; }
  /** An unsigned integer (major type 0): a non-negative safe integer number, or a bigint below 2^64. */
  uint(n) {
    if (typeof n === 'number' ? !(Number.isSafeInteger(n) && n >= 0) || Object.is(n, -0) : typeof n !== 'bigint' || n < 0n || n >= U64) this.#badArgument('uint expects a non-negative safe integer or a bigint below 2^64.');
    this.#slot(); this.#count();
    if (typeof n === 'number') this.#headN(0, n); else this.#bigint(n, this.#depth);
    return this;
  }
  /** An integer: a safe integer number, or a bigint of any size up to the profile's bignum bound. */
  int(n) {
    if (typeof n === 'number') { if (!Number.isSafeInteger(n) || Object.is(n, -0)) this.#badArgument('int expects a safe integer number or a bigint.'); }
    else if (typeof n !== 'bigint') this.#badArgument('int expects a safe integer number or a bigint.');
    this.#slot(); this.#count();
    if (typeof n === 'number') this.#intN(n); else this.#bigint(n, this.#depth);
    return this;
  }
  /** An integer from a bigint (a bignum, tag 2/3, beyond 64 bits). */
  bigint(n) {
    if (typeof n !== 'bigint') this.#badArgument('bigint expects a bigint.');
    this.#slot(); this.#count(); this.#bigint(n, this.#depth);
    return this;
  }
  /** A float in the shortest exact width. Under the Bindle float rules NaN, ±∞, ±0 and integral values within
   * ±(2^53-1) are refused (code float; use int() or value() for integers); under the deterministic rules
   * nothing is refused: NaN is written as f97e00, ±∞ and ±0 as float16, 1 as f93c00. */
  float(v) {
    if (typeof v !== 'number') this.#badArgument('float expects a number.');
    this.#slot(); this.#count(); this.#float(v);
    return this;
  }
  bool(v) { if (typeof v !== 'boolean') this.#badArgument('bool expects a boolean.'); this.#slot(); this.#count(); this.#head(7, 0, v ? 21 : 20); return this; }
  null() { this.#slot(); this.#count(); this.#head(7, 0, 22); return this; }
  /** The simple value undefined (f7); needs the profile's undefinedValue. */
  undefined() {
    if (!this.#undef) this.#badArgument('undefined needs the profile option undefinedValue.');
    this.#slot(); this.#count(); this.#head(7, 0, 23); return this;
  }
  /** A simple value other than false/true/null/undefined: n in 0..19 or 32..255, or a Simple; written in its
   * shortest form (one byte below 24, else f8 n). Needs the profile's undefinedValue (code simple otherwise). */
  simple(n) {
    const v = n instanceof Simple ? n : new Simple(n);
    this.#slot(); this.#count(); this.#simple(v.value); return this;
  }
  #simple(n) {
    if (!simpleOk(n)) this.#fail('simple', 'A simple value is an integer in 0..19 or 32..255.');
    if (!this.#undef) this.#fail('simple', 'Simple values other than false, true and null need the profile option undefinedValue.');
    this.#headN(7, n);
  }
  /** A tag outside the Bindle set with its content (as value(new Tagged(tag, content))); tag a number or bigint. */
  tagged(tag, content) { const v = new Tagged(tag, content); this.#slot(); this.#walk(v, this.#depth); return this; }
  text(s) { if (typeof s !== 'string') this.#badArgument('text expects a string.'); this.#slot(); this.#count(); this.#text(s, 'text'); return this; }
  bytes(b) { if (!(b instanceof Uint8Array)) this.#badArgument('bytes expects a Uint8Array.'); this.#slot(); this.#count(); this.#headN(2, b.byteLength); this.#raw(b); return this; }
  typed(a) { if (!typedInfo(a)) this.#badArgument('typed expects a typed array other than Uint8Array, or Float16Bytes.'); this.#slot(); this.#walk(a, this.#depth); return this; }
  decimal(d) { if (!(d instanceof Decimal)) this.#badArgument('decimal expects a Decimal.'); this.#slot(); this.#walk(d, this.#depth); return this; }
  ndarray(a) { if (!(a instanceof NDArray)) this.#badArgument('ndarray expects an NDArray.'); this.#slot(); this.#walk(a, this.#depth); return this; }
  #badArgument(message) {
    if (this.#kind === FAILED) throw new SnugFault('writer_failed', 'The writer failed earlier and cannot be used.');
    this.#fail('unsupported', message);
  }

  // ------------------------------------------------------------------ containers

  #begin(n, major, what) {
    if (!Number.isSafeInteger(n) || n < 0) this.#badArgument(`${what} expects a non-negative safe integer count.`);
    this.#slot(); this.#count();
    if (this.#depth >= this.#maxDepth) this.#fail('depth', 'Nesting exceeds the depth bound.');
    if (n > this.#maxEntries) this.#fail('too_many_entries', major === 4 ? 'An array exceeds the entry bound.' : 'A map exceeds the entry bound.');
    this.#headN(major, n);
    this.#kinds.push(this.#kind); this.#lefts.push(this.#left); this.#bases.push(this.#base);
    this.#depth++;
  }
  /** Opens an array of exactly n items. */
  beginArray(n) { this.#begin(n, 4, 'beginArray'); this.#kind = ARRAY; this.#left = n; return this; }
  /** Opens a map of exactly n pairs: key(k) then a value, n times. */
  beginMap(n) {
    this.#begin(n, 5, 'beginMap');
    this.#kind = MAP; this.#left = 2 * n; this.#base = this.#np;
    this.#pairWords(this.#np + 2 * n);
    return this;
  }
  /** The next key of the open map: a string; an integer (number or bigint) with keys 'integer' or 'any', or (keys
   * 'text', cose, top-level map only) a safe integer label; any value with keys 'any'. */
  key(k) {
    const left = this.#left;
    if (this.#kind !== MAP || left === 0 || (left & 1) === 1) this.#misuse('key');
    if (typeof k !== 'string') {
      if (this.#keys === 0) {
        if (!(typeof k === 'number' && this.#cose && this.#depth === 1 && Number.isSafeInteger(k) && !Object.is(k, -0))) this.#fail('key_type', 'Map keys must be valid text strings.');
      } else if (this.#keys === 1 && !intKey(k)) this.#fail('key_type', 'Map keys must be text strings or integers.');
    }
    this.#left = left - 1;
    this.#count();
    const t = this.#pairs, at = this.#np, ks = this.#pos, n0 = this.#norms;
    this.#key(k, this.#depth - 1);
    this.#nkey[at] = this.#norms !== n0;
    if (this.#sorted && at > this.#base) {
      const r = keyAfter(this.#buf, t[at - 2], t[at - 1], ks, this.#pos);
      if (r === -7 && (this.#nkey[at] || this.#nkey[at - 2])) this.#normalized();
      if (r < 0) this.#kinCode(r);
    }
    t[at] = ks; t[at + 1] = this.#pos; this.#np = at + 2;
    return this;
  }
  /** Closes the open array or map, which must hold exactly its declared items. */
  end() {
    const kind = this.#kind;
    if (kind !== ARRAY && kind !== MAP) {
      if (kind === FAILED) throw new SnugFault('writer_failed', 'The writer failed earlier and cannot be used.');
      this.#fail('grammar', kind === DONE ? 'The writer has finished.' : 'end() without an open array or map.');
    }
    if (this.#left !== 0) this.#fail('grammar', 'The container holds fewer items than declared.');
    if (kind === MAP) {
      if (!this.#sorted) this.#close(this.#base, (this.#np - this.#base) >> 1);
      this.#np = this.#base;
    }
    this.#depth--;
    this.#kind = this.#kinds.pop(); this.#left = this.#lefts.pop(); this.#base = this.#bases.pop();
    return this;
  }
  /** The bytes of the one complete root value. The writer is finished afterwards. */
  finish() {
    if (this.#kind !== ROOT || this.#left !== 0) {
      if (this.#kind === FAILED) throw new SnugFault('writer_failed', 'The writer failed earlier and cannot be used.');
      this.#fail('grammar', this.#kind === DONE ? 'The writer has finished.' : 'finish() before the root value is complete.');
    }
    if (this.#pos > this.#maxBytes) this.#fail('too_large', 'The encoding exceeds the size bound.');
    this.#kind = DONE;
    // This buffer has no external aliases and DONE forbids further writes.
    // Hand off exact-size storage directly; otherwise return an exact copy.
    if (this.#pos === this.#buf.length) return this.#buf;
    return this.#buf.slice(0, this.#pos);
  }
  /** The failure code, or '' while the writer has not failed. */
  get failure() { return this.#code; }
}

/** encode(value, options) as one value through a Writer. */
export function writeValue(value, options = {}) {
  return new Writer(options).value(value).finish();
}
