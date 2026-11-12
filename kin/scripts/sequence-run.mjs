// CBOR sequences at the kin level (P7.13, D210-D212): the session VM's
// sequence mode driven over a sequence delivered in chunks, and the oracle
// (D211) it must equal -- the buffer driver over each message's window. The
// Rust arm (host/rust/src/bin/sequence.rs) runs the same driver.
//
//   chunk policy {kind, w, seed, k}: how the sequence is DELIVERED
//     kind 0  one chunk
//     kind 1  chunks of w bytes
//     kind 2  chunks of 1 + rnd() % w bytes (xorshift32 from seed)
//     kind 3  two chunks [0, k), [k, n)
//   q: the work quantum of every session (0: none)
//
// A result is a list of lines, one per message the reader reached:
//   `m <index> <offset> <length> <out words>`   accepted (out: code 0 ...)
//   `s <index> <offset> <length> <out words>`   refused and skipped (skip policy)
//   `x <index> <offset> <out words>`            refused, the sequence stops
// offsets absolute (the error offset in the out words too), then `end <offset>`
// when the sequence ended cleanly at a boundary.
import { vmScratchWords, vmScratchInit, vmValidateV } from '../../gen/js/snug/vm/api.mjs';
import { vmsWords, vmsArena, vmsNeedOffset, vmsNeedLength, vmsPosition, vmsKeep,
  vmsUnknownTotal, vmsEof, vmsHeldCode, vmsInitSeq, vmsMessageLength } from '../../gen/js/snug/vm/session.mjs';
import { extFor } from './ext-cases.mjs';
import { navInit, navSkip, NAV_WORDS } from '../../gen/js/snug/nav/walk.mjs';
import { xorshift, stepV } from './vmsession-run.mjs';
import { frameItem } from '../../corpus/tools/rfc8742-framer.mjs';

export const VMS_NEED = -64, VMS_YIELD = -65, VMS_HELD = -67, VMS_RESUME = -68;
const CODE_TRUNCATED = 1, CODE_TOO_LARGE = 20;
/** D214: the reasons a skip may drop (schema reasons, never cbor/* or budget). */
export const skippableCode = code => code >= 32 && code <= 43;

/** The chunk ends ([e1, e2, ..., n]) a policy delivers a sequence of n bytes in. */
export function chunkEnds(n, policy) {
  const ends = [];
  if (n === 0) return ends;
  if (policy.kind === 0) return [n];
  if (policy.kind === 3) { const k = Math.min(Math.max(policy.k, 1), n); return k < n ? [k, n] : [n]; }
  const rnd = xorshift(policy.seed ?? 1);
  let at = 0;
  while (at < n) { at = Math.min(n, at + (policy.kind === 1 ? Math.max(1, policy.w) : 1 + (rnd() % policy.w))); ends.push(at); }
  return ends;
}

// The key arena is sized for the input limit: one is reused (runs are sequential, and
// nothing reads an arena byte the session did not write first), as vmsession-run does.
let arenaCache = new Uint8Array(0);
const arraysCache = new WeakMap();
const arenaOf = n => (arenaCache.length >= n ? arenaCache.subarray(0, n) : (arenaCache = new Uint8Array(n)));

/** The out words with the error offset made absolute (word 2), as a string. */
function words(out, o) {
  const w = Array.from(out.slice(0, 8 + 2 * out[6]));
  if (w[0] !== 0) w[2] += o;
  return w.join(' ');
}

/** Run a sequence through vms-init-seq sessions (one per message, the same arrays).
 *  opts: { skip, failFast, guard }. Answers {lines: [...]} or {error}. */
