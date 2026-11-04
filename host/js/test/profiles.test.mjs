// P7.1: the profile options and presets (D120-D125) through every JS surface: the deterministic vectors
// (corpus/cbor-vectors/deterministic.json) through decode, encode, views and the profile sources; option
// resolution; the Writer's new values; schemas over the prelude types the deterministic preset now admits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decode, encode, Tagged, profiles, SnugFault, Decimal } from '../src/index.mjs';
import { profileFlags, codecTop } from '../src/profiles.mjs';
import { Writer } from '../src/writer.mjs';
import { view } from '../src/view.mjs';
import { compile } from '../src/schema.mjs';
import { scanHandleSync, bufferHandle, pushScanner, validateHandleSync } from '../src/sources.mjs';

const det = JSON.parse(readFileSync(new URL('../../../corpus/cbor-vectors/deterministic.json', import.meta.url)));
const fromHex = h => new Uint8Array(Buffer.from(h, 'hex'));
const toHex = b => Buffer.from(b).toString('hex');
const B = profiles.bindle;

/** deterministic.json's value notation. */
function value(v) {
  if (Array.isArray(v)) return v.map(value);
  if (v === null || typeof v !== 'object') return v;
  if ('$undefined' in v) return undefined;
  if ('$float' in v) return { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 }[v.$float];
  if ('$int' in v) { const n = BigInt(v.$int); return n >= -BigInt(Number.MAX_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n; }
  if ('$bytes' in v) return fromHex(v.$bytes);
  if ('$tag' in v) return new Tagged(v.$tag, value(v.value));
  if ('$map' in v) return new Map(v.$map.map(([k, x]) => [value(k), value(x)]));
  const out = Object.create(null);
  for (const [k, x] of Object.entries(v)) out[k] = value(x);
  return out;
}

for (const v of det.accept) test(`deterministic accept: ${v.name}`, () => {
  const bytes = fromHex(v.hex), got = decode(bytes);
  if ('value' in v) {
    assert.deepStrictEqual(got, value(v.value));
    assert.equal(toHex(encode(value(v.value))), v.reencode ?? v.hex);
  }
  assert.equal(toHex(encode(got)), v.reencode ?? v.hex);
  assert.deepStrictEqual(view(bytes).value(), got);
  assert.deepStrictEqual(view(bytes, { borrow: true, directories: true }).value(), got);
  assert.equal(scanHandleSync(bufferHandle(bytes), {}, { chunk: 3 }), true);
  const push = pushScanner(bytes.length, {}, { quantum: 2 });
  for (let i = 0; i < bytes.length; i++) { let s = push.feed(bytes.subarray(i, i + 1)); while (s.state === 'yield') s = push.resume(); }
  assert.equal(push.finalize(), true);
  if (v.bindle === 'ok') assert.deepStrictEqual(decode(bytes, { ...B, top: 'any' }), got);
  else assert.throws(() => decode(bytes, { ...B, top: 'any' }), { name: 'SnugFault', code: v.bindle });
});

for (const v of det.refuse) test(`deterministic refuse: ${v.name}`, () => {
  const bytes = fromHex(v.hex);
  assert.throws(() => decode(bytes), e => e instanceof SnugFault && e.code === v.code);
  assert.throws(() => view(bytes), e => e instanceof SnugFault && e.code === v.code);
  assert.throws(() => scanHandleSync(bufferHandle(bytes), {}, { chunk: 2, quantum: 1 }), e => e instanceof SnugFault && e.code === v.code);
  if (v.bindle === 'ok') decode(bytes, { ...B, top: 'any' });
  else assert.throws(() => decode(bytes, { ...B, top: 'any' }), { name: 'SnugFault', code: v.bindle });
});

test('option resolution: presets, overrides, refusals of unknown values', () => {
  assert.equal(profileFlags({}), 118);
  assert.equal(profileFlags({ wire: 'deterministic' }), 118);
  assert.equal(profileFlags(B), 0);
  assert.equal(profileFlags(profiles.deterministic), 118);
  assert.equal(profileFlags({ keys: 'text' }), 116);
  assert.equal(profileFlags({ keys: 'integer' }), 117);
  assert.equal(profileFlags({ wire: 'bindle', keys: 'any', tags: 'standard' }), 6);
  assert.equal(profileFlags({ wire: 'bindle', floats: 'deterministic', undefinedValue: true, noncharacters: true }), 112);
  assert.equal(codecTop({}), 'any'); assert.equal(codecTop(B), 'map'); assert.equal(codecTop({ wire: 'bindle', top: 'any' }), 'any');
  for (const bad of [{ wire: 'cde' }, { keys: 'int' }, { tags: 'all' }, { floats: 'rfc' }, { undefinedValue: 1 }, { noncharacters: 'yes' }, { keys: 'toString' }])
    assert.throws(() => decode(Uint8Array.of(0), bad), TypeError);
  // each option alone turns one acceptance on or off
  assert.throws(() => decode(fromHex('a10100'), { keys: 'text' }), { code: 'key_type' });
  assert.deepStrictEqual(decode(fromHex('a10100'), { keys: 'integer' }), new Map([[1, 0]]));
  assert.throws(() => decode(fromHex('a1810000'), { keys: 'integer' }), { code: 'key_type' });
  assert.throws(() => decode(fromHex('c100'), { tags: 'bindle' }), { code: 'tag' });
  assert.throws(() => decode(fromHex('f97e00'), { floats: 'bindle' }), { code: 'float' });
  assert.throws(() => decode(fromHex('f7'), { undefinedValue: false }), { code: 'simple' });
  assert.throws(() => decode(fromHex('63efbfbf'), { noncharacters: false }), { code: 'text' });
  assert.equal(decode(fromHex('f7'), { wire: 'bindle', top: 'any', undefinedValue: true }), undefined);
  // cose stays the Bindle option: integer labels in the top-level map only, under keys 'text'
  assert.deepStrictEqual(decode(fromHex('a10100'), { ...B, cose: true }), new Map([[1, 0]]));
  assert.throws(() => decode(fromHex('a16161a10100'), { ...B, cose: true }), { code: 'key_type' });
});

test('JS values: maps by key kind, Tagged, undefined, special floats; key collisions refused', () => {
  assert.equal(Object.getPrototypeOf(decode(fromHex('a1616101'))), null);
  assert.ok(decode(fromHex('a10101')) instanceof Map);
  const mixed = decode(fromHex('a2616101810002'));
  assert.ok(mixed instanceof Map); assert.deepStrictEqual([...mixed.keys()], ['a', [0]]);
  const t = decode(fromHex('c074323031332d30332d32315432303a30343a30305a'));
  assert.ok(t instanceof Tagged && Object.isFrozen(t)); assert.equal(t.tag, 0); assert.equal(t.value, '2013-03-21T20:04:00Z');
  assert.throws(() => decode(fromHex('a201f93c00f93c0001')), { code: 'unsupported' });  // 1 and 1.0
  assert.throws(() => decode(fromHex('a2f90000f98000f9800001')), { code: 'unsupported' });  // 0.0 and -0.0
  assert.equal(view(fromHex('a201f93c00f93c0001')).length, 2);  // a view still reads it
  assert.throws(() => new Tagged(-1, 0), TypeError);
  assert.throws(() => new Tagged(2 ** 32, 0), TypeError);
});

test('encode: Maps, Tagged and undefined under each preset; the profile decides what encodes', () => {
  assert.equal(toHex(encode(new Map([[1, 2], [3, 4]]))), 'a201020304');
  assert.equal(toHex(encode(new Map([['a', 1], [-1, 2], [[0], 3], [new Uint8Array([0]), 4]]))), 'a4200241000461610181000' + '3');
  assert.equal(toHex(encode([NaN, -0, Infinity, -Infinity, undefined])), '85f97e00f98000f97c00f9fc00f7');
  assert.equal(toHex(encode(new Tagged(32, 'http://www.example.com'))), 'd82076687474703a2f2f7777772e6578616d706c652e636f6d');
  assert.equal(toHex(encode(new Tagged(24, encode(new Map([[1, 2]]))))), 'd81843a10102');
  assert.equal(toHex(encode(new Tagged(55799, { a: 1 }))), 'd9d9f7a1616101');
  for (const [v, code] of [[new Tagged(0, 'yesterday'), 'tag'], [new Tagged(1, 'x'), 'tag'], [new Tagged(1, NaN), 'tag'],
    [new Tagged(32, '/relative'), 'tag'], [new Tagged(5, [1, 2]), 'tag'], [new Tagged(2, new Uint8Array(9)), 'tag'],
    [[new Tagged(55799, 0)], 'tag'], [new Tagged(24, Uint8Array.of(1, 2)), 'trailing'], [new Tagged(24, Uint8Array.of(0x18, 1)), 'non_shortest'],
    [new Tagged(24, 'text'), 'tag'], [new Map([[1, 0], [1n, 1]]), 'duplicate_key']])
    assert.throws(() => encode(v), { name: 'SnugFault', code }, `${code}`);
  assert.throws(() => encode(new Map([[[0], 1]]), { keys: 'integer' }), { code: 'key_type' });
  assert.equal(toHex(encode(new Map([[2n ** 64n - 1n, 0]]), { keys: 'integer' })), 'a11bffffffffffffffff00');
  assert.throws(() => encode(new Map([[2n ** 64n, 0]]), { keys: 'integer' }), { code: 'key_type' });
  // the Bindle preset keeps every old refusal
  for (const v of [NaN, -0, Infinity, undefined, new Map([[1, 2]]), new Tagged(0, '2013-03-21T20:04:00Z'), '￿', [undefined]])
    assert.throws(() => encode(v, B), SnugFault);
  assert.equal(toHex(encode(new Map([[1, 2]]), { ...B, cose: true })), 'a10102');
});

test('Writer: undefined(), tagged(), floats, key kinds per profile', () => {
  const hexOf = (opts, f) => { const w = new Writer(opts); f(w); return toHex(w.finish()); };
  assert.equal(hexOf({}, w => w.float(1)), 'f93c00');
  assert.equal(hexOf({}, w => w.float(NaN)), 'f97e00');
  assert.equal(hexOf({}, w => w.float(-0)), 'f98000');
  assert.equal(hexOf({}, w => w.float(16777216)), 'fa4b800000');
  assert.equal(hexOf({}, w => w.undefined()), 'f7');
  assert.equal(hexOf({}, w => w.tagged(1, 1363896240)), 'c11a514b67b0');
  assert.equal(hexOf({}, w => w.beginMap(3).key('a').uint(1).key(-1).uint(2).key([0]).uint(3).end()), 'a3200261610181000' + '3');
  assert.equal(hexOf({ keysSorted: true }, w => w.beginMap(2).key(1).null().key('a').null().end()), 'a201f66161f6');
  assert.throws(() => hexOf({ keysSorted: true }, w => w.beginMap(2).key('a').null().key(1)), { code: 'key_order' });
  assert.throws(() => hexOf({ keys: 'integer' }, w => w.beginMap(1).key([0])), { code: 'key_type' });
  assert.throws(() => hexOf(B, w => w.undefined()), { code: 'unsupported' });
  assert.throws(() => hexOf(B, w => w.float(1)), { code: 'float' });
  assert.throws(() => hexOf(B, w => w.tagged(1, 0)), { code: 'tag' });
  assert.throws(() => hexOf(B, w => w.beginMap(1).key(1)), { code: 'key_type' });
  assert.throws(() => hexOf({}, w => w.tagged(0, 'not a date')), { code: 'tag' });
  // a container key's items count toward the bound
  assert.throws(() => hexOf({ maxItems: 4 }, w => w.beginMap(1).key([1, 2, 3]).uint(0).end()), { code: 'too_many_items' });
  assert.equal(hexOf({ maxItems: 6 }, w => w.beginMap(1).key([1, 2, 3]).uint(0).end()), 'a18301020300');
});

test('views: integer and container keys, tagged items, undefined', () => {
  const v = view(encode(new Map([[1, 'one'], [-1, 'minus'], [[0], 'zero-array'], ['t', new Tagged(1, 5)], ['u', undefined]])));
  assert.equal(v.get(1).text(), 'one');
  assert.equal(v.get(-1n).text(), 'minus');
  assert.equal(v.get([0]).text(), 'zero-array');
  assert.equal(v.get([1]), undefined);
  assert.equal(v.get('t').kind, 'tagged'); assert.equal(v.get('t').tag, 1); assert.equal(v.get('t').content().int(), 5);
  assert.ok(v.get('t').value() instanceof Tagged);
  assert.equal(v.get('u').kind, 'undefined'); assert.equal(v.get('u').isUndefined(), true);
  assert.deepStrictEqual([...v.keys()], [1, -1, 't', 'u', [0]]);
  const c = v.cursor(); assert.ok(c.find([0])); assert.equal(c.text(), 'zero-array');
  // the Bindle preset refuses the same bytes when the view opens
  assert.throws(() => view(encode(new Map([[1, 'one']])), B), { code: 'key_type' });
  const tv = view(fromHex('d8464401000000'));
  assert.equal(tv.kind, 'typed'); assert.equal(tv.tag, 70);
});

test('schemas: the prelude types the deterministic preset admits; float ranges over ±0, NaN and infinities', async () => {
  const s = await compile(`
    d = tdate
    t = time
    u = uri
    e = encoded-cbor
    s = cbor-any
    x = undefined
    k = { 1: int, -1: bstr, ? h'00' => bool }
    r = 0.0..1.0
    g = float .ge 1.5
    b = #6.24(bytes .cbor k)
  `);
  const ok = (rule, hex, opts = {}) => s.validate(fromHex(hex), rule, opts);
  assert.deepEqual(ok('d', 'c074323031332d30332d32315432303a30343a30305a'), { ok: true });
  assert.equal(ok('d', 'c074323031332d30332d32315432303a30343a30305a', { wire: 'bindle' }).reason, 'cbor/tag');
  assert.equal(ok('d', 'c06161').reason, 'cbor/tag');
  assert.deepEqual(ok('t', 'c11a514b67b0'), { ok: true });
  assert.deepEqual(ok('t', 'c1fb41d452d9ec200000'), { ok: true });
  assert.deepEqual(ok('u', 'd82076687474703a2f2f7777772e6578616d706c652e636f6d'), { ok: true });
  assert.deepEqual(ok('e', 'd818456449455446'), { ok: true });
  assert.equal(ok('e', 'd818420102').reason, 'cbor/trailing');
  assert.deepEqual(ok('s', 'd9d9f7a0'), { ok: true });
  assert.equal(ok('s', '81d9d9f7a0').reason, 'cbor/tag');
  assert.deepEqual(ok('x', 'f7'), { ok: true });
  assert.equal(ok('x', 'f7', { wire: 'bindle' }).reason, 'cbor/simple');
  assert.deepEqual(ok('k', 'a20101204100'), { ok: true });
  assert.deepEqual(ok('k', 'a30101204100' + '4100f5'), { ok: true });
  assert.equal(ok('k', 'a20101204100', { wire: 'bindle' }).reason, 'cbor/key_type');
  assert.equal(ok('k', 'a3010120410041' + '00' + 'f6').reason, 'value');
  // D125: a cut (`:`) on a byte-string or float literal key is refused, never compiled as an absent member
  for (const text of ["r = { h'00': bool }", 'r = { ? 1.5: int }', 'r = { 18446744073709551616: int }'])
    await assert.rejects(compile(text), { code: 'map_cut' });
  for (const [hex, want] of [['f90000', true], ['f98000', true], ['f93c00', true], ['f93800', true], ['f9bc00', false], ['f97e00', false],
    ['f97c00', false], ['f9fc00', false], ['fb3ff199999999999a', false]]) assert.equal(ok('r', hex).ok, want, hex);
  for (const [hex, want] of [['f93e00', true], ['f97c00', true], ['f97e00', false], ['f9fc00', false], ['f93c00', false]]) assert.equal(ok('g', hex).ok, want, hex);
  assert.deepEqual(ok('b', 'd81846' + 'a20101204100'), { ok: true });
  assert.equal(ok('b', 'd81846' + 'a20101201801').reason, 'cbor/non_shortest');
  // schema decode builds the same values as decode; resumable validation agrees
  const bytes = fromHex('a20101204100');
  assert.deepStrictEqual(s.decode(bytes, 'k'), new Map([[1, 1], [-1, new Uint8Array([0])]]));
  assert.deepEqual(validateHandleSync(s, bufferHandle(bytes), 'k', {}, { chunk: 1, quantum: 1 }), { ok: true });
  assert.equal(validateHandleSync(s, bufferHandle(bytes), 'k', B, { chunk: 1 }).reason, 'cbor/key_type');
  assert.ok(Decimal);
});
