// `bb nav-test`: the kin navigation primitives (snug.nav.walk) on JS and Rust.
//
//   node kin/scripts/nav-test.mjs <rust nav-test binary> [random documents] [seed]
//
// 1. Trace identity: the trace of every primitive (snug.nav.trace) over every
//    accepted profile vector, every Bindle-accepted oracle value and seeded
//    random documents is identical on both hosts.
// 2. Trace truth: the trace agrees with an independent reading by the
//    trusted builder (item ends via build of the span, child counts, key
//    lookups found at the value that follows each key, absent keys absent).
// 3. Robustness: on unchecked bytes (seeded mutations, random bytes) neither
//    host panics or reads out of bounds, and both answer the same words.
// 4. Rust view: random key paths through a Rust View answer the same raw span
//    as the JS view.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { navTrace } from '../../gen/js/snug/nav/trace.mjs';
import { encode } from '../../host/js/src/encode.mjs';
import { scan } from '../../host/js/src/scan.mjs';
import { build } from '../../host/js/src/build.mjs';
import { view } from '../../host/js/src/view.mjs';
import { createRandom, randomMap, randomValue, mutate } from '../../host/js/test/corpus.mjs';

const [bin, nDocs = '600', seedArg = '1'] = process.argv.slice(2);
const N = Number(nDocs), SEED = Number(seedArg);
const hex = b => Buffer.from(b).toString('hex');
const unhex = h => new Uint8Array(Buffer.from(h, 'hex'));
let failed = false;
const ok = (good, msg) => { console.log(`  ${good ? 'ok  ' : 'FAIL'} ${msg}`); if (!good) failed = true; };

