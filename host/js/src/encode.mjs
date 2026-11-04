// Adapted from 3sln.me packages/core/cbor.mjs (MIT, Copyright (c) 2026 3sln).
// encode() is the object walk over the Writer (P5.4, D072): host-value admissibility here and in writer.mjs, every
// byte-level choice (shortest heads, float widths, bignums, key order) in kin (gen/js/snug/write). The Phase 2
// encoder this replaced is frozen at bench/baseline/encode-p2.mjs as the benchmark baseline (architecture §16.5).
import { Writer } from './writer.mjs';

/** Encodes a value in deterministic CBOR (RFC 8949 §4.2.1) under the profile options (D120; default the
 * deterministic preset, `wire: 'bindle'` the Bindle profile). number: safe integer → integer, any other number →
 * shortest exact float (deterministic floats: NaN as f97e00, ±∞ and −0 as float16; Bindle floats refuse them);
 * bigint → integer (bignum beyond 64 bits); Uint8Array → byte string; typed arrays (and Float16Bytes) → little-endian
 * RFC 8746 tags; Decimal → tag 4; NDArray → tag 40; Tagged → a standard-set tag (checked by kin); undefined → f7
 * (undefinedValue); Array elements 0..length−1 (holes refused, exact Array.prototype required); plain or
 * null-prototype object with text keys, or a Map whose keys the profile admits, sorted bytewise by encoded form.
 * Options: `strictArrays` (true retains the old own-key count check, refusing extra named/hidden/symbol properties;
 * false by default, ignoring extras as JSON.stringify does), `cose` (under keys 'text', a top-level Map may have safe integer and text keys,
 * spike §2.6), `omitUndefined` (JSON-compatible member
 * omission: an object member whose value is undefined, and any symbol-keyed or non-enumerable member, is left out, as
 * JSON.stringify does; RPC adapters use it for handler results, never for decoded data, which holds none of these;
 * accessor properties are still refused), maxDepth/maxEntries/maxItems/maxBytes. */
export function encode(value, options = {}) {
  return new Writer(options).value(value).finish();
}
