// P6.1: every source gives the buffer fast path's verdict (bb rscan-test holds the
// resumable scanner itself to the recursive one under every window split).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openSession, scanBuffer, scanHandle, scanHandleSync, pushScanner, bufferHandle, asyncHandle, SourceError } from '../src/sources.mjs';
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

// ---------------------------------------------------------------- P6.2: schema validation over sources
import { compile as compileSchema } from '../src/schema.mjs';
import { validateHandle, validateHandleSync, pushValidator } from '../src/sources.mjs';

function pushValidate(schema, bytes, rule, options, sizes, quantum = 0) {
  const p = pushValidator(schema, bytes.length, rule, options, { quantum });
  let i = 0, k = 0;
  while (i < bytes.length) {
    const n = sizes[k++ % sizes.length];
    let r = p.feed(bytes.subarray(i, i + n)); i += n;
    while (r.state === 'yield') r = p.resume();
  }
  return p.finalize();
}

const suites = [];
for (const file of ['study', 'adversarial', 'audit-2026-11-04']) {
  const j = JSON.parse(readFileSync(new URL(`../../../corpus/conformance/${file}.json`, import.meta.url)));
  for (const su of j.suites) if (su.cddl && !su.schemaError && !su.snugSchemaError && su.phase !== 'later') suites.push(su);
}

test('P6.2: every corpus case through sync and async handles and the push source gives Schema.validate\'s result', async () => {
  let n = 0;
  for (const su of suites) {
    let schema;
    try { schema = await compileSchema(su.cddl); } catch { continue; }
    for (const k of su.cases) {
      const bytes = new Uint8Array(Buffer.from(k.hex, 'hex'));
      const opts = { top: 'any', cose: su.options?.cose === true, ...(su.options?.maxItems !== undefined ? { maxItems: su.options.maxItems } : {}) };
      const want = schema.validate(bytes, k.rule, opts);
      for (const [chunk, quantum] of [[1, 0], [3, 1], [65536, 0], [7, 2]]) {
        assert.deepEqual(validateHandleSync(schema, bufferHandle(bytes), k.rule, opts, { chunk, quantum }), want, `${su.name} sync ${chunk}/${quantum}`);
        assert.deepEqual(await validateHandle(schema, asyncHandle(bytes), k.rule, opts, { chunk, quantum }), want, `${su.name} async ${chunk}/${quantum}`);
      }
      assert.deepEqual(pushValidate(schema, bytes, k.rule, opts, [1, 0, 2]), want, `${su.name} push`);
      assert.deepEqual(pushValidate(schema, bytes, k.rule, opts, [bytes.length || 1], 1), want, `${su.name} push whole`);
      n++;
    }
  }
  assert.ok(n > 500, `${n} cases`);
});

const BIG = `doc = { docs: [* entry] }
entry = { * tstr => int / tstr / entry / [* number] }`;
const bigDoc = (() => { const docs = []; for (let d = 0; d < 1500; d++) docs.push({ [`k${d % 7}`]: d, long: 'é'.repeat(d % 50), [`key-${'x'.repeat(d % 400)}`]: { a: 1, b: [1.5, d] } }); return encode({ docs }); })();

test('P6.2: a large document with long keys through every source, small chunks and tiny quanta', async () => {
  const schema = await compileSchema(BIG);
  const want = schema.validate(bigDoc, 'doc');
  assert.deepEqual(want, { ok: true });
  assert.deepEqual(validateHandleSync(schema, bufferHandle(bigDoc), 'doc', {}, { chunk: 1024 }), want);
  assert.deepEqual(await validateHandle(schema, asyncHandle(bigDoc), 'doc', {}, { chunk: 16384, quantum: 3 }), want);
  assert.deepEqual(pushValidate(schema, bigDoc, 'doc', {}, [1000, 1, 17], 2), want);
  const bad = bigDoc.slice(); bad[bad.length - 9] = 0xff;
  const wantBad = schema.validate(bad, 'doc');
  assert.equal(wantBad.ok, false);
  assert.deepEqual(await validateHandle(schema, asyncHandle(bad), 'doc', {}, { chunk: 1024, quantum: 1 }), wantBad);
  assert.deepEqual(pushValidate(schema, bad, 'doc', {}, [333]), wantBad);
  const tight = { budget: 20000 };
  const wantBudget = schema.validate(bigDoc, 'doc', tight);
  assert.equal(wantBudget.reason, 'budget');
  assert.deepEqual(await validateHandle(schema, asyncHandle(bigDoc), 'doc', tight, { chunk: 333, quantum: 2 }), wantBudget);
});

