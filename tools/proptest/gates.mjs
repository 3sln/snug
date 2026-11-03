// P4.2 property 6: the existing Rust-parity gates with larger seeds and counts.
//
// The gates run in a tree chosen by --gates-tree:
//   head     (default) a fresh `git archive HEAD` snapshot in a scratch directory,
//            beside a `kin` symlink to ../kin, with .cache cloned (APFS copy-on-write
//            where available). Uncommitted work in the shared checkout (another
//            engineer's in-progress kin sources, gen/ files or gate scripts) can
//            neither break nor be overwritten by the campaign: the gates run
//            `emit` and write gen/ and .cache/ in whatever tree they run in.
//   working  this checkout, as it is.
//   <path>   an existing tree laid out like this one.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, symlinkSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));

/** [gate, (scale, seed) -> args]; defaults from each script's header, times `scale`. */
export const GATES = [
  ['scan-test', (k, s) => [30000 * k, s]],
  ['rscan-test', (k, s) => [20000 * k, s]],
  ['vm-test', (k, s) => [20000 * k, s, 400 * k]],
  ['vmsession-test', (k, s) => [20000 * k, s, 400 * k, 60 * k]],
  ['compile-fuzz', (k, s) => [3000 * k, s]],
  ['nav-test', (k, s) => [600 * k, s]],
  ['write-test', (k, s) => [3000 * k, s]],
  ['compile-test', (k, s) => [40 * k, s]],
  ['unicode-test', () => []],
];

export function prepareTree(mode, scratch) {
  if (mode === 'working') return { dir: repo, describe: 'working tree', cleanup() {} };
  if (mode !== 'head') return { dir: realpathSync(mode), describe: `tree ${mode}`, cleanup() {} };
  const base = mkdtempSync(join(scratch ?? tmpdir(), 'snug-proptest-'));
  const dir = join(base, 'snug');
  mkdirSync(dir);
  execFileSync('/bin/sh', ['-c', `git -C "$1" archive HEAD | tar -x -C "$2"`, 'sh', repo, dir]);
  symlinkSync(realpathSync(join(repo, '..', 'kin')), join(base, 'kin'));
  if (existsSync(join(repo, '.cache'))) {
    try { execFileSync('cp', ['-cR', join(repo, '.cache'), join(dir, '.cache')]); }
    catch { /* no clone support: the gates rebuild their crates */ }
  }
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
  return { dir, describe: `git archive of HEAD ${head} at ${dir}`, head, cleanup() { rmSync(base, { recursive: true, force: true }); } };
}

function run(dir, gate, args, logFile, timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(join(dir, 'kin/scripts', gate), args.map(String), { cwd: dir, env: { ...process.env, CARGO_NET_OFFLINE: 'true' } });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { out += `\n[proptest] gate killed after ${timeoutMs} ms\n`; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      mkdirSync(dirname(logFile), { recursive: true });
      writeFileSync(logFile, out);
      const lines = out.split('\n');
      resolve({ gate, args, exit: code, signal, ms: Date.now() - t0, log: logFile,
        fails: lines.filter(l => /^\s*FAIL/.test(l)).slice(0, 40),
        context: lines.filter(l => /FAIL|differs|^\s+(js|rs) |panic|PANIC/.test(l)).slice(0, 60),
        summary: lines.filter(l => /^\s*(ok|FAIL|info|SKIP|skip)\b|ℹ (pass|fail)/.test(l)).slice(-40) });
    });
  });
}

/** Rounds of every gate (seed = seedBase + round) until the time budget is spent; at least one round. */
export async function runGates({ tree, scale, seedBase, budgetMs, logDir, only, timeoutMs = 3600_000, onResult = () => {} }) {
  const results = [], t0 = Date.now();
  const gates = GATES.filter(([g]) => !only || only.includes(g));
  for (let round = 0; round === 0 || Date.now() - t0 < budgetMs; round++) {
    for (const [gate, args] of gates) {
      if (round > 0 && Date.now() - t0 >= budgetMs) break;
      if (round > 0 && gate === 'unicode-test') continue;   // seedless: once is enough
      const seed = seedBase + round;
      const res = await run(tree.dir, gate, args(scale, seed), join(logDir, `${gate}-r${round}.log`), timeoutMs);
      res.round = round; res.seed = seed;
      results.push(res); onResult(res);
    }
  }
  return results;
}
