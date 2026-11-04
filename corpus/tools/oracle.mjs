/** Independent, intentionally exponential CDDL reference interpreter.
 * No snug compiler/VM/host imports. The baseline supplies ONLY the CBOR value model.
 * check() accepts profile-decoded values, not arbitrary JS objects or wire bytes.
 * Resource exhaustion is unknown, never false. No diagnostics contain data.
 */
import { encode, decode } from '../../bench/baseline/cbor-3sln.mjs';

export const STEP_LIMIT = 1_000_000;
class Exhausted extends Error {}
const meter = (limit = STEP_LIMIT) => ({ left: limit, tick(n = 1) { this.left -= n; if (this.left < 0) throw new Exhausted(); } });
const utf8 = new TextEncoder();
const literal = (value, float = false) => ({ k: 'lit', value, float });
const entry = value => ({ k: 'entry', value, key: null, cut: false });
const seq = xs => ({ k: 'seq', xs });
const choice = xs => xs.length === 1 ? xs[0] : ({ k: 'choice', xs });
const rep = (x, min, max) => min === 1 && max === 1 ? x : ({ k: 'rep', x, min, max });

// Convert a hexadecimal float with one rounding to binary64, including gradual
// underflow. Number(significand) * 2**exponent would round twice near subnormals.
function hexFloat(raw) {
  const m = /^(-?)0x([0-9a-f]+)(?:\.([0-9a-f]+))?p([+-]?[0-9]+)$/i.exec(raw);
  const digits = m[2] + (m[3] ?? ''), n = BigInt('0x' + digits);
  if (!n) return m[1] ? -0 : 0;
  const exp = Number(m[4]) - 4 * (m[3]?.length ?? 0);
  const top = n.toString(2).length - 1 + exp;
  if (top > 1024) throw Error('float literal');
  if (top < -1075) return m[1] ? -0 : 0;
  const unit = Math.max(top - 52, -1074), shift = exp - unit;
  let rounded;
  if (shift >= 0) rounded = n << BigInt(shift);
  else {
    const down = BigInt(-shift), half = 1n << (down - 1n);
    rounded = n >> down;
    const remainder = n - (rounded << down);
    if (remainder > half || remainder === half && (rounded & 1n)) rounded++;
  }
  const value = Number(rounded) * 2 ** unit;
  if (!Number.isFinite(value)) throw Error('float literal');
  return m[1] ? -value : value;
}
function byteText(raw) {
  // Unqualified byte strings use UTF-8 and the JSON escapes, plus escaped '.
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { out += raw[i]; continue; }
    const c = raw[++i];
    if (c === "'") out += "'";
    else if (c === 'u') { const h = raw.slice(i + 1, i + 5); if (!/^[0-9a-f]{4}$/i.test(h)) throw Error('byte escape'); out += String.fromCharCode(parseInt(h, 16)); i += 4; }
    else { const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }; if (!Object.hasOwn(escapes, c)) throw Error('byte escape'); out += escapes[c]; }
  }
  return out;
}