test('P6.2: interleaved async sessions on one schema keep separate state', async () => {
  const schema = await compileSchema(BIG);
  const other = encode({ docs: [{ z: [1, 2, 3], a: 'x'.repeat(5000) }] });
  const bad = other.slice(); bad[12] = 0x1c;
  const wrong = encode({ docs: [{ a: 1.5 }, { b: [1, 'x'] }] });
  const results = await Promise.all([
    validateHandle(schema, asyncHandle(bigDoc), 'doc', {}, { chunk: 777, quantum: 5 }),
    validateHandle(schema, asyncHandle(bad), 'doc', {}, { chunk: 13, quantum: 1 }),
    validateHandle(schema, asyncHandle(other), 'doc', {}, { chunk: 64, quantum: 2 }),
    validateHandle(schema, asyncHandle(wrong), 'doc', {}, { chunk: 3, quantum: 1 }),
  ]);
  assert.deepEqual(results, [{ ok: true }, schema.validate(bad, 'doc'), { ok: true }, schema.validate(wrong, 'doc')]);
  assert.equal(results[3].ok, false);
});

test('P6.2: async session reads are pulled one at a time, only when the session asks', async () => {
  const schema = await compileSchema(BIG);
  let inflight = 0, max = 0, reads = 0;
  const base = asyncHandle(bigDoc, { delay: 1 });
  const handle = { size: base.size, read: async (off, len) => {
    inflight++; max = Math.max(max, inflight); reads++;
    try { return await base.read(off, len); } finally { inflight--; }
  } };
  assert.deepEqual(await validateHandle(schema, handle, 'doc', {}, { chunk: 65536 }), { ok: true });
  assert.equal(max, 1);
  assert.ok(reads <= Math.ceil(bigDoc.length / 65536) * 2 + 2, `${reads} reads`);
});

test('P6.2: a declared-length mismatch is a SourceError, not a verdict; an empty chunk is not EOF', async () => {
  const schema = await compileSchema('r = { a: int, b: tstr }');
  const bytes = encode({ a: 1, b: 'hello' });
  const short = pushValidator(schema, bytes.length, 'r');
  short.feed(bytes.subarray(0, bytes.length - 1));
  assert.throws(() => short.finalize(), e => e instanceof SourceError && e.code === 'length_mismatch');
  const long = pushValidator(schema, bytes.length - 1, 'r');
  assert.throws(() => long.feed(bytes), e => e instanceof SourceError && e.code === 'length_mismatch');
  // a declared length longer than the item is the message's own verdict: trailing
  const over = pushValidator(schema, bytes.length + 1, 'r');
  over.feed(bytes); over.feed(new Uint8Array([0]));
  assert.equal(over.finalize().reason, 'cbor/trailing');
  const p = pushValidator(schema, bytes.length, 'r');
  assert.equal(p.feed(new Uint8Array(0)).state, 'need');
  assert.equal(p.feed(bytes.subarray(0, 3)).state, 'need');
  assert.equal(p.feed(new Uint8Array(0)).state, 'need');
  p.feed(bytes.subarray(3));
  assert.deepEqual(p.finalize(), { ok: true });
  const lying = { size: 10, read: () => new Uint8Array(3) };
  assert.throws(() => validateHandleSync(schema, lying, 'r'), e => e instanceof SourceError && e.code === 'short_read');
  await assert.rejects(validateHandle(schema, { size: 10, read: async () => new Uint8Array(3) }, 'r'), e => e instanceof SourceError);
  assert.throws(() => validateHandleSync(schema, asyncHandle(bytes), 'r'), e => e instanceof SourceError);
});

