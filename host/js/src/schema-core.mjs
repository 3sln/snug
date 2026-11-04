// snug's buffer core (SPEC §1): validate CBOR bytes against a Program's rule,
// decode after validating. Everything that decides accept or
// refuse is kin (gen/js/snug/vm, gen/js/snug/compile); this module owns the
// Program objects, the per-isolate scratch lease (architecture §8, §17.1:
// synchronous validation holds one shared scratch for the duration of a call)
// and the rendering of results (reason names, paths rendered from the
// Program's key table only, §9.3).
import { vmScratchWords, vmScratchInit, vmRuleIndex, vmValidate, vmValidateSpan, vmValidateX, vmValidateSpanX } from '../../../gen/js/snug/vm/api.mjs';
import { bindControls, rethrow } from './ext.mjs';
import { codeName } from '../../../gen/js/snug/cbor/scan.mjs';
import { build } from './build.mjs';
import { profileFlags } from './profiles.mjs';
import { validateOptions } from './options.mjs';
import { schemaPrograms } from './schema-state.mjs';

const REASONS = { 32: 'type', 33: 'missing', 34: 'unexpected', 35: 'value', 36: 'size', 37: 'range',
  38: 'pattern', 39: 'tag', 40: 'bits', 41: 'embedded', 42: 'control', 43: 'control_size', 48: 'budget' };
export function reasonName(code) {
  if (code >= 1 && code <= 21) return 'cbor/' + codeName(code);
  return REASONS[code] ?? 'unknown';
}

// ---------------------------------------------------------------- the scratch lease
// One Int32Array per isolate, shared by every Program, grown lazily (program.md
// §13.1). The lease flag refuses re-entry from an extension predicate rather
// than allowing it to corrupt the shared scratch.
let scratch = new Int32Array(0), markCap = 0, leased = false;
const out = new Int32Array(8 + 2 * 257);
function lease(P, rule) {
  if (leased) throw new Error('snug: scratch already leased (re-entrant validation)');
  const cap = Math.max(markCap, P[16]);
  const need = vmScratchWords(P, rule, cap);
  if (cap > markCap || need > scratch.length) {
    scratch = new Int32Array(Math.max(need, scratch.length));
    markCap = cap;
    vmScratchInit(scratch, cap);
  }
  leased = true;
  return scratch;
}
/** Release the shared scratch (it is re-grown on the next call). */
export function releaseScratch() { if (!leased) { scratch = new Int32Array(0); markCap = 0; } }

// limits words 0..7 (program.md §12.3), word 8 the VM's generic/schedule bits (0: defaults), word 9 the profile
// flags (D120). The schema default root is 'any' under every profile.
export const limitWords = (opts = {}) => Int32Array.of(
  opts.top === 'map' ? 0 : 1, opts.cose ? 1 : 0, lim(opts.maxBytes), lim(opts.maxDepth), lim(opts.maxEntries),
  lim(opts.maxItems), lim(opts.maxBignumBytes), lim(opts.budget), 0, profileFlags(opts));
function lim(v) { return v === undefined ? -1 : Math.min(v, 0x7fffffff); }

