// bb sequence-test (P7.13, D218): CBOR sequences (RFC 8742) against D211's
// oracle -- every message's verdict is the buffer driver's over its window.
//
// Every vm-test case (corpus, oracle schemas, mutations, profile identity
// against `any`, extension controls, stress; validateAt span cases excepted)
// becomes sequences of 0..8 messages of its Program (the case itself among
// others of its group, invalid ones anywhere, a truncated tail, an oversize
// message under a small maxMessageBytes; the empty sequence), delivered as one
// chunk, 1-byte chunks, random chunks of 1..7 / 1..300 / 1..4096 bytes and
// (small sequences) split at every offset, under stop and skip and some
// fail-fast runs. The kin driver (sequence-run.mjs) must give the oracle's
// lines exactly (index, absolute offset, length, every out word); the debug
// Rust build the same lines (panics caught); JS behind out-of-bounds traps (a
// sample). Hosts: JS readSequence / sequenceReader (spanning and always) and
// Rust snug::Sequence give the oracle's messages and refusals, borrowed exactly
// when a message lies inside one chunk ('spanning'), never with 'always', and
// views walk-equal to a View opened on the message's bytes.
//
//     node kin/scripts/sequence-test.mjs <rust-sequence-binary> [mutations] [seed] [schemas]
import { spawnSync } from 'node:child_process';
import { buildVmCases } from './vm-allcases.mjs';
import { runSequence, oracleSequence, chunkEnds, skippableCode } from './sequence-run.mjs';
import { hex } from './scan-cases.mjs';
import { xorshift } from './vmsession-run.mjs';
import { testControls } from './ext-cases.mjs';
import { controlEntries } from '../../host/js/src/ext.mjs';
import { Program as HostProgram, Schema as HostSchema } from '../../host/js/src/schema.mjs';
import { vmVerify, vmVerifyWords } from '../../gen/js/snug/program/verify.mjs';
import { readSequence, sequenceReader } from '../../host/js/src/sequence.mjs';
import { view as openView } from '../../host/js/src/view.mjs';
import { ANY_P, ANY_B } from '../../host/js/src/any-program.mjs';

const [rustBin, mutArg, seedArg, schemaArg] = process.argv.slice(2);
const MUTATIONS = Number(mutArg ?? 6000), SEED = Number(seedArg ?? 1), SCHEMAS = Number(schemaArg ?? 200);
let fails = 0;
const fail = msg => { if (fails < 40) console.log('  FAIL ' + msg); fails++; };
const t0 = performance.now();

// ---------------------------------------------------------------- message sets
const { programs, cases: vmCases } = buildVmCases({ MUTATIONS, SEED, SCHEMAS, fail });
const cases = vmCases.filter(c => !c.span);
const limKey = c => `${c.prog}:${c.rule}:${Array.from(c.lim).join(',')}`;
const groups = new Map();
// companions are the group's messages of at most 4 KiB (a large case still appears alone and among them)
for (const c of cases) { const k = limKey(c); if (!groups.has(k)) groups.set(k, []); if (c.bytes.length <= 4096) groups.get(k).push(c); }
const rnd = xorshift((SEED * 2654435761) >>> 0 || 1);
const pick = a => a[rnd() % a.length];
// small valid items any Program may meet (profile-valid under every flag set; a map root for top = map)
const FILLERS = [[0xa0], [0xa1, 0x61, 0x61, 0x01], [0x00], [0x80], [0x60], [0x18, 0x64]].map(a => Uint8Array.from(a));
const cat = parts => { const t = new Uint8Array(parts.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of parts) { t.set(x, o); o += x.length; } return t; };
const limOf = c => Int32Array.from([...c.lim.slice(0, 8), c.lim[8] ?? 0, c.lim[9] ?? 0]);

