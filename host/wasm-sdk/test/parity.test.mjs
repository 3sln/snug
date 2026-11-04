// The wasm SDK parity gate (P7.9 follow-up, D174): the SDK must answer exactly
// as the native package, through the public API, on bb vm-test's whole case
// set (kin/scripts/vm-allcases.mjs: §15, profile identity incl. the profile-
// option cases under random flags, conformance, the oracle differential, fast-
// path stress, extension controls, assembled Programs) for
//
//   validate   the whole result (verdict, reason, path, offset, subcode), and
//              validateAt for span cases
//   decode     schema.decode and the codec decode (values or the fault)
//   encode     the decoded values re-encoded under the case's profile, plus a
//              value set of the profile shapes (bytes or the fault)
//   views      open (profile and schema check), walks, lookups, cursor
//   sessions   handles, declared-length and unknown-length push sources under
//              seeded window splits, quanta and failFast; profile scans too
//   compile    every schema text of the case set (and truncations, profiles,
//              registries): the serialised Program bytes or the SchemaError
//
// plus option validation (D150), extension-control binding and errors, and
// instance-loss recovery. Run by `bb wasm-sdk-test` after building the sdk and
// cc modules. Knobs: SNUG_PARITY_MUTATIONS (20000, as vm-test), SNUG_PARITY_SEED
// (1), SNUG_PARITY_SCHEMAS (400).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import * as N from '../../js/src/index.mjs';
import * as NS from '../../js/src/public-schema.mjs';
import { compile as ncompile } from '../../js/src/public-compile.mjs';
import { view as nview } from '../../js/src/public-view.mjs';
import * as NSRC from '../../js/src/public-sources.mjs';
import { Writer as NWriter } from '../../js/src/public-writer.mjs';
import { tables as unicodeTables } from '../../js/src/unicode-tables.mjs';
import * as W from '../src/index.mjs';
import * as WS from '../src/schema.mjs';
import { compile as wcompile } from '../src/compile.mjs';
import { view as wview } from '../src/view.mjs';
import * as WSRC from '../src/sources.mjs';
import { controls as wgeneric } from '../src/controls.mjs';
import { Writer as WWriter } from '../src/writer.mjs';
import { buildVmCases } from '../../../kin/scripts/vm-allcases.mjs';
import { testControls, EXT_SCHEMAS } from '../../../kin/scripts/ext-cases.mjs';
import { oracleSchemas } from '../../../kin/scripts/vm-oracle-gen.mjs';

const MUTATIONS = Number(process.env.SNUG_PARITY_MUTATIONS ?? 20000);
const SEED = Number(process.env.SNUG_PARITY_SEED ?? 1);
const SCHEMAS = Number(process.env.SNUG_PARITY_SCHEMAS ?? 400);
const root = new URL('../../../', import.meta.url);
const json = p => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const hexb = h => new Uint8Array(Buffer.from(h, 'hex'));
const hex = b => Buffer.from(b).toString('hex');
const errOf = e => (e && typeof e === 'object'
  ? { err: e.name, code: e.code, reason: e.reason, path: e.path, offset: e.offset, subcode: e.subcode, message: e.message, controls: e.controls, cause: e.cause?.message }
  : { thrown: e });
const outcome = f => { try { return { ok: f() }; } catch (e) { return errOf(e); } };
const outcomeAsync = async f => { try { return { ok: await f() }; } catch (e) { return errOf(e); } };

await W.init();

// ---------------------------------------------------------------- mismatch bookkeeping
function tally(name) {
  const t = { name, n: 0, bad: 0, first: [] };
  t.same = (label, a, b) => {
    t.n++;
    if (isDeepStrictEqual(a, b)) return true;
    t.bad++;
    if (t.first.length < 8) t.first.push(`${label}\n    native ${show(b)}\n    wasm   ${show(a)}`);
    return false;
  };
  t.done = () => {
    console.log(`  ${t.bad === 0 ? 'ok  ' : 'FAIL'} ${name}: ${t.n - t.bad}/${t.n} wasm == native`);
    assert.equal(t.bad, 0, `${name}: ${t.bad} of ${t.n} differ:\n  ${t.first.join('\n  ')}`);
  };
  return t;
}
const show = v => { try { return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? `h'${hex(x)}'` : x)).slice(0, 400); } catch { return String(v); } };

