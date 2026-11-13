// Stamp a release version onto every version site, then re-emit gen/ (P9.15
// rework, O2, D343).
//
//     bb stamp            stamp version.edn's :version
//     bb stamp 0.1.0-rc.1 stamp the given version (a test or a candidate build)
//
// Stamped versions are never checked in (owner, 2026-11-12). This tool runs
// only in a release build tree: a detached-HEAD worktree (`git worktree add
// --detach <dir> <commit>`) or a directory that is not a git checkout (an
// exported copy). It refuses a checkout with a branch checked out, so a
// stamped tree cannot be committed to main or a working branch by accident;
// `bb versions` and kin/scripts/pre-commit catch it if one is anyway.
//
// It rewrites only the version text at each site (kin/scripts/version-sites.mjs),
// so it is deterministic and idempotent: the same commit and version give the
// same tree, and a second run changes nothing.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROOT, readSites, readVersionEdn, siteMismatches, versionProblem, writeSites } from './version-sites.mjs';

/** Why the tree at `root` must not be stamped, or null. */
export function stampRefusal(root = ROOT) {
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const top = git('rev-parse', '--show-toplevel');
  // Not a checkout of its own (an exported copy, even one inside another checkout's .cache/).
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root)) return null;
  const branch = git('symbolic-ref', '-q', '--short', 'HEAD');
  if (branch.status === 0)
    return `${root} has branch ${branch.stdout.trim()} checked out. Stamped versions are never checked in ` +
      '(D343): stamp a detached release worktree (git worktree add --detach .cache/release <commit>) or an exported copy.';
  return null;
}

function fail(message, status = 1) { console.error(`stamp: ${message}`); process.exit(status); }

function main(args) {
  if (args.length > 1 || args.some(a => a.startsWith('-'))) fail('usage: bb stamp [version]   (default: version.edn :version)', 2);
  const edn = readVersionEdn();
  const version = args[0] ?? edn.version;
  const problem = versionProblem(version);
  if (problem) fail(problem, 2);
  if (version === edn.placeholder) fail(`${version} is the placeholder; nothing to stamp`, 2);
  const refusal = stampRefusal();
  if (refusal) fail(`refused. ${refusal}`);

  const changed = writeSites(ROOT, version);
  for (const f of changed) console.log(`  stamped ${f}`);
  const emit = spawnSync('bb', ['emit'], { cwd: ROOT, encoding: 'utf8' });
  if (emit.status !== 0) {
    process.stderr.write(emit.stdout + emit.stderr);
    fail('bb emit failed; the tree is half stamped. Discard it.');
  }
  const bad = siteMismatches(readSites(), version);
  if (bad.length) fail(bad.join('\n  '));
  console.log(`  ok   every version site, and gen/, holds ${version}${changed.length ? '' : ' (already stamped)'}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
  main(process.argv.slice(2));
