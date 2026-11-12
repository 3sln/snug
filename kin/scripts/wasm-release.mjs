// P9.17 (D345): the wasm release artefacts. Builds the two modules the SDK ships
// (kin/scripts/wasm-build sdk | cc: the pinned nightly, -Zbuild-std, the pinned
// binaryen wasm-opt) and stages them, with their SHA-256 and how they were made,
// in a fresh directory:
//
//     node kin/scripts/wasm-release.mjs [DEST]      (bb wasm-release; default .cache/release/wasm)
//
//   snug.wasm            the runtime module (validate, decode, encode, views, sessions)
//   snug-compiler.wasm   the compiler module (compile)
//   SHA256SUMS           `sha256sum -c` format
//   MANIFEST.json        version (the version site host/wasm-sdk/package.json, so a
//                        placeholder unless the tree was stamped), commit, the build
//                        inputs that are not clean, toolchain (rustc -vV), wasm-opt,
//                        per module: build, bytes, gzip -9, sha256, required wasm features
//
// The npm package (host/wasm-sdk/package-build.mjs) takes its modules from here,
// so the package's bytes are the release artefact's. Without the nightly or
// wasm-opt, wasm-build answers SKIP and so does this (exit 3). DEST must be a new
// directory under the repository's .cache/ (the default is replaced).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_DEST = join(ROOT, '.cache/release/wasm');
export const MODULES = Object.freeze([
  { file: 'snug.wasm', mode: 'sdk', role: 'runtime', build: 'host/wasm (feature sdk), opt-level 3, LTO, one codegen unit; wasm-opt -O3 --strip-debug --strip-producers' },
  { file: 'snug-compiler.wasm', mode: 'cc', role: 'compiler', build: 'host/wasm (feature compiler), opt-level "z", LTO, one codegen unit; wasm-opt -Oz --strip-debug --strip-producers' },
]);
// The features wasm-build's wasm-opt step is told about (what rustc's wasm32 target may emit).
const FEATURES = ['bulk-memory', 'sign-ext', 'mutable-globals', 'nontrapping-float-to-int', 'multivalue', 'reference-types'];
const WASM_OPT = join(ROOT, 'bench/compare/node_modules/binaryen/bin/wasm-opt');

const sha256 = b => createHash('sha256').update(b).digest('hex');
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim();

/** The pinned toolchain: wasm-build's default, or SNUG_WASM_TOOLCHAIN when set. */
export function toolchain() {
  const pinned = readFileSync(join(ROOT, 'kin/scripts/wasm-build'), 'utf8').match(/SNUG_WASM_TOOLCHAIN:-([^}]+)\}/)[1];
  return { pinned, used: process.env.SNUG_WASM_TOOLCHAIN || pinned };
}

/** The features a module cannot validate without: each is dropped in turn from wasm-build's set. */
function requiredFeatures(path) {
  const valid = enabled => spawnSync(process.execPath, [WASM_OPT, '--mvp-features', ...enabled.map(f => '--enable-' + f), path],
    { stdio: 'ignore' }).status === 0;
  const needed = FEATURES.filter(f => !valid(FEATURES.filter(g => g !== f)));
  if (!valid(needed)) throw new Error(`${path}: does not validate with only ${needed.join(', ') || 'MVP'} enabled`);
  return needed;
}

