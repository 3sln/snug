// docs-test (D366): the text that ships -- the npm packages' documents, declarations and
// examples, the crate's documents and rustdoc, and the user docs they link to -- reads as a
// released library's documentation.
//
//     node kin/scripts/docs-test.mjs          (bb docs-test; in the land and release sets)
//     node kin/scripts/docs-test.mjs --self-test
//
// 1. stale release state: no "not yet published", "private package", "unreleased",
//    "from a checkout only", the version placeholder ... (so a release cannot ship text that
//    says it is not released);
// 2. internal process: no decision numbers (D###), phase IDs (P#.#), "kin", "gate", or links
//    to DEVLOG, SPEC, architecture or Program-format design documents in the user docs,
//    declarations and rustdoc (the changelog may cite D### decisions, as its preamble says);
// 3. links: every relative Markdown link in the user docs names an existing file, and every
//    #anchor a heading of its target (GitHub's slugs).
// The file lists come from the packages' own allowlists (host/js/src/package-build.mjs,
// host/wasm-sdk/package-build.mjs) and the crate's `include` (host/rust/Cargo.toml).
// 4. the repository READMEs' pre-release block (kin/scripts/prerelease.mjs): at most one,
//    well-formed (one opener, then one closer, no nesting, no stray or inline marker); zero
//    is fine (the release commit removes it, and `bb dist` refuses a release that kept it).
//    The rules above read each README as it ships, without the block, and no shipped text
//    may hold a marker; links are checked in the repository's copy, block included.
// Watchdog caps: 120 s wall / 240 s CPU.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfWatch } from './watchdog.mjs';
import { READMES, prereleaseBlocks, stripPrerelease } from './prerelease.mjs';
selfWatch('docs-test', import.meta.url);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { PACKAGE_FILES: NPM } = await import(join(repo, 'host/js/src/package-build.mjs'));
const { PACKAGE_FILES: SDK } = await import(join(repo, 'host/wasm-sdk/package-build.mjs'));

// ---------------------------------------------------------------- the rules
export const STALE = [
  /\bnot (?:yet )?(?:been )?(?:published|released)\b/i,
  /\bnothing (?:is|has been|was) (?:yet )?(?:published|released)\b/i,
  /\b(?:until|before|once) (?:snug|it|the (?:package|crate)) (?:is|has been) (?:on npm|published|released)\b/i,
  /\bonce published\b/i,
  /\bnot yet (?:on|in) (?:npm|crates\.io)\b/i,
  /\bunreleased\b/i,                                    // the placeholder and "the package is unreleased"
  /\bpre-?release\b/i,
  /\b(?:package|packages|repository|repo|crate|manifest|manifests|library) (?:is|are) (?:still )?private\b/i,
  /\bprivate and experimental\b/i,
  /"private"\s*:\s*true|`private: true`/,
  /\bfrom a checkout only\b|\bonly from a (?:checkout|repository)\b/i,
  /\b(?:cannot|can't|does not|doesn't) (?:yet )?(?:be )?install(?:ed)? from (?:npm|crates\.io)\b/i,
];
// `## [Unreleased]` is the changelog's standing heading (Keep a Changelog)
const STALE_ALLOWED = [/^## \[Unreleased\]\s*$/];

export const INTERNAL = [
  [/\bD\d{3}\b/, 'a decision number (D###)'],
  [/\bP\d{1,2}\.\d{1,2}[a-z]?\b/, 'a phase ID (P#.#)'],
  [/\bkin\b(?![/-])/, '"kin" (say: the core / the generated core)'],
  [/\bgate[sd]?\b/i, '"gate" (say: test)'],
  [/\bDEVLOG\b|\bSPEC(?:\.md|\s+§)|\barchitecture\.md\b|\bprogram(?:-2)?\.md\b|docs\/(?:briefs|reviews)\//, 'a design or process document'],
];

export function staleHits(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (STALE_ALLOWED.some(r => r.test(line))) return;
    for (const r of STALE) if (r.test(line)) hits.push([i + 1, r.source, line.trim()]);
  });
  return hits;
}
export function internalHits(text, { decisions = true } = {}) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const [r, what] of INTERNAL) {
      if (!decisions && (what.startsWith('a decision') || what.startsWith('a design'))) continue;
      if (r.test(line)) hits.push([i + 1, what, line.trim()]);
    }
  });
  return hits;
}

