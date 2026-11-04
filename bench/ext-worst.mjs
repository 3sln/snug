// Default-limit EXT adversaries. Copy this file into a clean HEAD worktree:
// node --expose-gc --single-threaded-gc bench/ext-worst.mjs --out ../ext-worst.json
// --quick: three rounds; --check-only: admission/charging/counter checks only.
// --only <id-substring>: run a subset (including for supplementary measurements).
// Long samelen rows take seconds per call; they use three single-call samples.
// Timed calls use default limits/registry maxima and the original predicates.
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
import { uniqueWords } from '../gen/js/snug/vm/controls.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2), quick = argv.includes('--quick');
const checkOnly = argv.includes('--check-only');
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
assert.equal(command('git', ['status', '--porcelain', '--untracked-files=no']), '',
  'Run a copy in a clean worktree: concurrent tracked edits invalidate this benchmark');
assert.equal(typeof process.threadCpuUsage, 'function');
assert(process.execArgv.includes('--single-threaded-gc'), 'Use --single-threaded-gc');
assert(controlEntries(controls).every(c => c.maxBytes === 65536));
const report = { revision, start: environment(), method: 'threadCpuUsage user+system; public buffer validate; medians; compilation/construction/counters excluded', rows: [] };
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

// Generated kin, instrumented ONLY in an in-memory untimed copy. Count actual
// comparator invocations and compared byte pairs, not n*log(n) estimates.
let source = readFileSync(new URL('../gen/js/snug/vm/controls.mjs', import.meta.url), 'utf8');
function replaceOnce(from, to) {
  assert.equal(source.split(from).length, 2, `instrumentation anchor: ${from}`);
  source = source.replace(from, to);
}
replaceOnce("'../cbor/tags.mjs'", JSON.stringify(new URL('../gen/js/snug/cbor/tags.mjs', import.meta.url).href));
replaceOnce('export function spanCmp(b, t, x, y) {', 'export function spanCmp(b, t, x, y) { counts.sortComparisons++;');
replaceOnce('const c = b[xs + i];', 'counts.sortBytePairs++; const c = b[xs + i];');
replaceOnce('export function spanEq(x, xs, xe, y, ys, ye) {', 'export function spanEq(x, xs, xe, y, ys, ye) { counts.nameComparisons++;');
replaceOnce('if (x[xs + i] !== y[ys + i]) {', 'counts.nameBytePairs++; if (x[xs + i] !== y[ys + i]) {');
source += '\nexport const counts = {sortComparisons:0, sortBytePairs:0, nameComparisons:0, nameBytePairs:0};';
const counted = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

const pass = () => true;
// Finite, pure example: even a one-byte item can request arbitrarily much
// computation. This fixed 100M-iteration example does not establish an upper bound.
const slow = (_a, b) => {
  let x = b[0]; for (let i = 0; i < 100_000_000; i++) x = (Math.imul(x ^ i, 16777619) + 1) | 0;
  return x !== 0;
};
const registry = { ...controls, pass, slow };
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

async function run(id, bytes, text, { expected = 'ok', predicateResult = true, slowRow = false, counters, ...details } = {}) {
  if (!id.includes(only)) return;
  assert(bytes.length <= 1500000);
  const s = await schema(text), p = schemaPrograms.get(s), rid = p.ruleIndex('r');
  // Untimed dispatch/charging audit substitutes constant verdicts for expensive
  // predicates. Timed calls below use the original generic/custom predicates.
  const original = p.ext.call; let calls = 0, itemBytes = 0, maxItem = 0;
  p.ext.call = (_id, _pool, _ao, _al, _b, lo, hi) => {
    calls++; itemBytes += hi - lo; maxItem = Math.max(maxItem, hi - lo); return predicateResult;
  };
  let audit;
  try { audit = p.run(rid, bytes, {}); } finally { p.ext.call = original; }
  assert.equal(reason(p.result(audit)), expected, id + ': charged-path verdict');
  assert(maxItem <= 65536, id + ': no oversized callback');
  const row = { id, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    schema: text, verdict: expected, steps: audit[3], items: audit[4], calls, itemBytes,
    extCharge: calls + itemBytes, maxItem, ...details };
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
    Object.assign(row, { medianMs: median(samplesUs) / 1000, samplesUs, iterations: n, rounds });
  }
  row.load = os.loadavg(); report.rows.push(row);
  console.log(JSON.stringify(row));
}

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
  '[* [* (uint .pass true)]]', { expected: 'budget' });
await run('extra-chars-tiny-131068', repeat(concat([head(4, 65534), new Uint8Array(65534).fill(0x60)]), 2),
  '[* [* (tstr .chars 0)]]', { expected: 'budget' });
await run('extra-chars-tiny-65536', concat([head(4, 65536), new Uint8Array(65536).fill(0x60)]),
  '[* (tstr .chars 0)]');
await run('slow-one-byte', Uint8Array.of(0), 'any .slow true', { slowRow: true });

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
await run('unique-65536-refused', uniqueInput(65536, 15), 'any .unique true',
  { expected: 'control_size' });

