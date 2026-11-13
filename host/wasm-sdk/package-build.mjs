// P9.17 (D345): stage the @3sln/snug-wasm npm package in a NEW directory under
// the repository's .cache/ (the default, .cache/release/npm/snug-wasm, is
// replaced). The checkout keeps its relative imports into host/js and gen/js;
// only staged copies are rewritten.
//
//     node host/wasm-sdk/package-build.mjs [DEST] [--wasm=DIR]
//
// --wasm: a release directory staged by kin/scripts/wasm-release.mjs (default
// .cache/release/wasm), checked against its SHA256SUMS, so the package carries
// the release artefacts' exact bytes. The version is host/wasm-sdk/package.json's
// as checked in (a version site, release-policy §1.1): the placeholder, unless
// the tree was stamped for a release. The package build never stamps.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_FILES as NATIVE_FILES } from '../js/src/package-build.mjs';
import { readRelease } from '../../kin/scripts/wasm-release.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SDK = join(ROOT, 'host/wasm-sdk');
export const DEFAULT_DEST = join(ROOT, '.cache/release/npm/snug-wasm');

// What the package contains. package.test.mjs fails on any staged file outside it.
export const PACKAGE_FILES = Object.freeze({
  // README.md is host/wasm-sdk/README.md; the rest come from the repository root
  root: ['package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'README.md', 'CHANGELOG.md'],
  // the native package's user docs (the API is the same, D172) and the SDK's own
  docs: ['wasm-sdk.md', ...NATIVE_FILES.docs],
  // src: host/wasm-sdk/src (the entries' import closure) and the generated inline-wasm.mjs;
  // native: the host/js/src files that closure reaches; generated: the gen/js files;
  // types: host/wasm-sdk/types, with host/js/types under types/native;
  // wasm: the release modules and their MANIFEST.json
  dirs: ['src', 'native', 'generated', 'types', 'wasm'],
  wasm: ['snug.wasm', 'snug-compiler.wasm', 'MANIFEST.json'],
});

/** Is `path` (relative to the package root, '/'-separated) one PACKAGE_FILES allows? */
export function packageAllows(path) {
  if (PACKAGE_FILES.root.includes(path)) return true;
  if (path.startsWith('docs/')) return PACKAGE_FILES.docs.includes(path.slice(5));
  if (path.startsWith('wasm/')) return PACKAGE_FILES.wasm.includes(path.slice(5));
  return ['src', 'native', 'generated', 'types'].some(d => path.startsWith(d + '/') && /\.(mjs|d\.ts)$/.test(path));
}

// checkout file -> staged path
function stagedPath(abs) {
  const rel = relative(ROOT, abs).split(sep).join('/');
  for (const [from, to] of [['host/wasm-sdk/src/', 'src/'], ['host/js/src/', 'native/'], ['gen/js/', 'generated/']])
    if (rel.startsWith(from)) return to + rel.slice(from.length);
  throw new Error(`snug-wasm package: ${rel} is outside the staged trees`);
}
const IMPORTS = /(\b(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?|\bimport\(\s*)(['"])(\.[^'"]+)\2/g;

/** The package entries' import closure (static and literal dynamic edges): checkout paths. */
export function closure(entries) {
  const seen = new Set();
  const visit = abs => {
    if (seen.has(abs)) return;
    seen.add(abs);
    for (const m of readFileSync(abs, 'utf8').matchAll(IMPORTS)) visit(resolve(dirname(abs), m[3]));
  };
  for (const e of entries) visit(e);
  return [...seen];
}

// The links unlinkMissing would leave dangling become text plus the repository path (as the native build does).
function unlinkMissing(text, file, target) {
  return text.replace(/\[([^\]]+)\]\(([^)\s#]+)(#[^)\s]*)?\)/g, (all, label, href) => {
    if (/^[a-z]+:/i.test(href)) return all;
    const staged = posix.normalize(posix.join(posix.dirname(file), href));
    if (existsSync(join(target, staged))) return all;
    return `${label} (snug repository: \`${staged.replace(/\/$/, '')}\`)`;
  });
}

function replaceOnce(text, from, to, where) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`snug-wasm package: ${where} holds ${JSON.stringify(from)} ${n} times, not once`);
  return text.replace(from, to);
}

export function buildPackage(destination = DEFAULT_DEST, { wasm } = {}) {
  const target = resolve(destination);
  if (!target.startsWith(join(ROOT, '.cache') + '/')) throw new Error('snug-wasm package: the destination must be under the repository\'s .cache/');
  const releaseDir = resolve(wasm ?? join(ROOT, '.cache/release/wasm'));
  if (!existsSync(join(releaseDir, 'MANIFEST.json')))
    throw new Error(`snug-wasm package: no wasm release modules in ${relative(ROOT, releaseDir) || releaseDir}; ` +
      (wasm ? 'stage them with `bb wasm-release <dir>` and pass that directory' : 'run `bb wasm-release` first (it needs the pinned nightly toolchain and wasm-opt)'));
  if (target === DEFAULT_DEST) rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(target);   // EEXIST for an existing non-default destination: never overwritten
  const release = readRelease(releaseDir);
  const pkg = JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8'));

  // code: the closure of every exported module, rewritten to the staged layout
  const entries = Object.values(pkg.exports).map(e => e.default).filter(p => p?.endsWith('.mjs') && p !== './src/inline.mjs');
  const files = closure(entries.map(p => join(SDK, p)));
  files.push(join(SDK, 'src/inline.mjs'));   // its inline-wasm.mjs import is generated below
  for (const abs of files) {
    const out = stagedPath(abs);
    let code = readFileSync(abs, 'utf8').replace(IMPORTS, (all, head, q, spec) => {
      const dep = resolve(dirname(abs), spec);
      if (abs.endsWith('/inline.mjs') && spec === './inline-wasm.mjs') return all;
      let rel = posix.relative(posix.dirname(out), stagedPath(dep));
      if (!rel.startsWith('.')) rel = './' + rel;
      return head + q + rel + q;
    });
    if (out === 'src/runtime.mjs') {
      code = replaceOnce(code, "'../../../.cache/snug-wasm-sdk/snug.wasm'", "'../wasm/snug.wasm'", out);
      code = replaceOnce(code, "'../../../.cache/snug-wasm-cc/snug.wasm'", "'../wasm/snug-compiler.wasm'", out);
    }
    mkdirSync(dirname(join(target, out)), { recursive: true });
    writeFileSync(join(target, out), code);
  }
  const b64 = b => Buffer.from(b).toString('base64');
  writeFileSync(join(target, 'src/inline-wasm.mjs'),
    `// Generated by host/wasm-sdk/package-build.mjs from the release modules (wasm/MANIFEST.json). DO NOT EDIT.\n`
    + `export const RUNTIME_BASE64 = '${b64(release.modules['snug.wasm'])}';\n`
    + `export const COMPILER_BASE64 = '${b64(release.modules['snug-compiler.wasm'])}';\n`);

  // the wasm modules, byte for byte the release artefacts
  mkdirSync(join(target, 'wasm'));
  for (const [file, bytes] of Object.entries(release.modules)) writeFileSync(join(target, 'wasm', file), bytes);
  writeFileSync(join(target, 'wasm/MANIFEST.json'), JSON.stringify(release.manifest, null, 2) + '\n');

  // types: the SDK's declarations over the native ones
  cpSync(join(ROOT, 'host/js/types'), join(target, 'types/native'), { recursive: true });
  for (const name of readdirSync(join(SDK, 'types'))) {
    const code = readFileSync(join(SDK, 'types', name), 'utf8').replaceAll("'../../js/types/", "'./native/");
    writeFileSync(join(target, 'types', name), code);
  }

  // the manifest: development scripts need the checkout; engines follow the native package's (one declaration)
  delete pkg.scripts;
  const native = JSON.parse(readFileSync(join(ROOT, 'host/js/package.json'), 'utf8'));
  if (native.engines && !pkg.engines) pkg.engines = native.engines;
  writeFileSync(join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  // documents
  for (const name of PACKAGE_FILES.root) {
    if (name === 'package.json') continue;
    const from = name === 'README.md' ? join(SDK, 'README.md') : join(ROOT, name);
    if (existsSync(from)) cpSync(from, join(target, name));
    else throw new Error(`snug-wasm package: ${from} is missing`);
  }
  for (const name of PACKAGE_FILES.docs) {
    mkdirSync(dirname(join(target, 'docs', name)), { recursive: true });
    cpSync(join(ROOT, 'docs', name), join(target, 'docs', name));
  }
  const api = join(target, 'docs/api.md');
  writeFileSync(api, readFileSync(api, 'utf8').replaceAll('../host/js/types/', '../types/native/'));
  for (const file of [...PACKAGE_FILES.root, ...PACKAGE_FILES.docs.map(d => 'docs/' + d)]) {
    if (!file.endsWith('.md') || !existsSync(join(target, file))) continue;
    const path = join(target, file);
    writeFileSync(path, unlinkMissing(readFileSync(path, 'utf8'), file, target));
  }
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), wasm = args.find(a => a.startsWith('--wasm='))?.slice(7);
  console.log(buildPackage(args.find(a => !a.startsWith('--')), { wasm }));
}