// ---------------------------------------------------------------- the case set
const buildFails = [];
const t0 = performance.now();
const { programs, cases } = buildVmCases({ MUTATIONS, SEED, SCHEMAS, fail: m => buildFails.push(m) });
console.log(`  case set: ${cases.length} cases over ${programs.length} Programs (mutations ${MUTATIONS}, seed ${SEED}, schemas ${SCHEMAS}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const KEYS = ['text', 'integer', 'any', 'any'], TAGS = ['bindle', 'standard', 'any', 'any'];
/** The public options of a case's limits words (program.md §12.3; word 9 the profile flags, D120). */
function optsOf(lim) {
  const o = { top: lim[0] === 0 ? 'map' : 'any', cose: lim[1] === 1 };
  ['maxBytes', 'maxDepth', 'maxEntries', 'maxItems', 'maxBignumBytes', 'budget'].forEach((k, i) => { if (lim[2 + i] >= 0) o[k] = lim[2 + i]; });
  const f = lim[9] ?? 0;
  Object.assign(o, { wire: 'bindle', keys: KEYS[f & 3], tags: TAGS[(f >> 2) & 3], floats: f & 16 ? 'deterministic' : 'bindle',
    undefinedValue: (f & 32) !== 0, noncharacters: (f & 64) !== 0 });
  return o;
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const PROFILE = ['wire', 'keys', 'tags', 'floats', 'undefinedValue', 'noncharacters', 'top', 'cose'];
const codecOpts = o => pick(o, [...PROFILE, 'maxBytes', 'maxDepth', 'maxEntries', 'maxItems']);

const pairs = programs.map(({ P, B, label }) => {
  const n = outcome(() => new NS.Schema(new NS.Program(P, B, { controls: testControls })));
  const w = outcome(() => new WS.Schema(new WS.Program(P, B, { controls: testControls })));
  return { label, n: n.ok, w: w.ok, load: [n.ok ? 'ok' : n, w.ok ? 'ok' : w], rules: n.ok ? n.ok.program.rules : [] };
});
const ruleOf = c => { const r = pairs[c.prog].rules[c.rule]; return r !== undefined && pairs[c.prog].rules.indexOf(r) === c.rule ? r : undefined; };

let st = (SEED * 2654435761 + 99) >>> 0 || 1;
const rnd = n => { st ^= st << 13; st ^= st >>> 17; st ^= st << 5; return (st >>> 0) % n; };

test('the case set builds and every Program loads alike', () => {
  assert.deepEqual(buildFails, [], 'vm-allcases reported failures building the case set');
  const t = tally('Program load (vm-verify, controls bound)');
  pairs.forEach(p => t.same(p.label, p.load[1], p.load[0]));
  t.done();
});

test('validate: the whole result on every case (validateAt for spans)', () => {
  const t = tally('validate / validateAt');
  for (const c of cases) {
    const p = pairs[c.prog], rule = ruleOf(c);
    if (!p.n || rule === undefined) continue;
    const o = optsOf(c.lim);
    const run = s => (c.span ? s.validateAt(c.bytes, c.span[0], c.span[1], rule, { ...o, depth: c.span[2], items: c.span[3] }) : s.validate(c.bytes, rule, o));
    t.same(c.label, outcome(() => run(p.w)), outcome(() => run(p.n)));
  }
  t.done();
});

const decoded = new Map();   // case index -> native codec value, for the encode section
test('decode: schema.decode and codec decode on every case', () => {
  const t = tally('schema.decode'), u = tally('codec decode');
  cases.forEach((c, i) => {
    const p = pairs[c.prog], rule = ruleOf(c), o = optsOf(c.lim);
    if (p.n && rule !== undefined && !c.span) t.same(c.label, outcome(() => p.w.decode(c.bytes, rule, o)), outcome(() => p.n.decode(c.bytes, rule, o)));
    const co = codecOpts(o), a = outcome(() => W.decode(c.bytes, co)), b = outcome(() => N.decode(c.bytes, co));
    if (u.same(c.label, a, b) && 'ok' in b) decoded.set(i, b.ok);
  });
  t.done(); u.done();
});

const encodeValues = [
  0, -1, 23, 24, 2 ** 53 - 1, -(2 ** 53), 1.5, -0, NaN, Infinity, -Infinity, 65504, 1e300, 5e-324, 2 ** 60, 1n << 70n, -(1n << 70n), 1n << 1100n,
  'a', 'é', '\uD800', '﷐', '\u{10FFFF}', 'x'.repeat(100) + 'ü', new Uint8Array(70), undefined, null, true, [1, , 3], [undefined],
  { b: 1, a: [new Float32Array([1, 2]), new Float64Array([NaN])] }, new N.Decimal(-12345n, -3), new N.NDArray([2, 2], new Int16Array(4)),
  new Map([[1, 'x'], ['a', 2]]), new Map([[-1n, 0], [2n ** 64n - 1n, 1]]), new Map([[1.5, 'f'], [[1, 2], 'arr'], [new Map([[1, 2]]), 'map'], [null, 0], [true, 1]]),
  new Map([[1, 'a'], [1n, 'b']]), new Map([['b', 1], [new Uint8Array([1]), 2], [undefined, 3]]),
  ...[[0, '2026-11-03T12:00:00Z'], [0, 'not a date'], [1, 1700000000], [1, 'x'], [32, 'https://example.com/a?b#c'], [32, 'not a uri'],
    [24, new Uint8Array([0x82, 1, 2])], [24, new Uint8Array([0x82, 1])], [24, new Uint8Array([0xf9, 0x3c, 0x00])], [21, 'x'], [55799, { a: 1 }],
    [16, [1, 2]], [61, { a: 1 }], [2, new Uint8Array([1])], [69, new Uint8Array(2)], [4294967296, 'big'], [2n ** 64n - 1n, 0],
    [66, new Uint8Array(4)], [66, new Uint8Array(3)]].map(([tag, v]) => { try { return new N.Tagged(tag, v); } catch { return `no Tagged(${tag})`; } }),
  { z: 1, y: { x: 2, w: 'é' }, aa: null, a: true }, Array.from({ length: 70000 }, () => 0), new Map([[new N.Tagged(1, 2), 'tagkey']]),
];
encodeValues.push([new N.Tagged(55799, 1)]);
const encodeOptions = [{}, { wire: 'bindle' }, { wire: 'bindle', top: 'any' }, { keys: 'text' }, { keys: 'integer' }, { tags: 'standard' }, { tags: 'bindle' },
  { floats: 'bindle' }, { undefinedValue: false }, { noncharacters: false }, { cose: true }, { wire: 'bindle', cose: true }, { maxItems: 3 },
  { maxDepth: 1 }, { maxBytes: 4 }, { maxEntries: 2 }, { strictArrays: true }, { omitUndefined: true }];

test('encode: the decoded case values and the profile value set', () => {
  const t = tally('encode of decoded case values'), u = tally('encode of the value set x options'), v = tally('native Writer re-exported');
  for (const [i, value] of decoded) {
    const o = codecOpts(optsOf(cases[i].lim));
    t.same(cases[i].label, outcome(() => W.encode(value, o)), outcome(() => N.encode(value, o)));
  }
  const det = json('corpus/cbor-vectors/deterministic.json');
  const values = [...encodeValues, ...det.accept.map(x => outcome(() => N.decode(hexb(x.hex), { top: 'any' }))).filter(x => 'ok' in x).map(x => x.ok)];
  values.forEach((value, k) => { for (const opts of encodeOptions) u.same(`value #${k} ${show(value).slice(0, 60)} ${show(opts)}`, outcome(() => W.encode(value, opts)), outcome(() => N.encode(value, opts))); });
  v.same('Writer', WWriter, NWriter);
  t.done(); u.done(); v.done();
});

