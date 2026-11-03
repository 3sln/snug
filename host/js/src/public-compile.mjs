// Importing snug/compile does not load the compiler; the first call does.
import { Program, Schema } from './public-schema.mjs';

/** A stable public class without eagerly importing the generated compiler. */
export class SchemaError extends Error {
  constructor(code, line = 0, column = 0, rule) {
    super(`CDDL schema refused: ${code}` + (line > 0 ? ` at ${line}:${column}` : ''));
    this.name = 'SchemaError'; this.code = code; this.line = line; this.column = column; this.rule = rule;
  }
}
export async function compile(text, options = {}) {
  const compiler = await import('./compile.mjs');
  let compiled;
  try { compiled = compiler.compile(text, options); }
  catch (e) {
    if (e instanceof compiler.SchemaError) throw new SchemaError(e.code, e.line, e.column, e.rule);
    throw e;
  }
  return new Schema(new Program(compiled.program, compiled.pool));
}
