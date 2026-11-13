// Extension controls on the JS host. The generated core decides
// where an EXT leaf is queried and charges it; this module only turns a
// registry ({name: predicate}) into the compiler's registry words, reads a
// Program's control table, and binds it to the predicate port the VM calls.
//
//   control  = (argument: Uint8Array, item: Uint8Array) => boolean
//            | { check(argument, item): boolean, maxBytes?: number,
//                argument?(argument): boolean, cost?(itemBytes): number }
//
// A predicate must be a pure function of its two inputs (no I/O, no clock, no
// state, no call back into snug); only a strict `true` matches. `maxBytes`
// (default 65,536) bounds the item a control is asked about: a longer item
// fails the control with the reason `control_size` without asking, under
// every source, so the session driver never buffers more than that for it.
//
// BUDGET. The VM charges every call EXT_CALL units, then the
// predicate's COST, before it runs: `cost(itemBytes)` budget units (a
// non-negative safe integer), by default `itemBytes`. A cost above what the
// budget has left stops validation with `budget` without calling. The VM
// cannot interrupt or measure host code: what a predicate does with its CPU is
// the host's responsibility, and `cost` is how a host keeps a slow predicate
// inside the budget (~20 ns of CPU per unit is what the default budget assumes).
// The generic controls (snug/controls) instead meter their own work in the core
// (the METERED protocol below, not a public contract).
import { ProgramError } from './serialized.mjs';

/** Registry entries carrying this key are metered in the core (snug/controls only):
 *  { prepare(pool, ao, al): Int32Array, run(pool, ao, prepared, b, s, e, room): verdict }. */
export const METERED = Symbol.for('snug.metered');
const ABNF = Symbol.for('snug.abnf');   // the ABNF module's entries name themselves (snug/abnf)
const MAX_UNITS = 0x7ffffffd;

export const DEFAULT_MAX_BYTES = 65536;
const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const BUILTIN = new Set(['size', 'bits', 'lt', 'le', 'gt', 'ge', 'eq', 'ne', 'and', 'within', 'regexp',
  'cbor', 'cborseq', 'default', 'feature', 'cat', 'det', 'plus', 'pcre', 'abnf', 'abnfb']);
const encoder = new TextEncoder(), decoder = new TextDecoder();

/** The registry as sorted entries {name, check, maxBytes, argument}; TypeError on a malformed one. */
export function controlEntries(controls) {
  if (controls === undefined) return [];
  if (controls === null || typeof controls !== 'object' || Array.isArray(controls))
    throw new TypeError('controls must be an object of named predicates.');
  const entries = [];
  for (const name of Object.keys(controls).sort((a, b) => compareBytes(encoder.encode(a), encoder.encode(b)))) {
    const c = controls[name];
    // D334: `abnf` / `abnfb` are built-in names that only the ABNF module (snug/abnf) binds
    if (!NAME.test(name) || (BUILTIN.has(name) && c?.[ABNF] !== name))
      throw new TypeError(`Invalid control name ${JSON.stringify(name)} (an identifier that is not a built-in control).`);
    const entry = typeof c === 'function' ? { check: c } : c;
    if (entry === null || typeof entry !== 'object' || typeof entry.check !== 'function')
      throw new TypeError(`Control .${name} must be a function or an object with a check function.`);
    const maxBytes = entry.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 0x7fffffff)
      throw new TypeError(`Control .${name} maxBytes must be an integer in 0..2^31-1.`);
    if (entry.argument !== undefined && typeof entry.argument !== 'function')
      throw new TypeError(`Control .${name} argument must be a function.`);
    if (entry.cost !== undefined && typeof entry.cost !== 'function')
      throw new TypeError(`Control .${name} cost must be a function of the item's byte length.`);
    entries.push({ name, check: entry.check, maxBytes, argument: entry.argument, cost: entry.cost, metered: entry[METERED] });
  }
  return entries;
}