function walk(v, out, budget = { left: 3000 }) {
  if (--budget.left < 0) return out;
  const kind = v.kind;
  out.push(kind, v.offset, v.depth, v.length);
  if (kind === 'map' || kind === 'array') {
    for (const [k, c] of v.entries()) {
      out.push(k, outcome(() => (kind === 'map' ? v.get(k) : v.at(k))?.offset ?? -1));
      walk(c, out, budget);
      if (budget.left < 0) break;
    }
  } else if (kind === 'tagged') { out.push(v.tag); walk(v.content(), out, budget); }
  else out.push(outcome(() => v.value()), hex(v.raw()), outcome(() => v.isUndefined()));
  return out;
}
function cursorWalk(v) {
  const c = v.cursor(), out = []; let steps = 0;
  const rec = () => {
    out.push(c.kind, c.offset, c.depth, outcome(() => c.key));
    if (++steps > 3000) return;
    if (c.enter()) { do rec(); while (steps <= 3000 && c.next()); c.up(); }
  };
  rec();
  return out;
}
const viewAll = v => ({ walk: walk(v, []), cursor: cursorWalk(v), value: outcome(() => v.value()) });

test('views: open, walks, lookups and cursor on every case', () => {
  const t = tally('view (profile check)'), u = tally('view (schema check)');
  for (const c of cases) {
    if (c.span) continue;
    const o = optsOf(c.lim), co = codecOpts(o), small = c.bytes.length <= 8192;
    const directories = rnd(4) === 0;
    const open = (f, opts) => { const r = outcome(() => f(c.bytes, opts)); return 'ok' in r ? (small ? viewAll(r.ok) : 'opened') : r; };
    t.same(c.label, open(wview, { ...co, directories }), open(nview, { ...co, directories }));
    const p = pairs[c.prog], rule = ruleOf(c);
    if (p.n && rule !== undefined) {
      const vo = pick(o, [...PROFILE, 'maxBytes', 'maxDepth', 'maxEntries', 'maxItems', 'maxBignumBytes', 'budget']);
      u.same(c.label, open(wview, { ...vo, schema: p.w, rule }), open(nview, { ...vo, schema: p.n, rule }));
    }
  }
  t.done(); u.done();
});

