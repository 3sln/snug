// Session-only host state. Keep the kin window/EOF protocol unchanged (D144–D147).
import { vmScratchWords, vmScratchInit } from '../../../gen/js/snug/vm/api.mjs';
import { vmsWords, vmsArena, vmsInit, vmsStepV, vmsNeedOffset, vmsNeedLength, vmsPosition, vmsKeep,
  vmsInitUnknown, vmsUnknownTotal, vmsEof, vmsGrowWords, vmsGrowBytes, vmsGrowScratch, vmsGrowArena } from '../../../gen/js/snug/vm/session.mjs';
import { rethrow } from './ext.mjs';
import { limitWords } from './schema-core.mjs';

// ---------------------------------------------------------------- sessions
const VMS_NEED = -64, VMS_YIELD = -65, VMS_HELD = -67, VMS_RESUME = -68, VMS_GROW = -69;
const noExt = () => -2;

// ---------------------------------------------------------------- the valid machinery's buffers (D286)
// vs (the scanner's options and scratch) and cb (the canonical buffer) are step-local: nothing in them outlives
// one vms-step-v call (kept keys live in the session's arena, a copy's events are copied into S). One pair per
// isolate, grown on VMS_GROW and kept, serves every session and sequence step, as the buffer driver's lease
// does (schema-core.mjs): a fresh session no longer regrows them from 512 words / 1 KiB, rerunning a whole
// item's scanner pass and copy on every growth. A step re-entered from an extension predicate takes fresh ones.
let lease = null;
/** Run step(v) with the isolate's valid buffers v = {vs, cb} (fresh ones when re-entered), grown by growValid. */
export function withValidBuffers(step) {
  const v = lease ?? { vs: new Int32Array(512), cb: new Uint8Array(1024) };
  lease = null;
  try { return step(v); } finally { lease = v; }
}
/** After VMS_GROW: v's buffers grown to what the session array ss asks for. */
export function growValid(v, ss) {
  const w = vmsGrowWords(ss), nb = vmsGrowBytes(ss);
  if (w > v.vs.length) v.vs = new Int32Array(Math.max(w, 2 * v.vs.length));
  if (nb > v.cb.length) v.cb = new Uint8Array(Math.max(nb, 2 * v.cb.length));
}

/** One resumable validation (P6.2, D027): the kin session over windows of a message of
 *  a declared length. It owns its scratch, session array and key arena from start to
 *  verdict (§17.1 W9: interleaved async sessions never share state); the Program is
 *  shared. step(window, base) answers {state: 'need', offset, length, keep},
 *  {state: 'yield', position, keep} or {state: 'done', result} (result as
 *  Schema.validate's). `keep`: no byte before it will be asked for again. */
