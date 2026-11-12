// P9.14 (D334): `.abnf` / `.abnfb` (RFC 9165 §3) through the public package -- the optional
// module, compile-time refusals, the hand vectors, sources and sessions, budget, the bus
// profile and serialised Programs. The engine's own gate is `bb abnf-test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile, SchemaError } from 'snug/compile';
import { ProgramError, fromSerialized } from 'snug/schema';
import { abnf, abnfWith, checkAbnf } from 'snug/abnf';
import { controls } from 'snug/controls';
import { encode } from 'snug';
import { validateHandleSync, bufferHandle } from 'snug/sources';

const vectors = JSON.parse(readFileSync(new URL('../../../corpus/conformance/abnf.json', import.meta.url)));
const te = new TextEncoder();
const hexOf = s => Buffer.from(te.encode(s)).toString('hex');
// a controller as a CDDL byte-string literal: any ABNF text, no escaping
const schemaFor = (g, op) => `r = (text / bytes) .${op} h'${hexOf(g)}'`;

test('without the module: unsupported_control naming it; the module names only bind its own entries', async () => {
  await assert.rejects(compile('r = text .abnf "x"'),
    e => e instanceof SchemaError && e.code === 'unsupported_control' && /snug\/abnf/.test(e.message));
  await assert.rejects(compile('r = bytes .abnfb "x"', { controls }), e => e.code === 'unsupported_control');
  await assert.rejects(compile('r = 1', { controls: { abnf: () => true } }), TypeError);
  await assert.rejects(compile('r = 1', { controls: { abnfb: { ...controls.chars } } }), TypeError);
  await assert.rejects(compile('r = text .pcre "x"', { controls: { ...abnf } }), e => e.code === 'unsupported_control');
});

test('the hand vectors through compile and validate (text and byte string controllers and targets)', async () => {
  let cases = 0;
  for (const g of vectors.grammars) {
    // "parse": "lenient" vectors need the abnf: 'lenient' option (D340); the strict default
    // refuses them
    const lenient = g.parse === 'lenient', mode = { abnf: lenient ? 'lenient' : 'strict' };
    if (lenient) {
      await assert.rejects(compile(schemaFor(g.abnf, 'abnf'), { controls: { ...abnf } }),
        e => e.code === 'control_value' && (!!g.error || /abnf: 'lenient'/.test(e.message)), g.name);
      assert.equal(typeof checkAbnf(g.abnf), 'string', g.name);
    }
    if (g.error) {
      await assert.rejects(compile(schemaFor(g.abnf, 'abnf'), { controls: { ...abnf }, ...mode }),
        e => e.code === 'control_value' && /\.abnf argument: /.test(e.message), g.name);
      assert.equal(typeof checkAbnf(g.abnf, mode), 'string', g.name);
      continue;
    }
    assert.equal(checkAbnf(g.abnf, mode), true, g.name);
    if (!lenient) assert.equal(checkAbnf(g.abnf, { abnf: 'lenient' }), true, g.name);
    const s = await compile(`${schemaFor(g.abnf, 'abnf')}\nb = (text / bytes) .abnfb h'${hexOf(g.abnf)}'`, { controls: { ...abnf }, ...mode });
    for (const c of g.cases) {
      const content = c.input !== undefined ? te.encode(c.input) : Uint8Array.from(Buffer.from(c.inputHex, 'hex'));
      // a text target must be valid UTF-8 for the wire profile; send those as bytes otherwise
      const asText = c.major === 'text';
      const value = asText ? new TextDecoder().decode(content) : content;
      const r = s.validate(encode(value), c.mode === 'abnfb' ? 'b' : 'r');
      assert.equal(r.ok, c.expect, `${g.name}: ${JSON.stringify(c)} ${JSON.stringify(r)}`);
      if (!r.ok) assert.equal(r.reason, 'control');
      cases++;
    }
  }
  assert.ok(cases > 100);
});

