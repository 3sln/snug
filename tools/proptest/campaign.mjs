// P4.2: the consolidated property-based test campaign over the whole library.
//
//   node tools/proptest/campaign.mjs [options]          (bb proptest [options])
//
//   --minutes=N         time budget for properties 1-5 (default 10); the gates (6) run
//                       concurrently for the same budget, always at least one round
//   --seeds=A..B        campaign seed range (default 1..1000000); each worker cycles it
//   --cases-per-seed=N  cases per seed before moving to the next (default 250)
//   --props=1,2,3,4,5,6 which properties (default all)
//   --workers=1:2,2:1   workers per property (default 1:2,2:1,3:1,4:1,5:2)
//   --timeout=MS        per-case watchdog (default 20000): a case that does not finish is a hang
//   --tree=head|working  the tree under test (default head): head re-runs this
//                       campaign inside a `git archive HEAD` snapshot (plus this
//                       tools/proptest), so uncommitted work in the shared checkout
//                       is never imported by properties 1-5 nor emitted by the gates
//   --gate-scale=K      multiply each gate's default case/mutation counts (default 10)
//   --gates=a,b         only these gates
//   --out=DIR           findings directory (default tools/proptest/findings)
//   --replay=P:SEED:IDX re-run one case and print its inputs and failures
//
// Properties (props.mjs): 1 schema x value (oracle, decode, validateAt, budget),
// 2 codec (encode == Writer == cbor.mjs, round trip, mutations), 3 views,
// 4 serialised Programs, 5 robustness (error types, sources, hangs, budgets),
// 6 the Rust-parity gates (gates.mjs). Each failure is reported with its seed,
// index, inputs (hex/text), expected vs actual and, for the first few of each
// signature, a minimised reproduction. findings/triage.json (hand-written)
// classifies signatures; the summary carries that classification forward.
import { Worker } from 'node:worker_threads';
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { prepareTree, runGates, repo } from './gates.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a); if (!m) throw new Error(`bad argument ${a}`); return [m[1], m[2] ?? 'true']; }));
const known = ['minutes', 'seeds', 'cases-per-seed', 'props', 'workers', 'timeout', 'tree', 'gate-scale', 'gates', 'out', 'replay', 'scratch', 'in-snapshot', 'log-dir', 'snapshot-of'];
for (const k of Object.keys(args)) if (!known.includes(k)) throw new Error(`unknown option --${k}`);
const minutes = Number(args.minutes ?? 10);
if (args.tree && !['head', 'working'].includes(args.tree)) throw new Error('--tree is head or working');
const [seedLo, seedHi] = (args.seeds ?? '1..1000000').split('..').map(Number);
const casesPerSeed = Number(args['cases-per-seed'] ?? 250);
const props = (args.props ?? '1,2,3,4,5,6').split(',').map(Number);
const workersPer = { 1: 2, 2: 1, 3: 1, 4: 1, 5: 2, ...Object.fromEntries((args.workers ?? '').split(',').filter(Boolean).map(x => x.split(':').map(Number))) };
const timeoutMs = Number(args.timeout ?? 20000);
const outDir = args.out ?? join(repo, 'tools/proptest/findings');
const budgetMs = minutes * 60_000;

// ------------------------------------------------------------------ replay
if (args.replay) {
  const [p, s, i] = args.replay.split(':').map(Number);
  const { PROPERTIES, describe, doShrink } = await import('./props.mjs');
  const { createRandom, caseSeed } = await import('./gen.mjs');
  const inputs = PROPERTIES[p].gen(createRandom(caseSeed(s, p, i)));
  console.log(JSON.stringify({ inputs: describeInputs(inputs, describe) }, null, 1).slice(0, 20000));
  const out = await PROPERTIES[p].check(inputs);
  for (const f of out.failures) console.log(JSON.stringify({ cls: f.cls, sub: f.sub, detail: f.detail, expected: describe(f.expected), actual: describe(f.actual), repro: f.repro, minimized: doShrink(f) }, null, 1));
  console.log(JSON.stringify(out.stats));
  process.exit(0);
}
function describeInputs(inputs, describe) {
  return JSON.parse(JSON.stringify(inputs, (k, v) => {
    if (v instanceof Uint8Array && v.constructor === Uint8Array) return { $hex: Buffer.from(v).toString('hex') };
    if (typeof v === 'bigint' || (v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)) return describe(v);
    return v;
  }));
}

