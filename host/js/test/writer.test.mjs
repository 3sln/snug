// P5.4 Writer gates: typed calls and value() against encode(), cbor.mjs and the scanner; the grammar state machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writer, writeValue } from '../src/writer.mjs';
import { build } from '../src/build.mjs';
import { typedInfo } from '../src/values.mjs';
import { snug, baseline, profile, oracle, translate, fromHex, toHex } from './values.mjs';
import { createRandom, randomValue, randomMap } from './corpus.mjs';
const { encode, decode, SnugFault, Decimal, NDArray, Float16Bytes } = snug;

const keyBytes = k => encode(k, { top: 'any' });
const byEncoded = (a, b) => Buffer.compare(Buffer.from(keyBytes(a)), Buffer.from(keyBytes(b)));

/** Drive a value through the Writer's typed calls. order: 'given' | 'sorted' | 'shuffled' (with r). */
function drive(w, v, order, r, top = true) {
  switch (typeof v) {
    case 'number': return Number.isSafeInteger(v) && !Object.is(v, -0) ? w.int(v) : w.float(v);
    case 'bigint': return r && r.chance(0.5) ? w.bigint(v) : w.int(v);
    case 'string': return w.text(v);
    case 'boolean': return w.bool(v);
  }
  if (v === null) return w.null();
  if (v instanceof Uint8Array) return w.bytes(v);
  if (typedInfo(v)) return w.typed(v);
  if (v instanceof Decimal) return w.decimal(v);
  if (v instanceof NDArray) return w.ndarray(v);
  if (Array.isArray(v)) { w.beginArray(v.length); for (const x of v) drive(w, x, order, r, false); return w.end(); }
  let entries = v instanceof Map ? [...v] : Object.keys(v).map(k => [k, v[k]]);
  if (order === 'sorted') entries.sort((a, b) => byEncoded(a[0], b[0]));
  else if (order === 'shuffled') entries = r.shuffle(entries);
  w.beginMap(entries.length);
  for (const [k, x] of entries) { w.key(k); drive(w, x, order, r, false); }
  return w.end();
}
const typedCalls = (v, order = 'given', r = null, options = {}) => {
  const w = new Writer({ ...options, keysSorted: order === 'sorted' });
  drive(w, v, order, r);
  return w.finish();
};

const vectorBytes = [];
for (const v of profile.accept) vectorBytes.push(fromHex(v.hex));
for (const c of oracle.cases) if (c.accept) { const b = fromHex(c.hex); try { decode(b, { top: 'any' }); vectorBytes.push(b); } catch { /* a Bindle refusal */ } }

test('every accepted vector: value() and typed calls (given, sorted, shuffled keys) re-encode byte for byte', () => {
  const r = createRandom(7);
  assert.ok(vectorBytes.length > 380);
  for (const bytes of vectorBytes) {
    const value = build(bytes, { top: 'any' }), hex = toHex(bytes);
    assert.equal(toHex(writeValue(value)), hex);
    assert.equal(toHex(typedCalls(value, 'given')), hex);
    assert.equal(toHex(typedCalls(value, 'sorted')), hex);
    assert.equal(toHex(typedCalls(value, 'shuffled', r)), hex);
  }
});

test('3000 seeded random values: Writer == encode == cbor.mjs; output passes decode() and round-trips build()', () => {
  const r = createRandom(20261029);
  for (let i = 0; i < 3000; i++) {
    const v = i % 3 ? randomValue(r, { maxDepth: 5 }) : randomMap(r, { maxDepth: 5 });
    const want = toHex(encode(v, { top: 'any' }));
    assert.equal(toHex(baseline.encode(translate(v, baseline))), want);
    const outs = [writeValue(v), typedCalls(v, 'given'), typedCalls(v, 'shuffled', r), typedCalls(v, 'sorted')];
    for (const out of outs) {
      assert.equal(toHex(out), want);
      const back = decode(out, { top: 'any' }); // the generated scanner, then the builder
      assert.equal(toHex(writeValue(back)), want);
      assert.deepStrictEqual(back, build(out, { top: 'any' }));
    }
  }
});

