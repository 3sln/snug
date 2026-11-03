// One V8 isolate per library family (js-codec.mjs). Measured: in a shared isolate, node-cbor's encodeCanonical left
// ~170 MB retained per call on the 10k-map workload and slowed every other library's later samples (cbor2 encode
// 0.26 s -> 3.8 s, snug encode 13 -> 30 ms), so libraries never share an isolate. Timing is this thread's CPU time
// (process.threadCpuUsage) with single-threaded GC and a forced collection before each sample.
import { parentPort, workerData } from 'node:worker_threads';
import { DECODERS, ENCODERS, norm, toMaps, snug, cborx } from './lib.mjs';
import { Writer } from '../../host/js/src/writer.mjs';
import { workloads } from './workloads.mjs';

const group = workerData.group;
if ((group === 'cbor-x-js') === cborx.isNativeAccelerationEnabled) throw new Error(`${group}: cbor-x native acceleration ${cborx.isNativeAccelerationEnabled}`);
const cpu = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };

// RFC 8746 little-endian tag numbers, so a library that leaves typed-array tags uninterpreted compares equal.
const TAG = { Uint16Array: 69, Uint32Array: 70, BigUint64Array: 71, Int8Array: 72, Int16Array: 77, Int32Array: 78, BigInt64Array: 79, Float32Array: 85, Float64Array: 86 };
const key = v => norm(v).replace(/t:(\w+):([0-9a-f]*)/g, (_, c, x) => `tag(${TAG[c]},b:${x})`);

// Typed Writer builders (snug's Writer: typed calls, keys supplied in encoded order with keysSorted).
const writers = {
  rpc287: (v, o) => { const w = new Writer({ ...o, keysSorted: true }); w.beginMap(9).key('args').beginMap(2).key('key').text(v.args.key).key('data').bytes(v.args.data).end()
    .key('epoch').null().key('scope').beginMap(0).end().key('method').text(v.method).key('version').text(v.version).key('contract').text(v.contract).key('resource').text(v.resource)
    .key('resourceGeneration').null().key('connectionGeneration').null().end(); return w.finish(); },
  ints: (v, o) => { const w = new Writer(o); w.beginArray(v.length); for (let i = 0; i < v.length; i++) w.uint(v[i]); w.end(); return w.finish(); },
  maps: (v, o) => { const w = new Writer({ ...o, keysSorted: true }); w.beginArray(v.length);
    for (const m of v) w.beginMap(8).key('a').uint(m.a).key('b').uint(m.b).key('c').text(m.c).key('d').uint(m.d).key('e').uint(m.e).key('f').text(m.f).key('g').null().key('h').bool(m.h).end();
    w.end(); return w.finish(); },
  cwt: (v, o) => { const w = new Writer({ ...o, keysSorted: true }); w.beginMap(v.size); for (const k of [1, 2, 3, 4, 5, 6, 7, -1, -2, -65537, -65538]) { w.key(k); const x = v.get(k); typeof x === 'string' ? w.text(x) : typeof x === 'number' ? w.int(x) : w.bytes(x); } w.end(); return w.finish(); },
  seq: (vs, o) => vs.map(m => { const w = new Writer({ ...o, keysSorted: true }); w.beginMap(6).key('id').uint(m.id).key('ok').bool(m.ok).key('op').text(m.op).key('ts').uint(m.ts).key('key').text(m.key).key('value').uint(m.value).end(); return w.finish(); }),
};

const all = workloads();
let ops = new Map(), sink;

function load(wid) {
  const w = all.find(x => x.id === wid);
  ops = new Map();
  const report = [];
  const each = w.seq ? f => w.bytes.map(f) : f => f(w.bytes);
  const ctx = { opts: w.opts, maps: !!w.cose };
  const expected = key(w.seq ? w.bytes.map(b => snug.decode(b, w.opts)) : snug.decode(w.bytes, w.opts));
  for (const d of DECODERS.filter(d => d.group === group)) {
    const name = 'decode:' + d.id, run = () => each(b => d.fn(b, ctx));
    let first;
    try { first = run(); } catch (e) { report.push({ name, status: 'refused', note: e.message.slice(0, 140) }); continue; }
    if (d.validateOnly) { ops.set(name, { run, check: () => {} }); report.push({ name, status: 'ok' }); continue; }
    if (key(first) !== expected) { report.push({ name, status: 'mismatch', note: 'decoded value differs from snug\'s' }); continue; }
    ops.set(name, { run, check: r => { if (key(r) !== expected) throw new Error(`${name}: answer changed`); } });
    report.push({ name, status: 'ok' });
  }
  const encs = ENCODERS.filter(e => e.group === group);
  if (group === 'snug' && writers[w.id]) encs.push({ id: 'snug-writer', fn: (v, o) => writers[w.id](v, o.opts), whole: true });
  for (const e of encs) {
    const name = 'encode:' + e.id, v = e.mapsOnly ? toMaps(w.value) : w.value;
    const run = w.seq && !e.whole ? () => v.map(x => e.fn(x, ctx)) : () => e.fn(v, ctx);
    let out;
    try { out = run(); } catch (err) { report.push({ name, status: 'failed', note: err.message.slice(0, 140) }); continue; }
    const outs = (w.seq ? out : [out]).map(b => Uint8Array.from(b)); // plain copies for the main thread's checks
    const total = outs.reduce((n, b) => n + b.length, 0);
    ops.set(name, { run, check: r => { const rs = w.seq ? r : [r]; if (rs.reduce((n, b) => n + b.length, 0) !== total) throw new Error(`${name}: output changed`); } });
    report.push({ name, status: 'ok', outs });
  }
  return report;
}

function calibrate(name, targetMs) {
  const op = ops.get(name);
  for (let i = 0; i < 3; i++) sink = op.run();
  let n = 1;
  for (;;) { const t = cpu(); for (let i = 0; i < n; i++) sink = op.run(); const d = cpu() - t;
    if (d >= targetMs || n >= 1 << 20) return n; n = d < 1 ? n * 8 : Math.max(n + 1, Math.ceil(n * targetMs * 1.1 / d)); }
}

function sample(name, n) {
  const op = ops.get(name);
  globalThis.gc?.();
  const t = cpu();
  for (let i = 0; i < n; i++) sink = op.run();
  const ms = (cpu() - t) / n;
  op.check(sink);
  return ms;
}

parentPort.on('message', m => {
  try {
    if (m.cmd === 'load') parentPort.postMessage({ ok: true, report: load(m.wid) });
    else if (m.cmd === 'calibrate') parentPort.postMessage({ ok: true, n: calibrate(m.name, m.targetMs) });
    else if (m.cmd === 'sample') parentPort.postMessage({ ok: true, ms: sample(m.name, m.n) });
    else if (m.cmd === 'mem') { globalThis.gc?.(); parentPort.postMessage({ ok: true, heap: process.memoryUsage().heapUsed }); }
  } catch (e) { parentPort.postMessage({ ok: false, error: e.stack }); }
});
