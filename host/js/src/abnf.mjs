// @3sln/snug/abnf: RFC 9165 §3's `.abnf` and `.abnfb` controls, an optional module so
// that no core bundle carries the ABNF engine. Give its registry to the compiler and to
// a Program's loader:
//
//   import { abnf } from '@3sln/snug/abnf';
//   const schema = compile(text, { controls: { ...abnf } });          // with others: { ...controls, ...abnf }
//   fromSerialized(bytes, { controls: { ...abnf } });
//
// Without it a schema using `.abnf` is refused (`unsupported_control`, naming this
// module) and a stored Program using it fails to load (`missing_control`).
//
// The controller (a text string, or a byte string holding UTF-8) is ABNF (RFC 5234 with
// RFC 7405's %s/%i strings): one element -- the start -- then optionally a newline and
// rules, exactly as RFC 9165 §3 says by default; `compile(text, { abnf: 'lenient' })`
// also admits snug's non-RFC forms. It is checked when the schema compiles (prose-val, syntax errors, undefined
// rules: `control_value`, with the ABNF line and column) and prepared once when a
// Program is bound. The match is language membership over the target string's Unicode
// scalars (`.abnf`) or bytes (`.abnfb`), metered in the generated core against the budget that remains
// (snug.abnf): verdicts and charges are the same on every host.
import { abnfWords, abnfPrep, abnfErrorName, abnfErrorHint, abnfErrorLine, abnfErrorColumn, abnfTableWords,
  abnfScratchWords, abnfRun, abnfMore, ABNF_DEFAULT_WORDS, ABNF_MIN_WORDS, ABNF_MAX_WORDS, MODE_STRICT, MODE_LENIENT }
  from '../../../gen/js/snug/abnf.mjs';
const METERED = Symbol.for('snug.metered'), ABNF = Symbol.for('snug.abnf');   // ext.mjs's keys
const NONE = new Int32Array(0);

/** The prepared table of an argument (its encoding at pool[ao, +al)), or an empty one when
 *  refused. Lenient: every controller the strict default admits means the same there, and
 *  the compile-time check already applied the schema's mode. */
function prepare(pool, ao, al) {
  const t = new Int32Array(abnfWords(al));
  return abnfPrep(pool, ao, al, t, MODE_LENIENT) === 0 ? t.slice(0, abnfTableWords(t)) : NONE;
}

// One scratch, reused (kin never re-enters a run), first sized by abnfScratchWords. When kin
// needs more (abnfMore: the size it suggests -- at least double, at most the cap) the run
// is repeated with that, not charged; so verdicts and units never depend on this size,
// and a run is repeated at most log2(cap / first size) + 1 times (at most 2x the work).
// Given back after a run past 2^20 words.
let scratch = new Int32Array(4096);
function run(mode, cap) {
  return (_pool, _ao, t, b, s, e, room) => {
    if (t.length === 0) return -2;
    const first = abnfScratchWords(t, e - s, cap);
    if (scratch.length < first) scratch = new Int32Array(first);
    for (let reruns = 0; ; reruns++) {
      const r = abnfRun(t, mode, b, s, e, scratch, room, cap);
      const more = abnfMore(scratch);
      if (r === -1 && more > scratch.length) {
        if (more < 2 * scratch.length || reruns > 24) throw new Error('snug: internal error (abnf scratch growth)');
        scratch = new Int32Array(more);
        continue;
      }
      if (scratch.length > 1 << 20) scratch = new Int32Array(4096);
      return r;
    }
  };
}

/** true, or the refusal's detail: "<message> at ABNF line L, column C<hint>" (the hint names
 *  the option for a strict-only refusal). The compile options give the parse mode: strict
 *  RFC 5234 + 7405 + 9165 §3 unless { abnf: 'lenient' }. */
function argument(bytes, options) {
  const mode = options?.abnf === 'lenient' ? MODE_LENIENT : MODE_STRICT;
  const t = new Int32Array(abnfWords(bytes.length)), code = abnfPrep(bytes, 0, bytes.length, t, mode);
  if (code === 0) return true;
  return abnfErrorName(code) + (abnfErrorLine(t) > 0 ? ` at ABNF line ${abnfErrorLine(t)}, column ${abnfErrorColumn(t)}` : '')
    + abnfErrorHint(code);
}

function control(name, mode, maxBytes, cap) {
  const m = Object.freeze({ prepare, run: run(mode, cap) });
  return Object.freeze({
    check: (a, item) => m.run(a, 0, m.prepare(a, 0, a.length), item, 0, item.length, 0x7fffffff) >= 0,
    argument,
    maxBytes,
    [METERED]: m,
    [ABNF]: name,
  });
}

/** The two controls with other bounds: `maxBytes`, the item a control is asked about
 *  (default 65,536; a longer one fails with `control_size`), and `maxWords`, the
 *  matcher's scratch cap (default 4,194,304 words = 16 MiB, the group arena default;
 *  65,536 to 16,777,216): a match that needs more stops with `budget`. */
export function abnfWith({ maxBytes = 65536, maxWords = ABNF_DEFAULT_WORDS } = {}) {
  if (!Number.isSafeInteger(maxWords) || maxWords < ABNF_MIN_WORDS || maxWords > ABNF_MAX_WORDS)
    throw new TypeError(`abnf maxWords must be an integer in ${ABNF_MIN_WORDS}..${ABNF_MAX_WORDS}.`);
  return Object.freeze({ abnf: control('abnf', 0, maxBytes, maxWords), abnfb: control('abnfb', 1, maxBytes, maxWords) });
}

/** `.abnf` (the target string's Unicode scalars; a byte string must hold UTF-8) and
 *  `.abnfb` (its bytes) with the default bounds, to spread into a registry:
 *  compile(text, { controls: { ...abnf } }). Other bounds: abnfWith(). */
export const abnf = abnfWith();

/** A controller on its own (ABNF text, or a CBOR text/byte string's encoding): true, or
 *  why the compiler would refuse it under the same options ({ abnf: 'strict' | 'lenient' }). */
export function checkAbnf(text, options = {}) {
  if (typeof text !== 'string') return argument(text, options);
  const b = new TextEncoder().encode(text), n = b.length;
  const h = n < 24 ? [0x60 | n] : n < 256 ? [0x78, n] : n < 65536 ? [0x79, n >> 8, n & 255]
    : [0x7a, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  return argument(Uint8Array.from([...h, ...b]), options);
}