test('shuffled wide maps and nested maps sort at end(); objects in any key order give one encoding', () => {
  const r = createRandom(3);
  for (let i = 0; i < 200; i++) {
    const o = Object.create(null);
    for (let k = 0, n = 2 + r.int(400); k < n; k++) o[r.chance(0.5) ? 'k' + r.int(10000) : 'é' + r.int(99)] = r.chance(0.2) ? { z: r.int(5), a: [r.int(3)], m: { y: 1, b: 2 } } : r.int(1000);
    const want = toHex(encode(o));
    assert.equal(toHex(typedCalls(o, 'shuffled', r)), want);
    const reversed = Object.create(null); for (const k of Object.keys(o).reverse()) reversed[k] = o[k];
    assert.equal(toHex(writeValue(reversed)), want);
  }
});

const refusals = [
  [undefined, 'unsupported'], [NaN, 'float'], [Infinity, 'float'], [-Infinity, 'float'], [-0, 'float'],
  [Symbol('private-payload'), 'unsupported'], [() => 1, 'unsupported'], [new Date(0), 'unsupported'],
  [new Map(), 'unsupported'], [new Set(), 'unsupported'], [new ArrayBuffer(1), 'unsupported'], [new Uint8ClampedArray(1), 'unsupported'],
  [new Float32Array([NaN]), 'typed_array'], [new Float64Array([1, NaN]), 'typed_array'],
  ['﷐', 'text'], ['\ud800', 'text'], ['a\udfff', 'text'], ['\u{10ffff}', 'text'], ['x'.repeat(70) + '\ud800', 'text'],
  [2n ** 1024n, 'bignum'], [-(2n ** 1024n) - 1n, 'bignum'], [new (class X {})(), 'unsupported'],
  [[1, , 3], 'unsupported'], [Object.assign([1], { extra: 1 }), 'unsupported'], [{ [Symbol('private-key')]: 1 }, 'unsupported'],
  [Object.defineProperty({}, 'private-key', { get: () => { throw new Error('getter must never run'); }, enumerable: true }), 'unsupported'],
  [Object.defineProperty({}, 'hidden', { value: 1 }), 'unsupported'], [{ u: undefined }, 'unsupported'],
  [{ '￾': 1 }, 'key_type'], [{ ['x'.repeat(80) + '\ud800']: 1 }, 'key_type'],
];
test('value() refuses what encode refuses, with its code, never echoing the value; the writer stays failed', () => {
  for (const [value, code] of refusals) {
    assert.throws(() => encode(value), { code });
    const w = new Writer();
    assert.throws(() => w.value(value), e => e instanceof SnugFault && e.code === code && !e.message.includes('private'));
    assert.equal(w.failure, code);
    assert.throws(() => w.null(), { code: 'writer_failed' });
    assert.throws(() => w.finish(), { code: 'writer_failed' });
  }
});

test('limits: depth, entries, items, bytes and the cycle match encode', () => {
  const cycle = {}; cycle.self = cycle;
  let deep = []; for (let i = 0; i < 31; i++) deep = [deep];
  const cases = [
    [cycle, {}], [deep, {}], [[deep], {}], [new Array(65537).fill(0), {}], [[0, 1], { maxEntries: 1 }], [{ a: 0, b: 1 }, { maxEntries: 1 }],
    [[0, 1, 2], { maxItems: 3 }], [[0, 1, 2], { maxItems: 4 }], [{ a: 0 }, { maxItems: 2 }], [{ a: 0 }, { maxItems: 3 }],
    [new Float64Array(100), { maxItems: 1 }], [new Float64Array(0), { maxDepth: 0 }], [2n ** 64n, { maxDepth: 0 }], [1, { maxDepth: 0 }],
    [new Uint8Array(1), { maxDepth: 0 }], [Decimal.from('1.5'), { maxDepth: 1 }], [Decimal.from('1.5'), { maxDepth: 2 }],
    [new NDArray([1], [1]), { maxDepth: 2 }], [new NDArray([1], [1]), { maxDepth: 3 }], [{ a: 'x'.repeat(100) }, { maxBytes: 50 }],
    [1, { maxBytes: 0 }], [0, { maxItems: 0 }], [[], { maxEntries: 0 }], [Decimal.from('-123456789012345678901234567890.5'), { maxDepth: 2 }],
  ];
  for (const [value, options] of cases) {
    let want; try { want = toHex(encode(value, options)); } catch (e) { want = e.code; }
    let got; try { got = toHex(writeValue(value, options)); } catch (e) { got = e.code; }
    assert.equal(got, want);
  }
  assert.equal(writeValue(new Uint8Array(1_500_001)).length, 1_500_006); // maxBytes only when supplied
  for (const name of ['maxBytes', 'maxDepth', 'maxEntries', 'maxItems']) for (const value of [-1, 0.5, NaN, '1', 1n]) assert.throws(() => new Writer({ [name]: value }), TypeError);
  assert.throws(() => new Writer({ limits: { maxDepth: 1 } }).beginArray(1).beginArray(0), { code: 'depth' });
});

