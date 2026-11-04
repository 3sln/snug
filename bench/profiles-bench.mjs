// P7.1: the cost of the profile options. Runs bench/codec.mjs's workloads through this tree's codec under one preset
// and through a BASE tree's codec (a checkout from before P7.1, given as an argument), interleaved in one process,
// measured as THREAD CPU time (process.threadCpuUsage), median of trials.
//
//     node --single-threaded-gc bench/profiles-bench.mjs <base-tree> <bindle|deterministic> [trials]
//
// One preset per process: V8 inlines differently when one process runs both presets' paths (measured: the Bindle
// float path 1.16-2x slower beside the deterministic one, 0.94-1.01x alone), and a library process uses one preset.
// The base tree is any snug checkout (e.g. `git worktree add --detach /tmp/snug-base <rev>`); only its host/js and
// gen/js are imported. Decode = the scan plus the trusted build; scan alone; encode. Every answer is checked equal
// across the three before timing.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [baseArg, preset, trialsArg = '15'] = process.argv.slice(2);
if (!baseArg || (preset !== 'bindle' && preset !== 'deterministic')) {
  console.error('usage: node --single-threaded-gc bench/profiles-bench.mjs <base-tree> <bindle|deterministic> [trials]'); process.exit(2);
}
const trials = Number(trialsArg), targetUs = 20000;
const here = new URL('../', import.meta.url);
const load = (root, rel) => import(pathToFileURL(path.join(root, rel)).href);
const cur = await load(here.pathname, 'host/js/src/index.mjs');
const curScan = await load(here.pathname, 'host/js/src/scan.mjs');
const base = await load(path.resolve(baseArg), 'host/js/src/index.mjs');
const baseScan = await load(path.resolve(baseArg), 'host/js/src/scan.mjs');
const cpu = () => { const u = process.threadCpuUsage(); return u.user + u.system; };
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
let sink;

console.log(JSON.stringify({ cpu: os.cpus()[0]?.model, arch: os.arch(), node: process.version, v8: process.versions.v8,
  base: path.resolve(baseArg), preset, trials, timing: 'process.threadCpuUsage, µs per call, median of trials; arms interleaved, rotated each round',
  loadavg: os.loadavg().map(x => x.toFixed(1)) }));

const rpc = data => ({ version: '0', resource: 'https://resource.example/r/1', contract: 'https://contracts.example/object-storage/v1',
  method: 'put', args: { key: 'app/directory.json', data }, scope: {}, epoch: null, resourceGeneration: null, connectionGeneration: null });
const many = Array.from({ length: 10000 }, (_, i) => ({ h: true, f: 'short', d: i, b: 2, g: null, e: i % 10, c: 'text', a: 1 }));
const document = { records: Array.from({ length: 10000 }, (_, i) => ({ id: i, kind: 'note', title: 'A small benchmark document',
  meta: { owner: 'person', size: 128, active: true }, body: 'x'.repeat(35) })) };
const big = { maxEntries: 120000, maxItems: 500000, maxBytes: 1500000, top: 'any' };
const workloads = [
  ['RPC put (small)', rpc(new Uint8Array(100).fill(97)), { top: 'any' }],
  ['RPC put + 1 MiB bytes', rpc(new Uint8Array(2 ** 20).fill(97)), { top: 'any' }],
  ['120000 integers', Array.from({ length: 120000 }, (_, i) => i), big],
  ['1 MiB Float64Array', Float64Array.from({ length: 2 ** 17 }, (_, i) => i + 0.5), { top: 'any' }],
  ['10000 maps x 8 short keys', many, big],
  ['map-heavy document', document, big],
  ['5000 floats (scalar)', Array.from({ length: 5000 }, (_, i) => i + 0.25), big],
  ['text-heavy (5000 strings)', Array.from({ length: 5000 }, (_, i) => `the quick brown fox ${i} ü 水`), big],
];
// The Bindle arm keeps strictArrays off, as the base arm's default encode does: the preset's strict own-key check is
// D113's separate, measured cost (bench/WRITER.md), not the profile's.
const P = preset === 'bindle' ? { wire: 'bindle', strictArrays: false } : { wire: 'deterministic' };
console.log(`| Workload | Bytes | op | base µs | ${preset} µs | ${preset} / base |`);
console.log('| --- | ---: | --- | ---: | ---: | ---: |');
for (const [name, value, o] of workloads) {
  const bytes = base.encode(value, o);
  const op = { ...o, ...P };   // built once, outside the timed calls, as o is for the base arm
  const arms = {
    decode: [() => base.decode(bytes, o), () => cur.decode(bytes, op)],
    scan: [() => baseScan.scan(bytes, o), () => curScan.scan(bytes, op)],
    encode: [() => base.encode(value, o), () => cur.encode(value, op)],
  };
  // answers equal across the arms (bytes for encode; values for decode)
  for (const [what, fs] of Object.entries(arms)) {
    const r = fs.map(f => f());
    if (what === 'encode' || what === 'decode') assert.deepStrictEqual(r[1], r[0]);
  }
  for (const [what, fs] of Object.entries(arms)) {
    for (let w = 0; w < 3; w++) for (const f of fs) sink = f();
    const n = fs.map(f => { const t = cpu(); sink = f(); return Math.max(1, Math.min(5000, Math.ceil(targetUs / Math.max(1, cpu() - t)))); });
    const samples = fs.map(() => []);
    for (let round = 0; round < trials; round++) for (let k = 0; k < fs.length; k++) {
      const a = (round + k) % fs.length, f = fs[a], m = n[a];
      const t = cpu();
      for (let i = 0; i < m; i++) sink = f();
      samples[a].push((cpu() - t) / m);
    }
    const [mb, mp] = samples.map(median);
    console.log(`| ${name} | ${bytes.length} | ${what} | ${mb.toFixed(1)} | ${mp.toFixed(1)} | ${(mp / mb).toFixed(3)} |`);
  }
}
console.log(`Answers checked equal across the base and ${preset} arms before timing.`);
