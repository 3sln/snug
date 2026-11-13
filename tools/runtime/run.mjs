// P7.7 runtime evidence: the same conformance subset (suite.mjs) in Node, a
// real headless Chrome and a local workerd isolate, plus bundle sizes, a scan
// of the bundles for dynamic code evaluation, CPU per call and workerd cold
// start. Loopback only; nothing is deployed or fetched from the network.
//
//   node tools/runtime/run.mjs [--checkout DIR] [--package DIR] [--out DIR]
//        [--samples 21] [--skip browser,workerd,cold,cpu]
//
// --checkout  the source tree whose package is staged and whose corpus is read
//             (default: this repository; use a clean `git worktree` of the
//             commit under test when the working tree is mid-edit)
// --package   an already staged package (`npm run build` output) to use
// --out       a NEW scratch directory for everything produced (default: a
//             fresh directory under os.tmpdir())
// Tools (read-only; override with environment variables):
//   SNUG_ESBUILD  esbuild binary   (default bench/compare/node_modules/.bin/esbuild)
//   SNUG_WORKERD  workerd binary   (default: the first that exists of ci/tools's pinned
//                 workerd, `npm ci` in ci/tools, and the global bun install's workerd)
//   SNUG_CHROME   Chrome binary    (default /Applications/Google Chrome.app/…)
// Writes OUT/results.json and prints Markdown tables for tools/runtime/README.md.
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, brotliCompressSync, constants as Z } from 'node:zlib';
import { buildFixtures } from './fixtures.mjs';
import { selfWatch } from '../../kin/scripts/watchdog.mjs';
import { verdict, selfTest } from './verdict.mjs';
selfWatch('runtime', import.meta.url);   // P9.1 caps

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const skip = new Set((arg('skip', '') || '').split(',').filter(Boolean));
const SAMPLES = Number(arg('samples', 21));
const checkout = resolve(arg('checkout', repo));
const out = arg('out') ? resolve(arg('out')) : mkdtempSync(join(tmpdir(), 'snug-runtime-'));
mkdirSync(out, { recursive: true });
const HOME = process.env.HOME;
const firstExisting = (...paths) => paths.find(p => p && existsSync(p));
const esbuild = firstExisting(process.env.SNUG_ESBUILD, join(repo, 'bench/compare/node_modules/.bin/esbuild'));
const workerdPath = firstExisting(process.env.SNUG_WORKERD, join(repo, 'ci/tools/node_modules/.bin/workerd'),
  `${HOME}/.bun/install/global/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd`);
