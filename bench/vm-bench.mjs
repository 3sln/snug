// P3.4 benchmark: the validator VM (bench/VM.md).
//
//     node bench/vm-bench.mjs [--quick]
//
// Columns: snug JS (generated kin VM, low-level vm-validate with a reused
// scratch), snug wasm (the same kin source, Rust -> wasm32, kin/scripts/
// wasm-build; input copied into linear memory per call), and the Rust `cddl`
// crate's wasm build from the 3sln.me study (wasm-bindgen API compile /
// validate_cbor / free, loaded as corpus/cddl-study/load.mjs does; its
// validate_cbor returns a JSON string, which is part of its cost). Then the
// end-to-end decode: schema.decode (VM + trusted builder) vs cbor.mjs decode.
//
// Method: CPU time (process.cpuUsage user + system) because the machine is
// shared; each cell calibrates an iteration count to >= 100 ms of CPU, then
// takes 7 repetitions and reports the median per call (min in VM.md's raw
// lines). Verdicts are checked outside the timed loops; every column must
// agree with the expected verdict or the row says so.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { encode, decode as cborDecode, BindleDecimal, NDArray } from './baseline/cbor-3sln.mjs';
import { inputs } from './scan-inputs.mjs';
import { compile } from '../host/js/src/compile.mjs';
import { Program, Schema } from '../host/js/src/schema.mjs';
import { vmVerify, vmVerifyWords } from '../gen/js/snug/program/verify.mjs';
import { vmScratchWords, vmScratchInit, vmValidate } from '../gen/js/snug/vm/api.mjs';

const QUICK = process.argv.includes('--quick');
const REPS = QUICK ? 3 : 7, MIN_MS = QUICK ? 30 : 100;
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
function measure(fn) {
  fn(); fn();
  let n = 1;
  for (;;) { const t = cpu(); for (let i = 0; i < n; i++) fn(); const d = cpu() - t; if (d >= MIN_MS || n >= 1 << 22) break; n = d < 1 ? n * 16 : Math.max(n * 2, Math.ceil(n * MIN_MS / d)); }
  const per = [];
  for (let r = 0; r < REPS; r++) { const t = cpu(); for (let i = 0; i < n; i++) fn(); per.push((cpu() - t) / n); }
  per.sort((a, b) => a - b);
  return { med: per[per.length >> 1], min: per[0], n };
}
const fmt = ms => ms >= 1 ? `${ms.toFixed(2)} ms` : ms >= 0.001 ? `${(ms * 1000).toFixed(1)} µs` : `${(ms * 1e6).toFixed(0)} ns`;

// ---------------------------------------------------------------- the three validators
function snugJs(text, limits) {
  const c = compile(text, { limits });
  const prog = new Program(c.program, c.pool, { verify: vmVerify, verifyWords: vmVerifyWords });
  const P = prog.P, B = prog.B;
  const S = new Int32Array(vmScratchWords(P, 0, P[16]) + 4096); vmScratchInit(S, P[16]);
  const out = new Int32Array(8 + 2 * 257);
  const rules = c.rules;
  return {
    P, B, rules, compileMs: measureOnce(() => compile(text, { limits })),
    validate(rule, bytes, lim) {
      const r = rules.indexOf(rule);
      const need = vmScratchWords(P, r, P[16]);
      if (need > S.length) throw new Error('scratch');
      return vmValidate(P, B, r, bytes, lim, S, out);
    },
    out,
  };
}
function measureOnce(f) { const t = cpu(); for (let i = 0; i < 5; i++) f(); return (cpu() - t) / 5; }