export class VmSession {
  constructor(program, rule, length, opts = {}, quantum = 0) {
    // D085: no length (undefined) is an unknown-length session (drain mode)
    const unknown = length === undefined;
    if (!unknown && (!Number.isSafeInteger(length) || length < 0 || length > 0x7fffffff)) throw new TypeError('snug: length must be an integer in 0..2^31-1');
    if (!Number.isSafeInteger(quantum) || quantum < 0 || quantum > 0x7fffffff) throw new TypeError('snug: quantum must be a non-negative integer');
    if (!Number.isInteger(rule) || rule < 0 || rule >= program.P[15]) throw new TypeError('snug: rule index out of range');
    const { P, B } = program;
    this.program = program; this.length = length;
    const limits = limitWords(opts), cap = Math.max(P[16], 1);
    // D286 A3: S as large as earlier sessions on this Program needed (a session's arena starts at the lease, D324,
    // so the room past it holds a canonical item's events)
    this.s = new Int32Array(Math.max(vmScratchWords(P, rule, cap), program.sw || 0)); vmScratchInit(this.s, cap);
    this.ss = new Int32Array(vmsWords(P));
    this.out = new Int32Array(8 + 2 * 257);
    let c;
    if (unknown) {
      // the key arena of an unknown-length session is sized for the input limit
      this.limit = vmsUnknownTotal(P, limits);
      this.ka = new Uint8Array(vmsArena(P, limits, this.limit));
      c = vmsInitUnknown(P, B, rule, limits, this.s, this.ss, this.ka, quantum);
    } else {
      this.ka = new Uint8Array(vmsArena(P, limits, length));
      c = vmsInit(P, B, rule, limits, this.s, this.ss, this.ka, length, quantum);
    }
    if (c < 0) throw new Error(`snug: vms-init answered ${c}`);
    this.busy = false; this.verdict = null;
  }
  /** D085, an unknown-length session: the message ended after `n` bytes (or passed the
   *  input limit `limit`: any n above it). Answers {state: 'done', result}, or
   *  {state: 'yield', position, keep} when the walk must go on over the bytes from
   *  `position` to n (step again; it never asks past n). */
  end(n) {
    if (this.verdict) return this.verdict;
    if (this.length !== undefined) throw new TypeError('snug: end() is for a session of unknown length');
    if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('snug: end(n) takes the byte count');
    const r = vmsEof(this.ss, this.out, Math.min(n, 0x7fffffff));
    if (r === VMS_RESUME) return { state: 'yield', position: vmsPosition(this.ss), keep: vmsKeep(this.ss) };
    if (r < 0) throw new Error(`snug: vms-eof answered ${r}`);
    this.verdict = { state: 'done', result: this.program.result(this.out.slice(0, 8 + 2 * this.out[6])) };
    return this.verdict;
  }
  /** Bytes this session holds beyond the Program (its exclusive arrays). */
  get bytesHeld() { return 4 * (this.s.length + this.ss.length + this.out.length) + this.ka.length; }
  step(window, base) {
    if (this.verdict) return this.verdict;
    if (this.dead) throw this.dead;
    if (this.busy) throw new Error('snug: a session cannot be resumed concurrently');
    if (!(window instanceof Uint8Array)) throw new TypeError('snug: a window is a Uint8Array');
    this.busy = true;
    let r;
    const x = this.program.ext;
    try {
      r = withValidBuffers(v => {
        for (;;) {
          const c = vmsStepV(this.program.P, this.program.B, window, this.s, this.ss, this.ka, this.out, base, x ? x.call : noExt, v.vs, v.cb);
          if (c !== VMS_GROW) return c;
          growValid(v, this.ss);
          const sw = vmsGrowScratch(this.ss), aw = vmsGrowArena(this.ss);
          // D286 A3: the Program remembers S for later sessions (this S started at least that large), at most
          // 2^18 words: one huge item does not pre-grow every later session
          if (sw > this.s.length) { const g = new Int32Array(sw); g.set(this.s); this.s = g; if (sw < 262144) this.program.sw = sw; }
          if (aw > this.ka.length) { const g = new Uint8Array(aw); g.set(this.ka); this.ka = g; }
        }
      });
    } finally { this.busy = false; }
    // a predicate that threw voids the session (its walk went on with a false verdict)
    try { rethrow(x); } catch (e) { this.dead = e; throw e; }
    if (r === VMS_NEED) return { state: 'need', offset: vmsNeedOffset(this.ss), length: vmsNeedLength(this.ss), keep: vmsKeep(this.ss) };
    if (r === VMS_YIELD) return { state: 'yield', position: vmsPosition(this.ss), keep: vmsKeep(this.ss) };
    // D085: a verdict waiting for the end of an unknown-length message (end(n) settles it)
    if (r === VMS_HELD) return { state: 'held', result: this.program.result(this.out.slice(0, 8 + 2 * this.out[6])) };
    if (r < 0) throw new Error(`snug: vms-step answered ${r}`);
    this.verdict = { state: 'done', result: this.program.result(this.out.slice(0, 8 + 2 * this.out[6])) };
    return this.verdict;
  }
}

