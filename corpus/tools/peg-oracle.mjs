/** Independent, direct RFC 8610 / architecture §20 interpreter. No production matcher imports. */
import { decode as baselineDecode } from '../../bench/baseline/cbor-3sln.mjs';

const utf8 = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const UNKNOWN = Symbol('unknown');
const FAIL = Symbol('fail'), CUT = Symbol('cut'), COMMITTED = Symbol('fail!');
const controls = new Set('size bits lt le gt ge eq ne and within regexp cbor cborseq default feature plus cat det'.split(' '));
const I = value => ({ kind: 'int', value: BigInt(value) });
const F = (value, width = 64, bits) => ({ kind: 'float', value, width, bits });
const literal = value => ({ k: 'lit', value });
const sequence = xs => xs.length === 1 ? xs[0] : ({ k: 'seq', xs });
const choice = (k, xs) => xs.length === 1 ? xs[0] : ({ k, xs });
function fault(code, offset) { throw Object.assign(new Error(code), { code, offset }); }
function compare(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
function concat(xs) { return Uint8Array.from(xs.flatMap(x => Array.from(x))); }
function head(major, n) {
  n = BigInt(n);
  if (n < 0n || n >= 1n << 64n) fault('integer_range');
  if (n < 24n) return Uint8Array.of(major * 32 + Number(n));
  const size = n <= 255n ? 1 : n <= 65535n ? 2 : n <= 0xffffffffn ? 4 : 8;
  const out = new Uint8Array(size + 1); out[0] = major * 32 + 24 + Math.log2(size);
  for (let i = size; i > 0; i--, n >>= 8n) out[i] = Number(n & 255n);
  return out;
}
function halfValue(bits) {
  const sign = bits & 0x8000 ? -1 : 1, exp = bits >> 10 & 31, frac = bits & 1023;
  return exp === 31 ? frac ? NaN : sign * Infinity : sign * (exp ? (1024 + frac) * 2 ** (exp - 25) : frac * 2 ** -24);
}
function halfBits(value) {
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0, v = Math.abs(value);
  if (v === Infinity) return sign | 0x7c00;
  if (v === 0) return sign;
  const exp = Math.floor(Math.log2(v));
  if (exp < -14) { const f = v * 2 ** 24; return Number.isInteger(f) && f <= 1023 ? sign | f : null; }
  if (exp > 15) return null;
  const f = (v / 2 ** exp - 1) * 1024;
  return Number.isInteger(f) && f >= 0 && f < 1024 ? sign | (exp + 15) << 10 | f : null;
}
function floatBytes(v, ec) {
  // For NaNs, preserve the significand, zero-extended on the right (§19.2).
  if (Number.isNaN(v.value)) {
    const width = v.width ?? 64, fracWidth = width === 16 ? 10 : width === 32 ? 23 : 52;
    let bits = v.bits ?? (width === 16 ? 0x7e00n : width === 32 ? 0x7fc00000n : 0x7ff8000000000000n);
    const frac = bits & ((1n << BigInt(fracWidth)) - 1n);
    const fraction = frac << BigInt(52 - fracWidth);
    const w = (fraction & ((1n << 42n) - 1n)) === 0n ? 16 : (fraction & ((1n << 29n) - 1n)) === 0n ? 32 : 64;
    const fw = w === 16 ? 10 : w === 32 ? 23 : 52;
    bits = (fraction >> BigInt(52 - fw)) | ((1n << BigInt(w - fw - 1)) - 1n) << BigInt(fw);
    if (!ec && (v.bits ?? 0n) >> BigInt(width - 1)) bits |= 1n << BigInt(w - 1);
    const out = new Uint8Array(w / 8 + 1); out[0] = w === 16 ? 0xf9 : w === 32 ? 0xfa : 0xfb;
    for (let i = out.length - 1; i > 0; i--, bits >>= 8n) out[i] = Number(bits & 255n);
    return out;
  }
  const value = ec && v.value === 0 ? 0 : v.value, h = halfBits(value);
  if (h !== null) return Uint8Array.of(0xf9, h >> 8, h & 255);
  const small = Object.is(Math.fround(value), value), out = new Uint8Array(small ? 5 : 9);
  out[0] = small ? 0xfa : 0xfb;
  new DataView(out.buffer)[small ? 'setFloat32' : 'setFloat64'](1, value);
  return out;
}
/** Canonical bytes for EC key comparison, including nested maps and NaN payloads. */
export function ecBytes(value) { return canonical(fromJS(value), true); }
function canonical(v, ec) {
  switch (v.kind) {
    case 'int': return head(v.value < 0n ? 1 : 0, v.value < 0n ? -1n - v.value : v.value);
    case 'float': return floatBytes(v, ec);
    case 'text': { const b = utf8.encode(v.value); return concat([head(3, b.length), b]); }
    case 'bytes': return concat([head(2, v.value.length), v.value]);
    case 'simple': return head(7, v.value);
    case 'tag': return concat([head(6, v.tag), canonical(v.item, ec)]);
    case 'array': return concat([head(4, v.items.length), ...v.items.map(x => canonical(x, ec))]);
    case 'map': {
      const pairs = v.pairs.map(([k, x]) => [canonical(k, ec), canonical(x, ec)]);
      if (ec) pairs.sort((a, b) => compare(a[0], b[0]));
      return concat([head(5, pairs.length), ...pairs.flat()]);
    }
    default: fault('value_kind');
  }
}
function fromJS(v) {
  if (v && typeof v === 'object' && typeof v.kind === 'string') return v;
  if (typeof v === 'bigint') return representedInteger(I(v));
  if (typeof v === 'number') return Number.isSafeInteger(v) && !Object.is(v, -0) ? I(v) : F(v);
  if (typeof v === 'string') return { kind: 'text', value: v };
  if (v instanceof Uint8Array) return { kind: 'bytes', value: v };
  if (Array.isArray(v)) return { kind: 'array', items: v.map(fromJS) };
  if (v === null || v === undefined || typeof v === 'boolean') return { kind: 'simple', value: v === false ? 20 : v === true ? 21 : v === null ? 22 : 23 };
  if (v instanceof Map) return { kind: 'map', pairs: Array.from(v, ([k, x]) => [fromJS(k), fromJS(x)]) };
  if (v && (Object.getPrototypeOf(v) === null || Object.getPrototypeOf(v) === Object.prototype))
    return { kind: 'map', pairs: Object.entries(v).map(([k, x]) => [fromJS(k), fromJS(x)]) };
  fault('value_kind');
}
function representedInteger(v) {
  if (v.kind !== 'int' || v.value >= -(1n << 64n) && v.value < 1n << 64n) return v;
  let n = v.value < 0n ? -1n - v.value : v.value;
  const bytes = []; while (n) { bytes.push(Number(n & 255n)); n >>= 8n; }
  return { kind: 'tag', tag: v.value < 0n ? 3n : 2n, item: { kind: 'bytes', value: Uint8Array.from(bytes.reverse()) } };
}
function numeric(v, tick = () => {}) {
  if (v.kind === 'int' || v.kind === 'float') return v;
  if (v.kind === 'tag' && (v.tag === 2n || v.tag === 3n) && v.item.kind === 'bytes') {
    let n = 0n; for (const b of v.item.value) { tick(); n = (n << 8n) + BigInt(b); }
    return I(v.tag === 2n ? n : -1n - n);
  }
  return null;
}

class Decoder {
  constructor(bytes, tick = () => {}) { this.b = bytes; this.p = 0; this.tick = tick; }
  take(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.b.length - this.p) fault('truncated');
    const out = this.b.slice(this.p, this.p + n); this.p += n; return out;
  }
  item(depth = 0) {
    this.tick(); if (depth > 512) throw UNKNOWN;
    const initial = this.take(1)[0], m = initial >> 5, ai = initial & 31;
    if (ai >= 28 && ai <= 30 || ai === 31 && ![2, 3, 4, 5].includes(m)) fault('malformed');
    let n = BigInt(ai);
    if (ai >= 24 && ai <= 27) { n = 0n; for (const b of this.take(2 ** (ai - 24))) n = n * 256n + BigInt(b); }
    if (m === 0 || m === 1) return I(m === 0 ? n : -1n - n);
    if (m === 7) {
      if (ai === 24 && n < 32n) fault('malformed');
      if (ai < 25) return { kind: 'simple', value: Number(n) };
      const width = ai === 25 ? 16 : ai === 26 ? 32 : 64;
      const bytes = new Uint8Array(width / 8); let bits = n;
      for (let i = bytes.length - 1; i >= 0; i--, bits >>= 8n) bytes[i] = Number(bits & 255n);
      const view = new DataView(bytes.buffer);
      return F(width === 16 ? halfValue(Number(n)) : width === 32 ? view.getFloat32(0) : view.getFloat64(0), width, n);
    }
    if (m === 6) return { kind: 'tag', tag: n, item: this.item(depth + 1) };
    const indefinite = ai === 31, length = Number(n);
    if (!indefinite && (!Number.isSafeInteger(length) || length > this.b.length - this.p)) fault('truncated');
    if (m === 2 || m === 3) {
      const chunks = [];
      if (!indefinite) chunks.push(this.take(length));
      else {
        while (this.b[this.p] !== 255) {
          if (this.p >= this.b.length) fault('truncated');
          if (this.b[this.p] >> 5 !== m || (this.b[this.p] & 31) === 31) fault('malformed_chunk');
          const chunk = this.item(depth + 1);
          chunks.push(m === 2 ? chunk.value : utf8.encode(chunk.value));
        }
        this.p++;
      }
      const bytes = concat(chunks);
      return { kind: m === 2 ? 'bytes' : 'text', value: m === 2 ? bytes : textDecoder.decode(bytes) };
    }
    const items = [];
    for (let i = 0; indefinite ? this.b[this.p] !== 255 : i < length; i++) {
      if (this.p >= this.b.length) fault('truncated');
      if (m === 4) items.push(this.item(depth + 1));
      else items.push([this.item(depth + 1), this.item(depth + 1)]);
    }
    if (indefinite) this.p++;
    if (m === 4) return { kind: 'array', items };
    const keys = items.map(([k]) => ecBytes(k)).sort(compare);
    for (let i = 1; i < keys.length; i++) if (compare(keys[i - 1], keys[i]) === 0) fault('duplicate_key');
    return { kind: 'map', pairs: items };
  }
}
function baselineValues(wire, value) {
  // Baseline erases tag wrappers. Keep those from the independent wire walk.
  if (wire.kind === 'tag') return wire;
  if (wire.kind === 'array') return { ...wire, items: wire.items.map((x, i) => baselineValues(x, value[i])) };
  if (wire.kind === 'map') return { ...wire, pairs: wire.pairs.map(([k, x]) => [k, baselineValues(x, value[k.value])]) };
  if (['int', 'float', 'text', 'bytes'].includes(wire.kind)) return { ...wire, value: wire.kind === 'int' ? BigInt(value) : value };
  return wire;
}
/** Baseline first (top:any); independent RFC 8949 decoder on refusal. Returns kind-preserving items. */
export function decode(bytes) {
  if (!(bytes instanceof Uint8Array)) fault('bytes_required');
  let baseline, accepted = false;
  try { baseline = baselineDecode(bytes, { top: 'any' }); accepted = true; } catch { /* valid CBOR may exceed Bindle */ }
  const reader = new Decoder(bytes), wire = reader.item();
  if (reader.p !== bytes.length) fault('trailing');
  return accepted ? baselineValues(wire, baseline) : wire;
}
export function decodeSequence(bytes, tick) {
  const reader = new Decoder(bytes, tick), items = [];
  while (reader.p < bytes.length) items.push(reader.item());
  return { kind: 'array', items };
}

