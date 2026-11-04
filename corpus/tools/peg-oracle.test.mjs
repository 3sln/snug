import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compile, check, decode, ecBytes } from './peg-oracle.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const architecture = readFileSync(join(root, 'docs/architecture.md'), 'utf8');
const hex = s => Uint8Array.from(Buffer.from(s.replace(/\s/g, ''), 'hex'));
const bytes = xs => Uint8Array.from(xs.flatMap(x => Array.from(x)));
function head(m, n) {
  n = BigInt(n);
  if (n < 24n) return Uint8Array.of(m * 32 + Number(n));
  const size = n < 256n ? 1 : n < 65536n ? 2 : n < 4294967296n ? 4 : 8;
  const a = new Uint8Array(size + 1); a[0] = m * 32 + 24 + Math.log2(size);
  for (let i = size; i; i--, n >>= 8n) a[i] = Number(n & 255n);
  return a;
}
// Test-side diagnostic notation reader: directly emits bytes, preserving map wire order.
function diagnosticBytes(s) {
  let p = 0;
  const space = () => { while (/\s/.test(s[p] ?? '') && p < s.length) p++; };
  function item() {
    space();
    if (s[p] === '[' || s[p] === '{') {
      const map = s[p++] === '{', close = map ? '}' : ']', out = []; let count = 0; space();
      while (s[p] !== close) {
        out.push(item()); space();
        if (map) { assert.equal(s[p++], ':'); out.push(item()); space(); }
        count++; if (s[p] !== close) { assert.equal(s[p++], ','); space(); }
      }
      p++; return bytes([head(map ? 5 : 4, count), ...out]);
    }
    if (s[p] === '"') {
      const m = /^"(?:[^"\\]|\\.)*"/s.exec(s.slice(p)); assert.ok(m); p += m[0].length;
      const b = new TextEncoder().encode(JSON.parse(m[0])); return bytes([head(3, b.length), b]);
    }
    const bstr = /^h'([\da-fA-F ]*)'/.exec(s.slice(p));
    if (bstr) { p += bstr[0].length; const b = hex(bstr[1]); return bytes([head(2, b.length), b]); }
    const simple = /^(false|true|null|undefined)/.exec(s.slice(p));
    if (simple) { p += simple[0].length; return Uint8Array.of({ false: 244, true: 245, null: 246, undefined: 247 }[simple[0]]); }
    const n = /^-?\d+/.exec(s.slice(p)); assert.ok(n, 'supported diagnostic item'); p += n[0].length;
    const v = BigInt(n[0]); return head(v < 0n ? 1 : 0, v < 0n ? -1n - v : v);
  }
  const result = item(); space(); assert.equal(p, s.length); return result;
}
function verdict(cddl, data, options) {
  const schema = compile(cddl); assert.equal(schema.error, undefined, 'schema compiles: ' + cddl);
  return check(schema, 'r', decode(diagnosticBytes(data)), options);
}
function wireVerdict(cddl, encoded, options) {
  const schema = compile(cddl); assert.equal(schema.error, undefined, 'schema compiles: ' + cddl);
  return check(schema, 'r', decode(hex(encoded)), options);
}

// Read only the documented table: no scratch probes or matcher implementation.
const probes = architecture.split('\n').filter(line => /^\| [AFHMNR]\d+\.\d+ \|/.test(line)).map(line => {
  const cells = line.split('|').slice(1, -1).map(s => s.trim());
  const unquote = x => { assert.ok(x.startsWith('`') && x.endsWith('`')); return x.slice(1, -1); };
  return { id: cells[0], cddl: unquote(cells[1]).replace(/;\s*/g, '\n'), data: unquote(cells[2]), reference: cells[3] === '✓', rfc: cells[4] === '✓' };
});

test('design table has exactly 117 documented probes', () => assert.equal(probes.length, 117));
for (const p of probes) for (const cuts of ['reference', 'rfc']) test(`design ${p.id} ${cuts}`, () => {
  assert.equal(verdict(p.cddl, p.data, { cuts }), p[cuts], `${p.id} ${cuts}: design mismatch`);
});

