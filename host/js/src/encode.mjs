// Adapted from 3sln.me packages/core/cbor.mjs (MIT, Copyright (c) 2026 3sln).
// encode() is the object walk over the Writer (P5.4, D072): host-value admissibility here and in writer.mjs, every
// byte-level choice (shortest heads, float widths, bignums, key order) in kin (gen/js/snug/write). The Phase 2
// encoder this replaced is frozen at bench/baseline/encode-p2.mjs as the benchmark baseline (architecture §16.5).
import { Writer } from './writer.mjs';

/** Encodes a value in Bindle deterministic CBOR. number: safe integer → integer, any other finite number → shortest
 * exact float (an integral float within ±(2^53-1) cannot arise from a number); bigint → integer (bignum beyond 64 bits);
 * Uint8Array → byte string; typed arrays (and Float16Bytes) → little-endian RFC 8746 tags; Decimal → tag 4;
 * NDArray → tag 40; dense Array; plain or null-prototype object with text keys sorted bytewise by encoded form.
 * Options: `cose` (a top-level Map may have integer and text keys, spike §2.6), `omitUndefined` (JSON-compatible member
 * omission: an object member whose value is undefined, and any symbol-keyed or non-enumerable member, is left out, as
 * JSON.stringify does; RPC adapters use it for handler results, never for decoded data, which holds none of these;
 * accessor properties are still refused), maxDepth/maxEntries/maxItems/maxBytes. */
export function encode(value, options = {}) {
  return new Writer(options).value(value).finish();
}
