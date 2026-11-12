// P9.14 (D334): the `.abnf` / `.abnfb` gate (bb abnf-test). The engine (gen/js/snug/abnf.mjs,
// from kin/abnf.kin) is checked against
//   1. the hand vectors (corpus/conformance/abnf.json): kin and the oracle both answer the
//      expected verdict or refusal code;
//   2. the independent oracle (corpus/tools/abnf-oracle.mjs) on seeded random grammars
//      (every construct: recursion, empty matches, ranges, case modes, =/, continuation
//      lines, comments, CRLF) and on random, sampled and near-miss strings, in both modes,
//      over text and byte string targets;
//   3. the oracle again on mutated grammar texts (accept/refuse must agree; when both
//      accept, the verdicts must too);
//   4. the budget: for every case answered with u units, room u - 1 answers -1 and room u
//      the same verdict; a scratch grown from 16 words gives the same word;
//   5. pathological grammars under the default budget: they stop (budget or the memory
//      cap) within a bounded time, the CPU per unit is printed;
//   6. JS == Rust: every prepare (status, line, column, table words) and run (the verdict
//      word) above replayed through a debug Rust build of the same kin source.
// Sections 1-3 run both parse modes (D340): the strict default and abnf: 'lenient', kin
// against the oracle's own switch in each; a strict-valid text prepares the same table in
// lenient mode; half the random grammars have the strict shape.
//
//     node kin/scripts/abnf-test.mjs <rust abnf binary> [grammars] [seed]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as K from '../../gen/js/snug/abnf.mjs';
import { parseAbnf, matchAbnf, symbolsOf } from '../../corpus/tools/abnf-oracle.mjs';
import { selfWatch } from './watchdog.mjs';
selfWatch('abnf-test', import.meta.url);   // P9.1 caps

const [bin, grammarsArg = '600', seedArg = '1'] = process.argv.slice(2);
const GRAMMARS = Number(grammarsArg), SEED = Number(seedArg);
const BIG = 0x7fffffff, DEFAULT_BUDGET = 2250000;
const NAMES = { 1: 'not_string', 2: 'utf8', 3: 'syntax', 4: 'prose', 5: 'undefined', 6: 'duplicate', 7: 'incremental',
  8: 'repeat', 9: 'range', 10: 'nesting', 11: 'too_large', 12: 'internal',
  // strict only (D340)
  13: 'start_wide', 14: 'rule_first', 15: 'no_eol', 16: 'comment', 17: 'leading', 18: 'order', 19: 'after_start' };
const te = new TextEncoder();
const hex = b => Buffer.from(b).toString('hex');