test('P6.2: a session owns its arrays; after the verdict it answers the verdict again', async () => {
  const schema = await compileSchema('r = [* tstr]');
  const bytes = encode(['a', 'bb', 'ccc']);
  const a = openSession(schema, 'r', bytes.length), b = openSession(schema, 'r', bytes.length);
  assert.notEqual(a, b);
  assert.equal(a.bytesHeld, b.bytesHeld);
  for (const session of [a, b]) for (const key of ['ss', 's', 'ka', 'program']) assert.equal(session[key], undefined);
  let r = a.step(bytes.subarray(0, 2), 0);
  assert.equal(r.state, 'need');
  r = b.step(bytes, 0);
  assert.deepEqual(r.result, { ok: true });
  r = a.step(bytes.subarray(r.offset ?? 2), 2);
  if (r.state === 'need') r = a.step(bytes.subarray(r.offset), r.offset);
  assert.deepEqual(r.result, { ok: true });
  assert.deepEqual(a.step(new Uint8Array(0), 0).result, { ok: true });
});

test('P6.2: a quantum yield at the declared end is stepped by finalize, not a length mismatch', async () => {
  assert.equal(pushAll(Uint8Array.from([0x82, 0x18, 0x18]), { top: 'any' }, [3], 1), 'truncated');
  const schema = await compileSchema('r = bstr .cbor { a: int }');
  const bytes = Uint8Array.from([0x43, 0xa1, 0x61, 0x62]);
  const want = schema.validate(bytes, 'r');
  for (const quantum of [0, 1, 2, 3]) {
    const v = pushValidator(schema, bytes.length, 'r', {}, { quantum });
    let s = v.feed(bytes);
    while (s.state === 'yield') s = v.resume();
    assert.deepEqual(v.finalize(), want, `quantum ${quantum}`);
  }
});

import { pickYield } from '../src/sources.mjs';
test('P6.2: the yield helper prefers scheduler.yield, setImmediate, MessageChannel, and setTimeout only last', async () => {
  const noTimer = () => { throw new Error('setTimeout must not be chosen'); };
  const y = pickYield({ MessageChannel, setTimeout: noTimer });
  assert.equal(y.kind, 'MessageChannel');
  await y.turn(); await y.turn();
  y.dispose();
  let used = 0;
  assert.equal(pickYield({ scheduler: { yield: async () => { used++; } }, setImmediate, MessageChannel, setTimeout: noTimer }).kind, 'scheduler.yield');
  await pickYield({ scheduler: { yield: async () => { used++; } } }).turn();
  assert.equal(used, 1);
  assert.equal(pickYield({ setImmediate, MessageChannel, setTimeout: noTimer }).kind, 'setImmediate');
  assert.equal(pickYield({ setTimeout }).kind, 'setTimeout');
});

