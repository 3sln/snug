// `@3sln/snug-wasm/sources`: the native surface (public-sources.mjs).
// sources.mjs also exports an internal (pickYield) that is not part of the package.
export { openSession, SourceError, ScanSession, scanBuffer, scanHandle, scanHandleSync,
  bufferHandle, asyncHandle, pushScanner, validateHandle, validateHandleSync,
  pushValidator, streamSource, validateStream, scanStream, sessionLimits, releasePool } from './sources.mjs';