let wasm = null;
const wasmPath = '.cache/snug-wasm/target/wasm32-unknown-unknown/release/snug_wasm.wasm';
try {
  execFileSync('./kin/scripts/wasm-build', ['speed'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath));
  wasm = instance.exports;
} catch { wasm = null; }
function snugWasm(js) {
  if (!wasm) return null;
  const mem = () => wasm.memory.buffer;
  return {
    load() {
      new Int32Array(mem(), wasm.snug_prog_buf(), js.P.length).set(js.P);
      new Uint8Array(mem(), wasm.snug_pool_buf(), js.B.length).set(js.B);
      if (wasm.snug_vm_load(js.P.length, js.B.length) !== 0) throw new Error('wasm load');
    },
    validate(rule, bytes, lim) {
      new Uint8Array(mem(), wasm.snug_buf(), bytes.length).set(bytes);
      new Int32Array(mem(), wasm.snug_lim_buf(), 8).set(lim);
      return wasm.snug_vm_validate(bytes.length, js.rules.indexOf(rule));
    },
  };
}
const CRATE = process.env.CDDL_CRATE_PKG ?? '/private/tmp/claude-501/-Users-raystubbs-Projects--3sln-3sln-me/8f763b0e-277c-4c0c-b7f0-8c3d4fc70450/scratchpad/cddlproj-oracle/pkg/';
let glue = null, crateModule = null;
if (existsSync(CRATE + 'bindle_cddl_study_bg.wasm')) {
  glue = await import(CRATE + 'bindle_cddl_study.js');
  crateModule = new WebAssembly.Module(readFileSync(CRATE + 'bindle_cddl_study_bg.wasm'));
  glue.initSync({ module: crateModule });
}
// after a trap the crate's instance is unusable (study §6): a fresh one
const crateReset = () => { glue.__reset ? glue.__reset(crateModule) : glue.initSync({ module: crateModule }); };
function crate(text) {
  if (!glue) return null;
  let h = glue.compile(text), note = '';
  if (!h) { const w = text.replace('safe-uint = 0..9007199254740991', 'safe-uint = uint'); if (w !== text) { h = glue.compile(w); note = 'study WORKAROUND (safe-uint = uint)'; } }
  if (!h) return { error: glue.last_error().slice(0, 80) };
  return { note, validate: (rule, bytes) => JSON.parse(glue.validate_cbor(h, rule, bytes)).ok, raw: (rule, bytes) => glue.validate_cbor(h, rule, bytes), free: () => glue.free(h) };
}

// ---------------------------------------------------------------- 1. the six study contracts
const src = n => readFileSync(new URL(`../corpus/cddl-study/contracts/${n}`, import.meta.url), 'utf8');
const jkt = 'a'.repeat(43), sid = 'b'.repeat(22);
const base = { bindle: 'signaling-message', v: 1, iss: 'https://p.example', sub: 'https://p.example/u', aud: 'https://q.example/v', sid, leg: jkt, seq: 0, iat: 1 };
// probe values: corpus/cddl-study/contracts.mjs (the study's), signaling as CBOR
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
const LIM_ANY = Int32Array.of(1, 0, -1, -1, -1, -1, -1, -1);
const rows1 = [];
console.log('# 1. study contracts: per call, median CPU (snug JS | snug wasm | cddl crate wasm)');
for (const [file, cases] of Object.entries(sets)) {
  const text = src(file);
  const js = snugJs(text, {});
  const wm = snugWasm(js); if (wm) wm.load();
  const cr = crate(text);
  for (const [rule, v, exp] of cases) {
    const bytes = encode(v);
    const okJs = js.validate(rule, bytes, LIM_ANY) === 0;
    const okW = wm ? wm.validate(rule, bytes, LIM_ANY) === 0 : null;
    const okC = cr?.validate ? cr.validate(rule, bytes) : null;
    const tJs = measure(() => js.validate(rule, bytes, LIM_ANY));
    const tW = wm ? measure(() => wm.validate(rule, bytes, LIM_ANY)) : null;
    const tC = cr?.validate ? measure(() => cr.raw(rule, bytes)) : null;
    const row = { file, rule, bytes: bytes.length, exp, okJs, okW, okC, tJs, tW, tC, used: js.out[3], crateNote: cr?.note ?? cr?.error };
    rows1.push(row);
    console.log(`${file.padEnd(28)} ${rule.padEnd(15)} ${String(bytes.length).padStart(5)} B ${exp ? 'valid  ' : 'invalid'} | ${fmt(tJs.med).padStart(9)} ${okJs === exp ? '' : '!'} | ${tW ? fmt(tW.med).padStart(9) : '-'} ${okW === null || okW === exp ? '' : '!'} | ${tC ? fmt(tC.med).padStart(9) : (cr?.error ? 'no compile' : '-')} ${okC === null || okC === exp ? '' : `! crate says ${okC}`} | budget ${js.out[3]}`);
  }
  cr?.free?.();
  console.log(`${''.padEnd(28)} compile (snug JS): ${fmt(js.compileMs)}`);
}

