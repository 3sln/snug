import assert from 'node:assert/strict';
import { encode } from '../host/js/src/index.mjs';
import { compile } from '../host/js/src/public-compile.mjs';
import { asyncHandle, validateHandle } from '../host/js/src/public-sources.mjs';

const schema = await compile('message = { id: uint, body: tstr .size (0..1024) }');
const bytes = encode({ id: 7, body: 'hello from a snapshot' });
// This helper copies ordinary Uint8Array input and resolves reads asynchronously.
// Remote handles must pin a version themselves and return exact requested ranges.
const result = await validateHandle(schema, asyncHandle(new Uint8Array(bytes)), 'message', {},
  { chunk: 8, quantum: 4 });
assert.deepEqual(result, schema.validate(bytes, 'message'));
assert.deepEqual(result, { ok: true });
console.log('validated a CDDL schema over an asynchronous in-memory handle');
