import assert from 'node:assert/strict';
import { encode } from '../host/js/src/index.mjs';
import { compile } from '../host/js/src/public-compile.mjs';
import { openSession } from '../host/js/src/public-sources.mjs';

const schema = await compile('message = { id: uint, body: tstr }');
const bytes = encode({ id: 7, body: 'a window at a time' });
// Advanced custom driver. Prefer validateHandle / pushValidator for normal sources.
const session = openSession(schema, 'message', bytes.length, {}, { quantum: 4 });
let window = new Uint8Array(), base = 0, step;
for (;;) {
  step = session.step(window, base);
  if (step.state === 'done') break;
  if (step.state === 'need') {
    base = step.offset;
    window = bytes.subarray(base, base + step.length);
  } else await new Promise(resolve => setImmediate(resolve));
}
assert.deepEqual(step.result, schema.validate(bytes, 'message'));
console.log('validated through openSession from snug/sources');
