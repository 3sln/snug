// P3.6 iteration harness: live validation vs the generated scanner, and
// schema.decode vs cbor.mjs decode. CPU time, best of N rounds (the machine
// is shared). `node bench/vm-perf.mjs [--generic] [filter]`
//   --generic   force the VM's generic path (limits word 8 bit 0)
import { readFileSync } from 'node:fs';
import { encode, decode as cborDecode, BindleDecimal, NDArray } from './baseline/cbor-3sln.mjs';
import { inputs } from './scan-inputs.mjs';
import { compile } from '../host/js/src/compile.mjs';
import { Program, Schema } from '../host/js/src/schema.mjs';
import { build } from '../host/js/src/build.mjs';
import { vmScratchWords, vmScratchInit, vmValidate } from '../gen/js/snug/vm/api.mjs';
import { scan, scanOptions } from '../gen/js/snug/cbor/scan.mjs';

const GENERIC = process.argv.includes('--generic');
const filter = process.argv.slice(2).find(a => !a.startsWith('--')) ?? '';
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
export function best(fn, rounds = 7) {
  fn(); fn();
  let n = 1;
  for (;;) { const t = cpu(); for (let i = 0; i < n; i++) fn(); const d = cpu() - t; if (d >= 40 || n >= 1 << 22) break; n = d < 1 ? n * 16 : Math.max(n * 2, Math.ceil(n * 40 / d)); }
  let m = 1e99; for (let r = 0; r < rounds; r++) { const t = cpu(); for (let i = 0; i < n; i++) fn(); m = Math.min(m, (cpu() - t) / n); }
  return m;
}
const fmt = ms => ms >= 1 ? `${ms.toFixed(2)} ms` : `${(ms * 1000).toFixed(2)} µs`;
const BIGL = { budget: 0x7fffffff, items: 1 << 24, entries: 1 << 24 };
function vm(text, limits = BIGL) {
  const c = compile(text, { limits });
  const P = c.program, B = c.pool;
  const S = new Int32Array(P[40] + 16); vmScratchInit(S, P[16]);
  const out = new Int32Array(8 + 2 * 257);
  return { c, run: (rule, bytes, top = 1) => vmValidate(P, B, c.rules.indexOf(rule), bytes,
    Int32Array.of(top, 0, -1, -1, -1, -1, -1, -1, GENERIC ? 1 : 0), S, out), out };
}
const o = new Int32Array(16);
const scanT = (bytes, top = 1) => { scanOptions(o, top, 0, 0x7fffffff, 32, 1 << 24, 1 << 24); return scan(bytes, o); };

const rows = [];
function row(name, fv, fs) {
  if (filter && !name.includes(filter)) return;
  const tv = best(fv), ts = best(fs);
  rows.push([name, tv, ts]);
  console.log(`${name.padEnd(70).slice(0, 70)} vm ${fmt(tv).padStart(10)}  scan ${fmt(ts).padStart(10)}  ${(tv / ts).toFixed(2)}x`);
}