// ---------------------------------------------------------------- 2. large inputs, permissive schemas
console.log('\n# 2. P1.4 inputs against permissive schemas (budget unlimited): snug JS | snug wasm | crate wasm');
const permissive = {
  'vectors': 'r = any',
  'RPC put, 287 B': 'r = { * tstr => any }',
  'RPC put with 1 MiB bstr': 'r = { method: tstr, args: { key: tstr, data: bstr, * tstr => any }, * tstr => any }',
  '120,000-int array': 'r = { v: [* int] }',
  '1 MiB typed arrays': 'r = { f32: #6.85(bstr), f64: #6.86(bstr), i16: #6.77(bstr) }',
  'nested maps': 'r = { docs: [* { * tstr => any }] }',
};
const BIGL = { budget: 0x7fffffff, items: 1 << 24, entries: 1 << 24 };
const rows2 = [];
for (const inp of inputs) {
  const key = Object.keys(permissive).find(k => inp.name.startsWith(k));
  for (const text of ['r = any', permissive[key]]) {
    if (text === 'r = any' && key === 'vectors' && rows2.some(r => r.input === inp.name)) continue;
    const js = snugJs(text, BIGL);
    const wm = snugWasm(js); if (wm) wm.load();
    const cr = crate(text);
    const list = inp.many ?? [inp.bytes];
    const lim = Int32Array.of(inp.opt.top === 'any' ? 1 : 0, 0, 0x7fffffff, -1, -1, -1, -1, -1);
    const verdicts = list.map(b => js.validate('r', b, lim));
    const okJs = verdicts.every(c => inp.many ? true : c === 0);
    const tJs = measure(() => { for (const b of list) js.validate('r', b, lim); });
    const used = list.length === 1 ? js.out[3] : null;
    const tW = wm && list.every(b => b.length <= wasm.snug_cap()) ? measure(() => { for (const b of list) wm.validate('r', b, lim); }) : null;
    let tC = null, okC = null;
    if (cr?.validate && !inp.many) {
      try { okC = cr.validate('r', list[0]); tC = measure(() => cr.raw('r', list[0])); cr.free(); }
      catch (e) { okC = 'trap'; crateReset(); }
    }
    const row = { input: inp.name, schema: text, tJs, tW, tC, okJs, okC, used };
    rows2.push(row);
    console.log(`${inp.name.padEnd(46)} ${text.padEnd(40).slice(0, 40)} | ${fmt(tJs.med).padStart(9)}${okJs ? '' : ' !'} | ${tW ? fmt(tW.med).padStart(9) : '-'} | ${tC ? fmt(tC.med).padStart(9) : (okC === 'trap' ? '     trap' : '-')}${okC === false ? ' ! crate refuses' : ''}${used !== null ? ` | budget ${used}` : ''}`);
  }
}

// ---------------------------------------------------------------- 3. hostile
console.log('\n# 3. hostile inputs');
const sixText = ['r = [* msg]', 'msg = a / b / c / d / e / f',
  ...'abcdef'.split('').map(k => `${k} = { kind: "${k}", v: ${({ a: 'uint', b: 'tstr', c: 'bool', d: '[* int]', e: '{ * tstr => int }', f: 'bstr' })[k]} }`)].join('\n');