export function release(dest = DEFAULT_DEST) {
  dest = resolve(dest);
  if (!dest.startsWith(join(ROOT, '.cache') + '/')) throw new Error('wasm-release: DEST must be under the repository\'s .cache/');
  for (const m of MODULES) {
    const r = spawnSync(join(ROOT, 'kin/scripts/wasm-build'), [m.mode], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (r.status === 3) return { skip: `kin/scripts/wasm-build ${m.mode} answered SKIP (the pinned nightly or wasm-opt is missing)` };
    if (r.status !== 0) throw new Error(`kin/scripts/wasm-build ${m.mode} exited ${r.status}`);
    m.built = resolve(ROOT, r.stdout.trim());
  }
  if (dest === DEFAULT_DEST) rmSync(dest, { recursive: true, force: true });
  else if (existsSync(dest)) throw new Error(`wasm-release: ${dest} exists; give a new directory`);
  mkdirSync(dest, { recursive: true });
  const tc = toolchain();
  const rustc = execFileSync('rustup', ['which', '--toolchain', tc.used, 'rustc'], { encoding: 'utf8' }).trim();
  const pkg = JSON.parse(readFileSync(join(ROOT, 'host/wasm-sdk/package.json'), 'utf8'));
  // build inputs with uncommitted changes (the artefact then does not match the commit)
  const inputs = ['host/wasm', 'host/rust/src', 'gen/rust', 'kin/scripts/wasm-build', 'kin/scripts/rust-crate'];
  const dirty = sh('git', ['status', '--porcelain', '--', ...inputs]).split('\n').filter(Boolean);
  const manifest = {
    artefact: 'snug wasm modules (the @3sln/snug-wasm SDK loads them)',
    version: pkg.version,
    commit: sh('git', ['rev-parse', 'HEAD']),
    dirtyInputs: dirty,
    toolchain: { pinned: tc.pinned, used: tc.used, rustc: execFileSync(rustc, ['-vV'], { encoding: 'utf8' }).trim().split('\n'),
      target: 'wasm32-unknown-unknown', flags: '-Zbuild-std=std,panic_abort -Zunstable-options -Cpanic=immediate-abort' },
    wasmOpt: execFileSync(process.execPath, [WASM_OPT, '--version'], { encoding: 'utf8' }).trim() + ' (binaryen '
      + JSON.parse(readFileSync(join(ROOT, 'bench/compare/node_modules/binaryen/package.json'), 'utf8')).version + ', bench/compare)',
    modules: {},
  };
  const sums = [];
  for (const m of MODULES) {
    const out = join(dest, m.file);
    copyFileSync(m.built, out);
    const bytes = readFileSync(out);
    manifest.modules[m.file] = { role: m.role, build: m.build, from: relative(ROOT, m.built), bytes: bytes.length,
      gzip: gzipSync(bytes, { level: 9 }).length, sha256: sha256(bytes), features: requiredFeatures(out) };
    sums.push(`${sha256(bytes)}  ${m.file}`);
  }
  writeFileSync(join(dest, 'SHA256SUMS'), sums.join('\n') + '\n');
  writeFileSync(join(dest, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { dest, manifest };
}

/** Read a staged release directory back, checking every module against SHA256SUMS and MANIFEST.json. */
export function readRelease(dir = DEFAULT_DEST) {
  const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8'));
  const sums = new Map(readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n').map(l => l.split(/\s+/).reverse()));
  const modules = {};
  for (const m of MODULES) {
    const bytes = readFileSync(join(dir, m.file)), h = sha256(bytes);
    if (h !== sums.get(m.file) || h !== manifest.modules[m.file]?.sha256) throw new Error(`${dir}/${m.file}: SHA-256 does not match SHA256SUMS / MANIFEST.json`);
    modules[m.file] = bytes;
  }
  return { manifest, modules };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = release(process.argv[2]);
  if (r.skip) { console.log(`SKIP wasm-release -- ${r.skip}`); process.exit(3); }
  console.log(r.dest);
  for (const [file, m] of Object.entries(r.manifest.modules))
    console.log(`  ${file}  ${m.bytes} B, ${m.gzip} B gzip -9, sha256 ${m.sha256}, features: ${m.features.join(', ')}`);
  console.log(`  toolchain ${r.manifest.toolchain.used} (${r.manifest.toolchain.rustc[0]}); ${r.manifest.wasmOpt}; commit ${r.manifest.commit}${r.manifest.dirtyInputs.length ? ' + uncommitted build inputs' : ''}`);
}
