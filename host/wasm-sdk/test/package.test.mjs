// P9.17 (D345): the staged @3sln/snug-wasm package (host/wasm-sdk/package-build.mjs).
// Run by `bb wasm-package-test` after kin/scripts/wasm-release.mjs has staged the
// modules (SNUG_WASM_RELEASE, default .cache/release/wasm):
//
//   files      nothing outside PACKAGE_FILES; every listed doc; no dangling
//              Markdown link; no path back into the checkout; the native
//              compiler is not in the code (the SDK compiles in wasm)
//   metadata   name, private, MIT, no dependencies, the version site's version
//              (the same as the native package's and SNUG_VERSION), engines
//   wasm       the modules are the release artefacts byte for byte; the inline
//              entry's base64 decodes to the same bytes
//   types      every declaration parses (Node's type stripper) and declares
//              exactly the entry's runtime exports
//   imports    every entry by bare specifier from a consumer directory (Node),
//              with a validate through each; deep imports refused
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPackage, PACKAGE_FILES, packageAllows } from '../package-build.mjs';
import { readRelease } from '../../../kin/scripts/wasm-release.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RELEASE = process.env.SNUG_WASM_RELEASE ?? join(ROOT, '.cache/release/wasm');
const scratch = join(ROOT, `.cache/wasm-package-test/package-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const target = buildPackage(join(scratch, 'package'), { wasm: RELEASE });
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
const shipped = readdirSync(target, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
  .map(e => join(e.parentPath ?? e.path, e.name).slice(target.length + 1).split(sep).join('/')).sort();
const specifier = key => key === '.' ? pkg.name : pkg.name + key.slice(1);
const codeEntries = Object.entries(pkg.exports).filter(([, v]) => typeof v === 'object');

test('files: the allowlist, every listed document, no dangling link, nothing from the checkout', () => {
  assert.deepEqual(shipped.filter(p => !packageAllows(p)), [], 'files outside the package allowlist');
  for (const name of PACKAGE_FILES.root)
    if (name !== 'SECURITY.md' || existsSync(join(ROOT, 'SECURITY.md'))) assert.ok(shipped.includes(name), name);
  for (const d of PACKAGE_FILES.docs) assert.ok(shipped.includes('docs/' + d), d);
  for (const w of PACKAGE_FILES.wasm) assert.ok(shipped.includes('wasm/' + w), w);
  assert.ok(!shipped.some(p => /(^|\/)(DEVLOG|SPEC)\.md$|^bench\/|^corpus\/|^tools\/|^docs\/reviews\/|package-build|\.test\.mjs$/.test(p)));
  for (const md of shipped.filter(p => p.endsWith('.md')))
    for (const [, href] of readFileSync(join(target, md), 'utf8').matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g))
      if (!/^[a-z]+:/i.test(href)) assert.ok(existsSync(join(target, dirname(md), href)), `${md} links to ${href}`);
  for (const code of shipped.filter(p => /\.(mjs|d\.ts)$/.test(p))) {
    const text = readFileSync(join(target, code), 'utf8');
    assert.ok(!/['"][^'"\n]*(\.\.\/\.\.\/(js|\.\.)\/|gen\/js\/|\.cache\/)[^'"\n]*['"]/.test(text), `${code} points back into the checkout`);
    for (const [, spec] of text.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"](\.[^'"]+)['"]/g)) {
      const dep = join(target, dirname(code), code.endsWith('.d.ts') ? spec.replace(/\.js$/, '.d.ts') : spec);
      assert.ok(existsSync(dep), `${code} imports ${spec}`);
    }
  }
  // the SDK compiles in wasm: neither the native compiler nor its lazy loader ships
  assert.deepEqual(shipped.filter(p => /^generated\/snug\/(compile|program)\/|^native\/(public-)?compile|^native\/compile-runtime/.test(p)), []);
});

test('metadata: name, private, licence, no dependencies, the version site, engines', async () => {
  assert.equal(pkg.name, '@3sln/snug-wasm');
  assert.equal(pkg.private, true); assert.equal(pkg.license, 'MIT'); assert.equal(pkg.type, 'module');
  assert.equal(pkg.scripts, undefined); assert.equal(pkg.dependencies, undefined); assert.equal(pkg.devDependencies, undefined);
  const native = JSON.parse(readFileSync(join(ROOT, 'host/js/package.json'), 'utf8'));
  const sdk = JSON.parse(readFileSync(join(ROOT, 'host/wasm-sdk/package.json'), 'utf8'));
  const { SNUG_VERSION } = await import(join(target, 'native/version.mjs'));
  assert.equal(pkg.version, sdk.version, 'the staged version is the version site\'s, unstamped');
  assert.equal(pkg.version, native.version); assert.equal(pkg.version, SNUG_VERSION);
  assert.deepEqual(pkg.engines, sdk.engines ?? native.engines);
  for (const [key, v] of Object.entries(pkg.exports)) {
    const files = typeof v === 'string' ? [v] : [v.default, v.types];
    for (const f of files) assert.ok(existsSync(join(target, f)), `${key}: ${f}`);
  }
});

test('wasm: the release artefacts byte for byte, and the inline entry\'s copies', async () => {
  const release = readRelease(RELEASE);
  for (const [file, bytes] of Object.entries(release.modules)) {
    assert.ok(readFileSync(join(target, 'wasm', file)).equals(bytes), file);
    assert.ok(WebAssembly.validate(bytes), file);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(target, 'wasm/MANIFEST.json'), 'utf8')), release.manifest);
  const inline = await import(join(target, 'src/inline-wasm.mjs'));
  assert.ok(Buffer.from(inline.RUNTIME_BASE64, 'base64').equals(release.modules['snug.wasm']));
  assert.ok(Buffer.from(inline.COMPILER_BASE64, 'base64').equals(release.modules['snug-compiler.wasm']));
});

/** The value names a declaration file exports, following `export *` and `export { .. } from`. */
function declared(path, seen = new Set()) {
  if (seen.has(path)) return new Set();
  seen.add(path);
  const source = readFileSync(path, 'utf8'), names = new Set();
  assert.doesNotThrow(() => stripTypeScriptTypes(source), path);
  for (const [, n] of source.matchAll(/export declare (?:class|function|const) (\w+)/g)) names.add(n);
  for (const [, spec] of source.matchAll(/export \* from '([^']+)'/g))
    for (const n of declared(join(dirname(path), spec.replace(/\.js$/, '.d.ts')), seen)) names.add(n);
  for (const [, list] of source.matchAll(/export \{([^}]*)\} from/g))
    for (const n of list.split(',').map(s => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)) names.add(n);
  return names;
}

test('types: every declaration parses and declares exactly its entry\'s runtime exports', async () => {
  for (const [key, entry] of codeEntries) {
    const names = [...declared(join(target, entry.types))].sort();
    const module = await import(join(target, entry.default));
    assert.deepEqual(names, Object.keys(module).sort(), key);
  }
});

test('imports: every entry by bare specifier from a consumer directory, a validate through each', () => {
  const consumer = join(scratch, 'consumer');
  cpSync(target, join(consumer, 'node_modules', ...pkg.name.split('/')), { recursive: true });
  writeFileSync(join(consumer, 'package.json'), '{ "type": "module", "private": true }\n');
  const n = pkg.name;
  const smoke = `
    import assert from 'node:assert/strict';
    import * as root from '${n}';
    import { compile, SchemaError, compilerSource, releaseCompiler, compilerMemoryBytes } from '${n}/compile';
    import { fromSerialized, fromSerializedSync, validate, decode as schemaDecode, validateAt, Program, Schema } from '${n}/schema';
    import { view, View, Cursor } from '${n}/view';
    import { Writer } from '${n}/writer';
    import { tables } from '${n}/unicode';
    import { bufferHandle, asyncHandle, scanHandle, validateHandle, validateHandleSync, pushValidator, openSession } from '${n}/sources';
    import { readSequence } from '${n}/sequence';
    import { controls, chars } from '${n}/controls';
    import { abnf } from '${n}/abnf';
    import * as inline from '${n}/inline';
    assert.throws(() => root.encode({}).length && root.decode(Uint8Array.of(1)), /init/);
    await root.init();
    const s = await compile('r = { id: uint, ? name: tstr .chars (1..10) }', { controls });
    const b = root.encode({ id: 7 }), bad = root.encode({ id: 'x' });
    assert.deepEqual(validate(s, b, 'r'), { ok: true });
    assert.equal(validate(s, bad, 'r').reason, 'type');
    assert.equal(schemaDecode(s, b, 'r').id, 7);
    assert.equal(root.decode(b).id, 7);
    assert.deepEqual(validateAt(s, b, 0, b.length, 'r'), { ok: true });
    const v = view(b, { schema: s, rule: 'r' });
    assert.ok(v instanceof View && v.cursor() instanceof Cursor);
    assert.deepEqual(new Writer().beginMap(1).key('id').uint(7).end().finish(), b);
    assert.deepEqual((await fromSerialized(s.program.serialize(), { controls })).validate(b, 'r'), { ok: true });
    assert.deepEqual(fromSerializedSync(s.program.serialize(), { controls }).validate(b, 'r'), { ok: true });
    assert.ok(s instanceof Schema && s.program instanceof Program);
    assert.equal(await scanHandle(asyncHandle(b)), true);
    assert.deepEqual(await validateHandle(s, asyncHandle(b), 'r'), { ok: true });
    assert.deepEqual(validateHandleSync(s, bufferHandle(b), 'r'), { ok: true });
    const push = pushValidator(s, b.length, 'r'); push.feed(b); assert.deepEqual(push.finalize(), { ok: true });
    assert.deepEqual(openSession(s, 'r', b.length).step(b, 0), { state: 'done', result: { ok: true } });
    let count = 0; for await (const m of readSequence([new Uint8Array([...b, ...b])], { schema: s, rule: 'r' })) count++;
    assert.equal(count, 2);
    const u = await compile('r = tstr .regexp "\\\\\\\\p{Lu}+"', { unicode: tables });
    assert.deepEqual(u.validate(root.encode('AB'), 'r'), { ok: true });
    assert.equal(u.validate(root.encode('ab'), 'r').reason, 'pattern');
    const a = await compile("r = text .abnf h'${Buffer.from('x\nx = %x61 %x62\n').toString('hex')}'", { controls: abnf });
    assert.deepEqual(a.validate(root.encode('ab'), 'r'), { ok: true });
    assert.equal(a.validate(root.encode('ac'), 'r').ok, false);
    await assert.rejects(compile('r = nope'), e => e instanceof SchemaError && e.code === 'undefined_name');
    assert.ok(compilerMemoryBytes() > 0); releaseCompiler(); assert.equal(compilerMemoryBytes(), 0);
    assert.equal(typeof compilerSource, 'function'); assert.equal(typeof chars.check, 'function');
    assert.ok(root.memoryBytes() > 0); root.trim(); root.reset();
    assert.deepEqual(validate(s, b, 'r'), { ok: true });
    // the inline entry: the root's surface with its own init, initSync
    assert.deepEqual(Object.keys(inline).sort(), Object.keys(root).sort());
    inline.initSync();
    assert.deepEqual(inline.encode({ id: 7 }), b);
    for (const deep of ['${n}/src/index.mjs', '${n}/native/fault.mjs', '${n}/src/inline-wasm.mjs', '${n}/wasm/MANIFEST.json'])
      await assert.rejects(import(deep), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }, deep);
    console.log('imports ok');
  `;
  writeFileSync(join(consumer, 'smoke.mjs'), smoke);
  const child = spawnSync(process.execPath, ['smoke.mjs'], { cwd: consumer, encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.match(child.stdout, /imports ok/);
});

test('the build refuses an existing destination and a destination outside .cache/', () => {
  assert.throws(() => buildPackage(target, { wasm: RELEASE }), { code: 'EEXIST' });
  assert.throws(() => buildPackage(join(ROOT, 'host/wasm-sdk/staged'), { wasm: RELEASE }), /\.cache/);
});
