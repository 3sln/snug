import assert from 'node:assert/strict';
import { encode, decode, Decimal } from '../host/js/src/index.mjs';
import { Writer } from '../host/js/src/public-writer.mjs';

const price = Decimal.from('1.50');
const bytes = encode({ price, id: 7 }, { maxBytes: 256 });
assert.deepEqual(bytes, encode({ id: 7, price }, { maxBytes: 256 }));
// Typed calls need no intermediate object. Unsorted maps are ordered at end().
const writer = new Writer({ maxBytes: 256 });
writer.beginMap(2).key('price').decimal(price).key('id').uint(7).end();
assert.deepEqual(writer.finish(), bytes);
assert.equal(decode(bytes).price.toString(), '1.5');
console.log('deterministic object and Writer encodings agree');
