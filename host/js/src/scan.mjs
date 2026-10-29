import { SnugFault } from './fault.mjs';
import { resolveLimits } from './limits.mjs';
import { scan as scanGenerated, scanOptions, codeName } from '../../../gen/js/snug/cbor/scan.mjs';

// The generated profile scanner (kin, snug.cbor.scan) has an integer ABI: options are packed into one reused
// Int32Array by scanOptions, scan returns 0 (accept) or a code whose cbor.mjs name codeName gives.
// Validation is synchronous and calls no host code, so one options buffer per module is safe.
const o = new Int32Array(16);
const I32_MAX = 0x7fffffff;
const clamp = n => (n > I32_MAX ? I32_MAX : n);

/** Throws SnugFault(code) unless bytes are valid under the profile with these options. */
export function scan(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decode expects a Uint8Array.');
  // Review C17: a SharedArrayBuffer-backed input could change between the checking pass and the trusted build.
  if (typeof SharedArrayBuffer === 'function' && bytes.buffer instanceof SharedArrayBuffer) throw new TypeError('decode refuses SharedArrayBuffer-backed input; copy it first.');
  const top = options.top ?? 'map'; if (top !== 'map' && top !== 'any') throw new TypeError("top must be 'map' or 'any'.");
  const limits = resolveLimits(options);
  scanOptions(o, top === 'any' ? 1 : 0, options.cose === true ? 1 : 0, clamp(limits.maxBytes), clamp(limits.maxDepth), clamp(limits.maxEntries), clamp(limits.maxItems));
  const code = scanGenerated(bytes, o);
  if (code !== 0) throw new SnugFault(codeName(code));
}
