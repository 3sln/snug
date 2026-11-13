// Private bridge between the buffer facade and source sessions (D160).
// No session imports or factories; package exports block direct access.
export const schemaPrograms = new WeakMap();
// P9.16: a compiled Schema's warnings, set by compile (snug/compile) once, read by `schema.warnings`.
export const schemaWarnings = new WeakMap();
// P9.16: an own enumerable Symbol makes structuredClone / postMessage throw DataCloneError
// instead of silently cloning a Schema or Program into a plain object without methods.
export function brand(target, what) {
  Object.defineProperty(target, 'brand', { value: Symbol(`snug.${what} cannot be cloned or posted: send program.serialize() bytes`), enumerable: true });
}
