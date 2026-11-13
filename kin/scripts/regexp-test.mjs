// P8.3: Appendix F fixed vectors, both compiler dialects, complete JS/Rust
// Program identity and sampled VM outputs (including work, errors and paths).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { compile, SchemaError, COMPILE_OPTIONS, SNUG_VERSION } from '../../host/js/src/compile.mjs';
import { tables } from '../../host/js/src/unicode-tables.mjs';
import { encode } from '../../bench/baseline/cbor-3sln.mjs';
import { encode as encodeText } from '../../host/js/src/index.mjs';
import { vmScratchWords, vmScratchInit, vmValidate } from '../../gen/js/snug/vm/api.mjs';
import { selfWatch } from './watchdog.mjs';
selfWatch('regexp-test', import.meta.url);   // P9.1 caps
const vectors = JSON.parse(readFileSync(new URL('../../corpus/conformance/xsd-regexp.json', import.meta.url)));
const schema = pattern => `r = tstr .regexp ${JSON.stringify(pattern).replaceAll(String.fromCodePoint(0x10ffff), '\\u{10ffff}')}`;
const hex = b => Buffer.from(b).toString('hex');
const wordsHex = p => Array.from(p, x => (x >>> 0).toString(16).padStart(8, '0')).join('');
const cases = [];
for (const regexp of ['xsd', 'iregexp']) {
  for (const c of vectors.cases) cases.push({ ...c, text: schema(c.pattern), regexp });
  for (const pattern of vectors.invalid) cases.push({ text: schema(pattern), regexp, unicode: true, error: regexp === 'xsd' || !pattern.startsWith('(){') ? 'regexp' : undefined });
  for (const pattern of ['\\d', '\\D', '\\w', '\\W', '\\p{L}', '\\p{IsBasicLatin}', '\\P{IsGreek}'])
    for (const unicode of [false, true]) cases.push({ text: schema(pattern), regexp, unicode });
  cases.push({ text: schema('[a-z-[aeiou]]{513}'), regexp });
  cases.push({ text: schema('[a-'.repeat(520) + '[a]' + ']'.repeat(520)), regexp });
  cases.push({ text: schema('[\\p{L}-[\\p{Lu}]]'), regexp, unicode: true, limits: { compileBudget: 30000 } });
  // Folding and map-key matching use kin's compile-time matcher too.
  cases.push({ text: `r = (tstr .regexp "[a-z-[aeiou]]+") .eq "bc"`, regexp });
  cases.push({ text: `r = { * (tstr .regexp "[a-z-[aeiou]]+") => uint }`, regexp });
}
const lines = cases.map(c => `${c.regexp === 'iregexp' ? 'I ' : ''}${c.unicode ? 'U ' : ''}0 ${hex(Buffer.from(c.text))} ${COMPILE_OPTIONS.map(k => c.limits?.[k] ?? -1).join(' ')}`);
const rr = spawnSync(process.argv[2], [], { input: lines.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 28 });
assert.equal(rr.status, 0, rr.stderr || rr.error?.message);
const results = rr.stdout.trimEnd().split('\n');
assert.equal(results.length, cases.length);
let compiled = 0, refused = 0, samples = 0, references = 0;
const vmInput = [], vmExpected = [], compileExpected = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  let result;
  try { result = compile(c.text, { regexp: c.regexp, unicode: c.unicode ? tables : undefined, limits: c.limits }); }
  catch (e) {
    assert.ok(e instanceof SchemaError, e.stack);
    assert.notEqual(e.code, 'internal', c.text);
    assert.equal(results[i], `err ${e.code} ${e.line} ${e.column} ${e.rule ?? '-'}`, c.text);
    if (c.error) assert.equal(e.code, c.error);
    // Every fixed positive XSD vector must compile.
    assert.ok(c.regexp !== 'xsd' || c.accept === undefined, `${c.name}: ${e.message}`);
    compileExpected.push(results[i]);
    refused++;
    continue;
  }
  assert.equal(c.error, undefined, c.text);
  const { program: p, pool: b } = result;
  assert.equal(results[i], `ok 0 ${wordsHex(p)} ${hex(b)}`, c.text);
  compileExpected.push(results[i]);
  const pi = compiled++;
  vmInput.push(`prog ${Array.from(p).join(',')} ${hex(b) || '-'}`);
  const ref = c.node === undefined ? undefined : new RegExp(`^(?:${c.node})$`, 'v');
  const s = new Int32Array(vmScratchWords(p, 0, p[16])); vmScratchInit(s, p[16]);
  const out = new Int32Array(8 + 2 * 257);
  for (const [texts, want] of [[c.accept ?? [], true], [c.reject ?? [], false]]) for (const text of texts) {
    const bytes = encodeText(text);
    if (ref) { assert.equal(ref.exec(text)?.[0] === text, want, `Node v: ${c.name}`); references++; }
    for (const flags of [0, 1, 2, 3]) for (const budget of [-1, 0, 1, 16, 64, 256]) {
      const lim = Int32Array.from([1, 0, -1, -1, -1, -1, -1, budget, flags, 122, -1]);   // word 10: the group arena's limit (default), as vm.rs reads 11 words
      assert.ok(vmValidate(p, b, 0, bytes, lim, s, out) >= 0);
      if (budget === -1) assert.equal(out[0] === 0, want, `${c.regexp} ${c.name}: ${JSON.stringify(text)}`);
      vmInput.push(`case ${pi} 0 ${Array.from(lim).join(' ')} ${hex(bytes) || '-'}`);
      vmExpected.push(Array.from(out.slice(0, 8 + 2 * out[6])).join(' '));
      samples++;
    }
  }
}
console.log(`ok regexp: ${cases.length} JS == Rust compiler outcomes (${compiled} complete Programs, ${refused} schema errors); ${references} equivalent Node v reference verdicts`);
// Check dialect-bound source keys independently (including empty placeholders).
for (const regexp of ['xsd', 'iregexp']) for (const unicode of [undefined, tables]) {
  const text = schema(unicode ? '\\p{L}' : '[a-z]+');
  const p = compile(text, { regexp, unicode }).program;
  // format 2.0 (program-2 §1): version element 2, pegNodes 1024, then cuts (0, rfc) and groupWords (-1)
  const defaults = [262144,64,65536,1024,1024,256,256,256,1048576,8388608,10000000,32,1500000,65536,131072,128,p[37], 0, -1];
  const pre = ['snug/program-key', 2, SNUG_VERSION, 0, defaults, Buffer.from(text)];
  if (unicode || regexp === 'xsd') pre.push(Array.from(unicode ?? []));
  if (regexp === 'xsd') pre.push([], 0);
  const hash = createHash('sha256').update(encode(pre)).digest();
  for (let j = 0; j < 8; j++) assert.equal(p[7 + j], hash.readInt32BE(j * 4));
}
console.log('ok regexp: independent dialect/Unicode source-key preimages');
if (process.argv[3]) {
  const r = spawnSync(process.argv[3], [], { input: vmInput.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), vmExpected);
  console.log(`ok regexp: ${samples} complete JS == Rust VM outputs (fixed verdicts, fast/generic, both schedules, partial budgets)`);
} else console.log(`SKIP regexp: Rust VM arm (no binary given; kin/scripts/compile-test supplies it): NOT RUN`);

