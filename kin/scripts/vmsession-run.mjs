// The resumable session's drivers for the gates (P6.2): one session over a
// message held in memory, with windows chosen by a deterministic POLICY that
// the Rust arm (host/rust/src/bin/vmsession.rs) implements identically.
//
//   policy {kind, w, q, seed, k}:
//     kind 0  whole windows (from the requested offset to the end)
//     kind 1  windows of max(asked, w) bytes
//     kind 2  windows of max(asked, 1 + rnd() % w) bytes (xorshift32 from seed)
//     kind 3  a first window [0, k), then whole windows
//   q: the work quantum (0: none). Every window starts EXACTLY at the offset
//   asked for (nothing earlier is available) and is a fresh copy.
import { vmScratchWords, vmScratchInit } from '../../gen/js/snug/vm/api.mjs';
import { vmsWords, vmsArena, vmsInit, vmsStep, vmsStepX, vmsNeedOffset, vmsNeedLength, vmsPosition, vmsKeep } from '../../gen/js/snug/vm/session.mjs';
import { extFor } from './ext-cases.mjs';

export const VMS_NEED = -64, VMS_YIELD = -65;

export function xorshift(seed) {
  let x = (seed >>> 0) || 0x9e3779b9;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
}

/** Run one session; answers {out: 'words...', steps, needs, yields} or {error}. */
export function runSession(P, B, rule, lim, bytes, policy, opts = {}) {
  const it = sessionSteps(P, B, rule, lim, bytes, policy, opts);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

/** The same session as a generator that yields after every vms-step call, so
 *  several sessions can be interleaved step by step (each owns its arrays). */
export function* sessionSteps(P, B, rule, lim, bytes, policy, { guard = null, maxSteps = 0 } = {}) {
  const n = bytes.length;
  const x = extFor(P, B);   // P7.2: the test registry's predicates for a Program using extension controls
  const cap = Math.max(P[16], 1);
  let s = new Int32Array(vmScratchWords(P, rule, cap)); vmScratchInit(s, cap);
  let ss = new Int32Array(vmsWords(P));
  let ka = new Uint8Array(vmsArena(P, lim, n));
  const out = new Int32Array(8 + 2 * 257);
  let p = P, b = B, o = out;
  if (guard) { p = guard(P, 'P'); b = guard(B, 'B'); s = guard(s, 'S'); ss = guard(ss, 'SS'); ka = guard(ka, 'KA'); o = guard(out, 'out'); }
  const ci = vmsInit(p, b, rule, lim, s, ss, ka, n, policy.q);
  if (ci < 0) return { error: `vms-init ${ci}` };
  const rnd = xorshift(policy.seed ?? 1);
  const limit = maxSteps || (200000 + 64 * n);
  let off = 0, len = 1, steps = 0, needs = 0, yields = 0, first = true, lastKeep = 0;
  for (;;) {
    let L;
    if (first && policy.kind === 3) L = Math.min(policy.k, n);
    else if (policy.kind === 0 || policy.kind === 3) L = n - off;
    else if (policy.kind === 1) L = Math.max(len, policy.w);
    else L = Math.max(len, 1 + (rnd() % policy.w));
    first = false;
    const e = Math.min(n, off + L);
    let win = bytes.slice(off, e);
    if (guard) win = guard(win, 'window');
    const r = x ? vmsStepX(p, b, win, s, ss, ka, o, off, x) : vmsStep(p, b, win, s, ss, ka, o, off);
    steps++;
    yield r;
    if (r >= 0) return { out: Array.from(out.slice(0, 8 + 2 * out[6])).join(' '), steps, needs, yields };
    if (r === VMS_NEED) {
      needs++;
      const no = vmsNeedOffset(ss), nl = vmsNeedLength(ss);
      if (no < 0 || nl < 1 || no + nl > n) return { error: `bad NEED(${no}, ${nl}) of ${n}` };
      if (no >= off && no + nl <= e) return { error: `NEED(${no}, ${nl}) inside the window [${off}, ${e})` };
      const keep = vmsKeep(ss);
      if (keep > no) return { error: `keep ${keep} past the need offset ${no}` };
      if (keep < lastKeep) return { error: `keep went back from ${lastKeep} to ${keep}` };
      lastKeep = keep;
      off = no; len = nl;
    } else if (r === VMS_YIELD) {
      yields++;
      off = vmsPosition(ss); len = 1;
      if (off < 0 || off > n) return { error: `bad YIELD position ${off}` };
      if (off === n) len = 0;
    } else return { error: `vms-step ${r}` };
    if (steps > limit) return { error: `no verdict after ${steps} steps` };
  }
}

// ---------------------------------------------------------------- unknown length (D085)
import { vmsInitUnknown, vmsUnknownTotal, vmsEof, vmsHeldCode } from '../../gen/js/snug/vm/session.mjs';
export const VMS_HELD = -67, VMS_RESUME = -68;
// An unknown-length session's key arena is sized for the input limit (D085): the
// runner reuses one (sessions run one after another; nothing reads an arena byte the
// session did not write first).
let arenaCache = new Uint8Array(0);
const arenaOf = n => (arenaCache.length >= n ? arenaCache.subarray(0, n) : (arenaCache = new Uint8Array(n)));

/** One UNKNOWN-length session (drain mode) over a message the runner holds but the
 *  session is never told the length of: windows per `policy`, never past the message;
 *  a need past the end, or a held verdict, ends the stream (vms-eof). failFast: a held
 *  refusal is answered at once. Answers {out, steps, early?} or {error}. The Rust arm
 *  (vmsession.rs `ucase`) runs the same loop. */
export function runUnknown(P, B, rule, lim, bytes, policy, { failFast = false, guard = null } = {}) {
  const n = bytes.length;
  const x = extFor(P, B);
  const cap = Math.max(P[16], 1);
  const total = vmsUnknownTotal(P, lim);
  let s = new Int32Array(vmScratchWords(P, rule, cap)); vmScratchInit(s, cap);
  let ss = new Int32Array(vmsWords(P));
  let ka = arenaOf(vmsArena(P, lim, total));
  const out = new Int32Array(8 + 2 * 257);
  let p = P, b = B, o = out;
  if (guard) { p = guard(P, 'P'); b = guard(B, 'B'); s = guard(s, 'S'); ss = guard(ss, 'SS'); ka = guard(ka, 'KA'); o = guard(out, 'out'); }
  const ci = vmsInitUnknown(p, b, rule, lim, s, ss, ka, policy.q);
  if (ci < 0) return { error: `vms-init-unknown ${ci}` };
  const rnd = xorshift(policy.seed ?? 1);
  const limit = 200000 + 64 * n;
  const words = () => Array.from(out.slice(0, 8 + 2 * out[6])).join(' ');
  let off = 0, len = 1, steps = 0, first = true, eofed = false, lastKeep = 0;
  const eof = () => { eofed = true; return vmsEof(ss, o, n); };
  // a forward-only stream drops what precedes keep: the session may never ask for it again
  const keepOk = at => { const k = vmsKeep(ss); if (at < lastKeep || k < lastKeep) return false; lastKeep = k; return true; };
  for (;;) {
    let L;
    if (first && policy.kind === 3) L = Math.min(policy.k, n);
    else if (policy.kind === 0 || policy.kind === 3) L = n - off;
    else if (policy.kind === 1) L = Math.max(len, policy.w);
    else L = Math.max(len, 1 + (rnd() % policy.w));
    first = false;
    const e = Math.min(n, total, off + L);
    let win = bytes.slice(off, Math.max(off, e));
    if (guard) win = guard(win, 'window');
    let r = x ? vmsStepX(p, b, win, s, ss, ka, o, off, x) : vmsStep(p, b, win, s, ss, ka, o, off);
    steps++;
    if (r === VMS_HELD) {
      if (failFast && vmsHeldCode(ss) !== 0) return { out: words(), steps, early: true };
      if (eofed) return { error: 'held after vms-eof' };
      r = eof();
      if (r < 0) return { error: `vms-eof ${r} after held` };
    }
    if (r >= 0) return { out: words(), steps };
    if (r === VMS_NEED) {
      const no = vmsNeedOffset(ss), nl = vmsNeedLength(ss);
      const keep = vmsKeep(ss);
      if (keep > no) return { error: `keep ${keep} past the need offset ${no}` };
      if (!keepOk(no)) return { error: `NEED(${no}) or keep ${keep} before a keep already given (${lastKeep})` };
      if (no + nl > Math.min(n, total) || n > total && no + nl >= total) {
        if (eofed) return { error: `NEED(${no}, ${nl}) past the end ${n} after vms-eof` };
        const r2 = eof();
        if (r2 >= 0) return { out: words(), steps };
        if (r2 !== VMS_RESUME) return { error: `vms-eof ${r2}` };
      }
      off = no; len = nl;
    } else if (r === VMS_YIELD) {
      off = vmsPosition(ss); len = 1;
      if (!keepOk(off)) return { error: `YIELD at ${off} or keep before a keep already given (${lastKeep})` };
      // a window may not start past the bytes the stream has delivered: past the end is EOF
      if (off > n) {
        if (eofed) return { error: `YIELD at ${off} past the end ${n} after vms-eof` };
        const r3 = eof();
        if (r3 >= 0) return { out: words(), steps };
        if (r3 !== VMS_RESUME) return { error: `vms-eof ${r3}` };
        off = vmsPosition(ss);
      }
      if (off >= n) len = 0;
    } else return { error: `vms-step ${r}` };
    if (steps > limit) return { error: `no verdict after ${steps} steps` };
  }
}
