import type { Value, TypedArray, Float16Bytes, Decimal, NDArray } from './index.js';
import type { Schema, ValidationOptions, ValidationResult } from './schema.js';
export type Kind = 'int' | 'float' | 'bytes' | 'text' | 'bool' | 'null' | 'undefined' |
  'array' | 'map' | 'decimal' | 'ndarray' | 'typed' | 'tagged';
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
  /** Any key the view's profile admits; non-text, non-integer keys compare by their encoding (keys 'any'). */
  get(key: unknown): View | undefined;
  at(index: number): View | undefined;
  entries(): IterableIterator<[Value, View]>;
  keys(): IterableIterator<Value>;
  values(): IterableIterator<View>;
  number(): number;
  bigint(): bigint;
  int(): number | bigint;
  text(): string;
  bool(): boolean;
  isNull(): boolean;
  isUndefined(): boolean;
  /** A tagged item's tag number, else undefined. */
  readonly tag: number | undefined;
  /** A View of a tagged item's content. */
  content(): View;
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
  readonly key: Value;
  keyIs(key: string): boolean;
  enter(): boolean;
  next(): boolean;
  up(): boolean;
  find(key: unknown): boolean;
  number(): number;
  bigint(): bigint;
  int(): number | bigint;
  text(): string;
  bool(): boolean;
  isNull(): boolean;
  view(): View;
  value(): Value;
}
