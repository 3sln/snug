# snug — the Program format

Status: **frozen candidate, format version 1 (2026-10-29)**, provisional
(D015). Nothing here is owner-approved. It is the only interface between the
compiler work (P3.2, P3.3) and the VM work (P3.4). It implements architecture
revision 2 on paper (`docs/architecture.md`, "arch"). Where arch was ambiguous
or wrong, this document does not decide silently: §17 lists every such point
with the resolution it proposes, and the format below is written *as if* those
resolutions are accepted. A rejected resolution changes this document before
either side builds on it.

Changes after freezing bump `FORMAT_VERSION` (header word 1); the VM refuses
any other version. **Format 1.1** (D084, D141, 2026-11-03) adds extension
controls: leaf kind 18 `EXT` (§4.2), header words 30, 31 and 39 (§2, §4.6),
reason codes 42 and 43 (§9.1) and a charge row (§14). The compiler writes 1.1
only for a Program that uses an extension control; every other Program is
byte-identical to 1.0.

---

## 0. Conventions

* **P** is the Program: one `Int32Array` / `Vec<i32>`, little-endian when
  serialised. **B** is the byte pool: one `Uint8Array` / `Vec<u8>`.
* A **word offset** is an index into P; a **byte offset** is an index into B.
  Offsets are absolute (from P[0] / B[0]), never relative, never pointers.
* An **id** is a 0-based index into a section (leaf id, typeset id, key id,
  …). An absent id is `-1`. Ids of fixed-width records give their offset by
  arithmetic (`S_LEAVES + 8·id`); ids of variable-length records go through an
  index section (`P[S_TS_INDEX + id]` is the record's word offset).
* **INF** = `0x7fffffff` (2^31 − 1). Used for unbounded maxima and size
  bounds; a counter compared with `<` against INF never reaches it (counters
  are bounded by entries ≤ 2^24).
* A 64-bit unsigned quantity (a tag number, a head argument, an ordered float
  key) is two words **hi, lo** holding the bit pattern; compare with `ult`
  (snug.lang) on hi, then lo.
* Field annotations, used in every table:
  * **[V]** verified: the structural verifier checks the field is in range and
    consistent with other fields (§11).
  * **[D]** derived: the verifier recomputes the field from other fields and
    refuses the Program if the stored value differs. Derived fields are stored
    (not recomputed at load into a side table) so that Program bytes are a
    pure function of the compilation and the VM reads them directly.
  * **[S]** semantic: a property the compiler proves (determinism rule,
    counter predecessor condition, factor conditions, closure exactness beyond
    the superset check). The verifier cannot check it; a corrupt value can
    produce a wrong verdict but never an out-of-range access, a crash, or more
    work than the budget allows.
* Every reserved or unused word is 0 [V].

## 1. Overall layout

```
P:  header (64 words)
    S0  RULES          5 words per rule, sorted by name bytes
    S1  LEAVES         8 words per leaf
    S2  TS_INDEX       1 word per typeset (offset)          [D]
    S3  TS_DATA        typeset records
    S4  KEYS           2 words per literal key, sorted by encoding
    S5  GROUP_INDEX    1 word per residual group             [D]
    S6  GROUP_DATA     group records
    S7  MAP_INDEX      1 word per map table                  [D]
    S8  MAP_DATA       map tables
    S9  ARRAY_INDEX    1 word per array automaton            [D]
    S10 ARRAY_DATA     array automata
    S11 REGEX_INDEX    1 word per regexp automaton           [D]
    S12 REGEX_DATA     regexp automata
    S13 INTERVALS      6 words per integer interval
    S14 FINTERVALS     4 words per float interval
    S15 LITREFS        2 words per LITSET member
    S16 CSET_INDEX     1 word per closure set                [D]
    S17 CSET_DATA      closure-set records
    S18 CHAIN_INDEX    1 word per closure chain              [D]
    S19 CHAIN_DATA     chain records
    END
B:  rule names, key encodings, literal encodings, bignum bound magnitudes,
    .bits masks
```

Sections are contiguous, in this order, with no gaps; a section's end is the
next section's start. Every index section is derived: the verifier walks the
data section record by record (records are stored in id order, back to back)
and requires `index[id]` to equal the walk position.

## 2. Header (words 0–63)

| Word | Name | Meaning | |
| --- | --- | --- | --- |
| 0 | `MAGIC` | `0x67756e73` (the bytes `s n u g` little-endian) | [V] |
| 1 | `FORMAT_VERSION` | 1 | [V] |
| 2 | `HEADER_WORDS` | 64 | [V] |
| 3 | `PROGRAM_WORDS` | length of P | [V] |
| 4 | `POOL_BYTES` | length of B | [V] |
| 5 | `PROFILE` | 0 `full`, 1 `bindle`, 2 `bus` (informative at run time) | [V] |
| 6 | `FLAGS` | bit 0: some key in KEYS is an integer; bit 1: a TEXT leaf has a regexp; bit 2: an EMBED leaf exists; bit 3: an AND/NOT leaf exists; bit 4 (1.1): an EXT leaf exists | [D] |
| 7–14 | `SOURCE_KEY` | SHA-256 of the source preimage (§13.2), 8 words, word i = big-endian bytes 4i..4i+3 as i32. The kin compiler writes zeros; the host fills it before the Program is used or stored. Not verifiable. | — |
| 15 | `N_RULES` | rules | [V] |
| 16 | `N_LEAVES` | leaves (≤ 2^20, §17 Q18) | [V] |
| 17 | `N_TYPESETS` | | [V] |
| 18 | `N_KEYS` | literal keys | [V] |
| 19 | `N_GROUPS` | residual groups | [V] |
| 20 | `N_MAPS` | map tables | [V] |
| 21 | `N_ARRAYS` | array automata | [V] |
| 22 | `N_REGEXPS` | regexp automata | [V] |
| 23 | `N_INTERVALS` | integer intervals | [V] |
| 24 | `N_FINTERVALS` | float intervals | [V] |
| 25 | `N_LITREFS` | LITSET members | [V] |
| 26 | `N_CSETS` | closure sets | [V] |
| 27 | `N_CHAINS` | closure chains | [V] |
| 28 | `TS_ANY` | typeset id of `{ANY}`, or −1 if no leaf needs it | [V] |
| 29 | `G_EMPTY` | group id of the empty group, or −1 | [V] |
| 30 | `N_EXTS` | format 1.1: extension controls in the table (§4.6); 0 under 1.0 | [V] |
| 31 | `EXT_NAMES` | format 1.1: pool offset of their names; 0 when `N_EXTS` = 0 | [V] |
| 32 | `LIM_DEPTH` | compiled depth **D** (default 32, ≤ 256); scratch is sized for item depths 0..D | [V] |
| 33 | `LIM_INPUT_BYTES` | default input bytes (≤ 2^31 − 1) | [V] |
| 34 | `LIM_ENTRIES` | default entries per container (≤ 2^24) | [V] |
| 35 | `LIM_ITEMS` | default items per message (≤ 2^24) | [V] |
| 36 | `LIM_BIGNUM_BYTES` | default bignum content bytes (≤ 4 096) | [V] |
| 37 | `LIM_BUDGET` | default step budget | [V] |
| 38 | `LIM_TOTAL_BYTES` | the compile cap on Program + pool + scratch bytes that this Program was checked against (≤ 64 MiB) | [V] |
| 39 | `EXT_NAMES_LEN` | format 1.1: byte length of the names; 0 when `N_EXTS` = 0 | [V] |
| 40 | `SCRATCH_MAX` | max over rules of `rule.scratch_words` | [D] |
| 41 | reserved | 0 | |
| 42–61 | `S_RULES` … `S_CHAIN_DATA` | word offsets of sections S0..S19 | [V] |
| 62 | `S_END` | = `PROGRAM_WORDS` | [V] |
| 63 | reserved | 0 | |

Per-call limits (§12.3) may only **lower** words 32–37.

## 3. Rules (S0)

One record per **validatable rule**: every non-generic type rule of the user's
schema. Group rules, generic rules and prelude rules are not listed (§17 Q11).
Sorted strictly by name bytes (UTF-8, bytewise), so the rule index of a name is
its position and `vm-rule-index` is a binary search.

| +0 | `name_off` | byte offset of the UTF-8 name in B | [V] |
| --- | --- | --- | --- |
| +1 | `name_len` | bytes, ≥ 1 | [V] |
| +2 | `typeset` | the rule's root typeset | [V] |
| +3 | `chain` | its closure chain (§10) | [V] |
| +4 | `scratch_words` | §12.1 with `MARK_CAP = N_LEAVES` | [D] |

## 4. Leaves (S1)

Fixed width, 8 words. Leaf ids are assigned in a **depth-first preorder walk of
the user's rules in source order**, a leaf numbered when first reached
(hash-consed leaves keep their first id; prelude leaves are numbered when the
walk first reaches them). The witness rules (§9) use this order.

| +0 | `kind | flags << 8` | kind in bits 0–7, flags in bits 8–15, rest 0 | [V] |
| --- | --- | --- | --- |
| +1 | `mask` | class mask (§4.1) | [D] |
| +2..+7 | `d0..d5` | kind-specific | [V] |

### 4.1 Item classes and masks

The VM computes one **class bit** per item from its head; a leaf's `mask` is
the set of classes it can possibly match. The filter is exact for kinds that
match whole classes and a prefilter for the rest.

| Bit | Value | Item |
| --- | --- | --- |
| 0 | `0x001` | major 0 |
| 1 | `0x002` | major 1 |
| 2 | `0x004` | major 2 (byte string) |
| 3 | `0x008` | major 3 (text) |
| 4 | `0x010` | major 4 (array) |
| 5 | `0x020` | major 5 (map) |
| 6 | `0x040` | major 6, tag number ∉ {2, 3} |
| 7 | `0x080` | major 7, ai ≤ 24: a simple value (D284) |
| 8 | `0x100` | a float whose value binary16 represents exactly, in any encoded width (D328) |
| 9 | `0x200` | a float whose value binary32 represents exactly (D328) |
| 10 | `0x400` | any float (D328); a float item has every width bit its value allows |
| 11 | `0x800` | major 6, tag 2 or 3 (bignum) |

`ALL = 0xfff`.

### 4.2 Leaf kinds

| Kind | Name | flags | d0 | d1 | d2 | d3 | d4 | mask (derived) | Children (closure, §10) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `ANY` | 0 | – | – | – | – | – | `ALL` | `TS_ANY` |
| 2 | `MAJOR` | 0 | major 0..7 | | | | | 0→`001` 1→`002` 2→`004` 3→`008` 4→`010` 5→`020` 6→`840` 7→`780` | majors 4, 5, 6: `TS_ANY` |
| 3 | `INT` | bit 0 `BIGOK` | first interval id | interval count ≥ 1 | | | | bit 0 if an interval meets POS, bit 1 if one meets NEG, bit 11 if `BIGOK` and one meets NEG_BIG or POS_BIG | none |
| 4 | `FLOAT` | bits 0–2: f16, f32, f64 allowed (≠ 0) | first finterval id | count (0 = unbounded) | | | | `flags << 8` | none |
| 5 | `SIMPLE` | 0 | lo | hi (lo ≤ hi; both in 0..23 or both in 32..255, D334) | | | | `080` | none |
| 6 | `LIT` | 0 | byte offset of the encoding | length ≥ 1 | | | | class of the encoding | none |
| 7 | `LITSET` | 0 | first litref id | count ≥ 2 | | | | the members' common class | none |
| 8 | `TEXT` | 0 | size lo (bytes) | size hi (INF) | regexp id or −1 | | | `008` | none |
| 9 | `BYTES` | 0 | size lo | size hi | `.bits` mask byte offset | mask length (0 = no `.bits`) | | `004` | none |
| 10 | `UINTX` | 0 | allowed bits hi | allowed bits lo | first interval id | interval count (0 = none) | | `001` | none |
| 11 | `TAG` | 0 | tag hi | tag lo | content typeset | | | `800` if tag ∈ {2,3} else `040` | content |
| 12 | `TAGSET` | 0 | lo hi | lo lo | hi hi | hi lo | content typeset | `040` if [lo,hi] holds a tag ∉ {2,3}; `800` if it holds 2 or 3 | content |
| 13 | `EMBED` | bit 0 `SEQ` (`.cborseq`) | content typeset | | | | | `004` | content (at the next physical depth, §8.4) |
| 14 | `ARRAY` | 0 | array id | | | | | `010` | every position typeset |
| 15 | `MAP` | 0 | map id | | | | | `020` | every literal entry's value typeset; every key and value typeset of every group its pools use |
| 16 | `AND` | 0 | leaf a | leaf b | | | | `mask(a) & mask(b)` | none (operands are same-item dependencies) |
| 17 | `NOT` | 0 | target leaf | literal leaf (kind `LIT`) | | | | `mask(target)` | none |
| 18 | `EXT` (1.1) | 0 | control id (< `N_EXTS`) | argument byte offset | argument length ≥ 1 | max item bytes ≥ 0 | | `ALL` | none |

Kind 0 and kinds ≥ 19 are invalid; kind 18 only under format 1.1. Unused `d`
words are 0.

Notes on kinds:

* **INT** covers `uint`, `nint`, `int`, `integer`, `unsigned`, ranges, `.lt …
  .ne` on integers and `uint .size …` (arch §4.6: every `.size` on `uint` is
  the interval `[256^(lo−1), 256^hi − 1]`, or from 0 when lo = 0). Bignums
  match only with `BIGOK`; the VM reads the bignum magnitude in place, and
  the tag's content is not visited as a schema child unless a `TAG` leaf asks
  (§17 Q13).
* **UINTX** is `uint .bits m` (optionally intersected with an interval list):
  a major-0 value v matches iff `v & ~allowed = 0` (64-bit, on hi/lo) and v is
  in the intervals (if any).
* **BYTES** `.bits`: data byte i must satisfy `data[i] & ~mask[i] = 0`, with
  `mask[i] = 0` past the mask's length (RFC 8610 §3.8.2 numbering: bit n is
  byte n>>3, bit n&7, LSB first).
