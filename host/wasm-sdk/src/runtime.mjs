// P7.9 (D005 re-take): the wasm instance behind the SDK. snug's Rust build
// (host/wasm/src/sdk.rs, `kin/scripts/wasm-build sdk`) exports a plain integer
// ABI: no wasm-bindgen, one import (D170): `env.snug_ext`, which asks the
// extension-control predicate of the Program in the current call (`withExt`).
// This module owns the one instance per isolate, the views over its memory,
// and instance loss.
//
//   await init(source?)   source: a WebAssembly.Module (workerd imports .wasm
//                         modules), bytes, a Response, a URL; in Node with no
//                         argument the build output in the checkout is read
//   initSync(source)      a WebAssembly.Module or bytes (sync compile)
//   memoryBytes()         linear memory size now (it only ever grows)
//   reset()               drop the instance and its memory; Programs reload
//                         lazily, open views and sessions become unusable
//
// Instance loss: the generated code never panics, but a trap is still
// possible (an allocation beyond 4 GiB). Engine stack exhaustion inside wasm
// (recursion under limits raised far past the defaults) surfaces as a
// RangeError, and leaves the module's shadow-stack pointer wherever it was.
// Either error escaping a wasm call makes the SDK discard the instance and
// start a fresh one from the same module; the failing call throws
// InstanceLost (never a verdict). Callers wrap only wasm calls and memory
// copies, so a RangeError there is the engine's, not argument checking.
let mod = null, inst = null;
export let x = null;            // the exports
export let u8 = null, i32 = null;
let buf = null;
export let generation = 0;      // bumped by every new instance
export let OUT = 0, INFO = 0, NAV = 0;   // word indexes of the static areas
/** P8.4 (D262): after sdk_scan or sdk_validate accepted, the canonical copy to build from (a fresh Uint8Array) when
 *  the input is valid but not its own deterministic form, else null; and whether some map's keys may be out of
 *  canonical order (INFO[1] bit VC_UNSORTED). */
export function lastCopy() {
  refresh();
  const n = i32[INFO + 2], unsorted = (i32[INFO + 1] & 1024) !== 0;
  if (n < 0) return { bytes: null, unsorted };
  const p = x.sdk_copy() >>> 0;
  return { bytes: u8.slice(p, p + n), unsorted };
}

export class InstanceLost extends Error {
  constructor(cause) { super('snug wasm: the instance trapped and was reset; no verdict was reached'); this.name = 'InstanceLost'; this.cause = cause; }
}

// ---------------------------------------------------------------- extension controls (D170)
// The VM asks a host predicate through the import while a validate or session
// step is inside wasm. The bound predicate (ext.mjs bindControls) is set for the
// duration of that one call; the predicate gets COPIES of the argument and the
// item (an alias into linear memory would change under it), and any SDK call it
// makes meets a guard instead of re-entering the instance (whose Rust state is
// borrowed for the call): that error, like any other the predicate throws, is
// recorded by bindControls and rethrown after the call (ext.mjs rethrow).
let current = null;
const GUARD = new Proxy({}, { get() { throw new Error('snug wasm: an extension control called back into snug'); } });
function snugExt(id, _ap, al, ip, il, room, ao) {
  const bound = current;
  if (bound === null || bound.failure) return -2;
  refresh();
  // The argument is read from the bound Program's own pool (the JS copy, byte for byte the
  // one in wasm) at its offset ao, as on the native host: a metered control's arguments
  // (`.abnf`, D334) were prepared at bind under that offset.
  const item = u8.slice(ip, ip + il), saved = x;
  x = GUARD;
  try { return bound.call(id, bound.pool, ao, al, item, 0, il, room); } finally { x = saved; }
}
/** Run f (one wasm call) with `bound` answering the Program's extension controls. */
export function withExt(bound, f) {
  if (bound === null) return f();
  const before = current;
  current = bound;
  try { return f(); } finally { current = before; }
}

function start() {
  inst = new WebAssembly.Instance(mod, { env: { snug_ext: snugExt } });
  x = inst.exports;
  buf = null; refresh();
  OUT = x.sdk_out() >>> 2; INFO = x.sdk_info() >>> 2; NAV = x.sdk_nav_words() >>> 2;
  x.sdk_nav_init();
  generation++;
}

/** Re-derive the memory views after anything that may have grown memory. */
export function refresh() {
  const b = x.memory.buffer;
  if (b !== buf) { buf = b; u8 = new Uint8Array(b); i32 = new Int32Array(b); }
}

/** Use from every public entry point's catch: a trap loses the instance. */
export function lost(e) {
  if (e instanceof WebAssembly.RuntimeError || e instanceof RangeError) {
    inst = null; x = null; u8 = null; i32 = null; buf = null;
    start();
    throw new InstanceLost(e);
  }
  throw e;
}

export function ready() {
  if (x === GUARD) throw new Error('snug wasm: an extension control called back into snug');
  if (x === null) throw new Error('snug wasm: call init() first');
}

const DEFAULT = '../../../.cache/snug-wasm-sdk/target/wasm32-unknown-unknown/release/snug_wasm.wasm';

async function compileFrom(source) {
  if (source instanceof WebAssembly.Module) return source;
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) return WebAssembly.compile(source);
  if (typeof Response === 'function' && source instanceof Response) return WebAssembly.compileStreaming ? WebAssembly.compileStreaming(source) : WebAssembly.compile(await source.arrayBuffer());
  const url = source ?? new URL(DEFAULT, import.meta.url);
  if (String(url).startsWith('file:')) {
    const { readFile } = await import('node:fs/promises');
    return WebAssembly.compile(await readFile(url));
  }
  return compileFrom(await fetch(url));
}

export async function init(source) {
  if (x !== null && source === undefined) return;
  mod = await compileFrom(source);
  start();
}
export function initSync(source) {
  mod = source instanceof WebAssembly.Module ? source : new WebAssembly.Module(source);
  start();
}
export const memoryBytes = () => x.memory.buffer.byteLength;
export function reset() { ready(); start(); }
export const module = () => mod;

// ---------------------------------------------------------------- helpers

let inPtr = 0, inCap = 0, inGen = -1;
/** Copy bytes into the reusable input buffer; answers its pointer. */
export function input(bytes) {
  const n = bytes.length;
  if (n > inCap || inGen !== generation) { inPtr = x.sdk_input(n) >>> 0; inCap = n; inGen = generation; refresh(); }
  if (n <= 64) { const u = u8; for (let i = 0; i < n; i++) u[inPtr + i] = bytes[i]; }
  else u8.set(bytes, inPtr);
  return inPtr;
}
/** Drop the reusable buffers (memory pages stay; the allocator reuses them). */
export function trim() { x.sdk_trim(); inCap = 0; refresh(); }

let kPtr = 0, kCap = 0, kGen = -1;
/** The key scratch, at least n bytes: its pointer. */
export function kbuf(n) {
  if (n > kCap || kGen !== generation) { kPtr = x.sdk_kbuf(Math.max(n, 64)) >>> 0; kCap = Math.max(n, 64); kGen = generation; refresh(); }
  return kPtr;
}

const names = new Map();
const td = new TextDecoder();
/** The scanner's code name (from kin, through wasm). */
export function codeName(code) {
  let s = names.get(code);
  if (s === undefined) { const p = x.sdk_code_name(code) >>> 0; s = td.decode(u8.subarray(p, p + i32[INFO])); names.set(code, s); }
  return s;
}
