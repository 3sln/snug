// P7.8 workloads. Every workload is a value plus snug's deterministic encoding of it; the decode benchmarks feed
// these exact bytes to every library (bytes every library under test accepts, checked in js-codec.mjs).
import { encode } from '../../host/js/src/index.mjs';

export const LARGE = { maxEntries: 150000, maxItems: 600000, maxBytes: 1500000 };

const rpc = data => ({ version: '0', resource: 'https://resource.example/r/1',
  contract: 'https://contracts.example/object-storage/v1', method: 'put',
  args: { key: 'app/directory.json', data }, scope: {}, epoch: null,
  resourceGeneration: null, connectionGeneration: null });

function rpcSmall() {
  for (let n = 0; n < 287; n++) { const v = rpc(new Uint8Array(n).fill(97)); if (encode(v).length === 287) return v; }
  throw new Error('no 287-byte request');
}

function documentOf(target, recordOf, count) {
  const doc = { records: Array.from({ length: count }, (_, i) => recordOf(i)), padding: '' };
  const size0 = encode(doc, { ...LARGE, top: 'any' }).length;
  if (size0 >= target) throw new Error(`document already ${size0} B`);
  doc.padding = 'x'.repeat(target - size0);
  doc.padding = doc.padding.slice(encode(doc, LARGE).length - target);
  if (encode(doc, LARGE).length !== target) throw new Error('padding');
  return doc;
}

// Text-heavy: prose bodies with ~10% non-ASCII (2-, 3- and 4-byte UTF-8) so UTF-8 validation is exercised.
const WORDS = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'café', 'naïve', 'résumé', 'Straße',
  '日本語', '東京', 'данные', 'λόγος', 'emoji😀', 'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur'];
const prose = (seed, words) => { let s = '', x = seed * 2654435761 >>> 0; for (let i = 0; i < words; i++) { x = (x * 1103515245 + 12345) >>> 0; s += (i ? ' ' : '') + WORDS[x % WORDS.length]; } return s; };

// CWT-like claims set (RFC 8392 integer labels; COSE-style negative private labels). snug's current profile allows
// integer keys only in the TOP-LEVEL map with `cose: true` (SPEC §3; D081's general profile is P7.1, not yet built),
// so the claims are flat: no nested `cnf` COSE_Key (that variant is in probe.mjs's refusal list).
const cwt = new Map([[1, 'https://issuer.example'], [2, 'subject-0123456789'], [3, 'https://audience.example'],
  [4, 1767225600], [5, 1767222000], [6, 1767222000], [7, new Uint8Array(16).fill(7)],
  [-65537, 'private-claim'], [-65538, 42], [-1, new Uint8Array(32).fill(1)], [-2, new Uint8Array(32).fill(2)]]);

// 10k small messages, each its own buffer (per-call overhead dominates).
const message = i => ({ id: i, op: i % 3 ? 'set' : 'del', key: `user/${i % 977}/profile`, value: i * 7, ok: i % 2 === 0, ts: 1767222000 + i });

export function workloads() {
  return [
    { id: 'rpc287', name: 'RPC put 287 B', value: rpcSmall() },
    { id: 'rpc1m', name: 'RPC put + 1 MiB bstr', value: rpc(new Uint8Array(2 ** 20).fill(97)) },
    { id: 'ints', name: '120k integers', value: Array.from({ length: 120000 }, (_, i) => i), opts: LARGE },
    { id: 'typed', name: '1 MiB typed arrays (f32,f64,i16)', typed: true, value: {
      f32: Float32Array.from({ length: 2 ** 16 }, (_, i) => i + 0.5),
      f64: Float64Array.from({ length: 2 ** 16 }, (_, i) => i * 0.25 + 0.125),
      i16: Int16Array.from({ length: 2 ** 17 }, (_, i) => (i % 65536) - 32768) } },
    { id: 'maps', name: '10k maps x 8 short keys', opts: LARGE, value: Array.from({ length: 10000 }, (_, i) =>
      ({ h: true, f: 'short', d: i, b: 2, g: null, e: i % 10, c: 'text', a: 1 })) },
    { id: 'doc', name: 'map-heavy document 1.4 MB', opts: LARGE, value: documentOf(1400000, i => ({ id: i, kind: 'note',
      title: 'A small benchmark document', meta: { owner: 'person', size: 128, active: true }, body: 'x'.repeat(35) }), 10000) },
    { id: 'text', name: 'text-heavy document 1.2 MB', opts: LARGE, value: documentOf(1200000, i => ({ id: i,
      title: prose(i, 6), body: prose(i + 7, 70), tags: [prose(i + 1, 1), prose(i + 2, 1)] }), 2000) },
    { id: 'cwt', name: 'CWT-like integer-key map', cose: true, value: cwt, opts: { cose: true } },
    { id: 'seq', name: '10k small messages (separate buffers)', seq: true, value: Array.from({ length: 10000 }, (_, i) => message(i)) },
  ].map(w => {
    const opts = { top: 'any', ...(w.opts ?? {}) };
    const bytes = w.seq ? w.value.map(v => encode(v, opts)) : encode(w.value, opts);
    return { ...w, opts, bytes, size: w.seq ? bytes.reduce((n, b) => n + b.length, 0) : bytes.length };
  });
}
