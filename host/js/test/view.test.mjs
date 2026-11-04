// P5.2: views and cursor (host/js/src/view.mjs) against the trusted builder.
// Every accepted vector and oracle value, and seeded random documents, are
// navigated in full through accessors only and compared with build(); get/at/
// entries are checked against each other, with and without directories,
// owned and borrowed; refusals, ownership and detached validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { view, View, directoryWords, messageOf } from '../src/view.mjs';
import { build } from '../src/build.mjs';
import { compile } from '../src/schema.mjs';
import { snug, baseline, profile, oracle, expected, fromHex } from './values.mjs';
import { createRandom, randomMap, randomValue, mutate } from './corpus.mjs';

const MODES = [{}, { directories: true }, { borrow: true }, { borrow: true, directories: true }];
const B = snug.profiles.bindle;

/** Rebuild a value from navigation alone (no value() except for the wrapper kinds), checking the accessors agree. */
function walk(v, cose = false) {
  switch (v.kind) {
    case 'int': {
      const i = v.int();
      assert.equal(BigInt(i), v.bigint());
      if (typeof i === 'number') assert.equal(v.number(), i); else assert.throws(() => v.number(), RangeError);
      return i;
    }
    case 'float': return v.number();
    case 'text': assert.equal(v.length, new TextEncoder().encode(v.text()).length); return v.text();
    case 'bytes': {
      const a = v.bytes(), c = v.copyBytes();
      assert.deepStrictEqual(c, Uint8Array.from(a)); assert.equal(v.length, c.length);
      return c;
    }
    case 'bool': return v.bool();
    case 'null': assert.equal(v.isNull(), true); return null;
    case 'array': {
      const out = [];
      for (const [i, e] of v.entries()) { assert.equal(v.at(i).offset, e.offset); out.push(walk(e)); }
      assert.equal(out.length, v.length); assert.equal(v.at(v.length), undefined); assert.equal(v.at(-1), undefined);
      return out;
    }
    case 'map': {
      const out = cose ? new Map() : Object.create(null);
      let n = 0;
      for (const [k, e] of v.entries()) {
        assert.equal(v.get(k).offset, e.offset, `get(${String(k)})`);
        const x = walk(e);
        if (cose) out.set(k, x); else Object.defineProperty(out, k, { value: x, enumerable: true, writable: true, configurable: true });
        n++;
      }
      assert.equal(n, v.length);
      assert.equal(v.get('\u0000absent￿'), undefined);
      return out;
    }
    case 'typed': {
      const t = v.typed(), tv = v.typedView();
      assert.equal(tv.length, t.length); assert.equal(v.length, t.length);
      for (let i = 0; i < t.length; i++) {
        const want = t instanceof snug.Float16Bytes ? undefined : t[i];
        if (want !== undefined) assert.ok(Object.is(tv.get(i), want), `typed ${i}`);
      }
      return t;
    }
    case 'decimal': return v.decimal();
    case 'ndarray': return v.ndarray();
    default: assert.fail(`kind ${v.kind}`);
  }
}

/** Visit every item with a Cursor; answers the item count and checks keys against entries(). */
function cursorWalk(v) {
  const c = v.cursor();
  let count = 1;
  const rec = () => {
    const kind = c.kind;
    if ((kind === 'array' || kind === 'map') && c.enter()) {
      const keys = [];
      do { count++; keys.push(c.key); rec(); } while (c.next());
      assert.ok(c.up());
      const want = [...c.view().keys()];
      assert.deepStrictEqual(keys, want);
    }
  };
  rec();
  return count;
}

function checkAll(bytes, want, opts = {}) {
  for (const mode of MODES) {
    const v = view(bytes, { ...opts, ...mode });
    const cose = opts.cose === true && v.kind === 'map';
    assert.deepStrictEqual(walk(v, cose), want);
    assert.deepStrictEqual(v.value(), want);
    assert.deepStrictEqual(Uint8Array.from(v.raw()), Uint8Array.from(bytes));
    cursorWalk(v);
  }
}

for (const v of profile.accept) test(`view: profile accept ${v.name}`, () => {
  const bytes = fromHex(v.hex);
  checkAll(bytes, build(bytes), { top: 'any' });
  assert.deepStrictEqual(build(bytes), expected(v.value));
});

test('view: every Bindle-accepted oracle value', () => {
  let n = 0;
  for (const c of oracle.cases) {
    if (!c.accept) continue;
    const bytes = fromHex(c.hex);
    try { baseline.decode(bytes, { top: 'any' }); } catch { continue; }
    checkAll(bytes, build(bytes), { top: 'any' });
    n++;
  }
  assert.ok(n > 50, `${n} oracle values`);
});

