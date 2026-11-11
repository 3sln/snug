// Explicit surface: transport failures stay distinct from CBOR refusals.
export { openSession, SourceError, ScanSession, scanBuffer, scanHandle, scanHandleSync,
  bufferHandle, asyncHandle, pushScanner, validateHandle, validateHandleSync,
  pushValidator, streamSource, validateStream, scanStream } from './sources.mjs';
// P9.7: the isolate's live-session bound and idle-array pool
export { sessionLimits, releasePool } from './session-pool.mjs';
