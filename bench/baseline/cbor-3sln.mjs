// Bindle CBOR profile codec (docs/architecture/cbor-rpc-spike.md revision 2, phase 1; provisional, unsigned except the
// owner-approved points of spike §8: unrestricted integers with bignums, decimals allowed, shortest floats, own strict
// codec). RFC 8949 §4.2.1 core deterministic encoding, required on encode and verified on decode, plus the spike §2
// rules: text map keys only, no indefinite lengths, no simple values other than false/true/null, an explicit tag
// allow-list (2, 3 bignums; 4 decimal fractions; RFC 8746 little-endian typed arrays 69-72, 77-79, 84-86; 40 row-major
// multi-dimensional arrays), scalar NaN/±Infinity/-0 refused and an integral float within ±(2^53-1) refused.
// Because exactly one byte sequence decodes to each accepted value, decode→encode is the identity on bytes.
// Pure and runtime-neutral (Workers, browsers, Node); imports nothing. The SDK re-exports it (packages/sdk/src/cbor.mjs).
// Fault messages never echo decoded values or input bytes (spike §6 item 7).

export class CBORFault extends Error {
  constructor(code = 'malformed', message = 'The CBOR data is not valid under the Bindle profile.') { super(message); this.name = 'CBORFault'; this.code = code; }
}
const fail = (code, message) => { throw new CBORFault(code, message); };

/** Spike defaults (§2.2, §2.3, §4.3; resource bounds provisional). */
export const LIMITS = Object.freeze({
  maxBytes: 1_500_000,
  maxDepth: 32,
  maxEntries: 65_536,
  maxItems: 131_072,
  maxBignumBytes: 128,
  minDecimalExponent: -1024,
  maxDimensions: 8,
});
export const MEDIA_TYPE = 'application/vnd.bindle.rpc+cbor';
export const RPC_FINGERPRINT_DOMAIN = 'bindle-rpc-fingerprint-v1';

const MAX_SAFE = Number.MAX_SAFE_INTEGER, MAX_SAFE_N = BigInt(MAX_SAFE), U64 = 1n << 64n;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const utf8 = new TextEncoder(), utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Noncharacters U+FDD0..U+FDEF and U+xFFFE/U+xFFFF in every plane (same rule as strict-json scalarString).
const NONCHARACTER = /[﷐-﷯￾￿]|[\uD83F\uD87F\uD8BF\uD8FF\uD93F\uD97F\uD9BF\uD9FF\uDA3F\uDA7F\uDABF\uDAFF\uDB3F\uDB7F\uDBBF\uDBFF][\uDFFE\uDFFF]/;
const scalarText = s => s.isWellFormed() && !NONCHARACTER.test(s);

// ---------------------------------------------------------------------------------------------------------------------
// Value types

const DECIMAL_LITERAL = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const normalInteger = n => (n >= -MAX_SAFE_N && n <= MAX_SAFE_N ? Number(n) : n);
const absBig = n => (n < 0n ? -n : n);
const bignumBytes = n => { const hex = n.toString(16); return (hex.length + 1) >> 1; };

/** An exact decimal fraction (CBOR tag 4) in normalized form: mantissa a non-zero bigint not divisible by 10, exponent a
 * negative integer ≥ LIMITS.minDecimalExponent. Value only, no scale: 1.50 and 1.5 are the same decimal. Immutable; no
 * arithmetic; numeric coercion and JSON.stringify throw so a decimal is never rounded silently (spike §2.6). */
