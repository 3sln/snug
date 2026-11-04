// P7.9: the codec entry over wasm (`snug` in the native package). decode =
// the wasm profile scan (input copied into linear memory) + the same trusted
// JS builder the native package uses, over the caller's bytes (D004: hosts own
// the value model; the bytes are already in JS, so nothing is read back).
// encode = the JS walk writing a tape + one wasm call (encode.mjs).
import * as rt from './runtime.mjs';
import { SnugFault } from '../../js/src/fault.mjs';
import { resolveLimits } from '../../js/src/limits.mjs';
import { build } from '../../js/src/build.mjs';

export { init, initSync, reset, trim, memoryBytes, InstanceLost } from './runtime.mjs';
export { encode } from './encode.mjs';
export { Decimal, NDArray, Float16Bytes } from '../../js/src/values.mjs';
export { SnugFault } from '../../js/src/fault.mjs';
export { LIMITS } from '../../js/src/limits.mjs';
export { profiles } from '../../js/src/profiles.mjs';

const I32_MAX = 0x7fffffff;
const clamp = n => (n > I32_MAX ? I32_MAX : n);

/** Throws SnugFault(code) unless bytes are valid under the profile (the native scan's contract). */
export function scan(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decode expects a Uint8Array.');
  if (typeof SharedArrayBuffer === 'function' && bytes.buffer instanceof SharedArrayBuffer) throw new TypeError('decode refuses SharedArrayBuffer-backed input; copy it first.');
  const top = options.top ?? 'map'; if (top !== 'map' && top !== 'any') throw new TypeError("top must be 'map' or 'any'.");
  const limits = resolveLimits(options);
  rt.ready();
  let code;
  try {
    const p = rt.input(bytes);
    code = rt.x.sdk_scan(p, bytes.length, top === 'any' ? 1 : 0, options.cose === true ? 1 : 0, clamp(limits.maxBytes), clamp(limits.maxDepth), clamp(limits.maxEntries), clamp(limits.maxItems));
  } catch (e) { rt.lost(e); }
  if (code !== 0) throw new SnugFault(rt.codeName(code));
}

export function decode(bytes, options = {}) {
  scan(bytes, options);
  return build(bytes, options);
}
