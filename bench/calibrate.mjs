// Schedule-2 CPU calibration. Copy this file and calibrate.rs into a clean HEAD
// worktree, then run node --expose-gc --single-threaded-gc bench/calibrate.mjs.
// No emission/install/network. --check-only audits; --quick uses 3 rounds;
// --out PATH saves raw samples. Rust is built offline from that worktree's gen/.
import assert from 'node:assert/strict';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { compile } from '../host/js/src/compile.mjs';
import { encode } from './baseline/cbor-3sln.mjs';
import { encode as hostEncode } from '../host/js/src/index.mjs';
import { vmScratchWords, vmScratchInit, vmValidateX } from '../gen/js/snug/vm/api.mjs';
import { bindControls, controlEntries } from '../host/js/src/ext.mjs';
import { controls } from '../host/js/src/controls.mjs';
import * as kc from '../gen/js/snug/vm/controls.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), quick = args.includes('--quick'), checkOnly = args.includes('--check-only');
const opt = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const budget = Number(opt('--budget', 2_300_000)), rounds = quick ? 3 : 9;
const cmd = (c, a = []) => execFileSync(c, a, { cwd: root, encoding: 'utf8' }).trim();
const cpu = () => { const t = process.threadCpuUsage(); return 1000 * (t.user + t.system); };
const median = a => { const s = [...a].sort((a, b) => a - b); return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2; };
assert.equal(cmd('git', ['status', '--porcelain', '--untracked-files=no']), '', 'Use a clean tracked HEAD worktree');
assert(process.execArgv.includes('--single-threaded-gc'));
const environment = () => ({ utc: new Date().toISOString(), uptime: cmd('uptime'), load: os.loadavg(),
  cpu: os.cpus()[0].model, cores: os.cpus().length, ram: os.totalmem(), os: `${os.type()} ${os.release()} ${os.arch()}`,
  macOS: process.platform === 'darwin' ? cmd('sw_vers', ['-productVersion']) : null,
  node: process.version, v8: process.versions.v8, flags: process.execArgv });
const report = { revision: cmd('git', ['rev-parse', 'HEAD']), start: environment(), budget, rounds,
  rustc: cmd('rustc', ['--version']), rustFlags: ['--edition=2021', '-O', '-Awarnings'],
  rustHarnessSha256: createHash('sha256').update(readFileSync(root + 'bench/calibrate.rs')).digest('hex'), harnessSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  method: 'thread CPU; reused scratch; rotated interleaved rounds, reference bracket per row; setup/bind/IPC excluded', rows: [], runs: [] };
console.log(JSON.stringify({ revision: report.revision, start: report.start }));
const BIG = { budget: 0x7fffffff, items: 1 << 25, entries: 1 << 24, inputBytes: 0x7fffffff };
const enc = v => (v instanceof Map ? hostEncode : encode)(v, { maxEntries: 1 << 24, maxItems: 1 << 25, maxBytes: 1 << 28 });
const registry = { ...controls, pass: { check: () => true, cost: () => 0 },
  declared: { check: (_a, b) => { let h = 0; for (const x of b) h = (Math.imul(h, 33) ^ x) | 0; return h !== 123456789; }, cost: n => n },
  costly: { check: (_a, b) => b.length % 3 !== 0, maxBytes: 1000, cost: n => 3 * n + 5 },
  huge: { check: () => { throw Error('must not be called'); }, cost: () => 1_000_000_000 } };
