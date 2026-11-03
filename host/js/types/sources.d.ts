import type { DecodeOptions } from './index.js';
export interface Handle {
  readonly size: number;
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
}
export interface SyncHandle extends Handle { read(offset: number, length: number): Uint8Array }
export interface SourceOptions { chunk?: number; quantum?: number }
export type ScanStep = { state: 'need'; offset: number; length: number } |
  { state: 'yield'; position: number } | { state: 'done' };
export type PushStep = { state: 'need' | 'yield' | 'done' };
export interface PushScanner {
  feed(chunk: Uint8Array): PushStep;
  resume(): PushStep;
  finalize(): true;
}
export declare class SourceError extends Error {
  constructor(code: string, message: string);
  code: string;
}
/** Profile-only scanner; raw step callers supply exactly the requested window. */
export declare class ScanSession {
  constructor(length: number, options?: DecodeOptions, scheduling?: { quantum?: number });
  readonly length: number;
  done: boolean;
  step(window: Uint8Array, base: number): ScanStep;
}
/** Returns undefined on success; throws SnugFault on a CBOR refusal. */
export declare function scanBuffer(bytes: Uint8Array, options?: DecodeOptions): void;
export declare function scanHandle(handle: Handle, options?: DecodeOptions, sourceOptions?: SourceOptions): Promise<true>;
export declare function scanHandleSync(handle: SyncHandle, options?: DecodeOptions, sourceOptions?: SourceOptions): true;
export declare function bufferHandle(bytes: Uint8Array): SyncHandle;
export declare function asyncHandle(bytes: Uint8Array, options?: { delay?: number }): Handle;
export declare function pushScanner(length: number, options?: DecodeOptions, scheduling?: { quantum?: number }): PushScanner;