test('view: seeded random documents (maps and any top), subtrees materialise like build()', () => {
  const r = createRandom(0x5e1f);
  for (let i = 0; i < 400; i++) {
    const value = i % 2 ? randomMap(r, { maxDepth: 5 }) : randomValue(r, { maxDepth: 5 });
    const bytes = snug.encode(value, { top: 'any' });
    checkAll(bytes, build(bytes), { top: 'any' });
    // every subtree's raw span decodes to that subtree's value()
    const v = view(bytes, { top: 'any' });
    const stack = [v];
    while (stack.length) {
      const x = stack.pop();
      assert.deepStrictEqual(build(Uint8Array.from(x.raw())), x.value());
      if (x.kind === 'array' || x.kind === 'map') for (const e of x.values()) stack.push(e);
    }
  }
});

test('view: large maps and arrays (directories engage) agree with linear lookup', () => {
  const r = createRandom(7);
  const big = Object.create(null);
  for (let i = 0; i < 3000; i++) big['k' + r.int(1e6)] = i % 3 ? i : ['x', i];
  const arr = Array.from({ length: 500 }, (_, i) => ({ i, s: 'v' + i }));
  const bytes = snug.encode({ big, arr });
  const lin = view(bytes), dir = view(bytes, { directories: true });
  for (const k of Object.keys(big).slice(0, 500)) assert.equal(dir.get('big').get(k).offset, lin.get('big').get(k).offset);
  for (let i = 0; i < 500; i += 7) assert.equal(dir.get('arr').at(i).offset, lin.get('arr').at(i).offset);
  assert.equal(dir.get('big').get('nope'), undefined);
  assert.ok(directoryWords(dir) >= Object.keys(big).length);
  assert.equal(directoryWords(lin), 0);
});

test('view: cose labels in the top-level map only', () => {
  const m = new Map([[1, -7], [4, new Uint8Array([1, 2])], [-1, 'x']]);
  const bytes = snug.encode(m, { cose: true });
  const v = view(bytes, { cose: true });
  assert.equal(v.get(1).int(), -7);
  assert.equal(v.get(-1).text(), 'x');
  assert.equal(v.get(2), undefined);
  assert.deepStrictEqual(v.value(), build(bytes, { cose: true }));
  assert.deepStrictEqual([...v.keys()], [...build(bytes, { cose: true }).keys()]);
});

test('view: refusals -- unchecked bytes throw the scanner code; shared and non-byte input refused', () => {
  const r = createRandom(99);
  let refused = 0;
  for (let i = 0; i < 1500; i++) {
    const bytes = mutate(r, snug.encode(randomMap(r)));
    let code;
    try { snug.decode(bytes); } catch (e) { code = e.code; }
    if (code === undefined) { view(bytes, B); continue; }
    for (const mode of MODES) assert.throws(() => view(bytes, { ...B, ...mode }), e => e.code === code);
    refused++;
  }
  assert.ok(refused > 500);
  if (typeof SharedArrayBuffer === 'function') {
    const s = new Uint8Array(new SharedArrayBuffer(4)); s.set([0xa1, 0x61, 0x61, 0x01]);
    assert.throws(() => view(s), TypeError);
    assert.throws(() => view(s, { borrow: true }), TypeError);
  }
  assert.throws(() => view([0xa0]), TypeError);
  assert.throws(() => view(fromHex('01'), B), e => e.code === 'not_map');
  assert.equal(view(fromHex('01'), { ...B, top: 'any' }).int(), 1);
  assert.equal(view(fromHex('01')).int(), 1); // the deterministic preset's root is any item
});

test('view: owned views copy at open; borrowed views alias the caller', () => {
  const bytes = snug.encode({ a: new Uint8Array([1, 2, 3]), b: 'hi' });
  const owned = view(bytes), borrowed = view(bytes, { borrow: true });
  assert.equal(owned.borrowed, false); assert.equal(borrowed.borrowed, true);
  assert.equal(borrowed.get('a').bytes().buffer, bytes.buffer);
  assert.notEqual(owned.get('a').bytes().buffer, bytes.buffer);
  const copy = owned.get('a').copyBytes(); copy[0] = 9;
  assert.equal(owned.get('a').bytes()[0], 1);
  bytes[bytes.length - 1] = 0x48; // 'i' -> 'H' in the caller's buffer
  assert.equal(owned.get('b').text(), 'hi');
  assert.equal(borrowed.get('b').text(), 'hH'); // the broken promise is visible, not unsafe
});

