import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile, SchemaError } from 'snug/compile';
import { tables, categories, unicodeVersion } from 'snug/unicode';
import { fromSerialized } from 'snug/schema';
import { compile as compileRaw, lastBudgetUsed } from '../src/compile.mjs';

const schemaText = pattern => `r = tstr .regexp ${JSON.stringify(pattern)}`;
const id = s => s.charCodeAt(0) * 256 + (s.charCodeAt(1) || 0);
const scalar = cp => cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
const noncharacter = cp => (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xffff) >= 0xfffe;
const textBytes = text => {
  const body = new TextEncoder().encode(text);
  assert.ok(body.length < 24);
  return Uint8Array.of(0x60 + body.length, ...body);
};
let seed = 0x1929485;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % 0x110000; };

// The oracle: Node's own \p{gc=..} when its ICU is at snug's pinned Unicode
// version; otherwise the committed tables themselves, which are generated from
// that version's ICU and held to it by tools/unicode/gen-tables.mjs --check (bb
// unicode-test). A newer (or older) Node ICU must never fail npm test: it says
// nothing about snug, whose tables stay at the pinned version (P9.18).
const runtimeOracle = process.versions.unicode === unicodeVersion;
const inTables = category => cp => {
  for (let i = 0; i < tables.length; i += 3) if (tables[i] === id(category) && tables[i + 1] <= cp && cp <= tables[i + 2]) return true;
  return false;
};

for (const category of categories) test(`Unicode ${category}: range boundaries, neighbours, randoms, complement through VM`, async t => {
  const normal = await compile(schemaText(`\\p{${category}}`), { unicode: tables });
  const complement = await compile(schemaText(`\\P{${category}}`), { unicode: tables });
  const re = runtimeOracle ? new RegExp(`^\\p{gc=${category}}$`, 'u') : { test: text => inTables(category)(text.codePointAt(0)) };
  if (!runtimeOracle) t.diagnostic(`note: Node ${process.version} has Unicode ${process.versions.unicode}, snug's tables Unicode ${unicodeVersion}; comparing the VM with the pinned tables, not with Node's \\p{gc=${category}}`);
  const samples = new Set([0, 0x10ffff, 0xd7ff, 0xe000, 0x10000, 0x378, 0xfdd0, 0xfffe]);
  for (let i = 0; i < tables.length; i += 3) if (tables[i] === id(category)) {
    const lo = tables[i + 1], hi = tables[i + 2];
    for (const cp of [lo, hi, lo - 1, hi + 1]) samples.add(cp);
  }
  for (let i = 0; i < 128; i++) samples.add(random());
  let compared = 0, profileRefusals = 0;
  for (const cp of samples) if (scalar(cp)) {
    const text = String.fromCodePoint(cp), bytes = textBytes(text);
    const a = normal.validate(bytes, 'r'), b = complement.validate(bytes, 'r');
    // The Bindle profile rejects noncharacters before regexp matching: exercise and count
    // those refusals. The deterministic preset (the default, D121) admits them, so every
    // scalar value -- noncharacters included -- is compared with the oracle.
    if (noncharacter(cp)) {
      const B = { wire: 'bindle' };
      assert.equal(normal.validate(bytes, 'r', B).reason, 'cbor/text'); assert.equal(complement.validate(bytes, 'r', B).reason, 'cbor/text');
      profileRefusals++;
    }
    assert.equal(a.ok, re.test(text), `${category} U+${cp.toString(16)}`);
    assert.equal(b.ok, !re.test(text), `complement ${category} U+${cp.toString(16)}`);
    compared++;
  }
  assert.equal(normal.validate(textBytes(''), 'r').ok, false);
  assert.equal(normal.validate(textBytes('AA'), 'r').ok, false);
  t.diagnostic(`${compared} scalar comparisons x 2; ${profileRefusals} noncharacter profile refusals x 2`);
});

test('Unicode unions, negated classes, quantifiers and compile-time literal membership', async () => {
  for (const pattern of ['[\\p{L}\\p{Nd}_-]', '[^\\P{L}]', '[\\P{L}A]']) {
    const s = await compile(schemaText(pattern), { unicode: tables });
    const re = new RegExp(`^(?:${pattern})$`, 'u');
    for (const text of ['A', 'é', 'λ', '一', '𐐀', '2', '٣', '_', '-', '!', '\n', ''])
      assert.equal(s.validate(textBytes(text), 'r').ok, re.test(text), `${pattern} ${JSON.stringify(text)}`);
  }
  const s = await compile(schemaText('[\\p{L}\\p{Nd}_-]+'), { unicode: tables });
  for (const [text, want] of [['é٣_-', true], ['', false], ['a!', false]])
    assert.equal(s.validate(textBytes(text), 'r').ok, want);
  for (const [literal, want] of [['λ', true], ['1', false]]) {
    const s = await compile(`r = (tstr .regexp ${JSON.stringify('\\p{L}')}) .eq ${JSON.stringify(literal)}`, { unicode: tables });
    assert.equal(s.validate(textBytes(literal), 'r').ok, want);
  }
});

