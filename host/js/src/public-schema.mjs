// Buffer/Program package facade; all session construction lives in snug/sources.
import { Program as HostProgram, Schema as HostSchema } from './schema-core.mjs';
import { vmVerify, vmVerifyWords } from '../../../gen/js/snug/program/verify.mjs';
import { parseSerialized, serializeProgram, ProgramError } from './serialized.mjs';
import { validationFault } from './public-errors.mjs';
import { SNUG_VERSION } from './version.mjs';
import { controlEntries, programControls } from './ext.mjs';
import { validateOptions } from './options.mjs';
import { schemaPrograms } from './schema-state.mjs';

export { ProgramError };
const internals = new WeakMap(), versions = new WeakMap();

/** Verified, owned Program. Array accessors return copies (D102). */
export class Program {
  constructor(P, B, options = {}) {
    validateOptions(options, 'program');
    // D141: a Program using extension controls needs the same registry to load
    const controls = controlEntries(options.controls);
    if (!(P instanceof Int32Array) || !(B instanceof Uint8Array))
      throw new TypeError('snug: Program needs Int32Array words and Uint8Array pool');
    if ((typeof SharedArrayBuffer === 'function') &&
        (P.buffer instanceof SharedArrayBuffer || B.buffer instanceof SharedArrayBuffer))
      throw new TypeError('snug: copy SharedArrayBuffer input first');
    if (P.byteLength + B.length > 64 * 1024 * 1024) throw new ProgramError('too_large');
    let inner;
    try { inner = new HostProgram(P, B, { verify: vmVerify, verifyWords: vmVerifyWords, controls }); }
    catch (e) { if (e instanceof ProgramError) throw e; throw new ProgramError('verify'); }
    internals.set(this, inner); versions.set(this, SNUG_VERSION);
    Object.freeze(this);
  }
  get P() { return internals.get(this).P.slice(); }
  get B() { return internals.get(this).B.slice(); }
  get sourceKey() {
    return Array.from(internals.get(this).P.subarray(7, 15), w => (w >>> 0).toString(16).padStart(8, '0')).join('');
  }
  get rules() {
    const { P, B } = internals.get(this), names = [], td = new TextDecoder();
    for (let i = 0; i < P[15]; i++) {
      const at = P[42] + 5 * i;
      names.push(td.decode(B.subarray(P[at], P[at] + P[at + 1])));
    }
    return Object.freeze(names);
  }
  /** The extension controls this Program uses (D141), by name. */
  get controls() {
    const { P, B } = internals.get(this);
    return Object.freeze(programControls(P, B));
  }
  serialize() {
    const { P, B } = internals.get(this);
    return serializeProgram(P, B, versions.get(this));
  }
}

function bytesInput(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('snug: bytes must be a Uint8Array');
  if (typeof SharedArrayBuffer === 'function' && bytes.buffer instanceof SharedArrayBuffer)
    throw new TypeError('snug: copy SharedArrayBuffer input first');
}

export class Schema {
  #host;
  constructor(program) {
    if (!internals.has(program)) throw new TypeError('snug: Schema needs a verified Program');
    this.program = program;
    this.#host = new HostSchema(internals.get(program));
    schemaPrograms.set(this, internals.get(program));
    Object.freeze(this);
  }
  #rule(rule) {
    if (typeof rule !== 'string') throw new TypeError('snug: rule must be a string');
    if (internals.get(this.program).ruleIndex(rule) < 0) throw new TypeError('snug: unknown rule');
  }
  validate(bytes, rule, options = {}) {
    bytesInput(bytes); this.#rule(rule);
    return this.#host.validate(bytes, rule, options);
  }
  validateAt(bytes, start, end, rule, options = {}) {
    bytesInput(bytes); this.#rule(rule);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > bytes.length)
      throw new TypeError('snug: invalid span');
    return this.#host.validateAt(bytes, start, end, rule, options);
  }
  decode(bytes, rule, options = {}) {
    bytesInput(bytes); this.#rule(rule);
    try { return this.#host.decode(bytes, rule, options); }
    catch (error) { if (error.reason) throw validationFault(error); throw error; }
  }
}

export const validate = (schema, bytes, rule, options) => schema.validate(bytes, rule, options);
export const validateAt = (schema, bytes, start, end, rule, options) => schema.validateAt(bytes, start, end, rule, options);
export const decode = (schema, bytes, rule, options) => schema.decode(bytes, rule, options);
export async function fromProgram(P, B, options = {}) { return new Schema(new Program(P, B, options)); }
export async function fromSerialized(bytes, options = {}) {
  validateOptions(options, 'program');
  const { P, B, version } = parseSerialized(bytes);
  const program = new Program(P, B, options);
  versions.set(program, version);
  return new Schema(program);
}