const rows = [];
function vm(id, schema, value, flags = 0, bytes = false) {
  const b = bytes ? value : enc(value), c = compile(schema, { limits: BIG, controls: registry });
  const p = c.program, pool = c.pool, rule = c.rules.indexOf('r'), s = new Int32Array(vmScratchWords(p, rule, p[16]));
  vmScratchInit(s, p[16]);
  const o = new Int32Array(600), lim = Int32Array.of(1, 0, -1, -1, -1, -1, -1, budget, flags, 122);
  const ext = bindControls(p, pool, controlEntries(registry));
  const call = ext ? ext.call.bind(ext) : () => -2;
  const fn = () => { vmValidateX(p, pool, rule, b, lim, s, o, call); return [o[0], o[3]]; };
  const audit = fn(); assert([0, 48].includes(audit[0]), `${id}: ${audit}`);
  if (id === 'AND' || id === 'NOT') assert(Array.from({ length: p[16] }, (_, i) => p[p[43] + 8 * i] & 255).includes(id === 'AND' ? 16 : 17), id + ': compiler must retain the combinator');
  rows.push({ id, mode: 'vm', b, p, pool, rule, flags, fn, audit, schema });
}
const ints = Array.from({ length: 1_300_000 }, (_, i) => i % 24);
vm('array-fast', 'r = [* uint]', ints);
vm('array-generic-same-charges', 'r = [* uint]', ints, 1);
vm('array-automaton', 'r = [* (uint, tstr, bool, null)]', Array.from({ length: 400000 }, (_, i) => [i, 'x', true, null][i % 4]));
vm('dead-walk', 'r = any', Array(2_400_000).fill(0));
const recs = Array.from({ length: 150000 }, (_, i) => ({ a: i, b: i }));
vm('map-struct', 'r = [* {a: uint, b: uint}]', recs);
vm('map-struct-generic', 'r = [* {a: uint, b: uint}]', recs, 1);
vm('map-table', 'r = [* {* tstr => uint}]', recs);
vm('map-table-generic', 'r = [* {* tstr => uint}]', recs, 1);
const six = ['r = [* msg]', 'msg = a / b / c / d / e / f', ...'abcdef'.split('').map(k => `${k} = {kind: "${k}", v: ${{ a: 'uint', b: 'tstr', c: 'bool', d: '[* int]', e: '{* tstr => int}', f: 'bstr' }[k]}}`)].join('\n');
vm('reference-map-choice', six, Array.from({ length: 24000 }, (_, i) => ({ kind: 'a', v: i })));
// program-2 (P8.5): the PEG tiers -- an A1 group choice, an A2 backtracking REP, an S
// group choice in a map, T records, and the T sort over EC-sensitive keys
vm('array-A1-choice', 'r = [* ((uint, tstr) // (uint, uint, tstr))]', Array.from({ length: 300000 }, (_, i) => [i, i, 'x'][i % 3]));
vm('array-A2', 'r = [* (* uint, tstr)]', Array.from({ length: 400000 }, (_, i) => i % 4 === 3 ? 'x' : i));
vm('map-S-choice', 'r = [* {("a" => uint, "b" => tstr) // ("a" => tstr, "b" => uint)}]', Array.from({ length: 100000 }, () => ({ a: 'x', b: 1 })));
vm('map-T-choice', 'r = [* {* (tstr => uint // tstr => tstr)}]', recs);
vm('map-T-sort', 'r = {* (any => uint // any => tstr)}', new Map(Array.from({ length: 60000 }, (_, i) => [[i, 0.0], i])));
vm('scalar-leaves', 'r = [* (bool / null / uint / nint / tstr)]', Array(150000).fill(true));
vm('text-ascii', 'r = tstr', 'a'.repeat(1_400_000));
vm('literal-long-compare', 'r = [* ' + JSON.stringify('a'.repeat(100000)) + ']', Array(14).fill('a'.repeat(100000)));
vm('text-utf8', 'r = tstr', 'é'.repeat(700000));
vm('bytes-bits-scan', 'r = bstr .bits (0..7)', new Uint8Array(1_400_000));
vm('bytes-bits-rescan', 'r = ' + Array.from({ length: 128 }, (_, i) => `(bstr .bits (0..${i + 1}))`).join(' / '), new Uint8Array(1_400_000));
vm('regexp', 'r = tstr .regexp "(a|b|ab|ba)*c"', 'ab'.repeat(220000) + 'c');
const keys = Array.from({ length: 200 }, (_, i) => `k${i.toString().padStart(3, '0')}`);
vm('key-binary-search', 'r = [* {' + keys.map(k => `? ${k}: uint`).join(',') + '}]', Array.from({ length: 6500 }, () => Object.fromEntries(keys.map(k => [k, 0]))));
const longKeys = Array.from({ length: 100 }, (_, i) => 'a'.repeat(496) + i.toString().padStart(4, '0'));
vm('key-long-prefix-search', 'r = [* {' + longKeys.map(k => `? ${JSON.stringify(k)}: uint`).join(',') + '}]', Array.from({ length: 28 }, () => Object.fromEntries(longKeys.map(k => [k, 0]))));
vm('AND', 'r = [* ((tstr .regexp "a+") .and (tstr .regexp "[a-z]+"))]', Array(200000).fill('aaa'));
vm('NOT', 'r = [* (tstr .ne "b")]', Array(200000).fill('a'));
vm('embedded', 'r = [* (bstr .cbor [* uint])]', Array(150000).fill(enc([0, 1, 2, 3])));
vm('EXT_CALL', 'r = [* (uint .pass true)]', Array(150000).fill(0));
vm('custom-declared-byte', 'r = [* (bstr .declared true)]', Array(64).fill(new Uint8Array(65530).fill(1)));
vm('custom-declared-3n+5', 'r = [* (uint .costly true)]', Array(150000).fill(0));
vm('custom-declared-refused', 'r = any .huge true', 0);

