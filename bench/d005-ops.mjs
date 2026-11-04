// P7.9: the key rows repeated in headless Chrome and workerd (bench/d005-runtimes.mjs
// bundles this). Pure ESM, no Node APIs. prepare() answers { name: [native, wasm] }
// after checking that both answer identically.
import * as N from '../host/js/src/index.mjs';
import { compile as ncompile } from '../host/js/src/public-compile.mjs';
import { view as nview } from '../host/js/src/public-view.mjs';
import * as NSRC from '../host/js/src/sources.mjs';
import { compile as hcompile } from '../host/js/src/schema.mjs';
import * as W from '../host/wasm-sdk/src/index.mjs';
import { compile as wcompile, compilerSource } from '../host/wasm-sdk/src/compile.mjs';
import { view as wview } from '../host/wasm-sdk/src/view.mjs';
import * as WSRC from '../host/wasm-sdk/src/sources.mjs';
import { workloads, mutations, BIGL } from './d005-inputs.mjs';

export { W, compilerSource };

function same(a, b, path = '') {
  if (a === b) return;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    if (Number.isNaN(a) && Number.isNaN(b)) return;
    throw new Error(`answers differ at ${path}: ${String(a)} vs ${String(b)}`);
  }
  if (ArrayBuffer.isView(a)) { if (a.length !== b.length || a.some((x, i) => x !== b[i])) throw new Error(`bytes differ at ${path}`); return; }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) throw new Error(`keys differ at ${path}`);
  for (const k of ka) same(a[k], b[k], `${path}.${k}`);
}
const outcome = f => { try { return { ok: f() }; } catch (e) { return { err: e.name, code: e.code, reason: e.reason }; } };

export async function prepare(objectStorageCddl) {
  const W8 = workloads(objectStorageCddl), by = id => W8.find(w => w.id === id);
  for (const w of W8) {
    const limits = w.cddl === objectStorageCddl ? {} : { limits: BIGL };
    w.n = await ncompile(w.cddl, limits); w.w = await wcompile(w.cddl, limits); w.nh = await hcompile(w.cddl, limits);
  }
  const r = by('rpc287'), d = by('doc'), ints = by('ints'), muts = mutations(r.bytes, 1000);
  const nPick = v => [v.get('records').at(5000).get('meta').get('owner').text(), v.get('records').at(9999).get('id').number(), v.get('padding').length];
  const wPick = v => [v.path('records', 5000, 'meta', 'owner').text(), v.path('records', 9999, 'id').number(), v.path('padding').length];
  const push = (S, s) => { const b = d.bytes, p = S.pushValidator(s, b.length, 'r', d.opts); for (let i = 0; i < b.length; i += 1024) { let st = p.feed(b.subarray(i, i + 1024)); while (st.state === 'yield') st = p.resume(); } return p.finalize(); };
  const ops = {
    'validate rpc287': [() => r.n.validate(r.bytes, 'request'), () => r.w.validate(r.bytes, 'request')],
    'validate ints 584 KB': [() => ints.n.validate(ints.bytes, 'r', ints.opts), () => ints.w.validate(ints.bytes, 'r', ints.opts)],
    'validate doc 1.4 MB': [() => d.n.validate(d.bytes, 'r', d.opts), () => d.w.validate(d.bytes, 'r', d.opts)],
    'decode rpc287': [() => N.decode(r.bytes), () => W.decode(r.bytes)],
    'decode doc 1.4 MB': [() => N.decode(d.bytes, d.opts), () => W.decode(d.bytes, d.opts)],
    'encode rpc287': [() => N.encode(r.value), () => W.encode(r.value)],
    'encode ints': [() => N.encode(ints.value, ints.opts), () => W.encode(ints.value, ints.opts)],
    'view open + 3 fields, doc (fine-grained)': [() => nPick(nview(d.bytes, d.opts)), () => { const v = wview(d.bytes, d.opts); const x = nPick(v); v.release(); return x; }],
    'view open + 3 fields, doc (path)': [() => nPick(nview(d.bytes, d.opts)), () => { const v = wview(d.bytes, d.opts); const x = wPick(v); v.release(); return x; }],
    'pushValidator doc, 1 KiB chunks': [() => push(NSRC, d.nh), () => push(WSRC, d.w)],
    '1,000 mutated puts validated': [() => muts.map(m => r.n.validate(m, 'request')), () => muts.map(m => r.w.validate(m, 'request'))],
  };
  for (const [name, [a, b]] of Object.entries(ops)) same(outcome(a), outcome(b), name);
  return { ops, objectStorageCddl, compileOps: { 'compile object-storage': [() => ncompile(objectStorageCddl), () => wcompile(objectStorageCddl)] } };
}

/** Wall-clock medians, interleaved (no CPU clock in a page). */
export async function timeOps(ops, now, { reps = 9, minMs = 20 } = {}) {
  const out = {};
  for (const [name, fns] of Object.entries(ops)) {
    const ns = fns.map(fn => { fn(); fn(); let n = 1; for (;;) { const t = now(); for (let i = 0; i < n; i++) fn(); const dt = now() - t; if (dt >= minMs || n > 1 << 20) return n; n = dt < 1 ? n * 8 : Math.ceil(n * minMs / dt) + 1; } });
    const per = fns.map(() => []);
    for (let k = 0; k < reps; k++) fns.forEach((fn, j) => { const t = now(); for (let i = 0; i < ns[j]; i++) fn(); per[j].push((now() - t) / ns[j]); });
    out[name] = per.map(a => { a.sort((x, y) => x - y); return a[a.length >> 1]; });
    await new Promise(r => setTimeout(r, 0));
  }
  return out;
}
