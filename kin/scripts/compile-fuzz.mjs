// bb compile-fuzz: seeded random and mutated CDDL through the compiler on JS
// and Rust.
//
//     node kin/scripts/compile-fuzz.mjs <rust-compile-test-binary> [cases] [seed]
//
// Texts: (a) corpus schemas mutated at the byte and token level, (b) schemas
// from a small random CDDL grammar (rules, generics, sockets, maps with
// occurrences, cuts and choices, arrays, controls, ranges, literals of every
// kind, regexps), (c) hostile shapes (deep nesting, long rule chains, huge
// occurrences, many choices, instantiation bombs), each under random small
// limits some of the time. Gates:
//   * JS throws nothing but SchemaError, Rust never panics (debug build);
//   * no compile answers `internal` (a compiler bug caught by a checked access);
//   * JS and Rust agree exactly (Program words and pool, or error fields);
//   * every compiled Program passes vm-verify;
//   * every compile stays inside the compile budget: it ends (with
//     `limit_compile_budget` at worst) and takes < 2 s of wall time on JS.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compile, SchemaError, COMPILE_OPTIONS } from '../../host/js/src/compile.mjs';
import { vmVerify } from '../../gen/js/snug/program/verify.mjs';

const [rustBin, nArg, seedArg] = process.argv.slice(2);
const N = Number(nArg ?? 3000), SEED = Number(seedArg ?? 0x5eed);
const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
let s = SEED >>> 0 || 1;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const ri = n => Math.floor(rnd() * n), pick = a => a[ri(a.length)], chance = p => rnd() < p;

// ---------------------------------------------------------------- seeds
const seeds = [];
for (const f of ['study', 'adversarial', 'audit-2026-11-04']) for (const x of JSON.parse(read(`corpus/conformance/${f}.json`)).suites) if (x.cddl) seeds.push(x.cddl);
for (const f of readdirSync(new URL('corpus/cddl-study/contracts/', root))) seeds.push(read('corpus/cddl-study/contracts/' + f));

// ---------------------------------------------------------------- a random grammar
const NAMES = ['a', 'b', 'c', 'r', 'g', 't', 'item', 'key', 'kind', 'x1', 'my-type', 'v.2'];
const PRE = ['int', 'uint', 'nint', 'tstr', 'bstr', 'text', 'bytes', 'bool', 'null', 'any', 'float', 'float16',
  'float32', 'float64', 'number', 'integer', 'unsigned', 'biguint', 'bignint', 'decfrac', 'tdate', 'uri', 'true', 'false'];
const CTLS = ['.size', '.bits', '.lt', '.le', '.gt', '.ge', '.eq', '.ne', '.and', '.within', '.regexp', '.cbor', '.cborseq',
  '.default', '.feature', '.cat', '.pcre', '.abnf', '.bogus'];
