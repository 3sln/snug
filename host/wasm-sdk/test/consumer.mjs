// P9.17 (D345): the @3sln/snug-wasm consumer smoke test, run by `bb wasm-package-test`
// after package.test.mjs. Everything happens in a fresh .cache/wasm-package-test/
// directory, offline, and nothing is published:
//
//   pack       the staged package: `npm pack --dry-run` (the file list, printed)
//              and `npm pack` (the tarball: size and SHA-256, printed)
//   install    the tarball into a scratch project (`npm install --offline`, a
//              private npm cache under the scratch directory)
//   loaders    one fresh Node process per loader: init() with nothing, a relative
//              and an absolute path, a file: URL and string, an http URL served as
//              application/wasm (streaming) and as octet-stream, a Response and a
//              promise of one, Uint8Array / ArrayBuffer / Buffer bytes, a
//              WebAssembly.Module (init and initSync), initSync with bytes,
//              compilerSource, the inline entry (initSync and init); each then
//              compiles and validates; and the loader errors
//   workerd    docs/wasm-sdk.md's Workers recipe (copied from the page) bundled by
//              esbuild with its .wasm imports kept as modules, and by
//              `wrangler deploy --dry-run` when wrangler is on the PATH; the
//              inline entry with initSync() at module scope; and the refusal to
//              compile from bytes inside a request (the page says so)
//   chrome     headless Chrome under script-src 'self' 'wasm-unsafe-eval': the
//              inline entry's initSync() on the main thread and in a dedicated
//              worker, init(url) streaming and init() with nothing in workers
//
// workerd (SNUG_WORKERD) or Chrome (SNUG_CHROME) missing: that arm prints SKIP,
// which `bb gates` counts as not run. Exit 1 on any failure.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildPackage } from '../package-build.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RELEASE = process.env.SNUG_WASM_RELEASE ?? join(ROOT, '.cache/release/wasm');
const KEEP = process.argv.includes('--keep');
const scratch = join(ROOT, `.cache/wasm-package-test/consumer-${process.pid}`);
const run = promisify(execFile);
const HOME = process.env.HOME;
const firstExisting = (...paths) => paths.find(p => p && existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (name, detail = '') => console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`);
const fail = (name, e) => { failures++; console.log(`  FAIL ${name}\n       ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n       ')}`); };
async function check(name, f) { try { const d = await f(); ok(name, d); } catch (e) { fail(name, e); } }

rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const npmEnv = { ...process.env, npm_config_cache: join(scratch, 'npm-cache'), npm_config_update_notifier: 'false',
  npm_config_fund: 'false', npm_config_audit: 'false' };
const servers = [];
const workerd = nativeWorkerd(firstExisting(process.env.SNUG_WORKERD, `${HOME}/Projects/@3sln/3sln.me/node_modules/.bin/workerd`,
  `${HOME}/.bun/install/global/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd`));

try {
  // ------------------------------------------------------------------ pack
  const pkgDir = buildPackage(join(scratch, 'package'), { wasm: RELEASE });
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  console.log(`${pkg.name}@${pkg.version}: npm pack --dry-run`);
  const [dry] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: pkgDir, env: npmEnv, encoding: 'utf8' }));
  for (const f of dry.files.sort((a, b) => a.path.localeCompare(b.path))) console.log(`  ${String(f.size).padStart(8)}  ${f.path}`);
  console.log(`  ${dry.entryCount} files, unpacked ${dry.unpackedSize} B, packed ${dry.size} B`);
  await check('npm pack --dry-run lists exactly the staged files', () => {
    const staged = readdirSync(pkgDir, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
      .map(e => join(e.parentPath ?? e.path, e.name).slice(pkgDir.length + 1)).sort();
    assert.deepEqual(dry.files.map(f => f.path).sort(), staged);
  });
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', scratch], { cwd: pkgDir, env: npmEnv, encoding: 'utf8' }))[0];
  const tarball = join(scratch, packed.filename), tgz = readFileSync(tarball);
  console.log(`npm pack: ${packed.filename}, ${tgz.length} B, sha256 ${createHash('sha256').update(tgz).digest('hex')}`);

  // ------------------------------------------------------------------ install
  const project = join(scratch, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'snug-wasm-consumer', private: true, type: 'module' }, null, 2));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-package-lock', tarball], { cwd: project, env: npmEnv, stdio: ['ignore', 'ignore', 'inherit'] });
  const installed = join(project, 'node_modules', ...pkg.name.split('/'));
  await check('installed from the tarball', () => {
    assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, pkg.version);
    assert.ok(readFileSync(join(installed, 'wasm/snug.wasm')).equals(readFileSync(join(RELEASE, 'snug.wasm'))));
  });

  // ------------------------------------------------------------------ loaders (Node)
  console.log('loaders (Node, one process each)');
  const http = await serve(join(installed, 'wasm'), (req, file) => req.url.startsWith('/octet/') ? 'application/octet-stream' : 'application/wasm', u => u.replace(/^\/(octet|wasm)\//, '/'));
  const n = pkg.name, W = 'node_modules/' + n + '/wasm/';
  const prelude = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    import * as W from '${n}';
    import { compile, compilerSource } from '${n}/compile';
    const PKG = new URL('./${W}', import.meta.url), BASE = '${http.base}';
    const rt = () => readFileSync(new URL('snug.wasm', PKG)), cc = () => readFileSync(new URL('snug-compiler.wasm', PKG));
  `;
  const verify = `
    const s = await compile('r = { id: uint, ? name: tstr }');
    assert.deepEqual(s.validate(W.encode({ id: 7, name: 'x' }), 'r'), { ok: true });
    assert.equal(s.validate(W.encode({ id: 'x' }), 'r').reason, 'type');
    console.log('validated');
  `;
  const loaders = {
    'init() with nothing: the package\'s wasm/': `await W.init();`,
    'a relative path (Node)': `await W.init('${W}snug.wasm'); compilerSource('${W}snug-compiler.wasm');`,
    'an absolute path (Node)': `await W.init(fileURLToPath(new URL('snug.wasm', PKG))); compilerSource(fileURLToPath(new URL('snug-compiler.wasm', PKG)));`,
    'a file: URL and a file: string': `await W.init({ runtime: new URL('snug.wasm', PKG), compiler: new URL('snug-compiler.wasm', PKG).href });`,
    'an http URL, application/wasm (streaming)': `await W.init({ runtime: BASE + '/wasm/snug.wasm', compiler: new URL(BASE + '/wasm/snug-compiler.wasm') });`,
    'an http URL, application/octet-stream': `await W.init(BASE + '/octet/snug.wasm'); compilerSource(BASE + '/octet/snug-compiler.wasm');`,
    'a Response and a promise of one': `await W.init(await fetch(BASE + '/wasm/snug.wasm')); compilerSource(fetch(BASE + '/wasm/snug-compiler.wasm'));`,
    'bytes: Uint8Array and ArrayBuffer': `const c = cc(); await W.init({ runtime: new Uint8Array(rt()), compiler: c.buffer.slice(c.byteOffset, c.byteOffset + c.length) });`,
    'bytes: a Node Buffer': `await W.init(rt()); compilerSource(cc());`,
    'a WebAssembly.Module (init)': `await W.init({ runtime: await WebAssembly.compile(rt()), compiler: await WebAssembly.compile(cc()) });`,
    'a WebAssembly.Module (initSync)': `W.initSync({ runtime: new WebAssembly.Module(rt()), compiler: new WebAssembly.Module(cc()) });`,
    'initSync with bytes': `W.initSync({ runtime: rt(), compiler: cc() });`,
    'the inline entry, initSync()': `const I = await import('${n}/inline'); I.initSync(); I.initSync(); assert.equal(I.encode, W.encode);`,
    'the inline entry, await init()': `const I = await import('${n}/inline'); await I.init();`,
  };
  const nodeFile = async (name, code) => {
    const f = join(project, `loader-${name.replace(/[^a-z0-9]+/gi, '-')}.mjs`);
    writeFileSync(f, code);
    const { stdout } = await run(process.execPath, [f], { cwd: project, timeout: 60000 }).catch(e => { throw new Error((e.stderr || e.message).trim()); });
    return stdout;
  };
  for (const [name, code] of Object.entries(loaders))
    await check(name, async () => assert.match(await nodeFile(name, prelude + code + verify), /validated/));
  await check('loader errors: initSync without a module, with a URL; init with HTTP 404, an unknown option, a number', async () =>
    assert.match(await nodeFile('errors', prelude + `
      assert.throws(() => W.initSync(), /initSync needs the runtime module/);
      assert.throws(() => W.initSync('${W}snug.wasm'), /initSync takes a WebAssembly.Module or bytes/);
      await assert.rejects(W.init(BASE + '/wasm/nothing.wasm'), /HTTP 404/);
      await assert.rejects(W.init({ runtime: rt(), nope: 1 }), /unknown init option "nope"/);
      await assert.rejects(W.init(7), TypeError);
      assert.throws(() => W.encode(1), /call init\\(\\) first/);
      const I = await import('${n}/inline');
      assert.throws(() => I.initSync(rt()), /take no argument/);
      console.log('validated');`), /validated/));

  // ------------------------------------------------------------------ workerd
  if (!workerd) console.log('SKIP workerd arm -- no workerd (SNUG_WORKERD): the Workers recipe NOT run');
  else {
    console.log(`workerd: ${execFileSync(workerd, ['--version'], { encoding: 'utf8' }).trim()} (${workerd})`);
    const doc = readFileSync(join(ROOT, 'docs/wasm-sdk.md'), 'utf8');
    const block = first => {
      const m = [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(x => x[1]).find(b => b.startsWith(first + '\n'));
      assert.ok(m, `docs/wasm-sdk.md has no code block starting ${JSON.stringify(first)}`);
      return m;
    };
    const recipe = join(scratch, 'worker');
    mkdirSync(join(recipe, 'src'), { recursive: true });
    cpSync(join(project, 'node_modules'), join(recipe, 'node_modules'), { recursive: true });
    writeFileSync(join(recipe, 'src/worker.js'), block('// src/worker.js'));
    writeFileSync(join(recipe, 'wrangler.toml'), block('# wrangler.toml'));
    writeFileSync(join(recipe, 'src/inline.js'), `
      import { initSync, encode } from '${n}/inline';
      import { compile } from '${n}/compile';
      initSync();   // module scope: synchronous compile from bytes is allowed here
      export default { async fetch() {
        const s = await compile('r = { id: uint }');
        return Response.json([s.validate(encode({ id: 7 }), 'r'), s.validate(encode({ id: 'x' }), 'r')]);
      } };`);
    writeFileSync(join(recipe, 'src/refused.js'), `
      import bytes from './snug.bin';
      import { init } from '${n}';
      export default { async fetch() {
        try { await init(new Uint8Array(bytes)); return new Response('compiled'); }
        catch (e) { return new Response(String(e)); }
      } };`);
    cpSync(join(installed, 'wasm/snug.wasm'), join(recipe, 'src/snug.bin'));
    const I = await import(join(installed, 'src/inline.mjs'));
    I.initSync();
    const good = I.encode({ id: 7, name: 'snug' }), bad = I.encode({ id: -1 });
    const esb = join(recipe, 'esbuild');
    await bundle(join(recipe, 'src/worker.js'), join(esb, 'worker'));
    await bundle(join(recipe, 'src/inline.js'), join(esb, 'inline'));
    await bundle(join(recipe, 'src/refused.js'), join(esb, 'refused'));
    await check('workerd: the docs recipe (esbuild bundle, .wasm module bindings), validate and compile in a request', async () => {
      const r = await inWorkerd(join(esb, 'worker'), async base => {
        const a = await fetch(base, { method: 'POST', body: good }), b = await fetch(base, { method: 'POST', body: bad });
        return [a.status, await a.json(), b.status, await b.json()];
      });
      assert.deepEqual(r, [200, { ok: true }, 422, { ok: false, reason: 'type', path: ['id'], offset: 4 }]);
      return `${size(join(esb, 'worker'))}`;
    });
    await check('workerd: the inline entry, initSync() at module scope, compile in a request', async () => {
      const r = await inWorkerd(join(esb, 'inline'), async base => (await fetch(base)).json());
      assert.deepEqual(r, [{ ok: true }, { ok: false, reason: 'type', path: ['id'], offset: 4 }]);
      return `${size(join(esb, 'inline'))}`;
    });
    await check('workerd: compiling from bytes inside a request is refused (as docs/wasm-sdk.md says)', async () => {
      const r = await inWorkerd(join(esb, 'refused'), async base => (await fetch(base)).text(), { data: ['snug.bin', join(recipe, 'src/snug.bin')] });
      assert.match(r, /Wasm code generation disallowed by embedder/);
      return JSON.stringify(r.slice(0, 80));
    });
    const wrangler = firstExisting(process.env.SNUG_WRANGLER, ...String(process.env.PATH).split(':').map(d => join(d, 'wrangler')));
    if (!wrangler) console.log('  note wrangler is not on the PATH: the wrangler bundling arm was not run (the esbuild bundle above stands in for it)');
    else await check('workerd: the docs recipe bundled by `wrangler deploy --dry-run` (offline, nothing deployed)', async () => {
      const out = join(recipe, 'wrangler-out');
      const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(recipe, 'wrangler-logs'),
        CI: '1', NO_UPDATE_NOTIFIER: '1', XDG_CONFIG_HOME: join(recipe, 'xdg') };
      const { stdout } = await run(wrangler, ['deploy', '--dry-run', '--outdir', out], { cwd: recipe, env, timeout: 180000 });
      const version = (await run(wrangler, ['--version'], { cwd: recipe, env })).stdout.trim();
      const upload = stdout.match(/Total Upload: ([^\n]+)/)?.[1];
      const r = await inWorkerd(out, async base => {
        const a = await fetch(base, { method: 'POST', body: good }), b = await fetch(base, { method: 'POST', body: bad });
        return [a.status, (await a.json()).ok, b.status, (await b.json()).reason];
      });
      assert.deepEqual(r, [200, true, 422, 'type']);
      return `wrangler ${version}; upload ${upload}`;
    });
  }

  // ------------------------------------------------------------------ Chrome
  const chrome = firstExisting(process.env.SNUG_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  if (!chrome) console.log('SKIP chrome arm -- no Chrome (SNUG_CHROME): browser init NOT run');
  else await check(`chrome: ${execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim()}, CSP script-src 'self' 'wasm-unsafe-eval'`, async () => {
    const r = await inChrome(chrome, project, n);
    assert.deepEqual(r, {
      'main thread: inline initSync()': 'ok', 'worker: inline initSync()': 'ok',
      'worker: init(url), streaming': 'ok', 'worker: init() with nothing': 'ok',
    });
    return 'main thread and dedicated workers';
  });
} catch (e) { fail('consumer smoke', e); }
finally {
  for (const s of servers) s.close();
  if (!KEEP) rmSync(scratch, { recursive: true, force: true });
}
console.log(failures ? `FAIL wasm package consumer smoke: ${failures} failure(s)` : 'wasm package consumer smoke: all passed');
process.exit(failures ? 1 : 0);

// ------------------------------------------------------------------ helpers

function serve(dir, typeOf, map = u => u, headers = {}) {
  const server = createServer((req, res) => {
    const path = join(dir, decodeURIComponent(map(new URL(req.url, 'http://x').pathname)));
    if (req.method === 'POST') { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { res.writeHead(204).end(); server.emit('result', b); }); return; }
    if (!path.startsWith(dir) || !existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404, headers).end(); return; }
    res.writeHead(200, { ...headers, 'Content-Type': typeOf(req, path) }).end(readFileSync(path));
  });
  servers.push(server);
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

function nativeWorkerd(p) {
  if (!p) return p;
  p = realpathSync(p);
  if (!readFileSync(p).subarray(0, 2).equals(Buffer.from('#!'))) return p;
  const native = resolve(p, '../../../@cloudflare', `workerd-${process.platform}-${process.arch}`, 'bin/workerd');
  return existsSync(native) ? native : p;
}

/** esbuild, as wrangler bundles: ESM, every .wasm import kept as a module next to the bundle. */
async function bundle(entry, outdir) {
  const { build } = await import(join(ROOT, 'bench/compare/node_modules/esbuild/lib/main.js'));
  mkdirSync(outdir, { recursive: true });
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', minify: true,
    outfile: join(outdir, 'worker.js'), logLevel: 'error', mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'],
    external: ['./snug.bin'],
    plugins: [{ name: 'wasm-modules', setup(b) {
      b.onResolve({ filter: /\.wasm$/ }, async args => {
        if (args.pluginData === 1) return undefined;
        const r = await b.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: 1 });
        cpSync(r.path, join(outdir, basename(r.path)));
        return { path: './' + basename(r.path), external: true };
      });
    } }] });
}
function size(dir) {
  return readdirSync(dir).filter(f => /\.(js|wasm)$/.test(f)).map(f => `${f} ${statSync(join(dir, f)).size} B`).join(', ');
}

/** Serve dir's modules (worker.js or index.js, every .wasm) in workerd on loopback; run f(base); stop. */
async function inWorkerd(dir, f, { data } = {}) {
  const main = existsSync(join(dir, 'worker.js')) ? 'worker.js' : 'index.js';
  const mods = [`(name = "${main}", esModule = embed "${main}")`,
    ...readdirSync(dir).filter(x => x.endsWith('.wasm')).map(x => `(name = "${x}", wasm = embed "${x}")`)];
  if (data) { cpSync(data[1], join(dir, data[0])); mods.push(`(name = "${data[0]}", data = embed "${data[0]}")`); }
  const port = 20000 + Math.floor(Math.random() * 20000);
  writeFileSync(join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = ( services = [ (name = "main", worker = .w) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "main") ] );
const w :Workerd.Worker = ( modules = [ ${mods.join(', ')} ], compatibilityDate = "2025-12-01" );
`);
  const proc = spawn(workerd, ['serve', join(dir, 'config.capnp')], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; proc.stderr.on('data', d => { err += d; });
  const base = `http://127.0.0.1:${port}/`;
  try {
    for (let t = 0; ; t += 50) {
      try { await fetch(base, { method: 'HEAD' }); break; }
      catch { if (t > 20000 || proc.exitCode !== null) throw new Error(`workerd did not answer: ${err}`); await sleep(50); }
    }
    return await f(base);
  } finally {
    const exited = proc.exitCode === null ? new Promise(r => proc.once('exit', r)) : null;
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    await exited;
  }
}

/** The package, unbundled, in headless Chrome: the main thread and three dedicated module workers. */
async function inChrome(chrome, project, name) {
  const site = join(project, 'site');
  mkdirSync(site, { recursive: true });
  const pkgPath = `/node_modules/${name}`;
  const job = (label, code) => `
    try { ${code}
      const { compile } = await import('${pkgPath}/src/compile.mjs');
      const s = await compile('r = { id: uint }');
      if (!s.validate(W.encode({ id: 7 }), 'r').ok || s.validate(W.encode({ id: 'x' }), 'r').ok) throw new Error('wrong verdict');
      result[${JSON.stringify(label)}] = 'ok';
    } catch (e) { result[${JSON.stringify(label)}] = String(e); }`;
  const worker = (label, code) => `const result = {};\n${job(label, code)}\npostMessage(result);\n`;
  writeFileSync(join(site, 'w1.js'), worker('worker: inline initSync()', `const W = await import('${pkgPath}/src/inline.mjs'); W.initSync();`));
  writeFileSync(join(site, 'w2.js'), worker('worker: init(url), streaming', `const W = await import('${pkgPath}/src/public-index.mjs');
      await W.init({ runtime: new URL('${pkgPath}/wasm/snug.wasm', location.href), compiler: '${pkgPath}/wasm/snug-compiler.wasm' });`));
  writeFileSync(join(site, 'w3.js'), worker('worker: init() with nothing', `const W = await import('${pkgPath}/src/public-index.mjs'); await W.init();`));
  writeFileSync(join(site, 'main.js'), `const result = {};
    ${job('main thread: inline initSync()', `const W = await import('${pkgPath}/src/inline.mjs'); W.initSync();`)}
    for (const w of ['w1.js', 'w2.js', 'w3.js'])
      Object.assign(result, await new Promise(r => { const k = new Worker('/' + w, { type: 'module' }); k.onmessage = e => r(e.data); k.onerror = e => r({ [w]: String(e.message) }); }));
    await fetch('/result', { method: 'POST', body: JSON.stringify(result) });`);
  writeFileSync(join(site, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="/main.js"></script>');
  const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'";
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
  const { server, base } = await serve(project, (req, p) => types[extname(p)] ?? 'application/octet-stream',
    u => (u === '/' ? '/site/index.html' : u.startsWith('/node_modules/') ? u : '/site' + u), { 'Content-Security-Policy': CSP });
  const result = new Promise(r => server.once('result', b => r(JSON.parse(b))));
  const profile = join(scratch, 'chrome-profile');
  const proc = spawn(chrome, ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings',
    '--disable-default-apps', base + '/'], { stdio: 'ignore', detached: true });
  try { return await Promise.race([result, sleep(120000).then(() => { throw new Error('no result from Chrome in 120 s'); })]); }
  finally {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    await Promise.race([new Promise(r => proc.once('exit', r)), sleep(3000)]);
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
  }
}
