// Default-limit EXT adversaries. Copy this file into a clean HEAD worktree:
// node --expose-gc --single-threaded-gc bench/ext-worst.mjs --out ../ext-worst.json
// --quick: three rounds; --check-only: admission/charging/counter checks only.
// --only <id-substring>: run a subset (including for supplementary measurements).
// --dirty: allow tracked edits (calibration runs only; recorded in the report).
// Timed calls use default limits/registry maxima and the original predicates.
// Since D190-D194 the generic controls meter their own work and every row's
// verdict is whatever the real run answers (often `budget`); the gate is that
// no row but the undeclared custom predicate (host responsibility, D193)
// takes more than ~50 ms of CPU.
import assert from 'node:assert/strict';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { compile } from '../host/js/src/public-compile.mjs';
import { encode } from '../host/js/src/index.mjs';
import { controls } from '../host/js/src/controls.mjs';
import { schemaPrograms } from '../host/js/src/schema-state.mjs';
import { controlEntries } from '../host/js/src/ext.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2), quick = argv.includes('--quick');
const checkOnly = argv.includes('--check-only'), dirty = argv.includes('--dirty');
const onlyAt = argv.indexOf('--only'), only = onlyAt < 0 ? '' : argv[onlyAt + 1];
const cpu = () => { const t = process.threadCpuUsage(); return t.user + t.system; };
const median = a => [...a].sort((a, b) => a - b)[a.length >> 1];
const command = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();
const environment = () => ({ utc: new Date().toISOString(), load: os.loadavg(),
  freeBytes: os.freemem(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length,
  ramBytes: os.totalmem(), os: `${os.type()} ${os.release()} ${os.arch()}`,
  macOS: command('sw_vers', ['-productVersion']), node: process.version,
  v8: process.versions.v8, flags: process.execArgv });
const revision = command('git', ['rev-parse', 'HEAD']);
if (!dirty) assert.equal(command('git', ['status', '--porcelain', '--untracked-files=no']), '',
  'Run a copy in a clean worktree: concurrent tracked edits invalidate this benchmark');
assert.equal(typeof process.threadCpuUsage, 'function');
assert(process.execArgv.includes('--single-threaded-gc'), 'Use --single-threaded-gc');
assert(controlEntries(controls).every(c => c.maxBytes === 65536));
const report = { revision, dirty, start: environment(), method: 'threadCpuUsage user+system; public buffer validate; medians; compilation/construction/counters excluded', rows: [] };
console.log(JSON.stringify({ revision, start: report.start }));

const concat = parts => {
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0; for (const b of parts) { out.set(b, at); at += b.length; } return out;
};
const head = (major, n) => n < 24 ? Uint8Array.of(major * 32 + n)
  : n < 256 ? Uint8Array.of(major * 32 + 24, n)
  : n < 65536 ? Uint8Array.of(major * 32 + 25, n >>> 8, n & 255)
  : Uint8Array.of(major * 32 + 26, n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const array = parts => concat([head(4, parts.length), ...parts]);
const repeat = (b, n) => array(Array(n).fill(b));
const reason = r => r.ok ? 'ok' : r.reason;

// Generated kin, instrumented ONLY in an in-memory untimed copy: record
// comparisons and name probes actually made (the units are the VM's own).
let source = readFileSync(new URL('../gen/js/snug/vm/controls.mjs', import.meta.url), 'utf8');
function replaceOnce(from, to) {
  assert.equal(source.split(from).length, 2, `instrumentation anchor: ${from}`);
  source = source.replace(from, to);
}
replaceOnce("'../cbor/tags.mjs'", JSON.stringify(new URL('../gen/js/snug/cbor/tags.mjs', import.meta.url).href));
replaceOnce('export function recCmp(b, m, x, y) {', 'export function recCmp(b, m, x, y) { counts.sortComparisons++;');
replaceOnce('export function named(a, ao, t, b, ks, ke, m) {', 'export function named(a, ao, t, b, ks, ke, m) { counts.nameSearches++;');
source += '\nexport const counts = {sortComparisons:0, nameSearches:0};';
const counted = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const bigMeter = n => { const m = new Int32Array(counted.M_WORDS + 3 * n + 8); counted.meterInit(m, 0x7fffffff); return m; };

const pass = () => true;
// Finite, pure example: even a one-byte item can request arbitrarily much
// computation. This fixed 100M-iteration example does not establish an upper bound.
const slow = (_a, b) => {
  let x = b[0]; for (let i = 0; i < 100_000_000; i++) x = (Math.imul(x ^ i, 16777619) + 1) | 0;
  return x !== 0;
};
// The same predicate with a declared cost (D193): 100M iterations at ~3 ns is
// ~300 ms, so the host declares 15,000,000 units (~20 ns each) and the budget
// refuses before the call.
const slowDeclared = { check: slow, cost: () => 15_000_000 };
const registry = { ...controls, pass, slow, slowDeclared };
const schemas = new Map();
async function schema(text) {
  if (!schemas.has(text)) {
    const s = await compile('r = ' + text, { controls: registry });
    const p = s.program.P;
    assert.deepEqual([...p.slice(32, 38)], [32, 1500000, 65536, 131072, 128, 2300000]);
    schemas.set(text, s);
  }
  return schemas.get(text);
}

async function run(id, bytes, text, { slowRow = false, counters, ...details } = {}) {
  if (!id.includes(only)) return;
  assert(bytes.length <= 1500000);
  const s = await schema(text), p = schemaPrograms.get(s), rid = p.ruleIndex('r');
  // Untimed audit: the real predicates, counted.
  let calls = 0, itemBytes = 0, maxItem = 0, audit;
  if (p.ext) {
    const original = p.ext.call;
    p.ext.call = (id_, pool, ao, al, b, lo, hi, room) => {
      calls++; itemBytes += hi - lo; maxItem = Math.max(maxItem, hi - lo);
      return original(id_, pool, ao, al, b, lo, hi, room);
    };
    try { audit = p.run(rid, bytes, {}); } finally { p.ext.call = original; }
  } else audit = p.run(rid, bytes, {});
  const expected = reason(p.result(audit));
  assert(maxItem <= 65536, id + ': no oversized callback');
  const row = { id, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    schema: text.length > 200 ? text.slice(0, 200) + '...' : text, verdict: expected, steps: audit[3], items: audit[4], calls, itemBytes,
    maxItem, ...details };
  if (counters) row.work = await counters();
  if (!checkOnly) {
    const fn = () => s.validate(bytes, 'r');
    // One untimed warm call for long rows; at least 100ms CPU for short rows.
    let t = cpu(), answer;
    do { answer = fn(); } while (!slowRow && cpu() - t < (quick ? 25000 : 100000));
    assert.equal(reason(answer), expected, id + ': real verdict');
    let n = 1;
    if (!slowRow) for (;;) {
      t = cpu(); for (let i = 0; i < n; i++) answer = fn();
      const elapsed = cpu() - t;
      if (elapsed >= 25000 || n >= 65536) break;
      n = Math.min(65536, Math.max(n + 1, Math.ceil(n * 27500 / Math.max(1, elapsed))));
    }
    const samplesUs = [], rounds = quick || slowRow ? 3 : 7;
    if (slowRow) console.error(`${id}: warm-up complete; measuring ${rounds} calls`);
    for (let r = 0; r < rounds; r++) {
      t = cpu(); for (let i = 0; i < n; i++) answer = fn();
      samplesUs.push((cpu() - t) / n);
      assert.equal(reason(answer), expected, id + ': measured verdict');
      if (slowRow) console.error(`${id}: sample ${r + 1}/${rounds}, ${(samplesUs.at(-1) / 1000).toFixed(2)} ms CPU`);
    }
    const medianUs = median(samplesUs);
    Object.assign(row, { medianMs: medianUs / 1000, nsPerUnit: medianUs * 1000 / Math.max(1, audit[3]), samplesUs, iterations: n, rounds });
  }
  row.load = os.loadavg(); report.rows.push(row);
  console.log(JSON.stringify(row));
}

// The VM's own worst generic walk (bench/VM.md's six-way choice of maps, the
// D046 calibration reference, ~18.5 ns/unit unloaded), run to budget refusal
// under default limits: what 2.3 M units of ordinary VM work cost right now,
// on this (shared) machine. Reported, not gated.
const sixWay = ['[* msg]', 'msg = a / b / c / d / e / f', ...'abcdef'.split('').map(k => `${k} = { kind: "${k}", v: ${({ a: 'uint', b: 'tstr', c: 'bool', d: '[* int]', e: '{ * tstr => int }', f: 'bstr' })[k]} }`)].join('\n');
await run('reference-six-way-choice', encode(Array.from({ length: 21000 }, (_, i) => ({ kind: 'a', v: i }))), sixWay, { reference: true });

// Fill the default item cap, checking ASCII and every valid UTF-8 width.
for (const [label, ch] of [['ascii', 'a'], ['utf8-2', 'é'], ['utf8-3', '€'], ['utf8-4', '\u{10ffff}']]) {
  const width = new TextEncoder().encode(ch).length;
  const b = encode(ch.repeat(Math.floor(65533 / width)));
  await run(`chars-${label}-one`, b, 'tstr .chars (0..65536)');
  await run(`chars-${label}-22`, repeat(b, 22), '[* (tstr .chars (0..65536))]');
}
// High callback count, also exercises budget refusal before the next callback.
const tiny = concat([head(4, 65536), new Uint8Array(65536)]);
await run('pass-tiny-65536', tiny, '[* (uint .pass true)]');
await run('pass-tiny-131068', repeat(concat([head(4, 65534), new Uint8Array(65534)]), 2),
  '[* [* (uint .pass true)]]');
await run('extra-chars-tiny-131068', repeat(concat([head(4, 65534), new Uint8Array(65534).fill(0x60)]), 2),
  '[* [* (tstr .chars 0)]]');
await run('extra-chars-tiny-65536', concat([head(4, 65536), new Uint8Array(65536).fill(0x60)]),
  '[* (tstr .chars 0)]');
await run('slow-declared-one-byte', Uint8Array.of(0), 'any .slowDeclared true');
// Host responsibility (D193): an undeclared predicate's own CPU is not the VM's to bound.
await run('slow-one-byte', Uint8Array.of(0), 'any .slow true', { slowRow: true, hostResponsibility: true });

// Exactly the previous 65,536-element long-prefix case, now with DEFAULTS.
function uniqueInput(n, size, duplicate = false) {
  const h = head(2, size), blobs = [];
  for (let i = 0; i < n; i++) {
    const b = new Uint8Array(size).fill(97), v = duplicate ? 0 : (i * 40503) & 65535;
    b[size - 2] = v >>> 8; b[size - 1] = v & 255;
    blobs.push(concat([h, b]));
  }
  return array(blobs);
}
await run('unique-65536-refused', uniqueInput(65536, 15), 'any .unique true');

// Sweep element counts and common prefix lengths under 65,536 encoded bytes.
// Repeated rows obey total input/items/budget limits, not just the per-item cap.
for (const n of [64, 256, 1024, 2047, 4095, 8191, 16383, 21844]) {
  let size = Math.floor((65536 - head(4, n).length) / n) - 1;
  while (n * (size + head(2, size).length) + head(4, n).length > 65536) size--;
  const b = uniqueInput(n, size);
  const copies = Math.min(Math.floor((1500000 - 5) / b.length), Math.floor(131070 / (n + 1)));
  const counters = () => {
    for (const k of Object.keys(counted.counts)) counted.counts[k] = 0;
    const r = counted.uniqueRun(b, 0, b.length, bigMeter(n));
    assert(r >= 0);
    return { ...counted.counts, units: r, scratchBytes: 4 * counted.uniqueWords(b, 0, b.length) };
  };
  const prefix = n === 21844 ? 'extra-' : '';
  await run(`${prefix}unique-${n}-one`, b, 'any .unique true', { elements: n, payloadBytes: size, counters });
  await run(`${prefix}unique-${n}-repeat`, repeat(b, copies), '[* (any .unique true)]',
    { elements: n, payloadBytes: size, copies });
}
await run('unique-duplicates', uniqueInput(4095, 15, true), 'any .unique true');
// Many distinct ranks repeated: duplicates are detected only AFTER sorting.
const ranked = concat([head(4, 65533), Uint8Array.from({ length: 65533 }, (_, i) => (i * 17) % 24)]);
await run('extra-unique-ranked-one', ranked, 'any .unique true',
  { counters: () => {
    for (const k of Object.keys(counted.counts)) counted.counts[k] = 0;
    const r = counted.uniqueRun(ranked, 0, ranked.length, bigMeter(65533));
    assert(r < -1);
    return { ...counted.counts, units: -2 - r, scratchBytes: 4 * counted.uniqueWords(ranked, 0, ranked.length) };
  } });
// Different arguments make different EXT leaves. Every choice must be decided;
// purity/once-per-leaf caching does not memoise the ignored .unique controller.
await run('chain-unique-ranked-35', ranked,
  Array.from({ length: 35 }, (_, i) => `(any .unique ${i})`).join(' / '),
  { variants: 35 });

// samelen: absent names still search the ENTIRE controller array for every key.
// Duplicate controller names are legal. Repeated strings avoid spending schema
// bytes on syntax; same-length keys force deep byte comparisons before mismatch.
for (const [nameLength, names, members, copies] of [[0, 21000, 16400, 3], [8, 21000, 6551, 10], [20, 11300, 2978, 22]]) {
  const name = 'a'.repeat(nameLength), prefix = 'a'.repeat(Math.max(0, nameLength - 4));
  const map = new Map();
  for (let i = 0; i < members; i++) map.set(nameLength ? prefix + i.toString(16).padStart(4, '0') : i, 0);
  const b = encode(map), arg = '[' + Array(names).fill(JSON.stringify(name)).join(',') + ']';
  const encodedArg = encode(Array(names).fill(name));
  assert(b.length <= 65536);
  const counters = () => {
    for (const k of Object.keys(counted.counts)) counted.counts[k] = 0;
    const t = new Int32Array(counted.samelenWords(encodedArg, 0, encodedArg.length));
    assert.equal(counted.samelenPrep(encodedArg, 0, encodedArg.length, t), 0);
    const r = counted.samelenRun(encodedArg, 0, t, b, 0, b.length, bigMeter(0));
    return { ...counted.counts, units: r >= 0 ? r : -2 - r, distinctNames: t[0], argumentBytes: encodedArg.length };
  };
  await run(`samelen-${nameLength}-one`, b, `any .samelen ${arg}`,
    { names, members, nameLength, counters });
  await run(`samelen-${nameLength}-repeat`, repeat(b, copies), `[* (any .samelen ${arg})]`,
    { names, members, nameLength, copies });
}
// Distinct long names (the old duplicates collapse when prepared): every key
// probes ~13 names, each compared over a 40-byte common prefix.
{
  const names = Array.from({ length: 5000 }, (_, i) => 'a'.repeat(40) + i.toString(16).padStart(4, '0'));
  const map = new Map(Array.from({ length: 1300 }, (_, i) => ['a'.repeat(40) + (i * 5).toString(16).padStart(4, '0') + 'x', 0]));
  const b = encode(map), arg = '[' + names.map(n => JSON.stringify(n)).join(',') + ']';
  await run('samelen-distinct-long-one', b, `any .samelen ${arg}`, { names: names.length, members: map.size });
  await run('samelen-distinct-long-repeat', repeat(b, Math.floor(1500000 / b.length) - 1), `[* (any .samelen ${arg})]`,
    { names: names.length, members: map.size });
}

// Ordinary samelen has linear item work when its name list is short.
const columns = encode({ x: Array(32760).fill(0), y: Array(32760).fill(0) });
await run('samelen-two-columns', columns, 'any .samelen ["x", "y"]');

const emptyMaps = repeat(concat([head(4, 65534), new Uint8Array(65534).fill(0xa0)]), 2);
const emptyNames = '[' + Array(21000).fill('""').join(',') + ']';
await run('extra-samelen-empty-131068', emptyMaps, `[* [* (any .samelen ${emptyNames})]]`,
  { names: 21000 });
// Deep values: every head of a skipped value is charged.
const nestedUnique = array(Array.from({ length: 3000 }, (_, i) => array(Array.from({ length: 20 }, (_, j) => Uint8Array.of(j === 0 ? i % 24 : 0)))));
await run('unique-nested-3000x20', nestedUnique, 'any .unique true');
const deepValues = encode({ a: Array(16000).fill([0]), b: Array(16000).fill([0]) });
await run('samelen-deep-values', deepValues, 'any .samelen ["a", "b"]');
report.counterCheck = { ...counted.counts };
report.end = environment();
const outAt = argv.indexOf('--out');
if (outAt >= 0) writeFileSync(argv[outAt + 1], JSON.stringify(report, null, 2) + '\n');
console.table(report.rows.map(({ id, bytes, steps, calls, medianMs, nsPerUnit, verdict }) => ({ id, bytes, steps, calls, medianMs, nsPerUnit, verdict })));
const over = report.rows.filter(r => !r.hostResponsibility && !r.reference && r.medianMs > 50);
const ref = report.rows.find(r => r.reference);
if (ref) {
  const worse = report.rows.filter(r => !r.hostResponsibility && !r.reference && r.steps >= 100000 && r.nsPerUnit > ref.nsPerUnit);
  console.log(`reference: ${ref.medianMs.toFixed(1)} ms for ${ref.steps} units of plain VM work (${ref.nsPerUnit.toFixed(1)} ns/unit) under the current load; ` +
    (worse.length ? `rows dearer per unit than it: ${worse.map(r => r.id).join(', ')}` : 'no EXT row of >= 100k units costs more per unit than it'));
}
console.log(over.length ? `GATE FAIL: ${over.map(r => r.id).join(', ')} over 50 ms` : 'GATE ok: every row other than the undeclared custom predicate is at most 50 ms CPU (or refused by the budget first).');
console.log(JSON.stringify({ end: report.end, counterCheck: report.counterCheck }));
console.log('These are adversarial measured cases, not exhaustive CPU upper bounds. An undeclared custom predicate\'s own CPU is the host\'s responsibility (D193). Rust not timed here. No stream/wasm/browser timing.');
