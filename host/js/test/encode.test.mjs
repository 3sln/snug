// Encoder and wrapper cases ported from 3sln.me tests/cbor.test.mjs (MIT, Copyright (c) 2026 3sln).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { build } from '../src/build.mjs';
import { snug, baseline, translate, fromHex, toHex } from './values.mjs';
const { encode, SnugFault, Decimal, NDArray, Float16Bytes } = snug;

const cases = [
  [undefined, 'unsupported'], [NaN, 'float'], [Infinity, 'float'], [-Infinity, 'float'], [-0, 'float'],
  [Symbol('private-payload'), 'unsupported'], [() => 1, 'unsupported'], [new Date(0), 'unsupported'],
  [new Map(), 'unsupported'], [new Set(), 'unsupported'], [/x/, 'unsupported'], [new ArrayBuffer(1), 'unsupported'],
  [new DataView(new ArrayBuffer(1)), 'unsupported'], [new Uint8ClampedArray(1), 'unsupported'],
  [new Float32Array([NaN]), 'typed_array'], [new Float64Array([1, NaN]), 'typed_array'],
  ['\ufdd0', 'text'], ['\ud800', 'text'], ['a\udfff', 'text'], ['\u{10ffff}', 'text'],
  [2n ** 1024n, 'bignum'], [-(2n ** 1024n) - 1n, 'bignum'], [new (class X {})(), 'unsupported'],
  [[1, , 3], 'unsupported'], [Object.assign([1], { extra: 1 }), 'unsupported'],
  [{ [Symbol('private-key')]: 1 }, 'unsupported'],
  [Object.defineProperty({}, 'private-key', { get: () => { throw new Error('getter must never run'); }, enumerable: true }), 'unsupported'],
  [Object.defineProperty({}, 'hidden', { value: 1 }), 'unsupported'], [{ u: undefined }, 'unsupported'],
  [{ '\ufffe': 1 }, 'key_type'],
];
for (const [i, [value, code]] of cases.entries()) test(`encoder refuses case ${i}: ${code}`, () => {
  assert.throws(() => baseline.encode(value), { name: 'CBORFault', code });
  assert.throws(() => encode(value), e => e instanceof SnugFault && e.code === code && !e.message.includes('private'));
});

test('cycles, depth boundaries, tags and all encoder resource options match baseline', () => {
  const cycle = {}; cycle.self = cycle;
  let deep = []; for (let i = 0; i < 31; i++) deep = [deep];
  const limitCases = [
    [cycle, {}, 'depth'], [deep, {}, null], [[deep], {}, 'depth'],
    [new Array(65537).fill(0), {}, 'too_many_entries'], [[0, 1], { maxEntries: 1 }, 'too_many_entries'],
    [{ a: 0, b: 1 }, { maxEntries: 1 }, 'too_many_entries'],
    [[0, 1, 2], { maxItems: 3 }, 'too_many_items'], [[0, 1, 2], { maxItems: 4 }, null],
    [{ a: 0 }, { maxItems: 2 }, 'too_many_items'], [{ a: 0 }, { maxItems: 3 }, null],
    [new Float64Array(100), { maxItems: 1 }, null],
    [new Float64Array(0), { maxDepth: 0 }, 'depth'], [2n ** 64n, { maxDepth: 0 }, 'depth'],
    [1, { maxDepth: 0 }, null], [new Uint8Array(1), { maxDepth: 0 }, null],
    [Decimal.from('1.5'), { maxDepth: 1 }, 'depth'], [Decimal.from('1.5'), { maxDepth: 2 }, null],
    [new NDArray([1], [1]), { maxDepth: 2 }, 'depth'], [new NDArray([1], [1]), { maxDepth: 3 }, null],
    [{ a: 'x'.repeat(100) }, { maxBytes: 50 }, 'too_large'], [1, { maxBytes: 0 }, 'too_large'],
    [0, { maxItems: 0 }, 'too_many_items'], [[], { maxEntries: 0 }, null],
  ];
  for (const [value, options, code] of limitCases) {
    if (code) {
      assert.throws(() => encode(value, options), { name: 'SnugFault', code });
      assert.throws(() => baseline.encode(value === cycle ? cycle : translate(value, baseline), options), { code });
    } else assert.deepStrictEqual(encode(value, options), baseline.encode(translate(value, baseline), options));
  }
  // Baseline deliberately enforces maxBytes on encode only when supplied.
  assert.equal(encode(new Uint8Array(1_500_001)).length, 1_500_006);
  for (const name of ['maxBytes', 'maxDepth', 'maxEntries', 'maxItems']) {
    for (const value of [-1, 0.5, NaN, Infinity, '1', 1n, null]) {
      assert.throws(() => encode(0, { [name]: value }), TypeError);
      assert.throws(() => baseline.encode(0, { [name]: value }), TypeError);
    }
  }
});

