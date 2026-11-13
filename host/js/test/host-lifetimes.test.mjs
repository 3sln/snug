// P9.13 WP2: host resource and lifetime fixes -- each test fails without its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '@3sln/snug/compile';
import { encode, decode } from '@3sln/snug';
import { view } from '@3sln/snug/view';
import { openSession, sessionLimits, releasePool, validateStream, scanStream, pushValidator, pushScanner } from '@3sln/snug/sources';
import { sequenceReader } from '@3sln/snug/sequence';
import { testing } from '../src/session-pool.mjs';

test('CODE-S1/S2: end() of a voided session answers its predicate error and never touches re-leased arrays; end() inside its own step is refused', async () => {
  let boom = true, inner = null, reentry = null;
  const schema = await compile('r = [ uint .ok 0, tstr ]', { controls: { ok: () => {
    if (inner) { try { inner.end(3); } catch (e) { reentry = e; } return true; }
    if (boom) throw new Error('predicate failed');
    return true;
  } } });
  const b = encode([1, 'x']);
  const handed = [];
  testing.handout = e => handed.push(e);
  try {
    releasePool();
    const s = openSession(schema, 'r');          // unknown length
    const sE = handed.at(-1);
    assert.throws(() => s.step(b, 0), /extension control .ok threw/);
    boom = false;
    const t = openSession(schema, 'r');          // takes s's arrays from the pool
    assert.equal(handed.at(-1), sE, 'the voided session\'s arrays were reused');
    const before = Array.from(sE.ss);
    assert.throws(() => s.end(b.length), e => e.cause?.message === 'predicate failed');
    assert.deepEqual(Array.from(sE.ss), before, 'end() of the voided session wrote nothing');
    t.step(b, 0);
    let r = t.end(b.length);
    while (r.state === 'yield') r = t.step(b, 0);
    assert.equal(r.result.ok, true);
    // busy: end() from a predicate inside the session's own step
    inner = openSession(schema, 'r');
    inner.step(b, 0);
    assert.match(reentry?.message ?? '', /cannot be resumed concurrently/);
    inner.close();
  } finally { testing.handout = null; }
});

test('CODE-S3: failed streams release their sessions (validateStream, scanStream, push sources)', async () => {
  const schema = await compile('r = [ uint, tstr ]');
  const b = encode([1, 'x']);
  const base = sessionLimits().live;
  async function* reset() { yield b.subarray(0, 1); throw new Error('network reset'); }
  async function* notBytes() { yield b.subarray(0, 1); yield 'not bytes'; }
  for (let i = 0; i < 20; i++) {
    await assert.rejects(validateStream(schema, reset(), 'r'), /network reset/);
    await assert.rejects(validateStream(schema, notBytes(), 'r'), e => e.code === 'bad_chunk');
    await assert.rejects(scanStream(reset(), { wire: 'valid' }), /network reset/);
    await assert.rejects(scanStream(notBytes()), e => e.code === 'bad_chunk');
  }
  assert.equal(sessionLimits().live, base, '80 failed streams hold no session');
  // a push source that throws is released too
  for (const p of [pushValidator(schema, undefined, 'r'), pushValidator(schema, b.length, 'r'), pushScanner(undefined)]) {
    assert.throws(() => p.feed('not bytes'), TypeError);
  }
  assert.equal(sessionLimits().live, base);
  // and the slots are usable: maxLive more streams still open
  const limits = sessionLimits();
  sessionLimits({ maxLive: base + 1 });
  try { assert.equal((await validateStream(schema, [b], 'r')).ok, true); }
  finally { sessionLimits({ maxLive: limits.maxLive }); }
});

test('SEC-F4: an extension control gets copies holding exactly its argument and item', async () => {
  const seen = [];
  const schema = await compile('r = [ tstr .ok "arg", tstr .ok "arg" ]', { controls: { ok: (a, item) => {
    seen.push([a.buffer.byteLength, a.length, item.buffer.byteLength, item.length]);
    a.fill(0); item.fill(0);   // a predicate that writes changes nothing of snug's
    return true;
  } } });
  // valid, non-deterministic input: the VM walks its canonical copy in the isolate's shared buffer
  const b = Uint8Array.of(0x9f, 0x7f, 0x61, 0x61, 0xff, 0x63, 0x61, 0x62, 0x63, 0xff);
  for (let i = 0; i < 2; i++) assert.equal(schema.validate(b, 'r', { wire: 'valid' }).ok, true);
  assert.ok(seen.length >= 4);
  for (const [ab, al, ib, il] of seen) { assert.equal(ab, al); assert.equal(ib, il); }
});

test('SEC-F2: maxDepth above 256 is a TypeError everywhere (as Rust\'s Limits)', async () => {
  const schema = await compile('r = any');
  const deep = new Uint8Array(301).fill(0x81); deep[300] = 0;
  const o = { maxDepth: 257 };
  assert.throws(() => decode(deep, o), TypeError);
  assert.throws(() => view(deep, o), TypeError);
  assert.throws(() => encode([1], o), TypeError);
  assert.throws(() => schema.validate(deep, 'r', o), TypeError);
  assert.throws(() => openSession(schema, 'r', deep.length, o), TypeError);
  assert.throws(() => sequenceReader(o), TypeError);
  await assert.rejects(validateStream(schema, [deep], 'r', o), TypeError);
  // 256 is the ceiling, and deep input under it is a refusal, never a stack overflow
  assert.throws(() => decode(deep, { maxDepth: 256 }), e => e.code === 'depth');
  assert.equal(schema.validate(deep, 'r', { maxDepth: 256 }).reason, 'cbor/depth');
});

test('SEC-F5: validateAt\'s enclosing item count is clamped, never wrapped', async () => {
  const schema = await compile('r = uint');
  const b = Uint8Array.of(0x81, 0x01);
  assert.equal(schema.validateAt(b, 1, 2, 'r', { items: 0 }).ok, true);
  // 2^32 would wrap to 0 in a 32-bit word and accept; clamped it is over any item cap
  assert.equal(schema.validateAt(b, 1, 2, 'r', { items: 2 ** 32 }).reason, 'cbor/too_many_items');
});

test('Decision 5: an undefined value for an optional member is refused naming its key', async () => {
  const schema = await compile('r = { ? name: tstr, id: uint }');
  const b = encode({ id: 1, name: undefined });   // omitUndefined stays false: name is written as f7
  assert.deepEqual(schema.validate(b, 'r'), { ok: false, reason: 'type', path: ['name'], offset: 10 });
  assert.throws(() => schema.decode(b, 'r'), e => e.code === 'schema/type' && e.path.join() === 'name');
  assert.equal(schema.validate(encode({ id: 1, name: undefined }, { omitUndefined: true }), 'r').ok, true);
});