// ---------------------------------------------------------------- Programs
const td = new TextDecoder('utf-8', { fatal: true });
/** A Program (P: Int32Array, B: Uint8Array) the host trusts (architecture §5.2). */
export class Program {
  constructor(P, B, { verify, controls } = {}) {
    // copy on load: P and B stay private after verification (program.md §11)
    this.P = Int32Array.from(P); this.B = Uint8Array.from(B);
    if (verify) {
      // the verifier's scratch: epoch and marks (program.md §11, §12.1); a
      // corrupt Program's words never size more than 2^20 marks
      const m = Math.min(Math.max(0, this.P[16] | 0), 1 << 20);
      const S = new Int32Array(64 + 2 * m);
      S[16] = 1; S[17] = m;
      const r = verify(this.P, this.B, S);
      if (r !== 0) throw new Error(`snug: Program refused by vm-verify (word ${S[35]}, check ${S[36]})`);
    }
    // D141: a Program naming extension controls runs only with their predicates
    this.ext = bindControls(this.P, this.B, controls ?? []);
    this.rules = new Map();
  }
  ruleIndex(name) {
    let i = this.rules.get(name);
    if (i === undefined) { i = vmRuleIndex(this.P, this.B, new TextEncoder().encode(name)); this.rules.set(name, i); }
    return i;
  }
  keyName(id) {
    // a key from KEYS, rendered from the Program only (§9.3)
    const off = this.P[this.P[46] + 2 * id], len = this.P[this.P[46] + 2 * id + 1];
    const b = this.B.subarray(off, off + len), ib = b[0], major = ib >> 5, ai = ib & 31;
    let arg = ai, h = 1;
    if (ai === 24) { arg = b[1]; h = 2; } else if (ai === 25) { arg = (b[1] << 8) | b[2]; h = 3; }
    else if (ai === 26) { arg = ((b[1] << 24) >>> 0) + (b[2] << 16) + (b[3] << 8) + b[4]; h = 5; }
    else if (ai === 27) { let v = 0n; for (let i = 1; i < 9; i++) v = (v << 8n) | BigInt(b[i]); arg = Number(v); h = 9; }
    if (major === 3) return td.decode(b.subarray(h, h + arg));
    return major === 0 ? arg : -1 - arg;
  }
  /** Low level: run the VM; answers the out words (code first) as a fresh array. */
  run(rule, bytes, opts, span) {
    const S = lease(this.P, rule), x = this.ext;
    let o;
    try {
      const c = x
        ? (span
          ? vmValidateSpanX(this.P, this.B, rule, bytes, span.start, span.end, span.depth ?? 0, span.items ?? 0, limitWords(opts), S, out, x.call)
          : vmValidateX(this.P, this.B, rule, bytes, limitWords(opts), S, out, x.call))
        : (span
          ? vmValidateSpan(this.P, this.B, rule, bytes, span.start, span.end, span.depth ?? 0, span.items ?? 0, limitWords(opts), S, out)
          : vmValidate(this.P, this.B, rule, bytes, limitWords(opts), S, out));
      if (c < 0 && !(x && x.failure)) throw new Error(`snug: vm-validate answered ${c}`);
      o = out.slice(0, 8 + 2 * out[6]);
    } finally { leased = false; }
    rethrow(x);
    return o;
  }
  result(o) {
    if (o[0] === 0) return { ok: true };
    const path = [];
    for (let i = 0; i < o[6]; i++) {
      const kind = o[8 + 2 * i], v = o[9 + 2 * i];
      if (kind === 0) path.push(v);
      else if (kind === 1) path.push(this.keyName(v));
      else if (kind === 2) path.push('*');
      else if (kind === 3) path.push('#tag');
      else if (kind === 4) path.push('cbor');
      else { path.push('cbor'); path.push(v); }
    }
    const r = { ok: false, reason: reasonName(o[0]), path, offset: o[2] };
    if (o[0] === 41) r.subcode = reasonName(o[1]);
    return r;
  }
}

function asBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('snug: bytes must be a Uint8Array');
  return bytes;
}

/** A compiled schema: validate / decode against its rules. */
export class Schema {
  constructor(program) { this.program = program; schemaPrograms.set(this, program); }
  rule(name) {
    const i = this.program.ruleIndex(name);
    if (i < 0) throw new Error(`snug: no rule ${JSON.stringify(name)}`);
    return i;
  }
  /** validate(bytes, rule, opts) -> {ok: true} | {ok: false, reason, path, offset[, subcode]} */
  validate(bytes, rule, opts = {}) {
    validateOptions(opts, 'validation');
    return this.program.result(this.program.run(this.rule(rule), asBytes(bytes), opts));
  }
  /** validateAt(bytes, start, end, rule, opts): the span as its own document (§16.3). */
  validateAt(bytes, start, end, rule, opts = {}) {
    validateOptions(opts, 'span');
    return this.program.result(this.program.run(this.rule(rule), asBytes(bytes), { top: 'any', ...opts },
      { start, end, depth: opts.depth ?? 0, items: opts.items ?? 0 }));
  }
  /** decode(bytes, rule, opts): validate, then the trusted builder (D017). */
  decode(bytes, rule, opts = {}) {
    validateOptions(opts, 'validation');
    asBytes(bytes);
    if (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)
      throw new TypeError('snug: SharedArrayBuffer input is refused (architecture §8)');
    const r = this.validate(bytes, rule, opts);
    if (!r.ok) { const e = new Error(`snug: ${r.reason}`); e.reason = r.reason; e.path = r.path; e.offset = r.offset; if (r.subcode) e.subcode = r.subcode; throw e; }
    return build(bytes, opts);
  }
}