// ---------------------------------------------------------------- sessions
const CHUNKS = [1, 2, 3, 5, 8, 13, 64, 1000, 65536];
function push(open, bytes, chunk) {
  try {
    const p = open();
    for (let i = 0; i < bytes.length; i += chunk) {
      let r = p.feed(bytes.subarray(i, i + chunk));
      while (r.state === 'yield') r = p.resume();
    }
    return { ok: p.finalize() };
  } catch (e) { return errOf(e); }
}
// Every case runs one VM session, the flavour rotating (a handle, a declared-length push, an unknown-length push),
// and every fourth case one profile scan session (handle, declared, unknown): a session costs ~0.3-1.7 ms to set
// up on either side (an unknown-length one sizes its key arena for the input limit, D144), so running every flavour
// on every case would take ~16 minutes.
test('sessions: handles, declared and unknown length, under window splits, quanta and failFast', () => {
  const k = tally('validateHandleSync'), d = tally('pushValidator (declared length)'), u = tally('pushValidator (unknown length)'),
    s = tally('scanHandleSync / pushScanner (declared and unknown length)');
  let i = 0;
  for (const c of cases) {
    if (c.span) continue;
    const p = pairs[c.prog], rule = ruleOf(c), o = optsOf(c.lim), b = c.bytes, flavour = i++ % 3;
    const chunk = CHUNKS[rnd(CHUNKS.length)], quantum = [0, 0, 1, 7, 50][rnd(5)], failFast = rnd(2) === 0;
    const tag = `${c.label} (chunk ${chunk}, quantum ${quantum}${flavour === 2 ? `, failFast ${failFast}` : ''})`;
    if (p.n && rule !== undefined) {
      if (flavour === 0) k.same(tag, outcome(() => WSRC.validateHandleSync(p.w, WSRC.bufferHandle(b), rule, o, { chunk, quantum })),
        outcome(() => NSRC.validateHandleSync(p.n, NSRC.bufferHandle(b), rule, o, { chunk, quantum })));
      else if (flavour === 1) d.same(tag, push(() => WSRC.pushValidator(p.w, b.length, rule, o, { quantum }), b, chunk), push(() => NSRC.pushValidator(p.n, b.length, rule, o, { quantum }), b, chunk));
      else u.same(tag, push(() => WSRC.pushValidator(p.w, undefined, rule, o, { quantum, failFast }), b, chunk),
        push(() => NSRC.pushValidator(p.n, undefined, rule, o, { quantum, failFast }), b, chunk));
    }
    if (i % 4 === 0) {
      const co = codecOpts(o), f = (i >> 2) % 3;
      if (f === 0) s.same(tag, outcome(() => WSRC.scanHandleSync(WSRC.bufferHandle(b), co, { chunk, quantum })), outcome(() => NSRC.scanHandleSync(NSRC.bufferHandle(b), co, { chunk, quantum })));
      else if (f === 1) s.same(tag, push(() => WSRC.pushScanner(b.length, co, { quantum }), b, chunk), push(() => NSRC.pushScanner(b.length, co, { quantum }), b, chunk));
      else s.same(tag, push(() => WSRC.pushScanner(undefined, co, { quantum, failFast }), b, chunk), push(() => NSRC.pushScanner(undefined, co, { quantum, failFast }), b, chunk));
    }
  }
  k.done(); d.done(); u.done(); s.done();
});