const suites = JSON.parse(readFileSync(join(root, 'corpus/conformance/adversarial.json'), 'utf8')).suites;
// Case indices are explicit reviewable expectations from §20.13, not oracle-generated gold.
const flips = new Map([
  ['A1: choices correlate optional factor with residual', [1, 3]],
  ['C6: incoming optional prefix gives multiple counts', [2]],
  ['A3: paired prefix gives multiple counts', [3, 5, 7]],
  ['embedded sequence with backtracking', [0]],
  ['seeded-041', [4]], ['seeded-043', [4]], ['seeded-049', [4]], ['seeded-050', [2]],
  ['seeded-000', [1, 2, 3]], ['seeded-004', [1]], ['seeded-008', [2, 3]],
  ['seeded-012', [2, 3]], ['seeded-016', [1, 2, 3]], ['seeded-024', [1]],
  ['seeded-028', [1, 2, 3]], ['seeded-044', [2]], ['seeded-048', [2]],
  ['seeded-052', [2]], ['seeded-056', [1, 2, 3]], ['seeded-068', [1]],
]);
test('migration specifies 11 structural + 22 rule-A flips', () => {
  assert.equal([...flips.values()].reduce((n, xs) => n + xs.length, 0), 33);
  for (const name of flips.keys()) assert.ok(suites.some(s => s.name === name), name);
});
for (const [name, changed] of flips) {
  const s = suites.find(s => s.name === name);
  for (const [i, c] of s.cases.entries()) test(`corpus ${name} #${i}${changed.includes(i) ? ' flips' : ''}`, () => {
    const schema = compile(s.cddl); assert.equal(schema.error, undefined);
    if (changed.includes(i)) assert.equal(c.expect, true, 'old verdict before migration');
    assert.equal(check(schema, c.rule, decode(hex(c.hex))), changed.includes(i) ? false : c.expect);
  });
}
test('complete adversarial corpus: precisely the 33 documented flips', () => {
  const differences = []; let checked = 0;
  for (const s of suites) {
    if (s.schemaError) continue;
    const schema = compile(s.cddl); assert.equal(schema.error, undefined, s.name);
    for (const [i, c] of s.cases.entries()) {
      const actual = check(schema, c.rule, decode(hex(c.hex))); checked++;
      assert.notEqual(actual, 'unknown', s.name + ' #' + i);
      if (actual !== c.expect) differences.push(s.name + ' #' + i);
    }
  }
  const expected = [...flips].flatMap(([name, indices]) => indices.map(i => name + ' #' + i));
  assert.deepEqual(differences.sort(), expected.sort());
  assert.equal(checked, 910);
});

