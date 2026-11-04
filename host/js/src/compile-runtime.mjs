// Keep the async compiler's facade chunk limited to the classes it needs.
// Re-exports preserve the public constructors' identity and synchronous methods.
export { Program, Schema } from './public-schema.mjs';
export { compile, SchemaError } from './compile.mjs';
