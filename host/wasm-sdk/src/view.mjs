// P7.9 / P7.13w: `snug/view` over wasm -- the public entry. The implementation and its
// internal capabilities (mintView for the sequence reader, directoryWords) live in
// view-core.mjs, which no package entry exports (D215; review 2026-11-04 #3).
export { view, View, Cursor } from './view-core.mjs';
