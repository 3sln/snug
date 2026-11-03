import assert from 'node:assert/strict';
import { encode, SnugFault } from '../host/js/src/index.mjs';
import { asyncHandle, scanHandle } from '../host/js/src/public-sources.mjs';

const bytes = encode({ id: 7, body: new Uint8Array(256) });
// Current public source support checks the CBOR profile, not a CDDL rule.
// Reads resolve on later event-loop turns; one read is in flight at a time.
assert.equal(await scanHandle(asyncHandle(bytes), {}, { chunk: 16, quantum: 4 }), true);
await assert.rejects(scanHandle(asyncHandle(Uint8Array.of(0xbf, 0xff))), e =>
  e instanceof SnugFault && e.code === 'indefinite');
console.log('validated a profile over an asynchronous in-memory handle');
