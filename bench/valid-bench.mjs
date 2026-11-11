// P8.4 (D269): what the valid-CBOR machinery costs, and whether a deterministic-only fast path is material.
// One tree and one preset per process (V8 inlines differently when a process runs two trees' or two presets' paths;
// bench/README.md#profile-options-p71), measured as THREAD CPU time (process.threadCpuUsage), µs per call, median of
// trials. Prints one JSON line per workload/op.
//
//     node --single-threaded-gc bench/valid-bench.mjs <tree> <deterministic|valid> [trials] [nondet]
//
// <tree> is any snug checkout (its host/js and gen/js are imported). With `nondet` the workloads are re-encoded in a
// valid but non-deterministic form (indefinite-length arrays/maps, keys reversed, non-shortest integer heads) and run
// under `valid` only; the deterministic workloads are measured otherwise. validate = a compiled schema's validate (compiled with the workload's limits;
// per-call limits only lower them).
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [treeArg, preset, trialsArg = '15', mode = 'det'] = process.argv.slice(2);
if (!treeArg || (preset !== 'valid' && preset !== 'deterministic')) {
  console.error('usage: node --single-threaded-gc bench/valid-bench.mjs <tree> <deterministic|valid> [trials] [nondet]'); process.exit(2);
}
const root = path.resolve(treeArg), trials = Number(trialsArg), targetUs = 20000;
const load = rel => import(pathToFileURL(path.join(root, rel)).href);
const snug = await load('host/js/src/index.mjs');
const { scan } = await load('host/js/src/scan.mjs');
const { compile } = await load('host/js/src/public-compile.mjs');
const cpu = () => { const u = process.threadCpuUsage(); return u.user + u.system; };
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
let sink;

const rpc = data => ({ version: '0', resource: 'https://resource.example/r/1', contract: 'https://contracts.example/object-storage/v1',
  method: 'put', args: { key: 'app/directory.json', data }, scope: {}, epoch: null, resourceGeneration: null, connectionGeneration: null });
const many = Array.from({ length: 10000 }, (_, i) => ({ h: true, f: 'short', d: i, b: 2, g: null, e: i % 10, c: 'text', a: 1 }));
const doc = { records: Array.from({ length: 10000 }, (_, i) => ({ id: i, kind: 'note', title: 'A small benchmark document',
  meta: { owner: 'person', size: 128, active: true }, body: 'x'.repeat(35) })) };
const big = { maxEntries: 120000, maxItems: 500000, maxBytes: 1500000, top: 'any' };
const workloads = [
  ['RPC put (small)', rpc(new Uint8Array(100).fill(97)), { top: 'any' }, 'r = { * tstr => any }'],
  ['120000 integers', Array.from({ length: 120000 }, (_, i) => i), big, 'r = [* uint]'],
  ['10000 maps x 8 short keys', many, big, 'r = [* { * tstr => any }]'],
  ['map-heavy document', doc, big,
    'r = { records: [* rec] }\nrec = { id: uint, kind: tstr, title: tstr, meta: { owner: tstr, size: uint, active: bool }, body: tstr }'],
  ['5000 floats (scalar)', Array.from({ length: 5000 }, (_, i) => i + 0.25), big, 'r = [* float]'],
  ['text-heavy (5000 strings)', Array.from({ length: 5000 }, (_, i) => `the quick brown fox ${i} ü 水`), big, 'r = [* tstr]'],
];

// A valid, non-deterministic encoding of a JS value: indefinite containers, keys in reverse order, integers 0..23 with
// a one-byte argument (the deterministic encoder's bytes for everything else).
const nondet = (v, o) => {
  const out = [];
  const det = x => out.push(...snug.encode(x, o));
  const walk = x => {
    if (Array.isArray(x)) { out.push(0x9f); x.forEach(walk); out.push(0xff); return; }
    if (x && typeof x === 'object' && !(x instanceof Uint8Array) && !ArrayBuffer.isView(x)) {
      out.push(0xbf); for (const k of Object.keys(x).reverse()) { det(k); walk(x[k]); } out.push(0xff); return;
    }
    if (Number.isInteger(x) && x >= 0 && x < 24) { out.push(0x18, x); return; }
    det(x);
  };
  walk(v);
  return Uint8Array.from(out);
};

console.log(JSON.stringify({ tree: root, preset, mode, trials, cpu: os.cpus()[0]?.model, node: process.version,
  v8: process.versions.v8, loadavg: os.loadavg().map(x => x.toFixed(1)) }));
for (const [name, value, o, cddl] of workloads) {
  const op = { ...o, wire: preset };
  const bytes = mode === 'nondet' ? nondet(value, o) : snug.encode(value, o);
  const limits = o.maxEntries ? { inputBytes: o.maxBytes, entries: o.maxEntries, items: o.maxItems } : undefined;
  const schema = await compile(cddl, limits ? { limits } : {});
  const vo = { ...op };
  const ok = schema.validate(bytes, 'r', vo);
  if (!ok.ok) throw new Error(`${name}: validate refused (${JSON.stringify(ok.error ?? ok)})`);
  const arms = {
    scan: () => scan(bytes, op),
    decode: () => snug.decode(bytes, op),
    validate: () => schema.validate(bytes, 'r', vo),
    ...(mode === 'nondet' ? {} : { encode: () => snug.encode(value, op) }),
  };
  for (const [what, f] of Object.entries(arms)) {
    for (let w = 0; w < 3; w++) sink = f();
    const t0 = cpu(); sink = f();
    const m = Math.max(1, Math.min(5000, Math.ceil(targetUs / Math.max(1, cpu() - t0))));
    const samples = [];
    for (let r = 0; r < trials; r++) { const t = cpu(); for (let i = 0; i < m; i++) sink = f(); samples.push((cpu() - t) / m); }
    console.log(JSON.stringify({ name, bytes: bytes.length, op: what, us: +median(samples).toFixed(2) }));
  }
}
