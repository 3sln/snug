// Stage a self-contained private package in a NEW scratch directory. Source
// checkouts keep their generated imports; only staged copies are rewritten.
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildPackage(destination) {
  const root = fileURLToPath(new URL('../', import.meta.url));
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
  await cp(join(root, 'src'), join(target, 'src'), { recursive: true });
  await cp(join(root, 'types'), join(target, 'types'), { recursive: true });
  await cp(resolve(root, '../../gen/js'), join(target, 'generated'), { recursive: true });
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
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'CHANGELOG.md', 'SPEC.md', 'DEVLOG.md'])
    await cp(resolve(root, '../..', name), join(target, name));
  await cp(resolve(root, '../../docs'), join(target, 'docs'), { recursive: true });
  await cp(resolve(root, '../../examples'), join(target, 'examples'), { recursive: true });
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
  await mkdir(join(target, 'bench'));
  const benchRoot = resolve(root, '../../bench');
  for (const name of await readdir(benchRoot))
    if (name.endsWith('.md')) await cp(join(benchRoot, name), join(target, 'bench', name));
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(await buildPackage(process.argv[2]));
