export type TypedArray = Int8Array | Uint16Array | Uint32Array | BigUint64Array |
  Int16Array | Int32Array | BigInt64Array | Float32Array | Float64Array | Float16ArrayLike;
/** Structural spelling for runtimes with native Float16Array (no TS lib dependency). */
export interface Float16ArrayLike {
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly length: number;
  readonly [index: number]: number;
}
export type Value = null | boolean | number | bigint | string | Uint8Array | TypedArray |
  Decimal | NDArray | Float16Bytes | Value[] | { [key: string]: Value } | Map<string | number, Value>;
export interface Limits {
  maxBytes?: number;
  maxDepth?: number;
  maxEntries?: number;
  maxItems?: number;
}
export interface DecodeOptions extends Limits {
  /** Codec default: 'map'. Schema default: 'any'. */
  top?: 'map' | 'any';
  /** Safe integer labels in the top-level map; materialises that map as Map. */
  cose?: boolean;
  objects?: 'null' | 'plain';
}
export interface EncodeOptions extends Limits {
  cose?: boolean;
  omitUndefined?: boolean;
}
export type ProfileCode = 'truncated' | 'non_shortest' | 'indefinite' | 'malformed' |
  'key_type' | 'key_order' | 'duplicate_key' | 'text' | 'float' | 'simple' | 'tag' |
  'bignum' | 'decimal' | 'typed_array' | 'ndarray' | 'trailing' | 'depth' |
  'too_many_entries' | 'too_many_items' | 'too_large' | 'not_map';
export type SchemaReason = 'type' | 'missing' | 'unexpected' | 'value' | 'size' |
  'range' | 'pattern' | 'tag' | 'bits' | 'embedded' | 'budget';
export type Reason = SchemaReason | `cbor/${ProfileCode}`;
export type FaultCode = ProfileCode | 'unsupported' | 'grammar' | 'writer_failed' | `schema/${SchemaReason}`;
export declare class SnugFault extends Error {
  constructor(code?: string, message?: string);
  code: string;
  reason?: Reason;
  path?: (string | number)[];
  offset?: number;
  subcode?: Reason;
}
export declare const LIMITS: Readonly<{
  maxBytes: 1500000; maxDepth: 32; maxEntries: 65536; maxItems: 131072;
  maxBignumBytes: 128; minDecimalExponent: -1024; maxDimensions: 8;
}>;
/** D081's general deterministic preset is planned, and is not exported yet. */
export declare const profiles: Readonly<{ bindle: Readonly<{ top: 'map'; cose: false }> }>;
export declare function decode(bytes: Uint8Array, options?: DecodeOptions): Value;
/** maxBytes is enforced at finish only when explicitly supplied. */
export declare function encode(value: unknown, options?: EncodeOptions): Uint8Array;
export declare class Decimal {
  constructor(mantissa: bigint, exponent: number);
  readonly mantissa: bigint;
  readonly exponent: number;
  static from(text: string): Decimal | number | bigint;
  static normalize(mantissa: bigint, exponent: number): Decimal | number | bigint;
  toString(): string;
  valueOf(): never;
  [Symbol.toPrimitive](hint: string): string;
  toJSON(): never;
}
export declare class Float16Bytes {
  constructor(bytes: Uint8Array);
  readonly bytes: Uint8Array;
  readonly length: number;
}
export declare class NDArray {
  constructor(shape: number[], data: Value[] | TypedArray | Float16Bytes);
  readonly shape: readonly number[];
  readonly data: Value[] | TypedArray | Float16Bytes;
}
