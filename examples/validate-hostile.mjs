// Run: node examples/validate-hostile.mjs. Repository-relative public entry;
// a staged/installed package spells this import 'snug/compile'.
import assert from 'node:assert/strict';
import { compile } from '../host/js/src/public-compile.mjs';

const schema = await compile('message = { id: uint, body: bstr .size (0..1024) }', {
  limits: { inputBytes: 2048, entries: 8, items: 32, depth: 4, budget: 10000 },
});
// No decoded values are built for this hostile input: an indefinite-length map
// whose second key repeats the first in a longer encoding (duplicate by value).
const hostile = Uint8Array.of(0xbf, 0x62, 0x69, 0x64, 0x01, 0x78, 0x02, 0x69, 0x64, 0x02, 0xff);
const result = schema.validate(hostile, 'message');
assert.equal(result.ok, false);
assert.equal(result.reason, 'cbor/duplicate_key');
assert.deepEqual(result.path, []);
// The deterministic preset refuses the indefinite length first.
assert.equal(schema.validate(hostile, 'message', { wire: 'deterministic' }).reason, 'cbor/indefinite');
console.log('hostile CBOR refused:', result.reason);
