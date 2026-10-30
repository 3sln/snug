// P5 views and cursor (architecture §16.7): node --expose-gc bench/view-bench.mjs [samples]
//
// Per input (the P1.4 inputs of bench/scan-inputs.mjs plus a text-heavy body):
//   open+1   open a checked view (owned copy | borrowed) and read one field,
//            vs snug decode() + the field, vs cbor.mjs decode() + the field, and,
//            for the map inputs, view with a schema vs schema.decode() (rule
//            `r = { * tstr => any }`)
//   field    reading that field again on an already open view
//   walk     a Cursor over every item, reading every scalar (allocation-free
//            except text), vs walking the materialised value of decode()
//   random   random lookup paths (map keys / array indices, up to 3 steps) on an
//            open view, linear vs with child directories; time per path
//   value    v.value() of the root vs decode() vs cbor.mjs
//   memory   bytes retained per open view (owned vs borrowed; directories)
// Correctness is checked outside the timed loops. Medians of samples of a loop
// calibrated to ~20 ms.
import assert from 'node:assert/strict';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { inputs, BIG } from './scan-inputs.mjs';
import { decode as cborDecode, encode as cborEncode } from './baseline/cbor-3sln.mjs';
import { decode } from '../host/js/src/index.mjs';
import { view, directoryWords } from '../host/js/src/view.mjs';
import { compile } from '../host/js/src/schema.mjs';

const SAMPLES = Number(process.argv[2] ?? 15);
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const fmt = ms => ms >= 1 ? `${ms.toFixed(2)} ms` : ms >= 0.001 ? `${(ms * 1000).toFixed(1)} µs` : `${(ms * 1e6).toFixed(0)} ns`;
let sink = 0;
function time(fn) {
  for (let i = 0; i < 3; i++) fn();
  let n = 1;
  for (;;) { const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); if (performance.now() - t0 > 20 || n >= 1 << 20) break; n *= 2; }
  const per = [];
  for (let s = 0; s < SAMPLES; s++) { const t0 = performance.now(); for (let i = 0; i < n; i++) fn(); per.push((performance.now() - t0) / n); }
  return median(per);
}
const sys = (c, a) => { try { return execFileSync(c, a, { encoding: 'utf8' }).trim(); } catch { return '?'; } };
console.log(`## environment\n- ${sys('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'])} (${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GiB), macOS ${sys('/usr/bin/sw_vers', ['-productVersion'])}, node ${process.version} (V8 ${process.versions.v8}); load ${os.loadavg().map(x => x.toFixed(1)).join(' ')}; ${SAMPLES} samples`);

// ---------------------------------------------------------------- inputs and their one field
const textHeavy = (() => {
  const m = {};
  for (let i = 0; i < 4500; i++) m[`entry-${String(i).padStart(5, '0')}`] = `Lorem ipsum dolor sit amet ${i}, consectetur adipiscing elit; sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud ${i * 7}.`.repeat(1 + (i % 2));
  return cborEncode(m, { maxEntries: 1 << 20 });
})();
const cases = [];
for (const inp of inputs) if (inp.bytes) cases.push(inp);
cases.push({ name: `text-heavy map (4,500 text values), ${textHeavy.length} B`, bytes: textHeavy, opt: { ...BIG, maxItems: 131_072 } });

const FIELD = {
  'RPC put': [v => v.get('args').get('key').text(), x => x.args.key],
  '120,000': [v => v.get('v').at(60_000).number(), x => x.v[60_000]],
  '1 MiB typed': [v => v.get('f64').typedView().get(1000), x => x.f64[1000]],
  'nested maps': [v => v.get('docs').at(8_000).get('k4w').number(), x => x.docs[8_000].k4w],
  'text-heavy': [v => v.get('entry-04321').text(), x => x['entry-04321']],
};
const fieldOf = name => FIELD[Object.keys(FIELD).find(k => name.startsWith(k))];
const scalar = r => (r && typeof r === 'object' && 'kind' in r ? r.text() : r);

// compiled limits are the ceiling for per-call limits (program.md §13): raise them to the inputs' options
const schema = await compile('r = { * tstr => any }', { limits: { entries: 1 << 20, items: 1 << 24 } });

