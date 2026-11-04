// P7.9: the wasm SDK must answer exactly as the native package on the same
// inputs: profile vectors, encodings, compiled Program bytes, validation
// results (verdict, reason, path, offset), views, sources; and recover from
// instance loss. Needs `kin/scripts/wasm-build sdk` and `cc` first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as N from '../../js/src/index.mjs';
import * as NS from '../../js/src/public-schema.mjs';
import { compile as ncompile } from '../../js/src/public-compile.mjs';
import { view as nview } from '../../js/src/public-view.mjs';
import * as NSRC from '../../js/src/sources.mjs';
import { compile as hcompile } from '../../js/src/schema.mjs';
import * as W from '../src/index.mjs';
import * as WS from '../src/schema.mjs';
import { compile as wcompile } from '../src/compile.mjs';
import { view as wview } from '../src/view.mjs';
import * as WSRC from '../src/sources.mjs';

const root = new URL('../../../', import.meta.url);
const json = p => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const hexb = h => new Uint8Array(Buffer.from(h, 'hex'));
const outcome = f => { try { return { ok: f() }; } catch (e) { return { err: e.name, code: e.code, reason: e.reason, path: e.path, offset: e.offset }; } };
await W.init();

const profile = json('corpus/cbor-vectors/cbor-profile.json');
const study = json('corpus/conformance/study.json');
const contracts = study.suites.filter(s => s.cddlFile).map(s => ({ ...s, cddl: readFileSync(new URL(`corpus/${s.cddlFile}`, root), 'utf8') }));

test('profile vectors: decode and refusal codes', () => {
  for (const v of [...profile.accept, ...profile.refuse]) {
    for (const top of ['map', 'any']) {
      const b = hexb(v.hex);
      assert.deepEqual(outcome(() => W.decode(b, { top })), outcome(() => N.decode(b, { top })), v.name);
    }
  }
});

test('encode: accept vectors re-encode identically; refusals agree', () => {
  for (const v of profile.accept) {
    const value = N.decode(hexb(v.hex), { top: 'any' });
    assert.deepEqual(outcome(() => W.encode(value)), outcome(() => N.encode(value)), v.name);
  }
  const odd = [NaN, Infinity, -0, 1.5, 2 ** 60, -(2n ** 70n), 2n ** 1100n, 'a\uD800', '﷐', [1, , 3], new Map([[1, 'x']]),
    { b: 1, a: [new Float32Array([1, 2]), new Float64Array([NaN])] }, new N.Decimal(-12345n, -3), new N.NDArray([2, 2], new Int16Array(4)),
    { z: 1, y: { x: 2, w: 'é' }, aa: null, a: true }, Array.from({ length: 70000 }, () => 0), 'x'.repeat(100) + 'ü'];
  for (const value of odd) for (const opts of [{}, { cose: true }, { maxItems: 3 }, { maxDepth: 1 }, { maxBytes: 4 }])
    assert.deepEqual(outcome(() => W.encode(value, opts)), outcome(() => N.encode(value, opts)));
});

const compiled = new Map();
test('compile: the six contracts give the same Program bytes; validation results agree', async () => {
  for (const s of contracts) {
    const n = await ncompile(s.cddl), w = await wcompile(s.cddl);
    assert.deepEqual(w.program.P, n.program.P, s.name);
    assert.deepEqual(w.program.B, n.program.B, s.name);
    assert.equal(w.program.sourceKey, n.program.sourceKey);
    assert.deepEqual(w.program.serialize(), n.program.serialize());
    compiled.set(s.name, { n, w });
    for (const c of s.cases) {
      const b = hexb(c.hex);
      const r = w.validate(b, c.rule);
      assert.deepEqual(r, n.validate(b, c.rule), `${s.name} ${c.hex}`);
      assert.equal(r.ok, c.expect);
      assert.deepEqual(outcome(() => w.decode(b, c.rule)), outcome(() => n.decode(b, c.rule)));
      if (r.ok && b.length > 2) assert.deepEqual(w.validateAt(b, 1, b.length, c.rule), n.validateAt(b, 1, b.length, c.rule));
    }
  }
  const bad = [['r = { a: uint', 'syntax'], ['r = x', 'undefined_name']];
  for (const [t] of bad) {
    const e1 = await wcompile(t).catch(e => e), e2 = await ncompile(t).catch(e => e);
    assert.equal(e1.code, e2.code); assert.equal(e1.line, e2.line); assert.equal(e1.column, e2.column);
  }
  const ser = compiled.get(contracts[0].name).n.program.serialize();
  const w2 = await WS.fromSerialized(ser);
  assert.deepEqual(w2.program.P, (await NS.fromSerialized(ser)).program.P);
});