function jsTrace(b) {
  const o = new Int32Array(8), d = new Int32Array(b.length + 1), w = new Int32Array(64 + 16 * b.length);
  const n = navTrace(b, o, d, w);
  return [n, ...w.subarray(0, Math.max(n, 0))].join(' ');
}
function rust(lines) {
  const r = spawnSync(bin, { input: lines.join('\n') + '\n', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('nav-test binary failed: ' + r.stderr);
  return r.stdout.toString().trimEnd().split('\n');
}
const accepts = (b, top = 'any') => { try { scan(b, { top }); return true; } catch { return false; } };

// ---------------------------------------------------------------- documents
const docs = [];
const profile = JSON.parse(readFileSync(new URL('../../corpus/cbor-vectors/cbor-profile.json', import.meta.url)));
for (const v of profile.accept) docs.push(unhex(v.hex));
const oracle = JSON.parse(readFileSync(new URL('../../corpus/cbor-vectors/cbor-cborg-oracle.json', import.meta.url)));
for (const c of oracle.cases) if (c.accept) { const b = unhex(c.hex); if (accepts(b)) docs.push(b); }
const r = createRandom(SEED);
for (let i = 0; i < N; i++) docs.push(encode(i % 2 ? randomMap(r, { maxDepth: 6 }) : randomValue(r, { maxDepth: 6 }), { top: 'any' }));
// a few wide maps, so directories and binary search see depth
for (let i = 0; i < 20; i++) { const m = Object.create(null); for (let j = 0, n = 10 + r.int(400); j < n; j++) m['k' + r.int(1e5)] = r.int(9); docs.push(encode(m)); }
const checked = docs.filter(b => accepts(b));

// ---------------------------------------------------------------- 1. identity
const js = checked.map(jsTrace);
const rs = rust(checked.map(b => 'T ' + hex(b)));
let same = 0;
for (let i = 0; i < checked.length; i++) if (rs[i] === 't ' + js[i]) same++; else if (same + 5 > i) console.log(`    differs: ${hex(checked[i]).slice(0, 80)}\n      js ${js[i].slice(0, 120)}\n      rs ${rs[i].slice(0, 120)}`);
ok(same === checked.length, `${same}/${checked.length} traces identical across hosts (checked documents)`);

// ---------------------------------------------------------------- 2. truth
// Re-read the trace with an independent structural reader (the builder and the
// encoder): ends, child counts, key lookups.
function endBy(b, p) {
  // a structural end by brute force: the shortest prefix from p that scans as one item
  for (let e = p + 1; e <= b.length; e++) if (accepts(b.subarray(p, e))) return e;
  return -1;
}
let truthful = 0, truthDocs = 0;
for (let i = 0; i < checked.length && truthDocs < 250; i++) {
  const b = checked[i];
  if (b.length > 600) continue;
  truthDocs++;
  const w = js[i].split(' ').map(Number), n = w[0];
  let k = 1, good = n > 0;
  while (good && k < n) {
    const p = w[k], e = w[k + 1], len = w[k + 2];
    k += 3;
    if (endBy(b, p) !== e) { good = false; break; }
    const major = b[p] >> 5;
    if (len >= 0) {
      const children = [];
      for (let c = 0; c < len; c++) children.push(w[k++]);
      if (major !== 6) {
        const dn = w[k++];
        if (dn !== len) { good = false; break; }
        if (major === 5) for (let j = 0; j < dn; j++) {
          const f1 = w[k++], f2 = w[k++], g1 = w[k++], g2 = w[k++], g3 = w[k++], g4 = w[k++];
          const keyEnd = endBy(b, children[j]);
          if (f1 !== keyEnd || f2 !== keyEnd || g1 !== -3 || g2 !== -3 || g3 !== -3 || g4 !== -3) good = false;
        }
      }
      // children are consecutive items (array) or alternate key/value (map)
      let q = major === 6 ? -1 : children[0];
      for (let c = 0; c < len && major !== 6; c++) {
        if (children[c] !== q) good = false;
        q = endBy(b, q); if (major === 5) q = endBy(b, q);
      }
    }
  }
  if (good) truthful++;
}
ok(truthful === truthDocs, `${truthful}/${truthDocs} traces agree with an independent structural reading (ends, children, keys found, absent keys absent)`);

// ---------------------------------------------------------------- 3. robustness
const junk = [];
const r2 = createRandom(SEED + 1000);
for (let i = 0; i < 4000; i++) junk.push(mutate(r2, docs[r2.int(docs.length)]));
for (let i = 0; i < 1000; i++) { const b = new Uint8Array(r2.int(40)); for (let j = 0; j < b.length; j++) b[j] = r2.int(256); junk.push(b); }
const jj = junk.map(b => { try { return 't ' + jsTrace(b); } catch (e) { return 'JS THREW ' + e.message; } });
const rr = rust(junk.map(b => 'T ' + hex(b)));
let jsOk = jj.filter(s => !s.startsWith('JS THREW')).length, panics = rr.filter(s => s === 'PANIC').length, agree = 0;
for (let i = 0; i < junk.length; i++) if (jj[i] === rr[i]) agree++;
ok(jsOk === junk.length && panics === 0 && agree === junk.length, `${junk.length} unchecked inputs: JS threw ${junk.length - jsOk}, Rust panicked ${panics}, ${agree}/${junk.length} identical`);

// ---------------------------------------------------------------- 4. Rust view
const paths = [], wantRaw = [];
const r3 = createRandom(SEED + 2000);
for (const b of checked) {
  if (b[0] >> 5 !== 5) continue;
  const v = view(b, { top: 'any' });
  const path = [];
  let x = v;
  while (x && x.kind === 'map' && x.length > 0 && r3.chance(0.8)) {
    const keys = [...x.keys()].filter(k => typeof k === 'string' && !k.includes(' ') && k.length > 0);
    if (!keys.length) break;
    const k = r3.chance(0.9) ? r3.pick(keys) : 'absent-key';
    path.push(k); x = x.get(k);
  }
  paths.push('V ' + hex(b) + (path.length ? ' ' + path.join(' ') : ''));
  wantRaw.push(x ? 'v ' + hex(x.raw()) : 'v none');
}
const vr = rust(paths);
let vsame = 0;
for (let i = 0; i < paths.length; i++) if (vr[i] === wantRaw[i]) vsame++;
ok(vsame === paths.length, `${vsame}/${paths.length} Rust View key paths answer the JS view's span`);

if (failed) { console.log('  FAIL nav-test'); process.exit(1); }
console.log('  ok   nav-test');
