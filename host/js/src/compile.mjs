// The CDDL compiler's JS entry point: a thin loop around the generated kin
// compiler (snug.compile.main). Every decision -- syntax, semantics, limits,
// the compile budget, the Program's bytes -- is kin's; this file owns only the
// arena, the decimal float-literal port (D020: Number(), at most 17
// significant digits, checked by kin) and the shape of the result.
//
//   compile(text, { profile, limits }) -> { program: Int32Array, pool: Uint8Array, rules: string[] }
//   throws SchemaError { code, line, column, rule } (schema text may be quoted; there is no payload)
import { compileSchema, floatRequests, floatRequestStart, floatRequestEnd, errorName, errorLine, errorColumn,
  errorRuleStart, errorRuleLen, outProgramAt, outProgramWords, outPoolAt, outPoolBytes, budgetUsed, keyPreimageAt,
  keyPreimageLen, snugVersion, OPT_WORDS }
  from '../../../gen/js/snug/compile/main.mjs';
import { ERR_ARENA, ERR_NEED_FLOATS, ERR_NEED_UNICODE, ARENA_MIN_WORDS, ARENA_MAX_WORDS } from '../../../gen/js/snug/compile/arena.mjs';
import { sha256 } from './sha256.mjs';
import { validateOptions } from './options.mjs';

/** The snug version (kin's, so both hosts agree): in the source key and the serialisation container. */
export const SNUG_VERSION = snugVersion();

/** A schema the compiler refuses. `code` is a stable name (e.g. `map_overlap`); line and column are 1-based (column in code points), 0 when not about a place in the text. */
export class SchemaError extends Error {
  constructor(code, line, column, rule, detail = '') {
    super(`CDDL schema refused: ${code}` + (line > 0 ? ` at ${line}:${column}` : '') + (rule ? ` in rule ${rule}` : '') + detail);
    this.name = 'SchemaError'; this.code = code; this.line = line; this.column = column; this.rule = rule;
  }
}

const PROFILES = { full: 0, bindle: 1, bus: 2 };
// Option order: program.md §13.3's source key, then the leaf limit (snug.compile.main OPT_WORDS).
export const COMPILE_OPTIONS = ['schemaBytes', 'nesting', 'astNodes', 'instantiations', 'alternatives',
  'arrayPositions', 'regexpPositions', 'width', 'poolBytes', 'totalBytes', 'compileBudget', 'depth', 'inputBytes',
  'entries', 'items', 'bignumBytes', 'budget', 'leaves'];

// One arena per isolate: compilation is synchronous and calls no host code, so it is reused (and grown) across calls.
let arena = new Int32Array(ARENA_MIN_WORDS);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function options(profile, limits) {
  const opt = new Int32Array(OPT_WORDS).fill(-1);
  opt[0] = PROFILES[profile];
  for (const [i, k] of COMPILE_OPTIONS.entries()) {
    const v = limits[k];
    if (v === undefined) continue;
    opt[i + 1] = Math.min(v, 0x7fffffff);
  }
  return opt;
}

function floats(h, bytes) {
  // D020/D032: kin found decimal float literals it cannot round itself; convert each span with Number().
  const n = floatRequests(h), out = new Int32Array(1 + 2 * n), dv = new DataView(new ArrayBuffer(8));
  out[0] = n;
  for (let i = 0; i < n; i++) {
    const lit = decoder.decode(bytes.subarray(floatRequestStart(h, i), floatRequestEnd(h, i)));
    dv.setFloat64(0, Number(lit));
    out[1 + 2 * i] = dv.getInt32(0); out[2 + 2 * i] = dv.getInt32(4);
  }
  return out;
}

/** Compile CDDL text (a string, or its UTF-8 bytes) to a Program (docs/program.md, format 1). */
export function compile(text, opts = {}) {
  validateOptions(opts, 'compile');
  const { profile = 'full', limits = {}, unicode } = opts;
  try { return compileOnce(text, profile, limits, unicode); }
  finally {
    // A hostile schema may have grown the arena to tens of megabytes: do not keep that for the isolate's life.
    if (arena.length > RETAIN_WORDS) arena = new Int32Array(ARENA_MIN_WORDS);
  }
}
const RETAIN_WORDS = 1 << 22;

function compileOnce(text, profile, limits, unicode) {
  const bytes = typeof text === 'string' ? encoder.encode(text) : text;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('compile expects CDDL text.');
  const opt = options(profile, limits);
  const tables = unicode ?? new Int32Array(0);
  if (!(tables instanceof Int32Array) || (typeof SharedArrayBuffer !== 'undefined' && tables.buffer instanceof SharedArrayBuffer))
    throw new TypeError('unicode must be the Int32Array tables from snug/unicode');
  let fl = new Int32Array(0);
  for (;;) {
    const h = arena;
    const code = compileSchema(bytes, opt, fl, tables, h);
    if (code === ERR_ARENA) {
      if (arena.length >= ARENA_MAX_WORDS) throw new SchemaError('limit_memory', 0, 0, undefined);
      arena = new Int32Array(Math.min(arena.length * 2, ARENA_MAX_WORDS));
      continue;
    }
    if (code === ERR_NEED_FLOATS) { fl = floats(h, bytes); continue; }
    if (code !== 0) {
      const rs = errorRuleStart(h);
      const rule = rs >= 0 ? decoder.decode(bytes.subarray(rs, rs + errorRuleLen(h))) : undefined;
      throw new SchemaError(errorName(code), errorLine(h), errorColumn(h), rule,
        code === ERR_NEED_UNICODE ? '; Unicode categories require tables from snug/unicode' : '');
    }
    const p = outProgramAt(h), b = outPoolAt(h);
    if (outProgramWords(h) < 64) throw new SchemaError('internal', 0, 0, undefined);
    const program = h.slice(p, p + outProgramWords(h));
    const pool = Uint8Array.from(h.subarray(b, b + outPoolBytes(h)));
    // SOURCE_KEY (header words 7..14): SHA-256 of kin's deterministic preimage, word i = big-endian bytes 4i..4i+3.
    const k = keyPreimageAt(h);
    const key = sha256(Uint8Array.from(h.subarray(k, k + keyPreimageLen(h))));
    for (let i = 0; i < 8; i++) program[7 + i] = (key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3];
    return { program, pool, rules: ruleNames(program, pool) };
  }
}

/** Compile budget units the last compile() spent (benchmarks, the fuzz gate). */
export function lastBudgetUsed() { return budgetUsed(arena); }

/** The rule names of a Program, in RULES order (a rule's index is its position). */
export function ruleNames(program, pool) {
  const names = [], at = program[42], n = program[15];
  for (let i = 0; i < n; i++) {
    const off = program[at + 5 * i], len = program[at + 5 * i + 1];
    names.push(decoder.decode(pool.subarray(off, off + len)));
  }
  return names;
}