// ------------------------------------------------------------------ snapshot
if ((args.tree ?? 'head') === 'head' && !args['in-snapshot']) {
  const { spawnSync } = await import('node:child_process');
  const { cpSync } = await import('node:fs');
  const snap = prepareTree('head', args.scratch);
  cpSync(join(repo, 'tools/proptest'), join(snap.dir, 'tools/proptest'), { recursive: true, filter: src => !src.includes('/findings/') || src.endsWith('triage.json') });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rest = process.argv.slice(2).filter(a => !/^--(tree|out|log-dir|in-snapshot|snapshot-of)=/.test(a));
  console.log(`[proptest] running inside ${snap.describe}`);
  const child = spawnSync(process.execPath, [join(snap.dir, 'tools/proptest/campaign.mjs'), ...rest, '--tree=working', '--in-snapshot=true',
    `--out=${outDir}`, `--log-dir=${join(repo, '.cache/proptest', stamp)}`, `--snapshot-of=${snap.head}`], { stdio: 'inherit' });
  snap.cleanup();
  process.exit(child.status ?? 1);
}

// ------------------------------------------------------------------ run
const started = new Date();
const head = args['snapshot-of'] ?? execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();
const dirty = args['in-snapshot'] ? [] : execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', 'kin', 'gen', 'host', 'corpus', 'bench/baseline']).toString().trim().split('\n').filter(Boolean);
const treeDescription = args['in-snapshot'] ? `git archive of HEAD ${head} (+ working tools/proptest) at ${repo}` : `checkout ${repo}`;
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (/^P\d.*\.json$|^summary\.json$/.test(f)) rmSync(join(outDir, f));
const logDir = args['log-dir'] ?? join(repo, '.cache/proptest', started.toISOString().replace(/[:.]/g, '-'));
mkdirSync(logDir, { recursive: true });
const triage = existsSync(join(outDir, 'triage.json')) ? JSON.parse(readFileSync(join(outDir, 'triage.json'), 'utf8')) : {};
const log = m => { const line = `[${((Date.now() - started) / 1000).toFixed(0)}s] ${m}`; console.log(line); try { writeFileSync(join(logDir, 'campaign.log'), line + '\n', { flag: 'a' }); } catch { /* ignore */ } };
log(`tree under test: ${treeDescription}`);
log(`P4.2 campaign: ${minutes} min, seeds ${seedLo}..${seedHi}, ${casesPerSeed} cases/seed, properties ${props.join(',')}, timeout ${timeoutMs} ms; HEAD ${head}${dirty.length ? `; uncommitted under kin/gen/host/corpus: ${dirty.length} paths (--tree=working: they are under test)` : ''}`);

const sigs = new Map();   // sig -> {count, examples: []}
const perProp = {};
for (const p of props.filter(p => p <= 5)) perProp[p] = { stats: {}, failures: 0, hangs: 0, crashes: 0, workers: workersPer[p] ?? 1 };
function record(f) {
  let s = sigs.get(f.sig);
  if (!s) { s = { count: 0, examples: [] }; sigs.set(f.sig, s); log(`new failure signature ${f.sig} (seed ${f.seed} index ${f.index})`); }
  s.count++;
  if (s.examples.length < 3) s.examples.push(f);
  if (perProp[f.prop]) perProp[f.prop].failures++;
  try { writeFileSync(join(logDir, 'failures.jsonl'), JSON.stringify(f) + '\n', { flag: 'a' }); } catch { /* ignore */ }
}

const deadline = Date.now() + budgetMs;
const running = [];
async function startProp(p) {
  const { PROPERTIES, describe } = await import('./props.mjs');
  const { createRandom, caseSeed } = await import('./gen.mjs');
  const n = workersPer[p] ?? 1, span = Math.max(1, Math.floor((seedHi - seedLo + 1) / n));
  const jobs = [];
  for (let w = 0; w < n; w++) {
    const lo = seedLo + w * span, hi = w === n - 1 ? seedHi : lo + span - 1;
    jobs.push(new Promise(resolve => {
      let cur = { seed: lo, index: 0 };
      const spawnWorker = () => {
        const hb = new SharedArrayBuffer(12), beat = new Int32Array(hb);
        const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { prop: p, seeds: [lo, hi], seed: cur.seed, index: cur.index, casesPerSeed, deadline, hb, maxShrinkPerSig: 2 }, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
        let finished = false, seen = '', since = Date.now();
        const watch = setInterval(() => {
          const s = Atomics.load(beat, 0), i = Atomics.load(beat, 1), on = Atomics.load(beat, 2);
          const key = `${s}:${i}:${on}`;
          if (key !== seen) { seen = key; since = Date.now(); return; }
          if (on && Date.now() - since > timeoutMs) {
            finished = true; clearInterval(watch);
            worker.terminate();
            const inputs = PROPERTIES[p].gen(createRandom(caseSeed(s, p, i)));
            perProp[p].hangs++;
            record({ sig: `P${p}/hang`, prop: p, seed: s, index: i, cls: 'hang', detail: `no result after ${timeoutMs} ms`, repro: describeInputs(inputs, describe) });
            cur = next(s, i, lo, hi); spawnWorker();
          }
        }, 250);
        worker.on('message', m => {
          if (m.type === 'stats') for (const [k, v] of Object.entries(m.stats)) perProp[p].stats[k] = (perProp[p].stats[k] ?? 0) + v;
          else if (m.type === 'failure') record(m.failure);
          else if (m.type === 'done') { finished = true; clearInterval(watch); resolve(); }
        });
        worker.on('error', e => {
          if (finished) return;
          finished = true; clearInterval(watch);
          const s = Atomics.load(beat, 0), i = Atomics.load(beat, 1);
          perProp[p].crashes++;
          record({ sig: `P${p}/worker-crash`, prop: p, seed: s, index: i, cls: 'worker-crash', detail: String(e?.message ?? e).slice(0, 300), actual: { name: e?.name, stack: String(e?.stack ?? '').split('\n').slice(0, 8).join('\n') } });
          cur = next(s, i, lo, hi);
          if (Date.now() < deadline) spawnWorker(); else resolve();
        });
        worker.on('exit', () => { if (!finished) { finished = true; clearInterval(watch); if (Date.now() < deadline) { cur = next(Atomics.load(beat, 0), Atomics.load(beat, 1), lo, hi); spawnWorker(); } else resolve(); } });
      };
      spawnWorker();
    }));
  }
  await Promise.all(jobs);
}
const next = (s, i, lo, hi) => (i + 1 >= casesPerSeed ? { seed: s >= hi ? lo : s + 1, index: 0 } : { seed: s, index: i + 1 });

