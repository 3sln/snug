import type { EncodeOptions, Limits, TypedArray, Float16Bytes, Decimal, NDArray } from './index.js';
/** Grouped limits override top-level limits; both are checked. maxBytes bounds finish-time acceptance, not peak allocation.
 * Unknown keys/malformed values throw TypeError at construction, before any value is written. */
export interface WriterOptions extends EncodeOptions { keysSorted?: boolean; limits?: Limits }
export declare class Writer {
  constructor(options?: WriterOptions);
  readonly failure: string;
  /** encode's array policy, including strictArrays, applies to all nested values. */
  value(value: unknown): this;
  uint(value: number | bigint): this;
  int(value: number | bigint): this;
  bigint(value: bigint): this;
  float(value: number): this;
  bool(value: boolean): this;
  null(): this;
  /** f7; needs the profile's undefinedValue. */
  undefined(): this;
  /** A standard-set tag and its content: value(new Tagged(tag, content)). */
  tagged(tag: number | bigint, content: unknown): this;
  text(value: string): this;
  bytes(value: Uint8Array): this;
  typed(value: TypedArray | Float16Bytes): this;
  decimal(value: Decimal): this;
  ndarray(value: NDArray): this;
  beginArray(count: number): this;
  beginMap(count: number): this;
  /** A string; an integer with keys 'integer' / 'any' (or a cose label under keys 'text'); any value with keys 'any'. */
  key(key: unknown): this;
  end(): this;
  finish(): Uint8Array;
}