test('Unicode opt-in, invalid property spellings, options and resource limits', async () => {
  for (const pattern of ['\\p{L}', '\\P{L}', '[\\p{L}]', '[\\P{Cs}]'])
    await assert.rejects(compile(schemaText(pattern)), e => e instanceof SchemaError && e.code === 'regexp' && /snug\/unicode/.test(e.message) && e.line === 1 && e.column > 0 && e.rule === 'r');
  for (const pattern of ['\\p', '\\pL', '\\p{}', '\\p{l}', '\\p{Letter}', '\\p{LC}', '\\p{Luu}', '\\p{L', '\\p{IsGreek}', '\\p{@౵}', '[a-\\p{L}]', '[\\p{L}-a]'])
    await assert.rejects(compile(schemaText(pattern), { unicode: tables }), { code: 'regexp' });
  await assert.rejects(compile(schemaText('\\p{L}'), { unicode: {} }), TypeError);
  for (const malformed of [[1], [id('L'), 10, 9], [id('L'), -1, 0], [id('L'), 0xd800, 0xdfff], [id('L'), 0, 0x110000], [id('Cs'), 0, 1], [id('L'), 1, 2, id('L'), 2, 3], [id('Lu'), 1, 2, id('L'), 4, 5]])
    await assert.rejects(compile(schemaText('\\p{L}'), { unicode: Int32Array.from(malformed) }), { code: 'regexp' });
  await assert.rejects(compile(schemaText('\\p{L}{513}'), { unicode: tables }), { code: 'limit_regexp_positions' });
  await assert.rejects(compile(schemaText('\\p{L}{2}'), { unicode: tables, limits: { regexpPositions: 1 } }), { code: 'limit_regexp_positions' });
  compileRaw(schemaText('\\p{L}'), { unicode: tables });
  const used = lastBudgetUsed();
  compileRaw(schemaText('\\p{L}'), { unicode: tables, limits: { compileBudget: used } });
  assert.throws(() => compileRaw(schemaText('\\p{L}'), { unicode: tables, limits: { compileBudget: used - 1 } }), { code: 'limit_compile_budget' });
  await assert.rejects(compile(schemaText('\\p{L}'), { unicode: tables, limits: { compileBudget: 100 } }), { code: 'limit_compile_budget' });
  await assert.rejects(compile(schemaText('\\p{L}'), { unicode: tables, profile: 'bus' }), { code: 'profile' });
  // No state leaks into the next compile after an opted-in call.
  await assert.rejects(compile(schemaText('\\p{L}')), { code: 'regexp' });
});

test('Unicode Program serialises, loads and validates without retaining tables', async () => {
  const s = await compile(schemaText('\\p{L}'), { unicode: tables });
  const bytes = s.program.serialize();
  const loaded = await fromSerialized(bytes);
  assert.equal(loaded.validate(textBytes('λ'), 'r').ok, true);
  assert.equal(loaded.validate(textBytes('7'), 'r').ok, false);
  assert.deepEqual(loaded.program.serialize(), bytes);
  const changed = tables.slice(); changed[1]++;
  const other = await compile(schemaText('\\p{L}'), { unicode: changed });
  assert.notEqual(s.program.sourceKey, other.program.sourceKey);
  // Statically follow the runtime and compiler imports: neither implicitly loads tables.
  const seen = new Set();
  function visit(url) {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const code = readFileSync(url, 'utf8');
    for (const [, ref] of code.matchAll(/(?:import\s*(?:[^'";]*?\sfrom\s*)?|export\s+[^'";]*?from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g))
      if (ref.startsWith('.')) visit(new URL(ref, url));
  }
  for (const entry of ['index.mjs', 'public-schema.mjs', 'public-compile.mjs']) visit(new URL('../src/' + entry, import.meta.url));
  assert.ok(![...seen].some(p => /unicode[-_]?tables/.test(p)));
});
