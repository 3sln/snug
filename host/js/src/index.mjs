import { scan } from './scan.mjs';
import { build } from './build.mjs';

export { encode } from './encode.mjs';
export { Decimal, NDArray, Float16Bytes, Tagged, Simple } from './values.mjs';
export { SnugFault } from './fault.mjs';
export { LIMITS } from './limits.mjs';
export { profiles } from './profiles.mjs';

export function decode(bytes, options = {}) {
  // scan answers the bytes to build from: the input, or its canonical copy (P8.4, D262)
  return build(scan(bytes, options), options);
}
