import type { DecodeOptions, Value, Reason } from './index.js';
export interface ValidationOptions extends DecodeOptions {
  maxBignumBytes?: number;
  budget?: number;
}
export interface SpanOptions extends ValidationOptions { depth?: number; items?: number }
export type ValidationResult = { ok: true } | {
  ok: false; reason: Reason; path: (string | number)[]; offset: number; subcode?: Reason;
};
export type ProgramErrorCode = 'magic' | 'container_version' | 'format_version' |
  'length' | 'version' | 'reserved' | 'digest' | 'verify' | 'too_large';
export declare class ProgramError extends Error {
  constructor(code: ProgramErrorCode);
  code: ProgramErrorCode;
}
/** Verified on construction; do not load Programs from untrusted stores. */
export declare class Program {
  constructor(P: Int32Array, B: Uint8Array);
  /** Copies, never aliases of the verified storage. */
  readonly P: Int32Array;
  readonly B: Uint8Array;
  readonly sourceKey: string;
  readonly rules: readonly string[];
  serialize(): Uint8Array;
}
export declare class Schema {
  constructor(program: Program);
  readonly program: Program;
  validate(bytes: Uint8Array, rule: string, options?: ValidationOptions): ValidationResult;
  validateAt(bytes: Uint8Array, start: number, end: number, rule: string, options?: SpanOptions): ValidationResult;
  decode(bytes: Uint8Array, rule: string, options?: ValidationOptions): Value;
}
export declare function validate(schema: Schema, bytes: Uint8Array, rule: string, options?: ValidationOptions): ValidationResult;
export declare function validateAt(schema: Schema, bytes: Uint8Array, start: number, end: number, rule: string, options?: SpanOptions): ValidationResult;
export declare function decode(schema: Schema, bytes: Uint8Array, rule: string, options?: ValidationOptions): Value;
export declare function fromProgram(P: Int32Array, B: Uint8Array): Promise<Schema>;
export declare function fromSerialized(bytes: Uint8Array): Promise<Schema>;
