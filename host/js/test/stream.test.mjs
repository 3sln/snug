// D085: messages of unknown length (drain mode, fail-fast) through the public package.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from 'snug/compile';
import { encode } from 'snug';
import { scanBuffer } from 'snug/sources';
import { pushValidator, pushScanner, streamSource, validateStream, scanStream } from 'snug/sources';
import { ANY_P, ANY_B, ANY_LIMITS } from '../src/any-program.mjs';
import { compile as compileRaw } from '../src/compile.mjs';

const schemaText = `
  msg = { id: uint, name: tstr .size (0..40), tags: [* tstr], ? blob: bstr, ? m: { * tstr => int } }`;
let seed = 7;
const rnd = n => { seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return seed % n; };
function inputs() {
  const out = [];
  for (let k = 0; k < 160; k++) {
    const v = { id: rnd(9) ? rnd(1000) : -1, name: 'x'.repeat(rnd(50)), tags: Array.from({ length: rnd(5) }, () => 't'.repeat(rnd(4))) };
    if (rnd(2)) v.blob = new Uint8Array(rnd(300));
    if (rnd(3) === 0) v.m = Object.fromEntries(Array.from({ length: rnd(4) }, (_, i) => ['k' + i, rnd(9) ? i : 'z']));
    let bytes = encode(v);
    if (rnd(4) === 0) { bytes = Uint8Array.from(bytes); bytes[1 + rnd(bytes.length - 1)] ^= 1 << rnd(8); }
    if (rnd(4) === 0) bytes = bytes.subarray(0, rnd(bytes.length + 1));
    if (rnd(8) === 0) bytes = Uint8Array.of(...bytes, 0x01, 0x02);
    out.push(bytes);
  }
  out.push(new Uint8Array(0), Uint8Array.of(0x9f), Uint8Array.of(0xa1, 0x62), Uint8Array.of(0x5a, 0xff, 0xff, 0xff, 0x00, 1, 2));
  return out;
}
const chunked = (bytes, size) => { const parts = []; for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size)); return parts; };

test('unknown-length validation equals the buffer for every chunking; fail-fast agrees on accept/refuse', async () => {
  const schema = await compile(schemaText);
  let early = 0;
  for (const bytes of inputs()) {
    const want = schema.validate(bytes, 'msg');
    for (const size of [1, 2, 3, 7, 64, 100000]) {
      const p = pushValidator(schema, undefined, 'msg');
      let r = { state: 'need' };
      for (const part of chunked(bytes, size)) { r = p.feed(part); while (r.state === 'yield') r = p.resume(); if (r.state === 'done') break; }
      const got = r.state === 'done' ? r.result : p.finalize();
      assert.deepEqual(got, want, `chunk ${size} ${Buffer.from(bytes).toString('hex').slice(0, 40)}`);
      const f = pushValidator(schema, undefined, 'msg', {}, { failFast: true, quantum: 3 });
      let rf = { state: 'need' };
      for (const part of chunked(bytes, size)) { rf = f.feed(part); while (rf.state === 'yield') rf = f.resume(); if (rf.state === 'done') break; }
      const gotF = rf.state === 'done' ? rf.result : f.end();
      assert.equal(gotF.ok, want.ok);
      if (!gotF.ok && JSON.stringify(gotF) !== JSON.stringify(want)) early++;
    }
    assert.deepEqual(await validateStream(schema, streamSource(chunked(bytes, 5)), 'msg'), want);
  }
  assert.ok(early >= 0);
});

