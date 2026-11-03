// P7.8 library adapters, the value normaliser used to check answers, and the CPU-time harness.
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import * as cborx from 'cbor-x';
import * as cborg from 'cborg';
import * as cbor2 from 'cbor2';
import nodeCbor from 'cbor';
import * as tiny from '@levischuck/tiny-cbor';
import * as snug from '../../host/js/src/index.mjs';
import { scan as snugScan } from '../../host/js/src/scan.mjs';
import * as base from '../baseline/cbor-3sln.mjs';

// ---------------------------------------------------------------- environment
const sys = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return `unavailable (${(e.stderr || e.code || '').toString().trim()})`; } };
export function environment(extra = {}) {
  return { cpu: sys('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']), cpuModel: os.cpus()[0]?.model, cores: os.cpus().length,
    macOS: sys('/usr/bin/sw_vers', ['-productVersion']), build: sys('/usr/bin/sw_vers', ['-buildVersion']), node: process.version,
    v8: process.versions.v8, load: os.loadavg().map(x => +x.toFixed(2)), cborxNative: cborx.isNativeAccelerationEnabled, ...extra };
}

// ---------------------------------------------------------------- CPU-time harness
/** Re-run this script under `--expose-gc --single-threaded-gc` unless already so. process.cpuUsage counts every
 * thread, so with V8's parallel/concurrent GC one library's garbage is charged to whichever op runs next (measured:
 * cbor2 encode 9 s vs 0.3 s for the same 10k messages after node-cbor's encodes). Single-threaded GC plus a forced
 * collection before each sample charges GC work to the op that caused it. */
export async function ensureGcFlags() {
  if (typeof globalThis.gc === 'function') return;
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--expose-gc', '--single-threaded-gc', '--max-old-space-size=8192', ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
export const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
export const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1];
/** ops: [{name, fn, check?}]. Warm-up, calibrate each op to >= targetMs CPU, then `rounds` interleaved rounds in a
 * rotating order; returns per-op {med, min, n} in ms per call. check(result) runs outside the timed region. */
export function bench(ops, { rounds = 9, targetMs = 25, warm = 3 } = {}) {
  let sink;
  for (const op of ops) { const r = op.fn(); op.check?.(r); }
  for (let w = 0; w < warm; w++) for (const op of ops) sink = op.fn();
  const iters = ops.map(op => {
    let n = 1;
    for (;;) { const t = cpuMs(); for (let i = 0; i < n; i++) sink = op.fn(); const d = cpuMs() - t;
      if (d >= targetMs || n >= 1 << 20) return n; n = d < 1 ? n * 8 : Math.max(n + 1, Math.ceil(n * targetMs * 1.1 / d)); }
  });
  const samples = ops.map(() => []);
  for (let r = 0; r < rounds; r++) for (let o = 0; o < ops.length; o++) {
    const k = (r + o) % ops.length, op = ops[k], n = iters[k];
    globalThis.gc?.(); // start every sample from a collected heap (outside timing), so garbage is charged to its maker
    const t = cpuMs(); for (let i = 0; i < n; i++) sink = op.fn(); samples[k].push((cpuMs() - t) / n);
    op.check?.(sink);
  }
  return ops.map((op, k) => ({ name: op.name, med: median(samples[k]), min: Math.min(...samples[k]), n: iters[k] }));
}
export const fmt = ms => ms >= 100 ? `${ms.toFixed(0)} ms` : ms >= 1 ? `${ms.toFixed(2)} ms` : ms >= 0.001 ? `${(ms * 1000).toFixed(ms >= 0.01 ? 0 : 1)} µs` : `${(ms * 1e6).toFixed(0)} ns`;

