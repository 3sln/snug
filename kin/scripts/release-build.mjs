// Build a release's artefacts from one commit, reproducibly (D368; release-policy §4).
//
//     node kin/scripts/release-build.mjs [--commit <rev>] [--out <dir>] [--dist-from <git url or path>] [--keep]
//
// What a release ships, built as the 0.1.0 release was by hand (DEVLOG "Release 0.1.0"), in a
// detached worktree of the commit under --out (default .cache/release-build; it must be under
// this checkout's .cache/ and is replaced):
//
//   1. `git worktree add --detach <out>/tree <commit>`; <out>/kin links to ../kin, as bb.edn wants
//   2. `bb stamp` (version.edn's :version) in the tree
//   3. @3sln/snug: host/js/src/package-build.mjs, then `npm pack`
//   4. @3sln/snug-wasm: `bb wasm-release` (the pinned nightly, wasm-opt from bench/compare), then
//      host/wasm-sdk/package-build.mjs, then `npm pack`
//   5. snug-cbor: kin/scripts/rust-crate, then `cargo package --offline --allow-dirty` (verified)
//   6. <out>/artefacts/SHA256SUMS, and <out>/release-notes.md from CHANGELOG `[<version>]`
//      (the build fails without that section)
//   7. the dist commit and its tags (kin/scripts/dist.mjs) in <out>/dist-repo, a scratch repository
//      (its dist branch first fetched from --dist-from, when given and present), and
//      <out>/dist.bundle holding them; nothing is written to this repository's refs
//
// It writes <out>/build.json (version, commit, artefacts and their SHA-256s, the dist commit) and
// prints it. Every step is the tree's own script, so an old commit builds with its own tools
// (the 0.1.0 reproduction: --commit bcfd46d gives the published SHA-256s, D368).
//
// Reproducibility: the bytes depend on the npm CLI (npm pack's tar), cargo (the .crate's
// Cargo.lock and normalised manifest), the wasm nightly and wasm-opt (pinned in the tree), and
// nothing else: npm pack and cargo package normalise mtimes and order, and every tool runs with
// TZ=UTC and LC_ALL=C. The versions used are recorded in build.json.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const fail = (m, status = 1) => { console.error(`release-build: ${m}`); process.exit(status); };
const ENV = { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
function run(cmd, args, { cwd = ROOT, env = {}, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...ENV, ...env } });
  if (r.status !== 0) { console.error((r.stdout ?? '') + (r.stderr ?? '')); fail(`${cmd} ${args.join(' ')} exited ${r.status} (in ${cwd})`); }
  if (!quiet && r.stderr?.trim()) process.stderr.write(r.stderr);
  return (r.stdout ?? '').trim();
}
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');

const commit = run('git', ['rev-parse', '--verify', `${opt('commit', 'HEAD')}^{commit}`]);
const out = resolve(opt('out', join(ROOT, '.cache/release-build')));
if (!out.startsWith(join(ROOT, '.cache') + '/')) fail('--out must be under this checkout\'s .cache/');
const tree = join(out, 'tree'), tmp = join(out, 'tmp'), artefacts = join(out, 'artefacts');

// 1. a detached worktree of the commit (any earlier one at the same place goes first)
if (existsSync(tree)) spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: ROOT });
spawnSync('git', ['worktree', 'prune'], { cwd: ROOT });
rmSync(out, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true }); mkdirSync(artefacts);
run('git', ['worktree', 'add', '--detach', tree, commit], { quiet: true });
symlinkSync(realpathSync(join(ROOT, '..', 'kin')), join(out, 'kin'));
const { readVersionEdn } = await import(join(tree, 'kin/scripts/version-sites.mjs'));
const version = readVersionEdn(tree).version;
console.error(`release-build: ${version} from ${commit} in ${tree}`);

// bench/compare (wasm-opt): this checkout's install when its lockfile is the tree's, else npm ci
const lock = d => { try { return readFileSync(join(d, 'bench/compare/package-lock.json'), 'utf8'); } catch { return null; } };
if (existsSync(join(ROOT, 'bench/compare/node_modules')) && lock(ROOT) === lock(tree))
  symlinkSync(join(ROOT, 'bench/compare/node_modules'), join(tree, 'bench/compare/node_modules'));
else run('npm', ['ci', '--no-audit', '--no-fund', '--cache', join(out, 'npm-cache')], { cwd: join(tree, 'bench/compare'), quiet: true });

// 2. stamp
run('node', ['kin/scripts/stamp.mjs'], { cwd: tree, env: { TMPDIR: tmp } });

