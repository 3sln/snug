import type { DecodeOptions } from './index.js';
import type { Schema, ValidationOptions, ValidationResult } from './schema.js';
/** quantum defaults to 0 (no scheduling yields); otherwise 1..2^31-1. */
/** failFast (D085) applies to messages of unknown length only. */
export interface SessionOptions { quantum?: number; failFast?: boolean }
/** 'held' (D085, unknown length): a verdict waiting for end(n); an ok:false one is a
 *  certain refusal whose final code may still become cbor/truncated or cbor/too_large. */
export type VmStep = { state: 'need'; offset: number; length: number; keep: number } |
  { state: 'yield'; position: number; keep: number } |
  { state: 'held'; result: ValidationResult } |
  { state: 'done'; result: ValidationResult };
/** Advanced exclusive window session, obtained only from openSession(). */
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
  /** P9.7: release the session's arrays and its live-session slot now (a finished session has
   *  released them already); step/end then throw TypeError. */
  close(): void;
  [Symbol.dispose](): void;
}
/** P9.7: the isolate's session policy. Every session (openSession, handles, push sources,
 *  streams, a sequence reader) counts as live until it finishes, errors or is closed; an
 *  abandoned one holds its slot until it is garbage-collected. Creating one more than
 *  maxLive throws SnugFault 'sessions/limit'. Idle arrays up to maxPooledBytes are kept
 *  for reuse (zero-filled first). Defaults: maxLive 1024, maxPooledBytes 2 MiB. */
export interface SessionLimits { maxLive: number; maxPooledBytes: number }
export declare function sessionLimits(set?: Partial<SessionLimits>): SessionLimits & { live: number; pooledBytes: number };
/** P9.7: drop every idle pooled array now (a long-lived process trimming memory). */
export declare function releasePool(): void;
/** length undefined: a message of unknown length (D085 drain mode).
 *  Synchronous; replaces Schema.session (D160). */
export declare function openSession(schema: Schema, rule: string, length: number | undefined, options?: ValidationOptions, scheduling?: SessionOptions): VmSession;
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
  /** P9.7: abandon the message, releasing its session now. */
  close(): void;
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
  /** P9.7: abandon the message, releasing its session now. */
  close(): void;
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
