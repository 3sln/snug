// P7.9: `snug/compile` over wasm. The compiler is its own module
// (host/wasm/src/cc.rs, `kin/scripts/wasm-build cc`), compiled and
// instantiated on the first call, as the native package loads its compiler
// chunk on the first call. The Program's words and pool are copied out (the
// public Program keeps them for its accessors) and loaded into the runtime
// instance, where vm-verify checks them.
//
// Since P7.9 (D171, D172): the options are the native ones, checked by the
// native validator (`profile`, `limits`, `unicode` tables from snug/unicode,
// `controls` and `controlsInBus`); the extension-control registry rides after
// the option words exactly as native compile.mjs builds it (ext.mjs
// registryWords), so the Program (format 1.1 when a control is used) and its
// SOURCE_KEY are byte-identical; a control's argument check runs here, in JS,
// after compilation, as the native host does. SchemaError is the native public
// class, with the native message.
import { Program, Schema } from './schema.mjs';
import { SchemaError } from '../../js/src/public-compile.mjs';
import { validateCompileOptions } from '../../js/src/options.mjs';
import { controlEntries, registryWords, programControls, programArguments } from '../../js/src/ext.mjs';

export { SchemaError };
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

function refused(code, line, column, rule, detail) {
  const e = new SchemaError(code, line, column, rule);
  e.message = `CDDL schema refused: ${code}` + (line > 0 ? ` at ${line}:${column}` : '') + (rule ? ` in rule ${rule}` : '') + detail;
  return e;
}

export async function compile(text, options = {}) {
  validateCompileOptions(options);
  const { profile = 'full', limits = {}, unicode, controls, controlsInBus = false, regexp = 'xsd' } = options;
  const entries = controlEntries(controls);
  const bytes = typeof text === 'string' ? te.encode(text) : text;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('compile expects CDDL text.');
  const registry = registryWords(entries, controlsInBus);
  const opt = new Int32Array(20 + registry.length).fill(-1);
  opt.set(registry, 20);
  opt[0] = PROFILES[profile];
  opt[19] = regexp === 'iregexp' ? 1 : 0;
  for (const [i, k] of COMPILE_OPTIONS.entries()) if (limits[k] !== undefined) opt[i + 1] = Math.min(limits[k], 0x7fffffff);
  const c = await compiler();
  let P, B;
  try {
    const tp = c.cc_text(bytes.length);
    new Uint8Array(c.memory.buffer, tp, bytes.length).set(bytes);
    const op = c.cc_opt(opt.length);
    new Int32Array(c.memory.buffer, op, opt.length).set(opt);
    const tables = unicode ?? new Int32Array(0);
    const up = c.cc_unicode(tables.length);
    if (tables.length) new Int32Array(c.memory.buffer, up, tables.length).set(tables);
    const r = c.cc_compile(bytes.length);
    if (r !== 0) {
      const p = c.cc_error();
      const m = new Uint8Array(c.memory.buffer), inf = new Int32Array(c.memory.buffer, c.cc_info(), 8);
      const code = td.decode(m.subarray(p, p + inf[0]));
      const rl = Math.max(inf[3], 0);
      const rule = inf[3] >= 0 ? td.decode(m.subarray(p + inf[0], p + inf[0] + rl)) : undefined;
      const name = inf[4] >= 0 ? td.decode(m.subarray(p + inf[0] + rl, p + inf[0] + rl + inf[4])) : undefined;
      const detail = inf[5] === 1 ? '; Unicode categories require tables from snug/unicode'
        : inf[5] === 2 ? '; XSD block escapes require unavailable pinned Unicode block data'
        : code === 'unknown_control' && name !== undefined ? ` (.${name} is not a registered control)` : '';
      c.cc_release();
      throw refused(code, inf[1], inf[2], rule, detail);
    }
    const pp = c.cc_program(), bp = c.cc_pool();
    const info = new Int32Array(c.memory.buffer, c.cc_info(), 8);
    const words = info[0], nb = info[1];
    P = new Int32Array(c.memory.buffer, pp, words).slice();
    B = new Uint8Array(c.memory.buffer, bp, nb).slice();
    c.cc_release();
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError || e instanceof RangeError) { x = null; throw new Error('snug wasm: the compiler instance trapped and was dropped', { cause: e }); }
    throw e;
  }
  // D142: a registered control may check its argument once, at compile time
  if (P[30] !== 0) {
    const names = programControls(P, B), byName = new Map(entries.map(e => [e.name, e]));
    for (const { id, argument } of programArguments(P, B)) {
      const entry = byName.get(names[id]);
      if (entry.argument && entry.argument(Uint8Array.from(argument)) !== true)
        throw refused('control_value', 0, 0, undefined, ` (.${entry.name} argument)`);
    }
  }
  return new Schema(new Program(P, B, controls === undefined ? {} : { controls }));
}
