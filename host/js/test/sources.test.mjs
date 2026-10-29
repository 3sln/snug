// P6.1: every source gives the buffer fast path's verdict (bb rscan-test holds the
// resumable scanner itself to the recursive one under every window split).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanBuffer, scanHandle, scanHandleSync, pushScanner, bufferHandle, asyncHandle, SourceError } from '../src/sources.mjs';
import { encode } from '../../../bench/baseline/cbor-3sln.mjs';

const vectors = JSON.parse(readFileSync(new URL('../../../corpus/cbor-vectors/cbor-profile.json', import.meta.url)));
const all = [...vectors.accept, ...vectors.refuse].map(v => ({ name: v.name, bytes: new Uint8Array(Buffer.from(v.hex, 'hex')) }));
const ANY = { top: 'any' };
const verdict = f => { try { f(); return 'ok'; } catch (e) { if (e.name === 'SnugFault') return e.code; throw e; } };
const averdict = async p => { try { await p; return 'ok'; } catch (e) { if (e.name === 'SnugFault') return e.code; throw e; } };
const nested = (() => { const docs = []; for (let d = 0; d < 2000; d++) docs.push({ [`k${d % 7}`]: d, long: 'é'.repeat(d % 50), [`key-${'x'.repeat(d % 40)}`]: { a: 1, b: [1.5, d] } }); return encode({ docs }); })();

function pushAll(bytes, options, sizes, quantum = 0) {
  const p = pushScanner(bytes.length, options, { quantum });
  let i = 0, k = 0;
  try {
    while (i < bytes.length) {
      const n = sizes[k++ % sizes.length];
      let r = p.feed(bytes.subarray(i, i + n)); i += n;
      while (r.state === 'yield') r = p.resume();
    }
    p.finalize();
    return 'ok';
  } catch (e) { if (e.name === 'SnugFault') return e.code; throw e; }
}

test('every vector: sync handle, async handle and push source agree with the buffer path', async () => {
  for (const { name, bytes } of all) {
    const want = verdict(() => scanBuffer(bytes, ANY));
    for (const chunk of [1, 7, 65536]) {
      assert.equal(verdict(() => scanHandleSync(bufferHandle(bytes), ANY, { chunk })), want, `${name} sync ${chunk}`);
      assert.equal(await averdict(scanHandle(asyncHandle(bytes), ANY, { chunk })), want, `${name} async ${chunk}`);
    }
    assert.equal(pushAll(bytes, ANY, [1, 0, 3, 2]), want, `${name} push`);
    assert.equal(pushAll(bytes, ANY, [bytes.length || 1]), want, `${name} push whole`);
  }
});

test('a large nested document through every source, small chunks and tiny quanta', async () => {
  const want = verdict(() => scanBuffer(nested));
  assert.equal(want, 'ok');
  assert.equal(verdict(() => scanHandleSync(bufferHandle(nested), {}, { chunk: 1024 })), want);
  assert.equal(await averdict(scanHandle(asyncHandle(nested), {}, { chunk: 16384, quantum: 3 })), want);
  assert.equal(pushAll(nested, {}, [1000, 1, 17], 2), want);
  const bad = nested.slice(); bad[bad.length - 3] = 0xff;
  const wantBad = verdict(() => scanBuffer(bad));
  assert.notEqual(wantBad, 'ok');
  assert.equal(await averdict(scanHandle(asyncHandle(bad), {}, { chunk: 1024, quantum: 1 })), wantBad);
  assert.equal(pushAll(bad, {}, [333]), wantBad);
});

test('async reads are pulled one at a time, forward, and only when the scanner asks', async () => {
  let inflight = 0, max = 0, last = -1, reads = 0;
  const base = asyncHandle(nested, { delay: 1 });
  const handle = { size: base.size, read: async (off, len) => {
    inflight++; max = Math.max(max, inflight); reads++;
    assert.ok(off >= last, 'reads move forward'); last = off;
    try { return await base.read(off, len); } finally { inflight--; }
  } };
  assert.equal(await scanHandle(handle, {}, { chunk: 65536 }), true);
  assert.equal(max, 1);
  assert.ok(reads <= Math.ceil(nested.length / 65536) + 2, `${reads} reads`);
});

test('two interleaved async sessions keep separate state', async () => {
  const other = encode({ z: [1, 2, 3], a: 'x'.repeat(5000) });
  const bad = other.slice(); bad[2] = 0x1c;
  const results = await Promise.all([
    averdict(scanHandle(asyncHandle(nested), {}, { chunk: 777, quantum: 5 })),
    averdict(scanHandle(asyncHandle(bad), {}, { chunk: 13, quantum: 1 })),
    averdict(scanHandle(asyncHandle(other), {}, { chunk: 64, quantum: 2 })),
  ]);
  assert.deepEqual(results, ['ok', verdict(() => scanBuffer(bad)), 'ok']);
});

test('tiny yield quanta never change a verdict', async () => {
  for (const { name, bytes } of all) {
    const want = verdict(() => scanBuffer(bytes, ANY));
    for (const quantum of [1, 2, 3]) assert.equal(await averdict(scanHandle(asyncHandle(bytes), ANY, { chunk: 5, quantum })), want, `${name} q${quantum}`);
  }
});

test('a source that breaks its declared length is a SourceError, not a CBOR verdict; an empty chunk is not EOF', () => {
  const bytes = encode({ a: 1, b: 'hello' });
  const short = pushScanner(bytes.length, {});
  short.feed(bytes.subarray(0, bytes.length - 1));
  assert.throws(() => short.finalize(), e => e instanceof SourceError && e.code === 'length_mismatch');
  // A declared length longer than the item is the message's own verdict: trailing bytes.
  assert.throws(() => pushScanner(bytes.length + 1, {}).feed(bytes), e => e.name === 'SnugFault' && e.code === 'trailing');
  const long = pushScanner(bytes.length - 1, {});
  assert.throws(() => long.feed(bytes), e => e instanceof SourceError);
  const p = pushScanner(bytes.length, {});
  assert.equal(p.feed(new Uint8Array(0)).state, 'need');
  assert.equal(p.feed(bytes.subarray(0, 3)).state, 'need');
  assert.equal(p.feed(new Uint8Array(0)).state, 'need');
  p.feed(bytes.subarray(3));
  assert.equal(p.finalize(), true);
  const lying = { size: 10, read: () => new Uint8Array(3) };
  assert.throws(() => scanHandleSync(lying, {}), e => e instanceof SourceError && e.code === 'short_read');
});
