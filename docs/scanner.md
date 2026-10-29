# The CBOR profile scanner — order of checks

Normative for `kin/scan.kin` and its helpers (`kin/head.kin`, `text.kin`,
`float.kin`, `keys.kin`, `tags.kin`), generated to
`gen/{js,rust}/snug/cbor/*`. The scanner accepts exactly what 3sln.me's
`packages/core/cbor.mjs` `decode` accepts and refuses everything it refuses
**with the same code**; where an input breaks several rules, the first check
below that fails decides. The arbiter is cbor.mjs itself
(`bench/baseline/cbor-3sln.mjs`): `bb scan-test` compares codes on every
vector, on fixed edge cases and on seeded mutations (architecture §4.5; review
C15, C16).

Status: implemented and gated (DEVLOG P1.3). Integer-only (D009).

## API (the generated `snug.cbor.scan` module)

| JS (`gen/js/snug/cbor/scan.mjs`) | Rust (`snug::cbor::scan`) | |
| --- | --- | --- |
| `scanOptions(o, topAny, cose, maxBytes, maxDepth, maxEntries, maxItems)` | `scan_options` | fill an `Int32Array(16)` / `[i32; 16]` |
| `scan(bytes, o)` | `scan` | 0, or a code (below) |
| `errorOffset(o)` | `error_offset` | offset the refusal was decided at, -1 if accepted |
| `itemsScanned(o)` | `items_scanned` | the item counter |
| `codeName(code)` | `code_name` | cbor.mjs's string for a code |

`o` is input and scratch: slots 0–5 options, 6 error offset, 7 items, 8–10
scratch (`snug.cbor.codes`). Allocate it once and reuse it. Limits are
cbor.mjs's options clamped by the host to 0..2^31−1 (exact: no input or count
reaches 2^31); inputs must be shorter than 2^31 bytes. Recursion depth is at
most `maxDepth` + 2 frames of the walk; hosts should keep `maxDepth ≤ 256`.

Codes: 1 truncated, 2 non_shortest, 3 indefinite, 4 malformed, 5 key_type,
6 key_order, 7 duplicate_key, 8 text, 9 float, 10 simple, 11 tag, 12 bignum,
13 decimal, 14 typed_array, 15 ndarray, 16 trailing, 17 depth,
18 too_many_entries, 19 too_many_items, 20 too_large, 21 not_map.

The error offset is snug's own (cbor.mjs reports none): the item's head for
head, length, limit, tag and float refusals; the key's first byte for
`key_type`, `key_order`, `duplicate_key`; the first byte of the bad sequence
for `text`; the bad element for a NaN in a typed array; the content's first
byte when a tag's content is missing or not a byte string; otherwise the
tag's head for `bignum`, `decimal`, `ndarray` and `typed_array`; the byte after
the item for `trailing`; 0 for `too_large`/`not_map`. JS and Rust report the
same offset (gated).

## Top level

1. `length > maxBytes` → **too_large**.
2. option top = map and (empty input, or major type of byte 0 ≠ 5) →
   **not_map** (byte 0 is peeked; nothing else is read).
3. scan one item at offset 0, depth 0 (below).
4. bytes remain after it → **trailing**.

## One item at `pos`, depth `d`

1. items + 1 > maxItems → **too_many_items** (counted BEFORE the head is read).
2. no byte at `pos` → **truncated**.
3. head: major `m`, additional information `ai`.
   * `ai < 24`: the argument is `ai`.
   * `m = 7` and `ai` 25..27: a float — go to *Floats* (no argument check here).
   * `ai` 24/25/26/27: 1/2/4/8 argument bytes must remain, else **truncated**;
     the value must need that width (≥ 24, ≥ 2^8, ≥ 2^16, ≥ 2^32), else
     **non_shortest**. This applies to `f8 xx` too: xx < 24 is non_shortest.
   * `ai` 28..30 → **malformed**; `ai` 31 → **indefinite** (so a stray
     `ff` break is indefinite).