const semantics = [
  // Source order, pick order, cuts, epochs, lock-in, empty iteration and scope.
  ['r = {int => int, int => 6}', '{3:6,4:5}', false],
  ['r = {int => int, int => 6}', '{4:6,3:5}', true],
  ['r = {(a: int) // (), * tstr => any}', '{"a":"x"}', true],
  ['r = {? a: int, * tstr => any}', '{"a":"x"}', false],
  ['r = {(a: int) // (), * tstr => any}', '{"a":"x"}', false, 'rfc'],
  ['r = {* (a: int)}', '{"a":1}', true, 'rfc'],
  ['r = {((a: int // b: int), c: int) // (* tstr => any)}', '{"a":1}', false, 'rfc'],
  ['r = {((a: int // b: int), c: int) // (* tstr => any)}', '{"a":1}', true],
  ['r = {a: int, b: int} / {* tstr => any}', '{"a":"x"}', true, 'rfc'],
  ['r = [16777216*16777216 (? int)]', '[]', true],
  ['r = {16777216*16777216 (? a: int)}', '{}', true],
  ['r = [0*0 $$g]', '[]', true],
  ['r = [* 3]', '[3,3]', true],
  ['r = [2 *3 int]', '[2,1,1]', true],
  ['r = [$$g]', '[]', false],
  ['r = [$x]', '[1]', false],
  ['r = [$$g]\n$$g //= int\n$$g //= tstr', '["x"]', true],
  ['r = $x\n$x /= int\n$x /= tstr', '"x"', true],
  ['r = {g}\ng = (a: int)', '{"a":1}', true],
  ['r = [~a]\na = [int] / [int,int]', '[1,2]', false],
  ['r = [~tagged]\ntagged = #6.42(int)', '[1]', true],
  ['r = ~tagged\ntagged = #6.42(tstr)', '"x"', true],
  ['r = &g\ng = (? a: 1, 0*0 b: 2)', '2', true],
  ['r = uint .bits &(r: 2, w: 1, x: 0)', '7', true],
  ['r = uint .bits (0 / 2)', '2', false],
  ['r = bstr .bits (0 / 8)', "h'0101'", true],
  ['r = bstr .bits (0 / 8)', "h'0002'", false],
  ['r = tstr .size 2', '"é"', true],
  ['r = uint .size 1', '255', true],
  ['r = uint .size 1', '256', false],
  ['r = uint .size (1..2)', '256', true],
  ['r = (1..3) .and (2..4)', '1', false],
  ['r = (1..3) .within (2..4)', '3', true],
  ['r = tstr .regexp "[a-z]+"', '"abc"', true],
  ['r = tstr .regexp "[a-z]+"', '"abc\\n"', false],
  ['r = tstr .regexp "[a-z]+"', '"!abc"', false],
  ['r = bstr .cbor [int]', "h'8101'", true],
  ['r = bstr .cbor int', "h'0102'", false],
  ['r = bstr .cborseq [* int]', "h'0102'", true],
  ['r = bstr .cborseq [* int]', "h''", true],
  ['r = bstr .cbor int / bstr', "h'ff'", true],
  ['r = [pair<uint>]\npair<T> = (T, T)', '[1,2]', true],
  ['r = box<tstr>\nbox<T> = [T]', '["x"]', true],
  ['r = g<1>\ng<T> = [T, ? g<1>]', '[1,[1]]', true],
  ['r = #7.<32..255>', 'true', false],
  ['r = (1 .plus 2)', '3', true],
  ['r = ((1 / 2) .plus 3)', '5', true],
  ['r = ("ab" .cat "cd")', '"abcd"', true],
  ['r = ("" .det \'  a\\n  b\')', '"a\\nb"', true],
  ['r = tstr .feature "f"', '"x"', true],
  ['r = uint .default 1', '1', true], // Inherited architecture §4.6 policy; README finding F6.
  ['r = "\\u{1F073}"', '"🁳"', true],
  ['r = "\\uD83C\\uDC73"', '"🁳"', true],
  ['r = b64\'AQI\'', "h'0102'", true],
  ['r = \'a\\\'b\'', "h'612762'", true],
  ['r = 0x1.8p1', '3', false], // A float literal does not match an integer.
];
semantics.forEach(([cddl, data, expected, cuts], i) => test(`semantic supplement ${i}`, () => assert.equal(verdict(cddl, data, { cuts }), expected)));
const wireCases = [
  ['r = uint', '1801', true], ['r = [int]', '9f01ff', true],
  ['r = #0.24', '01', true], ['r = #0.24', '18ff', true], ['r = #0.24', '190100', false],
  ['r = #0.25', '190100', true], ['r = #3.31', '6161', true], ['r = #0.31', '01', false],
  ['r = tstr .size 2', '7f61616162ff', true], ['r = bstr .size 2', '5f41014102ff', true],
  ['r = {a: int}', 'bf616101ff', true], ['r = any', 'f820', true],
  ['r = undefined', 'f7', true], ['r = #7.<32..255>', 'f8ff', true],
  ['r = #6.<40..50>(int)', 'd82a01', true],
  ['r = tdate', 'c06178', true], ['r = time', 'c101', true],
  ['r = integer', 'c24101', true], ['r = uint', 'c24101', false],
  ['r = bigfloat', 'c5820001', true], ['r = decfrac', 'c4822001', true],
  ['r = eb64url', 'd501', true], ['r = eb64legacy', 'd601', true], ['r = eb16', 'd701', true],
  ['r = encoded-cbor', 'd8184101', true], ['r = uri', 'd8206178', true],
  ['r = b64url', 'd8216178', true], ['r = b64legacy', 'd8226178', true],
  ['r = regexp', 'd8236178', true], ['r = mime-message', 'd8246178', true],
  ['r = cbor-any', 'd9d9f701', true],
  ['r = 18446744073709551616..18446744073709551617', 'c249010000000000000001', true],
  ['r = integer .gt 18446744073709551615', 'c249010000000000000000', true],
  ['r = integer .le -18446744073709551617', 'c349010000000000000000', true],
  ['r = 18446744073709551616', 'c249010000000000000000', true],
  ['r = 18446744073709551616', 'c24a00010000000000000000', false],
  ['r = integer .eq 18446744073709551616', 'c24a00010000000000000000', true],
  ['r = 0x3p-1075', 'fb0000000000000002', true],
  ['r = 0X3P-1075', 'fb0000000000000002', true],
  ['r = 1E0', 'f93c00', true],
  ['r = float16', 'f93e00', true], ['r = float32', 'fa3fc00000', true], ['r = float64', 'fb3ff8000000000000', true],
  ['r = 1', 'f93c00', false], ['r = 1.0', '01', false],
  ['r = -0.0', 'f90000', true], ['r = 0.0', 'f98000', true],
  ['r = float .lt 0.0', 'f98000', false], ['r = float .gt -0.0', 'f90000', false],
  ['r = float .le 0.0', 'f98000', true], ['r = float .ge -0.0', 'f90000', true],
  ['r = float .eq -0.0', 'f90000', true], ['r = float .ne 0.0', 'f98000', false],
  ['r = float .ne 1.5', 'f97e00', true], ['r = float .eq 1.5', 'f97e00', false],
  ['r = float .lt 2.0', 'f97e00', false], ['r = -1.0..1.0', 'f98000', true],
  ['r = -1.0...0.0', 'f98000', false], ['r = float .le 2.0', 'f97e00', false],
  ['r = float .gt 2.0', 'f97e00', false], ['r = float .ge 2.0', 'f97e00', false],
  ['r = #7', 'f97c00', true],
  ['r = [* int] .eq [1,2]', '820102', true],
  ['r = {* tstr => int} .ne {a:1}', 'a1616101', false],
  ['r = #6.42(float) .eq #6.42(0.0)', 'd82af98000', true],
  ['r = #6.42(float) .ne #6.42(1.5)', 'd82af97e00', true],
  ['r = {float ^=> int}', 'a1f9800001', true],
  ['r = {bstr ^=> int}', 'a1410001', true],
  ['r = {[int] => int}', 'a1810102', true],
  ['r = { {a: int} => int }', 'a1a161610102', true],
];
wireCases.forEach(([cddl, data, expected], i) => test(`wire and types supplement ${i}`, () => assert.equal(wireVerdict(cddl, data), expected)));

