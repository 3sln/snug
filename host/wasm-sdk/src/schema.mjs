// P7.9: `snug/schema` over wasm. A Program lives in linear memory (copied in
// and checked by vm-verify there); the JS object keeps its own copy of P and B
// for the public accessors, serialisation and path rendering (program.md
// §9.3), and reloads itself into a fresh instance after instance loss.
// validate copies the input into the reusable input buffer and makes one call;
// the out words are read in place.
//
// Since P7.9 (D170-D173): limits word 9 carries the profile flags (D120); a
// format 1.1 Program binds its extension controls at load exactly as the native
// host does (ext.mjs: a missing one is ProgramError('missing_control')), the
// generic controls run inside wasm and any other predicate is asked through the
// module's one import (runtime.mjs withExt); options go through the native
// validator (D150). Sessions are opened by `openSession` in sources.mjs (D160).
import * as rt from './runtime.mjs';
import { build } from '../../js/src/build.mjs';
import { parseSerialized, serializeProgram, ProgramError } from '../../js/src/serialized.mjs';
import { validationFault } from '../../js/src/public-errors.mjs';
import { SNUG_VERSION } from '../../js/src/version.mjs';
import { validateOptions } from '../../js/src/options.mjs';
import { profileFlags } from '../../js/src/profiles.mjs';
import { controlEntries, bindControls, programControls, rethrow } from '../../js/src/ext.mjs';
import { controls as generic } from '../../js/src/controls.mjs';

export { ProgramError };
const REASONS = { 32: 'type', 33: 'missing', 34: 'unexpected', 35: 'value', 36: 'size', 37: 'range',
  38: 'pattern', 39: 'tag', 40: 'bits', 41: 'embedded', 42: 'control', 43: 'control_size', 44: 'group_limit', 48: 'budget' };
const reasonName = code => (code >= 1 && code <= 21 ? 'cbor/' + rt.codeName(code) : REASONS[code] ?? 'unknown');
const lim = v => (v === undefined || v === null ? -1 : Math.max(0, Math.min(Number(v), 0x7fffffff)) | 0);
const internals = new WeakMap(), versions = new WeakMap();
const td = new TextDecoder('utf-8', { fatal: true }), te = new TextEncoder();
const isShared = b => typeof SharedArrayBuffer === 'function' && b.buffer instanceof SharedArrayBuffer;
// The generic controls (snug/controls) run inside wasm, recognised by their check function (D171).
const GENERIC = new Map([[generic.chars.check, 1], [generic.unique.check, 2], [generic.samelen.check, 3]]);

/** limits words 0..7 as the wasm exports take them, then the profile flags (word 9). */
export function limitArgs(opts) {
  return [opts.top === 'map' ? 0 : 1, opts.cose ? 1 : 0, lim(opts.maxBytes), lim(opts.maxDepth), lim(opts.maxEntries),
    lim(opts.maxItems), lim(opts.maxBignumBytes), lim(opts.budget), profileFlags(opts)];
}

// Programs are freed in wasm when their JS object is collected.
const programs = new FinalizationRegistry(({ h, gen }) => { if (gen === rt.generation && rt.x) rt.x.sdk_prog_free(h); });

