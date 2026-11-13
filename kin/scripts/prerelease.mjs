// The repository READMEs' pre-release block (D366 follow-up).
//
// README.md, host/rust/README.md and host/wasm-sdk/README.md are also the GitHub
// pages of the repository. Until the first release they carry one block
//
//     <!-- prerelease -->
//     ... not yet on npm or crates.io; build from a checkout ...
//     <!-- /prerelease -->
//
// that no shipped copy carries: the npm package builds, kin/scripts/rust-crate and
// therefore `bb dist` take their READMEs through stripPrerelease. The release commit
// removes the block (docs/release-policy.md §4 step 3), and `bb dist` refuses a
// release whose source commit still has one. bb docs-test checks both sides.
//
//     node kin/scripts/prerelease.mjs strip IN OUT     write IN without its block
//     node kin/scripts/prerelease.mjs check FILE...    exit 1 unless each has at most one well-formed block
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPEN = '<!-- prerelease -->';
export const CLOSE = '<!-- /prerelease -->';
/** The repository's READMEs that may carry the block. */
export const READMES = ['README.md', 'host/rust/README.md', 'host/wasm-sdk/README.md'];

/** The blocks of `text` ({ open, close } 0-based line numbers) and the problems with its markers.
 *  A marker is a line holding exactly OPEN or CLOSE; one anywhere else in a line is a problem.
 *  Well-formed: at most one block, opener before closer, no nesting, nothing unbalanced. */
export function prereleaseBlocks(text) {
  const blocks = [], problems = [];
  let open = null;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim(), n = i + 1;
    const isOpen = line === OPEN, isClose = line === CLOSE;
    if (!isOpen && !isClose) {
      if (raw.includes(OPEN) || raw.includes(CLOSE) || /<!--\s*\/?\s*prerelease\s*-->/i.test(raw))
        problems.push([n, 'a pre-release marker that is not alone on its line (or misspelled)']);
      return;
    }
    if (isOpen) {
      if (open !== null) problems.push([n, `a nested ${OPEN} (the block opened at line ${open + 1} is not closed)`]);
      else open = i;
    } else if (open === null) problems.push([n, `${CLOSE} without an opener`]);
    else { blocks.push({ open, close: i }); open = null; }
  });
  if (open !== null) problems.push([open + 1, `${OPEN} is never closed`]);
  if (blocks.length > 1) problems.push([blocks[1].open + 1, `${blocks.length} pre-release blocks: at most one is allowed`]);
  return { blocks, problems };
}

/** `text` without its pre-release block (markers included, and one blank line after it). Throws on
 *  malformed markers, so a broken block can never ship half-stripped. */
export function stripPrerelease(text, where = 'README') {
  const { blocks, problems } = prereleaseBlocks(text);
  if (problems.length) throw new Error(`${where}:${problems[0][0]}: ${problems[0][1]}`);
  if (!blocks.length) return text;
  const lines = text.split('\n'), { open, close } = blocks[0];
  let end = close + 1;
  if (end < lines.length && lines[end].trim() === '' && (open === 0 || lines[open - 1].trim() === '')) end++;
  lines.splice(open, end - open);
  return lines.join('\n');
}

/** `text` with the block's lines blanked (line numbers kept): what rules outside the block see. */
export function outsidePrerelease(text) {
  const { blocks } = prereleaseBlocks(text);
  const lines = text.split('\n');
  for (const { open, close } of blocks) for (let i = open; i <= close; i++) lines[i] = '';
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'strip' && args.length === 2) writeFileSync(args[1], stripPrerelease(readFileSync(args[0], 'utf8'), args[0]));
    else if (cmd === 'check' && args.length) {
      let bad = 0;
      for (const f of args) for (const [n, p] of prereleaseBlocks(readFileSync(f, 'utf8')).problems) { console.error(`${f}:${n}: ${p}`); bad++; }
      process.exit(bad ? 1 : 0);
    } else { console.error('usage: prerelease.mjs strip IN OUT | check FILE...'); process.exit(2); }
  } catch (e) { console.error(`prerelease: ${e.message}`); process.exit(1); }
}
