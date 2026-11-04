// The deterministic preset against an independent decoder/encoder (P7.1): cbor2 2.4.1 (bench/compare/node_modules,
// MIT, hildjj/cbor2) in its CDE mode (draft-ietf-cbor-cde) plus rejectDuplicateKeys, rejectLongLoundNaN and
// rejectSimple ("C1"), and C1 + rejectLongFloats ("C2"). cbor2 is not a dependency of snug: absent, this module
// reports SKIP. Every disagreement on ACCEPTANCE must fall in a documented class (docs/profiles.md, "Against cbor2"):
//
//   tag         snug's tag content checks (RFC 8949 standard tags, RFC 8746 typed-array lengths, 55799 only at the
//               top, D121/D180) where cbor2 accepts (cbor2 checks few contents); under the any-tag level snug refuses
//               no tag number cbor2 accepts (both refuse the invalid 65535, 2^32-1, 2^64-1)
//   cbor2tags   a tag whose content snug does not check (D180), refused by one of cbor2's own tag decoders (33
//               base64url, ...): confirmed when cbor2 accepts the same bytes with ignoreGlobalTags
//   tag24       a tag-24 payload that is not one valid item (cbor2 does not look inside)
//   floatwidth  a non-shortest float: cbor2 checks widths only under rejectLongFloats (C2), which also refuses
//               integral floats (a dCBOR rule RFC 8949 §4.2.1 does not have); confirmed by C2
//   intfloat    an integral float (f93c00): RFC 8949 §4.2.1 admits it, cbor2 C2 refuses it
//   nan         a float16 NaN with the sign bit set: RFC 8949 §4.2.2's canonical NaN is 0x7e00 only
//   snugtags    snug's content rules for the tags both presets keep (2/3 bignum length, 4, 40, typed arrays)
//   limits      snug's default resource limits
//   cbor2tag1   cbor2's tag-1 decoder needs a JS number: an epoch integer beyond ±(2^53-1) (RFC 8949 §3.4.2 admits
//               any integer) throws "Expected number"
//
// Anything else is UNEXPLAINED and fails the gate. Encoding: snug encode() and cbor2 encode({cde: true}) must give
// the same bytes for every generated value of the shared value model (no typed arrays, no tags).
import { existsSync } from 'node:fs';

const CBOR2 = new URL('../../bench/compare/node_modules/cbor2/lib/index.js', import.meta.url);

export async function loadCbor2() {
  if (!existsSync(CBOR2)) return null;
  return import(CBOR2.href);
}

const C1 = { cde: true, rejectDuplicateKeys: true, rejectLongLoundNaN: true, rejectSimple: true };
const C2 = { ...C1, rejectLongFloats: true };

