import type { DecodeOptions, Value, Reason } from './index.js';
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
  ok: false; reason: Reason; path: (string | number)[]; offset: number; subcode?: Reason;
};
/** quantum defaults to 0 (no scheduling yields); otherwise 1..2^31-1. */
/** failFast (D085) applies to messages of unknown length only. */
export interface SessionOptions { quantum?: number; failFast?: boolean }
/** 'held' (D085, unknown length): a verdict waiting for end(n); an ok:false one is a
 *  certain refusal whose final code may still become cbor/truncated or cbor/too_large. */
export type VmStep = { state: 'need'; offset: number; length: number; keep: number } |
  { state: 'yield'; position: number; keep: number } |
  { state: 'held'; result: ValidationResult } |
  { state: 'done'; result: ValidationResult };
/** Advanced exclusive window session, obtained only from Schema.session(). */
export interface VmSession {
  /** undefined for a session of unknown length (D085). */
  readonly length: number | undefined;
  /** An unknown-length session's input limit: more bytes than this is too_large. */
  readonly limit: number | undefined;
  /** Bytes in exclusive VM arrays, excluding the Program and supplied windows. */
  readonly bytesHeld: number;
  /** In an unknown-length session a window [base, base + length) asserts that those bytes exist. */
  step(window: Uint8Array, base: number): VmStep;
  /** D085: the unknown-length message ended after n bytes; 'yield' means step again from position. */
  end(n: number): VmStep;
}
export type ProgramErrorCode = 'magic' | 'container_version' | 'format_version' |
  'length' | 'version' | 'reserved' | 'digest' | 'verify' | 'too_large' | 'missing_control';
export declare class ProgramError extends Error {
  constructor(code: ProgramErrorCode);
  code: ProgramErrorCode;
}
/** Verified on construction; do not load Programs from untrusted stores. */
export declare class Program {
  constructor(P: Int32Array, B: Uint8Array, options?: ProgramOptions);
  /** Copies, never aliases of the verified storage. */
  readonly P: Int32Array;
  readonly B: Uint8Array;
  readonly sourceKey: string;
  readonly rules: readonly string[];
  /** The extension controls this Program uses, by name (format 1.1). */
  readonly controls: readonly string[];
  serialize(): Uint8Array;
}
export declare class Schema {
  constructor(program: Program);
  readonly program: Program;
  validate(bytes: Uint8Array, rule: string, options?: ValidationOptions): ValidationResult;
  /** length undefined: a message of unknown length (D085 drain mode). */
  session(rule: string, length: number | undefined, options?: ValidationOptions, scheduling?: SessionOptions): VmSession;
  validateAt(bytes: Uint8Array, start: number, end: number, rule: string, options?: SpanOptions): ValidationResult;
  decode(bytes: Uint8Array, rule: string, options?: ValidationOptions): Value;
}
export declare function validate(schema: Schema, bytes: Uint8Array, rule: string, options?: ValidationOptions): ValidationResult;
export declare function validateAt(schema: Schema, bytes: Uint8Array, start: number, end: number, rule: string, options?: SpanOptions): ValidationResult;
export declare function decode(schema: Schema, bytes: Uint8Array, rule: string, options?: ValidationOptions): Value;
export declare function fromProgram(P: Int32Array, B: Uint8Array, options?: ProgramOptions): Promise<Schema>;
export declare function fromSerialized(bytes: Uint8Array, options?: ProgramOptions): Promise<Schema>;
