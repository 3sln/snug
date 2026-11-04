// Internal compatibility entry for buffer schemas and async compiler/loaders.
// Public facades use schema-core directly, keeping these lazy edges out of their graph.
import { Program, Schema } from './schema-core.mjs';
export { Program, Schema, reasonName, releaseScratch } from './schema-core.mjs';

/** compile(text, {profile, limits}) -> Schema, via the compiler's host entry
 * (host/js/src/compile.mjs; throws its SchemaError). The Program is verified
 * by vm-verify before use. */
export async function compile(text, opts = {}) {
  const [{ compile: compileCddl }, { vmVerify }] = await Promise.all([
    import('./compile.mjs'), import('../../../gen/js/snug/program/verify.mjs')]);
  const { program, pool, controls } = compileCddl(text, opts);
  return new Schema(new Program(program, pool, { verify: vmVerify, controls }));
}

/** fromProgram(P, B) -> Schema, for a Program compiled elsewhere (a trusted store). */
export async function fromProgram(P, B, { controls } = {}) {
  const [{ vmVerify }, { controlEntries }] = await Promise.all([
    import('../../../gen/js/snug/program/verify.mjs'), import('./ext.mjs')]);
  return new Schema(new Program(P, B, { verify: vmVerify, controls: controlEntries(controls) }));
}