* **LIT / LITSET** compare the item's whole encoded span (head through end of
  content) with pool bytes; correct because the profile admits one encoding
  per value. LITSET members are sorted strictly bytewise and share one class.
* **NOT** is only `target ∧ ¬literal` (`.ne` on non-numeric targets).
* **TAG** content and **EMBED** content and every map/array child are typeset
  ids, never leaf ids.
* **EXT** (format 1.1, D140/D141) is an extension control: `target .name
  argument` with `.name` registered with the compiler. The compiler emits one
  EXT leaf per (control, argument encoding, max) and `AND(t, EXT)` for each
  leaf t of the target, so an EXT is never an answer by itself (verified). The
  VM decides an EXT only inside the combinator pass (§8.4), only when it is
  needed — an AND's second operand once the first matched, an AND's first
  operand or a NOT's target — and at most once per item: an item longer than
  d3 bytes fails with `control_size` without asking; otherwise the host
  predicate is called with (d0, the pool bytes [d1, d1 + d2), the item's whole
  encoding, the budget left) and its verdict is MATCHED, `control` or `budget`
  (§14: the units it reports are charged). The argument is the CBOR
  encoding of the controller literal (an integer, text, bytes, a simple value,
  a range `lo..hi` as the array `[lo, hi]`, or an array of those).

### 4.6 The extension-control table (format 1.1)

Header word 30 (`N_EXTS`) counts the extension controls the Program uses;
words 31 and 39 locate their names in the pool: `N_EXTS` deterministic CBOR
text strings, back to back, filling exactly [`EXT_NAMES`, + `EXT_NAMES_LEN`).
Each name is 1..64 bytes `[A-Za-z_][A-Za-z0-9_-]*`, the names strictly
ascending bytewise; control id i is the i-th name [V]. With `N_EXTS` = 0 both
words are 0. A host binds each name to its registry's predicate when it loads
the Program and refuses a Program naming a control its registry lacks
(`missing_control`, naming it); the VM itself never reads the names.

### 4.3 Integer intervals (S13)

An interval is two inclusive **bounds**; a bound is 3 words
`region, a, b`:

| region | Name | a, b | Values |
| --- | --- | --- | --- |
| 0 | `NEG_INF` | 0, 0 | −∞ |
| 1 | `NEG_BIG` | byte offset, length of n's big-endian magnitude | v = −1 − n, n ≥ 2^64 (tag 3 range) |
| 2 | `NEG` | n hi, n lo | v = −1 − n, 0 ≤ n < 2^64 (major 1) |
| 3 | `POS` | v hi, v lo | 0 ≤ v < 2^64 (major 0) |
| 4 | `POS_BIG` | byte offset, length | v ≥ 2^64 (tag 2 range) |
| 5 | `POS_INF` | 0, 0 | +∞ |

Record: `lo_region lo_a lo_b hi_region hi_a hi_b` (6 words).

Order: region first (0 < 1 < … < 5); within `NEG` and `NEG_BIG` a larger n is a
smaller value; within `POS`/`POS_BIG` larger is larger; big magnitudes compare
by length then bytes (minimal, first byte ≠ 0, length ≥ 9). Exclusive schema
bounds are normalised by the compiler to inclusive ones (±1 on the magnitude).
A data item maps to a point the same way (major 0 → POS argument, major 1 →
NEG argument, tag 2 → POS_BIG content, tag 3 → NEG_BIG content), so no value
is ever materialised (D009).

A leaf's intervals (d0, d1) are a run of consecutive records, sorted
ascending, pairwise disjoint and non-adjacent, each lo ≤ hi [V]. Membership is
a binary search for the last interval with lo ≤ point.

### 4.4 Float intervals (S14)

Record: `lo_hi lo_lo hi_hi hi_lo` (4 words): inclusive bounds as **ordered
keys** of binary64 patterns, `key(x) = x ≥ 0 ? x | 2^63 : ~x` (64-bit,
unsigned order). float16/float32 data are widened to binary64 by integer
operations before keying. Under the Bindle float rules NaN, ±∞ and −0 never
reach a leaf (profile `float`); under the deterministic rules (D122) they
arrive as float16 only. Matching is numeric (RFC 8610 §3.8.6, D250): ±∞ key
as binary64 ±∞; a zero is in a run when the key of +0 or of −0 is (two
adjacent keys, `7fffffff:ffffffff` and `80000000:00000000`; a second binary
search for −0, charged as probes); every NaN, whatever its width, sign or
payload, is looked up as the one NaN key `fff80000:00000000` (the key of
`f97e00`, above +∞), charged as probes. Exclusive bounds are normalised by
stepping the key by one. Runs sorted, disjoint, non-adjacent [V].

The compiler keeps the two zero keys together (D250): a run holds both or
neither (a bound on one is widened to the other, so the literal `0.0` is the
run `[key(−0), key(+0)]`), exclusive bounds at zero stop below key(−0) or
start above key(+0), ordered comparisons (`.lt .le .gt .ge`) stop at
key(±∞) so that no NaN key is inside, and `.ne` complements over the whole
key space, so a target that admitted NaN still does.

### 4.5 LITSET members (S15)

Record: `byte offset, length` (2 words). Binary search over the run.

## 5. Typesets (S2, S3)

A typeset is a set of **answer** leaves plus, when it contains `AND`/`NOT`
leaves, the **evaluation list**: its dependency closure in an order where
every combinator comes after its operands (arch §4.1, "obligations").

```
+0  n_ans                      ≥ 0
+1  n_eval                     0, or ≥ n_ans + 1
+2  ans[n_ans]                 answer leaf ids, strictly ascending
    eval[n_eval]               (only when n_eval > 0) every answer (as id ≥ 0)
                               and every dependency-only leaf (as ~id < 0),
                               each once, combinators after their operands
```

`n_eval = 0` means the evaluation list is the answer list (no combinators).
Invariants [V]: answers valid and ascending; `n_eval = 0` ⇒ no answer is a
combinator; `n_eval > 0` ⇒ the eval list holds each answer once as itself,
no answer as a dependency, every element distinct, and every operand of every
combinator in the list occurs **earlier** in the list.

**Why this order is enough.** The VM builds a child's query list Q′ by
concatenating the evaluation lists of the contributing typesets and keeping
the first occurrence of each leaf (an answer flag is OR-ed in on a duplicate).
Each list is closed under operands and topologically ordered, so the
concatenation is too: a kept element's operands are either earlier in its own
list or were kept from an earlier list. One pass in Q′ order therefore
evaluates every combinator after its operands; no sort, no recursion.

A typeset **test** ("did T match?") scans `ans` only.

`TS_ANY` is `{ANY}` (n_ans 1, n_eval 0).

Typeset ids are assigned in order of first creation during lowering; equal
sets are hash-consed to one id.

## 6. Literal keys (S4)

