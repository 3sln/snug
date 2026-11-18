// Decide what a release run must do (D368; release-policy §4).
//
//     node kin/scripts/release-guard.mjs [--remote <git url>] [--repo <owner/name>] [--github-output <file>]
//
// Reads version.edn's :version from this checkout and asks the outside world what of its
// release exists (kin/scripts/release-registry.mjs, read-only, User-Agent snug-release-check):
// the source tag src/v<version>, the dist tag v<version>, the GitHub release, both npm packages
// and the crate. Then:
//
//   action  noop     everything exists: nothing to do
//           release  no source tag: test, build, tag, release and publish this commit
//           resume   the source tag exists but something after it is missing: build the TAGGED
//                    commit (not this one) and do only the missing steps; its tests ran before
//                    it was tagged
//   commit           the commit to build: the source tag's target when it exists, else HEAD
//   need_*           tests, tag, dist, release, npm_snug, npm_wasm, crate: what is missing
//   run_build        whether the tests and the build run: whenever something is missing, and
//                    on every run that cannot write (--write false: a dry run, or a ref other
//                    than main) -- a dry run of a released version rebuilds it and checks its
//                    bytes against the registries (on main: the tagged commit; elsewhere: HEAD),
//                    a proof that the build still reproduces what was published
//
// A version already on a registry without a source tag (published by hand) is a 'release'
// run whose build must reproduce the registry's bytes (release-registry.mjs verify) before
// anything is tagged. version.edn's placeholder, or an invalid version, fails.
// --write true|false and --on-main true|false: what the run may do (release.yml's guard job
// decides them from the ref and the event); the default is false and true.
// With --github-output the result is also written as key=value lines for the workflow.
// --version V asks about V instead of version.edn's (a dry check); --self-test checks decide()
// on fixed states (no network) and exits.
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readVersionEdn, versionProblem } from './version-sites.mjs';
import { releaseState, PACKAGES } from './release-registry.mjs';

const argv = process.argv.slice(2);
const opt = (n, f) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : f; };

/** What is missing, and so what the run does, from a release state (release-registry.mjs). */
export function decide(s, head, { write = false, onMain = true } = {}) {
  const need = {
    tests: !s.srcTag,
    tag: !s.srcTag,
    dist: !s.distTag,
    release: !s.release,
    npm_snug: !s.npm['@3sln/snug'],
    npm_wasm: !s.npm['@3sln/snug-wasm'],
    crate: !s.crate,
  };
  const action = Object.values(need).every(x => !x) ? 'noop' : s.srcTag ? 'resume' : 'release';
  // a run that cannot write still tests and builds; a released version is rebuilt and its bytes
  // checked against the registries (D368)
  const run_build = action !== 'noop' || !write;
  if (action === 'noop' && !write) need.tests = true;
  const commit = action === 'noop' && !write && !onMain ? head : s.srcTag?.commit ?? head;
  return { action, commit, need, run_build };
}

if (argv.includes('--self-test')) {
  const T = { object: 'a'.repeat(40), commit: 'b'.repeat(40) }, H = 'c'.repeat(40), P = { integrity: 'x' };
  const all = { srcTag: T, distTag: T, release: true, npm: { '@3sln/snug': P, '@3sln/snug-wasm': P }, crate: { cksum: 'y' } };
  const none = { srcTag: null, distTag: null, release: false, npm: { '@3sln/snug': null, '@3sln/snug-wasm': null }, crate: null };
  const cases = [
    ['all of it exists', all, 'noop', T.commit, []],
    ['nothing exists', none, 'release', H, ['tests', 'tag', 'dist', 'release', 'npm_snug', 'npm_wasm', 'crate']],
    ['tagged, nothing published', { ...none, srcTag: T }, 'resume', T.commit, ['dist', 'release', 'npm_snug', 'npm_wasm', 'crate']],
    ['tagged and released, npm wasm and the crate missing', { ...all, npm: { '@3sln/snug': P, '@3sln/snug-wasm': null }, crate: null }, 'resume', T.commit, ['npm_wasm', 'crate']],
    ['published by hand, never tagged', { ...all, srcTag: null }, 'release', H, ['tests', 'tag']],
  ];
  const W = { write: true, onMain: true };
  let bad = 0;
  const check = (name, d, action, commit, missing, build) => {
    const got = Object.entries(d.need).filter(([, x]) => x).map(([k]) => k);
    const ok = d.action === action && d.commit === commit && JSON.stringify(got) === JSON.stringify(missing) && d.run_build === build;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}: ${d.action} ${d.commit.slice(0, 4)} missing [${got.join(', ')}] build ${d.run_build}`);
  };
  for (const [name, st, action, commit, missing] of cases) check(`${name} (may write)`, decide(st, H, W), action, commit, missing, action !== 'noop');
  // D368: a dry run of a released version tests and rebuilds it: on main the tagged commit, elsewhere HEAD
  check('all of it exists, dry run on main', decide(all, H, { write: false, onMain: true }), 'noop', T.commit, ['tests'], true);
  check('all of it exists, dry run off main', decide(all, H, { write: false, onMain: false }), 'noop', H, ['tests'], true);
  check('nothing exists, dry run', decide(none, H, { write: false, onMain: true }), 'release', H, ['tests', 'tag', 'dist', 'release', 'npm_snug', 'npm_wasm', 'crate'], true);
  process.exit(bad ? 1 : 0);
}

const edn = readVersionEdn();
const version = opt('version', edn.version);
if (!version || version === edn.placeholder || versionProblem(version)) {
  console.error(`release-guard: version.edn's :version ${JSON.stringify(version)} is not a release version${versionProblem(version) ? ` (${versionProblem(version)})` : ''}`);
  process.exit(1);
}
const s = await releaseState(version, { remote: opt('remote', 'https://github.com/3sln/snug.git'), repo: opt('repo', process.env.GITHUB_REPOSITORY || '3sln/snug') });
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const flag = (n, f) => { const v = opt(n, String(f)); if (v !== 'true' && v !== 'false') { console.error(`release-guard: --${n} is true or false`); process.exit(2); } return v === 'true'; };
const write = flag('write', false), onMain = flag('on-main', true);
const { action, commit, need, run_build } = decide(s, head, { write, onMain });
const out = { version, action, commit, head, write, run_build, need, state: s };
const missing = Object.entries(need).filter(([, x]) => x).map(([k]) => k);
console.error(action === 'noop' ? `release-guard: ${version} already released (src/v${version} on ${commit.slice(0, 12)}, dist v${version}, GitHub release, ${PACKAGES.npm.map(p => p.name).join(', ')}, ${PACKAGES.crate.name}) -> no-op`
  : `release-guard: ${version}: ${action} ${commit.slice(0, 12)}; missing: ${missing.join(', ')}`);
if (action === 'noop' && run_build) console.error(`release-guard: a run that cannot write: test, and rebuild ${commit.slice(0, 12)} to check its bytes against the registries`);
console.log(JSON.stringify(out, null, 2));
const gh = opt('github-output');
if (gh) appendFileSync(gh, [`version=${version}`, `action=${action}`, `commit=${commit}`, `run_build=${run_build}`, ...Object.entries(need).map(([k, x]) => `need_${k}=${x}`)].join('\n') + '\n');
