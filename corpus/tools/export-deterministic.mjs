// Writes corpus/cbor-vectors/deterministic.json: accept / refuse vectors for the DETERMINISTIC preset (D081,
// D120-D125; docs/profiles.md), with the Bindle verdict of every input alongside. Run:
//
//     node corpus/tools/export-deterministic.mjs
//
// The bytes are spelled out here by hand (a tiny head writer, never snug's encoder), and every expected code and
// error offset is written by hand from docs/profiles.md and docs/scanner.md, then held by the gates (bb scan-test,
// rscan-test, vm-test, vmsession-test, host/js npm test) against the scanner, the resumable scanner, the VM and the
// session, JS and Rust. RFC 8949 Appendix A examples are marked `rfc`. The Bindle column (`bindle`) is the code
// cbor.mjs's profile gives the same bytes (bb scan-test checks it against bench/baseline/cbor-3sln.mjs too).
import { writeFileSync } from 'node:fs';

// ------------------------------------------------------------------ a head writer (hex)
const hx = n => n.toString(16).padStart(2, '0');
function head(major, n) {
  const m = major << 5;
  n = BigInt(n);
  if (n < 24n) return hx(m | Number(n));
  if (n < 256n) return hx(m | 24) + hx(Number(n));
  if (n < 65536n) return hx(m | 25) + n.toString(16).padStart(4, '0');
  if (n < 4294967296n) return hx(m | 26) + n.toString(16).padStart(8, '0');
  return hx(m | 27) + n.toString(16).padStart(16, '0');
}
const uint = n => head(0, n);
const nint = n => head(1, -1n - BigInt(n));            // n < 0
const int = n => (BigInt(n) < 0n ? nint(n) : uint(n));
const bstr = h => head(2, h.length / 2) + h;
const utf8 = s => Buffer.from(s, 'utf8').toString('hex');
const tstr = s => head(3, Buffer.byteLength(s, 'utf8')) + utf8(s);
const arr = (...items) => head(4, items.length) + items.join('');
const map = (...pairs) => head(5, pairs.length) + pairs.map(([k, v]) => k + v).join('');
const tag = (t, content) => head(6, t) + content;

// ------------------------------------------------------------------ the vectors
// accept: [name, hex, value, {rfc, reencode, bindle, standard}]   refuse: [name, hex, code, offset, {bindle, standard}]
// value notation (docs: the format field): JSON scalars; {"$int"}; {"$bytes"}; {"$map": [[k, v], ...]} a Map;
// {"$tag": n, "value": v} a Tagged; {"$float": "NaN" | "Infinity" | "-Infinity" | "-0"}; {"$undefined": true}.
const A = [], R = [];
const acc = (name, hex, value, o = {}) => A.push({ name, hex, value, ...o });
const ref = (name, hex, code, offset, o = {}) => R.push({ name, hex, code, offset, ...o });
const F = s => ({ $float: s });
const U = { $undefined: true };
const T = (n, value) => ({ $tag: n, value });
const M = (...pairs) => ({ $map: pairs });
const B = h => ({ $bytes: h });
const I = s => ({ $int: s });

// RFC 8949 Appendix A: every example that is deterministic, accepted (rfc: true).
for (const [v, h] of [[0, '00'], [1, '01'], [10, '0a'], [23, '17'], [24, '1818'], [25, '1819'], [100, '1864'],
  [1000, '1903e8'], [1000000, '1a000f4240'], [1000000000000, '1b000000e8d4a51000'], [-1, '20'], [-10, '29'],
  [-100, '3863'], [-1000, '3903e7']]) acc(`A: ${v}`, h, v, { rfc: true, bindle: 'ok' });
