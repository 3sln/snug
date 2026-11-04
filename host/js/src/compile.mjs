// The CDDL compiler's JS entry point: a thin loop around the generated kin
// compiler (snug.compile.main). Every decision -- syntax, semantics, limits,
// the compile budget, the Program's bytes -- is kin's; this file owns only the
// arena, the decimal float-literal port (D020: Number(), at most 17
// significant digits, checked by kin) and the shape of the result.
//
//   compile(text, { profile, limits, cuts, groupWords }) -> { program: Int32Array, pool: Uint8Array, rules: string[],
//     warnings: [{ code, rule, line, column, message }] }   (format 2.0, docs/program-2.md)
//   throws SchemaError { code, line, column, rule } (schema text may be quoted; there is no payload)
import { compileSchema, floatRequests, floatRequestStart, floatRequestEnd, errorName, errorLine, errorColumn, errorOffset,
  errorRuleStart, errorRuleLen, outProgramAt, outProgramWords, outPoolAt, outPoolBytes, budgetUsed, keyPreimageAt,
  keyPreimageLen, snugVersion, OPT_WORDS, OPT_REGEXP, OPT_CUTS, OPT_GROUP_WORDS, warningCount, warningCode,
  warningLine, warningColumn, warningRuleStart, warningRuleLen, warningName, warningMessage }
  from '../../../gen/js/snug/compile/main.mjs';
import { ERR_ARENA, ERR_NEED_FLOATS, ERR_NEED_UNICODE, ERR_REGEXP_BLOCK, ARENA_MIN_WORDS, ARENA_MAX_WORDS } from '../../../gen/js/snug/compile/arena.mjs';
import { sha256 } from './sha256.mjs';
import { validateCompileOptions } from './options.mjs';
import { controlEntries, registryWords, programControls, programArguments } from './ext.mjs';

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
// Format 2.0 (D292): the fifth option limits PEG nodes per group (it was the alternatives limit).
export const COMPILE_OPTIONS = ['schemaBytes', 'nesting', 'astNodes', 'instantiations', 'pegNodes',
  'arrayPositions', 'regexpPositions', 'width', 'poolBytes', 'totalBytes', 'compileBudget', 'depth', 'inputBytes',
  'entries', 'items', 'bignumBytes', 'budget', 'leaves'];

// One arena per isolate: compilation is synchronous and calls no host code, so it is reused (and grown) across calls.
let arena = new Int32Array(ARENA_MIN_WORDS);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function options(profile, limits, registry = []) {
  // D141: the extension-control registry rides after the OPT_WORDS options
  const opt = new Int32Array(OPT_WORDS + registry.length).fill(-1);
  opt.set(registry, OPT_WORDS);
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

/** Compile CDDL text (a string, or its UTF-8 bytes) to a Program (docs/program.md + docs/program-2.md, format 2.0). */
export function compile(text, opts = {}) {
  validateCompileOptions(opts);
  const { profile = 'full', limits = {}, unicode, controls, controlsInBus = false, regexp = 'xsd',
    cuts = 'reference', groupWords } = opts;
  const entries = controlEntries(controls);
  try { return compileOnce(text, profile, limits, unicode, entries, controlsInBus, regexp, cuts, groupWords); }
  finally {
    // A hostile schema may have grown the arena to tens of megabytes: do not keep that for the isolate's life.
    if (arena.length > RETAIN_WORDS) arena = new Int32Array(ARENA_MIN_WORDS);
  }
}
const RETAIN_WORDS = 1 << 22;

function compileOnce(text, profile, limits, unicode, entries, inBus, regexp, cuts, groupWords) {
  const bytes = typeof text === 'string' ? encoder.encode(text) : text;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('compile expects CDDL text.');
  const opt = options(profile, limits, registryWords(entries, inBus));
  opt[OPT_REGEXP] = regexp === 'iregexp' ? 1 : 0;
  // D273: rule A (`reference`, the default) or commitment epochs (`rfc`); D276/D281: the arena cap.
  opt[OPT_CUTS] = cuts === 'rfc' ? 1 : 0;
  opt[OPT_GROUP_WORDS] = groupWords === undefined ? -1 : Math.min(groupWords, 0x7fffffff);
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
        code === ERR_NEED_UNICODE ? '; Unicode categories require tables from snug/unicode'
          : code === ERR_REGEXP_BLOCK ? '; XSD block escapes require unavailable pinned Unicode block data'
          : errorName(code) === 'unknown_control' ? controlNamed(bytes, errorOffset(h)) : '');
    }
    const p = outProgramAt(h), b = outPoolAt(h);
    if (outProgramWords(h) < 64) throw new SchemaError('internal', 0, 0, undefined);
    const program = h.slice(p, p + outProgramWords(h));
    const pool = Uint8Array.from(h.subarray(b, b + outPoolBytes(h)));
    // SOURCE_KEY (header words 7..14): SHA-256 of kin's deterministic preimage, word i = big-endian bytes 4i..4i+3.
    const k = keyPreimageAt(h);
    const key = sha256(Uint8Array.from(h.subarray(k, k + keyPreimageLen(h))));
    for (let i = 0; i < 8; i++) program[7 + i] = (key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3];
    checkArguments(program, pool, entries);
    return { program, pool, rules: ruleNames(program, pool), controls: entries, warnings: warnings(h, bytes) };
  }
}

// Architecture §20.11: compile warnings never refuse; kin decides them, in a deterministic order.
function warnings(h, bytes) {
  const out = [];
  for (let i = 0, n = warningCount(h); i < n; i++) {
    const code = warningCode(h, i), rs = warningRuleStart(h, i);
    out.push({ code: warningName(code), rule: rs >= 0 ? decoder.decode(bytes.subarray(rs, rs + warningRuleLen(h, i))) : null,
      line: warningLine(h, i), column: warningColumn(h, i), message: warningMessage(code) });
  }
  return out;
}

// D141: name the control a schema uses but the registry lacks (schema text, never payload).
function controlNamed(bytes, at) {
  if (at < 0 || bytes[at] !== 0x2e) return '';
  let e = at + 1;
  while (e < bytes.length && /[A-Za-z0-9_\-@$.]/.test(String.fromCharCode(bytes[e]))) e++;
  return ` (.${decoder.decode(bytes.subarray(at + 1, e))} is not a registered control)`;
}

// A registered control may check its argument once, at compile time (D142).
function checkArguments(program, pool, entries) {
  if (program[30] === 0) return;
  const names = programControls(program, pool), byName = new Map(entries.map(e => [e.name, e]));
  for (const { id, argument } of programArguments(program, pool)) {
    const entry = byName.get(names[id]);
    if (entry.argument && entry.argument(Uint8Array.from(argument)) !== true)
      throw new SchemaError('control_value', 0, 0, undefined, ` (.${entry.name} argument)`);
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
