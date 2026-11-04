// The profile-option cases (P7.1, D120-D125), shared by bb scan-test, rscan-test, vm-test and vmsession-test:
// the deterministic vectors (corpus/cbor-vectors/deterministic.json, with their hand-written codes and offsets),
// fixed edge cases of the new rules at the limits, and SEEDED cases under random profile flags: deterministic
// items built at the byte level (any key kind in sorted order, the standard tags with valid and invalid contents,
// RFC floats, undefined, noncharacters), the Bindle vector files' inputs, and byte mutations of all of them.
// buildDetCases(mutations, seed) -> {cases, nVectors, nFixed, det}; a case is
// {label, bytes, opt: {top, cose, maxBytes, maxDepth, maxEntries, maxItems, flags}, want?: {code, offset}}.
// `flags` are the kin profile flags (snug.cbor.codes PF_*): 122 the deterministic preset (any tag, D180), 0 Bindle.
import { readFileSync } from 'node:fs';
import { hex, unhex } from './scan-cases.mjs';

export const PF_DET = 122;
export const PF_STD = (PF_DET & ~12) | 4;   // the preset with the standard tag set
export const DDEF = { top: 'any', cose: false, maxBytes: 1_500_000, maxDepth: 32, maxEntries: 65_536, maxItems: 131_072, flags: PF_DET };
export const optWords = opt => [opt.top === 'any' ? 1 : 0, opt.cose ? 1 : 0, Math.min(opt.maxBytes, 0x7fffffff),
  Math.min(opt.maxDepth, 0x7fffffff), Math.min(opt.maxEntries, 0x7fffffff), Math.min(opt.maxItems, 0x7fffffff)];