test('P9.9 addendum P5/hang (seed 7001290, index 130): a session over the copy of a refused map ends at once', async () => {
  // r = { * tstr => any } on a 718-byte map refused for depth at offset 63 (maxDepth 1): the session's valid run
  // walks the canonical copy, which stops at the refusal; the map streak skipped an `any` value with tskip into
  // the bytes past that stop -- 97 s of uncharged work on a66224a. Now the streak stops before such a pair.
  const s = await compileSchema('r = { * tstr => any }');
  const b = Uint8Array.from(Buffer.from(
    'a5655ce6b0b430581a8c4235a2fba9f3136c68222f41cceb95dc73418ffb00fe2313bb66224162dfbf7a3b718e0eec6eaa8bca6b00e0a080e4b8ad7fc3bc5cba79a899716e005cc280c3bce6b0b4f090859161d828828105d84654fc237378a392074134f6cca0891d06ded557b1137902387fdfbfc280efbfaf2041c280f0908591efbfaf7fc3a9c3a94120e4b8ade0a0807ae4b8ad5cdfbf6230c3a9c28062efbfafe4b8ad617a30e6b0b462dfbf5c30e6b0b4f09f988061dfbff090859122f09f988061e6b0b430e0a080dfbfe6b0b4c280e4b8ade6b0b4c3a96161c3bc20e6b0b4efbfaff0908591c3bc7a7a7ac280f09f98806161dfbf00dfbfc3bcefbfafe6b0b420c3a962f09f988062e0a0807ff09f9880205cf0908591c280c3a930c3bcc3a9c3a9c3bc200030e0a080c3a92262f09f9880dfbfefbfaf7ae4b8ad202222dfbfdfbf627ac3bcc3bc6161c3bc007f7f2220f09f988022c280c2800062c3bcf09f988041e4b8ad41c3a900dfbff09f988022e4b8adefbfaf7a41f09085917fc3bce0a08062c2805ce6b0b4413062c3a920dfbff090859161227f62207ac3a9efbfaf6162627aefbfaf2262c3bc227a7adfbff09f98807f7fc3bcf0908591c3a9c28020c280c280412262627ae4b8adc3bcefbfaf622230c3bcf0908591f09f9880f09f9880007fc280306222c28020c3a962dfbf62dfbfc3bcdfbfe6b0b4e0a080626100e0a080dfbf7a5cc3a9c280c3bc41dfbf00e4b8ad627f7f5cc3a9efbfafefbfafc3bc0022e6b0b462e0a0805cc3a920efbfaf7fdfbf22f09f988030efbfaf20417fdfbfc280617ae6b0b441f09f988062e6b0b4e4b8adc3a922c3bcefbfafe4b8addfbf5ce0a080f09085914100c3a930c280e6b0b47ac3a9007ff0908591005ce0a08061c3bc41c28000e4b8ad307af0908591e4b8adf09f9880e4b8ad7f7fc280417fd85658203433339d8f3e943f0000202a6003464000000000000000809a9999999999f13f',
    'hex'));
  const o = { top: 'any', maxDepth: 1 };
  const want = { ok: false, reason: 'cbor/depth', path: [], offset: 63 };
  assert.deepEqual(s.validate(b, 'r', o), want);
  const t0 = process.hrtime.bigint();
  assert.deepEqual(validateHandleSync(s, bufferHandle(b), 'r', o, { chunk: 65536 }), want);
  const p = pushValidator(s, b.length, 'r', o);
  p.feed(b);
  assert.deepEqual(p.finalize(), want);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 5000, `the sessions took ${ms.toFixed(0)} ms`);   // 4 ms here; ~97 s each before
});

test('D371: a handle of 2^31 bytes or more is too_large at offset 0, unread; openSession(length) still refuses it', async () => {
  // a fake size: nothing is allocated and a read fails the test. Before, every driver threw a TypeError.
  const s = await compileSchema('r = bstr');
  const unread = size => ({ size, read() { throw new Error('a handle past every limit was read'); } });
  const want = { ok: false, reason: 'cbor/too_large', path: [], offset: 0 };
  // what a 2^31-1-byte handle gets under the default limits
  assert.deepEqual(validateHandleSync(s, { size: 2 ** 31 - 1, read: (_o, n) => new Uint8Array(n) }, 'r'), want);
  for (const size of [2 ** 31, 2 ** 31 + 1, 2 ** 53 - 1]) {
    for (const o of [{}, { maxBytes: 2 ** 31 - 1 }, { wire: 'valid' }, { wire: 'deterministic', top: 'map' }]) {
      assert.deepEqual(validateHandleSync(s, unread(size), 'r', o), want);
      assert.deepEqual(await validateHandle(s, unread(size), 'r', o), want);
      assert.equal(verdict(() => scanHandleSync(unread(size), o)), 'too_large');
      assert.equal(await averdict(scanHandle(unread(size), o)), 'too_large');
    }
    // the argument checks come first, as for any handle
    assert.throws(() => validateHandleSync(s, unread(size), 'nope'), TypeError);
    assert.throws(() => scanHandleSync(unread(size), { maxDepth: 257 }), TypeError);
    assert.throws(() => openSession(s, 'r', size), TypeError);
    assert.throws(() => pushScanner(size), TypeError);
  }
});
