// P5.4 Writer benchmark (bench/WRITER.md). Run: node bench/writer-bench.mjs [trials]
//
// For each bench/codec.mjs workload: the Writer driven by typed calls that build the same document (keys supplied in
// encoded order with keysSorted, and in a shuffled order sorted at end()), encode(value) (since P5.4 the object walk
// over the Writer, = writeValue), the Phase 2 encoder (frozen, bench/baseline/encode-p2.mjs: the §16.5 baseline) and
// cbor.mjs's encode. Values are given with keys in encoded order and shuffled (every map's keys reversed). Every
// answer is checked equal to the Phase 2 encoder's outside the timed region.
import assert from 'node:assert/strict';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { encode } from '../host/js/src/encode.mjs';
import { encode as encodeP2 } from './baseline/encode-p2.mjs';
import { Writer, writeValue } from '../host/js/src/writer.mjs';
import { baseline, translate, profile, oracle, fromHex } from '../host/js/test/values.mjs';
import { build } from '../host/js/src/build.mjs';
import { typedInfo, Decimal, NDArray } from '../host/js/src/values.mjs';

const trials = Number(process.argv[2] ?? 9), targetMs = 15;
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const system = (command, args) => { try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return 'unavailable'; } };
console.log(JSON.stringify({ cpu: system('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']), arch: os.arch(), macOS: system('/usr/bin/sw_vers', ['-productVersion']),
  node: process.version, v8: process.versions.v8, trials, targetMs, load: os.loadavg().map(x => x.toFixed(2)) }));
let sink;

// ------------------------------------------------------------------ workloads (bench/codec.mjs)
const rpc = data => ({ version: '0', resource: 'https://resource.example/r/1', contract: 'https://contracts.example/object-storage/v1', method: 'put',
  args: { key: 'app/directory.json', data }, scope: {}, epoch: null, resourceGeneration: null, connectionGeneration: null });
let small;
for (let n = 0; n < 287; n++) { const v = rpc(new Uint8Array(n).fill(97)); if (encode(v).length === 287) { small = v; break; } }
const big = rpc(new Uint8Array(2 ** 20).fill(97));
const ints = Array.from({ length: 120000 }, (_, i) => i);
const f64 = Float64Array.from({ length: 2 ** 17 }, (_, i) => i + 0.5);
const i64 = BigInt64Array.from({ length: 2 ** 17 }, (_, i) => BigInt(i) - 65536n);
const many = Array.from({ length: 10000 }, (_, i) => ({ h: true, f: 'short', d: i, b: 2, g: null, e: i % 10, c: 'text', a: 1 }));
const document = { records: Array.from({ length: 10000 }, (_, i) => ({ id: i, kind: 'note', title: 'A small benchmark document',
  meta: { owner: 'person', size: 128, active: true }, body: 'x'.repeat(35) })), padding: '' };
const large = { maxEntries: 120000, maxItems: 500000, maxBytes: 1500000 };
const size0 = encode(document, large).length;
document.padding = 'x'.repeat(1400000 - size0);
document.padding = document.padding.slice(encode(document, large).length - 1400000);
assert.equal(encode(document, large).length, 1400000);

// A value with keys in encoded order, or in reverse encoded order (every map shuffled the same way).
const keyCmp = (a, b) => Buffer.compare(Buffer.from(encode(a, { top: 'any' })), Buffer.from(encode(b, { top: 'any' })));
function reorder(v, how) {
  if (Array.isArray(v)) return v.map(x => reorder(x, how));
  if (!v || typeof v !== 'object' || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)) return v;
  const keys = Object.keys(v).sort(keyCmp); if (how === 'shuffled') keys.reverse();
  const o = Object.create(null); for (const k of keys) o[k] = reorder(v[k], how); return o;
}

