// P7.2/D085: JS EXT dispatch/generic controls and ordered session drain cost.
// Run a COPY of this script inside a clean HEAD worktree (no installs/builds):
//   node --expose-gc --single-threaded-gc bench/ext-drain-bench.mjs --out <scratch.json>
// --quick: 5 x >=5ms CPU batches; --check-only: fixtures/agreement only.
// Default: >=200ms CPU warm-up per arm, then 11 rotated/interleaved rounds,
// calibrated >=25ms CPU per arm/batch.
// Compilation, byte construction, assertions, counters and memory sampling are
// outside timed loops. Public buffer/push APIs include their usual allocations;
// unlike P6.2 this measures a NEW public session per message, not a pooled VM.
// Memory: separate fresh child per stream cell, GC then sample process.memoryUsage
// at creation/chunk/resume/finalize boundaries; approximate, NOT an exact peak.
import assert from 'node:assert/strict';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { compile } from '../host/js/src/public-compile.mjs';
import { encode } from '../host/js/src/index.mjs';
import { controls } from '../host/js/src/controls.mjs';
import { openSession, pushValidator } from '../host/js/src/public-sources.mjs';

const argv = process.argv.slice(2), quick = argv.includes('--quick');
const checkOnly = argv.includes('--check-only'), memoryAt = argv.indexOf('--memory');
const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);
const rounds = quick ? 5 : 11, targetUs = quick ? 5000 : 25000, warmUs = quick ? 25000 : 200000;
const limits = { inputBytes: 1_500_000, entries: 1 << 24, items: 1 << 24, budget: 0x7fffffff };
const encOpts = { maxEntries: 1 << 24, maxItems: 1 << 24 };
const maxBytes = 1_500_000;
const registry = {
  ...Object.fromEntries(Object.entries(controls).map(([k, c]) => [k, { ...c, maxBytes }])),
  pass: { check: () => true, maxBytes },
  deny: { check: () => false, maxBytes },
};
const makeSchema = text => compile(text, { limits, controls: registry });
const cpu = () => { const u = process.cpuUsage(); return u.user + u.system; };
const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];
const hash = b => createHash('sha256').update(b).digest('hex');
const reason = r => r.ok ? 'ok' : r.reason;
const chunks = [65536, 16384, 1024], modes = ['known', 'drain', 'fast'];
let sink;

function measure(fns) {
  // Warm each arm for >=200ms CPU (25ms quick), then separately calibrate.
  const counts = fns.map(fn => {
    let t = cpu(); do { sink = fn(); } while (cpu() - t < warmUs);
    let n = 1;
    for (;;) {
      t = cpu(); for (let i = 0; i < n; i++) sink = fn();
      const d = cpu() - t;
      if (d >= targetUs || n >= 1 << 22) return n;
      n = Math.min(1 << 22, Math.max(n + 1, Math.ceil(n * targetUs / Math.max(1, d) * 1.1)));
    }
  });
  const samples = fns.map(() => []);
  for (let r = 0; r < rounds; r++) for (let j = 0; j < fns.length; j++) {
    const k = (j + r) % fns.length, fn = fns[k], n = counts[k], t = cpu();
    for (let i = 0; i < n; i++) sink = fn();
    samples[k].push((cpu() - t) / n);
  }
  return samples.map((a, k) => ({ us: median(a), samplesUs: a, iterations: counts[k] }));
}

