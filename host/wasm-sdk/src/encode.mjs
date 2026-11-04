// P7.9: encode over wasm. The JS walk keeps every host-value admission rule of
// the native Writer#walk (host/js/src/writer.mjs, D113) and the items/depth/
// entries bounds, and writes a TAPE of ops into linear memory (texts and byte
// payloads into a byte area there). One wasm call (sdk_enc_run) then turns the
// tape into deterministic CBOR with kin's writer primitives: shortest heads,
// float widths, bignums, and map key order (kin sorts each map's keys before
// any value is written, as the native walk does). Per-head wasm calls were
// measured as the alternative (bench/D005.md, boundary probe) and lose.
//
// Differences from the native walk: map members are walked in host order
// (native: kin order), so when one message holds several faults the one
// reported can differ; error codes for a single fault are the same.
import * as rt from './runtime.mjs';
import { SnugFault } from '../../js/src/fault.mjs';
import { resolveLimits } from '../../js/src/limits.mjs';
import { Decimal, NDArray, Float16Bytes, typedInfo } from '../../js/src/values.mjs';
import { copyTypedBytes } from '../../js/src/typed-bytes.mjs';

const MAX_SAFE_N = BigInt(Number.MAX_SAFE_INTEGER), U64 = 1n << 64n, U32 = 4294967296;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LITTLE_ENDIAN ? 1 : 0, LO = 1 - HI;
const f64 = new Float64Array(1), f64w = new Int32Array(f64.buffer);
const typedIncludes = Float64Array.prototype.includes;
const utf8 = new TextEncoder();
const NONCHARACTER = /[﷐-﷯￾￿]|[\uD83F\uD87F\uD8BF\uD8FF\uD93F\uD97F\uD9BF\uD9FF\uDA3F\uDA7F\uDABF\uDAFF\uDB3F\uDB7F\uDBBF\uDBFF][\uDFFE\uDFFF]/;
const scalarText = s => s.isWellFormed() && !NONCHARACTER.test(s);
const plainObject = v => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };
const CODES = { 4: 'malformed', 5: 'key_type', 6: 'key_order', 7: 'duplicate_key', 9: 'float', 12: 'bignum' };
const fail = (code, message) => { throw new SnugFault(code, message); };

// tape (words) and byte area: pointers into linear memory, capacities, fill
let tp = 0, tcap = 0, tn = 0, bp = 0, bcap = 0, bn = 0, gen = -1;
let items = 0, maxItems = 0, maxDepth = 0, maxEntries = 0, cose = false, omit = false, strict = false;
let busy = false;

function words(n) {
  if (tn + n <= tcap) return;
  tcap = Math.max(2 * tcap, tn + n, 1024);
  tp = rt.x.sdk_enc_tape(tcap) >> 2; rt.refresh();
}
function room(n) {
  if (bn + n <= bcap) return;
  bcap = Math.max(2 * bcap, bn + n, 4096);
  bp = rt.x.sdk_enc_bytes(bcap); rt.refresh();
}
function op4(a, b, c, d) { words(4); const t = rt.i32, k = tp + tn; t[k] = a; t[k + 1] = b; t[k + 2] = c; t[k + 3] = d; tn += 4; }
function op3(a, b, c) { words(3); const t = rt.i32, k = tp + tn; t[k] = a; t[k + 1] = b; t[k + 2] = c; tn += 3; }
const headN = (major, n) => op4(1, major, n > 0xffffffff ? (n / U32) | 0 : 0, n | 0);
function intN(n) { if (n >= 0) headN(0, n); else headN(1, -1 - n); }

