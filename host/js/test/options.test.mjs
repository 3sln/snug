import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, profiles, Tagged, SnugFault } from 'snug';
import { compile } from 'snug/compile';
import { validate, decode as schemaDecode, validateAt } from 'snug/schema';
import { Writer } from 'snug/writer';
import { view } from 'snug/view';
import * as sources from 'snug/sources';

const schema = await compile('r = { id: uint }\nid = uint', {
  limits: { inputBytes: 32, depth: 3, entries: 4, items: 12, budget: 1000 },
});
const bytes = encode({ id: 7 }), handle = sources.bufferHandle(bytes);
const numberBad = [null, -1, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1,
  '1', 'private-option-value', true, 1n, [], {}, Symbol('private-option-value')];
const boolBad = [null, 0, 1, 'true', 'private-option-value', [], {}];
const enumBad = [null, 0, true, 'banana', 'private-option-value', 'toString', [], {},
  { toString() { throw new Error('private-coercion'); } }];
const malformedBags = [null, false, 1, NaN, Infinity, 'private-option-value', 1n, [], new Date(), () => {}];
const presetKeys = ['wire', 'keys', 'tags', 'floats', 'undefinedValue', 'noncharacters', 'top', 'cose', 'strictArrays'];
const limitKeys = ['maxBytes', 'maxDepth', 'maxEntries', 'maxItems'];
const decodeKeys = [...presetKeys, ...limitKeys, 'objects'];
const validationKeys = [...decodeKeys, 'maxBignumBytes', 'budget'];
const encodeKeys = [...presetKeys, ...limitKeys, 'objects', 'omitUndefined'];
const compileLimits = ['schemaBytes', 'nesting', 'astNodes', 'instantiations', 'alternatives',
  'arrayPositions', 'regexpPositions', 'width', 'poolBytes', 'totalBytes', 'compileBudget',
  'leaves', 'depth', 'inputBytes', 'entries', 'items', 'bignumBytes', 'budget'];
const badFor = key => [...limitKeys, ...compileLimits, 'maxBignumBytes', 'chunk', 'quantum', 'delay'].includes(key)
  ? numberBad : ['cose', 'strictArrays', 'undefinedValue', 'noncharacters', 'omitUndefined', 'keysSorted', 'borrow', 'directories'].includes(key)
    ? boolBad : key === 'rule' ? [null, false, 1, {}, []]
      : key === 'schema' ? [null, false, 1, {}, { validate() {} }]
        : key === 'unicode' ? [null, false, 1, {}, [], new Uint8Array()]
          : key === 'limits' ? malformedBags : enumBad;

// These calls deliberately use package exports, including schema-first helpers.
const entries = [
  ['decode', decodeKeys, o => decode(bytes, o)],
  ['encode', encodeKeys, o => encode({ id: 7 }, o)],
  ['Writer', [...encodeKeys, 'keysSorted', 'limits'], o => new Writer(o)],
  ['Schema.validate', validationKeys, o => schema.validate(bytes, 'r', o)],
  ['Schema.decode', validationKeys, o => schema.decode(bytes, 'r', o)],
  ['Schema.validateAt', [...validationKeys, 'depth', 'items'], o => schema.validateAt(bytes, 0, bytes.length, 'r', o)],
  ['validate helper', validationKeys, o => validate(schema, bytes, 'r', o)],
  ['decode helper', validationKeys, o => schemaDecode(schema, bytes, 'r', o)],
  ['validateAt helper', [...validationKeys, 'depth', 'items'], o => validateAt(schema, bytes, 0, bytes.length, 'r', o)],
  ['openSession', validationKeys, o => sources.openSession(schema, 'r', bytes.length, o)],
  ['openSession scheduling', ['quantum'], o => sources.openSession(schema, 'r', bytes.length, {}, o)],
  ['view', [...validationKeys, 'schema', 'rule', 'borrow', 'directories'], o => view(bytes, o)],
  ['schema view', [...validationKeys, 'schema', 'rule', 'borrow', 'directories'], o => view(bytes,
    Object.defineProperties({ schema, rule: 'r' }, Object.getOwnPropertyDescriptors(o)))],
  ['View.validateAt', ['schema'], o => view(bytes, { schema, rule: 'r' }).validateAt('r', o)],
  ['scanBuffer', decodeKeys, o => sources.scanBuffer(bytes, o)],
  ['scanHandle', decodeKeys, o => sources.scanHandle(handle, o)],
  ['scanHandleSync', decodeKeys, o => sources.scanHandleSync(handle, o)],
  ['ScanSession', decodeKeys, o => new sources.ScanSession(bytes.length, o)],
  ['ScanSession scheduling', ['quantum'], o => new sources.ScanSession(bytes.length, {}, o)],
  ['pushScanner', decodeKeys, o => sources.pushScanner(bytes.length, o)],
  ['pushScanner scheduling', ['quantum'], o => sources.pushScanner(bytes.length, {}, o)],
  ['validateHandle', validationKeys, o => sources.validateHandle(schema, handle, 'r', o)],
  ['validateHandleSync', validationKeys, o => sources.validateHandleSync(schema, handle, 'r', o)],
  ['pushValidator', validationKeys, o => sources.pushValidator(schema, bytes.length, 'r', o)],
  ['pushValidator scheduling', ['quantum'], o => sources.pushValidator(schema, bytes.length, 'r', {}, o)],
  ['scanHandle sourceOptions', ['chunk', 'quantum'], o => sources.scanHandle(handle, {}, o)],
  ['scanHandleSync sourceOptions', ['chunk', 'quantum'], o => sources.scanHandleSync(handle, {}, o)],
  ['validateHandle sourceOptions', ['chunk', 'quantum'], o => sources.validateHandle(schema, handle, 'r', {}, o)],
  ['validateHandleSync sourceOptions', ['chunk', 'quantum'], o => sources.validateHandleSync(schema, handle, 'r', {}, o)],
  ['asyncHandle', ['delay'], o => sources.asyncHandle(bytes, o)],
  ['compile', ['profile', 'limits', 'unicode'], o => compile('r = uint', o)],
  ['compile limits', compileLimits, o => compile('r = uint', { limits: o })],
  ['Writer limits', limitKeys, o => new Writer({ limits: o })],
];
const allKeys = [...new Set(entries.flatMap(([, keys]) => keys)), 'maxByets', 'failFast', 'private-option-key', '__proto__', 'toString'];

