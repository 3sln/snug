// P7.8 CDDL validation cases, shared by js-cddl.mjs, wasm.mjs and (dumped to files) the Rust harness.
//
//     node bench/compare/cddl-cases.mjs <dir>     writes <dir>/manifest.txt, <dir>/*.cddl, <dir>/*.cbor
//
// 1. The six study contracts with the study's probe values (copied from bench/vm-bench.mjs, encoded with cbor.mjs as
//    there). 2. Schemas for this comparison's codec workloads (workloads.mjs), each validated against its bytes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { encode, BindleDecimal, NDArray } from '../baseline/cbor-3sln.mjs';
import { workloads } from './workloads.mjs';

const src = n => readFileSync(new URL(`../../corpus/cddl-study/contracts/${n}`, import.meta.url), 'utf8');
const jkt = 'a'.repeat(43), sid = 'b'.repeat(22);
const base = { bindle: 'signaling-message', v: 1, iss: 'https://p.example', sub: 'https://p.example/u', aud: 'https://q.example/v', sid, leg: jkt, seq: 0, iat: 1 };
const sets = {
  'object-storage-v1.cddl': [
    ['request', { method: 'put', args: { key: 'k', data: new Uint8Array(10), condition: { absent: true } } }, true],
    ['request', { method: 'put', args: { key: 'k', data: new Uint8Array(10), condition: { absent: true }, extra: 1 } }, false],
    ['request', { method: 'get', args: { key: 'k', range: { start: 0, end: 2 ** 40 } } }, true],
    ['request', { method: 'presign', args: { key: 'k', operation: 'write', size: 10, condition: { version: 'v' } } }, true],
    ['request', { method: 'capabilities', args: {} }, true],
    ['presign-result', { url: 'https://x.example/a', method: 'PUT', expiresAt: 1, revocation: 'live', requiredHeaders: { a: 'b' }, mode: 'proxy' }, true],
    ['presign-result', { url: 'javascript:https://x', method: 'PUT', expiresAt: 1, revocation: 'live', requiredHeaders: {}, mode: 'proxy' }, false],
  ],
  'item-classification-v1.cddl': [
    ['classify-args', { detail: 'minimal', item: { kind: 'text', mediaType: 'text/plain', size: 3, data: new Uint8Array(3) }, labels: [{ id: 'spam', description: 'Spam' }] }, true],
    ['classify-args', { detail: 'full', item: { kind: 'image', mediaType: 'image/png', size: 5, url: { href: 'https://x.example/i', expiresAt: 9 } }, tags: { source: 'email', context: ['a.b'] }, labels: [{ id: 'spam', description: 'Spam' }] }, true],
    ['classify-args', { detail: 'full', item: { kind: 'image', mediaType: 'Image/PNG', size: 5, url: { href: 'https://x.example/i', expiresAt: 9 } }, labels: [{ id: 'spam', description: 'S' }] }, false],
  ],
  'event-bus-tasks.cddl': [
    ['payload', { task: 't1', title: 'Hello' }, true],
    ['record', { type: 'created', data: encode({ task: 't1' }) }, true],
    ['record', { type: 'created', data: encode({ task: 1 }) }, false],
  ],
  'preferences-v2.cddl': [
    ['result', { fragment: 'https://f.example/x', revision: '1', values: { a: 1, b: [{ id: 'https://r.example/1', status: 'available', contracts: [] }] } }, true],
    ['result', { fragment: 'https://f.example/x', revision: '1', values: { b: [{ id: 'https://r.example/1', status: 'available', contracts: [], token: 't', token_type: 'DPoP', expires_at: 5 }] } }, true],
    ['result', { fragment: 'https://f.example/x', revision: '1', values: { a: BindleDecimal.from('2.5') } }, true],
  ],
  'ledger-numeric.cddl': [
    ['entry', { amount: 2n ** 70n, price: BindleDecimal.from('9.99'), weights: new Float32Array(3), matrix: new NDArray([2, 2], new Float64Array(4)), flags: 5, series: { ts: new BigInt64Array(2), value: new Float64Array(2) } }, true],
    ['entry', { amount: 1, flags: 8, series: { ts: [1], value: [1.5] } }, false],
  ],
  'signaling-message-v1.cddl': [
    ['message', { ...base, to: null, type: 'cancel', body: {} }, true],
    ['message', { ...base, to: jkt, type: 'end', body: { reason: 'closed' } }, true],
    ['message', { ...base, to: null, type: 'invite', body: { kind: { artefact: 'a', version: '1', digest: 'd' }, profile: 'webrtc', answer_by: 5, basis: null, context: { a: 1 }, params: {} } }, true],
    ['message', { ...base, to: jkt, type: 'end', body: { reason: 'nope' } }, false],
  ],
};