// Sweep element counts and common prefix lengths under 65,536 encoded bytes.
// Repeated rows obey total input/items/budget limits, not just the per-item cap.
for (const n of [64, 256, 1024, 2047, 4095, 8191, 16383, 21844]) {
  let size = Math.floor((65536 - head(4, n).length) / n) - 1;
  while (n * (size + head(2, size).length) + head(4, n).length > 65536) size--;
  const b = uniqueInput(n, size);
  const copies = Math.min(Math.floor((1500000 - 5) / b.length), Math.floor(131070 / (n + 1)));
  const counters = () => {
    for (const k of Object.keys(counted.counts)) counted.counts[k] = 0;
    assert.equal(counted.uniqueOk(b, 0, b.length, new Int32Array(uniqueWords(b.length))), true);
    return { ...counted.counts, scratchBytes: 4 * uniqueWords(b.length) };
  };
  const prefix = n === 21844 ? 'extra-' : '';
  await run(`${prefix}unique-${n}-one`, b, 'any .unique true', { elements: n, payloadBytes: size, counters });
  await run(`${prefix}unique-${n}-repeat`, repeat(b, copies), '[* (any .unique true)]',
    { elements: n, payloadBytes: size, copies });
}
await run('unique-duplicates', uniqueInput(4095, 15, true), 'any .unique true',
  { expected: 'control', predicateResult: false });
// Many distinct ranks repeated: duplicates are detected only AFTER sorting.
const ranked = concat([head(4, 65533), Uint8Array.from({ length: 65533 }, (_, i) => (i * 17) % 24)]);
await run('extra-unique-ranked-one', ranked, 'any .unique true',
  { expected: 'control', predicateResult: false, counters: () => {
    for (const k of Object.keys(counted.counts)) counted.counts[k] = 0;
    assert.equal(counted.uniqueOk(ranked, 0, ranked.length, new Int32Array(uniqueWords(ranked.length))), false);
    return { ...counted.counts, scratchBytes: 4 * uniqueWords(ranked.length) };
  } });
// Different arguments make different EXT leaves. Every choice must be decided;
// purity/once-per-leaf caching does not memoise the ignored .unique controller.
await run('chain-unique-ranked-35', ranked,
  Array.from({ length: 35 }, (_, i) => `(any .unique ${i})`).join(' / '),
  { expected: 'budget', predicateResult: false, slowRow: true, variants: 35 });

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
  const counters = () => ({ nameComparisons: names * members,
    // Same encoded lengths/prefix; every key mismatches at the first hex digit.
    nameBytePairs: nameLength ? names * members * (1 + prefix.length + 1) : names * 24,
    argumentBytes: encodedArg.length, formula: true });
  await run(`samelen-${nameLength}-one`, b, `any .samelen ${arg}`,
    { slowRow: true, names, members, nameLength, counters });
  await run(`samelen-${nameLength}-repeat`, repeat(b, copies), `[* (any .samelen ${arg})]`,
    { slowRow: true, names, members, nameLength, copies });
}

// Ordinary samelen has linear item work when its name list is short.
const columns = encode({ x: Array(32760).fill(0), y: Array(32760).fill(0) });
await run('samelen-two-columns', columns, 'any .samelen ["x", "y"]');

const emptyMaps = repeat(concat([head(4, 65534), new Uint8Array(65534).fill(0xa0)]), 2);
const emptyNames = '[' + Array(21000).fill('""').join(',') + ']';
await run('extra-samelen-empty-131068', emptyMaps, `[* [* (any .samelen ${emptyNames})]]`,
  { expected: 'budget', slowRow: true, names: 21000,
    argumentHeadVisitsPerCall: 42001 });

// Validate counter formulas against the generated predicate on a small map.
const smallMap = encode(new Map([['aaaa0000', 0], ['aaaa0001', 0]]));
const smallArg = encode(Array(3).fill('aaaaaaaa'));
for (const k of Object.keys(counted.counts)) counted.counts[k] = 0;
assert(counted.samelenOk(smallArg, 0, smallArg.length, smallMap, 0, smallMap.length));
assert.equal(counted.counts.nameComparisons, 6);
assert.equal(counted.counts.nameBytePairs, 36);
report.counterCheck = { ...counted.counts };
report.end = environment();
const outAt = argv.indexOf('--out');
if (outAt >= 0) writeFileSync(argv[outAt + 1], JSON.stringify(report, null, 2) + '\n');
console.table(report.rows.map(({ id, bytes, steps, calls, medianMs, verdict }) => ({ id, bytes, steps, calls, medianMs, verdict })));
console.log(JSON.stringify({ end: report.end, counterCheck: report.counterCheck }));
console.log('Verdict: these are adversarial measured lower bounds, not exhaustive CPU upper bounds. Generic samelen/unique work is not proportional to EXT byte charging; arbitrary custom predicates have no CPU bound. Rust source inspected, not timed. No stream/wasm/browser timing.');
