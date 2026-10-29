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

The walk functions (`item`, `read-arg`, `take-len`, `enter-container`,
`bytes-content`, …) take an explicit **`end` offset** and never look at the
input's length: `scan` passes `length(bytes)`, and a caller can walk an item
embedded in a byte string by passing the byte string's end (`.cbor`,
architecture §17 Q21; the navigation primitives of D026). "Bytes remaining"
below always means `end − position`.

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

## Resumable scanner (P6.1, `kin/rscan.kin`)

The same checks, order, codes, error offsets and item counts as the recursive
scanner (gated by `bb rscan-test`), as a loop over an explicit frame stack in
a **per-session** scratch arena, over windows of a message whose exact length
is declared up front (known-length sessions only).

API (`gen/js/snug/cbor/rscan.mjs`, Rust `snug::cbor::rscan`):
`rscanScratchLen(maxDepth, min(length, maxBytes))`,
`rscanInit(o, s, length, quantum)` (o filled by `scanOptions`; both arrays
belong to one session), `rscanStep(window, o, s, baseHi, baseLo)` → `0` |
code | `RS_NEED` (-1: give a window holding
`[rscanNeedOffset(s), +rscanNeedLength(s))`) | `RS_YIELD` (-2: the work
quantum is spent; give a window holding `rscanPosition(s)`).
`host/js/src/sources.mjs` drives it for handles and push sources.

**Never split, so no carried decoder state**: a head (with any float
payload), a UTF-8 sequence, a typed-array element, the first byte of a
bignum's content, a decimal mantissa's whole bignum content. Each is asked
for whole from its first byte; the host's unconsumed tail is the carried
state. Text and typed-array content are scanned incrementally; byte-string
content is never read at all, so a handle need not fetch it (`scanHandle` reads from the next head on).

**Scratch layout** (words): header `s[0..23]`, then `maxDepth` frames of 28
words from `s[24]`, then the key arena (`S_ARENA`), bytes packed four to a
word, little-endian within the word.

| header | | frame (`F_*`, base `24 + 28·i`) | |
| --- | --- | --- | --- |
| 0 `S_PHASE` | resume point (`PH_*`) | 0 `F_KIND` | 1 array, 2 map, 3 tag-4 pair, 4 tag-40 pair |
| 1 `S_POS` | position (absolute) | 1 `F_CDEPTH` | depth of its children |
| 2 `S_TOTAL` | declared length | 2 `F_REM` | children (pairs) left |
| 3 `S_CEND` | end of text / typed-array content (absolute) | 3 `F_STATE` | map: 0 key next, 1 in key, 2 in value; pair: element 0/1 |
| 4 `S_SP` | frames in use | 4 `F_PLEN` | previous key's encoded length, -1 none |
| 5, 6 `S_NEED_OFF`, `S_NEED_LEN` | the request | 5, 6 `F_PA`, `F_PALEN` | previous key: arena part (start, length) |
| 7 `S_QUANTUM` | work units per step (0: none) | 7, 8 `F_PW0`, `F_PWLEN` | previous key: window part (relative; empty between steps) |
| 8, 9, 10 `S_TPOS`, `S_TTAG`, `S_TSIZE` | the tag being read (absolute head position, number, element size) | 9, 10 `F_KSTART`, `F_KMAJ` | key being read: start (absolute), major type |
| 11 `S_MAXF` | frames allocated (maxDepth) | 11 `F_SHAPE` | 1: this array is a tag-40 shape |
| 12 `S_ATOP` | arena top (bytes) | 12, 13 `F_EXPOK`, `F_MANT` | tag 4: exponent / mantissa verdicts noted from heads |
| 13–16 `S_KACT`, `S_KA`, `S_KALEN`, `S_KW0` | the key being read: active, arena start/length, window start (absolute) | 14–17 `F_NDBAD`, `F_NDK`, `F_NDSEEN`, `F_COUNT` | tag 40: shape bad, dimensions, seen, element count |
| 17 `S_ARENA` | first arena word | 18 `F_TPOS`; 19–26 `F_DIMS` | the tag's position (absolute); up to 8 dimensions |

**Previous keys**: one per ACTIVE map (nested maps each keep theirs), kept as
a window span while the window lasts and copied into the arena only when the
walk suspends or yields (a whole-buffer scan copies nothing). Regions are
stacked in frame order (each open map's previous key, then the key being
read); a key that ends becomes its map's previous key in place, and a map's
region is freed when it closes. Keys are disjoint spans of the message, so
the arena never holds more than `min(length, maxBytes)` bytes.

**Tag 4 / tag 40** cannot re-read their elements when the pair ends (the
bytes may be gone), so each child's verdict input is **noted from its head**
as it starts (exponent and integer-mantissa checks, shape entries, data
count; a bignum mantissa's remainder when its content is read) and the
semantic check runs at the pair's end, in the recursive scanner's order.

**Yields**: one unit per item and per byte of text or typed-array content
scanned (at least one whole UTF-8 sequence per step, so any quantum
progresses); yield points are item starts and sequence / element boundaries.
