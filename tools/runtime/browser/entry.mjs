// Browser arm: bundled by esbuild (ESM, code splitting so snug/compile stays a
// lazily loaded chunk) and served from loopback under a strict CSP.
import { runSuite } from '../suite.mjs';
import { prepareOps } from '../ops.mjs';

const errors = [];
addEventListener('error', e => errors.push(String(e.message)));
addEventListener('unhandledrejection', e => errors.push(String(e.reason?.stack ?? e.reason)));
const consoleErrors = [], consoleError = console.error.bind(console);
console.error = (...a) => { consoleErrors.push(a.map(String).join(' ')); consoleError(...a); };
const out = document.getElementById('out');
const now = () => performance.now();
let report;
try {
  const fx = await (await fetch('fixtures.json')).json();
  const t0 = now(), compiled = await runSuite(fx, { now, compiler: true });
  const t1 = now(), precompiled = await runSuite(fx, { now, compiler: false });
  const t2 = now();
  // Wall time per call (the page has no CPU clock); batches sized as in Node.
  const { ops, counts, yields } = await prepareOps(fx), perCall = {};
  for (const [name, f] of Object.entries(ops)) {
    const n = counts[name];
    for (let i = 0; i < Math.min(n, 50); i++) await f();
    const s = now(); for (let i = 0; i < n; i++) await f();
    perCall[name] = +((now() - s) * 1000 / n).toFixed(3);
  }
  // What one cooperative yield costs with each primitive (130 chained yields, as scanYield does).
  const primitives = { setTimeout0: () => new Promise(r => setTimeout(r, 0)) };
  { const ch = new MessageChannel(), q = []; ch.port1.onmessage = () => q.shift()(); primitives.messageChannel = () => new Promise(r => { q.push(r); ch.port2.postMessage(0); }); }
  if (globalThis.scheduler?.yield) primitives.schedulerYield = () => scheduler.yield();
  const yieldMs = {};
  for (const [name, y] of Object.entries(primitives)) { const s = now(); for (let i = 0; i < 130; i++) await y(); yieldMs[name] = +((now() - s) / 130).toFixed(3); }
  report = { runtime: 'browser', yieldMsPerYield: yieldMs, userAgent: navigator.userAgent, crossOriginIsolated,
    float16: typeof Float16Array === 'function', evalBlocked: window.__evalBlocked,
    functionBlocked: window.__functionBlocked, compiled, precompiled, perCallUs: perCall, yields,
    wallMs: { compiled: +(t1 - t0).toFixed(1), precompiled: +(t2 - t1).toFixed(1) } };
} catch (e) {
  // What one cooperative yield costs with each primitive (130 chained yields, as scanYield does).
  const primitives = { setTimeout0: () => new Promise(r => setTimeout(r, 0)) };
  { const ch = new MessageChannel(), q = []; ch.port1.onmessage = () => q.shift()(); primitives.messageChannel = () => new Promise(r => { q.push(r); ch.port2.postMessage(0); }); }
  if (globalThis.scheduler?.yield) primitives.schedulerYield = () => scheduler.yield();
  const yieldMs = {};
  for (const [name, y] of Object.entries(primitives)) { const s = now(); for (let i = 0; i < 130; i++) await y(); yieldMs[name] = +((now() - s) / 130).toFixed(3); }
  report = { runtime: 'browser', yieldMsPerYield: yieldMs, fatal: String(e?.stack ?? e) };
}
report.violations = window.__cspViolations; report.errors = errors; report.consoleErrors = consoleErrors;
out.textContent = JSON.stringify(report, null, 1);
await fetch('result', { method: 'POST', body: JSON.stringify(report) });
