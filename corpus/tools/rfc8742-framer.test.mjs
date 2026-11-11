// Unit vectors for the independent RFC 8742 framer (P9.5).
//     node --test corpus/tools/rfc8742-framer.test.mjs
// bb sequence-test runs it before the gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frameItem, frameSequence } from './rfc8742-framer.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const appendixA = read('../cbor-vectors/rfc8949-appendix-a.json').vectors;
const appendixF = read('../conformance/rfc/rfc8949-well-formedness.json').vectors;
const rfc8742 = read('../conformance/rfc/rfc8742.json').vectors;
const extra = read('../conformance/rfc/rfc8949-additional.json').vectors;
const unhex = h => Uint8Array.from(Buffer.from(h.replace(/\s+/g, ''), 'hex'));
const cat = parts => { const t = new Uint8Array(parts.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of parts) { t.set(x, o); o += x.length; } return t; };

/** Every prefix of a concatenation of the well-formed `items`: the items wholly inside it, then
 *  end (at a boundary) or truncated at the start of the cut item. */
function assertEveryCut(items, label) {
  const S = cat(items), bounds = [0];
  for (const x of items) bounds.push(bounds[bounds.length - 1] + x.length);
  for (let k = 0; k <= S.length; k++) {
    const r = frameSequence(S.subarray(0, k));
    const whole = bounds.filter(b => b > 0 && b <= k).length;
    assert.equal(r.items.length, whole, `${label}: cut at ${k}`);
    r.items.forEach(([o, e], i) => assert.deepEqual([o, e], [bounds[i], bounds[i + 1]], `${label}: cut at ${k}, item ${i}`));
    const boundary = bounds.includes(k);
    assert.equal(r.stop.kind, boundary ? 'end' : 'truncated', `${label}: cut at ${k}`);
    assert.equal(r.stop.offset, bounds[whole], `${label}: cut at ${k}`);
    if (!boundary) assert.ok(r.stop.at >= r.stop.offset && r.stop.at <= k, `${label}: cut at ${k}: at ${r.stop.at}`);
  }
}

test('RFC 8949 Appendix A: every example is one well-formed item', () => {
  assert.equal(appendixA.length, 81);
  for (const v of appendixA) {
    const b = unhex(v.hex);
    assert.deepEqual(frameItem(b, 0), { kind: 'ok', end: b.length }, v.hex);
  }
});

test('RFC 8949 Appendix A concatenated: boundaries, and a truncation at every byte', () => {
  const items = appendixA.map(v => unhex(v.hex));
  const S = cat(items);
  const r = frameSequence(S);
  assert.equal(r.items.length, 81);
  assert.deepEqual(r.stop, { kind: 'end', offset: S.length });
  assertEveryCut(items, 'Appendix A');
  // the same items in reverse order, and each one twice in a row
  assertEveryCut(items.slice().reverse(), 'Appendix A reversed');
  assert.equal(frameSequence(cat(items.flatMap(x => [x, x]))).items.length, 162);
});

// Appendix F.1's notes: "too little data" (kind 2) vs "syntax error" (kind 3)
const TRUNCATED_NOTES = /^(End of input in a head|Definite-length strings with short data|Definite-length maps and arrays not closed|Tag number not followed|Indefinite-length (strings|maps and arrays) not closed)/;
const WHY = [
  [/^Reserved additional information/, 'reserved-ai'],
  [/^Reserved two-byte encodings of simple/, 'bad-simple'],
  [/^Indefinite-length string chunks/, 'chunk'],
  [/^Break occurring on its own|^Break occurring in a definite/, 'break'],
  [/^Break in an indefinite-length map/, 'break-as-value'],
  [/^Major type 0, 1, 6 with additional information 31/, 'indefinite-mt'],
];

test('RFC 8949 Appendix F.1: every example is refused, with its kind', () => {
  assert.equal(appendixF.length, 94);
  let kinds = { truncated: 0, malformed: 0 };
  for (const v of appendixF) {
    const b = unhex(v.hex);
    const r = frameItem(b, 0);
    if (TRUNCATED_NOTES.test(v.note)) assert.equal(r.kind, 'truncated', `${v.hex} (${v.note})`);
    else {
      assert.equal(r.kind, 'malformed', `${v.hex} (${v.note})`);
      const why = WHY.find(([re]) => re.test(v.note))?.[1];
      assert.equal(r.why, why, `${v.hex} (${v.note})`);
    }
    kinds[r.kind]++;
    // the same item after a well-formed one: framing stops at its offset with the same answer
    const S = cat([unhex('a1616101'), b]);
    const q = frameSequence(S);
    assert.deepEqual(q.items, [[0, 4]], v.hex);
    assert.equal(q.stop.kind, r.kind, v.hex);
    assert.equal(q.stop.offset, 4, v.hex);
    assert.equal(q.stop.at, r.at + 4, v.hex);
  }
  assert.deepEqual(kinds, { truncated: 42, malformed: 52 });
});