class Inner {
  constructor(P, B, entries) {
    this.P = Int32Array.from(P); this.B = Uint8Array.from(B);
    this.h = -1; this.gen = -1; this.rules = new Map();
    this.load();
    // D141: a Program naming extension controls runs only with their predicates
    this.ext = bindControls(this.P, this.B, entries);
    if (this.ext) {
      const byName = new Map(entries.map(e => [e.name, e]));
      this.kinds = Int32Array.from(this.ext.names, n => GENERIC.get(byName.get(n).check) ?? 0);
      this.bind();
    } else this.kinds = null;
  }
  load() {
    rt.ready();
    const { P, B } = this, x = rt.x;
    const pp = x.sdk_alloc(P.byteLength) >>> 0, bp = x.sdk_alloc(B.length) >>> 0;
    rt.refresh();
    rt.i32.set(P, pp >>> 2); rt.u8.set(B, bp);
    const h = x.sdk_prog_load(pp, P.length, bp, B.length);
    x.sdk_free(pp, P.byteLength); x.sdk_free(bp, B.length);
    rt.refresh();
    if (h < 0) throw new ProgramError('verify');
    this.h = h; this.gen = rt.generation; this.rules.clear();
    programs.register(this, { h, gen: this.gen });
    if (this.kinds) this.bind();
  }
  bind() {
    const k = this.kinds, x = rt.x, p = x.sdk_alloc(4 * k.length) >>> 0;
    rt.refresh(); rt.i32.set(k, p >>> 2);
    x.sdk_prog_bind(this.h, p, k.length);
    x.sdk_free(p, 4 * k.length);
  }
  handle() { if (this.gen !== rt.generation) this.load(); return this.h; }
  ruleIndex(name) {
    let i = this.rules.get(name);
    if (i === undefined) {
      const b = te.encode(name), h = this.handle(), p = rt.kbuf(b.length);
      rt.u8.set(b, p);
      i = rt.x.sdk_rule_index(h, b.length);
      this.rules.set(name, i);
    }
    return i;
  }
  keyName(id) {
    const off = this.P[this.P[46] + 2 * id], len = this.P[this.P[46] + 2 * id + 1];
    const b = this.B.subarray(off, off + len), ib = b[0], major = ib >> 5, ai = ib & 31;
    let arg = ai, h = 1;
    if (ai === 24) { arg = b[1]; h = 2; } else if (ai === 25) { arg = (b[1] << 8) | b[2]; h = 3; }
    else if (ai === 26) { arg = ((b[1] << 24) >>> 0) + (b[2] << 16) + (b[3] << 8) + b[4]; h = 5; }
    else if (ai === 27) { let v = 0n; for (let i = 1; i < 9; i++) v = (v << 8n) | BigInt(b[i]); arg = Number(v); h = 9; }
    if (major === 3) return td.decode(b.subarray(h, h + arg));
    return major === 0 ? arg : -1 - arg;
  }
  /** The out words at OUT (or at `at` in `o`: a copy a sequence session kept) rendered as
   *  Schema.validate's result. */
  result(o = rt.i32, at = rt.OUT) {
    const code = o[at];
    if (code === 0) return { ok: true };
    const path = [];
    for (let i = 0; i < o[at + 6]; i++) {
      const kind = o[at + 8 + 2 * i], v = o[at + 9 + 2 * i];
      if (kind === 0) path.push(v);
      else if (kind === 1) path.push(this.keyName(v));
      else if (kind === 2) path.push('*');
      else if (kind === 3) path.push('#tag');
      else if (kind === 4) path.push('cbor');
      else { path.push('cbor'); path.push(v); }
    }
    const r = { ok: false, reason: reasonName(code), path, offset: o[at + 2] };
    if (code === 41) r.subcode = reasonName(o[at + 1]);
    return r;
  }
  /** Validate [ptr, ptr+n) already in linear memory (views open on their own copy). */
  runAt(rule, ptr, n, opts, span) {
    const h = this.handle(), x = rt.x;
    let c;
    if (span || this.ext !== null) {
      const l = limitArgs(opts);
      c = rt.withExt(this.ext, () => (span
        ? x.sdk_validate_span(h, rule, ptr, n, span.start, span.end, span.depth ?? 0, span.items ?? 0, ...l)
        : x.sdk_validate(h, rule, ptr, n, ...l)));
    } else {
      // the hot path: no array, no closure
      c = x.sdk_validate(h, rule, ptr, n, opts.top === 'map' ? 0 : 1, opts.cose ? 1 : 0, lim(opts.maxBytes), lim(opts.maxDepth),
        lim(opts.maxEntries), lim(opts.maxItems), lim(opts.maxBignumBytes), lim(opts.budget), profileFlags(opts));
    }
    rt.refresh();
    rethrow(this.ext);
    if (c < 0) throw new Error(`snug wasm: vm-validate answered ${c}`);
    return this.result();
  }
  run(rule, bytes, opts, span) {
    try { return this.runAt(rule, rt.input(bytes), bytes.length, opts, span); }
    catch (e) { rt.lost(e); }
  }
}

