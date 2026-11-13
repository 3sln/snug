// P4.2 property worker: runs one property over (seed, index) cases until its
// deadline. The heartbeat words [seed, index, running] let the campaign's
// watchdog spot a case that does not finish; the campaign then terminates this
// worker, records the hang and starts a new worker at the next case.
import { parentPort, workerData } from 'node:worker_threads';
import { loadavg } from 'node:os';
import { PROPERTIES, doShrink, describe, injectSlow } from './props.mjs';
import { createRandom, caseSeed } from './gen.mjs';

const { prop, seeds: [lo, hi], seed: startSeed, index: startIndex, casesPerSeed, deadline, hb, maxShrinkPerSig, inject, injectSlow: slowKind } = workerData;
if (slowKind) injectSlow(slowKind);   // --inject-slow: this worker's next compile or validate is slow (self-check)
let injected = false;
const P = PROPERTIES[prop];
const beat = new Int32Array(hb);
const stats = { cases: 0 };
const shrunk = new Map();
let lastPost = Date.now();
const add = s => { for (const [k, v] of Object.entries(s)) stats[k] = (stats[k] ?? 0) + v; };
const postStats = () => { parentPort.postMessage({ type: 'stats', stats: { ...stats } }); for (const k of Object.keys(stats)) stats[k] = 0; lastPost = Date.now(); };

let seed = startSeed, index = startIndex;
while (Date.now() < deadline) {
  Atomics.store(beat, 0, seed); Atomics.store(beat, 1, index); Atomics.store(beat, 2, 1);
  const inputs = P.gen(createRandom(caseSeed(seed, prop, index)));
  const t0 = performance.now();
  let out;
  try { out = await P.check(inputs); }
  catch (e) {
    out = { failures: [{ cls: 'harness-throw', detail: 'the property check itself threw (harness or API bug)', actual: { name: e?.name, message: String(e?.message ?? e).slice(0, 300), stack: String(e?.stack ?? '').split('\n').slice(0, 6).join('\n') } }], stats: { cases: 1 } };
  }
  // --inject=P: one seeded known-bad result on this worker's first case, so a self-check can see the failure path
  // (worker -> record -> findings -> exit status) end to end
  if (inject === prop && !injected) { injected = true; out = { ...out, failures: [...out.failures, { cls: 'injected', detail: '--inject: a seeded known-bad result (self-check of the failure path)' }] }; }
  const ms = performance.now() - t0;
  Atomics.store(beat, 2, 0);
  add(out.stats);
  // non-failing warnings (wall-clock overruns): recorded with the load average at the time
  for (const w of out.warnings ?? [])
    parentPort.postMessage({ type: 'warning', warning: { sig: `P${prop}/${w.cls}`, prop, seed, index, cls: w.cls, detail: w.detail, repro: w.repro, loadavg: loadavg().map(x => Math.round(x * 100) / 100), caseMs: Math.round(ms) } });
  for (const f of out.failures) {
    const sig = `P${prop}/${f.cls}${f.sub ? '/' + f.sub : ''}`;
    const n = shrunk.get(sig) ?? 0;
    let minimized;
    if (f.shrink && n < maxShrinkPerSig) { minimized = doShrink(f); shrunk.set(sig, n + 1); }
    parentPort.postMessage({ type: 'failure', failure: { sig, prop, seed, index, cls: f.cls, sub: f.sub, detail: f.detail,
      expected: f.expected === undefined ? undefined : describe(f.expected), actual: f.actual === undefined ? undefined : describe(f.actual), repro: f.repro, minimized, caseMs: Math.round(ms) } });
  }
  index++;
  if (index >= casesPerSeed) { index = 0; seed = seed >= hi ? lo : seed + 1; }
  if (Date.now() - lastPost > 2000) postStats();
}
postStats();
parentPort.postMessage({ type: 'done', seed, index });