export function runSequence(P, B, rule, lim, S, policy, { skip = false, failFast = false, guard = null } = {}) {
  const n = S.length;
  const x = extFor(P, B);
  const cap = Math.max(P[16], 1);
  const total = vmsUnknownTotal(P, lim);
  // per (Program, rule): the same arrays serve every run, as they serve every message of one
  let arrays = arraysCache.get(P)?.get(rule);
  if (!arrays) {
    const s0 = new Int32Array(vmScratchWords(P, rule, cap)); vmScratchInit(s0, cap);
    arrays = { s: s0, ss: new Int32Array(vmsWords(P)) };
    if (!arraysCache.has(P)) arraysCache.set(P, new Map());
    arraysCache.get(P).set(rule, arrays);
  }
  let s = arrays.s, ss = arrays.ss;
  let ka = arenaOf(vmsArena(P, lim, total));
  const out = new Int32Array(8 + 2 * 257);
  let p = P, b = B, ou = out;
  if (guard) { p = guard(P, 'P'); b = guard(B, 'B'); s = guard(s, 'S'); ss = guard(ss, 'SS'); ka = guard(ka, 'KA'); ou = guard(out, 'out'); }
  const st = { s, ss, ka, vs: new Int32Array(512), cb: new Uint8Array(1024) };
  const ends = chunkEnds(n, policy);
  let ci = 0, delivered = 0;
  const more = () => { if (ci >= ends.length) return false; delivered = ends[ci++]; return true; };
  const lines = [];
  let o = 0, index = 0, steps = 0, late = 0;   // late: accepted only after bytes past its end arrived
  const limit = 400000 + 64 * n;
  for (;;) {
    // a message starts once a byte after the boundary has arrived; EOF there ends the sequence
    while (delivered <= o) if (!more()) { lines.push(`end ${o}`); return { lines, late, sWords: st.s.length }; }
    const c0 = vmsInitSeq(p, b, rule, lim, st.s, ss, st.ka, policy.q ?? 0);
    if (c0 < 0) return { error: `vms-init-seq ${c0}` };
    let at = 0, eofed = false, lastKeep = 0, end = total;   // end: the session's end once vms-eof gave it
    let r;
    let want = 1;
    let held = false, asserted = 0;   // a held verdict only needs the frontier asserted: an empty window there
    const step = () => {
      const e = Math.min(delivered - o, end);
      if (held) at = e;
      // a fresh copy of at most 64 KiB past the position asked for (a need longer than that whole):
      // copying all that has arrived for every message would be quadratic in a long sequence
      const w = Math.min(e, at + Math.max(65536, want));
      let win = S.slice(o + at, o + Math.max(at, w));
      asserted = at + win.length;   // a window asserts its bytes exist (D147)
      if (guard) win = guard(win, 'window');
      steps++;
      // P8.4 (D266): the valid machinery's buffers, grown on VMS_GROW
      return stepV(st, p, b, win, ou, at, x);
    };
    const eof = () => {
      // only once more than the provisional end has arrived (too_large) or the stream has ended
      if (!(delivered - o > total || ci >= ends.length)) throw new Error('vms-eof before the end');
      eofed = true;
      const nn = delivered - o;
      if (nn <= total) end = nn;
      return vmsEof(ss, ou, nn);
    };
    r = step();
    for (;;) {
      if (steps > limit) return { error: `no verdict after ${steps} steps` };
      if (r === VMS_HELD) {
        const hc = vmsHeldCode(ss), ml = vmsMessageLength(ss);
        if (failFast && hc !== 0 && !(skip && ml >= 0 && skippableCode(hc))) {
          lines.push(`x ${index} ${o} ${words(out, o)} early`);
          return { lines, late };
        }
        if (eofed) return { error: 'held after vms-eof' };
        held = true;
        // bytes delivered past the last window first release the claims they cover (a held
        // complete message must not become too_large because the window was capped)
        if (asserted < Math.min(delivered - o, end)) { r = step(); continue; }
        if (delivered - o > total || !more()) { r = eof(); if (r === VMS_RESUME) return { error: 'held then resume' }; continue; }
        r = step();
        continue;
      }
      if (r >= 0) break;
      if (r === VMS_NEED || r === VMS_YIELD) {
        const isNeed = r === VMS_NEED;
        const no = isNeed ? vmsNeedOffset(ss) : vmsPosition(ss);
        const nl = isNeed ? vmsNeedLength(ss) : 1;
        const keep = vmsKeep(ss);
        if (isNeed && keep > no) return { error: `keep ${keep} past the need offset ${no}` };
        if (no < lastKeep || keep < lastKeep) return { error: `${isNeed ? 'NEED' : 'YIELD'}(${no}) or keep ${keep} before a keep already given (${lastKeep})` };
        lastKeep = keep;
        if (isNeed && no >= at && no + nl <= Math.min(delivered - o, end, at + Math.max(65536, want))) return { error: `NEED(${no}, ${nl}) inside the window [${at}, ${delivered - o})` };
        at = no; want = isNeed ? nl : 1;
        // a need: [no, no + nl) must have arrived; a yield: the bytes up to its position
        const upto = o + no + (isNeed ? nl : 0);
        while (delivered < upto && delivered - o <= total && more()) { /* deliver */ }
        if (delivered >= upto && no + (isNeed ? nl : 0) <= end) { r = step(); continue; }
        if (eofed) return { error: `${isNeed ? 'NEED' : 'YIELD'}(${no}, ${nl}) past the end after vms-eof` };
        r = eof();
        if (r === VMS_RESUME) { at = vmsPosition(ss); if (o + at > delivered) return { error: 'resume past the end' }; r = step(); }
        continue;
      }
      return { error: `vms-step ${r}` };
    }
    // the verdict
    const ml = vmsMessageLength(ss);
    if (out[0] === 0) {
      if (ml < 1) return { error: `accepted with message length ${ml}` };
      if (o + ml > delivered) return { error: `accepted before its bytes arrived (${o + ml} > ${delivered})` };
      if (delivered > o + ml && ends[ci - 2] >= o + ml) late++;
      lines.push(`m ${index} ${o} ${ml} ${words(out, o)}`);
      o += ml; index++;
      continue;
    }
    if (skip && ml >= 0 && skippableCode(out[0])) {
      if (o + ml > delivered) return { error: `skipped before its bytes arrived (${o + ml} > ${delivered})` };
      lines.push(`s ${index} ${o} ${ml} ${words(out, o)}`);
      o += ml; index++;
      continue;
    }
    lines.push(`x ${index} ${o} ${words(out, o)}`);
    return { lines, late };
  }
}

