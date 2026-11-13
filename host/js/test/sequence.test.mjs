// CBOR sequences (P7.13, D210-D217): the public readSequence / sequenceReader.
// The exhaustive differential is bb sequence-test; these pin the contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../src/index.mjs';
import { compile } from '../src/public-compile.mjs';
import { readSequence, sequenceReader } from '../src/public-sequence.mjs';
import { view } from '../src/public-view.mjs';

const schema = await compile('event = { type: tstr, ? n: uint, ? b: bstr }');
const events = [{ type: 'a', n: 1 }, { type: 'bb', b: new Uint8Array(40) }, { type: 'c' }, { type: 'dd', n: 1 << 20 }];
const parts = events.map(e => encode(e));
const cat = a => { const t = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of a) { t.set(x, o); o += x.length; } return t; };
const body = cat(parts);
const offsets = parts.reduce((a, p) => [...a, a[a.length - 1] + p.length], [0]);
const chunked = (bytes, w) => { const a = []; for (let i = 0; i < bytes.length; i += w) a.push(bytes.slice(i, i + w)); return a; };
async function collect(it) { const out = []; for await (const m of it) out.push(m); return out; }

test('messages carry index, absolute offset, exact bytes and a checked view', async () => {
  for (const w of [1, 3, 16, 1000]) {
    const got = await collect(readSequence(chunked(body, w), { schema, rule: 'event' }));
    assert.equal(got.length, events.length);
    got.forEach((m, i) => {
      assert.equal(m.index, i);
      assert.equal(m.offset, offsets[i]);
      assert.deepEqual(m.bytes, parts[i]);
      assert.deepEqual(m.view.value(), decode(parts[i]));
      assert.equal(m.view.get('type').text(), events[i].type);
      // borrowed exactly when the message lies inside one chunk
      const inside = Math.floor(offsets[i] / w) === Math.floor((offsets[i + 1] - 1) / w);
      assert.equal(m.borrowed, inside, `w ${w} message ${i}`);
      assert.equal(m.view.borrowed, m.borrowed);
    });
  }
});

test("copy: 'always' gives every message its own buffer; snug never writes to a chunk", async () => {
  const chunks = chunked(body, 1000), before = chunks.map(c => c.slice());
  const got = await collect(readSequence(chunks, { schema, rule: 'event', copy: 'always' }));
  assert.ok(got.every(m => !m.borrowed && m.bytes.buffer !== chunks[0].buffer));
  assert.deepEqual(chunks, before);
  // a recycled push buffer: with 'always' earlier messages survive the reuse
  const r = sequenceReader({ copy: 'always' }), buf = new Uint8Array(body.length);
  buf.set(body);
  const { messages } = r.feed(buf);
  buf.fill(0);
  assert.deepEqual(messages.map(m => m.view.value()), events.map(e => decode(encode(e))));
});

test('end of input: empty sequence, boundary, truncated tail; oversize is too_large', async () => {
  assert.deepEqual(await collect(readSequence([], {})), []);
  assert.deepEqual(await collect(readSequence([new Uint8Array(0), new Uint8Array(0)], {})), []);
  await assert.rejects(collect(readSequence([body.subarray(0, offsets[2] + 3)], {})),
    e => e.code === 'truncated' && e.index === 2 && e.messageOffset === offsets[2] && e.skippable === false);
  await assert.rejects(collect(readSequence(chunked(body, 7), { maxMessageBytes: 20 })),
    e => e.code === 'too_large' && e.index === 1 && e.offset === offsets[1]);
  // under fail-fast the oversize message is refused at once (the walk's code)
  const r = sequenceReader({ maxMessageBytes: 20, failFast: true });
  const first = r.feed(body.subarray(0, offsets[1] + 6));
  assert.equal(first.messages.length, 1);
  assert.equal(first.error.code, 'truncated');
  assert.equal(r.done, true);
  assert.throws(() => r.feed(body), TypeError);
});

