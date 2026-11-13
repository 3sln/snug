// snug/controls: the generic extension controls as registry entries for
// compile({ controls }) and fromSerialized(bytes, { controls }). Their verdicts
// AND their budget charges are the generated core's (snug.vm.controls), so every
// host agrees: each run meters its own work against the budget that remains
// and stops with `budget` before passing it. Arguments are prepared once per
// EXT leaf when a Program is bound, never per item.
//
//   .chars n | lo..hi       a text string of n / lo..hi Unicode code points
//   .unique <anything>      an array whose elements' encodings are pairwise distinct
//   .samelen "a" | [names]  a map whose named members, where present, hold arrays or
//                           typed arrays of one element count
import { charsArg, charsPrep, charsRun, uniqueRun, uniqueWords, anyArg, samelenRun, samelenPrep,
  samelenWords, namesArg, meterInit, M_WORDS } from '../../../gen/js/snug/vm/controls.mjs';
const METERED = Symbol.for('snug.metered');   // ext.mjs METERED (a registered symbol: no import)

// One meter + .unique scratch, reused across calls (kin never re-enters a run).
// Its size follows the largest array asked about -- three words per element,
// and the profile walk bounds elements by the entries limit -- and it is given
// back after an item past 2^20 words.
let scratch = new Int32Array(64);
const meter = (need, room) => {
  if (scratch.length < need) scratch = new Int32Array(need);
  meterInit(scratch, room);
  return scratch;
};
const NONE = new Int32Array(0);
const whole = (f, a) => f(a, 0, a.length);
const direct = m => (argument, item) => m.run(argument, 0, m.prepare(argument, 0, argument.length),
  item, 0, item.length, 0x7fffffff) >= 0;

const charsM = Object.freeze({
  prepare: (pool, ao, al) => { const t = new Int32Array(2); return charsPrep(pool, ao, al, t) === 0 ? t : Int32Array.of(1, 0); },
  run: (_pool, _ao, t, b, s, e, room) => charsRun(t, b, s, e, meter(M_WORDS, room)),
});
const uniqueM = Object.freeze({
  prepare: () => NONE,
  run: (_pool, _ao, _t, b, s, e, room) => {
    const r = uniqueRun(b, s, e, meter(uniqueWords(b, s, e), room));
    if (scratch.length > 1 << 20) scratch = new Int32Array(64);
    return r;
  },
});
const samelenM = Object.freeze({
  prepare: (pool, ao, al) => {
    const t = new Int32Array(samelenWords(pool, ao, al));
    return samelenPrep(pool, ao, al, t) === 0 ? t : NONE;
  },
  run: (pool, ao, t, b, s, e, room) => t.length === 0 ? -2 : samelenRun(pool, ao, t, b, s, e, meter(M_WORDS, room)),
});

export const chars = Object.freeze({
  check: direct(charsM),
  argument: argument => whole(charsArg, argument),
  [METERED]: charsM,
});
export const unique = Object.freeze({
  check: direct(uniqueM),
  argument: argument => whole(anyArg, argument),
  [METERED]: uniqueM,
});
export const samelen = Object.freeze({
  check: direct(samelenM),
  argument: argument => whole(namesArg, argument),
  [METERED]: samelenM,
});
/** All three, to spread into a registry: compile(text, { controls: { ...controls } }). */
export const controls = Object.freeze({ chars, unique, samelen });