function walk(v, out = []) {
  out.push([v.kind, v.offset, v.depth, v.length]);
  if (v.kind === 'map' || v.kind === 'array') for (const [k, c] of v.entries()) { out.push(k); walk(c, out); }
  else out.push(String(v.value()));
  return out;
}
test('views: walks, lookups, path, cursor agree', () => {
  for (const v of profile.accept) {
    const b = hexb(v.hex);
    const nv = nview(b, { top: 'any' });
    for (const batch of [true, false]) {
      const wv = wview(b, { top: 'any', batch });
      assert.deepEqual(walk(wv), walk(nv), v.name);
      assert.deepEqual(outcome(() => wv.value()), outcome(() => nv.value()));
    }
  }
  const s = compiled.get(contracts[0].name);
  const c = contracts[0].cases.find(k => k.expect && k.rule === 'request');
  const b = hexb(c.hex);
  const wv = wview(b, { schema: s.w, rule: 'request' }), nv = nview(b, { schema: s.n, rule: 'request' });
  assert.equal(wv.get('method').text(), nv.get('method').text());
  assert.equal(wv.path('args', 'key').text(), nv.get('args').get('key').text());
  assert.equal(wv.path('args', 'nope'), undefined);
  assert.deepEqual(wv.get('args').validateAt('put-args'), nv.get('args').validateAt('put-args'));
  const doc = N.encode({ rows: Array.from({ length: 50 }, (_, i) => ({ i, t: 'x'.repeat(i), b: new Uint8Array(i) })), z: 'é' });
  const a = wview(doc), n2 = nview(doc), d = wview(doc, { directories: true });
  assert.deepEqual(walk(a), walk(n2));
  assert.equal(a.path('rows', 37, 't').text(), n2.get('rows').at(37).get('t').text());
  assert.equal(d.get('rows').at(41).get('i').number(), 41);
  const wc = a.cursor(), nc = n2.cursor(), seen = [[], []];
  for (const [cur, out] of [[wc, seen[0]], [nc, seen[1]]]) {
    cur.enter(); cur.find('rows'); cur.enter();
    do { out.push(cur.key, cur.kind); if (cur.enter()) { do { out.push(cur.key, cur.keyIs('t'), cur.kind === 'int' ? cur.int() : cur.offset); } while (cur.next()); cur.up(); } } while (cur.next());
  }
  assert.deepEqual(seen[0], seen[1]);
  assert.throws(() => wview(hexb('a1616101616201')), e => e.code === 'key_order' || e.code === 'duplicate_key' || e instanceof N.SnugFault);
});

test('sources: handles and push streams agree with the buffer verdicts', async () => {
  const docs = [N.encode({ id: 7, rows: Array.from({ length: 300 }, (_, i) => ({ i, text: 'x'.repeat(i % 100), body: new Uint8Array(32) })) }),
    ...profile.accept.map(v => hexb(v.hex)), ...profile.refuse.map(v => hexb(v.hex))];
  for (const d of docs) for (const chunk of [1, 7, 1024, 65536]) {
    const a = await WSRC.scanHandle(WSRC.bufferHandle(d), { top: 'any' }, { chunk }).then(r => ({ r }), e => ({ code: e.code }));
    const b = await NSRC.scanHandle(NSRC.bufferHandle(d), { top: 'any' }, { chunk }).then(r => ({ r }), e => ({ code: e.code }));
    assert.deepEqual(a, b);
    const p = WSRC.pushScanner(d.length, { top: 'any' }), q = NSRC.pushScanner(d.length, { top: 'any' });
    const run = (s) => { try { for (let i = 0; i < d.length; i += chunk) s.feed(d.subarray(i, i + chunk)); return { r: s.finalize() }; } catch (e) { return { code: e.code }; } };
    assert.deepEqual(run(p), run(q));
  }
  const s = await hcompile('r = { id: uint, rows: [* { i: uint, text: tstr, body: bstr }] }');
  const w = await wcompile('r = { id: uint, rows: [* { i: uint, text: tstr, body: bstr }] }');
  for (const d of docs.slice(0, 40)) for (const chunk of [1, 64, 65536]) for (const quantum of [0, 100]) {
    const a = WSRC.validateHandleSync(w, WSRC.bufferHandle(d), 'r', {}, { chunk, quantum });
    const b = NSRC.validateHandleSync(s, NSRC.bufferHandle(d), 'r', {}, { chunk, quantum });
    assert.deepEqual(a, b);
    assert.deepEqual(a, s.validate(d, 'r'));
    const p = WSRC.pushValidator(w, d.length, 'r', {}, { quantum }), q = NSRC.pushValidator(s, d.length, 'r', {}, { quantum });
    for (let i = 0; i < d.length; i += chunk) { let r = p.feed(d.subarray(i, i + chunk)); while (r.state === 'yield') r = p.resume(); r = q.feed(d.subarray(i, i + chunk)); while (r.state === 'yield') r = q.resume(); }
    assert.deepEqual(p.finalize(), q.finalize());
  }
  assert.deepEqual(await WSRC.validateHandle(w, WSRC.asyncHandle(docs[0]), 'r', {}, { chunk: 1000, quantum: 50 }), s.validate(docs[0], 'r'));
});

test('instance loss: a trap resets the instance; Programs reload; the next call works', async () => {
  const w = await wcompile('r = [* any]');
  // 1,000,000 nested arrays under a raised depth limit: the recursive scanner exhausts the wasm stack.
  const deep = new Uint8Array(1_000_001).fill(0x81); deep[deep.length - 1] = 0;
  const g = W.memoryBytes();
  const e = (() => { try { W.decode(deep, { top: 'any', maxDepth: 2_000_000, maxBytes: 2_000_000 }); } catch (err) { return err; } })();
  const n = (() => { try { N.decode(deep, { top: 'any', maxDepth: 2_000_000, maxBytes: 2_000_000 }); } catch (err) { return err; } })();
  assert.ok(e instanceof W.InstanceLost, String(e));
  assert.ok(n instanceof RangeError, `native gives ${n}`);   // neither build reaches a verdict
  {
    assert.deepEqual(w.validate(N.encode([1, 2], { top: 'any' }), 'r'), { ok: true });
    assert.deepEqual(W.decode(N.encode({ a: 1 })), N.decode(N.encode({ a: 1 })));
  }
  assert.ok(g > 0);
});
