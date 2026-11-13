// P9.7 (D327): session arrays pooled per Program, a bound on live sessions per isolate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '@3sln/snug/compile';
import { encode, SnugFault } from '@3sln/snug';
import { openSession, sessionLimits, releasePool, pushValidator, validateHandleSync, bufferHandle } from '@3sln/snug/sources';
import { sequenceReader, sessionLimits as seqLimits, releasePool as releasePoolSeq } from '@3sln/snug/sequence';
import { acquire, release, testing } from '../src/session-pool.mjs';

const schemaP = compile('r = { id: uint, body: tstr }');
const bytes = encode({ id: 7, body: 'hello' });

test('sessionLimits: the same policy from snug/sources and snug/sequence; malformed limits are refused', () => {
  assert.equal(sessionLimits, seqLimits);
  const l = sessionLimits();
  assert.equal(l.maxLive, 1024);
  assert.equal(l.maxPooledBytes, 2 << 20);
  for (const bad of [{ maxLive: 0 }, { maxLive: 1.5 }, { maxPooledBytes: -1 }, { other: 1 }, null, 3])
    assert.throws(() => sessionLimits(bad), TypeError);
});

test('the live bound: one more session than maxLive throws sessions/limit; close() frees a slot', async () => {
  const schema = await schemaP;
  const before = sessionLimits();
  sessionLimits({ maxLive: before.live + 3 });
  try {
    const open = [0, 1, 2].map(() => openSession(schema, 'r', bytes.length));
    assert.equal(sessionLimits().live, before.live + 3);
    assert.throws(() => openSession(schema, 'r', bytes.length), e => {
      assert.ok(e instanceof SnugFault);
      assert.equal(e.code, 'sessions/limit');
      assert.match(e.message, /close\(\)/);
      return true;
    });
    // pushValidator, handles and sequence readers take a slot too
    assert.throws(() => pushValidator(schema, bytes.length, 'r'), e => e.code === 'sessions/limit');
    assert.throws(() => sequenceReader({}), e => e.code === 'sessions/limit');
    open[0].close();
    assert.throws(() => open[0].step(bytes, 0), TypeError);
    const s = openSession(schema, 'r', bytes.length);
    assert.equal(s.step(bytes, 0).result.ok, true);
    // a finished session has released its slot already; close() after it is harmless
    s.close(); s.close();
    for (const o of open.slice(1)) o[Symbol.dispose]();
    assert.equal(sessionLimits().live, before.live);
  } finally { sessionLimits({ maxLive: before.maxLive }); }
});

test('100,000 sessions that finish or close never come near the bound', async () => {
  const schema = await schemaP;
  const base = sessionLimits().live;
  let high = 0;
  for (let i = 0; i < 100000; i++) {
    const s = openSession(schema, 'r', bytes.length);
    high = Math.max(high, sessionLimits().live - base);
    if (i % 3 === 0) s.close();
    else assert.equal(s.step(bytes, 0).state, 'done');
  }
  assert.equal(high, 1);
  assert.equal(sessionLimits().live, base);
});

test('push sources, handles and sequence readers release their session when they end, err or close', async () => {
  const schema = await schemaP;
  const base = sessionLimits().live;
  const p = pushValidator(schema, bytes.length, 'r'); p.feed(bytes); p.finalize();
  const u = pushValidator(schema, undefined, 'r'); u.feed(bytes); u.end();
  const c = pushValidator(schema, bytes.length, 'r'); c.feed(bytes.subarray(0, 2)); c.close();
  assert.equal(validateHandleSync(schema, bufferHandle(bytes), 'r', {}, { chunk: 1 }).ok, true);
  assert.throws(() => validateHandleSync(schema, { size: 10, read: () => { throw new Error('io'); } }, 'r'));
  const r = sequenceReader({}); r.feed(Uint8Array.of(...bytes, ...bytes)); r.end();
  const a = sequenceReader({}); a.feed(bytes.subarray(0, 3)); a.close();
  assert.throws(() => a.feed(bytes), TypeError);
  assert.equal(sessionLimits().live, base);
});

