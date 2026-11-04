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
  /** finalize() (the end of an unknown-length message). */
  end?(): true;
}
export type PushValidationStep = { state: 'need' | 'yield' } |
  { state: 'done'; result: ValidationResult };
export interface PushValidator {
  feed(chunk: Uint8Array): PushValidationStep;
  resume(): PushValidationStep;
  /** Required even after done; checks that the declared length was delivered. For an
   *  unknown length (D085) it is the end of the message: every pending check settles. */
  finalize(): ValidationResult;
  /** finalize(), for an unknown-length message. */
  end?(): ValidationResult;
  /** Unknown length: bytes held now (at most what the session asks for, plus a chunk). */
  readonly bytesHeld?: number;
}
/** A message of unknown length, read once in order until it ends (D085). */
export type StreamInput = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
export declare function streamSource(input: StreamInput): AsyncIterable<Uint8Array>;
/** Drain mode: Schema.validate's result for the same bytes; failFast answers a certain
 *  refusal at once (accept/refuse equal, code may differ). Only the bytes the session
 *  asks for are held; a held verdict's remaining bytes are counted and dropped. */
export declare function validateStream(schema: Schema, source: StreamInput, rule: string, options?: ValidationOptions, scheduling?: SessionOptions): Promise<ValidationResult>;
/** Profile check of a message of unknown length: true, or rejects with SnugFault / SourceError. */
export declare function scanStream(source: StreamInput, options?: DecodeOptions, scheduling?: SessionOptions): Promise<true>;
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
/** length undefined: a message of unknown length (D085). */
export declare function pushScanner(length: number | undefined, options?: DecodeOptions, scheduling?: SessionOptions): PushScanner;
/** CBOR/CDDL refusals are results; source protocol failures throw/reject. */
export declare function validateHandle(schema: Schema, handle: Handle, rule: string, options?: ValidationOptions, sourceOptions?: SourceOptions): Promise<ValidationResult>;
export declare function validateHandleSync(schema: Schema, handle: SyncHandle, rule: string, options?: ValidationOptions, sourceOptions?: SourceOptions): ValidationResult;
/** length undefined: a message of unknown length (D085 drain mode; failFast optional). */
export declare function pushValidator(schema: Schema, length: number | undefined, rule: string, options?: ValidationOptions, scheduling?: SessionOptions): PushValidator;
