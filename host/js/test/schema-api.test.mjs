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

test('D373: strict lexing (the default) refuses HT, a lone CR and comment controls; lexing: lenient is 0.1.0\'s', async () => {
  const refused = [['r =\tuint', 1, 4], ['r = {\n\ta: uint\n}', 2, 1], ['r = uint\rs = tstr', 1, 9], ['r = uint ; c\rs = tstr', 1, 13],
    ['r = uint ; a\tb', 1, 13], ['r = uint ; \u0001', 1, 12], ['r = uint ; \u007f', 1, 12], ['r = uint ; \u0085', 1, 12]];
  for (const [text, line, column] of refused) {
    await assert.rejects(async () => compile(text), e => e.code === 'syntax' && e.line === line && e.column === column &&
      /lexing: 'lenient'/.test(e.message), JSON.stringify(text));
    const s = await compile(text, { lexing: 'lenient' });
    assert.equal(s.validate(encode(text.includes('{') ? { a: 1 } : 1), 'r').ok, true, JSON.stringify(text));
  }
  // a final comment needs no newline, in both modes; CR LF and a non-ASCII comment are strict
  for (const lexing of ['strict', 'lenient'])
    assert.equal((await compile('r = uint ; the end', { lexing })).validate(encode(1), 'r').ok, true);
  assert.equal((await compile('r = uint\r\n; café ✓\r\ns = tstr\r\n')).validate(encode('a'), 's').ok, true);
  // bound into the source key: 'strict' is the default, 'lenient' another key for the same Program
  const text = 'r = uint', strict = await compile(text), lenient = await compile(text, { lexing: 'lenient' });
  assert.equal((await compile(text, { lexing: 'strict' })).program.sourceKey, strict.program.sourceKey);
  assert.notEqual(lenient.program.sourceKey, strict.program.sourceKey);
  await assert.rejects(async () => compile(text, { lexing: 'loose' }), TypeError);
});

test('D374: b64\'\' content skips ;-comments under strict lexing; comment controls in h\'\'/b64\'\' are refused there; lenient is 0.1.0\'s', async () => {
  const bytes = Uint8Array.of(0x42, 1, 2);
  const b64 = ["r = b64'AQ ; c\n I='", "r = b64'AQI= ; c\n'", "r = b64'AQI= ; end'"];
  for (const text of b64) {
    assert.equal((await compile(text)).validate(bytes, 'r').ok, true, JSON.stringify(text));
    // lenient: a ; in b64'' is refused, as 0.1.0 refused it
    await assert.rejects(async () => compile(text, { lexing: 'lenient' }), e => e.code === 'syntax' && e.column === 5, JSON.stringify(text));
  }
  // a control character, which only an escape can put in the content, at the literal (line 2, column 5)
  for (const ctl of ['\\u0001', '\\t', 'a\\rb', '\\u007f', '\\u{85}']) {
    const h = `s = uint\nr = h'01 ; ${ctl}\n 02'`, b = `s = uint\nr = b64'AQI= ; ${ctl}\n'`;
    // plain `syntax` (no lexing hint: lenient helps for h'' only); lenient accepts it in h'' (0.1.0) and refuses
    // the b64'' comment itself
    for (const text of [h, b])
      await assert.rejects(async () => compile(text), e => e.code === 'syntax' && e.line === 2 && e.column === 5 && !/lenient/.test(e.message), text);
    assert.equal((await compile(h, { lexing: 'lenient' })).validate(bytes, 'r').ok, true, h);
    await assert.rejects(async () => compile(b, { lexing: 'lenient' }), e => e.code === 'syntax', b);
  }
  // CR LF ends a comment; a non-ASCII escape is a PCHAR
  assert.equal((await compile("r = b64'AQ ; caf\\u00e9\r\n I='")).validate(bytes, 'r').ok, true);
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
