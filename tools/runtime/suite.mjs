// P7.7 runtime evidence: one conformance subset, run unchanged in Node, a
// browser and a workerd isolate. Platform-neutral: no Node APIs, no eval, only
// the six public package entry points (bare `snug/...` specifiers, resolved by
// Node from a fresh node_modules/snug or by esbuild when bundling).
//
// runSuite(fixtures, { now, compiler }) -> { groups: { name: {pass, fail, ms,
// failures[]} }, totals: {pass, fail}, env }
//   compiler: true  compile every CDDL text here (lazy `snug/compile` import)
//             false use the Programs serialised by tools/runtime/fixtures.mjs
//                   (fromSerialized only; the compiler is never imported)
import { decode, encode, Decimal, NDArray, Float16Bytes, SnugFault } from 'snug';
import { Program, Schema, ProgramError, fromSerialized, fromProgram, validateAt } from 'snug/schema';
import { view } from 'snug/view';
import { Writer } from 'snug/writer';
import { asyncHandle, bufferHandle, scanHandle, scanHandleSync } from 'snug/sources';

export const fromHex = h => { const b = new Uint8Array(h.length >> 1); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; };
export const toHex = b => { let s = ''; for (const x of b) s += x.toString(16).padStart(2, '0'); return s; };

// The value notation of corpus/cbor-vectors/cbor-profile.json (see its format field).
const TYPES = { u16: 'Uint16Array', u32: 'Uint32Array', u64: 'BigUint64Array', i8: 'Int8Array', i16: 'Int16Array',
  i32: 'Int32Array', i64: 'BigInt64Array', f16: 'Float16Array', f32: 'Float32Array', f64: 'Float64Array' };
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
export function expected(value) {
  if (Array.isArray(value)) return value.map(expected);
  if (value === null || typeof value !== 'object') return value;
  if ('$int' in value) return BigInt(value.$int);
  if ('$bytes' in value) return fromHex(value.$bytes);
  if ('$decimal' in value) return Decimal.from(value.$decimal);
  if ('$typed' in value) {
    const bytes = fromHex(value.hex), ctor = globalThis[TYPES[value.$typed]];
    if (!ctor) return new Float16Bytes(bytes);
    const size = ctor.BYTES_PER_ELEMENT;
    if (!littleEndian) for (let i = 0; i < bytes.length; i += size) bytes.subarray(i, i + size).reverse();
    return new ctor(bytes.buffer);
  }
  if ('$nd' in value) return new NDArray(value.$nd, expected(value.data));
  const out = Object.create(null);
  for (const [k, v] of Object.entries(value)) out[k] = expected(v);
  return out;
}

/** Strict structural equality (Object.is on numbers, prototypes, typed-array constructors). */
export function same(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (ArrayBuffer.isView(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Decimal) return a.mantissa === b.mantissa && a.exponent === b.exponent;
  if (a instanceof Float16Bytes) return same(a.bytes, b.bytes);
  if (a instanceof NDArray) return same([...a.shape], [...b.shape]) && same(a.data, b.data);
  if (a instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !same(v, b.get(k))) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !same(a[k], b[k])) return false;
  return true;
}

class Check extends Error {}
const ok = (cond, msg) => { if (!cond) throw new Check(msg); };
const throwsFault = (fn, code, msg) => {
  try { fn(); } catch (e) { ok(e instanceof SnugFault && e.code === code, `${msg}: got ${e?.name} ${e?.code}`); return; }
  throw new Check(`${msg}: no fault`);
};