test('omitUndefined uses descriptors, skips symbols and non-enumerable members, refuses accessors', () => {
  const object = { a: 1, b: undefined, [Symbol('skip')]: 2 };
  Object.defineProperty(object, 'hidden', { get: () => { throw new Error('not called'); } });
  const opts = { omitUndefined: true };
  assert.deepStrictEqual(encode(object, opts), baseline.encode(object, opts));
  assert.equal(toHex(encode(object, opts)), 'a1616101');
  for (const value of [undefined, [undefined], { a: [undefined] }, Object.defineProperty({}, 'get', { get() { throw new Error('not called'); }, enumerable: true })]) {
    assert.throws(() => encode(value, opts), { code: 'unsupported' });
    assert.throws(() => baseline.encode(value, opts), { code: 'unsupported' });
  }
  assert.throws(() => encode({ u: undefined }, { omitUndefined: 1 }), { code: 'unsupported' });
});

test('encoded key ordering: ASCII, UTF-8, head size transitions and COSE integers', () => {
  const keys = ['', 'z', 'aa', 'é', '\uffef', '\u{10000}', '\0', '__proto__', 'a'.repeat(23), 'a'.repeat(24),
    'a'.repeat(255), 'a'.repeat(256), 'a'.repeat(65535), 'a'.repeat(65536)];
  const map = Object.create(null); for (let i = keys.length - 1; i >= 0; i--) map[keys[i]] = i;
  assert.deepStrictEqual(encode(map), baseline.encode(map));
  const cose = new Map(keys.map((key, i) => [key, i]));
  for (const key of [0, 23, 24, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32, Number.MAX_SAFE_INTEGER,
    -1, -24, -25, -256, -257, -65536, -65537, -(2 ** 32), -(2 ** 32) - 1, -Number.MAX_SAFE_INTEGER]) cose.set(key, key);
  assert.deepStrictEqual(encode(cose, { cose: true }), baseline.encode(cose, { cose: true }));
  assert.deepStrictEqual(build(encode(cose, { cose: true }), { cose: true }), baseline.decode(baseline.encode(cose, { cose: true }), { cose: true }));
  assert.throws(() => encode(cose), { code: 'unsupported' });
  assert.throws(() => encode({ nested: cose }, { cose: true }), { code: 'unsupported' });
  for (const key of [NaN, Infinity, 1.5, 2 ** 53, 1n, {}, null]) {
    assert.throws(() => encode(new Map([[key, 1]]), { cose: true }), { code: 'key_type' });
    assert.throws(() => baseline.encode(new Map([[key, 1]]), { cose: true }), { code: 'key_type' });
  }
});

test('Decimal parsing, normalization, limits, immutability and coercion refusals', () => {
  for (const [text, want] of [['1.50', '1.5'], ['-0.050', '-0.05'], ['100.000', 100], ['0.0', 0],
    ['123456789012345678901234567890', 123456789012345678901234567890n], ['12345678901234567890123.45', '12345678901234567890123.45']]) {
    const value = Decimal.from(text);
    assert.equal(value instanceof Decimal ? value.toString() : value, want);
    assert.deepStrictEqual(encode(value), baseline.encode(baseline.BindleDecimal.from(text)));
  }
  for (const input of ['1e5', '+1', '01.5', '1.', '.5', '', '1,5', ' 1', `0.${'0'.repeat(1024)}1`, 1.5, '1'.repeat(4097)]) {
    assert.throws(() => Decimal.from(input), { code: 'decimal' });
    assert.throws(() => baseline.BindleDecimal.from(input), { code: 'decimal' });
  }
  for (const [m, e] of [[10n, -1], [0n, -1], [15n, 0], [15n, 1], [15, -1], [15n, -1025], [15n, -1.5]]) {
    assert.throws(() => new Decimal(m, e), { code: 'decimal' });
  }
  for (const [m, e, code] of [[1n, 1101, 'decimal'], [2n ** 1024n + 1n, -1, 'bignum'], [1, -1, 'decimal']]) {
    assert.throws(() => Decimal.normalize(m, e), { code });
  }
  assert.throws(() => Decimal.from('1' + '0'.repeat(400)), { code: 'bignum' });
  assert.equal(Decimal.normalize(0n, -10000), 0);
  assert.equal(Decimal.normalize(150n, -1), 15);
  assert.equal(Decimal.normalize(15n, 1), 150);
  const d = Decimal.from('2.5');
  for (const coerce of [() => d + 1, () => +d, () => Number(d), () => JSON.stringify({ d })]) assert.throws(coerce, TypeError);
  assert.equal(`${d}`, '2.5'); assert.ok(Object.isFrozen(d)); assert.ok(Object.isFrozen(Decimal.prototype));
  const tiny = build(fromHex('c4823903ff01'));
  assert.equal(tiny.toString(), `0.${'0'.repeat(1023)}1`);
  assert.equal(toHex(encode(tiny)), 'c4823903ff01');
});