function verdict(cbor2, bytes, opts) {
  try { return { ok: true, value: cbor2.decode(bytes, opts) }; } catch (e) { return { ok: false, why: String(e.message) }; }
}
function hasTag(v, n, seen = new Set()) {
  if (v === null || typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  if (v.constructor?.name === 'Tag' && Number(v.tag) === n) return true;
  if (v instanceof Map) { for (const [k, x] of v) if (hasTag(k, n, seen) || hasTag(x, n, seen)) return true; return false; }
  if (Array.isArray(v)) return v.some(x => hasTag(x, n, seen));
  if (v.constructor?.name === 'Tag') return hasTag(v.contents, n, seen);
  if (ArrayBuffer.isView(v)) return false;
  return Object.values(v).some(x => hasTag(x, n, seen));
}

// The tags whose content snug checks under the any-tag level (D121, D180): a `tag` refusal at any other tag is
// unexplained (snug would refuse a tag number cbor2 accepts).
const RULED = new Set([0, 1, 24, 32, 55799, 64, 65, 66, 67, 68, 73, 74, 75, 80, 81, 82, 83, 87]);
function tagHasRule(bytes, at) {
  const ai = bytes[at] & 31;
  if (ai >= 27) return false;
  const n = ai < 24 ? ai : ai === 24 ? bytes[at + 1] : ai === 25 ? bytes[at + 1] * 256 + bytes[at + 2]
    : ((bytes[at + 1] << 24) | (bytes[at + 2] << 16) | (bytes[at + 3] << 8) | bytes[at + 4]) >>> 0;
  return RULED.has(n);
}

/** Acceptance differential over cases decoded with the deterministic preset at default options. snug(bytes) answers
 * {code, offset}. Returns {compared, agree, classes: {name: count}, unexplained: [label...]}. */
export function acceptanceDiff(cbor2, cases, snug) {
  const out = { compared: 0, agree: 0, classes: {}, unexplained: [] };
  const note = (k) => { out.classes[k] = (out.classes[k] ?? 0) + 1; };
  for (const c of cases) {
    const s = snug(c.bytes), a = verdict(cbor2, c.bytes, C1);
    out.compared++;
    if ((s.code === 'ok') === a.ok) {
      // both accept, or both refuse; for floats C1 cannot tell, so a C1 accept of a snug refusal is handled below
      out.agree++; continue;
    }
    const b = c.bytes[s.offset];
    if (s.code !== 'ok') {
      if (s.code === 'tag' && b >> 5 === 6 && tagHasRule(c.bytes, s.offset)) { note('tag'); continue; }
      if (['bignum', 'decimal', 'typed_array', 'ndarray'].includes(s.code)) { note('snugtags'); continue; }
      if (['depth', 'too_many_items', 'too_many_entries', 'too_large'].includes(s.code)) { note('limits'); continue; }
      if (s.code === 'float' && b === 0xf9 && (c.bytes[s.offset + 1] & 0xfc) === 0xfc) { note('nan'); continue; }
      if (s.code === 'non_shortest' && b >= 0xf9 && b <= 0xfb) {
        const v2 = verdict(cbor2, c.bytes, C2);
        if (!v2.ok) { note('floatwidth'); continue; }
      }
      if (hasTag(a.value, 24)) { note('tag24'); continue; }
    } else {
      if (/^Expected number/.test(a.why)) { note('cbor2tag1'); continue; }
      if (verdict(cbor2, c.bytes, { ...C1, ignoreGlobalTags: true }).ok) { note('cbor2tags'); continue; }
      const v2 = verdict(cbor2, c.bytes, C2);
      if (/Should have been encoded as int/.test(a.why) || (v2.ok === false && /Should have been encoded as int/.test(v2.why))) { note('intfloat'); continue; }
    }
    out.unexplained.push(`${c.label}: snug ${s.code}@${s.offset}, cbor2 ${a.ok ? 'accepts' : a.why}`);
  }
  return out;
}

class TagMark { constructor(n, v) { this.n = n; this.v = v; } }

/** Encoding differential: seeded values of the shared value model through snug encode (deterministic preset) and
 * cbor2's CDE encoder. Returns {values, equal, differ: [description...]}. With `tagged` ({Tagged}: snug's class) the
 * model also holds tags of rule-free numbers (D180, 64-bit ones too): snug Tagged against cbor2 Tag. */
export function encodeDiff(cbor2, encode, n, seed, tagged = null) {
  let s = (seed * 2654435761) >>> 0 || 1;
  const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const ri = k => Math.floor(r() * k);
  const pick = a => a[ri(a.length)];
  const NUM = [0, 1, -1, 23, 24, -25, 255, 256, 65535, 65536, 2 ** 32, -(2 ** 32) - 1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER,
    1.5, -4.1, 1.1, 1e300, 5.960464477539063e-8, 3.4028234663852886e38, 65504, 2 ** 53, 2 ** 60, -0, NaN, Infinity, -Infinity, 0.1, 1e-310];
  const BIG = [2n ** 64n - 1n, -(2n ** 64n), 2n ** 63n, -(2n ** 63n) - 1n];
  const TXT = ['', 'a', 'é', '水', '😀', 'key', '￿', 'x'.repeat(40)];
  function value(d) {
    if (tagged && d < 3 && r() < 0.15) {
      const n = pick([5, 16, 17, 18, 61, 96, 97, 98, 21, 22, 23, 256, 1000, 65534, 65536, 2 ** 32 - 2, 2 ** 32, 2 ** 40, 2n ** 63n, 2n ** 64n - 2n]);
      return new TagMark(n, value(d + 1));
    }
    switch (ri(d > 2 ? 6 : 9)) {
      case 0: return pick(NUM);
      case 1: return pick(BIG);
      case 2: return pick(TXT);
      case 3: return pick([null, true, false, undefined]);
      case 4: return new Uint8Array(ri(5)).map(() => ri(256));
      case 5: return pick(NUM);
      case 6: return Array.from({ length: ri(4) }, () => value(d + 1));
      case 7: { const o = {}; for (let i = ri(4); i > 0; i--) o[pick(TXT) + ri(9)] = value(d + 1); return o; }
      default: {
        const m = new Map();
        for (let i = ri(5); i > 0; i--) m.set(pick([() => pick(TXT) + ri(5), () => ri(40) - 20, () => pick(BIG), () => pick([1.5, -0.5, NaN])])(), value(d + 1));
        return m;
      }
    }
  }
  // Tags as marks, turned into each library's class per side (keys never hold one).
  const side = (v, mk) => {
    if (v instanceof TagMark) return mk(v.n, side(v.v, mk));
    if (Array.isArray(v)) return v.map(x => side(x, mk));
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, side(x, mk)]));
    if (v !== null && typeof v === 'object' && !ArrayBuffer.isView(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = side(x, mk); return o; }
    return v;
  };
  const out = { values: 0, equal: 0, tags: 0, differ: [] };
  for (let i = 0; i < n; i++) {
    const v = value(0);
    let marks = 0;
    const vs = tagged ? side(v, (t, x) => { marks++; return new tagged.Tagged(t, x); }) : v, vc = tagged ? side(v, (t, x) => new cbor2.Tag(t, x)) : v;
    if (marks) out.tags++;
    let a, b;
    try { a = Buffer.from(encode(vs)).toString('hex'); } catch (e) { a = 'ERR ' + e.code; }
    try { b = Buffer.from(cbor2.encode(vc, { cde: true })).toString('hex'); } catch (e) { b = 'ERR ' + e.message.slice(0, 40); }
    out.values++;
    if (a === b) out.equal++; else out.differ.push(`value ${i}: snug ${a.slice(0, 60)} | cbor2 ${b.slice(0, 60)}`);
  }
  return out;
}