// The npm `workerd/bin/workerd` is a Node launcher that spawns the native binary;
// use the native one so killing the process really stops the isolate.
const nativeWorkerd = p => {
  if (!p) return p;
  p = realpathSync(p);
  if (!readFileSync(p).subarray(0, 2).equals(Buffer.from('#!'))) return p;
  const native = resolve(p, '../../../@cloudflare', `workerd-${process.platform}-${process.arch}`, 'bin/workerd');
  return existsSync(native) ? native : p;
};
const workerd = nativeWorkerd(workerdPath);
const chrome = firstExisting(process.env.SNUG_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
if (!esbuild) throw new Error('esbuild not found; set SNUG_ESBUILD');
// A runtime that is missing (and not --skip'd) is NOT RUN, never a quiet pass:
// `bb gates` fails a set on a SKIP line on stdout (release-policy §2, P9.20).
if (!skip.has('browser') && !chrome) console.log('SKIP runtime browser arm -- no Chrome (SNUG_CHROME): NOT RUN');
if (!skip.has('workerd') && !workerd) console.log('SKIP runtime workerd arm -- no workerd (SNUG_WORKERD): NOT RUN');
for (const a of ['browser', 'workerd']) if (skip.has(a)) console.log(`SKIP runtime ${a} arm -- --skip ${a}: NOT RUN`);
// P9.13 WP3 (B1): the verdict must catch each kind of failure before it judges this run.
console.error(`[runtime] verdict self-test: ${selfTest()} injected failures caught`);
// --inject-fail: one fixture every arm must fail (proves the gate fails end to end)
const INJECT = process.argv.includes('--inject-fail');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
const log = (...a) => console.error('[runtime]', ...a);
const results = { date: new Date().toISOString(), out };

// ---------------------------------------------------------------- environment
let commit = null, dirty = null;
try { commit = sh('git', ['-C', checkout, 'rev-parse', 'HEAD']); dirty = sh('git', ['-C', checkout, 'status', '--porcelain', '--', 'host/js', 'gen/js', 'corpus']) !== ''; } catch {}
results.env = {
  checkout, commit, dirtyPackageSources: dirty,
  machine: `${sh('sysctl', ['-n', 'machdep.cpu.brand_string'])}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GiB`,
  os: `${sh('sw_vers', ['-productName'])} ${sh('sw_vers', ['-productVersion'])} (${process.arch})`,
  node: process.version, esbuild: sh(esbuild, ['--version']),
  workerd: workerd ? `${sh(workerd, ['--version'])} (${workerd})` : null,
  chrome: chrome ? sh(chrome, ['--version']) : null,
  loadAverageAtStart: loadavg().map(x => +x.toFixed(1)),
};
log(JSON.stringify(results.env));

// -------------------------------------------------------------- stage package
let pkg = arg('package');
if (!pkg) {
  const { buildPackage } = await import(pathToFileURL(join(checkout, 'host/js/src/package-build.mjs')));
  pkg = await buildPackage(join(out, 'package'));
}
pkg = resolve(pkg);
results.env.package = pkg;
const fx = await buildFixtures(checkout, pkg);
if (INJECT) fx.profile.refuse.push({ name: 'injected failure (--inject-fail): 0x00 is accepted', hex: '00', code: 'malformed' });
writeFileSync(join(out, 'fixtures.json'), JSON.stringify(fx));
results.fixtures = { profileAccept: fx.profile.accept.length, profileRefuse: fx.profile.refuse.length, oracle: fx.oracle.length,
  contracts: fx.contracts.length, contractCases: fx.contracts.reduce((n, s) => n + s.cases.length, 0), probes: fx.probes.length,
  fixtureBytes: statSync(join(out, 'fixtures.json')).size };

// A fresh consumer directory: node_modules/@3sln/snug is a copy of the staged package;
// suite/ops/entries are copied beside it, so no import can reach the repository.
const consumer = join(out, 'consumer');
mkdirSync(join(consumer, 'node_modules', '@3sln'), { recursive: true });
cpSync(pkg, join(consumer, 'node_modules/@3sln/snug'), { recursive: true });
for (const f of ['suite.mjs', 'ops.mjs', 'node-entry.mjs']) cpSync(join(here, f), join(consumer, f));
cpSync(join(here, 'browser'), join(consumer, 'browser'), { recursive: true });
cpSync(join(here, 'worker'), join(consumer, 'worker'), { recursive: true });
cpSync(join(out, 'fixtures.json'), join(consumer, 'fixtures.json'));
writeFileSync(join(consumer, 'package.json'), '{ "private": true, "type": "module" }\n');
writeFileSync(join(consumer, 'compile-absent.mjs'),
  "// Stands in for snug/compile in the precompiled worker: the compiler is not bundled.\nexport async function compile() { throw new Error('snug/compile is not bundled in this worker'); }\nexport class SchemaError extends Error {}\n");

// ------------------------------------------------------------------ Node arm
log('node: fresh consumer directory', consumer);
const nodeRun = JSON.parse(sh(process.execPath, ['node-entry.mjs'], { cwd: consumer, maxBuffer: 1 << 26 }));
results.node = nodeRun;
{ // CPU per call in Node (thread CPU), same ops as workerd
  writeFileSync(join(consumer, 'node-ops.mjs'), `import { readFileSync } from 'node:fs';
import { prepareOps } from './ops.mjs';
const fx = JSON.parse(readFileSync('./fixtures.json', 'utf8'));
const { ops, counts, yields } = await prepareOps(fx), res = {}, wall = {};
const cpu = () => { const u = process.threadCpuUsage(); return u.user + u.system; };
for (const [name, f] of Object.entries(ops)) {
  const n = counts[name];
  for (let i = 0; i < Math.min(n, 50); i++) await f();
  const runs = [], walls = [];
  for (let r = 0; r < 7; r++) { const s = cpu(), w = performance.now(); for (let i = 0; i < n; i++) await f(); runs.push((cpu() - s) / n); walls.push((performance.now() - w) * 1000 / n); }
  runs.sort((a, b) => a - b); walls.sort((a, b) => a - b); res[name] = +runs[3].toFixed(3); wall[name] = +walls[3].toFixed(3);
}
console.log(JSON.stringify({ cpu: res, wall, yields }));
`);
  if (!skip.has('cpu')) { const r = JSON.parse(sh(process.execPath, ['node-ops.mjs'], { cwd: consumer })); results.node.cpuPerCallUs = r.cpu; results.node.wallPerCallUs = r.wall; results.yields = r.yields; }
}

// -------------------------------------------------------------------- bundles
const bundleDir = join(out, 'bundles');
mkdirSync(bundleDir, { recursive: true });
const esb = (args) => sh(esbuild, [...args, '--bundle', '--format=esm', '--log-level=warning', '--charset=utf8'], { cwd: consumer });
const sizeOf = file => { const b = readFileSync(file); return { raw: b.length,
  gzip: gzipSync(b, { level: 9 }).length, brotli: brotliCompressSync(b, { params: { [Z.BROTLI_PARAM_QUALITY]: 11 } }).length }; };
const sumSizes = files => files.map(sizeOf).reduce((a, b) => ({ raw: a.raw + b.raw, gzip: a.gzip + b.gzip, brotli: a.brotli + b.brotli }), { raw: 0, gzip: 0, brotli: 0 });
const jsFiles = dir => readdirSync(dir).filter(f => f.endsWith('.js')).map(f => join(dir, f));

// Library-only entries (what a consumer's bundle pays for snug), minified.
const RUNTIME = "export * from '@3sln/snug'; export * as schema from '@3sln/snug/schema'; export * as view from '@3sln/snug/view'; export * as writer from '@3sln/snug/writer'; export * as sources from '@3sln/snug/sources';";
const libEntries = [
  ['snug (codec: decode, encode, values)', "export * from '@3sln/snug';"],
  ['snug/schema (Program, Schema, fromSerialized; no compiler)', "export * from '@3sln/snug/schema';"],
  ['snug/view', "export * from '@3sln/snug/view';"],
  ['snug/writer', "export * from '@3sln/snug/writer';"],
  ['snug/sources', "export * from '@3sln/snug/sources';"],
  ['runtime: snug + schema + view + writer + sources (no compiler)', RUNTIME],
  ['runtime + snug/compile, one file (compiler inlined by esbuild)', RUNTIME + " export * as compile from '@3sln/snug/compile';"],
];
results.sizes = [];
for (const [i, [label, code]] of libEntries.entries()) {
  writeFileSync(join(consumer, `lib-${i}.mjs`), code + '\n');
  esb([`lib-${i}.mjs`, '--minify', `--outfile=${join(bundleDir, `lib-${i}.min.js`)}`]);
  results.sizes.push({ label, ...sizeOf(join(bundleDir, `lib-${i}.min.js`)) });
}
{ // The same runtime + compile entry with code splitting: what loads at import vs at the first compile().
  const i = libEntries.length - 1, dir = join(bundleDir, 'lib-split');
  esb([`lib-${i}.mjs`, '--minify', '--splitting', `--outdir=${dir}`, '--entry-names=[name]', '--chunk-names=chunk-[hash]']);
  const files = jsFiles(dir), entry = files.find(f => basename(f).startsWith('lib-'));
  const eager = new Set([entry]); let grew = true;
  while (grew) { grew = false; for (const f of [...eager]) for (const m of readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*"\.\/(chunk-[^"]+)"/g)) { const p = join(dir, m[1]); if (!eager.has(p)) { eager.add(p); grew = true; } } }
  results.sizes.push({ label: `runtime + snug/compile, split: loaded at import (${eager.size} files)`, ...sumSizes([...eager]) });
  results.sizes.push({ label: `runtime + snug/compile, split: loaded by the first compile() (${files.length - eager.size} files)`, ...sumSizes(files.filter(f => !eager.has(f))) });
}
// The test bundles themselves (minified, as deployed).
const builds = {
  browser: { dir: join(bundleDir, 'browser'), args: ['browser/entry.mjs', '--splitting', '--platform=browser', '--minify', '--entry-names=entry', '--chunk-names=chunk-[hash]'] },
  'worker-split': { dir: join(bundleDir, 'worker-split'), args: ['worker/entry.mjs', '--splitting', '--minify', '--external:./fixtures.json', '--entry-names=worker', '--chunk-names=chunk-[hash]'] },
  'worker-eager': { dir: join(bundleDir, 'worker-eager'), args: ['worker/entry.mjs', '--minify', '--external:./fixtures.json', '--entry-names=worker'] },
  'worker-precompiled': { dir: join(bundleDir, 'worker-precompiled'), args: ['worker/entry.mjs', '--minify', '--external:./fixtures.json', '--entry-names=worker', '--alias:@3sln/snug/compile=./compile-absent.mjs'] },
  'unminified-all': { dir: join(bundleDir, 'unminified'), args: ['browser/entry.mjs', 'worker/entry.mjs', '--splitting', '--external:./fixtures.json', '--chunk-names=chunk-[hash]'] },
};
for (const [name, b] of Object.entries(builds)) { esb([...b.args, `--outdir=${b.dir}`]); b.files = jsFiles(b.dir); }
for (const name of ['worker-split', 'worker-eager', 'worker-precompiled'])
  results.sizes.push({ label: `test worker bundle: ${name} (suite + ops + snug, ${builds[name].files.length} files)`, ...sumSizes(builds[name].files) });
// Dynamic code evaluation scan over every produced bundle.
const patterns = { 'eval(': /\beval\s*\(/g, 'new Function': /\bnew\s+Function\b/g, 'Function(': /(?<![\w$.])Function\s*\(/g,
  'WebAssembly.*': /\bWebAssembly\s*\.\s*(compile|compileStreaming|instantiate|instantiateStreaming|Module|Instance|validate)\b/g,
  'setTimeout/setInterval with a string': /\bset(?:Timeout|Interval)\s*\(\s*['"`]/g, 'import(<non-literal>)': /\bimport\s*\(\s*(?!["'`])/g };
const scanned = [...new Set([...Object.values(builds).flatMap(b => b.files), ...readdirSync(bundleDir, { recursive: true }).filter(f => String(f).endsWith('.js')).map(f => join(bundleDir, String(f)))])];
results.codeScan = { files: scanned.length, bytes: scanned.reduce((n, f) => n + statSync(f).size, 0), hits: {} };
for (const [label, re] of Object.entries(patterns)) {
  const hits = [];
  for (const f of scanned) for (const m of readFileSync(f, 'utf8').matchAll(re)) hits.push(`${f.slice(bundleDir.length + 1)}@${m.index}`);
  results.codeScan.hits[label] = hits;
}
// The package source too (not only what esbuild kept).
const srcFiles = [join(pkg, 'src'), join(pkg, 'generated')].flatMap(d => readdirSync(d, { recursive: true }).filter(f => String(f).endsWith('.mjs')).map(f => join(d, String(f))));
results.codeScan.packageSourceHits = {};
for (const [label, re] of Object.entries(patterns)) {
  const hits = [];
  for (const f of srcFiles) for (const m of readFileSync(f, 'utf8').matchAll(re)) hits.push(`${f.slice(pkg.length + 1)}@${m.index}`);
  results.codeScan.packageSourceHits[label] = hits;
}

const freePort = () => new Promise(r => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --------------------------------------------------------------- browser arm
if (!skip.has('browser') && chrome) {
  const site = join(out, 'site');
  cpSync(builds.browser.dir, site, { recursive: true });
  for (const f of ['index.html', 'control.js']) cpSync(join(here, 'browser', f), join(site, f));
  cpSync(join(out, 'fixtures.json'), join(site, 'fixtures.json'));
  const CSP = "default-src 'self'; script-src 'self'; report-uri /csp-report";
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
  const reports = [];
  let resolveResult;
  const resultP = new Promise(r => { resolveResult = r; });
  const server = createServer((req, res) => {
    const headers = { 'Content-Security-Policy': CSP, 'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
    if (req.method === 'POST') {
      let body = ''; req.on('data', d => { body += d; });
      req.on('end', () => { res.writeHead(204, headers).end(); if (req.url === '/result') resolveResult(JSON.parse(body)); else reports.push(body); });
      return;
    }
    const path = join(site, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html');
    if (!path.startsWith(site) || !existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404, headers).end(); return; }
    res.writeHead(200, { ...headers, 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path));
  });
  const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const profile = mkdtempSync(join(tmpdir(), 'snug-chrome-'));
  log(`browser: http://127.0.0.1:${port}/ in headless Chrome`);
  const proc = spawn(chrome, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--metrics-recording-only', '--no-pings', '--disable-default-apps', `http://127.0.0.1:${port}/`],
  { stdio: 'ignore', detached: true });
  try {
    results.browser = await Promise.race([resultP, sleep(180000).then(() => ({ fatal: 'no result in 180 s' }))]);
    results.browser.cspHeader = CSP; results.browser.cspReports = reports;
  } finally {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    await Promise.race([new Promise(r => proc.once('exit', r)), sleep(3000)]);
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    server.close();
  }
}

// --------------------------------------------------------------- workerd arm
const capnp = (dir, modules, port, extra = '') => {
  const mods = modules.map(([name, kind]) => `(name = "${name}", ${kind} = embed "${name}")`).join(', ');
  writeFileSync(join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .w) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ],
);
const w :Workerd.Worker = (
  modules = [ ${mods} ],
  compatibilityDate = "2025-12-01",${extra}
);
`);
  return join(dir, 'config.capnp');
};
async function serve(config, port, { timeout = 20000 } = {}) {
  const t0 = performance.now();
  const proc = spawn(workerd, ['serve', config], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; proc.stderr.on('data', d => { err += d; });
  const stop = async () => { const exited = proc.exitCode === null ? new Promise(r => proc.once('exit', r)) : null; try { process.kill(-proc.pid, 'SIGKILL'); } catch {} await exited; };
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${port}/noop`); await r.text(); return { proc, stop, startMs: performance.now() - t0, stderr: () => err }; }
    catch { if (performance.now() - t0 > timeout || proc.exitCode !== null) { await stop(); throw new Error(`workerd did not answer: ${err}`); } await sleep(5); }
  }
}
const cpuSeconds = pid => { const t = sh('ps', ['-o', 'time=', '-p', String(pid)]); const [m, s] = t.split(':'); return Number(m) * 60 + Number(s); };