// ---------------------------------------------------------------- normaliser (answers equal modulo representation)
const hex = u => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('hex');
export function norm(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'undefined': return 'undefined';
    case 'boolean': return String(v);
    case 'number': return Object.is(v, -0) ? 'n:-0' : 'n:' + v;
    case 'bigint': return 'n:' + v;
    case 'string': return JSON.stringify(v);
  }
  if (v instanceof Uint8Array && !(v instanceof Uint8ClampedArray)) return 'b:' + hex(v); // includes Buffer
  if (ArrayBuffer.isView(v)) return `t:${v.constructor.name}:${hex(v)}`;
  if (Array.isArray(v)) return '[' + v.map(norm).join(',') + ']';
  if (v instanceof Map) return '{' + [...v].map(([k, x]) => [norm(k), norm(x)]).sort((a, b) => a[0] < b[0] ? -1 : 1).map(e => e.join(':')).join(',') + '}';
  if (v instanceof cborx.Tag || v instanceof nodeCbor.Tagged || v instanceof cborg.Tagged) return `tag(${v.tag},${norm(v.value)})`;
  if (v instanceof cbor2.Tag) return `tag(${v.tag},${norm(v.contents)})`;
  if (v instanceof tiny.CBORTag) return `tag(${v.tagId},${norm(v.tagValue)})`;
  const p = Object.getPrototypeOf(v);
  if (p === Object.prototype || p === null) return '{' + Object.keys(v).map(k => [JSON.stringify(k), norm(v[k])]).sort((a, b) => a[0] < b[0] ? -1 : 1).map(e => e.join(':')).join(',') + '}';
  throw new Error(`norm: unknown ${p?.constructor?.name}`);
}
/** Plain objects -> Map (deep), for libraries whose value model is Map-only (tiny-cbor) and for integer-key maps. */
export function toMaps(v) {
  if (Array.isArray(v)) return v.map(toMaps);
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, toMaps(x)]));
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) return new Map(Object.entries(v).map(([k, x]) => [k, toMaps(x)]));
  return v;
}

// ---------------------------------------------------------------- decoders
// cborg refuses unknown tags; give it RFC 8746 little-endian typed-array decoders for the workloads' tags (copying,
// as the others do, because the payload need not be aligned).
const typedTag = C => decode => new C(decode().slice().buffer); // cborg 6: a tag decoder receives decode()
const cborgTags = []; cborgTags[77] = typedTag(Int16Array); cborgTags[85] = typedTag(Float32Array); cborgTags[86] = typedTag(Float64Array);
cborgTags[72] = typedTag(Int8Array); cborgTags[69] = typedTag(Uint16Array); cborgTags[70] = typedTag(Uint32Array);
export const CBORG_STRICT = { strict: true, rejectDuplicateMapKeys: true, allowIndefinite: false, allowUndefined: false,
  strictUtf8: true, allowNaN: false, allowInfinity: false };
const cxPlain = new cborx.Decoder({ mapsAsObjects: true, useRecords: false });
const cxMaps = new cborx.Decoder({ mapsAsObjects: false, useRecords: false });
export const CBOR2_STRICT = { ...cbor2.cdeDecodeOptions, rejectDuplicateKeys: true, rejectLongFloats: true };

/** Decoder configurations. `strict` marks each library's strictest documented decode configuration. maps: the
 * workload wants Map output (integer keys). opts: snug/cbor.mjs limit options. */