// GitHub's heading slugs: lower case, drop what is not a letter, digit, space, '-' or '_',
// spaces to '-', repeats get -1, -2, ...
export function anchors(markdown) {
  const seen = new Map(), out = new Set();
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    const m = !fence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1].replace(/<[^>]+>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '').replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}
export function linkProblems(file, text, read = p => (existsSync(p) ? readFileSync(p, 'utf8') : null)) {
  const problems = [];
  let fence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    for (const [, href] of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      const [path, anchor] = href.split('#');
      const target = path ? posix.normalize(posix.join(posix.dirname(file), path)) : file;
      const abs = join(repo, target);
      if (path && !existsSync(abs)) { problems.push([i + 1, `${href}: no such file`]); continue; }
      if (anchor === undefined || !target.endsWith('.md')) continue;
      const body = target === file ? text : read(abs);
      if (body !== null && !anchors(body).has(anchor)) problems.push([i + 1, `${href}: no heading #${anchor} in ${target}`]);
    }
  });
  return problems;
}

// ---------------------------------------------------------------- the shipped text
function files() {
  const md = new Set(), decl = new Set(), code = new Set(), rust = new Set();
  // @3sln/snug: root documents, docs/, types/, examples/
  for (const f of NPM.root) if (f.endsWith('.md')) md.add(f);
  for (const d of NPM.docs) md.add('docs/' + d);
  for (const f of readdirSync(join(repo, 'host/js/types'))) if (f.endsWith('.d.ts')) decl.add('host/js/types/' + f);
  for (const f of readdirSync(join(repo, 'examples'))) if (f.endsWith('.mjs')) code.add('examples/' + f);
  // @3sln/snug-wasm: its README, docs/ (wasm-sdk.md and the native docs), types/
  md.add('host/wasm-sdk/README.md');
  for (const d of SDK.docs) md.add('docs/' + d);
  for (const f of readdirSync(join(repo, 'host/wasm-sdk/types'))) if (f.endsWith('.d.ts')) decl.add('host/wasm-sdk/types/' + f);
  // snug-cbor: Cargo.toml's include (README.md is host/rust/README.md; src/*.rs's rustdoc)
  const toml = readFileSync(join(repo, 'host/rust/Cargo.toml'), 'utf8');
  const include = [.../include\s*=\s*\[([\s\S]*?)\]/.exec(toml)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  for (const p of include) {
    if (p === '/README.md') md.add('host/rust/README.md');
    else if (/^\/[A-Z_]+\.md$/.test(p)) md.add(p.slice(1));
    else if (p === '/src/*.rs') for (const f of readdirSync(join(repo, 'host/rust/src'))) if (f.endsWith('.rs')) rust.add('host/rust/src/' + f);
  }
  // the user guide the READMEs send Rust users to
  md.add('docs/rust.md');
  return { md: [...md].sort(), decl: [...decl].sort(), code: [...code].sort(), rust: [...rust].sort() };
}
const rustdoc = text => text.split('\n').map(l => (/^\s*\/\/[/!]/.test(l) ? l : '')).join('\n');
const comments = text => text.split('\n').map(l => (/^\s*(\/\/|\/?\*)/.test(l) ? l : '')).join('\n');

/** What a README as shipped (or any shipped text) violates: a pre-release marker, stale text,
 *  internal references. Repo-side, `prereleaseBlocks(text).problems` covers well-formedness. */
export function shippedProblems(text, { decisions = true, internal = true } = {}) {
  const markers = text.split('\n').flatMap((l, i) => (/<!--\s*\/?\s*prerelease\s*-->/i.test(l) ? [[i + 1, 'pre-release marker', l.trim()]] : []));
  return [...markers, ...staleHits(text), ...(internal ? internalHits(text, { decisions }) : [])];
}
/** A repository README: its block problems, then what its shipped form violates. */
export function readmeProblems(text) {
  const { problems } = prereleaseBlocks(text);
  if (problems.length) return problems.map(([n, p]) => [n, 'pre-release block', p]);
  return shippedProblems(stripPrerelease(text));
}

function selfTest() {
  let bad = 0;
  const expect = (what, ok) => { if (!ok) { bad++; console.log(`  FAIL self-test: ${what}`); } };
  // the pre-release block: mutations of a well-formed README
  const O = '<!-- prerelease -->', C = '<!-- /prerelease -->', stale = 'Nothing is published to npm yet.';
  const good = `# x\n\n${O}\n> ${stale}\n${C}\n\n## Install\n`;
  expect('block: one well-formed block, stale text inside', readmeProblems(good).length === 0);
  expect('block: none at all', readmeProblems('# x\n\n## Install\n').length === 0);
  expect('block: stripped', stripPrerelease(good) === '# x\n\n## Install\n');
  for (const [what, t] of [['duplicated', good + `${O}\nx\n${C}\n`], ['nested', `${O}\n${O}\n${C}\n${C}\n`],
    ['closer first', `${C}\n${O}\n`], ['unclosed', `${O}\nx\n`], ['stray closer', `${O}\n${C}\n${C}\n`],
    ['inline marker', `text ${O} more\n`], ['misspelled', '<!--prerelease-->\n']])
    expect(`block: ${what} fails`, readmeProblems(t).length > 0);
  expect('block: stale text outside it fails', readmeProblems(`${good}\n${stale}\n`).length > 0);
  expect('block: a shipped README still carrying it fails', shippedProblems(`# x\n${O}\nok\n${C}\n`).length > 0);
  for (const s of ['Nothing is published to npm or crates.io yet.', 'The public JS package is private and experimental.',
    'The package is unreleased and private.', 'Until snug is on npm, build it.', '`cargo add snug-cbor` once published',
    'Every manifest is still `private: true`.', 'a checkout says `0.0.0-unreleased`', 'Use it from a checkout only.', 'Not yet on npm or crates.io.',
    '> **Status:** pre-release.'])
    expect(`stale: ${s}`, staleHits(s).length > 0);
  for (const s of ['## [Unreleased]', 'Report vulnerabilities privately.', 'Scratch arrays stay private.', 'npm install @3sln/snug'])
    expect(`not stale: ${s}`, staleHits(s).length === 0);
  for (const s of ['as decided (D342)', 'since P9.7', 'written in kin', 'gated by the suite', 'see DEVLOG.md', 'SPEC §4'])
    expect(`internal: ${s}`, internalHits(s).length > 0);
  for (const s of ['run `kin/scripts/rust-crate`', 'a P-256 key', 'aggregate', 'D3 tier'])
    expect(`not internal: ${s}`, internalHits(s).length === 0);
  const a = anchors('# A\n## Sources: `@3sln/snug/sources`\n## A\n```\n# not\n```\n## Option admission');
  expect('anchors', a.has('a') && a.has('a-1') && a.has('sources-3slnsnugsources') && a.has('option-admission') && !a.has('not'));
  return bad;
}

if (process.argv.includes('--self-test')) {
  const bad = selfTest();
  console.log(bad ? `  FAIL docs-test self-test: ${bad}` : '  ok   docs-test self-test');
  process.exit(bad ? 1 : 0);
}

let failed = selfTest();
const report = (file, hits, what) => {
  for (const [line, rule, text] of hits) console.log(`  ${file}:${line}: ${what} ${rule}: ${text.slice(0, 160)}`);
  failed += hits.length;
};
const { md, decl, code, rust } = files();
let blocks = 0;
for (const f of md) {
  const text = readFileSync(join(repo, f), 'utf8');
  // the READMEs as shipped, without their pre-release block; the notices credit the tools by name
  if (READMES.includes(f)) { report(f, readmeProblems(text), 'README'); blocks += prereleaseBlocks(text).blocks.length; }
  else report(f, shippedProblems(text, { decisions: f !== 'CHANGELOG.md', internal: f !== 'THIRD_PARTY_NOTICES.md' }), 'shipped text');
  // the SDK README sits at its package's root
  report(f, linkProblems(f === 'host/wasm-sdk/README.md' ? 'README.md' : f, text).map(([l, p]) => [l, '', p]), 'broken link');
}
for (const f of decl) {
  const text = readFileSync(join(repo, f), 'utf8');
  report(f, shippedProblems(text, { internal: false }), 'shipped text');
  report(f, internalHits(comments(text)), 'internal reference');
}
for (const f of code) report(f, shippedProblems(readFileSync(join(repo, f), 'utf8'), { internal: false }), 'shipped text');
for (const f of rust) report(f, shippedProblems(rustdoc(readFileSync(join(repo, f), 'utf8'))), 'shipped rustdoc');
console.log(`  ${failed ? 'FAIL' : 'ok  '} docs-test: ${md.length} documents, ${decl.length} declaration files, ${code.length} examples, ${rust.length} rustdoc sources, ${blocks} README pre-release block(s)${failed ? `; ${failed} problem(s)` : ''}`);
process.exit(failed ? 1 : 0);