test('sessions: openSession, async handles and streams', async () => {
  const t = tally('openSession / validateHandle / validateStream / scanStream');
  const text = 'r = { id: uint, rows: [* { i: uint, text: tstr .chars (0..99), body: bstr }] }';
  const n = await ncompile(text, { controls: testControls }), w = await wcompile(text, { controls: testControls });
  const doc = N.encode({ id: 7, rows: Array.from({ length: 200 }, (_, i) => ({ i, text: 'x'.repeat(i % 120), body: new Uint8Array(32) })) });
  const docs = [doc, doc.subarray(0, 1000), Uint8Array.from(doc, (x, i) => (i === 500 ? x ^ 0x40 : x))];
  const sessionRun = (S, schema, b, length) => {
    try {
      const s = S.openSession(schema, 'r', length, {}, { quantum: 3 });
      const out = [s.length, s.limit];
      let r = s.step(b.subarray(0, Math.min(b.length, 17)), 0);
      for (let guard = 0; guard < 100000 && r.state !== 'done'; guard++) {
        if (r.state === 'held') { out.push('held', r.result); r = s.end(b.length); continue; }
        const at = r.state === 'need' ? r.offset : r.position;
        if (length === undefined && at >= b.length) { r = s.end(b.length); continue; }
        r = s.step(b.subarray(at, Math.min(b.length, at + Math.max(r.length ?? 1, 17))), at);
      }
      return { ok: [...out, r] };
    } catch (e) { return errOf(e); }
  };
  for (const b of docs) {
    t.same('openSession declared', sessionRun(WSRC, w, b, b.length), sessionRun(NSRC, n, b, b.length));
    t.same('openSession unknown', sessionRun(WSRC, w, b, undefined), sessionRun(NSRC, n, b, undefined));
    t.same('validateHandle', await outcomeAsync(() => WSRC.validateHandle(w, WSRC.asyncHandle(b), 'r', {}, { chunk: 100, quantum: 20 })),
      await outcomeAsync(() => NSRC.validateHandle(n, NSRC.asyncHandle(b), 'r', {}, { chunk: 100, quantum: 20 })));
    const chunks = () => Array.from({ length: Math.ceil(b.length / 97) }, (_, i) => b.subarray(97 * i, 97 * i + 97));
    for (const failFast of [false, true]) {
      t.same('validateStream', await outcomeAsync(() => WSRC.validateStream(w, WSRC.streamSource(chunks()), 'r', {}, { failFast })),
        await outcomeAsync(() => NSRC.validateStream(n, NSRC.streamSource(chunks()), 'r', {}, { failFast })));
      t.same('scanStream', await outcomeAsync(() => WSRC.scanStream(chunks(), {}, { failFast })), await outcomeAsync(() => NSRC.scanStream(chunks(), {}, { failFast })));
    }
  }
  t.same('openSession on a non-schema', outcome(() => WSRC.openSession({}, 'r')), outcome(() => NSRC.openSession({}, 'r')));
  t.same('openSession unknown rule', outcome(() => WSRC.openSession(w, 'nope', 3)), outcome(() => NSRC.openSession(n, 'nope', 3)));
  t.same('Schema.session is gone (D160)', typeof w.session, typeof n.session);
  const snap = S => outcome(() => { const b = new Uint8Array([1, 2]); const h = S.bufferHandle(b); b[0] = 9; const r = h.read(0, 2); r[1] = 7; return [Object.isFrozen(h), Array.from(h.read(0, 2))]; });
  t.same('handle snapshots (D151)', snap(WSRC), snap(NSRC));
  t.done();
});