function compareBytes(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** The registry words that follow the compile options (snug.compile.ext): n, flags, then per
 *  control its name length, maximum item bytes and name bytes. */
export function registryWords(entries, inBus, abnfLenient = false) {
  if (entries.length === 0) return [];
  // flags: bit 0 admits them under `bus`; bit 1 the ABNF parse mode (D340), keyed with them
  const w = [entries.length, (inBus ? 1 : 0) | (abnfLenient ? 2 : 0)];
  for (const { name, maxBytes } of entries) {
    const b = encoder.encode(name);
    w.push(b.length, maxBytes, ...b);
  }
  return w;
}

/** The names of a Program's extension controls, in id order (format 1.1). */
export function programControls(P, B) {
  const names = [], n = P[30];
  let i = P[31];
  const end = i + P[39];
  while (names.length < n && i < end) {
    let len = B[i] & 31, c = i + 1;
    if (len === 24) { len = B[c]; c++; }
    names.push(decoder.decode(B.subarray(c, c + len)));
    i = c + len;
  }
  return names;
}

/** Each EXT leaf of a Program: {id, argument} (the argument's encoded bytes). */
export function programArguments(P, B) {
  const out = [], at = P[43], n = P[16];
  for (let l = 0; l < n; l++) {
    const o = at + 8 * l;
    if ((P[o] & 255) === 18) out.push({ id: P[o + 2], argument: B.subarray(P[o + 3], P[o + 3] + P[o + 4]) });
  }
  return out;
}

/** A Program's controls bound to the registry: the port the VM calls (null when the
 *  Program uses none). A control the Program names but the registry lacks is
 *  ProgramError('missing_control'), naming it. A metered (generic) control's
 *  arguments are prepared here, once per EXT leaf, keyed by (id, argument offset). */
export function bindControls(P, B, entries) {
  const names = programControls(P, B);
  if (names.length === 0) return null;
  const byName = new Map(entries.map(e => [e.name, e]));
  const missing = names.filter(n => !byName.has(n));
  if (missing.length) {
    const e = new ProgramError('missing_control');
    e.message = `snug: Program refused (missing_control: ${missing.map(n => '.' + n).join(', ')})`;
    e.controls = missing;
    throw e;
  }
  const bound_ = names.map(n => byName.get(n));
  const checks = bound_.map(e => e.check), costs = bound_.map(e => e.cost ?? null);
  const metered = bound_.map(e => e.metered ?? null);
  const preps = names.map(() => new Map());
  const at = P[43];
  for (let l = 0; l < P[16]; l++) {
    const o = at + 8 * l, id = P[o + 2];
    if ((P[o] & 255) !== 18 || !metered[id] || preps[id].has(P[o + 3])) continue;
    preps[id].set(P[o + 3], metered[id].prepare(B, P[o + 3], P[o + 4]));
  }
  const bound = {
    names, failure: null, pool: B,
    call(id, pool, ao, al, b, s, e, room) {
      const m = metered[id];
      if (m !== null) return m.run(pool, ao, preps[id].get(ao), b, s, e, room);
      if (bound.failure) return -2;
      let units = e - s;
      try {
        if (costs[id] !== null) {
          units = costs[id](e - s);
          if (!Number.isSafeInteger(units) || units < 0)
            throw new TypeError(`Control .${names[id]} cost must answer a non-negative integer.`);
        }
        if (units > room || units > MAX_UNITS) return -1;
        return checks[id](pool.subarray(ao, ao + al), b.subarray(s, e)) === true ? units : -2 - units;
      } catch (error) { bound.failure = { name: names[id], error }; return -2; }
    },
  };
  return bound;
}

/** After a VM call: a predicate that threw makes the call throw (its verdict is void). */
export function rethrow(bound) {
  if (!bound || !bound.failure) return;
  const { name, error } = bound.failure;
  bound.failure = null;
  throw new Error(`snug: extension control .${name} threw`, { cause: error });
}
