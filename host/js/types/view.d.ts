import type { Value, TypedArray, Float16Bytes, Decimal, NDArray } from './index.js';
import type { Schema, ValidationOptions, ValidationResult } from './schema.js';
export type Kind = 'int' | 'float' | 'bytes' | 'text' | 'bool' | 'null' |
  'array' | 'map' | 'decimal' | 'ndarray' | 'typed';
export interface ViewOptions extends ValidationOptions {
  schema?: Schema; rule?: string; borrow?: boolean;
  /** Experimental, opt-in per-container offset directories (D053). */
  directories?: boolean;
}
export declare function view(bytes: Uint8Array, options?: ViewOptions): View;
export declare class View {
  private constructor();
  readonly kind: Kind;
  readonly length: number | undefined;
  readonly offset: number;
  readonly depth: number;
  readonly borrowed: boolean;
  get(key: string | number | bigint): View | undefined;
  at(index: number): View | undefined;
  entries(): IterableIterator<[string | number | bigint, View]>;
  keys(): IterableIterator<string | number | bigint>;
  values(): IterableIterator<View>;
  number(): number;
  bigint(): bigint;
  int(): number | bigint;
  text(): string;
  bool(): boolean;
  isNull(): boolean;
  /** Read-only aliases by contract; JS cannot enforce that contract. */
  bytes(): Uint8Array;
  raw(): Uint8Array;
  copyBytes(): Uint8Array;
  typedView(): Readonly<{ tag: number; length: number; get(index: number): number | bigint }>;
  typed(): TypedArray | Float16Bytes;
  decimal(): Decimal;
  ndarray(): NDArray;
  value(): Value;
  cursor(): Cursor;
  validateAt(rule: string, options?: { schema?: Schema }): ValidationResult;
}
export declare class Cursor {
  constructor(view: View);
  readonly depth: number;
  readonly offset: number;
  readonly kind: Kind;
  readonly length: number | undefined;
  readonly key: string | number | bigint | undefined;
  keyIs(key: string): boolean;
  enter(): boolean;
  next(): boolean;
  up(): boolean;
  find(key: string | number | bigint): boolean;
  number(): number;
  bigint(): bigint;
  int(): number | bigint;
  text(): string;
  bool(): boolean;
  isNull(): boolean;
  view(): View;
  value(): Value;
}
