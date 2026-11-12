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
