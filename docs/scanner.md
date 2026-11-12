# The CBOR profile scanner — order of checks

Normative for `kin/scan.kin` and its helpers (`kin/head.kin`, `text.kin`,
`float.kin`, `keys.kin`, `tags.kin`, `stdtags.kin`), generated to
`gen/{js,rust}/snug/cbor/*`. The scanner checks RFC 8949 §4.2.1 core
deterministic encoding under the **profile flags** in `o[11]` (D120,
[profiles](profiles.md#the-option-model-d120)). With the flags at 0 — the
Bindle profile — it accepts exactly what 3sln.me's `packages/core/cbor.mjs`
`decode` accepts and refuses everything it refuses **with the same code**;
where an input breaks several rules, the first check below that fails
decides. The Bindle arbiter is cbor.mjs itself (`bench/baseline/cbor-3sln.mjs`):
`bb scan-test` compares codes on every vector, on fixed edge cases and on
seeded mutations (architecture §4.5; review C15, C16). The other flags are
held to the hand-written codes and offsets of
`corpus/cbor-vectors/deterministic.json` and to cbor2 (profiles.md, "Against
cbor2"); `PF_VALID` (P8.4) to `bb valid-test`'s RFC vectors, equivalence
property and cbor2 differential. Rules marked **[flag]** below depend on a flag.

Status: implemented and gated (DEVLOG P1.3). Integer-only (D009).

## API (the generated `snug.cbor.scan` module)

| JS (`gen/js/snug/cbor/scan.mjs`) | Rust (`snug::cbor::scan`) | |
| --- | --- | --- |
| `scanOptions(o, topAny, cose, maxBytes, maxDepth, maxEntries, maxItems)` | `scan_options` | fill an `Int32Array(16)` / `[i32; 16]`; the profile flags to 0 (Bindle) |
| `scanProfile(o, flags)` | `scan_profile` | the profile flags (PF_*, host bits 0–6), after `scanOptions` |
| `scan(bytes, o)` | `scan` | 0, or a code (below) |
| `errorOffset(o)` | `error_offset` | offset the refusal was decided at, -1 if accepted |
| `itemsScanned(o)` | `items_scanned` | the item counter |
| `codeName(code)` | `code_name` | cbor.mjs's string for a code |

`o` is input and scratch: slots 0–5 options, 6 error offset, 7 items, 8–10
scratch, 11 the profile flags (`snug.cbor.codes`). Allocate it once and reuse it. Limits are
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
     2. the key's major type is PEEKED: not 3 (text), and not admitted by
        the key kinds **[flag]** (`PF_KEYS` 2/3: any major; 1: majors 0/1;
        0: majors 0/1 only with the cose option at `d = 0`) → **key_type**;
     3. the key is scanned as an item at d+1 (its own refusals win);
     4. under `PF_KEYS` 0, a cose integer label must be a safe integer
        (major 0 ≤ 2^53−1, major 1 with n < 2^53−1, i.e. value ≥ −(2^53−1))
        → **key_type**;
     5. compared with the previous key's encoded bytes (bytewise, shorter
        first on a common prefix): equal → **duplicate_key**, smaller →
        **key_order**;
     6. the value is scanned as an item at d+1.
   * 6 tag t: `d ≥ maxDepth` → **depth** (a tag is a level, checked before its
     number); t ≥ 2^32 → **tag** unless `PF_TAGS` is 2/3 **[flag]** (then
     its *rule tag*: −2, or −1 for 2^64 − 1, D180); then by t (below); any
     other t → **tag** unless `PF_TAGS` is 2/3.
   * 7 (after the head: `f8 xx` with xx < 24 is **non_shortest** first, as
     every head): `ai` 20, 21, 22 (false, true, null) accepted; then, under
     `PF_UNDEFINED` (or `PF_VALID`) **[flag]**, `f8 xx` with xx < 32 →
     **malformed** (RFC 8949 §3.3, Appendix F); under `PF_UNDEFINED`
     **[flag]** every other simple value is accepted — `f7` undefined and the
     unassigned `e0`–`f3` and `f8 20`–`f8 ff` (D284); anything else → **simple**
     (Bindle: every simple value but false, true and null).
   * 3, text: noncharacters are refused unless `PF_NONCHAR` **[flag]**.

## Under `PF_VALID` (P8.4, D260–D264)

The same walk, the same order, with these differences **[flag]**:

**Precedence across classes.** The first refusal in stream order wins, also when it
is a validity refusal and the input is, further on, not well-formed. Only
**truncated** and **malformed** speak to RFC 8949 Appendix F; any other code
says that the walk stopped before reaching a well-formedness error, not that
the input has none. Two RFC 8949 Appendix F.1 examples show it:
`bf 01 02 01 02` (an indefinite map not closed by a break) is **duplicate_key**
at offset 3, the second key `01`, before the end of input; `bf 00 00 00 ff` (a
break in a value position) is **duplicate_key** at offset 3, the second key
`00`, before the break. Under `deterministic` / `bindle` the same holds with
**indefinite** at offset 0. `bb sequence-test` holds these two to
`duplicate_key` and the other 92 F.1 examples to exactly **truncated** or
**malformed**, and the independent RFC 8742 framer (P9.5) accepts a refusal
only where it lies no later than the framer's own stop.

* Heads: any width is accepted (no **non_shortest**); `ai` 31 opens an
  indefinite-length item: a string of definite chunks of its own major type
  (each a definite head, **malformed** otherwise; text chunks each valid
  UTF-8), or an array / map whose entries run to a break `ff` (the depth bound
  first; **too_many_entries** at the head before the entry that would pass
  `maxEntries`; **truncated** at the end of input; a break where a map value
  belongs is **malformed**). A break anywhere else, and `f8 xx` with xx < 32,
  are **malformed** (RFC 8949 Appendix F).
* Floats: any width, any NaN.
* Maps: keys in any order. While the keys ascend bytewise and each is its own
  canonical form, an equal neighbour is **duplicate_key** at once (as
  before); a key out of order, not canonical, or EC-sensitive (a float, a
  NaN, a zero; RFC 8949 §4.2's EC form differs from its bytes) marks the map,
  and at its end its keys' canonical (EC) forms are sorted and compared:
  **duplicate_key** at the second occurrence of an equal key, ceil(len/8)
  units per comparison (D263, D277). When every key is its own comparison
  form the check runs at the map's end; otherwise (forms must be written to
  the canonical buffer, `scanCb`) it is recorded and run after the walk, in
  walk order, its refusal reporting the items walked to the map's end.
* Tags: tag 0/32 text and tag-24 payloads inside an indefinite-length string
  are checked after their chunks are gathered (recorded, run after the walk
  in walk order); tags 2/3 accept any bignum of at most 128 content bytes;
  tags 4/40 take any array head (D265).
* The scanner notes in `o[O_VCTL]` whether the input is its own deterministic
  form (`VC_NONDET`), whether some map's keys may be out of canonical order
  (`VC_UNSORTED`) and whether an EC-sensitive key occurred (`VC_ECS`); the
  hosts build the canonical copy (`canon.kin dc-copy`) when the input is not
  its own DC form, and views search unsorted maps linearly.

## Floats (major 7, `ai` 25/26/27)

Under `PF_FLOATS` **[flag]** (D122): 2/4/8 bytes must remain (**truncated**);
then a NaN other than float16 `7e00`, and the quiet NaN with a sign bit
included, → **float** (the canonical quiet NaN as float32 `7fc00000` or
float64 `7ff8000000000000` → **non_shortest**); then any value a narrower
width holds exactly — ±0 and ±∞ in float32/float64 included — →
**non_shortest**. Without the flag (Bindle):

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

Under `PF_TAGS` 1–3 **[flag]** the standard set adds (D121; checks after the
tag's depth and 32-bit checks):

| Tag | Content check order | Items counted | Depth levels |
| --- | --- | --- | --- |
| 0, 1, 21, 22, 23, 32 | the content AS AN ITEM at d+1 (all its own refusals) → the rule (**tag**): 0 text in RFC 3339 date-time form; 1 an integer or a finite float; 32 text in URI form; 21–23 anything | tag + content (+ its contents) | tag, content |
| 24 | the content as an item at d+1 → a byte string (**tag**) → its payload as ONE item at d+2, bounded by the string's end (its own refusals; **truncated** if it runs past the end, **trailing** at the byte after it) | tag + string + the payload's items | tag, string, payload |
| 55799 | only at d = 0 of the document (`PF_SUB` clear), else **tag**; then the content as an item | tag + content | tag, content |

Under `PF_TAGS` 2 or 3 (any tag, D180) every other tag number is admitted
(`std-allowed`), by the same path as 21–23:

| Tag | Content check order | Items counted | Depth levels |
| --- | --- | --- | --- |
| 65535, 2^32 − 1, 2^64 − 1 (rule tag −1) | **tag** at once (RFC 8949 §9.2 invalid numbers) | the tag | the tag |
| 64–68, 73–75, 80–83, 87 | the content as an item at d+1 → a byte string whose length is a multiple of the element size (1/2/4/8/16), read from its head (**tag**) | tag + content | tag, content |
| any other (5, 16–18, 61, 76, 96–98, 1040, ≥ 2^32 …) | the content as an item at d+1 (all its own refusals) | tag + content | tag, content |

A number of more than 32 bits never takes a 32-bit tag's path (2^32 + 2 is
not a bignum). Under `PF_TAGS` 1 the other tags, and under 0 the standard
ones too, → **tag**.

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

**Standard tags** (P7.1, D124) get a frame of kind 5 (`K_STD`: `F_STAG` 27 the
tag number, `F_EXPOK` the head verdict, `F_COUNT` the content start). The
content's head verdict is noted from its head (tag 1's whole rule; the major
type for 0, 24, 32; an any-level typed array's whole rule, D180). The text
content of a tag 0/32 and the byte-string
content of a tag 24 are **asked for whole** before their walk (and scanned
without yielding), so the rule — or the tag-24 payload walk by the recursive
scanner — runs over the window when the content ends.

**Keys of any kind** (`PF_KEYS` any): a key that is an array, map or tag is
asked for whole (its extent by `key-end-any`, windows doubling) and walked by
the recursive scanner, so no nested key state crosses a window; byte-string,
bignum and integer typed-array content inside an active key is not skipped
but walked through the windows (`PH_KSKIP`, 11) so the key arena receives it.

**Yields**: one unit per item and per byte of text or typed-array content
scanned (at least one whole UTF-8 sequence per step, so any quantum
progresses); yield points are item starts and sequence / element boundaries.

**Unknown length (D085, D146).** `pushScanner(undefined, …)` and `scanStream`
do not use this scanner: they run the validator VM's drain-mode session
against a built-in `r = any` Program compiled with the largest limits
(`host/js/src/any-program.mjs`), which gives this scanner's code, offset and
items on every input (`bb vm-test`, profile identity). The resumable scanner
stays known-length only.
