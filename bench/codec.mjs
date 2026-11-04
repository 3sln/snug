// Offline, dependency-free Phase 2 benchmark. Run: node bench/codec.mjs [deterministic|bindle]
// The optional argument selects snug's wire preset (P7.1, D120; default: the library default, deterministic);
// the baseline codec is always cbor.mjs. bench/profiles-bench.mjs compares the presets with a pre-P7.1 tree.
import assert from 'node:assert/strict';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { build } from '../host/js/src/build.mjs';
import { decode } from '../host/js/src/index.mjs';
import { scan } from '../host/js/src/scan.mjs';
import { encode } from '../host/js/src/encode.mjs';
import { baseline, profile, oracle, fromHex, translate } from '../host/js/test/values.mjs';

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const wire = process.argv[2];
if (wire !== undefined && wire !== 'deterministic' && wire !== 'bindle') throw new Error('usage: node bench/codec.mjs [deterministic|bindle]');
const W = wire === undefined ? {} : { wire };
const trials = 9, targetMs = 15;
let sink;
const system = (command, args) => {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { return `unavailable (${e.stderr?.toString().trim() || e.code})`; }
};
console.log(JSON.stringify({ cpuSysctl: system('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']),
  cpuFallback: os.cpus()[0]?.model, arch: os.arch(), macOS: system('/usr/bin/sw_vers', ['-productVersion']),
  node: process.version, v8: process.versions.v8, memoryGiB: os.totalmem() / 2 ** 30,
  trials, targetMs, warmup: '3 interleaved rounds, then one calibration per operation', wire: wire ?? 'default (deterministic)' }));

const vectors = profile.accept.map(v => fromHex(v.hex));
for (const v of oracle.cases) if (v.accept) {
  const b = fromHex(v.hex);
  try { baseline.decode(b, { top: 'any' }); vectors.push(b); }
  catch (e) { if (!(e instanceof baseline.CBORFault)) throw e; }
}
const rpc = data => ({ version: '0', resource: 'https://resource.example/r/1',
  contract: 'https://contracts.example/object-storage/v1', method: 'put',
  args: { key: 'app/directory.json', data }, scope: {}, epoch: null,
  resourceGeneration: null, connectionGeneration: null });
let small;
for (let n = 0; n < 287; n++) {
  const value = rpc(new Uint8Array(n).fill(97));
  if (encode(value).length === 287) { small = value; break; }
}
assert.ok(small, '287-byte request fixture');
const many = Array.from({ length: 10000 }, (_, i) => ({ h: true, f: 'short', d: i, b: 2,
  g: null, e: i % 10, c: 'text', a: 1 }));
const document = { records: Array.from({ length: 10000 }, (_, i) => ({ id: i,
  kind: 'note', title: 'A small benchmark document', meta: { owner: 'person', size: 128, active: true },
  body: 'x'.repeat(35) })), padding: '' };
const largeOptions = { maxEntries: 120000, maxItems: 500000, maxBytes: 1500000, top: 'any' };
const documentSize = encode(document, largeOptions).length;
assert.ok(documentSize < 1400000);
// Correct for changes in the padding string's CBOR length head.
document.padding = 'x'.repeat(1400000 - documentSize);
document.padding = document.padding.slice(encode(document, largeOptions).length - 1400000);
assert.equal(encode(document, largeOptions).length, 1400000);

const cases = [
  { name: 'vectors (74 profile + 315 oracle)', bytes: vectors },
  { name: 'RPC put 287 B', value: small },
  { name: 'RPC put + 1 MiB bytes', value: rpc(new Uint8Array(2 ** 20).fill(97)) },
  { name: '120000 integers', value: Array.from({ length: 120000 }, (_, i) => i) },
  { name: '1 MiB Float64Array', value: Float64Array.from({ length: 2 ** 17 }, (_, i) => i + 0.5) },
  { name: '1 MiB BigInt64Array', value: BigInt64Array.from({ length: 2 ** 17 }, (_, i) => BigInt(i) - 65536n) },
  { name: '10000 maps x 8 short keys', value: many },
  { name: 'map-heavy document 1.4 MB', value: document },
];

console.log('| Workload | Bytes | snug decode ms (scan+build) | scan ms | build ms | baseline decode ms | decode speedup | encode ms | baseline encode ms | encode speedup |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const c of cases) {
  // Raise container/item caps only for the intentionally oversized collection
  // workloads. Both codecs receive the exact same options.
  const options = ['120000 integers', '10000 maps x 8 short keys', 'map-heavy document 1.4 MB'].includes(c.name)
    ? largeOptions : { top: 'any' };
  const bytes = c.bytes ?? [baseline.encode(c.value, options)];
  const baselineValues = bytes.map(b => baseline.decode(b, options));
  const values = baselineValues.map(v => translate(v));
  const operations = [
    () => bytes.map(b => build(b, options)),
    () => bytes.map(b => baseline.decode(b, options)),
    () => values.map(v => encode(v, { ...options, ...W })),
    () => baselineValues.map(v => baseline.encode(v, options)),
    () => bytes.map(b => decode(b, { ...options, ...W })),
    () => bytes.map(b => scan(b, { ...options, ...W })),
  ];
  const check = (which, result) => {
    if (which === 5) return;
    if (which === 4) { assert.deepStrictEqual(result, values); return; }
    if (which >= 2) assert.deepStrictEqual(result, bytes);
    else assert.deepStrictEqual(which === 0 ? result : result.map(v => translate(v)), values);
  };
  for (let i = 0; i < operations.length; i++) check(i, operations[i]());
  for (let warm = 0; warm < 3; warm++) for (const op of operations) sink = op();
  const iterations = operations.map(op => {
    const start = performance.now(); sink = op();
    return Math.max(1, Math.min(2000, Math.ceil(targetMs / Math.max(0.01, performance.now() - start))));
  });
  const samples = operations.map(() => []);
  for (let round = 0; round < trials; round++) {
    // Rotate order so neither implementation always gets the warmer heap/CPU.
    for (let offset = 0; offset < operations.length; offset++) {
      const k = (round + offset) % operations.length, op = operations[k], n = iterations[k];
      const start = performance.now();
      for (let i = 0; i < n; i++) sink = op();
      samples[k].push((performance.now() - start) / n);
      check(k, sink); // correctness work is outside the timed region
    }
  }
  const [b, d, e, be, sd, sc] = samples.map(median);
  console.log(`| ${c.name} | ${bytes.reduce((n, b) => n + b.length, 0)} | ${sd.toFixed(4)} | ${sc.toFixed(4)} | ${b.toFixed(4)} | ${d.toFixed(4)} | ${(d / sd).toFixed(2)}x | ${e.toFixed(4)} | ${be.toFixed(4)} | ${(be / e).toFixed(2)}x |`);
  console.log(`<!-- iterations per sample: ${iterations.join(', ')} (build, baseline decode, encode, baseline encode, snug decode, scan) -->`);
}
console.log('Answers checked. snug decode = generated kin scanner (gen/js) + trusted build; both strict.');