// ---------------------------------------------------------------- the oracle (D211)
const vout = new Int32Array(8 + 2 * 257);
let oscratch = new Int32Array(0), omark = 0, ovs = new Int32Array(512), ocb = new Uint8Array(1024);
function buffer(P, B, rule, lim, bytes) {
  const cap = Math.max(omark, P[16], 1);
  const need = vmScratchWords(P, rule, cap);
  if (cap > omark || need > oscratch.length) { oscratch = new Int32Array(Math.max(need, oscratch.length)); omark = cap; vmScratchInit(oscratch, cap); }
  const x = extFor(P, B);
  // the buffer driver with valid-CBOR support (P8.4): its canonical path's buffers grown on -5
  let c;
  for (;;) {
    c = vmValidateV(P, B, rule, bytes, lim, oscratch, vout, x || (() => -2), ovs, ocb);
    if (c !== -5) break;
    if (vout[5] > ovs.length) ovs = new Int32Array(Math.max(vout[5], 2 * ovs.length));
    if (vout[6] > ocb.length) ocb = new Uint8Array(Math.max(vout[6], 2 * ocb.length));
    if (vout[7] > oscratch.length) { const g = new Int32Array(vout[7]); g.set(oscratch); oscratch = g; }
  }
  if (c < 0) throw new Error(`vm-validate ${c}`);
  return vout;
}

const navo = new Int32Array(NAV_WORDS);
/** The end of the item at 0 by heads and lengths alone, or -1: snug.nav.walk (total on any bytes),
 *  which walks definite-length items only (architecture §16.4); for an indefinite-length item
 *  (wire 'valid'), the independent RFC 8742 framer (P9.5: navSkip answered -1 there, so a valid
 *  indefinite root followed by another message read as `trailing`, not as a boundary). */
function rootEnd(b) {
  navInit(navo, 0x7fffffff);
  const e = navSkip(b, navo, 0, b.length);
  if (e >= 0) return e;
  const f = frameItem(b, 0);
  return f.kind === 'ok' ? f.end : -1;
}

/** The lines D211 defines: per message, the buffer driver over its window
 *  W = S[o, o + min(R, P)) with trailing as the boundary. */
export function oracleSequence(P, B, rule, lim, S, { skip = false } = {}) {
  const n = S.length, total = vmsUnknownTotal(P, lim);
  const lines = [];
  let o = 0, index = 0;
  for (;;) {
    if (o >= n) { lines.push(`end ${o}`); return { lines }; }
    const R = n - o, m = Math.min(R, total);
    let w = buffer(P, B, rule, lim, S.subarray(o, o + m));
    let len = -1;
    // trailing at the root's structural end: the root ended there (a trailing inside a tag-24
    // payload is that payload's refusal, not a boundary)
    if (w[0] === 16 && rootEnd(S.subarray(o, o + m)) === w[2]) { len = w[2]; w = buffer(P, B, rule, lim, S.subarray(o, o + len)); }
    else if (w[0] === 0 || skippableCode(w[0])) len = m;                                  // the root ended at W's end
    else if (w[0] === CODE_TRUNCATED && R > total) { w = vout; w.fill(0, 0, 8); w[0] = CODE_TOO_LARGE; }
    if (w[0] === 0) { lines.push(`m ${index} ${o} ${len} ${words(w, o)}`); o += len; index++; continue; }
    if (skip && len >= 0 && skippableCode(w[0])) { lines.push(`s ${index} ${o} ${len} ${words(w, o)}`); o += len; index++; continue; }
    lines.push(`x ${index} ${o} ${words(w, o)}`);
    return { lines };
  }
}
