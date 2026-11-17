import assert from 'node:assert/strict';
import { decode, encode } from '@3sln/snug';
import { compile } from '@3sln/snug/compile';

const schema = await compile('message = { id: uint, text: tstr .size (0..80) }');
const bytes = encode({ text: 'hello', id: 7 }, { maxBytes: 256 });
const value = schema.decode(bytes, 'message');
assert.equal(value.id, 7);
assert.equal(value.text, 'hello');
assert.deepEqual(decode(bytes), value);
assert.equal(Object.getPrototypeOf(value), null);
console.log('decoded checked message');
