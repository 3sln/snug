// P7.8 part 1: snug's strict codec vs the common JS CBOR libraries.
//
//     node bench/compare/js-codec.mjs [--quick] [--only=id,id] [--json=results/codec.json]
//
// Each library family runs in its own worker (V8 isolate; see codec-worker.mjs for why). Decode: every decoder gets
// snug's deterministic encoding of the workload (bytes every decoder under test should accept; a decoder that
// refuses them is reported, not timed). Answers are checked equal to snug's decoded value modulo representation
// (lib.mjs norm: Map ~ object, Buffer ~ Uint8Array, typed arrays ~ their RFC 8746 tag) before timing and after every
// timed sample. Encode: each encoder gets the workload value in its own value model (Maps for tiny-cbor); its bytes
// are compared with snug's (byte-equal?), decoded by cbor2 (permissive) to compare values, and fed to snug's strict
// decoder (accepted?).
//
// Method: thread CPU time (process.threadCpuUsage) under --single-threaded-gc with a forced GC before each sample;
// 3 warm-up calls, each op calibrated to >= 25 ms CPU, then 9 rounds over all ops in a rotating order (one op runs
// at a time, so libraries interleave in time); medians per call.
import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { DECODERS, ENCODERS, norm, fmt, environment, ensureGcFlags, median, cbor2, snug } from './lib.mjs';
import { workloads } from './workloads.mjs';

await ensureGcFlags();
const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const ONLY = args.find(a => a.startsWith('--only='))?.slice(7).split(',');
const JSON_OUT = args.find(a => a.startsWith('--json='))?.slice(7);
const ROUNDS = QUICK ? 3 : 9, TARGET = QUICK ? 10 : 25;

const groups = [...new Set([...DECODERS, ...ENCODERS].map(x => x.group))];
const workers = new Map(groups.map(g => [g, new Worker(new URL('./codec-worker.mjs', import.meta.url), { workerData: { group: g },
  // cbor-x uses the cbor-extract native addon for strings in Node when it loads; browsers get its pure-JS path.
  env: g === 'cbor-x-js' ? { ...process.env, CBOR_NATIVE_ACCELERATION_DISABLED: 'true' } : process.env })]));
const call = (g, msg) => new Promise((res, rej) => { const w = workers.get(g); w.once('message', m => m.ok ? res(m) : rej(new Error(`${g}: ${m.error}`))); w.postMessage(msg); });

const sameBytes = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const env = environment({ quick: QUICK, rounds: ROUNDS, targetMs: TARGET, timing: 'thread CPU, one isolate per library family' });
console.log(JSON.stringify(env));
const results = { env, workloads: [] };

for (const w of workloads()) {
  if (ONLY && !ONLY.includes(w.id)) continue;
  const rec = { id: w.id, name: w.name, size: w.size, ops: [] };
  const refs = w.seq ? w.bytes : [w.bytes];
  const refValue = norm(refs.map(b => cbor2.decode(b, { preferMap: !!w.cose })));
  const timed = [];
  for (const g of groups) {
    const { report } = await call(g, { cmd: 'load', wid: w.id });
    for (const r of report) {
      const op = { name: r.name, group: g, status: r.status, note: r.note };
      if (r.outs) {
        op.bytes = r.outs.reduce((n, b) => n + b.length, 0);
        op.equal = r.outs.length === refs.length && r.outs.every((b, i) => sameBytes(b, refs[i]));
        try { op.sameValue = norm(r.outs.map(b => cbor2.decode(b, { preferMap: !!w.cose }))) === refValue; } catch { op.sameValue = false; }
        try { r.outs.forEach(b => snug.decode(b, w.opts)); op.snugAccepts = true; } catch (e) { op.snugAccepts = false; op.snugRefusal = e.code ?? e.message; }
      }
      rec.ops.push(op);
      if (r.status === 'ok') timed.push(op);
    }
  }
  for (const op of timed) op.n = (await call(op.group, { cmd: 'calibrate', name: op.name, targetMs: TARGET })).n;
  for (const op of timed) op.samples = [];
  for (let r = 0; r < ROUNDS; r++) for (let o = 0; o < timed.length; o++) {
    const op = timed[(r + o) % timed.length];
    op.samples.push((await call(op.group, { cmd: 'sample', name: op.name, n: op.n })).ms);
  }
  for (const op of timed) { op.med = median(op.samples); op.min = Math.min(...op.samples); }
  results.workloads.push(rec);
  const line = kind => rec.ops.filter(o => o.name.startsWith(kind)).map(o => `${o.name.slice(kind.length)}=${o.med !== undefined ? fmt(o.med) : o.status}`).join(' ');
  console.log(`\n## ${w.name} (${w.size} B)\ndecode: ${line('decode:')}\nencode: ${line('encode:')}`);
  for (const o of rec.ops) if (o.bytes !== undefined) console.log(`  ${o.name}: ${o.bytes} B, byte-equal to snug: ${o.equal}, same value: ${o.sameValue}, snug accepts: ${o.snugAccepts}${o.snugRefusal ? ` (${o.snugRefusal})` : ''}`);
  for (const o of rec.ops) if (o.note) console.log(`  note ${o.name}: ${o.status}: ${o.note}`);
}
results.env.loadEnd = environment().load;
console.log(`\nload at end: ${results.env.loadEnd}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, (k, v) => k === 'samples' ? v.map(x => +x.toPrecision(5)) : v, 1));
for (const w of workers.values()) await w.terminate();