for (const p of props.filter(p => p <= 5)) running.push(startProp(p));
let gateResults = [], tree = null, gateCount = 0;
if (props.includes(6)) {
  running.push((async () => {
    tree = prepareTree('working');
    log(`gates in ${tree.describe}`);
    gateResults = await runGates({ tree, scale: Number(args['gate-scale'] ?? 10), seedBase: seedLo * 1000 + 1, budgetMs, logDir: join(logDir, 'gates'),
      only: args.gates?.split(','), onResult: r => (gateCount++, r.exit !== 0 && record({ sig: `P6/${r.gate}`, prop: 6, seed: r.seed, index: r.round, cls: 'gate-failed', detail: `${r.gate} ${r.args.join(' ')} exited ${r.exit}${r.signal ? ' ' + r.signal : ''}`, actual: { fails: r.fails, context: r.context }, repro: { gate: r.gate, args: r.args, log: r.log } }), log(`gate ${r.gate} round ${r.round} seed ${r.seed} args [${r.args.join(' ')}]: exit ${r.exit} in ${(r.ms / 1000).toFixed(0)} s${r.fails.length ? ' -- ' + r.fails[0].trim() : ''}`)) });
  })());
}
const progress = setInterval(() => log(Object.entries(perProp).map(([p, x]) => `P${p} ${x.stats.cases ?? 0} cases/${x.failures} failures`).join(', ') + ` | ${sigs.size} signatures | gate runs ${gateCount}`), 60_000);
await Promise.all(running);
clearInterval(progress);
tree?.cleanup?.();

// ------------------------------------------------------------------ write findings
const wallMs = Date.now() - started;
const safe = s => s.replace(/[^A-Za-z0-9_.-]+/g, '-');
const findings = [];
for (const [sig, s] of [...sigs].sort()) {
  const files = s.examples.map((f, k) => { const name = `${safe(sig)}-${k + 1}.json`; writeFileSync(join(outDir, name), JSON.stringify({ ...f, triage: triage[sig] }, null, 1) + '\n'); return name; });
  findings.push({ sig, count: s.count, triage: triage[sig]?.class ?? 'untriaged', files });
}
const summary = {
  campaign: 'P4.2', started: started.toISOString(), wallMs, minutes, seeds: [seedLo, seedHi], casesPerSeed, timeoutMs, head, uncommittedPaths: dirty.length,
  machine: { node: process.version, platform: `${process.platform} ${process.arch}`, cpus: cpus().length, cpu: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30) },
  properties: Object.fromEntries(Object.entries(perProp).map(([p, x]) => [p, { workers: x.workers, cases: x.stats.cases ?? 0, stats: x.stats, failures: x.failures, hangs: x.hangs, workerCrashes: x.crashes }])),
  gates: gateResults.map(r => ({ gate: r.gate, round: r.round, seed: r.seed, args: r.args, exit: r.exit, signal: r.signal, seconds: Math.round(r.ms / 1000), fails: r.fails, summary: r.summary })),
  tree: treeDescription, gateTree: tree?.describe, logDir,
  findings,
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
log(`done in ${(wallMs / 60000).toFixed(1)} min: ${Object.entries(perProp).map(([p, x]) => `P${p} ${x.stats.cases ?? 0} cases`).join(', ')}; ${gateResults.length} gate runs (${gateResults.filter(r => r.exit !== 0).length} failed); ${findings.length} failure signatures`);
for (const f of findings) log(`  ${f.sig}: ${f.count} (${f.triage})`);
process.exit(0);
