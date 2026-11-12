// P9.1: the gate watchdog trips on slow gates, names the gate, its arguments and the cap,
// kills the gate's whole process group (and nothing else), and otherwise passes the
// gate's status and arguments through.      node kin/scripts/watchdog-test.mjs  (bb watchdog-test)
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caps } from './watchdog.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const wd = join(root, 'kin/scripts/watchdog.mjs');
let fails = 0;
const line = (ok, s) => { if (!ok) fails++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${s}`); };
const env0 = { ...process.env }; delete env0.SNUG_WATCHDOG;
for (const k of Object.keys(env0)) if (k.startsWith('SNUG_GATE_')) delete env0[k];
const watch = (gate, cmd, args, env = {}) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [wd, gate, '--', cmd, ...args], { cwd: root, env: { ...env0, ...env }, encoding: 'utf8', timeout: 600000 });
  return { status: r.status, out: r.stdout + r.stderr, s: (Date.now() - t0) / 1000 };
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// 1. the CPU cap: a busy loop
{
  const r = watch('busy-gate', process.execPath, ['-e', 'for (;;) {}'], { SNUG_GATE_CPU: '2', SNUG_GATE_WALL: '120' });
  line(r.status === 124 && /WATCHDOG FAIL busy-gate exceeded its CPU-time cap/.test(r.out) && /gate: busy-gate/.test(r.out) && r.s < 30,
    `CPU cap: a busy loop under a 2 s CPU cap stops with 124 after ${r.s.toFixed(1)} s, naming the gate and the cap`);
}
// 2. the wall cap, set by the gate's own --gate-wall= argument (removed before the command sees it)
{
  const r = watch('sleepy-gate', '/bin/sleep', ['60', '--gate-wall=2']);
  line(r.status === 124 && /exceeded its wall-clock cap/.test(r.out) && /command: \/bin\/sleep 60\n/.test(r.out) && r.s < 30,
    `wall cap: sleep 60 under --gate-wall=2 stops with 124 after ${r.s.toFixed(1)} s; the message names the command and its arguments`);
}
// 3. the whole process group goes: a grandchild burning CPU is killed with its parent
{
  mkdirSync(join(root, '.cache'), { recursive: true });
  const dir = mkdtempSync(join(root, '.cache', 'watchdog-test-'));
  const pidFile = join(dir, 'pid');
  const r = watch('family-gate', '/bin/sh', ['-c', `${process.execPath} -e 'for (;;) {}' & echo $! > ${pidFile}; wait`], { SNUG_GATE_WALL: '3' });
  const gpid = Number(readFileSync(pidFile, 'utf8'));
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) { gone = !alive(gpid); if (!gone) spawnSync('/bin/sleep', ['0.1']); }
  rmSync(dir, { recursive: true, force: true });
  line(r.status === 124 && gpid > 0 && gone, `group kill: the gate's grandchild (pid ${gpid}) is gone after the cap`);
}
// 4. pass-through: status and arguments
{
  const r1 = watch('ok-gate', '/bin/sh', ['-c', 'exit 3']);
  const r2 = watch('args-gate', process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a', '--gate-cpu=50', 'b c']);
  line(r1.status === 3 && r2.status === 0 && r2.out.includes('["a","b c"]'), 'pass-through: the gate\'s exit status (3) and its arguments (the --gate-* ones removed) reach the caller unchanged');
}
// 5. defaults and overrides
{
  const d = caps('scan-test', [], {});
  const e = caps('scan-test', ['--gate-wall=7', 'x'], { SNUG_GATE_WALL: '5', SNUG_GATE_SCAN_TEST_CPU: '9' });
  let bad = false; try { caps('scan-test', ['--gate-cpu=0'], {}); } catch { bad = true; }
  line(d.wall > 0 && d.cpu > 0 && e.wall === 7 && e.cpu === 9 && e.args.join() === 'x' && bad,
    `caps: scan-test defaults ${d.wall} s wall / ${d.cpu} s CPU; env and --gate-* override (the flag last); a non-positive cap is refused`);
}
// 6. real gates trip: a sh gate (scan-test 300 1, the 6.5-day run's arguments) and a node gate (size)
{
  const r = spawnSync(join(root, 'kin/scripts/scan-test'), ['300', '1'], { cwd: root, env: { ...env0, SNUG_GATE_SCAN_TEST_WALL: '3' }, encoding: 'utf8', timeout: 600000 });
  const out = r.stdout + r.stderr;
  line(r.status === 124 && /WATCHDOG FAIL scan-test exceeded its wall-clock cap/.test(out) && /command: \S*scan-test 300 1\n/.test(out),
    'bb scan-test 300 1 under a 3 s wall cap fails with 124, naming scan-test, "300 1" and the cap');
  // the size gate needs bench/compare's esbuild, which a fresh git worktree lacks
  if (!existsSync(join(root, 'bench/compare/node_modules/esbuild/lib/main.js'))) {
    line(false, 'a node gate (size) under --gate-wall=1: esbuild is missing -- run `npm ci` in bench/compare, or symlink ' +
      'bench/compare/node_modules to an existing checkout\'s (AGENTS.md "Worktrees")');
  } else {
    const s = spawnSync(process.execPath, [join(root, 'tools/size/size.mjs'), '--gate-wall=1'], { cwd: root, env: env0, encoding: 'utf8', timeout: 600000 });
    const so = s.stdout + s.stderr;
    line(s.status === 124 && /WATCHDOG FAIL size exceeded its wall-clock cap/.test(so), 'a node gate (tools/size/size.mjs, selfWatch) under --gate-wall=1 fails with 124');
  }
}
console.log(fails ? `  FAIL ${fails} failure(s)` : '  ok   watchdog-test');
process.exit(fails ? 1 : 0);
