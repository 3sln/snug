// P7.13 benchmark: CBOR sequences (bench/SEQUENCE.md). Many small messages
// (100,000 events of ~100 B fed in 16 KiB chunks) and a few large ones (5 x ~1 MB
// fed in 64 KiB chunks), profile-only and against a schema, through
// sequenceReader (sync push) and readSequence (async), each message read through
// its View (one field); against manual framing (the boundaries known in advance)
// + decode() / + view(), and against the whole-buffer sequence decoders of
// cborg (decodeFirst), cbor2 (decodeSequence) and cbor-x (decodeMultiple).
// Correctness is checked outside the timed loops. CPU time from
// process.cpuUsage (user + system), median of the runs.
//
//     node bench/sequence-bench.mjs [runs]
import os from 'node:os';
import { encode, decode } from '../host/js/src/index.mjs';
import { compile } from '../host/js/src/public-compile.mjs';
import { readSequence, sequenceReader } from '../host/js/src/public-sequence.mjs';
import { view } from '../host/js/src/public-view.mjs';
import { decodeFirst } from './compare/node_modules/cborg/cborg.js';
import { decodeSequence } from './compare/node_modules/cbor2/lib/index.js';
import { decodeMultiple } from './compare/node_modules/cbor-x/index.js';

const RUNS = Number(process.argv[2] ?? 7);
const cat = parts => { const t = new Uint8Array(parts.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of parts) { t.set(x, o); o += x.length; } return t; };
const chunk = (b, w) => { const a = []; for (let i = 0; i < b.length; i += w) a.push(b.slice(i, i + w)); return a; };

// ---------------------------------------------------------------- inputs
const small = [];
for (let i = 0; i < 100000; i++) small.push(encode({ type: i % 3 ? 'note' : 'tick', seq: i, ts: 1730000000000 + i, text: 'event body ' + 'x'.repeat(40 + (i % 17)) }));
const large = [];
for (let m = 0; m < 5; m++) {
  const items = [];
  for (let i = 0; i < 9000; i++) items.push({ k: i, v: 'value ' + 'y'.repeat(70 + (i % 23)), ok: (i & 1) === 0 });
  large.push(encode({ type: 'batch', seq: m, items }));
}
const sets = [
  { name: '100,000 x ~100 B, 16 KiB chunks', parts: small, w: 16384, schemaRule: 'event' },
  { name: '5 x ~1 MB, 64 KiB chunks', parts: large, w: 65536, schemaRule: 'batch' },
];
const schema = await compile(`
  event = { type: "note" / "tick", seq: uint, ts: uint, text: tstr }
  batch = { type: "batch", seq: uint, items: [* { k: uint, v: tstr, ok: bool }] }
`);

// ---------------------------------------------------------------- timing
function measure(fn) {
  fn();   // warm
  const cpu = [], wall = [];
  for (let r = 0; r < RUNS; r++) {
    const c0 = process.cpuUsage(), w0 = performance.now();
    const x = fn();
    if (x && typeof x.then === 'function') throw new Error('use measureAsync');
    wall.push(performance.now() - w0);
    const c = process.cpuUsage(c0); cpu.push((c.user + c.system) / 1000);
  }
  const med = a => a.sort((p, q) => p - q)[a.length >> 1];
  return { cpu: med(cpu), wall: med(wall) };
}
async function measureAsync(fn) {
  await fn();
  const cpu = [], wall = [];
  for (let r = 0; r < RUNS; r++) {
    const c0 = process.cpuUsage(), w0 = performance.now();
    await fn();
    wall.push(performance.now() - w0);
    const c = process.cpuUsage(c0); cpu.push((c.user + c.system) / 1000);
  }
  const med = a => a.sort((p, q) => p - q)[a.length >> 1];
  return { cpu: med(cpu), wall: med(wall) };
}

const rows = [];
for (const set of sets) {
  const body = cat(set.parts), chunks = chunk(body, set.w), n = set.parts.length, mb = body.length / 1e6;
  const bounds = []; { let o = 0; for (const p of set.parts) { bounds.push([o, o + p.length]); o += p.length; } }
  const field = set.schemaRule === 'event' ? 'type' : 'type';
  const want = set.parts.map(p => decode(p)[field]);
  const check = (got, label) => { if (got.length !== n || got.some((t, i) => t !== want[i])) throw new Error(`${label}: wrong answers`); };
  const push = opts => () => {
    const r = sequenceReader(opts), got = [];
    for (const c of chunks) { const res = r.feed(c); if (res.error) throw res.error; for (const m of res.messages) got.push(m.view.get(field).text()); }
    const end = r.end(); if (end.error) throw end.error;
    return got;
  };
  const cases = [
    ['sequenceReader, profile', push({})],
    ['sequenceReader, schema', push({ schema, rule: set.schemaRule })],
    ['manual framing + decode()', () => bounds.map(([a, b]) => decode(body.subarray(a, b))[field])],
    ['manual framing + view(borrow)', () => bounds.map(([a, b]) => view(body.subarray(a, b), { borrow: true }).get(field).text())],
    ['manual framing + schema.validate + view(borrow)', () => bounds.map(([a, b]) => { const s = body.subarray(a, b); if (!schema.validate(s, set.schemaRule).ok) throw new Error('refused'); return view(s, { borrow: true }).get(field).text(); })],
    ['cborg decodeFirst loop (whole buffer)', () => { const got = []; let rest = body; while (rest.length) { const [v, r] = decodeFirst(rest); got.push(v[field]); rest = r; } return got; }],
    ['cbor2 decodeSequence (whole buffer)', () => { const got = []; for (const v of decodeSequence(body)) got.push(v[field]); return got; }],
    ['cbor-x decodeMultiple (whole buffer)', () => decodeMultiple(body).map(v => v[field])],
  ];
  for (const [label, fn] of cases) {
    check(fn(), label);
    const t = measure(fn);
    rows.push({ set: set.name, label, ...t, msgs: n / (t.cpu / 1000), mbs: mb / (t.cpu / 1000) });
  }
  // readSequence: the async iterator over the same chunks
  const asyncRun = opts => async () => { const got = []; for await (const m of readSequence(chunks, opts)) got.push(m.view.get(field).text()); return got; };
  for (const [label, fn] of [['readSequence (async), profile', asyncRun({})], ['readSequence (async), schema', asyncRun({ schema, rule: set.schemaRule })]]) {
    check(await fn(), label);
    const t = await measureAsync(fn);
    rows.push({ set: set.name, label, ...t, msgs: n / (t.cpu / 1000), mbs: mb / (t.cpu / 1000) });
  }
}

console.log(`node ${process.version}, ${os.cpus()[0].model}, ${os.cpus().length} cores, ${os.platform()} ${os.release()}, load ${os.loadavg().map(x => x.toFixed(2)).join(' ')}; median of ${RUNS} runs`);
let last = '';
for (const r of rows) {
  if (r.set !== last) { console.log(`\n${r.set}\n| Path | CPU ms | wall ms | messages/s (CPU) | MB/s (CPU) |\n| --- | ---: | ---: | ---: | ---: |`); last = r.set; }
  console.log(`| ${r.label} | ${r.cpu.toFixed(1)} | ${r.wall.toFixed(1)} | ${Math.round(r.msgs).toLocaleString('en-US')} | ${r.mbs.toFixed(1)} |`);
}
