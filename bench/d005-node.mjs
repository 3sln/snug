// P7.9 (D005 re-take): the native-JS package vs the wasm build behind a JS SDK
// with the same public API (host/wasm-sdk), on the same inputs, in one Node
// isolate. Every row checks that both answers are identical (deepEqual of the
// public results: values, verdicts with reason/path/offset, encodings, thrown
// codes) before timing.
//
// Method: thread CPU time (process.threadCpuUsage) under --single-threaded-gc
// (P7.8's lesson: parallel GC charges one variant's garbage to another);
// per variant an iteration count calibrated to >= MIN ms of CPU; then REPS
// interleaved rounds (every variant once per round, so load drift on a shared
// machine falls on all alike); the median per call is reported.
//
//     node bench/d005-node.mjs [--quick] [--only=substring] [--json=out.json] [--wasm=path/to/sdk.wasm]
//
// Needs `kin/scripts/wasm-build sdk` and `kin/scripts/wasm-build cc`.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import { isDeepStrictEqual } from 'node:util';

if (!process.execArgv.includes('--single-threaded-gc')) {
  execFileSync(process.execPath, ['--single-threaded-gc', '--expose-gc', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(0);
}

import * as N from '../host/js/src/index.mjs';
import * as NS from '../host/js/src/public-schema.mjs';
import { compile as ncompile } from '../host/js/src/public-compile.mjs';
import { view as nview } from '../host/js/src/public-view.mjs';
import * as NSRC from '../host/js/src/sources.mjs';
import { compile as hcompile } from '../host/js/src/schema.mjs';
import { putHead } from '../gen/js/snug/write/out.mjs';
import * as W from '../host/wasm-sdk/src/index.mjs';
import * as rt from '../host/wasm-sdk/src/runtime.mjs';
import { compile as wcompile } from '../host/wasm-sdk/src/compile.mjs';
import { innerOf } from '../host/wasm-sdk/src/schema.mjs';
import { view as wview } from '../host/wasm-sdk/src/view.mjs';
import * as WSRC from '../host/wasm-sdk/src/sources.mjs';
import { workloads, mutations, BIGL } from './d005-inputs.mjs';

const QUICK = process.argv.includes('--quick');
const ONLY = process.argv.find(a => a.startsWith('--only='))?.slice(7);
const JSON_OUT = process.argv.find(a => a.startsWith('--json='))?.slice(7);
const REPS = QUICK ? 5 : 15, MIN_MS = QUICK ? 10 : 25;
const cpu = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };

function calibrate(fn) {
  fn(); fn(); fn();
  let n = 1;
  for (;;) {
    const t = cpu(); for (let i = 0; i < n; i++) fn(); const d = cpu() - t;
    if (d >= MIN_MS || n >= 1 << 22) return n;
    n = d < 1 ? n * 8 : Math.max(n * 2, Math.ceil(n * MIN_MS / d));
  }
}
function measure(fns) {
  const ns = fns.map(calibrate), per = fns.map(() => []);
  for (let r = 0; r < REPS; r++) fns.forEach((fn, k) => { const t = cpu(); for (let i = 0; i < ns[k]; i++) fn(); per[k].push((cpu() - t) / ns[k]); });
  return per.map(a => { a.sort((x, y) => x - y); return a[a.length >> 1]; });
}
async function measureAsync(fns) {
  const per = fns.map(() => []), n = QUICK ? 3 : 10;
  for (const fn of fns) { await fn(); await fn(); }
  for (let r = 0; r < REPS; r++) for (let k = 0; k < fns.length; k++) { const t = cpu(); for (let i = 0; i < n; i++) await fns[k](); per[k].push((cpu() - t) / n); }
  return per.map(a => { a.sort((x, y) => x - y); return a[a.length >> 1]; });
}
const fmt = ms => ms >= 1 ? `${ms.toFixed(2)} ms` : ms >= 0.001 ? `${(ms * 1000).toFixed(ms >= 0.01 ? 1 : 2)} µs` : `${(ms * 1e6).toFixed(0)} ns`;
const outcome = f => { try { return { ok: f() }; } catch (e) { return { err: e.name, code: e.code, reason: e.reason, path: e.path, offset: e.offset }; } };

const rows = [];
function row(group, name, variants, { check = true } = {}) {
  if (ONLY && !(`${group} ${name}`).includes(ONLY)) return;
  if (check) {
    const answers = variants.map(([, f]) => outcome(f));
    for (let k = 1; k < answers.length; k++) if (!isDeepStrictEqual(answers[k], answers[0])) throw new Error(`${group} / ${name}: ${variants[k][0]} answers differently from ${variants[0][0]}`);
  }
  const t = measure(variants.map(v => v[1]));
  const r = { group, name, cells: Object.fromEntries(variants.map(([label], k) => [label, t[k]])) };
  rows.push(r);
  console.log(`${group.padEnd(10)} ${name.padEnd(54)} ${variants.map(([l], k) => `${l} ${fmt(t[k]).padStart(9)}`).join('  ')}  wasm/native ${(t[1] / t[0]).toFixed(2)}`);
}
async function rowAsync(group, name, variants, key = x => x) {
  if (ONLY && !(`${group} ${name}`).includes(ONLY)) return;
  const answers = [];
  for (const [, f] of variants) answers.push(await f().then(ok => ({ ok: key(ok) }), e => ({ code: e.code })));
  for (let k = 1; k < answers.length; k++) if (!isDeepStrictEqual(answers[k], answers[0])) throw new Error(`${group} / ${name}: ${variants[k][0]} differs`);
  const t = await measureAsync(variants.map(v => v[1]));
  rows.push({ group, name, cells: Object.fromEntries(variants.map(([label], k) => [label, t[k]])) });
  console.log(`${group.padEnd(10)} ${name.padEnd(54)} ${variants.map(([l], k) => `${l} ${fmt(t[k]).padStart(9)}`).join('  ')}  wasm/native ${(t[1] / t[0]).toFixed(2)}`);
}

// ---------------------------------------------------------------- setup
const WASM = process.argv.find(a => a.startsWith('--wasm='))?.slice(7);   // another SDK module build (e.g. opt-level z)
await W.init(WASM ? new URL(WASM, `file://${process.cwd()}/`) : undefined);
const root = new URL('../', import.meta.url);
const study = JSON.parse(readFileSync(new URL('corpus/conformance/study.json', root), 'utf8'));
const contracts = study.suites.filter(s => s.cddlFile).map(s => ({ name: s.name, cddl: readFileSync(new URL(`corpus/${s.cddlFile}`, root), 'utf8') }));
const objectStorage = contracts.find(c => c.name.includes('object-storage')).cddl;
const W8 = workloads(objectStorage);
const env = {
  date: new Date().toISOString(), cpu: cpus()[0].model, cores: cpus().length, node: process.version, v8: process.versions.v8,
  loadStart: loadavg().map(x => +x.toFixed(1)), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  wasmBytes: rt.module() ? WebAssembly.Module.exports(rt.module()).length + ' exports' : '', reps: REPS, minMs: MIN_MS, wasmModule: WASM ?? 'release (opt-level 3)',
};
console.log(`# P7.9 native JS vs wasm+SDK, Node ${process.version}, ${env.cpu}, commit ${env.commit}, load ${env.loadStart.join('/')}`);
for (const w of W8) {
  const limits = w.cddl === objectStorage ? {} : { limits: BIGL };
  w.n = await ncompile(w.cddl, limits); w.w = await wcompile(w.cddl, limits);
  w.nh = await hcompile(w.cddl, limits);   // the native schema drivers take the host Schema (not public yet, D106)
  if (!w.n.validate(w.bytes, w.rule, w.opts).ok) throw new Error(`${w.id}: schema refuses its message`);
}
const by = id => W8.find(w => w.id === id);

// ---------------------------------------------------------------- 1. validate (schema VM)
for (const w of W8) row('validate', `${w.name}, ${w.bytes.length} B`, [['native', () => w.n.validate(w.bytes, w.rule, w.opts)], ['wasm', () => w.w.validate(w.bytes, w.rule, w.opts)]]);
{ // zero-copy: the bytes already in linear memory (a caller reading straight into an SDK buffer, e.g. a BYOB stream read)
  for (const id of ['rpc287', 'put1m', 'doc']) {
    const w = by(id), n = w.bytes.length, p = rt.x.sdk_alloc(n); rt.refresh(); rt.u8.set(w.bytes, p);
    const inner = innerOf(w.w.program), ri = w.w.ruleIndex(w.rule);
    row('validate', `zero-copy: ${w.name} already in linear memory`, [['native', () => w.n.validate(w.bytes, w.rule, w.opts)], ['wasm', () => inner.runAt(ri, p, n, w.opts)]]);
  }
}
// ---------------------------------------------------------------- 2. decode to values
for (const w of W8) row('decode', `codec decode, ${w.name}`, [['native', () => N.decode(w.bytes, w.opts)], ['wasm', () => W.decode(w.bytes, w.opts)]]);
for (const id of ['rpc287', 'doc']) { const w = by(id); row('decode', `schema.decode, ${w.name}`, [['native', () => w.n.decode(w.bytes, w.rule, w.opts)], ['wasm', () => w.w.decode(w.bytes, w.rule, w.opts)]]); }
for (const id of ['rpc287', 'put1m', 'ints', 'doc']) { const w = by(id); row('scan', `profile check only (decode's first pass), ${w.name}`, [['native', () => NSRC.scanBuffer(w.bytes, w.opts)], ['wasm', () => W.scan(w.bytes, w.opts)]]); }
// ---------------------------------------------------------------- 3. encode
for (const w of W8) row('encode', `encode, ${w.name}`, [['native', () => N.encode(w.value, w.opts)], ['wasm', () => W.encode(w.value, w.opts)]]);
{ // the per-call boundary: 120,000 kin heads, one call each
  const buf = new Uint8Array(16);
  row('boundary', '120,000 put-head calls (JS kin fn vs wasm export)', [
    ['native', () => { let r = 0; for (let i = 0; i < 120000; i++) r = putHead(buf, 0, 0, 0, i); return r > 0; }],
    ['wasm', () => { rt.x.sdk_probe_reset(); let r = 0; for (let i = 0; i < 120000; i++) { r = rt.x.sdk_probe_head(0, 0, i); if (r > 1e6) rt.x.sdk_probe_reset(); } return r > 0; }]], { check: false });
  const mib = by('put1m').bytes;
  row('boundary', `copy ${mib.length} B into linear memory (input buffer)`, [['native', () => mib.slice().length], ['wasm', () => rt.input(mib)]], { check: false });
}
// ---------------------------------------------------------------- 4. lazy navigation of the 1.4 MB document
{
  const w = by('doc'), b = w.bytes, o = w.opts;
  const nPick = v => [v.get('records').at(5000).get('meta').get('owner').text(), v.get('records').at(9999).get('id').number(), v.get('padding').length];
  const wPick = v => [v.path('records', 5000, 'meta', 'owner').text(), v.path('records', 9999, 'id').number(), v.path('padding').length];
  row('view', 'open (profile check) + 3 fields, 1.4 MB', [['native', () => nPick(nview(b, o))], ['wasm', () => { const v = wview(b, o); const r = nPick(v); v.release(); return r; }],
    ['wasm-path', () => { const v = wview(b, o); const r = wPick(v); v.release(); return r; }]]);
  row('view', 'open (schema check) + 3 fields, 1.4 MB', [['native', () => nPick(nview(b, { ...o, schema: w.n, rule: 'r' }))],
    ['wasm', () => { const v = wview(b, { ...o, schema: w.w, rule: 'r' }); const r = nPick(v); v.release(); return r; }],
    ['wasm-path', () => { const v = wview(b, { ...o, schema: w.w, rule: 'r' }); const r = wPick(v); v.release(); return r; }]]);
  const nv = nview(b, o), wv = wview(b, o);
  row('view', '3 fields on an open view (no check)', [['native', () => nPick(nv)], ['wasm', () => nPick(wv)], ['wasm-path', () => wPick(wv)]]);
  row('view', 'one field 1 level deep on an open view: get("padding").length', [['native', () => nv.get('padding').length], ['wasm', () => wv.get('padding').length], ['wasm-path', () => wv.path('padding').length]]);
  const nWalk = (v, k) => { let s = 0; for (const [, r] of v.get('records').entries()) { if (k-- === 0) break; for (const [key, f] of r.entries()) s += key.length + (f.kind === 'int' ? f.number() : 0); } return s; };
  const wvf = wview(b, { ...o, batch: false });
  row('view', 'entries() walk of 100 records (keys + ints)', [['native', () => nWalk(nv, 100)], ['wasm', () => nWalk(wvf, 100)], ['wasm-batched', () => nWalk(wv, 100)]]);
  const nCur = v => { const c = v.cursor(); let s = 0; c.enter(); c.find('records'); c.enter(); let k = 0; do { if (c.enter()) { do { if (c.keyIs('id')) s += c.int(); } while (c.next()); c.up(); } } while (++k < 1000 && c.next()); return s; };
  row('view', 'cursor walk of 1,000 records, sum ids', [['native', () => nCur(nv)], ['wasm', () => nCur(wv)]]);
  const r = by('rpc287');
  row('view', 'open (schema check) + get("method").text(), RPC 287 B', [['native', () => nview(r.bytes, { schema: r.n, rule: 'request' }).get('method').text()],
    ['wasm', () => { const v = wview(r.bytes, { schema: r.w, rule: 'request' }); const t = v.get('method').text(); v.release(); return t; }]]);
  row('view', 'same, view released by GC only (FinalizationRegistry)', [['native', () => nview(r.bytes, { schema: r.n, rule: 'request' }).get('method').text()],
    ['wasm', () => wview(r.bytes, { schema: r.w, rule: 'request' }).get('method').text()]]);
}
// ---------------------------------------------------------------- 5. sources
for (const id of ['ints', 'doc']) {
  const w = by(id), b = w.bytes;
  for (const chunk of [65536, 1024]) {
    row('sources', `validateHandleSync ${w.name}, ${chunk / 1024} KiB reads`, [['native', () => NSRC.validateHandleSync(w.nh, NSRC.bufferHandle(b), w.rule, w.opts, { chunk })],
      ['wasm', () => WSRC.validateHandleSync(w.w, WSRC.bufferHandle(b), w.rule, w.opts, { chunk })]]);
    const push = (S, s) => { const p = S.pushValidator(s, b.length, w.rule, w.opts); for (let i = 0; i < b.length; i += chunk) { let st = p.feed(b.subarray(i, i + chunk)); while (st.state === 'yield') st = p.resume(); } return p.finalize(); };
    row('sources', `pushValidator ${w.name}, ${chunk / 1024} KiB chunks`, [['native', () => push(NSRC, w.nh)], ['wasm', () => push(WSRC, w.w)]]);
    row('sources', `scanHandleSync (profile) ${w.name}, ${chunk / 1024} KiB reads`, [['native', () => NSRC.scanHandleSync(NSRC.bufferHandle(b), w.opts, { chunk })],
      ['wasm', () => WSRC.scanHandleSync(WSRC.bufferHandle(b), w.opts, { chunk })]]);
    const pushS = S => { const p = S.pushScanner(b.length, w.opts); for (let i = 0; i < b.length; i += chunk) { let st = p.feed(b.subarray(i, i + chunk)); while (st.state === 'yield') st = p.resume(); } return p.finalize(); };
    row('sources', `pushScanner (profile) ${w.name}, ${chunk / 1024} KiB chunks`, [['native', () => pushS(NSRC)], ['wasm', () => pushS(WSRC)]]);
  }
  const ah = NSRC.asyncHandle(b), wah = WSRC.asyncHandle(b);
  await rowAsync('sources', `validateHandle (async reads) ${w.name}, 64 KiB`, [['native', () => NSRC.validateHandle(w.nh, ah, w.rule, w.opts)], ['wasm', () => WSRC.validateHandle(w.w, wah, w.rule, w.opts)]]);
}
// ---------------------------------------------------------------- 6. refusal-heavy
{
  const vec = JSON.parse(readFileSync(new URL('corpus/cbor-vectors/cbor-profile.json', root), 'utf8'));
  const all = [...vec.accept, ...vec.refuse].map(v => new Uint8Array(Buffer.from(v.hex, 'hex')));
  const each = (dec) => { let refused = 0; for (const b of all) { try { dec(b, { top: 'any' }); } catch (e) { refused++; } } return refused; };
  row('refusals', `216 profile vectors, decode each (${vec.refuse.length} refused)`, [['native', () => each(N.decode)], ['wasm', () => each(W.decode)]]);
  const r = by('rpc287'), muts = mutations(r.bytes, 1000);
  const verdicts = s => muts.map(m => s.validate(m, 'request'));
  const nref = verdicts(r.n).filter(x => !x.ok).length;
  row('refusals', `1,000 mutated 287 B puts, validate each (${nref} refused)`, [['native', () => verdicts(r.n)], ['wasm', () => verdicts(r.w)]]);
  const d = by('doc'), dm = mutations(d.bytes, 20, 11);
  row('refusals', '20 mutated 1.4 MB documents, validate each', [['native', () => dm.map(m => d.n.validate(m, 'r', d.opts))], ['wasm', () => dm.map(m => d.w.validate(m, 'r', d.opts))]]);
}
// ---------------------------------------------------------------- 7. compile
{
  const programs = async c => { const out = []; for (const s of contracts) out.push((await c(s.cddl)).program.serialize()); return out; };
  const a = await programs(ncompile), b = await programs(wcompile);
  if (!isDeepStrictEqual(a, b)) throw new Error('compile: Programs differ');
  for (const s of contracts) await rowAsync('compile', `compile ${s.name.replace('contract: ', '')}`, [['native', () => ncompile(s.cddl)], ['wasm', () => wcompile(s.cddl)]], c => c.program.serialize());
}

env.loadEnd = loadavg().map(x => +x.toFixed(1));
env.memoryBytesAtEnd = W.memoryBytes();
console.log(`# load ${env.loadStart.join('/')} -> ${env.loadEnd.join('/')}; wasm linear memory at end ${env.memoryBytesAtEnd} B`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ env, rows }, null, 1));
