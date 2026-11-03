import assert from 'node:assert/strict';
import { encode } from '../host/js/src/index.mjs';
import { compile } from '../host/js/src/public-compile.mjs';
import { view } from '../host/js/src/public-view.mjs';
import { validateAt } from '../host/js/src/public-schema.mjs';

const schema = await compile('doc = { items: [* item] }\nitem = { id: uint }');
const bytes = encode({ items: [{ id: 7 }, { id: 8 }] });
const root = view(bytes, { schema, rule: 'doc' }); // owns a checked copy
const item = root.get('items').at(1);
assert.equal(item.get('id').number(), 8);
assert.deepEqual(item.validateAt('item'), { ok: true });
assert.deepEqual(validateAt(schema, bytes, item.offset, item.offset + item.raw().length, 'item', {
  depth: item.depth,
}), { ok: true });
const cursor = root.cursor();
assert.equal(cursor.find('items'), true);
assert.equal(cursor.enter(), true);
assert.equal(cursor.next(), true);
assert.equal(cursor.view().get('id').number(), 8);
console.log('navigated and validated a nested span');