test('view: accessors are exact', () => {
  const bytes = snug.encode({ big: 2n ** 60n, neg: -(2n ** 64n), safe: 2 ** 53 - 1, nsafe: -(2 ** 53 - 1), f: 0.5, t: true, n: null, d: snug.Decimal.from('1.25') });
  const v = view(bytes);
  assert.throws(() => v.get('big').number(), RangeError);
  assert.equal(v.get('big').bigint(), 2n ** 60n);
  assert.equal(v.get('big').int(), 2n ** 60n);
  assert.equal(v.get('neg').bigint(), -(2n ** 64n));
  assert.equal(v.get('safe').number(), 2 ** 53 - 1);
  assert.equal(v.get('nsafe').number(), -(2 ** 53 - 1));
  assert.equal(v.get('f').number(), 0.5);
  assert.equal(v.get('t').bool(), true);
  assert.equal(v.get('n').isNull(), true);
  assert.equal(v.get('d').decimal().toString(), '1.25');
  assert.throws(() => v.get('t').text(), TypeError);
  assert.throws(() => v.get('f').get('x'), TypeError);
  assert.throws(() => v.at(0), TypeError);
});

test('view: schema-checked open, and validateAt agrees with validating the span standalone', async () => {
  const schema = await compile(`
    doc = { name: tstr, ? tags: [* tstr], items: [* item], meta: meta }
    item = { id: uint, ? label: tstr .size (1..8), ? score: int / float }
    meta = { * tstr => int / tstr }
    label = tstr .size (1..8)
  `);
  const r = createRandom(31);
  let agree = 0, bad = 0;
  for (let i = 0; i < 300; i++) {
    const items = Array.from({ length: r.int(6) }, () => {
      const it = { id: r.chance(0.9) ? r.int(1000) : -1 };
      if (r.chance(0.6)) it.label = 'abcdefghijk'.slice(0, r.int(11));
      if (r.chance(0.4)) it.score = r.chance(0.5) ? r.int(50) - 25 : 0.5;
      return it;
    });
    const doc = { name: 'n' + i, items, meta: { a: 1, b: r.chance(0.9) ? 'x' : 0.25 } };
    if (r.chance(0.5)) doc.tags = ['t'];
    const bytes = snug.encode(doc);
    const whole = schema.validate(bytes, 'doc');
    if (!whole.ok) { assert.throws(() => view(bytes, { schema, rule: 'doc' }), e => e.reason === whole.reason); bad++; }
    const v = whole.ok ? view(bytes, { schema, rule: 'doc' }) : view(bytes);
    for (const [k, rule] of [['meta', 'meta'], ['items', null]]) {
      const targets = rule ? [[v.get(k), rule]] : [...v.get(k).values()].map(x => [x, 'item']);
      for (const [x, rl] of targets) {
        const span = Uint8Array.from(x.raw());
        const a = x.validateAt(rl, { schema }), b = schema.validate(span, rl, { top: 'any' });
        assert.equal(a.ok, b.ok);
        if (!a.ok) { assert.equal(a.reason, b.reason); assert.deepStrictEqual(a.path, b.path); assert.equal(a.offset - x.offset, b.offset); }
        agree++;
      }
      for (const lab of v.get('items').values()) if (lab.get('label')) {
        const l = lab.get('label'), a = l.validateAt('label', { schema }), b = schema.validate(Uint8Array.from(l.raw()), 'label', { top: 'any' });
        assert.equal(a.ok, b.ok);
      }
    }
  }
  assert.ok(agree > 500 && bad > 10, `${agree} agreements, ${bad} schema refusals`);
  assert.throws(() => view(snug.encode({ a: 1 })).validateAt('doc'), TypeError);
  assert.throws(() => view(snug.encode({ a: 1 }), { schema }), TypeError);
});

test('view: a View is a cheap object', () => {
  const v = view(snug.encode({ a: [1, 2, 3] }));
  assert.ok(v instanceof View);
  assert.deepStrictEqual(Object.keys(v), []);   // its state is private (D215; review 2026-11-04 #3)
  assert.throws(() => new View({ b: Uint8Array.of(0x62, 0xc0, 0xae) }, 0, 0), TypeError);
});

test('view: the step budget bounds one walk, not the view\'s life; a failed walk throws, never a silent miss', () => {
  const v = view(snug.encode({ a: Array.from({ length: 1000 }, (_, i) => i) }));
  const a = v.get('a');
  for (let k = 0; k < 50; k++) assert.equal(a.at(900).int(), 900);   // ~45 000 steps in all
  messageOf(v).o[5] = 100;                                           // N_BUDGET: 100 heads per walk
  for (let k = 0; k < 20; k++) assert.equal(a.at(50).int(), 50);
  assert.throws(() => a.at(500), /navigation failed/);
});