test('RFC 8742 §2/§4.2 sequences and RFC 8949 extra vectors', () => {
  for (const v of rfc8742) {
    const b = unhex(v.hex), r = frameSequence(b);
    if (v.hex === '010218') { assert.equal(r.items.length, 2); assert.deepEqual(r.stop, { kind: 'truncated', offset: 2, at: 2 }); continue; }
    assert.equal(r.items.length, v.itemCount, v.hex);
    assert.equal(r.stop.kind, 'end', v.hex);
  }
  // well-formed but invalid or not deterministic: framing does not care
  for (const v of extra) {
    const b = unhex(v.hex), r = frameSequence(b);
    if (v.hex === 'd8184100ff') { assert.deepEqual(r.items, [[0, 4]]); assert.deepEqual(r.stop, { kind: 'malformed', offset: 4, at: 4, why: 'break' }); continue; }
    assert.deepEqual(r, { items: [[0, b.length]], stop: { kind: 'end', offset: b.length } }, `${v.hex} (${v.note})`);
  }
});

const WELL_FORMED = [
  // indefinite lengths
  '5f 42 0102 43 030405 ff', '7f 62 6162 60 ff', '5f ff', '7f ff', '9f ff', 'bf ff',
  '9f 01 82 02 03 9f 04 05 ff ff', 'bf 61 61 01 61 62 9f 02 03 ff ff', '9f 9f 9f 9f ff ff ff ff',
  'bf 5f 41 00 ff 7f 61 61 ff ff', '82 9f ff bf ff', 'a1 9f ff bf 01 02 ff',
  // nested tags (and tags around indefinite items, tag 24 around a byte string)
  'c1 c2 c3 c4 00', 'd8 18 45 82 01 02 03 04', 'd9 d9f7 d8 18 41 00', 'c0 9f c1 01 ff', 'da 00010000 db 0000000000000001 bf 01 c2 40 ff',
  // the largest heads, simple values, floats
  '1b ffffffffffffffff', '3b ffffffffffffffff', 'f8 20', 'f8 ff', 'f9 7c00', 'fa 7f800000', 'fb 7ff0000000000000', 'f7', 'e0',
  // a definite string holding what would be malformed as an item
  '45 ff 1c f8 00 1f', '65 ff ff ff ff ff',
];

test('hand vectors: indefinite lengths, nested tags, heads', () => {
  const items = WELL_FORMED.map(unhex);
  for (const b of items) assert.deepEqual(frameItem(b, 0), { kind: 'ok', end: b.length }, Buffer.from(b).toString('hex'));
  assertEveryCut(items, 'hand vectors');
});

// [hex, the framing: items' ends, then the stop as kind@offset/at(why)]
const STOPS = [
  // break-code misuse
  ['ff', 'malformed@0/0 break'],
  ['00 ff', '1 | malformed@1/1 break'],
  ['81 ff', 'malformed@0/1 break'],
  ['a1 00 ff', 'malformed@0/2 break'],
  ['c0 ff', 'malformed@0/1 break'],
  ['9f ff ff', '2 | malformed@2/2 break'],
  ['bf 00 ff', 'malformed@0/2 break-as-value'],
  ['bf 00 01 02 ff', 'malformed@0/4 break-as-value'],
  ['bf 00 01 ff', '4'],
  ['9f 81 ff ff', 'malformed@0/2 break'],
  ['9f c0 ff ff', 'malformed@0/2 break'],
  ['5f 9f ff ff', 'malformed@0/1 chunk'],
  ['5f 5f ff ff', 'malformed@0/1 chunk'],
  ['5f 7f', 'malformed@0/1 chunk'],                 // the chunk is refused at its initial byte (see the module note)
  ['5f 41', 'truncated@0/1'],
  ['7f 61 61 41 00 ff', 'malformed@0/3 chunk'],
  ['5f 1c ff', 'malformed@0/1 reserved-ai'],
  // indefinite on major types 0, 1, 6, nested
  ['82 00 1f', 'malformed@0/2 indefinite-mt'],
  ['d8 18 df', 'malformed@0/2 indefinite-mt'],
  ['9f 3f', 'malformed@0/1 indefinite-mt'],
  // reserved additional information, bad simple values, deep inside
  ['01 02 9f 82 01 bc', '1 | 2 | malformed@2/5 reserved-ai'],
  ['a1 61 61 f8 1f', 'malformed@0/3 bad-simple'],
  ['a1 61 61 f8 20 f8 00', '5 | malformed@5/5 bad-simple'],
  // truncations: at a head, in a string, a missing item, an open indefinite item
  ['1b 00 00', 'truncated@0/0'],
  ['82 01 1b 00', 'truncated@0/2'],
  ['82 01', 'truncated@0/2'],
  ['9f 01 02', 'truncated@0/3'],
  ['c1 c2', 'truncated@0/2'],
  ['5b ffffffffffffffff 01 02 03', 'truncated@0/0'],
  ['9b ffffffffffffffff 01 02 03', 'truncated@0/12'],
  ['bb 7fffffffffffffff', 'truncated@0/9'],
  ['5f 41 00 42 00', 'truncated@0/3'],
];
const render = r => [...r.items.map(([, e]) => String(e)), r.stop.kind === 'end' ? null : `${r.stop.kind}@${r.stop.offset}/${r.stop.at}${r.stop.why ? ' ' + r.stop.why : ''}`].filter(x => x !== null).join(' | ');