test('permissive decoder rejects malformed structures, UTF-8 and EC duplicate keys', () => {
  for (const data of ['ff', '1f', '3f', 'df', 'fc', 'f801', 'f818', 'f81f', '81ff', 'bf01ff', '5f5fffff', '5f6161ff', '7f62c328ff', '7f61c361a9ff', '9f', 'a201010102', 'a2f9000001f9800002', 'a2f97e0001f9fe0002', 'a2f97e0001fa7fc0000002', 'a2a20100020001a20200010002'])
    assert.throws(() => decode(hex(data)), undefined, data);
});
test('EC normalises finite widths, float zeros, NaN sign/significand and map order', () => {
  for (const [a, b] of [['f98000', 'f90000'], ['f93e00', 'fa3fc00000'], ['f97e00', 'fa7fc00000'], ['f97e00', 'fbfff8000000000000'], ['f97c01', 'fa7f802000'], ['a201010202', 'a202020101']])
    assert.deepEqual(ecBytes(decode(hex(a))), ecBytes(decode(hex(b))));
  for (const [a, b] of [['00', 'f90000'], ['f97e00', 'f97e01'], ['c24101', '01'], ['f97c01', 'f97e01']])
    assert.notDeepEqual(ecBytes(decode(hex(a))), ecBytes(decode(hex(b))));
});
test('step exhaustion and unsupported controller domains are unknown', () => {
  assert.equal(check(compile('r = [* int]'), 'r', [1, 2], { steps: 1 }), 'unknown');
  assert.equal(check(compile('r = uint .eq int'), 'r', 1), 'unknown');
  assert.equal(check(compile('r = float .eq (0.0..1.0)'), 'r', 0.5), 'unknown');
  assert.equal(check(compile(''), 'uint', 1), true);
});
test('compile refusals and empty grammar', () => {
  for (const [source, error] of [['r = {int}', 'map_key'], ['r = [g]\ng = (? g, int)', 'left_recursion'], ['r = r / int', 'left_recursion'], ['r = missing', 'undefined_rule'], ['r = bstr .abnf "x"', 'unsupported_control'], ['r = [3*2 int]', 'occurrence'], ['r = "\\u{110000}"', 'syntax'], ['r = "\\uD800"', 'syntax']])
    assert.equal(compile(source).error, error, source);
  assert.equal(compile('').error, undefined);
});

