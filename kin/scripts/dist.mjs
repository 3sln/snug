// Build a `dist` commit from a stamped release build (P9.19, O3, D346).
//
//     node kin/scripts/dist.mjs --repo <git checkout> --release <dir> --source <commit>
//                               [--source-repo <git checkout>] [--overlay <dir>]... [--branch dist] [--dry-run]
//
// The `dist` branch holds GENERATED RELEASE OUTPUT, not source history
// (docs/release-policy.md §9). Each commit is the unpacked release artefacts of
// one version, so a git-source consumer gets exactly what the registries ship:
//
//     /                 the @3sln/snug npm tarball's `package/` (npm git installs need the root)
//     /rust/            the snug-cddl .crate's contents (cargo finds it by package name)
//     /wasm-sdk/        the @3sln/snug-wasm tarball's `package/`, when the release has one
//     /<overlay>/...    further release trees (a Go module in go/, a deps.edn root in clj/)
//     /DIST.json        version, source commit, and the SHA-256 of every input artefact
//     /.npmignore       keeps the sibling trees out of an npm git install
//
// --release holds the artefacts a release build produced from a stamped tree
// (`bb stamp` in a detached worktree, then npm pack and cargo package):
// 3sln-snug-<v>.tgz and snug-cddl-<v>.crate, optionally 3sln-snug-wasm-<v>.tgz.
// Every artefact must carry the same version, and not version.edn's placeholder.
//
// Commits are linear (the previous dist tip is the parent; the first is an orphan
// root) and reproducible: author, committer and dates are the source commit's,
// so the same artefacts on the same parent give the same commit hash. Tags, all
// annotated with the same fixed identity and date:
//     v<version>        on the dist commit: the tag consumers name is the installable tree
//                       (the source commit gets src/v<version> from the release process, §9)
//     <dir>/v<version>  for every top-level <dir> holding a go.mod (Go's subdirectory rule)
// It writes refs only in --repo, refuses an existing tag, and never pushes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function fail(message, status = 1) { console.error(`dist: ${message}`); process.exit(status); }

