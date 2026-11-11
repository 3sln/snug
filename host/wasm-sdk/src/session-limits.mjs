// P9.7 (D327): the instance's session policy, as the native package's (host/js/src/session-pool.mjs). The
// bound and the pool of idle session arrays live in the wasm module (sdk_vs_new answers -3 at the bound);
// a session's arrays are zero-filled before reuse.
import * as rt from './runtime.mjs';
import { SnugFault } from '../../js/src/fault.mjs';

const I32_MAX = 0x7fffffff;

/** { maxLive, maxPooledBytes } to set (either may be omitted); answers the limits with { live, pooledBytes }. */
export function sessionLimits(set) {
  if (set !== undefined) {
    if (set === null || typeof set !== 'object') throw new TypeError('snug: sessionLimits takes { maxLive, maxPooledBytes }');
    for (const k of Object.keys(set)) {
      if (k !== 'maxLive' && k !== 'maxPooledBytes') throw new TypeError(`snug: unknown session limit ${k}`);
      if (!Number.isSafeInteger(set[k]) || set[k] < (k === 'maxLive' ? 1 : 0) || set[k] > I32_MAX) throw new TypeError(`snug: ${k} must be a ${k === 'maxLive' ? 'positive' : 'non-negative'} integer`);
    }
  }
  rt.ready();
  rt.x.sdk_ses_limits(set?.maxLive ?? 0, set?.maxPooledBytes ?? -1);
  const i = rt.INFO;
  return { maxLive: rt.i32[i], maxPooledBytes: rt.i32[i + 1], live: rt.i32[i + 2], pooledBytes: rt.i32[i + 3] };
}

/** Drop every idle pooled array now (a long-lived page trimming memory). */
export function releasePool() { rt.ready(); rt.x.sdk_ses_release_pool(); }

/** The fault for a session refused at the bound (sdk_vs_new -3). */
export const sessionLimitFault = () => new SnugFault('sessions/limit',
  `snug: ${sessionLimits().maxLive} sessions are live (sessionLimits); finish, close() or dispose sessions to release them`);
