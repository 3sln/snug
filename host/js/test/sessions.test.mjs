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
  // D327 note (2026-11-12): in `npm test` every file shares one isolate, and earlier files leave the 2 MiB
  // pool all but full (within ~1 KiB, by how much depending on when GC drops collected Programs' pools);
  // under 352 bytes of room `a` was dropped instead of pooled and the reuse assertion failed. Start empty.
  releasePool();
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
  releasePool();   // room in the pool, so the scribbled arrays are kept and reused (not dropped)
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

// D347: a session (or sequence reader) closed by an extension predicate from inside its own step kept
// writing its arrays after giving them back, so the next session (opened in the same predicate) shared them
test('regression D347: a session closed inside its own step keeps its arrays until the step ends', async () => {
  const handed = [];
  let outer = null, inner = null, outerE = null;
  const schema = await compile('r = [ uint .ok 0, tstr ]', { controls: { ok: () => {
    if (outer && !inner) {
      outer.close();
      const from = handed.length;
      inner = openSession(schema, 'r', b.length);
      assert.equal(handed.length, from + 1);
      assert.notEqual(handed[from], outerE, 'the closed session\'s arrays are not handed out while its step runs');
    }
    return true;
  } } });
  const b = encode([1, 'x']);
  testing.handout = e => handed.push(e);
  try {
    releasePool();
    openSession(schema, 'r', b.length).step(b, 0);         // one entry in the Program's pool
    const base = sessionLimits().live;
    outer = openSession(schema, 'r', b.length); outerE = handed.at(-1);
    assert.throws(() => outer.step(b, 0), /closed during its step/);
    assert.equal(sessionLimits().live, base + 1);           // outer released at the step's end; inner live
    assert.equal(inner.step(b, 0).result.ok, true);
    assert.equal(sessionLimits().live, base);
    assert.throws(() => outer.step(b, 0), /closed/);
  } finally { testing.handout = null; }
});

test('regression D347: a sequence reader closed inside its own step keeps its arrays until the step ends', async () => {
  const handed = [];
  let reader = null, inner = null, readerE = null;
  const schema = await compile('r = [ uint .ok 0, tstr ]', { controls: { ok: () => {
    if (reader && !inner) {
      reader.close();
      const from = handed.length;
      inner = openSession(schema, 'r', b.length);
      assert.notEqual(handed[from], readerE, 'the closed reader\'s arrays are not handed out while its step runs');
    }
    return true;
  } } });
  const b = encode([1, 'x']);
  testing.handout = e => handed.push(e);
  try {
    releasePool();
    const warm = sequenceReader({ schema, rule: 'r' }); warm.feed(b); warm.close();   // one pooled entry
    const base = sessionLimits().live;
    reader = sequenceReader({ schema, rule: 'r' }); readerE = handed.at(-1);
    const res = reader.feed(Uint8Array.of(...b, ...b));
    assert.deepEqual([res.messages.length, /closed during its step/.test(res.error?.message), reader.done], [0, true, true]);
    assert.equal(sessionLimits().live, base + 1);           // the reader released; inner live
    assert.equal(inner.step(b, 0).result.ok, true);
    assert.equal(sessionLimits().live, base);
  } finally { testing.handout = null; }
});

// D327/D347 property: whatever order sessions finish, close, err or are abandoned (and collected), every
// array the pool hands out is all zero, and none is held by a session still live
test('property: pooled arrays handed out are all zero and never held by a live session', { skip: typeof globalThis.gc !== 'function' && 'needs --expose-gc' }, async () => {
  const schemas = [await schemaP, await compile('r = [* { * tstr => any }]'),
    await compile('r = [ uint .ok 0, tstr ]', { controls: { ok: () => true } })];
  const inputs = [[encode({ id: 7, body: 'hello' }), encode({ id: 1, body: 'x'.repeat(200) })],
    [encode([{ a: 1, b: 2 }]), encode([{ x: 'y'.repeat(300) }, { k: 1 }])], [encode([1, 'x']), encode([2, 'yz'])]];
  let seed = 0x9e3779b9;
  const rnd = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  const held = new Set();       // arrays of the sessions this test still holds live
  let handouts = 0, reused = 0;
  let last = null;
  testing.handout = (e, r) => {
    handouts++; if (r) reused++; last = e;
    for (const a of [e.s, e.ss, e.ka]) {
      assert.ok(a.every(x => x === 0), 'a handed-out array is all zero');
      assert.ok(!held.has(a), 'a handed-out array is not held by a live session');
    }
  };
  testing.scribble = true;
  try {
    releasePool();
    const open = [];
    const end = (o, how) => {
      if (how === 0 && o.r) { if (o.fed < o.b.length) o.r.feed(o.b.subarray(o.fed)); o.r.end(); }
      else if (how === 0) { const b = o.b; for (let at = 0; at < b.length && !o.s.verdict;) { const r = o.s.step(b.subarray(at, at + 1 + rnd(8)), at); if (r.state === 'need') at = r.offset; else break; } }
      else if (how === 1) (o.r ?? o.s).close();
      // how 2: abandoned (left to the FinalizationRegistry)
      for (const a of o.arrays) held.delete(a);
    };
    for (let i = 0; i < 3000; i++) {
      const k = rnd(3), b = inputs[k][rnd(2)];
      // a session or (one in four) a sequence reader; part of the message, or none of it
      const o = rnd(4) ? { s: openSession(schemas[k], 'r', b.length), b } : { r: sequenceReader({ schema: schemas[k], rule: 'r' }), b, fed: 0 };
      o.arrays = [last.s, last.ss, last.ka];
      for (const a of o.arrays) held.add(a);
      if (rnd(2)) { const part = b.subarray(0, rnd(b.length)); if (o.r) { if (part.length) o.r.feed(part); o.fed = part.length; } else o.s.step(part, 0); }
      if (o.s?.verdict || o.r?.done) { for (const a of o.arrays) held.delete(a); continue; }   // ended already
      open.push(o);
      while (open.length > rnd(12)) end(open.splice(rnd(open.length), 1)[0], rnd(3));
      if (rnd(200) === 0) { globalThis.gc(); await new Promise(r => setImmediate(r)); }
    }
    for (const o of open.splice(0)) end(o, 1);
    assert.ok(reused > 100 && handouts >= 3000, `reused ${reused} of ${handouts}`);
  } finally { testing.scribble = false; testing.handout = null; }
});
