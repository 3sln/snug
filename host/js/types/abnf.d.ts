import type { Control } from './controls.js';
/**
 * RFC 9165 §3's `.abnf` and `.abnfb` (D334), an optional module: spread `abnf` into the
 * `controls` registry of `compile` and of a Program's loader (`fromSerialized`,
 * `new Program`). Without it, a schema using them is refused (`unsupported_control`)
 * and a stored Program using them fails to load (`missing_control`).
 *
 * The controller is ABNF (RFC 5234, RFC 7405): one element, the start, then optionally
 * a newline and rules (core rules are not imported). It is checked at compile time
 * (prose-val, syntax, undefined rules: `control_value`). The match is language
 * membership over the string's Unicode scalars (`.abnf`) or bytes (`.abnfb`), metered
 * against the validation budget. The item bound is 65,536 bytes unless overridden:
 * `{ ...abnf, abnf: { ...abnf.abnf, maxBytes: n } }`.
 */
export declare const abnf: Readonly<{ abnf: Control; abnfb: Control }>;
/** The two controls with other bounds: `maxBytes` (the item bound, default 65,536) and
 *  `maxWords` (the matcher's scratch cap in 32-bit words: default 4,194,304 = 16 MiB,
 *  the PEG group arena's default; 65,536..16,777,216, else TypeError). A match needing
 *  more scratch stops validation with `budget`. */
export declare function abnfWith(options?: { maxBytes?: number; maxWords?: number }): Readonly<{ abnf: Control; abnfb: Control }>;
/** A controller on its own (ABNF text, or the CBOR encoding of a text or byte string):
 *  true, or why the compiler would refuse it (with its ABNF line and column). */
export declare function checkAbnf(text: string | Uint8Array, options?: { abnf?: 'strict' | 'lenient' }): true | string;
