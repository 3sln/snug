// An independent ABNF membership oracle for the `.abnf` / `.abnfb` gate (P9.14, D334).
// Written apart from kin/abnf.kin, on purpose in another shape. Parsing is line-based:
// comments are stripped and continuation lines joined first, and each logical line is
// tokenised. Matching is a least fixpoint of "ends" sets: for each rule and start
// position, the set of positions where a match can end, iterated to a fixpoint. This
// handles left recursion and empty matches without an Earley chart. It is slow and
// small inputs only; it is a reference, not an engine.
//
// The dialect is snug's (docs/cddl-support.md, D334, D340). By default it is strict:
// RFC 5234 + RFC 7405 strings, RFC 9165 §3's controller (one element, then a newline and
// rules), LF or CRLF newlines (RFC 9165 §3), every line ending with a newline, comments
// of WSP / VCHAR. With { lenient: true }, snug's non-RFC forms are admitted too: the start
// may be an alternation, the text's end ends a line, a comment may hold any scalar but
// CR and LF, the start may be preceded by whitespace, an `=/` may precede its `=`, and a
// controller that begins with a rule starts at that rule. No core rules in either mode.
//
//   parseAbnf(text, { lenient }) -> { ok: true, start, rules } | { ok: false, code }
//   matchAbnf(grammar, symbols: number[]) -> boolean
//   symbolsOf(bytes, mode) -> number[] | null   (mode 'text': scalars, null if not UTF-8;
//                                                mode 'bytes': bytes)

export const CODES = ['syntax', 'prose', 'undefined', 'duplicate', 'incremental', 'nesting', 'utf8',
  // strict only (D340)
  'start_wide', 'rule_first', 'no_eol', 'comment', 'leading', 'order', 'after_start'];

class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
const refuse = code => { throw new Refusal(code); };

/** Logical lines: comments removed (quote-aware), continuation lines joined. */
function logicalLines(text) {
  if (/\r(?!\n)/.test(text)) refuse('syntax');           // a lone CR is never a newline
  const physical = text.split(/\r?\n/);
  const out = [];
  physical.forEach((raw, index) => {
    let line = '', quote = null;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (quote) { line += c; if (c === quote) quote = null; continue; }
      if (c === '"') quote = '"';
      else if (c === '<') quote = '>';
      else if (c === ';') break;                            // the rest is a comment
      line += c;
    }
    // char-val and prose-val hold no line break (RFC 5234 §4)
    if (quote) refuse('syntax');
    // what remains must be ASCII printable or whitespace (comments may hold anything)
    if (/[^\x20-\x7e\t]/.test(line)) refuse('syntax');
    if (index > 0 && /^[ \t]/.test(raw)) {
      if (out.length === 0) refuse('syntax');
      out[out.length - 1] += ' ' + line;                   // a continuation line
    } else out.push(line);
  });
  return out;
}

/** Tokens of one logical line, each with whether whitespace preceded it. */
function tokens(line) {
  const out = [];
  let i = 0, gap = true;
  const take = (type, re) => {
    re.lastIndex = i;
    const m = re.exec(line);
    if (!m || m.index !== i) return false;
    out.push({ type, text: m[0], gap });
    i += m[0].length; gap = false;
    return true;
  };
  while (i < line.length) {
    if (line[i] === ' ' || line[i] === '\t') { i++; gap = true; continue; }
    if (take('name', /[A-Za-z][A-Za-z0-9-]*/y)) continue;
    if (take('repeat', /\d*\*\d*|\d+/y)) continue;
    if (take('string', /%[sSiI]"[\x20\x21\x23-\x7e]*"|"[\x20\x21\x23-\x7e]*"/y)) continue;
    if (take('number', /%[bB][01]+(?:(?:\.[01]+)+|-[01]+)?|%[dD]\d+(?:(?:\.\d+)+|-\d+)?|%[xX][0-9A-Fa-f]+(?:(?:\.[0-9A-Fa-f]+)+|-[0-9A-Fa-f]+)?/y)) continue;
    if (take('prose', /<[^>]*>/y)) continue;
    if (take('defas', /=\/|=/y)) continue;
    if (take('punct', /[()[\]/]/y)) continue;
    refuse('syntax');
  }
  return out;
}

