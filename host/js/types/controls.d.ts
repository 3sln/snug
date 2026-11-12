/**
 * An extension control (D082, D140-D142): `target .name argument` in CDDL, decided by a
 * predicate over the encoded argument and the item's whole encoding. It must be pure
 * (no I/O, clock, state or call back into snug); only a strict `true` matches. It is
 * asked only for an item its leaf is queried for, after the profile checks. Each call costs
 * 17 budget units plus `cost(itemBytes)` (default: one unit per item byte), charged before it runs.
 * An item longer than `maxBytes` (default 65,536) fails
 * with the reason `control_size` without asking, whatever the source.
 */
export type Control = ((argument: Uint8Array, item: Uint8Array) => boolean) | {
  check(argument: Uint8Array, item: Uint8Array): boolean;
  maxBytes?: number;
  /** Checked once per use at compile time; anything but `true` refuses the schema
   *  (`control_value`), and a string answer is the refusal's detail. */
  argument?(argument: Uint8Array): boolean | string;
  /** Budget units charged before each call, beyond the fixed 17: a non-negative safe integer.
   *  Default: `itemBytes`. */
  cost?(itemBytes: number): number;
};
/** Names: identifiers ([A-Za-z_][A-Za-z0-9_-]*, at most 64 bytes), not built-in controls. */
export type Controls = Record<string, Control>;
/** `.chars n` / `.chars lo..hi`: a text string of that many Unicode code points. */
export declare const chars: Control;
/** `.unique <any>`: an array whose elements' encodings are pairwise distinct. */
export declare const unique: Control;
/** `.samelen "a"` / `.samelen ["a", "b"]`: the named members of a map, where present,
 *  hold arrays or typed arrays of one element count. */
export declare const samelen: Control;
/** All three: `compile(text, { controls })`, or spread them into a larger registry. */
export declare const controls: Readonly<{ chars: Control; unique: Control; samelen: Control }>;