// Same data for each arm. Extra controls are redundant on these fixtures;
// there is no built-in-only generic uniqueness or code-point-count equivalent.
// Non-ASCII, duplicates, unequal counts and choices have independent assertions.
function extFixtures() {
  const rpc = { method: 'put', args: { name: 'file', tags: ['a', 'b'], x: [0, 1], y: [2, 3], data: new Uint8Array() } };
  let small;
  for (let n = 0; n < 287; n++) {
    rpc.args.data = new Uint8Array(n); const b = encode(rpc);
    if (b.length === 287) { small = b; break; }
  }
  assert(small);
  const args = 'name: tstr, tags: [* tstr], x: [* uint], y: [* uint], data: bstr';
  const base = `{ method: tstr, args: { ${args} } }`;
  const argsBytes = encode(rpc.args).length;
  const texts = Array.from({ length: 4096 }, () => 'a'.repeat(253));
  const textBytes = encode(texts, encOpts), textMap = Object.fromEntries(texts.map((s, i) => [`k${String(i).padStart(4, '0')}`, s]));
  const mapBytes = encode(textMap, encOpts);
  const itemBytes = 4096 * encode(texts[0]).length;
  const blob = i => { const b = new Uint8Array(15).fill(97); b[12] = i >>> 16; b[13] = i >>> 8; b[14] = i; return b; };
  const rows = [
    { id: 'rpc287', bytes: small, arms: [
      ['built-in', base, 0, 0],
      ['pass-root', `(${base}) .pass true`, 1, 287],
      ['chars-name', `{method: tstr, args: {${args.replace('name: tstr', 'name: tstr .chars (0..253)')}}}`, 1, 5],
      ['unique-tags', `{method: tstr, args: {${args.replace('tags: [* tstr]', 'tags: [* tstr] .unique true')}}}`, 1, 5],
      ['samelen-args', `{method: tstr, args: ({${args}} .samelen ["x", "y"])}`, 1, argsBytes],
    ] },
    { id: 'array-text-1MiB', bytes: textBytes, arms: [
      ['built-in', '[* tstr]', 0, 0],
      ['pass-root', '([* tstr]) .pass true', 1, textBytes.length],
      ['pass-item', '[* (tstr .pass true)]', 4096, itemBytes],
      ['chars-item', '[* (tstr .chars (0..253))]', 4096, itemBytes],
    ] },
    { id: 'map-text-1MiB', bytes: mapBytes, arms: [
      ['built-in', '{* tstr => tstr}', 0, 0],
      ['pass-root', '({* tstr => tstr}) .pass true', 1, mapBytes.length],
      ['pass-value', '{* tstr => (tstr .pass true)}', 4096, itemBytes],
      ['chars-value', '{* tstr => (tstr .chars (0..253))}', 4096, itemBytes],
    ] },
  ];
  const columns = encode({ x: Array.from({ length: 32768 }, (_, i) => blob(i)), y: Array.from({ length: 32768 }, (_, i) => blob(i)) }, encOpts);
  rows.push({ id: 'samelen-map-1MiB', bytes: columns, arms: [
    ['built-in', '{x: [* bstr], y: [* bstr]}', 0, 0],
    ['pass-root', '({x: [* bstr], y: [* bstr]}) .pass true', 1, columns.length],
    ['samelen-root', '({x: [* bstr], y: [* bstr]}) .samelen ["x", "y"]', 1, columns.length],
  ] });
  for (const n of [4096, 16384, 65536]) {
    // Odd multiplicative permutation, common 12-byte prefix; 65,536 distinct
    // 15-byte bstrs = 1,048,581 B. Heap-sort must compare deep into each span.
    const bytes = encode(Array.from({ length: n }, (_, i) => blob((i * 40503) & (n - 1))), encOpts);
    rows.push({ id: `unique-${n}`, n, bytes, arms: [
      ['built-in', '[* bstr]', 0, 0],
      ['pass-root', '([* bstr]) .pass true', 1, bytes.length],
      ['unique-root', '([* bstr]) .unique true', 1, bytes.length],
    ] });
  }
  rows.push({ id: 'choice-pass-rpc', bytes: small, arms: [
    ['built-in', `(${base}) / bstr`, 0, 0],
    ['choice-pass', `((${base}) .pass true) / bstr`, 1, 287],
  ] }, { id: 'choice-fallback-rpc', bytes: small, arms: [
    ['built-in', base, 0, 0],
    ['choice-deny-fallback', `((${base}) .deny true) / (${base})`, 1, 287],
  ] });
  return rows;
}