// ---------------------------------------------------------------- compile
const STRESS = ['r = [* int]', 'r = [* (0..100)]', 'r = [* tstr .size (0..3)]', 'r = { v: [* uint], w: [* tstr] }', 'r = [* { * tstr => int }]',
  'r = { * tstr => any }', 'r = { * tstr => [* int] }', 'r = [* { a: uint, ? b: tstr, c: bool }]', 'r = { id: uint, ? m: { x: int, y: int }, tags: [* tstr] }'];
const programBytes = s => ({ serialized: hex(s.program.serialize()), sourceKey: s.program.sourceKey, rules: s.program.rules, controls: s.program.controls });
test('compile: every schema text of the case set gives the same Program bytes or SchemaError', async () => {
  const t = tally('compile (Program bytes / SchemaError)');
  const texts = [];
  for (const file of ['study', 'adversarial', 'audit-2026-11-04']) for (const su of json(`corpus/conformance/${file}.json`).suites)
    texts.push([`${file}: ${su.name}`, su.cddl ?? readFileSync(new URL(`corpus/${su.cddlFile}`, root), 'utf8'), {}]);
  for (const { cddl } of oracleSchemas(SCHEMAS, 8, SEED * 7919 + 1)) texts.push([`oracle: ${cddl}`, cddl, {}]);
  for (const [text, kind] of EXT_SCHEMAS) texts.push([`ext ${kind}`, text, { controls: testControls, limits: { items: 1 << 20, entries: 1 << 20 } }]);
  for (const text of STRESS) texts.push([`stress ${text}`, text, { limits: { items: 1 << 20, entries: 1 << 20 } }]);
  texts.push(['any', 'r = any', { limits: { depth: 256, inputBytes: 0x7fffffff, entries: 1 << 24, items: 1 << 24, budget: 0x7fffffff } }]);
  const all = [];
  for (const [label, text, opts] of texts) {
    all.push([label, text, opts]);
    if (rnd(2) === 0) all.push([`${label} (bindle)`, text, { ...opts, profile: 'bindle' }]);
    if (rnd(2) === 0) all.push([`${label} (bus)`, text, { ...opts, profile: 'bus', ...(opts.controls ? { controlsInBus: rnd(2) === 0 } : {}) }]);
    if (text.length > 4 && rnd(3) === 0) { const cut = 1 + rnd(text.length - 1); all.push([`${label} (cut at ${cut})`, text.slice(0, cut), opts]); }
  }
  for (const [label, text, opts] of all) {
    const a = await outcomeAsync(async () => programBytes(await wcompile(text, opts)));
    const b = await outcomeAsync(async () => programBytes(await ncompile(text, opts)));
    t.same(label, a, b);
  }
  // registries, arguments, Unicode tables (D110, D141, D142)
  const extra = [
    ['r = tstr .regexp "\\\\p{L}+"', {}], ['r = tstr .regexp "\\\\p{L}+"', { unicode: unicodeTables }], ['r = tstr .nope 1', {}],
    ['r = tstr .nope 1', { controls: { nope: () => true } }], ['r = tstr .chars "x"', { controls: wgeneric }], ['r = [* int] .unique true', { controls: wgeneric, profile: 'bus' }],
    ['r = [* int] .unique true', { controls: wgeneric, profile: 'bus', controlsInBus: true }], ['r = tstr .chars (1..3)', { controls: { ...wgeneric, size: () => true } }],
    ['r = tstr .x 1', { controls: { x: { check: () => true, maxBytes: -1 } } }], ['r = tstr .x 1', { controls: { x: { check: () => true, argument: a => a.length === 2 } } }],
    ['r = h\'00\' .x 1', { controls: { x: () => true } }], ['r = { a: 1 }', { limits: { schemaBytes: 3 } }], ['r = [* r]', { limits: { compileBudget: 10 } }],
  ];
  for (const [text, opts] of extra) {
    const a = await outcomeAsync(async () => programBytes(await wcompile(text, opts)));
    const b = await outcomeAsync(async () => programBytes(await ncompile(text, opts)));
    t.same(`${text} ${show(Object.keys(opts))}`, a, b);
  }
  t.done();
});

