// P7.9: the key rows, cold start and bundle sizes in headless Chrome and
// workerd, for the native package and the wasm SDK. The harness is
// tools/runtime/run.mjs's (P7.7): esbuild bundles, a loopback static server
// with COOP/COEP (fine-grained performance.now) for Chrome, workerd
// `serve` on loopback with process CPU read by `ps` (timers are frozen inside
// the isolate). Nothing is fetched from the network; nothing is deployed.
//
//     node bench/d005-runtimes.mjs [--out DIR] [--samples 15] [--skip browser,workerd,cold,sizes]
//
// Needs the wasm builds (kin/scripts/wasm-build sdk, cc; sdk-size, sdk-s, cc-size, cc-s for sizes).
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { tmpdir, loadavg } from 'node:os';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const skip = new Set((arg('skip', '') || '').split(',').filter(Boolean));
const SAMPLES = Number(arg('samples', 15));
const out = resolve(arg('out', mkdtempSync(join(tmpdir(), 'snug-d005-'))));
mkdirSync(out, { recursive: true });
const HOME = process.env.HOME;
const firstExisting = (...p) => p.find(x => x && existsSync(x));
const esbuild = firstExisting(process.env.SNUG_ESBUILD, join(repo, 'bench/compare/node_modules/.bin/esbuild'));
const nativeWorkerd = p => {
  if (!p) return p;
  p = realpathSync(p);
  if (!readFileSync(p).subarray(0, 2).equals(Buffer.from('#!'))) return p;
  const native = resolve(p, '../../../@cloudflare', `workerd-${process.platform}-${process.arch}`, 'bin/workerd');
  return existsSync(native) ? native : p;
};
const workerd = nativeWorkerd(firstExisting(process.env.SNUG_WORKERD, join(repo, 'ci/tools/node_modules/.bin/workerd'), `${HOME}/.bun/install/global/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd`));
const chrome = firstExisting(process.env.SNUG_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
const log = (...a) => console.error('[d005]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const T = 'target/wasm32-unknown-unknown';
const wasmPath = (crate, profile) => join(repo, `.cache/${crate}/${T}/${profile}/snug_wasm.wasm`);
const SDK = wasmPath('snug-wasm-sdk', 'release'), CC = wasmPath('snug-wasm-cc', 'release');

const results = { date: new Date().toISOString(), out, env: {
  node: process.version, esbuild: sh(esbuild, ['--version']), chrome: chrome ? sh(chrome, ['--version']) : null,
  workerd: workerd ? sh(workerd, ['--version']) : null, commit: sh('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo }),
  load: loadavg().map(x => +x.toFixed(1)) } };
log('out', out, results.env);

// ---------------------------------------------------------------- fixtures (built in Node with the native package)
const { compile } = await import('../host/js/src/public-compile.mjs');
const { workloads } = await import('./d005-inputs.mjs');
const os = readFileSync(join(repo, 'corpus/cddl-study/contracts/object-storage-v1.cddl'), 'utf8');
const hex = b => Buffer.from(b).toString('hex');
const fixtures = { cddl: os, program: hex((await compile(os)).program.serialize()), input: hex(workloads(os)[0].bytes) };
writeFileSync(join(out, 'fixtures.json'), JSON.stringify(fixtures));
const esb = (args) => sh(esbuild, [...args, '--bundle', '--format=esm', '--log-level=warning', '--charset=utf8', '--external:node:*'], { cwd: out });
const fx = 'const hexb = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));\n';

// ---------------------------------------------------------------- sizes
const sizeOf = b => ({ raw: b.length, gzip: gzipSync(b, { level: 9 }).length, brotli: brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length });
if (!skip.has('sizes')) {
  const S = p => join(repo, p);
  const entries = {
    'native runtime (snug + schema + view + sources; no compiler)': `export * from '${S('host/js/src/index.mjs')}'; export * as schema from '${S('host/js/src/public-schema.mjs')}'; export * as view from '${S('host/js/src/public-view.mjs')}'; export * as sources from '${S('host/js/src/public-sources.mjs')}';`,
    'native compile chunk (loaded by the first compile)': `export * from '${S('host/js/src/compile.mjs')}';`,
    'native codec only (decode + encode)': `export { decode, encode } from '${S('host/js/src/index.mjs')}';`,
    'native schema only (fromSerialized + validate)': `export { fromSerialized } from '${S('host/js/src/public-schema.mjs')}';`,
    'SDK glue: runtime (snug + schema + view + sources; no compiler)': `export * from '${S('host/wasm-sdk/src/index.mjs')}'; export * as schema from '${S('host/wasm-sdk/src/schema.mjs')}'; export * as view from '${S('host/wasm-sdk/src/view.mjs')}'; export * as sources from '${S('host/wasm-sdk/src/sources.mjs')}';`,
    'SDK glue: compile entry': `export * from '${S('host/wasm-sdk/src/compile.mjs')}';`,
    'SDK glue: codec only (decode + encode)': `export { decode, encode, init } from '${S('host/wasm-sdk/src/index.mjs')}';`,
    'SDK glue: schema only (fromSerialized + validate)': `export { fromSerialized } from '${S('host/wasm-sdk/src/schema.mjs')}'; export { init } from '${S('host/wasm-sdk/src/index.mjs')}';`,
  };
  results.sizes = { js: {}, wasm: {} };
  let i = 0;
  for (const [name, code] of Object.entries(entries)) {
    const f = join(out, `size-${i}.mjs`), o = join(out, `size-${i++}.min.js`);
    writeFileSync(f, code);
    esb([f, '--minify', `--outfile=${o}`]);
    results.sizes.js[name] = sizeOf(readFileSync(o));
  }
  for (const [crate, label] of [['snug-wasm-sdk', 'runtime'], ['snug-wasm-cc', 'compiler'], ['snug-wasm', 'P1.4/P3.4 module (scanner + VM, static buffers)']])
    for (const [profile, lvl] of [['release', '3'], ['size', 'z'], ['size-s', 's']]) {
      const p = wasmPath(crate, profile);
      if (existsSync(p)) results.sizes.wasm[`${label}, opt-level ${lvl}`] = sizeOf(readFileSync(p));
    }
  console.log('\n## sizes (bytes)\n| bundle | raw | gzip -9 | brotli 11 |\n| --- | ---: | ---: | ---: |');
  for (const [k, v] of [...Object.entries(results.sizes.js), ...Object.entries(results.sizes.wasm)]) console.log(`| ${k} | ${v.raw} | ${v.gzip} | ${v.brotli} |`);
}

// ---------------------------------------------------------------- bundles for the runtimes
copyFileSync(SDK, join(out, 'sdk.wasm')); copyFileSync(CC, join(out, 'cc.wasm'));
const ops = join(repo, 'bench/d005-ops.mjs');
writeFileSync(join(out, 'warm-page.mjs'), `import { prepare, timeOps, W, compilerSource } from '${ops}';
const post = (b) => fetch('/result', { method: 'POST', body: JSON.stringify(b) }).then(r => r.json()).then(r => { if (r.next) location.href = r.next; });
try {
  const fx = await (await fetch('fixtures.json')).json();
  await W.init(new URL('sdk.wasm', location.href)); compilerSource(new URL('cc.wasm', location.href));
  const { ops, compileOps } = await prepare(fx.cddl);
  const t = await timeOps(ops, () => performance.now());
  const c = {};
  for (const [name, [a, b]] of Object.entries(compileOps)) {
    const per = [[], []];
    for (let k = 0; k < 15; k++) for (const [j, f] of [[0, a], [1, b]]) { const s = performance.now(); await f(); per[j].push(performance.now() - s); }
    c[name] = per.map(x => { x.sort((p, q) => p - q); return x[x.length >> 1]; });
  }
  await post({ mode: 'warm', ops: { ...t, ...c }, isolated: crossOriginIsolated, memory: W.memoryBytes(), ua: navigator.userAgent });
} catch (e) { await post({ mode: 'warm', fatal: String(e.stack ?? e) }); }
`);
writeFileSync(join(out, 'cold-native.mjs'), `${fx}import { fromSerialized } from '${join(repo, 'host/js/src/public-schema.mjs')}';
const t0 = performance.now();
const fx = await (await fetch('fixtures.json')).json(); const p = hexb(fx.program), input = hexb(fx.input);
const t1 = performance.now(); const s = await fromSerialized(p); const t2 = performance.now(); const ok = s.validate(input, 'request').ok; const t3 = performance.now();
const r = await fetch('/result', { method: 'POST', body: JSON.stringify({ mode: 'cold-native', entry: t0, load: t2 - t1, first: t3 - t2, ok }) }).then(r => r.json());
if (r.next) location.href = r.next;
`);
writeFileSync(join(out, 'cold-wasm.mjs'), `${fx}import { initSync } from '${join(repo, 'host/wasm-sdk/src/index.mjs')}'; import { fromSerializedSync } from '${join(repo, 'host/wasm-sdk/src/schema.mjs')}';
const t0 = performance.now();
const fx = await (await fetch('fixtures.json')).json(); const p = hexb(fx.program), input = hexb(fx.input);
const a = performance.now(); const mod = await WebAssembly.compileStreaming(fetch('sdk.wasm')); const b = performance.now(); initSync(mod); const c = performance.now();
const s = fromSerializedSync(p); const d = performance.now(); const ok = s.validate(input, 'request').ok; const e = performance.now();
const r = await fetch('/result', { method: 'POST', body: JSON.stringify({ mode: 'cold-wasm', entry: t0, compile: b - a, instantiate: c - b, load: d - c, first: e - d, ok }) }).then(r => r.json());
if (r.next) location.href = r.next;
`);
writeFileSync(join(out, 'csp-probe.mjs'), `let r;
try { await WebAssembly.compileStreaming(fetch('sdk.wasm')); r = 'compiled'; } catch (e) { r = String(e); }
let r2; try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); r2 = 'compiled'; } catch (e) { r2 = String(e); }
const x = await fetch('/result', { method: 'POST', body: JSON.stringify({ mode: 'csp', streaming: r, bytes: r2 }) }).then(r => r.json());
if (x.next) location.href = x.next;
`);
for (const n of ['warm-page', 'cold-native', 'cold-wasm', 'csp-probe']) {
  esb([`${n}.mjs`, '--minify', `--outfile=${n}.js`]);
  writeFileSync(join(out, `${n}.html`), `<!doctype html><meta charset="utf-8"><title>${n}</title><script type="module" src="${n}.js"></script>`);
}

// ---------------------------------------------------------------- Chrome
if (!skip.has('browser') && chrome) {
  const STRICT = "default-src 'self'; script-src 'self'", WASM = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'";
  const plan = ['csp-probe.html?csp=strict', 'csp-probe.html?csp=wasm'];
  for (let s = 0; s < SAMPLES; s++) plan.push(...(s % 2 ? ['cold-wasm.html', 'cold-native.html'] : ['cold-native.html', 'cold-wasm.html']));
  plan.push('warm-page.html');
  const got = [];
  let done; const finished = new Promise(r => { done = r; });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const csp = u.searchParams.get('csp') === 'strict' ? STRICT : WASM;
    const headers = { 'Content-Security-Policy': csp, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
    if (req.method === 'POST') {
      let body = ''; req.on('data', d => { body += d; });
      req.on('end', () => {
        const r = JSON.parse(body); got.push(r);
        const next = plan[got.length];
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ next: next ? `/${next}` : null }));
        if (!next) done();
      });
      return;
    }
    const path = join(out, u.pathname.replace(/^\/+/, '') || 'index.html');
    if (!path.startsWith(out) || !existsSync(path)) { res.writeHead(404, headers).end(); return; }
    res.writeHead(200, { ...headers, 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path));
  });
  const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const profile = mkdtempSync(join(tmpdir(), 'snug-chrome-'));
  log(`browser: ${plan.length} pages on http://127.0.0.1:${port}/`);
  const proc = spawn(chrome, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--metrics-recording-only', '--no-pings', '--disable-default-apps',
    `http://127.0.0.1:${port}/${plan[0]}`], { stdio: 'ignore', detached: true });
  try { await Promise.race([finished, sleep(900000)]); }
  finally {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    await Promise.race([new Promise(r => proc.once('exit', r)), sleep(3000)]);
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    server.close();
  }
  results.browser = got;
  const med = a => { const x = [...a].sort((p, q) => p - q); return x[(x.length - 1) >> 1]; };
  const cn = got.filter(r => r.mode === 'cold-native'), cw = got.filter(r => r.mode === 'cold-wasm');
  console.log('\n## Chrome');
  for (const r of got.filter(r => r.mode === 'csp')) console.log('csp probe:', JSON.stringify(r));
  if (cn.length) console.log(`cold native: entry ${med(cn.map(r => r.entry)).toFixed(1)} ms, fromSerialized ${med(cn.map(r => r.load)).toFixed(2)} ms, first validate ${med(cn.map(r => r.first)).toFixed(2)} ms (n=${cn.length})`);
  if (cw.length) console.log(`cold wasm: entry ${med(cw.map(r => r.entry)).toFixed(1)} ms, compileStreaming ${med(cw.map(r => r.compile)).toFixed(2)} ms, instantiate ${med(cw.map(r => r.instantiate)).toFixed(2)} ms, fromSerialized ${med(cw.map(r => r.load)).toFixed(2)} ms, first validate ${med(cw.map(r => r.first)).toFixed(2)} ms`);
  const warm = got.find(r => r.mode === 'warm');
  if (warm?.ops) for (const [k, [a, b]] of Object.entries(warm.ops)) console.log(`${k.padEnd(44)} native ${(a * 1000).toFixed(1).padStart(10)} µs  wasm ${(b * 1000).toFixed(1).padStart(10)} µs  ${(b / a).toFixed(2)}`);
  else console.log('warm:', JSON.stringify(warm));
}