if (process.argv[4]) {
  const { instance } = await WebAssembly.instantiate(readFileSync(process.argv[4]), {});
  const x = instance.exports, td = new TextDecoder();
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i], bytes = Buffer.from(c.text);
    const tp = x.cc_text(bytes.length);
    new Uint8Array(x.memory.buffer, tp, bytes.length).set(bytes);
    const opt = Int32Array.from([0, ...COMPILE_OPTIONS.map(k => c.limits?.[k] ?? -1), c.regexp === 'iregexp' ? 1 : 0]);
    const op = x.cc_opt(opt.length);
    new Int32Array(x.memory.buffer, op, opt.length).set(opt);
    const u = c.unicode ? tables : new Int32Array(0), up = x.cc_unicode(u.length);
    new Int32Array(x.memory.buffer, up, u.length).set(u);
    let actual;
    if (x.cc_compile(bytes.length) === 0) {
      const pp = x.cc_program(), bp = x.cc_pool();
      const info = new Int32Array(x.memory.buffer, x.cc_info(), 8);
      actual = `ok 0 ${wordsHex(new Int32Array(x.memory.buffer, pp, info[0]))} ${hex(new Uint8Array(x.memory.buffer, bp, info[1]))}`;
    } else {
      const ep = x.cc_error(), info = new Int32Array(x.memory.buffer, x.cc_info(), 8), mem = new Uint8Array(x.memory.buffer);
      const code = td.decode(mem.subarray(ep, ep + info[0]));
      const rule = info[3] < 0 ? '-' : td.decode(mem.subarray(ep + info[0], ep + info[0] + info[3]));
      actual = `err ${code} ${info[1]} ${info[2]} ${rule}`;
    }
    assert.equal(actual, compileExpected[i], `wasm compiler: ${c.text}`);
    x.cc_release();
  }
  console.log(`ok regexp: ${cases.length} JS == Rust == wasm compiler outcomes (complete Program bytes and errors)`);
} else console.log('SKIP regexp: wasm compiler arm (no module given: the wasm toolchain is missing, or the caller gave none): NOT RUN');
