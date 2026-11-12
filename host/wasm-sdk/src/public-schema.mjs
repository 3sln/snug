// `@3sln/snug-wasm/schema` (P9.17): the native surface plus fromSerializedSync
// (a Worker can load a stored Program at module scope). schema.mjs also exports
// internals (innerOf, limitArgs) that are not part of the package.
export { Program, ProgramError, Schema, validate, validateAt, decode, fromProgram, fromSerialized,
  fromSerializedSync } from './schema.mjs';
