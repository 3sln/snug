// P9.7 (D326): session pooling, measured. One arm per process:
//
//     node --single-threaded-gc --expose-gc bench/sessions-bench.mjs <tree> <pooled|fresh> [n]
//
// n sessions (default 100,000) each validate one small message through openSession (whole window), then a
// smaller run of large-message sessions (a 64 KiB text) through validateHandleSync with 4 KiB chunks. `fresh`
// sets maxPooledBytes 0 (every session allocates its arrays, as before P9.7). Reports thread CPU µs per session,
// and peak/end RSS and heap. A tree before P9.7 has no sessionLimits: both arms then measure fresh arrays.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [treeArg, arm = 'pooled', nArg = '100000'] = process.argv.slice(2);
const root = path.resolve(treeArg ?? ''), n = Number(nArg);
const load = rel => import(pathToFileURL(path.join(root, rel)).href);
const { compile } = await load('host/js/src/public-compile.mjs');
const { encode } = await load('host/js/src/index.mjs');
const src = await load('host/js/src/public-sources.mjs');
if (arm === 'fresh' && src.sessionLimits) src.sessionLimits({ maxPooledBytes: 0 });
// pool=<MiB>: the idle pool at that size
if (arm.startsWith('pool=') && src.sessionLimits) src.sessionLimits({ maxPooledBytes: Number(arm.slice(5)) * 2 ** 20 });
const cpu = () => { const u = process.threadCpuUsage(); return u.user + u.system; };
const schema = await compile('r = { id: uint, kind: tstr, body: tstr, ? meta: { * tstr => any } }');
const small = encode({ id: 7, kind: 'note', body: 'hello', meta: { a: 1, b: [1, 2, 3] } });
const large = encode({ id: 8, kind: 'blob', body: 'x'.repeat(65536) });
let peakRss = 0, peakHeap = 0;
const sample = () => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); };
const run = (count, f) => {
  for (let i = 0; i < Math.min(2000, count); i++) f();          // warm-up
  globalThis.gc?.();
  const t = cpu();
  for (let i = 0; i < count; i++) { f(); if ((i & 1023) === 0) sample(); }
  return (cpu() - t) / count;
};
const smallUs = run(n, () => { const s = src.openSession(schema, 'r', small.length); s.step(small, 0); });
const largeUs = run(Math.max(1, n / 50), () => src.validateHandleSync(schema, src.bufferHandle(large), 'r', {}, { chunk: 4096 }));
globalThis.gc?.();
const end = process.memoryUsage();
console.log(JSON.stringify({ tree: path.basename(root), arm, n, smallUs: +smallUs.toFixed(2), largeUs: +largeUs.toFixed(1),
  peakRssMiB: +(peakRss / 2 ** 20).toFixed(1), peakHeapMiB: +(peakHeap / 2 ** 20).toFixed(1),
  endRssMiB: +(end.rss / 2 ** 20).toFixed(1), endHeapMiB: +(end.heapUsed / 2 ** 20).toFixed(1),
  live: src.sessionLimits ? src.sessionLimits().live : null }));