function streamFixtures() {
  // Exact 1,400,000-byte document, substantial live map/array work plus text.
  const value = { records: Array.from({ length: 10000 }, (_, i) => ({ id: i, title: 'record', body: 'x'.repeat(96) })), padding: '' };
  let bytes;
  for (let i = 0; i < 4; i++) {
    bytes = encode(value, encOpts);
    if (bytes.length === 1_400_000) break;
    value.padding = 'x'.repeat(value.padding.length + 1_400_000 - bytes.length);
  }
  assert.equal(bytes.length, 1_400_000);
  const text = 'r = {records: [* {id: uint, title: tstr, body: tstr}], padding: tstr}';
  const early = bytes.slice(); early[1] = 0xff; // first map key: reserved break
  // Locate a named literal, not a payload-derived key, and change its value's major.
  const late = bytes.slice();
  const titleAt = Buffer.from(late).lastIndexOf(Buffer.from([0x65, ...new TextEncoder().encode('title'), 0x66]));
  assert(titleAt > 0); late[titleAt + 6] = 0x46; // tstr -> bstr, same length/content, valid wire
  const truncated = new Uint8Array(1_400_000).fill(0);
  truncated.set([0x9a, 0x00, 0x16, 0x20, 0x10, 0xff]); // 1,450,000 elements; known end proves truncated first
  const trailing = bytes.slice(); trailing[0] = 0x00; // completed scalar then trailing bytes
  return [
    { id: 'valid', bytes, text, opts: {}, expected: 'ok' },
    { id: 'early-wire', bytes: early, text, opts: {}, expected: 'cbor/indefinite' },
    { id: 'late-schema', bytes: late, text, opts: {}, expected: 'type' },
    { id: 'pending-truncation', bytes: truncated, text: 'r = any', opts: {}, expected: 'cbor/truncated' },
    { id: 'limit-after-error', bytes: early, text, opts: { maxBytes: 1_350_000 }, expected: 'cbor/too_large' },
    { id: 'trailing', bytes: trailing, text: 'r = any', opts: {}, expected: 'cbor/trailing' },
  ];
}

function drive(fixture, schema, chunkSize, mode, sample, collect = true) {
  const known = mode === 'known';
  const push = pushValidator(schema, known ? fixture.bytes.length : undefined, 'r', fixture.opts, known ? {} : { failFast: mode === 'fast' });
  let read = 0, result, maxRetained = 0;
  const observe = () => {
    maxRetained = Math.max(maxRetained, push.bytesHeld ?? 0);
    sample?.();
  };
  if (collect) observe();
  for (let offset = 0; offset < fixture.bytes.length; offset += chunkSize) {
    const chunk = fixture.bytes.subarray(offset, offset + chunkSize);
    read += chunk.length;
    let r = push.feed(chunk); if (collect) observe();
    while (r.state === 'yield') { r = push.resume(); if (collect) observe(); }
    if (r.state === 'done' && !known) { result = r.result; break; }
  }
  result ??= push.finalize(); if (collect) observe();
  return { result, read, maxRetained };
}