// ---------------------------------------------------------------- workerd
const capnp = (dir, modules, port) => {
  const mods = modules.map(([name, kind]) => `(name = "${name}", ${kind} = embed "${name}")`).join(', ');
  writeFileSync(join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = ( services = [ (name = "main", worker = .w) ], sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ] );
const w :Workerd.Worker = ( modules = [ ${mods} ], compatibilityDate = "2025-12-01" );
`);
  return join(dir, 'config.capnp');
};
const cpuSeconds = pid => { const t = sh('ps', ['-o', 'time=', '-p', String(pid)]); const [m, s] = t.split(':'); return Number(m) * 60 + Number(s); };
async function serve(config, port) {
  const t0 = performance.now();
  const proc = spawn(workerd, ['serve', config], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; proc.stderr.on('data', d => { err += d; });
  const stop = async () => { const ex = proc.exitCode === null ? new Promise(r => proc.once('exit', r)) : null; try { process.kill(-proc.pid, 'SIGKILL'); } catch {} await ex; };
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${port}/noop`); await r.text(); return { proc, stop, stderr: () => err }; }
    catch { if (performance.now() - t0 > 30000 || proc.exitCode !== null) { await stop(); throw new Error(`workerd did not answer: ${err}`); } await sleep(5); }
  }
}
if (!skip.has('workerd') && workerd) {
  const dir = join(out, 'workerd-warm'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'entry.mjs'), `import sdkMod from './sdk.wasm'; import ccMod from './cc.wasm'; import fx from './fixtures.json';
import { prepare, W, compilerSource } from '${ops}';
W.initSync(sdkMod); compilerSource(ccMod);
let P;
export default { async fetch(req) {
  const u = new URL(req.url), q = u.searchParams;
  if (u.pathname === '/noop') return new Response('0');
  if (u.pathname === '/probe') { let a, b; try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); a = 'compiled'; } catch (e) { a = String(e); }
    try { new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); b = 'compiled'; } catch (e) { b = String(e); } return Response.json({ asyncCompile: a, syncModule: b, memory: W.memoryBytes() }); }
  P ??= await prepare(fx.cddl);
  if (u.pathname === '/names') return Response.json(Object.keys({ ...P.ops, ...P.compileOps }));
  const f = (P.ops[q.get('name')] ?? P.compileOps[q.get('name')])[Number(q.get('b'))], n = Number(q.get('n'));
  for (let i = 0; i < n; i++) await f();
  return new Response('ok');
} };
`);
  copyFileSync(join(out, 'sdk.wasm'), join(dir, 'sdk.wasm')); copyFileSync(join(out, 'cc.wasm'), join(dir, 'cc.wasm')); copyFileSync(join(out, 'fixtures.json'), join(dir, 'fixtures.json'));
  sh(esbuild, ['entry.mjs', '--bundle', '--format=esm', '--minify', '--log-level=warning', '--external:./sdk.wasm', '--external:./cc.wasm', '--external:./fixtures.json', '--external:node:*', '--outfile=worker.js'], { cwd: dir });
  const port = await freePort();
  const w = await serve(capnp(dir, [['worker.js', 'esModule'], ['sdk.wasm', 'wasm'], ['cc.wasm', 'wasm'], ['fixtures.json', 'json']], port), port);
  results.workerd = {};
  try {
    results.workerd.probe = await (await fetch(`http://127.0.0.1:${port}/probe`)).json();
    const names = await (await fetch(`http://127.0.0.1:${port}/names`)).json();
    // CPU per call: process CPU over R requests of n calls, minus R /noop requests; median of 3; ps has 10 ms resolution.
    const per = {};
    for (const name of names) {
      per[name] = [];
      for (const b of [0, 1]) {
        let n = 1;
        for (;;) { const c0 = cpuSeconds(w.proc.pid); await (await fetch(`http://127.0.0.1:${port}/op?name=${encodeURIComponent(name)}&b=${b}&n=${n}`)).text(); if (cpuSeconds(w.proc.pid) - c0 >= 0.05 || n > 1 << 16) break; n *= 4; }
        const R = 10, s = [];
        for (let k = 0; k < 3; k++) {
          let c0 = cpuSeconds(w.proc.pid); for (let i = 0; i < R; i++) await (await fetch(`http://127.0.0.1:${port}/noop`)).text(); const base = cpuSeconds(w.proc.pid) - c0;
          c0 = cpuSeconds(w.proc.pid); for (let i = 0; i < R; i++) await (await fetch(`http://127.0.0.1:${port}/op?name=${encodeURIComponent(name)}&b=${b}&n=${n}`)).text();
          s.push(((cpuSeconds(w.proc.pid) - c0 - base) * 1e6) / (R * n));
        }
        s.sort((p, q) => p - q); per[name].push(+s[1].toFixed(2));
      }
    }
    results.workerd.cpuPerCallUs = per;
  } finally { await w.stop(); }
  console.log('\n## workerd (process CPU µs per call)', JSON.stringify(results.workerd.probe));
  for (const [k, [a, b]] of Object.entries(results.workerd.cpuPerCallUs)) console.log(`${k.padEnd(44)} native ${String(a).padStart(10)}  wasm ${String(b).padStart(10)}  ${(b / a).toFixed(2)}`);
}