export class Program {
  constructor(P, B, options = {}) {
    validateOptions(options, 'program');
    const controls = controlEntries(options.controls);
    if (!(P instanceof Int32Array) || !(B instanceof Uint8Array))
      throw new TypeError('snug: Program needs Int32Array words and Uint8Array pool');
    if (isShared(P) || isShared(B)) throw new TypeError('snug: copy SharedArrayBuffer input first');
    if (P.byteLength + B.length > 64 * 1024 * 1024) throw new ProgramError('too_large');
    if (P.length < 64) throw new ProgramError('verify');
    internals.set(this, new Inner(P, B, controls)); versions.set(this, SNUG_VERSION);
    Object.freeze(this);
  }
  get P() { return internals.get(this).P.slice(); }
  get B() { return internals.get(this).B.slice(); }
  get sourceKey() {
    return Array.from(internals.get(this).P.subarray(7, 15), w => (w >>> 0).toString(16).padStart(8, '0')).join('');
  }
  get rules() {
    const { P, B } = internals.get(this), names = [], d = new TextDecoder();
    for (let i = 0; i < P[15]; i++) { const at = P[42] + 5 * i; names.push(d.decode(B.subarray(P[at], P[at] + P[at + 1]))); }
    return Object.freeze(names);
  }
  /** The extension controls this Program uses (D141), by name. */
  get controls() { const { P, B } = internals.get(this); return Object.freeze(programControls(P, B)); }
  serialize() { const { P, B } = internals.get(this); return serializeProgram(P, B, versions.get(this)); }
}
export const innerOf = program => internals.get(program);

function bytesInput(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('snug: bytes must be a Uint8Array');
  if (isShared(bytes)) throw new TypeError('snug: copy SharedArrayBuffer input first');
}

export class Schema {
  #inner;
  constructor(program) {
    if (!internals.has(program)) throw new TypeError('snug: Schema needs a verified Program');
    this.program = program; this.#inner = internals.get(program);
    Object.freeze(this);
  }
  #rule(rule) {
    if (typeof rule !== 'string') throw new TypeError('snug: rule must be a string');
    const i = this.#inner.ruleIndex(rule);
    if (i < 0) throw new TypeError('snug: unknown rule');
    return i;
  }
  validate(bytes, rule, options = {}) {
    bytesInput(bytes);
    const r = this.#rule(rule);
    validateOptions(options, 'validation');
    return this.#inner.run(r, bytes, options);
  }
  validateAt(bytes, start, end, rule, options = {}) {
    bytesInput(bytes);
    const r = this.#rule(rule);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > bytes.length)
      throw new TypeError('snug: invalid span');
    validateOptions(options, 'span');
    return this.#inner.run(r, bytes, { top: 'any', ...options }, { start, end, depth: options.depth ?? 0, items: options.items ?? 0 });
  }
  decode(bytes, rule, options = {}) {
    bytesInput(bytes);
    const ri = this.#rule(rule);
    validateOptions(options, 'validation');
    const r = this.#inner.run(ri, bytes, options);
    if (!r.ok) throw validationFault(r);
    // P8.4 (D262): built from the canonical copy the VM validated when the input is not its own deterministic form
    return build(rt.lastCopy().bytes ?? bytes, options);
  }
  /** Internal (views, sessions): the rule index, checked. */
  ruleIndex(rule) { return this.#rule(rule); }
}

export const validate = (schema, bytes, rule, options) => schema.validate(bytes, rule, options);
export const validateAt = (schema, bytes, start, end, rule, options) => schema.validateAt(bytes, start, end, rule, options);
export const decode = (schema, bytes, rule, options) => schema.decode(bytes, rule, options);
export async function fromProgram(P, B, options = {}) { return new Schema(new Program(P, B, options)); }
export async function fromSerialized(bytes, options = {}) { return fromSerializedSync(bytes, options); }
/** Synchronous fromSerialized (the SDK needs no lazy import; Workers can call it at module scope). */
export function fromSerializedSync(bytes, options = {}) {
  validateOptions(options, 'program');
  const { P, B, version } = parseSerialized(bytes);
  const program = new Program(P, B, options);
  versions.set(program, version);
  return new Schema(program);
}
