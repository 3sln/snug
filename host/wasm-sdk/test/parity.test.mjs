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
//   sequences  (P7.13w; P8.4 adds valid-CBOR sequences of indefinite-length items) readSequence / sequenceReader on sequences built from
//              the case set (as bb sequence-test builds them) under whole,
//              1-byte, random and every-offset chunkings, every policy
//              (onInvalid stop/skip, copy spanning/always, failFast, quanta):
//              per-feed messages (index, offset, length, borrowed, bytes),
//              skipped and stopping faults, stats, view walks; release
//              latency 0 in 1-byte runs; View/Cursor/message privacy
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
import * as NSEQ from '../../js/src/public-sequence.mjs';
import * as WSEQ from '../src/sequence.mjs';
import { View as WView, Cursor as WCursor } from '../src/view.mjs';
import { chunkEnds } from '../../../kin/scripts/sequence-run.mjs';
import { controls as wgeneric } from '../src/controls.mjs';
import { abnf as wabnf } from '../src/abnf.mjs';
import { abnf as nabnf } from '../../js/src/abnf.mjs';
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
  else out.push(outcome(() => v.value()), hex(v.raw()), outcome(() => v.isUndefined()), outcome(() => v.simple()));
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
      let r = s.step(b.subarray(0, Math.min(b.length, 17)), 0), ended = false;
      // end(n) once: after it a 'yield' (vms-eof's resume) is stepped from its position, never ended again
      for (let guard = 0; guard < 100000 && r.state !== 'done'; guard++) {
        if (r.state === 'held') { out.push('held', r.result); ended = true; r = s.end(b.length); continue; }
        const at = r.state === 'need' ? r.offset : r.position;
        if (length === undefined && at >= b.length && !ended) { ended = true; r = s.end(b.length); continue; }
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

// ---------------------------------------------------------------- sequences (P7.13w)
// Sequences are built from the case set as bb sequence-test builds them: each case alone,
// and among 0..3 companions of its group (same Program, rule and limits; at most 4 KiB) or
// small fillers before and after it, sometimes with a truncated tail; every fourth with a
// maxMessageBytes below its longest message; one empty sequence per Program. Each sequence
// runs on both packages through readSequence and sequenceReader, the chunking and policy
// rotating; small sequences are also split at every offset. Every fourth case also runs
// profile-only (no schema: the built-in `any`). The SDK must give the native per-feed
// answers exactly; native is held to D211's oracle by bb sequence-test.
const SEQ_FILLERS = [[0xa0], [0xa1, 0x61, 0x61, 0x01], [0x00], [0x80], [0x60], [0x18, 0x64]].map(a => Uint8Array.from(a));
const catBytes = parts => { const t = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of parts) { t.set(x, o); o += x.length; } return t; };
const SEQ_MAX = 2000;   // messages per run (the 1,500,001-zero vector is 1.5 M one-byte messages)
function sequenceSet() {
  const limKey = c => `${c.prog}:${c.rule}:${Array.from(c.lim).join(',')}`, groups = new Map(), seqs = [], empty = new Set();
  const plain = cases.filter(c => !c.span);
  for (const c of plain) { const k = limKey(c); if (!groups.has(k)) groups.set(k, []); if (c.bytes.length <= 4096) groups.get(k).push(c.bytes); }
  plain.forEach((c, ci) => {
    const g = groups.get(limKey(c)), member = () => (rnd(4) === 0 || g.length === 0 ? SEQ_FILLERS[rnd(SEQ_FILLERS.length)] : g[rnd(g.length)]);
    const profile = ci % 4 === 0;
    seqs.push({ c, S: c.bytes, label: `${c.label} alone`, profile });
    const parts = [];
    for (let k = rnd(4); k > 0; k--) parts.push(member());
    parts.push(c.bytes);
    for (let k = rnd(4); k > 0; k--) parts.push(member());
    if (rnd(3) === 0) { const t = member(); if (t.length > 1) parts.push(t.subarray(0, 1 + rnd(t.length - 1))); }
    const S = catBytes(parts);
    seqs.push({ c, S, label: `${c.label} in ${parts.length}`, profile });
    if (ci % 4 === 0) seqs.push({ c, S, label: `${c.label} in ${parts.length}, small maxMessageBytes`, small: rnd(Math.max(...parts.map(x => x.length)) + 1) });
    if (!empty.has(c.prog)) { empty.add(c.prog); seqs.push({ c, S: new Uint8Array(0), label: `empty (${pairs[c.prog].label})`, profile: true }); }
  });
  return seqs;
}
function seqOptions(q, side) {
  const o = optsOf(q.c.lim), { maxBytes, ...rest } = o;
  const opts = { ...rest };
  if (q.small !== undefined) opts.maxMessageBytes = q.small; else if (maxBytes !== undefined) opts.maxMessageBytes = maxBytes;
  if (!q.profile) {
    const p = pairs[q.c.prog], rule = ruleOf(q.c);
    if (!p.n || rule === undefined) return null;
    opts.schema = side === 'w' ? p.w : p.n; opts.rule = rule;
  } else { delete opts.maxBignumBytes; delete opts.budget; }
  return opts;
}
const faultOf = e => (e && typeof e === 'object'
  ? { name: e.name, code: e.code, reason: e.reason, path: e.path, offset: e.offset, subcode: e.subcode, index: e.index, messageOffset: e.messageOffset, skippable: e.skippable, message: e.message }
  : { thrown: String(e) });