test('onInvalid: skip drops schema refusals of complete messages only', async () => {
  const bad = encode({ type: 5 }), s = cat([parts[0], bad, parts[2]]);
  const it = readSequence(chunked(s, 5), { schema, rule: 'event', onInvalid: 'skip' });
  const got = await collect(it);
  assert.deepEqual(got.map(m => m.index), [0, 2]);
  assert.equal(it.stats.skipped, 1);
  assert.equal(it.stats.lastSkipped.index, 1);
  assert.equal(it.stats.lastSkipped.code, 'schema/type');
  assert.deepEqual(it.stats.lastSkipped.path, ['type']);
  await assert.rejects(collect(readSequence([s], { schema, rule: 'event' })),
    e => e.code === 'schema/type' && e.index === 1 && e.skippable === true && e.offset > e.messageOffset);
  // a wire refusal is never skipped. Under the default `valid` preset (D260) a
  // stray break is not well-formed: malformed (RFC 8949 §3.2.1, Appendix F;
  // docs/scanner.md; the RFC 8742 framer stops there too). Under `bindle`,
  // which refuses ai 31 at the head, the same byte is indefinite.
  const broken = cat([parts[0], Uint8Array.of(0xff), parts[2]]);
  await assert.rejects(collect(readSequence([broken], { schema, rule: 'event', onInvalid: 'skip' })),
    e => e.code === 'malformed' && e.index === 1 && e.offset === offsets[1] && e.skippable === false);
  await assert.rejects(collect(readSequence([broken], { schema, rule: 'event', onInvalid: 'skip', wire: 'bindle' })),
    e => e.code === 'indefinite' && e.index === 1 && e.offset === offsets[1] && e.skippable === false);
  // the push reader reports skipped refusals as they happen
  const r = sequenceReader({ schema, rule: 'event', onInvalid: 'skip' });
  const res = r.feed(s);
  assert.deepEqual([res.messages.length, res.skipped.length, res.error], [2, 1, undefined]);
});

test('profile-only sequences use the wire profile; bindle wants map roots', async () => {
  const items = [encode(1), encode('x'), encode([1, 2])];
  const got = await collect(readSequence([cat(items)], {}));
  assert.deepEqual(got.map(m => m.view.value()), [1, 'x', [1, 2]]);
  await assert.rejects(collect(readSequence([cat(items)], { wire: 'bindle' })), e => e.code === 'not_map' && e.index === 0);
  const maps = [encode({ a: 1 }), encode({ b: 2 })];
  assert.equal((await collect(readSequence([cat(maps)], { wire: 'bindle' }))).length, 2);
});

test('an accepted message is released as soon as its last byte arrives', () => {
  const r = sequenceReader({ schema, rule: 'event' });
  const seen = [];
  for (let i = 0; i < body.length; i++) {
    const { messages } = r.feed(body.subarray(i, i + 1));
    for (const m of messages) seen.push([m.index, i + 1]);
  }
  assert.deepEqual(seen, events.map((_, k) => [k, offsets[k + 1]]));
  assert.deepEqual(r.end(), { messages: [], skipped: [], error: undefined });
});