// The lexer keeps rule boundaries as token positions, not line-based heuristics:
// newlines are whitespace and rules may share a line.
function lex(text, budget) {
  const out = []; let p = 0;
  while (p < text.length) {
    budget.tick();
    const s = text.slice(p); let m;
    if ((m = /^(?:\s+|;[^\r\n]*)/.exec(s))) { p += m[0].length; continue; }
    if ((m = /^(h|b64)?'((?:[^'\\]|\\[\s\S])*)'/.exec(s))) {
      let bytes;
      if (m[1] === 'h') {
        const h = m[2].replace(/\s/g, ''); if (!/^(?:[0-9a-fA-F]{2})*$/.test(h)) throw Error('byte literal');
        bytes = Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16));
      } else if (m[1] === 'b64') {
        const b = m[2].replace(/\s/g, ''); if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b) || b.replace(/=/g, '').length % 4 === 1) throw Error('byte literal');
        bytes = new Uint8Array(Buffer.from(b, 'base64'));
      } else bytes = utf8.encode(byteText(m[2]));
      out.push({ t: 'literal', value: bytes, pos: p }); p += m[0].length; continue;
    }
    if (s[0] === '"') {
      m = /^"(?:[^"\\\r\n]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(s);
      if (!m) throw Error('text literal');
      out.push({ t: 'literal', value: JSON.parse(m[0]), pos: p }); p += m[0].length; continue;
    }
    // A decimal point starts a float only when followed by a digit (not '..').
    if ((m = /^-?0x[0-9a-fA-F]+(?:\.[0-9a-fA-F]+)?[pP][+-]?[0-9]+/.exec(s))) {
      out.push({ t: 'literal', value: hexFloat(m[0]), float: true, raw: m[0], pos: p }); p += m[0].length; continue;
    }
    if ((m = /^-?(?:0x[0-9a-fA-F]+|0b[01]+|[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(s))) {
      const raw = m[0], float = /[.eE]/.test(raw) && !/^-?0x/.test(raw);
      const value = float ? Number(raw) : raw[0] === '-' ? -BigInt(raw.slice(1)) : BigInt(raw);
      if (float && !Number.isFinite(value)) throw Error('float literal');
      out.push({ t: 'literal', value, float, raw, pos: p }); p += raw.length; continue;
    }
    if ((m = /^(?:\$\$?|[A-Za-z_@])(?:[A-Za-z0-9_@$-]|\.(?=[A-Za-z0-9_@$-]))*/.exec(s))) {
      out.push({ t: 'id', value: m[0], pos: p }); p += m[0].length; continue;
    }
    if ((m = /^(?:\/\/=|\/=|\/\/|\.\.\.|\.\.|=>|[=\/{}\[\](),:?*+^~&#.<>])/.exec(s))) {
      out.push({ t: m[0], pos: p }); p += m[0].length; continue;
    }
    throw Error('token');
  }
  out.push({ t: 'EOF', pos: p }); return out;
}
class Parser {
  constructor(text, budget) { this.ts = lex(text, budget); this.p = 0; this.b = budget; }
  at(t) { return this.ts[this.p].t === t; }
  take(t) { this.b.tick(); if (!this.at(t)) return false; return this.ts[this.p++]; }
  need(t) { const x = this.take(t); if (!x) throw Error('expected ' + t); return x; }
  newRule() {
    if (!this.at('id')) return false;
    let q = this.p + 1;
    if (this.ts[q].t === '<') { let d = 1; while (d && this.ts[++q]) { if (this.ts[q].t === '<') d++; if (this.ts[q].t === '>') d--; } q++; }
    return ['=', '/=', '//='].includes(this.ts[q]?.t);
  }
  rules() {
    const rules = new Map();
    while (!this.at('EOF')) {
      const name = this.need('id').value, params = [];
      if (this.take('<')) { do { params.push(this.need('id').value); } while (this.take(',')); this.need('>'); }
      const op = this.ts[this.p++].t; if (!['=', '/=', '//='].includes(op)) throw Error('rule operator');
      const group = this.group('EOF', true), body = this.asType(group);
      if (op === '=' && rules.has(name)) throw Error('duplicate rule');
      if (op === '=') rules.set(name, { params, body });
      else {
        const old = rules.get(name);
        if (old && old.params.join() !== params.join()) throw Error('generic parameters');
        const addition = op === '/=' ? body : group;
        rules.set(name, { params, body: old ? (op === '/=' ? choice([old.body, addition]) : { k: 'gchoice', xs: [old.body, addition] }) : addition });
      }
    }
    return rules;
  }
  asType(g) { return g.k === 'seq' && g.xs.length === 1 && g.xs[0].k === 'entry' && !g.xs[0].key ? g.xs[0].value : g; }
  group(end, top = false) {
    const alts = []; let xs = [];
    while (!this.at(end) && !this.at('EOF') && !(top && this.newRule())) {
      if (this.take('//')) { alts.push(seq(xs)); xs = []; continue; }
      xs.push(this.groupEntry());
      if (this.take(',')) continue;
      if (!this.at('//')) break;
    }
    alts.push(seq(xs)); return alts.length === 1 ? alts[0] : { k: 'gchoice', xs: alts };
  }
  groupEntry() {
    let min = 1, max = 1;
    if (this.take('?')) { min = 0; max = 1; }
    else if (this.take('+')) { min = 1; max = Infinity; }
    else if (this.take('*')) { min = 0; max = this.adjacentCount() ? this.count() : Infinity; }
    else if (this.at('literal') && typeof this.ts[this.p].value === 'bigint' && this.ts[this.p + 1].t === '*' && this.ts[this.p + 1].pos === this.ts[this.p].pos + this.ts[this.p].raw.length) {
      min = this.count(); this.need('*'); max = this.adjacentCount() ? this.count() : Infinity;
    }
    if (max < min) throw Error('occurrence');
    let x;
    // ':' is syntax: an identifier here is a key name even if a rule has that name.
    if (this.at('id') && this.ts[this.p + 1].t === ':') {
      const key = literal(this.need('id').value); this.need(':'); x = { k: 'entry', key, value: this.type(), cut: true };
    } else {
      const value = this.type();
      const cut = !!this.take('^');
      const arrow = this.take('=>'), colon = !arrow && this.take(':');
      if (arrow || colon) x = { k: 'entry', key: value, value: this.type(), cut: cut || !!colon };
      else { if (cut) throw Error('cut'); x = entry(value); }
    }
    return rep(x, min, max);
  }
  adjacentCount() { return this.at('literal') && typeof this.ts[this.p].value === 'bigint' && this.ts[this.p].pos === this.ts[this.p - 1].pos + 1; }
  count() { const n = this.need('literal').value; if (n < 0n || n > 1000000n) throw Error('occurrence bound'); return Number(n); }
  type() { const xs = [this.type1()]; while (this.take('/')) xs.push(this.type1()); return choice(xs); }
  type1() {
    let x = this.primary();
    while (this.at('..') || this.at('...') || this.at('.')) {
      if (this.take('.')) { const op = this.need('id').value; x = { k: 'control', op, x, y: this.primary() }; }
      else { const exclusive = !!this.take('...'); if (!exclusive) this.need('..'); x = { k: 'range', x, y: this.primary(), exclusive }; }
    }
    return x;
  }
  primary() {
    this.b.tick();
    if (this.at('literal')) { const t = this.ts[this.p++]; return literal(t.value, t.float); }
    if (this.take('[')) { const g = this.group(']'); this.need(']'); return { k: 'array', g }; }
    if (this.take('{')) { const g = this.group('}'); this.need('}'); return { k: 'map', g }; }
    if (this.take('(')) { const g = this.group(')'); this.need(')'); return this.asType(g); }
    if (this.take('~')) return { k: 'unwrap', x: this.primary() };
    if (this.take('&')) return { k: 'enum', x: this.primary() };
    if (this.take('#')) {
      if (!this.at('literal')) return { k: 'any' };
      // '#6.2' is one numeric token; it is a major/tag separator, not a float.
      const token = this.ts[this.p++];
      if (!/^[0-7](?:\.[0-9]+)?$/.test(token.raw)) throw Error('major');
      const parts = token.raw.split('.');
      const major = Number(parts[0]); if (major < 0 || major > 7) throw Error('major');
      let arg = parts.length > 1 ? literal(BigInt(parts[1])) : null;
      if (this.take('.')) { this.need('<'); arg = this.type(); this.need('>'); }
      let content = null;
      if (this.take('(')) { content = this.type(); this.need(')'); }
      if (content && major !== 6) throw Error('tag content');
      return { k: 'major', major, arg, content };
    }
    const name = this.need('id').value, args = [];
    if (this.take('<')) { do { args.push(this.type()); } while (this.take(',')); this.need('>'); }
    return { k: 'ref', name, args };
  }
}

// RFC 8610 Appendix D. Tags outside the strict codec's allow-list are still
// represented faithfully: they simply have no accepting profile value.
export const PRELUDE = `
any = #
uint = #0
nint = #1
int = uint / nint
bstr = #2
bytes = bstr
tstr = #3
text = tstr
tdate = #6.0(tstr)
time = #6.1(number)
number = int / float
biguint = #6.2(bstr)
bignint = #6.3(bstr)
bigint = biguint / bignint
integer = int / bigint
unsigned = uint / biguint
decfrac = #6.4([e10: int, m: integer])
bigfloat = #6.5([e2: int, m: integer])
eb64url = #6.21(any)
eb64legacy = #6.22(any)
eb16 = #6.23(any)
encoded-cbor = #6.24(bstr)
uri = #6.32(tstr)
b64url = #6.33(tstr)
b64legacy = #6.34(tstr)
regexp = #6.35(tstr)
mime-message = #6.36(tstr)
cbor-any = #6.55799(any)
float16 = #7.25
float32 = #7.26
float64 = #7.27
float16-32 = float16 / float32
float32-64 = float32 / float64
float = float16-32 / float64
false = #7.20
true = #7.21
bool = false / true
nil = #7.22
null = nil
undefined = #7.23
`;
const controls = new Set('size bits lt le gt ge eq ne and within default feature regexp cbor cborseq'.split(' '));
export function compile(text) {
  try {
    if (typeof text !== 'string' || text.length > 1_000_000) throw Error('schema size');
    const budget = meter();
    const parse = text => new Parser(text, budget).rules();
    const rules = parse(PRELUDE); for (const [n, r] of parse(text)) rules.set(n, r);
    function inspect(x, params) {
      budget.tick();
      if (x.k === 'ref') {
        if (params.includes(x.name)) { if (x.args.length) throw Error('parameter arguments'); }
        else { const r = rules.get(x.name); if (!r && !x.name.startsWith('$')) throw Error('undefined rule'); if (x.args.length !== (r?.params.length ?? 0)) throw Error('generic arity'); }
      }
      if (x.k === 'control') {
        if (!controls.has(x.op)) throw Error('unsupported control');
        if (x.op === 'regexp' && x.y.k === 'lit' && typeof x.y.value === 'string') x.regex = regexParse(x.y.value, budget);
      }
      for (const v of Object.values(x)) { if (v && typeof v === 'object' && typeof v.k === 'string') inspect(v, params); else if (Array.isArray(v)) for (const a of v) if (a?.k) inspect(a, params); }
    }
    for (const r of rules.values()) inspect(r.body, r.params);
    // Check patterns reached through aliases/generic applications as well as
    // inline literals. Parameter bindings are closures over their caller.
    function operand(x, env, seen = new Set()) {
      budget.tick();
      if (x.k === 'lit') return x.value;
      if (x.k !== 'ref') throw Error('regexp operand');
      if (env.has(x.name)) { const a = env.get(x.name); return operand(a.x, a.env, seen); }
      if (seen.has(x.name)) throw Error('regexp operand');
      const r = rules.get(x.name); if (!r) throw Error('regexp operand');
      const next = new Map(r.params.map((p, i) => [p, { x: x.args[i], env }]));
      return operand(r.body, next, new Set([...seen, x.name]));
    }
    function patterns(x, env, active) {
      budget.tick();
      if (x.k === 'ref') {
        if (env.has(x.name)) { const a = env.get(x.name); return patterns(a.x, a.env, active); }
        if (active.has(x.name)) return; // guarded recursion revisits its definition
        const r = rules.get(x.name); if (!r) return; // undefined socket
        const next = new Map(r.params.map((p, i) => [p, { x: x.args[i], env }]));
        patterns(r.body, next, new Set([...active, x.name])); return;
      }
      if (x.k === 'control' && x.op === 'regexp') {
        const pattern = operand(x.y, env);
        if (typeof pattern !== 'string') throw Error('regexp operand');
        regexParse(pattern, budget);
      }
      for (const v of Object.values(x)) { if (v?.k) patterns(v, env, active); else if (Array.isArray(v)) for (const a of v) if (a?.k) patterns(a, env, active); }
    }
    for (const [name, r] of rules) if (!r.params.length) patterns(r.body, new Map(), new Set([name]));
    return { rules };
  } catch (e) { return { error: e instanceof Exhausted || e instanceof RangeError ? 'compile budget' : e.message }; }
}

// A tiny I-Regexp parser and exhaustive code-point matcher. No host regexp is
// ever run over payload text, so pathological expressions consume our budget.
function regexParse(pattern, b) {
  const cs = [...pattern]; let p = 0;
  const take = c => cs[p] === c && (++p, true);
  function escaped() {
    const c = cs[p++]; if (c === 'n') return '\n'; if (c === 'r') return '\r'; if (c === 't') return '\t';
    if (!c || !'\\|.-^?*+{}()[]$'.includes(c)) throw Error('non-I-Regexp escape'); return c;
  }
  function atom() {
    b.tick(); let x;
    if (take('(')) { if (cs[p] === '?') throw Error('non-I-Regexp group'); x = alt(); if (!take(')')) throw Error('regexp group'); }
    else if (take('[')) {
      const neg = take('^'), ranges = [];
      while (p < cs.length && cs[p] !== ']') {
        const a = take('\\') ? escaped() : cs[p++];
        if (a === '[') throw Error('regexp class');
        let z = a;
        if (cs[p] === '-' && cs[p + 1] !== ']' && p + 1 < cs.length) { p++; z = take('\\') ? escaped() : cs[p++]; if (z === '[' || a.codePointAt(0) > z.codePointAt(0)) throw Error('regexp range'); }
        ranges.push([a.codePointAt(0), z.codePointAt(0)]);
      }
      if (!ranges.length || !take(']')) throw Error('regexp class'); x = { k: 'rchar', ranges, neg };
    } else if (take('.')) x = { k: 'rchar', dot: true };
    else {
      const c = take('\\') ? escaped() : cs[p++];
      if (!c || '*+?{}[]'.includes(c) && cs[p - 2] !== '\\') throw Error('regexp atom');
      x = { k: 'rchar', ranges: [[c.codePointAt(0), c.codePointAt(0)]] };
    }
    if (take('?')) x = { k: 'rrep', x, min: 0, max: 1 };
    else if (take('*')) x = { k: 'rrep', x, min: 0, max: Infinity };
    else if (take('+')) x = { k: 'rrep', x, min: 1, max: Infinity };
    else if (take('{')) {
      const count = () => { let s = ''; while (/[0-9]/.test(cs[p] ?? 'x')) s += cs[p++]; if (!s || Number(s) > 1000000) throw Error('regexp count'); return Number(s); };
      const min = count(); let max = min; if (take(',')) max = cs[p] === '}' ? Infinity : count();
      if (!take('}') || max < min) throw Error('regexp count'); x = { k: 'rrep', x, min, max };
    }
    return x;
  }
  function alt() { const xs = []; do { const ys = []; while (p < cs.length && ![')', '|'].includes(cs[p])) ys.push(atom()); xs.push({ k: 'rseq', xs: ys }); } while (take('|')); return { k: 'ralt', xs }; }
  const out = alt(); if (p !== cs.length) throw Error('regexp syntax'); return out;
}
function regexMatch(ast, text, b) {
  const cs = [...text]; b.tick(cs.length);
  function run(x, i) {
    b.tick();
    if (x.k === 'rchar') {
      if (i === cs.length) return new Set(); const c = cs[i].codePointAt(0);
      const yes = x.dot ? c !== 10 && c !== 13 : x.ranges.some(([a, z]) => { b.tick(); return c >= a && c <= z; }) !== !!x.neg;
      return new Set(yes ? [i + 1] : []);
    }
    if (x.k === 'ralt') return new Set(x.xs.flatMap(y => [...run(y, i)]));
    if (x.k === 'rseq') { let states = new Set([i]); for (const y of x.xs) { const next = new Set(); for (const j of states) for (const k of run(y, j)) next.add(k); states = next; } return states; }
    let states = new Set([i]); const out = new Set();
    const max = Math.min(x.max, x.min + cs.length + 1);
    for (let n = 0; n <= max; n++) {
      b.tick(); if (n >= x.min) for (const j of states) out.add(j);
      const next = new Set(); for (const j of states) for (const k of run(x.x, j)) next.add(k);
      if (!next.size) break;
      // Nullable fixed points can jump to the minimum safely.
      if (next.size === states.size && [...next].every(j => states.has(j))) { if (max >= x.min) for (const j of next) out.add(j); break; }
      states = next;
    }
    return out;
  }
  return run(ast, 0).has(cs.length);
}

// Recover the CBOR structure erased by baseline's convenient wrappers (bignum,
// decimal, ndarray, typed arrays). This is a structural reader of ENCODE output,
// not an alternative profile decoder. Floats retain their encoded width.
function readTree(bytes, budget, start = 0) {
  let p = start;
  function read() {
    budget.tick(); const start = p, head = bytes[p++], major = head >> 5, ai = head & 31;
    if (head === undefined) throw Error('internal CBOR span');
    let arg = BigInt(ai);
    if (ai >= 24 && ai <= 27) { arg = 0n; for (let n = 0; n < 2 ** (ai - 24); n++) { budget.tick(); if (p >= bytes.length) throw Error('internal CBOR span'); arg = arg * 256n + BigInt(bytes[p++]); } }
    if (ai > 27) throw Error('internal CBOR head');
    const node = { major, arg };
    if (major === 0 || major === 1) node.value = major === 0 ? arg : -1n - arg;
    else if (major === 2 || major === 3) { const n = Number(arg); budget.tick(n); if (p + n > bytes.length) throw Error('internal CBOR span'); const raw = bytes.slice(p, p + n); p += n; node.value = major === 2 ? raw : new TextDecoder().decode(raw); }
    else if (major === 4 || major === 5) { node.items = []; for (let n = 0n; n < arg * (major === 5 ? 2n : 1n); n++) node.items.push(read()); }
    else if (major === 6) node.content = read();
    else if (ai >= 25) { node.width = 2 ** (ai - 24); node.value = decode(bytes.slice(start, p), { top: 'any' }); }
    else node.value = ai === 20 ? false : ai === 21 ? true : ai === 22 ? null : undefined;
    node.raw = bytes.slice(start, p); return node;
  }
  const node = read(); return { node, end: p };
}
const intValue = n => {
  if (n.major === 0 || n.major === 1) return n.value;
  if (n.major === 6 && (n.arg === 2n || n.arg === 3n)) { let v = 0n; for (const c of n.content.value) v = v * 256n + BigInt(c); return n.arg === 2n ? v : -1n - v; }
  return null;
};
const numeric = n => intValue(n) ?? (n.major === 7 && n.width ? n.value : null);
const eqBytes = (a, b, budget) => { budget.tick(Math.max(a.length, b.length)); return a.length === b.length && a.every((v, i) => v === b[i]); };

export function check(schema, rule, value, { steps = STEP_LIMIT } = {}) {
  if (!schema?.rules || !schema.rules.has(rule) || schema.rules.get(rule).params.length) return 'unknown';
  const b = meter(steps);
  try {
    const root = readTree(encode(value, { cose: value instanceof Map }), b).node;
    const rules = schema.rules;
    function resolve(x, env) {
      b.tick();
      if (x.k !== 'ref') return [x, env];
      if (env.has(x.name)) { const bound = env.get(x.name); return resolve(bound.x, bound.env); }
      const r = rules.get(x.name);
      // RFC 8610 §3.9: an unplugged socket is an empty type choice / empty group
      // choice -- no alternatives, so nothing matches through it (D251; it was
      // wrongly the empty group, seq([]), which has one empty derivation).
      if (!r) return [x.name.startsWith('$$') ? { k: 'gchoice', xs: [] } : choice([]), env];
      const next = new Map(); for (let i = 0; i < r.params.length; i++) next.set(r.params[i], { x: x.args[i], env });
      return resolve(r.body, next);
    }
    function groupValue(x, env) {
      [x, env] = resolve(x, env);
      if (x.k === 'unwrap') {
        let y; [y, env] = resolve(x.x, env);
        if (y.k === 'choice') return [{ k: 'gchoice', xs: y.xs.map(x => ({ k: 'unwrap', x })) }, env];
        if (!['array', 'map'].includes(y.k)) throw Error('unwrap target');
        return [y.g, env];
      }
      return [x, env];
    }
    function equalLiteral(x, n) {
      if (x.float) return n.major === 7 && !!n.width && Object.is(n.value, x.value);
      if (typeof x.value === 'bigint') return intValue(n) === x.value;
      if (x.value instanceof Uint8Array) return n.major === 2 && eqBytes(x.value, n.value, b);
      return n.value === x.value && (typeof x.value === 'string' ? n.major === 3 : n.major === 7);
    }
    function scalar(x, env) { [x, env] = resolve(x, env); if (x.k === 'lit') return x.value; throw Error('nonliteral operand'); }
    function test(x, n, env = new Map()) {
      b.tick(); [x, env] = resolve(x, env);
      switch (x.k) {
        case 'any': return true;
        case 'lit': return equalLiteral(x, n);
        case 'choice': return x.xs.some(y => test(y, n, env));
        case 'major': {
          if (n.major !== x.major) return false;
          if (x.major === 7 && x.arg) { const wanted = scalar(x.arg, env); return wanted === BigInt(n.width ? ({ 2: 25, 4: 26, 8: 27 })[n.width] : Number(n.arg)); }
          if (x.arg && !test(x.arg, { major: 0, arg: n.arg, value: n.arg }, env)) return false;
          return !x.content || test(x.content, n.content, env);
        }
        case 'range': {
          const v = numeric(n), lo = scalar(x.x, env), hi = scalar(x.y, env);
          // Float ranges and integer ranges stay distinct, as RFC type2 bounds.
          const float = typeof lo === 'number' || typeof hi === 'number';
          if (v === null || (float ? !(n.major === 7 && n.width) : typeof v !== 'bigint')) return false;
          return v >= lo && (x.exclusive ? v < hi : v <= hi);
        }
        case 'array': return n.major === 4 && arrayRun(x.g, n.items, 0, env).has(n.items.length);
        case 'map': return n.major === 5 && mapMatch(x.g, n.items, env);
        case 'enum': return enumValues(x.x, env).some(([y, e]) => test(y, n, e));
        case 'control': return control(x, n, env);
        case 'seq': case 'gchoice': case 'entry': case 'rep': throw Error('group used as type');
        default: throw Error('type expression');
      }
    }
    function enumValues(x, env) {
      b.tick(); [x, env] = groupValue(x, env);
      if (x.k === 'seq' || x.k === 'gchoice') return x.xs.flatMap(y => enumValues(y, env));
      if (x.k === 'rep') return enumValues(x.x, env);
      if (x.k === 'entry') {
        const [y, e] = resolve(x.value, env);
        if (['seq', 'gchoice', 'entry', 'rep'].includes(y.k)) return enumValues(y, e);
        return [[y, e]];
      }
      return [[x, env]];
    }
    function arrayRun(x, items, i, env) {
      b.tick(); [x, env] = groupValue(x, env);
      if (x.k === 'gchoice') return new Set(x.xs.flatMap(y => [...arrayRun(y, items, i, env)]));
      if (x.k === 'seq') {
        let states = new Set([i]);
        for (const y of x.xs) { const next = new Set(); for (const j of states) for (const k of arrayRun(y, items, j, env)) next.add(k); states = next; }
        return states;
      }
      if (x.k === 'entry') {
        const [y, e] = groupValue(x.value, env);
        if (!x.key && ['seq', 'gchoice', 'rep', 'entry'].includes(y.k)) return arrayRun(y, items, i, e);
        return new Set(i < items.length && test(x.value, items[i], env) ? [i + 1] : []);
      }
      if (x.k === 'rep') {
        let states = new Set([i]); const out = new Set(), max = Math.min(x.max, x.min + items.length + 1);
        for (let n = 0; n <= max; n++) {
          b.tick(); if (n >= x.min) for (const j of states) out.add(j);
          const next = new Set(); for (const j of states) for (const k of arrayRun(x.x, items, j, env)) next.add(k);
          if (!next.size) break;
          if (next.size === states.size && [...next].every(j => states.has(j))) { if (max >= x.min) for (const j of next) out.add(j); break; }
          states = next;
        }
        return out;
      }
      return new Set(i < items.length && test(x, items[i], env) ? [i + 1] : []);
    }
    // Expand group repetition literally. Individual entry occurrences retain
    // counters, so optional cut entries are present even when their count is 0.
    function expand(x, env, count) {
      b.tick(); [x, env] = groupValue(x, env);
      if (x.k === 'entry' && !x.key) {
        const [y, e] = groupValue(x.value, env);
        if (['seq', 'gchoice', 'rep', 'entry'].includes(y.k)) return expand(y, e, count);
      }
      if (x.k === 'entry') return [[{ ...x, env, min: 1, max: 1 }]];
      if (x.k === 'gchoice') return x.xs.flatMap(y => expand(y, env, count));
      const product = (as, bs) => { const out = []; for (const a of as) for (const c of bs) { b.tick(a.length + c.length + 1); out.push([...a, ...c]); } return out; };
      if (x.k === 'seq') { let out = [[]]; for (const y of x.xs) out = product(out, expand(y, env, count)); return out; }
      if (x.k === 'rep') {
        let [y, e] = groupValue(x.x, env);
        if (y.k === 'entry') {
          const [z] = groupValue(y.value, e);
          if (y.key || !['seq', 'gchoice', 'rep', 'entry'].includes(z.k)) return [[{ ...y, env: e, min: x.min, max: x.max }]];
        }
        const unit = expand(y, e, count), out = []; let copies = [[]];
        // At most count productive copies; nullable copies can pad the minimum.
        const max = Math.min(x.max, x.min + count);
        for (let n = 0; n <= max; n++) { b.tick(); if (n >= x.min) out.push(...copies); if (n < max) copies = product(copies, unit); }
        return out;
      }
      throw Error('unkeyed map entry');
    }
    function mapMatch(g, items, env) {
      const pairs = []; for (let i = 0; i < items.length; i += 2) pairs.push([items[i], items[i + 1]]);
      for (const alt of expand(g, env, pairs.length)) {
        function assign(pos, remaining) {
          b.tick(); if (pos === alt.length) return !remaining.length;
          const e = alt[pos], eligible = [];
          for (const i of remaining) {
            b.tick(); if (!test(e.key, pairs[i][0], e.env)) continue;
            if (test(e.value, pairs[i][1], e.env)) eligible.push(i);
            else if (e.cut && e.max > 0) return false; // kills this assignment/alternative only
          }
          // Enumerate every subset; deliberately no greedy priority shortcuts.
          function subsets(q, chosen) {
            b.tick(); if (chosen.length > e.max) return false;
            if (q === eligible.length) return chosen.length >= e.min && assign(pos + 1, remaining.filter(i => !chosen.includes(i)));
            return subsets(q + 1, [...chosen, eligible[q]]) || subsets(q + 1, chosen);
          }
          return subsets(0, []);
        }
        if (assign(0, pairs.map((_, i) => i))) return true;
      }
      return false;
    }
    function control(x, n, env) {
      if (!test(x.x, n, env)) return false;
      const op = x.op;
      if (op === 'default' || op === 'feature') return true;
      if (op === 'and' || op === 'within' || op === 'eq') return test(x.y, n, env);
      if (op === 'ne') return !test(x.y, n, env);
      if (['lt', 'le', 'gt', 'ge'].includes(op)) {
        const a = numeric(n), v = scalar(x.y, env); if (a === null || !['bigint', 'number'].includes(typeof v)) return false;
        return op === 'lt' ? a < v : op === 'le' ? a <= v : op === 'gt' ? a > v : a >= v;
      }
      if (op === 'size') {
        if (n.major === 2 || n.major === 3) return test(x.y, { major: 0, arg: n.arg, value: n.arg }, env);
        if (n.major !== 0) return false;
        const [y, e] = resolve(x.y, env);
        if (y.k === 'lit' && typeof y.value === 'bigint') {
          if (y.value < 0n) return false; if (y.value > 1024n) return true;
          return n.value < 256n ** y.value;
        }
        let size = 0n, v = n.value; while (v) { b.tick(); size++; v >>= 8n; }
        return test(y, { major: 0, arg: size, value: size }, e);
      }
      if (op === 'bits') {
        if (n.major !== 0 && n.major !== 2) return false;
        let bytes = n.major === 2 ? n.value : null;
        if (!bytes) { bytes = []; let v = n.value; while (v) { b.tick(); bytes.push(Number(v & 255n)); v >>= 8n; } }
        for (let i = 0; i < bytes.length; i++) for (let j = 0; j < 8; j++) { b.tick(); if (bytes[i] & (1 << j)) { const bit = BigInt(i * 8 + j); if (!test(x.y, { major: 0, arg: bit, value: bit }, env)) return false; } }
        return true;
      }
      if (op === 'regexp') {
        if (n.major !== 3) return false;
        return regexMatch(x.regex ?? regexParse(scalar(x.y, env), b), n.value, b);
      }
      if (op === 'cbor' || op === 'cborseq') {
        if (n.major !== 2) return false;
        const bytes = n.value, nodes = []; let p = 0;
        try {
          while (p < bytes.length) {
            const { end } = readTree(bytes, b, p);
            const v = decode(bytes.slice(p, end), { top: 'any' });
            nodes.push(readTree(encode(v), b).node); p = end;
            if (op === 'cbor' && p !== bytes.length) return false;
          }
        } catch (e) { if (e instanceof Exhausted || e instanceof RangeError) throw e; return false; }
        if (op === 'cbor') return nodes.length === 1 && test(x.y, nodes[0], env);
        return test(x.y, { major: 4, arg: BigInt(nodes.length), items: nodes }, env);
      }
      throw Error('control');
    }
    return test({ k: 'ref', name: rule, args: [] }, root);
  } catch {
    // Exhausted budgets/stacks, an invalid root (e.g. a group rule), or a
    // non-profile host value cannot justify a conformance refusal. Corpus
    // tests require a Boolean and will expose any unexpected unknown.
    return 'unknown';
  }
}
