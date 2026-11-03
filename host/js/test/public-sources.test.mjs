import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from 'snug/compile';
import { Schema } from 'snug/schema';
import { encode } from 'snug';
import * as sources from 'snug/sources';

test('public entry points expose schema source validation and advanced sessions', () => {
  for (const name of ['validateHandle', 'validateHandleSync', 'pushValidator'])
    assert.equal(typeof sources[name], 'function', name);
  assert.equal(typeof Schema.prototype.session, 'function');
});

test('public schema sources match buffer success, schema refusal, profile refusal and budget', async () => {
  const schema = await compile('r = { id: uint, body: tstr .regexp "a+" }');
  const cases = [
    [encode({ id: 7, body: 'a'.repeat(300) }), {}],
    [encode({ id: 'wrong', body: 'aaa' }), {}],
    [encode({ 'private-key': 'private-value' }), {}],
    [Uint8Array.of(0xbf, 0xff), {}],
    [encode({ id: 7, body: 'aaa' }), { budget: 1 }],
  ];
  await Promise.all(cases.map(async ([bytes, options]) => {
    const expected = schema.validate(bytes, 'r', options);
    assert.ok(!JSON.stringify(expected).includes('private-'));
    assert.deepEqual(await sources.validateHandle(schema, sources.asyncHandle(bytes), 'r', options,
      { chunk: 3, quantum: 1 }), expected);
    assert.deepEqual(sources.validateHandleSync(schema, sources.bufferHandle(bytes), 'r', options,
      { chunk: 1, quantum: 2 }), expected);
    const push = sources.pushValidator(schema, bytes.length, 'r', options, { quantum: 1 });
    assert.equal(push.feed(new Uint8Array()).state, 'need');
    for (let i = 0; i < bytes.length; i += 2) {
      let step = push.feed(bytes.subarray(i, i + 2));
      while (step.state === 'yield') {
        await new Promise(resolve => setImmediate(resolve));
        step = push.resume();
      }
      if (step.state === 'done') assert.deepEqual(step.result, expected);
    }
    assert.deepEqual(push.finalize(), expected);
  }));
});

test('public schema source errors remain distinct from verdicts and read errors propagate', async () => {
  const schema = await compile('r = { id: uint }');
  const bytes = encode({ id: 7 });
  await assert.rejects(sources.validateHandle(schema, { size: bytes.length, read: async () => new Uint8Array() }, 'r'),
    e => e instanceof sources.SourceError && e.code === 'short_read');
  assert.throws(() => sources.validateHandleSync(schema, sources.asyncHandle(bytes), 'r'),
    e => e instanceof sources.SourceError && e.code === 'bad_chunk');
  const transport = new Error('transport unavailable');
  await assert.rejects(sources.validateHandle(schema, { size: bytes.length, read: async () => { throw transport; } }, 'r'),
    e => e === transport);
  const short = sources.pushValidator(schema, bytes.length, 'r');
  short.feed(bytes.subarray(0, bytes.length - 1));
  assert.throws(() => short.finalize(), e => e instanceof sources.SourceError && e.code === 'length_mismatch');
  assert.throws(() => sources.pushValidator(schema, bytes.length - 1, 'r').feed(bytes),
    e => e instanceof sources.SourceError && e.code === 'length_mismatch');
  // A byte string can be decided from its head; its remaining bytes are still owed.
  const blobSchema = await compile('r = bstr');
  const early = sources.pushValidator(blobSchema, 4, 'r');
  assert.equal(early.feed(Uint8Array.of(0x43)).state, 'done');
  assert.throws(() => early.finalize(), e => e instanceof sources.SourceError && e.code === 'length_mismatch');
  early.feed(Uint8Array.of(1, 2, 3));
  assert.deepEqual(early.finalize(), { ok: true });
});

test('public advanced sessions drive windows without exposing verified Program or scratch', async () => {
  const schema = await compile('r = { id: uint, body: tstr }');
  const bytes = encode({ id: 7, body: 'a'.repeat(100) });
  const session = schema.session('r', bytes.length, {}, { quantum: 1 });
  assert.equal(session.length, bytes.length);
  assert.ok(session.bytesHeld > 0);
  assert.deepEqual(Object.keys(session), []);
  assert.equal(session.program, undefined);
  assert.throws(() => schema.session('private-rule', bytes.length), e =>
    e instanceof TypeError && !e.message.includes('private-rule'));
  assert.throws(() => schema.session('r', -1), TypeError);
  assert.throws(() => session.step(bytes, -1), TypeError);
  assert.throws(() => session.step(new Uint8Array(new SharedArrayBuffer(1)), 0), TypeError);
  let window = new Uint8Array(), base = 0, yields = 0, needs = 0;
  for (;;) {
    const step = session.step(window, base);
    if (step.state === 'done') {
      assert.deepEqual(step.result, schema.validate(bytes, 'r'));
      break;
    }
    assert.ok(step.keep >= 0 && step.keep <= bytes.length);
    if (step.state === 'need') {
      needs++;
      base = step.offset;
      window = bytes.subarray(base, base + step.length);
    } else {
      yields++;
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  assert.ok(needs > 0 && yields > 0);
});