const BIG = 2 ** 31 - 1;
const num = (text, base) => { const v = parseInt(text, base); return v > BIG ? BIG : v; };

/** Parse a token list as an alternation (recursive descent over tokens). */
function parseAlternation(toks, pos, depth) {
  const items = [];
  let [node, p] = parseConcatenation(toks, pos, depth);
  items.push(node);
  while (p < toks.length && toks[p].type === 'punct' && toks[p].text === '/') {
    [node, p] = parseConcatenation(toks, p + 1, depth);
    items.push(node);
  }
  return [items.length === 1 ? items[0] : { t: 'alt', items }, p];
}

function startsRepetition(tok) {
  return tok && (['name', 'repeat', 'string', 'number', 'prose'].includes(tok.type)
    || (tok.type === 'punct' && (tok.text === '(' || tok.text === '[')));
}

function parseConcatenation(toks, pos, depth) {
  const items = [];
  let [node, p] = parseRepetition(toks, pos, depth);
  items.push(node);
  while (startsRepetition(toks[p]) && toks[p].gap) {
    [node, p] = parseRepetition(toks, p, depth);
    items.push(node);
  }
  return [items.length === 1 ? items[0] : { t: 'seq', items }, p];
}

function parseRepetition(toks, pos, depth) {
  const tok = toks[pos];
  if (tok && tok.type === 'repeat') {
    const next = toks[pos + 1];
    if (!next || next.gap) refuse('syntax');
    let min, max;
    if (tok.text.includes('*')) {
      const [a, b] = tok.text.split('*');
      min = a === '' ? 0 : num(a, 10);
      max = b === '' ? Infinity : num(b, 10);
    } else min = max = num(tok.text, 10);
    if (max === BIG) max = Infinity;
    // m < n is valid ABNF (RFC 5234 §4's repeat); no count satisfies both, so it is
    // an empty language (the rep case below)
    const [item, p] = parseElement(toks, pos + 1, depth);
    if (min === 1 && max === 1) return [item, p];
    return [{ t: 'rep', min, max, item }, p];
  }
  return parseElement(toks, pos, depth);
}

function letterTerm(c, sensitive) {
  const code = c.charCodeAt(0);
  if (!sensitive && /[A-Za-z]/.test(c)) return { t: 'term', ranges: [[code & ~32, code & ~32], [code | 32, code | 32]] };
  return { t: 'term', ranges: [[code, code]] };
}

function parseElement(toks, pos, depth) {
  const tok = toks[pos];
  if (!tok) refuse('syntax');
  if (tok.type === 'name') return [{ t: 'ref', name: tok.text.toLowerCase() }, pos + 1];
  if (tok.type === 'prose') refuse('prose');
  if (tok.type === 'string') {
    const sensitive = /^%[sS]/.test(tok.text);
    const body = tok.text.slice(tok.text.indexOf('"') + 1, -1);
    const items = [...body].map(c => letterTerm(c, sensitive));
    return [items.length === 1 ? items[0] : { t: 'seq', items }, pos + 1];
  }
  if (tok.type === 'number') {
    const base = { b: 2, d: 10, x: 16 }[tok.text[1].toLowerCase()];
    const body = tok.text.slice(2);
    if (body.includes('-')) {
      const [a, b] = body.split('-').map(s => num(s, base));
      // a > b is valid ABNF and an empty range: the term test matches nothing
      return [{ t: 'term', ranges: [[a, b]] }, pos + 1];
    }
    const items = body.split('.').map(s => ({ t: 'term', ranges: [[num(s, base), num(s, base)]] }));
    return [items.length === 1 ? items[0] : { t: 'seq', items }, pos + 1];
  }
  if (tok.type === 'punct' && (tok.text === '(' || tok.text === '[')) {
    if (depth >= 256) refuse('nesting');
    const close = tok.text === '(' ? ')' : ']';
    const [inner, p] = parseAlternation(toks, pos + 1, depth + 1);
    if (!toks[p] || toks[p].text !== close) refuse('syntax');
    return [close === ']' ? { t: 'rep', min: 0, max: 1, item: inner } : inner, p + 1];
  }
  refuse('syntax');
}

function refsOf(node, out) {
  if (node.t === 'ref') out.push(node.name);
  for (const x of node.items ?? []) refsOf(x, out);
  if (node.item) refsOf(node.item, out);
  return out;
}

