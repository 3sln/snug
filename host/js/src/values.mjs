// Adapted from 3sln.me packages/core/cbor.mjs (MIT, Copyright (c) 2026 3sln).
import { fail } from './fault.mjs';
import { LIMITS } from './limits.mjs';

const MAX_SAFE = Number.MAX_SAFE_INTEGER, MAX_SAFE_N = BigInt(MAX_SAFE), U64 = 1n << 64n;
const DECIMAL_LITERAL = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const normalInteger = n => (n >= -MAX_SAFE_N && n <= MAX_SAFE_N ? Number(n) : n);
const absBig = n => (n < 0n ? -n : n);
const bignumBytes = n => { const hex = n.toString(16); return (hex.length + 1) >> 1; };

/** An exact decimal fraction (CBOR tag 4) in normalized form: mantissa a non-zero bigint not divisible by 10, exponent a
 * negative integer ≥ LIMITS.minDecimalExponent. Value only, no scale: 1.50 and 1.5 are the same decimal. Immutable; no
 * arithmetic; numeric coercion and JSON.stringify throw so a decimal is never rounded silently (spike §2.6). */
export class Decimal {
  constructor(mantissa, exponent) {
    if (typeof mantissa !== 'bigint' || mantissa === 0n || mantissa % 10n === 0n) fail('decimal', 'A decimal mantissa must be a non-zero bigint without trailing zeros.');
    if (!Number.isSafeInteger(exponent) || exponent >= 0 || exponent < LIMITS.minDecimalExponent) fail('decimal', 'A decimal exponent must be a negative integer within the profile bound.');
    const magnitude = absBig(mantissa) - (mantissa < 0n ? 1n : 0n);
    if (magnitude >= U64 && bignumBytes(magnitude) > LIMITS.maxBignumBytes) fail('bignum', 'A decimal mantissa exceeds the bignum bound.');
    this.mantissa = mantissa; this.exponent = exponent; Object.freeze(this);
  }
  /** Parses an exact plain decimal literal ("-12.340"); returns a Decimal, or a number/bigint when the value is
   * integral (spike §2.2 rule 6). Exponent notation, "+", leading zeros and empty fractions are refused. */
  static from(text) {
    if (typeof text !== 'string' || text.length > 4096) fail('decimal', 'Not an exact decimal literal.');
    const match = DECIMAL_LITERAL.exec(text); if (!match) fail('decimal', 'Not an exact decimal literal.');
    let digits = match[2] + (match[3] ?? ''), exponent = -(match[3]?.length ?? 0);
    let mantissa = BigInt(digits); if (match[1]) mantissa = -mantissa;
    return Decimal.normalize(mantissa, exponent);
  }
  /** mantissa × 10^exponent in normal form: an integer (number when safe, else bigint) or a Decimal. */
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
    return new Decimal(mantissa, exponent);
  }
  toString() {
    const negative = this.mantissa < 0n, digits = absBig(this.mantissa).toString(), scale = -this.exponent;
    const padded = digits.length <= scale ? '0'.repeat(scale - digits.length + 1) + digits : digits;
    return (negative ? '-' : '') + padded.slice(0, padded.length - scale) + '.' + padded.slice(padded.length - scale);
  }
  valueOf() { throw new TypeError('Decimal cannot be converted to a number.'); }
  [Symbol.toPrimitive](hint) { if (hint === 'string') return this.toString(); throw new TypeError('Decimal cannot be converted to a number.'); }
  toJSON() { throw new TypeError('Decimal has no JSON form; map it to a decimal string explicitly.'); }
}
Object.freeze(Decimal.prototype);

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
export const TYPED_BY_TAG = new Map(TYPED.map(([tag, ctor, size]) => [tag, { tag, ctor, size }]));
const TYPED_BY_PROTO = new Map(TYPED.filter(([, ctor]) => ctor).map(([tag, ctor, size]) => [ctor.prototype, { tag, ctor, size }]));
export const typedInfo = v => (v instanceof Float16Bytes ? TYPED_BY_TAG.get(84) : v !== null && typeof v === 'object' ? TYPED_BY_PROTO.get(Object.getPrototypeOf(v)) : undefined);
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


/** A tagged item outside the Bindle set (D121, D123, D180): a standard-set tag -- 0 (RFC 3339 date/time text), 1
 * (epoch number), 21-23 (expected base64url / base64 / base16 conversions), 24 (an encoded CBOR data item: `value` is
 * its bytes), 32 (URI text), 55799 (self-described CBOR, top level only) -- or, under the any-tag level, any other tag
 * number (COSE 16-18 and 96-98, CWT 61, ...). `tag` is a non-negative integer: a number up to 2^53 - 1, a bigint
 * beyond (below 2^64). `value` is the decoded content. Immutable (shallowly: a byte string value is a Uint8Array).
 * The tag number and the content are checked against the profile when encoded. */
export class Tagged {
  constructor(tag, value) {
    if (typeof tag === 'bigint') {
      if (tag < 0n || tag >= 1n << 64n) throw new TypeError('A tag number is an integer in 0..2^64-1.');
      if (tag <= BigInt(MAX_SAFE)) tag = Number(tag);
    } else if (!Number.isSafeInteger(tag) || tag < 0) throw new TypeError('A tag number is an integer in 0..2^64-1.');
    this.tag = tag; this.value = value; Object.freeze(this);
  }
}
Object.freeze(Tagged.prototype);

// Internal factories for the trusted builder. The scanner has established all
// invariants; do not call validating public constructors in the building pass.
export function decimalValue(mantissa, exponent) {
  const out = Object.create(Decimal.prototype);
  out.mantissa = mantissa; out.exponent = exponent;
  return Object.freeze(out);
}
export function ndarrayValue(shape, data) {
  const out = Object.create(NDArray.prototype);
  out.shape = Object.freeze(shape); out.data = data;
  return Object.freeze(out);
}
export function taggedValue(tag, value) {
  const out = Object.create(Tagged.prototype);
  out.tag = tag; out.value = value;
  return Object.freeze(out);
}
export function float16Value(bytes) {
  const out = Object.create(Float16Bytes.prototype);
  out.bytes = bytes; out.length = bytes.length / 2;
  return Object.freeze(out);
}
