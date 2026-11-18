// The repository READMEs' GitHub-only blocks (D366 follow-up; repo-only blocks, D369).
//
// README.md, host/rust/README.md and host/wasm-sdk/README.md are also the GitHub
// pages of the repository. They may carry two kinds of block that no shipped copy carries:
//
//     <!-- prerelease -->      at most one per README, until the first release: the release
//     ... not yet on npm ...   commit removes it (docs/release-policy.md §4, the bump), and
//     <!-- /prerelease -->     `bb dist` refuses a source commit that still has one;
//
//     <!-- repo-only -->       any number, permanent: text for repository visitors only (such
//     ... design links ...     as links to the design documents, which do not ship); `bb dist`
//     <!-- /repo-only -->      lets them through.
//
// The npm package builds, kin/scripts/rust-crate and therefore `bb dist` take their READMEs
// through stripShipped, which removes every block of either kind. Each marker is alone on its
// line; blocks do not nest (neither kind inside the other); malformed markers make the strip
// throw, so a broken block can never ship half-stripped. bb docs-test checks both sides.
//
//     node kin/scripts/prerelease.mjs strip IN OUT     write IN as it ships (without its blocks)
//     node kin/scripts/prerelease.mjs check FILE...    exit 1 unless each has well-formed blocks only
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPEN = '<!-- prerelease -->';
export const CLOSE = '<!-- /prerelease -->';
export const REPO_OPEN = '<!-- repo-only -->';
export const REPO_CLOSE = '<!-- /repo-only -->';
/** The block kinds: their markers, a name for messages, and how many one README may hold. */
export const KINDS = {
  prerelease: { open: OPEN, close: CLOSE, name: 'pre-release', max: 1 },
  'repo-only': { open: REPO_OPEN, close: REPO_CLOSE, name: 'repo-only', max: Infinity },
};
/** Anything that looks like a marker of either kind, misspellings included. */
export const MARKER_LIKE = /<!--\s*\/?\s*(?:pre-?release|repo[\s_-]*only)\s*-->/i;
/** The repository's READMEs that may carry blocks. */
export const READMES = ['README.md', 'host/rust/README.md', 'host/wasm-sdk/README.md'];

/** The blocks of `text` ({ kind, open, close }, 0-based line numbers, in order) and the problems
 *  with its markers ([1-based line, message]). A marker is a line holding exactly one of the
 *  markers; one anywhere else in a line, or a misspelled one, is a problem. Well-formed: every
 *  opener closed by its own kind's closer, no block inside another, at most one pre-release block. */
export function readmeBlocks(text) {
  const blocks = [], problems = [];
  let open = null;   // { kind, line }
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim(), n = i + 1;
    const opens = Object.keys(KINDS).find(k => KINDS[k].open === line);
    const closes = Object.keys(KINDS).find(k => KINDS[k].close === line);
    if (!opens && !closes) {
      if (MARKER_LIKE.test(raw) || Object.values(KINDS).some(k => raw.includes(k.open) || raw.includes(k.close)))
        problems.push([n, 'a pre-release or repo-only marker that is not alone on its line (or misspelled)']);
      return;
    }
    if (opens) {
      if (open !== null) problems.push([n, `a nested ${KINDS[opens].open} (the ${KINDS[open.kind].name} block opened at line ${open.line + 1} is not closed; blocks do not nest)`]);
      else open = { kind: opens, line: i };
    } else if (open === null) problems.push([n, `${KINDS[closes].close} without an opener`]);
    else if (open.kind !== closes) problems.push([n, `${KINDS[closes].close} inside the ${KINDS[open.kind].name} block opened at line ${open.line + 1}`]);
    else { blocks.push({ kind: closes, open: open.line, close: i }); open = null; }
  });
  if (open !== null) problems.push([open.line + 1, `${KINDS[open.kind].open} is never closed`]);
  for (const [kind, { name, max }] of Object.entries(KINDS)) {
    const of = blocks.filter(b => b.kind === kind);
    if (of.length > max) problems.push([of[max].open + 1, `${of.length} ${name} blocks: at most ${max} is allowed`]);
  }
  return { blocks, problems };
}

/** The pre-release blocks of `text` ({ open, close }) and the problems with all its markers.
 *  Repo-only blocks are permanent and not listed (`bb dist` lets them through). */
export function prereleaseBlocks(text) {
  const { blocks, problems } = readmeBlocks(text);
  return { blocks: blocks.filter(b => b.kind === 'prerelease').map(({ open, close }) => ({ open, close })), problems };
}

/** `text` as it ships: without its pre-release and repo-only blocks (markers included, and one
 *  blank line after each when one precedes it). Throws on malformed markers. */
export function stripShipped(text, where = 'README') {
  const { blocks, problems } = readmeBlocks(text);
  if (problems.length) throw new Error(`${where}:${problems[0][0]}: ${problems[0][1]}`);
  if (!blocks.length) return text;
  const lines = text.split('\n');
  for (const { open, close } of [...blocks].reverse()) {
    let end = close + 1;
    if (end < lines.length && lines[end].trim() === '' && (open === 0 || lines[open - 1].trim() === '')) end++;
    lines.splice(open, end - open);
  }
  return lines.join('\n');
}

/** The non-blank lines (trimmed) inside `text`'s repo-only blocks, markers excluded: what no
 *  shipped copy may contain. Malformed markers give what the well-formed blocks hold. */
export function repoOnlyLines(text) {
  const lines = text.split('\n');
  return readmeBlocks(text).blocks.filter(b => b.kind === 'repo-only')
    .flatMap(({ open, close }) => lines.slice(open + 1, close).map(l => l.trim()).filter(Boolean));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'strip' && args.length === 2) writeFileSync(args[1], stripShipped(readFileSync(args[0], 'utf8'), args[0]));
    else if (cmd === 'check' && args.length) {
      let bad = 0;
      for (const f of args) for (const [n, p] of readmeBlocks(readFileSync(f, 'utf8')).problems) { console.error(`${f}:${n}: ${p}`); bad++; }
      process.exit(bad ? 1 : 0);
    } else { console.error('usage: prerelease.mjs strip IN OUT | check FILE...'); process.exit(2); }
  } catch (e) { console.error(`prerelease: ${e.message}`); process.exit(1); }
}
