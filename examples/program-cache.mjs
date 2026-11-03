import assert from 'node:assert/strict';
import { encode } from '../host/js/src/index.mjs';
import { compile } from '../host/js/src/public-compile.mjs';
import { fromSerialized } from '../host/js/src/public-schema.mjs';

const schema = await compile('message = { id: uint }');
// Put these bytes in a trusted, quota-bounded cache keyed by sourceKey.
const stored = schema.program.serialize();
const cached = await fromSerialized(stored); // digest + vm-verify; no compiler
assert.equal(cached.program.sourceKey, schema.program.sourceKey);
assert.deepEqual(cached.program.serialize(), stored);
assert.deepEqual(cached.validate(encode({ id: 7 }), 'message'), { ok: true });
console.log('loaded a verified Program from its deterministic container');