if (!skip.has('workerd') && workerd) {
  results.workerd = {};
  for (const name of ['worker-split', 'worker-eager', 'worker-precompiled']) {
    const dir = join(out, 'workerd', name);
    cpSync(builds[name].dir, dir, { recursive: true });
    cpSync(join(out, 'fixtures.json'), join(dir, 'fixtures.json'));
    const port = await freePort();
    const modules = [['worker.js', 'esModule'], ...builds[name].files.map(f => basename(f)).filter(f => f !== 'worker.js').map(f => [f, 'esModule']), ['fixtures.json', 'json']];
    const config = capnp(dir, modules, port);
    const w = await serve(config, port);
    const r = { modules: modules.map(m => m[0]) };
    try {
      for (const compiler of name === 'worker-precompiled' ? [false] : [true, false]) {
        const res = await fetch(`http://127.0.0.1:${port}/suite?compiler=${compiler ? 1 : 0}`);
        r[compiler ? 'compiled' : 'precompiled'] = res.ok ? await res.json() : { fatal: `${res.status} ${await res.text()} ${w.stderr()}` };
      }
      if (name === 'worker-split' && !skip.has('cpu')) {
        // CPU per call: workerd process CPU over batches, minus the same number of /noop requests.
        const ops = ['noop', 'decode', 'encode', 'validate', 'schemaDecode', 'view', 'fromSerialized', 'compile', 'scanNoYield', 'scanYield'];
        const per = {};
        for (const op of ops) {
          const n = op === 'compile' ? 20 : op === 'fromSerialized' ? 500 : op.startsWith('scan') ? 3 : 5000, R = op === 'compile' ? 10 : 20;
          await (await fetch(`http://127.0.0.1:${port}/op?name=${op}&n=${Math.min(n, 50)}`)).text();
          const samples = [];
          for (let k = 0; k < 3; k++) {
            let c0 = cpuSeconds(w.proc.pid);
            for (let i = 0; i < R; i++) await (await fetch(`http://127.0.0.1:${port}/noop`)).text();
            const base = cpuSeconds(w.proc.pid) - c0;
            c0 = cpuSeconds(w.proc.pid);
            for (let i = 0; i < R; i++) await (await fetch(`http://127.0.0.1:${port}/op?name=${op}&n=${n}`)).text();
            samples.push(((cpuSeconds(w.proc.pid) - c0 - base) * 1e6) / (R * n));
          }
          samples.sort((a, b) => a - b); per[op] = +samples[1].toFixed(3);
        }
        r.cpuPerCallUs = per;
        // Wall time per scan call seen by the client (timers cannot be read inside the isolate).
        const wallOf = async op => { const t = []; for (let k = 0; k < 15; k++) { const s = performance.now(); await (await fetch(`http://127.0.0.1:${port}/op?name=${op}&n=1`)).text(); t.push(performance.now() - s); } t.sort((a, b) => a - b); return +(t[7] * 1000).toFixed(0); };
        r.wallPerRequestUs = { noop: await wallOf('noop'), scanNoYield: await wallOf('scanNoYield'), scanYield: await wallOf('scanYield') };
      }
    } finally { await w.stop(); }
    r.stderr = w.stderr().slice(0, 2000);
    results.workerd[name] = r;
  }
}