async function semanticChecks() {
  const probes = [
    ['chars-unicode', 'r = tstr .chars 2', 'é😀', 'ok'],
    ['chars-refuse', 'r = tstr .chars 1', 'é😀', 'control'],
    ['unique-refuse', 'r = [* uint] .unique true', [1, 2, 1], 'control'],
    ['samelen-refuse', 'r = {x: [* uint], y: [* uint]} .samelen ["x", "y"]', {x: [1], y: [1, 2]}, 'control'],
    ['choice-rescue', 'r = (tstr .chars (1..3)) / (tstr .size 10)', '0123456789', 'ok'],
    ['choice-refuse', 'r = (tstr .chars 1) / bstr', 'aa', 'control'],
    ['choice-target-refuse', 'r = (tstr .deny true) / uint', 42, 'ok'],
    ['chars-size', 'r = tstr .chars (0..1500000)', 'a'.repeat(65536), 'control_size', true],
  ];
  let n = 0, targetCalls = 0;
  for (const [id, text, value, expected, defaultMax] of probes) {
    const cs = defaultMax ? controls : registry;
    const schema = await compile(text, { limits, controls: cs });
    const f = { bytes: encode(value), opts: {} }, buffer = schema.validate(f.bytes, 'r');
    assert.equal(reason(buffer), expected, id);
    for (const chunk of chunks) for (const mode of modes) {
      const r = drive(f, schema, chunk, mode).result;
      assert.deepEqual(r, buffer, `${id}/${mode}/${chunk}`); n++;
    }
  }
  const schema = await compile('r = (tstr .probe true) / uint', { limits, controls: { probe: { check: () => { targetCalls++; return true; }, maxBytes } } });
  assert.equal(schema.validate(encode(42), 'r').ok, true);
  assert.equal(targetCalls, 0, 'target mismatch must not call EXT');
  return n;
}

function command(cmd, args) { try { return execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return 'unavailable'; } }
function environment() {
  return { date: new Date().toISOString(), commit: command('git', ['rev-parse', 'HEAD']),
    treeStatus: command('git', ['status', '--short', '--untracked-files=no']),
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, ramBytes: os.totalmem(),
    os: `${os.type()} ${os.release()} ${os.arch()}`, macOS: command('sw_vers', ['-productVersion']),
    node: process.version, v8: process.versions.v8, flags: process.execArgv,
    load: os.loadavg(), freeBytes: os.freemem(), rounds, targetUs, warmUs, timing: 'process.cpuUsage user+system; rotated interleaved CPU batches' };
}