// Untimed tick attribution only: instrument an in-memory copy, never the timed
// module or generated files. The sum is checked against the real meter.
let countedSource = readFileSync(new URL('../gen/js/snug/vm/controls.mjs', import.meta.url), 'utf8');
countedSource = countedSource.replace("'../cbor/tags.mjs'", JSON.stringify(new URL('../gen/js/snug/cbor/tags.mjs', import.meta.url).href));
for (const [expr, label] of [['T_HEAD','heads'],['T_ELEM','elements'],['T_CMP','comparisons'],['T_PROBE','probes'],['T_PAIR','pairs'],['C_TICKS','byteChunks'],['C_FIRST','firstChunks'],['u * TPU','chars'],['hticks(y - x)','hash']]) {
  assert(countedSource.includes(`spend(m, ${expr})`), label + ': attribution anchor');
  countedSource = countedSource.replaceAll(`spend(m, ${expr})`, `countedSpend(m, ${expr}, '${label}')`);
}
countedSource += "\nexport const ticks = {}; function countedSpend(m,t,label) { const ok=spend(m,t); if(ok) ticks[label]=(ticks[label]??0)+t; return ok; }";
const counted = await import('data:text/javascript;base64,' + Buffer.from(countedSource).toString('base64'));

// Primitive control runs use the real generated functions and meter. Several
// calls share a fixed large budget; a failed spend leaves unused units, which
// are excluded from the denominator. No profile walk or EXT dispatch is timed.
function micro(id, op, b, a = enc(true), seed = []) {
  const m = new Int32Array(Math.max(kc.uniqueWords(b, 0, b.length), seed.length + 2)), t = new Int32Array(op === 'chars' ? 2 : kc.samelenWords(a, 0, a.length));
  if (op === 'chars') assert.equal(kc.charsPrep(a, 0, a.length, t), 0);
  if (op === 'samelen' || op === 'named') assert.equal(kc.samelenPrep(a, 0, a.length, t), 0);
  const makeStep = kc => op === 'chars' ? () => kc.charsRun(t, b, 0, b.length, m)
    : op === 'unique' ? () => kc.uniqueRun(b, 0, b.length, m)
    : op === 'samelen' ? () => kc.samelenRun(a, 0, t, b, 0, b.length, m)
    : op === 'heads' ? () => kc.mskip(b, 0, b.length, m)
    : op === 'compare' ? () => kc.recCmp(b, m, 0, 1)
    : op === 'bytes' ? () => kc.mcmp(b, 0, b.length, a, 0, a.length, m)
    : () => kc.named(a, 0, t, b, 0, b.length, m);
  const step = makeStep(kc);
  const stop = op === 'heads' ? -2 : ['compare', 'bytes'].includes(op) ? kc.BIG : -1;
  const fn = () => {
    kc.meterInit(m, budget); m.set(seed, 2);
    let r, calls = 0;
    do { r = step(); calls++; } while (r !== stop && calls < 10000000);
    assert(calls < 10000000, `${id}: did not exhaust`);
    return [r, Math.ceil(m[0] / kc.TPU)];
  };
  const audit = fn(), countedStep = makeStep(counted);
  kc.meterInit(m, budget); m.set(seed, 2);
  for (const key of Object.keys(counted.ticks)) delete counted.ticks[key];
  let result; do { result = countedStep(); } while (result !== stop);
  assert.deepEqual([result, Math.ceil(m[0] / 8)], audit, id + ': instrumented == original');
  assert.equal(Object.values(counted.ticks).reduce((a,b) => a+b,0), m[0]);
  rows.push({ id, mode: op, b, pool: a, seed, fn, audit, ticks: { ...counted.ticks } });
}
micro('chars-ascii-work', 'chars', enc('a'.repeat(65530)), enc([0, 65536]));
micro('chars-utf8-work', 'chars', enc('é'.repeat(32765)), enc([0, 65536]));
micro('unique-heads', 'heads', enc(Array(60000).fill([0])));
micro('unique-hash', 'unique', enc([new Uint8Array(65520).fill(97)]));
micro('unique-record-element', 'unique', enc([0]));
micro('unique-sort', 'unique', enc(Array.from({ length: 16000 }, (_, i) => i)));
micro('unique-record-compare', 'compare', enc([0, 1]), enc(true), [1, 1, 0, 2, 1, 1]);
// Actual same-hash unequal FNV encodings: a deterministic birthday search.
function collision() {
  const prefix = new Uint8Array(32750).fill(97), seen = new Map();
  prefix.set([0x59, 0x7f, 0xef]); // bstr head: 32,751 content bytes, then four-byte suffix
  const h0 = (() => { let h = 0x811c9dc5; for (const x of prefix) h = Math.imul(h ^ x, 16777619); return h; })();
  let state = 0x718abc39;
  for (let i = 0; i < 400000; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const n = state >>> 0, suffix = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    let h = h0; for (const x of suffix) h = Math.imul(h ^ x, 16777619);
    if (seen.has(h) && seen.get(h) !== n) {
      const other = seen.get(h), x = new Uint8Array(prefix.length + 4), y = new Uint8Array(x.length);
      x.set(prefix); y.set(prefix); x.set(suffix, prefix.length);
      y.set([other >>> 24, (other >>> 16) & 255, (other >>> 8) & 255, other & 255], prefix.length);
      return { b: Buffer.concat([x, y]), seed: [0, x.length, h, x.length, x.length, h] };
    }
    seen.set(h, n);
  }
  throw Error('collision search failed');
}
const coll = collision();
micro('unique-collision-byte-compare', 'compare', coll.b, enc(true), coll.seed);
micro('byte-chunk-compare', 'bytes', new Uint8Array(65530).fill(97), new Uint8Array(65530).fill(97));
micro('samelen-pass', 'samelen', enc(new Map(Array.from({ length: 16000 }, (_, i) => [i, 0]))), enc([]));
micro('samelen-short-probes', 'named', enc('k199x'), enc(keys));
micro('samelen-long-probes', 'named', enc('a'.repeat(120) + 'k198'), enc(keys.map(k => 'a'.repeat(120) + k)));
// End-to-end EXT checks keep the profile and dispatch overhead in view.
vm('EXT-chars', 'r = [* (tstr .chars (0..65536))]', Array(22).fill('é'.repeat(32765)));
vm('EXT-unique', 'r = [* (any .unique true)]', Array(20).fill(Array.from({ length: 16000 }, (_, i) => i)));
vm('EXT-samelen', 'r = [* (any .samelen ["x", "y"])]', Array(32).fill({ x: Array(16000).fill(0), y: Array(16000).fill(0) }));