// ---------------------------------------------------------- workerd cold start
if (!skip.has('cold') && workerd) {
  const dir = join(out, 'workerd', 'cold');
  mkdirSync(dir, { recursive: true });
  const suite = fx.contracts.find(s => s.name.includes('object-storage'));
  const c = suite.cases.find(k => k.expect && k.rule === 'request');
  const input = `const hex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));\nconst input = hex('${c.hex}');\n`;
  const entries = {
    empty: `${input}export default { async fetch() { return new Response(String(input.length)); } };`,
    import: `import * as schema from '@3sln/snug/schema';\n${input}globalThis.keep = schema;\nexport default { async fetch() { return new Response(String(input.length)); } };`,
    runtime: `import { fromSerialized } from '@3sln/snug/schema';\n${input}const program = hex('${fx.programs[suite.name]}');\n` +
      `export default { async fetch() { const s = await fromSerialized(program); const r = s.validate(input, '${c.rule}', { top: 'any' }); return new Response(r.ok ? String(input.length) : 'refused'); } };`,
    compile: `import { compile } from '@3sln/snug/compile';\n${input}const cddl = ${JSON.stringify(suite.cddl)};\n` +
      `export default { async fetch() { const s = await compile(cddl); const r = s.validate(input, '${c.rule}', { top: 'any' }); return new Response(r.ok ? String(input.length) : 'refused'); } };`,
  };
  const port = await freePort(), configs = {};
  results.cold = { rows: {}, samples: SAMPLES, port, sizes: {} };
  for (const [name, code] of Object.entries(entries)) {
    writeFileSync(join(consumer, `cold-${name}.mjs`), code);
    const d = join(dir, name); mkdirSync(d, { recursive: true });
    esb([`cold-${name}.mjs`, '--minify', `--outfile=${join(d, 'worker.js')}`]);
    configs[name] = capnp(d, [['worker.js', 'esModule']], port);
    results.cold.sizes[name] = sizeOf(join(d, 'worker.js'));
  }
  const once = async name => {
    const t0 = performance.now();
    const proc = spawn(workerd, ['serve', configs[name]], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    let err = ''; proc.stderr.on('data', d => { err += d; });
    try {
      for (;;) {
        try {
          const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
          if (body !== String(c.hex.length / 2)) throw new Error(`answered ${body}`);
          const wall = performance.now() - t0;
          return { wall, cpu: cpuSeconds(proc.pid) * 1000 };
        } catch (e) {
          if (e.message?.startsWith('answered')) throw new Error(`${name} ${e.message} ${err}`);
          if (performance.now() - t0 > 20000) throw new Error(`${name}: no answer in 20 s ${err}`);
          await sleep(2);
        }
      }
    } finally { const exited = proc.exitCode === null ? new Promise(r => proc.once('exit', r)) : null; try { process.kill(-proc.pid, 'SIGKILL'); } catch {} await exited; }
  };
  const names = Object.keys(entries), times = Object.fromEntries(names.map(n => [n, []])), cpu = Object.fromEntries(names.map(n => [n, []]));
  log('cold start:', SAMPLES, 'samples per worker');
  for (const n of names) await once(n); // warm OS caches
  for (let s = 0; s < SAMPLES; s++) for (const n of names.map((_, i) => names[(i + s) % names.length])) { const r = await once(n); times[n].push(r.wall); cpu[n].push(r.cpu); }
  const median = a => { const x = [...a].sort((p, q) => p - q); return x[(x.length - 1) >> 1]; };
  for (const n of names) results.cold.rows[n] = { median: +median(times[n]).toFixed(1), min: +Math.min(...times[n]).toFixed(1),
    max: +Math.max(...times[n]).toFixed(1), minusEmpty: +(median(times[n]) - median(times.empty)).toFixed(1), all: times[n].map(t => +t.toFixed(1)),
    cpuMedian: +median(cpu[n]).toFixed(0), cpuMinusEmpty: +(median(cpu[n]) - median(cpu.empty)).toFixed(0), cpuAll: cpu[n].map(t => +t.toFixed(0)) };
}

results.env.loadAverageAtEnd = loadavg().map(x => +x.toFixed(1));
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1));

