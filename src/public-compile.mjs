// Importing snug/compile does not load the compiler; the first call does.
import { validateCompileOptions } from './options.mjs';
import { SchemaError } from './schema-error.mjs';

export { SchemaError };

export async function compile(text, options = {}) {
  validateCompileOptions(options);
  const compiler = await import('./compile-runtime.mjs');
  let compiled;
  try { compiled = compiler.compile(text, options); }
  catch (e) {
    if (e instanceof compiler.SchemaError) {
      const error = new SchemaError(e.code, e.line, e.column, e.rule);
      error.message = e.message;
      throw error;
    }
    throw e;
  }
  return compiler.schemaOf(compiled, options.controls);
}