// ---------------------------------------------------------------- 1. open + one field
console.log('\n## open + one field (check included)');
console.log('| input | view, owned | view, borrowed | decode + field | cbor.mjs + field | view+schema, borrowed | schema.decode + field |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
const rows = {};
for (const c of cases) {
  const [vf, of] = fieldOf(c.name), b = c.bytes, opt = c.opt;
  const want = of(decode(b, opt));
  assert.deepStrictEqual(scalar(vf(view(b, opt))), want);
  assert.deepStrictEqual(of(cborDecode(b, opt)), want);
  const owned = time(() => { sink ^= +!!vf(view(b, opt)); });
  const borrowed = time(() => { sink ^= +!!vf(view(b, { ...opt, borrow: true })); });
  const dec = time(() => { sink ^= +!!of(decode(b, opt)); });
  const cb = time(() => { sink ^= +!!of(cborDecode(b, opt)); });
  let vs = '–', sd = '–';
  {
    const sopt = { ...opt, budget: 0x7fffffff };
    try {
      assert.deepStrictEqual(scalar(vf(view(b, { ...sopt, schema, rule: 'r', borrow: true }))), want);
      vs = fmt(time(() => { sink ^= +!!vf(view(b, { ...sopt, schema, rule: 'r', borrow: true })); }));
      sd = fmt(time(() => { sink ^= +!!of(schema.decode(b, 'r', sopt)); }));
    } catch (e) { vs = sd = `refused (${e.reason ?? e.code})`; }
  }
  rows[c.name] = { dec };
  console.log(`| ${c.name} | ${fmt(owned)} | ${fmt(borrowed)} | ${fmt(dec)} | ${fmt(cb)} | ${vs} | ${sd} |`);
}

// ---------------------------------------------------------------- 2. field on an open view
console.log('\n## the field again, on an open view (no check)');
console.log('| input | linear | with directories (warm) | property read on decode()d value |');
console.log('| --- | ---: | ---: | ---: |');
for (const c of cases) {
  const [vf, of] = fieldOf(c.name), v = view(c.bytes, { ...c.opt, borrow: true }), vd = view(c.bytes, { ...c.opt, borrow: true, directories: true });
  const x = decode(c.bytes, c.opt);
  console.log(`| ${c.name} | ${fmt(time(() => { sink ^= +!!vf(v); }))} | ${fmt(time(() => { sink ^= +!!vf(vd); }))} | ${fmt(time(() => { sink ^= +!!of(x); }))} |`);
}

// ---------------------------------------------------------------- 3. sequential walk
function cursorSum(v) {
  const c = v.cursor();
  let s = 0;
  const rec = () => {
    const k = c.kind;
    if (k === 'array' || k === 'map') { if (c.enter()) { do rec(); while (c.next()); c.up(); } }
    else if (k === 'int') s += Number(c.int()) & 1;
    else if (k === 'text') s += c.length;
    else if (k === 'float') s += c.number() > 0 ? 1 : 0;
    else s += 1;
  };
  rec();
  return s;
}
function valueSum(x) {
  if (Array.isArray(x)) { let s = 0; for (const e of x) s += valueSum(e); return s; }
  if (typeof x === 'number') return Number.isInteger(x) ? x & 1 : x > 0 ? 1 : 0;
  if (typeof x === 'bigint') return Number(x & 1n);
  if (typeof x === 'string') return new TextEncoder().encode(x).length;
  if (x && typeof x === 'object' && !ArrayBuffer.isView(x) && Object.getPrototypeOf(x) === null) { let s = 0; for (const k in x) s += valueSum(x[k]); return s; }
  return 1;
}
console.log('\n## sequential walk of every item (open view; decode includes its own check + build)');
console.log('| input | Cursor walk | decode() + walk of the value | walk of an already decoded value |');
console.log('| --- | ---: | ---: | ---: |');
for (const c of cases) {
  const v = view(c.bytes, { ...c.opt, borrow: true }), x = decode(c.bytes, c.opt);
  const a = cursorSum(v), bsum = valueSum(x);
  console.log(`| ${c.name} | ${fmt(time(() => { sink ^= cursorSum(v); }))} | ${fmt(time(() => { sink ^= valueSum(decode(c.bytes, c.opt)); }))} | ${fmt(time(() => { sink ^= valueSum(x); }))} |${a === bsum ? '' : ` (sums ${a} vs ${bsum})`}`);
}

// ---------------------------------------------------------------- 4. repeated random access
console.log('\n## repeated random access: time per lookup path (up to 3 get/at steps), on an open view');
console.log('| input | linear | with directories | directory words | on the decoded value |');
console.log('| --- | ---: | ---: | ---: | ---: |');
function plan(v, n, seed) {
  // random root-to-leaf key/index paths, at most 3 steps, fixed in advance
  let s = seed >>> 0; const rnd = k => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % k; };
  const paths = [];
  for (let i = 0; i < n; i++) {
    const p = []; let x = v;
    for (let d = 0; d < 3 && x && (x.kind === 'map' || x.kind === 'array') && x.length > 0; d++) {
      if (x.kind === 'array') { const j = rnd(x.length); p.push(j); x = x.at(j); }
      else { const ks = [...x.keys()]; const k = ks[rnd(ks.length)]; p.push(k); x = x.get(k); }
    }
    paths.push(p);
  }
  return paths;
}
for (const c of cases) {
  const v = view(c.bytes, { ...c.opt, borrow: true }), vd = view(c.bytes, { ...c.opt, borrow: true, directories: true }), x = decode(c.bytes, c.opt);
  const paths = plan(v, 10_000, 42), few = paths.slice(0, 100);
  const go = (w, ps) => { let s = 0; for (const p of ps) { let y = w; for (const k of p) y = typeof k === 'number' ? y.at(k) : y.get(k); s += y.offset & 1; } return s; };
  const goVal = () => { let s = 0; for (const p of paths) { let y = x; for (const k of p) y = y[k]; s += y === undefined ? 0 : 1; } return s; };
  assert.equal(go(v, few), go(vd, few));
  // linear lookups in a large container are O(n): timed over the first 100 paths only
  console.log(`| ${c.name} | ${fmt(time(() => { sink ^= go(v, few); }) / few.length)} | ${fmt(time(() => { sink ^= go(vd, paths); }) / paths.length)} | ${directoryWords(vd)} | ${fmt(time(() => { sink ^= goVal(); }) / paths.length)} |`);
}