export function buildDetCases(MUTATIONS, SEED) {
  const cases = [];
  const add = (label, bytes, opt, want) => cases.push({ label, bytes, opt, want });
  const det = JSON.parse(readFileSync(new URL('../../corpus/cbor-vectors/deterministic.json', import.meta.url)));
  for (const v of det.accept) add(`det ${v.name}`, unhex(v.hex), DDEF, { code: 'ok', offset: -1 });
  for (const v of det.refuse) add(`det ${v.name}`, unhex(v.hex), DDEF, { code: v.code, offset: v.offset });
  // the same bytes under the Bindle flags: the vector file's bindle column (top any)
  for (const v of [...det.accept, ...det.refuse]) add(`det/bindle ${v.name}`, unhex(v.hex), { ...DDEF, flags: 0 }, { code: v.bindle });
  // ... and under the standard tag set (D180): the standard column, else the vector's own verdict
  for (const v of det.accept) add(`det/standard ${v.name}`, unhex(v.hex), { ...DDEF, flags: PF_STD }, v.standard ? { code: v.standard } : { code: 'ok', offset: -1 });
  for (const v of det.refuse) add(`det/standard ${v.name}`, unhex(v.hex), { ...DDEF, flags: PF_STD }, v.standard ? { code: v.standard } : { code: v.code, offset: v.offset });
  const nVectors = cases.length;

  // ---------------------------------------------------------------- fixed edge cases
  const nest = (n, inner) => '81'.repeat(n) + inner;
  const t24 = h => 'd818' + bstrHex(h);
  const fixed = [
    // depth: a standard tag is a level, its content one below; a tag-24 payload two below the tag
    [nest(31, 'c100'), DDEF], [nest(32, 'c100'), DDEF], [nest(30, t24('00')), DDEF], [nest(31, t24('00')), DDEF],
    [nest(29, t24('8100')), DDEF], [nest(30, t24('8100')), DDEF], [nest(28, t24(t24('00'))), DDEF],
    [t24(t24(t24('00'))), { ...DDEF, maxDepth: 5 }], [t24(t24(t24('00'))), { ...DDEF, maxDepth: 6 }],
    ['d9d9f7d9d9f700', DDEF], ['d9d9f700', { ...DDEF, top: 'map' }], ['d9d9f7a0', { ...DDEF, top: 'map' }],
    // items: the tag, its content, a tag-24 payload's items all count
    [t24('820102'), { ...DDEF, maxItems: 4 }], [t24('820102'), { ...DDEF, maxItems: 5 }],
    ['c100', { ...DDEF, maxItems: 1 }], ['c100', { ...DDEF, maxItems: 2 }],
    // entries and bytes inside a payload
    [t24('83010203'), { ...DDEF, maxEntries: 2 }], [t24('83010203'), { ...DDEF, maxEntries: 3 }],
    // keys: every kind at the limits of order, under each key policy
    ...[0, 1, 2, 3].map(k => ['a3' + '0000' + '2000' + '616100', { ...DDEF, flags: (PF_DET & ~3) | k }]),
    ...[0, 1, 2].map(k => ['a2' + '1b001fffffffffffff00' + '1b002000000000000000', { ...DDEF, flags: (PF_DET & ~3) | k, cose: true, top: 'map' }]),
    ['a1' + 'a1' + '0102' + '00', DDEF], ['a1' + 'a10102' + '00', { ...DDEF, flags: PF_DET & ~2 | 1 }],
    ['a2' + 'f97e00' + '00' + 'f97c00' + '00', DDEF], ['a2' + 'f97c00' + '00' + 'f97e00' + '00', DDEF],
    // each flag alone on the inputs it decides
    ...[0, 4, 8, 12, 16, 32, 64, 118, 122].flatMap(f => ['f97e00', 'f7', 'c100', '63efbfbf', 'a10100', 'fa7fc00000', 'd24100', 'db00000001000000020100', 'd841420001', 'd8414100'].map(h => [h, { ...DDEF, flags: f }])),
    // any tag (D180): depth and item counts of unknown and 64-bit tags, 55799 under PF_SUB-like nesting
    [nest(31, 'd200'), DDEF], [nest(32, 'd200'), DDEF], [nest(31, 'db000000010000000000'), DDEF], [nest(32, 'db000000010000000000'), DDEF],
    ['d2d2d200', { ...DDEF, maxDepth: 2 }], ['d2d2d200', { ...DDEF, maxDepth: 3 }], ['d2d2d200', { ...DDEF, maxItems: 3 }], ['d2d2d200', { ...DDEF, maxItems: 4 }],
    [t24('d9d9f700'), DDEF], [t24('d200'), DDEF], ['d9d9f7d200', DDEF], ['d2d9d9f700', DDEF],
    ['a1' + 'd200' + '00', DDEF], ['a1' + 'db000000010000000000' + '00', DDEF], ['a2' + 'd200' + '00' + 'd201' + '00', DDEF], ['a2' + 'd201' + '00' + 'd200' + '00', DDEF],
    ['d8414401000200', DDEF], ['d84144010002', DDEF], ['d8574f' + '00'.repeat(15), DDEF], ['d857' + '5810' + '00'.repeat(16), DDEF],
    // date/time and URI boundaries
    ...['1900-02-29T00:00:00Z', '2000-02-29T00:00:00Z', '2100-02-28T23:59:59Z', '2023-04-31T00:00:00Z', '2023-04-30T00:00:00Z',
      '0000-01-01T00:00:00Z', '9999-12-31T23:59:60+23:59', '2023-01-01T00:00:00-24:00', '2023-01-01T00:00:00+00:60',
      '2023-01-01T00:00:00.000000000000000000001Z', '2023-01-01T00:00:00+0000', '2023-1-01T00:00:00Z', '2023-01-01T00:00:00ZZ']
      .map(s => ['c0' + tstrHex(s), DDEF]),
    ...['a:', 'a+b-c.d:', '1a:b', 'a:b%4', 'a:b%41%42', 'a:%7e', 'a:\u00e9', 'a:b c', 'A:B', 'a:b?#', 'a:b?c#d?e', 'a:[b]', 'a:b#[', 'a:"']
      .map(s => ['d820' + tstrHex(s), DDEF]),
  ];
  for (const [h, opt] of fixed) add(`detfixed ${h.slice(0, 40)}${h.length > 40 ? '…' : ''} f${opt.flags}`, unhex(h), opt, undefined);
  const nFixed = cases.length - nVectors;

  // ---------------------------------------------------------------- seeded cases
  let s = (SEED * 2246822519) >>> 0 || 1;
  const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const ri = n => Math.floor(r() * n);
  const pick = a => a[ri(a.length)];
  const head = (major, v, width = -1) => {
    v = BigInt(v);
    let w = width;
    if (w < 0) w = v < 24n ? 0 : v < 256n ? 1 : v < 65536n ? 2 : v < 4294967296n ? 4 : 8;
    if (w === 0) return [(major << 5) | Number(v & 31n)];
    const out = [(major << 5) | { 1: 24, 2: 25, 4: 26, 8: 27 }[w]];
    for (let i = w - 1; i >= 0; i--) out.push(Number((v >> BigInt(8 * i)) & 255n));
    return out;
  };
  const utf8 = t => [...Buffer.from(t, 'utf8')];
  const text = t => { const b = utf8(t); return [...head(3, b.length), ...b]; };
  const bytes = b => [...head(2, b.length), ...b];
  const cmp = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };
  const TEXTS = ['', 'a', 'b', 'é', '水', '😀', 'k', '\ufdd0', '\uffff', 'x'.repeat(30)];
  const DATES = ['2013-03-21T20:04:00Z', '1996-12-19T16:39:57.5-08:00', '2024-02-29t23:59:60z', '2023-02-29T00:00:00Z', '2013-03-21', '2013-03-21T20:04:00'];
  const URIS = ['http://www.example.com', 'urn:x:y?z#f', 'a:', '/rel', 'http://a b', 'a:%zz', 'a:b#c#d'];
  const FLOATS = [[0xf9, 0x00, 0x00], [0xf9, 0x80, 0x00], [0xf9, 0x7c, 0x00], [0xf9, 0xfc, 0x00], [0xf9, 0x7e, 0x00], [0xf9, 0x7e, 0x01],
    [0xf9, 0xfe, 0x00], [0xf9, 0x3c, 0x00], [0xf9, 0x3e, 0x00], [0xfa, 0x7f, 0xc0, 0x00, 0x00], [0xfa, 0x00, 0x00, 0x00, 0x00],
    [0xfa, 0x4b, 0x80, 0x00, 0x00], [0xfb, 0x7f, 0xf8, 0, 0, 0, 0, 0, 0], [0xfb, 0x3f, 0xf1, 0x99, 0x99, 0x99, 0x99, 0x99, 0x9a],
    [0xfb, 0x80, 0, 0, 0, 0, 0, 0, 0], [0xfa, 0x5a, 0, 0, 0]];
  function item(depth) {
    switch (ri(depth > 3 ? 7 : 11)) {
      case 0: return head(ri(2), pick([0n, 1n, 23n, 24n, 255n, 256n, 65536n, (1n << 53n), (1n << 64n) - 1n, BigInt(ri(1000))]));
      case 1: return pick(FLOATS);
      case 2: return text(pick(TEXTS));
      case 3: return bytes(Array.from({ length: ri(6) }, () => ri(256)));
      case 4: return [pick([0xf4, 0xf5, 0xf6, 0xf7, 0xf7, 0xe0 + ri(20)])];
      case 5: return pick([[0xc2, 0x49, 1, 0, 0, 0, 0, 0, 0, 0, 0], [0xc4, 0x82, 0x21, 0x19, 0x6a, 0xb3], [0xd8, 0x46, 0x44, 1, 0, 0, 0]]);
      case 6: return stdTag(depth);
      case 7: case 8: { const n = ri(4), out = [...head(4, n)]; for (let i = 0; i < n; i++) out.push(...item(depth + 1)); return out; }
      default: return mapOf(depth);
    }
  }
  function key(depth) {
    switch (ri(6)) {
      case 0: case 1: return text(pick(TEXTS) + ri(3));
      case 2: case 3: return head(ri(2), BigInt(ri(50)) * (r() < 0.1 ? 1000000000n : 1n));
      default: return item(depth + 2);
    }
  }
  function mapOf(depth) {
    const n = ri(5), pairs = [];
    for (let i = 0; i < n; i++) pairs.push([key(depth), item(depth + 1)]);
    // deterministic: sorted by encoded key, duplicates dropped (unless left in on purpose)
    if (r() < 0.9) pairs.sort((a, b) => cmp(a[0], b[0]));
    const kept = r() < 0.95 ? pairs.filter((p, i) => i === 0 || cmp(pairs[i - 1][0], p[0]) !== 0) : pairs;
    return [...head(5, kept.length), ...kept.flatMap(([k, v]) => [...k, ...v])];
  }
  function stdTag(depth) {
    const t = pick([0, 1, 21, 22, 23, 24, 32, 55799, 5, 18, 16, 17, 61, 96, 97, 98, 64, 65, 66, 67, 68, 73, 76, 80, 83, 87, 255, 256, 65535,
      65536, 4294967295n, 4294967296n, 4294967298n, 2n ** 64n - 1n, 2n ** 53n]);
    let content;
    if (t === 0) content = r() < 0.8 ? text(pick(DATES)) : item(depth + 1);
    else if (t === 1) content = r() < 0.7 ? pick([head(0, ri(2e9)), head(1, ri(100)), pick(FLOATS)]) : item(depth + 1);
    else if (t === 24) content = r() < 0.8 ? bytes(r() < 0.8 ? item(depth + 2) : [...item(depth + 2), ...item(depth + 2)]) : item(depth + 1);
    else if (t === 32) content = r() < 0.8 ? text(pick(URIS)) : item(depth + 1);
    else if (t >= 64 && t <= 87) content = r() < 0.8 ? bytes(Array.from({ length: pick([0, 1, 2, 3, 4, 8, 15, 16, 32]) }, () => ri(256))) : item(depth + 1);
    else content = item(depth + 1);
    return [...head(6, t), ...content];
  }
  const SPECIAL = [0x00, 0x17, 0x18, 0x1b, 0x1c, 0x1f, 0x20, 0x40, 0x5f, 0x60, 0x7f, 0x80, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xd5,
    0xd8, 0xd9, 0xf4, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xff, 0x7c, 0x7e, 0xfe, 0xef, 0xed, 0x18, 0x20];
  function mutate(b) {
    let a = Array.from(b);
    for (let t = 1 + ri(3); t > 0; t--) {
      const i = ri(Math.max(a.length, 1));
      switch (ri(8)) {
        case 0: if (a.length) a[i] ^= 1 << ri(8); break;
        case 1: if (a.length) a[i] = pick(SPECIAL); break;
        case 2: a.splice(i, 1); break;
        case 3: a.splice(i, 0, pick(SPECIAL)); break;
        case 4: a = a.slice(0, i); break;
        case 5: { const j = ri(a.length + 1), k = Math.min(a.length, j + 1 + ri(6)); a.splice(i, 0, ...a.slice(j, k)); break; }
        case 6: a.push(ri(256)); break;
        default: if (a.length > 1) { const j = ri(a.length); [a[i], a[j]] = [a[j], a[i]]; }
      }
    }
    return Uint8Array.from(a);
  }
  const profile = JSON.parse(readFileSync(new URL('../../corpus/cbor-vectors/cbor-profile.json', import.meta.url)));
  const seeds = [...det.accept, ...det.refuse, ...profile.accept].map(v => unhex(v.hex));
  const randomOpt = () => {
    const flags = r() < 0.6 ? PF_DET : r() < 0.5 ? ri(128) : pick([0, 1, 2, 4, 8, 16, 32, 64, PF_STD, PF_DET & ~8, PF_DET & ~16]);
    if (r() < 0.7) return { ...DDEF, flags };
    return { top: r() < 0.8 ? 'any' : 'map', cose: r() < 0.2, maxBytes: r() < 0.85 ? 1_500_000 : ri(40), maxDepth: r() < 0.6 ? 32 : ri(6),
      maxEntries: r() < 0.6 ? 65_536 : ri(6), maxItems: r() < 0.6 ? 131_072 : ri(14), flags };
  };
  for (let m = 0; m < MUTATIONS; m++) {
    const k = r();
    const base = k < 0.55 ? Uint8Array.from(item(0)) : k < 0.7 ? Uint8Array.from(mapOf(0)) : k < 0.8 ? Uint8Array.from(stdTag(0)) : pick(seeds);
    add(`detmut ${m}`, r() < 0.45 ? base : mutate(base), randomOpt(), undefined);
  }
  return { cases, nVectors, nFixed, det };
}

function bstrHex(h) { const n = h.length / 2; return (n < 24 ? (0x40 | n).toString(16) : '58' + n.toString(16).padStart(2, '0')) + h; }
function tstrHex(t) { const b = Buffer.from(t, 'utf8'); const n = b.length; return (n < 24 ? (0x60 | n).toString(16) : '78' + n.toString(16).padStart(2, '0')) + b.toString('hex'); }
export { hex };
