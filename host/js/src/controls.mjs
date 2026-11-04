// snug/controls: the generic extension controls (D142) as registry entries for
// compile({ controls }) and fromSerialized(bytes, { controls }). Their verdicts
// are kin's (snug.vm.controls), so every host agrees.
//
//   .chars n | lo..hi       a text string of n / lo..hi Unicode code points
//   .unique <anything>      an array whose elements' encodings are pairwise distinct
//   .samelen "a" | [names]  a map whose named members, where present, hold arrays or
//                           typed arrays of one element count
import { charsOk, charsArg, uniqueOk, uniqueWords, anyArg, samelenOk, namesArg }
  from '../../../gen/js/snug/vm/controls.mjs';

let scratch = new Int32Array(64);
const whole = (f, a) => f(a, 0, a.length);

export const chars = Object.freeze({
  check: (argument, item) => charsOk(argument, 0, argument.length, item, 0, item.length),
  argument: argument => whole(charsArg, argument),
});
export const unique = Object.freeze({
  check: (argument, item) => {
    const need = uniqueWords(item.length);
    if (scratch.length < need) scratch = new Int32Array(need);
    const ok = uniqueOk(item, 0, item.length, scratch);
    if (scratch.length > 1 << 20) scratch = new Int32Array(64);
    return ok;
  },
  argument: argument => whole(anyArg, argument),
});
export const samelen = Object.freeze({
  check: (argument, item) => samelenOk(argument, 0, argument.length, item, 0, item.length),
  argument: argument => whole(namesArg, argument),
});
/** All three, to spread into a registry: compile(text, { controls: { ...controls } }). */
export const controls = Object.freeze({ chars, unique, samelen });
