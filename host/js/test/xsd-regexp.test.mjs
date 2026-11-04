import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile, SchemaError } from 'snug/compile';
import { encode } from 'snug';
import { tables } from 'snug/unicode';
import { compile as raw, lastBudgetUsed } from '../src/compile.mjs';
const vectors = JSON.parse(readFileSync(new URL('../../../corpus/conformance/xsd-regexp.json', import.meta.url)));
const schema = pattern => `r = tstr .regexp ${JSON.stringify(pattern).replaceAll(String.fromCodePoint(0x10ffff), '\\u{10ffff}')}`;

for (const c of vectors.cases) test(`XSD Appendix F: ${c.name}`, async () => {
  const s = await compile(schema(c.pattern), { unicode: c.unicode ? tables : undefined });
  const ref = c.node === undefined ? undefined : new RegExp(`^(?:${c.node})$`, 'v');
  for (const [texts, want] of [[c.accept, true], [c.reject, false]]) for (const text of texts) {
    assert.equal(s.validate(encode(text), 'r').ok, want, JSON.stringify(text));
    // Node $ permits a trailing newline: require the matched span to cover the text.
    if (ref) assert.equal(ref.exec(text)?.[0] === text, want, `Node v translation ${c.node}: ${JSON.stringify(text)}`);
  }
});

test('XSD grammar refuses invalid constructs and host extensions', async () => {
  for (const pattern of vectors.invalid)
    await assert.rejects(compile(schema(pattern), { unicode: tables }), { code: 'regexp' }, pattern);
});

test('XSD optional category data and explicit unavailable block data', async () => {
  for (const pattern of ['\\d', '\\D', '\\w', '\\W', '[\\d]', '\\p{L}'])
    await assert.rejects(compile(schema(pattern)), e => e instanceof SchemaError && e.code === 'regexp' && /snug\/unicode/.test(e.message));
  for (const pattern of ['\\p{IsBasicLatin}', '\\P{IsGreek}', '[\\p{IsBasicLatin}]']) for (const unicode of [undefined, tables])
    await assert.rejects(compile(schema(pattern), { unicode }), e => e instanceof SchemaError && e.code === 'regexp' && /pinned Unicode block data/.test(e.message) && e.rule === 'r' && e.line === 1 && e.column > 0);
  // XML names and whitespace deliberately need no category tables.
  await compile(schema('\\i\\c*'));
  await compile(schema('\\s\\S'));
});

test('I-Regexp stays strict, and the compile option is validated', async () => {
  for (const pattern of ['\\d', '\\D', '\\w', '\\W', '\\s', '\\S', '\\i', '\\I', '\\c', '\\C', '[a-z-[aeiou]]'])
    await assert.rejects(compile(schema(pattern), { regexp: 'iregexp', unicode: tables }), { code: 'regexp' });
  for (const regexp of [null, true, 0, 'XSD', 'private-value', [], {}])
    await assert.rejects(compile('r = uint', { regexp }), e => e instanceof TypeError && /regexp/.test(e.message) && !/private-value/.test(e.message));
  const text = schema('[a-z]+');
  assert.deepEqual(raw(text).program, raw(text, { regexp: 'xsd' }).program);
  const x = raw(text).program, i = raw(text, { regexp: 'iregexp' }).program;
  assert.notDeepEqual(x.slice(7, 15), i.slice(7, 15));
  assert.deepEqual(x.slice(15), i.slice(15));
});

test('XSD expansion, subtraction and nesting obey existing bounds', async () => {
  await assert.rejects(compile(schema('[a-z-[aeiou]]{513}')), { code: 'limit_regexp_positions' });
  await assert.rejects(compile(schema('(){100000000001,100000000000}')), { code: 'regexp' });
  const epsilon = await compile(schema('(){999999999999,1000000000000}'));
  assert.equal(epsilon.validate(encode(''), 'r').ok, true);
  await assert.rejects(compile(schema('a{999999999999999999}')), { code: 'limit_regexp_positions' });
  await assert.rejects(compile(schema('[a-z-[aeiou]]{2}'), { limits: { regexpPositions: 1 } }), { code: 'limit_regexp_positions' });
  const nested = '[a-'.repeat(520) + '[a]' + ']'.repeat(520);
  await assert.rejects(compile(schema(nested)), { code: 'limit_nesting' });
  const text = schema('[\\p{L}-[\\p{Lu}-[A-Z]]]');
  raw(text, { unicode: tables });
  const used = lastBudgetUsed();
  raw(text, { unicode: tables, limits: { compileBudget: used } });
  assert.throws(() => raw(text, { unicode: tables, limits: { compileBudget: used - 1 } }), { code: 'limit_compile_budget' });
  await assert.rejects(compile(text, { unicode: tables, profile: 'bus' }), { code: 'profile' });
});