/** A physical line without its comment (quote-aware); strict: the comment holds only
 *  WSP / VCHAR (RFC 5234 §4). */
function stripLine(raw, strict) {
  let line = '', quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) { line += c; if (c === quote) quote = null; continue; }
    if (c === '"') quote = '"';
    else if (c === '<') quote = '>';
    else if (c === ';') { if (strict && /[^\t\x20-\x7e]/.test(raw.slice(i + 1))) refuse('comment'); break; }
    line += c;
  }
  if (quote) refuse('syntax');   // char-val and prose-val hold no line break (RFC 5234 §4)
  if (/[^\x20-\x7e\t]/.test(line)) refuse('syntax');
  return line;
}

/** Strict (D340): the start is one element that ends a physical line, directly followed by
 *  a newline or the end. An element may run over continuation lines (inside a group or
 *  option, RFC 5234's c-wsp), so the shortest run of lines 0..k that is exactly one element,
 *  ending without whitespace or a comment, is the start. Then RFC 5234's rulelist, every
 *  line ending with a newline. Answers [start, rule logical lines]. */
function strictStart(text) {
  if (/\r(?!\n)/.test(text)) refuse('syntax');
  const physical = text.split(/\r?\n/);
  const stripped = physical.map(raw => stripLine(raw, false));
  let start = null, k = 0;
  for (let n = 1; n <= physical.length && !start; n++) {
    if (n > 1 && !/^[ \t]/.test(physical[n - 1])) break;
    const last = physical[n - 1];
    if (/[ \t]$/.test(last) || stripped[n - 1] !== last) continue;
    try {
      const toks = tokens(stripped.slice(0, n).join(' '));
      if (toks.length === 0) continue;
      const [s, p] = parseElement(toks, 0, 0);
      if (p === toks.length) { start = s; k = n; }
    } catch (e) {
      if (!(e instanceof Refusal) || e.code === 'prose' || e.code === 'nesting') throw e;
    }
  }
  if (!start) {
    const first = (() => { try { return tokens(stripped[0]); } catch { return []; } })();
    if (first[0]?.type === 'name' && first[1]?.type === 'defas') refuse('rule_first');
    let element = false;
    try { const t = tokens(stripped[0].trimEnd()); element = t.length > 0 && parseElement(t, 0, 0)[1] === t.length; } catch {}
    refuse(element ? 'after_start' : 'start_wide');
  }
  const out = [];
  for (let i = k; i < physical.length; i++) {
    if (/^[ \t]/.test(physical[i])) {
      if (out.length === 0) { if (stripped[i].trim() !== '') refuse('syntax'); continue; }   // a blank or comment line
      out[out.length - 1] += ' ' + stripped[i];
    } else out.push(stripped[i]);
  }
  // checked after the rules parse, in kin's order: the final newline, then the comments
  const after = () => {
    if (k < physical.length && !text.endsWith('\n')) refuse('no_eol');
    physical.forEach(raw => stripLine(raw, true));
  };
  return [start, out, after];
}

/** Parse an ABNF controller (a JS string): strict RFC 5234 + RFC 7405 + RFC 9165 §3 by
 *  default, or snug's lenient dialect ({ lenient: true }, D340). */
export function parseAbnf(text, { lenient = false } = {}) {
  try {
    if (!lenient) {
      if (/^([ \t]|(;[^\r\n]*)?\r?\n[ \t])/.test(text)) refuse('leading');
      const [s, ruleLines, after] = strictStart(text);
      return finish(s, ruleLines, false, after);
    }
    const lines = logicalLines(text);
    const first = tokens(lines[0]);
    if (first.length === 0) refuse('syntax');
    // RFC 9165's element-first reading is tried first; only when it fails to parse does a
    // first line that is a rule (no start before it) start at that rule (snug's
    // extension, as the cddl crate reads it). kin decides the same by looking ahead for
    // `name *c-wsp "="`, which no element-first controller can begin with; the
    // differential checks the two agree.
    let start, ruleFirst = false;
    try {
      const [s, p0] = parseAlternation(first, 0, 0);
      if (p0 !== first.length) refuse('syntax');
      start = s;
    } catch (e) {
      if (!(e instanceof Refusal) || !(first[0].type === 'name' && first[1]?.type === 'defas')) throw e;
      ruleFirst = true;
      start = { t: 'ref', name: first[0].text.toLowerCase() };
    }
    return finish(start, ruleFirst ? lines : lines.slice(1), true);
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, code: e.code };
    throw e;
  }
}