// ---------------------------------------------------------------- workerd cold start
if (!skip.has('cold') && workerd) {
  const dir = join(out, 'workerd-cold'); mkdirSync(dir, { recursive: true });
  const prog = `const program = hexb('${fixtures.program}'), input = hexb('${fixtures.input}');\n`;
  const entries = {
    empty: `${fx}${prog}export default { async fetch() { return new Response(String(input.length)); } };`,
    native: `${fx}import { fromSerialized } from '${join(repo, 'host/js/src/public-schema.mjs')}';\n${prog}export default { async fetch() { const s = await fromSerialized(program); return new Response(s.validate(input, 'request').ok ? String(input.length) : 'refused'); } };`,
    wasm: `${fx}import sdkMod from './sdk.wasm'; import { initSync } from '${join(repo, 'host/wasm-sdk/src/index.mjs')}'; import { fromSerializedSync } from '${join(repo, 'host/wasm-sdk/src/schema.mjs')}';\n${prog}initSync(sdkMod);\nexport default { async fetch() { const s = fromSerializedSync(program); return new Response(s.validate(input, 'request').ok ? String(input.length) : 'refused'); } };`,
  };
  const port = await freePort(), configs = {};
  results.cold = { sizes: {}, rows: {} };
  for (const [name, code] of Object.entries(entries)) {
    const d = join(dir, name); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'entry.mjs'), code);
    sh(esbuild, ['entry.mjs', '--bundle', '--format=esm', '--minify', '--log-level=warning', '--external:./sdk.wasm', '--external:node:*', '--outfile=worker.js'], { cwd: d });
    const mods = [['worker.js', 'esModule']];
    if (name === 'wasm') { copyFileSync(join(out, 'sdk.wasm'), join(d, 'sdk.wasm')); mods.push(['sdk.wasm', 'wasm']); }
    configs[name] = capnp(d, mods, port);
    results.cold.sizes[name] = sizeOf(readFileSync(join(d, 'worker.js')));
  }
  const once = async name => {
    const t0 = performance.now();
    const proc = spawn(workerd, ['serve', configs[name]], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    let err = ''; proc.stderr.on('data', d => { err += d; });
    try {
      for (;;) {
        try {
          const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
          if (body !== String(fixtures.input.length / 2)) throw new Error(`answered ${body}`);
          return { wall: performance.now() - t0, cpu: cpuSeconds(proc.pid) * 1000 };
        } catch (e) {
          if (e.message?.startsWith('answered')) throw new Error(`${name} ${e.message} ${err}`);
          if (performance.now() - t0 > 30000) throw new Error(`${name}: no answer ${err}`);
          await sleep(2);
        }
      }
    } finally { const ex = proc.exitCode === null ? new Promise(r => proc.once('exit', r)) : null; try { process.kill(-proc.pid, 'SIGKILL'); } catch {} await ex; }
  };
  const names = Object.keys(entries), wall = Object.fromEntries(names.map(n => [n, []])), cpu = Object.fromEntries(names.map(n => [n, []]));
  for (const n of names) await once(n);
  for (let s = 0; s < SAMPLES; s++) for (const n of names.map((_, i) => names[(i + s) % names.length])) { const r = await once(n); wall[n].push(r.wall); cpu[n].push(r.cpu); }
  const med = a => { const x = [...a].sort((p, q) => p - q); return x[(x.length - 1) >> 1]; };
  console.log('\n## workerd cold start (spawn to first response)');
  for (const n of names) {
    results.cold.rows[n] = { wall: +med(wall[n]).toFixed(1), wallMinusEmpty: +(med(wall[n]) - med(wall.empty)).toFixed(1), cpu: med(cpu[n]), cpuMinusEmpty: med(cpu[n]) - med(cpu.empty), allWall: wall[n].map(x => +x.toFixed(1)), allCpu: cpu[n] };
    console.log(`${n.padEnd(8)} gzip ${results.cold.sizes[n].gzip} B (+wasm for wasm)  wall ${results.cold.rows[n].wall} ms (${results.cold.rows[n].wallMinusEmpty} over empty)  cpu ${results.cold.rows[n].cpu} ms (${results.cold.rows[n].cpuMinusEmpty} over empty)`);
  }
}
results.env.loadEnd = loadavg().map(x => +x.toFixed(1));
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1));
log('results', join(out, 'results.json'));
process.exit(0);