test('prose-val and syntax errors are refused at compile time with the ABNF place', async () => {
  await assert.rejects(compile('r = text .abnf "a\\na = \\"x\\" / <later>"', { controls: { ...abnf } }),
    e => e.code === 'control_value' && /prose-val \(<\.\.\.>\) is not supported at ABNF line 2, column 11/.test(e.message));
  await assert.rejects(compile('r = text .abnf "(1*DIGIT)"', { controls: { ...abnf } }),
    e => /undefined rule .* at ABNF line 1, column 4/.test(e.message));
  await assert.rejects(compile('r = text .abnf 5', { controls: { ...abnf } }), e => e.code === 'control_value');
  await assert.rejects(compile('r = text .abnf h\'ff\'', { controls: { ...abnf } }), e => /not valid UTF-8/.test(e.message));
  assert.match(checkAbnf('a\na = b\n'), /undefined rule/);
});

test('strict RFC parsing by default; abnf: \'lenient\' admits snug\'s other forms and is in the source key (D340)', async () => {
  const wide = 'r = text .abnf "1*DIGIT\\nDIGIT = %x30-39\\n"', ruleFirst = 'r = text .abnf "s = 1*DIGIT\\nDIGIT = %x30-39\\n"';
  for (const [src, why] of [[wide, /one element/], [ruleFirst, /begins with a rule/]])
    await assert.rejects(compile(src, { controls: { ...abnf } }),
      e => e.code === 'control_value' && why.test(e.message) && /abnf: 'lenient'/.test(e.message));
  await assert.rejects(compile(wide, { controls: { ...abnf }, abnf: 'loose' }), TypeError);
  const lw = await compile(wide, { controls: { ...abnf }, abnf: 'lenient' });
  const lr = await compile(ruleFirst, { controls: { ...abnf }, abnf: 'lenient' });
  for (const s of [lw, lr]) {
    assert.deepEqual(s.validate(encode('42'), 'r'), { ok: true });
    assert.equal(s.validate(encode('4x'), 'r').reason, 'control');
  }
  // the same strict-valid schema in both modes: the same verdicts, different source keys
  const ok = 'r = text .abnf "(1*DIGIT)\\nDIGIT = %x30-39\\n"';
  const strict = await compile(ok, { controls: { ...abnf } }), strict2 = await compile(ok, { controls: { ...abnf }, abnf: 'strict' });
  const lenient = await compile(ok, { controls: { ...abnf }, abnf: 'lenient' });
  assert.equal(strict.program.sourceKey, strict2.program.sourceKey);
  assert.notEqual(strict.program.sourceKey, lenient.program.sourceKey);
  assert.deepEqual(lenient.validate(encode('42'), 'r'), strict.validate(encode('42'), 'r'));
  assert.equal(checkAbnf('1*DIGIT\nDIGIT = %x30-39\n', { abnf: 'lenient' }), true);
  assert.match(checkAbnf('1*DIGIT\nDIGIT = %x30-39\n'), /abnf: 'lenient'/);
});

test('RFC 9165 Figure 4 verbatim', async () => {
  const s = await compile("oid = bytes .abnfb 'oid\noid = 1*arc\nroid = *arc\narc = [nlsb] %x00-7f\nnlsb = %x81-ff *%x80-ff\n'", { controls: { ...abnf } });
  assert.deepEqual(s.validate(Uint8Array.of(0x41, 0x00), 'oid'), { ok: true });
  assert.equal(s.validate(Uint8Array.of(0x40), 'oid').reason, 'control');
  assert.equal(s.validate(Uint8Array.of(0x41, 0x81), 'oid').reason, 'control');
  assert.equal(s.validate(encode('x'), 'oid').reason, 'type');      // the target first
});

test('exact under choices, map keys and embedded documents', async () => {
  const s = await compile(`
    choice = (text .abnf "(2DIGIT)\\nDIGIT = %x30-39\\n") / (text .size 5)
    keyed = { * (text .abnf "(%x61-7A *%x30-39)") => int }
    inner = bytes .cbor (text .abnf "\\"ok\\"")`, { controls: { ...abnf } });
  assert.deepEqual(s.validate(encode('42'), 'choice'), { ok: true });
  assert.deepEqual(s.validate(encode('hello'), 'choice'), { ok: true });
  assert.equal(s.validate(encode('4x'), 'choice').reason, 'control');
  assert.deepEqual(s.validate(encode({ a1: 1, b22: 2 }), 'keyed'), { ok: true });
  assert.equal(s.validate(encode({ A1: 1 }), 'keyed').ok, false);
  assert.deepEqual(s.validate(encode(encode('OK')), 'inner'), { ok: true });
  assert.equal(s.validate(encode(encode('no')), 'inner').subcode, 'control');
});