function safeTypeError(key) {
  return error => {
    assert.ok(error instanceof TypeError, `expected TypeError, received ${error?.name}`);
    assert.ok(error.message.includes(key), `message must name ${key}`);
    assert.ok(!/private-|banana|NaN|Infinity/.test(error.message), 'error must not echo option values/unknown keys');
    assert.ok(!('reason' in error), 'configuration is never a data refusal');
    return true;
  };
}
async function refuses(call, options, key) {
  await assert.rejects(async () => call(options), safeTypeError(key));
}

for (const [name, keys, call] of entries) test(`options: ${name} rejects malformed values and unknown keys`, async () => {
  for (const key of keys) for (const value of badFor(key))
    await refuses(call, { [key]: value }, key);
  for (const key of allKeys) if (!keys.includes(key))
    await refuses(call, { [key]: 'private-option-value' }, 'option');
  for (const key of [Symbol('private-option-key'), 'private-hidden-key']) {
    const options = Object.defineProperty({}, key, { value: 'private-option-value' });
    await refuses(call, options, 'option');
  }
  // The schema-backed opener merges its options; exercise bag shape on the raw opener separately.
  if (name !== 'schema view') for (const bag of malformedBags) await refuses(call, bag, 'options');
  if (keys.includes('quantum')) await refuses(call, { quantum: 2 ** 31 }, 'quantum');
  if (keys.includes('chunk')) await refuses(call, { chunk: 0 }, 'chunk');
});

test('options: malformed configuration wins over CBOR refusals and source reads', async () => {
  const badBytes = Uint8Array.of(0xff);
  const neverRead = { size: 1, read() { assert.fail('configuration must fail before any read'); } };
  for (const options of [{ maxBytes: 'x' }, { maxDepth: 1.5 }, { maxItems: -1 }, { budget: '1' }, { top: 'banana' }]) {
    const key = Object.keys(options)[0];
    for (const call of [o => schema.validate(badBytes, 'r', o), o => schema.decode(badBytes, 'r', o),
      o => schema.validateAt(badBytes, 0, 1, 'r', o), o => view(badBytes, { schema, rule: 'r', ...o }),
      o => sources.validateHandle(schema, neverRead, 'r', o), o => sources.validateHandleSync(schema, neverRead, 'r', o)])
      await refuses(call, options, key);
  }
  assert.throws(() => new Writer({ maxBytes: 'x', limits: { maxBytes: 32 } }), safeTypeError('maxBytes'));
  assert.throws(() => new Writer({ limits: { maxByets: 32 } }), safeTypeError('limits'));
});

