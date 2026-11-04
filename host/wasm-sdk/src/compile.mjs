// P7.9: `snug/compile` over wasm. The compiler is its own module
// (host/wasm/src/cc.rs, `kin/scripts/wasm-build cc`), compiled and
// instantiated on the first call, as the native package loads its compiler
// chunk on the first call. The Program's words and pool are copied out (the
// public Program keeps them for its accessors) and loaded into the runtime
// instance, where vm-verify checks them.
import { Program, Schema } from './schema.mjs';

export class SchemaError extends Error {
  constructor(code, line = 0, column = 0, rule) {
    super(`CDDL schema refused: ${code}` + (line > 0 ? ` at ${line}:${column}` : ''));
    this.name = 'SchemaError'; this.code = code; this.line = line; this.column = column; this.rule = rule;
  }
}

const PROFILES = { full: 0, bindle: 1, bus: 2 };
const COMPILE_OPTIONS = ['schemaBytes', 'nesting', 'astNodes', 'instantiations', 'alternatives',
  'arrayPositions', 'regexpPositions', 'width', 'poolBytes', 'totalBytes', 'compileBudget', 'depth', 'inputBytes',
  'entries', 'items', 'bignumBytes', 'budget', 'leaves'];
const DEFAULT = '../../../.cache/snug-wasm-cc/target/wasm32-unknown-unknown/release/snug_wasm.wasm';
const te = new TextEncoder(), td = new TextDecoder();

let source, mod = null, x = null;
/** Where the compiler module comes from (a WebAssembly.Module, bytes or URL); default: the checkout's build. */
export function compilerSource(s) { source = s; mod = null; x = null; }
/** Drop the compiler instance (its memory, grown by a large schema, goes with it). */
export function releaseCompiler() { x = null; }

async function compiler() {
  if (x) return x;
  if (!mod) {
    const s = source ?? new URL(DEFAULT, import.meta.url);
    if (s instanceof WebAssembly.Module) mod = s;
    else if (s instanceof Uint8Array || s instanceof ArrayBuffer) mod = await WebAssembly.compile(s);
    else if (String(s).startsWith('file:')) { const { readFile } = await import('node:fs/promises'); mod = await WebAssembly.compile(await readFile(s)); }
    else mod = await WebAssembly.compileStreaming(fetch(s));
  }
  x = new WebAssembly.Instance(mod, {}).exports;
  return x;
}
export const compilerMemoryBytes = () => (x ? x.memory.buffer.byteLength : 0);

export async function compile(text, { profile = 'full', limits = {}, unicode } = {}) {
  const bytes = typeof text === 'string' ? te.encode(text) : text;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('compile expects CDDL text.');
  if (!(profile in PROFILES)) throw new TypeError("profile must be 'full', 'bindle' or 'bus'.");
  if (unicode !== undefined) throw new TypeError('snug wasm SDK: Unicode tables are not wired in this experiment');
  const opt = new Int32Array(19).fill(-1);
  opt[0] = PROFILES[profile];
  for (const [k, v] of Object.entries(limits)) {
    const i = COMPILE_OPTIONS.indexOf(k);
    if (i < 0) throw new TypeError(`unknown compile limit ${k}`);
    if (!Number.isInteger(v) || v < 0) throw new TypeError(`limit ${k} must be a non-negative integer`);
    opt[i + 1] = Math.min(v, 0x7fffffff);
  }
  const c = await compiler();
  let P, B;
  try {
    const tp = c.cc_text(bytes.length);
    new Uint8Array(c.memory.buffer, tp, bytes.length).set(bytes);
    new Int32Array(c.memory.buffer, c.cc_opt(), 19).set(opt);
    const r = c.cc_compile(bytes.length);
    const info = new Int32Array(c.memory.buffer, c.cc_info(), 8);
    if (r !== 0) {
      const p = c.cc_error();
      const m = new Uint8Array(c.memory.buffer), inf = new Int32Array(c.memory.buffer, c.cc_info(), 8);
      const code = td.decode(m.subarray(p, p + inf[0]));
      const rule = inf[3] >= 0 ? td.decode(m.subarray(p + inf[0], p + inf[0] + inf[3])) : undefined;
      throw new SchemaError(code, inf[1], inf[2], rule);
    }
    const pp = c.cc_program(), bp = c.cc_pool();
    const words = info[0], nb = info[1];
    P = new Int32Array(c.memory.buffer, pp, words).slice();
    B = new Uint8Array(c.memory.buffer, bp, nb).slice();
    c.cc_release();
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) { x = null; throw new Error('snug wasm: the compiler instance trapped and was dropped'); }
    throw e;
  }
  return new Schema(new Program(P, B));
}