// Small lexer/parser written from RFC 9682 Appendix A, not the existing oracle.
function stringToken(source, start, quote) {
  let out = '', i = start + 1;
  while (i < source.length) {
    let c = source[i++];
    if (c === quote) return { value: out, end: i };
    if (c === '\\') {
      c = source[i++];
      const escapes = { '"': '"', "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (c === 'u') {
        let hex; const braced = source[i] === '{';
        if (braced) { const end = source.indexOf('}', i); if (end < 0) fault('syntax', i); hex = source.slice(i + 1, end); i = end + 1; }
        else { hex = source.slice(i, i + 4); i += 4; }
        if (!(braced ? /^[0-9a-fA-F]+$/ : /^[0-9a-fA-F]{4}$/).test(hex)) fault('syntax', i);
        let cp = parseInt(hex, 16); if (cp > 0x10ffff) fault('syntax', i);
        if (cp >= 0xd800 && cp <= 0xdfff) {
          if (braced || cp >= 0xdc00 || source.slice(i, i + 2) !== '\\u') fault('syntax', i);
          const low = source.slice(i + 2, i + 6);
          if (!/^[dD][c-fC-F][\da-fA-F]{2}$/.test(low)) fault('syntax', i);
          cp = 0x10000 + (cp - 0xd800) * 1024 + parseInt(low, 16) - 0xdc00; i += 6;
        }
        out += String.fromCodePoint(cp);
      } else if (Object.hasOwn(escapes, c) && (c !== "'" || quote === "'")) out += escapes[c];
      else fault('syntax', i);
    } else {
      const cp = c.codePointAt(0);
      if (cp < 32 && !(quote === "'" && (c === '\n' || c === '\r')) || cp >= 127 && cp <= 159) fault('syntax', i);
      out += c;
    }
  }
  fault('syntax', start);
}
function hexFloat(s) {
  const m = /^(-?)0x([\da-f]+)(?:\.([\da-f]+))?p([+-]?\d+)$/i.exec(s);
  const coefficient = BigInt('0x' + m[2] + (m[3] ?? '')), sign = m[1] ? -1 : 1;
  if (coefficient === 0n) return sign * 0;
  const exponent = BigInt(m[4]) - 4n * BigInt(m[3]?.length ?? 0), length = coefficient.toString(2).length;
  const highest = BigInt(length - 1) + exponent;
  if (highest > 1023n) return sign * Infinity;
  if (highest < -1075n) return sign * 0;
  const unit = Math.max(-1074, length + Number(exponent) - 53), shift = unit - Number(exponent);
  let rounded;
  if (shift <= 0) rounded = coefficient << BigInt(-shift);
  else {
    rounded = coefficient >> BigInt(shift);
    const remainder = coefficient - (rounded << BigInt(shift)), half = 1n << BigInt(shift - 1);
    if (remainder > half || remainder === half && (rounded & 1n)) rounded++;
  }
  return sign * Number(rounded) * 2 ** unit;
}
function tokens(source) {
  const out = []; let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source[i] === ';') { while (i < source.length && source[i] !== '\n') i++; continue; }
    const start = i, rest = source.slice(i);
    const prefix = /^(h|b64)?'/i.exec(rest);
    if (source[i] === '"' || prefix) {
      const quote = source[i] === '"' ? '"' : "'", qualifier = prefix?.[1]?.toLowerCase();
      const s = stringToken(source, i + (qualifier?.length ?? 0), quote); i = s.end;
      if (!s.value.isWellFormed()) fault('syntax', start);
      let value;
      if (quote === '"') value = { kind: 'text', value: s.value };
      else if (qualifier === 'h') {
        const hex = s.value.replace(/\s/g, ''); if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) fault('syntax', start);
        value = { kind: 'bytes', value: Uint8Array.from(Buffer.from(hex, 'hex')) };
      } else if (qualifier === 'b64') {
        const b64 = s.value.replace(/\s/g, ''); if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64) || b64.replace(/=/g, '').length % 4 === 1) fault('syntax', start);
        value = { kind: 'bytes', value: Uint8Array.from(Buffer.from(b64, 'base64')) };
      } else value = { kind: 'bytes', value: utf8.encode(s.value) };
      out.push({ text: 'literal', value, start }); continue;
    }
    if (source[i] === '#') {
      const match = /^#([0-7])?(?:\.(0x[\da-fA-F]+|0b[01]+|\d+))?/.exec(rest);
      i += match[0].length; out.push({ text: 'head', major: match[1] === undefined ? null : +match[1], arg: match[2] === undefined ? null : BigInt(match[2]), start }); continue;
    }
    const op = /^(?:\/\/=|\/\=|\/\/|\.\.\.|\.\.|=>)/.exec(rest);
    if (op) { out.push({ text: op[0], start }); i += op[0].length; continue; }
    const number = /^-?(?:0x[\da-fA-F]+(?:\.[\da-fA-F]+)?p[+-]?\d+|0x[\da-fA-F]+|0b[01]+|(?:0|[1-9]\d*)(?:\.(?!\.)\d+)?(?:e[+-]?\d+)?)/i.exec(rest);
    if (number) {
      const s = number[0]; let value;
      if (/p/i.test(s)) value = F(hexFloat(s));
      else if (!/^(-?0[xb])/i.test(s) && /[.e]/i.test(s)) value = F(Number(s));
      else value = I(s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s));
      out.push({ text: 'literal', value, start, end: start + s.length }); i += s.length; continue;
    }
    const id = /^[$@A-Za-z_][$@A-Za-z_\d.-]*/.exec(rest);
    if (id) { out.push({ text: id[0], id: true, start }); i += id[0].length; continue; }
    if ('=/:,?*+()[]{}~&^<>.'.includes(source[i])) { out.push({ text: source[i++], start }); continue; }
    fault('syntax', start);
  }
  out.push({ text: 'EOF', start: i }); return out;
}
class Parser {
  constructor(text) { this.ts = tokens(text); this.p = 0; }
  peek(s) { return this.ts[this.p].text === s; }
  eat(s) { if (this.peek(s)) { this.p++; return true; } return false; }
  take(s) { const t = this.ts[this.p]; if (s !== undefined && t.text !== s) fault('syntax', t.start); this.p++; return t; }
  name() { if (!this.ts[this.p].id) fault('syntax', this.ts[this.p].start); return this.take().text; }
  file() {
    const rules = new Map();
    while (!this.peek('EOF')) {
      const name = this.name(), params = [];
      if (this.eat('<')) { do { params.push(this.name()); } while (this.eat(',')); this.take('>'); }
      const op = this.take().text; if (!['=', '/=', '//='].includes(op)) fault('syntax');
      let body = this.entry();
      if (body.k === 'entry') body = body.t;
      if (op === '//=' && !isGroup(body)) body = sequence([{ k: 'entry', t: body }]);
      const old = rules.get(name);
      if (old && op === '=') fault('duplicate_rule');
      if (old && old.params.join() !== params.join()) fault('generic_arity');
      if (old) body = choice(op === '//=' ? 'gchoice' : 'tchoice', [old.body, body]);
      rules.set(name, { params, body });
    }
    return rules;
  }
  type() { const xs = [this.type1()]; while (this.eat('/')) xs.push(this.type1()); return choice('tchoice', xs); }
  type1() {
    let a = this.primary();
    // The grammar permits one operator; nested operators require parentheses.
    if (this.peek('..') || this.peek('...')) { const op = this.take().text; a = { k: 'range', a, b: this.primary(), inclusive: op === '..' }; }
    else if (this.eat('.')) { const op = this.name(); if (!controls.has(op)) fault('unsupported_control'); a = { k: 'control', op, a, b: this.primary() }; }
    return a;
  }
  reference() {
    const name = this.name(), args = [];
    if (this.eat('<')) { do { args.push(this.type1()); } while (this.eat(',')); this.take('>'); }
    return { k: 'name', name, args };
  }
  primary() {
    if (this.peek('literal')) return literal(this.take().value);
    if (this.eat('[')) { const g = this.group(']'); this.take(']'); return { k: 'array', g }; }
    if (this.eat('{')) { const g = this.group('}'); this.take('}'); return { k: 'map', g }; }
    if (this.eat('(')) {
      const start = this.p;
      try { const t = this.type(); this.take(')'); return t; } catch (e) { if (!e.code) throw e; this.p = start; }
      const g = this.group(')'); this.take(')'); return { k: 'paren', g };
    }
    if (this.eat('~')) return { k: 'unwrap', t: this.reference() };
    if (this.eat('&')) {
      if (this.eat('(')) { const g = this.group(')'); this.take(')'); return { k: 'enum', g }; }
      return { k: 'enum', g: this.reference() };
    }
    if (this.peek('head')) {
      const h = this.take(); let arg = h.arg === null ? null : literal(I(h.arg));
      if (this.eat('.')) {
        if (h.major !== 6 && h.major !== 7) fault('syntax');
        this.take('<'); arg = this.type(); this.take('>');
      }
      if (h.major === 6 && this.eat('(')) { const t = this.type(); this.take(')'); return { k: 'tag', arg, t }; }
      return { k: 'major', major: h.major, arg };
    }
    return this.reference();
  }
  group(end) {
    const alternatives = [];
    do {
      const xs = [];
      while (!this.peek(end) && !this.peek('EOF') && !this.peek('//')) { xs.push(this.entry()); this.eat(','); }
      alternatives.push(sequence(xs));
    } while (this.eat('//'));
    return choice('gchoice', alternatives);
  }
  entry() {
    let lo = 1, hi = 1, occurred = false;
    if (this.eat('?')) { lo = 0; hi = 1; occurred = true; }
    else if (this.eat('+')) { hi = Infinity; occurred = true; }
    else if (this.peek('*') || this.peek('literal') && this.ts[this.p].value.kind === 'int' && this.ts[this.p + 1].text === '*' && this.ts[this.p].end === this.ts[this.p + 1].start) {
      lo = this.peek('*') ? 0 : Number(this.take().value.value); const star = this.take('*');
      hi = this.peek('literal') && this.ts[this.p].value.kind === 'int' && this.ts[this.p].start === star.start + 1 ? Number(this.take().value.value) : Infinity;
      if (lo < 0 || hi < lo) fault('occurrence'); occurred = true;
    }
    lo = Math.min(lo, 2 ** 24); if (hi >= 2 ** 24) hi = Infinity;
    let node;
    if (this.ts[this.p].id && this.ts[this.p + 1].text === ':') {
      const key = literal({ kind: 'text', value: this.take().text }); this.take(':');
      node = { k: 'member', key, t: this.type(), cut: true, lo: 1, hi: 1 };
    } else {
      const a = this.type1();
      if (this.peek(':') || this.peek('^') || this.peek('=>')) {
        const colon = this.eat(':'), cut = colon || this.eat('^'); if (!colon) this.take('=>');
        if (colon && a.k !== 'lit') fault('syntax');
        node = { k: 'member', key: a, t: this.type(), cut, lo: 1, hi: 1 };
      } else {
        const xs = [a]; while (this.eat('/')) xs.push(this.type1());
        node = { k: 'entry', t: choice('tchoice', xs) };
      }
    }
    if (!occurred) return node;
    if (node.k === 'member') return { ...node, lo, hi };
    return { k: 'rep', lo, hi, g: node };
  }
}
function isGroup(n) { return ['seq', 'gchoice', 'member', 'rep', 'paren', 'entry', 'call', 'empty', 'fail'].includes(n.k); }
const PRELUDE = `
any = #
uint = #0 nint = #1 int = uint / nint
bstr = #2 bytes = bstr tstr = #3 text = tstr
tdate = #6.0(tstr) time = #6.1(number) number = int / float
biguint = #6.2(bstr) bignint = #6.3(bstr) bigint = biguint / bignint
integer = int / bigint unsigned = uint / biguint
decfrac = #6.4([e10: int, m: integer]) bigfloat = #6.5([e2: int, m: integer])
eb64url = #6.21(any) eb64legacy = #6.22(any) eb16 = #6.23(any)
encoded-cbor = #6.24(bstr) uri = #6.32(tstr) b64url = #6.33(tstr)
b64legacy = #6.34(tstr) regexp = #6.35(tstr) mime-message = #6.36(tstr)
cbor-any = #6.55799(any)
float16 = #7.25 float32 = #7.26 float64 = #7.27
float16-32 = float16 / float32 float32-64 = float32 / float64
float = float16-32 / float64
false = #7.20 true = #7.21 bool = false / true nil = #7.22 null = nil undefined = #7.23
`;

