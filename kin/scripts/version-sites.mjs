// The snug version's sites, read and written in one place (P9.15 rework, O2,
// D343). `version.edn` at the repository root is the single source:
//
//   :version      the version a release build stamps (`bb stamp`)
//   :placeholder  what every version site in the tracked tree holds
//
// Stamped versions are never checked in (owner, 2026-11-12). main and every
// working branch hold the placeholder at every site; only build output (a
// release worktree or directory, the npm tarball, the crate) is stamped.
//
//     node kin/scripts/version-sites.mjs            check: every site holds the placeholder
//     node kin/scripts/version-sites.mjs --list     print each site and its value
//     node kin/scripts/version-sites.mjs --staged   check the index instead (pre-commit)
//
// Used by `bb versions` (a land and release gate), kin/scripts/pre-commit,
// kin/scripts/stamp.mjs and host/js/test/version.test.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Semantic Versioning 2.0.0's grammar (semver.org's suggested expression).
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// The Program container's producer field is 32 bytes of printable ASCII
// (program.md §13.3; host/rust/src/program.rs refuses more). semver is ASCII,
// which kin's str-len / str-u8 also need.
export const MAX_VERSION_BYTES = 32;

/** Why `v` cannot be a snug version, or null when it can. */
export function versionProblem(v) {
  if (typeof v !== 'string' || !SEMVER.test(v)) return `${JSON.stringify(v)} is not a semver string`;
  if (v.length > MAX_VERSION_BYTES)
    return `${JSON.stringify(v)} is ${v.length} bytes; the Program container's producer field holds ${MAX_VERSION_BYTES}`;
  return null;
}

/** version.edn's two keys. The file is a flat map of keyword to string. */
export function parseVersionEdn(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const code = line.replace(/;.*$/, '');
    for (const [, key, value] of code.matchAll(/:([a-z-]+)\s+"([^"\\]*)"/g)) out[key] = value;
  }
  for (const key of ['version', 'placeholder']) {
    const problem = versionProblem(out[key]);
    if (problem) throw new Error(`version.edn :${key}: ${problem}`);
  }
  if (out.version === out.placeholder) throw new Error('version.edn: :version and :placeholder must differ');
  return { version: out.version, placeholder: out.placeholder };
}

export const readVersionEdn = (root = ROOT) => parseVersionEdn(readFileSync(join(root, 'version.edn'), 'utf8'));

// Each site is a file and one regular expression whose group 2 is the version.
// Group 1 and 3 are kept byte for byte, so stamping rewrites only the version.
// A site must match exactly once.
const pkg = /^(  "version": ")([^"]*)(",)$/m;
const cargo = /^(\[package\]\n(?:(?!\[)[^\n]*\n)*?version = ")([^"]*)(")$/m;
export const SITES = Object.freeze([
  { file: 'kin/compile/main.kin', what: 'kin snug-version literal (in every Program\'s source key)',
    re: /(\(defn \^:pub \^Str snug-version \[\][\s\S]*?\(return ")([^"]*)("\)\))/ },
  { file: 'host/js/package.json', what: 'npm @3sln/snug', re: pkg },
  { file: 'host/wasm-sdk/package.json', what: 'npm @3sln/snug-wasm', re: pkg },
  { file: 'host/rust/Cargo.toml', what: 'crate snug-cbor', re: cargo },
  { file: 'host/wasm/Cargo.toml', what: 'crate snug_wasm (the .wasm build)', re: cargo },
  { file: 'host/js/src/version.mjs', what: 'JS runtime SNUG_VERSION', re: /^(export const SNUG_VERSION = ')([^']*)(';)$/m },
]);
// Generated from kin/compile/main.kin by `bb emit` (stamp.mjs re-emits; bb drift
// checks they are current). Read-only here: they are checked, never edited.
export const GENERATED = Object.freeze([
  { file: 'gen/js/snug/compile/main.mjs', re: /(export function snugVersion\(\) \{\n(?:\s*\/\/[^\n]*\n)*\s*return ")([^"]*)(";)/ },
  { file: 'gen/rust/snug/compile/main.rs', re: /(pub fn snug_version\(\) -> &'static str \{\n(?:\s*\/\/[^\n]*\n)*\s*return ")([^"]*)(";)/ },
]);

function matchOnce(site, text) {
  const all = [...text.matchAll(new RegExp(site.re.source, site.re.flags + 'g'))];
  if (all.length !== 1) throw new Error(`${site.file}: the version site matched ${all.length} times, not once`);
  return all[0];
}

/** [{file, what, value}] for the hand-written sites and the generated ones. */
export function readSites(root = ROOT, read = p => readFileSync(join(root, p), 'utf8')) {
  return [...SITES, ...GENERATED].map(site => {
    let value = null, error = null;
    try { value = matchOnce(site, read(site.file))[2]; } catch (e) { error = e.message; }
    return { file: site.file, what: site.what ?? 'generated from kin/compile/main.kin', value, error };
  });
}

/** Every site that does not hold `want`, as messages. */
export function siteMismatches(sites, want) {
  return sites.filter(s => s.value !== want)
    .map(s => s.error ?? `${s.file} holds ${JSON.stringify(s.value)}, not ${JSON.stringify(want)}`);
}

/** Write `version` into every hand-written site; returns the files that changed. */
export function writeSites(root, version) {
  const problem = versionProblem(version);
  if (problem) throw new Error(problem);
  const changed = [];
  for (const site of SITES) {
    const path = join(root, site.file), text = readFileSync(path, 'utf8');
    const m = matchOnce(site, text);
    const next = text.slice(0, m.index) + m[1] + version + m[3] + text.slice(m.index + m[0].length);
    if (next !== text) { writeFileSync(path, next); changed.push(site.file); }
  }
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // --staged: what the index holds, for kin/scripts/pre-commit
  const read = process.argv.includes('--staged')
    ? p => execFileSync('git', ['-C', ROOT, 'show', `:${p}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    : p => readFileSync(join(ROOT, p), 'utf8');
  const { placeholder, version } = parseVersionEdn(read('version.edn'));
  const sites = readSites(ROOT, read);
  if (process.argv.includes('--list')) {
    console.log(`version.edn: :version ${version}  :placeholder ${placeholder}`);
    for (const s of sites) console.log(`  ${s.value ?? '?'}\t${s.file}${s.error ? `  (${s.error})` : ''}`);
  }
  const bad = siteMismatches(sites, placeholder);
  if (bad.length) {
    console.error('FAIL a version site does not hold version.edn\'s :placeholder. Stamped versions are never');
    console.error('     checked in (D343); `bb stamp` runs only in a release worktree or directory.');
    for (const m of bad) console.error(`  ${m}`);
    process.exit(1);
  }
  console.log(`  ok   all ${sites.length} version sites hold the placeholder ${placeholder} (version.edn)`);
}
