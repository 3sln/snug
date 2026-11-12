// `@3sln/snug-wasm`, the package root (P9.17): the native root's surface (D172)
// plus the wasm instance's own functions. index.mjs also exports internals
// (scan, for sources.mjs) that are not part of the package.
export { init, initSync, reset, trim, memoryBytes, InstanceLost, encode, decode,
  Decimal, NDArray, Float16Bytes, Tagged, Simple, SnugFault, LIMITS, profiles } from './index.mjs';