acc('A: 18446744073709551615', '1bffffffffffffffff', I('18446744073709551615'), { rfc: true, bindle: 'ok' });
acc('A: 18446744073709551616', 'c249010000000000000000', I('18446744073709551616'), { rfc: true, bindle: 'ok' });
acc('A: -18446744073709551616', '3bffffffffffffffff', I('-18446744073709551616'), { rfc: true, bindle: 'ok' });
acc('A: -18446744073709551617', 'c349010000000000000000', I('-18446744073709551617'), { rfc: true, bindle: 'ok' });
acc('A: 0.0', 'f90000', 0, { rfc: true, reencode: '00', bindle: 'float' });
acc('A: -0.0', 'f98000', F('-0'), { rfc: true, bindle: 'float' });
acc('A: 1.0', 'f93c00', 1, { rfc: true, reencode: '01', bindle: 'float' });
acc('A: 1.1', 'fb3ff199999999999a', 1.1, { rfc: true, bindle: 'ok' });
acc('A: 1.5', 'f93e00', 1.5, { rfc: true, bindle: 'ok' });
acc('A: 65504.0', 'f97bff', 65504, { rfc: true, reencode: '19ffe0', bindle: 'float' });
acc('A: 100000.0', 'fa47c35000', 100000, { rfc: true, reencode: '1a000186a0', bindle: 'float' });
acc('A: 3.4028234663852886e+38', 'fa7f7fffff', 3.4028234663852886e+38, { rfc: true, bindle: 'ok' });
acc('A: 1.0e+300', 'fb7e37e43c8800759c', 1e300, { rfc: true, bindle: 'ok' });
acc('A: 5.960464477539063e-8', 'f90001', 5.960464477539063e-8, { rfc: true, bindle: 'ok' });
acc('A: 0.00006103515625', 'f90400', 0.00006103515625, { rfc: true, bindle: 'ok' });
acc('A: -4.0', 'f9c400', -4, { rfc: true, reencode: '23', bindle: 'float' });
acc('A: -4.1', 'fbc010666666666666', -4.1, { rfc: true, bindle: 'ok' });
acc('A: Infinity', 'f97c00', F('Infinity'), { rfc: true, bindle: 'float' });
acc('A: NaN', 'f97e00', F('NaN'), { rfc: true, bindle: 'float' });
acc('A: -Infinity', 'f9fc00', F('-Infinity'), { rfc: true, bindle: 'float' });
acc('A: false', 'f4', false, { rfc: true, bindle: 'ok' });
acc('A: true', 'f5', true, { rfc: true, bindle: 'ok' });
acc('A: null', 'f6', null, { rfc: true, bindle: 'ok' });
acc('A: undefined', 'f7', U, { rfc: true, bindle: 'simple' });
acc('A: 0("2013-03-21T20:04:00Z")', 'c074323031332d30332d32315432303a30343a30305a', T(0, '2013-03-21T20:04:00Z'), { rfc: true, bindle: 'tag' });
acc('A: 1(1363896240)', 'c11a514b67b0', T(1, 1363896240), { rfc: true, bindle: 'tag' });
acc('A: 1(1363896240.5)', 'c1fb41d452d9ec200000', T(1, 1363896240.5), { rfc: true, bindle: 'tag' });
acc("A: 23(h'01020304')", 'd74401020304', T(23, B('01020304')), { rfc: true, bindle: 'tag' });
acc("A: 24(h'6449455446')", 'd818456449455446', T(24, B('6449455446')), { rfc: true, bindle: 'tag' });
acc('A: 32("http://www.example.com")', 'd82076687474703a2f2f7777772e6578616d706c652e636f6d', T(32, 'http://www.example.com'), { rfc: true, bindle: 'tag' });
acc("A: h''", '40', B(''), { rfc: true, bindle: 'ok' });
acc("A: h'01020304'", '4401020304', B('01020304'), { rfc: true, bindle: 'ok' });
acc('A: ""', '60', '', { rfc: true, bindle: 'ok' });
acc('A: "a"', '6161', 'a', { rfc: true, bindle: 'ok' });
acc('A: "IETF"', '6449455446', 'IETF', { rfc: true, bindle: 'ok' });
acc('A: "\\"\\\\"', '62225c', '"\\', { rfc: true, bindle: 'ok' });
acc('A: "\\u00fc"', '62c3bc', 'ü', { rfc: true, bindle: 'ok' });
acc('A: "\\u6c34"', '63e6b0b4', '水', { rfc: true, bindle: 'ok' });
acc('A: "\\ud800\\udd51"', '64f0908591', '𐅑', { rfc: true, bindle: 'ok' });
acc('A: []', '80', [], { rfc: true, bindle: 'ok' });
acc('A: [1, 2, 3]', '83010203', [1, 2, 3], { rfc: true, bindle: 'ok' });
acc('A: [1, [2, 3], [4, 5]]', '8301820203820405', [1, [2, 3], [4, 5]], { rfc: true, bindle: 'ok' });
acc('A: [1, ..., 25]', '98190102030405060708090a0b0c0d0e0f101112131415161718181819', Array.from({ length: 25 }, (_, i) => i + 1), { rfc: true, bindle: 'ok' });
acc('A: {}', 'a0', {}, { rfc: true, bindle: 'ok' });
acc('A: {1: 2, 3: 4}', 'a201020304', M([1, 2], [3, 4]), { rfc: true, bindle: 'key_type' });
acc('A: {"a": 1, "b": [2, 3]}', 'a26161016162820203', { a: 1, b: [2, 3] }, { rfc: true, bindle: 'ok' });
acc('A: ["a", {"b": "c"}]', '826161a161626163', ['a', { b: 'c' }], { rfc: true, bindle: 'ok' });
acc('A: {"a": "A", ..., "e": "E"}', 'a56161614161626142616361436164614461656145', { a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' }, { rfc: true, bindle: 'ok' });

// RFC 8949 Appendix A examples that are NOT deterministic: refused (rfc: true).
ref('A: Infinity as float32', 'fa7f800000', 'non_shortest', 0, { rfc: true, bindle: 'float' });
ref('A: NaN as float32', 'fa7fc00000', 'non_shortest', 0, { rfc: true, bindle: 'float' });
ref('A: -Infinity as float32', 'faff800000', 'non_shortest', 0, { rfc: true, bindle: 'float' });
ref('A: Infinity as float64', 'fb7ff0000000000000', 'non_shortest', 0, { rfc: true, bindle: 'float' });
ref('A: NaN as float64', 'fb7ff8000000000000', 'non_shortest', 0, { rfc: true, bindle: 'float' });
ref('A: -Infinity as float64', 'fbfff0000000000000', 'non_shortest', 0, { rfc: true, bindle: 'float' });
ref('A: simple(16)', 'f0', 'simple', 0, { rfc: true, bindle: 'simple' });
ref('A: simple(255)', 'f8ff', 'simple', 0, { rfc: true, bindle: 'simple' });
ref("A: (_ h'0102', h'030405')", '5f42010243030405ff', 'indefinite', 0, { rfc: true, bindle: 'indefinite' });
ref('A: (_ "strea", "ming")', '7f657374726561646d696e67ff', 'indefinite', 0, { rfc: true, bindle: 'indefinite' });
ref('A: [_ ]', '9fff', 'indefinite', 0, { rfc: true, bindle: 'indefinite' });
ref('A: [_ 1, [2, 3], [_ 4, 5]]', '9f018202039f0405ffff', 'indefinite', 0, { rfc: true, bindle: 'indefinite' });
ref('A: {_ "a": 1, "b": [_ 2, 3]}', 'bf61610161629f0203ffff', 'indefinite', 0, { rfc: true, bindle: 'indefinite' });

// Floats: shortest forms, the canonical NaN, zeros and infinities.
acc('float16 smallest subnormal negative', 'f98001', -5.960464477539063e-8, { bindle: 'ok' });
acc('integral float32 2^24', 'fa4b800000', 16777216, { reencode: '1a01000000', bindle: 'float' });
acc('integral float32 2^53', 'fa5a000000', 9007199254740992, { bindle: 'ok' });
acc('integral float64 2^53+2', 'fb4340000000000001', 9007199254740994, { bindle: 'ok' });
acc('float32 subnormal 2^-149', 'fa00000001', 2 ** -149, { bindle: 'ok' });
acc('float64 subnormal', 'fb0000000000000001', 5e-324, { bindle: 'ok' });
acc('-0 in an array with NaN and infinities', '84f98000f97e00f97c00f9fc00', [F('-0'), F('NaN'), F('Infinity'), F('-Infinity')], { bindle: 'float' });
ref('NaN with a payload (float16)', 'f97e01', 'float', 0, { bindle: 'float' });
ref('signalling NaN (float16)', 'f97c01', 'float', 0, { bindle: 'float' });
ref('negative quiet NaN (float16)', 'f9fe00', 'float', 0, { bindle: 'float' });
ref('NaN with a payload (float32)', 'fa7fc00001', 'float', 0, { bindle: 'float' });
ref('negative NaN (float32)', 'faffc00000', 'float', 0, { bindle: 'float' });
ref('NaN with a payload (float64)', 'fb7ff8000000000001', 'float', 0, { bindle: 'float' });
ref('negative NaN (float64)', 'fbfff8000000000000', 'float', 0, { bindle: 'float' });
ref('0.0 as float32', 'fa00000000', 'non_shortest', 0, { bindle: 'float' });
ref('-0.0 as float32', 'fa80000000', 'non_shortest', 0, { bindle: 'float' });
ref('-0.0 as float64', 'fb8000000000000000', 'non_shortest', 0, { bindle: 'float' });
ref('1.0 as float32', 'fa3f800000', 'non_shortest', 0, { bindle: 'float' });
ref('1.5 as float64', 'fb3ff8000000000000', 'non_shortest', 0, { bindle: 'non_shortest' });
ref('2^53 as float64', 'fb4340000000000000', 'non_shortest', 0, { bindle: 'non_shortest' });
ref('float16 subnormal as float32', 'fa33800000', 'non_shortest', 0, { bindle: 'non_shortest' });
ref('a float truncated', 'fa7f80', 'truncated', 0, { bindle: 'truncated' });

// Simple values.
acc('undefined in an array and as a map value', arr('f7', map([tstr('u'), 'f7'])), [U, { u: U }], { bindle: 'simple' });
ref('simple(24): unassigned', 'f818', 'simple', 0, { bindle: 'simple' });
ref('f8 17: non-shortest simple', 'f817', 'non_shortest', 0, { bindle: 'non_shortest' });
ref('simple(19): unassigned', 'f3', 'simple', 0, { bindle: 'simple' });

// Text: noncharacters are admitted; malformed UTF-8 is not.
acc('noncharacter U+FFFF', '63efbfbf', '￿', { bindle: 'text' });
acc('noncharacter U+FDD0 as a key', map([tstr('﷐'), '01']), { '﷐': 1 }, { bindle: 'text' });
acc('noncharacter U+10FFFF', '64f48fbfbf', '\u{10ffff}', { bindle: 'text' });
ref('surrogate in text', '63eda080', 'text', 1, { bindle: 'text' });
ref('overlong in text', '62c0af', 'text', 1, { bindle: 'text' });
ref('truncated sequence in text', '62e282', 'text', 1, { bindle: 'text' });

// Integer and mixed map keys: complete encoded keys in bytewise order.
acc('integer keys incl. negative and 64-bit', map([uint(0), uint(1)], [uint(23), uint(2)], [uint(24), uint(3)], [uint(2n ** 64n - 1n), uint(4)], [nint(-1), uint(5)], [nint(-(2n ** 64n)), uint(6)]),
  M([0, 1], [23, 2], [24, 3], [I('18446744073709551615'), 4], [-1, 5], [I('-18446744073709551616'), 6]), { bindle: 'key_type' });
const cwt = map([uint(1), tstr('coap://as.example.com')], [uint(2), tstr('erikw')], [uint(3), tstr('coap://light.example.com')],
  [uint(4), uint(1444064944)], [uint(5), uint(1443944944)], [uint(6), uint(1443944944)], [uint(7), bstr('0b71')]);
acc('RFC 8392 A.1 CWT claims', cwt, M([1, 'coap://as.example.com'], [2, 'erikw'], [3, 'coap://light.example.com'], [4, 1444064944], [5, 1443944944], [6, 1443944944], [7, B('0b71')]), { bindle: 'key_type' });
const coseKey = map([uint(1), uint(2)], [nint(-1), uint(1)], [nint(-2), bstr('d7cc072de2205bdc1537a543d53c60a6')], [nint(-3), bstr('acb7deae3a8d4e8f')]);
acc('CWT cnf holding a COSE_Key (nested integer keys)', map([uint(1), tstr('as')], [uint(8), map([uint(1), coseKey])]),
  M([1, 'as'], [8, M([1, M([1, 2], [-1, 1], [-2, B('d7cc072de2205bdc1537a543d53c60a6')], [-3, B('acb7deae3a8d4e8f')])])]), { bindle: 'key_type' });
acc('mixed key kinds in bytewise order', map([uint(0), '00'], [nint(-1), '00'], [bstr('00'), '00'], [tstr('a'), '00'], [arr(uint(0)), '00'], [map(), '00'], ['f4', '00'], ['f93e00', '00']),
  M([0, 0], [-1, 0], [B('00'), 0], ['a', 0], [[0], 0], [{}, 0], [false, 0], [1.5, 0]), { bindle: 'key_type' });
acc('length-first order is not used: 10, 100, -1', map([uint(10), '00'], [uint(100), '00'], [nint(-1), '00']), M([10, 0], [100, 0], [-1, 0]), { bindle: 'key_type' });
acc('tag, undefined and null keys', map([tag(1, uint(0)), '01'], ['f6', '02'], ['f7', '03']), M([T(1, 0), 1], [null, 2], [U, 3]), { bindle: 'key_type' });
ref('length-first order (10, -1, 100)', map([uint(10), '00'], [nint(-1), '00'], [uint(100), '00']), 'key_order', 5, { bindle: 'key_type' });
ref('text before integer', map([tstr('a'), '01'], [uint(1), '02']), 'key_order', 4, { bindle: 'key_type' });
ref('duplicate integer key', map([uint(1), '00'], [uint(1), '00']), 'duplicate_key', 3, { bindle: 'key_type' });
ref('duplicate array key', map([arr(uint(1)), '00'], [arr(uint(1)), '00']), 'duplicate_key', 4, { bindle: 'key_type' });
ref('float keys out of order', map(['f93e00', '00'], ['f93c00', '00']), 'key_order', 5, { bindle: 'key_type' });
ref('an array key truncated', 'a1830102', 'truncated', 1, { bindle: 'key_type' });
ref('a non-shortest integer key', map([uint(1).replace(/^01$/, '1801'), '00']), 'non_shortest', 1, { bindle: 'key_type' });

// Standard tags: content rules.
acc('tag 0 with a fraction and an offset', tag(0, tstr('1996-12-19T16:39:57.123-08:00')), T(0, '1996-12-19T16:39:57.123-08:00'), { bindle: 'tag' });
acc('tag 0 leap day, leap second at the month end', tag(0, tstr('2024-02-29T23:59:60Z')), T(0, '2024-02-29T23:59:60Z'), { bindle: 'tag' });
acc('tag 0 leap second at a month end in UTC, before it locally (D252)', tag(0, tstr('1990-12-31T15:59:60-08:00')), T(0, '1990-12-31T15:59:60-08:00'), { bindle: 'tag' });
acc('tag 0 leap second on the eve of local day 1 (D252)', tag(0, tstr('2017-01-01T00:59:60+01:00')), T(0, '2017-01-01T00:59:60+01:00'), { bindle: 'tag' });
acc('tag 1 negative integer', tag(1, nint(-1)), T(1, -1), { bindle: 'tag' });
acc('tag 1 -0.0', tag(1, 'f98000'), T(1, F('-0')), { bindle: 'tag' });
acc('tag 1 with NaN: discouraged, not invalid (RFC 8949 §3.4.2, D252)', tag(1, 'f97e00'), T(1, F('NaN')), { bindle: 'tag' });
acc('tag 1 with -Infinity: discouraged, not invalid (D252)', tag(1, 'f9fc00'), T(1, F('-Infinity')), { bindle: 'tag' });
acc('tag 21 over an array of byte strings', tag(21, arr(bstr('00'), bstr('ff'))), T(21, [B('00'), B('ff')]), { bindle: 'tag' });
acc('tag 22 over a map', tag(22, map([tstr('k'), bstr('01')])), T(22, { k: B('01') }), { bindle: 'tag' });
acc('tag 23 over an integer', tag(23, uint(5)), T(23, 5), { bindle: 'tag' });
acc('tag 24 holding a map with integer keys', tag(24, bstr(map([uint(1), uint(2)]))), T(24, B(map([uint(1), uint(2)]))), { bindle: 'tag' });
acc('tag 24 holding tag 24', tag(24, bstr(tag(24, bstr('01')))), T(24, B(tag(24, bstr('01')))), { bindle: 'tag' });
acc('tag 32 with query and fragment', tag(32, tstr('urn:a:b?c=d%2F#x/y?z')), T(32, 'urn:a:b?c=d%2F#x/y?z'), { bindle: 'tag' });
acc('tag 32 with an IP literal', tag(32, tstr('http://[::1]:80/p')), T(32, 'http://[::1]:80/p'), { bindle: 'tag' });
acc('tag 32 relative reference: URI-reference (RFC 8949 §3.4.5.3, D252)', tag(32, tstr('/a/b')), T(32, '/a/b'), { bindle: 'tag' });
acc('tag 32 with an IPv4-embedded IPv6 literal', tag(32, tstr('http://[::ffff:192.0.2.1]/')), T(32, 'http://[::ffff:192.0.2.1]/'), { bindle: 'tag' });
acc('tag 55799 at the top level', tag(55799, map([tstr('a'), uint(1)])), T(55799, { a: 1 }), { bindle: 'tag' });
acc('typed array (tag 70) and decimal (tag 4) stay', arr(tag(70, bstr('01000000')), tag(4, arr(nint(-2), uint(27315)))), undefined, { bindle: 'ok' });
ref('tag 0 with an integer', tag(0, uint(0)), 'tag', 0, { bindle: 'tag' });
ref('tag 0 with a date only', tag(0, tstr('2013-03-21')), 'tag', 0, { bindle: 'tag' });
ref('tag 0 with month 13', tag(0, tstr('2013-13-21T20:04:00Z')), 'tag', 0, { bindle: 'tag' });
ref('tag 0 with Feb 29 in a common year', tag(0, tstr('2023-02-29T20:04:00Z')), 'tag', 0, { bindle: 'tag' });
ref('tag 0 with hour 24', tag(0, tstr('2013-03-21T24:00:00Z')), 'tag', 0, { bindle: 'tag' });
ref('tag 0 with an empty fraction', tag(0, tstr('2013-03-21T20:04:00.Z')), 'tag', 0, { bindle: 'tag' });
ref('tag 0 without an offset', tag(0, tstr('2013-03-21T20:04:00')), 'tag', 0, { bindle: 'tag' });
ref('tag 0 with a space for T', tag(0, tstr('2013-03-21 20:04:00Z')), 'tag', 0, { bindle: 'tag' });
ref('tag 0 lower-case t and z: RFC 4287 §3.3 refinement (D252)', tag(0, tstr('2024-02-29t23:59:60z')), 'tag', 0, { bindle: 'tag' });
ref('tag 0 leap second at 00:00 (audit S61, D252)', tag(0, tstr('2024-01-01T00:00:60Z')), 'tag', 0, { bindle: 'tag' });
ref('tag 0 leap second mid-month (D252)', tag(0, tstr('2024-01-15T23:59:60Z')), 'tag', 0, { bindle: 'tag' });
ref('tag 0 with bad UTF-8: the content walk first', tag(0, '62c0af'), 'text', 2, { bindle: 'tag' });
ref('tag 1 with text', tag(1, tstr('1')), 'tag', 0, { bindle: 'tag' });
ref('tag 1 with a bignum', tag(1, 'c249010000000000000000'), 'tag', 0, { bindle: 'tag' });
ref('tag 1 with a non-shortest float: the content walk first', tag(1, 'fa3fc00000'), 'non_shortest', 1, { bindle: 'tag' });
ref('tag 24 with text', tag(24, tstr('01')), 'tag', 0, { bindle: 'tag' });
ref('tag 24 empty', tag(24, bstr('')), 'truncated', 3, { bindle: 'tag' });
ref('tag 24 holding two items', tag(24, bstr('0102')), 'trailing', 4, { bindle: 'tag' });
ref('tag 24 holding a non-shortest integer', tag(24, bstr('1817')), 'non_shortest', 3, { bindle: 'tag' });
ref('tag 24 holding unsorted keys', tag(24, bstr(map([uint(2), '00'], [uint(1), '00']))), 'key_order', 6, { bindle: 'tag' });
ref('tag 24 holding a truncated array', tag(24, bstr('8201')), 'truncated', 3, { bindle: 'tag' });
ref('tag 24 holding an indefinite string', tag(24, bstr('7fff')), 'indefinite', 3, { bindle: 'tag' });
ref('tag 32 with an unclosed IP literal (audit S60, D252)', tag(32, tstr('http://[x')), 'tag', 0, { bindle: 'tag' });
ref('tag 32 with nine IPv6 pieces', tag(32, tstr('http://[1:2:3:4:5:6:7:8:9]/')), 'tag', 0, { bindle: 'tag' });
ref('tag 32 with two :: in an IP literal', tag(32, tstr('http://[1::2::3]/')), 'tag', 0, { bindle: 'tag' });
ref('tag 32 with a non-digit port', tag(32, tstr('http://h:8x/')), 'tag', 0, { bindle: 'tag' });
ref('tag 32 with a colon in a schemeless first segment', tag(32, tstr('1a:b')), 'tag', 0, { bindle: 'tag' });
ref('tag 32 with a space', tag(32, tstr('http://a b')), 'tag', 0, { bindle: 'tag' });
ref('tag 32 with a bad escape', tag(32, tstr('http://a/%2g')), 'tag', 0, { bindle: 'tag' });
ref('tag 32 with two fragments', tag(32, tstr('a:b#c#d')), 'tag', 0, { bindle: 'tag' });
ref('tag 32 with a bracket in the query', tag(32, tstr('a:b?[c]')), 'tag', 0, { bindle: 'tag' });
ref('tag 32 with an empty scheme', tag(32, tstr(':b')), 'tag', 0, { bindle: 'tag' });
acc('tag 55799 nested: any depth (RFC 8949 §3.4.6, D265)', arr(tag(55799, uint(0))), [T(55799, 0)], { bindle: 'tag' });
acc('tag 55799 twice (D265)', tag(55799, tag(55799, uint(0))), T(55799, T(55799, 0)), { bindle: 'tag' });
ref('a non-shortest tag head', 'd80000', 'non_shortest', 0, { bindle: 'non_shortest' });

// Any tag (D180, the preset's tag level): every tag number, its content one item a level below; the known tags keep
// their rules. `standard` is the code under { tags: 'standard' } where it differs.
const STD = { standard: 'tag', bindle: 'tag' };
acc('tag 5 (bigfloat): no content rule', tag(5, arr(nint(-1), uint(3))), T(5, [-1, 3]), STD);
acc('tag 18 over an empty array: no content rule', tag(18, arr()), T(18, []), STD);
acc('tag 33 (base64url) content is not checked', tag(33, tstr('AA')), T(33, 'AA'), STD);
const sig = '8eb33e4ca31d1c465ab05aac34cc6b23d58fef5c083106c4d25a91aef0b0117e2af9a291aa32e14ab834dc56ed2a223444547e01f11d3b0916e5a4c345cacb36';
const sign1 = tag(18, arr(bstr('a10126'), map([uint(4), bstr('3131')]), bstr(utf8('This is the content.')), bstr(sig)));
acc('COSE_Sign1 (RFC 9052 C.2.1)', sign1,
  T(18, [B('a10126'), M([4, B('3131')]), B(utf8('This is the content.')), B(sig)]), { ...STD, bindle: 'tag' });
acc('CWT: tag 61 over a COSE_Sign1 whose payload is the RFC 8392 A.1 claims',
  tag(61, tag(18, arr(bstr('a10126'), map(), bstr(cwt), bstr(sig)))),
  T(61, T(18, [B('a10126'), {}, B(cwt), B(sig)])), STD);
acc('COSE_Encrypt0 (16), COSE_Mac0 (17), COSE_Encrypt (96), COSE_Mac (97), COSE_Sign (98)',
  arr(tag(16, arr(bstr('a1010a'), map([uint(5), bstr('00112233')]), bstr('deadbeef'))),
    tag(17, arr(bstr('a1010f'), map(), bstr('00'), bstr('726043745027214f'))),
    tag(96, arr(bstr(''), map(), 'f6', arr(arr(bstr(''), map([uint(1), nint(-6)]), bstr(''))))),
    tag(97, arr(bstr('a10105'), map(), bstr('00'), bstr('01'), arr(arr(bstr(''), map(), bstr(''))))),
    tag(98, arr(bstr(''), map(), bstr('00'), arr(arr(bstr('a10126'), map(), bstr('01')))))),
  undefined, STD);
acc('self-described COSE_Sign1 (55799 over tag 18)', tag(55799, sign1), undefined, STD);
acc('nested unknown tags', tag(1000, tag(5, tag(260, tstr('x')))), T(1000, T(5, T(260, 'x'))), STD);
acc('a standard tag inside an unknown one keeps its rule', tag(1001, tag(1, uint(0))), T(1001, T(1, 0)), STD);
acc('tag 256 (2-byte head)', tag(256, uint(0)), T(256, 0), STD);
acc('tag 65534 and 65536 (2- and 4-byte heads)', arr(tag(65534, uint(0)), tag(65536, uint(0))), [T(65534, 0), T(65536, 0)], STD);
acc('tag 2^32 - 2 (4-byte head, a negative i32)', tag(2n ** 32n - 2n, uint(0)), T(4294967294, 0), STD);
acc('tag 2^32 (8-byte head)', tag(2n ** 32n, 'f6'), T(4294967296, null), STD);
acc('tag 2^53 - 1', tag(2n ** 53n - 1n, uint(1)), T(9007199254740991, 1), STD);
acc('tag 2^64 - 2', tag(2n ** 64n - 2n, uint(0)), T('18446744073709551614', 0), STD);
acc('tag 2^63 + 2^32 - 1 (both halves odd)', tag(2n ** 63n + 2n ** 32n - 1n, uint(0)), T('9223372041149743103', 0), STD);
ref('tag 65535 is invalid (RFC 8949 §9.2)', tag(65535, uint(0)), 'tag', 0, STD);
ref('tag 2^32 - 1 is invalid', tag(2n ** 32n - 1n, uint(0)), 'tag', 0, STD);
ref('tag 2^64 - 1 is invalid', tag(2n ** 64n - 1n, uint(0)), 'tag', 0, STD);
ref('an invalid tag nested in a valid one', tag(18, tag(65535, uint(0))), 'tag', 1, STD);
acc('tag 2^32 + 2 is not a bignum (the rule follows the whole number)', tag(2n ** 32n + 2n, bstr('00')), T(4294967298, B('00')), STD);
acc('tag 2^32 + 24 is not an encoded data item', tag(2n ** 32n + 24n, tstr('x')), T(4294967320, 'x'), STD);
acc('an unknown tag as a map key, and a 64-bit one', map([tag(7, uint(0)), uint(1)], [tag(2n ** 40n, uint(0)), uint(2)]),
  M([T(7, 0), 1], [T(1099511627776, 0), 2]), { standard: 'tag', bindle: 'key_type' });
acc('tag 24 holding an unknown tag', tag(24, bstr(tag(18, arr()))), T(24, B(tag(18, arr()))), STD);
acc('tag 64 (uint8) over a byte string', tag(64, bstr('00ff')), T(64, B('00ff')), STD);
acc('tag 65 (uint16 big-endian) over whole elements', tag(65, bstr('00010002')), T(65, B('00010002')), STD);
acc('tag 87 (float128 little-endian) over 16 bytes', tag(87, bstr('00'.repeat(16))), T(87, B('00'.repeat(16))), STD);
acc('tag 76 (reserved in RFC 8746) has no rule', tag(76, uint(0)), T(76, 0), STD);
acc('tag 82 (float64 big-endian) may hold a NaN', tag(82, bstr('7ff8000000000001')), T(82, B('7ff8000000000001')), STD);
ref('tag 65 with an odd byte count', tag(65, bstr('000100')), 'tag', 0, STD);
ref('tag 87 with 8 bytes', tag(87, bstr('00'.repeat(8))), 'tag', 0, STD);
ref('tag 64 over text', tag(64, tstr('a')), 'tag', 0, STD);
ref('tag 66 over a truncated byte string: the content walk first', tag(66, '4400'), 'truncated', 2, { ...STD, standard: 'tag' });
ref('an unknown tag with a non-shortest content: the content walk first', tag(1000, '1817'), 'non_shortest', 3, STD);
ref('an unknown tag with no content', tag(18, ''), 'truncated', 1, STD);
ref('a 64-bit tag head truncated', 'db00000001000000', 'truncated', 0, { standard: 'truncated', bindle: 'truncated' });
ref('a 64-bit tag number with no content', 'db0000000100000000', 'truncated', 9, STD);
ref('tag 18 in a 1-byte head', 'd81280', 'non_shortest', 0, { standard: 'non_shortest', bindle: 'non_shortest' });
ref('tag 18 in a 2-byte head', 'd9001280', 'non_shortest', 0, { standard: 'non_shortest', bindle: 'non_shortest' });
ref('tag 256 in a 4-byte head', 'da0000010000', 'non_shortest', 0, { standard: 'non_shortest', bindle: 'non_shortest' });
ref('tag 2^32 - 1 in an 8-byte head', 'db00000000ffffffff00', 'non_shortest', 0, { standard: 'non_shortest', bindle: 'non_shortest' });
ref('an indefinite tag head', 'df00', 'indefinite', 0, { standard: 'indefinite', bindle: 'indefinite' });
acc('tag 55799 nested under an unknown tag (D265)', tag(18, tag(55799, uint(0))), T(18, T(55799, 0)), STD);
ref('unknown tags past maxDepth (32)', tag(1000, '').repeat(33) + '00', 'depth', 96, STD);
ref('tag 2 bignum that fits 64 bits (preferred serialization, D181)', tag(2, bstr('ffffffffffffffff')), 'bignum', 0, { standard: 'bignum', bindle: 'bignum' });
ref('tag 3 bignum with a leading zero', tag(3, bstr('000100000000000000')), 'bignum', 0, { standard: 'bignum', bindle: 'bignum' });
ref('tag 2 over text', tag(2, tstr('1')), 'bignum', 1, { standard: 'bignum', bindle: 'bignum' });

// Determinism of heads and lengths (unchanged from the Bindle profile).
ref('non-shortest integer', '1817', 'non_shortest', 0, { bindle: 'non_shortest' });
ref('non-shortest 16-bit integer', '1900ff', 'non_shortest', 0, { bindle: 'non_shortest' });
ref('non-shortest byte string length', '5801ff', 'non_shortest', 0, { bindle: 'non_shortest' });
ref('non-shortest array length', '9800', 'non_shortest', 0, { bindle: 'non_shortest' });
ref('non-shortest map length', 'b800', 'non_shortest', 0, { bindle: 'non_shortest' });
ref('reserved additional information', '1c', 'malformed', 0, { bindle: 'malformed' });
ref('a stray break', 'ff', 'indefinite', 0, { bindle: 'indefinite' });
ref('trailing bytes', '0000', 'trailing', 1, { bindle: 'trailing' });
ref('empty input', '', 'truncated', 0, { bindle: 'truncated' });

const doc = {
  profile: 'snug deterministic preset (D081, D120-D125, D180): docs/profiles.md',
  format: 'hex is the full input, decoded with { profile: "deterministic" } (top any). Accept vectors give the decoded '
    + 'value and, unless reencode is given (the bytes encode() writes for that value), re-encode to hex. Value notation: '
    + 'cbor-profile.json\'s, plus {"$map": [[key, value], ...]} a Map, {"$tag": n, "value": v} a Tagged, {"$float": '
    + '"NaN" | "Infinity" | "-Infinity" | "-0"} and {"$undefined": true}; a missing value is not checked. Refuse '
    + 'vectors name the code and the error offset. rfc marks RFC 8949 Appendix A examples. bindle is the code of '
    + 'the same bytes under { profile: "bindle", top: "any" } (cbor.mjs\'s). standard, when given, is the code of '
    + 'the same bytes under { tags: "standard" } (D180; else the vector\'s own verdict). A $tag number beyond 2^53 - 1 '
    + 'is a decimal string.',
  generator: 'corpus/tools/export-deterministic.mjs',
  accept: A, refuse: R,
};
writeFileSync(new URL('../cbor-vectors/deterministic.json', import.meta.url), JSON.stringify(doc, null, 1) + '\n');
console.log(`deterministic.json: ${A.length} accept, ${R.length} refuse`);