const REGEX = ['[a-z-[aeiou]]+', '[\\i-[:_]]\\c*', '\\s\\S', '[^a-z-[0-9]]', '[a-z]+', '(ab|c){1,3}', '[^x]?', 'a.b', '[0-9]{2,4}-x', '\\\\.', '(a|)', 'x{0}', '[a-z][a-z0-9-]{0,20}', '\\\\w', '[😀-🙏]'];
function lit() {
  switch (ri(9)) {
    case 0: return String(ri(300));
    case 1: return '-' + ri(100);
    case 2: return pick(['0x1f', '0b101', '18446744073709551616', '-18446744073709551617', '340282366920938463463374607431768211455']);
    case 3: return pick(['1.5', '-0.25', '1e-3', '0.0', '65504.0', '1e400', '0x1.8p0', '1.234567890123456789']);
    case 4: return JSON.stringify(pick(['a', 'kind', '', 'é', '水', 'x y']));
    case 5: return pick(["h'00ff'", "b64'AQI='", "'ab'", "h'0 1'"]);
    case 6: return '"\\u00e9\\u{1F600}"';
    default: return String(ri(10));
  }
}
function type(d, gen) {
  if (d > 4) return pick(PRE);
  const t1 = () => type1(d + 1, gen);
  const n = chance(0.25) ? 2 + ri(3) : 1;
  return Array.from({ length: n }, t1).join(' / ');
}
function type1(d, gen) {
  const base = type2(d, gen);
  if (chance(0.15)) return `${base} ${pick(['..', '...'])} ${pick([lit(), String(ri(50))])}`;
  if (chance(0.2)) {
    const c = pick(CTLS);
    const arg = c === '.regexp' ? JSON.stringify(pick(REGEX)) : c === '.cbor' || c === '.cborseq' ? type2(d + 1, gen) : pick([lit(), `(${ri(5)}..${ri(40)})`, type2(d + 1, gen)]);
    return `${base} ${c} ${arg}`;
  }
  return base;
}
function type2(d, gen) {
  switch (ri(d > 3 ? 4 : 13)) {
    case 0: return pick(PRE);
    case 1: return lit();
    case 2: return pick(NAMES) + (gen && chance(0.3) ? `<${type1(d + 1, gen)}>` : '');
    case 3: return pick(['#', '#0', '#1', '#2', '#3', '#4', '#5', '#6', '#7', '#7.25', '#7.20', '#6.1(tstr)', '#6.<69..70>(bstr)', '#6.2(bstr)', '#8']);
    case 4: case 5: return `{ ${group(d + 1, gen, true)} }`;
    case 6: case 7: return `[ ${group(d + 1, gen, false)} ]`;
    case 8: return `(${type(d + 1, gen)})`;
    case 9: return `~${pick(NAMES)}`;
    case 10: return `&(${group(d + 1, gen, true)})`;
    case 11: return '$' + pick(NAMES);
    default: return `&${pick(NAMES)}`;
  }
}
function occur() { return pick(['', '', '', '?', '*', '+', '1*3', '2*2', '0*0', '*5', '3*', '0*1048576', '2*1']); }
function entry(d, gen, map) {
  const o = occur();
  const sp = o ? ' ' : '';
  if (d > 4) return `${o}${sp}${pick(NAMES)}: ${pick(PRE)}`;
  switch (ri(map ? 7 : 6)) {
    case 0: return `${o}${sp}${pick(NAMES)}: ${type(d + 1, gen)}`;
    case 1: return `${o}${sp}${lit()}: ${type(d + 1, gen)}`;
    case 2: return `${o}${sp}${type1(d + 1, gen)} ${chance(0.2) ? '^ ' : ''}=> ${type(d + 1, gen)}`;
    case 3: return `${o}${sp}(${group(d + 1, gen, map)})`;
    case 4: return `${o}${sp}${pick(NAMES)}`;
    case 5: return `${o}${sp}$$${pick(NAMES)}`;
    default: return `${o}${sp}${type(d + 1, gen)}`;
  }
}
function group(d, gen, map) {
  const nch = chance(0.2) ? 2 + ri(2) : 1;
  const choices = [];
  for (let c = 0; c < nch; c++) {
    const n = ri(d > 3 ? 2 : 5);
    choices.push(Array.from({ length: n }, () => entry(d, gen, map)).join(pick([', ', ' ', ',\n  '])));
  }
  return choices.join(' // ');
}
function schema() {
  const n = 1 + ri(6), out = [];
  for (let i = 0; i < n; i++) {
    const nm = i === 0 ? 'r' : pick(NAMES);
    const gen = chance(0.15);
    const params = gen ? `<${pick(['T', 'T, U'])}>` : '';
    const assign = pick(['=', '=', '=', '/=', '//=']);
    const body = assign === '//=' || chance(0.15) ? `(${group(1, gen, true)})` : type(0, gen);
    out.push(`${chance(0.1) ? '$' : ''}${nm}${params} ${assign} ${body}`);
  }
  return out.join(chance(0.5) ? '\n' : ' ;c\n');
}