const seqs = [];   // {prog, rule, lim, S, label, c}
const seenEmpty = new Set();
cases.forEach((c, ci) => {
  const g = groups.get(limKey(c)), lim = limOf(c);
  const member = () => (rnd() % 4 === 0 || g.length === 0 ? pick(FILLERS) : pick(g).bytes);
  seqs.push({ prog: c.prog, rule: c.rule, lim, S: c.bytes, label: `${c.label} alone`, c, single: true });
  const before = rnd() % 4, after = rnd() % 4, parts = [];
  for (let i = 0; i < before; i++) parts.push(member());
  parts.push(c.bytes);
  for (let i = 0; i < after; i++) parts.push(member());
  if (rnd() % 3 === 0) { const t = member(); if (t.length > 1) parts.push(t.subarray(0, 1 + rnd() % (t.length - 1))); }
  const S = cat(parts);
  seqs.push({ prog: c.prog, rule: c.rule, lim, S, label: `${c.label} in ${parts.length}`, c });
  if (ci % 4 === 0) {
    const small = Int32Array.from(lim), longest = Math.max(...parts.map(x => x.length));
    small[2] = rnd() % (longest + 1);
    seqs.push({ prog: c.prog, rule: c.rule, lim: small, S, label: `${c.label} in ${parts.length}, maxMessageBytes ${small[2]}`, c });
  }
  if (!seenEmpty.has(c.prog)) { seenEmpty.add(c.prog); seqs.push({ prog: c.prog, rule: c.rule, lim, S: new Uint8Array(0), label: `empty (${programs[c.prog].label})`, c }); }
});
// Fixed regressions. 2026-11-11 (the scaled run 30000/1001): a 65,541-byte map holding a
// 65,535-byte string, then zeros up to 1,500,000 bytes and a0, maxMessageBytes 1,500,000, one
// chunk: the runner's window (capped 64 KiB past its position) left the string's claim open,
// and with more than P bytes delivered it settled the held verdict as too_large without first
// asserting the delivered frontier. The message is complete: accepted, then not_map at 65,541.
{
  const anyIndex = programs.findIndex(p => p.label === 'any');
  const big = new Uint8Array(1500001); big.set([0xa1, 0x61, 0x61, 0x59, 0xff, 0xff]); big[1500000] = 0xa0;
  for (const flags of [0, 122]) {
    const c = { label: `fixed: 65,541-byte message then 1.5 MB (flags ${flags})`, prog: anyIndex, rule: 0, bytes: big, fixed: true };
    seqs.push({ prog: anyIndex, rule: 0, lim: Int32Array.of(0, 0, 1500000, 32, 65536, 131072, -1, -1, 0, flags), S: big, label: c.label, c, fixed: true });
  }
}

// A sequence of more than MAX_MESSAGES messages (the 1,500,001 zero bytes vector is 1.5 M
// one-byte messages) is cut at the boundary after its first MAX_MESSAGES: every policy of
// every run is kept affordable; the many-small-messages shape keeps one whole run uncut.
const MAX_MESSAGES = 2000;
const manySmall = [];
seqs.forEach(q => {
  if (q.S.length < MAX_MESSAGES) return;
  const { P, B } = programs[q.prog];
  const lines = oracleSequence(P, B, q.rule, q.lim, q.S).lines;
  if (lines.length <= MAX_MESSAGES) return;
  const f = lines[MAX_MESSAGES - 1].split(' ');
  if (f[0] !== 'm') return;
  if (q.single) manySmall.push({ ...q, label: `${q.label} (uncut)` });
  q.S = q.S.subarray(0, Number(f[2]) + Number(f[3]));
  q.label += ` (first ${MAX_MESSAGES} messages)`;
});

