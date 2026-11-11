import assert from 'node:assert/strict';
import { encode, SnugFault } from '../host/js/src/index.mjs';
import { asyncHandle, scanHandle } from '../host/js/src/public-sources.mjs';

const bytes = encode({ id: 7, body: new Uint8Array(256) });
// This example checks only the CBOR profile; use validateHandle for CDDL
// (examples/validate-handle.mjs). Default reads resolve in Promise microtasks;
// quantum enables cooperative event-loop turns. One read is in flight at a time.
assert.equal(await scanHandle(asyncHandle(bytes), {}, { chunk: 16, quantum: 4 }), true);
// Any valid CBOR by default (an indefinite-length map here); the deterministic preset refuses it.
assert.equal(await scanHandle(asyncHandle(Uint8Array.of(0xbf, 0xff))), true);
await assert.rejects(scanHandle(asyncHandle(Uint8Array.of(0xbf, 0xff)), { wire: 'deterministic' }), e =>
  e instanceof SnugFault && e.code === 'indefinite');
console.log('validated a profile over an asynchronous in-memory handle');