// A balanced seeded sample, including the eight documented Ruby deviation mechanisms.
// Candidate classes describe a syntactic mechanism; classification also requires the
// expected direction of the disagreement. Unexpected directions remain "new".
function seededSample() {
  let state = 0x86109165;
  const next = n => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % n; };
  const out = [];
  for (let i = 0; i < 300; i++) {
    const family = i % 20, key = 'k' + next(100000), n = next(4), val = ['0', '1', '-1', '"x"', '"y"', 'true'][next(6)];
    const keyText = JSON.stringify(key), pair = `${keyText}:${val}`;
    let body, data, candidate;
    switch (family) {
      case 0: body = '[* uint, uint]'; data = '[' + Array.from({ length: n + 1 }, () => String(next(4))).join(',') + ']'; break;
      case 1: body = '[(int) // (int, int)]'; data = n % 2 ? '[1,2]' : '[1]'; break;
      case 2: body = `{? (${key}: int), * tstr => any}`; data = `{${pair}}`; candidate = 'RC'; break;
      case 3: body = `{? "${key}" => int, * tstr => any}`; data = `{${pair}}`; candidate = 'RL'; break;
      case 4: body = '{* tstr => int, * tstr => tstr}'; data = `{${keyText}:1,"z":"x"}`; candidate = 'RK'; break;
      case 5: body = `{? (${key}: int, z: int)}`; data = `{${keyText}:${n}}`; candidate = 'RI'; break;
      case 6: body = '[2*2 (? int)]'; data = n % 2 ? '[1]' : '[]'; candidate = 'RZ'; break;
      case 7: body = '[g]'; data = '[' + [...Array(n + 1).fill(0), ...Array(n + 1).fill(1)].join(',') + ']'; candidate = 'RR'; break;
      case 8: body = '{int => int, int => 6}'; data = n % 2 ? '{4:6,3:5}' : '{3:5,4:6}'; candidate = 'RO'; break;
      case 9: body = 'bstr .cborseq [* uint]'; data = n % 2 ? "h'0102'" : "h''"; candidate = 'RX'; break;
      case 10: body = `{${key}: int // ${key}: tstr}`; data = `{${pair}}`; break;
      case 11: body = `{* tstr => any, ? ${key}: int}`; data = `{${pair}}`; candidate = 'RL'; break;
      case 12: body = '[? uint, 2*3 uint, tstr]'; data = '[' + [...Array(n + 1).fill('1'), '"x"'].join(',') + ']'; break;
      case 13: body = `{* (${key}: int, z: int), * tstr => any}`; data = `{${pair}}`; candidate = 'RC'; break;
      case 14: body = '{(* tstr => int) // (* tstr => tstr)}'; data = `{${keyText}:"x"}`; candidate = 'RK'; break;
      case 15: body = '[g]'; data = '[' + Array(n + 1).fill(1).join(',') + ']'; candidate = 'RR'; break;
      case 16: body = `[${n}*${n + 2} int, tstr]`; data = '[' + [...Array(n + 1).fill('1'), '"x"'].join(',') + ']'; break;
      case 17: body = `{((${key}: int) // ()), * tstr => any}`; data = `{${pair}}`; break;
      case 18: body = `{* tstr => int, ? "${key}" ^=> tstr}`; data = `{${keyText}:${n}}`; candidate = 'RL'; break;
      case 19: body = `{2*2 (? ${key}: int)}`; data = n % 2 ? `{${keyText}:1}` : '{}'; candidate = 'RZ'; break;
    }
    let cddl = 'r = ' + body;
    if (family === 7) cddl += '\ng = (0, ? g, 1)';
    if (family === 15) cddl += '\ng = (int, ? g)';
    out.push({ id: i, cddl, encoded: diagnosticBytes(data), candidate, family });
  }
  // Seeded shuffle also varies process scheduling, without affecting cases or counts.
  for (let i = out.length - 1; i; i--) { const j = next(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function classify(sample, oracle, status) {
  const ruby = status === 0;
  if (status === 65) return sample.candidate === 'RX' ? 'RX' : 'new';
  if (status !== 0 && status !== 1) return 'new';
  if (oracle === ruby) return 'agreement';
  if (['RC', 'RI'].includes(sample.candidate) && oracle === false && ruby === true) return sample.candidate;
  if (['RL', 'RR', 'RZ', 'RO'].includes(sample.candidate) && oracle === true && ruby === false) return sample.candidate;
  if (sample.candidate === 'RK' && (sample.family === 4 && oracle === true && ruby === false || sample.family === 14 && oracle === false && ruby === true)) return 'RK';
  return 'new';
}
const rubyDefault = '/private/tmp/claude-501/-Users-raystubbs-Projects--3sln-3sln-me/8f763b0e-277c-4c0c-b7f0-8c3d4fc70450/scratchpad/cddlproj-ruby-cddl.sh';
function runRuby(wrapper, schemaPath, dataPath) {
  return new Promise(resolve => {
    const child = spawn(wrapper, [schemaPath, 'validate', dataPath], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.once('error', () => { clearTimeout(timer); resolve('spawn-error'); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve(signal ? 'timeout' : code); });
  });
}
test('Ruby differential: seed 0x86109165, 300 small schema/value pairs', async t => {
  const wrapper = process.env.PEG_RUBY ?? rubyDefault;
  if (!existsSync(wrapper)) { t.skip('Ruby wrapper absent; set PEG_RUBY to an installed offline reference wrapper'); return; }
  const scratch = mkdtempSync(join(tmpdir(), 'snug-peg-oracle-'));
  const samples = seededSample(), results = [], counts = Object.fromEntries(['agreement', 'RC', 'RL', 'RK', 'RI', 'RZ', 'RR', 'RO', 'RX', 'new', 'unknown', 'timeout'].map(k => [k, 0]));
  let cursor = 0;
  try {
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cursor < samples.length) {
        const sample = samples[cursor++], schema = compile(sample.cddl);
        assert.equal(schema.error, undefined, 'seeded schema ' + sample.id);
        const oracle = check(schema, 'r', decode(sample.encoded));
        const schemaPath = join(scratch, `${sample.id}.cddl`), dataPath = join(scratch, `${sample.id}.cbor`);
        writeFileSync(schemaPath, sample.cddl); writeFileSync(dataPath, sample.encoded);
        const status = await runRuby(wrapper, schemaPath, dataPath);
        const classification = oracle === 'unknown' ? 'unknown' : status === 'timeout' ? 'timeout' : classify(sample, oracle, status);
        counts[classification]++;
        results.push({ id: sample.id, oracle, rubyStatus: status, classification });
      }
    }));
    t.diagnostic('Ruby classifications ' + JSON.stringify(counts));
    for (const r of results.filter(r => ['new', 'unknown', 'timeout'].includes(r.classification)).sort((a, b) => a.id - b.id)) t.diagnostic(JSON.stringify(r) + ' schema=' + samples.find(s => s.id === r.id).cddl);
    assert.equal(results.length, 300);
    assert.equal(counts.new + counts.unknown + counts.timeout, 0, 'all differences explained; parse errors are RX, never false');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