// ------------------------------------------------------------------ typed-call builders (sorted: encoded order + keysSorted)
const put = (w, data, sorted) => {
  w.beginMap(9);
  if (sorted) {
    w.key('args').beginMap(2).key('key').text('app/directory.json').key('data').bytes(data).end();
    w.key('epoch').null().key('scope').beginMap(0).end().key('method').text('put').key('version').text('0')
      .key('contract').text('https://contracts.example/object-storage/v1').key('resource').text('https://resource.example/r/1')
      .key('resourceGeneration').null().key('connectionGeneration').null();
  } else {
    w.key('connectionGeneration').null().key('resourceGeneration').null().key('resource').text('https://resource.example/r/1')
      .key('contract').text('https://contracts.example/object-storage/v1').key('version').text('0').key('method').text('put')
      .key('scope').beginMap(0).end().key('epoch').null();
    w.key('args').beginMap(2).key('data').bytes(data).key('key').text('app/directory.json').end();
  }
  return w.end();
};
const builders = {
  small: (w, s) => put(w, small.args.data, s),
  big: (w, s) => put(w, big.args.data, s),
  ints: w => { w.beginArray(ints.length); for (let i = 0; i < ints.length; i++) w.uint(i); return w.end(); },
  f64: w => w.typed(f64),
  i64: w => w.typed(i64),
  many: (w, s) => {
    w.beginArray(10000);
    if (s) for (let i = 0; i < 10000; i++) w.beginMap(8).key('a').uint(1).key('b').uint(2).key('c').text('text').key('d').uint(i).key('e').uint(i % 10).key('f').text('short').key('g').null().key('h').bool(true).end();
    else for (let i = 0; i < 10000; i++) w.beginMap(8).key('h').bool(true).key('f').text('short').key('d').uint(i).key('b').uint(2).key('g').null().key('e').uint(i % 10).key('c').text('text').key('a').uint(1).end();
    return w.end();
  },
  document: (w, s) => {
    w.beginMap(2);
    if (!s) w.key('records');
    else w.key('padding').text(document.padding).key('records');
    w.beginArray(10000);
    for (let i = 0; i < 10000; i++) {
      if (s) w.beginMap(5).key('id').uint(i).key('body').text('x'.repeat(35)).key('kind').text('note').key('meta').beginMap(3).key('size').uint(128).key('owner').text('person').key('active').bool(true).end().key('title').text('A small benchmark document').end();
      else w.beginMap(5).key('title').text('A small benchmark document').key('meta').beginMap(3).key('active').bool(true).key('owner').text('person').key('size').uint(128).end().key('kind').text('note').key('body').text('x'.repeat(35)).key('id').uint(i).end();
    }
    w.end();
    if (!s) w.key('padding').text(document.padding);
    return w.end();
  },
};
// The vectors (74 profile + 315 oracle accepts) as values; typed calls through a generic driver.
const vectorValues = [];
for (const v of profile.accept) vectorValues.push(build(fromHex(v.hex), { top: 'any' }));
for (const c of oracle.cases) if (c.accept) { const b = fromHex(c.hex); try { baseline.decode(b, { top: 'any' }); vectorValues.push(build(b, { top: 'any' })); } catch { /* Bindle refusal */ } }
function drive(w, v, sorted) {
  switch (typeof v) {
    case 'number': return Number.isSafeInteger(v) && !Object.is(v, -0) ? w.int(v) : w.float(v);
    case 'bigint': return w.int(v); case 'string': return w.text(v); case 'boolean': return w.bool(v);
  }
  if (v === null) return w.null();
  if (v instanceof Uint8Array) return w.bytes(v);
  if (typedInfo(v)) return w.typed(v);
  if (v instanceof Decimal) return w.decimal(v);
  if (v instanceof NDArray) return w.ndarray(v);
  if (Array.isArray(v)) { w.beginArray(v.length); for (const x of v) drive(w, x, sorted); return w.end(); }
  const keys = Object.keys(v); if (sorted) keys.sort(keyCmp); else keys.reverse();
  w.beginMap(keys.length); for (const k of keys) { w.key(k); drive(w, v[k], sorted); } return w.end();
}
const cases = [
  ['vectors (74 profile + 315 oracle)', vectorValues, 'vectors', {}],
  ['RPC put 287 B', small, 'small', {}], ['RPC put + 1 MiB bytes', big, 'big', {}], ['120000 integers', ints, 'ints', large],
  ['1 MiB Float64Array', f64, 'f64', {}], ['1 MiB BigInt64Array', i64, 'i64', {}], ['10000 maps x 8 short keys', many, 'many', large],
  ['map-heavy document 1.4 MB', document, 'document', large],
];

