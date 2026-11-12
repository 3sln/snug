// @3sln/snug-wasm/inline: the root with both modules inlined (P9.17).
export * from './index.js';
/** Compile and instantiate the inlined runtime and compiler modules synchronously. A second call does nothing. */
export declare function initSync(): void;
/** Compile and instantiate the inlined runtime and compiler modules. A second call does nothing. */
export declare function init(): Promise<void>;
