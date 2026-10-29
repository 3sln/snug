import {readFileSync} from 'node:fs';
import * as glue from './pkg/bindle_cddl_study.js';
export const WASM_PATH=new URL('./pkg/bindle_cddl_study_bg.wasm',import.meta.url);
export const wasmBytes=readFileSync(WASM_PATH);
let module;
export function instantiate(){module??=new WebAssembly.Module(wasmBytes);glue.initSync({module});return glue;}
// After a trap the instance must be discarded: wasm-bindgen glue keeps module-level state, so re-init a fresh instance.
export function reinstantiate(){glue.__reset(module);return glue;}
export {glue};