test('sessions over every split give the buffer verdict; budget is charged and exhausts cleanly', async () => {
  const s = await compile('r = [* (text .abnf "a\\na = a a / \\"x\\"\\n")]', { controls: { ...abnf } });
  const bytes = encode(['xxxx', 'x'.repeat(30), 'xy']);
  const want = s.validate(bytes, 'r');
  assert.equal(want.reason, 'control');
  for (let chunk = 1; chunk <= bytes.length; chunk += 3)
    for (const quantum of [0, 1, 3])
      assert.deepEqual(validateHandleSync(s, bufferHandle(bytes), 'r', {}, { chunk, quantum }), want);
  let budgetSeen = false;
  for (let budget = 0; budget < 60000; budget = budget * 2 + 7) {
    const r = s.validate(bytes, 'r', { budget });
    budgetSeen ||= r.reason === 'budget';
    for (const chunk of [1, 7])
      assert.deepEqual(validateHandleSync(s, bufferHandle(bytes), 'r', { budget }, { chunk }), r);
  }
  assert.ok(budgetSeen);
  // a pathological grammar under the default budget stops with budget, quickly
  const p = await compile('r = text .abnf "a\\na = a a / \\"x\\" / \\"\\"\\n"', { controls: { ...abnf } });
  const t0 = performance.now();
  assert.equal(p.validate(encode('x'.repeat(300)), 'r').reason, 'budget');
  assert.ok(performance.now() - t0 < 5000);
});

test('maxBytes: the item bound (65,536 by default) and an override', async () => {
  const s = await compile('r = text .abnf "(*%x61)"', { controls: { ...abnf } });
  assert.deepEqual(s.validate(encode('a'.repeat(1000)), 'r'), { ok: true });
  assert.equal(s.validate(encode('a'.repeat(70000)), 'r', { budget: 1e8 }).reason, 'control_size');
  const big = await compile('r = text .abnf "(*%x61)"', { controls: { ...abnf, abnf: { ...abnf.abnf, maxBytes: 1 << 20 } } });
  assert.deepEqual(big.validate(encode('a'.repeat(70000)), 'r', { budget: 1e8 }), { ok: true });
});

test('abnfWith: the matcher scratch cap (maxWords) is the host\'s; past it, budget', async () => {
  const text = 'r = text .abnf "(*(%x61 / %x61 %x61))"', doc = encode('a'.repeat(3000)), opts = { budget: 1e8 };
  const small = await compile(text, { controls: { ...abnfWith({ maxWords: 65536 }) } });
  assert.equal(small.validate(doc, 'r', opts).reason, 'budget');
  const usual = await compile(text, { controls: { ...abnf } });
  assert.deepEqual(usual.validate(doc, 'r', opts), { ok: true });
  assert.throws(() => abnfWith({ maxWords: 1 }), TypeError);
  assert.throws(() => abnfWith({ maxWords: 2 ** 25 }), TypeError);
  assert.equal(abnfWith({ maxBytes: 9 }).abnf.maxBytes, 9);
});

test('the bus profile refuses .abnf unless controlsInBus', async () => {
  await assert.rejects(compile('r = (text .size (0..9)) .abnf "\\"a\\""', { profile: 'bus', controls: { ...abnf } }), e => e.code === 'profile');
  const s = await compile('r = (text .size (0..9)) .abnf "\\"a\\""', { profile: 'bus', controls: { ...abnf }, controlsInBus: true });
  assert.deepEqual(s.validate(encode('A'), 'r'), { ok: true });
});

test('serialised Programs need the module again', async () => {
  const s = await compile('r = text .abnf "\\"a\\""', { controls: { ...abnf } });
  assert.deepEqual(s.program.controls, ['abnf']);
  const bytes = s.program.serialize();
  await assert.rejects(fromSerialized(bytes), e => e instanceof ProgramError && e.code === 'missing_control' && /\.abnf/.test(e.message));
  const loaded = await fromSerialized(bytes, { controls: { ...abnf } });
  assert.deepEqual(loaded.validate(encode('A'), 'r'), { ok: true });
  assert.equal(loaded.validate(encode('b'), 'r').reason, 'control');
});
