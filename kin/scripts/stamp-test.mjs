// `bb stamp` on scratch copies of this tree (P9.15 rework, O2, D343).
//
//     bb stamp-test [--keep] [--full]
//
// Copies the tree (tracked files plus untracked, unignored ones, as they are on
// disk) twice into .cache/stamp-test/, never touching this checkout, then:
//
//  1. stamps copy a with `bb stamp` (version.edn's :version) and copy b with
//     the same version given explicitly; the two trees are byte-identical;
//  2. stamps a again: nothing changes (idempotent);
//  3. in a, every site holds the version and version.test.mjs passes with it
//     (--full: the whole of `npm test`); a compiled Program carries it in its
//     producer field, and its source key differs from the placeholder tree's;
//  4. builds the npm package (package-build, then `npm pack`) and the crate
//     (rust-crate, then `cargo package --list` and `cargo package
//     --no-verify`, offline) from both copies: the tarballs and .crate files
//     are byte-identical, and each ships SECURITY.md and the stamped version;
//  5. re-stamps a with a 32-byte prerelease (the producer field's limit) and
//     repeats the checks of 3; a 33-byte version is refused, tree unchanged;
//  6. turns b into a checkout with a branch: `bb stamp` refuses it.
//
// Nothing is published; the scratch directory is removed unless --keep.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selfWatch } from './watchdog.mjs';
import { MAX_VERSION_BYTES, ROOT, readSites, readVersionEdn, siteMismatches } from './version-sites.mjs';
selfWatch('stamp-test', import.meta.url);

const keep = process.argv.includes('--keep'), full = process.argv.includes('--full');
const edn = readVersionEdn();
const V1 = edn.version;
const V2 = '0.1.0-rc.1.long-prerelease.abcde';  // 32 bytes, the producer field's limit
const V3 = V2 + 'f';                             // 33 bytes: refused
if (V2.length !== MAX_VERSION_BYTES || V3.length !== MAX_VERSION_BYTES + 1) throw new Error('stamp-test: V2/V3 lengths');
const dir = join(ROOT, '.cache', 'stamp-test');
let fails = 0;
const ok = msg => console.log(`  ok   ${msg}`);
const bad = msg => { console.log(`  FAIL ${msg}`); fails++; };
const check = (cond, msg, detail = '') => cond ? ok(msg) : bad(msg + (detail ? `\n       ${detail}` : ''));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts, env: { ...process.env, ...opts.env } });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
const must = (r, what) => { if (r.status !== 0) { console.log(r.out); throw new Error(`${what} failed (exit ${r.status})`); } return r.out; };

/** sha256 of every file under `root`, by relative path (symlinks by target). */
function treeHash(root, skip = new Set(['.cache'])) {
  const lines = [];
  (function walk(d) {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name), rel = relative(root, p);
      if (skip.has(rel)) continue;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) lines.push(`${rel} -> ${readlinkSync(p)}`);
      else if (st.isDirectory()) walk(p);
      else lines.push(`${rel} ${sha(readFileSync(p))}`);
    }
  })(root);
  return { digest: sha(lines.join('\n')), files: lines.length };
}

function copyTree(to) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\0').filter(f => f && !f.startsWith('bench/compare/node_modules') && existsSync(join(ROOT, f)));
  for (const f of files) {
    mkdirSync(dirname(join(to, f)), { recursive: true });
    cpSync(join(ROOT, f), join(to, f), { verbatimSymlinks: true });
  }
  return files.length;
}

const stamp = (tree, ...args) => run('node', ['kin/scripts/stamp.mjs', ...args], { cwd: tree });

/** Every site, the test file, and a compiled Program, for `version` in `tree`. */
function coherent(tree, version, label) {
  check(siteMismatches(readSites(tree), version).length === 0, `${label}: every version site holds ${version}`,
    siteMismatches(readSites(tree), version).join('; '));
  const tests = full ? ['--expose-gc', '--test', 'test/'] : ['--test', 'test/version.test.mjs', 'test/serialized.test.mjs', 'test/package.test.mjs'];
  const t = run('node', tests, { cwd: join(tree, 'host/js'), env: { SNUG_STAMPED_VERSION: version, TMPDIR: dir } });
  check(t.status === 0, `${label}: ${full ? 'npm test' : 'version, serialized and package tests'} pass stamped`, t.out.split('\n').filter(l => /^not ok|✖|fail [1-9]/.test(l)).slice(0, 8).join('\n       '));
  // in a child: a tree re-stamped in place must not be served from this process's module cache
  const program = root => JSON.parse(must(run('node', ['--input-type=module', '-e',
    `const { compile } = await import(${JSON.stringify(pathToFileURL(join(root, 'host/js/src/public-compile.mjs')).href)});
     const s = await compile('r = { a: uint, b: [* tstr] }');
     console.log(JSON.stringify({ field: Buffer.from(s.program.serialize().subarray(24, 56)).toString('latin1'), key: s.program.sourceKey }));`]),
  'compile a Program'));
  const [mine, placeholder] = [program(tree), program(ROOT)];
  const field = mine.field.replace(/\0+$/, '');
  check(field === version, `${label}: a compiled Program's producer field says ${version}`, `got ${JSON.stringify(field)}`);
  check(mine.key && placeholder.key && String(mine.key) !== String(placeholder.key),
    `${label}: its source key differs from the placeholder tree's (the version is in the preimage)`);
}

