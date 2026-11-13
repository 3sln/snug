// `snug/sequence` over wasm -- CBOR sequences (RFC 8742) with the native package's API and driver (host/js/src/sequence-core.mjs):
// readSequence(source, options) and sequenceReader(options); messages
// { index, offset, length, bytes, borrowed, view }. The backend is one sequence session in
// linear memory (sdk_vs_new with total -2: vms-init-seq; sdk_vs_reseq per message), so the
// verdicts are the generated core's, as natively.
//
// Differences forced by linear memory: a window is copied into the session's
// window buffer. The session gets exactly the native windows (so even fail-fast timing is
// the native one), but the backend keeps its copy of a chunk while the chunk is read:
// a later window inside the copied range steps at an offset in it (sdk_ses_step_at), one
// reaching further appends only the missing tail, and the copy is compacted when most of
// it lies behind the window -- so a chunk of many small messages is copied about once,
// not once per message (a window runs to the end of the chunk or the message limit). Every answer the driver reads
// later (INFO, OUT) is copied out of the shared static areas right after each call,
// because any other SDK call overwrites them. A message's `bytes` stay in JS (borrowed
// from the chunk, or assembled) and its View copies them into linear memory on first
// use (view-core.mjs mintView). The session is freed when the sequence ends, when a
// readSequence loop is left, or by a FinalizationRegistry when a reader is abandoned.
import * as rt from './runtime.mjs';
import { innerOf, limitArgs, Program } from './schema.mjs';
import { rethrow } from '../../js/src/ext.mjs';
import { selectOptions } from '../../js/src/options.mjs';
import { ANY_P, ANY_B } from '../../js/src/any-program.mjs';
import { sequenceApi, sequenceTarget } from '../../js/src/sequence-core.mjs';
import { mintView } from './view-core.mjs';
import { SourceError, pickYield } from './sources.mjs';
import { sessionLimitFault } from './session-limits.mjs';
export { sessionLimits, releasePool } from './session-limits.mjs';

const VMS_HELD = -67, SEQ = -2;
const I32_MAX = 0x7fffffff;
const sessions = new FinalizationRegistry(({ h, gen }) => { if (gen === rt.generation && rt.x) rt.x.sdk_ses_free(h); });
let anyProgram = null;

/** The driver's backend over one wasm sequence session. */
class SequenceSession {
  constructor(inner, rule, opts, quantum) {
    rt.ready();
    let h;
    try { h = rt.x.sdk_vs_new(inner.handle(), rule, SEQ, quantum, ...limitArgs(opts)); } catch (e) { rt.lost(e); }
    rt.refresh();
    if (h === -3) throw sessionLimitFault();
    if (h < 0) throw new Error(`snug wasm: sequence session refused (${h})`);
    this.h = h; this.gen = rt.generation; this.token = {};
    sessions.register(this, { h, gen: this.gen }, this.token);
    this.inner = inner; this.ext = inner.ext; this.quantum = quantum;
    this.total = rt.i32[rt.INFO];              // the provisional end P (maxMessageBytes)
    this.wp = 0; this.wcap = 0;                // the window buffer in linear memory
    this.src = null; this.lo = 0; this.hi = 0; // the JS bytes it holds a copy of: buffer, [lo, hi) in it
    this.info = new Int32Array(6); this.out = null;
  }
  live() { if (this.h < 0 || this.gen !== rt.generation) throw new Error('snug wasm: the sequence session is finished or its instance was reset'); }
  close() { if (this.h >= 0) { if (this.gen === rt.generation && rt.x) rt.x.sdk_ses_free(this.h); sessions.unregister(this.token); this.h = -1; } }
  chunk() { this.src = null; }
  begin() {
    this.live();
    let c;
    try { c = rt.x.sdk_vs_reseq(this.h, this.quantum); } catch (e) { this.h = -1; rt.lost(e); }
    if (c < 0) throw new Error(`snug wasm: vms-init-seq answered ${c}`);
  }
  /** The window buffer, at least n bytes (contents kept): its pointer. */
  room(n) {
    if (n > this.wcap) { this.wcap = Math.max(n, 2 * this.wcap, 256); this.wp = rt.x.sdk_ses_window(this.h, this.wcap) >>> 0; rt.refresh(); }
    return this.wp;
  }
  /** One step over the JS window w (message bytes from base). */
  step(w, base) {
    this.live();
    const n = w.length;
    let off = 0;
    if (n > 0) {
      const s = w.byteOffset, e = s + n;
      if (w.buffer === this.src && s >= this.lo && s <= this.hi) {
        // inside (or continuing) the copy of this chunk / assembly: no byte crosses twice
        if (s - this.lo >= 65536 && s - this.lo >= this.hi - s) {
          const p = this.wp;
          rt.u8.copyWithin(p, p + (s - this.lo), p + (this.hi - this.lo));
          this.lo = s;
        }
        if (e > this.hi) { const p = this.room(e - this.lo); rt.u8.set(w.subarray(this.hi - s), p + (this.hi - this.lo)); this.hi = e; }
        off = s - this.lo;
      } else {
        const p = this.room(n);   // may grow memory: rt.u8 only after it
        rt.u8.set(w, p);
        this.src = w.buffer; this.lo = s; this.hi = e;
      }
    }
    let r;
    try { r = rt.withExt(this.ext ?? null, () => rt.x.sdk_ses_step_at(this.h, off, n, base)); }
    catch (e) { this.h = -1; rt.lost(e); }
    rt.refresh();   // a step may grow memory: re-derive the views first
    rethrow(this.ext);
    this.keep(r);
    return r;
  }
  eof(n) {
    this.live();
    let r;
    try { r = rt.x.sdk_ses_eof(this.h, Math.min(n, I32_MAX)); } catch (e) { this.h = -1; rt.lost(e); }
    rt.refresh();
    this.keep(r);
    return r;
  }
  /** Copy the answer's INFO words (and OUT for a verdict) out of the shared areas. */
  keep(r) {
    const i = rt.i32, at = rt.INFO;
    for (let k = 0; k < 6; k++) this.info[k] = i[at + k];
    if (r >= 0 || r === VMS_HELD) this.out = i.slice(rt.OUT, rt.OUT + 8 + 2 * i[rt.OUT + 6]);
  }
  needOffset() { return this.info[0]; }
  needLength() { return this.info[1]; }
  position() { return this.info[2]; }
  heldCode() { return this.info[4]; }
  messageLength() { return this.info[5]; }
  code() { return this.out[0]; }
  result() { return this.inner.result(this.out, 0); }
}

function openBackend(options, quantum) {
  rt.ready();
  const { program, rule, opts } = sequenceTarget(options,
    s => (s !== null && typeof s === 'object' && s.program ? innerOf(s.program) : undefined),
    () => (anyProgram ??= innerOf(new Program(ANY_P, ANY_B))));
  const backend = new SequenceSession(program, rule, opts, quantum);
  return { backend, viewOpts: { ...selectOptions(options, 'validation'), maxBytes: options.maxMessageBytes, schema: options.schema } };
}

export const { readSequence, sequenceReader } = sequenceApi({ openBackend, mint: mintView, SourceError, nextTurn: pickYield().turn });
