// Compare complete Programs (including Unicode-bound source keys) and errors.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { compile, COMPILE_OPTIONS, SchemaError, SNUG_VERSION } from '../../host/js/src/compile.mjs';
import { tables, categories } from '../../host/js/src/unicode-tables.mjs';
import { createHash } from 'node:crypto';
import { encode } from '../../bench/baseline/cbor-3sln.mjs';
import * as M from '../../gen/js/snug/compile/main.mjs';
import * as A from '../../gen/js/snug/compile/arena.mjs';
const schema = pattern => `r = tstr .regexp ${JSON.stringify(pattern)}`;
const wordsHex = p => Array.from(p, x => (x >>> 0).toString(16).padStart(8, '0')).join('');
const cases = [];
for (const category of categories) {
  for (const pattern of [`\\p{${category}}`, `\\P{${category}}`, `[\\p{${category}}_-]`, `[^\\p{${category}}]`])
    cases.push({ text: schema(pattern) });
}
for (const pattern of ['[\\p{L}\\p{Nd}_-]+', '\\p{L}{2,4}', '\\P{Cs}*', '\\p{L}{513}', '\\p{Unknown}', '\\p{@౵}', '[a-\\p{L}]', '[\\p{L}-a]'])
  cases.push({ text: schema(pattern) });
cases.push({ text: 'r = [1.25, tstr .regexp "\\\\p{L}"]' }); // float round + tables
for (const [limits, profile] of [[{ compileBudget: 100 }, 'full'], [{ regexpPositions: 1 }, 'full'], [{ totalBytes: 1000 }, 'full'], [{}, 'bus']])
  cases.push({ text: schema('\\p{L}{2}'), limits, profile });
for (const pattern of ['\\p{L}', '\\P{L}', '[\\p{L}]', '\\p{Cs}']) cases.push({ text: schema(pattern), absent: true });
// Malformed host data is refused by kin identically on both hosts.
for (const custom of [[1], [19456, 10, 9], [19456, -1, 0], [19456, 0xd800, 0xdfff],
  [19456, 0, 0x110000], [17267, 0, 1], [19456, 1, 2, 19456, 2, 3],
  [19573, 1, 2, 19456, 4, 5], [19456, 65, 90]])
  cases.push({ text: schema('\\p{L}'), custom: Int32Array.from(custom) });
let seed = 0x7339485;
const rnd = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
for (let i = 0; i < 400; i++) {
  const cat = categories[rnd(categories.length)], prop = `\\${rnd(2) ? 'p' : 'P'}{${cat}}`;
  let pattern = [prop, `[${prop}_-]`, `[^${prop}]`, `(${prop}|a){0,3}`][rnd(4)];
  if (rnd(2)) {
    const at = rnd(pattern.length);
    pattern = pattern.slice(0, at) + ['\\', '}', '[', '*', 'x', ''][rnd(6)] + pattern.slice(at + 1);
  }
  cases.push({ text: schema(pattern), limits: rnd(4) === 0 ? { compileBudget: rnd(100000) } : {} });
}
const lines = cases.map(c => `${c.custom ? 'T ' + wordsHex(c.custom) + ' ' : c.absent ? '' : 'U '}${c.profile === 'bus' ? 2 : 0} ${Buffer.from(c.text).toString('hex')} ${COMPILE_OPTIONS.map(k => c.limits?.[k] ?? -1).join(' ')}`);
const r = spawnSync(process.argv[2], [], { input: lines.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 27 });
assert.equal(r.status, 0, r.stderr || r.error?.message);
const results = r.stdout.trimEnd().split('\n');
assert.equal(results.length, cases.length);
let compiled = 0, refused = 0;
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  let out;
  try {
    const result = compile(c.text, { unicode: c.custom ?? (c.absent ? undefined : tables), limits: c.limits, profile: c.profile });
    out = `ok 0 ${wordsHex(result.program)} ${Buffer.from(result.pool).toString('hex')}`;
    compiled++;
  } catch (e) {
    assert.ok(e instanceof SchemaError, e.stack);
    assert.notEqual(e.code, 'internal', c.text);
    out = `err ${e.code} ${e.line} ${e.column} ${e.rule ?? '-'}`;
    refused++;
  }
  assert.equal(results[i], out, `${i}: ${c.text}`);
}
console.log(`ok ${cases.length} JS == Rust outcomes: ${compiled} complete Programs, ${refused} errors; Rust verifier accepts every Program`);
// Explicit port round + arena retry identity, including budget boundary outcomes.
function raw(text, initial, budget) {
  const bytes = new TextEncoder().encode(text), opt = new Int32Array(M.OPT_WORDS).fill(-1);
  if (budget !== undefined) opt[11] = budget;
  let size = initial, fl = new Int32Array(0), retries = 0;
  for (;;) {
    const h = new Int32Array(size), code = M.compileSchema(bytes, opt, fl, tables, h);
    if (code === A.ERR_ARENA) { assert.ok(size < A.ARENA_MAX_WORDS); size *= 2; retries++; continue; }
    if (code === A.ERR_NEED_FLOATS) {
      const n = M.floatRequests(h), dv = new DataView(new ArrayBuffer(8));
      fl = new Int32Array(1 + 2 * n); fl[0] = n;
      for (let i = 0; i < n; i++) {
        dv.setFloat64(0, Number(new TextDecoder().decode(bytes.subarray(M.floatRequestStart(h, i), M.floatRequestEnd(h, i)))));
        fl[1 + 2 * i] = dv.getInt32(0); fl[2 + 2 * i] = dv.getInt32(4);
      }
      continue;
    }
    const used = M.budgetUsed(h);
    if (code) return { key: `${code}:${M.errorLine(h)}:${M.errorColumn(h)}:${used}`, retries };
    const at = M.outProgramAt(h), pool = M.outPoolAt(h), key = M.keyPreimageAt(h);
    return { key: `${wordsHex(h.subarray(at, at + M.outProgramWords(h)))}:${wordsHex(h.subarray(pool, pool + M.outPoolBytes(h)))}:${wordsHex(h.subarray(key, key + M.keyPreimageLen(h)))}:${used}`, retries };
  }
}
let retries = 0;
for (const c of cases.slice(0, 161).filter(c => !c.absent)) for (const budget of [undefined, 24000, 60000]) {
  const a = raw(c.text, A.ARENA_MIN_WORDS, budget), b = raw(c.text, 1 << 22, budget);
  assert.equal(a.key, b.key, `arena/budget identity: ${c.text}`); retries += a.retries;
}
assert.ok(retries > 0);
console.log(`ok Unicode outcomes independent of arena size, including float retries and low budgets (${retries} arena growth retries)`);

const keyText = schema('\\p{L}');
const { program } = compile(keyText, { unicode: tables });
const defaults = [262144, 64, 65536, 1024, 64, 256, 256, 256, 1048576, 8388608, 10000000, 32, 1500000, 65536, 131072, 128, 2300000];
const preimage = encode(['snug/program-key', 1, SNUG_VERSION, 0, defaults, new TextEncoder().encode(keyText), Array.from(tables)]);
const hash = createHash('sha256').update(preimage).digest();
for (let i = 0; i < 8; i++) assert.equal(program[7 + i], hash.readInt32BE(i * 4));
console.log('ok Unicode-bound SOURCE_KEY independently recomputed with baseline CBOR + node:crypto');
