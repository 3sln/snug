/** P9.8 follow-up: `.regexp` differential (snug's default XSD dialect, D242/D243).
 * bb regexp-diff [--patterns=120] [--seed=0x5eed9898] [--timeout=20000]
 *
 * 1. corpus/conformance/xsd-regexp.json: every case and every invalid pattern.
 *    Snug is checked against the file's hand-derived XSD verdicts (the
 *    independent check); the Ruby cddl gem 0.12.14 and the cddl crate 0.10.7
 *    are recorded beside it.
 * 2. Seeded generated patterns over {a, b, c} using only constructs whose
 *    meaning XSD, ECMAScript `v`, Onigmo and Rust `regex` share (literals,
 *    simple classes, groups, `|`, `? * +`, `{n}`, `{n,}`, `{n,m}`). Snug is
 *    checked against Node's RegExp (`v`, anchored over the whole text).
 *
 * Oracles: RUBY_CDDL (default .cache/oracles/ruby-cddl.sh), CDDL_NATIVE
 * (default .cache/oracles/cddl-rs/bin/cddl); see corpus/tools/ORACLES.md.
 * A missing oracle fails the run. Evidence: .cache/regexp-diff/.
 * Exit 1 on a snug difference, an unclassified oracle difference, or an
 * oracle that gives no answer at all.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compile } from '../../host/js/src/schema.mjs';
import { tables } from '../../host/js/src/unicode-tables.mjs';
import { encode } from '../../host/js/src/encode.mjs';
import { selfWatch } from '../../kin/scripts/watchdog.mjs';
selfWatch('regexp-diff', import.meta.url);

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(x => {
  if (!/^--(?:patterns|seed|timeout)=.+$/.test(x)) throw Error('Use --patterns=, --seed=, --timeout=');
  const i = x.indexOf('='); return [x.slice(2, i), x.slice(i + 1)];
}));
const nGen = Number(args.patterns ?? 120), seed = Number(args.seed ?? 0x5eed9898), timeout = Number(args.timeout ?? 20000);
if (![nGen, seed, timeout].every(Number.isSafeInteger) || nGen < 0 || seed <= 0 || seed > 0xffffffff || timeout < 1) throw Error('Invalid numeric argument');
const ruby = process.env.RUBY_CDDL ?? root + '.cache/oracles/ruby-cddl.sh';
const crate = process.env.CDDL_NATIVE ?? root + '.cache/oracles/cddl-rs/bin/cddl';
for (const [name, p] of [['RUBY_CDDL', ruby], ['CDDL_NATIVE', crate]]) if (!existsSync(p)) throw Error(`${name} oracle missing: ${p} (rebuild per corpus/tools/ORACLES.md)`);
const cache = root + '.cache/regexp-diff/';
rmSync(cache, { recursive: true, force: true }); mkdirSync(cache, { recursive: true });
const hex = b => Buffer.from(b).toString('hex');

// The pattern as a CDDL text literal: JSON escapes are RFC 9682 escapes. U+10FFFF
// is outside RFC 8610's NONASCII, so it is written as an escaped surrogate pair.
const literal = p => JSON.stringify(p).replace(/[\u{10fffe}\u{10ffff}]/gu, c => c.split('').map(u => '\\u' + u.charCodeAt(0).toString(16)).join(''));
const schemaOf = p => `r = tstr .regexp ${literal(p)}\n`;

// Ruby: one process per pattern; `vv` prints "<file>:" then "ann: true|false" per
// instance on stderr. Only those lines are read (the gem echoes values otherwise).
function rubyRun(dir, files) {
  return new Promise(resolve => execFile(ruby, [dir + 's.cddl', 'vv', ...files.map(f => dir + f)], { timeout, killSignal: 'SIGKILL', maxBuffer: 8 << 20 }, (err, _out, errText) => {
    const got = {}; let cur = null;
    for (const line of String(errText).split('\n')) {
      const f = files.find(f => line === dir + f + ':'); if (f) { cur = f; continue; }
      const m = /^ann: (true|false)$/.exec(line); if (m && cur) { got[cur] = m[1] === 'true'; cur = null; }
    }
    const status = err ? (err.killed ? 'timeout' : err.code) : 0;
    const exception = /\b([A-Z]\w*(?:Error|Exception))\b/.exec(String(errText))?.[1];
    resolve(files.map(f => f in got ? { kind: 'verdict', ok: got[f] } : status === 65 ? { kind: 'schema-error' } : status === 'timeout' ? { kind: 'timeout' } : { kind: 'exception', what: exception ?? 'status ' + status }));
  }));
}
// The crate CLI: one process per instance, explicit success/failure lines (ORACLES.md).
function crateRun(dir, file) {
  const p = spawnSync(crate, ['validate', '--cddl', dir + 's.cddl', '--cbor', dir + file], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', env: { ...process.env, RUST_BACKTRACE: '0' } });
  const out = ((p.stdout ?? '') + (p.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, '');
  if (p.error?.code === 'ETIMEDOUT') return { kind: 'timeout' };
  if (/panicked at/.test(out) || p.signal) return { kind: 'panic' };
  if (/parsing error|error parsing|ParserError/i.test(out)) return { kind: 'schema-error' };
  if (/\[INFO\] Validation of .* is successful/.test(out)) return { kind: 'verdict', ok: true };
  // An invalid pattern surfaces at validation time as "regex parse error" (or
  // "malformed regex" for lookaround); a non-match as "expected … to match regex".
  if (/\[ERROR\] Validation of .* failed:/.test(out)) return /regex parse error|malformed regex/.test(out) ? { kind: 'schema-error' } : { kind: 'verdict', ok: false };
  return { kind: 'unknown' };
}

let state = seed;
const rand = n => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % n; };
const choose = xs => xs[rand(xs.length)];
function genPattern(depth = 0) {
  const atom = () => depth < 2 && !rand(4) ? '(' + genPattern(depth + 1) + ')' : choose(['a', 'b', 'c', '[ab]', '[^a]', '[a-b]', '[bc]', 'a', 'b']);
  const quant = () => choose(['', '', '', '?', '*', '+', `{${rand(3)}}`, `{${rand(2)},}`, (n => `{${n},${n + rand(3)}}`)(rand(3))]);
  const branch = () => Array.from({ length: 1 + rand(3) }, () => atom() + quant()).join('');
  return Array.from({ length: 1 + (rand(4) ? 0 : 1 + rand(2)) }, branch).join('|');
}
const genText = () => Array.from({ length: rand(7) }, () => choose(['a', 'b', 'c'])).join('');

const suites = [];
const x = JSON.parse(readFileSync(root + 'corpus/conformance/xsd-regexp.json'));
for (const c of x.cases) suites.push({ source: 'xsd', name: c.name, pattern: c.pattern, node: c.node, unicode: c.unicode, texts: [...c.accept.map(t => [t, true]), ...c.reject.map(t => [t, false])] });
for (const p of x.invalid) suites.push({ source: 'xsd-invalid', name: p, pattern: p, invalid: true, texts: [['a', undefined], ['', undefined]] });
for (let i = 0; i < nGen; i++) {
  const pattern = genPattern(), re = new RegExp(`^(?:${pattern})$`, 'v');
  const texts = [...new Set(Array.from({ length: 10 }, genText))].slice(0, 8);
  suites.push({ source: 'generated', name: `generated-${i}`, pattern, node: pattern, texts: texts.map(t => [t, re.test(t)]) });
}

const rows = [], summary = { seed, generatedPatterns: nGen, patterns: 0, texts: 0, snugDiffs: 0, refusals: { snug: 0, ok: 0 }, ruby: {}, crate: {}, classes: {} };
const tally = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
const verdictKey = v => v.kind === 'verdict' ? (v.ok ? 'accept' : 'refuse') : v.kind;
const jobs = [];
for (const [si, su] of suites.entries()) {
  const dir = `${cache}${si}/`; mkdirSync(dir);
  writeFileSync(dir + 's.cddl', schemaOf(su.pattern));
  let schema = null, refusal = null;
  try { schema = await compile(schemaOf(su.pattern), { unicode: tables }); } catch (e) { refusal = e.code ?? e.name; }
  summary.patterns++;
  if (su.invalid) { tally(summary.refusals, refusal === 'regexp' ? 'ok' : 'snug'); if (refusal !== 'regexp') summary.snugDiffs++; }
  else if (refusal) { summary.snugDiffs++; rows.push({ ...su, texts: undefined, snugRefusal: refusal, snugBug: true }); continue; }
  const files = su.texts.map((_, i) => `t${i}.cbor`);
  su.texts.forEach(([t], i) => writeFileSync(dir + files[i], encode(t, { top: 'any' })));
  jobs.push({ su, dir, files, schema, refusal });
}
// Ruby processes four at a time.
const rubyOut = new Map();
for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map(async j => rubyOut.set(j, await rubyRun(j.dir, j.files))));

function classify(r) {
  const ruby = verdictKey(r.ruby), crateV = verdictKey(r.crate);
  const want = r.expect === undefined ? 'refuse-schema' : r.expect ? 'accept' : 'refuse';
  const out = {};
  for (const [who, v] of [['ruby', ruby], ['crate', crateV]]) {
    if (r.source === 'xsd-invalid') { out[who] = v === 'schema-error' || v === 'exception' ? null : CLASS[who].invalid(r); continue; }
    if (v === want) { out[who] = null; continue; }
    out[who] = CLASS[who].valid(r, v);
  }
  return out;
}
// Closed routing: a new difference is UNCLASSIFIED and fails the run. The
// reasons are in corpus/conformance/crate-diff-findings.md ("regexp").
const SUBTRACTION = ['class subtraction', 'nested subtraction', 'negated subtrahend', 'empty difference', 'empty difference under star', 'category subtraction'];
const CLASS_ESCAPES = ['whitespace', 'nonwhitespace', 'decimal digits', 'nondigits', 'word excludes P Z C', 'nonword', 'escape union in class'];
const XML_NAMES = ['XML names', 'NameStart complement', 'NameChar complement', 'name class subtraction'];
const CATEGORIES = ['letter category', 'category complement', 'surrogates are empty', 'surrogate complement'];
const byName = (table, n) => Object.entries(table).find(([, names]) => names.includes(n))?.[0];
// The crate's find semantics: its verdict is an unanchored search. Checked, not
// assumed, with the case's Node `v` translation (the pattern itself when generated).
const unanchored = r => r.crate.kind === 'verdict' && r.crate.ok && r.expect === false && r.node !== undefined && new RegExp(r.node, 'v').test(r.text);
const CLASS = {
  // Ruby: Regexp.new("\\A(?:#{pattern})\\z") in Onigmo (Ruby 2.6.10).
  ruby: {
    invalid: () => 'invalid-xsd-admitted',
    valid: r => byName({ 'anchor-metacharacters': ['whole-string and literal assertions'], 'dot-matches-cr': ['dot excludes LF and CR'],
      'no-class-subtraction': SUBTRACTION, 'host-class-escapes': CLASS_ESCAPES, 'no-xml-name-escapes': XML_NAMES,
      'repetition-limit': ['large epsilon quantifier'] }, r.name) ?? 'UNCLASSIFIED',
  },
  // The crate: regex::Regex::new(format_regex(pattern)).is_match(text), where
  // format_regex drops the backslash before every non-meta character but `d`.
  crate: {
    invalid: () => 'invalid-xsd-admitted',
    valid: (r, v) => {
      if (unanchored(r)) return 'unanchored';
      if (r.source === 'generated') return 'UNCLASSIFIED';
      if (r.name === 'dot excludes LF and CR' && r.text === '\r') return 'dot-matches-cr';
      return byName({ 'anchor-metacharacters': ['whole-string and literal assertions'], 'no-class-subtraction': SUBTRACTION,
        'escape-stripped': ['single character escapes', ...CLASS_ESCAPES, ...XML_NAMES, ...CATEGORIES],
        'repetition-limit': ['large epsilon quantifier'] }, r.name) ?? 'UNCLASSIFIED';
    },
  },
};

for (const j of jobs) {
  const rv = rubyOut.get(j);
  j.su.texts.forEach(([text, expect], i) => {
    const snug = j.schema ? j.schema.validate(encode(text, { top: 'any' }), 'r', { top: 'any' }).ok : undefined;
    const r = { source: j.su.source, name: j.su.name, pattern: j.su.pattern, node: j.su.node, text, hex: hex(encode(text, { top: 'any' })), expect, snug, snugRefusal: j.refusal, ruby: rv[i], crate: crateRun(j.dir, j.files[i]) };
    if (!j.su.invalid && snug !== expect) { r.snugBug = true; summary.snugDiffs++; }
    r.class = classify(r);
    summary.texts++;
    tally(summary.ruby, verdictKey(r.ruby) + (r.class.ruby ? ' (differs)' : ''));
    tally(summary.crate, verdictKey(r.crate) + (r.class.crate ? ' (differs)' : ''));
    for (const who of ['ruby', 'crate']) if (r.class[who]) tally(summary.classes, `${who}: ${r.class[who]}`);
    rows.push(r);
  });
}
writeFileSync(cache + 'results.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(cache + 'summary.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
const unclassified = Object.keys(summary.classes).some(k => /UNCLASSIFIED/.test(k));
const silent = rows.some(r => r.ruby && ['unknown', 'timeout'].includes(r.ruby.kind) || r.crate && ['unknown', 'timeout'].includes(r.crate.kind));
console.log(`regexp-diff: ${summary.patterns} patterns, ${summary.texts} texts; snug differences ${summary.snugDiffs}; ${unclassified ? 'UNCLASSIFIED oracle differences' : 'every oracle difference classified'}${silent ? '; an oracle gave no answer' : ''}`);
if (summary.snugDiffs || unclassified || silent) process.exitCode = 1;