test('extension controls: binding, missing controls, host predicates, throws and re-entry', async () => {
  const t = tally('extension controls');
  const text = 'r = [* (tstr .even 0) / (tstr .chars (5..400))]';
  const n = await ncompile(text, { controls: testControls }), w = await wcompile(text, { controls: testControls });
  const ser = n.program.serialize();
  t.same('serialised 1.1 Program', hex(w.program.serialize()), hex(ser));
  t.same('fromSerialized without controls', await outcomeAsync(() => WS.fromSerialized(ser)), await outcomeAsync(() => NS.fromSerialized(ser)));
  t.same('fromSerialized with a partial registry', await outcomeAsync(() => WS.fromSerialized(ser, { controls: { even: testControls.even } })),
    await outcomeAsync(() => NS.fromSerialized(ser, { controls: { even: testControls.even } })));
  const w2 = await WS.fromSerialized(ser, { controls: testControls }), n2 = await NS.fromSerialized(ser, { controls: testControls });
  for (const v of [['ab', 'abcdef'], ['abc'], ['a'.repeat(300)], ['aaaa', 'é'.repeat(5)], []])
    t.same(`validate ${show(v)}`, outcome(() => w2.validate(N.encode(v), 'r')), outcome(() => n2.validate(N.encode(v), 'r')));
  // a predicate that throws, and one that calls back into its own package
  const throwing = { even: () => { throw new Error('boom'); }, chars: testControls.chars };
  const nt = await ncompile(text, { controls: throwing }), wt = await wcompile(text, { controls: throwing });
  const doc = N.encode(['ab']);
  t.same('throwing predicate (validate)', outcome(() => wt.validate(doc, 'r')), outcome(() => nt.validate(doc, 'r')));
  t.same('throwing predicate (session)', push(() => WSRC.pushValidator(wt, doc.length, 'r'), doc, 1), push(() => NSRC.pushValidator(nt, doc.length, 'r'), doc, 1));
  t.same('after a throw the schema still works', outcome(() => wt.validate(N.encode([]), 'r')), outcome(() => nt.validate(N.encode([]), 'r')));
  let nr = null, wr = null;
  nr = await ncompile(text, { controls: { even: () => nr.validate(doc, 'r').ok, chars: testControls.chars } });
  wr = await wcompile(text, { controls: { even: () => wr.validate(doc, 'r').ok, chars: testControls.chars } });
  const a = outcome(() => wr.validate(doc, 'r')), b = outcome(() => nr.validate(doc, 'r'));
  t.same('re-entrant predicate makes the call throw', [a.err, a.message], [b.err, b.message]);
  t.same('the instance survives re-entry', outcome(() => w.validate(N.encode(['abcdef']), 'r')), outcome(() => n.validate(N.encode(['abcdef']), 'r')));
  t.same('Program.controls', w.program.controls, n.program.controls);
  // the generic controls run inside wasm (kinds 1..3), any other predicate through the import (kind 0, D171)
  let calls = 0;
  const wc = await wcompile(text, { controls: { even: (arg, item) => { calls++; return item.length % 2 === 0; }, chars: wgeneric.chars } });
  wc.validate(N.encode(['ab', 'abcde']), 'r');
  assert.deepEqual(Array.from(WS.innerOf(wc.program).kinds), [1, 0], 'chars in wasm, even through the import');
  assert.ok(calls > 0, 'the host predicate was asked through the import');
  t.done();
});