/** The rule list, merged and checked: one `=` per rule (strict: before any `=/`). */
function finish(start, ruleLines, lenient, afterParse = () => {}) {
  const defs = new Map();   // name -> { eq: count, alts: [], early: an =/ before the = }
  for (const line of ruleLines) {
    const toks = tokens(line);
    if (toks.length === 0) continue;
    if (toks[0].type !== 'name') refuse('syntax');
    if (!toks[1] || toks[1].type !== 'defas') refuse('syntax');
    const [body, p] = parseAlternation(toks, 2, 0);
    if (p !== toks.length) refuse('syntax');
    const name = toks[0].text.toLowerCase();
    const d = defs.get(name) ?? { eq: 0, alts: [], early: false };
    if (toks[1].text === '=') d.eq++; else if (d.eq === 0) d.early = true;
    d.alts.push(body);
    defs.set(name, d);
  }
  afterParse();
  for (const d of defs.values()) if (d.eq === 0) refuse('incremental');
  for (const d of defs.values()) if (d.eq > 1) refuse('duplicate');
  if (!lenient) for (const d of defs.values()) if (d.early) refuse('order');
  const rules = new Map([...defs].map(([n, d]) => [n, d.alts.length === 1 ? d.alts[0] : { t: 'alt', items: d.alts }]));
  for (const body of [start, ...rules.values()])
    for (const r of refsOf(body, [])) if (!rules.has(r)) refuse('undefined');
  return { ok: true, start, rules };
}

/** Is symbols (numbers) in the language of the grammar's start? */
export function matchAbnf(g, sym) {
  const n = sym.length;
  const table = new Map([...g.rules.keys()].map(k => [k, Array.from({ length: n + 1 }, () => new Set())]));
  const step = (node, from) => {
    const out = new Set();
    for (const i of from) for (const j of ends(node, i)) out.add(j);
    return out;
  };
  const ends = (node, i) => {
    switch (node.t) {
      case 'term': return i < n && node.ranges.some(([lo, hi]) => sym[i] >= lo && sym[i] <= hi) ? new Set([i + 1]) : new Set();
      case 'ref': return table.get(node.name)[i];
      case 'alt': { const out = new Set(); for (const x of node.items) for (const j of ends(x, i)) out.add(j); return out; }
      case 'seq': { let s = new Set([i]); for (const x of node.items) s = step(x, s); return s; }
      case 'rep': {
        if (node.max < node.min) return new Set();   // no count is both at least min and at most max
        // S_k: the ends after exactly k repetitions; the answer is the union of S_min..S_max
        let s = new Set([i]);
        for (let k = 0; k < node.min; k++) {
          const nxt = step(node.item, s);
          if (nxt.size === 0) return nxt;
          if (sameSet(nxt, s)) break;          // S is constant from here on
          s = nxt;
        }
        const out = new Set(s);
        if (node.max === Infinity) {             // the closure of S_min under one more repetition
          for (let frontier = s; frontier.size;) {
            const fresh = new Set();
            for (const j of step(node.item, frontier)) if (!out.has(j)) { out.add(j); fresh.add(j); }
            frontier = fresh;
          }
          return out;
        }
        for (let k = node.min; k < node.max; k++) {
          const nxt = step(node.item, s);
          for (const j of nxt) out.add(j);
          if (nxt.size === 0 || sameSet(nxt, s)) break;
          s = nxt;
        }
        return out;
      }
    }
    throw new Error('oracle: bad node');
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, body] of g.rules) {
      const row = table.get(name);
      for (let i = 0; i <= n; i++) {
        for (const j of [...ends(body, i)]) if (!row[i].has(j)) { row[i].add(j); changed = true; }
      }
    }
  }
  return ends(g.start, 0).has(n);
}
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

/** The symbols an `.abnf` (mode 'text') or `.abnfb` (mode 'bytes') match reads. */
export function symbolsOf(bytes, mode) {
  if (mode === 'bytes') return Array.from(bytes);
  try { return Array.from(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), c => c.codePointAt(0)); }
  catch { return null; }
}
