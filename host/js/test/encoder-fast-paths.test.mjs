import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode } from '../src/encode.mjs';
import { Writer } from '../src/writer.mjs';
import { Float16Bytes } from '../src/values.mjs';
import { copyTypedBytes } from '../src/typed-bytes.mjs';
import { encode as frozenEncode } from '../../../bench/baseline/encode-p2.mjs';

test('array checks retain sparse, extra-own-property and prototype refusals', () => {
  const values = [new Array(3), [1, , 3], Object.assign([1], { extra: 2 }),
    Object.defineProperty([1], 'hidden', { value: 2 }),
    Object.assign([1], { [Symbol('extra')]: 2 }), new (class extends Array {})(1, 2),
    Object.setPrototypeOf([1], null), Object.setPrototypeOf([1], Object.create(Array.prototype))];
  for (const value of values) {
    for (const options of [{}, { omitUndefined: true }, { maxEntries: 0 }]) {
      assert.throws(() => frozenEncode(value, options), { code: 'unsupported' });
      assert.throws(() => encode(value, options), { code: 'unsupported' });
    }
  }
  for (const value of [[], [1, 2], Object.freeze([1, 2]),
    Object.defineProperty([1, 2], '0', { enumerable: false }),
    Object.defineProperty([1, 2], '0', { get: () => 3 })]) {
    assert.deepStrictEqual(encode(value), frozenEncode(value));
  }
  // The frozen check counts own keys; it does not independently prove density.
  // Preserve even its refusal precedence when an extra key compensates a hole.
  const compensated = Object.assign([1, , 3], { extra: 1 });
  for (const f of [encode, frozenEncode]) {
    assert.throws(() => f(compensated, { maxItems: 1 }), { code: 'too_many_items' });
  }
});

test('typed and byte-string bulk copies respect subarray offsets and ownership', () => {
  const types = [Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
    BigUint64Array, BigInt64Array, Float32Array, Float64Array];
  if (globalThis.Float16Array) types.push(globalThis.Float16Array);
  for (const C of types) {
    const big = C === BigInt64Array || C === BigUint64Array;
    const full = C.from([11, 1, 2, 3, 22], n => big ? BigInt(n) : n);
    const view = full.subarray(1, 4), want = frozenEncode(view);
    const w = new Writer();
    if (C === Uint8Array) w.bytes(view); else w.typed(view);
    const bytes = w.finish();
    assert.deepStrictEqual(bytes, want);
    assert.deepStrictEqual(encode(view), want);
    const nested = { prefix: 'x'.repeat(250), typed: view };
    assert.deepStrictEqual(encode(nested), frozenEncode(nested));
    full.fill(big ? 0n : 0);
    assert.deepStrictEqual(bytes, want);
  }
  for (const C of [Float32Array, Float64Array]) {
    const a = new C([-0, Infinity, -Infinity, 1.5]);
    assert.deepStrictEqual(encode(a), frozenEncode(a));
    for (const i of [0, a.length - 1]) {
      const b = a.slice(); b[i] = NaN;
      assert.throws(() => encode(b), { code: 'typed_array' });
    }
    const decorated = new C([NaN]);
    Object.defineProperty(decorated, 'length', { value: 0 });
    assert.deepStrictEqual(encode(decorated), frozenEncode(decorated));
    const shadowed = new C([1.5]);
    shadowed.includes = () => { throw new Error('not called'); };
    assert.deepStrictEqual(encode(shadowed), frozenEncode(shadowed));
  }
});

test('forced big-endian copies reverse each element directly into the destination', () => {
  for (const size of [1, 2, 4, 8]) {
    const storage = Uint8Array.from({ length: 4 + 3 * size }, (_, i) => i);
    const raw = storage.subarray(2, 2 + 3 * size), little = raw.slice();
    for (let i = 0; i < little.length; i += size) little.subarray(i, i + size).reverse();
    for (const [input, endian] of [[raw, false], [little, true]]) {
      const out = new Uint8Array(little.length + 6).fill(255);
      copyTypedBytes(out, 3, input, size, endian);
      assert.deepStrictEqual(out.subarray(3, -3), little);
      assert.deepStrictEqual(out.subarray(0, 3), new Uint8Array(3).fill(255));
      assert.deepStrictEqual(out.subarray(-3), new Uint8Array(3).fill(255));
      assert.deepStrictEqual(input, endian ? little : storage.subarray(2, 2 + 3 * size));
    }
  }
});

