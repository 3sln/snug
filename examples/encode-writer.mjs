import assert from 'node:assert/strict';
import { encode, decode, Decimal } from '@3sln/snug';
import { Writer } from '@3sln/snug/writer';

for (const [text, normalized] of [['1.50', '1.5'], ['2.00', '2'], ['0.00', '0']]) {
  const price = Decimal.from(text);
  const bytes = encode({ price, id: 7 }, { maxBytes: 256 });
  assert.deepEqual(bytes, encode({ id: 7, price }, { maxBytes: 256 }));
  // Typed calls need no intermediate object. Unsorted maps are ordered at end().
  const writer = new Writer({ maxBytes: 256 });
  // Integral factory results are numbers/bigints; value() admits those too.
  writer.beginMap(2).key('price').value(price).key('id').uint(7).end();
  assert.deepEqual(writer.finish(), bytes);
  assert.equal(decode(bytes).price.toString(), normalized);
}
// Decimal is an exact number, not fixed-scale money: presentation scale is lost.
console.log('deterministic object and Writer encodings agree');
