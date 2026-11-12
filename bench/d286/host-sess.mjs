// D286 A1/A3 (bench/D286-analysis.md, DEVLOG D325): the cost of one host VmSession
// (host/js/src/vm-session.mjs) per call, each validating a whole window under wire 'valid'.
// Workloads: 2000 maps x 8 keys and the map-heavy document, each encoded deterministic
// (det), with map keys reversed (rev) and with indefinite-length arrays and maps (ind).
// Prints one JSON line per workload and variant: thread CPU µs per call, median of the trials.
//
//     node --single-threaded-gc bench/d286/host-sess.mjs [tree] [trials]
//
// tree defaults to this checkout; pass another checkout (e.g. a worktree of an older commit)
// to compare, one tree per process, rotating the trees between rounds.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [treeArg, trialsArg = '7'] = process.argv.slice(2);
const root = path.resolve(treeArg ?? fileURLToPath(new URL('../..', import.meta.url)));
const load = rel => import(pathToFileURL(path.join(root, rel)).href);
const { compile } = await load('host/js/src/compile.mjs');
const { encode } = await load('host/js/src/index.mjs');
const { Program } = await load('host/js/src/schema-core.mjs');
const { VmSession } = await load('host/js/src/vm-session.mjs');
const cpu = () => { const u = process.threadCpuUsage(); return u.user + u.system; };
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const big = { maxEntries: 1 << 20, maxItems: 1 << 22, maxBytes: 1 << 28, top: 'any' };
const BIG = { depth: 64, inputBytes: 0x7fffffff, entries: 1 << 24, items: 1 << 24, budget: 0x7fffffff };
const many = Array.from({ length: 2000 }, (_, i) => ({ h: true, f: 'short', d: i, b: 2, g: null, e: i % 10, c: 'text', a: 1 }));
const doc = { records: Array.from({ length: 2000 }, (_, i) => ({ id: i, kind: 'note', title: 'A small benchmark document',
  meta: { owner: 'person', size: 128, active: true }, body: 'x'.repeat(35) })) };
const h = (m, n) => n < 24 ? [m << 5 | n] : n < 256 ? [m << 5 | 24, n] : [m << 5 | 25, n >> 8, n & 255];
const enc = (v, o) => {
  const out = [];
  const det = x => out.push(...encode(x, big));
  const walk = x => {
    if (Array.isArray(x)) {
      if (o.ind) out.push(0x9f); else out.push(...h(4, x.length));
      x.forEach(walk);
      if (o.ind) out.push(0xff);
      return;
    }
    if (x && typeof x === 'object') {
      let ks = Object.keys(x).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
      if (o.rev) ks.reverse();
      if (o.ind) out.push(0xbf); else out.push(...h(5, ks.length));
      for (const k of ks) { det(k); walk(x[k]); }
      if (o.ind) out.push(0xff);
      return;
    }
    det(x);
  };
  walk(v);
  return Uint8Array.from(out);
};
for (const [name, value, cddl] of [['2000 maps x 8 keys', many, 'r = [* { * tstr => any }]'],
  ['map-heavy', doc, 'r = { records: [* rec] }\nrec = { id: uint, kind: tstr, title: tstr, meta: { owner: tstr, size: uint, active: bool }, body: tstr }']]) {
  const C = compile(cddl, { limits: BIG }), prog = new Program(C.program, C.pool), rule = C.rules.indexOf('r');
  for (const [vn, o] of [['det', {}], ['rev', { rev: 1 }], ['ind', { ind: 1 }]]) {
    const bytes = enc(value, o);
    const f = () => {
      const s = new VmSession(prog, rule, bytes.length, { wire: 'valid' });
      const r = s.step(bytes, 0);
      if (r.state !== 'done' || !r.result.ok) throw new Error(JSON.stringify(r));
      return r;
    };
    for (let w = 0; w < 3; w++) f();
    const t0 = cpu(); f();
    const m = Math.max(1, Math.min(2000, Math.ceil(20000 / Math.max(1, cpu() - t0))));
    const xs = [];
    for (let r = 0; r < Number(trialsArg); r++) { const t = cpu(); for (let i = 0; i < m; i++) f(); xs.push((cpu() - t) / m); }
    console.log(JSON.stringify({ label: path.basename(root), name, vn, bytes: bytes.length, us: +median(xs).toFixed(1) }));
  }
}