test('Writer forced big-endian path encodes native views and Float16Bytes', async () => {
  const url = new URL('../src/writer.mjs', import.meta.url);
  let source = readFileSync(url, 'utf8');
  source = source.replace('const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;', 'const LITTLE_ENDIAN = false;');
  source = source.replace(/from '(\.[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
  const { Writer: BigEndianWriter } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  for (const C of [Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
    BigUint64Array, BigInt64Array, Float32Array, Float64Array]) {
    const big = C === BigInt64Array || C === BigUint64Array;
    const a = C.from([9, 1, 2, 3, 9], n => big ? BigInt(n) : n).subarray(1, 4);
    const want = frozenEncode(a), raw = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    // Simulate big-endian backing bytes on this little-endian test host.
    if (new Uint8Array(new Uint16Array([1]).buffer)[0] === 1) {
      for (let i = 0; i < raw.length; i += C.BYTES_PER_ELEMENT) raw.subarray(i, i + C.BYTES_PER_ELEMENT).reverse();
    }
    assert.deepStrictEqual(new BigEndianWriter().typed(a).finish(), want);
  }
  const half = new Float16Bytes(Uint8Array.of(0, 0x3c, 0, 0x80, 0, 0x7c));
  assert.deepStrictEqual(new BigEndianWriter().typed(half).finish(), frozenEncode(half));
});

test('Float16Bytes stays little-endian and retains NaN refusals', () => {
  const storage = Uint8Array.of(255, 255, 0, 0x3c, 0, 0x80, 0, 0x7c, 0, 0xfc, 255, 255);
  const value = new Float16Bytes(storage.subarray(2, -2));
  assert.deepStrictEqual(encode(value), frozenEncode(value));
  assert.deepStrictEqual(new Writer().typed(value).finish(), frozenEncode(value));
  const raw = value.bytes.slice();
  const out = new Uint8Array(raw.length);
  // Float16Bytes is already little-endian even on a big-endian host.
  copyTypedBytes(out, 0, raw, 2, true);
  assert.deepStrictEqual(out, raw);
  for (const h of [0x7c01, 0x7e00, 0xfc01, 0xffff]) {
    assert.throws(() => encode(new Float16Bytes(Uint8Array.of(h & 255, h >> 8))), { code: 'typed_array' });
  }
});

test('large exact buffers and copied outputs preserve ownership, limits and sticky grammar', () => {
  for (const n of [4095, 4096, 65536, 2 ** 20]) {
    const input = new Uint8Array(n + 8).fill(97).subarray(4, -4);
    const w = new Writer().beginMap(2).key('z').bytes(input).key('a').uint(1).end();
    const want = frozenEncode({ z: input, a: 1 }), result = w.finish();
    assert.deepStrictEqual(result, want);
    assert.equal(result.buffer.byteLength, result.length);
    input.fill(0);
    assert.deepStrictEqual(result, want);
    assert.throws(() => w.bytes(input), { code: 'grammar' });
    assert.throws(() => w.finish(), { code: 'writer_failed' });
    assert.deepStrictEqual(result, want);
    assert.throws(() => encode(input, { maxBytes: n }), { code: 'too_large' });
    const root = new Uint8Array(n).fill(42), rootWant = frozenEncode(root);
    const direct = encode(root);
    root.fill(0);
    assert.deepStrictEqual(direct, rootWant);
    assert.equal(direct.buffer.byteLength, direct.length);
    assert.deepStrictEqual(encode(new Float64Array(n)), frozenEncode(new Float64Array(n)));
  }
});