test('pooled arrays are zeroed before reuse: no byte crosses from one session to the next', () => {
  const program = {};
  const a = acquire(program, 64, 16, 32);
  a.e.s.fill(7); a.e.ss.fill(7); a.e.ka.fill(7);
  const { s, ss, ka } = a.e;
  release(a);
  const b = acquire(program, 32, 16, 16);
  assert.equal(b.e.s, s, 'the pooled entry is reused');
  assert.ok(b.e.s.every(x => x === 0) && b.e.ss.every(x => x === 0) && b.e.ka.every(x => x === 0));
  assert.equal(b.e.ka, ka); assert.equal(b.e.ss, ss);
  release(b);
  // SS must match exactly (its length bounds the session's pending checks); a larger arena is reused
  const c = acquire(program, 32, 17, 64);
  assert.notEqual(c.e.ss, ss);
  release(c);
  // a release is idempotent and counts once
  const live = sessionLimits().live;
  const d = acquire(program, 8, 8, 8); release(d); release(d);
  assert.equal(sessionLimits().live, live);
});

test('an entry larger than 1 MiB (or a quarter of the pool) is not kept', () => {
  const program = {};
  // D342: earlier tests' sessions now pool (their key arenas start small), so start from an empty pool
  releasePool();
  const before = sessionLimits().pooledBytes;
  const big = acquire(program, (1 << 20) / 4 + 1, 8, 8);
  release(big);
  assert.equal(sessionLimits().pooledBytes, before);
  const small = acquire(program, 256, 8, 8);
  release(small);
  assert.ok(sessionLimits().pooledBytes > before);
});

test('pooled (scribbled on release) and fresh arrays give the same results', async () => {
  const schema = await compile('r = [* { * tstr => any }]');
  const inputs = [encode([{ a: 1, b: 2 }]), Uint8Array.of(0x81, 0xa2, 0x61, 0x62, 0x02, 0x61, 0x61, 0x01),
    Uint8Array.of(0x9f, 0xbf, 0x61, 0x61, 0x01, 0xff, 0xff), Uint8Array.of(0x81, 0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02),
    Uint8Array.of(0x81, 0xa1, 0x61), encode([{ x: 'y'.repeat(300) }])];
  const run = () => inputs.flatMap(b => [1, 3, 4096].map(chunk => JSON.stringify(validateHandleSync(schema, bufferHandle(b), 'r', {}, { chunk }))));
  const pooled = sessionLimits().maxPooledBytes;
  testing.scribble = true;
  const a = run(), a2 = run();
  testing.scribble = false;
  sessionLimits({ maxPooledBytes: 0 });
  const f = run();
  sessionLimits({ maxPooledBytes: pooled });
  assert.deepEqual(a, f);
  assert.deepEqual(a2, f);
});

test('releasePool drops every idle entry; later sessions behave the same', async () => {
  const schema = await schemaP;
  const run = () => [1, 4, 64].map(chunk => JSON.stringify(validateHandleSync(schema, bufferHandle(bytes), 'r', {}, { chunk })));
  const before = run();
  assert.ok(sessionLimits().pooledBytes > 0);
  releasePool();
  assert.equal(sessionLimits().pooledBytes, 0);
  assert.deepEqual(run(), before);
  assert.ok(sessionLimits().pooledBytes > 0);
  assert.equal(releasePoolSeq, releasePool);
});

test('an abandoned session is released when it is collected', { skip: typeof globalThis.gc !== 'function' && 'needs --expose-gc' }, async () => {
  const schema = await schemaP;
  // settle sessions other tests abandoned first, then abandon one
  const settle = async () => { for (let i = 0; i < 10; i++) { globalThis.gc(); await new Promise(r => setTimeout(r, 10)); } };
  await settle();
  const base = sessionLimits().live;
  (() => { openSession(schema, 'r', bytes.length); })();
  assert.equal(sessionLimits().live, base + 1);
  await settle();
  assert.equal(sessionLimits().live, base);
});
