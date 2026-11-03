import type { EncodeOptions, Limits, TypedArray, Float16Bytes, Decimal, NDArray } from './index.js';
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
  text(value: string): this;
  bytes(value: Uint8Array): this;
  typed(value: TypedArray | Float16Bytes): this;
  decimal(value: Decimal): this;
  ndarray(value: NDArray): this;
  beginArray(count: number): this;
  beginMap(count: number): this;
  key(key: string | number): this;
  end(): this;
  finish(): Uint8Array;
}
