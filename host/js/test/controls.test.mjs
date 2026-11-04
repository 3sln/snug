// P7.2: extension controls (D082, D140-D142) through the public package.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile, SchemaError } from 'snug/compile';
import { ProgramError, fromSerialized, fromProgram } from 'snug/schema';
import { controls, chars, unique, samelen } from 'snug/controls';
import { encode, decode } from 'snug';
import { validateHandleSync, bufferHandle, pushValidator } from 'snug/sources';

const unhex = h => Uint8Array.from(Buffer.from(h, 'hex'));
// The table both hosts check (host/rust/tests/controls.rs reads the same file).
const table = JSON.parse(readFileSync(new URL('../../rust/tests/controls.json', import.meta.url)));

// Independent oracles over decoded values, not the kin predicates.
const oracle = {
  chars(arg, item) {
    const a = decode(arg, { top: 'any' }), v = decode(item, { top: 'any' });
    if (typeof v !== 'string') return false;
    const [lo, hi] = Array.isArray(a) ? a : [a, a];
    const n = [...v].length;
    return n >= lo && n <= hi;
  },
  unique(arg, item) {
    if (item[0] >> 5 !== 4) return false;
    const v = decode(item, { top: 'any' });
    const seen = new Set(v.map(x => Buffer.from(encode(x)).toString('hex')));
    return seen.size === v.length;
  },
  samelen(arg, item) {
    if (item[0] >> 5 !== 5) return false;
    const names = [].concat(decode(arg, { top: 'any' })), v = decode(item, { top: 'any' });
    let len = -1;
    for (const n of names) {
      if (!(n in v)) continue;
      const x = v[n];
      if (!Array.isArray(x) && !ArrayBuffer.isView(x)) return false;
      if (len >= 0 && x.length !== len) return false;
      len = x.length;
    }
    return true;
  },
};

test('generic controls: the shared table, an independent oracle and the kin predicates agree', () => {
  const byName = { chars, unique, samelen };
  for (const row of table) {
    const a = unhex(row.argument), item = unhex(row.item);
    assert.equal(byName[row.control].check(a, item), row.expect, JSON.stringify(row));
    assert.equal(oracle[row.control](a, item), row.expect, `oracle ${JSON.stringify(row)}`);
  }
  assert.ok(table.length >= 40 && table.some(r => r.expect) && table.some(r => !r.expect));
});

test('exactness under choices, maps, keys, arrays, embedded documents and nesting', async () => {
  const s = await compile(`
    choice = (tstr .chars (1..3)) / (tstr .size 10)
    ids = [* int] .unique true
    cols = { a: [* int], b: [* int], ? c: [* int] } .samelen ["a", "b", "c"]
    keyed = { * (tstr .chars (1..2)) => int }
    inner = bstr .cbor ([* uint] .unique 0)
    nested = [* ([* int] .unique 1) / tstr]
    ne = (tstr .chars 3) .ne "abc"`, { controls });
  const v = (rule, x) => s.validate(encode(x), rule);
  assert.deepEqual(v('choice', 'ab'), { ok: true });
  assert.deepEqual(v('choice', '0123456789'), { ok: true });                     // the other alternative
  assert.equal(v('choice', 'abcd').reason, 'control');
  assert.deepEqual(v('choice', '€€€'), { ok: true });                            // code points, not bytes
  assert.equal(v('choice', 7).reason, 'type');
  assert.deepEqual(v('ids', [3, 1, 2]), { ok: true });
  assert.equal(v('ids', [3, 1, 3]).reason, 'control');
  assert.deepEqual(v('cols', { a: [1, 2], b: [3, 4] }), { ok: true });
  assert.equal(v('cols', { a: [1, 2], b: [3], c: [] }).reason, 'control');
  assert.deepEqual(v('keyed', { a: 1, bc: 2 }), { ok: true });
  assert.equal(v('keyed', { abc: 1 }).reason, 'unexpected');
  assert.deepEqual(s.validate(encode(encode([1, 2])), 'inner'), { ok: true });
  const e = s.validate(encode(encode([2, 2])), 'inner');
  assert.equal(e.reason, 'embedded'); assert.equal(e.subcode, 'control');
  assert.deepEqual(v('nested', [[1, 2], 'x', [3]]), { ok: true });
  assert.equal(v('nested', [[1, 1]]).reason, 'control');
  assert.deepEqual(v('ne', 'abd'), { ok: true });
  assert.equal(v('ne', 'abc').reason, 'value');
  assert.equal(v('ne', 'ab').reason, 'control');
});

test('maxBytes: a longer item fails with control_size without asking, under every source', async () => {
  let asked = 0;
  const s = await compile('r = [* (tstr .short 0)]', {
    controls: { short: { check: () => { asked++; return true; }, maxBytes: 4 } } });
  assert.deepEqual(s.validate(encode(['abc']), 'r'), { ok: true });
  assert.equal(asked, 1);
  const long = encode(['abcdefgh']);
  assert.equal(s.validate(long, 'r').reason, 'control_size');
  assert.equal(asked, 1);
  for (const chunk of [1, 2, 3, 64]) {
    assert.equal(validateHandleSync(s, bufferHandle(long), 'r', {}, { chunk }).reason, 'control_size');
    assert.deepEqual(validateHandleSync(s, bufferHandle(encode(['ab', 'c'])), 'r', {}, { chunk }), { ok: true });
  }
});