// Build a measurement-only Rust binary in scratch. The VM test binary has no
// timing/repetition command and reparses input/prepares controls per case.
mkdirSync(new URL('../.cache/calibrate-host/', import.meta.url), { recursive: true });
const host = '.cache/calibrate-host', crate = '.cache/calibrate-rs';
writeFileSync(root + host + '/lib.rs', 'pub mod snug;\n');
cmd('sh', ['kin/scripts/rust-crate', crate, host]);
copyFileSync(root + 'bench/calibrate.rs', root + crate + '/src/main.rs');
copyFileSync(root + 'host/rust/src/controls.rs', root + crate + '/src/controls.rs');
cmd('rustc', ['--edition=2021', '-O', '-Awarnings', crate + '/src/main.rs', '-o', crate + '/calibrate']);
const child = spawn(root + crate + '/calibrate', [], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = [], lines = createInterface({ input: child.stdout });
let childFailure;
lines.on('line', line => { const p = pending.shift(); if (p) p.resolve(JSON.parse(line)); });
child.on('exit', code => { if (code) { childFailure = Error(`Rust exited ${code}`); for (const p of pending.splice(0)) p.reject(childFailure); } });
const request = line => new Promise((resolve, reject) => { if (childFailure) return reject(childFailure); pending.push({ resolve, reject }); child.stdin.write(line + '\n'); });
const hex = b => b.length ? Buffer.from(b).toString('hex') : '-';
try {
  for (const row of rows) {
    const idx = rows.indexOf(row);
    const r = await request(['add', row.mode, budget, row.rule ?? 0, row.flags ?? 0, row.p?.join(',') || '-', hex(row.pool), hex(row.b), row.seed?.join(',') || '-'].join(' '));
    assert.deepEqual(r, row.audit, row.id + ': JS/Rust code and units');
    Object.assign(row, { index: idx, samples: { js: [], rust: [] }, ratios: { js: [], rust: [] } });
    report.rows.push({ id: row.id, mode: row.mode, schema: row.schema, bytes: row.b.length, sha256: createHash('sha256').update(row.b).digest('hex'), code: r[0], units: r[1], ticks: row.ticks, samples: row.samples, referenceRatios: row.ratios });
  }
  console.log(`Audited ${rows.length} rows: JS == Rust codes and charged units.`);
  if (!checkOnly) {
    report.loadWait = [];
    const until = Date.now() + Number(opt('--wait-load-seconds', 0)) * 1000;
    while (os.loadavg()[0] >= 2 && Date.now() < until) {
      const sample = { utc: new Date().toISOString(), uptime: cmd('uptime'), load: os.loadavg() };
      report.loadWait.push(sample); console.log('Waiting for load < 2: ' + sample.uptime);
      await new Promise(resolve => setTimeout(resolve, Math.min(15000, until - Date.now())));
    }
    report.timingStart = environment();
    const ref = rows.find(r => r.id === 'reference-map-choice');
    const counts = { js: [], rust: [] };
    function batch(row, n) { const t = cpu(); let r; for (let i = 0; i < n; i++) r = row.fn(); const ns = (cpu() - t) / n; assert.deepEqual(r, row.audit); return ns; }
    // Warm each engine for >= 60ms CPU per row; then choose >= 20ms batches.
    for (const row of rows) {
      let elapsed = 0, n = 1;
      while (elapsed < 60000000) { const t = batch(row, n); elapsed += t * n; n = Math.min(100000, Math.max(1, Math.ceil(22000000 / Math.max(1, t)))); }
      counts.js[row.index] = n;
      const r = await request(`warm ${row.index}`); counts.rust[row.index] = r;
    }
    console.log(`Warm-up complete. Load: ${cmd('uptime')}`);
    for (let round = 0; round < rounds; round++) {
      const order = rows.map((_, i) => rows[(i + round * 7) % rows.length]);
      for (const row of order) for (const engine of round % 2 ? ['rust', 'js'] : ['js', 'rust']) {
        const uptime = cmd('uptime'), load = os.loadavg();
        const measure = async r => engine === 'js' ? batch(r, counts.js[r.index]) : await request(`time ${r.index} ${counts.rust[r.index]}`);
        const before = await measure(ref), ns = await measure(row), after = await measure(ref);
        const refNs = (before + after) / 2 / ref.audit[1], perUnit = ns / row.audit[1];
        row.samples[engine].push(perUnit); row.ratios[engine].push(perUnit / refNs);
        report.runs.push({ round, id: row.id, engine, uptime, load, ns, units: row.audit[1], referenceNsPerUnit: refNs, iterations: counts[engine][row.index] });
      }
      console.log(`Round ${round + 1}/${rounds}: ${cmd('uptime')}`);
    }
    for (const engine of ['js', 'rust']) {
      // Median kind excludes the deliberately uncalled arbitrary-cost predicate.
      const mid = median(rows.filter(r => r.id !== 'custom-declared-refused').map(r => median(r.samples[engine])));
      report[engine + 'MedianKind'] = mid;
      for (const row of report.rows) { row[engine] = median(row.samples[engine]); row[engine + 'Ratio'] = row[engine] / mid; row[engine + 'ReferenceRatio'] = median(row.referenceRatios[engine]); }
    }
  }
} finally { child.stdin.end(); }
report.end = environment();
if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify(report, null, 2) + '\n');
console.table(report.rows.map(r => ({ kind: r.id, units: r.units, JS: r.js?.toFixed(2), 'JS/median': r.jsRatio?.toFixed(2), Rust: r.rust?.toFixed(2), 'Rust/median': r.rustRatio?.toFixed(2) })));