export class BindleDecimal {
  constructor(mantissa, exponent) {
    if (typeof mantissa !== 'bigint' || mantissa === 0n || mantissa % 10n === 0n) fail('decimal', 'A decimal mantissa must be a non-zero bigint without trailing zeros.');
    if (!Number.isSafeInteger(exponent) || exponent >= 0 || exponent < LIMITS.minDecimalExponent) fail('decimal', 'A decimal exponent must be a negative integer within the profile bound.');
    const magnitude = absBig(mantissa) - (mantissa < 0n ? 1n : 0n);
    if (magnitude >= U64 && bignumBytes(magnitude) > LIMITS.maxBignumBytes) fail('bignum', 'A decimal mantissa exceeds the bignum bound.');
    this.mantissa = mantissa; this.exponent = exponent; Object.freeze(this);
  }
  /** Parses an exact plain decimal literal ("-12.340"); returns a BindleDecimal, or a number/bigint when the value is
   * integral (spike §2.2 rule 6). Exponent notation, "+", leading zeros and empty fractions are refused. */
  static from(text) {
    if (typeof text !== 'string' || text.length > 4096) fail('decimal', 'Not an exact decimal literal.');
    const match = DECIMAL_LITERAL.exec(text); if (!match) fail('decimal', 'Not an exact decimal literal.');
    let digits = match[2] + (match[3] ?? ''), exponent = -(match[3]?.length ?? 0);
    let mantissa = BigInt(digits); if (match[1]) mantissa = -mantissa;
    return BindleDecimal.normalize(mantissa, exponent);
  }
  /** mantissa × 10^exponent in normal form: an integer (number when safe, else bigint) or a BindleDecimal. */
  static normalize(mantissa, exponent) {
    if (typeof mantissa !== 'bigint' || !Number.isSafeInteger(exponent)) fail('decimal', 'Invalid decimal components.');
    if (mantissa === 0n) return 0;
    while (exponent < 0 && mantissa % 10n === 0n) { mantissa /= 10n; exponent++; }
    if (exponent >= 0) {
      if (exponent > 1100) fail('decimal', 'Decimal value exceeds the profile bound.');
      const n = mantissa * 10n ** BigInt(exponent), tagged = n < 0n ? -1n - n : n;
      if (tagged >= U64 && bignumBytes(tagged) > LIMITS.maxBignumBytes) fail('bignum', 'Integer exceeds the bignum bound.');
      return normalInteger(n);
    }
    return new BindleDecimal(mantissa, exponent);
  }
  toString() {
    const negative = this.mantissa < 0n, digits = absBig(this.mantissa).toString(), scale = -this.exponent;
    const padded = digits.length <= scale ? '0'.repeat(scale - digits.length + 1) + digits : digits;
    return (negative ? '-' : '') + padded.slice(0, padded.length - scale) + '.' + padded.slice(padded.length - scale);
  }
  valueOf() { throw new TypeError('BindleDecimal cannot be converted to a number.'); }
  [Symbol.toPrimitive](hint) { if (hint === 'string') return this.toString(); throw new TypeError('BindleDecimal cannot be converted to a number.'); }
  toJSON() { throw new TypeError('BindleDecimal has no JSON form; map it to a decimal string explicitly.'); }
}
Object.freeze(BindleDecimal.prototype);

/** Little-endian float16 elements held as bytes, used for tag 84 only where the runtime has no Float16Array. */
export class Float16Bytes {
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength % 2) fail('typed_array', 'Float16 data must be an even number of bytes.');
    this.bytes = bytes.slice(); this.length = bytes.byteLength / 2; Object.freeze(this);
  }
}
Object.freeze(Float16Bytes.prototype);
const HAS_FLOAT16 = typeof globalThis.Float16Array === 'function';

// Allowed RFC 8746 tags: little-endian typed arrays only; 64 and 68 refused (uint8 data is a byte string).
const TYPED = [
  [69, globalThis.Uint16Array, 2], [70, globalThis.Uint32Array, 4], [71, globalThis.BigUint64Array, 8], [72, globalThis.Int8Array, 1],
  [77, globalThis.Int16Array, 2], [78, globalThis.Int32Array, 4], [79, globalThis.BigInt64Array, 8],
  [84, HAS_FLOAT16 ? globalThis.Float16Array : null, 2], [85, globalThis.Float32Array, 4], [86, globalThis.Float64Array, 8],
];
const TYPED_BY_TAG = new Map(TYPED.map(([tag, ctor, size]) => [tag, { tag, ctor, size }]));
const TYPED_BY_PROTO = new Map(TYPED.filter(([, ctor]) => ctor).map(([tag, ctor, size]) => [ctor.prototype, { tag, ctor, size }]));
const typedInfo = v => (v instanceof Float16Bytes ? TYPED_BY_TAG.get(84) : v !== null && typeof v === 'object' ? TYPED_BY_PROTO.get(Object.getPrototypeOf(v)) : undefined);
const isTyped = v => typedInfo(v) !== undefined;

