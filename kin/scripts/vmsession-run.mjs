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
import { vmsWords, vmsArena, vmsInit, vmsStep, vmsNeedOffset, vmsNeedLength, vmsPosition, vmsKeep } from '../../gen/js/snug/vm/session.mjs';

export const VMS_NEED = -64, VMS_YIELD = -65;

export function xorshift(seed) {
  let x = (seed >>> 0) || 0x9e3779b9;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
}

/** Run one session; answers {out: 'words...', steps, needs, yields, maxWindow} or {error}. */
export function runSession(P, B, rule, lim, bytes, policy, { guard = null, maxSteps = 0 } = {}) {
  const n = bytes.length;
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
    const r = vmsStep(p, b, win, s, ss, ka, o, off);
    steps++;
    if (r >= 0) return { out: Array.from(out.slice(0, 8 + 2 * out[6])).join(' '), steps, needs, yields };
    if (r === VMS_NEED) {
      needs++;
      const no = vmsNeedOffset(ss), nl = vmsNeedLength(ss);
      if (no < 0 || nl < 1 || no + nl > n) return { error: `bad NEED(${no}, ${nl}) of ${n}` };
      if (no >= off && no + nl <= e && !(no === e)) return { error: `NEED(${no}, ${nl}) inside the window [${off}, ${e})` };
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
