// P7.9 (D005 re-take) workloads, shared by the Node, browser and workerd runs.
// Every message is snug's own deterministic encoding; every schema accepts its
// message (checked by the benches). Pure JS, no Node APIs, so the browser and
// worker bundles can build the same inputs.
import { encode } from '../host/js/src/index.mjs';

// The object-storage contract (corpus/cddl-study/contracts/object-storage-v1.cddl)
// accepts a put of up to 1 MiB; a 287-byte one and a 1 MiB one.
const put = n => ({ method: 'put', args: { key: 'app/directory.json', data: new Uint8Array(n).map((_, i) => (i * 31) & 255),
  condition: { absent: true }, contentType: 'application/json' } });
function put287() { for (let n = 0; n < 287; n++) { const v = put(n); if (encode(v).length === 287) return v; } throw new Error('no 287 B put'); }

// The P1.4 shapes (bench/scan-inputs.mjs), here with structured schemas.
const ints = { v: Array.from({ length: 120_000 }, (_, i) => ((i * 2654435761) % 2_000_003) - 1_000_000) };
const docs = [];
for (let d = 0; docs.length < 9_000; d++) {
  const m = {};
  for (let k = 0; k < 12; k++) m[`k${k}${String.fromCharCode(97 + ((d + k) % 26))}`] = k % 3 === 0 ? `v${d}` : k % 3 === 1 ? d * k : { a: k, é: 'x' };
  docs.push(m);
}
const typed = { f32: new Float32Array(65_536).map((_, i) => Math.cos(i)), f64: new Float64Array(65_536).map((_, i) => Math.sin(i) * 1e3),
  i16: new Int16Array(131_072).map((_, i) => (i * 7) & 0x7fff) };
// The map-heavy 1.4 MB document of P7.8 (bench/compare/workloads.mjs), for lazy navigation.
function documentOf(target) {
  const doc = { records: Array.from({ length: 10000 }, (_, i) => ({ id: i, kind: 'note', title: 'A small benchmark document',
    meta: { owner: `person${i}`, size: 128, active: true }, body: 'x'.repeat(35) })), padding: '' };
  const L = { maxEntries: 150000, maxItems: 600000, maxBytes: 1500000 };
  doc.padding = 'x'.repeat(target - encode(doc, L).length);
  doc.padding = doc.padding.slice(encode(doc, L).length - target);
  return doc;
}

export const OBJECT_STORAGE = 'object-storage';
export const BIG = { maxBytes: 1_500_000, maxDepth: 32, maxEntries: 1 << 20, maxItems: 1 << 24 };
export const BIGL = { budget: 0x7fffffff, items: 1 << 24, entries: 1 << 24 };

export function workloads(objectStorageCddl) {
  const w = [
    { id: 'rpc287', name: 'RPC put 287 B (object-storage request)', value: put287(), cddl: objectStorageCddl, rule: 'request', opts: {} },
    { id: 'put1m', name: 'RPC put 1 MiB bstr (object-storage request)', value: put(1 << 20), cddl: objectStorageCddl, rule: 'request', opts: {} },
    { id: 'ints', name: '120,000-int array', value: ints, cddl: 'r = { v: [* int] }', rule: 'r', opts: BIG },
    { id: 'nested', name: 'nested maps (9,000 x 12 keys)', value: { docs }, cddl: 'r = { docs: [* { * tstr => tstr / int / { a: int, "é": tstr } }] }', rule: 'r', opts: BIG },
    { id: 'typed', name: '1 MiB typed arrays (f32, f64, i16)', value: typed, cddl: 'r = { f32: #6.85(bstr), f64: #6.86(bstr), i16: #6.77(bstr) }', rule: 'r', opts: BIG },
    { id: 'doc', name: 'map-heavy document 1.4 MB', value: documentOf(1_400_000), rule: 'r', opts: BIG,
      cddl: 'r = { records: [* { id: uint, kind: tstr, title: tstr, meta: { owner: tstr, size: uint, active: bool }, body: tstr }], padding: tstr }' },
  ];
  for (const x of w) x.bytes = encode(x.value, x.opts);
  return w;
}

/** Seeded single-byte mutations of a message (refusal-heavy input). */
export function mutations(bytes, count, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s; };
  const out = [];
  for (let i = 0; i < count; i++) { const m = bytes.slice(); m[rnd() % m.length] ^= 1 << (rnd() % 8); out.push(m); }
  return out;
}
