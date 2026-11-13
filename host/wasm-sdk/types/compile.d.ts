// @3sln/snug-wasm/compile: the native declarations plus the compiler module's controls.
import './view.js'; // View.release()
import type { WasmSource } from './index.js';
export * from '../../js/types/compile.js';
/** Where the compiler module comes from (default: wasm/snug-compiler.wasm next to the SDK, or what
 *  init({ compiler }) was given). It is compiled on the next compile(). */
export declare function compilerSource(source: WasmSource | undefined): void;
/** Drop the compiler instance and its linear memory; the next compile() starts a fresh one. */
export declare function releaseCompiler(): void;
/** The compiler instance's linear memory size in bytes (0 when there is none). */
export declare function compilerMemoryBytes(): number;