/** Returns an AST schema or a payload-free {error, offset?}. */
export function compile(text) {
  try {
    if (typeof text !== 'string' || text.length > 1_000_000) fault('compile_limit');
    const definitions = new Parser(PRELUDE).file(), user = new Parser(text).file();
    for (const [name, d] of user) definitions.set(name, d);
    let steps = 0; const instances = new Map();
    function signature(n) {
      return JSON.stringify(n, (_key, value) => {
        if (++steps > 20000) fault('compile_limit');
        if (value?.k === 'ref') return { reference: value.instance };
        if (typeof value === 'bigint') return { bigint: value.toString() };
        if (value instanceof Uint8Array) return { bytes: Array.from(value) };
        return value;
      });
    }
    function link(n, env = new Map()) {
      if (++steps > 20000) fault('compile_limit');
      if (n.k === 'name') {
        if (env.has(n.name)) { if (n.args.length) fault('generic_arity'); return env.get(n.name); }
        const d = definitions.get(n.name);
        if (!d) { if (n.name.startsWith('$')) return { k: 'fail', group: n.name.startsWith('$$') }; fault('undefined_rule'); }
        const args = n.args.map(x => link(x, env)); if (args.length !== d.params.length) fault('generic_arity');
        const key = n.name + ':' + args.map(signature).join(',');
        if (key.length > 100000) fault('compile_limit');
        if (instances.has(key)) return instances.get(key);
        const ref = { k: 'ref', name: n.name, instance: key, body: null }; instances.set(key, ref);
        ref.body = link(d.body, new Map(d.params.map((p, i) => [p, args[i]]))); return ref;
      }
      const out = { ...n };
      for (const key of ['t', 'g', 'key', 'a', 'b', 'arg']) if (n[key]) out[key] = link(n[key], env);
      if (n.xs) out.xs = n.xs.map(x => link(x, env));
      return out;
    }
    const rules = new Map();
    for (const [name, d] of definitions) if (!d.params.length) rules.set(name, link({ k: 'name', name, args: [] }));
    function deref(n, seen = new Set()) {
      while (n.k === 'ref') { if (seen.has(n)) fault('left_recursion'); seen.add(n); n = n.body; } return n;
    }
    const groups = new Map();
    function group(n, context) {
      let cache = groups.get(n); if (!cache) groups.set(n, cache = new Map());
      if (cache.has(context)) return cache.get(context);
      const out = { k: 'call', body: null }; cache.set(context, out);
      if (n.k === 'ref' && isGroup(deref(n))) out.body = group(n.body, context);
      else if (n.k === 'paren') out.body = group(n.g, context);
      else if (n.k === 'entry') out.body = group(n.t, context);
      else if (n.k === 'seq' || n.k === 'gchoice') out.body = { k: n.k, xs: n.xs.map(x => group(x, context)) };
      else if (n.k === 'rep') out.body = n.hi === 0 ? { k: 'empty' } : { ...n, g: group(n.g, context) };
      else if (n.k === 'member') out.body = context === 'map' ? n.hi === 0 ? { k: 'empty' } : n : { k: 'rep', lo: n.lo, hi: n.hi, g: { k: 'entry', t: n.t } };
      else if (n.k === 'fail' && n.group) out.body = { k: 'fail' };
      else if (n.k === 'unwrap') {
        function unwrap(t) {
          t = deref(t);
          if (t.k === 'tchoice') return { k: 'gchoice', xs: t.xs.map(unwrap) };
          if (t.k === 'array' || t.k === 'map') return group(t.g, context);
          if (t.k === 'tag') { if (context === 'map') fault('map_key'); return { k: 'entry', t: t.t }; }
          fault('unwrap_type');
        }
        out.body = unwrap(n.t);
      } else { if (context === 'map') fault('map_key'); out.body = { k: 'entry', t: n }; }
      return out;
    }
    const visited = new Set(), groupRoots = [];
    function visit(n) {
      if (visited.has(n)) return; visited.add(n);
      if (n.k === 'map' || n.k === 'array') { n.group = group(n.g, n.k); groupRoots.push(n.group); }
      for (const key of ['body', 't', 'g', 'key', 'a', 'b', 'arg']) if (n[key]) visit(n[key]);
      if (n.xs) n.xs.forEach(visit);
    }
    rules.forEach(visit);
    // Least fixed point for empty success, then detect cycles reachable before consumption.
    const nodes = new Set();
    function collect(n) { if (nodes.has(n)) return; nodes.add(n); if (n.body) collect(n.body); if (n.g) collect(n.g); if (n.xs) n.xs.forEach(collect); }
    groupRoots.forEach(collect);
    const nullable = new Set(); let changed = true;
    while (changed) {
      changed = false;
      for (const n of nodes) {
        const yes = n.k === 'empty' || n.k === 'member' && n.lo === 0 || n.k === 'rep' && (n.lo === 0 || nullable.has(n.g)) || n.k === 'call' && nullable.has(n.body) || n.k === 'seq' && n.xs.every(x => nullable.has(x)) || n.k === 'gchoice' && n.xs.some(x => nullable.has(x));
        if (yes && !nullable.has(n)) { nullable.add(n); changed = true; }
      }
    }
    const active = new Set(), done = new Set();
    function noLeft(n) {
      if (active.has(n)) fault('left_recursion'); if (done.has(n)) return; active.add(n);
      if (n.k === 'call') noLeft(n.body);
      if (n.k === 'rep' && n.hi) noLeft(n.g);
      if (n.k === 'gchoice') n.xs.forEach(noLeft);
      if (n.k === 'seq') for (const child of n.xs) { noLeft(child); if (!nullable.has(child)) break; }
      active.delete(n); done.add(n);
    }
    for (const n of nodes) noLeft(n);
    // Type recursion may only cross a container/tag boundary.
    const typeDone = new Set(), typeActive = new Set();
    function noTypeLeft(n) {
      if (typeActive.has(n)) fault('left_recursion'); if (typeDone.has(n)) return; typeActive.add(n);
      if (n.k === 'ref' && !isGroup(deref(n))) noTypeLeft(n.body);
      if (n.k === 'tchoice') n.xs.forEach(noTypeLeft);
      if (n.k === 'control' || n.k === 'range') { noTypeLeft(n.a); noTypeLeft(n.b); }
      typeActive.delete(n); typeDone.add(n);
    }
    for (const n of visited) if (!isGroup(n)) noTypeLeft(n);
    return { rules, root: user.keys().next().value, group };
  } catch (e) {
    return { error: e.code ?? (e instanceof RangeError ? 'compile_limit' : 'syntax'), ...(e.offset === undefined ? {} : { offset: e.offset }) };
  }
}

