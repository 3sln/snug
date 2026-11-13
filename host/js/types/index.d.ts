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
/** A map with only text keys decodes to an object; a map with any other key (or a top-level map under cose) to a
 * Map whose keys are decoded values (D123). `undefined` and Tagged arise only under profiles that admit them. */
export type Value = null | undefined | boolean | number | bigint | string | Uint8Array | TypedArray |
  Decimal | NDArray | Float16Bytes | Tagged | Simple | Value[] | { [key: string]: Value } | Map<Value, Value>;
/** Finite non-negative safe integers. Zero is a real bound; malformed/unknown options throw TypeError. */
export interface Limits {
  maxBytes?: number;
  maxDepth?: number;
  maxEntries?: number;
  maxItems?: number;
}
/** Wire profile options (D120): `wire` picks a preset, any other option overrides it. (`profile` is the compiler's
 * separate restriction set.) 'valid' (the default, D260) accepts any valid RFC 8949 CBOR; 'deterministic' also
 * requires RFC 8949 §4.2.1 core deterministic encoding; 'bindle' restricts further. */
export interface ProfileOptions {
  /** Default 'valid'. */
  wire?: 'valid' | 'deterministic' | 'bindle';
  /** Map key kinds: text only, text and integers (major 0/1), or any item. valid/deterministic: 'any'; bindle: 'text'. */
  keys?: 'text' | 'integer' | 'any';
  /** The Bindle tag set; the standard set adding 0, 1, 21-24, 32, 55799; or any tag number (D180), the known tags
   * keeping their content rules. valid/deterministic: 'any'. */
  tags?: 'bindle' | 'standard' | 'any';
  /** Bindle refuses NaN, ±∞, −0 and safe-range integral floats; 'deterministic' (the value under both the valid
   *  and deterministic presets) is RFC 8949: any NaN under valid, canonical NaN f97e00 under deterministic. */
  floats?: 'bindle' | 'deterministic';
  /** The simple values other than false/true/null: undefined (f7) and the unassigned ones (Simple, D284).
   * valid/deterministic: true; bindle: false. */
  undefinedValue?: boolean;
  /** Unicode noncharacters in text. valid/deterministic: true; bindle: false. */
  noncharacters?: boolean;
}
export interface DecodeOptions extends Limits, ProfileOptions {
  /** Accepted for preset spreading; ignored while reading/checking. */
  strictArrays?: boolean;
  /** Codec, view and profile-source default: the preset's ('any' for valid/deterministic, 'map' for bindle). Schema default: 'any'. */
  top?: 'map' | 'any';
  /** Under keys 'text': safe integer labels in the top-level map; materialises that map as Map. */
  cose?: boolean;
  objects?: 'null' | 'plain';
}
export interface EncodeOptions extends Limits, ProfileOptions {
  /** Accepted for preset spreading; encoding permits any supported root. */
  top?: 'map' | 'any';
  /** Accepted for codec round trips; ignored while writing. */
  objects?: 'null' | 'plain';
  cose?: boolean;
  omitUndefined?: boolean;
  /** Default: the preset's (valid/deterministic false: ignore extra array own properties; bindle true: the strict own-key
   * count check). Holes are refused in both modes. */
  strictArrays?: boolean;
}
export type ProfileCode = 'truncated' | 'non_shortest' | 'indefinite' | 'malformed' |
  'key_type' | 'key_order' | 'duplicate_key' | 'text' | 'float' | 'simple' | 'tag' |
  'bignum' | 'decimal' | 'typed_array' | 'ndarray' | 'trailing' | 'depth' |
  'too_many_entries' | 'too_many_items' | 'too_large' | 'not_map';
export type SchemaReason = 'type' | 'missing' | 'unexpected' | 'value' | 'size' |
  'range' | 'pattern' | 'tag' | 'bits' | 'embedded' | 'control' | 'control_size' | 'group_limit' | 'budget';
export type Reason = SchemaReason | `cbor/${ProfileCode}`;
/** A refusal's subcode: an `embedded` refusal's own reason, `cut` on a `value` a cut decided (D342), or (encode, on
 * `duplicate_key`) `normalized`: two keys are one key once a non-preferred bignum is written as its integer (D348). */
export type Subcode = Reason | 'cut' | 'normalized';
export type FaultCode = ProfileCode | 'unsupported' | 'grammar' | 'writer_failed' | `schema/${SchemaReason}` | 'sessions/limit';
export declare class SnugFault extends Error {
  constructor(code?: string, message?: string);
  code: string;
  reason?: Reason;
  path?: (string | number)[];
  offset?: number;
  subcode?: Subcode;
}
export declare const LIMITS: Readonly<{
  maxBytes: 1500000; maxDepth: 32; maxEntries: 65536; maxItems: 131072;
  maxBignumBytes: 128; minDecimalExponent: -1024; maxDimensions: 8;
}>;
/** The three presets spelled out as frozen option objects (D120, D260). */
export declare const profiles: Readonly<{
  valid: Readonly<{ wire: 'valid'; top: 'any'; cose: false; keys: 'any'; tags: 'any';
    floats: 'deterministic'; undefinedValue: true; noncharacters: true; strictArrays: false }>;
  deterministic: Readonly<{ wire: 'deterministic'; top: 'any'; cose: false; keys: 'any'; tags: 'any';
    floats: 'deterministic'; undefinedValue: true; noncharacters: true; strictArrays: false }>;
  bindle: Readonly<{ wire: 'bindle'; top: 'map'; cose: false; keys: 'text'; tags: 'bindle'; floats: 'bindle';
    undefinedValue: false; noncharacters: false; strictArrays: true }>;
}>;
export declare function decode(bytes: Uint8Array, options?: DecodeOptions): Value;
/** maxBytes bounds output acceptance at finish when supplied, not peak allocation. Unknown/malformed options throw TypeError. */
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
/** A standard-set tag (D121): 0, 1, 21, 22, 23, 24 (value: the payload bytes), 32 or 55799. Frozen. */
export declare class Tagged {
  /** tag: 0..2^64-1, a bigint beyond 2^53 - 1 (normalised to a number within it). A tag 2/3 Tagged
   * holding a Uint8Array is a bignum outside preferred serialization (what decode gives one, D342). */
  constructor(tag: number | bigint, value: Value);
  readonly tag: number | bigint;
  readonly value: Value;
}
/** A simple value other than false/true/null/undefined (D284): value 0..19 or 32..255 (else SnugFault code simple).
 * Interned: one frozen instance per value, so === and Map keys compare by value. */
export declare class Simple {
  constructor(value: number);
  readonly value: number;
  toString(): string;
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
