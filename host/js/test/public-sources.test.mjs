import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from 'snug/compile';
import { Schema } from 'snug/schema';
import { encode } from 'snug';
import * as sources from 'snug/sources';

test('public entry points expose schema source validation and advanced sessions', () => {
  for (const name of ['openSession', 'validateHandle', 'validateHandleSync', 'pushValidator'])
    assert.equal(typeof sources[name], 'function', name);
  assert.equal(typeof Schema.prototype.session, 'undefined');
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
  const session = sources.openSession(schema, 'r', bytes.length, {}, { quantum: 1 });
  assert.equal(session.length, bytes.length);
  assert.ok(session.bytesHeld > 0);
  assert.deepEqual(Object.keys(session), []);
  assert.equal(session.program, undefined);
  assert.throws(() => sources.openSession(schema, 'private-rule', bytes.length), e =>
    e instanceof TypeError && !e.message.includes('private-rule'));
  assert.throws(() => sources.openSession(schema, 'r', -1), TypeError);
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

test('openSession uses the owned verified Program after loading, without trusting lookalikes', async () => {
  const { fromSerialized } = await import('snug/schema');
  const { chars } = await import('snug/controls');
  const compiled = await compile('r = tstr .chars 2', { controls: { chars } });
  const schema = await fromSerialized(compiled.program.serialize(), { controls: { chars } });
  const copy = schema.program.P; copy.fill(0);
  for (const value of ['éx', 'abc']) {
    const bytes = encode(value);
    assert.deepEqual(sources.openSession(schema, 'r', bytes.length).step(bytes, 0),
      { state: 'done', result: schema.validate(bytes, 'r') });
  }
  for (const fake of [null, undefined, {}, { program: schema.program }, Object.create(schema)])
    assert.throws(() => sources.openSession(fake, 'r', 1), TypeError);
  assert.throws(() => sources.openSession(schema, 1, 1), TypeError);
});

test('raw unknown-length sessions settle pending checks at EOF and preserve held verdicts', async () => {
  const schema = await compile('r = [bstr, uint]');
  for (const bytes of [Uint8Array.of(0x82, 0x42, 1), encode([new Uint8Array([1, 2]), 3]),
    encode([new Uint8Array([1]), 'private-value']), Uint8Array.of(0x82, 0x41, 1, 2, 0)]) {
    for (const quantum of [0, 1, 3]) {
      const session = sources.openSession(schema, 'r', undefined, { maxBytes: 32 }, { quantum });
      assert.equal(session.length, undefined); assert.equal(session.limit, 32);
      let step;
      do { step = session.step(bytes, 0); } while (step.state === 'yield');
      assert.notEqual(step.state, 'done', 'unknown length waits for EOF');
      step = session.end(bytes.length);
      while (step.state === 'yield') step = session.step(bytes, 0);
      assert.deepEqual(step, { state: 'done', result: schema.validate(bytes, 'r', { maxBytes: 32 }) });
      assert.deepEqual(session.end(bytes.length), step);
    }
  }
});

test('a throwing control poisons only its session; independent sessions can continue', async () => {
  const cause = new Error('predicate failure');
  let fail = true;
  const schema = await compile('r = tstr .check 0', { controls: { check() { if (fail) throw cause; return true; } } });
  const bytes = encode('x'), a = sources.openSession(schema, 'r', bytes.length), b = sources.openSession(schema, 'r', bytes.length);
  let failure;
  assert.throws(() => a.step(bytes, 0), e => { failure = e; return e.cause === cause; });
  fail = false;
  assert.deepEqual(b.step(bytes, 0), { state: 'done', result: { ok: true } });
  assert.throws(() => a.step(bytes, 0), e => e === failure);
  assert.deepEqual(schema.validate(bytes, 'r'), { ok: true });
});
