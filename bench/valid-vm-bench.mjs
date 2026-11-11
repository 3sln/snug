// P8.4 (D269): the deterministic-only fast paths, measured at the kin level. One tree and one ARM per process
// (bench/README.md#profile-options-p71: V8 inlines differently when a process runs two trees' or two arms' paths),
// THREAD CPU time (process.threadCpuUsage), µs per call, median of trials; one JSON line per workload.
//
//     node --single-threaded-gc bench/valid-vm-bench.mjs <tree> <arm> [trials]
//
// arms (deterministic input unless named nondet; profile flags 122 = deterministic, 378 = valid):
//   scan-det, scan-valid        the scanner (scanCb) over the input
//   vm-det, vm-valid            the buffer driver against a live schema (vmValidateV; vmValidateX on a tree before P8.4)
//   vm-canon                    the canonical path forced for every input (vmCanon): the cost without the attempt
//   sess-det, sess-valid        the session (whole windows, bench driver kin/scripts/vmsession-run.mjs runSession)
//   scan-nondet, vm-nondet, sess-nondet   valid flags over the non-deterministic re-encoding
//   vm-rev, sess-rev            valid flags over the deterministic encoding with every map's keys reversed
//                               (only the order is non-deterministic: the canonical path, the map streak over it, D325)
// A tree before P8.4 has the *-det arms only. vm arms also report the units used.
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [treeArg, arm, trialsArg = '15'] = process.argv.slice(2);
const root = path.resolve(treeArg ?? ''), trials = Number(trialsArg), targetUs = 20000;
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
  ['RPC put (small)', { version: '0', method: 'put', args: { key: 'app/directory.json', data: new Uint8Array(100).fill(97) }, scope: {}, epoch: null },
    'r = { * tstr => any }'],
  ['20000 integers', Array.from({ length: 20000 }, (_, i) => i), 'r = [* uint]'],
  ['2000 maps x 8 short keys', many, 'r = [* { * tstr => any }]'],
  ['map-heavy document (2000 records)', doc,
    'r = { records: [* rec] }\nrec = { id: uint, kind: tstr, title: tstr, meta: { owner: tstr, size: uint, active: bool }, body: tstr }'],
  ['5000 floats (scalar)', Array.from({ length: 5000 }, (_, i) => i + 0.25), 'r = [* float]'],
  ['text-heavy (5000 strings)', Array.from({ length: 5000 }, (_, i) => `the quick brown fox ${i} ü 水`), 'r = [* tstr]'],
];
const BIG = { depth: 64, inputBytes: 0x7fffffff, entries: 1 << 24, items: 1 << 24, budget: 0x7fffffff };
const big = { maxEntries: 1 << 20, maxItems: 1 << 22, maxBytes: 1 << 28, top: 'any' };

// valid, not deterministic: indefinite containers, keys reversed, small integers with a one-byte argument
const nondet = v => {
  const out = [];
  const det = x => out.push(...encode(x, big));
  const walk = x => {
    if (Array.isArray(x)) { out.push(0x9f); x.forEach(walk); out.push(0xff); return; }
    if (x && typeof x === 'object' && !(x instanceof Uint8Array)) { out.push(0xbf); for (const k of Object.keys(x).reverse()) { det(k); walk(x[k]); } out.push(0xff); return; }
    if (Number.isInteger(x) && x >= 0 && x < 24) { out.push(0x18, x); return; }
    det(x);
  };
  walk(v);
  return Uint8Array.from(out);
};
// keys reversed, everything else deterministic (definite lengths, shortest heads)
const rev = v => {
  const out = [];
  const det = x => out.push(...encode(x, big));
  const head = (maj, n) => { if (n < 24) out.push(maj << 5 | n); else if (n < 256) out.push(maj << 5 | 24, n); else out.push(maj << 5 | 25, n >> 8, n & 255); };
  const walk = x => {
    if (Array.isArray(x)) { head(4, x.length); x.forEach(walk); return; }
    if (x && typeof x === 'object' && !(x instanceof Uint8Array)) {
      const ks = Object.keys(x).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).reverse();
      head(5, ks.length); for (const k of ks) { det(k); walk(x[k]); } return; }
    det(x);
  };
  walk(v);
  return Uint8Array.from(out);
};

const valid = arm.endsWith('valid') || arm.endsWith('nondet') || arm.endsWith('rev') || arm === 'vm-canon', flags = valid ? 378 : 122;
const LIM = Int32Array.from([1, 0, -1, -1, -1, -1, -1, -1, 0, flags]);
console.log(JSON.stringify({ tree: root, arm, trials, cpu: os.cpus()[0]?.model, node: process.version, v8: process.versions.v8,
  loadavg: os.loadavg().map(x => x.toFixed(1)) }));
for (const [name, value, cddl] of workloads) {
  const bytes = arm.endsWith('nondet') ? nondet(value) : arm.endsWith('rev') ? rev(value) : encode(value, big);
  const C = compile(cddl, { limits: BIG }), P = C.program, B = C.pool, rule = C.rules.indexOf('r'), mc = P[16] + 5;
  let s = new Int32Array(V.vmScratchWords(P, rule, mc)); V.vmScratchInit(s, mc);
  let vs = new Int32Array(512), cb = new Uint8Array(1024);
  const out = new Int32Array(8 + 2 * 257);
  const o = new Int32Array(16 + 4096); let scb = new Uint8Array(Math.max(1024, 3 * bytes.length + 4096));
  const vmV = canon => {
    for (;;) {
      const r = canon ? V.vmCanon(P, B, rule, bytes, 0, bytes.length, 0, 0, LIM, s, out, () => -2, vs, cb)
        : V.vmValidateV(P, B, rule, bytes, LIM, s, out, () => -2, vs, cb);
      if (r !== -5) return out[0];
      if (out[5] > vs.length) vs = new Int32Array(Math.max(out[5], 2 * vs.length));
      if (out[6] > cb.length) cb = new Uint8Array(Math.max(out[6], 2 * cb.length));
      if (out[7] > s.length) { const g = new Int32Array(out[7]); g.set(s); s = g; }
    }
  };
  const f = {
    scan: () => { S.scanOptions(o, 1, 0, 0x7fffffff, 64, 1 << 24, 1 << 24); S.scanProfile(o, flags);
      return S.scanCb ? S.scanCb(bytes, o, scb) : S.scan(bytes, o); },
    vm: () => (V.vmValidateV ? vmV(false) : V.vmValidateX(P, B, rule, bytes, LIM, s, out, () => -2)),
    canon: () => vmV(true),
    sess: () => runSession(P, B, rule, LIM, bytes, { kind: 0, w: 0, q: 0, seed: 1, k: 0 }),
  }[arm === 'vm-canon' ? 'canon' : arm.split('-')[0]];
  const first = f();
  const verdict = typeof first === 'number' ? first : String(first?.out ?? first).split(' ')[0];
  if (Number(verdict) !== 0) throw new Error(`${name} ${arm}: refused (${verdict})`);
  for (let w = 0; w < 3; w++) sink = f();
  const t0 = cpu(); sink = f();
  const m = Math.max(1, Math.min(5000, Math.ceil(targetUs / Math.max(1, cpu() - t0))));
  const samples = [];
  for (let r = 0; r < trials; r++) { const t = cpu(); for (let i = 0; i < m; i++) sink = f(); samples.push((cpu() - t) / m); }
  console.log(JSON.stringify({ name, bytes: bytes.length, arm, us: +median(samples).toFixed(2), ...(arm.startsWith('vm') ? { units: out[3] } : {}) }));
}
