// Run: node examples/validate-hostile.mjs. Repository-relative public entry;
// a staged/installed package spells this import 'snug/compile'.
import assert from 'node:assert/strict';
import { compile } from '../host/js/src/public-compile.mjs';

const schema = await compile('message = { id: uint, body: bstr .size (0..1024) }', {
  limits: { inputBytes: 2048, entries: 8, items: 32, depth: 4, budget: 10000 },
});
// No decoded values are built for this hostile indefinite-length map.
const hostile = Uint8Array.of(0xbf, 0xff);
const result = schema.validate(hostile, 'message');
assert.equal(result.ok, false);
assert.equal(result.reason, 'cbor/indefinite');
assert.deepEqual(result.path, []);
console.log('hostile CBOR refused:', result.reason);