// A well-formed generator: types t0..t3 and groups g0..g2 are always defined,
// so most texts get past name resolution and exercise lowering.
const TN = ['t0', 't1', 't2', 't3'], GN = ['g0', 'g1', 'g2'];
function wtype(d) {
  const n = chance(0.3) ? 2 : 1;
  return Array.from({ length: n }, () => wtype1(d)).join(' / ');
}
function wtype1(d) {
  if (d > 3) return pick([...PRE, ...TN]);
  switch (ri(11)) {
    case 0: case 1: return pick(PRE);
    case 2: return pick(TN);
    case 3: return `{ ${wgroup(d + 1, true)} }`;
    case 4: return `[ ${wgroup(d + 1, false)} ]`;
    case 5: return `${pick(['uint', 'int', '0..100', 'integer'])} ${pick(['.lt', '.le', '.gt', '.ge', '.ne', '.eq'])} ${ri(50)}`;
    case 6: return `${pick(['tstr', 'bstr'])} .size ${pick([String(ri(9)), `(${ri(4)}..${4 + ri(20)})`])}`;
    case 7: return `tstr .regexp ${JSON.stringify(pick(REGEX.slice(0, 9)))}`;
    case 8: return `bstr .cbor ${wtype1(d + 1)}`;
    case 9: return `#6.${pick([1, 24, 32, 55799])}(${wtype1(d + 1)})`;
    default: return `${ri(5)}..${5 + ri(9)}`;
  }
}
function wentry(d, map) {
  const o = occur(), sp = o ? ' ' : '';
  if (map) {
    switch (ri(5)) {
      case 0: case 1: return `${o}${sp}${pick(['a', 'b', 'c', 'kind', 'id'])}: ${wtype(d + 1)}`;
      case 2: return `${o}${sp}${pick(['tstr', 'uint', '"k"', 'tstr .size 1'])} ${chance(0.1) ? '^ ' : ''}=> ${wtype(d + 1)}`;
      case 3: return `${o}${sp}${pick(GN)}`;
      default: return `${o}${sp}(${wgroup(d + 1, true)})`;
    }
  }
  switch (ri(4)) {
    case 0: case 1: return `${o}${sp}${wtype(d + 1)}`;
    case 2: return `${o}${sp}${pick(GN)}`;
    default: return `${o}${sp}(${wgroup(d + 1, false)})`;
  }
}
function wgroup(d, map) {
  const nch = chance(0.2) ? 2 : 1, out = [];
  for (let c = 0; c < nch; c++) out.push(Array.from({ length: ri(d > 2 ? 2 : 4) }, () => wentry(d, map)).join(', '));
  return out.join(' // ');
}
function wschema() {
  const out = [`r = ${wtype(0)}`];
  for (const t of TN) out.push(`${t} = ${wtype(1)}`);
  for (const g of GN) out.push(`${g} = (${wgroup(1, chance(0.5))})`);
  return out.join('\n');
}

// ---------------------------------------------------------------- mutations, hostile shapes
const ALPHA = ' \n\t;:,=/(){}[]<>*+?~&#.^"\'-0123456789abcxyz$@_\\é😀';
function mutate(t) {
  let b = Array.from(t);
  const n = 1 + ri(4);
  for (let k = 0; k < n; k++) {
    const at = ri(b.length + 1);
    switch (ri(6)) {
      case 0: b.splice(at, 0, pick(Array.from(ALPHA))); break;
      case 1: b.splice(at, 1 + ri(3)); break;
      case 2: { const l = 1 + ri(12); b.splice(at, 0, ...b.slice(ri(b.length), ri(b.length) + l)); break; }
      case 3: b[at] = pick(Array.from(ALPHA)); break;
      case 4: b.splice(at, 0, ...Array.from(pick([' // ', ' / ', '? ', '* ', '2*3 ', ' .size 3', '<T>', ' ~', '#6.', '0x', '1e9']))); break;
      default: b = b.slice(0, ri(b.length + 1));
    }
  }
  return b.join('');
}
function hostile() {
  const k = 1 + ri(400);
  switch (ri(12)) {
    case 0: return 'r = ' + '['.repeat(k) + 'int' + ']'.repeat(k);
    case 1: return 'r = ' + '('.repeat(k) + 'int' + ')'.repeat(k);
    case 2: return Array.from({ length: k }, (_, i) => `a${i} = a${i + 1}`).join('\n') + `\na${k} = int\nr = a0`;
    case 3: return Array.from({ length: k }, (_, i) => `a${i} = [a${i + 1}, a${i + 1}]`).join('\n') + `\na${k} = int\nr = a0`;
    case 4: return 'g<T> = [g<[T, T]>]\nr = g<int>';
    case 5: return 'r = { ' + Array.from({ length: k }, (_, i) => `? (k${i}: int // j${i}: int)`).join(', ') + ' }';
    case 6: return 'r = [' + `${ri(100000)}*${ri(1 << 30)} uint` + ', ? uint, tstr]';
    case 7: return 'r = ' + Array.from({ length: k }, (_, i) => `"v${i}"`).join(' / ');
    case 8: return 'r = tstr .regexp "' + '(a|b)'.repeat(Math.min(k, 60)) + '{2,200}"';
    case 9: return 'r = [' + Array.from({ length: Math.min(k, 60) }, () => '? uint').join(', ') + ', 3*7 uint]';
    case 10: return 'a = [* b]\nb = {x: a, ? y: c}\nc = #6.1(a) / bstr .cbor b\nr = a';
    default: return 'r = ' + 'int .and '.repeat(Math.min(k, 200)) + 'uint';
  }
}