const msgs = []; for (let i = 0; msgs.length < 1e6; i++) { msgs.push({ kind: 'a', v: i }); if (msgs.length * 13 > 1_400_000) break; }
const sixBad = encode([...msgs.slice(0, -1), { kind: 'a', v: 'late' }], { maxItems: 1 << 24, maxEntries: 1 << 20 });
const rows3 = [];
for (const [label, text, bytes, limits, lim] of [
  [`invalid ${sixBad.length} B vs six-way choice, default 4 M budget`, sixText, sixBad, { items: 1 << 24, entries: 1 << 20 }, LIM_ANY],
  [`invalid ${sixBad.length} B vs six-way choice, unlimited budget`, sixText, sixBad, { items: 1 << 24, entries: 1 << 20, budget: 0x7fffffff }, LIM_ANY],
  ['declared length 2^64-1 (byte string)', 'r = bstr', Uint8Array.from(Buffer.from('5bffffffffffffffff', 'hex')), {}, LIM_ANY],
  ['32-deep nesting', 'r = [* r] / int', Uint8Array.from(Buffer.from('81'.repeat(32) + '01', 'hex')), {}, LIM_ANY],
  ['regexp, 1.4 MB text, default budget', 'r = tstr .regexp "(a|b|ab|ba)*c"', encode('ab'.repeat(700000)), {}, LIM_ANY],
]) {
  const js = snugJs(text, limits);
  const wm = snugWasm(js); if (wm) wm.load();
  const code = js.validate('r', bytes, lim);
  const used = js.out[3];
  const tJs = measure(() => js.validate('r', bytes, lim));
  const tW = wm && bytes.length <= wasm.snug_cap() ? measure(() => wm.validate('r', bytes, lim)) : null;
  const cr = crate(text);
  let tC = null, okC = null;
  if (cr?.validate && bytes.length < 2e6) { try { okC = cr.validate('r', bytes); tC = measure(() => cr.raw('r', bytes)); cr.free?.(); } catch (e) { okC = 'trap: ' + e.message.slice(0, 40); crateReset(); } }
  rows3.push({ label, code, used, tJs, tW, tC, okC });
  console.log(`${label.padEnd(60)} code ${code} budget ${used} | ${fmt(tJs.med)} | ${tW ? fmt(tW.med) : '-'} | crate ${tC ? fmt(tC.med) : '-'} ${okC}`);
}

// ---------------------------------------------------------------- 4. end-to-end decode
console.log('\n# 4. end-to-end decode: schema.decode (VM + builder) vs cbor.mjs decode');
const rows4 = [];
for (const inp of inputs.filter(i => !i.many)) {
  const key = Object.keys(permissive).find(k => inp.name.startsWith(k));
  for (const text of ['r = any', permissive[key]]) {
    const c = compile(text, { limits: BIGL });
    const schema = new Schema(new Program(c.program, c.pool, { verify: vmVerify, verifyWords: vmVerifyWords }));
    const opt = { ...inp.opt, maxItems: Math.min(inp.opt.maxItems, 1 << 24), maxEntries: Math.min(inp.opt.maxEntries, 1 << 24) };
    schema.decode(inp.bytes, 'r', opt);
    const tS = measure(() => schema.decode(inp.bytes, 'r', opt));
    const tV = measure(() => schema.validate(inp.bytes, 'r', opt));
    const tC = measure(() => cborDecode(inp.bytes, inp.opt));
    rows4.push({ input: inp.name, schema: text, tS, tV, tC });
    console.log(`${inp.name.padEnd(46)} ${text.padEnd(40).slice(0, 40)} | decode ${fmt(tS.med).padStart(9)} (validate ${fmt(tV.med)}) | cbor.mjs ${fmt(tC.med).padStart(9)} | ${(tS.med / tC.med).toFixed(2)}x`);
  }
}

const env = { cpu: os.cpus()[0].model, cores: os.cpus().length, os: `${os.type()} ${os.release()}`, node: process.version, load: os.loadavg().map(x => x.toFixed(1)).join(' '), wasm: !!wasm, crate: !!glue, date: new Date().toISOString() };
console.log('\n' + JSON.stringify(env));