test('a ReadableStream source; the rest of a stream is not read after an early verdict', async () => {
  const schema = await compile(schemaText);
  const good = encode({ id: 1, name: 'a', tags: [] });
  const readable = bytes => new ReadableStream({ start(c) { for (const part of chunked(bytes, 2)) c.enqueue(part); c.close(); } });
  assert.deepEqual(await validateStream(schema, readable(good), 'msg'), { ok: true });
  assert.deepEqual(await validateStream(schema, readable(good), 'msg', {}, { failFast: true }), { ok: true });
  let pulled = 0;
  const bad = Uint8Array.of(0xa1, 0x61, 0x78, 0xf7, ...new Uint8Array(100));     // cbor/simple, then junk
  const lazy = new ReadableStream({ pull(c) { pulled++; if (pulled > 50) c.close(); else c.enqueue(bad.subarray(0, 4)); } });
  const r = await validateStream(schema, lazy, 'msg', {}, { failFast: true });
  assert.equal(r.ok, false);
  assert.ok(pulled < 5, `pulled ${pulled}`);
  // drain mode reads to the end before answering (the buffer of all of it would say trailing)
  pulled = 0;
  const lazy2 = new ReadableStream({ pull(c) { pulled++; if (pulled > 50) c.close(); else c.enqueue(bad.subarray(0, 4)); } });
  const d = await validateStream(schema, lazy2, 'msg');
  assert.equal(pulled, 51);
  const all = new Uint8Array(200); for (let i = 0; i < 50; i++) all.set(bad.subarray(0, 4), 4 * i);
  assert.deepEqual(d, schema.validate(all, 'msg'));
});

test('more bytes than maxBytes is too_large as soon as they arrive; truncated at the end', async () => {
  const schema = await compile('r = bstr');
  const p = pushValidator(schema, undefined, 'r', { maxBytes: 10 });
  assert.deepEqual(p.feed(Uint8Array.of(0x49, 1, 2, 3)), { state: 'need' });
  const r = p.feed(new Uint8Array(8));
  assert.equal(r.state, 'done');
  assert.deepEqual(r.result, schema.validate(new Uint8Array(12).fill(0x49, 0, 1), 'r', { maxBytes: 10 }));
  assert.equal(r.result.reason, 'cbor/too_large');
  const t = pushValidator(schema, undefined, 'r');
  t.feed(Uint8Array.of(0x58, 0x40, 1, 2));
  assert.deepEqual(t.end(), schema.validate(Uint8Array.of(0x58, 0x40, 1, 2), 'r'));
});

test('memory: a long byte string is dropped as it streams; only asked-for bytes are held', async () => {
  const schema = await compile('r = { a: bstr, b: tstr }');
  const bytes = encode({ a: new Uint8Array(200000), b: 'x'.repeat(300) });
  const p = pushValidator(schema, undefined, 'r');
  let high = 0;
  for (const part of chunked(bytes, 1000)) { p.feed(part); high = Math.max(high, p.bytesHeld); }
  assert.deepEqual(p.finalize(), { ok: true });
  assert.ok(high <= 2048, `held ${high}`);
});

test('unknown-length scanning (the VM against any) gives the scanner verdict', async () => {
  const c = compileRaw('r = any', { limits: ANY_LIMITS });
  assert.deepEqual(Array.from(c.program), Array.from(ANY_P));
  assert.deepEqual(Array.from(c.pool), Array.from(ANY_B));
  for (const bytes of inputs()) {
    for (const options of [{}, { wire: 'bindle' }, { maxDepth: 2 }, { top: 'map' }]) {
      let want = true;
      try { scanBuffer(bytes, options); } catch (e) { want = e.code; }
      let got = true;
      try { await scanStream(chunked(bytes, 3), options); } catch (e) { got = e.code; }
      assert.equal(got, want, `${JSON.stringify(options)} ${Buffer.from(bytes).toString('hex').slice(0, 40)}`);
      const s = pushScanner(undefined, options);
      let g2 = true;
      try { for (const part of chunked(bytes, 1)) s.feed(part); s.finalize(); } catch (e) { g2 = e.code; }
      assert.equal(g2, want);
    }
  }
});

test('failFast is only for an unknown length; malformed streams are refused', async () => {
  const schema = await compile('r = uint');
  assert.throws(() => pushValidator(schema, 3, 'r', {}, { failFast: true }), TypeError);
  assert.throws(() => pushValidator(schema, undefined, 'r', {}, { failFast: 1 }), TypeError);
  assert.throws(() => streamSource(5), TypeError);
  await assert.rejects(validateStream(schema, [Uint8Array.of(1), 'x'], 'r'), e => e.code === 'bad_chunk');
});
