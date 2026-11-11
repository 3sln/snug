// CBOR sequences (RFC 8742, D210-D217): one fused check per message, views minted from
// its verdict. A separate entry so that snug/sources does not carry the View.
export { readSequence, sequenceReader } from './sequence.mjs';
// P9.7: the isolate's live-session bound and idle-array pool (a reader counts as one session)
export { sessionLimits, releasePool } from './session-pool.mjs';