/** Tag 40 row-major multi-dimensional array (RFC 8746 §3.1.1): shape is 1..8 positive integers whose product equals the
 * element count of data, a typed array (or Float16Bytes) or a plain array. Immutable wrapper (data stays its own type). */
export class NDArray {
  constructor(shape, data) {
    if (!Array.isArray(shape) || shape.length < 1 || shape.length > LIMITS.maxDimensions || !shape.every(d => Number.isSafeInteger(d) && d > 0)) fail('ndarray', 'An ndarray shape must be 1 to 8 positive integers.');
    if (!Array.isArray(data) && !isTyped(data)) fail('ndarray', 'Ndarray data must be a typed array or an array.');
    if (shape.reduce((p, d) => p * BigInt(d), 1n) !== BigInt(data.length)) fail('ndarray', 'Ndarray shape does not match its element count.');
    this.shape = Object.freeze([...shape]); this.data = data; Object.freeze(this);
  }
}
Object.freeze(NDArray.prototype);

// ---------------------------------------------------------------------------------------------------------------------
// Float helpers (float16 conversion is ours; Math.f16round is not yet universal).

const scratch = new DataView(new ArrayBuffer(8));
/** float16 bits when x (finite, non-zero) is exactly representable as float16, else -1. */
function halfBits(x) {
  const sign = x < 0 ? 0x8000 : 0, a = Math.abs(x);
  if (a > 65504 || a < 2 ** -24) return -1;
  scratch.setFloat64(0, a); const hi = scratch.getUint32(0), lo = scratch.getUint32(4), exp = ((hi >>> 20) & 0x7ff) - 1023;
  if (exp >= -14) { if (lo !== 0 || (hi & 0x3ff) !== 0) return -1; return sign | ((exp + 15) << 10) | ((hi & 0xfffff) >>> 10); }
  const m = a * 2 ** 24; return Number.isInteger(m) ? sign | m : -1;
}
function halfValue(h) {
  const exp = (h >>> 10) & 0x1f, frac = h & 0x3ff, sign = h & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}
const badScalarFloat = v => Number.isNaN(v) || !Number.isFinite(v) || Object.is(v, -0) || (Number.isInteger(v) && Math.abs(v) <= MAX_SAFE);

// ---------------------------------------------------------------------------------------------------------------------
// Encoder

const plainObject = v => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };
const compareBytes = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };

class Writer {
  constructor() { this.buf = new Uint8Array(256); this.view = new DataView(this.buf.buffer); this.pos = 0; }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2; while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size); next.set(this.buf.subarray(0, this.pos)); this.buf = next; this.view = new DataView(next.buffer);
  }
  byte(b) { this.ensure(1); this.buf[this.pos++] = b; }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  head(major, n) {
    const m = major << 5;
    if (typeof n === 'bigint') { if (n <= 0xffffffffn) return this.head(major, Number(n)); this.ensure(9); this.buf[this.pos] = m | 27; this.view.setBigUint64(this.pos + 1, n); this.pos += 9; return; }
    if (n < 24) this.byte(m | n);
    else if (n < 0x100) { this.ensure(2); this.buf[this.pos] = m | 24; this.buf[this.pos + 1] = n; this.pos += 2; }
    else if (n < 0x10000) { this.ensure(3); this.buf[this.pos] = m | 25; this.view.setUint16(this.pos + 1, n); this.pos += 3; }
    else if (n < 0x100000000) { this.ensure(5); this.buf[this.pos] = m | 26; this.view.setUint32(this.pos + 1, n); this.pos += 5; }
    else this.head(major, BigInt(n));
  }
  result() { return this.buf.slice(0, this.pos); }
}

