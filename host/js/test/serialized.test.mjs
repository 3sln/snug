import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compile, SchemaError } from 'snug/compile';
import { Program, ProgramError, Schema, fromProgram, fromSerialized } from 'snug/schema';
import { encode } from 'snug';

const resign = bytes => {
  bytes.set(createHash('sha256').update(bytes.subarray(0, 56)).update(bytes.subarray(88)).digest(), 56);
  return bytes;
};
const refused = code => e => e instanceof ProgramError && e.code === code;

test('serialised Programs: every corpus schema, every compiled rule/input, deterministic bytes', async t => {
  let accepted = 0, refusedCount = 0, cases = 0;
  for (const file of ['study', 'adversarial', 'audit-2026-11-04']) {
    const { suites } = JSON.parse(readFileSync(new URL(`../../../corpus/conformance/${file}.json`, import.meta.url)));
    for (const suite of suites) await t.test(`${file}: ${suite.name}`, async () => {
      const text = suite.cddl ?? readFileSync(new URL(`../../../corpus/${suite.cddlFile}`, import.meta.url), 'utf8');
      let schema;
      try { schema = await compile(text, { profile: suite.profile ?? 'full' }); }
      catch (error) {
        assert.ok(error instanceof SchemaError);
        assert.ok(suite.schemaError || suite.snugSchemaError || suite.phase === 'later', error.code);
        refusedCount++;
        return;
      }
      accepted++;
      const bytes = schema.program.serialize(), loaded = await fromSerialized(bytes);
      assert.ok(loaded instanceof Schema && loaded.program instanceof Program);
      assert.deepEqual(loaded.program.P, schema.program.P);
      assert.deepEqual(loaded.program.B, schema.program.B);
      assert.deepEqual(loaded.program.rules, schema.program.rules);
      assert.equal(loaded.program.sourceKey, schema.program.sourceKey);
      assert.deepEqual(loaded.program.serialize(), bytes);
      assert.deepEqual((await compile(text, { profile: suite.profile ?? 'full' })).program.serialize(), bytes);
      for (const c of suite.cases) {
        const input = Uint8Array.from(Buffer.from(c.hex, 'hex'));
        assert.deepEqual(loaded.validate(input, c.rule, { top: 'any', cose: true }),
          schema.validate(input, c.rule, { top: 'any', cose: true }));
        cases++;
      }
    });
  }
  t.diagnostic(`${accepted} schemas round-tripped; ${refusedCount} declared refusal/later schemas refused; ${cases} validation results preserved`);
});

test('container matches §13.3, explicit little endian and independent host SHA-256', async () => {
  const s = await compile('r = { a: uint }'), bytes = s.program.serialize();
  const d = new DataView(bytes.buffer), P = s.program.P, B = s.program.B;
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), 'snugprog');
  assert.equal(d.getUint32(8, true), 1);
  assert.equal(d.getUint32(12, true), 2);   // format 2.0 (D279, D318: major in the low 16 bits)
  assert.equal(d.getUint32(16, true), P.length);
  assert.equal(d.getUint32(20, true), B.length);
  assert.equal(new TextDecoder().decode(bytes.subarray(24, 29)), '0.0.0');
  assert.ok(bytes.subarray(29, 56).every(x => x === 0));
  assert.ok(bytes.subarray(88, 96).every(x => x === 0));
  assert.equal(bytes.length, 96 + P.length * 4 + B.length);
  for (let i = 0; i < P.length; i++) assert.equal(d.getInt32(96 + 4 * i, true), P[i]);
  assert.deepEqual(bytes.subarray(96 + 4 * P.length), B);
  assert.deepEqual(resign(bytes.slice()), bytes);
  // Offset views and Buffer slices must load without alignment assumptions.
  const unaligned = Buffer.alloc(bytes.length + 3); unaligned.set(bytes, 3);
  const loaded = await fromSerialized(unaligned.subarray(3));
  unaligned.fill(0);
  assert.deepEqual(loaded.program.serialize(), bytes);
});

test('every bit in every byte flipped, and every truncation of a small Program is refused', async t => {
  const bytes = (await compile('r = uint')).program.serialize();
  for (let i = 0; i < bytes.length; i++) {
    for (let bit = 0; bit < 8; bit++) {
      const changed = bytes.slice(); changed[i] ^= 1 << bit;
      await assert.rejects(fromSerialized(changed), ProgramError, `byte ${i} bit ${bit}`);
    }
    await assert.rejects(fromSerialized(bytes.subarray(0, i)), ProgramError);
  }
  t.diagnostic(`${bytes.length * 8} single-bit mutations and ${bytes.length} truncations refused`);
});

test('container refusals have precise safe codes, including rehashed invalid Programs', async () => {
  const bytes = (await compile('r = uint')).program.serialize();
  const mutate = (offset, value, rehash = false) => {
    const b = bytes.slice(); b[offset] = value; return rehash ? resign(b) : b;
  };
  await assert.rejects(fromSerialized(mutate(0, 0)), refused('magic'));
  await assert.rejects(fromSerialized(mutate(8, 2, true)), refused('container_version'));
  await assert.rejects(fromSerialized(mutate(12, 1, true)), refused('format_version'));  // major 1: a 2.0 loader refuses every 1.x (D279)
  await assert.rejects(fromSerialized(mutate(12, 3, true)), refused('format_version'));
  await assert.rejects(fromSerialized(mutate(14, 2, true)), refused('format_version')); // major 2, minor 2 (the loader is 2.0)
  await assert.rejects(fromSerialized(mutate(24, 0, true)), refused('version'));
  await assert.rejects(fromSerialized(mutate(29, 0x80, true)), refused('version'));
  await assert.rejects(fromSerialized(mutate(88, 1, true)), refused('reserved'));
  await assert.rejects(fromSerialized(mutate(56, bytes[56] ^ 1)), refused('digest'));
  await assert.rejects(fromSerialized(mutate(bytes.length - 1, bytes.at(-1) ^ 1)), refused('digest'));
  await assert.rejects(fromSerialized(mutate(96, 0, true)), refused('verify'));
  await assert.rejects(fromSerialized(mutate(100, 3, true)), refused('format_version'));   // P[1] disagrees with the container's word
  const huge = bytes.slice(); new DataView(huge.buffer).setUint32(16, 0xffffffff, true);
  await assert.rejects(fromSerialized(resign(huge)), refused('length'));
  const trailing = new Uint8Array(bytes.length + 1); trailing.set(bytes);
  await assert.rejects(fromSerialized(trailing), refused('length'));
  await assert.rejects(fromSerialized([]), TypeError);
});

test('D084: same format may load across snug versions; provenance is retained', async () => {
  const bytes = (await compile('r = uint')).program.serialize();
  bytes.set(new TextEncoder().encode('9.9.9'), 24); resign(bytes);
  const loaded = await fromSerialized(bytes);
  assert.deepEqual(loaded.validate(encode(7), 'r'), { ok: true });
  assert.deepEqual(loaded.program.serialize(), bytes);
});

test('public Programs verify, own their arrays and expose copies', async () => {
  const s = await compile('r = uint'), P = s.program.P, B = s.program.B;
  const loaded = await fromProgram(P, B);
  P.fill(0); B.fill(0); loaded.program.P.fill(0); loaded.program.B.fill(0);
  assert.deepEqual(loaded.validate(encode(7), 'r'), { ok: true });
  assert.throws(() => new Program(P, B), refused('verify'));
  assert.throws(() => new Schema({}), TypeError);
  const shared = new Uint8Array(new SharedArrayBuffer(96));
  await assert.rejects(fromSerialized(shared), TypeError);
});
