import { SnugFault } from './fault.mjs';
import { resolveLimits } from './limits.mjs';
import { validateOptions } from './options.mjs';
import { profileFlags, codecTop } from './profiles.mjs';
import { scanCb, scanOptions, scanProfile, codeName } from '../../../gen/js/snug/cbor/scan.mjs';
import { dcCopy } from '../../../gen/js/snug/cbor/canon.mjs';
import { VC_NONDET, VC_UNSORTED, CODE_SCRATCH } from '../../../gen/js/snug/cbor/codes.mjs';

// The generated profile scanner (kin, snug.cbor.scan) has an integer ABI: options are packed into one reused
// Int32Array by scanOptions and scanProfile (D120), scan returns 0 (accept) or a code whose cbor.mjs name codeName
// gives. Validation is synchronous and calls no host code, so one options buffer per module is safe. Past its 16
// frozen words the array is the walk's scratch, and `cb` its canonical buffer (P8.4, D264): both start small and
// grow when kin answers CODE_SCRATCH (the sizes it needs in o[13], o[14]).
let o = new Int32Array(16 + 512), cb = new Uint8Array(1024);
const I32_MAX = 0x7fffffff;
const clamp = n => (n > I32_MAX ? I32_MAX : n);

function grow() {
  const keep = o.subarray(0, 16).slice();
  if (o[13] > o.length) { o = new Int32Array(Math.max(o[13], 2 * o.length)); o.set(keep); }
  if (o[14] > cb.length) cb = new Uint8Array(Math.max(o[14], 2 * cb.length));
}

/** Throws SnugFault(code) unless bytes are valid under the profile with these options. Answers the bytes to build
 * from: `bytes` itself, or -- for valid input that is not its own deterministic form (P8.4, D262) -- a fresh
 * Uint8Array holding its canonical copy (wire order kept). */
export function scan(bytes, options = {}) { return scanInfo(bytes, options).bytes; }

/** scan, also telling whether some map's keys may be out of canonical order (views then search linearly). */
export function scanInfo(bytes, options = {}) {
  validateOptions(options, 'decode');
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decode expects a Uint8Array.');
  // Review C17: a SharedArrayBuffer-backed input could change between the checking pass and the trusted build.
  if (typeof SharedArrayBuffer === 'function' && bytes.buffer instanceof SharedArrayBuffer) throw new TypeError('decode refuses SharedArrayBuffer-backed input; copy it first.');
  const top = codecTop(options), flags = profileFlags(options);
  const limits = resolveLimits(options);
  for (;;) {
    scanOptions(o, top === 'any' ? 1 : 0, options.cose === true ? 1 : 0, clamp(limits.maxBytes), clamp(limits.maxDepth), clamp(limits.maxEntries), clamp(limits.maxItems));
    scanProfile(o, flags);
    const code = scanCb(bytes, o, cb);
    if (code === CODE_SCRATCH) { grow(); continue; }
    if (code !== 0) throw new SnugFault(codeName(code));
    if ((o[12] & VC_NONDET) === 0) return { bytes, unsorted: (o[12] & VC_UNSORTED) !== 0 };
    break;
  }
  const unsorted = (o[12] & VC_UNSORTED) !== 0;
  // The DC form of the accepted input (canon.kin dc-copy: the input then its form in cb; the VM's replay
  // machinery, vcopy.kin, is not the codec's)
  const n = bytes.length, need = 2 * n + (n >> 7) + 64;
  if (cb.length < need) cb = new Uint8Array(need);
  for (;;) {
    const l = dcCopy(bytes, o, cb);
    if (l >= 0) return { bytes: cb.slice(n, l), unsorted };
    cb = new Uint8Array(2 * cb.length);
  }
}