console.log('| Workload | Bytes | Writer typed, keys in order (keysSorted) ms | Writer typed, keys shuffled ms | encode = walk over Writer, keys in order ms | encode = walk over Writer, keys shuffled ms | P2 encoder, keys in order ms | P2 encoder, keys shuffled ms | cbor.mjs encode, keys shuffled ms |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const [name, value, b, options] of cases) {
  const list = b === 'vectors';
  const sortedV = reorder(value, 'sorted'), shuffledV = reorder(value, 'shuffled'), base = translate(shuffledV, baseline);
  const want = list ? value.map(v => encodeP2(v, options)) : encodeP2(value, options);
  const typed = list
    ? s => value.map(v => { const w = new Writer({ ...options, keysSorted: s }); drive(w, v, s); return w.finish(); })
    : s => { const w = new Writer({ ...options, keysSorted: s }); builders[b](w, s); return w.finish(); };
  const each = list ? f => x => x.map(v => f(v, options)) : f => x => f(x, options);
  const [wv, en, be] = [each(encode), each(encodeP2), each(baseline.encode)];
  const ops = [() => typed(true), () => typed(false), () => wv(sortedV), () => wv(shuffledV), () => en(sortedV), () => en(shuffledV), () => be(base)];
  const check = out => assert.deepStrictEqual(out, want);
  for (const op of ops) check(op());
  for (let warm = 0; warm < 3; warm++) for (const op of ops) sink = op();
  const iterations = ops.map(op => { const t = performance.now(); sink = op(); return Math.max(1, Math.min(2000, Math.ceil(targetMs / Math.max(0.01, performance.now() - t)))); });
  const samples = ops.map(() => []);
  for (let round = 0; round < trials; round++) {
    for (let off = 0; off < ops.length; off++) {
      const k = (round + off) % ops.length, n = iterations[k], t = performance.now();
      for (let i = 0; i < n; i++) sink = ops[k]();
      samples[k].push((performance.now() - t) / n);
      check(sink);
    }
  }
  console.log(`| ${name} | ${list ? want.reduce((n, x) => n + x.length, 0) : want.length} | ${samples.map(s => median(s).toFixed(4)).join(' | ')} |`);
}
console.log('Answers checked equal to the Phase 2 encoder\'s outside the timed region.');

// ------------------------------------------------------------------ sizes (esbuild --bundle --minify, gzip -9)
{
  const { existsSync } = await import('node:fs');
  const { gzipSync } = await import('node:zlib');
  const esbuild = process.env.SNUG_ESBUILD ?? new URL('compare/node_modules/.bin/esbuild', import.meta.url).pathname;
  if (!existsSync(esbuild)) console.log(`(no esbuild at ${esbuild}: sizes skipped)`);
  else {
    const size = entry => { const b = execFileSync(esbuild, [entry, '--bundle', '--format=esm', '--minify', '--log-level=error']); return [b.length, gzipSync(b, { level: 9 }).length]; };
    console.log('\n| Bundle (with its imports: values, limits, fault, gen/js/snug/write) | min B | min+gzip B |');
    console.log('| --- | ---: | ---: |');
    for (const [name, entry] of [['host/js/src/writer.mjs (Writer + walk; encode.mjs adds 3 lines)', 'host/js/src/writer.mjs'],
      ['host/js/src/encode.mjs (= the walk over the Writer)', 'host/js/src/encode.mjs'],
      ['bench/baseline/encode-p2.mjs (the Phase 2 encoder it replaced)', 'bench/baseline/encode-p2.mjs'],
      ['host/js/src/values.mjs alone (shared by both)', 'host/js/src/values.mjs']]) {
      const [min, gz] = size(entry); console.log(`| ${name} | ${min} | ${gz} |`);
    }
  }
}
