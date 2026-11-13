// The public SchemaError class, in a module of its own so that a host that
// compiles elsewhere (the wasm SDK) can throw it without a static or
// dynamic edge to the generated compiler (public-compile.mjs has the lazy one).
/** A stable public class without eagerly importing the generated compiler. */
export class SchemaError extends Error {
  constructor(code, line = 0, column = 0, rule) {
    super(`CDDL schema refused: ${code}` + (line > 0 ? ` at ${line}:${column}` : ''));
    this.name = 'SchemaError'; this.code = code; this.line = line; this.column = column; this.rule = rule;
  }
}