// ------------------------------------------------------------------- summary
const md = [];
const totals = r => r?.totals ? `${r.totals.pass} / ${r.totals.fail}` : `FATAL ${r?.fatal ?? 'missing'}`;
md.push(`Environment: ${results.env.machine}; ${results.env.os}; Node ${results.env.node}; esbuild ${results.env.esbuild}; ${results.env.chrome}; ${results.env.workerd}; package staged from ${results.env.commit} (dirty package sources: ${results.env.dirtyPackageSources}); load average ${results.env.loadAverageAtStart.join('/')} at start, ${results.env.loadAverageAtEnd.join('/')} at end.`, '');
const arms = [['Node (fresh consumer dir)', results.node?.compiled, results.node?.precompiled],
  ['Chrome headless, strict CSP', results.browser?.compiled, results.browser?.precompiled],
  ['workerd, split bundle (lazy compiler chunk)', results.workerd?.['worker-split']?.compiled, results.workerd?.['worker-split']?.precompiled],
  ['workerd, one-file bundle (compiler inlined)', results.workerd?.['worker-eager']?.compiled, results.workerd?.['worker-eager']?.precompiled],
  ['workerd, no compiler (fromSerialized only)', null, results.workerd?.['worker-precompiled']?.precompiled]];
md.push('| runtime | compile arm pass / fail | precompiled arm pass / fail |', '| --- | ---: | ---: |');
for (const [label, a, b] of arms) md.push(`| ${label} | ${a === null ? '—' : totals(a)} | ${totals(b)} |`);
md.push('');
const groupNames = Object.keys(results.node.compiled.groups);
md.push('| group (compile arm) | Node pass/fail, ms | Chrome pass/fail, ms | workerd pass/fail |', '| --- | ---: | ---: | ---: |');
for (const g of groupNames) {
  const cell = (r, ms = true) => { const x = r?.groups?.[g]; return x ? `${x.pass}/${x.fail}${ms ? `, ${x.ms.toFixed(1)}` : ''}` : '—'; };
  md.push(`| ${g} | ${cell(results.node.compiled)} | ${cell(results.browser?.compiled)} | ${cell(results.workerd?.['worker-split']?.compiled, false)} |`);
}
md.push('');
const fails = [];
for (const [label, a, b] of arms) for (const r of [a, b]) for (const [g, x] of Object.entries(r?.groups ?? {})) for (const f of x.failures) fails.push(`${label} / ${g}: ${f}`);
if (fails.length) md.push('Failures:', ...fails.map(f => `- ${f}`), '');
md.push('| bundle (esbuild --minify) | raw | gzip -9 | brotli 11 |', '| --- | ---: | ---: | ---: |');
for (const s of results.sizes) md.push(`| ${s.label} | ${s.raw.toLocaleString('en')} | ${s.gzip.toLocaleString('en')} | ${s.brotli.toLocaleString('en')} |`);
md.push('');
md.push(`Code scan (${results.codeScan.files} bundle files, ${results.codeScan.bytes.toLocaleString('en')} bytes; package src+generated): ` +
  Object.entries(results.codeScan.hits).map(([k, v]) => `${k} ${v.length} (source ${results.codeScan.packageSourceHits[k].length})`).join('; '), '');