if (memoryAt >= 0) {
  assert.equal(typeof global.gc, 'function', 'memory children require --expose-gc');
  const [id, mode, chunk] = argv.slice(memoryAt + 1);
  let fixtures = streamFixtures(), f = fixtures.find(x => x.id === id);
  assert(f); fixtures = null;
  const schema = await makeSchema(f.text);
  global.gc(); global.gc();
  const high = { ...process.memoryUsage() };
  const sample = () => { const m = process.memoryUsage(); for (const k of Object.keys(high)) high[k] = Math.max(high[k], m[k]); };
  const arrays = openSession(schema, 'r', mode === 'known' ? f.bytes.length : undefined, f.opts).bytesHeld;
  global.gc(); // the size-only session is dead; exclude it from the actual sampled run
  const runBase = process.memoryUsage();
  Object.assign(high, runBase);
  const r = drive(f, schema, Number(chunk), mode, sample);
  console.log(JSON.stringify({ before: runBase, high, delta: Object.fromEntries(Object.keys(high).map(k => [k, high[k] - runBase[k]])),
    sessionArrays: arrays, retainedWindow: mode === 'known' ? null : r.maxRetained, read: r.read, result: r.result }));
} else {
  const report = { environment: environment(), ext: [], drain: [], agreement: { compared: 0, equal: 0, allowed: {}, verdictMismatch: 0, unexpected: 0 } };
  console.log(`# Extension controls and drain mode (P7.2/D085)\n${JSON.stringify(report.environment)}`);
  assert.equal(report.environment.treeStatus, '', 'benchmark requires clean tracked sources');
  report.semanticChecks = await semanticChecks();
  report.extSessionChecks = 0;
  for (const fixture of extFixtures()) {
    const schemas = await Promise.all(fixture.arms.map(a => makeSchema(`r = ${a[1]}`)));
    for (const s of schemas) {
      const buffer = s.validate(fixture.bytes, 'r');
      assert.equal(buffer.ok, true, fixture.id);
      for (const chunk of chunks) for (const mode of modes) {
        assert.deepEqual(drive({bytes: fixture.bytes, opts: {}}, s, chunk, mode).result, buffer, `${fixture.id}/${mode}/${chunk}`);
        report.extSessionChecks++;
      }
    }
    // Separate untimed registry counts: never put stateful counters in timed predicates.
    for (let k = 1; k < schemas.length; k++) {
      let calls = 0, bytes = 0;
      const counted = Object.fromEntries(Object.entries(registry).map(([name, c]) => [name, { ...c, check: (a, b) => { calls++; bytes += b.length; return c.check(a, b); } }]));
      const s = await compile(`r = ${fixture.arms[k][1]}`, { limits, controls: counted });
      assert.equal(s.validate(fixture.bytes, 'r').ok, true);
      assert.equal(calls, fixture.arms[k][2], `${fixture.id}: EXT calls`);
      assert.equal(bytes, fixture.arms[k][3], `${fixture.id}: EXT bytes`);
    }
    const fns = schemas.map(s => () => s.validate(fixture.bytes, 'r'));
    const times = checkOnly ? fns.map(() => ({ us: 0 })) : measure(fns);
    for (let k = 0; k < times.length; k++) {
      const [arm, text, calls, itemBytes] = fixture.arms[k];
      const row = { input: fixture.id, bytes: fixture.bytes.length, sha256: hash(fixture.bytes), n: fixture.n,
        arm, text, calls, itemBytes, ...times[k], deltaUs: times[k].us - times[0].us };
      row.deltaNsPerCall = calls ? row.deltaUs * 1000 / calls : null;
      row.deltaNsPerItemByte = itemBytes ? row.deltaUs * 1000 / itemBytes : null;
      report.ext.push(row);
      console.log(`EXT ${row.input} ${arm}: ${row.us.toFixed(3)} us; delta ${row.deltaUs.toFixed(3)} us; ${calls} calls / ${itemBytes} item B`);
    }
  }
  for (const fixture of streamFixtures()) {
    const schema = await makeSchema(fixture.text), buffer = schema.validate(fixture.bytes, 'r', fixture.opts);
    assert.equal(reason(buffer), fixture.expected, fixture.id);
    const configs = chunks.flatMap(chunk => modes.map(mode => ({ chunk, mode })));
    const checks = configs.map(({ chunk, mode }) => drive(fixture, schema, chunk, mode));
    for (let k = 0; k < configs.length; k++) {
      const { chunk, mode } = configs[k], got = checks[k]; report.agreement.compared++;
      assert.equal(got.result.ok, buffer.ok, `${fixture.id}/${mode}/${chunk}: verdict`);
      if (JSON.stringify(got.result) === JSON.stringify(buffer)) report.agreement.equal++;
      else {
        // D145 allows an earlier refusal only when the buffer would prioritise
        // pending truncation/too_large; never silently bless other differences.
        assert.equal(mode, 'fast'); assert(got.read < fixture.bytes.length);
        assert(['cbor/truncated', 'cbor/too_large'].includes(reason(buffer)));
        const key = `${reason(got.result)} -> ${reason(buffer)}`;
        report.agreement.allowed[key] = (report.agreement.allowed[key] ?? 0) + 1;
      }
      if (mode !== 'fast') assert.deepEqual(got.result, buffer);
    }
    const times = checkOnly ? configs.map(() => ({ us: 0 })) : measure(configs.map(({ chunk, mode }) => () => drive(fixture, schema, chunk, mode, undefined, false)));
    for (let k = 0; k < configs.length; k++) {
      const { chunk, mode } = configs[k], checked = checks[k];
      const fast = checks[configs.findIndex(c => c.chunk === chunk && c.mode === 'fast')];
      const arrays = openSession(schema, 'r', mode === 'known' ? fixture.bytes.length : undefined, fixture.opts).bytesHeld;
      const row = { input: fixture.id, bytes: fixture.bytes.length, sha256: hash(fixture.bytes), text: fixture.text,
        opts: fixture.opts, chunk, mode, result: checked.result, bufferResult: buffer, read: checked.read,
        firstErrorRead: buffer.ok ? null : fast.read, extraRead: buffer.ok ? null : checked.read - fast.read,
        sessionArrays: arrays, retainedWindow: mode === 'known' ? null : checked.maxRetained, ...times[k] };
      // Throughput is delivered bytes / CPU, not full-message bytes for early exits.
      row.mibPerSec = row.us ? checked.read / 1048576 / (row.us / 1e6) : null;
      if (!checkOnly) {
        row.memory = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--single-threaded-gc', script, '--memory', fixture.id, mode, String(chunk)], { cwd: root, encoding: 'utf8' }));
        assert.deepEqual(row.memory.result, row.result); assert.equal(row.memory.read, row.read);
      }
      report.drain.push(row);
      console.log(`STREAM ${row.input} ${mode} ${chunk}: ${row.us.toFixed(3)} us; ${row.mibPerSec?.toFixed(2) ?? 'n/a'} MiB/s; read ${row.read}; extra ${row.extraRead}; ${reason(row.result)}`);
    }
  }
  report.end = { date: new Date().toISOString(), load: os.loadavg(), freeBytes: os.freemem() };
  console.log(`AGREEMENT ${JSON.stringify(report.agreement)}; semantic checks ${report.semanticChecks}`);
  console.log(`END ${JSON.stringify(report.end)}`);
  if (!checkOnly) printSummary(report);
  const outAt = argv.indexOf('--out');
  if (outAt >= 0) { assert(argv[outAt + 1]); writeFileSync(argv[outAt + 1], JSON.stringify(report, null, 2) + '\n'); }
}

