// P9.1: the gate watchdog. Every gate runs under a CPU-time cap and a wall-clock cap;
// a gate that hits either fails loudly (naming the gate, its arguments and the cap) and
// never hangs silently (background: a `scan-test 300 1` that ran 6.5 days, dec5975).
//
//     node kin/scripts/watchdog.mjs <gate> -- <command> [args...]
//
// The command runs in its own process group; the watchdog samples the CPU time of that
// group's processes (`ps`, once a second: the gate's node, its cargo builds and Rust
// binaries) and kills only that group when a cap is reached, exit 124. Otherwise it exits
// with the command's own status. A sh gate re-executes itself under the watchdog
// (`[ -n "$SNUG_WATCHDOG" ] || exec node kin/scripts/watchdog.mjs <gate> -- "$0" "$@"`), a
// node gate through `selfWatch` below, so a direct run and a `bb` run are both watched.
//
// Caps (seconds) default per gate (DEFAULTS); override with
//   SNUG_GATE_WALL / SNUG_GATE_CPU                 every gate
//   SNUG_GATE_<GATE>_WALL / SNUG_GATE_<GATE>_CPU    one gate (name upper-cased, '-' -> '_')
//   --gate-wall=S / --gate-cpu=S                   on the gate's command line (removed
//                                                  before the gate sees its arguments)
// The CPU figure is the sum over the group's live processes plus the last sample of each
// process that has exited; a process that lives less than the sampling period may be
// missed, so the CPU cap is a backstop and the wall cap the guarantee.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// [wall, cpu] seconds. The CPU cap allows the parallel builds and Rust binaries a gate runs.
export const DEFAULTS = {
  'scan-test': [2400, 4800], 'rscan-test': [2400, 4800], 'compile-test': [2400, 4800], 'compile2-test': [2400, 4800],
  'unicode-test': [1800, 3600], 'vm-test': [3600, 7200], 'vmsession-test': [7200, 14400], 'sequence-test': [7200, 14400],
  'valid-test': [2400, 4800], 'compile-fuzz': [2400, 4800], 'nav-test': [1800, 3600], 'write-test': [1800, 3600],
  'drift': [900, 1800], 'check': [900, 1800], 'size': [900, 1800], 'types-test': [600, 1200], 'proptest': [10800, 43200], 'crate-diff': [3600, 7200],
  'rust-api-test': [1200, 2400], 'rust-api-test-full': [3600, 7200], 'wasm-sdk-test': [5400, 10800], 'rfc-corpus': [2400, 4800], 'watchdog-test': [300, 600],
  'js-target-test': [900, 1800], 'regexp-test': [1800, 3600], 'runtime': [2400, 4800], 'abnf-test': [2400, 4800],
  'regexp-diff': [300, 600], 'wasm-size': [3600, 7200], 'node-oldest': [3600, 7200], 'msrv': [2400, 4800],
  'wasm-package-test': [3600, 7200],
};
const FALLBACK = [3600, 7200];

/** The caps for a gate, after the environment and the gate's own --gate-* arguments. */
export function caps(gate, args = [], env = process.env) {
  let [wall, cpu] = DEFAULTS[gate] ?? FALLBACK;
  const key = gate.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const num = (v, what) => { const n = Number(v); if (!(n > 0)) throw new Error(`watchdog: ${what} must be a positive number of seconds, not ${JSON.stringify(v)}`); return n; };
  if (env.SNUG_GATE_WALL) wall = num(env.SNUG_GATE_WALL, 'SNUG_GATE_WALL');
  if (env.SNUG_GATE_CPU) cpu = num(env.SNUG_GATE_CPU, 'SNUG_GATE_CPU');
  if (env[`SNUG_GATE_${key}_WALL`]) wall = num(env[`SNUG_GATE_${key}_WALL`], `SNUG_GATE_${key}_WALL`);
  if (env[`SNUG_GATE_${key}_CPU`]) cpu = num(env[`SNUG_GATE_${key}_CPU`], `SNUG_GATE_${key}_CPU`);
  const rest = [];
  for (const a of args) {
    const m = /^--gate-(wall|cpu)=(.*)$/.exec(a);
    if (!m) { rest.push(a); continue; }
    if (m[1] === 'wall') wall = num(m[2], '--gate-wall'); else cpu = num(m[2], '--gate-cpu');
  }
  return { wall, cpu, args: rest };
}