export const DECODERS = [
  { id: 'snug', group: 'snug', label: 'snug decode (scan+build)', strict: true, fn: (b, o) => snug.decode(b, o.opts) },
  { id: 'snug-scan', group: 'snug', label: 'snug scan only (validate, no values)', strict: true, validateOnly: true, fn: (b, o) => snugScan(b, o.opts) },
  { id: 'cbor.mjs', group: 'cbor.mjs', label: '3sln.me cbor.mjs (strict)', strict: true, fn: (b, o) => base.decode(b, o.opts) },
  { id: 'cbor-x', group: 'cbor-x', label: 'cbor-x', strict: false, fn: (b, o) => (o.maps ? cxMaps : cxPlain).decode(b) },
  { id: 'cbor-x-js', group: 'cbor-x-js', label: 'cbor-x, native addon disabled (as in browsers)', strict: false, fn: (b, o) => (o.maps ? cxMaps : cxPlain).decode(b) },
  { id: 'cborg', group: 'cborg', label: 'cborg (default)', strict: false, fn: (b, o) => cborg.decode(b, { tags: cborgTags, useMaps: !!o.maps }) },
  { id: 'cborg-strict', group: 'cborg', label: 'cborg strict', strict: true, fn: (b, o) => cborg.decode(b, { ...CBORG_STRICT, tags: cborgTags, useMaps: !!o.maps }) },
  { id: 'cbor2', group: 'cbor2', label: 'cbor2 (default)', strict: false, fn: (b, o) => cbor2.decode(b, { preferMap: !!o.maps }) },
  { id: 'cbor2-strict', group: 'cbor2', label: 'cbor2 CDE + rejectDuplicateKeys + rejectLongFloats', strict: true, fn: (b, o) => cbor2.decode(b, { ...CBOR2_STRICT, preferMap: !!o.maps }) },
  { id: 'node-cbor', group: 'node-cbor', label: 'cbor (node-cbor)', strict: false, fn: (b, o) => nodeCbor.decodeFirstSync(b, { preferMap: !!o.maps, preferWeb: true }) },
  { id: 'node-cbor-dup', group: 'node-cbor', label: 'cbor (node-cbor) preventDuplicateKeys', strict: true, fn: (b, o) => nodeCbor.decodeFirstSync(b, { preferMap: !!o.maps, preferWeb: true, preventDuplicateKeys: true }) },
  { id: 'tiny-cbor', group: 'tiny-cbor', label: '@levischuck/tiny-cbor', strict: false, mapsOnly: true, fn: b => tiny.decodeCBOR(b) },
];

// ---------------------------------------------------------------- encoders
// node-cbor encode()/encodeCanonical() silently truncate output at the stream highWaterMark (16 KiB default; measured
// here: 65,605 B of a 1.2 MB document); encodeOne with a large highWaterMark is its documented API for large values.
const NC_HWM = 1 << 25;
const cxEnc = new cborx.Encoder({ useRecords: false, mapsAsObjects: true });
export const ENCODERS = [
  { id: 'snug', group: 'snug', label: 'snug encode', deterministic: true, fn: (v, o) => snug.encode(v, o.opts) },
  { id: 'cbor.mjs', group: 'cbor.mjs', label: '3sln.me cbor.mjs encode', deterministic: true, fn: (v, o) => base.encode(o.baseValue ?? v, o.opts) },
  { id: 'cbor-x', group: 'cbor-x', label: 'cbor-x encode', deterministic: false, fn: v => cxEnc.encode(v) },
  { id: 'cborg', group: 'cborg', label: 'cborg encode (default, RFC 7049 length-first)', deterministic: true, fn: v => cborg.encode(v) },
  { id: 'cborg-8949', group: 'cborg', label: 'cborg encode rfc8949EncodeOptions', deterministic: true, fn: v => cborg.encode(v, cborg.rfc8949EncodeOptions) },
  { id: 'cbor2', group: 'cbor2', label: 'cbor2 encode (default)', deterministic: false, fn: v => cbor2.encode(v) },
  { id: 'cbor2-cde', group: 'cbor2', label: 'cbor2 encode cdeEncodeOptions', deterministic: true, fn: v => cbor2.encode(v, cbor2.cdeEncodeOptions) },
  { id: 'node-cbor', group: 'node-cbor', label: 'cbor (node-cbor) encode', deterministic: false, fn: v => nodeCbor.encodeOne(v, { highWaterMark: NC_HWM }) },
  { id: 'node-cbor-canon', group: 'node-cbor', label: 'cbor (node-cbor) encodeCanonical', deterministic: true, fn: v => nodeCbor.encodeOne(v, { canonical: true, highWaterMark: NC_HWM }) },
  { id: 'tiny-cbor', group: 'tiny-cbor', label: '@levischuck/tiny-cbor encode', deterministic: false, mapsOnly: true, fn: v => tiny.encodeCBOR(v) },
];

export { snug, base, cborx, cborg, cbor2, nodeCbor, tiny };
