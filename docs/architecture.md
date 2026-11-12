# snug — architecture

Status: **design, revision 2 (2026-10-29)** with §16 and §17 (revision 3, after
their independent reviews) for the owner's decisions D026 and D027,
provisional. Revision 1 was
reviewed independently by Codex (`docs/reviews/2026-10-29-codex.md`, "C#")
and by a Claude reviewer (`docs/reviews/2026-10-29-claude.md`, "A#"); §15
lists every finding and what this revision did about it. Decisions are
numbered in `DEVLOG.md` (`D###`) and cited inline. Nothing here is
owner-approved.

snug is a CDDL (RFC 8610) validator and a strict deterministic CBOR (RFC 8949
§4.2) codec, written once in kin and generated into JavaScript and Rust. Its
first consumer is 3sln.me, which runs JavaScript in Node, browsers and
Cloudflare Workers (V8 isolates, 100 ms CPU, 128 MB). The requirements and the
traps to avoid come from 3sln.me's study of the Rust `cddl` crate
(`3sln.me/docs/architecture/cddl-wasm-study.md`, "the study"), its CBOR
profile (`3sln.me/docs/spec/cbor.md`, "the profile") and its codec
(`packages/core/cbor.mjs`, "cbor.mjs").

---

## 1. Requirements, restated as properties

| # | Property | Why (source) |
| --- | --- | --- |
| R1 | **Sound** CDDL matching: closed maps under group choices, optional groups, member names equal to rule names, anchored regexps, cuts. What snug cannot decide exactly it refuses at compile time; it never accepts a schema with a different meaning. | study §0 items 1, 3; §3.1 |
| R2 | **Linear time** in input bytes with a schema-bounded coefficient, and a hard, explicit **step budget** charged for every unit of work actually done. | study §4 (323 ms, 205 ms), Worker 100 ms CPU |
| R3 | **Bounded memory**: scratch sized at compile time, capped; validation allocates nothing proportional to the input. | study §4 (71 MB linear memory that never shrinks) |
| R4 | **No panics or traps** on any input bytes or any schema text. Every failure is a value. | study §6 (32 + 94 traps) |
| R5 | Errors carry a **reason code and a path only**. Never a payload value, never input bytes, never a schema key the current map context does not name. | study §1, §4; profile §5 |
| R6 | **Deterministic** across hosts: same verdict, same reason, same path, same budget exhaustion point in JS and Rust. | owner constraint; kin's purpose |
| R7 | **Strict CBOR profile** with cbor.mjs's refusals *and refusal precedence*, passing `tests/vectors/cbor-*.json`. | owner constraint |
| R8 | **Single pass** over the bytes where possible; streaming-compatible structure. | owner constraint |
| R9 | **Small, and gated**: each public entry stays within its measured size (+2%) as recorded in `tools/size/budget.json` and checked by `bb size` — codec ≈ 14.6 KB gzip, runtime (codec + schema) ≈ 41.9 KB gzip on 2026-11-04; the compiler is a separate, lazily loaded module. *Restated by owner decision D200 (2026-11-04); the original 20 KB runtime target was withdrawn.* | browser and Worker bundles |
| R10 | **Untrusted schemas** (event-bus manifests) compile under explicit limits *and a compile budget*; a profile can forbid features. | study §8 |
| R11 | Integers of any size, exact; no host floats in any validation decision. | profile §3; study §3.1 (wasm32 integer bug) |

---

## 2. Shape of the system

```
          CDDL text ──► [compiler] ──► Program (Int32Array + byte pool)
                          kin             │   serialisable, keyed by SHA-256
                                          ▼
  CBOR bytes ───────────────────────► [validator VM] ──► ok | {reason, path}
                                         kin
                │                         │ ok
                └────────────────────► [value builder] ──► host values
                                         host (JS: hand-written)
  host values ──► [encoder] ──► CBOR bytes        host (JS: hand-written)
```

* **Compiler** (kin): lexes and parses CDDL from UTF-8 bytes, resolves names,
  instantiates generics, folds the prelude, normalises groups, checks the
  exactness conditions (§4.3, §4.4), and lowers to a **Program**: a flat
  `Int32Array` plus a byte pool.
* **Validator VM** (kin): walks CBOR bytes once, checking the strict CBOR
  profile and the Program in the same walk (§4.5). Bytes and 32-bit integers
  only; no allocation during a validation.
* **Value builder** (host): turns validated bytes into host values. It
  performs no validity checks; it is the only part that allocates in
  proportion to the input.
* **Encoder** (host): host values to deterministic CBOR.
* **Profile-only decode** is the VM against the built-in `any` Program
  followed by the builder, so the profile's refusals have exactly one
  implementation, in kin.

**The kin/host line (D003, narrowed in revision 2).** kin decides everything
about *bytes*: every CBOR profile refusal and every schema verdict. Hosts
decide *host-value admissibility* in the encoder (a JS class that has no CBOR
form, a sparse array, a cycle, a lone surrogate, NaN) because those questions
are about host objects kin cannot see; they are pinned by shared vectors, not
generated (C19, A10). Cross-host identity is promised for bytes and schemas,
and for corresponding abstract values in the encoder.

---

## 3. Representation: bytes and int32, nothing else

All kin code operates on `Uint8Array`/`&[u8]` input, `Int32Array`/`Vec<i32>`
arenas and 32-bit integers, through vocabulary forms that are **checked**
(no out-of-range index can panic in Rust or read `undefined` in JS) and
**explicitly wrapping** where arithmetic can overflow (`mul32` is
`Math.imul`/`wrapping_mul`); plain `+`/`-` are used only where the source
proves no overflow (A9).

* **Integers** are never materialised. A CBOR integer is (major, argument
  bytes); a bignum is (tag, content bytes). Bounds are stored the same way.
  Comparison: sign, magnitude length, bytes (order flipped for major 1). Any
  size works; 2^53 and 2^64 are not special (R11).
* **Floats** are bit patterns. The profile's float rules are bit tests;
  float ranges compare binary64 patterns (f16/f32 widened by integer
  operations) through the sign-magnitude-to-ordered transform on two 32-bit
  halves.
* **Float literals in schema text** (`1.1`, `1e-3`) must become exact binary64
  patterns. The compiler asks the host for this one conversion through a kin
  host port (`parse-f64`), and refuses literals with more than 17 significant
  digits or outside the binary64 range, so that JS `Number()` and Rust
  `str::parse::<f64>`, both correctly rounded in that domain, agree bit for bit
  (D020, A9b). This is compile time only; validation never touches a host
  float.
* **Text** is validated as UTF-8 while read; `.size` counts bytes; a regexp
  runs over code points decoded on the fly.
* **Literals** are stored as their deterministic encoding; equality with a
  literal is a byte comparison against the item's encoded span, correct
  because the profile admits one encoding per value.
* **Map keys** compare by encoded bytes, which is also the profile's key
  order.

---

## 4. Validation semantics

### 4.1 Type-set evaluation

A schema denotes a tree automaton over CBOR items. The VM evaluates it
top-down with on-the-fly subset construction: each item is visited once,
against the set of **queried leaves** it might be, and returns which of them
matched.

    eval(item, Q) → M ⊆ Q

Type choices contribute all their leaves; containers compute each child's
query set from the live state of every candidate, evaluate the child once, and
advance every candidate with the result. No item is evaluated twice; nothing
backtracks. A lazy `(state, transition) → state` cache is a later
optimisation, not part of the semantics.

**Obligations, not just unions (C7).** A leaf whose verdict depends on other
predicates over the *same* item (`AND`, `NOT`) contributes **dependencies**
that are evaluated alongside `Q` but are not themselves answers: the item is
evaluated against `Q ∪ deps(Q)`, then each `AND`/`NOT` leaf is computed from
its operands' results, and only `M ∩ Q` is returned. So
`([uint] .and [tstr]) / [bool]` does not accept `[1]` because `[uint]`
matched as an internal operand.

**A leaf that accepts an item without examining its children asks nothing
of them** (D043, which replaced this section's original "ANY gives {ANY}"):
the children of an item matched by `ANY` or a bare `MAJOR 4/5/6` are walked
dead — profile checks only — unless another candidate queries them; the
closure still lists `TS_ANY` for them. Children are always walked (the
profile requires it); a query set only says what is being asked of them.

### 4.2 Leaves and typesets

The compiler flattens every type expression into a **typeset**: a sorted
list of leaf ids. Leaves are hash-consed with cycle-aware canonicalisation
(recursive rules get a fixed point), so a leaf reached twice is evaluated
once per item. Ids are assigned in a deterministic order (first appearance in
a depth-first walk of the rules in source order), which the error rules (§6)
rely on.

| Leaf | Matches |
| --- | --- |
| `ANY` | any item |
| `MAJOR m` | any item of major type m (`#0`…`#5`, bare `#6`, bare `#7`) |
| `INT bounds bigok` | major 0/1 (and tag 2/3 if `bigok`) within an interval list |
| `FLOAT widths bounds` | float whose value one of the allowed widths represents exactly (`#7.25/26/27`, `float16`…; D328), optional interval list |
| `SIMPLE lo..hi` | the simple values lo..hi, both in 0..23 or both in 32..255 (`false`, `true`, `null`, `#7.v`, `#7.24` = 32..255, `#7.<T>`; D336) |
| `LIT k` | exactly pool literal k |
| `LITSET t` | one of a sorted set of literals of one major type (binary search); large enums count as one leaf (A8) |
| `TEXT size regexp` / `BYTES size bits` | string with constraints |
| `UINTX size bits` | `uint .size …`, `uint .bits …` |
| `TAG n content` / `TAGSET range content` | tag n (or `#6.<type>` with a uint range, RFC 9682) whose content matches typeset `content` |
| `EMBED content seq` | byte string whose content is one item (`.cbor`) or a sequence (`.cborseq`) matching `content`; a sub-validation (§4.6) |
| `ARRAY nfa` | array accepted by an automaton (§4.4) |
| `MAP table` | map accepted by an alternative table (§4.3) |
| `AND a b` / `NOT a` | `.and`, `.within`, and control intersections that do not fold; `NOT` only as `target ∧ ¬literal` for `.ne` (§4.6) |

Each leaf has a major mask; on reading an item's head the VM filters the query
set by mask (charged, §7).

### 4.3 Maps

#### 4.3.1 Normal form

1. A **top-level group choice** in a map, `{ A // B }`, becomes separate map
   leaves `{A} / {B}` (A1c). Choices are already parallel, so nothing is
   lost, and nothing below has to reason about correlated choices.
2. Each remaining map group is a **sequence** of members. Expansion of
   optional groups and inner choices produces **alternatives**: lists of
   **entries** `(key, value-typeset, min, max, cut)` where a key is a
   **literal key** (`name:`, `"name" =>`, `1:`) or a **key typeset**
   (`tstr =>`, `uint =>`, `any =>`).
3. **Group occurrence** (A2, C1, C2):
   * `? G` contributes the alternatives of `G` plus the empty alternative.
   * A group containing only literal-key entries with occurrence `n*m`
     contributes every union of between n and m alternatives of G (empty
     alternatives pad) whose literal key sets are pairwise disjoint. So
     `{ + (email: tstr // phone: tstr) }` accepts either or both, and
     `{ 2*2 (? a: int) }` accepts `{}` and `{a: 1}`. Refused above the
     alternatives limit.
   * A group containing only key-typeset entries is multiplied entry-wise
     **only when exact**: every inner entry absorbing (`0*∞`), or a fixed
     count `n*n` (copies are independent and entries are key-disjoint by the
     determinism rule, so each entry's total is an interval `[n·min, n·max]`).
     Otherwise refused: `{ 0*2 (2*2 tstr => int) }` has count set {0, 2, 4},
     which no interval represents.
   * A mixed group with maximum above one is refused.
4. **Unsatisfiable alternatives are dropped**, not refused (A11): two
   entries with the same literal key in one alternative (as `$$ext //=`
   composition produces) make that alternative unsatisfiable. If every
   alternative is dropped the map type is empty, which is a warning.

#### 4.3.2 Assignment inside one alternative

RFC 8610 map matching is existential. snug assigns greedily and refuses at
compile time any alternative where greedy and existential could disagree
(D011):

* **Priority**: literal-key entries first, then key-typeset entries in source
  order. A pair goes to the first entry whose key and value matched and whose
  counter is below its maximum.
* **Determinism rule**: if two entries of one alternative have overlapping
  key domains, the lower-priority one must be absorbing (min 0, max
  unbounded). Overlap is decided conservatively (literal vs literal: bytes;
  literal vs typeset: run the VM on the literal's encoding; typeset vs
  typeset: overlapping masks and not provably disjoint).
* **Lemma (flat, cut-free; confirmed by both reviewers, C5, A).** Under the
  rule, every entry with a positive minimum or finite maximum has a key
  domain disjoint from every other constrained entry, so each pair has at most
  one constrained candidate; taking it can only help that entry's minimum,
  and the absorbing entries have no constraint to violate. Hence greedy
  succeeds iff some assignment does.
* **Priority reordering is meaning-preserving only without a cut** (A6b):
  a cut literal entry that *follows* an overlapping key-typeset entry in
  source order is refused (`{ * tstr => any, ? "a": int }`), because the RFC's
  "later entries" reading would let the earlier wildcard take the pair.
* **Cuts.** A literal entry with a cut (`^ =>`, and `name:`/`value:`, which
  imply one, RFC 8610 §3.5.4) whose key matched and whose value did not
  **kills that alternative**. RFC 8610 says "the entire map fails to match";
  snug applies that per alternative, which is the only reading under which
  `kind: "a" … // kind: "b" …` works, and is stated as a deliberate choice
  (A6a, D021). A cut entry already at its maximum when its key matches again
  cannot occur (keys are unique). **Cuts on key typesets** (`tstr ^ => uint`)
  are refused in revision 2 (C4, A6c).

#### 4.3.3 Factors (only where provably exact)

Alternatives of one sequence may be stored as a product of **factors** so
that `k` independent optional groups cost `2k` alternatives, not `2^k`. A
factor F (a set of literal keys and its own alternatives) is kept separate
from the **residual** (the key-typeset entries) only when one of these holds
(A1):

1. F's literal keys are disjoint from every residual key typeset; then pairs
   are routed by key and the factors do not interact; or
2. the residual has exactly one alternative and every residual entry whose
   key domain overlaps F's keys is absorbing. Then an alternative of F that
   does not consume a pair keyed in F survives iff the residual's **acceptance
   predicate** holds for that pair (some overlapping absorbing entry accepts
   key and value). The predicate does not depend on counts, so it is computed
   once per pair and shared by every alternative of F.

Otherwise F merges into the residual's alternatives (plain DNF). Both
reviewers' counterexamples (`{ ? (a: int, b: int), * tstr => any }` with
`{a: 1}`; `{ ? (a: int, b: int), ((* tstr => int) // (* tstr => tstr)) }`)
are decided correctly: the first by condition 2, the second because its
residual has two alternatives, so F merges.

#### 4.3.4 Combined evaluation

For a map item and query set Q, the VM gathers the live alternatives of every
`MAP` leaf in Q and passes over the pairs once:

1. Read the key. Find its literal key id by **binary search** in the
   schema-wide sorted key table (bytewise order = key order; no hash table,
   so an untrusted schema cannot cluster probes; A7). If a live alternative
   has key-typeset entries, evaluate the key once against their union.
2. Collect the value query set: value typesets of entries, in any live
   alternative, whose key matched. Evaluate the value once.
3. Update each live alternative (or factor alternative) by §4.3.2/§4.3.3.
   Alternatives are **indexed by literal key** at compile time (per map
   leaf, for each literal key id, the alternatives naming it), and
   alternatives with identical residuals are grouped, so a pair whose key no
   alternative names costs one residual check per group, not one per
   alternative. *Amended (program.md §17 q7):* sharing is within one map
   leaf; a pair still costs one unit per map leaf queried, so 100 distinct
   open-map message types in one choice cost 100 per pair until the
   discriminating key arrives. Accepted for format 1; a cross-leaf index is
   parked.
4. If no candidate survives, the map item fails here (§6).

At the end, alternatives with an entry below its minimum die; the matched map
leaves are those with a surviving alternative. **Oracle**: a brute-force
existential matcher over small maps (exhaustive assignment) is part of the
fuzz corpus and must agree with the VM on every generated schema the
compiler accepts (A2, D022).

### 4.4 Arrays

Each array type's group compiles to a **Glushkov automaton** (positions with
typesets, `first`, `follow`, accepting). Member names in arrays are labels.
Group recursion is allowed only where it is regular (tail position, e.g.
`g = (int, ? g)` inside an array); other group recursion is refused (A12).

**Combined evaluation**: the live state is the union of active position sets
of every `ARRAY` leaf in Q; each element's query set is the union of the
typesets of positions reachable in one step; the next state is the reachable
positions whose typeset matched. Exact regular semantics, no greediness.

**Counters (A3, C6).** Bounded occurrence `n*m` on a single entry at position
p becomes one counted position only if **no predecessor q ≠ p of p can match
any value p can match**. Then p is never active at the same time as a
predecessor (an element taken by both would be in both domains), so p is
never re-entered while active and carries a single count. The revision-1
condition (disjoint from followers) was wrong: `[? uint, 2*3 uint, tstr]`
and `[* (int, int), 3*3 uint]` both fail the new condition and are unrolled.
Otherwise bounded repetitions unroll up to the position limit; beyond it the
schema is refused (D012). `[0*1048576 uint]`, `[1*16 T]`, `[int, 0*1000 tstr]`
qualify for counters.

### 4.5 The fused profile walk and its precedence

The VM checks the profile on every item it reads, whatever the schema says.

**Profile errors always win (A5a, D023).** When a schema failure is found,
the VM stops evaluating predicates but **continues the walk in profile-only
mode** to the end of the input (charged at the profile rate, §7). If a
profile refusal occurs anywhere, it is reported instead of the schema
failure. A message that is not valid profile CBOR therefore always gets a
profile code, exactly as decode-then-validate gives today, which keeps
3sln.me's split between "400 malformed" and "contract violation". The extra
walk costs only on invalid messages. *Exception (program.md §17 q17):* if
the step budget is exhausted, the walk stops and `budget` is reported; a
later profile error cannot be found.

**Order of checks** follows cbor.mjs exactly; the scanner specification
(`docs/scanner.md`, owned by P1.3) is the normative table, gated by a seeded
mutation differential against cbor.mjs that compares **codes**, not just
verdicts, with multiply-invalid inputs (C15, C16, A5b). Highlights:
`too_large` first; `not_map` by peeking byte 0 (empty input is `not_map`);
the item counter is incremented before the head is read; for containers and
tags `depth` before `truncated` (arrays need ≥ n bytes left, maps ≥ 2n)
before `too_many_entries`; `key_type` by peeking the key's major type, then
order/duplicate after the key; tag 4 and tag 40 demand `0x82`, decode the
inner array with its own refusals, *then* check their semantics; bignum and
typed-array content is peeked (`bignum`/`typed_array`), its bstr head can
fail first, and **its content is not counted as an item**; `float` before
`non_shortest`; `f8 xx` with xx < 24 is `non_shortest`; AI 28–30 is
`malformed`; a stray `0xff` is `indefinite`; in `cose` mode integer labels
must be safe integers, else `key_type`.

