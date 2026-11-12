// D286 (bench/D286-analysis.md): what each kind of non-deterministic encoding costs under the
// valid-CBOR machinery, one kind at a time. The workloads of bench/valid-vm-bench.mjs, encoded
// as: det (deterministic), rev (map keys reversed), ind (indefinite arrays and maps), nsh (small
// ints with a one-byte argument), istr (text strings as two indefinite chunks), all (ind + rev +
// nsh). Arms: vm (the buffer driver vmValidateV), sess (the session VM through
// kin/scripts/vmsession-run.mjs, whole window; prints its steps and needs) and scan (scanCb).
// Prints one JSON line per workload and variant: thread CPU µs per call, median of the trials.
// ONCE=1 runs each case once and prints its budget line instead of timing it.
//
//     node --single-threaded-gc bench/d286/variants.mjs [tree] <vm|sess|scan> [trials] [workload] [variants]
//
// tree defaults to this checkout (pass `.` or a path when giving later arguments); workload is a
// substring of a workload name; variants a comma list. bench/d286/ab.sh rotates trees and arms.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
if (['vm', 'sess', 'scan'].includes(args[0])) args.unshift(fileURLToPath(new URL('../..', import.meta.url)));
const [treeArg, arm, trialsArg = '9', wf = '', vf = ''] = args;
if (!['vm', 'sess', 'scan'].includes(arm)) throw new Error('usage: variants.mjs [tree] <vm|sess|scan> [trials] [workload] [variants]');
const root = path.resolve(treeArg), trials = Number(trialsArg), targetUs = 20000;
const load = rel => import(pathToFileURL(path.join(root, rel)).href);
const { compile } = await load('host/js/src/compile.mjs');
const { encode } = await load('host/js/src/index.mjs');
const S = await load('gen/js/snug/cbor/scan.mjs');
const V = await load('gen/js/snug/vm/api.mjs');
const { runSession } = await load('kin/scripts/vmsession-run.mjs');
const cpu = () => { const u = process.threadCpuUsage(); return u.user + u.system; };
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
let sink;
const doc = { records: Array.from({ length: 2000 }, (_, i) => ({ id: i, kind: 'note', title: 'A small benchmark document',
  meta: { owner: 'person', size: 128, active: true }, body: 'x'.repeat(35) })) };
