import { scan } from './scan.mjs';
import { build } from './build.mjs';

export { encode } from './encode.mjs';
export { Decimal, NDArray, Float16Bytes, Tagged } from './values.mjs';
export { SnugFault } from './fault.mjs';
export { LIMITS } from './limits.mjs';
export { profiles } from './profiles.mjs';

export function decode(bytes, options = {}) {
  scan(bytes, options);
  return build(bytes, options);
}
