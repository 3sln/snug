// D286 D (bench/D286-analysis.md, DEVLOG D322): a differential of the canonical copy. Random
// valid CBOR (wide heads, indefinite lengths, shuffled and duplicate map keys, tag 24) goes through
// the scanner (scanX) and canon-build of this checkout and of a reference checkout; their
// verdicts, events (including EV_UNITS) and copied bytes must be identical. Exits 1 on the first
// difference, printing the input in hex.
//
//     node bench/d286/units-diff.mjs [refTree] [count] [seed]
//
// refTree defaults to this checkout (a self-check); pass a checkout of the commit to compare
// against (e.g. `git worktree add <dir> <commit>`). Uses the generated JS under gen/js/.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = fileURLToPath(new URL('../..', import.meta.url));
const [refArg = here, countArg = '20000', seedArg = '7'] = process.argv.slice(2);
const load = async root => ({
  S: await import(pathToFileURL(path.join(root, 'gen/js/snug/cbor/scan.mjs')).href),
  C: await import(pathToFileURL(path.join(root, 'gen/js/snug/cbor/vcopy.mjs')).href),
});
const A = await load(here), R = await load(path.resolve(refArg));
let x = Number(seedArg) >>> 0 || 1;
const rnd = n => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
const head = (out, maj, v, wide) => {
  const w = wide ? rnd(4) : (v < 24 ? -1 : v < 256 ? 0 : v < 65536 ? 1 : 2);
  if (w < 0) out.push(maj << 5 | v);
  else if (w === 0 && v < 256) out.push(maj << 5 | 24, v);
  else if (w <= 1 && v < 65536) out.push(maj << 5 | 25, v >> 8, v & 255);
  else out.push(maj << 5 | 26, v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255);
};
const P = { wide: 0, ind: 0, shuf: 0, dup: 0, t24: 0 };
function gen(out, d) {
  const k = rnd(d > 3 ? 4 : 9);
  if (k === 0) { head(out, 0, rnd(3) ? rnd(30) : rnd(70000), rnd(4) < P.wide); return; }
  if (k === 1) {
    const s = 'abcdefgh'.slice(0, rnd(6));
    if (rnd(4) < P.ind && s.length > 1) {
      out.push(0x7f); head(out, 3, 1); out.push(s.charCodeAt(0)); head(out, 3, s.length - 1);
      for (const c of s.slice(1)) out.push(c.charCodeAt(0));
      out.push(0xff);
    } else { head(out, 3, s.length, rnd(4) < P.wide); for (const c of s) out.push(c.charCodeAt(0)); }
    return;
  }
  if (k === 2) { [[0xf9, 0x80, 0], [0xf9, 0, 0], [0xf9, 0x7e, 0], [0xfa, 0x7f, 0xc0, 0, 0], [0xf9, 0x3c, 0], [0xfb, 0, 0, 0, 0, 0, 0, 0, 0]][rnd(6)].forEach(b => out.push(b)); return; }
  if (k === 3) { out.push([0xf4, 0xf5, 0xf6][rnd(3)]); return; }
  if (k === 4 || k === 5) {
    const n = rnd(5), ind = rnd(4) < P.ind;
    if (ind) out.push(0x9f); else head(out, 4, n, rnd(4) < P.wide);
    for (let i = 0; i < n; i++) gen(out, d + 1);
    if (ind) out.push(0xff);
    return;
  }
  if (k === 8 && rnd(4) < P.t24) { const inner = []; gen(inner, d + 2); out.push(0xd8, 24); head(out, 2, inner.length); out.push(...inner); return; }
  // a map: keys of mixed kinds, maybe shuffled, maybe a duplicate
  const n = 1 + rnd(5), keys = [];
  for (let i = 0; i < n; i++) { const kb = []; gen(kb, d + 2); keys.push(kb); }
  if (rnd(4) < P.dup && n > 1) keys[n - 1] = keys[0].slice();
  if (!(rnd(4) < P.shuf)) keys.sort((a, b) => a.length - b.length || a.findIndex((v, j) => v !== b[j]) - 0 || 0);
  const ind = rnd(4) < P.ind;
  if (ind) out.push(0xbf); else head(out, 5, n, rnd(4) < P.wide);
  for (const kb of keys) { out.push(...kb); gen(out, d + 1); }
  if (ind) out.push(0xff);
}
function run(M, b) {
  let o = new Int32Array(512), cb = new Uint8Array(1024);
  for (let g = 0; g < 60; g++) {
    M.S.scanOptions(o, 1, 0, 0x7fffffff, 64, 1 << 20, 1 << 22); M.S.scanProfile(o, 378);
    const sc = M.S.scanX(b, o, cb, 0, b.length, 0, 0);
    if (sc === 22) { o = new Int32Array(Math.max(o[13], 2 * o.length)); cb = new Uint8Array(Math.max(o[14] | 0, cb.length)); continue; }
    if (sc === 1 || sc === 2) return { sc };
    const l = M.C.canonBuild(b, o, cb, 0, b.length, 1, sc);
    if (l < 0) { const w = o[13], nb = o[14]; o = new Int32Array(Math.max(w, 2 * o.length)); cb = new Uint8Array(Math.max(nb, 2 * cb.length)); continue; }
    const nev = o[26], ev = [];
    for (let i = 0; i < nev; i++) ev.push(Array.from(o.subarray(48 + 8 * i, 48 + 8 * i + 8)).join(','));
    return { sc, l, ev: ev.join(';'), copy: Buffer.from(cb.subarray(o[39], l)).toString('hex'), fb: (o[12] & 4096) !== 0 };
  }
  throw new Error('no fit');
}
const N = Number(countArg);
let same = 0, withUnits = 0, fallback = 0, refused = 0;
for (let i = 0; i < N; i++) {
  P.wide = rnd(3); P.ind = rnd(3); P.shuf = rnd(5); P.dup = rnd(2); P.t24 = rnd(2);
  const out = []; gen(out, 0);
  const b = Uint8Array.from(out);
  const a = run(A, b), r = run(R, b);
  if (a.fb) fallback++;
  if (a.sc) refused++;
  if (a.ev && a.ev.includes(',6,')) withUnits++;
  if (a.sc !== r.sc || a.l !== r.l || a.ev !== r.ev || a.copy !== r.copy) {
    console.log('DIFF', Buffer.from(b).toString('hex'), JSON.stringify(a), JSON.stringify(r));
    process.exit(1);
  }
  same++;
}
console.log(`ok ${same}/${N} same events and copy (${withUnits} with EV_UNITS, ${refused} refused, ${fallback} fallbacks)`);
