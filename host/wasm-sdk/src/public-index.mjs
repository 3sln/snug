// `@3sln/snug-wasm`, the package root: the native root's surface
// plus the wasm instance's own functions. index.mjs also exports internals
// (scan, for sources.mjs) that are not part of the package.
export { init, initSync, reset, trim, memoryBytes, InstanceLost, encode, decode,
  Decimal, NDArray, Float16Bytes, Tagged, Simple, SnugFault, LIMITS, profiles } from './index.mjs';