if (results.browser?.yieldMsPerYield) md.push(`Chrome, ms per chained yield: ${Object.entries(results.browser.yieldMsPerYield).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
if (results.browser) md.push(`Browser: ${results.browser.userAgent}; crossOriginIsolated ${results.browser.crossOriginIsolated}; eval blocked ${results.browser.evalBlocked}; new Function blocked ${results.browser.functionBlocked}; CSP violations ${results.browser.violations?.length} (reports ${results.browser.cspReports?.length}); errors ${results.browser.errors?.length}; Float16Array ${results.browser.float16}.`, '');
const cpuOps = Object.keys(results.node.cpuPerCallUs ?? {});
if (cpuOps.length) {
  md.push('| op | Node CPU µs/call | Node wall µs/call | workerd CPU µs/call | workerd wall µs/request (client) | Chrome wall µs/call |', '| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const op of cpuOps) md.push(`| ${op} | ${results.node.cpuPerCallUs[op]} | ${results.node.wallPerCallUs[op]} | ${results.workerd?.['worker-split']?.cpuPerCallUs?.[op] ?? '—'} | ${results.workerd?.['worker-split']?.wallPerRequestUs?.[op] ?? '—'} | ${results.browser?.perCallUs?.[op] ?? '—'} |`);
  md.push('', `scanYield yields ${results.yields} times per call (quantum 1000 over a ${'~200 KB'} document).`, '');
}
if (results.cold) {
  md.push('| cold worker | min+gzip | wall median ms | min ms | max ms | median − empty | process CPU median ms | CPU − empty |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [n, r] of Object.entries(results.cold.rows)) md.push(`| ${n} | ${results.cold.sizes[n].gzip.toLocaleString('en')} | ${r.median} | ${r.min} | ${r.max} | ${r.minusEmpty} | ${r.cpuMedian} | ${r.cpuMinusEmpty} |`);
  md.push('');
}
console.log(md.join('\n'));
log('results:', join(out, 'results.json'));
// P9.13 WP3 (B1): exit 1 on any failing case, fatal, missing arm or totals, scan hit, CSP violation or page error
const problems = verdict(results, { browser: !skip.has('browser'), workerd: !skip.has('workerd') });
for (const q of problems) console.log(`  FAIL ${q}`);
console.log(problems.length ? `  FAIL runtime: ${problems.length} problem(s)` : '  ok   runtime');
process.exit(problems.length ? 1 : 0);