export async function runSuite(fx, { now = () => Date.now(), compiler = true } = {}) {
  const groups = {};
  const group = async (name, body) => {
    const g = groups[name] = { pass: 0, fail: 0, ms: 0, failures: [] };
    const t0 = now();
    const check = async (label, fn) => {
      try { await fn(); g.pass++; }
      catch (e) { g.fail++; if (g.failures.length < 8) g.failures.push(`${label}: ${e instanceof Check ? e.message : `${e?.name}: ${e?.message}`}`); }
    };
    try { await body(check); } catch (e) { g.fail++; g.failures.push(`group aborted: ${e?.name}: ${e?.message}`); }
    g.ms = +(now() - t0).toFixed(3);
  };

  // 1. Codec: the profile vectors (decode -> value, encode -> exact bytes; refusals by code).
  await group('codec: profile accept', async check => {
    for (const v of fx.profile.accept) await check(v.name, () => {
      const bytes = fromHex(v.hex), want = expected(v.value), got = decode(bytes, { top: 'any' });
      ok(same(got, want), 'decoded value differs');
      ok(toHex(encode(want)) === v.hex, 'encode(expected) differs');
      ok(toHex(encode(got)) === v.hex, 'encode(decoded) differs');
    });
  });
  await group('codec: profile refuse', async check => {
    for (const v of fx.profile.refuse) await check(v.name, () => throwsFault(() => decode(fromHex(v.hex), { top: 'any' }), v.code, 'decode'));
  });
  // cborg-oracle inputs cborg accepts: refused with the labelled profile code, or exactly re-encoded.
  await group('codec: cborg oracle', async check => {
    for (const [i, v] of fx.oracle.entries()) await check(`oracle ${i}`, () => {
      const bytes = fromHex(v.hex);
      if (v.refuse) return throwsFault(() => decode(bytes, { top: 'any' }), v.refuse, 'decode');
      ok(toHex(encode(decode(bytes, { top: 'any' }))) === v.hex, 'round trip differs');
    });
  });

  // 2. Schemas: compile (or load) the six study contracts and validate their cases.
  const schemas = new Map();
  const load = async suite => {
    if (compiler) {
      const { compile } = await import('snug/compile');
      return compile(suite.cddl, { profile: suite.profile ?? 'full' });
    }
    return fromSerialized(fromHex(fx.programs[suite.name]));
  };
  const optionsOf = suite => ({ top: 'any', cose: suite.options?.cose === true });
  await group(compiler ? 'contracts: compile' : 'contracts: fromSerialized', async check => {
    for (const s of fx.contracts) await check(s.name, async () => {
      const schema = await load(s);
      ok(schema instanceof Schema && schema.program instanceof Program, 'not a Schema');
      schemas.set(s.name, schema);
    });
  });
  await group('contracts: validate', async check => {
    for (const s of fx.contracts) for (const [i, c] of s.cases.entries()) await check(`${s.name} #${i}`, () => {
      const schema = schemas.get(s.name); ok(schema, 'no schema');
      const r = schema.validate(fromHex(c.hex), c.rule, optionsOf(s));
      ok(r.ok === c.expect, `expected ${c.expect}, got ${r.ok ? 'ok' : r.reason}`);
      if (!r.ok) ok(typeof r.reason === 'string' && Array.isArray(r.path) && Number.isInteger(r.offset), 'witness shape');
    });
  });
  // The other study suites (probes): compile refusals by SchemaError code; phase "later" excluded.
  await group(compiler ? 'study probes: compile + validate' : 'study probes: fromSerialized + validate', async check => {
    for (const s of fx.probes) await check(s.name, async () => {
      if (s.schemaError) {
        if (!compiler) return;
        const { compile, SchemaError } = await import('snug/compile');
        try { await compile(s.cddl, { profile: s.profile ?? 'full' }); } catch (e) {
          ok(e instanceof SchemaError && e.code === s.schemaError, `wanted SchemaError ${s.schemaError}, got ${e?.name} ${e?.code}`);
          return;
        }
        throw new Check(`compiled; wanted SchemaError ${s.schemaError}`);
      }
      const schema = await load(s);
      for (const [i, c] of s.cases.entries()) {
        const r = schema.validate(fromHex(c.hex), c.rule, optionsOf(s));
        ok(r.ok === c.expect, `case ${i}: expected ${c.expect}, got ${r.ok ? 'ok' : r.reason}`);
      }
    });
  });

  // 3. Serialised Programs: deterministic containers, identical to the Node-produced bytes.
  await group('programs: serialize / fromSerialized', async check => {
    for (const s of fx.contracts) await check(s.name, async () => {
      const schema = schemas.get(s.name); ok(schema, 'no schema');
      const bytes = schema.program.serialize();
      ok(toHex(bytes) === fx.programs[s.name], 'container differs from the Node-produced bytes');
      const loaded = await fromSerialized(bytes);
      ok(loaded.program.sourceKey === schema.program.sourceKey && /^[0-9a-f]{64}$/.test(loaded.program.sourceKey), 'sourceKey');
      ok(same([...loaded.program.rules], [...schema.program.rules]), 'rules');
      ok(toHex(loaded.program.serialize()) === toHex(bytes), 'reserialise differs');
      const viaArrays = await fromProgram(schema.program.P, schema.program.B);
      for (const c of s.cases) {
        const input = fromHex(c.hex), want = schema.validate(input, c.rule, optionsOf(s));
        ok(same(loaded.validate(input, c.rule, optionsOf(s)), want), 'loaded validate differs');
        ok(same(viaArrays.validate(input, c.rule, optionsOf(s)), want), 'fromProgram validate differs');
      }
      const bad = bytes.slice(); bad[bad.length - 1] ^= 1;
      try { await fromSerialized(bad); throw new Check('corrupted container loaded'); }
      catch (e) { if (e instanceof Check) throw e; ok(e instanceof ProgramError && e.code === 'digest', `corruption: ${e?.code}`); }
    });
  });

  // 4. Views: checked open, a full recursive walk (View entries + Cursor), lookups, value(), validateAt.
  await group('view: walk', async check => {
    const walk = v => {
      let n = 1;
      if (v.kind === 'map' || v.kind === 'array') for (const [k, child] of v.entries()) {
        const again = v.kind === 'map' ? v.get(k) : v.at(k);
        ok(again && again.offset === child.offset, 'lookup offset');
        n += walk(child);
      }
      return n;
    };
    const cwalk = c => {
      let n = 1;
      if ((c.kind === 'map' || c.kind === 'array') && c.enter()) { do n += cwalk(c); while (c.next()); ok(c.up(), 'up'); }
      return n;
    };
    for (const s of fx.contracts) for (const [i, c] of s.cases.entries()) {
      if (!c.expect) continue;
      await check(`${s.name} #${i}`, () => {
        const schema = schemas.get(s.name), bytes = fromHex(c.hex), opts = { ...optionsOf(s), schema, rule: c.rule };
        const root = view(bytes, opts);
        ok(same(root.value(), schema.decode(bytes, c.rule, optionsOf(s))), 'value() differs from schema.decode');
        ok(walk(root) === cwalk(root.cursor()), 'View and Cursor walks disagree');
        ok(same(root.validateAt(c.rule), { ok: true }), 'validateAt');
        ok(same(view(bytes, { ...opts, borrow: true }).raw(), bytes), 'borrowed raw');
      });
    }
    await check('nested span (examples/view.mjs)', async () => {
      const schema = await load(fx.viewSchema), bytes = encode({ items: [{ id: 7 }, { id: 8 }] });
      const item = view(bytes, { schema, rule: 'doc' }).get('items').at(1);
      ok(item.get('id').number() === 8, 'lookup');
      ok(same(validateAt(schema, bytes, item.offset, item.offset + item.raw().length, 'item', { depth: item.depth }), { ok: true }), 'detached validateAt');
      const c = view(bytes, { schema, rule: 'doc' }).cursor();
      ok(c.find('items') && c.enter() && c.next() && c.view().get('id').number() === 8, 'cursor');
      // A schema-checked open refuses before any navigation: { a: 1 } is not a doc.
      try { view(Uint8Array.of(0xa1, 0x61, 0x61, 0x01), { schema, rule: 'doc' }); }
      catch (e) { ok(e instanceof SnugFault && e.code.startsWith('schema/'), `checked open: ${e?.name} ${e?.code}`); return; }
      throw new Check('checked open accepted a refused message');
    });
  });

  // 5. Writer: typed calls and value() reproduce encode() byte for byte.
  await group('writer', async check => {
    for (const v of fx.profile.accept) await check(v.name, () => {
      const want = expected(v.value);
      ok(toHex(new Writer().value(want).finish()) === v.hex, 'Writer.value differs');
    });
    await check('typed calls (examples/encode-writer.mjs)', () => {
      const price = Decimal.from('1.50'), bytes = encode({ price, id: 7 }, { maxBytes: 256 });
      const w = new Writer({ maxBytes: 256 });
      w.beginMap(2).key('price').decimal(price).key('id').uint(7).end();
      ok(toHex(w.finish()) === toHex(bytes), 'typed Writer differs');
      ok(decode(bytes).price.toString() === '1.5', 'decimal');
    });
    await check('grammar failure', () => {
      const w = new Writer();
      w.beginMap(1).key('a');
      try { w.finish(); } catch { ok(w.failure !== '', 'failure code'); return; }
      throw new Check('incomplete root finished');
    });
  });

  // 6. Sources: the public profile scanner over the async in-memory handle (and the sync buffer handle).
  await group('sources: asyncHandle', async check => {
    for (const v of fx.profile.accept) await check(v.name, async () => {
      const bytes = fromHex(v.hex);
      ok(await scanHandle(asyncHandle(bytes), { top: 'any' }, { chunk: 64, quantum: 2 }) === true, 'async scan');
      ok(scanHandleSync(bufferHandle(bytes), { top: 'any' }, { chunk: 3 }) === true, 'sync scan');
    });
    for (const v of fx.profile.refuse) await check(v.name, async () => {
      const bytes = fromHex(v.hex);
      try { await scanHandle(asyncHandle(bytes), { top: 'any' }, { chunk: 64, quantum: 2 }); }
      catch (e) { ok(e instanceof SnugFault && e.code === v.code, `got ${e?.name} ${e?.code}`); return; }
      throw new Check('accepted');
    });
    await check('256 KiB document, 16 KiB chunks', async () => {
      const big = encode({ id: 7, rows: Array.from({ length: 2000 }, (_, i) => ({ i, text: 'x'.repeat(i % 100), body: new Uint8Array(32) })) });
      ok(await scanHandle(asyncHandle(big), {}, { chunk: 16384, quantum: 64 }) === true, 'big scan');
    });
  });

  let pass = 0, fail = 0;
  for (const g of Object.values(groups)) { pass += g.pass; fail += g.fail; }
  return { groups, totals: { pass, fail }, compiler };
}
