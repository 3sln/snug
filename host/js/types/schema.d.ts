import type { DecodeOptions, Value, Reason, Subcode } from './index.js';
import type { Controls } from './controls.js';
/** Loading a Program that uses extension controls needs their registry (D141). */
export interface ProgramOptions { controls?: Controls }
/** Invalid/unknown options throw TypeError, never a ValidationResult. Limits only lower compiled caps. */
export interface ValidationOptions extends DecodeOptions {
  maxBignumBytes?: number;
  budget?: number;
}
/** depth/items are non-negative safe integers, default 0. */
export interface SpanOptions extends ValidationOptions { depth?: number; items?: number }
export type ValidationResult = { ok: true } | {
  ok: false; reason: Reason; path: (string | number)[]; offset: number;
  /** `embedded`: the embedded item's own reason. `value`: `'cut'` when a key matched a cut member (`name:` or
   * `^=>`) whose value failed and the cut stopped the alternatives after it (D342). */
  subcode?: Subcode;
};
/** A compile warning (never a refusal): its stable code (`W1`..`W8`), the rule it is in (null for a schema-wide
 * one), its 1-based line and column (0 when about no place) and a fixed message. */
export interface CompileWarning {
  readonly code: string; readonly rule: string | null; readonly line: number; readonly column: number;
  readonly message: string;
}
export type ProgramErrorCode = 'magic' | 'container_version' | 'format_version' |
  'length' | 'version' | 'reserved' | 'digest' | 'verify' | 'too_large' | 'missing_control';
export declare class ProgramError extends Error {
  constructor(code: ProgramErrorCode);
  code: ProgramErrorCode;
}
/** Verified on construction; do not load Programs from untrusted stores. Not structured-cloneable: `postMessage` and
 * `structuredClone` throw DataCloneError (send `serialize()` bytes and load them with `fromSerialized`). */
export declare class Program {
  constructor(P: Int32Array, B: Uint8Array, options?: ProgramOptions);
  /** The clone brand (P9.16): a Symbol, so a structured clone throws instead of silently losing the methods. */
  readonly brand: symbol;
  /** Copies, never aliases of the verified storage. */
  readonly P: Int32Array;
  readonly B: Uint8Array;
  readonly sourceKey: string;
  readonly rules: readonly string[];
  /** The extension controls this Program uses, by name (empty when it uses none). */
  readonly controls: readonly string[];
  serialize(): Uint8Array;
}
/** Not structured-cloneable, as Program. */
export declare class Schema {
  constructor(program: Program);
  /** The clone brand (P9.16), as Program's. */
  readonly brand: symbol;
  readonly program: Program;
  /** The compile warnings, frozen, in a deterministic order (W8: a choice of map groups the RFC cut makes fail);
   * empty for a Schema not made by `compile`. */
  readonly warnings: readonly CompileWarning[];
  validate(bytes: Uint8Array, rule: string, options?: ValidationOptions): ValidationResult;
  validateAt(bytes: Uint8Array, start: number, end: number, rule: string, options?: SpanOptions): ValidationResult;
  decode(bytes: Uint8Array, rule: string, options?: ValidationOptions): Value;
}
export declare function validate(schema: Schema, bytes: Uint8Array, rule: string, options?: ValidationOptions): ValidationResult;
export declare function validateAt(schema: Schema, bytes: Uint8Array, start: number, end: number, rule: string, options?: SpanOptions): ValidationResult;
export declare function decode(schema: Schema, bytes: Uint8Array, rule: string, options?: ValidationOptions): Value;
export declare function fromProgram(P: Int32Array, B: Uint8Array, options?: ProgramOptions): Promise<Schema>;
export declare function fromSerialized(bytes: Uint8Array, options?: ProgramOptions): Promise<Schema>;
