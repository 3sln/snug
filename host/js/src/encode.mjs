// Adapted from 3sln.me packages/core/cbor.mjs (MIT, Copyright (c) 2026 3sln).
import { fail } from './fault.mjs';
import { LIMITS, resolveLimits } from './limits.mjs';
import { Decimal, NDArray, Float16Bytes, typedInfo } from './values.mjs';

const MAX_SAFE = Number.MAX_SAFE_INTEGER, MAX_SAFE_N = BigInt(MAX_SAFE), U64 = 1n << 64n;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const utf8 = new TextEncoder();
// Noncharacters U+FDD0..U+FDEF and U+xFFFE/U+xFFFF in every plane (same rule as strict-json scalarString).
const NONCHARACTER = /[﷐-﷯￾￿]|[\uD83F\uD87F\uD8BF\uD8FF\uD93F\uD97F\uD9BF\uD9FF\uDA3F\uDA7F\uDABF\uDAFF\uDB3F\uDB7F\uDBBF\uDBFF][\uDFFE\uDFFF]/;
const scalarText = s => s.isWellFormed() && !NONCHARACTER.test(s);

const scratch = new DataView(new ArrayBuffer(8));
/** float16 bits when x (finite, non-zero) is exactly representable as float16, else -1. */
function halfBits(x) {
  const sign = x < 0 ? 0x8000 : 0, a = Math.abs(x);
  if (a > 65504 || a < 2 ** -24) return -1;
  scratch.setFloat64(0, a); const hi = scratch.getUint32(0), lo = scratch.getUint32(4), exp = ((hi >>> 20) & 0x7ff) - 1023;
  if (exp >= -14) { if (lo !== 0 || (hi & 0x3ff) !== 0) return -1; return sign | ((exp + 15) << 10) | ((hi & 0xfffff) >>> 10); }
  const m = a * 2 ** 24; return Number.isInteger(m) ? sign | m : -1;
}
const badScalarFloat = v => Number.isNaN(v) || !Number.isFinite(v) || Object.is(v, -0) || (Number.isInteger(v) && Math.abs(v) <= MAX_SAFE);

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
  entries.sort(compareKeys);
  for (let i = 1; i < entries.length; i++) if (compareKeys(entries[i - 1], entries[i]) === 0) fail('duplicate_key', 'A map has duplicate keys.');
  w.head(5, entries.length);
  for (const [key, bytes, value] of entries) {
    if (key === null) w.bytes(bytes); // pre-encoded COSE integer label
    else {
      const n = bytes === null ? key.length : bytes.length;
      w.head(3, n);
      if (bytes === null) {
        w.ensure(n);
        for (let i = 0; i < n; i++) w.buf[w.pos++] = key.charCodeAt(i);
      } else w.bytes(bytes);
    }
    count(state, limits); writeItem(w, value, depth + 1, limits, state);
  }
}
const count = (state, limits) => { if (++state.items > limits.maxItems) fail('too_many_items', 'The message exceeds the item bound.'); };
// Text heads are monotone in UTF-8 length. ASCII needs neither a byte buffer
// nor a per-key Writer, and equal-length ASCII keys use native string ordering.
function textKey(k, value) {
  if (typeof k !== 'string') fail('key_type', 'Map keys must be valid text strings.');
  let ascii = true;
  for (let i = 0; i < k.length; i++) if (k.charCodeAt(i) >= 128) { ascii = false; break; }
  if (!ascii && !scalarText(k)) fail('key_type', 'Map keys must be valid text strings.');
  return [k, ascii ? null : utf8.encode(k), value];
}
function compareKeys(a, b) {
  if (a[0] === null) return b[0] === null ? compareBytes(a[1], b[1]) : -1;
  if (b[0] === null) return 1;
  const an = a[1] === null ? a[0].length : a[1].length;
  const bn = b[1] === null ? b[0].length : b[1].length;
  if (an !== bn) return an - bn;
  if (a[1] === null && b[1] === null) return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  for (let i = 0; i < an; i++) {
    const ac = a[1] === null ? a[0].charCodeAt(i) : a[1][i];
    const bc = b[1] === null ? b[0].charCodeAt(i) : b[1][i];
    if (ac !== bc) return ac - bc;
  }
  return 0;
}
function integerKey(n, value) {
  // COSE labels are safe integers, so at most eight argument bytes.
  const major = n < 0 ? 1 : 0, magnitude = n < 0 ? -1 - n : n;
  const ai = magnitude < 24 ? magnitude : magnitude < 256 ? 24 : magnitude < 65536 ? 25 : magnitude < 4294967296 ? 26 : 27;
  const size = ai < 24 ? 0 : ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : 8;
  const bytes = new Uint8Array(1 + size);
  bytes[0] = major * 32 + ai;
  let rest = magnitude;
  for (let i = size; i > 0; i--) { bytes[i] = rest % 256; rest = Math.floor(rest / 256); }
  return [null, bytes, value];
}

function writeItem(w, v, depth, limits, state) {
  count(state, limits);
  switch (typeof v) {
    case 'boolean': w.byte(v ? 0xf5 : 0xf4); return;
    case 'number': if (Number.isSafeInteger(v) && !Object.is(v, -0)) writeInteger(w, v, depth, limits); else writeFloat(w, v); return;
    case 'bigint': writeInteger(w, v >= -MAX_SAFE_N && v <= MAX_SAFE_N ? Number(v) : v, depth, limits); return;
    case 'string': { if (!scalarText(v)) fail('text', 'Text must be well-formed Unicode without noncharacters.'); const b = utf8.encode(v); w.head(3, b.length); w.bytes(b); return; }
    case 'object': break;
    default: fail('unsupported', 'Value type is not encodable under the Bindle profile.');
  }
  if (v === null) { w.byte(0xf6); return; }
  if (v instanceof Uint8Array) { w.head(2, v.byteLength); w.bytes(v); return; }
  if (depth >= limits.maxDepth) fail('depth', 'Nesting exceeds the depth bound.');
  const info = typedInfo(v);
  if (info) { const b = typedBytes(v, info); w.head(6, info.tag); w.head(2, b.length); w.bytes(b); return; }
  if (v instanceof Decimal) { w.head(6, 4); writeItem(w, [v.exponent, v.mantissa], depth + 1, limits, state); return; }
  if (v instanceof NDArray) { w.head(6, 40); writeItem(w, [v.shape, v.data], depth + 1, limits, state); return; }
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length + 1) fail('unsupported', 'Arrays must be dense with no extra properties.');
    if (v.length > limits.maxEntries) fail('too_many_entries', 'An array exceeds the entry bound.');
    w.head(4, v.length); for (let i = 0; i < v.length; i++) writeItem(w, v[i], depth + 1, limits, state); return;
  }
  if (v instanceof Map && state.cose && depth === 0) {
    const entries = [];
    for (const [k, value] of v) {
      if (typeof k === 'number' && Number.isSafeInteger(k) && !Object.is(k, -0)) entries.push(integerKey(k, value));
      else entries.push(textKey(k, value));
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
    entries.push(textKey(k, d.value));
  }
  encodeKeyed(w, entries, depth, limits, state);
}

/** Encodes a value in Bindle deterministic CBOR. number: safe integer → integer, any other finite number → shortest
 * exact float (an integral float within ±(2^53-1) cannot arise from a number); bigint → integer (bignum beyond 64 bits);
 * Uint8Array → byte string; typed arrays (and Float16Bytes) → little-endian RFC 8746 tags; Decimal → tag 4;
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

