// Stage a self-contained private package in a NEW scratch directory. Source
// checkouts keep their generated imports; only staged copies are rewritten.
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// What the package contains (release-policy §4 step 6, P9.15): the code, its
// types, the licence and notices, the README, the changelog and the user docs.
// Nothing else: no DEVLOG, SPEC, design or review documents, bench records,
// corpus or tools. package.test.mjs fails on any staged file outside this list.
export const PACKAGE_FILES = Object.freeze({
  root: ['package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'CHANGELOG.md'],
  docs: ['guide.md', 'api.md', 'profiles.md', 'profiles/bindle.md', 'cddl-support.md', 'conformance.md',
    'release-policy.md'],
  // whole directories, less the named development-only files
  dirs: ['src', 'types', 'generated', 'examples'],
  exclude: ['src/package-build.mjs', 'generated/snug/hello.mjs'],
});

/** Is `path` (relative to the package root, '/'-separated) one PACKAGE_FILES allows? */
export function packageAllows(path) {
  if (PACKAGE_FILES.exclude.includes(path)) return false;
  if (PACKAGE_FILES.root.includes(path)) return true;
  if (path.startsWith('docs/')) return PACKAGE_FILES.docs.includes(path.slice(5));
  return PACKAGE_FILES.dirs.some(d => path.startsWith(d + '/'));
}

// The repository's copy of a staged Markdown file links to files the package
// does not ship (DEVLOG, SPEC, bench records, design documents). Such a link
// becomes its text plus the repository path, so nothing dangles.
function unlinkMissing(text, file, target) {
  return text.replace(/\[([^\]]+)\]\(([^)\s#]+)(#[^)\s]*)?\)/g, (all, label, href) => {
    if (/^[a-z]+:/i.test(href)) return all;
    const staged = posix.normalize(posix.join(posix.dirname(file), href));
    if (existsSync(join(target, staged))) return all;
    return `${label} (snug repository: \`${staged.replace(/\/$/, '')}\`)`;
  });
}

export async function buildPackage(destination) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const repo = resolve(root, '../..');
  const scratch = resolve(tmpdir());
  let target;
  if (destination) {
    target = resolve(destination);
    // Build artifacts belong in the supplied scratch space, not gen/ or a
    // neighbouring checkout. Never remove/overwrite an existing destination.
    if (!target.startsWith(scratch + '/') && !target.startsWith('/private/tmp/') && !target.startsWith('/tmp/'))
      throw new Error('snug: package destination must be a new scratch directory');
    await mkdir(target);
  } else target = await mkdtemp(join(scratch, 'snug-package-'));
  const sources = { src: join(root, 'src'), types: join(root, 'types'), generated: join(repo, 'gen/js'),
    examples: join(repo, 'examples') };
  for (const d of PACKAGE_FILES.dirs) await cp(sources[d], join(target, d), { recursive: true });
  for (const name of PACKAGE_FILES.exclude) await rm(join(target, name));
  for (const name of await readdir(join(target, 'src'))) {
    if (!name.endsWith('.mjs')) continue;
    const path = join(target, 'src', name);
    const code = await readFile(path, 'utf8');
    await writeFile(path, code.replaceAll('../../../gen/js/', '../generated/'));
  }
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  // This is a consumer artifact; development scripts require the checkout.
  delete pkg.scripts;
  await writeFile(join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  for (const name of PACKAGE_FILES.root)
    if (name !== 'package.json') await cp(join(repo, name), join(target, name));
  for (const name of PACKAGE_FILES.docs) {
    await mkdir(dirname(join(target, 'docs', name)), { recursive: true });
    await cp(join(repo, 'docs', name), join(target, 'docs', name));
  }
  const entries = { 'index.mjs': 'snug', 'public-compile.mjs': 'snug/compile',
    'public-schema.mjs': 'snug/schema', 'public-view.mjs': 'snug/view',
    'public-writer.mjs': 'snug/writer', 'public-sources.mjs': 'snug/sources', 'public-sequence.mjs': 'snug/sequence',
    'controls.mjs': 'snug/controls' };
  for (const name of await readdir(join(target, 'examples'))) {
    if (!name.endsWith('.mjs')) continue;
    const path = join(target, 'examples', name);
    let code = await readFile(path, 'utf8');
    for (const [source, entry] of Object.entries(entries))
      code = code.replaceAll(`../host/js/src/${source}`, entry);
    await writeFile(path, code);
  }
  // Public reference links resolve within the staged package as well.
  const apiPath = join(target, 'docs', 'api.md');
  await writeFile(apiPath, (await readFile(apiPath, 'utf8')).replaceAll('../host/js/types/', '../types/'));
  for (const file of [...PACKAGE_FILES.root, ...PACKAGE_FILES.docs.map(d => 'docs/' + d)]) {
    if (!file.endsWith('.md')) continue;
    const path = join(target, file);
    await writeFile(path, unlinkMissing(await readFile(path, 'utf8'), file, target));
  }
  return target;
}

/** P9.16: the paths a staged package is built from that differ from the checkout's HEAD (modified,
 *  staged or untracked), or null when git cannot tell (no git, not a checkout). */
export function dirtyPaths(repo = resolve(fileURLToPath(new URL('../', import.meta.url)), '../..')) {
  const sources = ['host/js', 'gen/js', 'examples', 'docs', ...PACKAGE_FILES.root.filter(f => f !== 'package.json')];
  const r = spawnSync('git', ['status', '--porcelain', '--', ...sources], { cwd: repo, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split('\n').filter(Boolean).map(line => line.slice(3));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirty = dirtyPaths();
  if (dirty === null) console.warn('snug: warning: git could not report the checkout state; the staged package may not match a commit');
  else if (dirty.length) {
    console.warn(`snug: warning: the checkout has ${dirty.length} uncommitted change(s) in the package's sources; the staged package does not match HEAD:`);
    for (const p of dirty.slice(0, 20)) console.warn(`  ${p}`);
    if (dirty.length > 20) console.warn(`  ... and ${dirty.length - 20} more`);
  }
  console.log(await buildPackage(process.argv[2]));
}