test('options: valid presets, defaults, zero bounds, compiled caps and Writer precedence survive', async () => {
  for (const preset of Object.values(profiles)) {
    assert.equal(decode(bytes, preset).id, 7);
    assert.deepEqual(encode({ id: 7 }, preset), bytes);
    assert.deepEqual(new Writer(preset).value({ id: 7 }).finish(), bytes);
    assert.deepEqual(schema.validate(bytes, 'r', preset), { ok: true });
    assert.equal(schema.decode(bytes, 'r', preset).id, 7);
    assert.deepEqual(schema.validateAt(bytes, 0, bytes.length, 'r', preset), { ok: true });
    assert.equal(view(bytes, { ...preset, schema, rule: 'r' }).get('id').int(), 7);
    assert.equal(view(bytes, preset).get('id').int(), 7);
    assert.equal(sources.scanHandleSync(handle, preset), true);
    assert.deepEqual(await sources.validateHandle(schema, handle, 'r', preset), { ok: true });
    assert.deepEqual(sources.openSession(schema, 'r', bytes.length, preset).step(bytes, 0).result, { ok: true });
  }
  assert.equal(schema.validate(bytes, 'r', { maxBytes: 0 }).reason, 'cbor/too_large');
  assert.equal(schema.validate(bytes, 'r', { budget: 0 }).reason, 'budget');
  const over = encode({ id: 7, extra: 'x'.repeat(40) });
  assert.equal(schema.validate(over, 'r', { maxBytes: Number.MAX_SAFE_INTEGER }).reason, 'cbor/too_large');
  assert.throws(() => decode(bytes, { maxBytes: 0 }), SnugFault);
  assert.deepEqual(new Writer({ maxBytes: 0, limits: { maxBytes: 32 } }).value({ id: 7 }).finish(), bytes);
  assert.throws(() => new Writer({ maxBytes: 32, limits: { maxBytes: 0 } }).value({ id: 7 }).finish(), { code: 'too_large' });
  assert.equal(decode(bytes, { objects: 'plain' }).constructor, Object);
  assert.deepEqual(encode(decode(bytes, { objects: 'plain' }), { objects: 'plain', top: 'map' }), bytes);
  assert.equal(decode(bytes, Object.create(null)).id, 7);
  assert.equal(decode(bytes, { maxBytes: undefined }).id, 7);
  assert.deepEqual((await compile('r = uint', { limits: { inputBytes: undefined } })).validate(Uint8Array.of(7), 'r'), { ok: true });
  // Writer-specific options must not leak into the tag-24 profile check.
  assert.ok(new Writer({ keysSorted: true, omitUndefined: true, limits: { maxBytes: 32 } })
    .value(new Tagged(24, Uint8Array.of(7))).finish().length > 0);
});

test('options: non-enumerable known limits are checked and forwarded without being dropped', async () => {
  const zero = Object.defineProperty({}, 'maxBytes', { value: 0 });
  assert.throws(() => view(bytes, zero), { code: 'too_large' });
  assert.throws(() => view(bytes, Object.defineProperty({ schema, rule: 'r' }, 'maxBytes', { value: 0 })), { code: 'too_large' });
  assert.throws(() => new Writer({ maxBytes: 32, limits: zero }).value({ id: 7 }).finish(), { code: 'too_large' });
  const compiled = await compile('r = uint', { limits: Object.defineProperty({}, 'inputBytes', { value: 0 }) });
  assert.equal(compiled.validate(Uint8Array.of(7), 'r').reason, 'cbor/too_large');
});

for (const [kind, make] of [['Uint8Array', b => new Uint8Array(b)], ['Buffer', b => Buffer.from(b)]]) {
  for (const [name, create] of [['bufferHandle', sources.bufferHandle], ['asyncHandle', sources.asyncHandle],
    ['asyncHandle timer', b => sources.asyncHandle(b, { delay: 1 })]]) {
    test(`snapshot: ${name} owns ${kind} input and keeps reads independent`, async () => {
      // A subrange ensures neither backing-buffer padding nor byteOffset is lost.
      const backing = make(Uint8Array.of(99, ...bytes, 99));
      const input = backing.subarray(1, backing.length - 1), h = create(input);
      const pending = h.read(0, h.size);
      backing.fill(0);
      const first = await pending;
      assert.deepEqual(first, bytes);
      first.fill(0);
      assert.deepEqual(await h.read(0, h.size), bytes);
      assert.equal(decode(await h.read(0, h.size)).id, 7);
      assert.deepEqual(await sources.validateHandle(schema, h, 'r', {}, { chunk: 1 }), { ok: true });
      if (name === 'bufferHandle') assert.deepEqual(sources.validateHandleSync(schema, h, 'r'), { ok: true });
      assert.ok(Object.isFrozen(h));
    });
  }
}

test('snapshot: helpers reject invalid/shared input rather than fabricate a snapshot', () => {
  for (const make of [sources.bufferHandle, sources.asyncHandle]) {
    for (const bytes of [null, 'private-bytes', [], new ArrayBuffer(1), new Uint8Array(new SharedArrayBuffer(1))])
      assert.throws(() => make(bytes), e => e instanceof TypeError && !e.message.includes('private-'));
  }
});