function strItem(bytes, major) {          // major 3 text, 2 bytes: a definite CBOR string
  const n = bytes.length, m = major << 5;
  const h = n < 24 ? [m | n] : n < 256 ? [m | 24, n] : n < 65536 ? [m | 25, n >> 8, n & 255]
    : [m | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  return Uint8Array.from([...h, ...bytes]);
}

// ---------------------------------------------------------------- kin (JS), recorded for Rust
const rustIn = [], rustWant = [];
function prep(text, lenient = false) {
  const a = strItem(typeof text === 'string' ? te.encode(text) : text, 3), pm = lenient ? K.MODE_LENIENT : K.MODE_STRICT;
  const t = new Int32Array(K.abnfWords(a.length)), st = K.abnfPrep(a, 0, a.length, t, pm);
  const used = st === 0 ? K.abnfTableWords(t) : 0;
  rustIn.push(`P ${pm} ${hex(a)}`);
  rustWant.push(`P ${st} ${K.abnfErrorLine(t)} ${K.abnfErrorColumn(t)} ${used}`);
  return { st, code: NAMES[st], t: st === 0 ? t.slice(0, used) : null, line: K.abnfErrorLine(t), column: K.abnfErrorColumn(t) };
}
let scratchMax = 0;
// The rerun bound: kin's suggestion at least doubles the scratch and stays within the cap,
// so a run is repeated at most ceil(log2(cap / first)) times; checked on every run.
function run(p, mode, item, room, first = 0, record = true, cap = -1) {
  let r = -2, reruns = 0, m = null;
  if (p.t) {
    const capWords = K.abnfCap(cap);
    m = new Int32Array(first > 0 ? first : K.abnfScratchWords(p.t, item.length, cap));
    const bound = Math.ceil(Math.log2(capWords / m.length)) + 1;
    for (;;) {
      r = K.abnfRun(p.t, mode, item, 0, item.length, m, room, cap);
      if (r === -1 && K.abnfMore(m) > m.length) {
        assert.ok(K.abnfMore(m) <= capWords && K.abnfMore(m) >= 2 * m.length, 'a growth within the cap');
        m = new Int32Array(K.abnfMore(m));
        stats.grown++;
        reruns++;
        assert.ok(reruns <= bound, `reruns ${reruns} within log2(cap / first) + 1 = ${bound}`);
        continue;
      }
      break;
    }
    scratchMax = Math.max(scratchMax, m.length);
    stats.maxReruns = Math.max(stats.maxReruns, reruns);
  }
  lastScratch = m;
  if (record) {
    rustIn.push(`R ${mode} ${hex(item) || '-'} ${room} ${first} ${cap}`);
    rustWant.push(`R ${r} ${reruns}`);
  }
  return r;
}
let lastScratch = null;
const units = r => (r >= 0 ? r : -2 - r);

const stats = { grown: 0, maxReruns: 0, hand: 0, handCases: 0, grammars: 0, runs: 0, matched: 0, refused: 0, budgetSkipped: 0, sweeps: 0,
  growth: 0, mutants: 0, mutantsBothOk: 0, mutantsBothRefused: 0, mutantRuns: 0, strictRefusals: 0,
  strictGrammars: 0, strictRefused: 0, strictSame: 0, mutantsStrictOk: 0, mutantsStrictRefused: 0 };

/** Budget sweep on one answered run: room u - 1 stops, room u answers the same; a scratch
 *  grown from 16 words answers the same. */
function sweep(p, mode, item, r) {
  if (r === -1) return;
  const u = units(r);
  if (u > 0) assert.equal(run(p, mode, item, u - 1), -1, 'room u - 1 must stop');
  assert.equal(run(p, mode, item, u), r, 'room u must answer the same');
  assert.equal(run(p, mode, item, BIG, 16), r, 'a grown scratch must answer the same');
  stats.sweeps++; stats.growth++;
}

// ---------------------------------------------------------------- 1. hand vectors
const vectors = JSON.parse(readFileSync(new URL('../../corpus/conformance/abnf.json', import.meta.url)));
// A grammar marked "parse": "lenient" needs the abnf: 'lenient' option (D340): its cases
// run in lenient mode, and strict mode must refuse it with "strictError" (kin and oracle).
// Every other grammar is strict-valid and must mean the same in lenient mode: the same
// prepared table, so the same verdicts and units.
for (const g of vectors.grammars) {
  const lenient = g.parse === 'lenient';
  if (lenient) {
    // an error vector run in lenient mode (its code there is the point) is refused by
    // strict mode too, perhaps with another code; every other lenient vector names its
    // strict refusal
    assert.ok(g.strictError || g.error, `${g.name}: a lenient vector names its strict refusal`);
    const ps = prep(g.abnf), os = parseAbnf(g.abnf);
    assert.ok(ps.st !== 0 && !os.ok, `${g.name}: strict mode refuses it (kin ${ps.code}, oracle ${os.code})`);
    if (g.strictError) {
      assert.equal(ps.code, g.strictError, `${g.name}: kin strict`);
      assert.equal(os.code, g.strictError, `${g.name}: oracle strict`);
    }
    assert.ok(ps.line >= 1 && ps.column >= 1, `${g.name}: a strict refusal has a place`);
    stats.strictRefusals++;
  }
  const p = prep(g.abnf, lenient), o = parseAbnf(g.abnf, { lenient });
  if (!lenient && !g.error) {
    const pl = prep(g.abnf, true);
    assert.deepEqual(pl.t, p.t, `${g.name}: strict and lenient prepare the same table`);
  }
  if (g.error) {
    assert.equal(p.code, g.error, `${g.name}: kin`);
    assert.equal(o.ok ? 'ok' : o.code, g.error, `${g.name}: oracle`);
    assert.ok(p.line >= 1 && p.column >= 1, `${g.name}: a refusal has a place`);
    stats.hand++;
    continue;
  }
  assert.equal(p.st, 0, `${g.name}: kin refused it (${p.code} at ${p.line}:${p.column})`);
  assert.ok(o.ok, `${g.name}: the oracle refused it (${o.code})`);
  for (const c of g.cases) {
    const content = c.input !== undefined ? te.encode(c.input) : Buffer.from(c.inputHex, 'hex');
    const item = strItem(content, c.major === 'text' ? 3 : 2), mode = c.mode === 'abnfb' ? 1 : 0;
    const r = run(p, mode, item, BIG);
    assert.notEqual(r, -1, `${g.name}: ${JSON.stringify(c)} ran out`);
    assert.equal(r >= 0, c.expect, `${g.name}: kin on ${JSON.stringify(c)}`);
    const sym = symbolsOf(content, mode === 1 ? 'bytes' : 'text');
    assert.equal(sym !== null && matchAbnf(o, sym), c.expect, `${g.name}: oracle on ${JSON.stringify(c)}`);
    sweep(p, mode, item, r);
    stats.handCases++;
  }
  stats.hand++;
}

// ---------------------------------------------------------------- 2. random grammars
let seed = SEED * 2654435761 >>> 0 || 1;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = a => a[Math.floor(rnd() * a.length)];
const CHARS = ['a', 'b', 'A', 'B', '0', '1', '-', '.', ' ', '%', ';', '<', '/'];
const VALUES = [0x00, 0x2d, 0x30, 0x31, 0x39, 0x41, 0x42, 0x61, 0x62, 0x7f, 0x80, 0xe9, 0xff, 0x20ac, 0x1f600];
const caseMix = s => [...s].map(c => (rnd() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join('');

function leaf(nrules) {
  let r = rnd();
  if (nrules === 0 && r >= 0.7) r /= 2;
  if (r < 0.4) {
    const s = Array.from({ length: int(0, 3) }, () => pick(CHARS)).join('');
    return { t: 'str', s, mode: pick(['', '', '%s', '%i', '%S', '%I']) };
  }
  if (r < 0.7) {
    const kind = pick(['one', 'one', 'range', 'cat']);
    if (kind === 'range') {   // now and then reversed: valid ABNF, an empty range (D334)
      const a = pick(VALUES), b = pick(VALUES), lo = Math.min(a, b), hi = Math.max(a, b);
      return { t: 'num', range: rnd() < 0.12 && lo < hi ? [hi, lo] : [lo, hi], base: pick(['x', 'd', 'b', 'X']) };
    }
    if (kind === 'cat') return { t: 'num', cat: Array.from({ length: int(2, 3) }, () => pick(VALUES)), base: pick(['x', 'd', 'X']) };
    return { t: 'num', cat: [pick(VALUES)], base: pick(['x', 'd', 'b', 'x', 'X']) };
  }
  return { t: 'ref', n: int(0, nrules - 1) };
}
function expr(depth, nrules) {
  const r = rnd();
  if (depth >= 3 || r < 0.35) return leaf(nrules);
  if (r < 0.55) return { t: 'seq', items: Array.from({ length: int(2, 3) }, () => expr(depth + 1, nrules)) };
  if (r < 0.72) return { t: 'alt', items: Array.from({ length: int(2, 3) }, () => expr(depth + 1, nrules)) };
  if (r < 0.9) {
    // now and then max < min: valid ABNF that matches nothing (D334)
    const min = int(0, 2), max = min > 0 && rnd() < 0.08 ? min - 1 : pick([min, min + 1, min + 2, Infinity]);
    return { t: 'rep', min, max, item: expr(depth + 1, nrules) };
  }
  return { t: 'opt', item: expr(depth + 1, nrules) };
}
const ws = () => pick([' ', ' ', '  ', '\t', '\n  ', ' ; note\n ']);
const digitsIn = (v, base) => { const s = v.toString({ x: 16, X: 16, d: 10, b: 2 }[base]); return base === 'X' ? s.toUpperCase() : rnd() < 0.3 ? s.toUpperCase() : s; };
const isElement = n => ['str', 'num', 'ref', 'opt', 'group'].includes(n.t);
function text(n, names) {
  switch (n.t) {
    case 'str': return `${n.mode}"${n.s}"`;
    case 'num': {
      const b = n.base === 'X' ? 'X' : rnd() < 0.2 ? n.base.toUpperCase() : n.base;
      if (n.range) return `%${b}${digitsIn(n.range[0], n.base)}-${digitsIn(n.range[1], n.base)}`;
      return `%${b}` + n.cat.map(v => digitsIn(v, n.base)).join('.');
    }
    case 'ref': return caseMix(names[n.n]);
    case 'seq': return n.items.map(x => (x.t === 'alt' ? `(${text(x, names)})` : text(x, names))).join(ws());
    case 'alt': return n.items.map(x => text(x, names)).join(pick([' / ', '/', ' /\n   ', '  /  ']));
    case 'rep': {
      const rep = n.min === n.max ? `${n.min}` : `${n.min === 0 && rnd() < 0.5 ? '' : n.min}*${n.max === Infinity ? '' : n.max}`;
      return rep + (isElement(n.item) ? text(n.item, names) : `(${pick(['', ' '])}${text(n.item, names)}${pick(['', ' '])})`);
    }
    case 'opt': return `[${pick(['', ' '])}${text(n.item, names)}${pick(['', ' '])}]`;
  }
  throw new Error(n.t);
}
// strict: a controller of the strict default's shape (D340) -- the start one element
// (grouped when it is not), alone on its line, the text ending in a newline; otherwise the
// lenient shapes too (a wide start, text after it, no final newline)
function grammar(strict) {
  const nrules = int(0, 4), names = Array.from({ length: nrules }, (_, i) => pick(['r', 'rule', 'X', 'a-b']) + i);
  const bodies = names.map(() => expr(0, nrules)), start = expr(0, nrules);
  const nl = rnd() < 0.2 ? '\r\n' : '\n';
  const lines = [strict ? (isElement(start) ? text(start, names) : `(${text(start, names)})`) : text(start, names) + pick(['', ' ', ' ; start'])];
  names.forEach((name, i) => {
    const b = bodies[i];
    if (rnd() < 0.15) lines.push(pick(['', '; comment', '  ']));
    if (b.t === 'alt' && rnd() < 0.5) {            // split into = and =/ definitions
      lines.push(`${caseMix(name)} = ${text(b.items[0], names)}`);
      for (const x of b.items.slice(1)) lines.push(`${caseMix(name)} =/ ${text(x, names)}`);
    } else lines.push(`${caseMix(name)}${pick([' = ', '=', ' =  '])}${text(b, names)}`);
  });
  return { text: lines.join(nl) + (strict ? nl : pick(['', nl])), start, bodies, names, strict };
}
function sample(n, g, depth) {
  if (depth > 12) return null;
  switch (n.t) {
    case 'str': return [...n.s].map(c => {
      const code = c.charCodeAt(0);
      return /[A-Za-z]/.test(c) && !/^%[sS]/.test(n.mode) && rnd() < 0.5 ? code ^ 32 : code;
    });
    case 'num': return n.range ? [int(Math.min(...n.range), Math.max(...n.range))] : [...n.cat];
    case 'ref': return sample(g.bodies[n.n], g, depth + 1);
    case 'seq': { const out = []; for (const x of n.items) { const s = sample(x, g, depth + 1); if (!s) return null; out.push(...s); } return out; }
    case 'alt': { for (let k = 0; k < 3; k++) { const s = sample(pick(n.items), g, depth + 1); if (s) return s; } return null; }
    case 'rep': {
      const k = int(n.min, Math.min(n.max, n.min + 2)), out = [];
      for (let i = 0; i < k; i++) { const s = sample(n.item, g, depth + 1); if (!s) return null; out.push(...s); }
      return out;
    }
    case 'opt': return rnd() < 0.5 ? [] : sample(n.item, g, depth + 1);
  }
  throw new Error(n.t);
}
const scalarOk = v => v >= 0 && v <= 0x10ffff && !(v >= 0xd800 && v <= 0xdfff);
function inputsFor(g) {
  const pool = new Set([0x78]);
  const seen = new Map(), add = s => { if (s && s.length <= 14) seen.set(s.join(','), s); };
  for (let i = 0; i < 8; i++) { const s = sample(g.start, g, 0); add(s); if (s) s.forEach(v => pool.add(v)); }
  const vals = [...pool];
  for (const s of [...seen.values()]) {
    for (let k = 0; k < 2; k++) {
      const m = [...s], op = int(0, 2), at = int(0, m.length);
      if (op === 0 && m.length) m.splice(Math.min(at, m.length - 1), 1);
      else if (op === 1) m.splice(at, 0, pick(vals));
      else if (m.length) m[Math.min(at, m.length - 1)] = pick(vals);
      add(m);
    }
  }
  for (let i = 0; i < 3; i++) add(Array.from({ length: int(0, 6) }, () => pick(vals)));
  return [...seen.values()];
}
/** Items for a symbol list: [mode, item, content] -- .abnf over text (scalars) and over
 *  their UTF-8 as bytes; .abnfb over bytes (when every value is a byte) and over text. */
function itemsFor(sym) {
  const out = [];
  if (sym.every(scalarOk)) {
    const utf8 = te.encode(String.fromCodePoint(...sym));
    out.push([0, strItem(utf8, 3), utf8], [0, strItem(utf8, 2), utf8], [1, strItem(utf8, 3), utf8]);
  }
  if (sym.every(v => v <= 255)) { const b = Uint8Array.from(sym); out.push([1, strItem(b, 2), b], [0, strItem(b, 2), b]); }
  return out;
}
function differential(p, o, sym, where) {
  for (const [mode, item, content] of itemsFor(sym)) {
    const r = run(p, mode, item, BIG);
    stats.runs++;
    if (r === -1) { stats.budgetSkipped++; continue; }
    const s = symbolsOf(content, mode === 1 ? 'bytes' : 'text');
    const want = s !== null && matchAbnf(o, s);
    if ((r >= 0) !== want)
      assert.fail(`${where}: kin ${r >= 0} oracle ${want} (mode ${mode}, item ${hex(item)})`);
    if (r >= 0) stats.matched++; else stats.refused++;
    if (stats.runs % 7 === 0) sweep(p, mode, item, r);
  }
}
/** Both parse modes on one text (D340): kin and the oracle agree on accept/refuse in each;
 *  what strict accepts, lenient accepts with the same table. Returns the two preparations. */
function bothModes(t, where) {
  const ps = prep(t), os = parseAbnf(t), pl = prep(t, true), ol = parseAbnf(t, { lenient: true });
  if ((ps.st === 0) !== os.ok) assert.fail(`${where} strict: kin ${ps.st === 0 ? 'accepts' : ps.code} oracle ${os.ok ? 'accepts' : os.code}`);
  if ((pl.st === 0) !== ol.ok) assert.fail(`${where} lenient: kin ${pl.st === 0 ? 'accepts' : pl.code} oracle ${ol.ok ? 'accepts' : ol.code}`);
  if (ps.st === 0) {
    assert.equal(pl.st, 0, `${where}: strict accepts, lenient must`);
    assert.deepEqual(pl.t, ps.t, `${where}: strict and lenient prepare the same table`);
    stats.strictSame++;
  }
  return { ps, os, pl, ol };
}
const texts = [];
for (let i = 0; i < GRAMMARS; i++) {
  const g = grammar(i % 2 === 0), where = `grammar ${i} ${JSON.stringify(g.text)}`;
  const { ps, os, pl: p, ol: o } = bothModes(g.text, where);
  assert.equal(p.st, 0, `${where}: kin refused (${p.code} at ${p.line}:${p.column})`);
  assert.ok(o.ok, `${where}: the oracle refused (${o.code})`);
  if (g.strict) assert.equal(ps.st, 0, `${where}: kin strict refused (${ps.code} at ${ps.line}:${ps.column})`);
  const inputs = inputsFor(g);
  for (const sym of inputs) differential(p, o, sym, where);
  if (ps.st === 0) { stats.strictGrammars++; for (const sym of inputs.slice(0, 4)) differential(ps, os, sym, `${where} strict`); }
  else stats.strictRefused++;
  texts.push({ text: g.text, inputs });
  stats.grammars++;
}

// The rule-first extension (D334, lenient only since D340): each generated grammar without
// its start line begins with a rule; kin's lookahead and the oracle's
// element-first-then-rule-first must agree, and strict mode refuses it as rule_first.
stats.ruleFirst = 0;
for (const { text: src, inputs } of texts) {
  const rest = src.split(/\r?\n/).slice(1).join('\n');
  if (!/^[A-Za-z]/.test(rest)) continue;
  const where = `rule-first ${JSON.stringify(rest)}`, { ps, os, pl: p, ol: o } = bothModes(rest, where);
  if (/^[A-Za-z][A-Za-z0-9-]*[ \t]*=/.test(rest)) {
    assert.equal(ps.code, 'rule_first', `${where}: kin strict`);
    assert.equal(os.code, 'rule_first', `${where}: oracle strict`);
  }
  if (!o.ok) continue;
  stats.ruleFirst++;
  for (const sym of inputs.slice(0, 4)) differential(p, o, sym, where);
}

// ---------------------------------------------------------------- 3. mutated grammar texts
const NOISE = ['(', ')', '[', ']', '/', '*', '=', '%', ';', '<', '>', '"', 'x', 'X', 'b', '0', '9', 'a', ' ', '\n', '\t', '-', '.', '\r'];
for (const { text: src, inputs } of texts) {
  for (let k = 0; k < 4; k++) {
    let t = src;
    const ops = int(1, 2);
    for (let q = 0; q < ops; q++) {
      const at = int(0, t.length), op = int(0, 2);
      if (op === 0 && t.length) t = t.slice(0, at) + t.slice(at + 1);
      else if (op === 1) t = t.slice(0, at) + pick(NOISE) + t.slice(at);
      else if (t.length) { const b = int(0, t.length); t = t.slice(0, Math.min(at, b)) + t.slice(Math.max(at, b)) + t.slice(Math.min(at, b), Math.max(at, b)); }
    }
    const where = `mutant ${JSON.stringify(t)}`, { ps, os, pl: p, ol: o } = bothModes(t, where);
    stats.mutants++;
    if (ps.st === 0) {
      stats.mutantsStrictOk++;
      for (const sym of inputs.slice(0, 2)) { differential(ps, os, sym, `${where} strict`); stats.mutantRuns++; }
    } else stats.mutantsStrictRefused++;
    if (!o.ok) { stats.mutantsBothRefused++; continue; }
    stats.mutantsBothOk++;
    for (const sym of inputs.slice(0, 4)) { differential(p, o, sym, where); stats.mutantRuns++; }
  }
}

// ---------------------------------------------------------------- 5. pathological grammars
const patho = [
  ['ambiguous a = a a / "x"', 'a\na = a a / "x"\n', 'x'.repeat(400)],
  ['ambiguous with the empty string', 'a\na = a a / "x" / ""\n', 'x'.repeat(400)],
  ['nested nullable stars', '(*(*(*(*"x"))))', 'x'.repeat(3000)],
  ['counted repetition of an ambiguous pair', '(1000*2000("x" / "x" "x"))', 'x'.repeat(1500)],
  ['right recursion over a long input', 'a\na = "x" a / ""\n', 'x'.repeat(4000)],
  ['left recursion over a long input', 'a\na = a "x" / ""\n', 'x'.repeat(60000)],
  ['a counted nullable repetition', '(2147483647*"")', ''],
  ['many alternatives', 'a\na = ' + Array.from({ length: 300 }, (_, i) => `%x${(i % 64 + 32).toString(16)}`).join(' / ') + ' a / ""\n', '~'.repeat(2000)],
  ['deep nesting at the cap', 'x\nx = ' + '('.repeat(256) + '*"a"' + ')'.repeat(256) + '\n', 'a'.repeat(2000)],
];
const timing = [];
for (const [name, g, input] of patho) {
  const p = prep(g);
  assert.equal(p.st, 0, `${name}: ${p.code}`);
  const item = strItem(te.encode(input), 3);
  const t0 = process.hrtime.bigint();
  const r = run(p, 0, item, DEFAULT_BUDGET);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // a 50 M unit budget (22x the default): the memory cap or the budget, never a hang. JS only:
  // a debug Rust build is too slow for these.
  const capped = run(p, 0, item, 50000000, 0, false);
  const ms2 = Number(process.hrtime.bigint() - t0) / 1e6 - ms;
  timing.push({ name, r, ms: ms.toFixed(1), units: r === -1 ? DEFAULT_BUDGET : units(r), nsPerUnit: (ms * 1e6 / (r === -1 ? DEFAULT_BUDGET : Math.max(units(r), 1))).toFixed(1),
    unbounded: capped, msUnbounded: ms2.toFixed(0) });
  assert.ok(ms < 20000 && ms2 < 60000, `${name}: too slow (${ms} ms, ${ms2} ms)`);
}

// The memory cap: 1,500 terminals predicted at every position of a 2,000-symbol string -- the
// run stops at the scratch cap (-1, `budget`) with ticks left, on both hosts; grown from 16
// words within the rerun bound. Under the default cap (D281's 16 MiB) and two smaller ones:
// the cap is the host's option and moves the stopping point only. (At the 2^24-word hard
// maximum this input runs out of the 2^30-tick run allowance first.)
{
  const alts = Array.from({ length: 1500 }, (_, i) => `%x${(0x100 + i).toString(16)}`).join(' / ');
  const p = prep(`a\na = (${alts}) a / ""\n`), item = strItem(te.encode('Ā'.repeat(2000)), 3);
  const spent = [];
  assert.deepEqual([K.abnfCap(-1), K.abnfCap(5), K.abnfCap(1 << 30), K.abnfCap(1 << 20)],
    [K.ABNF_DEFAULT_WORDS, K.ABNF_MIN_WORDS, K.ABNF_MAX_WORDS, 1 << 20]);
  for (const cap of [-1, 1 << 20, K.ABNF_MIN_WORDS]) {
    const r = run(p, 0, item, 200000000, 16, true, cap), m = lastScratch;
    assert.equal(r, -1, 'the memory cap stops the run');
    assert.equal(m.length, K.abnfCap(cap), 'the scratch grew to the cap');
    assert.ok(m[0] < m[1] - 8000000, 'ticks remained: memory, not budget, stopped it');
    assert.equal(run(p, 0, item, 200000000, 0, true, cap), -1);
    spent.push(`${K.abnfCap(cap)} words: ${m[0] / 8 | 0} units`);
  }
  // a valid match whose scratch needs more than a small cap: refused by the cap, answered under the default
  const q = prep('(*(%x61 / %x61 %x61))'), long = strItem(te.encode('a'.repeat(3000)), 3);
  assert.equal(run(q, 0, long, 50000000, 0, true, K.ABNF_MIN_WORDS), -1, 'the minimum cap stops it');
  assert.ok(run(q, 0, long, 50000000) >= 0, 'the default cap answers');
  stats.memoryCap = `stopped at the cap with budget to spare (of 200 M): ${spent.join('; ')}; max reruns of any run ${stats.maxReruns}`;
}

// ---------------------------------------------------------------- 6. JS == Rust
const rr = spawnSync(bin, [], { input: rustIn.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 28 });
assert.equal(rr.status, 0, rr.stderr || rr.error?.message);
const got = rr.stdout.trimEnd().split('\n');
assert.equal(got.length, rustWant.length, 'Rust answered every line');
for (let i = 0; i < got.length; i++) if (got[i] !== rustWant[i]) assert.fail(`JS != Rust at line ${i}: ${rustIn[i].slice(0, 120)} -> JS ${rustWant[i]} Rust ${got[i]}`);

console.log(`  ok hand vectors: ${stats.hand} grammars, ${stats.handCases} cases (kin == oracle == expected)`);
console.log(`  ok oracle differential: ${stats.grammars} random grammars, ${stats.runs} runs (${stats.matched} matched, ${stats.refused} refused, ${stats.budgetSkipped} out of budget/memory, not compared)`);
console.log(`  ok strict parse mode (D340): ${stats.strictRefusals} lenient hand vectors refused by strict (kin == oracle); random grammars ${stats.strictGrammars} accepted by strict and run, ${stats.strictRefused} refused by both; ${stats.strictSame} strict-valid texts prepare the same table in lenient`);
console.log(`  ok rule-first controllers (the D334 extension, lenient mode): ${stats.ruleFirst} accepted by both and run`);
console.log(`  ok mutated grammars, lenient: ${stats.mutants} (${stats.mutantsBothOk} accepted by both, ${stats.mutantsBothRefused} refused by both); strict: ${stats.mutantsStrictOk} accepted by both, ${stats.mutantsStrictRefused} refused by both; ${stats.mutantRuns} inputs run on them`);
console.log(`  ok budget sweeps: ${stats.sweeps} (room u - 1 stops, room u answers; a scratch grown from 16 words == default; ${stats.grown} growths in all)`);
console.log(`  ok memory cap: ${stats.memoryCap}`);
for (const t of timing) console.log(`  ok pathological ${t.name}: ${t.r === -1 ? 'budget' : t.r >= 0 ? 'match' : 'refused'} in ${t.ms} ms (${t.units} units, ${t.nsPerUnit} ns/unit); budget 50 M: ${t.unbounded === -1 ? 'stopped (budget/memory cap)' : t.unbounded >= 0 ? 'match' : 'refused'} in ${t.msUnbounded} ms`);
console.log(`  ok JS == Rust: ${got.length} answers (${rustIn.filter(l => l[0] === 'P').length} prepares, ${rustIn.filter(l => l[0] === 'R').length} runs); largest scratch ${scratchMax} words`);