function writeInteger(w, n, depth, limits) {
  if (typeof n === 'number') { if (n >= 0) w.head(0, n); else w.head(1, -1 - n); return; }
  if (n >= 0n ? n < U64 : n >= -U64) { if (n >= 0n) w.head(0, n); else w.head(1, -1n - n); return; }
  if (depth >= limits.maxDepth) fail('depth', 'Nesting exceeds the depth bound.');
  const tagged = n >= 0n ? n : -1n - n, hex = tagged.toString(16), even = hex.length % 2 ? '0' + hex : hex;
  if (even.length / 2 > limits.maxBignumBytes) fail('bignum', 'Integer exceeds the bignum bound.');
  const out = new Uint8Array(even.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(even.slice(2 * i, 2 * i + 2), 16);
  w.head(6, n >= 0n ? 2 : 3); w.head(2, out.length); w.bytes(out);
}

function writeFloat(w, v) {
  if (badScalarFloat(v)) fail('float', 'NaN, infinities, -0 and integral floats within the safe range are not encodable as floats.');
  const h = halfBits(v);
  if (h >= 0) { w.ensure(3); w.buf[w.pos] = 0xf9; w.view.setUint16(w.pos + 1, h); w.pos += 3; }
  else if (Math.fround(v) === v) { w.ensure(5); w.buf[w.pos] = 0xfa; w.view.setFloat32(w.pos + 1, v); w.pos += 5; }
  else { w.ensure(9); w.buf[w.pos] = 0xfb; w.view.setFloat64(w.pos + 1, v); w.pos += 9; }
}

function typedBytes(v, info) {
  const raw = v instanceof Float16Bytes ? v.bytes : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (info.tag >= 84) { // NaN is refused in any payload (many bit patterns, one meaning); -0 and ±∞ are allowed here.
    if (info.tag === 84) { for (let i = 0; i < raw.length; i += 2) { const h = LITTLE_ENDIAN || v instanceof Float16Bytes ? raw[i] | raw[i + 1] << 8 : raw[i] << 8 | raw[i + 1]; if ((h & 0x7c00) === 0x7c00 && (h & 0x3ff)) fail('typed_array', 'NaN is not allowed in a float array.'); } }
    else for (let i = 0; i < v.length; i++) if (v[i] !== v[i]) fail('typed_array', 'NaN is not allowed in a float array.');
  }
  return LITTLE_ENDIAN || v instanceof Float16Bytes || info.size === 1 ? raw : swap(raw, info.size);
}
function swap(raw, size) { const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i += size) for (let j = 0; j < size; j++) out[i + j] = raw[i + size - 1 - j]; return out; }

function encodeKeyed(w, entries, depth, limits, state) {
  if (entries.length > limits.maxEntries) fail('too_many_entries', 'A map exceeds the entry bound.');
  entries.sort((a, b) => compareBytes(a[0], b[0]));
  for (let i = 1; i < entries.length; i++) if (compareBytes(entries[i - 1][0], entries[i][0]) === 0) fail('duplicate_key', 'A map has duplicate keys.');
  w.head(5, entries.length);
  for (const [key, value] of entries) { w.bytes(key); count(state, limits); writeItem(w, value, depth + 1, limits, state); }
}
const count = (state, limits) => { if (++state.items > limits.maxItems) fail('too_many_items', 'The message exceeds the item bound.'); };
const textKey = k => { if (typeof k !== 'string' || !scalarText(k)) fail('key_type', 'Map keys must be valid text strings.'); const b = utf8.encode(k), w = new Writer(); w.head(3, b.length); w.bytes(b); return w.result(); };

