import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';
import { buildPackage } from '../src/package-build.mjs';
import { SNUG_VERSION } from '../src/version.mjs';
import { SNUG_VERSION as compilerVersion } from '../src/compile.mjs';
import { compile, SchemaError } from 'snug/compile';
import { validate, decode as schemaDecode, validateAt } from 'snug/schema';
import { encode, decode, profiles, SnugFault } from 'snug';
import { view } from 'snug/view';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

test('public package metadata, entry points, profile status and blocked deep imports', async () => {
  assert.equal(pkg.name, 'snug'); assert.equal(pkg.private, true); assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.version, compilerVersion); assert.equal(SNUG_VERSION, compilerVersion);
  assert.deepEqual(Object.keys(profiles), ['valid', 'deterministic', 'bindle']);
  assert.ok(Object.isFrozen(profiles) && Object.isFrozen(profiles.bindle) && Object.isFrozen(profiles.deterministic) && Object.isFrozen(profiles.valid));
  assert.equal(profiles.valid.wire, 'valid'); assert.equal(profiles.deterministic.wire, 'deterministic'); assert.equal(profiles.bindle.wire, 'bindle');
  for (const key of Object.keys(pkg.exports)) {
    const specifier = key === '.' ? 'snug' : 'snug/' + key.slice(2);
    const module = await import(specifier);
    assert.ok(Object.keys(module).length);
    assert.ok(existsSync(new URL('../' + pkg.exports[key].types, import.meta.url)));
  }
  await assert.rejects(import('snug/src/schema.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  await assert.rejects(import('snug/generated/snug/vm/api.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('public error contract: safe compile failures, results, codec/schema/view faults', async () => {
  await assert.rejects(compile('r = definitely-undefined'), e =>
    e instanceof SchemaError && e.code === 'undefined_name' && e.line === 1 && e.column > 0);
  const s = await compile('r = { public: uint }');
  const bytes = encode({ 'private-secret-key': 'private-secret-payload' });
  const result = validate(s, bytes, 'r');
  assert.equal(result.ok, false); assert.deepEqual(result.path, ['*']);
  assert.ok(!JSON.stringify(result).includes('private-secret'));
  for (const f of [() => s.decode(bytes, 'r'), () => schemaDecode(s, bytes, 'r'),
    () => view(bytes, { schema: s, rule: 'r' })]) assert.throws(f, e => {
    assert.ok(e instanceof SnugFault); assert.equal(e.code, `schema/${result.reason}`);
    assert.equal(e.reason, result.reason); assert.deepEqual(e.path, result.path);
    assert.ok(!e.message.includes('private-secret')); return true;
  });
  const malformed = Uint8Array.of(0xbf, 0x61);   // an indefinite-length map cut short: not well-formed
  for (const f of [() => decode(malformed), () => s.decode(malformed, 'r'),
    () => view(malformed), () => view(malformed, { schema: s, rule: 'r' })])
    assert.throws(f, e => e instanceof SnugFault && e.code === 'truncated');
  const indefinite = Uint8Array.of(0xbf, 0xff);  // valid CBOR, refused by the deterministic preset
  for (const f of [() => decode(indefinite, { wire: 'deterministic' }), () => s.decode(indefinite, 'r', { wire: 'deterministic' }),
    () => view(indefinite, { wire: 'deterministic' }), () => view(indefinite, { schema: s, rule: 'r', wire: 'deterministic' })])
    assert.throws(f, e => e instanceof SnugFault && e.code === 'indefinite');
  assert.throws(() => s.validate(bytes, 'private-secret-rule'), e =>
    e instanceof TypeError && !e.message.includes('private-secret'));
  assert.throws(() => s.validate(new Uint8Array(new SharedArrayBuffer(1)), 'r'), TypeError);
  assert.throws(() => validateAt(s, bytes, -1, 5, 'r'), TypeError);
  const good = encode({ public: 1 });
  assert.deepEqual(validate(s, good, 'r'), { ok: true });
  assert.deepEqual(validateAt(s, good, 0, good.length, 'r'), { ok: true });
});

test('runtime entry points have no eager compiler dependency or Node builtins', () => {
  const seen = new Set();
  function visit(url) {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const code = readFileSync(url, 'utf8');
    // Only static import/re-export edges. import(...) is deliberately excluded.
    const refs = code.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g);
    for (const [, specifier] of refs) {
      assert.ok(!specifier.startsWith('node:'), `${url}: ${specifier}`);
      if (specifier.startsWith('.')) visit(new URL(specifier, url));
    }
  }
  for (const key of Object.keys(pkg.exports)) visit(new URL('../' + pkg.exports[key].default, import.meta.url));
  assert.ok(![...seen].some(p => p.includes('/gen/js/snug/compile/') || p.endsWith('/src/compile.mjs')));
});

test('every declaration parses with Node and matches the entry point exports', async t => {
  const roots = [];
  for (const [key, entry] of Object.entries(pkg.exports)) {
    const url = new URL('../' + entry.types, import.meta.url), source = readFileSync(url, 'utf8');
    roots.push(url.pathname);
    assert.doesNotThrow(() => stripTypeScriptTypes(source));
    const declared = [...source.matchAll(/export declare (?:class|function|const) (\w+)/g)].map(m => m[1]).sort();
    const module = await import(key === '.' ? 'snug' : 'snug/' + key.slice(2));
    assert.deepEqual(declared, Object.keys(module).sort(), key);
    for (const [, path] of source.matchAll(/from '([^']+)'/g))
      assert.ok(existsSync(new URL(path.replace(/\.js$/, '.d.ts'), url)));
  }
  const offline = new URL('../../../../3sln.me/node_modules/typescript/lib/typescript.js', import.meta.url);
  if (existsSync(offline)) {
    const ts = createRequire(import.meta.url)(offline.pathname);
    const program = ts.createProgram(roots, { noEmit: true, strict: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: x => x, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
    }));
    t.diagnostic(`offline TypeScript ${ts.version}: declaration semantic check passed`);
  } else t.diagnostic('Node declaration syntax/export/import checks only; offline TypeScript unavailable');
});

test('self-contained staged package works away from the repository through all exports', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'snug-package-test-'));
  try {
    const target = await buildPackage(join(temp, 'package'));
    const smoke = `
      import assert from 'node:assert/strict';
      import {encode,decode,Decimal,NDArray,Float16Bytes,Tagged,profiles} from 'snug';
      import {compile} from 'snug/compile';
      import {fromSerialized,validate,decode as schemaDecode,validateAt} from 'snug/schema';
      import {view,View,Cursor} from 'snug/view';
      import {Writer} from 'snug/writer';
      import {asyncHandle,bufferHandle,scanHandle,validateHandle,validateHandleSync,pushValidator,openSession} from 'snug/sources';
      const s = await compile('r = { id: uint }');
      const b = encode({id:7});
      assert.deepEqual(validate(s,b,'r'),{ok:true});
      assert.equal(schemaDecode(s,b,'r').id,7);
      assert.equal(decode(b).id,7);
      const v=view(b,{schema:s,rule:'r'});
      assert.ok(v instanceof View && v.cursor() instanceof Cursor);
      assert.deepEqual(validateAt(s,b,0,b.length,'r'),{ok:true});
      assert.deepEqual((await fromSerialized(s.program.serialize())).validate(b,'r'),{ok:true});
      assert.deepEqual(new Writer().beginMap(1).key('id').uint(7).end().finish(),b);
      assert.equal(await scanHandle(asyncHandle(b)),true);
      assert.deepEqual(await validateHandle(s,asyncHandle(b),'r'),s.validate(b,'r'));
      assert.deepEqual(validateHandleSync(s,bufferHandle(b),'r'),{ok:true});
      const push=pushValidator(s,b.length,'r');
      push.feed(b);
      assert.deepEqual(push.finalize(),{ok:true});
      assert.deepEqual(openSession(s,'r',b.length).step(b,0),{state:'done',result:{ok:true}});
      assert.equal(Decimal.from('1.5').toString(),'1.5');
      assert.ok(new NDArray([1],[7]) && new Float16Bytes(new Uint8Array(2)) && profiles.bindle && profiles.deterministic);
      assert.equal(decode(encode(new Tagged(1, 7))).value, 7);
      assert.throws(() => decode(Uint8Array.of(0x01), {wire:'bindle'}), {code:'not_map'});
      await assert.rejects(import('snug/generated/snug/vm/api.mjs'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
    `;
    await writeFile(join(target, 'smoke.mjs'), smoke);
    const child = spawnSync(process.execPath, ['smoke.mjs'], { cwd: target, encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    for (const example of readdirSync(join(target, 'examples')).filter(n => n.endsWith('.mjs'))) {
      const run = spawnSync(process.execPath, [join('examples', example)], { cwd: target, encoding: 'utf8', timeout: 30000 });
      assert.equal(run.status, 0, `${example}: ${run.stderr || run.error?.message}`);
    }
    const staged = JSON.parse(readFileSync(join(target, 'package.json')));
    assert.equal(staged.private, true); assert.equal(staged.scripts, undefined);
    await assert.rejects(buildPackage(target), { code: 'EEXIST' });
    assert.ok(readdirSync(join(target, 'generated', 'snug')).includes('vm'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('schema static graph excludes session drivers; sources excludes verifier and compiler loaders', () => {
  function closure(entry) {
    const seen = new Set();
    function visit(url) {
      if (seen.has(url.pathname)) return;
      seen.add(url.pathname);
      const code = readFileSync(url, 'utf8');
      for (const [, specifier] of code.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g))
        if (specifier.startsWith('.')) visit(new URL(specifier, url));
    }
    visit(new URL('../src/' + entry, import.meta.url));
    return [...seen];
  }
  const schema = closure('public-schema.mjs'), sources = closure('public-sources.mjs');
  for (const path of schema) {
    assert.ok(!/\/gen\/js\/snug\/vm\/(?:session[^/]*|sbase|scont|sstr)\.mjs$/.test(path), path);
    assert.ok(!/\/(?:vm-session|open-session|sources|public-sources|controls)\.mjs$/.test(path), path);
    assert.ok(!path.endsWith('/src/schema.mjs'), path);
  }
  assert.ok(schema.some(p => p.endsWith('/program/verify.mjs')), 'synchronous Program verifies before returning');
  assert.ok(sources.some(p => p.endsWith('/vm/session.mjs')), 'sources retains the real kin session');
  assert.ok(!sources.some(p => p.endsWith('/program/verify.mjs') || p.endsWith('/src/schema.mjs')));
});