const msgOf = m => [m.index, m.offset, m.length, m.borrowed, hex(m.bytes)];
const chunksBy = (S, ends) => { const a = []; let from = 0; for (const e of ends) { a.push(S.subarray(from, e)); from = e; } return a; };
/** sequenceReader: the answer of every feed and of end(); late: accepted messages of a 1-byte run not released by their own last byte. */
function pushRun(api, opts, chunks, byteRun, walks, ends) {
  const out = []; let late = 0;
  try {
    const rd = api.sequenceReader(opts);
    let k = 0, stopped = false;
    const take = (res, at) => {
      out.push([res.messages.map(m => { if (byteRun && m.offset + m.length - 1 !== at) late++; return msgOf(m); }), res.skipped.map(faultOf), res.error ? faultOf(res.error) : null]);
      for (const m of res.messages) if (walks && m.index % 5 === 0 && m.length <= 8192) out.push(viewAll(m.view));
      return res.error !== undefined;
    };
    for (; k < chunks.length && !stopped; k++) stopped = take(rd.feed(chunks[k]), byteRun ? ends[k] - 1 : -1);
    if (!stopped) take(rd.end(), -1);
    out.push(rd.done);
  } catch (e) { out.push(faultOf(e)); }
  return { out, late };
}
/** readSequence: every message with the chunk being read when it was yielded, the end or the fault, and stats. */
async function pullRun(api, opts, chunks, walks) {
  const out = []; let pulled = -1;
  const src = (function* () { for (let k = 0; k < chunks.length; k++) { pulled = k; yield chunks[k]; } pulled = chunks.length; })();
  let it;
  try {
    it = api.readSequence(src, opts);
    for await (const m of it) {
      out.push([pulled, ...msgOf(m)]);
      if (walks && m.index % 5 === 0 && m.length <= 8192) out.push(viewAll(m.view));
      if (out.length > 4 * SEQ_MAX) break;
    }
    out.push('end');
  } catch (e) { out.push(faultOf(e)); }
  if (it) { const st = it.stats; out.push({ ...st, lastSkipped: st.lastSkipped && faultOf(st.lastSkipped) }); }
  return out;
}
test('sequences: readSequence and sequenceReader == native under chunk splits and every policy; release latency; views', async () => {
  const t0 = performance.now();
  const seqs = sequenceSet();
  const tp = tally('sequenceReader (per-feed messages, skipped, error; profile and schema)'), tr = tally('readSequence (messages, release chunk, fault, stats)');
  let runs = 0, msgs = 0, byteMsgs = 0, wLate = 0, nLate = 0, splits = 0, cut = 0;
  const times = new Map(), prof = (k, w, nn) => { const x = times.get(k) ?? [0, 0, 0]; x[0]++; x[1] += w; x[2] += nn; times.set(k, x); };
  const POLICIES = [{}, { onInvalid: 'skip' }, { copy: 'always' }, { failFast: true }, { onInvalid: 'skip', copy: 'always' }, { onInvalid: 'skip', failFast: true }];
  for (let si = 0; si < seqs.length; si++) {
    const q = seqs[si], wo = seqOptions(q, 'w'), no = seqOptions(q, 'n');
    if (!wo || (process.env.SNUG_PARITY_SEQ_MATCH && !q.label.includes(process.env.SNUG_PARITY_SEQ_MATCH))) continue;
    let S = q.S;
    if (S.length > SEQ_MAX) {
      // cut at the boundary after the first SEQ_MAX messages (native's own framing tells where)
      const r = NSEQ.sequenceReader({ ...no, onInvalid: 'skip' }).feed(S), last = r.messages[SEQ_MAX - 1];
      if (last) { S = S.subarray(0, last.offset + last.length); cut++; }
    }
    // the rotation: sequenceReader on every sequence (chunking by si % 4, policy by si / 4 % 6);
    // readSequence on every other one (another chunking; a quantum on one in four)
    const n = S.length, policy = POLICIES[(si >> 2) % POLICIES.length], walks = si % 3 === 0;
    const chunkings = [{ kind: 0 }, n <= 4096 ? { kind: 1, w: 1 } : { kind: 2, w: 4096, seed: 1 + rnd(1 << 30) },
      { kind: 2, w: 7, seed: 1 + rnd(1 << 30) }, { kind: 2, w: 300, seed: 1 + rnd(1 << 30) }];
    const ch = chunkings[si % 4], ch2 = chunkings[(si + 1 + (si >> 3)) % 4];
    const label = `${q.label} ${show(policy)} ${show(ch)} [${hex(S).slice(0, 60)}]`;
    // sequenceReader on one chunking, readSequence on another (with a quantum on some)
    const ends = chunkEnds(n, ch), chunks = chunksBy(S, ends), byteRun = ch.kind === 1;
    let t1 = performance.now();
    const a = pushRun(WSEQ, { ...wo, ...policy }, chunks, byteRun, walks, ends);
    let t2 = performance.now();
    const b = pushRun(NSEQ, { ...no, ...policy }, chunks, byteRun, walks, ends);
    prof(`push ${ch.kind}`, t2 - t1, performance.now() - t2);
    tp.same(label, a.out, b.out); runs++;
    if (byteRun) { wLate += a.late; nLate += b.late; byteMsgs += a.out.reduce((s, x) => s + (Array.isArray(x) && Array.isArray(x[0]) ? x[0].length : 0), 0); }
    if (si % 2 === 1) continue;
    const quantum = [0, 0, 0, 0, 0, 0, 7, 50][rnd(8)] || (si % 512 === 0 ? 1 : 0), ends2 = chunkEnds(n, ch2), chunks2 = chunksBy(S, ends2);
    const ro = { ...policy, ...(quantum ? { quantum } : {}) };
    t1 = performance.now();
    const c = await pullRun(WSEQ, { ...wo, ...ro }, chunks2, walks);
    t2 = performance.now();
    const d = await pullRun(NSEQ, { ...no, ...ro }, chunks2, walks);
    prof(`pull ${ch2.kind}`, t2 - t1, performance.now() - t2);
    tr.same(`${q.label} ${show(ro)} ${show(ch2)}`, c, d); runs++;
    msgs += c.filter(x => Array.isArray(x)).length;
    // small sequences: split at every offset (sequenceReader, the policy rotating)
    if (n <= 24 && si % 4 === 0) for (let k = 1; k < n; k++) {
      const pk = POLICIES[k % POLICIES.length], sc = chunksBy(S, chunkEnds(n, { kind: 3, k }));
      t1 = performance.now();
      const e = pushRun(WSEQ, { ...wo, ...pk }, sc, false, false).out;
      t2 = performance.now();
      const f = pushRun(NSEQ, { ...no, ...pk }, sc, false, false).out;
      prof('split', t2 - t1, performance.now() - t2);
      tp.same(`${q.label} split ${k} ${show(pk)} ${show(no.maxMessageBytes)} [${hex(S)}]`, e, f);
      runs++; splits++;
    }
  }
  console.log(`  info sequences: ${seqs.length} sequences (${cut} cut at ${SEQ_MAX} messages), ${runs} runs (${splits} every-offset splits), ${msgs} readSequence messages, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`  info time (runs, wasm s, native s): ${[...times].map(([k, x]) => `${k}: ${x[0]}, ${(x[1] / 1000).toFixed(1)}, ${(x[2] / 1000).toFixed(1)}`).join('; ')}`);
  tp.done(); tr.done();
  console.log(`  ${wLate === 0 && nLate === 0 ? 'ok  ' : 'FAIL'} release latency: ${wLate} (wasm) / ${nLate} (native) of ${byteMsgs} accepted messages in 1-byte runs waited for a byte past their own end`);
  assert.equal(wLate, 0); assert.equal(nLate, 0);
});

test('sequences under wire valid: indefinite-length items, unsorted keys, duplicates by value == native, views over the canonical copy', async () => {
  const anyN = await ncompile('r = any'), anyW = await wcompile('r = any');
  // P8.4: valid, non-deterministic messages ([_ 1, 2], {_ "b": 2, "a": 1}, (_ "ab", "cde"), [_ {_ 1 (wide): "x"}, (_ h'01', h'0203')])
  // then a duplicate by value in an indefinite map, or a cut indefinite array; every view walked
  const unhex = h => Uint8Array.from(Buffer.from(h, 'hex'));
  const good = ['9f0102ff', 'bf616202616101ff', '7f62616263636465ff', '9fbf18016178ff5f4101420203ffff'].map(unhex);
  const t = tally('sequenceReader under wire valid (messages, views, errors)');
  for (const tail of ['', 'bf61610178016102ff', '9f0102']) {
    const S = catBytes([...good, unhex(tail)]);
    for (const ch of [{ kind: 0 }, { kind: 1, w: 1 }, { kind: 2, w: 3, seed: 7 }]) for (const sch of [false, true]) {
      const ends = chunkEnds(S.length, ch), chunks = chunksBy(S, ends);
      const run = api => {
        const out = [];
        try {
          const opts = { wire: 'valid', top: 'any' };
          if (sch) { opts.schema = api === WSEQ ? anyW : anyN; opts.rule = 'r'; }
          const rd = api.sequenceReader(opts);
          for (const c of chunks) { const r = rd.feed(c); for (const m of r.messages) out.push(msgOf(m), viewAll(m.view)); if (r.error) { out.push(faultOf(r.error)); return out; } }
          const e = rd.end(); for (const m of e.messages) out.push(msgOf(m), viewAll(m.view)); out.push(e.error ? faultOf(e.error) : null);
        } catch (e) { out.push(faultOf(e)); }
        return out;
      };
      t.same(`valid ${tail || 'good'} ${show(ch)} ${sch ? 'schema' : 'profile'}`, run(WSEQ), run(NSEQ));
    }
  }
  t.done();
});

test('sequences: API behaviours and privacy (read-only messages, private View/Cursor state, no trusted opener)', async () => {
  const t = tally('sequence API behaviours');
  const text = 'r = uint .count 0';
  let wc = 0, nc = 0;
  const w = await wcompile(text, { controls: { count: { maxBytes: 1, check: () => { wc++; return true; } } } });
  const n = await ncompile(text, { controls: { count: { maxBytes: 1, check: () => { nc++; return true; } } } });
  // one message ahead of the consumer
  const first = async (api, s) => { const it = api.readSequence([new Uint8Array(10000)], { schema: s, rule: 'r' }); const m = (await it.next()).value; await it.return(); return m.index; };
  t.same('readSequence first message', await first(WSEQ, w), await first(NSEQ, n));
  t.same('messages checked before the first was consumed', wc, nc);
  // an exception from a predicate ends the sequence after the messages before it
  const thrower = { check: { maxBytes: 1, check: (_a, item) => { if (item[0] === 2) throw new Error('predicate failed'); return true; } } };
  const wt = await wcompile('r = uint .check 0', { controls: thrower }), nt = await ncompile('r = uint .check 0', { controls: thrower });
  for (const chunks of [[Uint8Array.of(1, 2)], [Uint8Array.of(1), Uint8Array.of(2)]]) {
    const run = async (api, s) => { const seen = []; try { for await (const m of api.readSequence(chunks, { schema: s, rule: 'r' })) seen.push(m.view.number()); return seen; } catch (e) { return [seen, e.message]; } };
    t.same(`predicate throws ${chunks.length}`, await run(WSEQ, wt), await run(NSEQ, nt));
  }
  const pushThrow = (api, s) => { const r = api.sequenceReader({ schema: s, rule: 'r' }); const res = r.feed(Uint8Array.of(1, 2)); return [res.messages.length, res.error?.message, r.done]; };
  t.same('sequenceReader predicate throws', pushThrow(WSEQ, wt), pushThrow(NSEQ, nt));
  // copy 'always' copies Node Buffer chunks too; a View is minted from the checked bytes
  for (const make of [b => Buffer.from(b), b => Uint8Array.from(b)]) {
    const run = api => { const chunk = make([1, 2]); const { messages } = api.sequenceReader({ copy: 'always' }).feed(chunk); chunk[0] = 9; chunk[1] = 9; return messages.map(m => [m.borrowed, m.view.number()]); };
    t.same('copy always', run(WSEQ), run(NSEQ));
  }
  // messages released by their own last byte
  const ok = { maxBytes: 64, check: () => true };
  for (const [txt, msgs] of [['r = uint .ok 0', [Uint8Array.of(1)]], ['r = { text: tstr .ok 0 }', [N.encode({ text: 'a' })]], [null, [Uint8Array.of(0xd8, 0x28, 0x82, 0x81, 0x01, 0x81, 0x01)]], [null, [Uint8Array.of(0xa1, 0x81, 0x01, 0x02)]]]) {
    const ws = txt && await wcompile(txt, { controls: { ok } }), ns = txt && await ncompile(txt, { controls: { ok } });
    const bytes = catBytes([...msgs, ...msgs]);
    const run = (api, s) => { const r = api.sequenceReader(s ? { schema: s, rule: 'r' } : {}); const got = []; for (let i = 0; i < bytes.length; i++) got.push(r.feed(bytes.subarray(i, i + 1)).messages.length); return got; };
    t.same(`released by its last byte ${hex(bytes)}`, run(WSEQ, ws), run(NSEQ, ns));
  }
  // option validation (D213) and cross-package schemas
  for (const o of [{ maxBytes: 10 }, { onInvalid: 'x' }, { copy: 'x' }, { failFast: 1 }, { rule: 'r' }, { schema: n }, { schema: w }, { schema: {}, rule: 'r' }, { nope: 1 }, { maxMessageBytes: -1 }])
    for (const f of ['sequenceReader', 'readSequence']) {
      const fix = s => (o.schema === w || o.schema === n ? { ...o, schema: s } : o);
      t.same(`${f} ${show(o)}`, outcome(() => (WSEQ[f](...(f === 'readSequence' ? [[], fix(w)] : [fix(w)])), 'ok')), outcome(() => (NSEQ[f](...(f === 'readSequence' ? [[], fix(n)] : [fix(n)])), 'ok')));
    }
  t.same('a native Schema given to the SDK', outcome(() => WSEQ.sequenceReader({ schema: n, rule: 'r' })), outcome(() => NSEQ.sequenceReader({ schema: w, rule: 'r' })));
  t.done();
  // privacy (D215, review 2026-11-04 #3): no public state, no construction outside the view module
  const m = WSEQ.sequenceReader({}).feed(N.encode('ok')).messages[0];
  assert.throws(() => { m.bytes = Uint8Array.of(0x62, 0xc0, 0xae); }, TypeError);
  assert.throws(() => { m.index = 7; }, TypeError);
  assert.equal(m.view.text(), 'ok');
  assert.deepEqual(Object.keys(m), []);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), { index: 0, offset: 0, length: 3, borrowed: true });
  const v = wview(N.encode({ a: [1, 2, 3] })), cur = v.cursor();
  assert.ok(v instanceof WView && cur instanceof WCursor);
  assert.deepEqual(Object.keys(v), []);
  assert.deepEqual(Object.keys(cur), []);
  assert.deepEqual(Object.getOwnPropertyNames(v), []);
  assert.throws(() => new WView({ ptr: 0, end: 3, allocs: [], head() {} }, 0, 0), TypeError);
  assert.throws(() => new WView(Object.create(Object.getPrototypeOf(v)), 0, 0), TypeError);
  assert.throws(() => new WCursor({ _m: {}, _p: 0, _d: 0 }), TypeError);
  assert.throws(() => Reflect.construct(WView, [undefined, 0, 0]), TypeError);
  assert.equal(v.get('a').at(2).number(), 3);
  // the package entries: ./view is view/View/Cursor only; ./sequence the reader pair; the internals are not exported
  const pv = await import('snug-wasm-sdk/view'), ps = await import('snug-wasm-sdk/sequence');
  assert.deepEqual(Object.keys(pv).sort(), ['Cursor', 'View', 'view']);
  assert.deepEqual(Object.keys(ps).sort(), ['readSequence', 'releasePool', 'sequenceReader', 'sessionLimits']);
  await assert.rejects(import('snug-wasm-sdk/src/view-core.mjs'), e => e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
  console.log('  ok   sequence messages read-only; View/Cursor state private; mintView not exported');
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

test('.abnf / .abnfb (D334): the hand vectors, budgets and sessions == native; kin JS through the import', async () => {
  const t = tally('abnf');
  const vectors = json('corpus/conformance/abnf.json');
  const hexOf = s => Buffer.from(new TextEncoder().encode(s)).toString('hex');
  t.same('without the module', await outcomeAsync(() => wcompile('r = text .abnf "x"')), await outcomeAsync(() => ncompile('r = text .abnf "x"')));
  for (const g of vectors.grammars) {
    const text = `r = (text / bytes) .abnf h'${hexOf(g.abnf)}'\nb = (text / bytes) .abnfb h'${hexOf(g.abnf)}'`;
    // D340: "parse": "lenient" vectors are refused by the strict default and run with abnf: 'lenient'
    const mode = g.parse === 'lenient' ? { abnf: 'lenient' } : {};
    if (g.parse === 'lenient')
      t.same(`${g.name}: strict refusal`, await outcomeAsync(() => wcompile(text, { controls: { ...wabnf } })),
        await outcomeAsync(() => ncompile(text, { controls: { ...nabnf } })));
    const wo = await outcomeAsync(() => wcompile(text, { controls: { ...wabnf }, ...mode }));
    const no = await outcomeAsync(() => ncompile(text, { controls: { ...nabnf }, ...mode }));
    if (g.error) { t.same(`${g.name}: refused`, wo, no); continue; }
    const w = wo.ok, n = no.ok;
    t.same(`${g.name}: Program`, programBytes(w), programBytes(n));
    for (const c of g.cases) {
      const content = c.input !== undefined ? new TextEncoder().encode(c.input) : hexb(c.inputHex);
      const doc = N.encode(c.major === 'text' ? new TextDecoder().decode(content) : content), rule = c.mode === 'abnfb' ? 'b' : 'r';
      t.same(`${g.name} ${show(c)}`, outcome(() => w.validate(doc, rule)), outcome(() => n.validate(doc, rule)));
      for (const budget of [0, 20, 40, 80, 160])
        t.same(`${g.name} ${show(c)} budget ${budget}`, outcome(() => w.validate(doc, rule, { budget })), outcome(() => n.validate(doc, rule, { budget })));
      t.same(`${g.name} ${show(c)} 1-byte push`, push(() => WSRC.pushValidator(w, doc.length, rule), doc, 1), push(() => NSRC.pushValidator(n, doc.length, rule), doc, 1));
    }
    const ser = n.program.serialize();
    t.same(`${g.name}: fromSerialized without the module`, await outcomeAsync(() => WS.fromSerialized(ser)), await outcomeAsync(() => NS.fromSerialized(ser)));
  }
  const w = await wcompile('r = text .abnf "%x78"', { controls: { ...wabnf } });
  assert.deepEqual(Array.from(WS.innerOf(w.program).kinds), [0], '.abnf runs through the import (kin JS)');
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
  const pendingSeq = WSEQ.sequenceReader({ schema: w, rule: 'r' });
  pendingSeq.feed(N.encode([1]).subarray(0, 1));   // a message in progress
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
  const lostSeq = pendingSeq.feed(N.encode([1]).subarray(1));
  assert.ok(lostSeq.error instanceof Error && pendingSeq.done, 'a sequence reader from the lost instance ends with an error');
  assert.deepEqual(WSEQ.sequenceReader({ schema: w, rule: 'r' }).feed(catBytes([N.encode([1]), N.encode(['ab'])])).messages.map(m => m.view.value()), [[1], ['ab']]);
  const p = WSRC.pushValidator(w, 4, 'r'); p.feed(N.encode(['ab']));
  assert.deepEqual(p.finalize(), { ok: true });
  assert.ok(g > 0);
  console.log('  ok   instance loss recovered (decode, validate with a generic control, sessions, sequences)');
});

test('sequences: regression 2026-11-11 -- a complete 65,541-byte message followed by more than maxMessageBytes', () => {
  const big = new Uint8Array(1500001); big.set([0xa1, 0x61, 0x61, 0x59, 0xff, 0xff]); big[1500000] = 0xa0;
  const run = (api, wire, cuts) => {
    const r = api.sequenceReader({ wire, top: 'map', maxMessageBytes: 1500000 }), got = [];
    let from = 0;
    for (const to of cuts) {
      const res = r.feed(big.subarray(from, to)); from = to;
      got.push(...res.messages.map(m => `m${m.index}+${m.length}`));
      if (res.error) { got.push(`x${res.error.index} ${res.error.code} @${res.error.offset}`); break; }
    }
    return got;
  };
  for (const wire of ['bindle', 'deterministic', 'valid'])
    for (const cuts of [[big.length], [65536, big.length], [6, 65541, big.length]]) {
      assert.deepEqual(run(WSEQ, wire, cuts), ['m0+65541', 'x1 not_map @65541'], `wasm ${wire} ${cuts}`);
      assert.deepEqual(run(NSEQ, wire, cuts), ['m0+65541', 'x1 not_map @65541'], `native ${wire} ${cuts}`);
    }
});

test('sessions (P9.7, D327): the live bound and release, as the native package', async () => {
  const w = await wcompile('r = { id: uint }'), n = await ncompile('r = { id: uint }');
  const bytes = N.encode({ id: 3 });
  for (const [lib, schema, seq] of [[WSRC, w, WSEQ], [NSRC, n, NSEQ]]) {
    const base = lib.sessionLimits();
    assert.equal(base.maxLive, 1024);
    assert.equal(base.maxPooledBytes, 2 << 20);
    assert.throws(() => lib.sessionLimits({ maxLive: 0 }), TypeError);
    lib.sessionLimits({ maxLive: base.live + 2 });
    try {
      const a = lib.openSession(schema, 'r', bytes.length), b = lib.openSession(schema, 'r', bytes.length);
      assert.equal(lib.sessionLimits().live, base.live + 2);
      assert.throws(() => lib.openSession(schema, 'r', bytes.length), e => e.code === 'sessions/limit' && /close\(\)/.test(e.message));
      assert.throws(() => seq.sequenceReader({}), e => e.code === 'sessions/limit');
      a.close();
      assert.throws(() => a.step(bytes, 0), TypeError);
      assert.equal(b.step(bytes, 0).result.ok, true);
      assert.equal(lib.sessionLimits().live, base.live);
      for (let i = 0; i < 5000; i++) assert.equal(lib.validateHandleSync(schema, lib.bufferHandle(bytes), 'r', {}, { chunk: 1 }).ok, true);
      const r = seq.sequenceReader({}); r.feed(bytes); r.close();
      assert.equal(lib.sessionLimits().live, base.live);
      // releasePool drops the idle arrays; later sessions answer the same
      assert.ok(lib.sessionLimits().pooledBytes > 0);
      lib.releasePool();
      assert.equal(lib.sessionLimits().pooledBytes, 0);
      assert.equal(lib.validateHandleSync(schema, lib.bufferHandle(bytes), 'r', {}, { chunk: 2 }).ok, true);
      assert.equal(seq.releasePool, lib.releasePool);
    } finally { lib.sessionLimits({ maxLive: base.maxLive }); }
  }
  console.log('  ok   sessions: the live bound, close(), release at the verdict, pooled reuse (wasm and native)');
});