// ---------------------------------------------------------------- 5. full materialise
console.log('\n## full materialise');
console.log('| input | view open (borrowed) + value() | value() on an open view | decode() | cbor.mjs decode() |');
console.log('| --- | ---: | ---: | ---: | ---: |');
for (const c of cases) {
  const v = view(c.bytes, { ...c.opt, borrow: true });
  assert.deepStrictEqual(v.value(), decode(c.bytes, c.opt));
  console.log(`| ${c.name} | ${fmt(time(() => { sink ^= +!!view(c.bytes, { ...c.opt, borrow: true }).value(); }))} | ${fmt(time(() => { sink ^= +!!v.value(); }))} | ${fmt(rows[c.name].dec ? time(() => { sink ^= +!!decode(c.bytes, c.opt); }) : 0)} | ${fmt(time(() => { sink ^= +!!cborDecode(c.bytes, c.opt); }))} |`);
}

// ---------------------------------------------------------------- 6. memory
console.log('\n## memory retained per open view');
if (typeof globalThis.gc !== 'function') console.log('(run with --expose-gc)');
else {
  const heap = () => { gc(); gc(); const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
  console.log('| input | owned | borrowed | borrowed + directories after the random lookups |');
  console.log('| --- | ---: | ---: | ---: |');
  for (const c of cases) {
    const N = c.bytes.length < 4096 ? 2000 : 8;
    const measure = mk => { const keep = []; const h0 = heap(); for (let i = 0; i < N; i++) keep.push(mk()); const h1 = heap(); sink ^= keep.length; return (h1 - h0) / N; };
    const owned = measure(() => view(c.bytes, c.opt));
    const borrowed = measure(() => view(c.bytes, { ...c.opt, borrow: true }));
    const paths = plan(view(c.bytes, { ...c.opt, borrow: true }), 2000, 7);
    const withDirs = measure(() => { const w = view(c.bytes, { ...c.opt, borrow: true, directories: true }); for (const p of paths) { let y = w; for (const k of p) y = typeof k === 'number' ? y.at(k) : y.get(k); } return w; });
    const kb = x => x >= 10240 ? `${(x / 1024).toFixed(0)} KiB` : `${Math.round(x)} B`;
    console.log(`| ${c.name} | ${kb(owned)} | ${kb(borrowed)} | ${kb(withDirs)} |`);
  }
}
if (sink === 0.5) console.log(sink);
