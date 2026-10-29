// Offline microbenchmarks supporting host implementation choices. These isolate
// primitives; codec.mjs measures their effect in the complete host operations.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

let sink;
const median = a => [...a].sort((a, b) => a - b)[4];
function compare(name, operations, check, iterations = 100000) {
  const samples = operations.map(() => []);
  for (const op of operations) { check(op()); for (let i = 0; i < 10000; i++) sink = op(); }
  for (let round = 0; round < 9; round++) {
    for (let offset = 0; offset < operations.length; offset++) {
      const k = (round + offset) % operations.length, start = performance.now();
      for (let i = 0; i < iterations; i++) sink = operations[k]();
      samples[k].push((performance.now() - start) * 1e6 / iterations);
      check(sink);
    }
  }
  console.log(`${name}: ${samples.map(a => median(a).toFixed(1)).join(' / ')} ns/op`);
}
console.log('9 interleaved samples; 10000 warmup calls/variant; 100000 iterations/sample; medians; answers checked.');
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
for (const n of [4, 8, 16, 32, 64, 128]) {
  const bytes = new Uint8Array(n + 2).fill(97);
  compare(`ASCII ${n} (charCode loop / TextDecoder)`, [
    () => { let s = ''; for (let i = 1; i <= n; i++) { const c = bytes[i]; if (c >= 128) return decoder.decode(bytes.subarray(1, n + 1)); s += String.fromCharCode(c); } return s; },
    () => decoder.decode(bytes.subarray(1, n + 1)),
  ], s => assert.equal(s, 'a'.repeat(n)));
}
const bytes = new Uint8Array([0, 0x12, 0x34, 0x56, 0x78]), view = new DataView(bytes.buffer);
compare('uint32 (byte arithmetic / DataView / allocated head tuple)', [
  () => bytes[1] * 16777216 + bytes[2] * 65536 + bytes[3] * 256 + bytes[4],
  () => view.getUint32(1),
  () => [0, 26, view.getUint32(1)],
], value => assert.equal(Array.isArray(value) ? value[2] : value, 0x12345678));
const u64 = new Uint8Array([0, 0, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), uview = new DataView(u64.buffer);
compare('safe uint64 (byte arithmetic / DataView BigInt then number)', [
  () => {
    const hi = u64[1] * 16777216 + u64[2] * 65536 + u64[3] * 256 + u64[4];
    const lo = u64[5] * 16777216 + u64[6] * 65536 + u64[7] * 256 + u64[8];
    return hi * 4294967296 + lo;
  },
  () => Number(uview.getBigUint64(1)),
], value => assert.equal(value, Number.MAX_SAFE_INTEGER));