test('hand vectors: break-code misuse, malformed and truncated stops with their offsets', () => {
  for (const [h, want] of STOPS) assert.equal(render(frameSequence(unhex(h))), want, h);
});

test('framing starts at a given offset; byte-string contents are reported on request', () => {
  const S = unhex('ff 01 d8 18 43 a1 01 02 5f 41 07 ff');
  assert.equal(render(frameSequence(S, 1)), '2 | 8 | 12');
  const info = { strings: [] };
  assert.deepEqual(frameItem(S, 2, info), { kind: 'ok', end: 8 });
  assert.deepEqual(info.strings, [[5, 8]]);
  info.strings = [];
  frameItem(S, 8, info);
  assert.deepEqual(info.strings, [[10, 11]]);
  const text = { strings: [] };
  frameItem(unhex('63 616263'), 0, text);
  assert.deepEqual(text.strings, []);   // only byte strings
});

test('the items open at a stop, with lower bounds on their ends', () => {
  const open = h => { const info = {}; const r = frameItem(unhex(h), 0, info); return [r, (info.open ?? []).map(x => `${x.head}:${x.min}`).join(' ')]; };
  // a5: 10 items due; the value 67 at 2 claims 7 bytes of content
  assert.deepEqual(open('a5 60 67 efbfaf'), [{ kind: 'truncated', at: 2 }, '0:11 2:10']);
  // an item due at the end: the input length, needing one byte
  assert.deepEqual(open('82 01'), [{ kind: 'truncated', at: 2 }, '0:3 2:3']);
  // a head cut short claims its own length
  assert.deepEqual(open('c1 82 1b 00'), [{ kind: 'truncated', at: 2 }, '0:3 1:4 2:11']);
  // indefinite items and tags need one more byte; a refused head is not listed
  assert.deepEqual(open('9f d8 18 bf 01 ff'), [{ kind: 'malformed', at: 5, why: 'break-as-value' }, '0:6 1:6 3:6']);
  assert.deepEqual(open('98 20 5f 7f'), [{ kind: 'malformed', at: 3, why: 'chunk' }, '0:35 2:4']);
  assert.deepEqual(open('00'), [{ kind: 'ok', end: 1 }, '']);
});

test('deep nesting does not exhaust the stack', () => {
  const N = 1_000_000;
  const arr = new Uint8Array(N + 1).fill(0x81); arr[N] = 0x00;
  assert.deepEqual(frameItem(arr, 0), { kind: 'ok', end: N + 1 });
  assert.deepEqual(frameItem(arr.subarray(0, N), 0), { kind: 'truncated', at: N });
  const ind = new Uint8Array(2 * N).fill(0x9f, 0, N).fill(0xff, N);
  assert.deepEqual(frameItem(ind, 0), { kind: 'ok', end: 2 * N });
  assert.deepEqual(render(frameSequence(cat([ind, unhex('ff')]))), `${2 * N} | malformed@${2 * N}/${2 * N} break`);
  const tags = new Uint8Array(N + 1).fill(0xc6); tags[N] = 0xf6;
  assert.deepEqual(frameItem(tags, 0), { kind: 'ok', end: N + 1 });
  // a long sequence of one-byte items
  assert.equal(frameSequence(new Uint8Array(N)).items.length, N);
});