// 3. and 4. the npm packages
const pack = staged => { const name = run('npm', ['pack', '--silent', '--offline', '--pack-destination', artefacts, '--cache', join(out, 'npm-cache')], { cwd: staged }); return name.split('\n').pop(); };
const snugStage = join(tmp, 'npm-snug');
run('node', ['host/js/src/package-build.mjs', snugStage], { cwd: tree, env: { TMPDIR: tmp } });
const npmSnug = pack(snugStage);
run('node', ['kin/scripts/wasm-release.mjs'], { cwd: tree, env: { TMPDIR: tmp } });
run('node', ['host/wasm-sdk/package-build.mjs'], { cwd: tree, env: { TMPDIR: tmp } });
const npmWasm = pack(join(tree, '.cache/release/npm/snug-wasm'));

// 5. the crate
const crateDir = join(out, 'crate'), target = join(out, 'crate-target');
run('sh', ['kin/scripts/rust-crate', crateDir], { cwd: tree });
run('cargo', ['package', '--offline', '--allow-dirty', '--quiet'], { cwd: crateDir, env: { CARGO_TARGET_DIR: target } });
const crateName = `snug-cbor-${version}.crate`;
cpSync(join(target, 'package', crateName), join(artefacts, crateName));

// 6. checksums and release notes
const names = [npmSnug, npmWasm, crateName].sort();
for (const n of names) if (!existsSync(join(artefacts, n))) fail(`missing artefact ${n}`);
const sums = Object.fromEntries(names.map(n => [n, sha(join(artefacts, n))]));
writeFileSync(join(artefacts, 'SHA256SUMS'), names.map(n => `${sums[n]}  ${n}\n`).join(''));
const changelog = readFileSync(join(tree, 'CHANGELOG.md'), 'utf8');
const esc = version.replace(/[.+]/g, m => '\\' + m);
const m = new RegExp(`^## \\[${esc}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm').exec(changelog);
if (!m || !m[1].trim()) fail(`CHANGELOG.md has no [${version}] section: a release needs its notes`);
const notes = [`snug ${version}: CDDL (RFC 8610) validation and CBOR (RFC 8949) encoding, decoding and checked views for JavaScript (@3sln/snug), Rust (snug-cbor) and WebAssembly (@3sln/snug-wasm).`,
  '', '```sh', `npm install @3sln/snug@${version}`, `npm install @3sln/snug-wasm@${version}   # optional wasm build`, `cargo add snug-cbor@${version}`, '```', '',
  `Built from \`${commit}\` (tag \`src/v${version}\`); the installable tree is \`v${version}\` on the \`dist\` branch.`, '',
  '## SHA-256', '', '```', ...names.map(n => `${sums[n]}  ${n}`), '```', '', '## Changes', '', m[1].trim(), ''].join('\n');
writeFileSync(join(out, 'release-notes.md'), notes);

// 7. dist, in a scratch repository
const distRepo = join(out, 'dist-repo');
run('git', ['init', '-q', distRepo]);
const from = opt('dist-from');
if (from && spawnSync('git', ['ls-remote', '--exit-code', '--heads', from, 'dist'], { env: ENV }).status === 0)
  run('git', ['fetch', '-q', from, 'dist:dist'], { cwd: distRepo });
run('node', [join(tree, 'kin/scripts/dist.mjs'), '--repo', distRepo, '--release', artefacts, '--source', commit, '--source-repo', ROOT], { cwd: tree });
const distCommit = run('git', ['rev-parse', 'dist'], { cwd: distRepo });
run('git', ['bundle', 'create', join(out, 'dist.bundle'), '--all'], { cwd: distRepo, quiet: true });

const tool = (c, a) => { const r = spawnSync(c, a, { encoding: 'utf8', env: ENV }); return r.status === 0 ? r.stdout.trim().split('\n')[0] : null; };
const build = { version, commit, artefacts: sums, dist: { commit: distCommit, tags: run('git', ['tag', '-l'], { cwd: distRepo }).split('\n').filter(Boolean) },
  tools: { node: process.version, npm: tool('npm', ['--version']), cargo: tool('cargo', ['--version']) } };
writeFileSync(join(out, 'build.json'), JSON.stringify(build, null, 2) + '\n');
console.log(JSON.stringify(build, null, 2));
if (!argv.includes('--keep')) { spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: ROOT }); spawnSync('git', ['worktree', 'prune'], { cwd: ROOT }); }