test('typed calls: integers, floats and bigints choose the profile form; bad arguments are refused', () => {
  const one = f => { const w = new Writer(); f(w); return toHex(w.finish()); };
  assert.equal(one(w => w.uint(0)), '00');
  assert.equal(one(w => w.uint(2 ** 32)), '1b0000000100000000');
  assert.equal(one(w => w.uint(2n ** 64n - 1n)), '1bffffffffffffffff');
  assert.equal(one(w => w.int(-(2 ** 53) + 1)), '3b001ffffffffffffe');
  assert.equal(one(w => w.int(2n ** 64n)), 'c249010000000000000000');
  assert.equal(one(w => w.bigint(-(2n ** 64n) - 1n)), 'c349010000000000000000');
  assert.equal(one(w => w.bigint(5n)), '05');
  assert.equal(one(w => w.float(1.5)), 'f93e00');
  assert.equal(one(w => w.float(2 ** 53)), 'fa5a000000');
  assert.equal(one(w => w.float(5e-324)), 'fb0000000000000001');
  for (const x of [2 ** -149, 3 * 2 ** -140, 2 ** -127, 2 ** -126, 2 ** -24, 3 * 2 ** -20, 2 ** -15, 2 ** -14, 65503.5, 65504.5, 2 ** -1074, 2 ** -1022, 3.4028234663852886e38, 1e-310])
    for (const y of [x, -x]) assert.equal(one(w => w.float(y)), toHex(baseline.encode(y)));
  for (const x of [1, 0, -0, NaN, Infinity, 2 ** 53 - 1]) assert.throws(() => new Writer().float(x), { code: 'float' });
  for (const [m, x] of [['uint', -1], ['uint', 1.5], ['uint', 2n ** 64n], ['uint', -1n], ['int', 1.5], ['int', -0], ['int', 2 ** 53], ['int', '1'],
    ['bigint', 1], ['float', 1n], ['bool', 0], ['text', 1], ['bytes', [1]], ['typed', new Uint8Array(1)], ['decimal', 1.5], ['ndarray', [1]]]) {
    const w = new Writer();
    assert.throws(() => w[m](x), { code: 'unsupported' }, `${m}`);
    assert.throws(() => w.null(), { code: 'writer_failed' });
  }
  assert.equal(one(w => w.text('ü'.repeat(30))), toHex(encode('ü'.repeat(30))));
  assert.equal(one(w => w.text('a'.repeat(100000) + 'é')), toHex(encode('a'.repeat(100000) + 'é')));
  assert.equal(one(w => w.typed(new Float16Bytes(new Uint8Array([0, 0x3c])))), toHex(encode(new Float16Bytes(new Uint8Array([0, 0x3c])))));
});

