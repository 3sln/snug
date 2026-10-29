import { readFileSync } from 'node:fs';
import * as snug from '../src/index.mjs';
import * as baseline from '../../../bench/baseline/cbor-3sln.mjs';

export { snug, baseline };
export const profile = JSON.parse(readFileSync(new URL('../../../corpus/cbor-vectors/cbor-profile.json', import.meta.url)));
export const oracle = JSON.parse(readFileSync(new URL('../../../corpus/cbor-vectors/cbor-cborg-oracle.json', import.meta.url)));
export const fromHex = hex => new Uint8Array(Buffer.from(hex, 'hex'));
export const toHex = bytes => Buffer.from(bytes).toString('hex');

// Translate only the host-specific wrapper identities. All other types, numbers,
// prototypes and byte contents remain directly comparable with deepStrictEqual.
export function translate(value, target = snug) {
  if (value instanceof snug.Decimal || value instanceof baseline.BindleDecimal) {
    return new (target.Decimal ?? target.BindleDecimal)(value.mantissa, value.exponent);
  }
  if (value instanceof snug.NDArray || value instanceof baseline.NDArray) {
    return new target.NDArray([...value.shape], translate(value.data, target));
  }
  if (value instanceof snug.Float16Bytes || value instanceof baseline.Float16Bytes) return new target.Float16Bytes(value.bytes);
  if (Array.isArray(value)) return value.map(v => translate(v, target));
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, translate(v, target)]));
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    const out = Object.create(Object.getPrototypeOf(value));
    for (const k of Object.keys(value)) Object.defineProperty(out, k, {
      value: translate(value[k], target), enumerable: true, writable: true, configurable: true,
    });
    return out;
  }
  return value;
}

const types = { u16: Uint16Array, u32: Uint32Array, u64: BigUint64Array, i8: Int8Array, i16: Int16Array,
  i32: Int32Array, i64: BigInt64Array, f16: globalThis.Float16Array, f32: Float32Array, f64: Float64Array };
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** The JSON notation described in cbor-profile.json's format field. */
export function expected(value) {
  if (Array.isArray(value)) return value.map(expected);
  if (value === null || typeof value !== 'object') return value;
  if ('$int' in value) return BigInt(value.$int);
  if ('$bytes' in value) return fromHex(value.$bytes);
  if ('$decimal' in value) return snug.Decimal.from(value.$decimal);
  if ('$typed' in value) {
    const bytes = fromHex(value.hex), ctor = types[value.$typed];
    if (!ctor) return new snug.Float16Bytes(bytes);
    const size = ctor.BYTES_PER_ELEMENT;
    if (!littleEndian) for (let i = 0; i < bytes.length; i += size) bytes.subarray(i, i + size).reverse();
    return new ctor(bytes.buffer);
  }
  if ('$nd' in value) return new snug.NDArray(value.$nd, expected(value.data));
  const out = Object.create(null);
  for (const [k, v] of Object.entries(value)) out[k] = expected(v);
  return out;
}
