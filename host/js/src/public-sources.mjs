// Explicit surface: transport failures stay distinct from CBOR refusals.
export { SourceError, ScanSession, scanBuffer, scanHandle, scanHandleSync,
  bufferHandle, asyncHandle, pushScanner, validateHandle, validateHandleSync,
  pushValidator } from './sources.mjs';