test('typed wrappers preserve views, immutable metadata and reject bad shapes and float16 NaN', () => {
  assert.equal(toHex(encode(Buffer.from([1, 2]))), '420102');
  const base = new Uint16Array([9, 1, 2, 9]);
  assert.equal(toHex(encode(base.subarray(1, 3))), 'd8454401000200');
  assert.equal(encode(2n ** 1024n - 1n).length, 131);
  const bytes = fromHex('003c'), half = new Float16Bytes(bytes);
  bytes.fill(0); assert.equal(toHex(half.bytes), '003c');
  assert.equal(toHex(encode(half)), 'd85442003c');
  assert.ok(Object.isFrozen(half));
  assert.throws(() => new Float16Bytes(new Uint8Array(3)), { code: 'typed_array' });
  assert.throws(() => new Float16Bytes([]), { code: 'typed_array' });
  assert.throws(() => encode(new Float16Bytes(fromHex('007e'))), { code: 'typed_array' });
  const nd = new NDArray([2, 3], new Float32Array(6));
  assert.ok(Object.isFrozen(nd) && Object.isFrozen(nd.shape));
  assert.deepStrictEqual(build(encode(nd)), nd);
  for (const [shape, data] of [[[], []], [[0], []], [[2], [1]], [[1, 1, 1, 1, 1, 1, 1, 1, 1], [1]],
    [[1.5], [1]], [[2], new Uint8Array(2)], [[1], 'x'], [[Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], []]]) {
    assert.throws(() => new NDArray(shape, data), { code: 'ndarray' });
    assert.throws(() => new baseline.NDArray(shape, data), { code: 'ndarray' });
  }
});

test('Float16Bytes fallback with native Float16Array absent at module initialization', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'Float16Array');
  if (saved) delete globalThis.Float16Array;
  let values;
  try { values = await import('../src/values.mjs?no-float16'); }
  finally { if (saved) Object.defineProperty(globalThis, 'Float16Array', saved); }
  assert.equal(values.TYPED_BY_TAG.get(84).ctor, null);
  const b = fromHex('003c00bc'), value = new values.Float16Bytes(b);
  assert.equal(value.length, 2); assert.equal(toHex(value.bytes), '003c00bc');
  // Main builder/encoder still use their own consistently initialized module.
  if (!saved) assert.deepStrictEqual(build(fromHex('d85444003c00bc')), new Float16Bytes(b));
  // A fresh process also exercises the builder and encoder with one shared
  // no-Float16 module identity, even on a runtime with a native Float16Array.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    delete globalThis.Float16Array;
    const { build } = await import(${JSON.stringify(new URL('../src/build.mjs', import.meta.url).href)});
    const { encode, Float16Bytes } = await import(${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)});
    const bytes = new Uint8Array([0xd8, 0x54, 0x44, 0, 0x3c, 0, 0xbc]);
    const value = build(bytes);
    assert.ok(value instanceof Float16Bytes);
    assert.equal(value.length, 2);
    assert.deepStrictEqual(value.bytes, new Uint8Array([0, 0x3c, 0, 0xbc]));
    assert.deepStrictEqual(encode(value), bytes);
    assert.throws(() => encode(new Float16Bytes(new Uint8Array([0, 0x7e]))), { code: 'typed_array' });
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});
