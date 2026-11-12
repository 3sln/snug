// Validate kin/scripts/dist.mjs and the git-source consumers, offline (P9.19, D346).
//
//     node kin/scripts/dist-test.mjs --release <dir> --source <commit> [--source-repo <checkout>]
//
// --release is a stamped release build's artefact directory (see dist.mjs). Not a
// gate: it needs a stamped build. Everything happens
// in scratch repositories under .cache/dist-test/ (each with a stand-in `main`
// commit tagged src/v<version>); nothing touches this checkout's refs or any remote.
//   determinism  two builds give the same commit and tag objects; a rebuild is refused
//   npm          git+file://…#v<version> installs exactly the npm tarball's files and
//                validates; #semver:<version> resolves to the dist commit
//   cargo        git = "file://…", tag = "v<version>" builds and validates
//   go           github.com/3sln/snug/go@v<version> via the go/v<version> tag (a probe module;
//                git's url.insteadOf maps the GitHub URL to the scratch repository)
// The go/ tree is a probe passed through --overlay: no Go host exists (D006). Clojure and
// babashka consumers were dropped by the owner (2026-11-12), so deps.edn is not exercised.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = join(ROOT, 'kin/scripts/dist.mjs');
const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const release = arg('--release') && resolve(arg('--release'));
const source = arg('--source');
const sourceRepo = resolve(arg('--source-repo') ?? ROOT);
if (!release || !source) { console.error('usage: dist-test.mjs --release <dir> --source <commit> [--source-repo <checkout>]'); process.exit(2); }
const version = readdirSync(release).find(n => /^3sln-snug-\d.*\.tgz$/.test(n))?.slice(10, -4);
if (!version) { console.error(`dist-test: no 3sln-snug-<v>.tgz in ${release}`); process.exit(2); }
const work = join(ROOT, '.cache/dist-test');
spawnSync('chmod', ['-R', 'u+w', work]); // Go's module cache is read-only
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

let failed = 0;
const ok = (what, detail = '') => console.log(`  ok   ${what}${detail ? ` (${detail})` : ''}`);
const bad = (what, detail) => { failed++; console.log(`  FAIL ${what}: ${detail}`); };
const skip = (what, why) => console.log(`  SKIP ${what}: ${why}`);
function sh(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...opts, env: { ...process.env, ...opts.env } });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: ((r.stderr ?? '') + (r.error?.message ?? '')).trim() };
}
const has = (cmd, ...a) => sh(cmd, a.length ? a : ['--version']).status === 0;
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

function repo(name, overlay) {
  const dir = join(work, name);
  sh('git', ['init', '-q', '-b', 'main', dir]);
  sh('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@invalid', 'commit', '-q', '--allow-empty', '-m', 'stand-in source']);
  sh('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@invalid', 'tag', '-a', `src/v${version}`, '-m', 'stand-in', 'main']);
  const r = sh('node', [DIST, '--repo', dir, '--release', release, '--source', source, '--source-repo', sourceRepo,
    ...(overlay ? ['--overlay', overlay] : [])]);
  if (r.status !== 0) { bad(`dist.mjs into ${name}`, r.err || r.out); process.exit(1); }
  return dir;
}
const rev = (dir, ref) => sh('git', ['-C', dir, 'rev-parse', ref]).out;

// Determinism and refusal.
const a = repo('a'), b = repo('b');
const tag = `v${version}`, commit = rev(a, `${tag}^{commit}`);
if (commit === rev(b, `${tag}^{commit}`) && rev(a, tag) === rev(b, tag)) ok('determinism', `commit ${commit.slice(0, 12)}`);
else bad('determinism', 'two builds of the same artefacts differ');
const again = sh('node', [DIST, '--repo', a, '--release', release, '--source', source, '--source-repo', sourceRepo]);
if (again.status !== 0 && /exists already/.test(again.err)) ok('rebuild refused', again.err);
else bad('rebuild refused', again.out || again.err);

// The probe trees for the consumers that have no host yet.
const probe = join(work, 'probe');
write(join(probe, 'go/go.mod'), 'module github.com/3sln/snug/go\n\ngo 1.21\n');
write(join(probe, 'go/snug.go'), `package snug\n\nconst Version = "${version}"\n`);
const p = repo('p', probe), url = `file://${p}`, pcommit = rev(p, `${tag}^{commit}`);
if (rev(p, `go/${tag}^{commit}`) === pcommit) ok('go/ tag', `go/${tag} on the dist commit`);
else bad('go/ tag', 'missing or elsewhere');

