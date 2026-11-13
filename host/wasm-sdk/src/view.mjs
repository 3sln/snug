// `snug/view` over wasm -- the public entry. The implementation and its
// internal capabilities (mintView for the sequence reader, directoryWords) live in
// view-core.mjs, which no package entry exports.
export { view, View, Cursor } from './view-core.mjs';
