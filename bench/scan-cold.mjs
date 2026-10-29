// P1.4 cold start in Node: a FRESH process per sample; inside it, the time
// from just before loading the scanner to the end of its first call on the
// 287-byte RPC put. Node's own startup is outside the measurement.
//
//   gen   await import(gen/js/snug/cbor/scan.mjs) + scanOptions + scan (7 modules)
//   genb  the same, bundled into one file by esbuild (what a consumer ships)
//   hand  await import(bench/scan-hand.mjs) + scanHand
//   wasm  readFileSync(module) + WebAssembly.instantiate (compile + instantiate)
//         + copy into linear memory + snug_scan
//
//     node bench/scan-cold.mjs <wasm path> [samples]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { encode } from './baseline/cbor-3sln.mjs';

const [wasmPath, samplesArg] = process.argv.slice(2);
const SAMPLES = Number(samplesArg ?? 21);
const root = fileURLToPath(new URL('..', import.meta.url));
const put = d => ({ resource: 'https://resource.example/r/1', addressedResource: 'https://resource.example/r/1',
  contract: 'https://contracts.example/object-storage/v1', method: 'put',
  args: { key: 'app/directory.json', data: new Uint8Array(d).map((_, i) => (i * 31) & 255), size: d, type: 'application/json' },
  scope: {}, epoch: null, resourceGeneration: null, connectionGeneration: null });
let small = encode(put(1)); small = encode(put(1 + 287 - small.length));
const hex = Buffer.from(small).toString('hex');

const esbuild = process.env.SNUG_ESBUILD ?? `${process.env.HOME}/Projects/@3sln/3sln.me/node_modules/.bin/esbuild`;
let bundled = null;
if (existsSync(esbuild)) {
  mkdirSync(`${root}.cache`, { recursive: true });
  bundled = `${root}.cache/scan-gen.bundle.mjs`;
  writeFileSync(bundled, execFileSync(esbuild, [`${root}gen/js/snug/cbor/scan.mjs`, '--bundle', '--format=esm', '--log-level=error']));
}
const programs = {
  gen: `const b=new Uint8Array(Buffer.from('${hex}','hex'));const t0=performance.now();
const m=await import('${root}gen/js/snug/cbor/scan.mjs');const o=new Int32Array(16);m.scanOptions(o,0,0,1500000,32,65536,131072);
const c=m.scan(b,o);const t1=performance.now();console.log(c,t1-t0);`,
  ...(bundled ? { genb: `const b=new Uint8Array(Buffer.from('${hex}','hex'));const t0=performance.now();
const m=await import('${bundled}');const o=new Int32Array(16);m.scanOptions(o,0,0,1500000,32,65536,131072);
const c=m.scan(b,o);const t1=performance.now();console.log(c,t1-t0);` } : {}),
  hand: `const b=new Uint8Array(Buffer.from('${hex}','hex'));const t0=performance.now();
const m=await import('${root}bench/scan-hand.mjs');const c=m.scanHand(b);const t1=performance.now();console.log(c,t1-t0);`,
  ...(wasmPath ? { wasm: `import {readFileSync} from 'node:fs';const b=new Uint8Array(Buffer.from('${hex}','hex'));const t0=performance.now();
const {instance}=await WebAssembly.instantiate(readFileSync('${wasmPath}'));const x=instance.exports;
new Uint8Array(x.memory.buffer,x.snug_buf(),b.length).set(b);const c=x.snug_scan(b.length,0,0,1500000,32,65536,131072);
const t1=performance.now();console.log(c,t1-t0);` } : {}),
};
const names = Object.keys(programs), times = Object.fromEntries(names.map(n => [n, []]));
for (let s = 0; s < SAMPLES; s++) {
  for (const n of names.map((_, i) => names[(i + s) % names.length])) {
    const p = spawnSync(process.execPath, ['--input-type=module', '-e', programs[n]], { encoding: 'utf8' });
    const [code, ms] = p.stdout.trim().split(' ').map(Number);
    if (p.status !== 0 || code !== 0) throw new Error(`${n}: ${p.stderr || p.stdout}`);
    times[n].push(ms);
  }
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
console.log('| variant | median ms | min ms |');
console.log('| --- | ---: | ---: |');
for (const n of names) console.log(`| ${n} | ${median(times[n]).toFixed(2)} | ${Math.min(...times[n]).toFixed(2)} |`);
console.log(`(${SAMPLES} fresh node processes per variant, interleaved; wall time inside the process from before the load to after the first call)`);