Every literal map key the schema names, once, sorted **strictly by encoded
bytes** (= RFC 8949 §4.2.1 order = the profile's key order). Record:
`byte offset, length` of the key's deterministic encoding. Key id = position.

Invariants [V]: each encoding is a single well-formed item of major 3, or of
major 0/1 (integer labels, meaningful only under the `cose` option), spanning
exactly its length; strictly ascending.

Paths render key ids from this table (§9.3); the VM finds a data key's id by
binary search over its encoded span.

## 7. Maps (S5–S8)

### 7.1 Model

One `MAP` leaf is one map type after arch §4.3.1 step 1 (top-level `//`
already split into separate leaves). Its sequence is lowered to:

* **factors** — factor 0 is the **residual factor** (always present); factors
  1..F−1 are literal-only factors kept separate under arch §4.3.3 condition 1
  (`DISJOINT`) or condition 2 (`ABSORB`);
* **alternatives** of each factor — lists of **literal entries**
  `(key id, value typeset, min ∈ {0,1}, cut ∈ {0,1})`. A literal key occurs
  at most once in a map, so max is 1 for every literal entry; a `?` entry has
  min 0. An entry whose min would exceed 1 makes its alternative unsatisfiable
  and the compiler drops it (arch §4.3.1 step 4; §17 Q10);
* **residual groups** — the key-typeset entries of a residual alternative,
  `(key typeset, value typeset, min, max)` in priority (= source) order,
  hash-consed program-wide. An entry is **absorbing** iff min 0 and max INF;
  otherwise **constrained**. The empty group (`G_EMPTY`) rejects every pair:
  a closed map;
* **pools** — the alternatives of one factor that share a group. Factor 0 has
  one pool per distinct group among its alternatives; a factor ≥ 1 has exactly
  one pool with no group.

Compiler policy (affects bytes, not meaning): a single optional member
`? k: T` is a literal entry with min 0; only occurrence groups or choices of
two or more literal entries are candidates for factors.

**Pool outcome of a pair.** For each live pool, after the value is evaluated:

* a residual pool (factor 0), for a pair routed to the residual (key owned by
  factor 0, or a key no factor of this leaf owns): let j\* be the first group
  entry, in priority order, whose key typeset and value typeset both matched,
  and j₂ the next such entry. Outcome = `TAKE j*` if j\* is absorbing or
  `cnt[j*] < max(j*)`; else `TAKE j₂` if j₂ exists; else `REJECT`. (j₂, if it
  exists, overlaps j\* and so is absorbing by the determinism rule [S].)
  `TAKE` of a constrained entry increments the pool's shared `cnt[j]`.
* a residual pool, for a pair owned by a factor ≥ 1: **not involved** (its
  alternatives ignore the pair); its j\* is still computed, as the predicate
  below.
* a factor-f pool (f ≥ 1), for a pair owned by f: `ABSORB` if the factor's
  mode is `ABSORB` and the outcome of its predicate pool (the residual pool
  named by `p_pool`) is not `REJECT`; otherwise `REJECT`. This is the
  acceptance predicate of arch §4.3.3 condition 2, computed once per pair and
  shared by every alternative of F; for `DISJOINT` it is always false.
* a factor-f pool, for a pair f does not own: not involved.

**Why counters can be shared per pool [S].** If a constrained entry j of group
g overlapped a literal key named by any alternative of the pool, that
alternative would violate the determinism rule (the lower-priority entry j
would have to be absorbing). So no alternative of the pool names a key in j's
domain, every live alternative of the pool sees exactly the same pairs reach
j, and one counter per (leaf, pool, entry) is exact.

**Alternative liveness without visiting every alternative.** Each pool keeps
`rej`, the number of pairs it has rejected; each alternative keeps `r`, the
number of those rejected pairs it consumed literally (§8.3). An alternative is live iff `dead = 0` and `r = pool.rej`. A pool
rejection therefore kills every live member that did not consume that pair, in
O(1), and the per-pair work is one step per live pool plus one per
alternative that **names** the key (arch §4.3.4 step 3, A8; see §17 Q7 for
cross-leaf sharing).

### 7.2 Residual groups (S5, S6)

```
+0  n_entries
+1  n_constrained                          [D]
+2  entries[n_entries] × 4: key typeset, value typeset, min, max
```

Invariants [V]: typesets valid; 0 ≤ min ≤ max; max ≥ 1; max = INF or
max < 2^24. [S]: determinism rule within every alternative using the group.

### 7.3 Map table (S7, S8)

```
header (8):   n_factors n_pools n_alts n_lits n_keys n_names state_words cand_max
factors[n_factors] × 4
pools[n_pools]     × 5
alts[n_alts]       × 5
lits[n_lits]       × 4
keys[n_keys]       × 4
names[n_names]     × 2
```

Header:

| Field | Meaning | |
| --- | --- | --- |
| `n_factors` | ≥ 1 | [V] |
| `n_pools` | ≥ 1 | [V] |
| `n_alts` | ≥ 1 (a map type with no satisfiable alternative is lowered to no leaf, with a warning) | [V] |
| `n_lits`, `n_keys`, `n_names` | counts | [V] |
| `state_words` | words of this leaf's state block (§12.2) | [D] |
| `cand_max` | most candidates one pair can produce: Σ over residual pools of `n_entries(group)` + max over keys of `name_count` (0 if no keys) | [D] |

Factor record: `mode, p_pool, pool_first, pool_count`.

| Field | Meaning | |
| --- | --- | --- |
| `mode` | 0 `RESIDUAL` (factor 0 only), 1 `DISJOINT`, 2 `ABSORB` | [V] |
| `p_pool` | `ABSORB`: the residual pool whose outcome is the predicate (factor 0 then has exactly one pool and one alternative, arch §4.3.3 condition 2); else −1 | [V] |
| `pool_first, pool_count` | factor 0: its pools, a run starting at 0; factor ≥ 1: exactly one pool | [V] |

Pool record: `factor, group, alt_first, alt_count, state_off`.

| Field | Meaning | |
| --- | --- | --- |
| `factor` | owning factor | [V] |
| `group` | factor 0: group id; factor ≥ 1: −1 | [V] |
| `alt_first, alt_count` | its alternatives, a run; pools partition `alts` in order | [V] |
| `state_off` | offset of the pool's state in the leaf block | [D] |

Alternative record: `pool, lit_first, lit_count, req_count, state_off`.

| Field | Meaning | |
| --- | --- | --- |
| `pool` | owning pool | [V] |
| `lit_first, lit_count` | its literal entries, a run in **source order**; runs of different alternatives may not overlap | [V] |
| `req_count` | number of its entries with min 1 | [D] |
| `state_off` | offset of the alternative's state in the leaf block | [D] |

Literal entry record: `key, value typeset, min, cut` (min ∈ {0,1}, cut ∈
{0,1}; `name:` and `value:` keys and `^ =>` set cut). Within one alternative,
keys are distinct [V].

Key-index record: `key, owner, name_first, name_count`, sorted strictly by
key id. `owner` is the factor whose alternatives name the key (a key is named
in exactly one factor [V]). The naming records `names[name_first ..
+name_count)` list every (alternative, literal entry) of this leaf naming the
key, ascending by alternative [V]: every literal entry appears in exactly one
naming record, under its own key [V].

Naming record: `alt, lit` (lit is an index into this table's `lits`).

Leaf state block layout: §12.2. Map evaluation: §8.3.

## 8. Arrays and regexps

### 8.1 Array automata (S9, S10)

A Glushkov automaton over positions (arch §4.4):

```
+0  npos
+1  W                      (npos + 31) >> 5                         [D]
+2  ncounters
+3  nullable               1 if the empty array is accepted
    first[W]               bitset of initial positions
    accept[W]              bitset of accepting positions
    pos[npos] × 2          typeset id, counter index or −1
    counters[ncounters] × 2  min, max  (1 ≤ max; max may be INF)
    follow[npos × W]       row p: bitset of positions that may follow p
```

Bits at positions ≥ npos are 0 [V]; npos ≤ 4 096 [V]; each counter index is
used by exactly one position [V]. A **counted** position p (counter c) never
has its own bit in `follow[p]`: its self-loop is implicit and governed by the
count (arch §4.4; the predecessor condition [S] guarantees one count suffices).

Element step for one live array leaf, with active set A and counts:

```
if no element yet:  C = first
else:               C = ∪ over p ∈ A of  (p counted and cnt[p] < min(p) ? ∅ : follow[p])
                    ∪ { p ∈ A : p counted and cnt[p] < max(p) }            (self-loops)
query += ∪ over p ∈ C of typeset(p)
after the element:  A' = { p ∈ C : typeset(p) matched }
                    counted p ∈ A': cnt[p] = (p ∈ A) ? cnt[p] + 1 : 1
end:                accepted iff (no element and nullable) or
                    ∃ p ∈ A ∩ accept with (p uncounted or cnt[p] ≥ min(p))
```

For an uncounted position with a self-loop, the loop is an ordinary bit in its
own follow row.

**Why bitsets, not adjacency lists (§7 charging).** arch §7 charges an array
element "1 per follow edge traversed + 1 per active position". With adjacency
lists the dense worst case at the default limit is |A| · npos = 256 · 256 =
65 536 edges per element; with bitset rows it is |A| · W = 256 · 8 = 2 048
word operations, 32× less, while the common sparse case (`[a, b, c]`,
`[* T]`, npos ≤ 32) costs the same: one word per active position. Bitsets
also need no dedupe pass (OR is idempotent) and no per-element scratch
proportional to edges. The format therefore uses bitset rows and charges
`W · (|A| + 1)` per live leaf per element (§14), which is the "follow edge"
row of arch §7 restated for this representation (§17 Q8). Enumerating C uses a
five-step binary lowest-bit search per set bit (no `ctz` in snug.lang), charged
one unit per enumerated position.

### 8.2 Regexp automata (S11, S12)

D083/P7.3 category escapes are resolved by kin at compile time using explicit
Unicode scalar-range triples from the optional host module. Categories,
complements and unions produce this same atom representation; the Program
contains neither the general Unicode tables nor a Unicode dependency.

XSD Appendix F or RFC 9485 I-Regexp (compile option, D242), anchored, as a Glushkov automaton over code-point classes
(arch §4.7):

```
+0  npos                   ≤ 512 (default limit 256)
+1  W                      (npos + 31) >> 5                         [D]
+2  natoms                 ≥ 1
+3  nullable               1 if the empty string matches
    first[W]
    accept[W]
    follow[npos × W]
    atom_start[natoms]     strictly ascending; atom_start[0] = 0; all ≤ 0x10FFFF
    atom_mask[natoms × W]  positions whose class contains the atom
```

Atom i is the code-point range `[atom_start[i], atom_start[i+1] − 1]` (the
last runs to U+10FFFF); the compiler splits the code space at every class
boundary, so a class is a union of atoms and a position needs no class field.
Bits ≥ npos are 0 [V].

Step per code point c (the text is already UTF-8-valid by the profile, so
decoding needs no checks):

```
m = atom_mask[atom containing c]            binary search over atom_start
N = (first step ? first : ∪ over p ∈ active of follow[p]) ∧ m
```

Accept iff (empty string and nullable) or `N ∩ accept ≠ ∅` after the last
code point. A regexp whose active set becomes empty stops early (the text is
still fully walked by the profile's UTF-8 scan).

### 8.3 Map evaluation (what the map fields mean in use)

A live map item at depth d has one block per admitted MAP leaf (§12.2). At
the start every block is initialised: `alive = 1`, `cursor = 0`,
`factor_live[f]` = the factor's alternative count, each pool's `live` = its
alternative count, everything else 0.

Per pair:

1. If no block is alive, the key and value are walked dead (empty queries; no
   search, no path writes).
2. **Key id.** Binary search of KEYS over `[lo, N_KEYS)` for the key's
   encoded span, where `lo` is one past the previous pair's found id or its
   insertion point (data keys ascend, so the range only shrinks). Not found:
   k = −1.
3. **Cursor.** For each alive block, if k ≥ 0, advance `cursor` while
   `keys[cursor].key < k`; the leaf names k iff `keys[cursor].key = k`, whose
   `owner` is then the owning factor.
4. **Key query** = the union of the key typesets of every entry of the group
   of every live residual pool of every alive block. The key is evaluated at
   depth d + 1 (it never records a witness, §9.2) and its matches stamped.
5. **Path.** The depth-(d + 1) segment is `KEY k` if some live alternative of
   an alive block has a naming record for k, else `ANYKEY`.
6. **Key phase.** For each alive block: each live residual pool's group
   entries whose key typeset matched become candidates (kind 1); each naming
   record of k whose alternative is live becomes a candidate (kind 0) and
   marks the pair **named**.
7. **Value query** = the union of the candidates' value typesets. The value is
   evaluated at depth d + 1 and its matches stamped.
8. **Update**, per alive block:
   1. Pool outcomes (§7.1) from the candidates whose value typeset matched;
      `exempt = 0` for every pool.
   2. Naming records of k with a live alternative: value matched → set its
      `consumed` bit, `req_done += min`, and if its pool is involved and
      rejected, `r += 1`, `pool.exempt += 1`. Value failed and the entry has a
      cut → `dead = 1`, decrement its pool's `live` and its factor's
      `factor_live`. Value failed without a cut → nothing now: the
      alternative follows its pool's outcome.
   3. Each involved live pool: `TAKE` of a constrained entry j →
      `cnt[j] += 1`; `REJECT` → `rej += 1`, `factor_live[f] −= live − exempt`,
      `live = exempt`.
   4. `alive = 0` if some `factor_live` is 0.
9. If no block is alive, witness rule 3 (§9.2); otherwise the slot is
   cleared.

At the end, a factor is **satisfied** if one of its alternatives is live
(`dead = 0`, `r = pool.rej`), has `req_done = req_count`, and its pool has
`cnt[j] ≥ min(j)` for every group entry. A MAP leaf matches iff it is alive
and every factor is satisfied.

### 8.4 Tags, embedded content, combinators

* **Tag item.** Admitted TAG leaves compare the number (hi, lo); TAGSET leaves
  test the range; an INT leaf with `BIGOK` compares the bignum magnitude in
  place. The content is visited at depth d + 1 (path segment `TAG`) with the
  union of the content typesets of the TAG/TAGSET leaves whose number
  matched, possibly empty. A TAG/TAGSET leaf matches iff its number matched
  and its content typeset matched. Profile counting is the scanner's: bignum
  and typed-array content is visited as a schema child but not counted as an
  item (scanner.md). A standard-set tag (D121, under the profile flag) has
  its content visited as an ordinary item (counted) with that query; after
  it the profile's content rule runs, and a tag-24 payload is walked dead as
  one item at d + 2 against the shared counters and budget (unlike an EMBED
  sub-validation, an inner refusal is a profile refusal of the document).
* **EMBED.** The byte string's content `[s, e)` is a sub-validation: the
  scanner's item counter is saved and reset, the depth limit is
  `min(limit, D − d − 1)`, top-any 1, `cose` 0, and the walk is bounded by e
  (not the input end; §17 Q21). `.cbor`: one item at physical depth d + 1
  (segment `EMBED`) with the union of the content typesets of admitted EMBED
  leaves, then it must end exactly at e (else inner `cbor/trailing`).
  `.cborseq` (D040; this replaces the original per-item model): the content
  typeset — the controller's array type — is the query of a **virtual array**
  at physical depth d + 1 (segment `EMBED`, not an item: not counted, no visit
  unit; its filter, blocks and elements charged as an array's) whose elements
  are the sequence's items at d + 2 (segments `INDEX i`, rendered `cbor, i`),
  so positions and occurrences apply; the inner depth limit is
  `min(limit, D − d − 2)`. `.cbor` and `.cborseq` leaves on one byte string
  run as two sub-validations. An inner profile or limit failure kills every EMBED leaf of
  the item and never the outer document; the outer counter is restored
  afterwards. An EMBED leaf matches iff the sub-validation succeeded for it.
* **Combinators.** When an item's evaluation ends, its matched leaves are
  stamped in a fresh epoch and one pass over Q′ in order evaluates each AND
  (`mark[a] = e ∧ mark[b] = e`) and NOT (`mark[target] = e ∧ mark[lit] ≠ e`),
  stamping each that matches. §5 guarantees operands come first.

## 9. Errors

### 9.1 Reason codes

| Code | Reason | | Code | Reason |
| --- | --- | --- | --- | --- |
| 0 | ok | | 32 | `type` |
| 1 | `cbor/truncated` | | 33 | `missing` |
| 2 | `cbor/non_shortest` | | 34 | `unexpected` |
| 3 | `cbor/indefinite` | | 35 | `value` |
| 4 | `cbor/malformed` | | 36 | `size` |
| 5 | `cbor/key_type` | | 37 | `range` |
| 6 | `cbor/key_order` | | 38 | `pattern` |
| 7 | `cbor/duplicate_key` | | 39 | `tag` |
| 8 | `cbor/text` | | 40 | `bits` |
| 9 | `cbor/float` | | 41 | `embedded` |
| 10 | `cbor/simple` | | 42 | `control` (1.1) |
| | | | 43 | `control_size` (1.1) |
| | | | 48 | `budget` |
| 11 | `cbor/tag` | | | |
| 12 | `cbor/bignum` | | | |
| 13 | `cbor/decimal` | | | |
| 14 | `cbor/typed_array` | | | |
| 15 | `cbor/ndarray` | | | |
| 16 | `cbor/trailing` | | | |
| 17 | `cbor/depth` | | | |
| 18 | `cbor/too_many_entries` | | | |
| 19 | `cbor/too_many_items` | | | |
| 20 | `cbor/too_large` | | | |
| 21 | `cbor/not_map` | | | |

Codes 1–21 are exactly `snug.cbor.codes` (`kin/codes.kin`, `CODE_*`, cbor.mjs
order); 22–31 are reserved for the scanner; 44–47 and 49–63 reserved. A
reason code fits in 8 bits.

`embedded` carries a **subcode**: the innermost non-`embedded` reason of the
failed sub-validation (a profile code, a schema code, or `cbor/depth` /
`too_many_items` from its separate accounting). Nested embedding shows in the
path, not the subcode (§17 Q6).

Leaf failure reasons, decided in this fixed order per kind:

| Kind | Checks → reason |
| --- | --- |
| `ANY`, `MAJOR` | none once admitted |
| `INT` | class ∉ {0, 1} and not (`BIGOK` and bignum) → `type`; intervals → `range` |
| `UINTX` | intervals → `range`; bits → `bits` |
| `FLOAT` | intervals → `range` |
| `SIMPLE`, `LIT`, `LITSET` | equality → `value` |
| `TEXT` | size → `size`; regexp → `pattern` |
| `BYTES` | size → `size`; bits → `bits` |
| `TAG` | number → `tag`; content → (the content's witness) |
| `TAGSET` | number → `tag`; content → (the content's witness) |
| `EMBED` | sub-validation → `embedded` |
| `AND` | the first failing operand's reason (a, then b) |
| `NOT` | target's reason; literal matched → `value` |
| `EXT` (1.1) | item longer than d3 → `control_size`; predicate false → `control` |
| `ARRAY`, `MAP` | witnesses arise at elements, pairs or the end (§9.2) |

### 9.2 The witness (arch §6 rules, made operational)

The scratch holds one **witness slot** (§12.1): `state, reason, subcode,
depth, xkind, xval, offset`. `depth` is the number of path-stack segments that
belong to the witness; `xkind/xval` is an optional extra final segment
(−1 = none).

1. **Recording.** When an item evaluated with a **non-empty** query list ends
   with no answer leaf matched, and the slot is empty, the item records: if no
   answer leaf was admitted by the mask, `type`; otherwise the reason of the
   **lowest-id admitted answer leaf** (arch §6 rule 3). Path: the stack down
   to the item's depth, no extra segment. A container item that failed at a
   child or at its end has already recorded (rules 3–5 below), so a scalar
   reason is only ever recorded at a scalar or at a container with no admitted
   container leaf.
2. **Clearing.** After each child step of a container (an array element, a
   map pair, a tag's content, an embedded item), if the container still has a
   live candidate, the slot is cleared (`state = 0`): the parent survived
   without that child (`#6.2(bstr .size 9) / integer`).
3. **Map pair.** If after a pair no map leaf of the item is live and the slot
   is empty: `value` if some alternative live before the pair named the key,
   else `unexpected`; path = stack to the value's depth (its last segment is
   the pair's key segment, §9.3); offset = the key's head.
4. **Map end.** If no map leaf matched at the end and the slot is empty:
   `missing`; among the leaves still live, the lowest leaf id; its first
   factor with no satisfied alternative; that factor's lowest-index live
   alternative; its first unmet entry — literal entries in source order first,
   then constrained group entries in priority order (§17 Q3). Path = the
   map's stack plus an extra segment: `KEY id` for a literal entry, `ANYKEY`
   for a group entry. Offset = the map's head.
5. **Array.** An element evaluated with an empty query (no live candidate
   position): `unexpected`, path = stack to the element (its `INDEX`). At the
   end with no accepting leaf: `missing`, path = the array's stack plus extra
   `INDEX n` where n is the element count (§17 Q4).
6. **Keys never record.** A map key item never records a witness: a key that
   matches no key typeset is the pair's `unexpected` (rule 3), never a `type`
   or `pattern` at the key (§17 Q5).
7. **Embedded.** When a sub-validation fails and its EMBED leaf was the item's
   last chance, the slot (holding the inner witness, or the inner profile
   failure) is rewritten to `reason = embedded`, `subcode = inner reason`,
   keeping the inner path.
8. **Final.** When the root fails, the result is the slot (which is always
   set then); a profile failure found anywhere in the walk replaces it (arch
   §4.5, D023); budget exhaustion stops the walk and replaces everything
   (§17 Q17).

A dead subtree (an item evaluated with an empty query) never writes the path
stack, so when the root fails the stack still holds the witness's path.

### 9.3 Path segments

Each segment is two words, `kind, value`:

| kind | Name | value | Rendered as |
| --- | --- | --- | --- |
| 0 | `INDEX` | array index | the number |
| 1 | `KEY` | literal key id | the key from KEYS (text, or an integer under `cose`), rendered **from the Program only** |
| 2 | `ANYKEY` | 0 | `*` |
| 3 | `TAG` | 0 | `#tag` (never the received number, C14) |
| 4 | `EMBED` | 0 | `cbor` (`.cbor` content) |
| 5 | `EMBEDSEQ` | item index | `cbor` then the index (`.cborseq` item) |

A map value's segment is `KEY k` only if, **before that pair**, some live
alternative of some live map leaf of that item names key k (arch §6, A10);
otherwise `ANYKEY`, even if k is in the key table.

Profile failures carry **no path** (length 0) and their byte offset (§17 Q2).

## 10. Closure sets and chains (S16–S19)

arch §5.1 step 6: for each rule, R₀ = its typeset's evaluation list, and
R_{k+1} = the dependency closure of the children of R_k (§4.2 "Children").
R_k is every leaf that can be queried for an item at **physical depth** k
(an embedded document's root is one deeper than its byte string, §8.4).

Closure-set record (S17):

```
+0  n
+1  frame_words      §12.1 frame formula over this set                 [D]
+2  regex_words      Σ over TEXT leaves with a regexp: 2 · W(regexp)   [D]
+3  leaves[n]        strictly ascending
```

Chain record (S19):

```
+0  n                1 ≤ n ≤ D + 1
+1  repeat_from      −1, or 0 ≤ r < n
+2  csets[n]         R_k = cset[k] for k < n
```

For k ≥ n: if `repeat_from = −1`, R_k = ∅; else `R_k = cset[r + (k − r) mod
(n − r)]`. The compiler stops at the first repetition or at depth D, whichever
comes first; depths beyond D are never used.

Verified [V] (§11): every cset is closed under combinator operands; R₀
contains the rule's evaluation list; for each k < n − 1, cset[k+1] ⊇ children
of cset[k]; if r ≥ 0, cset[r] ⊇ children of cset[n−1]; if r = −1 and n ≤ D,
cset[n−1] has no children. This **superset** check is what makes scratch safe:
any leaf the VM can place at depth k is in R_k, so the frame sized from R_k
holds it. Exactness (no extra leaves) is [S] and only affects scratch size.

Closure sets and chains are hash-consed; csets are numbered in order of first
use by rules in rule-table order.

## 11. The structural verifier

`vm-verify` (§13.1) runs once per Program at load, in kin, before any
`vm-validate`. It is linear in P and B except the closure transitions, and
charges a **verify budget** of `64 · (PROGRAM_WORDS + POOL_BYTES / 4 + 1)`
units; exceeding it refuses the Program. It uses the scratch marks (§12.1) as
its temporary sets.

Order (first failure refuses, with the failing word offset and a check id in
`S[VM_DETAIL]`, `S[VM_DETAIL + 1]`):

1. Header: magic, version, `HEADER_WORDS`, `PROGRAM_WORDS = len(P)`,
   `POOL_BYTES = len(B)`, limits ≤ their hard maxima (arch §7), section
   offsets monotone with `S_RULES = 64` and `S_END = PROGRAM_WORDS`, counts
   consistent with fixed-width section lengths.
2. Index sections: walk each variable-length data section in id order;
   every record fits in its section, the walk ends exactly at the section end,
   and each index word equals the walk position.
3. Every id field in range for its section; every byte range inside B;
   reserved words 0; enumerations (`kind`, `mode`, regions, flags) valid.
4. Per-section invariants marked [V] above (typeset order and closure,
   interval order, key order and well-formedness, LITSET order and class,
   map partitions and naming coverage, array/regexp bit hygiene, rule-name
   order and UTF-8 validity).
5. Derived fields [D] recomputed and compared: leaf masks, `FLAGS`, `W`,
   `n_constrained`, `req_count`, `state_off`, `state_words`, `cand_max`,
   cset `frame_words`/`regex_words`, rule `scratch_words`, `SCRATCH_MAX`;
   and `PROGRAM_WORDS·4 + POOL_BYTES + SCRATCH_MAX·4 ≤ LIM_TOTAL_BYTES`.
6. Closure chains (§10).
7. Format 1.1 (D141): the format word is 1 or 0x00010001; under 1.0 words 30,
   31 and 39 are 0 and no leaf has kind 18; under 1.1 the extension table of
   §4.6 is well formed (check id 24, `C_EXT`), every EXT leaf's id is below
   `N_EXTS`, its argument a non-empty pool range, its maximum ≥ 0, d4 = d5 =
   0, its mask `ALL`, and no typeset has an EXT leaf as an answer.

The verifier does **not** check [S] properties and does not check
`SOURCE_KEY`. A Program must also come from a store the host trusts (arch
§5.2, C18); verification bounds the damage of corruption to a wrong verdict.

**Run-time checks.** After verification every Program index the VM follows is
in range by construction, and no index into P is computed from input bytes
(the key binary search is bounded by `N_KEYS`). The VM therefore checks at run
time only what verification cannot fix in advance: the scratch length and
`MARK_CAP` (§12.1), the frame capacity when appending to a query list or
carving a block (a cheap compare; failure returns −1), and every input-byte
index (as the scanner does). The host must keep P and B private after
verification (copy on load, or own them) so they cannot change between verify
and validate (§17 Q15).

## 12. Scratch

### 12.1 Layout

One `Int32Array` per isolate (arch §8; Rust: `&mut` per validation context),
grown lazily, shared by every Program. For a call on rule r of Program P:

```
S[0  .. 16)     scanner block: snug.cbor.codes O_* layout (O_TOP 0, O_COSE 1,
                O_MAX_BYTES 2, O_MAX_DEPTH 3, O_MAX_ENTRIES 4, O_MAX_ITEMS 5,
                O_ERR_POS 6, O_ITEMS 7, O_HI 8, O_LO 9, O_CSTART 10, O_PROFILE 11
                (the profile flags, D120: setup copies limits word 9 here),
                12–15 scanner-reserved); the VM passes S itself as the scanner's `o`
S[16 .. 48)     VM block (below)
S[48 .. 48+M)               mark[M]       epoch stamps per leaf id
S[48+M .. 48+2M)            qidx[M]       query-list index per leaf id
S[48+2M .. +2(D+1))         path stack: segment of depth k at +2k (k = 1..D; slot 0 unused)
then regex area             max over k < (D+1) of cset(R_k).regex_words
then frames                 frame k (k = 0..D) back to back, frame_words(R_k) each
```

M is `MARK_CAP`, fixed for the life of the scratch array (it only changes
when the host allocates a new one), so marks never overlap other areas across
Programs. Total words:

```
48 + 2·M + 2·(D + 1) + regex_words(r) + Σ_{k=0..D} frame_words(R_k)
```

`rule.scratch_words` is this with M = `N_LEAVES` (computed in O(n) from the
chain's period). Required: `M ≥ N_LEAVES` and `len(S) ≥` the total.

VM block:

| Word | Name | |
| --- | --- | --- |
| 16 | `VM_EPOCH` | monotone stamp; persists across calls and Programs; at ≥ `0x7ffffff0` the VM zeroes `mark` and restarts at 1 (uncharged) |
| 17 | `VM_MARK_CAP` | M |
| 18 | `VM_BUDGET` | units remaining |
| 19 | `VM_BUDGET_START` | effective budget of this call |
| 20–26 | `VM_W_STATE, VM_W_REASON, VM_W_SUB, VM_W_DEPTH, VM_W_XKIND, VM_W_XVAL, VM_W_OFFSET` | the witness slot (§9.2) |
| 27 | `VM_D` | D |
| 28 | `VM_FRAMES` | offset of frame 0 |
| 29 | `VM_PATH` | offset of the path stack |
| 30 | `VM_REGEX` | offset of the regex area |
| 31 | `VM_RULE` | rule index |
| 32 | `VM_CHAIN` | word offset of the rule's chain record in P |
| 33 | `VM_EMBED` | embedded nesting level (0 = outer document) |
| 34 | `VM_BIGNUM_MAX` | effective bignum content limit |
| 35–36 | `VM_DETAIL` | verifier refusal detail (word offset, check id) |
| 37–47 | reserved | |

**Marks.** `mark[l] = e` means "leaf l is stamped in epoch e". Building a
child query uses a fresh epoch: a leaf is appended to Q′ only if `mark[l] ≠
e`, then `mark[l] = e, qidx[l] = position`; a duplicate ORs its answer flag
into `QF[qidx[l]]`. After a child returns, the parent takes another fresh
epoch and stamps every **matched** leaf of the child's Q′; a typeset test is
then "some answer a with `mark[a] = epoch`". Combinators are evaluated the
same way at the end of their own item (stamp matched leaves, then one pass in
Q′ order). Stale stamps from earlier calls or Programs are always smaller
than the current epoch. Two arrays of M words replace any per-depth leaf
index.

### 12.2 Frames

Frame k serves the item at physical depth k currently being evaluated.

```
QL[w]           query list: leaf ids (w = |R_k|)
QF[w]           flags per entry: bit 0 ANSWER, bit 1 ADMITTED, bit 2 MATCHED,
                bit 3 EVALUATED, bits 8–15 failure reason
container area  max(MAPAREA(R_k), ARRAREA(R_k)) words
```

```
frame_words(R) = 2·|R| + max(MAPAREA(R), ARRAREA(R))
MAPAREA(R)     = Σ over MAP leaves m ∈ R of (state_words(m) + 4·cand_max(m))
ARRAREA(R)     = Σ over ARRAY leaves a ∈ R of (3 + 2·W(a) + ncounters(a))
regex_words(R) = Σ over TEXT leaves t ∈ R with a regexp of 2·W(regexp(t))
```

An item is a map or an array, never both, so the two areas overlap. Scalars,
tags and embedded byte strings need only QL/QF (a tag's content and an
embedded document live in deeper frames).

**Container area for a map item.** Blocks, one per admitted MAP leaf of Q′, in
Q′ order, `state_words` each; then the pair candidate list (4 words per
candidate: block offset, kind (0 literal / 1 group entry), naming-record or
pool index, entry index or typeset id). Map block layout (`state_off` fields
are relative to its start):

```
+0  qindex           position of the leaf in Q′
+1  alive
+2  cursor           position in the leaf's key index (keys arrive ascending)
+3  tmp
+4  factor_live[n_factors]
pools, in order:     rej, live, exempt, outcome, cnt[n_entries(group)]   (4 + n_entries)
alts, in order:      dead, r, req_done, consumed[⌈lit_count/32⌉]          (3 + ⌈lit_count/32⌉)

state_words = 4 + n_factors + Σ_pools (4 + n_entries) + Σ_alts (3 + ⌈lit_count/32⌉)
```

**Container area for an array item.** One block per admitted ARRAY leaf:
`qindex, alive, tmp, active[W], cand[W], cnt[ncounters]`.

**Regex area.** For each admitted TEXT leaf with a regexp, `cur[W], next[W]`,
in Q′ order. Text items have no children, so one area (the max over depths)
serves every depth.

**Path stack.** Segment for depth k at `VM_PATH + 2k` (written by the parent
before evaluating a live child: `INDEX`, `KEY`/`ANYKEY`, `TAG`, `EMBED`).

**Pending witness.** The slot in the VM block (§9.2).

### 12.3 Limits array

`limits` (8 words), host-filled; −1 means "the compiled default":

| Word | Limit | Effective value |
| --- | --- | --- |
| 0 | top-any (0: top-level item must be a map, as cbor.mjs `top: 'map'`; 1: any) | as given (0/1) |
| 1 | cose (0/1) | as given |
| 2 | input bytes | min(given, `LIM_INPUT_BYTES`) |
| 3 | depth | min(given, `LIM_DEPTH`) |
| 4 | entries | min(given, `LIM_ENTRIES`) |
| 5 | items | min(given, `LIM_ITEMS`) |
| 6 | bignum bytes | min(given, `LIM_BIGNUM_BYTES`) |
| 7 | budget | min(given, `LIM_BUDGET`) |
| 8 | VM extension: bit 0 forces the generic path (D044), bit 1 the legacy schedule 1 (D045) | as given; absent = 0 |
| 9 | VM extension: the profile flags (D120, snug.cbor.codes `PF_*`; host bits 0–6) | as given; absent (fewer than 10 words) or negative = 0, the Bindle profile; `PF_SUB` added when the span's depth is not 0 |

The VM copies the effective values into the scanner block and the VM block.
Words 8 and 9 are API extensions of the call, not Program words: a Program
validates under any profile, and the format is unchanged (D084).

## 13. API, rule names, serialisation

### 13.1 kin entry points

```
vm-verify        (P: Ints, B: Bytes, S: Ints) → I32
                 0 valid; −1 refused (detail in S[35], S[36])
vm-scratch-words (P: Ints, rule: I32, mark_cap: I32) → I32
                 words S must have for this rule with MARK_CAP = max(mark_cap, N_LEAVES)
vm-scratch-init  (S: Ints, mark_cap: I32)
                 on a freshly zeroed S: VM_EPOCH = 1, VM_MARK_CAP = mark_cap
vm-rule-index    (P: Ints, B: Bytes, name: Bytes) → I32
                 binary search of RULES by UTF-8 bytes; −1 if absent
vm-validate      (P: Ints, B: Bytes, rule: I32, input: Bytes, limits: Ints,
                  S: Ints, out: Ints) → I32
                 ≥ 0: the reason code (0 ok), also in out[0]
                 −1 Program inconsistent (not verified, or modified since)
                 −2 scratch too small (len(S) or VM_MARK_CAP)
                 −3 rule index out of range
                 −4 out shorter than 8 words
```

All arrays are distinct (Rust borrows). The VM allocates nothing and calls no
host code, except the extension-control predicate of a format 1.1 Program
(`vm-validate-x`, `vm-validate-span-x`, `vms-step-x` take it as their last
argument; the plain entry points pass one that never matches). Host protocol for the shared scratch: `cap' = max(cap,
N_LEAVES)`; `need = vm-scratch-words(P, rule, cap')`; if `cap' > cap` or
`need > len(S)`, allocate a new zeroed array of `max(need, len(S))` words
(`SCRATCH_MAX`-based sizing avoids regrowth per rule) and `vm-scratch-init`
it. Growth never changes a verdict or a budget count.

**Rule names.** A rule's index is its position in RULES (sorted by UTF-8
bytes). Hosts may call `vm-rule-index` per call or build their own map once
from RULES/B; both give the same index.

### 13.2 Output array

```
out[0]  reason code (0 ok)
out[1]  subcode (embedded) or 0
out[2]  byte offset: profile refusal offset (the scanner's error offset);
        schema witness offset (§9.2); budget: offset of the item being visited
out[3]  budget units used
out[4]  items counted (the scanner's O_ITEMS)
out[5]  n, path segments in the witness
out[6]  m = min(n, (len(out) − 8) / 2), segments written
out[7]  0
out[8 + 2i], out[9 + 2i]   segment i: kind, value (§9.3)
```

A host passing `8 + 2·(D + 1)` words (≤ 522) never truncates an outer path.

### 13.3 Serialisation container

Little-endian bytes:

| Offset | Bytes | Field |
| --- | --- | --- |
| 0 | 8 | magic, ASCII `snugprog` |
| 8 | 4 | container version = 1 |
| 12 | 4 | `FORMAT_VERSION` (= P[1]) |
| 16 | 4 | program words (= P[3]) |
| 20 | 4 | pool bytes (= P[4]) |
| 24 | 32 | snug version, ASCII, NUL-padded (e.g. `0.1.0`) |
| 56 | 32 | SHA-256 over bytes [0, 56) ‖ [88, end): the whole container except this field |
| 88 | 8 | reserved, 0 |
| 96 | 4·words | P, each word little-endian |
| 96 + 4·words | pool bytes | B |

Total `96 + 4·words + pool`. **Compatibility note, 2026-11-03:** apply
[D084](../DEVLOG.md#d084--a-stable-versioned-serialised-program-with-a-compatibility-rule),
made concrete by D100: format major must equal the loader's and format minor
must be no newer (currently 1.1, D141 — a 1.0 Program loads unchanged; low
16 bits major, high 16 bits minor).
Producer snug version is provenance, not an equality gate. A loader refuses
wrong magic/container version, incompatible format, malformed producer
metadata, nonzero reserved bytes, length or digest mismatch; then runs
`vm-verify`. This supersedes the older exact producer-version requirement.
The digest is computed by the host (no SHA-256 in kin).
Little-endian decoding uses a `DataView` (or a zero-copy view when the host is
little-endian and the offset is 4-aligned, which 96 is).

**Source key** (`SOURCE_KEY`, header words 7–14): SHA-256 of the
deterministic CBOR encoding of

```
["snug/program-key", 1, <snug version: tstr>, <profile: uint>,
 [<schema bytes limit>, <nesting>, <AST nodes>, <instantiations>,
  <alternatives>, <array positions>, <regexp positions>, <width>,
  <pool bytes>, <total bytes>, <compile budget>,
  <depth>, <input bytes>, <entries>, <items>, <bignum bytes>, <budget>],
 <schema text: bstr>]
```

— every compile option, in that order, as uints. It is the cache key of arch
§5.2; the container digest is a separate integrity check of the bytes (§17
Q1).

**D110 amendment for optional Unicode data:** when nonempty tables are
supplied, kin appends a seventh array element, a CBOR array of uint words
`[category id, lo, hi, …]`, sorted by id then lo. Category id is the first
ASCII letter × 256 plus the suffix letter (zero for aggregate categories).
Within a category ranges are disjoint and non-adjacent; bounds are scalar
values and no range crosses the surrogate interval. Cs has no ranges.
The complete contents, rather than just a caller-supplied version label,
therefore bind the source key to the table semantics. With no tables the
six-element preimage above is unchanged. This changes key construction for
opted-in compilation only, not the Program/container format.

**D141 amendment for extension controls:** when the host registers controls,
the preimage has eight elements: the seventh is the Unicode element above or
an empty array, the eighth `[<flags: uint>, [[<name: tstr>, <max item bytes:
uint>], …]]` over the WHOLE registry in name order (flags bit 0: admitted
under `bus`). A cached Program is therefore never reused under another
registry, nor under the same names with another maximum. Hosts pass the
registry after the compile options (`opt` words 20.., snug.compile.ext; D242 adds the dialect word).

**Loading a 1.1 Program** (`fromSerialized(bytes, { controls })`,
`Schema::from_serialized_with`): framing and `vm-verify` as for 1.0, then each
name of the extension table must be in the registry given at load —
otherwise `ProgramError('missing_control')` / `Error::MissingControls`, which
names them. The predicates are not part of the Program: the registry at load
must give the same verdicts as at compile time (pure predicates, a trusted
store, as for every cached Program).

**Regexp dialect (D242).** Explicit `regexp: 'iregexp'` retains the preimages
above exactly. For `regexp: 'xsd'` (the default), the preimage has nine
elements: the seventh is the Unicode word array or `[]`, the eighth is the
registry element above or `[]`, and the ninth is uint `0` (XSD). This binds
the effective compile option even for schemas without regexps. This changes
only the opaque SOURCE_KEY, with no Program layout/version change: both
dialects lower into §8.2's same range automata. The internal compile options
now have 20 words (dialect at 19, 0 XSD / 1 I-Regexp); registry data follows.

## 14. Charging schedule

The step budget (arch §7) is charged **before** each unit of work, in walk
order, saturating; the call stops with `budget` at the first charge that
exceeds the remainder. These are the arch §7 rows, restated for this format
(§17 Q8):

| Event | Units |
| --- | --- |
| item visit (every `eval`: live or dead item, map key, tag content, embedded item) | 1 |
| text item UTF-8 validation (profile; live or dead) | ⌈len/8⌉ (D253; was ⌈len/64⌉) |
| map key order comparison (each key after the first) | ⌈min(len₁, len₂)/8⌉, at least 1 (D253) |
| typed-array float NaN scan (profile) | ⌈len/64⌉ (unchanged by D253) |
| standard-set tag check after its content (profile, D121) | 1, + ⌈len/8⌉ for a tag-0/32 text's form scan (D252/D253); a tag-24 payload is walked as dead items |
| query construction: each typeset element scanned (eval list, or answers when `n_eval = 0`) | 1 |
| mask filter, at a live item | \|Q′\| |
| scalar/TAG/TAGSET/EMBED leaf evaluated (admitted) | 1 |
| interval, LITSET, key-table, regexp-atom binary search | 1 per probe |
| byte comparison (literal, LITSET member, key) | ⌈len/8⌉, at least 1, per comparison (D253) |
| `.bits` scan | ⌈len/12⌉ (D253) |
| regexp, per code point, per live regexp | W · (\|active\| + 1) + atom probes |
| combinator (AND, NOT) | 2 |
| EXT leaf decided (1.1, once per item, when its combinator needs it) | 1; when the item is no longer than its maximum, + `EXT_CALL` (16) and then the predicate's units u (below) |
| container block initialisation | ⌈words/16⌉ per block |
| stamping a returned child's matches | \|Q′_child\| (only if non-empty) |
| typeset test | 1 per answer element examined (stops at the first hit) |
| map pair: per block visited (live or dead) | 1, + 1 per cursor step (live blocks) |
| map pair, key phase: each group entry of a live pool examined | 1 (+ its key typeset test) |
| map pair: each naming record visited, in the key phase and again in the update | 1 |
| map pair, update: each candidate | 1 (+ its value typeset test) |
| map pair, update: each live pool | 1 |
| map end: per block visited | 1, + 1 per alternative and 1 per pool (live blocks) |
| array element, per block visited | 1; live blocks + W · (\|A\| + 1) + 1 per candidate position |
| array element, after the child: each candidate position | 1 (+ its typeset test) |
| array end, per block visited | 1; live blocks + W |
| composing a `missing` witness | 1 per entry examined; rule 1's lowest-id scan: \|Q′\| |
| root | construction of the rule's typeset; after the root: stamping + test |

A dead item (empty query) therefore costs 1 + its profile scans, which is arch
§7's "profile-only continuation" row. Embedded content is charged the same
way, against the same budget.

**Extension controls (format 1.1; D190–D193).** After its 1 + `EXT_CALL`
units the VM asks the host port with `room`, the units the budget has left,
and the port answers a verdict word: u ≥ 0 matched after u units, −2 − u
refused after u units, −1 more than `room`. The VM charges u (−1, or u >
`room`: `budget` at the item, as any charge that exceeds the remainder). What
u is depends on the control, and both are deterministic functions of the
Program and the item, so hosts agree on the exhaustion point:

* **A host predicate:** its declared cost for the item's encoded length n —
  by default **n** (one unit per item byte) — decided before the predicate
  runs; a cost above `room` is −1 and the predicate is not called. The VM
  cannot interrupt or measure host code: a predicate's own CPU is the host's
  responsibility, and a declared cost is how a host bounds it by the budget.
* **A generic control** (`snug.vm.controls`) meters its own work in kin, in
  **ticks**, 8 to a unit, each charged before the work it pays for (a run that
  would pass `room` × 8 ticks stops at once: −1); u = ⌈ticks / 8⌉:

| Generic work | Ticks |
| --- | --- |
| `.chars`: the text content's code-point count | 8 per 16 content bytes (⌈len/16⌉ units), before the count |
| skipping an element, key or value (`.unique`, `.samelen`) | 3 per item head visited |
| `.unique`: recording an element (span and FNV-1a hash) | 10, + 1 per byte hashed (D253; was 5) |
| `.unique`: comparing two records (heap sort, then neighbours) | 6, + on equal hashes 2 for the first 8 bytes (up front) and 8 per further 8 bytes examined (D253; was 8 and 8 up front) |
| `.samelen`: a map pair | 5 |
| `.samelen`: a text key's binary search, per probe | 3, + 2 for the first 8 bytes (up front) and 8 per further 8 bytes examined (D253; was 4 and 8 up front) |

  The weights were set so that each kind of generic work costs no more CPU per
  unit than the VM's own worst generic walk (bench/VM.md, 2026-11-05), and
  repriced by D253 from the 2026-11-04 calibration (bench/VM.md, "Calibration
  2026-11-04"); `EXT_CALL` stays 16.
  `.unique` stops (refused) at the first comparison that finds two equal
  encodings. `.samelen`'s names are parsed, de-duplicated and sorted once,
  when the host binds the Program, and are not charged per item. An item that
  is not of the control's kind is refused after the units spent so far.

**Schedule 2 (D045; the default).** Three exceptions to the table, everything
else unchanged. They make the bookkeeping of the simplest shapes cost what it
costs in CPU; a validator implementing them must apply them exactly, since
they move the exhaustion point:

1. **Simple array element.** At an array item whose only admitted leaf is an
   ARRAY leaf whose group is one uncounted, self-looping position (`[* T]`)
   with a one-answer typeset (`n_eval = 0`, one answer), each element taken
   while that block is alive has no bookkeeping units: no block visit,
   W · (|A| + 1), candidate position, typeset element, stamping, candidate or
   typeset test. The array item's visit, filter and block initialisation and
   the array end stay.
2. **Simple map pair.** At a map item whose only admitted leaf is a MAP leaf
   that is either a closed struct (one factor, one pool, one alternative, the
   empty residual group) or a pure table (no literal entry; one absorbing
   group entry; one-leaf key and value typesets), each pair taken while that
   block is alive that is *simple* — for a struct, an unnamed key or a key
   named by exactly one literal entry with a one-leaf value typeset; for a
   table, every pair — costs exactly **1** bookkeeping unit at the map,
   replacing the block visit and cursor steps, the key and value query
   elements, both stampings, key-phase entries and their tests, naming
   records (key phase and update), candidates and their tests and the pools.
   The key-table binary search probes and the key order comparison stay. The
   map item's visit, filter and block initialisation and the map end stay.
3. **One scalar leaf.** A key, value or element taken under rule 1 or 2 whose
   query is exactly one admitted scalar leaf has no mask-filter unit and no
   leaf unit. Its visit, its profile scans and the leaf's variable work
   (interval and LITSET probes, byte comparisons, regexp steps, `.bits`
   scans) stay.

A pair or element that falls outside a rule (a second admitted leaf, a
non-simple pair, a dead block) is charged by the table. The legacy schedule
(the table alone, "schedule 1") remains selectable per call for comparison
(the reference VM's `limits` word 8 bit 1, a VM extension); it changes only
the budget used.

**Valid CBOR input (P8.4; D262, D264, D277, D280).** Under the `valid` wire
preset (`limits` word 9 bit 8, `PF_VALID`) the VM first walks the input as
above. When that walk meets an encoding only valid CBOR has (`non_shortest`,
`indefinite`, `key_order`) or a map key whose duplicates are not bytewise
(an EC-sensitive key), the run is replaced by a walk over the input's
canonical copy (its DC form, map pairs in wire order) with the same Program,
limits and budget, under these charging rules: every item, key and leaf is
charged as the table and schedule 2 charge the copy's encoding; a map whose
keys the source walk could not decide bytewise (keys out of order, not in
their canonical form, or EC-sensitive) adds its deferred duplicate check at
its logical end — 1 unit per key and ceil(min(len₁, len₂) / 8) per (D253)
comparison of the sort and of the neighbour scan over the keys' EC forms —
before anything else charged there; and a refusal of the source input is
replayed at the position of the copy where the source walk would have
reached it (after the charges that precede it on every route), with the
source's reason, offset and items. A run's verdict, reason, offset, path,
items and budget are therefore the same for an input and for every valid
re-encoding of it that keeps its map pairs in order, except for the deferred
checks' units of maps whose pairs moved or whose keys were re-encoded
(architecture §19.5). Resumable sessions take such items whole and walk them
the same way (D283).

**Schedules by path (D254).** Schedule 2's free bookkeeping prices what the
fast paths do for the simple shapes, decided by shape (Program and item),
never by window or chunk, so the buffer and session drivers charge the same
input identically on every host. The reference VM's diagnostic switch that
forces every item onto the generic walk (`limits` word 8 bit 0, a VM
extension, not public API) charges that walk by its own schedule, the table
(schedule 1): the walk does the table's bookkeeping, at 4–25× the fast
paths' CPU per unit under schedule 2 (bench/VM.md, calibration). A forced
run therefore equals the schedule-1 run of the same input word for word,
and equals the default run except for the budget used (and, when either
hits the budget, the exhaustion point).

---

## 15. Worked example

```
r = { kind: "a", x: int // kind: "b", ? y: [* tstr] }
```

Lowering (arch §4.3.1 step 1): two map leaves, `{kind: "a", x: int}` and
`{kind: "b", ? y: [* tstr]}`, both cut on every key (`name:`). No factors:
each map has one alternative; `? y` is a literal entry with min 0. Both maps
are closed (residual group `G_EMPTY`). `int` lowers to one INT leaf over
[−2^64, 2^64 − 1] (normaliser policy of P3.3, assumed here).

Leaf ids (preorder): L0 = first map, L1 = `"a"`, L2 = `int`, L3 = second map,
L4 = `"b"`, L5 = `[* tstr]`, L6 = `tstr`. Keys by encoding: `"x"` = `61 78`
(id 0), `"y"` = `61 79` (id 1), `"kind"` = `64 6b 69 6e 64` (id 2). Closure:
R₀ = {0, 3}, R₁ = {1, 2, 4, 5}, R₂ = {6}, R₃ = ∅.

### 15.1 The pool (14 bytes)

```
B[0]      72                 rule name "r"
B[1..3)   61 78              key 0 "x"
B[3..5)   61 79              key 1 "y"
B[5..10)  64 6b 69 6e 64     key 2 "kind"
B[10..12) 61 61              literal "a"
B[12..14) 61 62              literal "b"
```

Pool order policy: rule names (rule order), keys (key order), literals (leaf
order), bignum magnitudes, `.bits` masks; identical byte strings share.

### 15.2 The Program (286 words)

```
--- header ----------------------------------------------------------------
  0  0x67756e73   MAGIC
  1  1            FORMAT_VERSION
  2  64           HEADER_WORDS
  3  286          PROGRAM_WORDS
  4  14           POOL_BYTES
  5  0            PROFILE full
  6  0            FLAGS (no int keys, regexp, embed, combinators)
  7..14  k0..k7   SOURCE_KEY (host-filled)
 15  1            N_RULES
 16  7            N_LEAVES
 17  6            N_TYPESETS
 18  3            N_KEYS
 19  1            N_GROUPS
 20  2            N_MAPS
 21  1            N_ARRAYS
 22  0            N_REGEXPS
 23  1            N_INTERVALS
 24  0            N_FINTERVALS
 25  0            N_LITREFS
 26  3            N_CSETS
 27  1            N_CHAINS
 28  -1           TS_ANY (none needed)
 29  0            G_EMPTY = group 0
 30  0   31  0
 32  32           LIM_DEPTH (D)
 33  1500000      LIM_INPUT_BYTES
 34  65536        LIM_ENTRIES
 35  131072       LIM_ITEMS
 36  128          LIM_BIGNUM_BYTES
 37  2250000      LIM_BUDGET
 38  8388608      LIM_TOTAL_BYTES (8 MiB)
 39  0
 40  181          SCRATCH_MAX
 41  0
 42  64           S_RULES
 43  69           S_LEAVES
 44  125          S_TS_INDEX
 45  131          S_TS_DATA
 46  150          S_KEYS
 47  156          S_GROUP_INDEX
 48  157          S_GROUP_DATA
 49  159          S_MAP_INDEX
 50  161          S_MAP_DATA
 51  245          S_ARRAY_INDEX
 52  246          S_ARRAY_DATA
 53  255          S_REGEX_INDEX   (empty)
 54  255          S_REGEX_DATA    (empty)
 55  255          S_INTERVALS
 56  261          S_FINTERVALS    (empty)
 57  261          S_LITREFS       (empty)
 58  261          S_CSET_INDEX
 59  264          S_CSET_DATA
 60  280          S_CHAIN_INDEX
 61  281          S_CHAIN_DATA
 62  286          S_END
 63  0
--- rules ------------------------------------------------------------------
 64  0 1 0 0 181          "r" @B[0], len 1, typeset T0, chain 0, scratch 181
--- leaves (8 words: kind|flags, mask, d0..d5) -----------------------------
 69  15 0x020 0 0 0 0 0 0         L0 MAP map 0
 77   6 0x008 10 2 0 0 0 0        L1 LIT "a" @B[10], 2 bytes
 85   3 0x003 0 1 0 0 0 0         L2 INT intervals [0, +1), no BIGOK
 93  15 0x020 1 0 0 0 0 0         L3 MAP map 1
101   6 0x008 12 2 0 0 0 0        L4 LIT "b" @B[12]
109  14 0x010 0 0 0 0 0 0         L5 ARRAY array 0
117   8 0x008 0 0x7fffffff -1 0 0 0   L6 TEXT size 0..INF, no regexp
--- typeset index ----------------------------------------------------------
125  131 135 138 141 144 147      T0..T5
--- typesets (n_ans, n_eval, ans...) ---------------------------------------
131  2 0 0 3                      T0 {L0, L3}   rule r
135  1 0 1                        T1 {L1}       value of kind (map 0)
138  1 0 2                        T2 {L2}       value of x
141  1 0 4                        T3 {L4}       value of kind (map 1)
144  1 0 5                        T4 {L5}       value of y
147  1 0 6                        T5 {L6}       array position
--- keys (byte offset, length) ---------------------------------------------
150  1 2                          key 0 "x"
152  3 2                          key 1 "y"
154  5 5                          key 2 "kind"
--- groups -----------------------------------------------------------------
156  157                          group index
157  0 0                          G0 = empty group (closed map)
--- map index --------------------------------------------------------------
159  161 203
--- map 0: { kind: "a", x: int } -------------------------------------------
161  1 1 1 2 2 2 13 1             factors pools alts lits keys names state cand
169  0 -1 0 1                     factor 0: RESIDUAL, pools [0, 1)
173  0 0 0 1 5                    pool 0: factor 0, group G0, alts [0, 1), state +5
178  0 0 2 2 9                    alt 0: pool 0, lits [0, 2), req 2, state +9
183  2 1 1 1                      lit 0: key "kind", T1, min 1, cut
187  0 2 1 1                      lit 1: key "x",    T2, min 1, cut
191  0 0 0 1                      key "x":    owner factor 0, names [0, 1)
195  2 0 1 1                      key "kind": owner factor 0, names [1, 2)
199  0 1                          name 0: alt 0, lit 1
201  0 0                          name 1: alt 0, lit 0
--- map 1: { kind: "b", ? y: [* tstr] } ------------------------------------
203  1 1 1 2 2 2 13 1
211  0 -1 0 1                     factor 0
215  0 0 0 1 5                    pool 0: group G0
220  0 0 2 1 9                    alt 0: lits [0, 2), req 1, state +9
225  2 3 1 1                      lit 0: key "kind", T3, min 1, cut
229  1 4 0 1                      lit 1: key "y",    T4, min 0, cut
233  1 0 0 1                      key "y":    names [0, 1)
237  2 0 1 1                      key "kind": names [1, 2)
241  0 1                          name 0: alt 0, lit 1 (y)
243  0 0                          name 1: alt 0, lit 0 (kind)
--- array index, array 0: [* tstr] -----------------------------------------
245  246
246  1 1 0 1                      npos 1, W 1, no counters, nullable
250  0b1                          first {p0}
251  0b1                          accept {p0}
252  5 -1                         p0: typeset T5, uncounted
254  0b1                          follow[p0] = {p0}  (self-loop)
--- intervals ----------------------------------------------------------------
255  2 -1 -1 3 -1 -1              [NEG n=2^64-1 (= -2^64), POS 2^64-1]
--- closure sets ---------------------------------------------------------------
261  264 269 276                  cset index
264  2 38 0  0 3                  C0 = R0 {L0, L3}: frame 38
269  4 13 0  1 2 4 5              C1 = R1: frame 13
276  1 2 0   6                    C2 = R2 {L6}: frame 2
--- chains ---------------------------------------------------------------------
280  281
281  3 -1 0 1 2                   rule r: R0..R2, empty after
```

Derived values: map `state_words` = 4 + 1 factor + (4 + 0) pool + (3 + 1)
alt = 13; `cand_max` = 0 group entries + 1 naming record = 1. Frame C0 =
2·2 + (13 + 4) · 2 maps = 38; C1 = 2·4 + (3 + 2·1 + 0) = 13; C2 = 2·1 = 2.
Scratch for r = 48 + 2·7 + 2·33 + 0 + (38 + 13 + 2) = 181. Serialised:
96 + 4·286 + 14 = **1 254 bytes**.

Scratch carved for r with `MARK_CAP` = 7: scanner `S[0..16)`, VM `S[16..48)`,
`mark` 48–54, `qidx` 55–61, path stack 62–127, no regex area, frame 0 at
128 (QL 128–129, QF 130–131, L0 block 132–144, L3 block 145–157, candidates
158–165), frame 1 at 166 (QL 166–169, QF 170–173, array block 174–178), frame
2 at 179 (QL 179, QF 180), frames 3–32 empty (181).

### 15.3 Valid input: `{"y": ["p"], "kind": "b"}`

Bytes (13): `a2 | 61 79 | 81 61 70 | 64 6b 69 6e 64 | 61 62`.
Limits: all −1 (compiled defaults), top-any 1. Running budget total in
brackets.

1. **Root.** Build Q′₀ from T0: 2 elements [2]. Frame 0: QL = [0, 3],
   QF = [ANSWER, ANSWER].
2. **Map item at 0** (depth 0). Visit [3]. Scanner: item 1, `a2` = map of 2;
   depth 0 < 32, 4 ≤ 12 bytes left, 2 ≤ entries. Class `0x020`; filter |Q′| =
   2 [5]: L0 and L3 admitted. Init both blocks, ⌈13/16⌉ = 1 each [7]:
   alive = 1, `factor_live[0]` = 1, pool live = 1, alt state zero.
3. **Pair 0, key `"y"`** at 1.
   * Key search over ids [0, 3): probe 1 = `"y"`, equal → key 1 [8].
   * Blocks: L0 cursor 0 (key 0 < 1) steps to 1 (key 2 > 1): not named
     [10]; L3 cursor 0 is key 1: named [11].
   * Key query: no group entries in any live pool → empty. Key eval: visit 1
     + UTF-8 1 [13]; no key order check (first key).
   * Path: depth-1 segment = `KEY 1` (L3's live alt 0 names `"y"`).
   * Key phase: L3's naming record (alt 0, lit 1): alt 0 live → candidate
     (L3, lit, T4) [14].
   * Value query from T4: 1 element [15]. Frame 1: QL = [5].
   * **Array item at 3** (depth 1). Visit 1, filter 1, init L5 block
     ⌈5/16⌉ = 1 [18].
     * Element 0: path depth-2 segment = `INDEX 0`. The array item admitted
       only L5, one uncounted self-looping position with the one-answer
       typeset T5, and the block is alive: §14 schedule 2 rule 1, the
       element's bookkeeping is free (L5 block, C = first = {p0}, query from
       T5, frame 2: QL = [6]). **Text `"p"`** at 4: visit 1, UTF-8 1 [20];
       one scalar answer leaf (rule 3): no filter unit, L6 TEXT (size 1 in
       0..INF) evaluated without a leaf unit → matched. Stamp and candidate
       p0 (test T5 → matched) free; A = {p0}. Array still live → clear slot
       (already empty).
     * End: L5 block 1 + W [22]: p0 ∈ accept → L5 matched.
   * Stamp frame 1's matches (L5) [23]. Update: candidate (L3, lit 1): 1 +
     test T4 → matched [25]. Pool outcomes: L0 pool 0 and L3 pool 0 both see
     key 1 routed to the residual (L0 does not own it; L3's owner is factor
     0) with group G0 → `REJECT`. Naming record (L3 alt 0, lit 1): value
     matched → consume: `consumed` bit 1, `req_done` += 0, and since its pool
     rejected, `r` = 1 (exempt), pool `exempt` = 1 [26]. Pools [28]: L0 pool 0
     `rej` = 1, `live` = exempt 0 → `factor_live` 0 → **L0 dead**; L3 pool 0
     `rej` = 1, `live` = 1.
   * L3 live → map survives the pair; slot cleared. (The map item admitted
     two MAP leaves, so schedule 2 rule 2 does not apply to its pairs.)
4. **Pair 1, key `"kind"`** at 6.
   * Key search over [2, 3) (keys ascend): probe 2 equal → key 2 [29].
   * Blocks: L0 visited, dead [30]; L3 cursor 0 → 1 (key 2): named [32].
   * Key eval: visit 1, UTF-8 1, key order `61 79` < `64 6b…` 1 [35].
     Path: depth-1 segment = `KEY 2`.
   * Key phase: L3 naming record (alt 0, lit 0): alt 0 live (`r` 1 = `rej`
     1) → candidate (L3, lit, T3) [36]. Value query from T3 [37]: QL = [4].
   * **Text `"b"`** at 11: visit 1, UTF-8 1, filter 1, L4 LIT: 1 + compare
     `61 62` = `61 62` 1 → matched [42]. Stamp [43].
   * Update: candidate 1 + test [45]; L3 pool 0 `REJECT` (G0); naming record:
     consume lit 0, `req_done` = 1, `r` = 2 [46]; pool: `rej` = 2, `live` = 1
     [47]. Survives; slot cleared.
5. **Map end.** L0 visited, dead [48]; L3: 1 + alt 0 (live: `r` 2 =
   `rej` 2; `req_done` 1 = `req_count` 1 → satisfied) + pool 0 (no
   constrained entries) [51]. **L3 matched.**
6. **Root result.** Stamp Q′₀ (2) [53]; test T0: L0 not stamped, L3 stamped
   [55]. Scanner: end at 13 = length, no trailing.

`out = [0, 0, 0, 55, 6, 0, 0, 0]`: ok, 55 units, 6 items. (Under the legacy
schedule 1 the element costs 9 more — L5 block 1 + W · (0 + 1) and 1
candidate, query 1, filter 1, leaf 1, stamp 1, candidate 1 + test 1 — for 64
units, which is also what a reference VM forced onto its generic path reports:
D254 charges that path by schedule 1.) The 2,250,000 repricing of D253 leaves
these totals unchanged: every text here is under 8 bytes and every comparison
under 8 bytes, so each still costs 1.

### 15.4 Invalid input: `{"kind": "a"}`

Bytes (8): `a1 | 64 6b 69 6e 64 | 61 61`.

1. Root build [2]; map visit, filter, two block inits [7].
2. **Pair 0, key `"kind"`**: search [0, 3): probe 1 `"y"` < `"kind"`, probe 2
   equal [9]. L0 cursor 0 → 1 named; L3 cursor 0 → 1 named [13]. Key eval
   [15]. Path: `KEY 2`. Key phase: candidates (L0 lit 0, T1), (L3 lit 0, T3)
   [17]. Value query T1 + T3 [19]: QL = [1, 4].
3. **Text `"a"`**: visit, UTF-8, filter 2, L1 LIT 1 + compare 1 → matched, L4
   LIT 1 + compare 1 → `value` [27]. An answer matched, so no witness. Stamp
   2 [29].
4. Update: (L0, lit 0) 1 + test → matched; (L3, lit 0) 1 + test → not
   [33]. Both pools `REJECT` (G0). Naming: L0 alt 0 consumes `kind`,
   `req_done` = 1, `r` = 1; L3 alt 0: value failed and the entry has a cut →
   `dead` = 1, `factor_live` −1 [35]. Pools: L0 `rej` 1, `live` 1; L3 `rej`
   1, `live` 0 → **L3 dead** [37]. L0 live → slot cleared.
5. **Map end**: L0: 1 + alt 0 (live; `req_done` 1 < `req_count` 2: not
   satisfied) + pool 0 [40]; L3 visited, dead [41]. No leaf matched, slot
   empty → rule 4: live leaves {L0}; factor 0 has no satisfied alternative;
   alt 0; entries in source order: lit 0 `kind` consumed, lit 1 `x` min 1 not
   consumed → 2 entries examined [43]. Slot: `missing`, depth 0, extra
   `KEY 0`, offset 0.
6. Root: stamp Q′₀ (nothing matched) 2, test T0 2 [47]. Root failed; no
   profile failure; the slot is the result.

`out = [33, 0, 0, 47, 3, 1, 1, 0, 1, 0]`: `missing` at path `["x"]` (segment
`KEY 0`, rendered from KEYS[0] = `61 78`), 47 units, 3 items. Schedule 2 changes nothing
here: the map item admits two MAP leaves, and no array is reached.

For contrast, `{"x": "1", "kind": "a"}`: the value `"1"` is queried with
{L2} only (L3 does not name `x` and is closed, so it dies `unexpected` at
that pair without contributing a candidate); the text class `0x008` is not in
INT's mask `0x003`, nothing is admitted, the query empties and the value
records `type` with path `["x"]` (`x` named by L0's live alternative). L0's
alternative then dies on the cut, no leaf is live, rule 3 finds the slot
already set, the second pair is walked dead (1 + UTF-8 + key order per item),
and the result is `type` at `["x"]`.

### 15.5 A factor, for the record

`{ ? (a: int, b: int), * tstr => any }` (the reviewers' first
counterexample) lowers to: group G1 = [(T{tstr}, T{any}, 0, INF)]; factor 0
`RESIDUAL` with one pool (G1) and one empty alternative; factor 1 `ABSORB`,
`p_pool` = 0, one pool with alternatives A1 = [a: int (min 1, cut), b: int
(min 1, cut)] and A2 = []; keys `a` and `b` owned by factor 1.

```
map header   2 2 3 2 2 2 <state> <cand>
factors      0 -1 0 1  |  2 0 1 1
pools        0 G1 0 1 <off>  |  1 -1 1 2 <off>
alts         0 0 0 0 <off>  |  1 0 2 2 <off>  |  1 2 0 0 <off>
lits         a T{int} 1 1  |  b T{int} 1 1
keys         a 1 0 1  |  b 1 1 1
names        1 0  |  1 1
```

On `{a: 1}`: the pair is owned by factor 1. The residual pool's j\* is G1's
entry (key `"a"` ∈ tstr, value ∈ any; absorbing) → not `REJECT`, so factor
1's pool outcome is `ABSORB`. A1 consumes `a`; A2 does not name `a` and
survives because the pool did not reject; the residual pool is not involved.
At the end A1 misses `b`, A2 is satisfied, factor 0's empty alternative is
satisfied → accepted, as RFC 8610's existential reading requires.

---

## 16. Sizes per construct

| Construct | Words |
| --- | --- |
| header | 64 |
| rule | 5 (+ name bytes) |
| leaf | 8 |
| typeset | 1 index + 2 + n_ans (+ n_eval when it has combinators) |
| literal key | 2 (+ encoding bytes) |
| residual group | 1 + 2 + 4 per entry |
| map table | 1 + 8 + 4·factors + 5·pools + 5·alts + 4·lits + 4·keys + 2·names |
| array automaton | 1 + 4 + 2W + 2·npos + 2·counters + npos·W |
| regexp automaton | 1 + 4 + 2W + npos·W + atoms·(1 + W) |
| integer interval | 6 (+ magnitude bytes for bignum bounds) |
| float interval | 4 |
| LITSET member | 2 (+ encoding bytes) |
| closure set | 1 + 3 + n |
| chain | 1 + 2 + n |
| container | 96 bytes + 4·words + pool |

A typical two-field closed map with one alternative: 8 (leaf) + 1 + 8 + 4 + 5
+ 5 + 8 + 8 + 4 = 51 words. A 43-position ASCII regexp
(`[A-Za-z0-9_-]{43}`, 6 atoms ≈ 11 boundaries): 1 + 4 + 4 + 86 + 11·3 = 128
words.

---

## 17. Questions and proposed resolutions

Each is a place where arch revision 2 is silent, ambiguous or (in one case)
cannot be implemented as written. The format above assumes the proposed
resolution.

1. **Two hashes.** arch §5.2 says the serialised Program carries "the SHA-256
   of (schema text, options, snug version)" but defines no preimage, and the
   task asks for both a header hash slot and a container SHA-256 field.
   *Proposed:* the header slot holds the **source key** (cache key) over the
   CBOR preimage of §13.3; the container field holds a **content digest** of
   the container bytes, checked on load against truncation and bit rot.
   Neither authenticates (C18).
2. **Path of a profile failure.** arch §6 gives paths for schema failures
   only. Keeping the path stack current in dead subtrees would conflict with
   preserving the witness path (§9.2). *Proposed:* profile failures report no
   path, only the scanner's byte offset (which is not payload content); the
   public API decides whether to expose the offset.
3. **"First entry, in source order" across literal and typeset entries**
   (arch §6 rule 4). Groups are hash-consed and shared, so per-alternative
   source interleaving is not stored. *Proposed:* literal entries in source
   order first, then constrained group entries in priority order; a group
   entry is named `*`.
4. **Path of an array `missing`** (arch §6 rule 5 gives no segment).
   *Proposed:* the array's path plus `INDEX n`, n = element count (the
   position where an element was expected).
5. **Key items and the witness.** Read literally, arch §6 rule 2 would make a
   key whose query emptied the deepest witness, contradicting rule 4
   (`unexpected`). *Proposed:* map keys never record a witness.
6. **Embedded depth and scratch.** arch §4.6 accounts embedded depth
   "separately", but scratch frames are physical. *Proposed:* the embedded
   root is at physical depth k + 1 of its byte string; its effective depth
   limit is `min(depth limit, D − k − 1)`, so exceeding scratch is an inner
   `cbor/depth` (local to the EMBED leaf); inner documents run with top-any
   and without `cose` (Q16); the subcode is the innermost non-`embedded`
   reason, and nesting shows in the path.
7. **Cross-leaf sharing for many open map types (arch §4.3.4 step 3, A8).**
   The format shares work within one map leaf (pools, per-key naming index,
   O(1) pool rejection), but each pair still costs one unit per map block of
   the item. 100 open message types cost ~100 units per pair until
   discriminating keys kill them, not 1. A cross-leaf inverse key index needs
   a per-map-item index that nested children would clobber, or a build at
   every map start. *Proposed:* accept the per-block cost in format 1 (it is
   bounded by the closure width and charged), amend arch §4.3.4/§7 to say
   so, and revisit with the lazy DFA cache (parking lot).
8. **The §7 charging table is not precise enough for R6.** "1 per follow
   edge" assumes adjacency lists; typeset tests, stamping, block
   initialisation, visits and witness composition are uncharged loops there.
   *Proposed:* §14 becomes the normative schedule (or moves to a VM spec
   that cites it), arch §7 points to it, and the array row reads
   `W·(|A|+1)` for the bitset representation.
9. **A read-only Program tag.** snug.lang's `Ints` is `&mut [i32]` in Rust,
   so a Program could not be shared by threads validating concurrently.
   *Proposed:* P1.1 adds a read-only tag (`IntsR`: `Int32Array` / `&[i32]`)
   to snug.lang (snug's own vocabulary; no kin change), used for P in every
   entry point.
10. **Literal entry occurrences.** arch §4.3.1 gives entries `(min, max)`
    without saying that a literal key matches at most once. *Proposed:*
    literal entries are normalised to min ∈ {0, 1}, max 1; an alternative
    needing min > 1 on a literal key is unsatisfiable and dropped (arch
    §4.3.1 step 4).
11. **Which rules are validatable, and leaf numbering.** arch §4.2 says ids
    follow "first appearance in a depth-first walk of the rules in source
    order" (preorder or postorder unspecified; prelude position unspecified).
    *Proposed:* RULES lists the user's non-generic type rules only (no
    prelude, group or generic rules); leaf ids follow a preorder walk of the
    user's rules in source order, prelude leaves numbered when first reached.
12. **`UINTX size`.** arch §4.2 lists `UINTX size bits`, but every `uint
    .size` form is an interval (arch §4.6). *Proposed:* `.size` on `uint`
    lowers to INT; UINTX exists only for `.bits` (with an optional interval
    list).
13. **Bignum content as a child.** arch §4.1 says an INT leaf admitting
    bignums "gives the content `{BSTR}`". *Proposed:* equivalent but cheaper:
    the INT leaf compares the magnitude in place, and the tag content is
    visited as a schema child only with the union of content typesets of
    admitted TAG/TAGSET leaves (possibly empty, i.e. walked dead). The
    profile walk is unaffected.
14. **`top` and `cose` are run-time options**, not compiled. A schema with
    integer keys is meaningless without `cose`. *Proposed:* keep them
    run-time (arch §9: the same options go to VM and builder); `FLAGS` bit 0
    lets the host warn or default `cose` on.
15. **"Every VM access is a checked access"** (arch §5.2) would put a bound
    check on every Program read in the hot loop. *Proposed:* full structural
    verification proves every Program index in range; at run time the VM
    checks scratch capacity and input indexes only, and the host keeps P and
    B private after verification (copy on load). A Program changed after
    verification is a host bug, caught by the capacity checks where it
    matters for memory safety.
16. **Options of embedded documents.** Unspecified in arch §4.6.
    *Proposed:* top-any = 1, `cose` = 0, the same entries/items/bignum
    limits as the outer call (counted separately), the shared budget.
17. **Budget versus "profile errors always win"** (arch §4.5, D023). After
    budget exhaustion the walk cannot continue, so a later profile error is
    unknowable. *Proposed:* `budget` wins over everything once raised; arch
    §4.5 gets that exception.
18. **Leaf count limit.** arch §7 has none; the marks cost 2 words per leaf
    of scratch. *Proposed:* leaves ≤ 2^20 (hard), default 65 536, in the
    compile limit table.
19. **Combinator evaluation order.** arch §4.1 says AND/NOT are computed from
    operand results but not in which order nested combinators run.
    *Proposed:* the evaluation-list ordering of §5 (combinators after
    operands, first occurrence kept), which needs no sort or recursion.
20. **Physical depth convention.** *Proposed:* items exist at depths 0..D
    (a container at depth D − 1 has children at D; the scanner refuses a
    container or tag at depth ≥ the depth limit), so scratch has D + 1
    frames and the path stack D segments. A tag is a level (scanner.md), so a
    tag's content is one deeper than the tag.
21. **Embedded content needs end-bounded scanning.** The P1.3 scanner helpers
    compute "bytes remaining" from `blen(b)`, so they cannot walk an
    embedded document that ends before the input does, and snug.lang has no
    slice form (a JS `subarray` would also allocate per embedded item).
    *Proposed:* the VM's walk (and the shared helpers it calls) take an
    explicit end offset; `scan` keeps its current signature by passing
    `blen(b)`. This touches P1.3's code and is that owner's call.
22. **Bignum content limit.** arch §7 lists "bignum content bytes" as a
    validation limit (default 128, hard 4 096), but the scanner fixes it at
    `MAX_BIGNUM_BYTES = 128`. *Proposed:* keep the header word and limits
    slot (format stability) but accept only 128 in revision 2, until the
    scanner takes it as an option.

Sign-off of this format is D015's:
- [ ] **Signed off** (owner)