// Equality for .eq/.ne differs from EC: IEEE NaN is never equal, including in composites.
function equal(a, b, topNumeric = false, tick = () => {}) {
  tick();
  if (topNumeric) { const x = numeric(a, tick), y = numeric(b, tick); if (x && y) return x.value == y.value; }
  a = representedInteger(a); b = representedInteger(b);
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'int': case 'float': case 'text': case 'simple': return a.value === b.value;
    case 'bytes': return compare(a.value, b.value) === 0;
    case 'tag': return a.tag === b.tag && equal(a.item, b.item, false, tick);
    case 'array': return a.items.length === b.items.length && a.items.every((x, i) => equal(x, b.items[i], false, tick));
    case 'map': return a.pairs.length === b.pairs.length && a.pairs.every(([k, v]) => b.pairs.some(([l, w]) => equal(k, l, false, tick) && equal(v, w, false, tick)));
    default: return false;
  }
}

/** check(schema, rule, decodedValue, {cuts, steps}) -> true | false | 'unknown'.
 *  cuts (D301): 'rfc' (default; the literal RFC 8610 cut as commitment epochs) or 'branch' (rule A). */
export function check(schema, rule, value, { cuts = 'rfc', steps = 100000 } = {}) {
  if (!['rfc', 'branch'].includes(cuts)) throw new TypeError(`cuts: 'rfc' or 'branch' (D301), not ${String(cuts)}`);
  if (!schema?.rules || !schema.rules.has(rule)) return 'unknown';
  let remaining = steps;
  const tick = () => { if (--remaining < 0) throw UNKNOWN; };
  function deref(t) { while (t.k === 'ref') { tick(); t = t.body; } return t; }
  function constants(t) {
    tick(); t = deref(t);
    if (t.k === 'lit') return [t.value];
    if (t.k === 'tchoice') return t.xs.flatMap(constants);
    if (t.k === 'major' && t.major === 7 && t.arg) return constants(t.arg).filter(v => v.kind === 'int' && (v.value < 24n || v.value >= 32n && v.value <= 255n)).map(v => ({ kind: 'simple', value: Number(v.value) }));
    if (t.k === 'array') {
      function list(g) {
        tick(); g = deref(g);
        if (g.k === 'seq') return g.xs.flatMap(list);
        if (g.k === 'paren') return list(g.g);
        if (g.k === 'entry') return [singleton(g.t)];
        if (g.k === 'member' && g.lo === 1 && g.hi === 1) return [singleton(g.t)];
        if (!isGroup(g)) return [singleton(g)];
        throw UNKNOWN;
      }
      return [{ kind: 'array', items: list(t.g) }];
    }
    if (t.k === 'map') {
      function pairs(g) {
        tick(); g = deref(g);
        if (g.k === 'seq') return g.xs.flatMap(pairs);
        if (g.k === 'paren') return pairs(g.g);
        if (g.k === 'entry') return pairs(g.t);
        if (g.k === 'member' && g.lo === 1 && g.hi === 1) return [[singleton(g.key), singleton(g.t)]];
        throw UNKNOWN;
      }
      return [{ kind: 'map', pairs: pairs(t.g) }];
    }
    if (t.k === 'tag') return [{ kind: 'tag', tag: singleton(t.arg).value, item: singleton(t.t) }];
    if (t.k === 'range') {
      const a = singleton(t.a), b = singleton(t.b);
      if (a.kind !== 'int' || b.kind !== 'int') throw UNKNOWN;
      const end = b.value - (t.inclusive ? 0n : 1n);
      if (end - a.value > 4096n) throw UNKNOWN;
      const out = []; for (let i = a.value; i <= end; i++) { tick(); out.push(I(i)); } return out;
    }
    if (t.k === 'control' && ['plus', 'cat', 'det'].includes(t.op)) {
      const out = [];
      for (const a of constants(t.a)) for (const b of constants(t.b)) {
        tick();
        if (t.op === 'plus') {
          if (!['int', 'float'].includes(a.kind) || !['int', 'float'].includes(b.kind)) throw UNKNOWN;
          out.push(a.kind === 'int' ? I(a.value + (b.kind === 'int' ? b.value : BigInt(Math.floor(b.value)))) : F(a.value + Number(b.value)));
        } else {
          const bytes = v => v.kind === 'text' ? utf8.encode(v.value) : v.kind === 'bytes' ? v.value : (() => { throw UNKNOWN; })();
          const dedent = v => {
            const s = textDecoder.decode(bytes(v)), lines = s.split('\n');
            const nonblank = lines.filter(x => /[^ ]/.test(x));
            const n = nonblank.length ? Math.min(...nonblank.map(x => /^ */.exec(x)[0].length)) : Infinity;
            return utf8.encode(lines.map(x => x.slice(Math.min(n, /^ */.exec(x)[0].length))).join('\n'));
          };
          const joined = concat(t.op === 'det' ? [dedent(a), dedent(b)] : [bytes(a), bytes(b)]);
          out.push({ kind: a.kind, value: a.kind === 'text' ? textDecoder.decode(joined) : joined });
        }
      }
      return out;
    }
    throw UNKNOWN;
  }
  function singleton(t) { const xs = constants(t); if (xs.length !== 1) throw UNKNOWN; return xs[0]; }
  function enumeration(g, v) {
    tick(); g = deref(g);
    if (g.k === 'seq' || g.k === 'gchoice') return g.xs.some(x => enumeration(x, v));
    if (g.k === 'paren' || g.k === 'rep') return enumeration(g.g, v);
    if (g.k === 'entry') return enumeration(g.t, v);
    if (g.k === 'member') return type(g.t, v);
    if (g.k === 'fail') return false;
    return type(g, v);
  }
  function type(t, v) {
    tick();
    if (t.k === 'ref') return type(t.body, v);
    if (t.k === 'fail') return false;
    if (t.k === 'lit') return equal(t.value, v, false, tick);
    if (t.k === 'tchoice') return t.xs.some(x => type(x, v));
    if (t.k === 'enum') return enumeration(t.g, v);
    if (t.k === 'unwrap') {
      const u = deref(t.t); if (u.k === 'tag') return type(u.t, v); throw UNKNOWN;
    }
    if (t.k === 'major') {
      if (t.major === null) return true;
      const major = { int: v.value < 0n ? 1 : 0, bytes: 2, text: 3, array: 4, map: 5, tag: 6, float: 7, simple: 7 }[v.kind];
      if (major !== t.major) return false;
      if (!t.arg) return true;
      const arg = v.kind === 'float' ? v.width === 16 ? 25 : v.width === 32 ? 26 : 27 : v.kind === 'simple' ? v.value : v.kind === 'tag' ? v.tag : v.kind === 'int' ? v.value < 0n ? -1n - v.value : v.value : v.kind === 'text' ? utf8.encode(v.value).length : v.kind === 'bytes' ? v.value.length : v.kind === 'array' ? v.items.length : v.pairs.length;
      if (t.major < 6) {
        // For majors 0–5 the suffix is AI, unlike tag/simple head numbers.
        // Match values representable with that AI, independent of input spelling.
        const ai = singleton(t.arg); if (ai.kind !== 'int') throw UNKNOWN;
        if (ai.value < 24n) return BigInt(arg) === ai.value;
        if (ai.value <= 27n) return BigInt(arg) < 1n << (8n * (1n << (ai.value - 24n)));
        return ai.value === 31n && t.major >= 2;
      }
      return type(t.arg, I(arg));
    }
    if (t.k === 'tag') return v.kind === 'tag' && (!t.arg || type(t.arg, I(v.tag))) && type(t.t, v.item);
    if (t.k === 'array') return v.kind === 'array' && array(t.group, v.items, 0) === v.items.length;
    if (t.k === 'map') {
      if (v.kind !== 'map') return false;
      const pairs = v.pairs.map(p => ({ pair: p, key: ecBytes(p[0]) })).sort((a, b) => compare(a.key, b.key));
      const ctx = { commits: 0 }; const r = map(t.group, pairs, ctx); return Array.isArray(r) && r.length === 0;
    }
    if (t.k === 'range') {
      const a = singleton(t.a), b = singleton(t.b), n = numeric(v, tick);
      return n && a.kind === b.kind && a.kind === n.kind && n.value >= a.value && (t.inclusive ? n.value <= b.value : n.value < b.value) || false;
    }
    if (t.k === 'control') {
      const op = t.op;
      if (['plus', 'cat', 'det'].includes(op)) return constants(t).some(x => equal(x, v, false, tick));
      if (!type(t.a, v)) return false;
      if (op === 'default' || op === 'feature') return true;
      if (op === 'and' || op === 'within') return type(t.b, v);
      if (op === 'size') {
        if (v.kind === 'text' || v.kind === 'bytes') return type(t.b, I(v.kind === 'text' ? utf8.encode(v.value).length : v.value.length));
        if (v.kind !== 'int' || v.value < 0n) return false;
        const controller = deref(t.b);
        // A single N is a maximum, a range/choice controls the minimal length.
        if (controller.k === 'range' || controller.k === 'tchoice') {
          let n = 0, x = v.value; while (x) { tick(); x >>= 8n; n++; } return type(t.b, I(n));
        }
        const n = singleton(t.b); if (n.kind !== 'int' || n.value < 0n) return false;
        return n.value >= 8n || v.value < 1n << (8n * n.value);
      }
      if (op === 'bits') {
        if (v.kind === 'int' && v.value >= 0n) {
          let x = v.value, n = 0n; while (x) { tick(); if ((x & 1n) && !type(t.b, I(n))) return false; x >>= 1n; n++; } return true;
        }
        if (v.kind === 'bytes') { for (let i = 0; i < v.value.length * 8; i++) { tick(); if ((v.value[i >> 3] & 1 << (i & 7)) && !type(t.b, I(i))) return false; } return true; }
        return false;
      }
      if (['lt', 'le', 'gt', 'ge', 'eq', 'ne'].includes(op)) {
        const b = singleton(t.b);
        if (op === 'eq' || op === 'ne') return equal(v, b, true, tick) === (op === 'eq');
        const n = numeric(v, tick), bound = numeric(b, tick);
        if (!n || !bound) return false;
        return op === 'lt' ? n.value < bound.value : op === 'le' ? n.value <= bound.value : op === 'gt' ? n.value > bound.value : n.value >= bound.value;
      }
      if (op === 'regexp') {
        const pattern = singleton(t.b); if (v.kind !== 'text' || pattern.kind !== 'text') return false;
        try { return new RegExp('^(?:' + pattern.value + ')$(?![\\s\\S])', 'u').test(v.value); } catch { throw UNKNOWN; }
      }
      if (op === 'cbor' || op === 'cborseq') {
        if (v.kind !== 'bytes') return false;
        try {
          const r = new Decoder(v.value, tick), item = op === 'cbor' ? r.item() : decodeSequence(v.value, tick);
          if (op === 'cbor' && r.p !== v.value.length) return false;
          return type(t.b, item);
        } catch (e) { if (e === UNKNOWN || e instanceof RangeError) throw UNKNOWN; return false; }
      }
    }
    throw UNKNOWN;
  }
  function array(g, xs, i) {
    tick();
    switch (g.k) {
      case 'call': return array(g.body, xs, i);
      case 'empty': return i;
      case 'fail': return FAIL;
      case 'entry': return i < xs.length && type(g.t, xs[i]) ? i + 1 : FAIL;
      case 'seq': { let p = i; for (const child of g.xs) { p = array(child, xs, p); if (p === FAIL) break; } return p; }
      case 'gchoice': for (const child of g.xs) { const p = array(child, xs, i); if (p !== FAIL) return p; } return FAIL;
      case 'rep': {
        let p = i, c = 0;
        while (c < g.hi) { const q = array(g.g, xs, p); if (q === FAIL) break; if (q === p) { c = g.hi; break; } p = q; c++; }
        return c >= g.lo ? p : FAIL;
      }
      default: throw UNKNOWN;
    }
  }
  function map(g, pairs, ctx) {
    tick();
    switch (g.k) {
      case 'call': return map(g.body, pairs, ctx);
      case 'empty': return pairs;
      case 'fail': return FAIL;
      case 'member': {
        let c = 0; const taken = new Set();
        for (const p of pairs) {
          tick(); if (c === g.hi) break;
          if (!type(g.key, p.pair[0])) continue;
          if (g.cut && cuts === 'rfc') ctx.commits++;
          if (type(g.t, p.pair[1])) { taken.add(p); c++; }
          else if (g.cut) return cuts === 'branch' ? CUT : COMMITTED;
        }
        return c >= g.lo ? pairs.filter(p => !taken.has(p)) : FAIL;
      }
      case 'seq': { let p = pairs; for (const child of g.xs) { p = map(child, p, ctx); if (!Array.isArray(p)) break; } return p; }
      case 'gchoice': {
        let saw = false;
        for (const child of g.xs) {
          const start = ctx.commits, r = map(child, pairs, ctx);
          if (Array.isArray(r)) return r;
          if (cuts === 'rfc' && (r === COMMITTED || ctx.commits > start)) return COMMITTED;
          if (r === CUT) saw = true;
        }
        return saw ? CUT : FAIL;
      }
      case 'rep': {
        let p = pairs, c = 0;
        while (c < g.hi) {
          const start = ctx.commits, q = map(g.g, p, ctx);
          if (!Array.isArray(q)) {
            if (q === CUT) return CUT;
            if (cuts === 'rfc' && (q === COMMITTED || ctx.commits > start)) return COMMITTED;
            break;
          }
          if (q.length === p.length) { c = g.hi; break; }
          p = q; c++;
        }
        return c >= g.lo ? p : FAIL;
      }
      default: throw UNKNOWN;
    }
  }
  try { return type(schema.rules.get(rule), fromJS(value)); }
  catch (e) { if (e === UNKNOWN || e instanceof RangeError) return 'unknown'; throw e; }
}
