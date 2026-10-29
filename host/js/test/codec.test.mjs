import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/build.mjs';
import { scan } from '../src/scan.mjs';
import { snug, baseline, profile, oracle, expected, translate, fromHex, toHex } from './values.mjs';
import { createRandom, randomMap, randomValue, mutate } from './corpus.mjs';

const scannerUnavailable = false; // the generated scanner is a static import now
const pending = scannerUnavailable ? 'Generated profile scanner unavailable; trusted build must never receive refuse bytes.' : false;

for (const v of profile.accept) test(`profile accept: ${v.name}`, () => {
  const bytes = fromHex(v.hex), want = expected(v.value), actual = build(bytes);
  assert.deepStrictEqual(actual, want);
  assert.equal(toHex(snug.encode(actual)), v.hex);
  assert.equal(toHex(snug.encode(want)), v.hex);
  if (!scannerUnavailable) assert.deepStrictEqual(snug.decode(bytes, { top: 'any' }), want);
});

for (const [i, v] of oracle.cases.entries()) {
  if (!v.accept) continue;
  const bytes = fromHex(v.hex);
  let want, refusal;
  // cborg's profile is broader. Its 12 profile:* accepts deliberately document
  // disagreements, not valid trusted-builder inputs. Keep each one visible.
  try { want = baseline.decode(bytes, { top: 'any' }); } catch (e) {
    if (!(e instanceof baseline.CBORFault)) throw e;
    refusal = e.code;
  }
  test(`oracle accept ${i}: ${v.origin}${refusal ? ` (Bindle refuses ${refusal})` : ''}`, { skip: refusal && pending }, () => {
    if (refusal) {
      assert.throws(() => snug.decode(bytes, { top: 'any' }), { name: 'SnugFault', code: refusal });
      return;
    }
    const actual = build(bytes);
    assert.deepStrictEqual(actual, translate(want));
    assert.equal(toHex(snug.encode(actual)), v.hex);
    assert.equal(toHex(snug.encode(translate(want))), v.reencoded);
  });
}

for (const v of profile.refuse) test(`profile refuse: ${v.name}`, { skip: pending }, () => {
  assert.throws(() => snug.decode(fromHex(v.hex), { top: 'any' }), { name: 'SnugFault', code: v.code });
});

test('decode refuses SharedArrayBuffer-backed input (review C17)', () => {
  const shared = new Uint8Array(new SharedArrayBuffer(1)); shared[0] = 0xa0;
  assert.throws(() => snug.decode(shared), TypeError);
});

test('seeded differential: 1000 maps and values, default and plain objects, COSE', () => {
  for (let seed = 1; seed <= 1000; seed++) {
    const random = createRandom(seed), value = seed % 2 ? randomMap(random) : randomValue(random);
    const options = seed % 3 ? {} : { cose: true };
    const input = options.cose ? new Map([[1, value], [-1, seed], ['text', randomValue(random)]]) : value;
    const bytes = snug.encode(input, options);
    assert.deepStrictEqual(bytes, baseline.encode(translate(input, baseline), options), `encode seed=${seed}`);
    for (const objects of ['null', 'plain']) {
      const opts = { ...options, objects, top: 'any' };
      assert.deepStrictEqual(build(bytes, opts), translate(baseline.decode(bytes, opts)), `build seed=${seed} objects=${objects}`);
      assert.deepStrictEqual(snug.encode(build(bytes, opts), opts), bytes, `round trip seed=${seed}`);
    }
  }
});

test('seeded canonical mutations and truncations (scanner required)', { skip: pending }, () => {
  for (let seed = 1; seed <= 250; seed++) {
    const r = createRandom(seed), bytes = snug.encode(randomMap(r));
    for (let i = 0; i < 12; i++) {
      const changed = mutate(r, bytes);
      let value;
      try { value = snug.decode(changed); } catch (e) { assert.ok(e instanceof snug.SnugFault); continue; }
      assert.deepStrictEqual(snug.encode(value), changed, `mutation seed=${seed}`);
    }
    const cuts = bytes.length <= 64 ? Array.from({ length: bytes.length }, (_, i) => i) : Array.from({ length: 32 }, () => r.int(bytes.length));
    for (const n of cuts) assert.throws(() => snug.decode(bytes.subarray(0, n)), snug.SnugFault);
  }
});

test('builder copies Buffer input and unaligned views into fresh aligned typed arrays', () => {
  const values = [new Uint8Array([1, 2, 3]), new Uint16Array([1, 65535]), new Float64Array([-0, Infinity, 1.1]),
    new BigInt64Array([-9223372036854775808n])];
  for (const value of values) {
    const bytes = snug.encode(value), buffer = Buffer.alloc(bytes.length + 3);
    buffer.set(bytes, 3);
    const actual = build(buffer.subarray(3));
    assert.deepStrictEqual(actual, value);
    assert.equal(actual.byteOffset, 0);
    assert.equal(actual.buffer.byteLength, actual.byteLength);
    buffer.fill(0);
    assert.deepStrictEqual(actual, value);
    actual[0] = typeof actual[0] === 'bigint' ? 1n : 1;
    assert.deepStrictEqual(build(bytes), value);
  }
});

test('both map modes preserve __proto__, constructor and toString as own data', () => {
  const bytes = fromHex('a2617801695f5f70726f746f5f5fa16161f5');
  for (const objects of ['null', 'plain']) {
    const value = build(bytes, { objects });
    assert.equal(Object.getPrototypeOf(value), objects === 'plain' ? Object.prototype : null);
    assert.equal(Object.getPrototypeOf(value.__proto__), objects === 'plain' ? Object.prototype : null);
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(value, '__proto__'), {
      value: value.__proto__, enumerable: true, configurable: true, writable: true,
    });
    assert.equal(value.__proto__.a, true);
    assert.equal(({}).a, undefined);
    const special = Object.create(null);
    special.toString = 1; special.constructor = 2; special.__proto__ = 3;
    const back = build(snug.encode(special), { objects });
    assert.equal(back.toString, 1); assert.equal(back.constructor, 2); assert.equal(back.__proto__, 3);
  }
});

test('UTF-8 BOM, ASCII threshold, integer and float boundaries', () => {
  for (const value of ['\ufeff', 'a'.repeat(8), 'a'.repeat(9), 'a'.repeat(7) + 'é', 'a'.repeat(9) + '😀',
    Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 2n ** 53n, -(2n ** 53n), 2n ** 64n - 1n,
    -(2n ** 64n), Number.MIN_VALUE, -(2 ** -24), 1e300, 1.1, 1.5]) {
    const bytes = snug.encode(value);
    assert.deepStrictEqual(build(bytes), baseline.decode(bytes, { top: 'any' }));
  }
});
