// P1.4 cold start in workerd (local, 3sln.me's pinned binary). workerd freezes
// performance.now() between I/O, so nothing can be timed INSIDE a worker; this
// times from spawning `workerd serve` to the first HTTP response, per worker:
//
//   empty  a worker holding the 287-byte input, answering its length (baseline)
//   js     + the bundled generated JS scanner, scanning it per request
//   wasm   + the wasm module (a CompiledWasm module binding, compiled when the
//            worker loads), instantiated and scanning per request
//
// The difference from `empty` is the scanner's load + first-call cost. Process
// start dominates and the machine is shared, so treat small differences as
// noise. Port 18961 on 127.0.0.1 (never 8851).
//
//     node bench/scan-cold-workerd.mjs <wasm path> [samples]
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encode } from './baseline/cbor-3sln.mjs';

const [wasmPath, samplesArg] = process.argv.slice(2);
const SAMPLES = Number(samplesArg ?? 15), PORT = 18961;
const root = fileURLToPath(new URL('..', import.meta.url));
const workerd = process.env.SNUG_WORKERD ?? `${process.env.HOME}/Projects/@3sln/3sln.me/node_modules/.bin/workerd`;
const esbuild = process.env.SNUG_ESBUILD ?? `${process.env.HOME}/Projects/@3sln/3sln.me/node_modules/.bin/esbuild`;
if (!existsSync(workerd) || !existsSync(esbuild) || !wasmPath) { console.log('SKIP workerd cold start (needs workerd, esbuild and a wasm path)'); process.exit(0); }

const dir = `${root}.cache/workerd`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/gen.mjs`, execFileSync(esbuild, [`${root}gen/js/snug/cbor/scan.mjs`, '--bundle', '--format=esm', '--log-level=error']));
copyFileSync(wasmPath, `${dir}/snug.wasm`);
const put = d => ({ resource: 'https://resource.example/r/1', addressedResource: 'https://resource.example/r/1',
  contract: 'https://contracts.example/object-storage/v1', method: 'put',
  args: { key: 'app/directory.json', data: new Uint8Array(d).map((_, i) => (i * 31) & 255), size: d, type: 'application/json' },
  scope: {}, epoch: null, resourceGeneration: null, connectionGeneration: null });
let small = encode(put(1)); small = encode(put(1 + 287 - small.length));
const input = `const b = new Uint8Array('${Buffer.from(small).toString('hex')}'.match(/../g).map(h => parseInt(h, 16)));`;
const workers = {
  empty: { src: `${input}\nexport default { async fetch() { return new Response(String(b.length - 287)); } };`, extra: '' },
  js: { src: `import { scan, scanOptions } from './gen.mjs';\n${input}\nexport default { async fetch() { const o = new Int32Array(16); scanOptions(o, 0, 0, 1500000, 32, 65536, 131072); return new Response(String(scan(b, o))); } };`,
        extra: ', (name = "gen.mjs", esModule = embed "gen.mjs")' },
  wasm: { src: `import mod from './snug.wasm';\n${input}\nexport default { async fetch() { const x = new WebAssembly.Instance(mod, {}).exports; new Uint8Array(x.memory.buffer, x.snug_buf(), b.length).set(b); return new Response(String(x.snug_scan(b.length, 0, 0, 1500000, 32, 65536, 131072))); } };`,
          extra: ', (name = "snug.wasm", wasm = embed "snug.wasm")' },
};
for (const [name, w] of Object.entries(workers)) {
  writeFileSync(`${dir}/${name}.mjs`, w.src);
  writeFileSync(`${dir}/${name}.capnp`, `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .w) ],
  sockets = [ (name = "http", address = "127.0.0.1:${PORT}", http = (), service = "main") ],
);
const w :Workerd.Worker = (
  modules = [ (name = "worker.mjs", esModule = embed "${name}.mjs")${w.extra} ],
  compatibilityDate = "2026-10-01",
);
`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function once(name) {
  const t0 = performance.now();
  const p = spawn(workerd, ['serve', `${dir}/${name}.capnp`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', d => { err += d; });
  try {
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/`);
        const body = await r.text();
        if (body !== '0') throw new Error(`${name} answered ${body}`);
        return performance.now() - t0;
      } catch (e) {
        if (e.message?.includes('answered')) throw e;
        if (performance.now() - t0 > 20000) throw new Error(`${name}: no answer in 20 s ${err}`);
        await sleep(2);
      }
    }
  } finally {
    p.kill('SIGKILL');
    await new Promise(r => p.once('exit', r));
  }
}
const names = Object.keys(workers), times = Object.fromEntries(names.map(n => [n, []]));
await once('empty');  // warm the OS caches for the binary
for (let s = 0; s < SAMPLES; s++) for (const n of names.map((_, i) => names[(i + s) % names.length])) times[n].push(await once(n));
const median = a => { const x = [...a].sort((p, q) => p - q); return x[(x.length - 1) >> 1]; };
console.log('| worker | median ms to first response | min ms | median minus empty |');
console.log('| --- | ---: | ---: | ---: |');
for (const n of names) console.log(`| ${n} | ${median(times[n]).toFixed(1)} | ${Math.min(...times[n]).toFixed(1)} | ${(median(times[n]) - median(times.empty)).toFixed(1)} |`);
console.log(`(${SAMPLES} workerd processes per worker, interleaved; ${execFileSync(workerd, ['--version']).toString().trim()})`);