**Profile options** (P7.1, D120–D127) are one integer of flags in the
scanner block's word 11, read by every walk: zero is the Bindle profile above
(cbor.mjs's order and codes, bit for bit) and each set bit admits more — any
key kind, the standard tags with content checks or any tag (D180), RFC 8949 floats, `undefined`,
noncharacters ([profiles](profiles.md#the-option-model-d120)). The extended
order of checks is in `docs/scanner.md`. Programs never depend on the flags.

**Profile item counting is separate from predicate visits** (C15): typed
arrays and bignums are one item each, decimal and ndarray inner arrays count
as cbor.mjs counts them, and embedded `.cbor` content has its own accounting
(§4.6).

### 4.6 Controls

| Control | Lowering |
| --- | --- |
| `.size` | text/bytes: byte-length interval; `uint .size n` = `0..256^n−1`; `uint .size (lo..hi)` = values whose minimal byte length is in lo..hi (study §3.1 case) |
| `.bits` | allowed-bit mask (uint: bit positions; bstr: RFC 8610 §3.8.2 numbering, byte n>>3, bit n&7 LSB-first); vectors across byte boundaries |
| `.lt .le .gt .ge` | numeric literal: intersect the target's interval list (bignums included when the target admits them) |
| `.eq` | `target ∧ LIT k`, folded to `LIT k` only if the compiler proves `k ∈ target` (C8); `(tstr .size 1) .eq "aa"` is empty |
| `.ne` | numeric target: split interval (`(0..10) .ne 5` → `0..4, 6..10`); otherwise `target ∧ NOT LIT k` (C8) |
| `.and`, `.within` | folded when both sides are the same scalar kind (interval intersection); otherwise `AND` |
| `.regexp` | XSD Appendix F (default) or RFC 9485 I-Regexp, anchored (§4.7) |
| `.cbor T` / `.cborseq T` | `EMBED`: the content is validated as a **sub-validation**. Its profile, limit and schema failures kill only the `EMBED` leaf, never the message (`bstr .cbor {a: int} / bstr .size (0..16)` accepts `h'ff'`); if it is the reported failure the reason is `embedded` with a sub-code. Depth and item limits are accounted separately for the embedded document; only the budget is global. Exact span: the content must be fully consumed (`.cbor`: exactly one item; `.cborseq`: items to the end) (A4, C7). |
| `.default` | annotation; no effect |
| `.feature` | accepted as a no-op annotation (RFC 9165: it always matches) (A12) |
| `.cat`, `.det`, `.plus` | compile-time folding (P3, not gated in revision 2) |
| `.pcre` | refused (D013) |
| `.abnf`, `.abnfb` | with the optional module `snug/abnf` / `Controls::with_abnf()` (D334): extension controls named `abnf`/`abnfb` (the EXT row below). The controller is RFC 5234 + RFC 7405 ABNF (the start, then rules), checked at compile time (strict RFC parsing by default; the compile option `abnf: 'lenient'`, in the source key's registry flags, admits snug's non-RFC forms, D340) and prepared at bind. The match is kin's metered Earley recognizer over scalars or bytes (language membership), with scratch capped by a host option (default 2²² words = 16 MiB, the D281 arena default; at most 2²⁴). Without the module, `unsupported_control`. |
| a registered `.name` | extension control (D082, D140–D142): `AND(target leaf, EXT)` per target leaf; the EXT is decided by a host predicate over the item's encoding, only when the AND needs it, after the item's profile walk, charged before it runs (a fixed call charge plus the predicate's declared cost, by default one unit per item byte; the generic controls meter their own work in kin, D190–D193), bounded by the control's maximum item size (program.md §4.2, §14, format 1.1). Unregistered: `unknown_control` naming it. |

### 4.7 Regular expressions

`.regexp` selects XSD 1.0 Appendix F (default) or RFC 9485 I-Regexp with
`regexp: 'xsd' | 'iregexp'` (D242–D243), matched against the whole string. It compiles
to a Glushkov automaton over code-point range classes, at most 256 positions
(hard maximum 512), simulated as a bitset: per code point, the next state is
the OR of the follow masks of active positions, ANDed with the positions
whose class contains the code point. Cost per code point is
`(active + 1) × ⌈P/32⌉` word operations and is **charged as such** (C11, A7);
the worst case is `P × ⌈P/32⌉` = 2 048 word operations at P = 256. A class
lookup is a binary search over the regexp's range table. Counted repetition
unrolls within the position limit. D083/P7.3 adds `\\p{…}` and `\\P{…}` via
an explicitly supplied, compile-time-only `snug/unicode` module (Unicode 16.0,
D110–D111); without it these remain schema errors naming the module. Kin
resolves categories into the existing classes, including class unions and
complements; Cs is empty because text has no surrogates. Table ingestion,
lookup and class probes consume compile budget. Validation and stored
Programs need no table module. XSD class subtraction is range-set difference
(after base negation), with budget charged per range comparison/copy and
nesting capped. XML 1.0 fifth edition `\i`/`\c` ranges and `\s` (TAB/LF/CR/
SPACE) are static compiler data; complements need no tables. `\d` is Nd;
`\w` is the complement of P/Z/C, both requiring optional category tables.
I-Regexp still refuses these shorthands/subtraction. Block escapes explicitly
refuse unavailable pinned block data (Node's ICU API has no Block property).
Neither mode accepts host extensions or `\x..` (use CDDL Unicode escapes).
No VM/Program fields, runtime charges or scratch change. See the
[coverage table](cddl-support.md#regexp-cookbook).

### 4.8 Semantic notes

* `float16`/`float32`/`float64` mean the encoded width; under shortest-form
  encoding `float32` refuses `1.5`. Contracts should say `float`; the
  compiler warns.
* `uint` is major 0 only; `integer`/`unsigned` include bignums.
* `number` is `int / float`; decimals are not numbers.
* Undefined sockets (RFC 8610 §3.9): an undefined type socket `$x` is the
  empty type choice and an undefined group socket `$$x` the empty group
  *choice* -- no alternatives, so nothing matches through either. `[ $$x ]`
  and `{ a: int, $$x }` match nothing until `$$x` is plugged; `? $$x` and
  `* $$x` still match by taking zero occurrences.
  *Amended 2026-11-04 (D251, audit S32):* this note used to say `$$x` was the
  empty group (one empty derivation, so `{ a: int, $$x }` accepted `{a: 1}`,
  citing crate issue #838). That was a misreading of §3.9; the Ruby and Rust
  reference tools refuse both examples, and so does snug now.
* Float numbers compare numerically (RFC 8610 §3.8.6, D250): −0.0 and +0.0
  are one number for literals, ranges and `.lt .le .gt .ge .eq .ne`
  (`float .lt 0.0` and `float .ne 0.0` exclude both zeros; `0.0` and `-0.0`
  each match both), and NaN is outside every ordered comparison but unequal
  to every number (`float .ne 1.5` accepts NaN; `float .lt 2.0` refuses it).

---

## 5. The compiler

### 5.1 Pipeline

1. **Lex** UTF-8 bytes (RFC 8610 Appendix B with RFC 9682) into spans.
2. **Parse** (recursive descent, depth-limited) into an AST arena.
3. **Resolve** rules and sockets, unwrap `~`, enumerations `&`, generics
   (monomorphised, memoised on `(rule, argument typesets)`).
4. **Check productivity**: refuse a rule reaching itself without passing
   through a map, array or tag, and non-regular group recursion (§4.4).
5. **Normalise** (§4.2–§4.7) with every exactness condition checked.
6. **Close**: compute, per root and per depth, the reachable leaf sets
   `R_0 = Q_root ∪ deps`, `R_{k+1} = closure(children(R_k))` (one chain per
   root, periodic after at most |leaves| steps) and from them the maximum
   width, live alternatives, entries, array positions and regexp state needed
   at each depth (A8). These are both the scratch sizes and the published
   per-item cost bound.
7. **Lower** to the Program.

The prelude (RFC 8610 Appendix D) is CDDL text compiled with the schema.

**Compile budget (C12, A7).** Every phase charges a compile budget (default
10 M steps): AST nodes, instantiations, every alternative produced before the
alternatives limit is checked, every Glushkov follow edge, every unrolled
position, pool bytes. Expansions are checked **prospectively** (a product is
computed as a count before it is materialised; multiplications saturate), so
`g<T> = [g<[T, T]>]` or many independent choices are refused when their size
is known, not after building it.

### 5.2 The Program

One `Int32Array` (header, rules, typesets, leaves, sorted key table, maps with
factors, alternatives, entries and per-key indexes, arrays, regexps, bounds)
plus a byte pool. Exact layout: `docs/program.md`, frozen before the compiler
and VM are built in parallel (D015).

**Serialisation is first-class** (A9c): a runtime-only bundle can validate
with Programs compiled elsewhere (at build time, or by a lazily loaded
compiler). A serialised Program carries a format version, the snug version
and the **SHA-256 of (schema text, options, snug version)**. It must come from
a store the host trusts (a cache is not an authentication mechanism, C18);
the loader still runs a structural verifier (offsets and ids in range,
counts consistent, scratch sizes recomputed from the closure data rather than
read), and every VM access is a checked access, so a corrupt Program can give
a wrong verdict but never a crash or an out-of-bounds read.

### 5.3 Profiles

`full` (everything §4 supports), `bindle` (study §9.1: no sockets, no
`.cborseq`, no unwrap, no explicit cuts, non-recursive generics, text and
integer map keys), `bus` (`bindle` minus `.regexp`, every string and
container bounded, schema text ≤ 16 KiB, recursion refused). Profiles only
refuse; they never change the meaning of what they accept.

---

## 6. Errors

A failed validation returns `{reason, path}`.

**Reasons.** Schema: `type`, `missing`, `unexpected`, `value`, `size`,
`range`, `pattern`, `tag`, `bits`, `embedded`. Profile (`cbor/<code>`, the
complete cbor.mjs `CBORFault` list): `truncated`, `non_shortest`,
`indefinite`, `malformed`, `key_type`, `key_order`, `duplicate_key`, `text`,
`float`, `simple`, `tag`, `bignum`, `decimal`, `typed_array`, `ndarray`,
`trailing`, `depth`, `too_many_entries`, `too_many_items`, `too_large`,
`not_map`. Validator: `budget` (C16, A5c).

**Which failure (D024; C14, A4, A10).**

1. A profile failure anywhere wins (§4.5); it is the first in walk order.
2. Otherwise the schema failure is the **deepest point at which a query set
   became empty such that every ancestor then also failed**. The VM keeps one
   "pending witness" slot: when a child's matched set is empty it records the
   child's witness; if the parent survives anyway (another candidate did not
   need that child, as in `#6.2(bstr .size 9) / integer`), the slot is
   cleared. When the root fails, the slot holds the witness.
3. A witness at a scalar names the reason of the **first queried leaf in leaf
   id order whose major mask admits the item** (`(uint .lt 3) / 9` on `5`:
   `range`, because the `uint` leaf has the lower id), or `type` if no leaf
   admits its major type.
4. A witness at a map pair: `value` if some candidate alternative named the
   key, else `unexpected`. At map end: `missing`, naming the first entry, in
   source order, with unmet minimum, of the alternative that died **last**
   (at the latest pair index), ties broken by lowest alternative index
   (deterministic compile order).
5. A witness at an array: `type` at the first element no position accepted,
   or `missing` at the end (array too short) / `unexpected` (too long).

**Paths.** Segments are array indexes; schema literal keys, rendered from the
Program only, and **only if a live alternative in that map context names the
key** (otherwise `*`, so the path never reveals that the payload carried a
key some unrelated rule names; A10); `*` for unnamed data keys; `#tag` as a
fixed marker (never the received tag number; C14); `cbor` for embedded
content. Schema compile errors are `{code, line, column, rule}`.

---

## 7. Limits and the cost model

| Limit | Default | Hard max | Where |
| --- | --- | --- | --- |
| schema text bytes | 256 KiB (`bus` 16 KiB) | 1 MiB | compile |
| parser nesting depth | 64 | 256 | compile |
| AST nodes | 65 536 | 1 048 576 | compile |
| generic instantiations | 1 024 | 16 384 | compile |
| alternatives per map sequence (after factoring) | 64 | 1 024 | compile |
| array positions per array type | 256 | 4 096 | compile |
| regexp positions | 256 | 512 | compile |
| reachable width per depth (closure) | 256 | 4 096 | compile |
| pool bytes | 1 MiB | 16 MiB | compile |
| Program + pool + scratch bytes | 8 MiB | 64 MiB | compile (refused before allocation) |
| compile budget (steps) | 10 M | 2^31 − 1 | compile |
| input bytes | 1 500 000 | 2^31 − 1 | validate |
| depth (a tag counts) | 32 | 256 (≤ compiled) | validate |
| entries per container | 65 536 | 2^24 | validate |
| items per message | 131 072 | 2^24 | validate |
| bignum content bytes | 128 | 4 096 | validate |
| step budget | 2 250 000 (D253) | 2^31 − 1 | validate |

Per-call validation limits may only **lower** the compiled ones (A8): depth
and state capacity were sized at compile time.

**Charging (A7, C9, C10).** One budget unit is a bounded amount of work, and
every loop whose trip count depends on input or schema charges per trip:

| Work | Charge |
| --- | --- |
| item head + major-mask filter | 1 + \|Q\| |
| leaf evaluation (scalar) | 1 per leaf |
| content scans (UTF-8, `.bits`, typed-array NaN, literal compare) | per scan: UTF-8 and byte comparisons 1 per 8 bytes, `.bits` 1 per 12, typed-array NaN 1 per 64 (D253) |
| regexp step | `(active + 1) × ⌈P/32⌉` per code point, plus the class search |
| key binary search | ⌈log2 keys⌉ |
| map pair | 1 per candidate entry tested + 1 per live alternative group updated |
| array element | 1 per follow edge traversed + 1 per active position |
| AND / NOT / EMBED dependency | 1 per dependency |
| profile-only continuation (§4.5) | 1 per item + its content scans (above) |
| extension control asked (D190–D193) | 1 + 16 per call, + the predicate's units: a host predicate's declared cost (default 1 per item byte), charged before it runs; a generic control's metered work (heads, hashing, comparisons, probes) |

Budget arithmetic saturates. The exact, normative per-event schedule (so
that hosts agree on the exhaustion point) is `docs/program.md` §14; this table
is its summary. The default 2.25 M units (D046 as repriced by D253, under
program.md §14's schedule 2, D045; provisional) is calibrated so that the
worst budget-bounded input measured under normal dispatch stays near 50 ms in
Node on the reference machine (bench/VM.md, "Calibration 2026-11-04" and the
D253 confirmation); the workerd measurement is still to be taken (Phase 4).
The reference VM's forced-generic diagnostic mode is charged by schedule 1
(D254).

**Large T maps under the default budget (D323).** A map whose PEG program is
T (non-literal members under a choice or REP, §20.5) costs about 27–34 units
per pair when its keys arrive in EC order, and about 5.5–6 · n · log₂ n when
they must be sorted (unsorted input under the `valid` preset). Measured
limits of the default 2.25 M units: `{* (tstr => uint // tstr => tstr)}` about
66,000 pairs in order (the default 65,536 entries per container comes first)
and about 25,900 unsorted; `{ a: uint, * (tstr => uint // tstr => tstr) }`
about 66,800 / 25,700; `{ ? k00000: uint, * ("t" => uint // tstr => any) }`
about 83,000 / 27,000. Larger T maps need a larger `budget`.

---

## 8. Memory model

* **Scratch** is sized from the closure data (§5.1 step 6): per depth, the
  set, alternative counters, array state, regexp vectors and path stack that
  can be live at once, aggregated over all leaves that can be queried
  simultaneously, not per type (C13). The Program records the requirement;
  compile refuses a schema whose Program + pool + scratch exceeds the cap.
* **One scratch per isolate, not per schema** (A8): JS validation is
  synchronous and the VM calls no host code (beyond a pure extension-control predicate, which must not call snug), so a single lazily grown scratch
  (grown to the largest compiled requirement, releasable) serves every
  compiled schema. 1 000 cached bus manifests cost their Programs, not 1 000
  scratch arenas. In Rust, `validate` takes a `&mut Scratch` (or a per-thread
  pool); the JS single-thread argument is not assumed there (C13).
* **Validation** allocates nothing and reads input in place.
* **Builder** allocates exactly the output values. Input stability (C17): the
  JS `decode` refuses `Uint8Array`s backed by a `SharedArrayBuffer` (or, with
  an option, snapshots them first), because another agent could change the
  bytes between the checking and building passes; user wrapper constructors
  are called only after building completes.
* **Recursion** is bounded by the compiled depth (D016).

---

## 9. The codec

* `decode(bytes, opts)` = VM against `any`, then the builder.
  `schema.decode(bytes, rule)` = VM against the rule, then the builder, with
  the **same** `top`/`cose`/`objects` options passed to both (A14).
* Value mapping follows profile §2 and §6 exactly (see `host/js`).
* `encode(value, opts)` is hand-written per host with cbor.mjs's rules.
* **D017 (two-pass)** stays provisional: the measure is end-to-end
  check-plus-build latency against cbor.mjs, and against a fused prototype if
  the second pass dominates; invalid-input allocation behaviour and
  text-heavy bodies are reported (C22, A14).

---

## 10. Targets

* **JavaScript** through a kin JS target defined in snug's tree (D005).
* **Rust** through kin's Rust target: native tests, the differential oracle
  host, and the wasm build.
* **Go, Java, C#**: not in revision 2 (D006).

**The JS target decision is taken twice (C21, A9d).** P1.4 is an early gate on
the scanner (generated JS ≤ 1.25× hand-written; cold start and size reported).
The binding decision is taken in P4.3 on representative compiled schemas and
hostile cases, with complete artefacts: runtime and compiler sizes separately,
cold start (import/compile + first call) in Node and workerd, steady-state
latency, peak memory including the wasm input copy, and a zero-disagreement
JS-vs-Rust fuzz gate as a precondition. If generated JS loses there, JS
consumers get the wasm build (whose memory stays fixed, since validation
allocates nothing) with the hand-written JS host.

---

## 11. Alternatives considered

| Alternative | Verdict |
| --- | --- |
| Validate host values decoded by the strict codec (study §9.1) | Rejected as the core: host-specific, allocates before refusing. Encode-then-validate covers values. |
| Ordered trial with backtracking (+ memo) | Rejected: memo memory proportional to input; error shaping per alternative. |
| Full DFA over typesets | Rejected: state explosion; lazy bounded cache later. |
| Bipartite matching for maps | Deferred: the determinism rule is exact on every study contract; matching can be added for refused schemas. |
| Host regex engines | Rejected: ReDoS, divergence across hosts. |
| The `cddl` crate, patched | Rejected per study §9.2; native oracle only. |
| Fused single-pass decode | Deferred (D017). |
| Compiler hand-written in JS, VM in kin | Rejected: limits and exactness rules must agree across hosts. |
| Hash table for literal keys | Rejected in revision 2: probe clustering under untrusted schemas; sorted table + binary search instead (A7). |
| Kin-side decimal→binary64 parsing | Rejected: a big-integer algorithm in kin for a compile-time-only conversion; a host port restricted to ≤ 17 significant digits is exact on both hosts (D020). |

---

## 12. Benchmark plan (Phase 4; `bench/README.md` with environment)

1. Profile decode vs cbor.mjs: vectors; 287 B put; 1 MiB bstr put; 120 000
   integers; 1 MiB typed arrays; map-heavy and text-heavy 1.4 MB bodies.
2. Encode vs cbor.mjs.
3. Validate the six study contracts: snug JS vs snug wasm vs the crate's wasm
   build.
4. Hostile: invalid 1.4 MB vs six-way choice; declared 2^32−1 lengths; deep
   nesting; worst budget-bounded inputs per charging row (§7): time and
   memory high water.
5. Compile time: each contract; a 16 KiB generated schema; worst
   compile-budget schemas.
6. Size: runtime and compiler, min+gzip and brotli; wasm after `wasm-opt -Oz`.
7. Cold start: Node and workerd, JS import vs wasm compile+instantiate.
8. Kin cost: generated vs hand-written JS scanner.

---

## 13. Open questions (not to be guessed)

1. Project controls (equal-length columns, uniqueness — O(n log n) with
   scratch from the entries limit — code-point length, decimal bounds): in
   snug or a 3sln.me extension hook; names.
2. `\p{…}` worth its table size?
3. Program serialisation stability across snug versions (first-class within
   a version).

---

## 14. What revision 2 changed (summary)

Top-level map `//` split into map leaves; group occurrence exact or refused;
factors only under proven conditions; counter condition on predecessors;
typeset cuts refused; cut-after-wildcard refused; obligations for AND/NOT;
`.cbor` local with its own accounting; profile errors win with a profile-only
continuation; a defined witness rule; paths only name keys a live
alternative names; sorted key table; a real charging model and a compile
budget; closure-based width and scratch; one scratch per isolate; LITSET;
`.eq`/`.ne` lowering by intersection; float literals through a host port;
runtime/compiler split with first-class Programs; the D005 decision taken
twice; D003 narrowed to bytes.

## 15. Review disposition

| Finding | Disposition |
| --- | --- |
| C1, A2 group occurrence | Accepted: §4.3.1 (3). |
| C2 nullable literal groups | Accepted: §4.3.1 (3). |
| C3, A1 factors | Accepted: §4.3.1 (1), §4.3.3. |
| C4, A6c typeset cuts | Accepted: refused (§4.3.2). |
| C5 flat greedy lemma holds | Recorded as the lemma (§4.3.2). |
| C6, A3 counters | Accepted: predecessor condition (§4.4). |
| C7 obligations, embedded locality | Accepted: §4.1, §4.6. |
| C8 literal-control lowering | Accepted: §4.6. |
| C9, C10, A7 cost/budget | Accepted: §7 charging table. |
| C11 regexp complexity | Accepted: §4.7 states the simulation and its charged cost. |
| C12 compile budget | Accepted: §5.1. |
| C13, A8 memory | Accepted: §5.1 step 6, §8. |
| C14, A10 error ties, path leak | Accepted: §6. |
| C15, C16, A5 profile counting, precedence, codes | Accepted: §4.5, §6; forwarded to P1.3 with the mutation differential as its gate. |
| C17 shared input | Accepted: §8. |
| C18 verifier ≠ integrity | Accepted: §5.2 (trusted store + checked accesses). |
| C19 encoder refusals vs D003 | Accepted: D003 narrowed (§2). |
| C20 underspecified semantics | Accepted: §4.6 table; discriminating vectors required in P3.5. Project controls remain an owner question (§13). |
| C21, A9d D005 too narrow | Accepted: §10. |
| C22, A14 D017, size target | Accepted: §9; R9 split into runtime/compiler. |
| A4 local failures | Accepted: §6 rule 2, §4.6. |
| A6a, A6b cut reading, priority | Accepted: D021, §4.3.2. |
| A9a checked access, wrapping | Accepted: §3; forwarded to P1.1. |
| A9b float literal parsing | Accepted: host port (D020). |
| A9c Program serialisation | Accepted: §5.2. |
| A11 duplicate literal keys | Accepted: §4.3.1 (4). |
| A12 coverage gaps | Accepted: `#6.<type>`, `#7.n`, bare `#6`/`#7` (§4.2), undefined sockets (§4.8), regular group recursion (§4.4), `.feature` no-op (§4.6). |
| A13 project controls | Recorded for the owner (§13). |


---

## 16. Cursor, views and the builder (owner decision D026) — revision 3

The owner decided (2026-10-29) that codec and validator are one library built
around an opaque, unparsed message and a cursor: navigate and parse only what
is needed, validate fully in one pass when required, zero-copy views, an
encoder writing deterministic output directly, a materialising decode for
convenience; "the best CBOR library in the world, if we can do it without too
much hassle". Revision 1 of this section was reviewed independently
(`docs/reviews/2026-10-29-codex-s16.md`, "V#"); this revision answers it.

### 16.1 Facts that shape it

* Strings carry byte lengths (O(1) skip); arrays and maps carry only counts,
  so skipping one walks its descendants' heads unless an index knows its end.
* Deterministic encoding sorts map keys by encoded bytes, so a key lookup is a
  byte comparison and can stop early — **but only on bytes already proven
  ordered** (V8): early exit and binary search are justified by a completed
  check, never by the keys a lazy reader happened to visit.
* Received bytes are canonical: a subtree's span is its encoding (hashing,
  forwarding without re-encoding).
* Profile §5: untrusted input is refused whole before any value is used.

### 16.2 Two independent axes: trust and ownership (V1, V2)

**Trust.** A view is **checked** (the full fused pass ran: profile, plus the
schema when one is given) or **trusted** (the caller asserts that these exact
bytes were checked before, under the same profile options). There is no
"lazy checking" mode that pretends partial reads satisfy profile §5; a trusted
opener takes an explicit assertion argument and is documented as the
caller's promise. Inspecting malformed bytes is not supported.

**Ownership.** A check is a statement about bytes; it stays true only while
the bytes do not change. A view therefore either **owns** its bytes (copied at
open, or an `ArrayBuffer` transferred to it) — the default for checked views,
costing one memcpy (~0.1 ms per MB) — or **borrows** them under an explicit
contract (the caller must not mutate the buffer for the view's lifetime;
`SharedArrayBuffer` is refused). Zero-copy accessors (`bytes()` as a
subarray) are available only on borrowed views and on owned views as
read-only aliases of the view's own copy; `copyBytes()` always copies.

**Indexing** is a third, independent choice (§16.4), not a trust mode.

### 16.3 Validation and position (V3, V4, V5, V6)

Revision 1 claimed that descending through a map by a literal key yields that
entry's value typeset. That is false in general: the live alternative
depends on the map's other keys, and ancestor predicates (AND, sibling
constraints) are not visible from the child. **Withdrawn.** Instead:

* A **checked view against a schema** is valid as a whole; navigation needs no
  typesets.
* **`validateAt(rule)`** is a *detached* subtree validation: it proves exactly
  that this subtree's span matches the named rule (and the profile), nothing
  about its ancestors. It runs the VM over the span with an internal
  span-evaluation entry (start, end, rule, scratch) whose result is the same as
  validating the span as its own document, except that the depth and item
  accounting continue from the enclosing position.
* Position-aware lazy validation is parked until a precise contract exists.

### 16.4 Navigation and an optional index (V9–V13)

**First slice.** kin primitives over checked bytes: read a head, the span of
an item (structural skip with progress and bounds checks, charged), the n-th
child by sequential skip, key search in a map by linear scan with early exit
on sort order. These primitives walk **definite-length (deterministic-form)
bytes only**: a head with additional information 28–31 answers `NAV_BAD`, so
an indefinite-length item is never walked or skipped. Input that is not its
own deterministic form (`wire: 'valid'`) is navigated through its canonical
copy (§19.3); code that must find the end of arbitrary valid CBOR cannot use
`nav-skip` for it. The host exposes a `View` (offset + owner) and a mutable
`Cursor` (`enter`, `next`, `up`, `key`) for allocation-free loops, exact scalar
accessors, raw spans and `value()` (materialise a subtree via the builder).

**Index**, private until measured: a bounded **per-container child directory**
built on first access to a container (offsets of its children, `n` words),
held by the view (message-owned state, never the transient VM scratch; V14).
Map lookup then binary-searches the directory. A dense whole-message tape is
not built: its addressing and single-pass sizing were not specified (V10–V12)
and nothing yet shows it beats on-demand directories. Benchmarks decide.

### 16.5 The builder (V15–V17)

The current host encoder stays the baseline and the default. A `Writer` (typed
methods, `beginArray(n)`/`beginMap(n)`/`end()`) is a later item with a
specified grammar state machine (counts remaining, closed nested values,
failure leaves the writer unusable), with map keys either supplied in order or
sorted at `end()` by permuting complete, non-overlapping pair ranges. The
deterministic choices are shared kin primitives; the host↔kin representation
is specified with that item.

### 16.6 Accessors (V18)

Integers: `number()` throws outside ±(2^53−1); `bigint()` always works;
`int()` returns either. Decimals and ndarrays as the builder's wrappers.
Typed arrays: `typedView()` returns a portable accessor (element count,
`get(i)` reading little-endian) because a subarray of the input may be
misaligned for a native typed array; `typed()` copies into an aligned native
array.

### 16.7 Benchmarks that would justify "best" (V19)

A matrix with correctness checks outside timing: open (copy vs borrow) + one
field, sequential walk, repeated random access, full materialise; for the 287
B put, 1 MiB bstr put, 120 000 ints, typed arrays, map-heavy and text-heavy
bodies; vs cbor.mjs and, conceptually, the common JS CBOR libraries (cbor-x,
cborg, cbor) — named, not installed (offline), so only cbor.mjs is measured;
memory retained per view.

---

## 17. Sources: buffers, blob handles and streams (owner direction D027) — revision 3

The owner directed (2026-10-29) that the codec and validator work over an
opaque blob handle (size + sync/async range reads; object storage via HTTP
range requests) and over streams (validate as bytes arrive, bounded buffering,
resumable, backpressure), with the same Program for all sources, the buffer
path as fast as possible, and a benchmark of the abstraction's cost.
Revision 1 was reviewed independently (`docs/reviews/2026-10-29-codex-s17.md`,
"W#"); this revision answers it.

### 17.1 Plan/fulfil sessions

The VM never does I/O. A **session** runs the walk over windows of the
message; when it needs bytes it does not have it returns **`NEED(offset,
minLength)`**, and the host resumes it with a window containing them (a slice
of a buffer, a cached chunk, a range read, the next chunk of a stream). This
requires the explicit-stack VM (D016 superseded). The session protocol (W2,
W21):

* **Results**: `NEED`, `YIELD` (§17.4), `DONE` (verdict), `ERROR` (verdict:
  profile/schema/budget code), and host-side `SOURCE_FAILURE` (read failed,
  short read, size or version changed, declared length mismatch) and
  `ABORTED`. Source failures are transport outcomes, never CBOR verdicts (W13).
* **Window ownership**: each result reports the offset up to which the session
  has consumed input; bytes before it will not be requested again by the
  forward walk, so a stream host may drop them. A window must include the
  requested range; the session guarantees progress (it never asks for a range
  it was just given).
* **Known length** (W1): every session declares the exact document length up
  front — a buffer's length, a handle's size, a push stream's declared length
  (`Content-Length`, a framing header). All existing checks that depend on the
  end (`truncated` precedence, `too_large`, `trailing`, minimum remaining
  lengths) use it, so codes are identical across sources. Delivered bytes that
  do not match the declared length are a source failure; an empty chunk is
  never EOF.
* **Unknown length** (D085, D144–D146): the session runs with the input limit
  as a provisional end. A length or count check that passes against it with a
  claim beyond the bytes seen is recorded as a *pending check* (claim, offset,
  budget used, items: what the buffer walk answers if the message ends before
  the claim); the root's trailing check asks for one more byte; a verdict is
  *held*. At EOF (or past the limit) the pending checks settle: too_large past
  the limit, else the earliest unsatisfied check's truncated, else the held
  verdict — or, when the walk was waiting for bytes, its ends become the real
  one and it finishes. Codes are therefore identical to a buffer of the same
  bytes; an opt-in fail-fast reports a held refusal at once (its code may
  differ). Divergences can only start at a check of a crossing item (frames
  note them) or of a byte string skipped from its head; a prescan stopping at
  a refusal inside an item no longer makes that item "whole".
* **Exclusive state** (W9): a live session owns its scratch arena from start
  to a terminal state, across every `await`. Programs (immutable) are shared;
  arenas come from a pool of idle ones with a bound on live sessions and on
  pooled high water. Concurrent resume of one session is refused. This amends
  §8: "one scratch per isolate" holds for synchronous buffer validation (a
  short exclusive lease); asynchronous sessions lease their own.

### 17.2 What a session carries across a suspension

* Heads are never split (the head must be in the window).
* String and typed-array content is scanned **incrementally** with carried
  state: UTF-8 decoder state, typed-array element remainder, NaN-check state,
  regexp bitset, literal-compare position, `.bits` position, size counters.
  Suspension can happen mid-string.
* **Map key look-back without a new limit** (W3–W5): cbor.mjs has no key
  length cap (a 1,025-byte key is valid), so none is added. Each *active* map
  needs its previous key (nested maps each keep one). The session keeps
  active key spans in its arena: for a buffer or handle source, as offsets
  into the message (re-readable); for a forward-only stream, as copies, with
  the arena bounded by the declared document length — bounded memory, but not
  a tiny constant, and accounted as such. `LITSET`/literal-key binary search
  over a key split across windows uses the copied key (W6).
* Embedded `.cbor` content runs as a nested sub-walk over a sub-range of the
  same windows (W7); tag-4/tag-40 deferred checks keep summaries in the frame
  (W8); the profile-only continuation and the witness slot are session state
  (W11).
* Offsets stay below 2^31 and the 1.5 MB default stays (W14); 64-bit documents
  are a later, separate change to the ABI.

### 17.3 Sources

| Source | Interface | Notes |
| --- | --- | --- |
| **Buffer** | `Uint8Array` / `&[u8]` | one window, `NEED` never happens; monomorphic fast path in the host (W20) |
| **Blob handle** | JS `{ size, version?, read(offset, length) → Uint8Array \| Promise<Uint8Array> }`; Rust `trait Blob` (+ async) | a **checked view over a handle needs an immutable snapshot** (W12): the handle must pin a version (an ETag with `If-Match`, an object generation) and every read is made against it; a changed version is a source failure. Synchronous `read` results are used without a Promise (W20). Cache and read-ahead are byte-budgeted and come later, measured (W15). |
| **Push stream (known length)** | `session.feed(chunk)` → result; `finalize()`; adapters for `ReadableStream` / `AsyncIterable` | backpressure = the driver pulls the next chunk only on `NEED` and respects `YIELD` (W16); a forward-only cursor exists only during the pass (W18); fused stream materialisation is deferred (W17); CBOR sequences (RFC 8742) are a later framing item (W21). |

### 17.4 CPU scheduling: `YIELD` (W19)

A window that holds the whole message never produces `NEED`, so a long
validation would occupy the event loop. The session therefore returns
**`YIELD`** after a deterministic work quantum (a count of charged units,
default 64 Ki), with safe points inside long content scans and regexp loops
as well as at items. Yields and needs change nothing observable: verdict,
code, path, error offset, items and budget are identical for every window
split and quantum (W10, W22) — budget charges are per event and never depend
on where windows end. The quantum gives fairness and responsive abort; it
does not reset any CPU allowance, and the global budget still bounds total
work.

### 17.5 One driver or two (W22, W23)

The buffer fast path is measured against the resumable walk (P6.1, scanner
first; then the VM). If whole-window resumable costs ≤ 15% over the recursive
walk on the P1.4 inputs, one kin driver serves all sources; otherwise a
specialised recursive buffer driver is kept beside the resumable one. **Either
way**, a differential gate requires identical results for every corpus input
between the recursive scanner (the oracle) and the resumable walk under
whole-window, every-offset splits (small inputs), random splits and tiny yield
quanta. The 15% figure is a trigger for a decision, not the decision.

### 17.6 Benchmarks (W24)

Separate the VM's overhead from transport policy and from retained output:
(a) recursive vs resumable whole-window (pure VM overhead); (b) resumable with
64 KiB / 16 KiB / 1 KiB windows from an in-memory source (driver overhead,
sync and async); (c) a simulated remote handle with injected latency (requests,
bytes read, time) for one-field reads; (d) carried memory high water.

### 17.7 First slice and what is deferred

First: the session contract above; the resumable profile scanner in kin with
the recursive scanner as oracle; three supplies (buffer, immutable
synchronous handle, genuinely async mock handle) plus a push source with a
declared length; the split/EOF/lifetime/interleaving gates; benchmarks (a)
and (b). Then the VM's scratch/API/charging amendment for sessions, with
worked executions of long `LITSET` keys, key-typeset entries and nested
`EMBED`. Deferred: fused stream decode, remote views
and indexes, cache/read-ahead policy, sequences, 64-bit offsets.

### 17.8 Review disposition

Every finding of both reviews was accepted. §16: V1–V2 (trust and ownership
axes), V3–V6 (withdrawn positional typesets; `validateAt`; span entry), V7–V9
(no lazy checking mode; ordered search only on checked bytes; structural skip
contract), V10–V14 (tape withdrawn; per-container directories in view state),
V15–V17 (writer deferred, grammar and kin/host representation specified with
it), V18 (accessors), V19 (benchmark matrix), V20 (complete-buffer scope for
§16; sources in §17). §17: W1 (known length; unknown deferred to the owner),
W2/W13/W21 (session protocol and outcomes), W3–W6 (no key cap; per-map key
state; copies for streams), W7/W8/W11 (embedded, tag summaries, continuation
as session state), W9 (exclusive arenas), W10/W22 (charge timing and the
differential gate), W12/W15 (snapshot handles; cache later), W14 (offsets
< 2^31), W16–W18 (backpressure, fused decode deferred, forward cursor during
the pass), W19 (`YIELD`), W20 (sync reads, monomorphic buffer path), W23–W24
(the 15% trigger; benchmark separation).

---

## 18. CBOR sequences (RFC 8742; review item W21) — design 2026-11-04, provisional

The owner's use case: an HTTP response (SSE-like, long-lived, unknown total
length, served as `application/cbor-seq`) whose body is a CBOR sequence of
messages. The consumer wants each message as soon as its last byte arrives,
checked (profile, and optionally a schema rule), as a lazy View that does not
materialise or re-scan it. W21 asked for exactly this as an **explicit mode**,
never as a fallback of the single-document APIs, which stay strict about
`trailing`. Decisions D210–D219.

### 18.1 What a message's verdict is (D211)

For a sequence S and a message starting at absolute offset o, let P be the
per-message size limit (`maxMessageBytes`, at most the input limit) and
R = |S| − o the bytes that follow (not known for a stream until it ends).
The **message window** is W = S[o, o + min(R, P)). The verdict is defined by
the buffer driver (`vm-validate`, or the scanner for profile-only) over W
with the `trailing` check replaced by a boundary:

1. **The root ends at t < |W|** (the buffer reports `cbor/trailing` at t):
   the message is S[o, o + t) and its verdict is the buffer driver's over
   exactly those bytes — accepted, a schema failure, or `budget` — with
   every offset made absolute (+ o). The next message starts at o + t.
2. **The root ends exactly at |W|**: as 1 with t = |W|.
3. **`cbor/truncated` and R > P**: `cbor/too_large` at o (budget 0, items 0,
   as the buffer reports `too_large`): the message does not end within P
   bytes. With R ≤ P it stays `cbor/truncated` (the input ended inside the
   message).
4. **Any other refusal**: that verdict (profile code or `budget`), offsets
   absolute. The message has no known end.

For a valid message, case 1/2 equals the buffer driver over the message's
own bytes in every word (code, offset, budget used, items, path): every claim
of a completed root lies inside it, so no check depends on what follows.
For an invalid one "its own bytes" is undefined; W makes the answer a pure
function of (S, o, P) — independent of chunking — and needs no byte past
o + P beyond knowing whether one exists (R > P), which is counted, never
buffered. Two consequences, both deliberate: a refusal other than
truncation is answered as soon as no earlier length claim is still open
(there is no drain to the end of the stream, unlike D085, whose `too_large`
counts the whole input); and an embedded payload truncated inside its byte
string is reported `too_large` when more than P bytes follow (case 3 cannot
tell which end a truncation was against; the code is still a refusal and
still a function of the bytes).

### 18.2 One pass: the session VM's sequence mode (D210, D212)

A sequence is a series of roots, each validated by the resumable session
(§17) in a new **sequence mode** (`vms-init-seq`): an unknown-length session
(D144, provisional end P, pending end checks) whose root end is a boundary.

* At the root's end the walk does not look for `trailing` (it neither reads
  nor asks for the next byte): it records the message length
  (`vms-message-length`) and finishes the root's typeset test and witness as
  the buffer walk does at its end.
* The verdict is **held** while a pending end check remains (a length or
  count claim beyond the bytes delivered — e.g. a byte string skipped from
  its head whose content has not arrived) or while it is `truncated` (case 3:
  is the input longer than P?). Each later step drops the pending checks its
  window covers (a window asserts its bytes exist, D147) and answers the
  verdict once none is left; `vms-eof(n)` settles as in drain mode (n > P:
  `too_large`; an uncovered claim: `truncated`; else the held verdict).
* Offsets inside a session are relative to the message start; the host adds
  o, so a sequence may run past 2^31 bytes (a message may not).
* Per-message reset is a re-initialisation of the same arrays (scratch,
  session array, key arena grown with the input read up to P, D342): items, depth, budget and the
  witness start fresh for every message; nothing is allocated per message.
* Profile-only sequences run the same session against the built-in
  `r = any` Program (largest limits), as unknown-length scanning already does
  (D146): one implementation of end-dependent checks, gated once. The
  resumable scanner (`rscan`) stays known-length; a second sequence mode
  there would be a second set of pending checks to keep equal.

The View of an accepted message is opened **without a scan**: the host mints
it from the session's verdict through an internal capability (§18.5).

### 18.3 Limits (D213)

Per message, each starting from zero: `maxMessageBytes` (P; default the input
limit — 1,500,000 bytes profile-only, the schema's compiled input limit with
a schema), `maxDepth`, `maxEntries`, `maxItems`, `maxBignumBytes`, `budget`
(each only lowers the compiled value, as everywhere). `maxBytes` is refused
in sequence options (its meaning — message or stream? — would be a guess).
Per sequence: nothing in this slice. A consumer bounds a sequence by leaving
the loop (which cancels the source); total CPU is bounded per message by the
budget, so per byte of input. The key arena grows with the message read, up
to P (D342; it used to be sized for P at the start).

### 18.4 Invalid messages: stop or skip (D214)

`onInvalid: 'stop'` (default) ends the sequence at the first refused message:
every earlier message has been delivered, the refusal is reported, the
source is not read further (and is cancelled). Earlier messages cannot be
revoked (W21). `onInvalid: 'skip'` skips a message **only when its framing
is intact**: its root completed (the whole message passed the profile
check, its end is known and its bytes were delivered) and the reason is a
schema reason (`type`, `missing`, `unexpected`, `value`, `size`, `range`,
`pattern`, `tag`, `bits`, `embedded`, `control`, `control_size`). Never
skippable: every `cbor/*` code (including `truncated`, `too_large` and the
depth/entries/items limits: a profile refusal leaves no safe resynchronisation
point in CBOR), `budget` (wherever the allowance ran out), an extension
predicate that threw, and source failures. A refusal carries `skippable` so
a consumer can see which kind it got.

### 18.5 Bytes, views and ownership (D215)

* A message lying wholly inside one delivered chunk is a **borrowed
  subarray** of that chunk (zero copy). A message spanning chunks is
  **assembled** into a buffer of its own (growth doubles, capped at P, so
  copies are amortised linear; bytes after a message that ended inside the
  assembly stay a view of it and each message gets exactly its own bytes, so
  splitting many messages out of one assembly is linear too).
* `readSequence` checks one message ahead of its consumer (it pauses after
  each message, keeping the chunk), so leaving the loop stops the work at the
  next boundary; the push API returns everything a chunk completes.
* `copy: 'spanning'` (default) borrows when it can; `copy: 'always'` gives
  every message a fresh buffer. Borrowing is safe when the source hands over
  chunks whose buffers it never mutates, recycles or transfers afterwards — a
  `fetch` body's byte stream, an async generator yielding new arrays. A
  default `ReadableStream` reader does not guarantee that by itself (it hands
  over whatever the producer enqueued). Use `'always'` (a plain copy, Node
  `Buffer` chunks included) otherwise: BYOB adapters, pooled or reused
  buffers, a push caller that recycles its chunk after `feed` returns. snug never writes to a chunk;
  a borrowed message (and its View) aliases the chunk, so the chunk must not
  change while either is used. SharedArrayBuffer chunks are refused.
* A message's View is minted from its verdict by an internal function of the
  view module that no package entry exports: only the sequence reader holds
  the capability. There is no public "trust me" opener (§16.2, V1/V2): a
  View still always means "these bytes passed the full check".
* Rust: the borrow checker carries the contract. The push API answers
  messages that borrow the fed chunk (`Cow::Borrowed`) or own their assembly
  (`Cow::Owned`); the `Read` iterator yields owned messages. `View` borrows
  the message.

### 18.6 Errors (D216)

A refused message is reported with its **index** (0-based), the absolute
offset of the message (`messageOffset`) and of the failure (`offset`), the
code / reason / path / subcode of the per-message verdict, and `skippable` —
never payload. JS: a `SnugFault` (D103's family: `code` unprefixed for CBOR,
`schema/<reason>` otherwise). Rust: `Error::Sequence(MessageFailure)`.
Adapter failures are `SourceError` (`bad_chunk`) / `Error::Source`; transport
exceptions pass through unchanged, as for the other sources. An exception
from an extension predicate ends the sequence after the messages found
before it (yielded first; the push result carries it as `error`).

**Liveness (D212, amended after review 2026-11-04).** A complete message is
released by the bytes that complete it: no read the walk makes reaches past
the item it is reading. Where a check wants a fixed span (an extension leaf's
maximum, a tag-40 shape/data note) the session first asks whether the item
already ends in the window (the structural prescan) and otherwise asks for
exactly one more byte of it; key reads ask for exactly what `key-end-any`
needs next. Gated: no accepted message waits for a byte past its end.

### 18.7 End of input (D217)

EOF at a boundary ends the sequence, including the empty sequence (no
message, no error). EOF inside a message is `cbor/truncated` with the
message's index (case 3, or a pending claim the input never covered).
`trailing` does not exist in a sequence. `too_large` is answered as soon as
more than P bytes follow the message start while the walk still needs one,
counting the bytes without buffering them. The drain machinery is used only
within a message, for its own pending claims; no check needs the stream's
end except a truncation's. `failFast: true` reports a held refusal at once
(D145's contract: the accept/refuse decision is the same; the code may be the
walk's `truncated` where case 3 would say `too_large`, or the refusal where
an earlier open claim would have been `truncated`); an accepted message is
never released before its bytes are complete.

### 18.8 API

JS (`snug/sequence`, its own entry so that `snug/sources` does not carry the View):

```js
for await (const m of readSequence(source, { schema, rule: 'event', maxMessageBytes: 65536 }))
  m.view.get('type').text();   // m: { index, offset, length, bytes, borrowed, view }
const reader = sequenceReader({ schema, rule: 'event' });   // push
const { messages, skipped, error } = reader.feed(chunk);     // ... reader.end()
```

`source`: a ReadableStream, an AsyncIterable or an Iterable of Uint8Array.
Options: the validation options (profile, top, cose, per-message limits)
with `maxMessageBytes`, plus `schema` + `rule`, `onInvalid`, `copy`,
`failFast`, and (readSequence) `quantum`. Rust: `snug::read_sequence(reader,
&SequenceOptions)` / `Schema::read_sequence(reader, rule, &SequenceOptions)`
(an `Iterator<Item = Result<Message, Error>>`), and `snug::Sequence`
(`feed(&[u8]) -> Vec<Result<Message<'_>, Error>>`, `finish()`).

### 18.9 Gate and benchmarks (D218)

`bb sequence-test`: every vm-test case set (corpus, oracle schemas,
mutations, profile identity) and the scanner's vectors and mutations, built
into sequences of 0–8 messages (valid and invalid at random positions,
oversize under a small P, truncated tails), delivered under whole, 1-byte,
random-size and (small inputs) every-offset chunkings: the per-message
results equal §18.1's oracle in every word, the stop/skip outcome is as
specified, JS == Rust (kin level, debug build, panics caught); hosts: JS
`readSequence`/`sequenceReader` and Rust `read_sequence`/`Sequence` give the
oracle's messages, borrowed exactly when a message lies in one chunk under
`'spanning'` and never under `'always'`, with views walk-equal to a View
opened on the message's bytes; JS behind out-of-bounds traps (a sample).
Benchmarks in `bench/SEQUENCE.md`.

### 18.10 Deferred

*(The wasm SDK's sequence reader landed in P7.13w: the driver of §18 over a
wasm sequence session -- `sdk_vs_new` with total -2, `sdk_vs_reseq`, INFO[4..5]
held code and message length, `sdk_ses_step_at` -- with the native windows
exactly, views over a linear-memory copy; D219.)* Per-sequence caps;
a reader that resynchronises after a profile error (not possible in general
for CBOR); fused materialisation of messages (use `view.value()`).

---

## 19. Valid CBOR input (RFC 8949 §5.3; owner direction D230.2) — design 2026-11-04, provisional

D230 makes snug a general CBOR decoder: by default every decoder path —
`decode`, views, the scanner, `validate`/`validateAt`, handles, streams, push
sources and sequences — accepts any **well-formed, valid** CBOR item (RFC 8949
§3, §5.3), not only the deterministic subset (§4.2.1), while still refusing
what the RFC calls invalid. Deterministic checking (§4.2, with D122's NaN
rule) and the Bindle profile stay as options. Encoders keep writing
deterministic bytes. Decisions D260–D269; the audit's ranked fixes 5 and 9
(docs/conformance.md §(c), §(h), §(j)).

### 19.1 The `valid` preset and its flag (D260)

A new host profile bit **`PF_VALID` (bit 8, 256)** in the profile flags word
(`O_PROFILE`, scanner `o[11]`; VM limits word 9): set, it admits the
non-deterministic encodings of RFC 8949; clear, every path behaves exactly as
before. Presets: `valid` = `PF_DETERMINISTIC | PF_VALID` = **378** (the new
default: any key, any tag, RFC floats, `undefined`, noncharacters, plus
non-deterministic encodings); `deterministic` = 122; `bindle` = 0. Zero is
still the Bindle profile and every set bit still admits more, so old flag
words keep their meaning and a host that never fills the word still gets the
strictest policy. `PF_HOST` becomes 383. Two internal bits follow `PF_SUB`
(bit 7): `PF_CANON` (bit 9: the walk is over a canonical copy whose
duplicates the canonical pass has already checked, §19.5) and nothing else;
hosts never set them (`scanProfile` keeps the host bits only). The VM's
deterministic walk of a valid-CBOR run carries `PF_VREL` (bit 10) instead of
`PF_VALID`: what `PF_VALID` admits without changing bytes.

Under `PF_VALID`:

| Admitted (valid, not deterministic) | Still refused |
| --- | --- |
| Indefinite-length byte and text strings (definite chunks of the same major type, a `ff` break), arrays and maps | Every Appendix F well-formedness error: reserved AI 28–30, `f8 xx` with xx < 32, AI 31 on majors 0/1/6, a wrong or indefinite chunk, a break outside an indefinite item, in a definite container or tag, or in a map's value position (`malformed`); input ending before a break (`truncated`) |
| Non-shortest heads: integers, lengths, counts, tag numbers | Duplicate map keys, by value (§19.2, §19.4) — `duplicate_key` |
| Floats in any width, NaN with any sign, payload or signalling bit | Invalid UTF-8 in a text string or any chunk of one (a chunk boundary inside a code point is invalid, §3.2.3) — `text` |
| Map keys in any order | Invalid content of a tag snug knows (§5.3.2): dates, epochs, URIs, tag 24, bignums, decimals, ndarrays, typed arrays (§19.6) — their codes |
| Bignums with leading zero bytes or that fit major 0/1 (§3.4.3: decoders MUST accept leading zeros) | RFC 8949 §9.2's invalid tag numbers; the limits (unassigned simple values are admitted under `PF_UNDEFINED`, D284) |

The other flags (keys, tags, floats, `undefined`, noncharacters, `top`, `cose`)
keep their meaning and combine with `PF_VALID`. Refusal codes are unchanged;
the only new spelling is `malformed` for the indefinite-structure errors that
the deterministic profile reports as `indefinite` (a deterministic walk still
says `indefinite`, `non_shortest` and `key_order`, at the same offsets).

### 19.2 What "equal" means: the canonical-value comparison model (D261)

Comparisons on bytes must now be comparisons of **values** (RFC 8949 §2 data
model; §5.6.1 for map keys). snug defines two canonical forms of an item:

* **DC, the deterministic canonical form** — the §4.2.1 encoding of the
  item's data-model value: shortest heads, definite lengths, a string's
  chunks concatenated, every float in the shortest width that holds its exact
  bits (sign, NaN payload and signalling bit included: `fa7fc00000` →
  `f97e00`, `fa7fc00001` stays four bytes, `-0.0` stays `f98000`), tag numbers
  shortest, tag content in DC, bignum content bytes unchanged (`2(h'0001')`
  stays: a tag-2 item is not the integer 1 and keeps its bytes), **map pairs
  in their wire order**. DC is what a CDDL literal, a LITSET member, a KEYS
  entry and the key order are compared against: `1` matches `1801`, `"a"`
  matches `7f6161ff`, `1.5` matches `fa3fc00000`; `1` does not match `1.0`
  (distinct values, §5.6.1; S17 unchanged). For deterministic input DC is the
  input itself, so no existing verdict moves.
* **EC, the equivalence form** (§5.6.1) — DC with every float zero positive
  (`-0.0` equals `0.0`), every NaN's sign cleared (NaNs are equal when their
  significands, zero-extended on the right, are; the DC width already depends
  on the significand only), and every map's pairs sorted by their keys' EC
  bytes (maps are equal as sets of pairs). Two keys are duplicates iff their
  EC bytes are equal. EC is used for duplicate detection only.

A key is **EC-sensitive** when its EC form can differ from its DC form other
than by being non-canonical: it contains a float zero, a NaN, or a map whose
keys are not in canonical order. Only EC-sensitive and non-canonical keys ever
need an EC form written out; for every other key its bytes are its DC and EC
form.

### 19.3 Where canonicalisation happens (D262)

The guiding constraint: deterministic input must cost what it costs today on
every path, and the walkers that matter for speed (the VM's live and dead
walks, their D044 fast paths, the resumable session's buffer walks) must not
grow per-byte work for encodings that deterministic input never has.

* **The recursive scanner (`kin/scan.kin`) checks valid CBOR natively** — loops
  until a break, chunk checks, non-shortest heads, any float width, the key
  order test against the previous key's DC form, the duplicate check of §19.4 —
  and can write the **canonical copy** (DC, wire order) of a non-deterministic
  input (§19.5). Deterministic input takes the existing code path (the extra
  tests sit only where the deterministic walk would refuse).
* **The VM's buffer walks stay deterministic.** Under `PF_VALID` a run first
  walks the input exactly as the deterministic profile does (the
  **attempt**). If it ends in a refusal that only a non-deterministic
  encoding can cause — `indefinite`, `non_shortest`, `key_order` — or saw an
  EC-sensitive key (§19.4), the attempt is discarded (budget, items and the
  witness restored) and the run takes the **canonical path**: the scanner
  checks the item and writes its canonical copy, then the unchanged VM
  validates the copy under `PF_VALID | PF_CANON` (§19.5), and every offset it
  reports is mapped back to the input. Deterministic input is decided by the
  attempt alone, as today. What `PF_VALID` admits without changing an
  encoding's bytes — a NaN with a sign, payload or signalling bit in its
  shortest width, a bignum with leading zeros, the tag rules of §19.6 — the
  attempt and the walk over the copy admit directly (the copy contains them).
* **`decode` and views** run the scanner; for non-deterministic input the
  builder and the View read the canonical copy (which the View owns: `borrow`
  cannot alias input that is not the canonical form; Rust's borrowing `View`
  answers `owned_view` and a new owned `Document` holds the copy). `raw()` is
  already documented as an item's canonical encoding; `offset` is a position
  in the View's message (the copy). Map order is the wire order in both; a
  view whose scan noted keys out of order searches maps linearly
  (`nav-find-any`).
* **The resumable session (handles, streams, push, sequences)** cannot copy a
  stream; it walks valid CBOR natively in its frames (§19.7) and sends
  non-deterministic items it takes whole through the same attempt/canonical
  path as the buffer driver. Profile-only handles under `PF_VALID` run the
  session against `any` (as unknown-length scanning already does, D146);
  `rscan` stays a deterministic/Bindle path.

The three routes give **the same out array** (code, offset, budget used,
items, path) for any input, because the charges of the canonical path are
defined on the canonical form (§19.4) and the copy keeps wire order (so a
witness names the same pair the session's frames name).

### 19.4 Key order and duplicate keys (D263)

Per map, in wire order, every key's DC form is compared with the previous
key's (the existing key-order comparison, charged as today: ⌈min(len₁,
len₂)/64⌉, at least 1, on the DC lengths):

* **ascending** (greater): no duplicate is possible so far;
* **equal**: `duplicate_key` at this key, immediately (deterministic and valid
  alike; the existing behaviour);
* **descending**: under the deterministic profiles `key_order` at this key;
  under `PF_VALID` (or `PF_CANON`) the map is **marked**.

A map with an EC-sensitive key is also marked (all profiles: under the
deterministic preset `{0.0: 1, -0.0: 2}` is today accepted although RFC 8949
§5.6.1 makes those keys equal; the mark fixes it). When a marked map ends —
after its last value, so refusals inside the map's pairs come first — the
**deferred check** runs: one record per key (its comparison form: the input
bytes when the key is canonical and not EC-sensitive, else its EC form
written to scratch, with the key's offset), a heap sort of the records by
comparison bytes (ties by offset), then a pass over neighbours. The refusal
is `duplicate_key` at the **earliest second occurrence**: the smallest key
offset that equals some earlier key (what an O(n²) walk in wire order would
report). Cost (program.md §14 additions): 1 per record, then each sort and
neighbour comparison ⌈min(len₁, len₂)/64⌉, at least 1. An n-key map costs at
most n + 2n·⌈log₂ n⌉ comparison units beyond its keys' bytes; n is bounded by
`maxEntries`. The scanner rebuilds the records by re-walking the marked map's
keys from its head (no memory for sorted maps); the session retains them
(its bytes are gone, §19.7). Both produce the same record sequence, so the
same comparisons and charges. Over a canonical copy (`PF_CANON`) the keys come
in wire order: a key below its predecessor restarts the key-table search bound
and every map block's cursor (uncharged), so the map matching of program.md §8.3
needs no sorted input; the session does the same.

### 19.5 The canonical copy and the canonical path (D264, D277, D280)

**Two passes, both kin.** A valid-CBOR check is the scanner's walk (`scan-cb`;
`scan-x` for a span or a session's whole item). When the walk admitted an
encoding that changes bytes in the DC form (`o[12]` bit `VC_NONDET`), a second,
trusted pass writes the item's **canonical copy** (`canon-build`,
`kin/vcopy.kin`, over the writers of `kin/canon.kin`). Input that is only out
of key order, or holds NaN payloads or bignum leading zeros, is its own copy:
decode and views read it in place. The VM's canonical path (below) always
builds the copy, for a refused input too.

**Layout and content.** The input item is copied to the start of the buffer
(`cb[0, n)`, the *source*) and the copy written after it (from `cb[n]`,
`o[O_S_CBASE]`): the DC form of the item in wire order — definite heads in
shortest form, strings concatenated, floats shortened, everything else byte
for byte (byte-string and text content, bignum content, tag-24 payloads).
Size ≤ n + ⌊n/128⌋ + 16 for a complete n-byte item (strings, heads and floats
never grow; an indefinite container of k ≥ 256 elements grows by at most 3
bytes and holds ≥ k bytes); a refused item's copy adds at most n + 64 bytes of
planting and padding (below).

**The prefix writer.** The copy is written by `pw`, which checks what the
scanner checks for well-formedness, in the scanner's order (end of input,
reserved AI, indefinite on a major that has none, head bytes, length claims,
the depth and entry bounds, an indefinite string's chunks), and stops at the
first item that fails. Everything else the scanner refuses — a definite
text's UTF-8, key types, tag rules, floats and simple values, item counts —
the copy carries byte for byte and the VM's own walk refuses it there. So a
refused input has an executable **partial copy**:

* an **item stop** — an item that cannot be read — leaves its place
  *planted* with bytes on which the VM's walk reaches the same check phase as
  on the input and refuses: a malformed head of the source byte's major type
  (so key-type peeks, a tag's content kind and the visit and count come
  first, as on the input); where the source has no byte, a byte string whose
  length runs past any end (truncated after the visit and count, or, as tag
  content, before any visit — as on the input); for an indefinite text
  refused for a chunk's UTF-8, a text of the chunks' bytes up to and including
  that chunk with an invalid byte at the refused byte's content offset, so
  the text's scan charge precedes the refusal and the offset maps back to the
  refused byte;
* a **container stop** — the input ends where a map key or an indefinite
  container's entry would begin, which every route refuses before any visit,
  or an indefinite container reaches `maxEntries` with another entry — gives
  the container the count of its complete entries and an end event that
  refuses at its end, before its end-run;
* containers open at a stop keep their heads: a definite one its own count,
  an indefinite one the count of the entries begun;
* zero bytes, never walked, pad the copy after the stop (and after an item
  that more input bytes follow), so every length claim the input passed —
  a definite container's minimum-byte check, a string's length — still passes
  in the copy, and the walk meets the stop before any padding.

**Events.** Seven words each, sorted by position then kind, in the scanner's
options array past its header, then in the VM scratch past the rule's own
words (`S[36]` their offset during the run). A container's events sit at its
content start (the position after its head), which no other container shares.

| event | at | meaning |
|---|---|---|
| `EV_HEAD` | a stop | the recorded code and offset, the code the planting makes the VM find, the planted length, the stopped item's source start |
| `EV_UNITS` | a map's content start | a complete marked map's deferred duplicate check, in units (D277), charged at the map's position |
| `EV_END` | a container's content start | a refusal at its end, before its end-run: a duplicate the deferred check found, too many entries in an indefinite container, a container stop |
| `EV_KEY` | a key | a refusal after the key's key-order comparison: an immediate duplicate, or (deterministic profiles on the canonical path) `key_order` |
| `EV_EMB` | byte-string content | the content's own copy (start, end, its stop) |

The scanner notes its key refusals (kind, the key's or the map's first key's
position, the refused key's offset, the code) in its scratch header; the
writer finds their copy positions as it writes.

**Embedded CBOR.** Byte strings whose content the VM may walk as CBOR — every
tag-24 payload the profile walks (a standard-set tag 24), and, when the
Program has `.cbor`/`.cborseq` controls (`FL_EMBED`), every byte string — are
checked as a CBOR sequence under the same profile, in the copy and,
recursively, inside content walked in place. Content that is valid and its own
DC form is walked in place; any other content — not its own DC form, or
refused — gets its own copy region after the main copy, written by the same
prefix writer (a refused one partial, planted and padded, with its key
refusals' events), and an `EV_EMB` event. The VM walking such content looks
the event up and walks the copy instead; its refusals happen there, by the
same rules. Content in an indefinite-length byte string is checked on the main
copy, where every string is definite.

**Offsets.** The copy keeps the input's item structure one for one, so a copy
offset maps back by a lockstep walk of the two (`map-back-p`: an item's head
to the item's start, a string's content byte to the matching byte of the
matching chunk, a child recursively, the stop to the stopped item's start, an
embedded copy first to its content). The walk never enters a planted item: an
item that holds the stop is incomplete. A refusal the VM finds at a stop with
the planted code is reported with the stop's own code and offset — the run's
code, or the sub-code of a witness when embedded content's refusal became
one. Every other offset (error, witness, budget position) is mapped once, at
the end; paths are unchanged.

**Deferred checks in the scanner.** The scanner's walk takes no byte buffer of
its own (its hot path stays as it was), so three rare checks that need one are
recorded and run when the walk ends, in the order they were recorded — which is
walk order, and before the walk's own refusal if any, since every record
precedes the point where the walk stopped: a marked map's duplicate check
whose keys need EC forms, the text rule of tag 0/32 and the payload walk of tag
24 over an indefinite-length string (gathered into the buffer; refusals inside
a gathered payload map back into its chunks; a payload's items are counted as
they would be in walk order, a replay of the walk settling `maxItems` when
payload items could pass it). The records sit at the end of the options
array's scratch, the records of a running duplicate check at its start.

**The scratch protocol.** `scan-cb(b, o, cb)`: `o` is the scanner's options
array, now any length — words 16–47 a scratch header (record stack, deferral
bottom, duplicate-check units, buffer top, deferral count, source, payload
items; the copy's build: source base and end, event count, stop and planting,
the key refusal and its copy positions), the rest events, records and
deferrals — and `cb` the byte buffer. `o[12]` carries the outcomes
(`VC_NONDET`; `VC_UNSORTED`: some map's keys may be out of canonical order;
`VC_ECS`: the VM saw an EC-sensitive key), `o[13]`/`o[14]` the words and bytes
needed, `o[15]` the copy's end or −1. A buffer that is too small ends the call
with the internal code `scratch` (22), never seen by a user: the host grows the
buffer and calls again (D033's rule). `scan(b, o)` stays for callers without a
buffer and answers `scratch` when a deferred check is needed. The VM's
`vm-validate-v` / `vm-validate-span-v` take `vs` (the scanner's options array
for the canonical path, which also holds the events) and `cb`; too small, they
answer −5 with the words, bytes and VM-scratch words needed in `out[5..7]`.
Hosts keep one leased set per isolate, as for the VM scratch.

**The canonical path and its charges (D277, D280).** The VM attempts every
valid-CBOR run deterministically (D262); when the attempt meets an encoding
only valid CBOR has, or a key whose duplicates are not bytewise, the run
takes the canonical path: the scanner checks the item, `canon-build` writes
the (possibly partial) copy, the events and the embedded copies, and the VM
walks the copy under `PF_CANON` with a fresh budget. Refusals decided before
any walk on every route (`too_large`, `not_map`) are reported at once;
everything else is reached by the walk. The canonical pass (reading the input,
writing the copy, the events and the units) is not metered: it is linear in
the input, like the codec's scan. The VM's run over the copy is charged by the
table as for any input, the key-order comparison of every key included
(`PF_CANON` compares, charges and never refuses — a recorded `key_order` is an
`EV_KEY`). A marked map's deferred duplicate check (§19.4) is charged **at
that map's logical end**, before anything else there, on every route: the
copy's units pass computes each complete marked map's units over the copy (the
same records and comparisons as the scanner's) and the VM charges them when
its walk reaches that map's end — as the session does when it runs the check
there. The VM's fast paths leave every container end, every key that breaks
the ascending order and every stop to the generic walk, so they need no hooks
of their own. A non-deterministic input therefore costs what its canonical
copy costs plus its duplicate checks, charged at the same points as on the
session's route; CPU per call is bounded by twice the budget plus the linear
passes. When the scanner and the replay ever disagree (never expected: the
gates hold them equal), the scanner's verdict stands.

**Refusal replay (D280).** A refused input is walked, not reported from the
scanner: the VM's walk over the partial copy reaches the refusal at its own
check phase, after exactly the charges, item counts and schema work that
precede it on the input, so a budget that runs out earlier — or at that very
event — and profile-only continuation after a schema failure (D023) act as on
every other route. F2 (docs/reviews/2026-11-04-peg-final-check.md), point by
point:

* *An executable partial-copy representation* — the prefix writer above: the
  valid prefix in DC form, open containers' heads, the planted stop or the
  container stop, padding.
* *Check phases, not locations* — the stop is planted so that the walk's own
  checks reach it: visit, count and the items limit; a key's type peek; a
  tag's content-kind check; a text's scan charge before its `text` refusal;
  container stops, deferred duplicates and too many entries at the container's
  end before its end-run; immediate duplicates after the key's key-order
  charge; deferred units before the duplicate refusal they precede.
* *Original length and end claims, open containers, refused-item metadata* —
  definite containers keep their counts and padding keeps their minimum-byte
  checks true; the stop's code, offset and item start travel in its event.
* *The same item counting and every preceding charge, including a budget
  that fails at the same logical event* — the planted item is visited and
  counted as the input's item is; charges at the refusal's own position come
  first, so a budget one unit short reports `budget` there.
* *No synthetic truncation or end-run* — padding means no premature
  `truncated`; a container stop refuses before its end-run; the walk stops at
  the stop and never reads the padding.
* *No live schema charges after D023* — the walk is the VM's ordinary walk:
  after a schema failure the rest is dead, so the planted item is walked dead,
  as the input's would be.
* *Embedded and deferred-duplicate cases* — embedded content is checked and,
  refused, copied by the same writer (its own stop, planting and key events);
  deferred duplicates are end events of their maps, after their units.
* *Gates* — the valid-CBOR gate (§19.9, `bb valid-test`) runs invalid text
  (definite and indefinite), malformed and truncated partial containers
  (definite and indefinite, keys and values, tag content), immediate and
  deferred duplicates and embedded content (tag 24 and `.cbor`) at every
  budget from 0 to the run's total and compares the whole out array with the
  session (whole item and framed, every window split) and with the expected
  native verdict.

### 19.6 Application rules move to the Bindle tag set (D265; audit rank 9)

These restrictions are Bindle's value model, not RFC validity; they now apply
only at tag level 0 (`tags: 'bindle'`, the Bindle preset):

| Rule | `tags: 'bindle'` | `tags: 'standard'` / `'any'` (both other presets) |
| --- | --- | --- |
| Tag 4 decimal | `[e, m]`, e −1024..−1, m non-zero, not divisible by 10 | RFC 8949 §3.4.4: a two-element array of an integer exponent (major 0/1) and an integer or bignum mantissa — `decimal` otherwise |
| Tag 40 ndarray | 1..8 positive dimensions, product = element count | RFC 8746 §3.1.1: `[shape, data]`, shape an array of unsigned integers "distinct from zero" (any rank, no cap of 8), data an array, a typed array or a homogeneous array (tag 41) whose element count is the product — `ndarray` otherwise (tag 1040 stays an opaque tag, as today) |
| Little-endian float typed arrays (84–86) | no NaN element | any element |
| Tag 55799 | — (not in the set) | anywhere, any depth (§3.4.6 imposes no nesting rule) |
| Bignum content (tags 2, 3) | 9..`maxBignumBytes` bytes, no leading zero | deterministic: the same (preferred serialization, §3.4.3); `PF_VALID`: 0..`maxBignumBytes` bytes, leading zeros allowed |

At levels 1–3 the order of checks for tags 4 and 40 is: a byte is left
(`truncated`), the content is an array (else the tag's code), the array is
walked as an item, it holds exactly two items (else the tag's code), then the
rule; at level 0 Bindle's order (`0x82` first) stays. Under `PF_VALID`, `f8 xx`
with xx < 32 is `malformed` (Appendix F). Nothing else changes for the Bindle
preset: every 3sln.me vector keeps its code. Hosts build `Decimal`/`NDArray` only from content inside those classes'
invariants and a `Tagged` otherwise (D267).

### 19.7 Sessions: handles, streams, push, sequences (D266, D283)

The session (§17) walks valid CBOR natively in its frames; what it takes
whole goes through the canonical path of §19.5. As implemented (D283):

* **The valid machinery** runs when the step is given its buffers
  (`vms-step-v`: `vs` the scanner's options array and scratch, `cb` the
  canonical buffer) and the run is a valid-CBOR run (`PF_VREL`, vm-setup's
  translation of `PF_VALID`) or admits keys of any kind (EC-sensitive keys,
  D263). A buffer that is too small suspends the step with `VMS_GROW`
  (`vms-grow-words`/`-bytes`/`-scratch`/`-arena`): the host grows it — S and
  the key arena keeping their contents — and steps again over the same
  window. `vms-step-x` (no buffers) walks as before P8.4.
* **Heads** in frames (strings, containers, tags) may be non-shortest.
* **Indefinite arrays and maps** are frames (`F_IND`; their count is a bound
  far above any real one until the break sets it): before each entry the
  frame reads one byte, in the scanner's order — the end of input there is
  `truncated` before any visit, a break ends the frame, the entry bound is
  `too_many_entries` at the container; a break in a map's value position is
  the value's own `malformed`. The prescans (D091) treat an indefinite string,
  array or map as a level its break closes.
* **Whole items** (`vitem`): the scanner checks the item over the window
  first (asking for more window, one byte past what it holds, while it may be
  truncated by the window's end — an item is walked in the feed that completes
  it). An item the scanner accepts as its own DC form, with no marked map and
  no embedded content to canonicalise (FL_EMBED), is walked in place by the
  buffer walk; any other — refused ones included, and every refused item whose
  bounds pass the window — is walked over its canonical copy with its events,
  exactly as the buffer driver's canonical path walks it, its offsets mapped
  back to the window. Under the deterministic profiles (keys of any kind) an
  item without an EC-sensitive key is walked in place, refused or not, as the
  buffer driver's attempt walks it. Indefinite strings, malformed heads, and
  the tags whose rules read their content (bignums, 4, 40, typed arrays, 0, 24,
  32) are always whole. So a session's out array is a function of the input
  alone, and equals the buffer driver's.
* **Map frames** take each key whole (asked for whole: no key crosses a
  window under the valid machinery), check it as a whole item, and keep its DC
  form (the window's bytes when clean, else its canonical copy's) in the key
  arena with a 12-byte header (DC length, key offset, canonical flag) for the
  open map. The key's search, cursors (restarted when a key sorts at or below
  the previous one), evaluation, key-order charge (`ceil(min/8)` on the DC
  forms) and immediate refusals (two canonical neighbours equal:
  `duplicate_key`; descending under a deterministic profile: `key_order`) are
  the walk over a copy's. A map with a key that is not canonical or is
  EC-sensitive, or with canonical keys out of order, is marked; at its end the
  deferred check of §19.4 runs over the kept keys (the scanner's records and EC
  forms) and charges its units at the map before the map's end-run (D277).
  Memory: the keys of the open maps (≤ the message, plus 12 bytes a key), the
  price of duplicate detection on a stream (§5.6).
* **The resumable scanner** (`rscan`) stays deterministic/Bindle: a valid-CBOR
  handle, or one that meets an EC-sensitive key, answers `scratch`, and hosts
  run profile-only streams under `PF_VALID` or any-key profiles on the session
  against `any`.
* **Sequences** (§18, D210–D219): a message is still one root; an indefinite
  root ends at its break; sequence sessions step with `vms-step-v`.

### 19.8 Hosts (D267)

`wire: 'valid'` is the default in JS (`profiles.valid`) and Rust
(`Profile::VALID`, the `Default` of every options struct);
`'deterministic'` and `'bindle'` select the checking presets. `encode`, the
Writer and Rust `encode` write deterministic bytes under every preset (the
`valid` preset encodes as `deterministic`). Decoded values: maps keep wire
order (canonical copies keep it); a `Decimal` only for tag-4 content inside
`Decimal`'s invariants and an `NDArray` only for tag-40 content inside
`NDArray`'s (else `Tagged(4, [e, m])`, `Tagged(40, [shape, data])`); a bignum with leading zeros decodes to its integer; a NaN's
payload is not kept by a JS number (a View's `raw()` keeps the bytes).

### 19.9 Gates, vectors and the differential (D268)

Gates that hold deterministic input name their preset explicitly
(`wire: 'deterministic'` / flags 122, or Bindle 0) and keep every expectation;
none is weakened. New: RFC 8949 Appendix A in full (every row, including all
non-deterministic encodings: `fa7fc00000`, `fb7ff8000000000000`, the
`f9`/`fa`/`fb` infinities, the indefinite strings, arrays and maps), plus
every Appendix F example (each with its code under every preset), duplicate
keys by value (`{1, 1801}`, `{"a", 7f6161ff}`, `{0.0, -0.0}`, NaN keys of two
widths, maps as keys in two orders), and the rank-9 cases; a **canonical
equivalence** property (random values; every non-canonical variant —
indefinite splits, widened heads and floats, permuted keys, nested — decodes
and validates under `valid` exactly as its canonical encoding, and is refused
under `deterministic` with the documented code); a **differential against
cbor2 2.4.1's default (non-CDE) decoder** with every difference classified;
JS == Rust at kin level and through the hosts; session == buffer under
`valid` (vmsession-test, sequence-test); oracle agreement unchanged.

### 19.10 The deterministic-only fast path (D269)

The attempt (§19.3) *is* a deterministic-only fast path for the VM; the
alternative is a VM that walks non-deterministic input natively. D269 records
the measurement: `valid` against `deterministic` on the standard inputs
(bench/README.md) and the canonical path's cost on their non-deterministic
variants, and keeps the split only if the native alternative would be
measurably slower on deterministic input. The deterministic *checking*
option stays regardless (dCBOR, CTAP2 and signing protocols need it).

---

## 20. PEG group semantics (D270–D280) — design revision 3, 2026-11-04, provisional; cut default amended 2026-11-10 (D301)

D270 moves group matching in arrays and maps from the exact regular /
existential semantics of §4.3–§4.4 (D010–D012, D035, D036) to the parsing
expression grammar (PEG) semantics of RFC 8610 Appendix A. D271 asked for
two cut readings. Revision 1 of this section (cd7c33c) was reviewed
independently by a Claude reviewer (`docs/reviews/2026-11-04-peg-claude.md`,
"C#") and by Codex (`docs/reviews/2026-11-04-peg-codex.md`, "X#").

Revision 2 (d4dd863) answered every finding and was re-reviewed by Codex
(`docs/reviews/2026-11-04-peg-rereview.md`, "N#"). Revision 3 answers N1–N9:
summed activation bounds and a chunk heap for recursive frames, demand
growth with a cap and session relocation, sorted T traversal, FAIL events,
and refusal replay on the canonical path (D280). §20.14 holds the full
disposition. Revision 2 also applied the manager's decisions of 2026-11-04:

* the reference cut mode becomes "rule A";
* the T tier sorts its own records;
* the group arena is sized from the limits and grown on demand;
* memo cells are reserved, not shipped;
* only proven complexity bounds are stated.

> **Note (2026-11-10, D301; supersedes the default in D271/D273).** The owner
> decided that the **default cut semantics is the literal RFC 8610 reading**:
> the mode below called `rfc` (commitment epochs; a cut failure fails the
> whole map type, R19). Rule A remains available as the non-default option,
> **renamed from `reference` to `cuts: 'branch'`** (the failure scope is the
> choice branch). `reference` is not accepted as an alias: snug is
> pre-release, and an unknown mode is an option error on every host. The
> option names in this section were renamed in place; the review records
> (§20.14, `docs/reviews/`) keep the names they were written with. In kin's
> option word 20 and in FLAGS bit 5 (`CUTS_BRANCH`), 0 is `rfc` and 1 is
> `branch`, so an absent option is the default; SOURCE_KEY always carries
> the effective mode. Consequence: the discriminated-union idiom
> `{kind: "a", x: int // kind: "b", y: tstr}` rejects `{kind: "b", y: "z"}`
> by default, because `kind:` implies a cut that the first alternative
> commits to. Write a type choice of maps or `=>` discriminators instead
> ([guide](guide.md#discriminated-unions-under-the-rfc-cut)); warning W8
> (§20.11) flags the idiom. No RFC example changes verdict (§20.13).

The decisions are D272–D280, all unsigned. The Program format is in
[program-2.md](program-2.md) (format 2.0, revision 3). Implemented on branch
`p85-peg`: the compiler and verifier (phase 1, D290–D299) and the VM on
every route (phase 2, D310–D320; program-2 §15 lists where the build fills in
or departs from the draft: block layouts, the T comparator, −5 growth,
session gates, the kept streaks). §4.1–§4.2 (type-set evaluation of single items) are unchanged.
This section supersedes §4.3, §4.4, the group parts of §5.1 steps 4–5, and
the D011/D012 refusals once it lands.

### 20.1 What the RFCs say

All quotations below are from `corpus/rfc/rfc8610.txt` (checked by the
2026-11-04 quotation review). RFC 9682 changes nothing here. Its only
grammar changes are escapes, empty files and `#6.<type>` / `#7.<type>`.

* **Appendix A (normative).** "This appendix is normative." For `//`: "The
  two alternatives listed are to be tested in left-to-right order, locking in
  the first successful match and disregarding any further potential matches
  within the choice (but not disabling alternatives in choices containing
  this choice, as a cut (Section 3.5.4) would)." With `A = "a" / "a" "b"`:
  "the second alternative will never match, as any input string starting
  with an "a" will already succeed in the first alternative, locking in the
  match." Occurrences: "the occurrence indicators ("?", "*", "+") are
  "greedy" in PEG, i.e., they consume as much input as they match (and, as a
  consequence, "a* a" in PEG notation or "*a a" in CDDL syntax never can
  match anything ...)". The mapping table lists `/` as "prioritized choice,
  limited to types only".
* **§2.1.** "An array matches a specification given as a group when the
  group matches a sequence of name/value pairs the value parts of which
  exactly match the elements of the array in order." "A map matches a
  specification given as a group when the group matches a sequence of
  name/value pairs such that all of these name/value pairs are present in
  the map and the map has no name/value pair that is not covered by the
  group."
* **§2.2.2** (a generative description): "A group choice matches the union
  of the sets of name/value pair sequences that the alternatives in the
  choice can."
* **§3.2.** "A group entry with an occurrence indicator matches sequences of
  name/value pairs that are composed by concatenating a number of sequences
  that the basic group entry matches, where the number needs to be allowed by
  the occurrence indicator."
* **§3.5.3.** "While the way arrays are matched is fully determined by the
  PEG formalism (see Appendix A), matching is more complicated for maps, as
  maps do not have an inherent order. For each candidate name/value pair that
  the PEG algorithm would try, a matching member is picked out of the entire
  map." For `{ int => int, int => 6 }` against `{3: 5, 4: 6}`: "the first
  group entry might pick off the "3: 5", leaving "4: 6" for matching the
  second one. Or it might pick off "4: 6", leaving nothing for the second
  entry." Writers are "urged to not write pathologically non-deterministic
  specifications".
* **§3.5.4.** Without a cut, `{ "optional-key": "nonsense" }` "does match
  this specification: while the first entry of the group does not match, the
  second one (the wildcard) does." With a cut: "once the member key matches
  the name part of an entry that carries a cut, other potential matches for
  the key of the member that occur in later entries in the group of the map
  are no longer allowed. In other words, when a group entry would pick a
  key/value pair based on just a matching key, it "locks in" the pick -- this
  rule applies, independently of whether the value matches as well, so when
  it does not, the entire map fails to match." `name:` and `value:` keys
  imply the cut.
* **Appendix C (normative).** Type choice: "The choice uses PEG semantics as
  discussed in Appendix A: the first choice that matches wins." Map: "a
  valid CBOR map the key/value pairs of which can be ordered in such a way
  that the resulting sequence matches the group expression". Group: "A group
  matches any sequence of key/value pairs that matches any of the choices
  given (again using PEG semantics)." Occurrence: "it acts as a (possibly
  infinite) group choice that contains choices with the group repeated each
  of the occurrences times." Member keys: "If the memberkey is not given, the
  entry can only be used for matching arrays, not for maps." "A key value
  matches its key type if the key value is a member of the key type, unless
  a cut preceding it in the group applies".
* **§3.11** (precedence example `group2 = (? ab: a / b // cd: c / d)`):
  "Note that the optionality is attached to the first choice ("ab"), not to
  the second choice." So `{cd: 3}` fails under PEG. The empty first
  alternative succeeds, locks in, and leaves `cd` uncovered.

* **Appendix H** (informative) gives the verbose `reputon` (named groups such
  as `conf-value = ( confidence: float16 )` used as `? conf-value`) and says
  "An equivalent, more compact form of this example would be" one that
  writes `? confidence: float16` directly. Together with App. C's rule that a
  rule's semantics "does not change when the name is replaced by its
  (parenthesized if needed) definition", that makes `? (k: v)` and `? k: v`
  equal in every cut mode (D273).

### 20.2 The semantics, exactly (D272, D273)

A group is a tree once names, generics, sockets and unwraps are resolved.
Its nodes are:

* `EMPTY`;
* `FAIL`: the empty group choice, i.e. an unplugged `$$g` (§3.9, S32);
* `SEQ(g₁…gₖ)`;
* `CHOICE(g₁…gₖ)`: `//`, in source order, with `//=` contributions in rule
  order (App. C);
* `REP(lo, hi, g)`: an occurrence indicator, with `?` = 0..1, `*` = 0..∞,
  `+` = 1..∞ and no indicator = 1..1;
* `ENTRY(T)` in array context, or `MEMBER(K, V, cut)` in map context;
* `CALL(r)`: a recursive group reference.

Unwrap `~` of a map or array inlines its group, and a type choice of
containers unwraps to a group choice in rule order. Unwrap of a tag (§3.7:
"type (for tags)") yields an `ENTRY` of the tag's content type (X14,
R17).

**Counts.** A minimum ≥ 2^24 is stored as 2^24. Consumption can never reach
that count (entries ≤ 2^24 − 1), so such a minimum is met only through the
zero-length rule; it is never lowered to `FAIL` (X7). A maximum ≥ 2^24 is
∞. `0*0 g` is `EMPTY`.

Type choices `/` stay inside the types T, K and V. App. A makes them
prioritised, but prioritising cannot change whether one item matches, so
set-based evaluation (D010) stays exact for types.

**Arrays.** `run(g, i)` returns an index j ≥ i or `fail`. The elements are
`e₀…e_{n−1}`.

```
run(EMPTY, i)        = i
run(FAIL, i)         = fail
run(ENTRY(T), i)     = i + 1 if i < n and eᵢ ∈ T, else fail
run(SEQ(g₁…gₖ), i)   = thread i through g₁…gₖ; fail at the first fail
run(CHOICE(g₁…gₖ),i) = run(gₘ, i) for the least m whose run does not fail; else fail
run(REP(lo,hi,g), i) = c := 0, p := i
                       while c < hi:
                         q := run(g, p)
                         if q = fail: break
                         if q = p: c := hi; break      -- zero-length success (R4)
                         p := q; c := c + 1
                       return p if c ≥ lo, else fail
run(CALL(r), i)      = run(body(r), i)
array matches        ⇔ run(root, 0) = n
```

Nothing is retried after a node returns. A choice keeps the alternative it
returned with, a repetition keeps its count, and the final `= n` test does
not re-enter the root. Member keys in arrays are labels, and cuts have no
effect in arrays: §3.5.4 is about maps.

**Maps.** The state R is the set of pairs not yet consumed. Pairs are taken
in **pick order**: ascending bytewise order of the keys' EC forms (§19.2).
For every key with no float zero, NaN or map inside it, the EC form is its
RFC 8949 §4.2.1 deterministic encoding. Pick order therefore depends on the
map's value, not on its serialisation (R8). `run(g, R)` returns a new set
R′ ⊆ R or a failure. There are three failure kinds:

* `fail`, the ordinary kind;
* `cut`, in the `branch` mode (rule A) only;
* `fail!`, in the rfc mode only.

```
run(MEMBER(K, V, cut) with occurrence lo..hi, R):
    c := 0; R′ := R
    for p in R in pick order:
        if c = hi: break
        if key(p) ∉ K: continue
        [rfc] if cut: commits := commits + 1                    -- the key matched
        if value(p) ∈ V: R′ := R′ − {p}; c := c + 1             -- consume
        elif cut: return cut [branch] | fail! [rfc]             -- §3.5.4
        -- no cut: skip; p stays for later entries (§3.5.4, first example)
    return R′ if c ≥ lo, else fail
run(SEQ(g₁…gₖ), R)    = thread R; the first failure (of any kind) is the result
run(CHOICE(g₁…gₖ), R) = saw := false
                        for m in 1..k:
                           c₀ := commits; r := run(gₘ, R)  -- a failed gₘ's consumption is undone
                           if r is a set: return r          -- locked in
                           [rfc] if r = fail! or commits > c₀: return fail!
                           [branch] if r = cut: saw := true
                        return cut if saw, else fail
run(REP(lo,hi,g), R)  = iterate as for arrays on sets; a failed iteration is undone;
                        "zero-length" means "consumed nothing";
                        an iteration returning cut → return cut       [branch]
                        an iteration returning fail!, or failing with
                          commits > its c₀ (taken at the iteration's start) → fail!   [rfc]
                        otherwise a failed iteration ends the repetition
run(EMPTY/FAIL/CALL)  as for arrays
map matches           ⇔ run(root, all pairs) is the empty set   -- closed (§2.1)
```

**Cut modes (D273; default and names D301).**

* **`cuts: 'branch'` (not the default since D301) is "rule A".** When a cut member meets a
  remaining pair whose key matches and whose value does not, before reaching
  its maximum, it returns `cut`. `SEQ` and `REP` pass `cut` through, so an
  enclosing `?(…)` or `*(…)` cannot recover by matching fewer times. Only a
  `CHOICE` absorbs it: the choice tries its next alternative, and raises
  `cut` again if none succeeds. At the root, `cut` fails the map.
  * This keeps D021's purpose: `{kind: "a", … // kind: "b", …}` works, and
    so does the D271 case.
  * It honours §3.5.4's "later entries … are no longer allowed" through
    `?`, `*` and named groups. An explicit `//` can still absorb the cut,
    and a later wildcard can then take the key:
    `{(a: int) // (), * tstr => any}` accepts `{a: "x"}` while
    `{? a: int, * tstr => any}` rejects it. So rule A deliberately does not
    follow App. C's literal "occurrence acts as a group choice" expansion
    when cuts are involved (R9, N9).
  * It is invariant under replacing a group name by its definition, so the
    verbose and compact `reputon` of App. H mean the same (C1).
  * It is not what Ruby does, nor what format 1's DNF did: they let a group
    repetition absorb the failure. That is deviation class RC (§20.4).
  * It was called `reference` until D301 renamed it `branch` (it names
    D021's reading, not the reference tools' behaviour).
* **`cuts: 'rfc'` (the default, D301) is commitment epochs (X9).** Each CHOICE alternative
  attempt and each REP iteration attempt records `commits` at its start. A
  cut member's key match increments `commits`. An attempt that fails after
  `commits` grew returns `fail!`, and `fail!` passes through everything to
  the root of the map's group. A cut member's value mismatch is `fail!` at
  once.
  * A fresh iteration that sees no cut can still end its repetition
    normally: `{* (a: int)}` accepts `{a: 1}`.
  * A later failure of an enclosing alternative still sees the cuts matched
    inside it, even in sub-attempts that succeeded.
  * The scope is the map type (R19). An enclosing *type* choice `{…} / {…}`
    and an enclosing EMBED are outside it.
  * These lifetime rules are snug's formalisation. They are consistent with
    §3.5.4 and App. A, but they are not settled RFC text.
  * A discriminated union written as one map with a group choice,
    `{kind: "a", x: int // kind: "b", y: tstr}`, rejects `{kind: "b", y: "z"}`:
    the first alternative's `kind:` matches the key, its value fails, and
    that is `fail!`. A *successful* cut commits too: `{id: tstr, token: tstr
    // id: tstr}` rejects `{id: "a"}`. The working forms are a type choice of
    maps, `{kind: "a", x: int} / {kind: "b", y: tstr}` (each map is its own
    fail scope, R19), or cut-free discriminators, `{"kind" => "a", x: int //
    "kind" => "b", y: tstr}`. Warning W8 flags the idiom (§20.11).

### 20.3 Ambiguities resolved (D272)

The basis column separates what the RFC text says from what is snug's
policy. A policy choice is labelled as one (X R-audit).

| # | Question | Resolution | Basis |
| --- | --- | --- | --- |
| R1 | Can the end-of-array test make a choice try its next alternative? | No. `[(int) // (int, int)]` rejects `[1, 2]`. | App. A: "locking in the first successful match"; example (2). §2.1's "exactly match" adds the completeness check, not a licence to retry. |
| R2 | Greedy occurrence | The most iterations that succeed, never given back. `[* uint, uint]` matches nothing; `[? uint, 2*3 uint, tstr]` rejects `[1,2,"x"]`. | App. A ("*a a" "never can match anything") |
| R3 | Ranges with min > 1 | Iterate greedily; succeed iff count ≥ min. `[2*3 uint, uint]` rejects `[1,2,3]` and `[1,2]`, and accepts `[1,2,3,4]`. | App. A copies the n*m notation. App. C's "repeated each of the occurrences times" explains the same verdicts; it is not an algorithm. |
| R4 | An iteration that succeeds without consuming | The repetition stops and counts as satisfied, also for minima saturated at 2^24. `[2*2 (? int)]` accepts `[]`. | A terminating extension. Repeating a deterministic empty success gives the same result, so App. C's choice "repeated min times" matches. snug policy for termination and charges; Ruby fails or hangs (RZ). |
| R5 | Group choice in a map: union (§2.2.2) or prioritised (App. A/C)? | Prioritised, locking in; closedness is tested after the root without retry. `{(? a: int) // (b: int)}` rejects `{b: 1}`; the §3.11 `group2` rejects `{cd: 3}`. | App. C "again using PEG semantics" + App. A lock-in. §3.11 only fixes the parse ("optionality is attached to the first choice"); App. A supplies the lock-in (C11). There is a real tension with §2.2.2's "union of the sets", resolved in favour of the normative PEG appendices (X R5). Warning W5. |
| R6 | Does a member consume a pair whose key matches and whose value does not? | Without a cut, no: the pair is skipped and stays for later entries. `{? "optional-key" => int, * tstr => any}` accepts `{"optional-key": "nonsense"}`. | §3.5.4's first example, verbatim; §3.5.3 "a *matching* member". Ruby deviates (RL, RK). |
| R7 | How much does a member take? | Every remaining matching pair, up to its maximum (greedy). A 1..1 member takes one. | App. A greed; §3.5.3's "tends to consume all matches" is supporting text only (X R7) |
| R8 | Which pairs does a member with a finite maximum take when more match? | The first in pick order (EC key order). `{int => int, int => 6}` accepts `{3:5, 4:6}` however encoded, and rejects `{3:6, 4:5}`. | **snug policy (D274).** §3.5.3 calls the pick "indeterminate, but does matter". EC order makes it determinate and independent of serialisation (§2.2.3). Warning W6 flags such members. |
| R9 | What does a failed cut kill? | rfc (the default, D301): the map type; branch (rule A): the innermost enclosing choice alternative, else the map. A successful cut does not commit under rule A: `{(a: int, b: int) // (* tstr => any)}` accepts `{a: 1}`. | D273. Rule A deviates deliberately from App. A ("choices containing this choice") and from App. C's occurrence-as-choice expansion: `(a: int) // ()` absorbs a cut where `? a: int` does not. App. H transparency selects neither mode uniquely (N9). |
| R10 | Does a cut reach back to earlier entries? | No: earlier entries ran first. `{* tstr => any, ? a: int}` accepts `{a: "x"}`; `{* tstr => any, "a" => int}` matches no map at all (C12). | §3.5.4 "later entries"; App. A greed. Warnings W1, W2. |
| R11 | Cuts on key types (`tstr ^=> uint`) | Allowed: the same rule for each pair examined. In rfc mode every matching key commits (C14). | App. C memberkey has no restriction. Byte/float key handling follows the actual key representation (§19), not a text/integer optimisation. |
| R12 | `* (a: int, b: int)` in a map | Both pairs or neither; a failed iteration is undone. `{a: 1}` alone is rejected. | §3.2. Ruby leaks the consumption (RI). |
| R13 | The same literal key twice in one sequence | Legal. The second member sees the pair only if the first did not take it. | App. C. Distinct *data* keys (§3.2) are a different matter. |
| R14 | Unplugged group socket | `FAIL`: `{a: int, $$x}` matches nothing; `{a: int, * $$x}` = `{a: int}`. | §3.9 "the choice is empty" (S32) |
| R15 | Does App. C's "can be ordered in such a way" make maps existential? | No: the PEG picks members from the whole map in pick order. | **Policy resolving a real tension** (C6, X R15). App. C literally reads existentially; §3.5.3 explicitly allows an unsuccessful pick in its pathological example, which supports implementation-defined picking over mandatory permutation search. The two differ only for order-sensitive groups (W6). |
| R16 | Recursion | Guarded group recursion is allowed. **Left recursion** is refused, as a snug termination policy, not RFC text (X R16). A conservative check may also refuse unreachable left-recursive branches. Growing generic recursion is refused by the compile budget before lowering (C13). | App. C allows names in their own rules |
| R17 | `~`, `&`, `.cborseq` | `~` inlines a map or array group. A choice of containers unwraps to a group choice in rule order (a lowering rule, not §3.7 text). `~` of a tag gives the tag's content type (X14). `&` is a value set, occurrences ignored. `.cborseq` is a virtual array (D040). | §3.7, App. C, §3.8.4 |
| R18 | A keyless type entry in a map | Refused (`map_key`) after resolving names and unwraps; `{g}` with `g = (a: int)` stays valid. | App. C |
| R19 | Scope of an rfc cut | The map type. An enclosing type choice or EMBED is outside it. | §3.5.4 "the entire map fails to match"; App. A "choices containing this choice" (C14) |

### 20.4 What the Ruby reference tool does

The probes live in `.cache/peg/` and are not committed:

* `proto.mjs` is a scratch PEG interpreter derived from the existing
  oracle's parser. It has known gaps, such as no tag unwrap (X14).
* `probes*.mjs` and `table.mjs` generate the table in §20.15.

Tools: Ruby `cddl` 0.12.14, with rc 0 for valid, 1 for invalid and 65 for a
*parse error*, which is not a refusal; cddl-rs 0.10.7 (`--ci`, secondary
evidence); and snug as of the working tree.

Of 117 cases, **Ruby agrees with §20.2 (rule A, now `cuts: 'branch'`) on 88**. The 29
disagreements fall into eight classes, all explained by Ruby's source
(`map_check`, `validate_forward`):

| Class | Ruby behaviour | Cases | snug |
| --- | --- | --- | --- |
| RC | A group repetition (`?(…)`, `*(…)`) absorbs a member's cut failure, so the verbose and compact App. H forms differ | H01 (vs H02), M18, M19, N01, N02, N06, R07 | rule A (D273). Evidence: App. H calls the two forms "equivalent" |
| RL | Every literal-key member acts as a cut, even `=>` and `?`. It also looks keys up in the whole map, including pairs already consumed | M01, M05, M22, M34, R02 | §3.5.4, whose first example is exactly M01 |
| RK | A non-literal member fails on a key match with a wrong value | M15, M16, N08, F01 ×2 | §3.5.3 |
| RI | A failed group iteration keeps what it consumed | M07, M08, M30 | undo (R12) |
| RZ | A zero-length iteration fails the minimum; an empty-matching array body loops until killed | A09 ×2, A10, M14 ×2 | R4 |
| RR | Group recursion in arrays rejects valid data | A17, A18 | R16 |
| RO | Picks in wire order | M06 (unsorted encoding) | EC order (R8) |
| RX | `.cborseq` gives a parse error (rc 65) | F04 | no evidence either way |

In more detail:

* **Arrays:** Ruby is PEG with prioritised choice, greedy occurrence and no
  retry (R1–R3).
* **Maps:** Ruby's choices lock in (M10, M11, F05, F08).
* **cddl-rs** deviates more widely and is not used as a semantic witness.
* **Votes:** no RFC conclusion is drawn from tool votes. The table records
  evidence; RFC expectations, snug policy and tool observations are kept
  apart in the corpus (§20.12).

### 20.5 Evaluation: bytes read once, a PEG over verdicts (D275)

Every driver still reads each byte once, in the existing walk. What changes
is what a container does with its children's results.

**Arrays.** Each ARRAY leaf has two parts.

1. **A query automaton** decides what each element is evaluated against.
   It is the Glushkov automaton of the group with priorities and counts
   relaxed:
   * positions are the `ENTRY` nodes;
   * `REP(lo, hi, g)` adds g's loop edges when hi ≥ 2 and makes g skippable
     when lo = 0;
   * `CHOICE` is a union;
   * a `CALL` is approximated context-insensitively. nullable, first and
     last are least fixed points; every call site gets the callee's first
     positions and a bypass when the callee is nullable; every callee-last
     position follows into every call site's follow set.

   Element i is evaluated **once**, against the union of the typesets of
   its candidate positions Cᵢ. This is format 1's step without counters.

   **Superset lemma** (C15, X15; both reviewers proved it). If the PEG tests
   element i against position p, then p ∈ Cᵢ. *Proof sketch:* drop the
   undone speculation and follow the active path from the root to the test.
   Its first i successful `ENTRY` matches spell the input prefix. Relaxing
   choices admits the selected alternative, dropping finite counts admits
   the actual repetition count, and erasing the call stack admits every
   finite call/return path. Induction on the prefix then gives the result.

   The lemma rests on lowering obligations. Distinct generic instantiations
   must get distinct typesets (`g<uint>` must not share an `ENTRY` with
   `g<tstr>`). Unwrapped choices and `~tag` are lowered before the
   construction. `.cborseq` content has its own root, first set and EOF.
   Test builds assert the lemma on every `ENTRY` test.
2. **A verdict record** per element: rᵢ = {p ∈ Cᵢ : eᵢ matched
   typeset(p)}. It is W = ⌈npos/32⌉ words, and equals format 1's A′, the
   next automaton state. The PEG's test of `ENTRY(p)` at i reads bit p of
   rᵢ. The PEG never touches bytes.

**The PEG machine** (program-2 §5) runs `run(root, 0)` over the records,
incrementally:

* After rᵢ is stored, the machine runs until it asks for r_{i+1} or
  terminates.
* At the array's end it is told the input ended and finishes. The leaf
  matches iff the result is n.
* A root success at e ≤ i, a failure, or rᵢ = ∅ kills the block at element
  i. For rᵢ = ∅ the machine is first run to termination, which produces the
  witness, and those steps are charged at that element (C16).

**Storage tiers** come from syntactic lengths `ml`, with `ml(FAIL) = 0` and
`0·∞ = 0`, and the failing-prefix bound `FL` (program-2 §3.2). B is the
maximum FL over the backtrack attempts: every REP child attempt and every
non-last CHOICE alternative.

**Read-bound lemma** (C2, X16). An attempt of g started at index s reads no
record past s + ml(g), and no record past s + FL(g) if it fails. So B + 1
ring rows suffice. Both bounds are syntactic. Revision 1 left maxlen
undefined; a semantic maxlen (0 for a body that can never succeed) breaks
the bound: C2's `[* ((int, int, ? (int, int, int, $$g), tstr) // int)]`.
B is a safe upper bound, not the minimal storage (X16).

| Tier | Condition | Storage | Examples |
| --- | --- | --- | --- |
| A0 | B = 0 | no stored record | `[* T]`, `[a, b, ? c]`, `[* uint, uint]`, `[? uint, 2*3 uint, tstr]` |
| A1 | 0 < B < ∞ and (B+1)·W ≤ the ring limit | a ring in the block | `[* (k, v)]` (B = 1) |
| A2 | anything else, including recursion | group arena records | `[(* int, tstr) // (* int)]` |

The syntactic census of the corpus, `tiers.mjs`, found 799 A0, 25 A1, 0 A2
and 1 recursive array.

**No memoisation in 2.0** (D275; C8, X8, X10). Memo cells and link cells
are withdrawn. The Program field is reserved and must be 0, and a later
minor may define it only together with EOF sentinel rows and a loader
capability rule (program-2 §1). §20.7 states what is proven instead.

**Recursive activations** (X1, N2). A recursive program keeps every frame
of every activation in its own linked list of 64-word chunks from the
arena's chunk heap, behind a 3-word activation record pushed by `CALL`
(program-2 §5.3). Non-recursive programs use the static block stack. Left
recursion is refused, so live activations are at most
(consumed + 1)·n_calls per block.

**Maps.** A pair is still evaluated once:

* **Key id.** Binary search over the whole key table once keys stop
  arriving in ascending order, which is the case for §19's unsorted input
  (X3). Format 1's ascending-only search and naming cursor are used only
  while keys ascend; once unordered, the naming record is found by binary
  search too.
* **Key test.** The key is evaluated against `key_ts`, the union of the
  non-literal members' key typesets.
* **Value test.** The value is evaluated against the value typesets of the
  members whose key matched.

**Normalisation** is the exact fold table of program-2 §3.3 (C3, X6). For
example, `REP(lo,hi,MEMBER(1,1))` becomes `MEMBER(lo,hi)`, and
`{2*2 (+ tstr => int)}` becomes `SEQ(MEMBER(1,∞), FAIL)`, which matches
nothing. Under rule A every fold holds with cuts too, which revision 1's
mode could not offer.

**Map tiers:**

* **F (flat).** The normalised root is a sequence of members with no
  order-sensitive member (a non-literal key with a finite maximum).
  * F is a pair-major pass. Each pair walks the members in source order. At
    the first member whose key and value match and which has room, the pair
    is taken and the walk **stops** (C7: `{* tstr => int, ? "a" ^=> tstr}`
    accepts `{a: 1}`).
  * A key-matching cut member before the taker that rejects the value
    records a cut event.
  * At the end, the first member in source order with a cut event or count
    < min fails.
  * Equivalence with the entry-major PEG: both reviewers proved it for
    verdicts under these conditions (X17).
* **S (slots).** Every non-literal member is class R: at the root, with an
  unbounded maximum.
  * A pair with an unnamed key runs the F walk over the class-R members at
    arrival. Each member keeps `ucount`, `ukey` and its first cut
    violation.
  * A pair with a named key writes its slot.
  * At the end the machine runs the root. A class-R member first imports
    its saved unnamed state, then takes the matching unconsumed slots at
    its source position (X12: `{+ tstr => int, ? (a: int)}` accepts
    `{z: 1}`).
  * Slots are not consumed before the group runs (X17). So
    `{* tstr => any, ?(a: int, b: int)}` accepts `{a: "x"}`, while
    `{* tstr => any, (a: int // b: int)}` rejects `{a: 1}`. Both are
    regression tests.
* **T (table).** Everything else. One record per pair goes in the arena.
  * At the end, if the map was unordered or had an EC-sensitive key, the
    machine **sorts its own records** by EC key comparison, whatever its
    members (N4). Cut traversal and failure scores therefore always follow
    pick order. This is a heap sort, charged per
    comparison identically on every route, and independent of §19.4's
    permutation (C4).
  * The machine then runs over the records with an undo trail.

The census found 61 F, 37 S and 26 T. The published T cases are F once
normalised.

**Fail-fast.** A pair that no member can take dooms the map in every mode
and tier (X Q14: a sufficient test, not a necessary one). The block dies at
that pair. Profile validation continues as usual (D023).

### 20.6 Charging, refusal order and resources (D276, D277, D280)

**One logical event order on every route** (X4, program-2 §10). The buffer
walk, the canonical-copy walk (§19.3) and the framed session charge the same
events in the same order:

* **Per item:** format 1's order up to the candidates' typeset tests, then
  the record or slot store, then the machine's steps until it suspends or
  its block dies.
* **At a map's logical end** (after its last value): the deferred duplicate
  check's units (§19.4), the map end row, the T sort, the machine,
  closedness, then the witness trace.
* **At an array's end:** the end row, then the machine.

§19.5 now charges the duplicate-check units at the map's logical end on
every route. P8.4 agreed to D277 and amended §19.5 in 531220f, so X4's
valid-input example is closed (N9).

**Refusals in the same order (D280, N6; owned with P8.4).** D277 deferred
only units. On the canonical path the scanner still refuses before the VM
runs, while a framed session may first spend its budget on earlier schema
work. N6 shows this with `9f00a3020001000200ff` under `r=[uint,{* int=>int}]`.
D280 extends §19.5's own embedded-table rule ("reports the recorded refusal
where its own walk would have found one") to the outer item:

1. When the scanner refuses, it records the refusal: its code, its input
   offset, and its **logical event**. That is the head of the refused item,
   or the end of the map for a deferred duplicate check, or the break /
   end-of-input position.
2. The copy writer builds the canonical copy of the valid prefix, up to that
   event.
3. The VM walks the prefix as usual. That includes profile-only
   continuation after a schema failure (D023), and stopping on `budget`
   (§4.5 / program.md §17 Q17). When the walk reaches the recorded event,
   it reports the recorded refusal.

So `budget` wins exactly when the budget runs out before the event, as in
the session, and a profile refusal wins over an earlier schema failure, as
everywhere. The same applies to embedded content (unchanged) and to
sequence messages. This needs P8.4's agreement and a §19.5 amendment; the
manager is coordinating it.

**Prices** are bounded-work charges, not an equal-CPU claim, until the
implemented paths are measured with D241's method (X Q12):

* a stored record costs ⌈R/16⌉;
* a PEG step costs 1. A step is a node entry, a rewind, a record examined
  in T (consumed or not), or a chunk link or unlink (program-2 §5.3);
* a trail entry costs 1;
* a T sort comparison costs ⌈min len/8⌉.

D045 rule 1 also makes the machine steps of `[* T]` free.

**Scratch.** Frames stay closure-sized (R3), with the layouts of program-2
§5.2 and §6.3.

**The group arena** (D276, revised for N1–N3) holds A2/T records, T sort
permutations and trails in an **upward stack**. Recursive activations live
in a **chunk heap** growing downward from the arena's end:

* **Chunks** are fixed-size chunks of 64 words.
* **Per-block lists.** Each recursive block owns a linked list of chunks and
  pushes its frames into its own current chunk.
* **Free list.** A freed chunk goes to a free list. So machines that suspend
  interleaved never need global LIFO order (N2).
* **Chunk addresses** are chunk indices counted from the arena's end. Record
  addresses are offsets from its start. Both stay valid when the arena is
  copied into a larger array, so a session relocates by copying the two
  regions and updating only the end and the heap top (N3).

**Bound (N1).** Activation cost is summed over the simultaneous recursive
leaves of a closure set, as records are, and items are counted by a global
counter `VM_GROUP_ITEMS` that EMBED does not reset. Program-2 §9.4:

```
need ≤ items · (R_ITEM_MAX + ACT_SUM) + (D + 1)·ACT_SUM + 2·maxEntries + chunk slack
```

`ACT_SUM` is the maximum, over closure sets, of the sum of per-item
activation words of their recursive leaves, in whole chunks. `items` ≤ the
input bytes. The compiler evaluates this at the compiled limits and warns
(W7) when it exceeds the default arena cap.

**Growth and caps (N3).** Growth follows demand: the arena doubles from its
lease.

* **Buffer route:** a re-run per doubling. Charges are a pure function of
  the run. CPU ≤ (1 + number of doublings) × one run: ≤ 10 doublings
  (11 runs) at the default cap, ≤ 12 (13 runs) at the 2^24-word hard cap,
  from the default 4 096-word lease. EXT predicates may be called again on
  a re-run (they must be pure, D140).
* **Session route:** `VMS_GROW` with the relocation above, no re-run.

The arena never exceeds its **cap**: the explicit `groupWords` limit if one
is given, else `LIM_GROUP_WORDS`. That defaults to 2^22 words (16 MiB) and
is never more than 2^24. It is counted separately from the 64 MiB
Program/pool/scratch cap, with its own hard maximum.

Demand beyond the cap is **`group_limit` (code 44)**:

* a resource outcome, like `budget`;
* never skippable;
* never swallowed by EMBED;
* `budget` wins if both happen on the same event, because the charge comes
  first;
* the offset is the current item's head, or the container head for
  end-runs.

**Rebuttal of "never refuses at defaults" (C5, part):** no finite default
can promise that. N1's twenty-recursive-leaf family needs memory linear in
leaves × items, and N3 shows the loose bound exceeds a Worker. What is
promised instead:

* no refusal below the default cap;
* demand-sized allocation;
* a compile-time warning when a schema's worst case can exceed the cap.

No corpus schema comes near the cap.

### 20.7 Complexity contracts (D279; C10, X10)

Revision 1 claimed O(|G|·(n+1)) PEG work. **That claim is withdrawn**, and
so is D270's "group nodes × elements" bound. The proven contracts are below.
Everything else is bounded by the step budget only, and every step is
charged.

| Part | Contract |
| --- | --- |
| Compile / verify | Charged to the compile and verify budgets. The O(Program words + npos·W·(n_calls+1)) figure plus the fixed-point rounds is a **proof obligation** (N8), not an established bound. |
| Arrays, query and records | Per element O(W·(\|A\|+1) + \|C\|), as format 1 |
| Arrays A0/A1, non-recursive | **Proof obligation** (N8): linear in n for a fixed group: steps ≤ (n + 1)·K(G), where K(G) is finite (sketch below). K(G) can be exponential in nesting depth: X10's `[* ((2*2 (2*2 (… uint))), tstr) // uint)]` gives Ω(n·2^k) with B = 2^k. |
| Arrays A2, recursive | No bound beyond the budget. Rescans are polynomial for fixed non-recursive groups and can be exponential with recursion. |
| Maps F | Per pair O(members); end O(members) |
| Maps S | Per pair O(members); one end-run bounded by a constant K_S(G) independent of n. Slots number n_named, and every successful group iteration consumes a slot. |
| Maps T | No polynomial bound claimed in general; budget-bounded. Since D323 (non-literal members' cursors, program-2 §6.4) X10's `{* (int => int // tstr => tstr)}`, formerly Θ(n²), is the T sort's O(n log n) comparisons plus O(n) steps: no member re-reads a record before its cursor, and only a rewind that gives records back moves a cursor back. Measured: 3,000 pairs 102k units sorted / 223k reversed (was 9.1 M); 30,000 pairs 1.0 M / 2.6 M. |

*Sketch for A0/A1.* Between two successive record requests the machine
works inside a window of B + 1 records. An attempt is fixed by its node, its
start index and its enclosing live chain. Within a window, finitely many of
these can start without a new record, because every rewind abandons an
attempt for good. This is a review item (§20.16 Q3).

### 20.8 Sessions, streaming and sequences

The VM scratch holds everything the PEG needs: records, slots, counters,
rings, the arena and the machine stacks. A session owns its scratch from
start to a terminal state (§17.1). A suspension (`NEED`, `YIELD`,
`VMS_GROW`) therefore keeps all of it without re-reading a byte: a record is
computed from an element's evaluation, never from its bytes.

* **Yielding.** The machine has a safe point after every step, so long
  end-runs yield on the quantum.
* **Charges** never depend on where windows end.
* **Drain mode** (D144) holds the PEG verdict like any schema verdict.
* **Sequence mode** resets the arena tops per message.
* **§19.3's discarded attempt** discards its records along with the rest of
  its state.
* **T sort keys.** In a forward-only stream, the T sort compares only the
  key forms §19.7 already keeps for the duplicate check. No tier needs any
  byte after it has passed.

### 20.9 Witnesses (D278, amends D024)

Witnesses are a function of the semantics. They are the same in every tier
and on every route. Program-2 §8 makes this operational.

**Arrays.** The farthest failure event is reported (a `FAIL` node at
index i is event E4: `unexpected` at `INDEX i` when i < n, else `missing`;
N5):

* E1: an `ENTRY` failed at i < n.
* E2: an `ENTRY` was tested at n (end of input).
* E3: the root succeeded at e < n.

Ties go to the first event in run order. E2 is `missing` and E3 is
`unexpected`, each with an extra `INDEX` segment. E1 reports the element's
own deep witness when rᵢ = ∅; otherwise it reports `type` at `INDEX i`.

**Maps.** Witnesses are found at two points.

1. **At a pair, every tier:** the first unacceptable pair in wire order. Its
   witness follows format 1's rule 3.
2. **At the end:** a failure trace with explicit metadata (X12).
   * Each `MEMBER` failure records a score, the trail length *before
     undo*, plus its kind, member and pair.
   * A frame keeps the best score among its failed sub-attempts; ties go
     to the earlier one.
   * `SEQ` passes up its failing child's event, `CHOICE` its best event, a
     `REP` below its minimum its failing iteration's event, and `cut` or
     `fail!` the event that raised it.
   * A cut is reported as `value` at the **diagnostic pair**: the
     cut-violating pair with the smallest wire index in the member's scope
     (X5, C8). The scope is the pairs unconsumed at its entry that it would
     examine before reaching its maximum, ignoring violations. F and S keep
     this pair at arrival; T finds it with a charged scan. So
     `{* tstr ^=> int, ? "a" => any, ? "b" => any}` on wire-order
     `{b:"x",a:"y"}` reports `b` in every tier.
   * Leftovers after a root success report the first leftover in wire
     order: `value` if a member's key matched it and that member rejected
     its value, else `unexpected`.
   * A `FAIL` node records an event too (N5), scored at the current trail
     length. A folded `FAIL` carries the member whose repetition it
     replaced, and reports `missing` for it exactly as the unfolded `REP`
     would. An unplugged socket's `FAIL` reports `missing` with no key
     segment.
   * A `CHOICE` that re-raises `cut` passes up its best event (by score),
     like any failing `CHOICE` (N4).
   * T always traverses in pick order. F and S scores do not depend on
     order: F has no choice, and S's choices hold only literal members
     after unbounded root members (program-2 §8).

End-of-map witnesses are shallow (the map path plus one segment). That is
an intentional D024 revision, not the old deep witness. With several leaves,
the block that died last reports, ties to the lowest leaf id.

**Forced-tier gate** (C8; program-2 §8). In a test mode that forces every
map to T and every array to A2, verdict, reason, subcode, path and offset
must equal the natural run on every vm-test case that has sufficient budget
and arena. Only the budget used may differ. Under a tight budget or explicit
arena limit, each mode's `budget`/`group_limit` outcome is gated against
that mode's own charge and allocation schedule (N7).

**Relaxed queries** (C9, X Q15) can degrade nothing in a verdict. They can
add EXT calls, nested evaluations, charges, and resource refusals for
positions the PEG never tests. This is deterministic and documented, and a
resource refusal is never evidence that the PEG rejects. Pruning queries in
A0 is a later, separately versioned optimisation.

### 20.10 EXT, AND/NOT, EMBED, tags

Nothing changes at the type level. An element's verdict for a position is a
typeset test made after the item's combinator pass, so `AND`, `NOT` and EXT
are decided before the record is formed.

* An EXT call depends only on the Program and the input, never on PEG
  decisions. This is the same contract as today.
* `.cborseq` content is a virtual array (D040) with its own PEG and EOF.
* Sub-validations save and restore the arena tops.

### 20.11 Compiler changes, refusals, warnings, fast paths (D275, D278)

**Removed:**

* the map normal form: DNF alternatives, the top-level `//` split, and
  dropping unsatisfiable alternatives;
* factors and pools;
* the determinism rule and every overlap test;
* array counters and unrolling;
* the alternatives limit.

**Added:**

* PEG lowering;
* the fold table;
* the relaxed automaton, including its `CALL` fixed points;
* the analyses: syntactic lengths, FL and B, `depth`, `n_calls`, map tier,
  order-sensitivity and the S slot layout;
* the left-recursion check.

The verifier recomputes every one of these (program-2 §3.1).

**Refusals that remain:**

* left recursion (`group_recursion`);
* a keyless type entry in a map (`map_key`);
* growing generic recursion (compile budget, before lowering);
* compile limits.

**Withdrawn:** `map_overlap`, `map_group_occurrence`, `map_cut`, the
counter and unrolling position refusals, and the non-tail `group_recursion`
refusal.

**Compile warnings** (C12, X Q16). Warnings never refuse a schema. Each
analysis is conservative and cheap: subsumption is proved only between
identical typesets, `any`, or a literal tested with the VM.

| Code | Warns when | Example |
| --- | --- | --- |
| W1 | A required member can never match: an earlier unbounded member with an `any` value already takes its key domain | `{* tstr => any, "a" => int}` |
| W2 | The same, for an optional member (an ineffective constraint) | `{* tstr => any, ? a: int}` |
| W3 | A greedy unbounded repetition is followed directly by a required entry whose type it subsumes | `[* uint, uint]`, `[* any, int]` |
| W4 | `REP(lo ≥ 2)` wraps a body that consumes all it matches | `{2*3 (+ tstr => int)}`, `[2*3 (+ uint)]` |
| W5 | A choice alternative follows one that cannot fail | `{(? a: int) // (b: int)}`, §3.11's `group2` |
| W6 | Order-sensitive overlapping members (§3.5.3's pathological case) | `{int => int, int => 6}` |
| W7 | The worst-case group arena at the compiled limits can exceed the arena cap (§20.6) | the twenty-recursive-leaf family of N1 |
| W8 | (D301; default `rfc` cuts only) A map choice alternative starts with a cut member on the same literal key as an earlier alternative's first member (through a `SEQ`'s first kid, a `REP`'s child and a `CALL`'s target), so the earlier alternative's cut fails the whole map before the later one is reached through that key | `{kind: "a", x: int // kind: "b", y: tstr}`, `{id: tstr, token: tstr // id: tstr}` |

**Fast paths** that survive and are PEG-equivalent (both reviewers agreed
for verdicts):

* `[* T]`: A0, with D045 rule 1 and the array streak (C16).
* Closed structs, and structs followed by absorbing wildcards: F.
* `{* K => V}`: F.

The literal-priority change (`{* tstr => any, "a" => int}`) is not
equivalent, and W1 warns about it.

### 20.12 Oracle and testing (D279; X14)

* **Four kinds of expectation, kept apart in the corpus.** Each case is
  tagged with its basis:
  * `rfc`: the verdict follows from quoted RFC text;
  * `policy`: the verdict follows from a snug resolution (R4, R8, R15, R16,
    rule A), naming the D number;
  * `observed`: a tool's answer, kept as evidence and never as an
    expectation;
  * `invariant`: an execution or resource property (forced-tier equality,
    split invariance, budget and arena boundaries).

  A parse error, a timeout and `unknown` are recorded as such, never as a
  refusal.
* **The independent PEG oracle**, `corpus/tools/peg-oracle.mjs`. A different
  engineer writes it from the RFC and from §20.2–§20.3 only. It is a direct
  recursive interpreter with both cut modes, EC pick order, tag unwrap and
  inherited type semantics. It deliberately does not copy the prototype,
  whose gaps include tag unwrap. It replaces D022's existential oracle.

  The oracle checks *semantics*. It cannot certify tiers, rings, the arena,
  charges or witnesses (X14). Those come from the gates below.
* **Gates:**
  * snug equals the oracle on vm-test cases and on a generator extended
    with group choices, nested and saturated occurrences, zero-length
    bodies, cuts on literal and typeset keys with named diagnostic keys,
    duplicate literal members, and center recursion;
  * **forced-tier equality** of verdict and witness *under sufficient
    resources*; with a tight budget or explicit arena limit, each tier's
    resource outcome is gated against its own charge and allocation
    schedule (N7);
  * **metamorphic encodings**: every valid re-encoding gives the same
    verdict. Witnesses are compared only where the witness rules do not
    depend on wire order: array witnesses, and map `missing` witnesses.
    Pair-attributed map witnesses (the first unacceptable pair, the
    diagnostic cut pair, the first leftover) choose by wire order, so their
    reason, key segment and offset may change with the encoding. On
    `r = {a: int}`, `{a:"x", b:1}` reports `value` at `a` but `{b:1, a:"x"}`
    reports `unexpected` at `*` (N7);
  * **splits**: every split, quantum and `VMS_GROW` point gives the same
    out array;
  * **resource boundaries**: the budget immediately before, at and after
    each charging event, and an explicit arena limit at each allocation, on
    the buffer, canonical and session routes, with EMBED;
  * JS == Rust (and wasm once P7.9c lands).
* **Ruby** stays evidence, triaged by class (§20.4).

### 20.13 Corpus changes and migration (D279)

**Expectations that flip.** The current corpus was run through the
prototype with rule A; the old oracle agreed with every one of the old
expectations. **33 cases flip, all from true to false:**

* **11 PEG-structural flips** (unchanged from revision 1):
  * adversarial A1 ×2: the first choice alternative locks in;
  * C6 `[? uint, 2*3 uint, tstr]`;
  * A3 `[* (int, int), 3*3 uint]` ×3;
  * the embedded backtracking `.cborseq` case;
  * seeded-041 and seeded-049: lock-in;
  * seeded-043;
  * seeded-050.
* **22 rule-A flips** in 14 suites of the shape `{ ? (a: T, b: U), * tstr
  => … }`: seeded-000 ×3, -004, -008 ×2, -012 ×2, -016 ×3, -024, -028 ×3,
  -044, -048, -052, -056 ×3 and -068. Here a present `a` or `b` with a
  wrong value is cut-failed through the `?`. Ruby accepts these (class RC).

Other changes:

* The D271 suite (renamed "literal cut scope (D301 default)", staged as
  `dependsOn: ["D301"]`) is false under the default `rfc` and true under
  `branch`. Suites gain an `options` field where they need `branch`.
* **D301 flips (2026-11-10).** Under the default `rfc` cut, 14 further
  cases flip from true to false (oracle, both modes re-derived): adversarial
  C3/A1 ×2, A1 #2, A1c #3, D021 #0, seeded-008 #1, -012 #1, -020 #1,
  -024 #3, -036 #3, -052 ×2; study "group choice in map //" #1 and
  "dependent members: group choice //" #0. All are a cut matched inside a
  failed `?(…)` group or `//` alternative that still commits. The RFC
  corpus (390 decided cases) changes only the derived D301 case, which now
  agrees with its literal-RFC expectation; no printed RFC example changes
  verdict, and W8 fires on no RFC schema.
* The 26 `snugSchemaError` suites now compile.
* Staged `dependsOn: ["D270"]` cases become gated.

**Migration:**

* **Format 2.0**, with 1.x refused (program-2 §1).
* **Compile options** `cuts` (default `rfc`, D301; `branch` = rule A) and
  `groupWords`, both part of SOURCE_KEY.
* **Corpus additions:**
  * every probe in §20.15, each with its basis tag;
  * App. A and App. H, with the reputon verbose and compact forms on the
    same data;
  * the §3.5.3, §3.5.4 and §3.11 examples;
  * zero-length, saturated-minimum and lock-in cases;
  * C2's FAIL-in-ring case;
  * X1's center recursion and X5's diagnostic-pair case;
  * the S-versus-T regression pair (X17);
  * explicit-arena `group_limit` cases;
  * witness cases for every §20.9 rule.
* **Docs:** superseded notes in §4.3, §4.4 and §6; cddl-support.md;
  conformance.md D012, D036, S28 and D021/S26 re-audited after landing.
* **Order of work:** P8.4, including D280's refusal replay (D277 is done);
  then the PEG oracle; then compiler and format; then the VM buffer driver;
  then sessions; then the corpus; then docs.

### 20.14 Review disposition (revisions 2 and 3)

**A** = accepted with the change shown. **R** = rebutted, with the reason.
**M** = settled by a manager decision of 2026-11-04.

| Finding | Disposition | Where |
| --- | --- | --- |
| C1 BLOCKER: reference cuts break name transparency | A/M: `reference` = rule A; new Ruby class RC with App. H as evidence; 22 extra corpus flips listed | §20.2, §20.4, §20.13, D273 |
| C2 MAJOR: B needs maxlen(FAIL) = 0 | A: syntactic `ml`, `ml(FAIL) = 0`, `0·∞ = 0`; read-bound lemma stated; verifier recomputes | program-2 §3.2, §20.5 |
| C3 MAJOR: F fold false | A: exact fold table, with `SEQ(M, FAIL)` instead of `FAIL` when the member has a cut (keeps `cut`/commit outcomes) | program-2 §3.3 |
| C4 MAJOR: T permutation absent on the canonical path | A/M: T sorts its own records, charged identically on every route | program-2 §6.5 |
| C5 MAJOR: `group_limit` refuses valid data at defaults | A/M: arena bounded by `A_max` from limits and grown on demand; code 44 only under an explicit limit. *Revised in revision 3 (N1, N3): demand growth to a cap; see N3* | program-2 §9.4, §20.6 |
| C6 App. C existential vs R8/R15 | A: R8/R15 labelled policy; tension recorded; W6 | §20.3 |
| C7 F stop-at-taker | A | program-2 §6.2 |
| C8 witness gaps; forced-tier gate | A: score before undo; cut diagnostic predicate; leftover reason for non-literal members; forced-tier mode and gate | program-2 §8, §20.9 |
| C9 relaxed queries degrade witnesses / add EXT calls | A: documented, deterministic | §20.9 |
| C10 T can be Θ(n²) | A: stated; every record examined is charged | §20.7 |
| C11 §3.11 basis misattributed | A: R5 basis corrected; W5 | §20.3 |
| C12 warnings | A: W1–W6 | §20.11 |
| C13 root as CALL target; `0*0`; nullable callees; growing generics | A | program-2 §3, §4; R16 |
| C14 R19 scope; surprises | A: R19 added; M09, M20, M30 and typeset-key commits documented in the table | §20.3, §20.15 |
| C15 superset lemma holds; test assertion | A | §20.5, program-2 §4 |
| C16 charge determinism | A: per-element stepping incl. streaks; a dying block charged at its element | program-2 §5.1 |
| C answers P1–P4 | A: memo reserved; fixed stride Rₜ; no `group_limit` at defaults; key-id → record table kept | program-2 |
| X1 BLOCKER: recursive activation storage | A: all frames of recursive programs live in the arena behind a 3-word activation record; bound `ACT_WORDS` per consumed item. *Revised in revision 3 (N1, N2): per-block chunk lists; `ACT_SUM`* | program-2 §5.3 |
| X2 BLOCKER: 8-word machine state holds 9 fields | A: exact block and frame layouts; formulas derived from them | program-2 §5.2, §6.3 |
| X3 BLOCKER: key lookup assumes ascending keys | A: full-range search and `named` lookup once unordered; 1 unit per probe on every route | program-2 §6.1 |
| X4 BLOCKER: canonical precharge vs session charging | A: one logical order; duplicate-check units charged at the map's end on every route. §19.5 amended by P8.4 in 531220f (D277 agreed); refusal order remains (N6 → D280) | §20.6, program-2 §10 |
| X5 MAJOR: F vs generic cut witness | A: diagnostic pair = smallest wire index in scope; T does a charged scan | program-2 §8 |
| X6 MAJOR: nested occurrence collapse | A: fold table (as C3) | program-2 §3.3 |
| X7 MAJOR: large-minimum rewrite contradicts R4 | A: minima saturate at 2^24 and are not lowered to `FAIL`; `0*0` → `EMPTY`; saturating arithmetic | §20.2, program-2 §3 |
| X8 MAJOR: memo has no EOF row | A/M: memo withdrawn from 2.0; a future minor needs sentinel rows and a capability rule | §20.5, program-2 §1 |
| X9 MAJOR: rfc cut lifetime inconsistent | A: commitment epochs per attempt; `{* (a: int)}` / `{a: 1}` accepted; called snug's formalisation, not settled RFC text | §20.2 |
| X10 MAJOR: linear-time claim false | A/M: withdrawn; proven contracts only | §20.7 |
| X11 MAJOR: arena bound and resource offsets | A: `A_max` sums records, end-run and activations over open containers; offsets at the item head or container head; charge before allocation. *Bound revised in revision 3 (N1)* | program-2 §8, §9.4 |
| X12 MAJOR: map trace metadata; S import | A: per-frame score/event fields; S imports `ucount`/`ukey`/`ucut` | program-2 §6.3–6.4, §8 |
| X13 verifier cost | A: cost stated in words and bitset ops; verify budget raised; SCC fixed points | program-2 §3.1 |
| X14 oracle cannot certify mechanisms | A: four expectation kinds; metamorphic, forced-tier, split and resource gates; tag unwrap in the oracle and in R17 | §20.12 |
| X15 superset lemma obligations | A | §20.5 |
| X16 B is a conservative bound | A: called an upper bound, not exact | program-2 §3.2 |
| X17 F/S equivalence conditions; S-vs-T tests | A | §20.5, §20.13 |
| X R-audit (R1–R18) | A: bases separated into text vs policy; R5 tension; R7 support only; R15 tension; R16 policy; R17 tag unwrap; R18 named groups | §20.3 |
| X Q1: keep the Ruby-compatible reference mode, do not quietly replace it with rule A | **R/M**: rule A adopted openly, not quietly. Name transparency (App. C, App. H) is decisive, and the Ruby difference is recorded as class RC with 7 probes. Renaming the mode is put to the owner (D273) | §20.2, §20.4 |
| X Q2–Q16 | A as the corresponding findings. Q3: EC order kept, but the coupling to §19.4 is dropped (manager decision 2). Q11: distinct code kept, precedence defined. Q12: prices provisional until measured | — |
| X Format Q1–Q4 | A: memo reserved with a capability rule; fixed stride keeping dead blocks; code 44 with precedence; `index[n_named]` with −1 initialisation | program-2 |

Only X Q1 is rebutted, and that is by the manager's decision, with the
reason stated above. No other finding is rejected.

**Re-review of revision 2** (`docs/reviews/2026-11-04-peg-rereview.md`,
"N#"; it confirms C1–C5 and X1–X14 as resolved or partially resolved and
raises the following, answered in revision 3):

| Finding | Disposition | Where |
| --- | --- | --- |
| N1 BLOCKER: A_max takes a max where simultaneous blocks need a sum | A: `ACT_SUM` sums per-item activation words over a closure set's recursive leaves (like `R_ITEM_MAX` for records); items counted by a global `VM_GROUP_ITEMS` that EMBED does not reset; bound saturates and is checked against a cap | §20.6, program-2 §2, §9.4 |
| N2 BLOCKER: one downward LIFO region cannot host interleaved suspended machines | A: chunk heap with 64-word chunks, per-block chunk lists, a free list; chunk addresses are indices; link/unlink charged as steps | §20.6, program-2 §5.3 |
| N3 MAJOR: growth unsafe; session relocation missing | A: demand-sized doubling (no jump to the loose bound); explicit cap with its own hard maximum, separate from the 64 MiB cap; relocation by copying two regions with stable addressing; re-run CPU bound restated; EXT purity noted. **Partly rebutted:** "never refuses at defaults" cannot be promised by any finite default; replaced by "no refusal below the cap" + warning W7 | §20.6, program-2 §9.4 |
| N4 MAJOR: unbounded cut members make scores and steps order-sensitive | A: T always visits records in pick order (sorted whenever the map is unordered or EC-sensitive, not only with order-sensitive members); F/S scores are order-independent (argued in program-2 §8); CHOICE re-raising `cut` passes its best event | program-2 §6.2, §6.5, §8 |
| N5 MAJOR: FAIL has no failure event | A: `FAIL` records an event (arrays E4; maps kind `fail` with score); folded `FAIL` carries provenance (the member whose iteration it replaces) so it reports what the unfolded REP would; unplugged sockets report `missing`/`unexpected` without a key | program-2 §3, §8 |
| N6 BLOCKER: early scanner refusals not deferred | A: D280 refusal replay — the scanner records refusal and logical event, the copy covers the valid prefix, the VM reports the refusal on reaching the event; needs P8.4's §19.5 amendment (requested via the manager) | §20.6, D280 |
| N7 MINOR: gates need resource and wire-order qualifications | A: forced-tier equality under sufficient resources; resource outcomes gated against their own schedules; encoding invariance only for the verdict and the wire-independent parts of witnesses (revision 3.1: §20.9/§20.12 wording aligned; pair-attributed map witnesses excluded) | §20.9, §20.12 |
| N8 MINOR: proofs vs established bounds | A: verifier cost and the A0/A1 bound labelled proof obligations | §20.7, program-2 §3.1, §20.16 |
| N9 MINOR: wording | A: D277 marked done; §20.2's §3.5.4 claim qualified; App. C occurrence-expansion exception recorded in R9 | §20.2, §20.3 |

**Final check** (`docs/reviews/2026-11-04-peg-final-check.md`, "F#"; revision 3.1):

| Finding | Disposition | Where |
| --- | --- | --- |
| F1 MAJOR: a no-cut fold to plain `FAIL` loses the consumed-prefix score, so a competing `CHOICE` reports the wrong event (`{((2*2 (+ tstr => int)) // ("a" => int, "c" => int)), ? "a" => any, ? "b" => any, ? "c" => any}` on `{a:1, b:2}`: unfolded missing `ANYKEY` with score 2; plain-`FAIL` fold missing `KEY c`) | A: plain-`FAIL` folding removed. `REP(lo ≥ 2, hi, MEMBER(k ≥ 1, INF))` always becomes `SEQ(MEMBER(k, INF), FAIL)` with provenance, so the event and score equal the unfolded repetition's. This example, with its competing branch, is a corpus witness case | program-2 §3.3, §8 |
| F2 BLOCKER: D280 replay phases and partial-copy representation | Routed by the manager to the P8.4 engineer (§19.5 owner); D280 stays pending | §20.6, D280 |

### 20.15 Probe record (2026-11-04, revision 2)

Columns:

* **branch**: §20.2 with `cuts: 'branch'` (rule A; `reference` before D301) and EC pick order. The
  prototype sorts keys by their encoded bytes, which equals EC order for
  these keys.
* **rfc**: `cuts: 'rfc'` (commitment epochs; the default since D301).
* **DNF**: revision 1's reference mode, i.e. the D021-DNF and Ruby-like
  reading.
* **old**: snug today (format 1).
* **Ruby**: `cddl` 0.12.14.
* **Rust**: cddl-rs 0.10.7.

✓ is valid and ✗ invalid. The Notes column gives Ruby's deviation class
(§20.4) and marks *flips* (old ≠ branch) and *was refused* (format 1 refused
the schema). The root rule is `r`. Data is shown in wire order, which is
canonical except for M06.1. A10.1's Ruby run hung and was killed at the
timeout.

| Case | Schema | Data | branch | rfc | DNF | old | Ruby | Rust | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A01.0 | `r = [* uint, uint]` | `[1]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A01.1 | `r = [* uint, uint]` | `[1,2]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A02.0 | `r = [? uint, 2*3 uint, tstr]` | `[1,2,"x"]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A02.1 | `r = [? uint, 2*3 uint, tstr]` | `[1,2,3,"x"]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A03.0 | `r = [(int) // (int, int)]` | `[1,2]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A03.1 | `r = [(int) // (int, int)]` | `[1]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A04.0 | `r = [(int, int) // (int)]` | `[1]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A04.1 | `r = [(int, int) // (int)]` | `[1,2]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A05.0 | `r = [2*3 uint, uint]` | `[1,2,3]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A05.1 | `r = [2*3 uint, uint]` | `[1,2,3,4]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A05.2 | `r = [2*3 uint, uint]` | `[1,2]` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| A06.0 | `r = [* (tstr, uint)]` | `["a",1,"b"]` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| A06.1 | `r = [* (tstr, uint)]` | `["a",1]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A07.0 | `r = [(* int, tstr) // (* int)]` | `[1,2]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A07.1 | `r = [(* int, tstr) // (* int)]` | `[1,2,"x"]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A08.0 | `r = [* ((* int, tstr) // int)]` | `[1,2,3]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A08.1 | `r = [* ((* int, tstr) // int)]` | `[1,"x",2]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A09.0 | `r = [2*2 (? int)]` | `[]` | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | Ruby RZ |
| A09.1 | `r = [2*2 (? int)]` | `[1]` | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | Ruby RZ |
| A10.0 | `r = [* (? int)]` | `[1,2]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A10.1 | `r = [* (? int)]` | `["x"]` | ✗ | ✗ | ✗ | ✗ | hang | ✗ | Ruby RZ |
| A11.0 | `r = [* (int // tstr), int]` | `[1,"a"]` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| A12.0 | `r = [+ uint, * uint, uint]` | `[1,2,3]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A13.0 | `r = [uint, ? (uint, tstr), uint]` | `[1,2]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A13.1 | `r = [uint, ? (uint, tstr), uint]` | `[1,2,"x",3]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A13.2 | `r = [uint, ? (uint, tstr), uint]` | `[1,2,3]` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| A14.0 | `r = [* (int, int), 3*3 uint]` | `[1,2,3]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A14.1 | `r = [* (int, int), 3*3 uint]` | `[1,2,3,4,5]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A15.0 | `r = [? (int, int), int]` | `[1,2]` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| A15.1 | `r = [? (int, int), int]` | `[1,2,3]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A16.0 | `r = [(int, tstr) // (int, int)]` | `[1,2]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A17.0 | `r = [int, ? g]; g = (int, ? g)` | `[1,2,3]` | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | Ruby RR |
| A18.0 | `r = [g]; g = (0, ? g, 1)` | `[0,0,1,1]` | ✓ | ✓ | ✓ | refused (group_recursion) | ✗ | ✓ | Ruby RR; was refused |
| A18.1 | `r = [g]; g = (0, ? g, 1)` | `[0,1,1]` | ✗ | ✗ | ✗ | refused (group_recursion) | ✗ | ✗ | was refused |
| A19.0 | `r = [* any, int]` | `[1]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A20.0 | `r = [int] / [int, int]` | `[1,2]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A21.0 | `r = [* (a: int, b: int)]` | `[1,2,3]` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| A22.0 | `r = [1*3 uint, 2*2 uint]` | `[1,2,3]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A22.1 | `r = [1*3 uint, 2*2 uint]` | `[1,2,3,4]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F01.0 | `r = { ? (a: int, b: int), ((* tstr => int) // (* tstr => tstr)) }` | `{"a":1,"b":2,"c":"x"}` | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | Ruby RK; flips |
| F01.1 | `r = { ? (a: int, b: int), ((* tstr => int) // (* tstr => tstr)) }` | `{"a":"x","c":"x"}` | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | Ruby RK; flips |
| F02.0 | `r = [? uint, 2*3 uint, tstr]` | `[1,1,"x"]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F03.0 | `r = [* (int, int), 3*3 uint]` | `[1,1,1]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F03.1 | `r = [* (int, int), 3*3 uint]` | `[1,1,1,1,1]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F03.2 | `r = [* (int, int), 3*3 uint]` | `[1,1,1,1,1,1,1]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F04.0 | `r = bstr .cborseq [? uint,2*3 uint,tstr]` | `h'01026178'` | ✗ | ✗ | ✗ | ✓ | error | ✗ | Ruby RX; flips |
| F05.0 | `r = { a: tstr, ? b: int // c: int, 0*2 tstr => tstr }` | `{"a":"y","c":0}` | ✗ | ✗ | ✗ | refused (map_overlap) | ✗ | ✗ | was refused |
| F05.1 | `r = { a: tstr, ? b: int // c: int, 0*2 tstr => tstr }` | `{"a":"x","c":1}` | ✗ | ✗ | ✗ | refused (map_overlap) | ✗ | ✗ | was refused |
| F06.0 | `r = [* ((uint / tstr), tstr), 2*4 (uint / tstr)]` | `[3,"y"]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F07.0 | `r = [? tstr, 0*2 (uint / tstr), 0..2]` | `[0]` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F08.0 | `r = {group2}; group2 = (? ab: a / b // cd: c / d); a = 1 b = 2 c = 3 d = 4` | `{"cd":3}` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| H01.0 | `r = {rater-value, ? conf-value, * ext-value}; rater-value = (rater: text); conf-value = (confidence: uint); ext-value = (text => any)` | `{"rater":"x","confidence":"bad"}` | ✗ | ✗ | ✓ | refused (map_group_occurrence) | ✓ | ✗ | Ruby RC; was refused; D021-DNF differs |
| H02.0 | `r = {rater: text, ? confidence: uint, * text => any}` | `{"rater":"x","confidence":"bad"}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M01.0 | `r = {? "optional-key" => int, * tstr => any}` | `{"optional-key":"nonsense"}` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Ruby RL |
| M02.0 | `r = {? "optional-key" ^=> int, * tstr => any}` | `{"optional-key":"nonsense"}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M03.0 | `r = {? optional-key: int, * tstr => any}` | `{"optional-key":"nonsense"}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M03.1 | `r = {? optional-key: int, * tstr => any}` | `{"z":2,"optional-key":1}` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| M04.0 | `r = {* tstr => any, "a" => int}` | `{"a":1}` | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | flips |
| M05.0 | `r = {* tstr => any, ? a: int}` | `{"a":"x"}` | ✓ | ✓ | ✓ | refused (map_cut) | ✗ | ✗ | Ruby RL; was refused |
| M06.0 | `r = {int => int, int => 6}` | `{3:5,4:6}` | ✓ | ✓ | ✓ | refused (map_overlap) | ✓ | ✗ | was refused |
| M06.1 | `r = {int => int, int => 6}` | `{4:6,3:5}` | ✓ | ✓ | ✓ | refused (map_overlap) | ✗ | ✗ | Ruby RO; was refused |
| M07.0 | `r = {* (a: int, b: int)}` | `{"a":1}` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | Ruby RI |
| M07.1 | `r = {* (a: int, b: int)}` | `{"a":1,"b":2}` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| M08.0 | `r = {? (a: int, b: int)}` | `{"a":1}` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | Ruby RI |
| M09.0 | `r = {? (a: int, b: int), * tstr => any}` | `{"a":1}` | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | rfc differs |
| M10.0 | `r = {(? a: int) // (b: int)}` | `{"b":1}` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| M11.0 | `r = {(a: int) // (a: int, b: int)}` | `{"a":1,"b":2}` | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| M12.0 | `r = {kind: "a", x: int // kind: "b", y: tstr}` | `{"y":"s","kind":"b"}` | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | rfc differs |
| M12.1 | `r = {kind: "a", x: int // kind: "b", y: tstr}` | `{"y":"s","kind":"c"}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M13.0 | `r = {+ (email: tstr // phone: tstr)}` | `{"email":"a","phone":"b"}` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |  |
| M13.1 | `r = {+ (email: tstr // phone: tstr)}` | `{}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M14.0 | `r = {2*2 (? a: int)}` | `{}` | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | Ruby RZ |
| M14.1 | `r = {2*2 (? a: int)}` | `{"a":1}` | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | Ruby RZ |
| M15.0 | `r = {* tstr => int, * tstr => tstr}` | `{"a":1,"b":"x"}` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Ruby RK |
| M16.0 | `r = {(* tstr => int) // (* tstr => tstr)}` | `{"b":"x"}` | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | Ruby RK; flips |
| M16.1 | `r = {(* tstr => int) // (* tstr => tstr)}` | `{"a":1}` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| M17.0 | `r = {1*2 tstr => int}` | `{"a":1,"b":2,"c":3}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M18.0 | `r = {* (a: int, b: int), * tstr => any}` | `{"a":"x"}` | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | Ruby RC; flips; D021-DNF differs |
| M18.1 | `r = {* (a: int, b: int), * tstr => any}` | `{"a":1}` | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | rfc differs |
| M19.0 | `r = {? ((a: int) // (b: int)), * tstr => any}` | `{"a":"x"}` | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | Ruby RC; flips; D021-DNF differs |
| M20.0 | `r = {(a: int, b: int) // (* tstr => any)}` | `{"a":1}` | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | rfc differs |
| M21.0 | `r = {"a" => int, * tstr => any}` | `{"a":"x"}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M22.0 | `r = {? "a" => int, * tstr => any}` | `{"a":"x"}` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Ruby RL |
| M23.0 | `r = {* tstr ^=> uint, * any => any}` | `{"a":"x"}` | ✗ | ✗ | ✗ | refused (map_cut) | ✗ | ✗ | was refused |
| M23.1 | `r = {* tstr ^=> uint, * any => any}` | `{1:"x"}` | ✓ | ✓ | ✓ | refused (map_cut) | ✓ | ✗ | was refused |
| M24.0 | `r = {1*2 tstr ^=> uint, * tstr => tstr}` | `{"a":1,"b":2,"c":"x"}` | ✓ | ✓ | ✓ | refused (map_cut) | ✓ | ✗ | was refused |
| M24.1 | `r = {1*2 tstr ^=> uint, * tstr => tstr}` | `{"a":"x","b":1,"c":2}` | ✗ | ✗ | ✗ | refused (map_cut) | ✗ | ✗ | was refused |
| M25.0 | `r = {a: int, ? b: int, * tstr => tstr}` | `{"a":1,"b":"x"}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M26.0 | `r = {a: int, $$x}` | `{"a":1}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M27.0 | `r = {a: int, * $$x}` | `{"a":1}` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| M28.0 | `r = {(a: int // b: int), (a: int // b: int)}` | `{"a":1,"b":2}` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |  |
| M28.1 | `r = {(a: int // b: int), (a: int // b: int)}` | `{"a":1}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |  |
| M29.0 | `r = {* (a: int // b: tstr)}` | `{"a":1,"b":"x"}` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |  |
| M30.0 | `r = {? (a: int, b: int), a: int}` | `{"a":1}` | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ | Ruby RI; rfc differs |
| M31.0 | `r = {(kind: "a", x: int) // (kind: "b")}` | `{"x":1,"kind":"b"}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |  |
| M32.0 | `r = {? 1 => int, ? (5 => bstr // 6 => bstr)}` | `{5:h'00',6:h'00'}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M32.1 | `r = {? 1 => int, ? (5 => bstr // 6 => bstr)}` | `{6:h'00'}` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |  |
| M33.0 | `r = {? a: int, ? a: tstr}` | `{"a":"x"}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M34.0 | `r = {? "a" => int, ? "a" => tstr}` | `{"a":"x"}` | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | Ruby RL; flips |
| M35.0 | `r = {* int => tstr, 1 => tstr}` | `{1:"x"}` | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | flips |
| N01.0 | `r = {? (a: int), * tstr => any}` | `{"a":"x"}` | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | Ruby RC; flips; D021-DNF differs |
| N02.0 | `r = {* (a: int), * tstr => any}` | `{"a":"x"}` | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | Ruby RC; flips; D021-DNF differs |
| N03.0 | `r = {(a: int) // (* tstr => any)}` | `{"a":"x"}` | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | rfc differs |
| N04.0 | `r = {? ("a" => int), * tstr => any}` | `{"a":"x"}` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |  |
| N05.0 | `r = {(a: int, b: int) // (a: tstr)}` | `{"a":"x"}` | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | rfc differs |
| N06.0 | `r = {? (a: int, b: tstr), * tstr => any}` | `{"a":1,"b":2}` | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | Ruby RC; flips; D021-DNF differs |
| N07.0 | `r = {a: int // b: int}` | `{"a":1,"b":2}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| N08.0 | `r = {* tstr => int, ? "a" => tstr}` | `{"a":"x","b":1}` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Ruby RK |
| N09.0 | `r = {+ a: int}` | `{"a":1}` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| N10.0 | `r = [* int, ? tstr, * int]` | `[1,"x",2]` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| R01.0 | `r = {* (a: int)}` | `{"a":1}` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| R02.0 | `r = {* tstr => int, ? "a" ^=> tstr}` | `{"a":1}` | ✓ | ✓ | ✓ | refused (map_cut) | ✗ | ✗ | Ruby RL; was refused |
| R03.0 | `r = {* tstr=>any, (a:int // b:int)}` | `{"a":1}` | ✗ | ✗ | ✗ | refused (map_cut) | ✗ | ✓ | was refused |
| R04.0 | `r = {* tstr=>any, ?(a:int,b:int)}` | `{"a":"x"}` | ✓ | ✓ | ✓ | refused (map_cut) | ✓ | ✗ | was refused |
| R05.0 | `r = {+ tstr => int, ? (a: int)}` | `{"z":1}` | ✓ | ✓ | ✓ | refused (map_cut) | ✓ | ✓ | was refused |
| R06.0 | `r = {2*2 (+ int => int)}` | `{"1":1}` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| R07.0 | `r = {? (a: tstr, b: tstr), * tstr => any}` | `{"a":3,"b":3}` | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | Ruby RC; flips; D021-DNF differs |

### 20.16 Remaining questions

1. ~~**D271 (owner).** Which cut mode should be the default, and should
   `reference` be renamed?~~ Answered 2026-11-10 by D301: `rfc` is the
   default; rule A is `cuts: 'branch'`.
2. **D280 (P8.4).** Agree to refusal replay on the canonical path and amend
   §19.5.
3. **Arena cap (manager/owner).** Is a 16 MiB default arena cap with a W7
   warning acceptable, given that no finite default can rule out
   `group_limit` (§20.6)?
4. **Proof obligations (N8):**
   * the A0/A1 linear bound (§20.7);
   * the verifier's fixed-point cost (program-2 §3.1).

   Both are labelled as obligations, not as established bounds.
5. **Measurement before adoption:** PEG step, record, chunk and sort
   prices; re-run cost on the buffer route.