test('grammar: counts, keys before values, closed containers, one root; misuse fails for good', () => {
  const misuse = [
    w => w.beginArray(1).uint(1).uint(2),                // too many items
    w => w.beginArray(2).uint(1).end(),                  // too few
    w => w.beginMap(1).uint(1),                          // value without key
    w => w.beginMap(1).key('a').key('b'),                // key without value
    w => w.beginMap(1).key('a').end(),                   // key, no value
    w => w.beginArray(0).key('a'),                       // key outside a map
    w => w.key('a'),
    w => w.end(),                                        // end() with nothing open
    w => w.beginArray(0).end().end(),
    w => w.uint(1).uint(2),                              // two roots
    w => w.finish(),                                     // nothing written
    w => w.beginArray(1).finish(),                       // finish early
    w => w.beginArray(1).beginArray(0).end().finish(),
    w => w.beginMap(1).key('a').finish(),
    w => w.beginArray(-1), w => w.beginMap(1.5), w => w.beginArray(2 ** 53),
  ];
  for (const [i, f] of misuse.entries()) {
    const w = new Writer();
    assert.throws(() => f(w), e => e instanceof SnugFault && (e.code === 'grammar' || e.code === 'unsupported'), `case ${i}`);
    assert.ok(w.failure === 'grammar' || w.failure === 'unsupported');
    for (const g of [x => x.uint(1), x => x.end(), x => x.finish(), x => x.key('a'), x => x.beginArray(0), x => x.value(1), x => x.float(1.5)])
      assert.throws(() => g(w), { code: 'writer_failed' });
  }
  const w = new Writer(); w.uint(1);
  assert.equal(toHex(w.finish()), '01');
  assert.throws(() => w.finish(), { code: 'grammar' });
  assert.throws(() => w.uint(2), { code: 'writer_failed' });
});

test('map keys: duplicates, keysSorted verification, text keys only, cose labels in the top-level map', () => {
  const run = (options, f) => { const w = new Writer(options); f(w); return toHex(w.finish()); };
  assert.throws(() => run({}, w => w.beginMap(2).key('a').uint(1).key('a').uint(2).end()), { code: 'duplicate_key' });
  assert.throws(() => run({}, w => w.beginMap(3).key('b').uint(1).key('c').uint(1).key('b').uint(2).end()), { code: 'duplicate_key' });
  assert.throws(() => run({ keysSorted: true }, w => w.beginMap(2).key('b').uint(1).key('a')), { code: 'key_order' });
  assert.throws(() => run({ keysSorted: true }, w => w.beginMap(2).key('aa').uint(1).key('b')), { code: 'key_order' }); // shorter first
  assert.throws(() => run({ keysSorted: true }, w => w.beginMap(2).key('a').uint(1).key('a')), { code: 'duplicate_key' });
  assert.equal(run({ keysSorted: true }, w => w.beginMap(2).key('b').uint(1).key('aa').uint(2).end()), 'a2616201626161' + '02');
  assert.equal(run({}, w => w.beginMap(2).key('aa').uint(2).key('b').uint(1).end()), 'a2616201626161' + '02');
  for (const k of [1, 1n, null, {}, '\ud800', -0]) assert.throws(() => run({}, w => w.beginMap(1).key(k)), { code: 'key_type' });
  assert.throws(() => run({ cose: true }, w => w.beginArray(1).beginMap(1).key(1)), { code: 'key_type' }); // not the top-level map
  assert.throws(() => run({ cose: true }, w => w.beginMap(1).key(1).beginMap(1).key(2)), { code: 'key_type' });
  assert.throws(() => run({ cose: true }, w => w.beginMap(1).key(1.5)), { code: 'key_type' });
  const cose = new Map([['x', 1], [-1, 2], [1, 3], [24, 4], ['a', 5]]);
  const want = toHex(encode(cose, { cose: true }));
  assert.equal(run({ cose: true }, w => drive(w, cose, 'given')), want);
  assert.equal(run({ cose: true, keysSorted: true }, w => drive(w, cose, 'sorted')), want);
  assert.equal(toHex(writeValue(cose, { cose: true })), want);
  assert.throws(() => writeValue(new Map([[1.5, 1]]), { cose: true }), { code: 'key_type' });
  assert.throws(() => writeValue({ a: new Map([[1, 1]]) }, { cose: true }), { code: 'unsupported' });
});

test('value() mixes with typed calls; omitUndefined as encode', () => {
  const w = new Writer({ omitUndefined: true });
  w.beginMap(2).key('z').value({ a: [1, 2], b: undefined }).key('a').value(new Float32Array([1.5])).end();
  assert.equal(toHex(w.finish()), toHex(encode({ z: { a: [1, 2] }, a: new Float32Array([1.5]) })));
});
