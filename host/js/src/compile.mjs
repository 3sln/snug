// The CDDL compiler's JS entry point: a thin loop around the generated kin
// compiler (snug.compile.main). Every decision -- syntax, semantics, limits,
// the compile budget, the Program's bytes -- is kin's; this file owns only the
// arena, the decimal float-literal port (D020: Number(), at most 17
// significant digits, checked by kin) and the shape of the result.
//
//   compile(text, { profile, limits }) -> { program: Int32Array, pool: Uint8Array, rules: string[] }
//   throws SchemaError { code, line, column, rule } (schema text may be quoted; there is no payload)
import { compileSchema, floatRequests, floatRequestStart, floatRequestEnd, errorName, errorLine, errorColumn,
  errorRuleStart, errorRuleLen, outProgramAt, outProgramWords, outPoolAt, outPoolBytes, OPT_WORDS }
  from '../../../gen/js/snug/compile/main.mjs';
import { ERR_ARENA, ERR_NEED_FLOATS, ARENA_MIN_WORDS, ARENA_MAX_WORDS } from '../../../gen/js/snug/compile/arena.mjs';

/** A schema the compiler refuses. `code` is a stable name (e.g. `map_overlap`); line and column are 1-based (column in code points), 0 when not about a place in the text. */
export class SchemaError extends Error {
  constructor(code, line, column, rule) {
    super(`CDDL schema refused: ${code}` + (line > 0 ? ` at ${line}:${column}` : '') + (rule ? ` in rule ${rule}` : ''));
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
  if (!(profile in PROFILES)) throw new TypeError("profile must be 'full', 'bindle' or 'bus'.");
  opt[0] = PROFILES[profile];
  for (const [k, v] of Object.entries(limits)) {
    const i = COMPILE_OPTIONS.indexOf(k);
    if (i < 0) throw new TypeError(`unknown compile limit ${k}`);
    if (!Number.isInteger(v) || v < 0) throw new TypeError(`limit ${k} must be a non-negative integer`);
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
export function compile(text, { profile = 'full', limits = {} } = {}) {
  const bytes = typeof text === 'string' ? encoder.encode(text) : text;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('compile expects CDDL text.');
  const opt = options(profile, limits);
  let fl = new Int32Array(0);
  for (;;) {
    const h = arena;
    const code = compileSchema(bytes, opt, fl, h);
    if (code === ERR_ARENA) {
      if (arena.length >= ARENA_MAX_WORDS) throw new SchemaError('limit_memory', 0, 0, undefined);
      arena = new Int32Array(Math.min(arena.length * 2, ARENA_MAX_WORDS));
      continue;
    }
    if (code === ERR_NEED_FLOATS) { fl = floats(h, bytes); continue; }
    if (code !== 0) {
      const rs = errorRuleStart(h);
      const rule = rs >= 0 ? decoder.decode(bytes.subarray(rs, rs + errorRuleLen(h))) : undefined;
      throw new SchemaError(errorName(code), errorLine(h), errorColumn(h), rule);
    }
    const p = outProgramAt(h), b = outPoolAt(h);
    const program = h.slice(p, p + outProgramWords(h));
    const pool = Uint8Array.from(h.subarray(b, b + outPoolBytes(h)));
    return { program, pool, rules: ruleNames(program, pool) };
  }
}

/** The rule names of a Program, in RULES order (a rule's index is its position). */
export function ruleNames(program, pool) {
  const names = [], at = program[42], n = program[15];
  for (let i = 0; i < n; i++) {
    const off = program[at + 5 * i], len = program[at + 5 * i + 1];
    names.push(decoder.decode(pool.subarray(off, off + len)));
  }
  return names;
}