// ps's TIME column: [[dd-]hh:]mm:ss[.cc] -> seconds
const seconds = t => {
  let days = 0;
  if (t.includes('-')) { const [d, r] = t.split('-'); days = Number(d); t = r; }
  return days * 86400 + t.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
};

/** CPU seconds of every process in process group pgid (pid -> seconds). */
function groupCpu(pgid) {
  let out;
  try { out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,time='], { encoding: 'utf8' }); } catch { return null; }
  const m = new Map();
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length === 3 && Number(f[1]) === pgid) m.set(Number(f[0]), seconds(f[2]));
  }
  return m;
}

/** Run a command under the caps. Answers the exit status (124 on a cap). */
export async function run(gate, cmd, rawArgs, { env = process.env, period = 1000 } = {}) {
  const { wall, cpu, args } = caps(gate, rawArgs, env);
  const child = spawn(cmd, args, { stdio: 'inherit', detached: true, env: { ...env, SNUG_WATCHDOG: '1' } });
  const pgid = child.pid, start = Date.now(), seen = new Map();
  let tripped = null;
  const kill = sig => { try { process.kill(-pgid, sig); } catch {} };
  const stop = msg => {
    if (tripped) return;
    tripped = msg;
    console.error(`\nWATCHDOG FAIL ${msg}\n  gate: ${gate}\n  command: ${[cmd, ...args].join(' ')}\n  caps: wall ${wall} s, cpu ${cpu} s (override: SNUG_GATE_${gate.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_WALL / _CPU, SNUG_GATE_WALL / _CPU, --gate-wall= / --gate-cpu=)`);
    kill('SIGTERM');
    setTimeout(() => kill('SIGKILL'), 5000).unref();
  };
  // a signal to the watchdog itself ends the gate's whole group too
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { kill('SIGKILL'); process.exit(130); });
  const timer = setInterval(() => {
    const el = (Date.now() - start) / 1000;
    if (el > wall) return stop(`${gate} exceeded its wall-clock cap: ${el.toFixed(0)} s > ${wall} s`);
    const m = groupCpu(pgid);
    if (m) for (const [pid, s] of m) seen.set(pid, Math.max(seen.get(pid) ?? 0, s));
    let total = 0; for (const s of seen.values()) total += s;
    if (total > cpu) stop(`${gate} exceeded its CPU-time cap: ${total.toFixed(0)} s > ${cpu} s`);
  }, period);
  const status = await new Promise(res => child.on('exit', (code, signal) => res(code ?? 128 + (signal === 'SIGKILL' ? 9 : signal === 'SIGTERM' ? 15 : 1))));
  clearInterval(timer);
  // the gate's leftover processes (a killed gate's children) go with it
  kill('SIGKILL');
  return tripped ? 124 : status;
}

/** A node gate: re-run this process under the watchdog unless it already is (call first). */
export function selfWatch(gate, metaUrl) {
  if (process.env.SNUG_WATCHDOG) return;
  const me = fileURLToPath(import.meta.url);
  const r = spawnSync(process.execPath, [me, gate, '--', process.execPath, ...process.execArgv, fileURLToPath(metaUrl), ...process.argv.slice(2)],
    { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [gate, sep, cmd, ...rest] = process.argv.slice(2);
  if (!gate || sep !== '--' || !cmd) { console.error('usage: node kin/scripts/watchdog.mjs <gate> -- <command> [args...]'); process.exit(2); }
  process.exit(await run(gate, cmd, rest));
}
