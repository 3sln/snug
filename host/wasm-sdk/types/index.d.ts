// @3sln/snug-wasm: the native package's root declarations (the same API, D172)
// plus the wasm instance's own functions (P9.17). In the package, '../../js/types/'
// reads './native/' (host/wasm-sdk/package-build.mjs).
export * from '../../js/types/index.js';

/** Where a wasm module comes from. A string with a scheme is a URL; any other string is a file path in Node and a
 *  page-relative URL elsewhere. A Response (or a promise of one) served as application/wasm is compiled streaming. */
export type WasmSource = WebAssembly.Module | ArrayBuffer | ArrayBufferView | Response | PromiseLike<Response> | URL | string;
/** The two modules: `runtime` (validate, decode, views, sessions) and `compiler` (used by compile()). */
export interface InitOptions { runtime?: WasmSource; compiler?: WasmSource }
/** Compile and instantiate the runtime module (default: wasm/snug.wasm next to the SDK). A no-op once initialised
 *  when called without an argument; with one, a fresh instance from that source replaces the current one. */
export declare function init(source?: WasmSource | InitOptions): Promise<void>;
/** Synchronous init from a WebAssembly.Module or bytes only. Hosts may refuse a synchronous compile from bytes
 *  (see docs/wasm-sdk.md); a WebAssembly.Module is always accepted. */
export declare function initSync(source: WebAssembly.Module | ArrayBuffer | ArrayBufferView |
  { runtime?: WebAssembly.Module | ArrayBuffer | ArrayBufferView; compiler?: WebAssembly.Module | ArrayBuffer | ArrayBufferView }): void;
/** Drop the instance and its linear memory and start a fresh one. Programs reload lazily; open views and
 *  sessions become unusable. */
export declare function reset(): void;
/** Release the reusable input and key buffers (linear memory itself never shrinks). */
export declare function trim(): void;
/** The runtime instance's linear memory size in bytes. */
export declare function memoryBytes(): number;
/** The instance trapped (memory beyond 4 GiB, or engine stack exhaustion) and was replaced; no verdict was reached. */
export declare class InstanceLost extends Error {
  constructor(cause: unknown);
  cause: unknown;
}
