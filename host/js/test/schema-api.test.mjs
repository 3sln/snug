// P9.16 (D342): compile warnings on the Schema, the `cut` subcode, Schema/Program refusing structured clone, and
// the package build's dirty-tree report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/public-compile.mjs';
import { fromSerialized, Schema, Program } from '../src/public-schema.mjs';
import { encode } from '../src/index.mjs';
import { dirtyPaths } from '../src/package-build.mjs';

const UNION = 'r = { kind: "a", x: int // kind: "b", y: tstr }';

test('compile warnings reach schema.warnings, frozen; a loaded Program has none', async () => {
  const s = await compile(UNION);
  assert.equal(s.warnings.length, 1);
  const [w] = s.warnings;
  assert.deepEqual([w.code, w.rule, w.line, w.column], ['W8', 'r', 1, 28]);
  assert.match(w.message, /cut/);
  assert.ok(Object.isFrozen(s.warnings) && Object.isFrozen(w));
  assert.deepEqual((await compile('r = uint')).warnings, []);
  assert.deepEqual((await fromSerialized(s.program.serialize())).warnings, []);
  assert.deepEqual(new Schema(new Program(s.program.P, s.program.B)).warnings, []);
});

test('a value a cut decided carries the subcode cut; an ordinary wrong value none', async () => {
  const s = await compile(UNION);
  assert.deepEqual(s.validate(encode({ kind: 'b', y: 'z' }), 'r'), { ok: false, reason: 'value', path: ['kind'], offset: 0, subcode: 'cut' });
  assert.equal(s.validate(encode({ kind: 'c', y: 'z' }), 'r').subcode, undefined);
  assert.deepEqual((await compile(UNION, { cuts: 'branch' })).validate(encode({ kind: 'b', y: 'z' }), 'r'), { ok: true });
  assert.throws(() => s.decode(encode({ kind: 'b', y: 'z' }), 'r'), e => e.code === 'schema/value' && e.subcode === 'cut');
  const plain = await compile('r = { a: "x" }');
  assert.equal(plain.validate(encode({ a: 'y' }), 'r').subcode, undefined);
});

test('D359: .default carries the implied .ne; defaultControl: annotation drops it and changes the source key', async () => {
  const text = 'r = { ? n: uint .default 5 }';
  const ne = await compile(text), ann = await compile(text, { defaultControl: 'annotation' });
  assert.equal(ne.validate(encode({ n: 5 }), 'r').ok, false);
  assert.equal(ne.validate(encode({ n: 4 }), 'r').ok, true);
  assert.equal(ne.validate(encode({}), 'r').ok, true);
  assert.equal(ann.validate(encode({ n: 5 }), 'r').ok, true);
  assert.equal((await compile(text, { defaultControl: 'ne' })).program.sourceKey, ne.program.sourceKey);
  assert.notEqual(ann.program.sourceKey, ne.program.sourceKey);
  assert.equal((await compile('r = bool .default false')).validate(encode(false), 'r').ok, false);
  await assert.rejects(async () => compile(text, { defaultControl: 'none' }), TypeError);
});

test('Schema and Program refuse structured clone (postMessage) with DataCloneError', async () => {
  const s = await compile('r = uint');
  for (const x of [s, s.program]) {
    assert.equal(typeof x.brand, 'symbol');
    assert.throws(() => structuredClone(x), { name: 'DataCloneError' });
  }
  assert.throws(() => structuredClone({ nested: [s] }), { name: 'DataCloneError' });
  // the documented way across a thread boundary: serialize() bytes clone fine and load back
  const bytes = structuredClone(s.program.serialize());
  assert.deepEqual((await fromSerialized(bytes)).validate(Uint8Array.of(1), 'r'), { ok: true });
});

test('npm run build reports a dirty checkout (dirtyPaths)', () => {
  const d = dirtyPaths();
  assert.ok(d === null || Array.isArray(d));
  assert.equal(dirtyPaths('/'), null);   // not a checkout
});