function parse(argv) {
  const o = { overlay: [], branch: 'dist', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i] ?? fail(`${a} needs a value`, 2);
    if (a === '--repo') o.repo = resolve(v());
    else if (a === '--release') o.release = resolve(v());
    else if (a === '--source') o.source = v();
    else if (a === '--source-repo') o.sourceRepo = resolve(v());
    else if (a === '--overlay') o.overlay.push(resolve(v()));
    else if (a === '--branch') o.branch = v();
    else if (a === '--dry-run') o.dryRun = true;
    else fail(`unknown argument ${a}`, 2);
  }
  if (!o.repo || !o.release || !o.source) fail('usage: dist.mjs --repo <checkout> --release <dir> --source <commit> ' +
    '[--source-repo <checkout>] [--overlay <dir>]... [--branch dist] [--dry-run]', 2);
  o.sourceRepo ??= o.repo;
  return o;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) fail(`${cmd} ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.status === 0 ? r.stdout.trim() : null;
}

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Unpack a .tgz/.crate whose entries all sit under `top/` into `dest`. */
function unpack(archive, top, dest) {
  const entries = run('tar', ['-tzf', archive]).split('\n');
  const bad = entries.find(e => !(e === top || e.startsWith(top + '/')) || e.split('/').includes('..'));
  if (bad) fail(`${archive}: entry ${bad} is outside ${top}/`);
  mkdirSync(dest, { recursive: true });
  run('tar', ['-xzf', archive, '-C', dest, '--strip-components', '1', top]);
}

function main(o) {
  // The artefacts.
  const names = readdirSync(o.release);
  const pick = (re, what, optional) => {
    const hits = names.filter(n => re.test(n));
    if (hits.length > 1) fail(`${o.release} holds more than one ${what}: ${hits.join(', ')}`);
    if (!hits.length && !optional) fail(`${o.release} holds no ${what}`);
    return hits[0];
  };
  const js = pick(/^3sln-snug-\d.*\.tgz$/, '@3sln/snug tarball (3sln-snug-<v>.tgz)');
  const crate = pick(/^snug-cddl-\d.*\.crate$/, 'snug-cddl .crate');
  const wasm = pick(/^3sln-snug-wasm-\d.*\.tgz$/, '@3sln/snug-wasm tarball', true);
  const version = js.slice('3sln-snug-'.length, -'.tgz'.length);

  // The source commit, and the placeholder it declares.
  const src = run('git', ['-C', o.sourceRepo, 'rev-parse', '--verify', `${o.source}^{commit}`]);
  const [name, email, date] = run('git', ['-C', o.sourceRepo, 'show', '-s', '--format=%cn%x00%ce%x00%cI', src]).split('\0');
  const edn = run('git', ['-C', o.sourceRepo, 'show', `${src}:version.edn`], { allowFail: true });
  const placeholder = edn?.match(/:placeholder\s+"([^"]+)"/)?.[1];
  if (version === placeholder) fail(`${version} is version.edn's placeholder: build from a stamped tree (bb stamp)`);

  // The tree.
  const stage = join(o.release, 'dist-tree');
  rmSync(stage, { recursive: true, force: true });
  unpack(join(o.release, js), 'package', stage);
  unpack(join(o.release, crate), crate.slice(0, -'.crate'.length), join(stage, 'rust'));
  if (wasm) unpack(join(o.release, wasm), 'package', join(stage, 'wasm-sdk'));
  for (const dir of o.overlay) {
    for (const top of readdirSync(dir)) {
      if (existsSync(join(stage, top))) fail(`overlay ${dir}: ${top} already exists in the dist tree`);
      cpSync(join(dir, top), join(stage, top), { recursive: true });
    }
  }
  const versions = { '@3sln/snug': JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')).version,
    'snug-cddl': readFileSync(join(stage, 'rust/Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)?.[1] };
  if (wasm) versions['@3sln/snug-wasm'] = JSON.parse(readFileSync(join(stage, 'wasm-sdk/package.json'), 'utf8')).version;
  for (const [pkg, v] of Object.entries(versions))
    if (v !== version) fail(`${pkg} is at ${v}, the release is ${version}: one version for every artefact (O2)`);

  const tops = readdirSync(stage).filter(t => statSync(join(stage, t)).isDirectory());
  const goDirs = tops.filter(t => existsSync(join(stage, t, 'go.mod')));
  const siblings = ['rust', ...(wasm ? ['wasm-sdk'] : []), ...o.overlay.flatMap(d => readdirSync(d))];
  writeFileSync(join(stage, '.npmignore'),
    '# dist branch (docs/release-policy.md §9): the npm package is the root; these are other artefacts.\n' +
    [...siblings, 'DIST.json'].map(s => `/${s}`).join('\n') + '\n');
  const artefacts = Object.fromEntries([js, crate, wasm].filter(Boolean).map(n => [n, sha256(join(o.release, n))]));
  writeFileSync(join(stage, 'DIST.json'), JSON.stringify({
    note: 'Generated release output (docs/release-policy.md §9), not source history.',
    version, source: src, artefacts, trees: { '/': '@3sln/snug', rust: 'snug-cddl', ...(wasm ? { 'wasm-sdk': '@3sln/snug-wasm' } : {}),
      ...Object.fromEntries(goDirs.map(d => [d, 'Go module'])) },
  }, null, 2) + '\n');

  // The commit, through a private index so the checkout's own index and work tree are untouched.
  const git = (args, env = {}, allowFail = false) => run('git', ['-C', o.repo, ...args],
    { env: { ...process.env, ...env }, allowFail });
  const index = join(o.release, 'dist-index');
  rmSync(index, { force: true });
  git(['--work-tree', stage, 'add', '--all', '--force', '.'], { GIT_INDEX_FILE: index });
  const tree = git(['write-tree'], { GIT_INDEX_FILE: index });
  rmSync(index, { force: true });
  const ref = `refs/heads/${o.branch}`;
  const parent = git(['rev-parse', '--verify', '-q', ref], {}, true);
  const tags = [`v${version}`, ...goDirs.map(d => `${d}/v${version}`)];
  for (const t of tags) if (git(['rev-parse', '--verify', '-q', `refs/tags/${t}`], {}, true)) fail(`tag ${t} exists already`);
  if (parent) {
    const prev = JSON.parse(git(['show', `${parent}:DIST.json`]));
    if (prev.version === version) fail(`${o.branch} already ends at ${version}`);
  }
  const ident = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: date };
  const message = `dist: snug ${version}\n\nGenerated release output, not source history (docs/release-policy.md §9).\n` +
    `Source commit: ${src}\n` + Object.entries(artefacts).map(([n, h]) => `${n} sha256 ${h}`).join('\n') + '\n';
  const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], ident);
  console.log(`  tree   ${tree}\n  commit ${commit}${parent ? ` (parent ${parent})` : ' (orphan root)'}`);
  if (o.dryRun) { console.log('  dry run: no ref written'); return; }
  git(['update-ref', '-m', `dist ${version}`, ref, commit, parent ?? '']);
  for (const t of tags) git(['tag', '-a', t, '-m', `snug ${version} (dist${t.includes('/') ? ', ' + t.split('/')[0] + ' module' : ''}; source ${src})`, commit], ident);
  console.log(`  ${ref} -> ${commit}\n  tags   ${tags.join(' ')}\n  nothing pushed`);
}

main(parse(process.argv.slice(2)));