export function studyCases() {
  const out = [];
  for (const [file, cases] of Object.entries(sets)) {
    const text = src(file);
    cases.forEach(([rule, v, valid], i) => out.push({ id: `${file.replace('.cddl', '')}#${i}`, schema: file.replace('.cddl', ''), text, rule, list: [encode(v)], valid, opts: { top: 'map' } }));
  }
  return out;
}

// Schemas for the codec workloads (closed maps, as RFC 8610 maps are).
const WS = {
  rpc287: 'r = { version: tstr, resource: tstr, contract: tstr, method: tstr, args: { key: tstr, data: bstr }, scope: { * tstr => any }, epoch: null, resourceGeneration: null, connectionGeneration: null }',
  ints: 'r = [* int]',
  typed: 'r = { f32: #6.85(bstr), f64: #6.86(bstr), i16: #6.77(bstr) }',
  maps: 'r = [* m]\nm = { a: uint, b: uint, c: tstr, d: uint, e: uint, f: tstr, g: null, h: bool }',
  doc: 'r = { records: [* record], padding: tstr }\nrecord = { id: uint, kind: tstr, title: tstr, meta: { owner: tstr, size: uint, active: bool }, body: tstr }',
  text: 'r = { records: [* record], padding: tstr }\nrecord = { id: uint, title: tstr, body: tstr, tags: [* tstr] }',
  cwt: 'r = { 1: tstr, 2: tstr, 3: tstr, 4: int, 5: int, 6: int, 7: bstr, * int => any }',
  seq: 'r = { id: uint, op: "set" / "del", key: tstr, value: uint, ok: bool, ts: uint }',
};
WS.rpc1m = WS.rpc287;

export function workloadCases() {
  return workloads().filter(w => WS[w.id]).map(w => ({ id: `workload:${w.id}`, schema: `workload-${w.id}`, text: WS[w.id], rule: 'r',
    list: w.seq ? w.bytes : [w.bytes], valid: true, size: w.size, name: w.name, opts: w.opts, cose: !!w.cose }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2]; mkdirSync(dir, { recursive: true });
  const lines = [];
  const schemas = new Map();
  [...studyCases(), ...workloadCases()].forEach((c, i) => {
    schemas.set(c.schema, c.text);
    const file = `case${i}.cbor`;
    // a sequence is stored as u32-LE length-prefixed items
    const parts = c.list.flatMap(b => { const h = new Uint8Array(4); new DataView(h.buffer).setUint32(0, b.length, true); return [h, b]; });
    writeFileSync(`${dir}/${file}`, Buffer.concat(parts));
    const o = c.opts ?? {};
    // id schema rule valid top_any cose max_bytes max_entries max_items file
    lines.push([c.id, c.schema, c.rule, c.valid ? 1 : 0, o.top === 'any' ? 1 : 0, o.cose ? 1 : 0, o.maxBytes ?? -1, o.maxEntries ?? -1, o.maxItems ?? -1, file].join(' '));
  });
  for (const [name, text] of schemas) writeFileSync(`${dir}/${name}.cddl`, text);
  writeFileSync(`${dir}/manifest.txt`, lines.join('\n') + '\n');
  console.log(`${lines.length} cases, ${schemas.size} schemas -> ${dir}`);
}