// ---------------------------------------------------------------- kin-level runs
const runs = [];   // {si, policy, skip, ff, want, rust}
const counts = { whole: 0, byte: 0, rnd7: 0, rnd300: 0, rnd4096: 0, split: 0, skip: 0, failfast: 0 };
const oracleCache = new Map();
const oracle = (si, skip) => {
  const k = si * 2 + (skip ? 1 : 0);
  if (!oracleCache.has(k)) { const q = seqs[si], { P, B } = programs[q.prog]; oracleCache.set(k, oracleSequence(P, B, q.rule, q.lim, q.S, { skip }).lines.join(' | ')); }
  return oracleCache.get(k);
};
seqs.forEach((q, si) => {
  const n = q.S.length;
  const add = (policy, tag, skip = false, ff = false, rust = false) => { runs.push({ si, policy, skip, ff, rust }); counts[tag]++; if (skip) counts.skip++; if (ff) counts.failfast++; };
  if (q.fixed) {
    // every delivery shape that crosses the 64 KiB window cap, on both hosts
    add({ kind: 0, q: 0 }, 'whole', false, false, true);
    add({ kind: 3, k: 65536, q: 0 }, 'split', true, false, true);
    add({ kind: 2, w: 4096, q: 0, seed: 7 }, 'rnd4096', false, false, true);
    add({ kind: 2, w: 300, q: 1, seed: 11 }, 'rnd300', false, true, true);
    return;
  }
  add({ kind: 0, q: 0 }, 'whole', false, false, si % 3 === 0);
  if (n <= 4096) add({ kind: 1, w: 1, q: 0 }, 'byte', si % 2 === 0, false, si % 3 === 1);
  if (n <= 65536) add({ kind: 2, w: 7, q: rnd() % 4, seed: 1 + rnd() % (1 << 30) }, 'rnd7', si % 3 === 1, false, si % 3 === 2);
  add({ kind: 2, w: 300, q: 0, seed: 1 + rnd() % (1 << 30) }, 'rnd300', true);
  if (n > 300) add({ kind: 2, w: 4096, q: rnd() % 2, seed: 1 + rnd() % (1 << 30) }, 'rnd4096');
  if (n <= (q.single ? 48 : 24)) for (let k = 1; k < n; k++) add({ kind: 3, k, q: k % 5 === 0 ? 1 : 0 }, 'split', k % 2 === 0, false, n <= 24 && k % 3 === 0);
  if (si % 5 === 0 && n <= 65536) add({ kind: 2, w: 9, q: rnd() % 2, seed: 1 + rnd() % (1 << 30) }, 'rnd7', si % 2 === 0, true, si % 10 === 0);
});
console.log(`  info ${cases.length} cases, ${seqs.length} sequences, ${runs.length} runs (built in ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
if (process.env.SEQ_SLOW) {
  // diagnostics: the slowest runs of a sample
  const slow = [];
  for (let i = 0; i < runs.length; i += Number(process.env.SEQ_SLOW)) {
    const r = runs[i], q = seqs[r.si], { P, B } = programs[q.prog], t = performance.now();
    const x = runSequence(P, B, q.rule, q.lim, q.S, r.policy, { skip: r.skip, failFast: r.ff });
    slow.push([performance.now() - t, `${q.label} ${JSON.stringify(r.policy)} n ${q.S.length}`.slice(0, 200), x.error ?? ""]);
    if (performance.now() - t > 1000) console.log('  slow', (performance.now() - t).toFixed(0), 'ms', slow[slow.length - 1][1], hex(q.S).slice(0, 60));
  }
  slow.sort((a, b) => b[0] - a[0]);
  for (const s of slow.slice(0, 12)) console.log(s[0].toFixed(0), 'ms', s[2], s[1]);
  console.log('total', slow.reduce((a, b) => a + b[0], 0).toFixed(0), 'ms over', slow.length);
  process.exit(0);
}
if (process.env.SEQ_DRY) {
  const w = {}; for (const r of runs) { const n = seqs[r.si].S.length, k = r.policy.kind === 1 ? 'byte' : r.policy.kind === 2 ? 'rnd' + r.policy.w : r.policy.kind === 3 ? 'split' : 'whole';
    const steps = r.policy.kind === 1 ? n : r.policy.kind === 2 ? 2 * n / (r.policy.w + 1) : 2; w[k] = w[k] ?? [0, 0, 0]; w[k][0]++; w[k][1] += n; w[k][2] += steps; }
  console.log(w); process.exit(0);
}
for (const q of manySmall) { seqs.push(q); runs.push({ si: seqs.length - 1, policy: { kind: 0, q: 0 }, skip: false, ff: false, rust: true }); counts.whole++; }
const t1 = performance.now();
let late = 0, lateMsgs = 0;
const js = process.env.SEQ_HOSTONLY ? runs.map(() => '') : runs.map(r => {
  const q = seqs[r.si], { P, B } = programs[q.prog];
  try {
    const x = runSequence(P, B, q.rule, q.lim, q.S, r.policy, { skip: r.skip, failFast: r.ff });
    if (x.error) return 'E ' + x.error;
    if (r.policy.kind === 1) { late += x.late; lateMsgs += x.lines.filter(l => l.startsWith('m ')).length; }
    return x.lines.join(' | ');
  } catch (e) { return 'THROW ' + e.message; }
});
const tJs = performance.now() - t1;
console.log(`  info kin runs done in ${(tJs / 1000).toFixed(1)} s`);
const desc = r => { const q = seqs[r.si]; return `${q.label} policy ${JSON.stringify(r.policy)}${r.skip ? ' skip' : ''}${r.ff ? ' failFast' : ''} lim ${Array.from(q.lim).join(',')} [${hex(q.S).slice(0, 80)}]`; };
let agree = 0, ffRuns = 0, ffBad = 0, ffEarly = 0;
runs.forEach((r, i) => {
  if (process.env.SEQ_HOSTONLY) return;
  const want = oracle(r.si, r.skip), got = js[i];
  if (!r.ff) { if (got === want) agree++; else fail(`${desc(r)}:\n      oracle ${want}\n      kin    ${got}`); return; }
  ffRuns++;
  // fail-fast: the same messages; the same final decision (accept/end vs refuse), its code may differ
  const g = got.split(' | '), w = want.split(' | ');
  const lastG = g[g.length - 1], lastW = w[w.length - 1];
  const same = g.length === w.length && g.slice(0, -1).every((l, k) => l === w[k]) &&
    (lastG === lastW || (lastG.startsWith('x ') && lastW.startsWith('x ') && lastG.split(' ').slice(0, 3).join(' ') === lastW.split(' ').slice(0, 3).join(' ')));
  if (!same) { ffBad++; fail(`fail-fast ${desc(r)}:\n      oracle ${want}\n      kin    ${got}`); }
  else if (lastG !== lastW) ffEarly++;
});
const outcome = { m: 0, s: 0, x: 0, end: 0 };
for (const [, v] of oracleCache) for (const l of v.split(' | ')) outcome[l.split(' ')[0]]++;

// JS bounds: a sample behind traps
function guard(arr, name) {
  return new Proxy(arr, {
    get(t, k) {
      if (typeof k === 'string' && /^-?[0-9]+$/.test(k)) { const i = Number(k); if (i < 0 || i >= t.length) throw new Error(`out-of-bounds read ${name}[${i}] of ${t.length}`); return t[i]; }
      const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) {
      if (typeof k === 'string' && /^-?[0-9]+$/.test(k)) { const i = Number(k); if (i < 0 || i >= t.length) throw new Error(`out-of-bounds write ${name}[${i}] of ${t.length}`); t[i] = v; return true; }
      t[k] = v; return true;
    } });
}
let guarded = 0;
runs.forEach((r, i) => {
  const q = seqs[r.si];
  if (process.env.SEQ_HOSTONLY || r.ff || i % 97 !== 0 || q.S.length > 256 || r.policy.kind === 0) return;
  guarded++;
  const { P, B } = programs[q.prog];
  let g;
  try { const x = runSequence(P, B, q.rule, q.lim, q.S, r.policy, { skip: r.skip, guard }); g = x.error ? 'E ' + x.error : x.lines.join(' | '); }
  catch (e) { g = 'THROW ' + e.message; }
  if (g !== js[i]) fail(`${desc(r)}: trapped ${g} vs ${js[i]}`);
});

// ---------------------------------------------------------------- hosts
// The host rendering: m <index> <offset> <length> <b|o> | s/x <index> <messageOffset> <offset>
// <reason> <subcode|-> <path> <skippable> | end
const td = new TextDecoder();
const ruleNames = P => { const names = []; for (let i = 0; i < P[15]; i++) { const at = P[42] + 5 * i; names.push(td.decode(programs.find(p => p.P === P)?.B.subarray(P[at], P[at] + P[at + 1]) ?? new Uint8Array(0))); } return names; };
const pathText = path => path.map(x => (typeof x === 'number' ? String(x) : x === '*' || x === '#tag' || x === 'cbor' ? x : JSON.stringify(String(x)))).join('/');
const hostPrograms = new Map();
function hostProgram(pi) {
  if (!hostPrograms.has(pi)) {
    let hp = null;
    try { hp = new HostProgram(programs[pi].P, programs[pi].B, { verify: vmVerify, verifyWords: vmVerifyWords, controls: controlEntries(testControls) }); } catch { hp = null; }
    hostPrograms.set(pi, hp);
  }
  return hostPrograms.get(pi);
}
const FLAG_OPTS = f => ({ wire: f & 256 ? 'valid' : 'deterministic', keys: ['text', 'integer', 'any', 'any'][f & 3], tags: ['bindle', 'standard', 'any', 'any'][(f >> 2) & 3],
  floats: f & 16 ? 'deterministic' : 'bindle', undefinedValue: (f & 32) !== 0, noncharacters: (f & 64) !== 0 });
/** The oracle's lines in host rendering, `borrowed(o, len)` telling whether a message lies in one chunk. */
function hostWant(hp, oracleLines, borrowed) {
  return oracleLines.split(' | ').map(l => {
    const f = l.split(' ');
    if (f[0] === 'end') return 'end';
    if (f[0] === 'm') return `m ${f[1]} ${f[2]} ${f[3]}`;
    const words = f.slice(f[0] === 's' ? 4 : 3).filter(x => x !== 'early').map(Number);
    const r = hp.result(Int32Array.from(words));
    // a schema refusal always comes from a complete message (the walk reached the root's end)
    const skippable = skippableCode(words[0]) ? 1 : 0;
    return `${f[0]} ${f[1]} ${f[2]} ${r.offset} ${r.reason} ${r.subcode ?? '-'} ${pathText(r.path)} ${skippable}`;
  }).join(' | ');
}
function renderFault(tag, e) { return `${tag} ${e.index} ${e.messageOffset} ${e.offset} ${e.reason ?? e.code} ${e.subcode ?? '-'} ${pathText(e.path ?? [])} ${e.skippable ? 1 : 0}`; }
function walk(v) {
  const k = v.kind;
  if (k === 'array') { const a = []; for (let i = 0; i < v.length; i++) a.push(walk(v.at(i))); return `[${a.join(',')}]`; }
  if (k === 'map') { const a = []; for (const [, x] of v.entries()) a.push(walk(x)); return `{${v.length}:${a.join(',')}}`; }
  return `${k}:${hex(v.raw())}`;
}

const anyHost = new HostProgram(ANY_P, ANY_B);
const hostRuns = [];   // {si, policy, skip, opts, rule, js}
let hostMsgs = 0, borrowedMsgs = 0, assembledMsgs = 0, walks = 0, hostFails = 0;
const hfail = m => { hostFails++; fail(m); };
async function hostRun(q, policy, skip) {
  const P = programs[q.prog].P;
  const anyCase = programs[q.prog].label === 'any';
  const hp = anyCase ? null : hostProgram(q.prog);
  if (!anyCase && !hp) return;
  const lim = q.lim;
  if (lim[8] !== 0) return;
  const opts = { top: lim[0] === 0 ? 'map' : 'any', cose: lim[1] === 1, ...FLAG_OPTS(lim[9]) };
  ['maxMessageBytes', 'maxDepth', 'maxEntries', 'maxItems', 'maxBignumBytes', 'budget'].forEach((name, k) => { if (lim[2 + k] >= 0) opts[name] = lim[2 + k]; });
  let rule;
  if (!anyCase) { opts.schema = new HostSchema(hp); rule = ruleNames(P)[q.rule]; opts.rule = rule; }
  if (skip) opts.onInvalid = 'skip';
  // the oracle under the host's limit words (profile only: the decode defaults)
  let oLim = lim, oP = programs[q.prog].P, oB = programs[q.prog].B;
  if (anyCase) { const d = [1500000, 32, 65536, 131072]; oLim = Int32Array.from(lim); for (let k = 0; k < 4; k++) if (oLim[2 + k] < 0) oLim[2 + k] = d[k]; }
  const want0 = oracleSequence(oP, oB, q.rule, oLim, q.S, { skip }).lines.join(' | ');
  const ends = chunkEnds(q.S.length, policy);
  // D215's rule: a message is borrowed iff it lies inside one chunk -- it is then released while
  // that chunk is read (D212 liveness: no walk asks past its item's end), so the chunk is never
  // retained after its feed returned
  const chunkOf = at => { for (let k = 0; k < ends.length; k++) if (at < ends[k]) return k; return -1; };
  const borrowRule = (m, current) => chunkOf(m.offset) === chunkOf(m.offset + m.length - 1) && chunkOf(m.offset) === current;
  const inOneChunk = m => chunkOf(m.offset) === chunkOf(m.offset + m.length - 1);
  const renderer = anyCase ? anyHost : hp;
  const want = hostWant(renderer, want0), wantAlways = want;
  let pulled = -1;   // the chunk being read (readSequence pulls one chunk per feed); ends.length at the end
  const chunks = () => { const a = []; let from = 0; for (const e of ends) { a.push(q.S.slice(from, e)); from = e; } return a; };
  const counted = function* () { const a = chunks(); for (let k = 0; k < a.length; k++) { pulled = k; yield a[k]; } pulled = ends.length; };
  // readSequence (copy spanning)
  const got = [];
  try {
    for await (const m of readSequence(counted(), { ...opts })) {
      hostMsgs++;
      const ok = m.length === m.bytes.length && hex(m.bytes) === hex(q.S.subarray(m.offset, m.offset + m.length));
      if (m.borrowed) borrowedMsgs++; else assembledMsgs++;
      if (!ok) hfail(`${q.label}: readSequence message ${m.index} bytes differ`);
      if (hostMsgs % 5 === 0) {
        walks++;
        const { schema, rule: rr, onInvalid: _policy, maxMessageBytes, ...vo } = opts;
        const v2 = openView(m.bytes.slice(), schema ? { ...vo, schema, rule: rr, maxBytes: maxMessageBytes } : { ...vo, maxBytes: maxMessageBytes });
        if (walk(m.view) !== walk(v2)) hfail(`${q.label}: message ${m.index} view walk differs from a View opened on its bytes`);
      }
      if (m.borrowed !== borrowRule(m, pulled) || m.borrowed !== inOneChunk(m)) hfail(`readSequence ${q.label} ${JSON.stringify(policy)}: message ${m.index} borrowed ${m.borrowed}, but the rule says ${!m.borrowed}`);
      got.push(`m ${m.index} ${m.offset} ${m.length}`);
    }
    got.push('end');
  } catch (e) {
    if (e.index === undefined) got.push(`THROW ${e.message}`); else got.push(renderFault('x', e));
  }
  // skipped refusals are not yielded by readSequence: compare with the oracle less its s lines
  const wantRead = want.split(' | ').filter(l => !l.startsWith('s ')).join(' | ');
  const g = got.join(' | ');
  if (g !== wantRead) hfail(`readSequence ${q.label} ${JSON.stringify(policy)}${skip ? ' skip' : ''} [${hex(q.S).slice(0, 120)}]:\n      want ${wantRead}\n      got  ${g}`);
  // sequenceReader (copy always): the push API's messages, skipped and error, in index order
  const pushed = [];
  try {
    const rd = sequenceReader({ ...opts, copy: 'always' });
    const take = res => {
      if (res.messages.some(m => m.borrowed)) hfail(`sequenceReader ${q.label}: a message borrowed under copy 'always'`);
      const items = [...res.messages.map(m => ({ i: m.index, s: `m ${m.index} ${m.offset} ${m.length}` })),
        ...res.skipped.map(e => ({ i: e.index, s: renderFault('s', e) }))].sort((a, b) => a.i - b.i);
      for (const x of items) pushed.push(x.s);
      if (res.error) { pushed.push(renderFault('x', res.error)); return true; }
      return false;
    };
    let stopped = false;
    for (const ch of chunks()) { if (take(rd.feed(ch))) { stopped = true; break; } }
    if (!stopped && !take(rd.end())) pushed.push('end');
  } catch (e) { pushed.push(`THROW ${e.message}`); }
  const p = pushed.join(' | ');
  if (p !== wantAlways) hfail(`sequenceReader ${q.label} ${JSON.stringify(policy)}${skip ? ' skip' : ''}:\n      want ${wantAlways}\n      got  ${p}`);
  hostRuns.push({ q, policy, skip, opts, rule, anyCase, want });
}
const tH = performance.now();
for (let si = 0; si < seqs.length; si++) {
  const q = seqs[si];
  if (q.fixed) { await hostRun(q, { kind: 0 }, false); await hostRun(q, { kind: 3, k: 65536 }, false); continue; }
  if (si % 3 !== 0) continue;
  await hostRun(q, { kind: 2, w: q.S.length <= 65536 ? 7 : 4096, seed: 1 + rnd() % (1 << 30) }, si % 2 === 0);
  if (si % 9 === 0) await hostRun(q, { kind: 0 }, false);
}
const tHost = performance.now() - tH;
console.log(`  info host runs done in ${(tHost / 1000).toFixed(1)} s`);

// ---------------------------------------------------------------- Rust
let rustLine = '  SKIP Rust (no binary given)', rustHostLine = '  SKIP Rust host';
if (rustBin) {
  const lines = programs.map(p => `prog ${Array.from(p.P).join(',')} ${p.B.length ? hex(p.B) : '-'}`);
  const sel = [];
  runs.forEach((r, i) => {
    if (!r.rust) return;
    const q = seqs[r.si], pol = r.policy;
    sel.push(i);
    lines.push(`case ${q.prog} ${q.rule} ${Array.from(q.lim).join(' ')} ${pol.kind} ${pol.w ?? 0} ${pol.q ?? 0} ${(pol.seed ?? 1) >>> 0} ${pol.k ?? 0} ${r.skip ? 1 : 0} ${r.ff ? 1 : 0} ${q.S.length ? hex(q.S) : '-'}`);
  });
  for (const h of hostRuns) {
    const q = h.q, pol = h.policy, lim = q.lim;
    const ruleHex = h.anyCase ? '-' : Buffer.from(h.rule).toString('hex') || '-';
    lines.push(`host ${h.anyCase ? -1 : q.prog} ${ruleHex} ${lim[0] === 0 ? 1 : 0} ${lim[1]} ${Array.from(lim.slice(2, 8)).join(' ')} ${lim[9]} ${pol.kind} ${pol.w ?? 0} ${(pol.seed ?? 1) >>> 0} ${pol.k ?? 0} ${h.skip ? 1 : 0} 0 ${q.S.length ? hex(q.S) : '-'}`);
  }
  const t2 = performance.now();
  const p = spawnSync(rustBin, [], { input: lines.join('\n') + '\n', maxBuffer: 1 << 30, encoding: 'utf8' });
  const tRs = performance.now() - t2;
  if (p.status !== 0) fail(`the Rust binary exited ${p.status}: ${p.stderr.slice(0, 400)}`);
  const all = p.stdout.trim().split('\n');
  if (all.length !== sel.length + hostRuns.length) fail(`Rust answered ${all.length} lines, expected ${sel.length + hostRuns.length}`);
  let ra = 0, panics = 0;
  sel.forEach((i, k) => {
    if (all[k] === 'PANIC') { panics++; fail(`${desc(runs[i])}: Rust PANICKED`); return; }
    if (all[k] !== js[i]) { fail(`${desc(runs[i])}:\n      JS   ${js[i]}\n      Rust ${all[k]}`); return; }
    ra++;
  });
  rustLine = `  ${ra === sel.length ? 'ok  ' : 'FAIL'} JS == Rust (kin level, debug, overflow checks on): ${ra}/${sel.length} sequence runs, every line, ${panics} panics (${(tRs / 1000).toFixed(1)} s)`;
  let ha = 0;
  hostRuns.forEach((h, k) => {
    const got = all[sel.length + k];
    if (got === h.want) ha++; else fail(`Rust host ${h.q.label} ${JSON.stringify(h.policy)}${h.skip ? ' skip' : ''}:\n      want ${h.want}\n      got  ${got}`);
  });
  rustHostLine = `  ${ha === hostRuns.length ? 'ok  ' : 'FAIL'} Rust snug::Sequence == the oracle on ${ha}/${hostRuns.length} host runs (messages, borrowed exactly inside one chunk, skipped and stopping refusals)`;
}

const line = (ok, s) => console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${s}`);
line(agree === runs.length - ffRuns, `kin sequence mode == oracle (D211): ${agree}/${runs.length - ffRuns} runs over ${seqs.length} sequences from ${cases.length} vm-test cases (${MUTATIONS} mutations, ${SCHEMAS} oracle schemas, seed ${SEED}), every line and out word`);
console.log(`  info runs: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}; oracle outcomes: ${outcome.m} messages, ${outcome.s} skipped, ${outcome.x} stops, ${outcome.end} clean ends`);
line(ffBad === 0, `fail-fast: ${ffRuns - ffBad}/${ffRuns} runs give the oracle's messages and decision (${ffEarly} stopped early with another code or offset)`);
line(true, `JS bounds: ${guarded} runs behind throwing out-of-bounds traps (failures above if any)`);
line(late === 0, `release latency (D212 liveness): ${late} of ${lateMsgs} accepted messages in 1-byte runs waited for a byte past their own end`);
line(hostFails === 0, `JS hosts: readSequence (spanning) and sequenceReader (always) == the oracle on ${hostRuns.length} host runs; ${hostMsgs} messages (${borrowedMsgs} borrowed, ${assembledMsgs} assembled), ${walks} view walks equal to a View on the bytes (${(tHost / 1000).toFixed(1)} s)`);
console.log(rustLine);
console.log(rustHostLine);
console.log(`  info ${programs.length} programs; JS ran ${runs.length} sequence runs in ${(tJs / 1000).toFixed(1)} s (all ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
if (fails) { console.log(`  FAIL ${fails} failure(s)`); process.exit(1); }
console.log('  ok   sequence-test');