4. by major type:
   * 0, 1: done (the argument is up to 64 bits, kept as two i32 halves).
   * 2: length > bytes remaining → **truncated** (an argument ≥ 2^31 is
     always more than remains).
   * 3: as 2, then the text rule over the payload → **text**: WHATWG fatal
     UTF-8 (no overlong, no surrogate `ED A0..BF`, nothing above U+10FFFF, no
     truncated sequence, no stray continuation or `C0 C1 F5..FF`), then no
     noncharacter: U+FDD0..U+FDEF and U+xFFFE/U+xFFFF in every plane.
   * 4 array of n: `d ≥ maxDepth` → **depth**; n > bytes remaining →
     **truncated**; n > maxEntries → **too_many_entries**; then n items at
     depth d+1.
   * 5 map of n pairs: `d ≥ maxDepth` → **depth**; 2n > bytes remaining →
     **truncated**; n > maxEntries → **too_many_entries**; then per pair:
     1. no byte left → **truncated**;
     2. the key's major type is PEEKED: not 3 (text), and not (cose option,
        `d = 0`, major 0/1) → **key_type**;
     3. the key is scanned as an item at d+1 (its own refusals win);
     4. a cose integer label must be a safe integer (major 0 ≤ 2^53−1,
        major 1 with n < 2^53−1, i.e. value ≥ −(2^53−1)) → **key_type**;
     5. compared with the previous key's encoded bytes (bytewise, shorter
        first on a common prefix): equal → **duplicate_key**, smaller →
        **key_order**;
     6. the value is scanned as an item at d+1.
   * 6 tag t: `d ≥ maxDepth` → **depth** (a tag is a level, checked before its
     number); t ≥ 2^32 → **tag**; then by t (below); any other t → **tag**.
   * 7: `ai` 20, 21, 22 (false, true, null) accepted; anything else
     (unassigned simple values, `f7` undefined, `f8 xx` with xx ≥ 24) →
     **simple**.

## Floats (major 7, `ai` 25/26/27)

1. 2/4/8 bytes must remain → **truncated**.
2. **float**: NaN, ±∞, ±0, or an integral value of magnitude ≤ 2^53−1 — bit
   tests: exponent all ones; exponent and fraction zero; unbiased exponent
   0..52 with the fraction bits below the binary point all zero.
3. **non_shortest**: a float32 that float16 holds exactly (unbiased exponent
   −14..15 with the low 13 fraction bits zero, or −24..−15 and a multiple of
   2^−24); a float64 that float32 holds exactly (−126..127 with the low 29
   fraction bits zero, or −149..−127 and a multiple of 2^−149). float16 is
   never non_shortest.

## Tags: what is counted, what is a level

| Tag | Content check order | Items counted | Depth levels |
| --- | --- | --- | --- |
| 2, 3 bignum | byte left? (**truncated**) → major 2? (**bignum**) → its head (truncated / non_shortest / malformed / indefinite) → its length (**truncated**) → 9 ≤ len, first byte ≠ 0 (**bignum**) → len ≤ 128 (**bignum**) | the tag only (content is NOT an item) | the tag |
| 69–72, 77–79, 84–86 typed arrays (LE) | byte left? → major 2? (**typed_array**) → its head → its length → len a multiple of the element size (**typed_array**) → tags 84/85/86: no NaN element (**typed_array**; −0 and ±∞ allowed) | the tag only | the tag |
| 4 decimal | byte left? (**truncated**) → byte is `82`? (**decimal**) → the inner array AS AN ITEM (counted → **too_many_items**; a level → **depth**; 2 ≤ remaining → **truncated**; 2 ≤ maxEntries → **too_many_entries**) → exponent item → mantissa item (each with all its own refusals) → THEN semantics (**decimal**): exponent major 1 with n ≤ 1023 (−1024..−1); mantissa major 0/1 or tag 2/3, non-zero, not divisible by 10 (n+1 for major 1 and tag 3; remainder over the bytes) | tag + array + both elements (+ their contents) | tag, array |
| 40 ndarray | as tag 4 up to the semantics, with **ndarray**; then: data an array, or a typed-array tag (counted by bytes / element size); shape an array of 1..8 major-0 integers, each 1..2^53−1, whose product equals the count — product checked by division (`d ≤ count / p`), so it never overflows (**ndarray** for all) | tag + array + shape and data items | tag, array |

Other tags (0, 1, 5, 64, 68, 73–76, 80–83, 87, 1040, 55799, …) → **tag**.

## How it is gated

`bb scan-test [mutations] [seed]` (default 30 000, seed 1) runs, through the
generated JS and a DEBUG Rust build (overflow checks on, panics caught per
case):

* both 3sln.me vector files (profile vectors must equal cbor.mjs too);
* ~210 fixed edge cases: every limit at and one past, length bombs, cose
  labels at ±2^53, top-level map, and the multiply-invalid precedence cases;
* seeded mutations of cbor.mjs-encoded random values, of structured byte-level
  items aimed at the bit tests (floats at the exponent edges with the lowest
  set fraction bit at each threshold; UTF-8 fragments around every boundary;
  decimals, bignums, typed arrays with NaN-like patterns, ndarray shapes), and
  of random short strings, under random options including tiny limits.

Every case must give cbor.mjs's code on both targets and the same error offset
on both; a re-run with the input behind a throwing out-of-bounds trap shows the
JS never reads outside the input. Mutating a threshold in the kin source turns
the gate red (DEVLOG P1.3).