test('option validation: unknown and malformed options are the same TypeError (D150)', async () => {
  const t = tally('option validation');
  const n = await ncompile('r = any'), w = await wcompile('r = any');
  const b = N.encode({ a: 1 });
  const bad = [{ nope: 1 }, { wire: 'x' }, { keys: 'all' }, { tags: 'every' }, { floats: 1 }, { undefinedValue: 'yes' }, { maxDepth: -1 },
    { maxBytes: 1.5 }, { budget: 2 ** 60 }, { top: 'list' }, { cose: 1 }, { objects: 'map' }, { [Symbol('s')]: 1 }, Object.create({ x: 1 }), null, [], 'x'];
  const sides = [
    ['decode', o => W.decode(b, o), o => N.decode(b, o)], ['encode', o => W.encode({ a: 1 }, o), o => N.encode({ a: 1 }, o)],
    ['validate', o => w.validate(b, 'r', o), o => n.validate(b, 'r', o)], ['validateAt', o => w.validateAt(b, 0, b.length, 'r', o), o => n.validateAt(b, 0, b.length, 'r', o)],
    ['schema.decode', o => w.decode(b, 'r', o), o => n.decode(b, 'r', o)], ['view', o => wview(b, o), o => nview(b, o)],
    ['view.validateAt', o => wview(b, { schema: w, rule: 'r' }).validateAt('r', o), o => nview(b, { schema: n, rule: 'r' }).validateAt('r', o)],
    ['pushValidator scheduling', o => WSRC.pushValidator(w, b.length, 'r', {}, o), o => NSRC.pushValidator(n, b.length, 'r', {}, o)],
    ['pushScanner', o => WSRC.pushScanner(b.length, o), o => NSRC.pushScanner(b.length, o)],
    ['validateHandleSync source', o => WSRC.validateHandleSync(w, WSRC.bufferHandle(b), 'r', {}, o), o => NSRC.validateHandleSync(n, NSRC.bufferHandle(b), 'r', {}, o)],
    ['scanHandleSync', o => WSRC.scanHandleSync(WSRC.bufferHandle(b), o), o => NSRC.scanHandleSync(NSRC.bufferHandle(b), o)],
    ['openSession', o => WSRC.openSession(w, 'r', b.length, o), o => NSRC.openSession(n, 'r', b.length, o)],
    ['asyncHandle', o => WSRC.asyncHandle(b, o), o => NSRC.asyncHandle(b, o)],
    ['Program', o => new WS.Program(w.program.P, w.program.B, o), o => new NS.Program(n.program.P, n.program.B, o)],
  ];
  const brief = r => ('ok' in r ? 'ok' : r);
  for (const [name, wf, nf] of sides) for (const o of bad) t.same(`${name} ${show(o)}`, brief(outcome(() => wf(o))), brief(outcome(() => nf(o))));
  for (const o of [{ quantum: -1 }, { quantum: 2 ** 31 }, { failFast: 'yes' }, { chunk: 0 }, { delay: -1 }])
    for (const [name, wf, nf] of sides.slice(7)) t.same(`${name} ${show(o)}`, brief(outcome(() => wf(o))), brief(outcome(() => nf(o))));
  for (const o of [...bad, { limits: { nope: 1 } }, { limits: { depth: -1 } }, { profile: 'strict' }, { unicode: [1] }, { controls: 3 }, { controlsInBus: 1 }])
    t.same(`compile ${show(o)}`, brief(await outcomeAsync(() => wcompile('r = any', o))), brief(await outcomeAsync(() => ncompile('r = any', o))));
  for (const o of [{ controls: 3 }, { nope: 1 }])
    t.same(`fromSerialized ${show(o)}`, brief(await outcomeAsync(() => WS.fromSerialized(n.program.serialize(), o))), brief(await outcomeAsync(() => NS.fromSerialized(n.program.serialize(), o))));
  t.done();
});

test('instance loss: a trap resets the instance; Programs and sessions recover; the next call works', async () => {
  const text = 'r = [* (any / tstr .chars (1..3))]';
  const w = await wcompile(text, { controls: wgeneric }), n = await ncompile(text, { controls: wgeneric });
  const pending = WSRC.pushValidator(w, 10, 'r');
  // 1,000,000 nested arrays under a raised depth limit: the recursive scanner exhausts the wasm stack.
  const deep = new Uint8Array(1_000_001).fill(0x81); deep[deep.length - 1] = 0;
  const g = W.memoryBytes();
  const e = outcome(() => W.decode(deep, { top: 'any', maxDepth: 2_000_000, maxBytes: 2_000_000 }));
  const native = outcome(() => N.decode(deep, { top: 'any', maxDepth: 2_000_000, maxBytes: 2_000_000 }));
  assert.equal(e.err, 'InstanceLost', show(e));
  assert.equal(native.err, 'RangeError', `native gives ${show(native)}`);   // neither build reaches a verdict
  for (const v of [[1, 2], ['ab'], ['abcd']]) assert.deepEqual(w.validate(N.encode(v), 'r'), n.validate(N.encode(v), 'r'));
  assert.deepEqual(W.decode(N.encode({ a: 1 })), N.decode(N.encode({ a: 1 })));
  assert.equal(outcome(() => pending.feed(new Uint8Array(10))).err, 'Error', 'a session from the lost instance is unusable');
  const p = WSRC.pushValidator(w, 4, 'r'); p.feed(N.encode(['ab']));
  assert.deepEqual(p.finalize(), { ok: true });
  assert.ok(g > 0);
  console.log('  ok   instance loss recovered (decode, validate with a generic control, sessions)');
});