const many = Array.from({ length: 2000 }, (_, i) => ({ h: true, f: 'short', d: i, b: 2, g: null, e: i % 10, c: 'text', a: 1 }));
const workloads = [
  ['20000 integers', Array.from({ length: 20000 }, (_, i) => i), 'r = [* uint]'],
  ['2000 maps x 8 keys', many, 'r = [* { * tstr => any }]'],
  ['map-heavy (2000 records)', doc,
    'r = { records: [* rec] }\nrec = { id: uint, kind: tstr, title: tstr, meta: { owner: tstr, size: uint, active: bool }, body: tstr }'],
  ['5000 strings', Array.from({ length: 5000 }, (_, i) => `the quick brown fox ${i} ü 水`), 'r = [* tstr]'],
];
const big = { maxEntries: 1 << 20, maxItems: 1 << 22, maxBytes: 1 << 28, top: 'any' };
const BIG = { depth: 64, inputBytes: 0x7fffffff, entries: 1 << 24, items: 1 << 24, budget: 0x7fffffff };
const enc = (v, o) => {
  const out = [];
  const det = x => out.push(...encode(x, big));
  const head = (maj, n) => { if (n < 24) out.push(maj << 5 | n); else if (n < 256) out.push(maj << 5 | 24, n); else out.push(maj << 5 | 25, n >> 8, n & 255); };
  const walk = x => {
    if (Array.isArray(x)) { if (o.ind) out.push(0x9f); else head(4, x.length); x.forEach(walk); if (o.ind) out.push(0xff); return; }
    if (x && typeof x === 'object' && !(x instanceof Uint8Array)) {
      let ks = Object.keys(x).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
      if (o.rev) ks = ks.reverse();
      if (o.ind) out.push(0xbf); else head(5, ks.length);
      for (const k of ks) { det(k); walk(x[k]); }
      if (o.ind) out.push(0xff);
      return;
    }
    if (o.nsh && Number.isInteger(x) && x >= 0 && x < 24) { out.push(0x18, x); return; }
    if (o.istr && typeof x === 'string' && x.length >= 2) {
      const h = Math.floor(x.length / 2);
      out.push(0x7f); det(x.slice(0, h)); det(x.slice(h)); out.push(0xff);
      return;
    }
    det(x);
  };
  walk(v);
  return Uint8Array.from(out);
};
const variants = { det: {}, rev: { rev: 1 }, ind: { ind: 1 }, nsh: { nsh: 1 }, istr: { istr: 1 }, all: { ind: 1, rev: 1, nsh: 1 } };
const LIM = Int32Array.from([1, 0, -1, -1, -1, -1, -1, -1, 0, 378]);
for (const [name, value, cddl] of workloads) {
  if (wf && !name.includes(wf)) continue;
  const C = compile(cddl, { limits: BIG }), P = C.program, B = C.pool, rule = C.rules.indexOf('r'), mc = P[16] + 5;
  for (const [vn, vo] of Object.entries(variants)) {
    if (vf && !vf.split(',').includes(vn)) continue;
    if (vo.istr && !name.includes('strings') && !name.includes('map-heavy')) continue;
    if (vo.nsh && name.includes('strings')) continue;
    const bytes = enc(value, vo);
    let s = new Int32Array(V.vmScratchWords(P, rule, mc)); V.vmScratchInit(s, mc);
    let vs = new Int32Array(512), cb = new Uint8Array(1024);
    const out = new Int32Array(8 + 2 * 257);
    const o = new Int32Array(16 + 4096), scb = new Uint8Array(Math.max(1024, 3 * bytes.length + 4096));
    const f = {
      vm: () => {
        for (;;) {
          const r = V.vmValidateV(P, B, rule, bytes, LIM, s, out, () => -2, vs, cb);
          if (r !== -5) return out[0];
          if (out[5] > vs.length) vs = new Int32Array(Math.max(out[5], 2 * vs.length));
          if (out[6] > cb.length) cb = new Uint8Array(Math.max(out[6], 2 * cb.length));
          if (out[7] > s.length) { const g = new Int32Array(out[7]); g.set(s); s = g; }
        }
      },
      scan: () => { S.scanOptions(o, 1, 0, 0x7fffffff, 64, 1 << 24, 1 << 24); S.scanProfile(o, 378); return S.scanCb(bytes, o, scb); },
      sess: () => runSession(P, B, rule, LIM, bytes, { kind: 0, w: 0, q: 0, seed: 1, k: 0 }),
    }[arm];
    const first = f();
    const verdict = typeof first === 'number' ? first : String(first?.out ?? first).split(' ')[0];
    const extra = arm === 'sess' ? { steps: first.steps, needs: first.needs, budget: String(first.out).split(' ').slice(0, 4).join(' ') } :
      arm === 'vm' ? { budget: Array.from(out.slice(0, 4)).join(' ') } : {};
    if (Number(verdict) !== 0) { console.log(JSON.stringify({ name, vn, arm, refused: verdict, first })); continue; }
    if (process.env.ONCE) { console.log(JSON.stringify({ name, vn, arm, bytes: bytes.length, ...extra })); continue; }
    for (let w = 0; w < 3; w++) sink = f();
    const t0 = cpu(); sink = f();
    const m = Math.max(1, Math.min(5000, Math.ceil(targetUs / Math.max(1, cpu() - t0))));
    const samples = [];
    for (let r = 0; r < trials; r++) { const t = cpu(); for (let i = 0; i < m; i++) sink = f(); samples.push((cpu() - t) / m); }
    console.log(JSON.stringify({ name, vn, arm, bytes: bytes.length, us: +median(samples).toFixed(1), ...extra }));
  }
}
