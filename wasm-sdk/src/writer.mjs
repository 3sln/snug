// `snug/writer` for the SDK: the native Writer (the core's JS writer primitives),
// re-exported. The typed-call Writer crosses no boundary per value that
// a tape could batch, so it stays native; encode() is the wasm tape path.
export { Writer } from '../native/writer.mjs';