function text(s, code) {
  const n = s.length;
  if (n <= 64) {
    room(n);
    const u = rt.u8, at = bp + bn; let i = 0;
    for (; i < n; i++) { const c = s.charCodeAt(i); if (c >= 128) break; u[at + i] = c; }
    if (i === n) { op3(3, bn, n); bn += n; return; }
  }
  if (!scalarText(s)) fail(code, code === 'text' ? 'Text must be well-formed Unicode without noncharacters.' : 'Map keys must be valid text strings.');
  room(3 * n);
  const { written } = utf8.encodeInto(s, rt.u8.subarray(bp + bn, bp + bn + 3 * n));
  op3(3, bn, written); bn += written;
}
function bytes(raw, swap) {
  room(raw.length);
  if (swap > 1) copyTypedBytes(rt.u8, bp + bn, raw, swap, false); else rt.u8.set(raw, bp + bn);
  op3(4, bn, raw.length); bn += raw.length;
}
function bigint(n, depth) {
  if (n >= -MAX_SAFE_N && n <= MAX_SAFE_N) { intN(Number(n)); return; }
  const negative = n < 0n, arg = negative ? -1n - n : n;
  if (arg < U64) { op4(1, negative ? 1 : 0, Number(arg >> 32n) | 0, Number(arg & 0xffffffffn) | 0); return; }
  if (depth >= maxDepth) fail('depth', 'Nesting exceeds the depth bound.');
  let hex = arg.toString(16); if (hex.length & 1) hex = '0' + hex;
  const len = Math.min(hex.length >> 1, 129);
  room(len);
  const u = rt.u8;
  for (let i = 0; i < len; i++) u[bp + bn + i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  op4(5, negative ? 1 : 0, bn, len); bn += len;
}
function typedPayload(v, info) {
  const raw = v instanceof Float16Bytes ? v.bytes : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (info.tag >= 84) {
    if (info.tag === 84) { for (let i = 0; i < raw.length; i += 2) { const h = LITTLE_ENDIAN || v instanceof Float16Bytes ? raw[i] | raw[i + 1] << 8 : raw[i] << 8 | raw[i + 1]; if ((h & 0x7c00) === 0x7c00 && (h & 0x3ff)) fail('typed_array', 'NaN is not allowed in a float array.'); } }
    else if (Object.hasOwn(v, 'length')) { for (let i = 0; i < v.length; i++) if (v[i] !== v[i]) fail('typed_array', 'NaN is not allowed in a float array.'); }
    else if (typedIncludes.call(v, NaN)) fail('typed_array', 'NaN is not allowed in a float array.');
  }
  return raw;
}

function walk(v, depth) {
  if (++items > maxItems) fail('too_many_items', 'The message exceeds the item bound.');
  switch (typeof v) {
    case 'boolean': op4(1, 7, 0, v ? 21 : 20); return;
    case 'number': {
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) { f64[0] = v; op3(2, f64w[HI], f64w[LO]); return; }
      const major = v < 0 ? 1 : 0, a = v < 0 ? -1 - v : v;
      op4(1, major, a > 0xffffffff ? (a / U32) | 0 : 0, a | 0);
      return;
    }
    case 'bigint': bigint(v, depth); return;
    case 'string': text(v, 'text'); return;
    case 'object': break;
    default: fail('unsupported', 'Value type is not encodable under the Bindle profile.');
  }
  if (v === null) { op4(1, 7, 0, 22); return; }
  if (v instanceof Uint8Array) { bytes(v, 0); return; }
  if (depth >= maxDepth) fail('depth', 'Nesting exceeds the depth bound.');
  const info = typedInfo(v);
  if (info) { const b = typedPayload(v, info); headN(6, info.tag); bytes(b, LITTLE_ENDIAN || v instanceof Float16Bytes ? 0 : info.size); return; }
  if (v instanceof Decimal) { headN(6, 4); walk([v.exponent, v.mantissa], depth + 1); return; }
  if (v instanceof NDArray) { headN(6, 40); walk([v.shape, v.data], depth + 1); return; }
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype || (strict && Reflect.ownKeys(v).length !== v.length + 1)) fail('unsupported', 'Arrays must be dense with no extra properties.');
    if (v.length > maxEntries) fail('too_many_entries', 'An array exceeds the entry bound.');
    headN(4, v.length);
    for (let i = 0; i < v.length; i++) {
      const value = v[i];
      if (value === undefined && !(i in v)) fail('unsupported', 'Arrays must be dense with no extra properties.');
      walk(value, depth + 1);
    }
    return;
  }
  const keys = [], values = [];
  if (v instanceof Map && cose && depth === 0) {
    for (const [k, value] of v) {
      if (typeof k === 'number' ? !Number.isSafeInteger(k) || Object.is(k, -0) : typeof k !== 'string') fail('key_type', 'Map keys must be valid text strings.');
      keys.push(k); values.push(value);
    }
  } else {
    if (!plainObject(v)) fail('unsupported', 'Value type is not encodable under the Bindle profile.');
    for (const k of Reflect.ownKeys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (omit && (typeof k !== 'string' || !d.enumerable)) continue;
      if (typeof k !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) fail('unsupported', 'Objects must hold only enumerable data properties with text keys.');
      if (d.value === undefined && omit) continue;
      keys.push(k); values.push(d.value);
    }
  }
  const n = keys.length;
  if (n > maxEntries) fail('too_many_entries', 'A map exceeds the entry bound.');
  if (n === 0) { headN(5, 0); return; }
  words(2); rt.i32[tp + tn] = 6; rt.i32[tp + tn + 1] = n; tn += 2;
  for (let i = 0; i < n; i++) { const k = keys[i]; if (typeof k === 'string') text(k, 'key_type'); else intN(k); }
  words(n);
  const slots = tn; tn += n;
  for (let i = 0; i < n; i++) {
    rt.i32[tp + slots + i] = tn;
    if (++items > maxItems) fail('too_many_items', 'The message exceeds the item bound.');
    walk(values[i], depth + 1);
  }
}

/** encode(value, options): the native contract, through the tape. */
export function encode(value, options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('Writer options must be an object.');
  const limits = resolveLimits(options.limits ? { ...options, ...options.limits } : options);
  rt.ready();
  if (busy) throw new Error('snug wasm: encode re-entered from a host value (the tape is per isolate)');
  busy = true;
  try {
    if (gen !== rt.generation) { tcap = 0; bcap = 0; gen = rt.generation; }
    cose = options.cose === true; omit = options.omitUndefined === true; strict = options.strictArrays === true;
    maxDepth = limits.maxDepth; maxEntries = limits.maxEntries; maxItems = limits.maxItems;
    const explicit = options.maxBytes ?? options.limits?.maxBytes;
    tn = 0; bn = 0; items = 0;
    walk(value, 0);
    let r;
    try { r = rt.x.sdk_enc_run(); } catch (e) { rt.lost(e); }
    rt.refresh();
    if (r < 0) {
      if (r === -1000) fail('depth', 'Nesting exceeds the SDK tape depth.');
      const code = CODES[-r] ?? 'malformed';
      fail(code, code === 'float' ? 'NaN, infinities, -0 and integral floats within the safe range are not encodable as floats.' : 'The encoder refused the value.');
    }
    if (explicit !== undefined && r > limits.maxBytes) fail('too_large', 'The encoding exceeds the size bound.');
    const p = rt.x.sdk_enc_out();
    return rt.u8.slice(p, p + r);
  } finally { busy = false; }
}