function writeItem(w, v, depth, limits, state) {
  count(state, limits);
  switch (typeof v) {
    case 'boolean': w.byte(v ? 0xf5 : 0xf4); return;
    case 'number': if (Number.isSafeInteger(v) && !Object.is(v, -0)) writeInteger(w, v, depth, limits); else writeFloat(w, v); return;
    case 'bigint': writeInteger(w, normalInteger(v), depth, limits); return;
    case 'string': { if (!scalarText(v)) fail('text', 'Text must be well-formed Unicode without noncharacters.'); const b = utf8.encode(v); w.head(3, b.length); w.bytes(b); return; }
    case 'object': break;
    default: fail('unsupported', 'Value type is not encodable under the Bindle profile.');
  }
  if (v === null) { w.byte(0xf6); return; }
  if (v instanceof Uint8Array) { w.head(2, v.byteLength); w.bytes(v); return; }
  if (depth >= limits.maxDepth) fail('depth', 'Nesting exceeds the depth bound.');
  const info = typedInfo(v);
  if (info) { const b = typedBytes(v, info); w.head(6, info.tag); w.head(2, b.length); w.bytes(b); return; }
  if (v instanceof BindleDecimal) { w.head(6, 4); writeItem(w, [v.exponent, v.mantissa], depth + 1, limits, state); return; }
  if (v instanceof NDArray) { w.head(6, 40); writeItem(w, [v.shape, v.data], depth + 1, limits, state); return; }
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length + 1) fail('unsupported', 'Arrays must be dense with no extra properties.');
    if (v.length > limits.maxEntries) fail('too_many_entries', 'An array exceeds the entry bound.');
    w.head(4, v.length); for (let i = 0; i < v.length; i++) writeItem(w, v[i], depth + 1, limits, state); return;
  }
  if (v instanceof Map && state.cose && depth === 0) {
    const entries = [];
    for (const [k, value] of v) {
      if (typeof k === 'number' && Number.isSafeInteger(k) && !Object.is(k, -0)) { const kw = new Writer(); writeInteger(kw, k, 0, limits); entries.push([kw.result(), value]); }
      else entries.push([textKey(k), value]);
    }
    encodeKeyed(w, entries, depth, limits, state); return;
  }
  if (!plainObject(v)) fail('unsupported', 'Value type is not encodable under the Bindle profile.');
  const entries = [];
  for (const k of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    // JSON-compatible member omission (RPC boundary): symbol-keyed and non-enumerable members are skipped, as
    // JSON.stringify skips them (workerd JSRPC results carry a symbol-keyed disposer).
    if (state.omitUndefined && (typeof k !== 'string' || !d.enumerable)) continue;
    if (typeof k !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) fail('unsupported', 'Objects must hold only enumerable data properties with text keys.');
    if (d.value === undefined && state.omitUndefined) continue; // JSON-compatible member omission (RPC boundary option)
    entries.push([textKey(k), d.value]);
  }
  encodeKeyed(w, entries, depth, limits, state);
}

const resolveLimits = options => {
  const limits = { ...LIMITS };
  for (const name of ['maxBytes', 'maxDepth', 'maxEntries', 'maxItems']) if (options[name] !== undefined) { if (!Number.isSafeInteger(options[name]) || options[name] < 0) throw new TypeError(`${name} must be a non-negative integer.`); limits[name] = options[name]; }
  return limits;
};

/** Encodes a value in Bindle deterministic CBOR. number: safe integer → integer, any other finite number → shortest
 * exact float (an integral float within ±(2^53-1) cannot arise from a number); bigint → integer (bignum beyond 64 bits);
 * Uint8Array → byte string; typed arrays (and Float16Bytes) → little-endian RFC 8746 tags; BindleDecimal → tag 4;
 * NDArray → tag 40; dense Array; plain or null-prototype object with text keys sorted bytewise by encoded form.
 * Options: `cose` (a top-level Map may have integer and text keys, spike §2.6), `omitUndefined` (JSON-compatible member
 * omission: an object member whose value is undefined, and any symbol-keyed or non-enumerable member, is left out, as
 * JSON.stringify does; RPC adapters use it for handler results, never for decoded data, which holds none of these;
 * accessor properties are still refused), maxDepth/maxEntries/maxItems/maxBytes. */