console.log(`# live validation vs scanner${GENERIC ? ' (FORCED GENERIC)' : ''}`);
const permissive = {
  'RPC put, 287 B': 'r = { * tstr => any }',
  'RPC put with 1 MiB bstr': 'r = { method: tstr, args: { key: tstr, data: bstr, * tstr => any }, * tstr => any }',
  '120,000-int array': 'r = { v: [* int] }',
  '1 MiB typed arrays': 'r = { f32: #6.85(bstr), f64: #6.86(bstr), i16: #6.77(bstr) }',
  'nested maps': 'r = { docs: [* { * tstr => any }] }',
};
for (const inp of inputs) {
  if (inp.many) continue;
  const key = Object.keys(permissive).find(k => inp.name.startsWith(k));
  const v = vm(permissive[key]);
  const code = v.run('r', inp.bytes, 0);
  if (code !== 0) console.log(`  !! ${inp.name}: code ${code}`);
  row(`${inp.name} :: ${permissive[key]}`, () => v.run('r', inp.bytes, 0), () => scanT(inp.bytes, 0));
}
// the study contracts with their valid probes
const src = n => readFileSync(new URL(`../corpus/cddl-study/contracts/${n}`, import.meta.url), 'utf8');
const jkt = 'a'.repeat(43), sid = 'b'.repeat(22);
const base = { bindle: 'signaling-message', v: 1, iss: 'https://p.example', sub: 'https://p.example/u', aud: 'https://q.example/v', sid, leg: jkt, seq: 0, iat: 1 };
const probes = [
  ['object-storage-v1.cddl', 'request', { method: 'put', args: { key: 'k', data: new Uint8Array(10), condition: { absent: true } } }],
  ['object-storage-v1.cddl', 'presign-result', { url: 'https://x.example/a', method: 'PUT', expiresAt: 1, revocation: 'live', requiredHeaders: { a: 'b' }, mode: 'proxy' }],
  ['item-classification-v1.cddl', 'classify-args', { detail: 'full', item: { kind: 'image', mediaType: 'image/png', size: 5, url: { href: 'https://x.example/i', expiresAt: 9 } }, tags: { source: 'email', context: ['a.b'] }, labels: [{ id: 'spam', description: 'Spam' }] }],
  ['event-bus-tasks.cddl', 'record', { type: 'created', data: encode({ task: 't1' }) }],
  ['preferences-v2.cddl', 'result', { fragment: 'https://f.example/x', revision: '1', values: { a: 1, b: [{ id: 'https://r.example/1', status: 'available', contracts: [] }] } }],
  ['ledger-numeric.cddl', 'entry', { amount: 2n ** 70n, price: BindleDecimal.from('9.99'), weights: new Float32Array(3), matrix: new NDArray([2, 2], new Float64Array(4)), flags: 5, series: { ts: new BigInt64Array(2), value: new Float64Array(2) } }],
  ['signaling-message-v1.cddl', 'message', { ...base, to: null, type: 'invite', body: { kind: { artefact: 'a', version: '1', digest: 'd' }, profile: 'webrtc', answer_by: 5, basis: null, context: { a: 1 }, params: {} } }],
];
for (const [file, rule, value] of probes) {
  const v = vm(src(file), {});
  const bytes = encode(value);
  const code = v.run(rule, bytes);
  if (code !== 0) console.log(`  !! ${file} ${rule}: code ${code}`);
  row(`${file} ${rule} ${bytes.length} B`, () => v.run(rule, bytes), () => scanT(bytes));
}

// codec benchmark set: schema.decode (any + a permissive schema) vs cbor.mjs decode
console.log('\n# schema.decode vs cbor.mjs decode (codec set)');
const rpc = data => ({ version: '0', resource: 'https://resource.example/r/1', contract: 'https://contracts.example/object-storage/v1', method: 'put',
  args: { key: 'app/directory.json', data }, scope: {}, epoch: null, resourceGeneration: null, connectionGeneration: null });
const many = Array.from({ length: 10000 }, (_, i) => ({ h: true, f: 'short', d: i, b: 2, g: null, e: i % 10, c: 'text', a: 1 }));
const document = { records: Array.from({ length: 10000 }, (_, i) => ({ id: i, kind: 'note', title: 'A small benchmark document', meta: { owner: 'person', size: 128, active: true }, body: 'x'.repeat(35) })), padding: '' };
const large = { maxEntries: 120000, maxItems: 500000, maxBytes: 1500000, top: 'any' };
const codec = [
  ['RPC put 287 B', rpc(new Uint8Array(160).fill(97)), { top: 'any' }, 'r = { * tstr => any }'],
  ['RPC put + 1 MiB bytes', rpc(new Uint8Array(2 ** 20).fill(97)), { top: 'any' }, 'r = { * tstr => any }'],
  ['120000 integers', Array.from({ length: 120000 }, (_, i) => i), large, 'r = [* int]'],
  ['1 MiB Float64Array', Float64Array.from({ length: 2 ** 17 }, (_, i) => i + 0.5), { top: 'any' }, 'r = #6.86(bstr)'],
  ['10000 maps x 8 short keys', many, large, 'r = [* { * tstr => any }]'],
  ['10000 maps x 8 short keys (struct)', many, large, 'r = [* { h: bool, f: tstr, d: uint, b: uint, g: null, e: uint, c: tstr, a: uint }]'],
  ['map-heavy document 1.4 MB', document, large, 'r = { records: [* { id: uint, kind: tstr, title: tstr, meta: { owner: tstr, size: uint, active: bool }, body: tstr }], padding: tstr }'],
];
for (const [name, value, opt, text] of codec) {
  if (filter && !name.includes(filter)) continue;
  const bytes = encode(value, opt);
  for (const t of ['r = any', text]) {
    const c = compile(t, { limits: BIGL });
    const sc = new Schema(new Program(c.program, c.pool));
    const dopt = { ...opt, ...(GENERIC ? { _generic: true } : {}) };
    sc.decode(bytes, 'r', dopt);
    const td = best(() => sc.decode(bytes, 'r', dopt)), tc = best(() => cborDecode(bytes, opt));
    console.log(`${(name + ' :: ' + t).padEnd(70).slice(0, 70)} decode ${fmt(td).padStart(10)}  cbor.mjs ${fmt(tc).padStart(10)}  ${(td / tc).toFixed(2)}x`);
  }
}
