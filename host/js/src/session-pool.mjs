// P9.7 (D326): the sessions' arrays pooled per Program, and a bound on live sessions per isolate.
// A session (VmSession, a sequence reader's backend) takes its scratch S, session array SS and key arena
// from its Program's pool and gives them back when it ends -- finished, refused, errored, closed -- or, if
// abandoned mid-message, when it is garbage-collected. Every array is zero-filled before reuse, so a
// pooled session starts from exactly the bytes a fresh one does: no byte crosses from one session to
// another, and units, events and verdicts are those of fresh arrays.
import { SnugFault } from './fault.mjs';

const L = { maxLive: 1024, maxPooledBytes: 2 << 20 };
let live = 0, pooled = 0;
// a Program's idle entries; every pool (for releasePool), each dropped with its Program
const pools = new WeakMap(), all = new Set();
const size = e => 4 * (e.s.length + e.ss.length) + e.ka.length;
const drop = pool => { for (const e of pool) pooled -= size(e); pool.length = 0; };
const finals = new FinalizationRegistry(lease => release(lease));
const programFinals = new FinalizationRegistry(pool => { drop(pool); all.delete(pool); });

/** Drop every idle entry now (a long-lived process trimming memory); later sessions allocate afresh. */
export function releasePool() { for (const pool of all) drop(pool); }
/** Gates only (not a public entry): scribble pooled arrays, so reuse that skipped the zero-fill shows. */
export const testing = { scribble: false };

/** The isolate's session policy: { maxLive, maxPooledBytes } to set (either may be omitted); answers the
 *  limits with the current counts { live, pooledBytes }. */
export function sessionLimits(set) {
  if (set !== undefined) {
    if (!set || typeof set !== 'object') throw new TypeError('snug: sessionLimits takes { maxLive, maxPooledBytes }');
    // maxLive at least 1, maxPooledBytes at least 0
    for (const k in set) if (!Object.hasOwn(L, k) || !Number.isSafeInteger(set[k]) || set[k] < (k === 'maxLive')) throw new TypeError(`snug: bad session limit ${k}`);
    Object.assign(L, set);
  }
  return { ...L, live, pooledBytes: pooled };
}

/** A lease of { s, ss, ka } (S at least sw words, SS exactly ssw, the arena at least kab bytes), all zero;
 *  owner (if given) releases it when collected. Throws sessions/limit at the bound. */
export function acquire(program, sw, ssw, kab, owner) {
  if (live >= L.maxLive) throw new SnugFault('sessions/limit', `snug: ${live} sessions are live (sessionLimits); finish, close() or dispose sessions to release them`);
  const pool = pools.get(program) ?? [];
  const i = pool.findLastIndex(c => c.s.length >= sw && c.ss.length === ssw);
  let e;
  if (i < 0) e = { s: new Int32Array(sw), ss: new Int32Array(ssw), ka: new Uint8Array(kab) };
  else {
    [e] = pool.splice(i, 1); pooled -= size(e);
    e.s.fill(0); e.ss.fill(0);
    if (e.ka.length < kab) e.ka = new Uint8Array(kab); else e.ka.fill(0);
  }
  live++;
  const lease = { program, e };
  if (owner) own(lease, owner);
  return lease;
}

/** The lease is released when owner is garbage-collected (an abandoned session). */
export const own = (lease, owner) => finals.register(owner, lease, lease);

/** Give a lease back (once; later calls do nothing). The arrays are the session's current ones (it may
 *  have grown them): kept in the Program's pool unless one is above 1 MiB or a quarter of the pool. */
export function release(lease) {
  const e = lease.e;
  if (!e) return;
  lease.e = null; live--;
  finals.unregister(lease);
  const n = size(e);
  if (n > 1 << 20 || n > L.maxPooledBytes >> 2 || pooled + n > L.maxPooledBytes) return;
  if (testing.scribble) { e.s.fill(0x5a5a5a5a); e.ss.fill(0x5a5a5a5a); e.ka.fill(0x5a); }
  let pool = pools.get(lease.program);
  if (!pool) { pools.set(lease.program, pool = []); all.add(pool); programFinals.register(lease.program, pool); }
  pool.push(e); pooled += n;
}