function printSummary(report) {
  console.log('\nMedian CPU per validation; delta includes EXT combinators, byte charging and host dispatch.');
  console.log('| input | bytes | arm | CPU us | delta us | delta ns/call | delta ns/item B |');
  console.log('| --- | ---: | --- | ---: | ---: | ---: | ---: |');
  for (const r of report.ext) console.log(`| ${r.input} | ${r.bytes} | ${r.arm} | ${r.us.toFixed(2)} | ${r.deltaUs.toFixed(2)} | ${r.deltaNsPerCall?.toFixed(1) ?? '—'} | ${r.deltaNsPerItemByte?.toFixed(3) ?? '—'} |`);
  console.log('\nOrdered push sessions; CPU includes allocation/copying/finalize; MiB/s uses delivered bytes.');
  console.log('| input | KiB | mode | CPU us | MiB/s | read B | extra B after first error chunk | code | sampled heap/external/RSS delta KiB |');
  console.log('| --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- |');
  for (const r of report.drain) {
    const m = r.memory.delta;
    console.log(`| ${r.input} | ${r.chunk / 1024} | ${r.mode} | ${r.us.toFixed(2)} | ${r.mibPerSec.toFixed(1)} | ${r.read} | ${r.extraRead ?? '—'} | ${reason(r.result)} | ${[m.heapUsed, m.external, m.rss].map(x => (x / 1024).toFixed(0)).join(' / ')} |`);
  }
  console.log(`Agreement: ${report.agreement.equal}/${report.agreement.compared} stream results exactly equal; allowed early-code differences ${JSON.stringify(report.agreement.allowed)}; ${report.extSessionChecks} EXT session comparisons and ${report.semanticChecks} semantic comparisons passed.`);
  console.log('Caveats: shared loaded machine; CPU ratios are local to this run. Built-in/EXT schemas agree on timed fixtures, not on every possible value. ASCII chars fixtures; uniqueness is heap-sort O(n log n) span comparisons (long common prefixes cost more). Extension maxBytes raised to 1,500,000; validation budget/items/entries raised. Memory samples are approximate fresh-process boundary high waters above a GC baseline, not heap snapshots/exact peaks; arrayBuffers is part of external, do not add them. Input/Program memory is already in the baseline. Known push must deliver/finalize all bytes even after early done. First certain error is measured at the delivering chunk boundary; fail-fast already read that whole chunk. No real I/O, network, browser, Rust or wasm is measured.');
}