test('a ReadableStream source is read lazily and cancelled when the loop is left', async () => {
  let pulled = 0, cancelled = false;
  const stream = new ReadableStream({
    pull(c) { if (pulled < parts.length) c.enqueue(parts[pulled++].slice()); else c.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  for await (const m of readSequence(stream, { schema, rule: 'event' })) { if (m.index === 1) break; }
  assert.ok(pulled <= 3);
  assert.equal(cancelled, true);
});

test('options are checked before anything is read', () => {
  assert.throws(() => readSequence([], { maxBytes: 10 }), /maxMessageBytes/);
  assert.throws(() => readSequence([], { rule: 'event' }), /schema/);
  assert.throws(() => readSequence([], { schema, rule: 'nope' }), TypeError);
  assert.throws(() => readSequence([], { onInvalid: 'retry' }), TypeError);
  assert.throws(() => readSequence({}, {}), TypeError);
  assert.throws(() => sequenceReader({ quantum: 1 }), TypeError);
  const r = sequenceReader({});
  assert.throws(() => r.feed([1, 2]), TypeError);
  if (typeof SharedArrayBuffer === 'function') assert.throws(() => r.feed(new Uint8Array(new SharedArrayBuffer(4))), TypeError);
});

test('views equal a View opened on the message bytes', async () => {
  const got = await collect(readSequence(chunked(body, 9), { schema, rule: 'event' }));
  for (const m of got) {
    const v = view(m.bytes.slice(), { schema, rule: 'event' });
    assert.deepEqual(m.view.value(), v.value());
    assert.deepEqual(m.view.validateAt('event'), { ok: true });
  }
});

test('quantum yields change nothing', async () => {
  const a = await collect(readSequence(chunked(body, 5), { schema, rule: 'event', quantum: 1 }));
  assert.deepEqual(a.map(m => [m.index, m.offset, m.length]), parts.map((p, i) => [i, offsets[i], p.length]));
});

// ---------------------------------------------------------------- review 2026-11-04 findings

test('copy: always copies Node Buffer messages too (Buffer#slice aliases)', () => {
  for (const make of [b => Buffer.from(b), b => Uint8Array.from(b)]) {
    const chunk = make([1, 2]);
    const r = sequenceReader({ copy: 'always' });
    const { messages } = r.feed(chunk);
    chunk[0] = 9; chunk[1] = 9;
    assert.deepEqual(messages.map(m => [m.borrowed, m.view.number()]), [[false, 1], [false, 2]]);
  }
});

test('message fields are read-only and the view comes from the checked bytes', () => {
  const m = sequenceReader({}).feed(encode('ok')).messages[0];
  assert.throws(() => { m.bytes = Uint8Array.of(0x62, 0xc0, 0xae); }, TypeError);
  assert.throws(() => { m.index = 7; }, TypeError);
  assert.equal(m.view.text(), 'ok');
  assert.deepEqual(Object.keys(m), []);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), { index: 0, offset: 0, length: 3, borrowed: true });
});

test('every message is released by its own last byte (no wait for unrelated input)', async () => {
  const ok = { maxBytes: 64, check: () => true };
  const cases = [
    [await compile('r = uint .ok 0', { controls: { ok } }), 'r', [Uint8Array.of(1)]],
    [await compile('r = { text: tstr .ok 0 }', { controls: { ok } }), 'r', [encode({ text: 'a' })]],
    [null, null, [Uint8Array.of(0xd8, 0x28, 0x82, 0x81, 0x01, 0x81, 0x01)]],          // tag 40: shape [1], data [1]
    [null, null, [Uint8Array.of(0xa1, 0x81, 0x01, 0x02)]],                              // a non-text key: {[1]: 2}
  ];
  for (const [schema, rule, msgs] of cases) {
    const bytes = cat(msgs);
    const r = sequenceReader(schema ? { schema, rule } : {});
    let got = 0;
    for (let i = 0; i < bytes.length; i++) got += r.feed(bytes.subarray(i, i + 1)).messages.length;
    assert.equal(got, msgs.length, `released by its last byte: ${Buffer.from(bytes).toString('hex')}`);
  }
});

test('an exception from a predicate ends the sequence after the messages before it', async () => {
  const schema = await compile('r = uint .check 0', { controls: { check: { maxBytes: 1, check: (_a, item) => { if (item[0] === 2) throw new Error('predicate failed'); return true; } } } });
  for (const chunks of [[Uint8Array.of(1, 2)], [Uint8Array.of(1), Uint8Array.of(2)]]) {
    const seen = [];
    await assert.rejects(async () => { for await (const m of readSequence(chunks, { schema, rule: 'r' })) seen.push(m.view.number()); }, /extension control .check threw/);
    assert.deepEqual(seen, [1]);
  }
  const r = sequenceReader({ schema, rule: 'r' });
  const res = r.feed(Uint8Array.of(1, 2));
  assert.deepEqual([res.messages.length, /threw/.test(res.error?.message), r.done], [1, true, true]);
});

test('readSequence checks one message ahead of the consumer, not a whole chunk', async () => {
  let calls = 0;
  const schema = await compile('r = uint .count 0', { controls: { count: { maxBytes: 1, check: () => { calls++; return true; } } } });
  const it = readSequence([new Uint8Array(10000)], { schema, rule: 'r' });
  const first = await it.next();
  assert.equal(first.value.index, 0);
  assert.ok(calls <= 2, `${calls} messages checked before the first was consumed`);
  await it.return();
});

test('splitting many messages out of one assembly copies linearly', async () => {
  const schema = await compile('r = uint .ok 0', { controls: { ok: { maxBytes: 512, check: () => true } } });
  const r = sequenceReader({ schema, rule: 'r', maxMessageBytes: 512 });
  const all = [...r.feed(Uint8Array.of(0)).messages, ...r.feed(new Uint8Array(511)).messages, ...r.end().messages];
  assert.equal(all.length, 512);
  const backings = new Set(all.map(m => m.bytes.buffer));
  const retained = [...backings].reduce((n, b) => n + b.byteLength, 0);
  assert.ok(retained <= 4 * 512, `${retained} bytes retained for 512 bytes of messages`);
});

test('regression 2026-11-11: a complete 65,541-byte message followed by more than maxMessageBytes', () => {
  const big = new Uint8Array(1500001); big.set([0xa1, 0x61, 0x61, 0x59, 0xff, 0xff]); big[1500000] = 0xa0;
  for (const wire of ['bindle', 'deterministic']) {
    for (const cuts of [[big.length], [65536, big.length], [70000, big.length], [6, 65541, big.length]]) {
      const r = sequenceReader({ wire, top: 'map', maxMessageBytes: 1500000 });
      const got = [];
      let from = 0;
      for (const to of cuts) {
        const res = r.feed(big.subarray(from, to)); from = to;
        got.push(...res.messages.map(m => `m${m.index}+${m.length}`));
        if (res.error) { got.push(`x${res.error.index} ${res.error.code} @${res.error.offset}`); break; }
      }
      assert.deepEqual(got, ['m0+65541', 'x1 not_map @65541'], `${wire} ${cuts}`);
    }
  }
});

// D351: the shape sequence-test met -- an indefinite byte string completed in the same chunk as a following
// message that is refused and ends the reader, under valid CBOR and a Program with `.cbor`. The message's
// view equals a view opened on its bytes, and both read the canonical copy.
test('regression D351: an indefinite bstr message, then a refusal in the same chunk, under valid', async () => {
  const schema = await compile('r = bstr .cbor {a: int} / bstr .size (0..16)');
  const msg = [0x5f, 0x41, 0x00, 0x42, 0x01, 0x02, 0xff], bad = [0x51, ...new Array(17).fill(0xff)];
  const opts = { schema, rule: 'r', wire: 'valid' };
  const chunk = Uint8Array.of(0x44, 0xa1, 0x61, 0x61, 0x01, ...msg, ...bad);
  const seen = [];
  await assert.rejects(async () => {
    for await (const m of readSequence([chunk], opts)) seen.push([m.index, [...m.view.raw()], [...view(m.bytes.slice(), opts).raw()]]);
  }, e => e.index === 2);
  assert.deepEqual(seen, [[0, [0x44, 0xa1, 0x61, 0x61, 0x01], [0x44, 0xa1, 0x61, 0x61, 0x01]], [1, [0x43, 0, 1, 2], [0x43, 0, 1, 2]]]);
  const res = sequenceReader(opts).feed(chunk);
  assert.deepEqual([res.messages.map(m => [...m.view.raw()]), res.error?.index], [[[0x44, 0xa1, 0x61, 0x61, 0x01], [0x43, 0, 1, 2]], 2]);
});