function npmTarball(tree, tag) {
  const staged = join(dir, `npm-${tag}`), out = join(dir, `tgz-${tag}`);
  must(run('node', ['host/js/src/package-build.mjs', staged], { cwd: tree, env: { TMPDIR: dir } }), `package-build (${tag})`);
  mkdirSync(out);
  must(run('npm', ['pack', '--silent', '--pack-destination', out, '--cache', join(dir, 'npm-cache'), '--offline'], { cwd: staged }), `npm pack (${tag})`);
  const [name] = readdirSync(out);
  return { name, path: join(out, name), staged };
}

function crate(tree, tag) {
  const assembled = join(dir, `crate-${tag}`), target = join(dir, `target-${tag}`);
  must(run('sh', ['kin/scripts/rust-crate', assembled], { cwd: tree }), `rust-crate (${tag})`);
  const env = { CARGO_TARGET_DIR: target };
  const list = must(run('cargo', ['package', '--list', '--offline', '--allow-dirty', '--quiet'], { cwd: assembled, env }), `cargo package --list (${tag})`);
  must(run('cargo', ['package', '--no-verify', '--offline', '--allow-dirty', '--quiet'], { cwd: assembled, env }), `cargo package (${tag})`);
  const pkgDir = join(target, 'package');
  const [name] = readdirSync(pkgDir).filter(n => n.endsWith('.crate'));
  return { name, path: join(pkgDir, name), list: list.trim().split('\n').sort() };
}

try {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // the copies' bb.edn finds kin at ../kin
  symlinkSync(realpathSync(join(ROOT, '..', 'kin')), join(dir, 'kin'));
  const a = join(dir, 'a'), b = join(dir, 'b');
  const n = copyTree(a); copyTree(b);
  ok(`copied ${n} files twice into ${relative(ROOT, dir)}/ (a, b)`);

  // 1. two stamps, one by default from version.edn, one explicit
  must(stamp(a), 'bb stamp (a)');
  must(stamp(b, V1), `bb stamp ${V1} (b)`);
  const [ha, hb] = [treeHash(a), treeHash(b)];
  check(ha.digest === hb.digest, `stamping ${V1} twice gives byte-identical trees (${ha.files} files, sha256 ${ha.digest.slice(0, 16)}…)`);

  // 2. idempotent
  const again = stamp(a, V1);
  check(again.status === 0 && /already stamped/.test(again.out) && treeHash(a).digest === ha.digest,
    'stamping the same version again changes nothing');

  // 3. coherent
  await coherent(a, V1, V1);

  // 4. reproducible artefacts
  const [ta, tb] = [npmTarball(a, 'a'), npmTarball(b, 'b')];
  check(ta.name === tb.name && sha(readFileSync(ta.path)) === sha(readFileSync(tb.path)),
    `npm pack: ${ta.name} byte-identical from both stamps (sha256 ${sha(readFileSync(ta.path))})`);
  const tpkg = JSON.parse(readFileSync(join(ta.staged, 'package.json'), 'utf8'));
  check(tpkg.name === '@3sln/snug' && tpkg.version === V1, `the npm package is @3sln/snug ${V1}`, `${tpkg.name} ${tpkg.version}`);
  check(existsSync(join(ta.staged, 'SECURITY.md')), 'the npm package ships SECURITY.md');
  const [ca, cb] = [crate(a, 'a'), crate(b, 'b')];
  check(ca.name === cb.name && sha(readFileSync(ca.path)) === sha(readFileSync(cb.path)),
    `cargo package: ${ca.name} byte-identical from both stamps (sha256 ${sha(readFileSync(ca.path))})`);
  check(JSON.stringify(ca.list) === JSON.stringify(cb.list), `cargo package --list: the same ${ca.list.length} files`);
  check(ca.name === `snug-cbor-${V1}.crate`, `the crate is snug-cbor ${V1}`, ca.name);
  check(ca.list.includes('SECURITY.md'), 'the crate ships SECURITY.md');

  // 5. a long prerelease, stamped over a stamped tree; one byte more is refused
  must(stamp(a, V2), `bb stamp ${V2}`);
  await coherent(a, V2, `${V2.length}-byte prerelease`);
  const before = treeHash(a).digest, refused = stamp(a, V3);
  check(refused.status === 2 && /32/.test(refused.out) && treeHash(a).digest === before,
    `a ${V3.length}-byte version is refused, tree unchanged`, refused.out.trim());

  // 6. a checkout with a branch is refused
  must(run('git', ['init', '-q', '-b', 'main', b]), 'git init');
  const hb2 = treeHash(b, new Set(['.cache', '.git'])).digest, branch = stamp(b, V2);
  check(branch.status === 1 && /refused/.test(branch.out) && treeHash(b, new Set(['.cache', '.git'])).digest === hb2,
    'bb stamp refuses a checkout with a branch checked out', branch.out.trim());
} catch (e) {
  bad(e.message);
} finally {
  if (!keep) rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `stamp-test: ${fails} FAILED` : 'stamp-test: ok');
process.exit(fails ? 1 : 0);