test('sessions over every split give the buffer verdict, budget included', async () => {
  const s = await compile('r = { x: [* (tstr .chars (1..40))], y: [* int] .unique 0 }', { controls });
  const bytes = encode({ x: ['a', 'é'.repeat(30), 'b'.repeat(50)], y: [5, 6, 7, 5] });
  const want = s.validate(bytes, 'r');
  assert.equal(want.reason, 'control');
  for (let chunk = 1; chunk <= bytes.length; chunk++)
    for (const quantum of [0, 1, 3])
      assert.deepEqual(validateHandleSync(s, bufferHandle(bytes), 'r', {}, { chunk, quantum }), want, `chunk ${chunk} quantum ${quantum}`);
  const p = pushValidator(s, bytes.length, 'r');
  for (let i = 0; i < bytes.length; i += 3) { let r = p.feed(bytes.subarray(i, i + 3)); while (r.state === 'yield') r = p.resume(); }
  assert.deepEqual(p.finalize(), want);
  for (let budget = 0; budget < 400; budget += 7)
    for (const chunk of [1, 5])
      assert.deepEqual(validateHandleSync(s, bufferHandle(bytes), 'r', { budget }, { chunk }), s.validate(bytes, 'r', { budget }));
});

test('an unregistered control is a SchemaError naming it; registry and argument checks', async () => {
  await assert.rejects(compile('r = tstr .nope 1', { controls }),
    e => e instanceof SchemaError && e.code === 'unknown_control' && /\.nope/.test(e.message));
  await assert.rejects(compile('r = tstr .chars 1'), e => e.code === 'unknown_control' && /\.chars/.test(e.message));
  await assert.rejects(compile('r = tstr .chars "x"', { controls }), e => e.code === 'control_value' && /\.chars/.test(e.message));
  await assert.rejects(compile('r = tstr .chars (1 / 2)', { controls }), e => e.code === 'control_value');
  await assert.rejects(compile('r = 1', { controls: { size: () => true } }), TypeError);
  await assert.rejects(compile('r = 1', { controls: { '9x': () => true } }), TypeError);
  await assert.rejects(compile('r = 1', { controls: { x: 5 } }), TypeError);
  await assert.rejects(compile('r = 1', { controls: { x: { check: () => true, maxBytes: -1 } } }), TypeError);
  await assert.rejects(compile('r = 1', { controls: [] }), TypeError);
});

test('the bus profile refuses extension controls unless controlsInBus', async () => {
  await assert.rejects(compile('r = tstr .size (0..9) .chars 2', { profile: 'bus', controls }), e => e.code !== undefined);
  await assert.rejects(compile('r = (tstr .size (0..9)) .chars 2', { profile: 'bus', controls }), e => e.code === 'profile');
  const s = await compile('r = (tstr .size (0..9)) .chars 2', { profile: 'bus', controls, controlsInBus: true });
  assert.deepEqual(s.validate(encode('ab'), 'r'), { ok: true });
});

test('format 1.1 only with a control; serialised Programs need the registry, and the source key binds it', async () => {
  const plain = await compile('r = tstr');
  assert.equal(plain.program.P[1], 1);
  const a = await compile('r = tstr .chars 2', { controls });
  assert.equal(a.program.P[1], 0x10001);
  assert.deepEqual(a.program.controls, ['chars']);
  const b = await compile('r = tstr .chars 2', { controls: { chars } });
  assert.notEqual(a.program.sourceKey, b.program.sourceKey);          // the whole registry is in the key
  const c = await compile('r = tstr .chars 2', { controls: { chars: { ...chars, maxBytes: 9 } } });
  assert.notEqual(b.program.sourceKey, c.program.sourceKey);          // and each maxBytes
  const bytes = a.program.serialize();
  await assert.rejects(fromSerialized(bytes), e => e instanceof ProgramError && e.code === 'missing_control' && /\.chars/.test(e.message));
  await assert.rejects(fromSerialized(bytes, { controls: { unique } }), e => e.code === 'missing_control');
  const loaded = await fromSerialized(bytes, { controls: { chars } });
  assert.deepEqual(loaded.validate(encode('ab'), 'r'), { ok: true });
  assert.equal(loaded.validate(encode('abc'), 'r').reason, 'control');
  await assert.rejects(fromProgram(a.program.P, a.program.B), e => e.code === 'missing_control');
  assert.deepEqual((await fromProgram(a.program.P, a.program.B, { controls })).validate(encode('ab'), 'r'), { ok: true });
  await assert.rejects(fromSerialized(bytes, { controls: { chars }, bogus: 1 }), TypeError);
});

test('predicates see the encoded argument and item; a throwing predicate fails the call', async () => {
  const seen = [];
  const s = await compile('r = [* (int .spy [1, "a"])]', {
    controls: { spy: (arg, item) => { seen.push([Buffer.from(arg).toString('hex'), Buffer.from(item).toString('hex')]); return true; } } });
  assert.deepEqual(s.validate(encode([7, 300]), 'r'), { ok: true });
  assert.deepEqual(seen, [['820161 61'.replace(' ', ''), '07'], ['82016161', '19012c']]);
  const t = await compile('r = tstr .boom 0', { controls: { boom: () => { throw new Error('inner'); } } });
  assert.throws(() => t.validate(encode('x'), 'r'), e => /\.boom threw/.test(e.message) && e.cause.message === 'inner');
  assert.deepEqual(t.validate(encode(1), 'r').reason, 'type');      // never asked: the target failed
});