// ---------------------------------------------------------------- run
const cases = [];
for (let i = 0; i < N; i++) {
  const r = rnd();
  let text = r < 0.3 ? mutate(pick(seeds)) : r < 0.55 ? schema() : r < 0.9 ? wschema() : hostile();
  if (chance(0.05)) {
    // raw bytes: a valid prefix, then bytes that need not be UTF-8 at all
    const pre = Buffer.from(text.slice(0, ri(text.length + 1)), 'utf8');
    const tail = Uint8Array.from({ length: ri(40) }, () => ri(256));
    text = Uint8Array.from([...pre, ...tail]);
  }
  const limits = {};
  if (chance(0.2)) {
    const k = ri(COMPILE_OPTIONS.length);
    limits[COMPILE_OPTIONS[k]] = pick([0, 1, 2, 3, 8, 64, 1000]);
  }
  if (chance(0.1)) limits.compileBudget = pick([100, 1000, 10000, 100000]);
  cases.push({ text, limits, profile: pick(['full', 'full', 'full', 'bindle', 'bus']), regexp: pick(['xsd', 'iregexp']) });
}
const PROF = { full: 0, bindle: 1, bus: 2 };
const hex = b => Buffer.from(b).toString('hex');
const wordsHex = P => Array.from(P, w => (w >>> 0).toString(16).padStart(8, '0')).join('');
let fails = 0, okCount = 0, errCount = 0, slowest = 0, slowText = '';
const failed = [];
const fail = m => { fails++; if (fails <= 30) console.log(`  FAIL ${m}`); };
const codes = {};
const js = cases.map((c, i) => {
  // The guard uses process CPU time, not wall time: a busy machine must not fail a correct compile (P8.3/P7.13 notes).
  const t0 = performance.now(), c0 = process.cpuUsage();
  const cpuMs = () => { const d = process.cpuUsage(c0); return (d.user + d.system) / 1000; };
  try {
    const { program, pool } = compile(c.text, { profile: c.profile, limits: c.limits, regexp: c.regexp });
    return { ok: true, program, pool, ms: cpuMs(), wall: performance.now() - t0 };
  } catch (e) {
    const ms = cpuMs();
    if (e instanceof SchemaError) return { ok: false, code: e.code, line: e.line, column: e.column, rule: e.rule ?? '-', ms };
    return { crash: String(e && e.stack || e), ms };
  }
});
const rin = cases.map(c => {
  const lim = COMPILE_OPTIONS.map(k => c.limits[k] ?? -1);
  return `${c.regexp === 'iregexp' ? 'I ' : ''}${PROF[c.profile]} ${hex(typeof c.text === 'string' ? Buffer.from(c.text, 'utf8') : c.text)} ${lim.join(' ')}`;
}).join('\n') + '\n';
const rr = spawnSync(rustBin, [], { input: rin, maxBuffer: 1 << 30 });
const rust = rr.stdout.toString().trimEnd().split('\n');
if (rust.length !== cases.length) { console.log(`  FAIL Rust answered ${rust.length} of ${cases.length}`); process.exit(1); }
for (let i = 0; i < cases.length; i++) {
  const c = cases[i], j = js[i], r = rust[i];
  const show = typeof c.text === 'string' ? JSON.stringify(c.text.slice(0, 70)) : `bytes ${hex(c.text.slice(0, 35))}`;
  if (j.ms > slowest) { slowest = j.ms; slowText = show; }
  if (j.ms > 2000) fail(`${show}: ${j.ms.toFixed(0)} ms CPU on JS`);
  if (j.crash) { fail(`${show}: JS threw ${j.crash.split('\n')[0]}`); continue; }
  if (r === 'PANIC') { failed.push(rin.split('\n')[i]); fail(`${show}: Rust panicked`); continue; }
  const f = r.split(' ');
  if (j.ok) {
    okCount++;
    if (!(f[0] === 'ok' && f[2] === wordsHex(j.program) && (f[3] ?? '') === hex(j.pool))) fail(`${show}: JS and Rust Programs differ`);
    const S = new Int32Array(48 + 2 * Math.max(j.program[16], 1) + 16); S[17] = Math.max(j.program[16], 1);
    const v = vmVerify(j.program, j.pool, S);
    if (v !== 0 || f[1] !== '0') fail(`${show}: vm-verify ${v} / Rust ${f[1]} (detail ${S[35]} check ${S[36]})`);
  } else {
    errCount++;
    codes[j.code] = (codes[j.code] ?? 0) + 1;
    if (process.env.SNUG_SHOW && j.code === process.env.SNUG_SHOW) console.log(`  show ${j.ms.toFixed(0)}ms ${show} ${JSON.stringify(c.limits)}`);
    if (j.code === 'internal') fail(`${show}: internal error (a compiler bug) at ${j.line}:${j.column}`);
    if (!(f[0] === 'err' && f[1] === j.code && Number(f[2]) === j.line && Number(f[3]) === j.column && f.slice(4).join(' ') === j.rule))
      fail(`${show}: JS ${j.code} ${j.line}:${j.column} ${j.rule} vs Rust ${r}`);
  }
}
// Arena-size independence (D033) on every 8th text: from the smallest arena
// (retrying) and from a large one, the same outcome.
{
  const M = await import('../../gen/js/snug/compile/main.mjs');
  const A = await import('../../gen/js/snug/compile/arena.mjs');
  const dec = new TextDecoder();
  const run = (c, start) => {
    const bytes = typeof c.text === 'string' ? new TextEncoder().encode(c.text) : c.text;
    const opt = new Int32Array(M.OPT_WORDS).fill(-1); opt[M.OPT_REGEXP] = c.regexp === 'iregexp' ? 1 : 0;
    opt[0] = PROF[c.profile];
    COMPILE_OPTIONS.forEach((k, i) => { if (c.limits[k] !== undefined) opt[i + 1] = c.limits[k]; });
    let fl = new Int32Array(0), words = start;
    for (;;) {
      const h = new Int32Array(words);
      const code = M.compileSchema(bytes, opt, fl, new Int32Array(0), h);
      if (code === A.ERR_ARENA) { if (words >= A.ARENA_MAX_WORDS) return 'limit_memory'; words = Math.min(words * 2, A.ARENA_MAX_WORDS); continue; }
      if (code === A.ERR_NEED_FLOATS) {
        const n = M.floatRequests(h), f = new Int32Array(1 + 2 * n), dv = new DataView(new ArrayBuffer(8)); f[0] = n;
        for (let i = 0; i < n; i++) { dv.setFloat64(0, Number(dec.decode(bytes.subarray(M.floatRequestStart(h, i), M.floatRequestEnd(h, i))))); f[1 + 2 * i] = dv.getInt32(0); f[2 + 2 * i] = dv.getInt32(4); }
        fl = f; continue;
      }
      if (code !== 0) return `err ${code} ${M.errorLine(h)} ${M.errorColumn(h)}`;
      const p = M.outProgramAt(h);
      return wordsHex(h.subarray(p, p + M.outProgramWords(h)));
    }
  };
  let checked = 0;
  for (let i = 0; i < cases.length; i += 8) {
    checked++;
    if (run(cases[i], A.ARENA_MIN_WORDS) !== run(cases[i], 1 << 22)) fail(`case ${i}: the outcome depends on the starting arena size`);
  }
  console.log(`  ${fails ? 'FAIL' : 'ok  '} ${checked} texts compiled from two starting arena sizes: same outcomes`);
}
console.log(`  ${fails ? 'FAIL' : 'ok  '} ${N} texts (seed ${SEED}): ${okCount} compiled, ${errCount} refused; slowest ${slowest.toFixed(1)} ms CPU ${slowText}`);
console.log(`       refusals: ${Object.entries(codes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (failed.length) writeFileSync(new URL('.cache/compile-fuzz-failures.txt', root), failed.join('\n') + '\n');
if (fails) { console.log(`  FAIL ${fails} failure(s)${failed.length ? ' (Rust inputs in .cache/compile-fuzz-failures.txt)' : ''}`); process.exit(1); }
console.log('  ok   compile-fuzz');