// npm
{
  const dir = join(work, 'npm'), cache = join(work, 'npm-cache');
  write(join(dir, 'package.json'), '{"name":"consumer","private":true,"type":"module"}\n');
  const i = sh('npm', ['install', '--no-audit', '--no-fund', '--cache', cache, `git+${url}#${tag}`], { cwd: dir });
  const pkg = join(dir, 'node_modules/@3sln/snug');
  if (i.status !== 0) bad('npm install #tag', i.err);
  else {
    const installed = sh('find', ['.', '-type', 'f'], { cwd: pkg }).out.split('\n').map(f => f.slice(2)).sort();
    const packed = sh('tar', ['-tzf', join(release, `3sln-snug-${version}.tgz`)]).out.split('\n').map(f => f.slice(8)).sort();
    if (JSON.stringify(installed) !== JSON.stringify(packed)) bad('npm install #tag', 'installed files != the npm tarball');
    else ok('npm install #tag', `${installed.length} files == the npm tarball`);
    write(join(dir, 'check.mjs'), "import { compile } from '@3sln/snug/compile';\nimport { encode } from '@3sln/snug';\n" +
      "const s = await compile('message = { id: uint }');\nconst r = s.validate(encode(new Map([['id', 7]])), 'message');\n" +
      "if (!r.ok) throw new Error(JSON.stringify(r));\nconsole.log('ok');\n");
    const run = sh('node', ['check.mjs'], { cwd: dir });
    if (run.out === 'ok') ok('npm consumer validates'); else bad('npm consumer validates', run.err || run.out);
  }
  const dir2 = join(work, 'npm-semver');
  write(join(dir2, 'package.json'), '{"name":"consumer2","private":true}\n');
  const s = sh('npm', ['install', '--no-audit', '--no-fund', '--cache', cache, `git+${url}#semver:${version}`], { cwd: dir2 });
  const lock = s.status === 0 ? sh('grep', ['-o', `#[0-9a-f]\\{40\\}`, join(dir2, 'package-lock.json')]).out : '';
  if (lock === `#${pcommit}`) ok('npm #semver', 'resolves to the dist commit'); else bad('npm #semver', s.err || lock);
}

// cargo
if (!has('cargo')) skip('cargo', 'no cargo');
else {
  const dir = join(work, 'cargo');
  write(join(dir, 'Cargo.toml'), `[package]\nname = "consumer"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n` +
    `[dependencies]\nsnug-cddl = { git = "${url}", tag = "${tag}" }\n`);
  write(join(dir, 'src/main.rs'), 'use snug::{CompileOptions, EncodeOptions, Schema, Scratch, Value, encode};\nfn main() {\n' +
    '    let s = Schema::compile("message = { id: uint }", &CompileOptions::default()).unwrap();\n' +
    '    let b = encode(&Value::Map(vec![(Value::Text("id".into()), Value::Uint(7))]), &EncodeOptions::default()).unwrap();\n' +
    '    s.validate(&b, "message", &mut Scratch::new()).unwrap();\n    println!("ok");\n}\n');
  const r = sh('cargo', ['run', '-q'], { cwd: dir, env: { CARGO_HOME: join(work, 'cargo-home'), CARGO_TARGET_DIR: join(work, 'cargo-target') } });
  if (r.out === 'ok') ok('cargo git tag', `Cargo.lock pins ${pcommit.slice(0, 12)}`); else bad('cargo git tag', r.err);
}

// go
if (!has('go', 'version')) skip('go', 'no go');
else {
  const dir = join(work, 'go');
  write(join(dir, 'gitconfig'), `[url "${url}"]\n\tinsteadOf = https://github.com/3sln/snug\n`);
  write(join(dir, 'go.mod'), `module example.com/consumer\n\ngo 1.21\n\nrequire github.com/3sln/snug/go ${tag}\n`);
  write(join(dir, 'main.go'), 'package main\n\nimport (\n\t"fmt"\n\tsnug "github.com/3sln/snug/go"\n)\n\nfunc main() { fmt.Println(snug.Version) }\n');
  const r = sh('go', ['run', '.'], { cwd: dir, env: { GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GOPROXY: 'direct', GOSUMDB: 'off',
    GOFLAGS: '-mod=mod -modcacherw', GOTOOLCHAIN: 'local', GOPATH: join(work, 'gopath'), GOMODCACHE: join(work, 'gopath/mod'), GOCACHE: join(work, 'gocache') } });
  if (r.out === version) ok('go module via go/ tag'); else bad('go', r.err || r.out);
}

console.log(failed ? `dist-test: ${failed} failed` : 'dist-test: ok (nothing pushed; scratch in .cache/dist-test)');
process.exit(failed ? 1 : 0);