export function encode(value, options = {}) {
  const limits = resolveLimits(options), w = new Writer();
  writeItem(w, value, 0, limits, { items: 0, cose: options.cose === true, omitUndefined: options.omitUndefined === true });
  if (options.maxBytes !== undefined && w.pos > limits.maxBytes) fail('too_large', 'The encoding exceeds the size bound.');
  return w.result();
}

// ---------------------------------------------------------------------------------------------------------------------
// Decoder

class Reader {
  constructor(bytes, limits, cose, plainObjects = false) { this.plainObjects = plainObjects; this.b = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.pos = 0; this.items = 0; this.limits = limits; this.cose = cose; }
  need(n) { if (n > this.b.length - this.pos) fail('truncated', 'The data ends early or declares more content than remains.'); }
  /** Reads a head; returns [major, ai, argument] where argument is a number (≤ MAX_SAFE) or bigint. Enforces shortest form. */
  head() {
    this.need(1); const ib = this.b[this.pos++], major = ib >> 5, ai = ib & 31;
    if (ai < 24) return [major, ai, ai];
    if (major === 7 && ai >= 25 && ai <= 27) return [major, ai, 0];
    let n;
    switch (ai) {
      case 24: this.need(1); n = this.b[this.pos]; this.pos += 1; if (n < 24) fail('non_shortest', 'A head is not in shortest form.'); break;
      case 25: this.need(2); n = this.view.getUint16(this.pos); this.pos += 2; if (n < 0x100) fail('non_shortest', 'A head is not in shortest form.'); break;
      case 26: this.need(4); n = this.view.getUint32(this.pos); this.pos += 4; if (n < 0x10000) fail('non_shortest', 'A head is not in shortest form.'); break;
      case 27: { this.need(8); const big = this.view.getBigUint64(this.pos); this.pos += 8; if (big <= 0xffffffffn) fail('non_shortest', 'A head is not in shortest form.'); n = big <= MAX_SAFE_N ? Number(big) : big; break; }
      case 31: fail('indefinite', 'Indefinite lengths and breaks are not allowed.');
      default: fail('malformed', 'Reserved additional information.');
    }
    return [major, ai, n];
  }
  length(n, unit) { if (typeof n === 'bigint' || n * unit > this.b.length - this.pos) fail('truncated', 'The data ends early or declares more content than remains.'); return n; }
  take(n) { this.length(n, 1); const out = this.b.slice(this.pos, this.pos + n); this.pos += n; return out; }
  text(n) {
    this.length(n, 1); let s;
    try { s = utf8Decoder.decode(this.b.subarray(this.pos, this.pos + n)); } catch { fail('text', 'Text is not valid UTF-8.'); }
    if (NONCHARACTER.test(s)) fail('text', 'Text contains a noncharacter.');
    this.pos += n; return s;
  }
  enter(depth) { if (depth >= this.limits.maxDepth) fail('depth', 'Nesting exceeds the depth bound.'); }
  item(depth) {
    if (++this.items > this.limits.maxItems) fail('too_many_items', 'The message exceeds the item bound.');
    const [major, ai, n] = this.head();
    switch (major) {
      case 0: return n;
      case 1: return typeof n === 'number' && n < MAX_SAFE ? -1 - n : -1n - BigInt(n);
      case 2: return this.take(n);
      case 3: return this.text(n);
      case 4: {
        this.enter(depth); this.length(n, 1); if (n > this.limits.maxEntries) fail('too_many_entries', 'An array exceeds the entry bound.');
        const out = new Array(n); for (let i = 0; i < n; i++) out[i] = this.item(depth + 1); return out;
      }
      case 5: return this.map(n, depth);
      case 6: return this.tag(n, depth);
      default: return this.simple(ai);
    }
  }
  map(n, depth) {
    this.enter(depth); this.length(n, 2); if (n > this.limits.maxEntries) fail('too_many_entries', 'A map exceeds the entry bound.');
    const cose = this.cose && depth === 0, out = cose ? new Map() : this.plainObjects ? {} : Object.create(null);
    let prevStart = -1, prevEnd = -1;
    for (let i = 0; i < n; i++) {
      const start = this.pos; this.need(1); const keyMajor = this.b[start] >> 5;
      if (keyMajor !== 3 && !(cose && keyMajor <= 1)) fail('key_type', 'Map keys must be text strings.');
      const key = this.item(depth + 1), end = this.pos;
      if (cose && typeof key !== 'string' && typeof key !== 'number') fail('key_type', 'Map key label out of range.');
      if (prevStart >= 0) { const order = compareBytes(this.b.subarray(prevStart, prevEnd), this.b.subarray(start, end)); if (order === 0) fail('duplicate_key', 'A map has duplicate keys.'); if (order > 0) fail('key_order', 'Map keys are not in deterministic order.'); }
      prevStart = start; prevEnd = end;
      const value = this.item(depth + 1);
      if (cose) out.set(key, value); else Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  bytesContent() { const start = this.pos; this.need(1); if (this.b[start] >> 5 !== 2) return null; const [, , n] = this.head(); return this.take(n); }
  tag(t, depth) {
    this.enter(depth);
    if (t === 2 || t === 3) {
      const content = this.bytesContent(); if (!content) fail('bignum', 'Bignum content must be a byte string.');
      if (content.length < 9 || content[0] === 0) fail('bignum', 'A bignum must be beyond the 64-bit range without leading zero bytes.');
      if (content.length > this.limits.maxBignumBytes) fail('bignum', 'Bignum exceeds the profile bound.');
      let hex = ''; for (const b of content) hex += b.toString(16).padStart(2, '0');
      const v = BigInt('0x' + hex); return t === 2 ? v : -1n - v;
    }
    if (t === 4) {
      this.need(1); if (this.b[this.pos] !== 0x82) fail('decimal', 'A decimal must be a two-element array.');
      const [exponent, mantissa] = this.item(depth + 1);
      if (typeof exponent !== 'number' || !Number.isSafeInteger(exponent) || exponent >= 0 || exponent < this.limits.minDecimalExponent) fail('decimal', 'A decimal exponent must be a negative integer within the profile bound.');
      if (typeof mantissa !== 'number' && typeof mantissa !== 'bigint' || typeof mantissa === 'number' && !Number.isSafeInteger(mantissa)) fail('decimal', 'A decimal mantissa must be an integer.');
      const m = BigInt(mantissa); if (m === 0n || m % 10n === 0n) fail('decimal', 'A decimal must be normalized.');
      return new BindleDecimal(m, exponent);
    }
    if (t === 40) {
      this.need(1); if (this.b[this.pos] !== 0x82) fail('ndarray', 'A multi-dimensional array must be a two-element array.');
      const [shape, data] = this.item(depth + 1);
      return new NDArray(shape, data); // the constructor enforces shape (1-8 positive integers), data type and element count
    }
    const info = typeof t === 'number' ? TYPED_BY_TAG.get(t) : undefined;
    if (!info) fail('tag', 'Tag not allowed by the Bindle profile.');
    const content = this.bytesContent(); if (!content) fail('typed_array', 'Typed array content must be a byte string.');
    if (content.length % info.size) fail('typed_array', 'Typed array length is not a multiple of its element size.');
    const bytes = LITTLE_ENDIAN || info.size === 1 ? content : swap(content, info.size); // content is already a fresh aligned copy
    if (t === 84) {
      for (let i = 0; i < content.length; i += 2) { const h = content[i] | content[i + 1] << 8; if ((h & 0x7c00) === 0x7c00 && (h & 0x3ff)) fail('typed_array', 'NaN is not allowed in a float array.'); }
      return info.ctor ? new info.ctor(bytes.buffer, 0, bytes.length / 2) : new Float16Bytes(content);
    }
    const array = new info.ctor(bytes.buffer, 0, bytes.length / info.size);
    if (t >= 85) for (let i = 0; i < array.length; i++) if (array[i] !== array[i]) fail('typed_array', 'NaN is not allowed in a float array.');
    return array;
  }
  simple(ai) {
    if (ai === 20) return false; if (ai === 21) return true; if (ai === 22) return null;
    if (ai >= 25 && ai <= 27) {
      let v;
      if (ai === 25) { this.need(2); v = halfValue(this.view.getUint16(this.pos)); this.pos += 2; }
      else if (ai === 26) { this.need(4); v = this.view.getFloat32(this.pos); this.pos += 4; }
      else { this.need(8); v = this.view.getFloat64(this.pos); this.pos += 8; }
      if (badScalarFloat(v)) fail('float', 'NaN, infinities, -0 and integral floats within the safe range are refused.');
      if (ai === 26 ? halfBits(v) >= 0 : ai === 27 && Math.fround(v) === v) fail('non_shortest', 'A float is not in shortest form.');
      return v;
    }
    fail('simple', 'Simple value not allowed by the Bindle profile.');
  }
}

/** Strictly decodes one Bindle CBOR item. Refuses every non-canonical or out-of-profile form (spike §2.3) before
 * returning anything. Maps decode to null-prototype objects with own data properties (`__proto__` is data); integers
 * to number within ±(2^53-1), else bigint; byte strings to fresh Uint8Array copies; typed arrays to fresh aligned native
 * typed arrays (Float16Bytes where Float16Array is missing). Options: `top` ('map', the default, or 'any'), `cose`
 * (top-level map may use integer labels and decodes to a Map), `objects` ('null', the default: null-prototype maps; or
 * 'plain': Object.prototype maps whose members are still defined, never assigned, so `__proto__` stays data exactly as
 * with JSON.parse; RPC adapters use it so handlers see the same object shape the JSON transport gave them),
 * maxBytes/maxDepth/maxEntries/maxItems. */
export function decode(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decode expects a Uint8Array.');
  const limits = resolveLimits(options);
  if (bytes.byteLength > limits.maxBytes) fail('too_large', 'The data exceeds the size bound.');
  const top = options.top ?? 'map'; if (top !== 'map' && top !== 'any') throw new TypeError("top must be 'map' or 'any'.");
  if (top === 'map' && (bytes.length === 0 || bytes[0] >> 5 !== 5)) fail('not_map', 'The top-level item must be a map.');
  const objects = options.objects ?? 'null'; if (objects !== 'null' && objects !== 'plain') throw new TypeError("objects must be 'null' or 'plain'.");
  const reader = new Reader(bytes, limits, options.cose === true, objects === 'plain'), value = reader.item(0);
  if (reader.pos !== bytes.length) fail('trailing', 'Bytes follow the top-level item.');
  return value;
}

/** True when two values have the same Bindle CBOR encoding (the equality used for const/enum and fingerprints). */
export function sameValue(a, b, options) {
  return compareBytes(encode(a, options), encode(b, options)) === 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fingerprints (spike §2.4): SHA-256(domain ‖ 0x00 ‖ deterministic CBOR). Callers that key the digest (HMAC journal
// fingerprints) use fingerprintInput directly.

const DOMAIN = /^[\x21-\x7e]{1,128}$/;
export function fingerprintInput(value, { domain = RPC_FINGERPRINT_DOMAIN, omitUndefined = false } = {}) {
  if (typeof domain !== 'string' || !DOMAIN.test(domain)) throw new TypeError('A fingerprint domain must be 1-128 printable ASCII characters.');
  const prefix = utf8.encode(domain), body = encode(value, { omitUndefined }), out = new Uint8Array(prefix.length + 1 + body.length);
  out.set(prefix); out.set(body, prefix.length + 1); return out;
}
/** Lowercase hex SHA-256 over fingerprintInput(value), via WebCrypto (Workers, browsers, Node ≥ 19). */
export async function fingerprint(value, { domain = RPC_FINGERPRINT_DOMAIN, omitUndefined = false, subtle = globalThis.crypto?.subtle } = {}) {
  if (!subtle) throw new TypeError('WebCrypto is unavailable.');
  const digest = new Uint8Array(await subtle.digest('SHA-256', fingerprintInput(value, { domain, omitUndefined })));
  let hex = ''; for (const b of digest) hex += b.toString(16).padStart(2, '0'); return hex;
}
