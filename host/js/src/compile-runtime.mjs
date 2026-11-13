// Keep the async compiler's facade chunk limited to the classes it needs.
// Re-exports preserve the public constructors' identity and synchronous methods.
import { schemaWarnings } from './schema-state.mjs';
import { Program, Schema } from './public-schema.mjs';
export { Program, Schema };
export { compile, SchemaError } from './compile.mjs';

/** The Schema of a compile result, its warnings as `schema.warnings` (frozen, P9.16). Here, not in snug/compile's
 *  static facade, so importing snug/compile stays small. */
export function schemaOf(compiled, controls) {
  const schema = new Schema(new Program(compiled.program, compiled.pool, controls === undefined ? {} : { controls }));
  schemaWarnings.set(schema, Object.freeze(compiled.warnings.map(w => Object.freeze({ ...w }))));
  return schema;
}
