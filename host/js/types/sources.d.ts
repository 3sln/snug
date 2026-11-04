import type { DecodeOptions } from './index.js';
import type { Schema, ValidationOptions, ValidationResult, SessionOptions } from './schema.js';
/** Immutable snapshot: size and every range stay fixed for the operation. */
export interface Handle {
  readonly size: number;
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
}
export interface SyncHandle extends Handle { read(offset: number, length: number): Uint8Array }
/** chunk is a positive safe integer, default 65536. Unknown/malformed options throw/reject TypeError. */
export interface SourceOptions extends SessionOptions { chunk?: number }
export type ScanStep = { state: 'need'; offset: number; length: number } |
  { state: 'yield'; position: number } | { state: 'done' };
export type PushStep = { state: 'need' | 'yield' | 'done' };
export interface PushScanner {
  feed(chunk: Uint8Array): PushStep;
  resume(): PushStep;
  finalize(): true;
}
export type PushValidationStep = { state: 'need' | 'yield' } |
  { state: 'done'; result: ValidationResult };
export interface PushValidator {
  feed(chunk: Uint8Array): PushValidationStep;
  resume(): PushValidationStep;
  /** Required even after done; checks that the declared length was delivered. */
  finalize(): ValidationResult;
}
export declare class SourceError extends Error {
  constructor(code: string, message: string);
  code: string;
}
/** Profile-only scanner; raw step callers supply exactly the requested window. */
export declare class ScanSession {
  constructor(length: number, options?: DecodeOptions, scheduling?: SessionOptions);
  readonly length: number;
  done: boolean;
  step(window: Uint8Array, base: number): ScanStep;
}
/** Returns undefined on success; throws SnugFault on a CBOR refusal. */
export declare function scanBuffer(bytes: Uint8Array, options?: DecodeOptions): void;
export declare function scanHandle(handle: Handle, options?: DecodeOptions, sourceOptions?: SourceOptions): Promise<true>;
export declare function scanHandleSync(handle: SyncHandle, options?: DecodeOptions, sourceOptions?: SourceOptions): true;
/** Owns a copy, including Node Buffers; each read returns an independent copy. SharedArrayBuffer is refused. */
export declare function bufferHandle(bytes: Uint8Array): SyncHandle;
/** Owns a copy as bufferHandle does. delay: non-negative safe integer milliseconds, default 0 (microtask). */
export declare function asyncHandle(bytes: Uint8Array, options?: { delay?: number }): Handle;
export declare function pushScanner(length: number, options?: DecodeOptions, scheduling?: SessionOptions): PushScanner;
/** CBOR/CDDL refusals are results; source protocol failures throw/reject. */
export declare function validateHandle(schema: Schema, handle: Handle, rule: string, options?: ValidationOptions, sourceOptions?: SourceOptions): Promise<ValidationResult>;
export declare function validateHandleSync(schema: Schema, handle: SyncHandle, rule: string, options?: ValidationOptions, sourceOptions?: SourceOptions): ValidationResult;
export declare function pushValidator(schema: Schema, length: number, rule: string, options?: ValidationOptions, scheduling?: SessionOptions): PushValidator;
