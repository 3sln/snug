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

**Every leaf that accepts an item without examining children still gives the
children a query set**: `ANY` gives `{ANY}`, `MAJOR 4` gives `{ANY}` to
elements, an `INT` leaf admitting bignums gives the content `{BSTR}`.
Children are always walked (the profile requires it); the query set only says
what is being asked of them.

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
| `FLOAT widths bounds` | float of allowed encoded widths (`#7.25/26/27`, `float16`…), optional interval list |
| `SIMPLE v` | `#7.v` for v < 24 (`false`, `true`, `null`, …) |
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
| `.regexp` | RFC 9485 I-Regexp, anchored (§4.7) |
| `.cbor T` / `.cborseq T` | `EMBED`: the content is validated as a **sub-validation**. Its profile, limit and schema failures kill only the `EMBED` leaf, never the message (`bstr .cbor {a: int} / bstr .size (0..16)` accepts `h'ff'`); if it is the reported failure the reason is `embedded` with a sub-code. Depth and item limits are accounted separately for the embedded document; only the budget is global. Exact span: the content must be fully consumed (`.cbor`: exactly one item; `.cborseq`: items to the end) (A4, C7). |
| `.default` | annotation; no effect |
| `.feature` | accepted as a no-op annotation (RFC 9165: it always matches) (A12) |
| `.cat`, `.det`, `.plus` | compile-time folding (P3, not gated in revision 2) |
| `.pcre`, `.abnf`, `.abnfb` | refused (D013) |
| a registered `.name` | extension control (D082, D140–D142): `AND(target leaf, EXT)` per target leaf; the EXT is decided by a host predicate over the item's encoding, only when the AND needs it, after the item's profile walk, charged before it runs (a fixed call charge plus the predicate's declared cost, by default one unit per item byte; the generic controls meter their own work in kin, D190–D193), bounded by the control's maximum item size (program.md §4.2, §14, format 1.1). Unregistered: `unknown_control` naming it. |

### 4.7 Regular expressions

`.regexp` is RFC 9485 I-Regexp, matched against the whole string. It compiles
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
Programs need no table module. `\\d \\w \\s` and `\\x..` are refused as non-I-Regexp
(the CDDL string literal can carry `\\u` escapes instead).

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
| step budget | 2 300 000 | 2^31 − 1 | validate |

Per-call validation limits may only **lower** the compiled ones (A8): depth
and state capacity were sized at compile time.

**Charging (A7, C9, C10).** One budget unit is a bounded amount of work, and
every loop whose trip count depends on input or schema charges per trip:

| Work | Charge |
| --- | --- |
| item head + major-mask filter | 1 + \|Q\| |
| leaf evaluation (scalar) | 1 per leaf |
| content scans (UTF-8, `.bits`, typed-array NaN, literal compare) | 1 per 64 bytes per scan |
| regexp step | `(active + 1) × ⌈P/32⌉` per code point, plus the class search |
| key binary search | ⌈log2 keys⌉ |
| map pair | 1 per candidate entry tested + 1 per live alternative group updated |
| array element | 1 per follow edge traversed + 1 per active position |
| AND / NOT / EMBED dependency | 1 per dependency |
| profile-only continuation (§4.5) | 1 per item + 1 per 64 content bytes |
| extension control asked (D190–D193) | 1 + 16 per call, + the predicate's units: a host predicate's declared cost (default 1 per item byte), charged before it runs; a generic control's metered work (heads, hashing, comparisons, probes) |

Budget arithmetic saturates. The exact, normative per-event schedule (so
that hosts agree on the exhaustion point) is `docs/program.md` §14; this table
is its summary. The default 2.3 M units (D046, under program.md §14's
schedule 2, D045; both provisional) is calibrated so that the worst
budget-bounded input measured stays near 50 ms in Node on the reference
machine (bench/VM.md P3.6); the workerd measurement is still to be taken
(Phase 4).

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
on sort order. The host exposes a `View` (offset + owner) and a mutable
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

## 20. PEG group semantics (D270, D271) — design 2026-11-04, provisional, for independent review

D270 moves group matching in arrays and maps from the exact regular /
existential semantics of §4.3–§4.4 (D010–D012, D035, D036) to the parsing
expression grammar (PEG) semantics of RFC 8610 Appendix A. D271 keeps D021's
cut reading as the default and asks for the literal RFC reading as an
option. This section defines the semantics exactly, resolves each ambiguity in
the RFC text, records what the Ruby reference tool does, and designs the
evaluation, the compiler changes, the oracle and the migration. The Program
format it needs is drafted in [program-2.md](program-2.md) (format 2.0).
Nothing here is implemented. §4.1–§4.2 (type-set evaluation of single items)
are unchanged. §4.3, §4.4, the group parts of §5.1 steps 4–5 and the D011 /
D012 refusals are superseded once this lands.

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

### 20.2 The semantics, exactly

A group is a tree after names, generics, sockets and unwraps are resolved.
Its nodes are `EMPTY`, `FAIL` (the empty group choice: an unplugged `$$g`,
§3.9, S32), `SEQ(g₁…gₖ)`, `CHOICE(g₁…gₖ)` (`//`, in source order, with
`//=` contributions in rule order, App. C), `REP(min, max, g)` (an
occurrence indicator; `?` = 0..1, `*` = 0..∞, `+` = 1..∞, no indicator =
1..1; counts ≥ 2^24 are ∞ as a maximum and unsatisfiable as a minimum,
D035), `ENTRY(T)` (array context: one element of type T) or `MEMBER(K, V,
cut)` (map context), and `CALL(r)` for a recursive group reference. Type
choices `/` stay inside the types T, K and V. They are prioritised in App.
A, but prioritising alternatives cannot change whether one item matches, so
set-based evaluation (D010) stays exact for types.

**Arrays.** `run(g, i)` gives an index j ≥ i or `fail`. Elements are
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
                         if q = p: c := hi; break      -- zero-length iteration (R4)
                         p := q; c := c + 1
                       return p if c ≥ lo, else fail
run(CALL(r), i)      = run(body(r), i)
array matches        ⇔ run(root, 0) = n
```

Nothing is retried after a node returns: a choice that returned keeps its
alternative, a repetition keeps its count, and the final `= n` test does not
re-enter the root. Member keys in arrays are labels. Cuts have no effect in
arrays (§3.5.4 is about maps).

**Maps.** The state is the set R of pairs not yet consumed. The pairs are
taken in **pick order**: ascending bytewise order of the keys' EC forms
(§19.2, the data-model equivalence form; for every key without a float zero,
a NaN or a map inside, this is its RFC 8949 §4.2.1 deterministic encoding).
It is a function of the map's value, not of its serialisation (R8).
`run(g, R)` gives a new set R′ ⊆ R or `fail`. Under `cuts: 'rfc'` it can
also give `fail!`, a failure no enclosing construct may recover from.

```
run(MEMBER(K, V, cut) with occurrence lo..hi, R):
    c := 0; R′ := R
    for p in R in pick order:
        if c = hi: break
        if key(p) ∉ K: continue
        [rfc] if cut: committed := true                        -- the key matched
        if value(p) ∈ V: R′ := R′ − {p}; c := c + 1            -- consume
        elif cut: return fail  [reference]  |  fail!  [rfc]    -- §3.5.4
        -- else (no cut): skip; p stays for later entries (§3.5.4, first example)
    return R′ if c ≥ lo, else fail
run(SEQ(g₁…gₖ), R)    = thread R through g₁…gₖ; the first fail (or fail!) is the result
run(CHOICE(g₁…gₖ), R) = for m in 1..k:
                           r := run(gₘ, R)                -- consumption of a failed gₘ is undone
                           if r ≠ fail/fail!: return r     -- locked in
                           [rfc] if r = fail! or a cut key matched inside gₘ: return fail!
                        return fail
run(REP(lo,hi,g), R)  = iterate as for arrays on sets, a failed iteration undone,
                        "zero-length" meaning "consumed nothing";
                        [rfc] a fail! (or a failed iteration in which a cut key
                        matched) is returned as fail!
run(EMPTY/FAIL/CALL)  as for arrays
map matches           ⇔ run(root, all pairs) = ∅            -- closed (§2.1)
```

A `MEMBER` with an occurrence is one node. The loop above is its
repetition. `REP` around a parenthesised *group* is the general repetition,
even when that group has one member. That difference is observable only
through cuts, and only in the reference mode (R9, probes N01/M03).

**Cut modes (D271).** `cuts: 'reference'` (the default until the owner
decides D271) is D021 translated to PEG. A cut member that meets a remaining
pair whose key matches but whose value does not, before reaching its
maximum, **fails**, even when its own minimum is 0. That failure is ordinary:
an enclosing `?(…)`/`*(…)` group may end with fewer iterations, and an
enclosing `//` tries its next alternative. This is what both Ruby and snug's
DNF did: a cut killed the expanded alternative that contained it and spared
the zero-iterations alternative (probes M18, M19, N01, N02, N06). `cuts:
'rfc'` is the literal text. A cut member whose key matches a remaining pair
**commits**: from then on, any failure inside every enclosing choice or
repetition of this map's group fails the whole map type (App. A: a cut
disables "alternatives in choices containing this choice"; a repetition is a
choice between one more iteration and stopping). A value mismatch fails the
map at once (§3.5.4 "the entire map fails to match"). The map *type* fails;
an enclosing *type* choice `{…} / {…}` is outside the group and still tries
its other alternatives.

### 20.3 Ambiguities resolved

| # | Question | Resolution | Basis |
| --- | --- | --- | --- |
| R1 | Can the end-of-array test make a choice try its next alternative? | No. `[(int) // (int, int)]` rejects `[1, 2]`. | App. A example (2) ("the second alternative will never match"); §2.1 "exactly match" read as "the PEG consumed every element" |
| R2 | Greedy occurrence | The maximum number of iterations that succeed; never given back. `[* uint, uint]` matches nothing. `[? uint, 2*3 uint, tstr]` rejects `[1,2,"x"]`. | App. A ("*a a" "never can match anything") |
| R3 | Ranges with min > 1 | Iterate greedily; succeed iff count ≥ min. `[2*3 uint, uint]` rejects `[1,2,3]` and `[1,2]` and accepts `[1,2,3,4]`. | App. C's "group choice … repeated each of the occurrences times", read with App. A's greed as a prioritised choice of counts in descending order. That gives the same results, because a locked count is never revisited. |
| R4 | An iteration that succeeds without consuming | The repetition stops and counts as satisfied (min reached). `[2*2 (? int)]` accepts `[]` and `[1]`; `[* (? int)]` cannot loop. | Repeating a zero-length success at the same position repeats it identically, so App. C's alternative "repeated min times" matches. Ruby stops instead and fails (deviation RZ; it also hangs on `[* (? int)]` with `["x"]`). |
| R5 | Group choice in a map: union (§2.2.2) or prioritised (App. A/C)? | Prioritised, locking in. Closedness is tested after the root and does not retry. `{(? a: int) // (b: int)}` rejects `{b: 1}`, and the §3.11 example rejects `{cd: 3}`. | App. A and C are normative and specific. §2.2.2 describes the generative set and is satisfied for every non-overlapping choice. |
| R6 | Does a member consume a pair whose key matches and whose value does not? | Without a cut, no: the pair is skipped and stays for later entries. `{? "optional-key" => int, * tstr => any}` accepts `{"optional-key": "nonsense"}`. | §3.5.4 first example, verbatim; §3.5.3 "a *matching* member is picked". Ruby always fails here (RL, RK). |
| R7 | How much does a map member take? | Every remaining matching pair, up to its maximum (greedy). | App. A greed; §3.5.3 "the group expression tends to consume all matches" |
| R8 | Which pairs does a member with a finite maximum take when more match? | The first ones in pick order (EC key order). `{int => int, int => 6}` accepts `{3:5, 4:6}` however it is encoded and rejects `{3:6, 4:5}`. Pick order is the wire order for every map that §19.4 does not mark (in particular all deterministic input), and the deferred duplicate check's sort order for marked maps, so it costs no extra comparison. | §3.5.3 calls the outcome indeterminate. snug fixes it, independently of the serialisation (§2.2.3: CDDL "does not provide any language means to restrict the choice of serialization variants"; D230: compare by value). Ruby uses wire order (RO). |
| R9 | What does a failed cut kill? | reference: the member (ordinary failure from there on). rfc: the map type. | D021/D271 (above) |
| R10 | Does a cut reach back to earlier entries? | No: earlier entries ran first. `{* tstr => any, ? a: int}` accepts `{a: "x"}` (the wildcard took it), and `{* tstr => any, "a" => int}` matches no map containing `"a"`. | §3.5.4 "later entries"; App. A greed. The old `map_cut` refusal is withdrawn. |
| R11 | Cuts on key types (`tstr ^=> uint`) | Allowed: the same rule for each pair the member examines. | App. C memberkey (no restriction). The old `map_cut` refusal is withdrawn. D188's byte-string/float cut keys follow P8.4's key policy. |
| R12 | What does `* (a: int, b: int)` match in a map? | Both pairs or neither. A failed iteration is undone completely; `{a: 1}` alone is rejected (leftover). | §3.2 "concatenating a number of sequences that the basic group entry matches". Ruby leaks a failed iteration's consumption (RI). |
| R13 | The same literal key twice in one sequence (`$$ext //=` compositions, `{? "a" => int, ? "a" => tstr}`) | Legal; plain PEG. The second member sees the pair only if the first did not take it. The old "unsatisfiable alternative dropped" rule (§4.3.1 step 4) is withdrawn. | No RFC restriction; PEG is determinate |
| R14 | Unplugged group socket | `FAIL`: `{a: int, $$x}` matches nothing, `{a: int, * $$x}` = `{a: int}`. | §3.9 "empty group choice" (S32, D251) |
| R15 | Does App. C's "can be ordered in such a way" make maps existential? | No. snug reads it together with §3.5.3: the PEG picks members from the whole map. An existential reading would bring back permutation search and contradict §3.5.3's "leaving nothing for the second entry". For non-pathological groups (§3.5.3) the two readings give the same results. | §3.5.3 is the specific text |
| R16 | Recursion | A group reference cycle is a PEG nonterminal and is allowed. Only **left recursion** (a cycle that can re-enter without consuming) is refused, because a PEG with it does not terminate. `[g]`, `g = (0, ? g, 1)` accepts `[0,0,1,1]`. | PEG well-formedness [PEG] |
| R17 | `~` unwrap, `&` enumeration, `.cborseq` | `~` inlines the group (a choice of maps/arrays unwraps to a group choice in rule order). `&` stays a value set (occurrences ignored). A `.cborseq` sequence is a virtual array (D040) and gets array PEG semantics. | App. C, §3.7, §3.8.4 |
| R18 | A keyless type entry in a map | Refused (`map_key`), as now | App. C ("can only be used for matching arrays") |

### 20.4 What the Ruby reference tool does

Probes live in `.cache/peg/` (not committed): `proto.mjs` is a scratch PEG
interpreter derived from the existing oracle's parser and used only to check
this design. `probes*.mjs` / `table.mjs` produce the table in §20.13. Tools:
Ruby `cddl` 0.12.14 (`… schema.cddl validate data.cbor`; rc 0 valid, 1
invalid), cddl-rs 0.10.7 (the audit's offline build, `--ci`, secondary
evidence), and current snug (HEAD working tree, default options). Of 108
cases, **Ruby agrees with the reference-mode semantics above on 87**. Every
one of the 21 disagreements falls in one of seven classes that Ruby's source
(`lib/cddl.rb`, `map_check` / `validate_forward`) explains:

| Class | Ruby behaviour | Cases | snug |
| --- | --- | --- | --- |
| RL | A literal-key member is always a cut: a present key with a wrong value fails the member, even for `=>` and `?`. It also looks the key up in the whole map, including pairs an earlier entry consumed. | M01, M05, M22, M34 | follow §3.5.4 (its first example is exactly M01) |
| RK | A non-literal member fails as soon as a key-matching pair has the wrong value (until its maximum is reached), cut or not | M15, M16, N08, F01 ×2 | follow §3.5.3 ("a matching member") |
| RI | A failed iteration of a group repetition keeps what it consumed (`d_check1` is shared across iterations) | M07, M08, M30 | undo (R12) |
| RZ | A zero-length iteration stops the repetition and the minimum fails; in arrays an empty-matching body loops until the timeout | A09 ×2, A10, M14 ×2 | R4 |
| RR | Group recursion in arrays rejects valid data | A17, A18 | R16 |
| RO | Picks in wire order | M06 (unsorted encoding) | EC key order (R8) |
| RX | `.cborseq` fails with an internal error | F04 | — |

On arrays, Ruby is PEG with prioritised choice, greedy occurrence and no
retry, exactly as R1–R3 say (A01–A08, A11–A16 and A19–A22 all agree). On
maps, its choices are prioritised and lock in (M10, M11, F05, F08 agree). Its
reference-mode cut behaviour, including a group repetition absorbing a member's
cut failure, is what `cuts: 'reference'` reproduces (M18, M19, N01–N06).
cddl-rs deviates more widely (M04, M13, M28, M31, M35 and others) and is not
used as a semantic witness.

### 20.5 Evaluation: one read of every byte, then a PEG over verdicts

The bytes are still read once, by the existing walk, in every driver. What
changes is what a container does with its children's results.

**Arrays.** Each ARRAY leaf keeps two things:

1. **A query automaton** decides what each element is evaluated against. It
   is the Glushkov automaton of the group with priorities and counts
   *relaxed*. Positions are the `ENTRY` nodes. `REP(lo, hi, g)` adds g's
   loop edges when hi ≥ 2 and makes g skippable when lo = 0. `CHOICE` is a
   union. A `CALL` is approximated context-insensitively: a call site
   follows into the callee's first positions, and the callee's last
   positions follow into every call site's follow set. So every group,
   recursive or not, has one with no unrolling and no counters. Element i
   is evaluated **once** against the union of the typesets of the candidate
   positions Cᵢ (format 1's step, minus counters).
   **Superset lemma:** if the PEG ever tests element i against position p,
   then p ∈ Cᵢ. *Proof sketch:* the PEG reaches p at i only after
   consuming e₀…e_{i−1} through `ENTRY` nodes along a path of the tree that
   ignores priorities and counts. Each of those elements matched its node's
   type, so the relaxed automaton has the same path.
2. **A verdict record** per element: rᵢ = {p ∈ Cᵢ : eᵢ matched typeset(p)},
   W = ⌈npos/32⌉ words. This is exactly format 1's A′ bitset, the next
   automaton state. The PEG's `ENTRY(p)` test at i is "bit p of rᵢ". The
   PEG never touches bytes.

The **PEG machine** (program-2 §5.2) runs `run(root, 0)` of §20.2 over the
records with an explicit stack. It runs **incrementally**: after rᵢ is
stored, it runs until it asks for r_{i+1} or terminates. At the array's end
(count reached, or `break` for indefinite arrays) it is told the input ended
(`ENTRY` at n fails) and finishes. The array leaf matches iff the result is
n. If the root succeeds at e while elements remain, the leaf fails
(`unexpected` at e). If rᵢ = ∅, no `ENTRY` can consume eᵢ, so the leaf
cannot match: the machine is run to termination with no later record (it
never asks for one), which yields the witness (§20.8), and the block dies.
As now, elements after that are walked dead when no other candidate lives.

**How far back the PEG can go: three storage tiers.** A backtrack point is a
`REP` iteration attempt or a `CHOICE` alternative that is not the last. On
failure the machine rewinds to the point's start index. Let FL(g) be the
most elements g can consume before failing:

```
FL(ENTRY) = 0;  FL(FAIL) = 0;  FL(EMPTY) = −∞ (cannot fail)
FL(SEQ(g₁…gₖ)) = max over j with FL(gⱼ) ≠ −∞ of (maxlen(g₁…g_{j−1}) + FL(gⱼ))
FL(CHOICE(g₁…gₖ)) = max FL(gⱼ), −∞ if some gⱼ cannot fail
FL(REP(lo, hi, g)) = −∞ if lo = 0, else (lo − 1)·maxlen(g) + FL(g)
B = max over backtrack points of FL(the attempted node)   (∞ through a CALL)
```

* **A0, B = 0.** No record is kept beyond the current one (it is the
  automaton state). This covers `[* T]`, records `[a, b, ? c]`, `[* uint,
  uint]`, `[* (int, * tstr)]`, `[? uint, 2*3 uint, tstr]` and every
  single-element choice.
* **A1, 0 < B < ∞.** A ring of B + 1 records lives in the leaf's frame block
  (static size): `[* (k, v)]` has B = 1, `[* (int, int), 3*3 uint]` has
  B = 1.
* **A2, B = ∞.** Records go in the scratch's **group arena** (§20.6) from
  the start of the array:
  `[(* int, tstr) // (* int)]`, recursive groups.

A static census of the 825 array types in the conformance corpus (syntactic,
`.cache/peg/tiers.mjs`) found 799 A0, 25 A1, 0 A2 and 1 recursive.

**Memoisation (A2 only).** Packrat memo cells live in each A2 record, one
word per memoised node, initialised 0 when the record is stored. Two kinds:
*result* cells (0 unknown, 1 fail, 2 + length) for `CHOICE` and finite-max
`REP` nodes the compiler proves **re-entrant** (the node can be invoked twice
at the same index); and *link* cells for `REP(lo, ∞)` nodes that can start
at more than one index. A link cell at s holds (end, iterations) of the
greedy run from s, saturated at lo. It is written as each iteration
completes and path-compressed when the run ends, so `* ((* x, y) // x)` is
linear, not quadratic. Claim, for review: with these cells, PEG steps for a
non-recursive group are O(|G|·(n+1)), plus O(n·m) for a finite-max-m
repetition that can start at many indices. Every step is charged anyway, so
the budget bounds any case the claim misses.

**Maps: three tiers.** A pair is still evaluated once. Its key is looked up
by binary search (literal key id, as now) and evaluated against the union of
the key typesets of the non-literal members (one static typeset). Its value
is evaluated against the union of the value typesets of the members whose key
matched. That gives the pair's verdict: for each member, key matched and
value matched. Then:

* **F (flat):** the root is a sequence of members only, and no member is
  *order-sensitive* (a non-literal key with a finite maximum). A repetition
  around a single cut-free member counts as that member's own occurrence;
  the two are identical without a cut. The PEG run of a flat sequence
  equals a **pair-major** pass: each pair goes to the first member in source
  order whose key and value match and which has room. A key-matching
  cut member with room that rejects the value records a cut event. Then
  minimums are checked at the end. *Proof sketch:* by induction over the
  members in source order, member m takes exactly the first max(m) matching
  pairs not taken by earlier members, in both orders. Pick order does not
  matter without order-sensitive members. Counters per member; no
  per-pair storage. Closed structs and `{* K => V}` tables are F, so D045
  schedule 2 rule 2 and the map streaks survive unchanged.
* **S (slots):** every non-literal member sits at the root, not under a
  choice or a group repetition, and has an unbounded maximum. Pairs whose
  key no literal member names can only be taken by those root members:
  handle them pair-major at arrival, as in F. A pair whose key is named
  stores its verdict in the leaf's **slot** for that key (one per named key,
  static size: wire index plus the verdict bits). At the map's end the PEG
  runs over the slots: literal members are O(1) lookups; a root non-literal
  member takes the matching unconsumed named slots. COSE headers and CWT
  claims are S.
* **T (table):** anything else: non-literal members inside choices or
  repetitions, order-sensitive members, recursion. Each pair's verdict is a
  record in the group arena (key id, flags, two bits per member). At the
  end the PEG runs over the records with a consumed bit per record and an
  undo trail. When an order-sensitive member exists and §19.4 marked the
  map, the records are visited in the deferred duplicate check's sorted
  order (EC bytes, ties by offset; keys are distinct once that check
  passes). That permutation is kept, one word per pair. Nothing else needs
  a pick order (§20.2).

Census (same corpus): 61 F, 37 S, 26 T. Every T map is adversarial except
two that the syntactic census misclassifies: `* ext-value` is a
single-member group under an occurrence, and `? v => number` has a
generic literal key; both are F after normalisation.

**Fail-fast.** A pair that no member can take (no member's key matches, or
every key-matching member rejects its value) dooms the map in every mode
and tier. The leaf dies at that pair, as format 1 does, with its deep
witness. An array whose PEG fails, or whose record is empty, dies at that
element.

### 20.6 Budget and scratch

Exact rows are in program-2 §10. In summary: per element or pair, everything
format 1 charged for the automaton step, candidates and typeset tests; a
stored record costs ⌈R/16⌉ (R its words; nothing in A0); and **one unit per
PEG step**. A step is a node entry (each `ENTRY` test, each `SEQ`/`CHOICE`
alternative/`REP` iteration entry, each `MEMBER` evaluation), a memo probe
or store, a link follow or rewrite, a rewind (plus one per trail entry
undone), or a pair examined by a non-literal member in S/T. Steps are
charged in a fixed order: after each record is stored, the machine's steps
until it suspends; at the end, the rest. So the exhaustion point is a pure
function of (Program, input), whichever driver or window split is used. D045
schedule 2's rule 1 (`[* T]`) also makes that shape's PEG steps free.

**Scratch** stays closure-sized (R3), with one bounded, explicit addition:

* Frames: an array block adds the machine state (8 words), its static
  stack (4 words per nesting level of the PEG tree, [D]) and, for A1,
  (B + 1)·W ring words. A map block adds member counters, cut-event words
  and (S) slots: n_named_keys × slot_words. All static, from closure sets
  as today.
* **The group arena**: one region of `LIM_PEG_WORDS` words, present only
  when the Program has an A2 or T leaf (FLAGS bit 6). Records and undo
  trails grow upward; recursion frames grow downward. Items nest
  stack-wise: an inner container's region is popped when it ends, and an
  embedded sub-validation restores the tops it found. A collision
  refuses the message with the new validator reason **`group_limit`**
  (code 44): a resource refusal like `budget`, never a schema verdict, and
  not skippable in sequences. The explicit bound: an A2 array uses
  n·(W + memo columns) words, a T map n·(2 + ⌈2·members/32⌉ (+1 rank)) +
  trail ≤ n words, with n ≤ the entries limit. Default 65 536 words
  (256 KiB), hard maximum 2^24, counted in `LIM_TOTAL_BYTES`. Per-call
  limits may lower it.

### 20.7 Sessions, streaming and sequences

Records, slots, counters, rings, the arena and the machine stacks are all in
the VM scratch. A session owns its scratch from start to a terminal state
(§17.1), so a suspension (`NEED`/`YIELD`) keeps them without re-reading a
byte: a record is computed from the element's evaluation, never from its
bytes. The machine has a safe point after every step, so long end-of-array
or end-of-map runs yield on the quantum (§17.4), and charges never depend
on where windows end. Unknown-length drain mode (D144) and held verdicts are
unchanged: the PEG is part of the schema verdict that is held. Sequence mode
(§18.2) resets the arena tops with the rest of the per-message state. When
§19.3 discards a deterministic attempt and re-runs on the canonical copy,
the attempt's records and machine state go with the rest of its scratch
state. In a forward-only stream, the only key bytes an order-sensitive T
map needs at its end are the ones §19.7 already keeps for the deferred
duplicate check. No tier needs any byte after it has passed.

### 20.8 Witnesses (D024 adapted)

The witness is a function of the semantics. It is the same in every tier and
driver, and computed from verdict records and the run.

* **Arrays.** A run records failure events: `ENTRY` at i < n failed (E1),
  `ENTRY` at n (E2), and the root succeeding at e < n (E3). The reported event
  has the greatest index; ties go to the first in run order. E2: `missing`
  at the array, extra segment `INDEX n` (format 1 rule 5). E3: `unexpected`,
  extra `INDEX e`. E1 at i: if rᵢ = ∅, the element's own witness, recorded
  while it was evaluated and kept because the block died there (later
  siblings were dead, so the path stack still holds it). Otherwise `type`,
  extra `INDEX i`. `[* T]`, which ends with an E1/E3 tie, therefore reports
  what format 1 did.
* **Maps.** (1) At a pair, in every tier: the first pair in wire order that
  no member can take. The block dies with format 1 rule 3's witness. (2) At
  the end: follow the failure trace. A `SEQ` goes to its failing child. A
  `CHOICE` goes to the alternative that failed with the most pairs consumed;
  ties go to the earliest. A `REP` below its minimum goes to its failing
  iteration. A `MEMBER` gives `value` at its cut-violating pair with the
  smallest wire index (extra segment `KEY k` or `ANYKEY`), or `missing`
  (extra `KEY id` / `ANYKEY`). If the root succeeded with leftovers: the
  first leftover in wire order, `value` if a member naming its key rejected
  its value, else `unexpected`. F computes the same trace at the end from
  its counters and its first cut pair per member. Witnesses found at the end
  are shallow: the map's path plus one segment.
* When several ARRAY or MAP leaves are admitted, the block that died last
  in walk order reports (ties: lowest leaf id), consistent with D024's
  "deepest emptied query set".
* Paths still name a schema key only if a member of that map names it (A10).

### 20.9 EXT, AND/NOT, EMBED, tags

Nothing changes at the type level. An element's verdict for a position is a
typeset test after the item's combinator pass, so `AND`, `NOT` and EXT
decide before the record is formed. Because queries come from the relaxed
automaton, an EXT predicate (or a nested container) can be evaluated
against a position the PEG never tests. That costs units but is
deterministic: calls depend on (Program, input), never on PEG decisions,
which is the same contract as today. Tags and their contents are untouched.
`.cborseq` content is a virtual array (D040) with its own block and PEG.
`.cbor` and `.cborseq` sub-validations nest in the arena as items do.

### 20.10 Compiler changes

**Removed:** map normal form (§4.3.1: DNF alternatives, the top-level `//`
split into separate map leaves, unsatisfiable-alternative dropping), factors
and pools (§4.3.3), the determinism rule and every overlap test (§4.3.2),
array counters and unrolling (§4.4, D036), and the alternatives limit. The
regexp Glushkov builder stays (and the relaxed array automaton reuses it).

**Added:** lowering of each array/map group to a **PEG program** (program-2
§3: a node table of `EMPTY`, `FAIL`, `ENTRY`, `MEMBER`, `SEQ`, `CHOICE`,
`REP`, `CALL`), plus static analyses that the verifier recomputes as [D]
fields. These are nullable, min/max length, FL and B (array tier),
nesting depth (stack words), re-entrancy and multi-start (memo columns), map
tier, order-sensitivity and the S slot layout. The left-recursion check is
the one semantic refusal.

**Refusals that remain:** left-recursive groups (`group_recursion`: the PEG
does not terminate); a keyless type entry in a map (`map_key`); compile
limits (PEG nodes per group, positions per array, members per map, nesting
depth, ring words B·W, memo columns, total bytes). Withdrawn:
`map_overlap`, `map_group_occurrence`, `map_cut`, counter/unrolling
position refusals, non-tail `group_recursion`, and the alternatives limit.

**Fast paths that survive, and why they are PEG-equivalent:**

* `[* T]`: `REP(0, ∞, ENTRY p)` continues while bit p is set and stops at
  the first clear bit, so the root ends at n iff every element matched T.
  That is the one-position automaton's language, and its witness is format
  1's (§20.8). The array streak and schedule 2 rule 1 stand.
* Closed structs (distinct literal keys, occurrence ≤ 1, no wildcard) and
  struct + trailing absorbing wildcards: F tier. Keys are unique in a valid
  map, so literal members never compete. A non-cut literal member that
  rejects a value leaves the pair to the wildcards that follow it, which is
  the same outcome as format 1 ("the alternative follows its pool's
  outcome"). The struct and table streaks stand.
* `{* K => V}`: one unbounded member takes every matching pair, so the map
  is valid iff all pairs match. That is the old table rule.
* Not equivalent, so these change: a required literal member *after* an
  overlapping wildcard (`{* tstr => any, "a" => int}` used to take `"a"` by
  literal priority; PEG gives it to the wildcard).

### 20.11 Oracle and differential testing

* **A new independent PEG oracle**, `corpus/tools/peg-oracle.mjs`. A
  different engineer writes it from RFC 8610 Appendix A, Appendix C, §2.1,
  §3.2, §3.5.3–§3.5.4 and §20.2–§20.3 of this document, without reading kin
  code or this design's prototype. It is a direct recursive interpreter of
  `run`: no tiers, no automaton, no memo, no records. It reuses only the
  oracle's existing CDDL parser and value model, and the type-level `test`
  (unchanged semantics). It has both cut modes and EC pick order,
  its budget gives `unknown` on exhaustion, and its self-tests are the
  §20.3 examples. The existential oracle (`arrayRun`/`mapMatch`) is
  retired. Its 1,840 audit agreements were evidence for the old semantics.
* **snug == PEG oracle** (gate, D022 re-based): every vm-test case set plus
  a generator extended with group choices, nested repetitions with min > 1,
  zero-length bodies, cuts on literal and typeset keys, duplicate literal
  members, recursion, and maps forced into each tier. It runs both cut
  modes, the forced-generic path, schedule 1 and 2, sessions under every
  split (`bb sequence-test` included), and JS == Rust (== wasm when P7.9c
  lands).
* **PEG oracle vs Ruby** (evidence, not a gate): the §20.13 probes plus
  generated cases. A disagreement is triaged into RL/RK/RI/RZ/RR/RO/RX by a
  predicate per class; anything outside the classes is investigated before
  the corpus records an expectation. cddl-rs is optional extra evidence.
* **Corpus expectations that flip** (current corpus, run through the
  prototype in reference mode; the old oracle agreed with every one of the
  old expectations): `adversarial.json` A1 `{ ? (a: int, b: int), ((* tstr
  => int) // (* tstr => tstr)) }` ×2 (`{a:1,b:2,c:"x"}`, `{a:"x",c:"x"}`:
  the first choice alternative succeeds empty and locks in); C6 `[? uint,
  2*3 uint, tstr]` / `[1,1,"x"]`; A3 `[* (int, int), 3*3 uint]` ×3; the
  embedded-sequence-with-backtracking `.cborseq` case; seeded-041 and
  seeded-049 `{ a: tstr, ? b: int // c: int, 0*2 tstr => tstr }`; seeded-043
  `[* ((uint / tstr), tstr), 2*4 (uint / tstr)]` / `[3,"y"]`; seeded-050
  `[? tstr, 0*2 (uint / tstr), 0..2]` / `[0]`. That is 11 cases, all true →
  false. Ruby agrees with the new verdict on 9 of them; the two A1 cases
  are class RK. The 26 `snugSchemaError` suites (21 `map_overlap`, 3
  `map_group_occurrence`, 2 `map_cut`) compile; their cases keep their
  verdicts except seeded-041/049. RFC suites: the D271 cut-scope case
  (`{kind: "a", x: uint // kind: "b", y: tstr}` / `{kind: "b", y: "z"}`)
  is true under `cuts: 'reference'` and false under `'rfc'`. The suite
  format gains a per-suite `options` field. Staged `dependsOn: ["D270"]`
  cases (§3.5.3 indeterminate, §3.11 precedence-2) already match the
  prototype and become gated.

### 20.12 Migration

* **Format 2.0** (program-2 §1). Map tables and array automata change
  meaning, so D084 requires a major version. Staying at 1.x with new leaf
  kinds would keep the existential engine in every VM just to run old
  Programs, with a meaning different from recompiling the same text, which
  is wrong for R1 and costs size (R9). The loader refuses 1.x. SOURCE_KEY's
  preimage gains the format version change and two option values (`cuts`,
  the arena limit), so caches miss rather than serve old meanings. snug is
  0.0.0, so nothing outside the repo stores Programs.
* **Compile option** `cuts: 'reference' | 'rfc'` (default `'reference'`
  pending D271). It is stored in the Program (FLAGS bit 5), because it
  changes verdicts.
* **Conformance corpus additions** (P8.6): every §20.13 probe with a
  verdict per cut mode and the Ruby class as evidence; App. A's examples;
  §3.5.3/§3.5.4/§3.11 cases; zero-length, min > 1 and lock-in cases;
  center recursion and a left-recursion refusal; a `group_limit` case at a
  lowered arena limit; witness cases for each §20.8 rule; split-invariance
  sessions for A1, A2, S and T.
* **Documents**: §4.3/§4.4 and §6 rules 4–5 get superseded notes;
  cddl-support.md loses the D011/D012 refusal list; conformance.md D012,
  D036, S28 (and D021/S26 as an option) are re-audited after landing.
* **Order of work**: P8.4 (valid CBOR, value-correct keys) first, as D270
  says. Then the PEG oracle; compiler + format 2.0; VM buffer driver;
  sessions; corpus; docs.

### 20.13 Probe record (2026-11-04)

Columns: **ref** = §20.2 with `cuts: 'reference'`, EC pick order (the
prototype sorts by the keys' encoded bytes, which equals EC order for these
keys); **rfc** = `cuts: 'rfc'`; **old** = snug today (format 1, default
options); **Ruby** = `cddl` 0.12.14; **Rust** = cddl-rs 0.10.7. ✓ valid, ✗
invalid. Notes: Ruby's deviation class (§20.4); *flips* = old ≠ ref; *was
refused* = old compile refusal; *rfc differs*; *rule A differs* = the
alternative cut reading of Q1. The root rule is always `r`. Data is shown
in wire order, which is canonical for every case except M06.1. A10.1's Ruby
run hung until the 8 s timeout.

| Case | Schema | Data | ref | rfc | old | Ruby | Rust | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A01.0 | `r = [* uint, uint]` | `[1]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A01.1 | `r = [* uint, uint]` | `[1,2]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A02.0 | `r = [? uint, 2*3 uint, tstr]` | `[1,2,"x"]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A02.1 | `r = [? uint, 2*3 uint, tstr]` | `[1,2,3,"x"]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A03.0 | `r = [(int) // (int, int)]` | `[1,2]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A03.1 | `r = [(int) // (int, int)]` | `[1]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A04.0 | `r = [(int, int) // (int)]` | `[1]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A04.1 | `r = [(int, int) // (int)]` | `[1,2]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A05.0 | `r = [2*3 uint, uint]` | `[1,2,3]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A05.1 | `r = [2*3 uint, uint]` | `[1,2,3,4]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A05.2 | `r = [2*3 uint, uint]` | `[1,2]` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| A06.0 | `r = [* (tstr, uint)]` | `["a",1,"b"]` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| A06.1 | `r = [* (tstr, uint)]` | `["a",1]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A07.0 | `r = [(* int, tstr) // (* int)]` | `[1,2]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A07.1 | `r = [(* int, tstr) // (* int)]` | `[1,2,"x"]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A08.0 | `r = [* ((* int, tstr) // int)]` | `[1,2,3]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A08.1 | `r = [* ((* int, tstr) // int)]` | `[1,"x",2]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A09.0 | `r = [2*2 (? int)]` | `[]` | ✓ | ✓ | ✓ | ✗ | ✓ | Ruby RZ |
| A09.1 | `r = [2*2 (? int)]` | `[1]` | ✓ | ✓ | ✓ | ✗ | ✓ | Ruby RZ |
| A10.0 | `r = [* (? int)]` | `[1,2]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A10.1 | `r = [* (? int)]` | `["x"]` | ✗ | ✗ | ✗ | hang | ✗ | Ruby RZ |
| A11.0 | `r = [* (int // tstr), int]` | `[1,"a"]` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| A12.0 | `r = [+ uint, * uint, uint]` | `[1,2,3]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A13.0 | `r = [uint, ? (uint, tstr), uint]` | `[1,2]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A13.1 | `r = [uint, ? (uint, tstr), uint]` | `[1,2,"x",3]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A13.2 | `r = [uint, ? (uint, tstr), uint]` | `[1,2,3]` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| A14.0 | `r = [* (int, int), 3*3 uint]` | `[1,2,3]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A14.1 | `r = [* (int, int), 3*3 uint]` | `[1,2,3,4,5]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A15.0 | `r = [? (int, int), int]` | `[1,2]` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| A15.1 | `r = [? (int, int), int]` | `[1,2,3]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A16.0 | `r = [(int, tstr) // (int, int)]` | `[1,2]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A17.0 | `r = [int, ? g]; g = (int, ? g)` | `[1,2,3]` | ✓ | ✓ | ✓ | ✗ | ✓ | Ruby RR |
| A18.0 | `r = [g]; g = (0, ? g, 1)` | `[0,0,1,1]` | ✓ | ✓ | refused (group_recursion) | ✗ | ✓ | Ruby RR; was refused |
| A18.1 | `r = [g]; g = (0, ? g, 1)` | `[0,1,1]` | ✗ | ✗ | refused (group_recursion) | ✗ | ✗ | was refused |
| A19.0 | `r = [* any, int]` | `[1]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A20.0 | `r = [int] / [int, int]` | `[1,2]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| A21.0 | `r = [* (a: int, b: int)]` | `[1,2,3]` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| A22.0 | `r = [1*3 uint, 2*2 uint]` | `[1,2,3]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| A22.1 | `r = [1*3 uint, 2*2 uint]` | `[1,2,3,4]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F01.0 | `r = { ? (a: int, b: int), ((* tstr => int) // (* tstr => tstr)) }` | `{"a":1,"b":2,"c":"x"}` | ✗ | ✗ | ✓ | ✓ | ✓ | Ruby RK; flips |
| F01.1 | `r = { ? (a: int, b: int), ((* tstr => int) // (* tstr => tstr)) }` | `{"a":"x","c":"x"}` | ✗ | ✗ | ✓ | ✓ | ✗ | Ruby RK; flips |
| F02.0 | `r = [? uint, 2*3 uint, tstr]` | `[1,1,"x"]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F03.0 | `r = [* (int, int), 3*3 uint]` | `[1,1,1]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F03.1 | `r = [* (int, int), 3*3 uint]` | `[1,1,1,1,1]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F03.2 | `r = [* (int, int), 3*3 uint]` | `[1,1,1,1,1,1,1]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F04.0 | `r = bstr .cborseq [? uint,2*3 uint,tstr]` | `h'01026178'` | ✗ | ✗ | ✓ | error | ✗ | Ruby RX; flips |
| F05.0 | `r = { a: tstr, ? b: int // c: int, 0*2 tstr => tstr }` | `{"a":"y","c":0}` | ✗ | ✗ | refused (map_overlap) | ✗ | ✗ | was refused |
| F05.1 | `r = { a: tstr, ? b: int // c: int, 0*2 tstr => tstr }` | `{"a":"x","c":1}` | ✗ | ✗ | refused (map_overlap) | ✗ | ✗ | was refused |
| F06.0 | `r = [* ((uint / tstr), tstr), 2*4 (uint / tstr)]` | `[3,"y"]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F07.0 | `r = [? tstr, 0*2 (uint / tstr), 0..2]` | `[0]` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| F08.0 | `r = {group2}; group2 = (? ab: a / b // cd: c / d); a = 1 b = 2 c = 3 d = 4` | `{"cd":3}` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| M01.0 | `r = {? "optional-key" => int, * tstr => any}` | `{"optional-key":"nonsense"}` | ✓ | ✓ | ✓ | ✗ | ✗ | Ruby RL |
| M02.0 | `r = {? "optional-key" ^=> int, * tstr => any}` | `{"optional-key":"nonsense"}` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M03.0 | `r = {? optional-key: int, * tstr => any}` | `{"optional-key":"nonsense"}` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M03.1 | `r = {? optional-key: int, * tstr => any}` | `{"z":2,"optional-key":1}` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| M04.0 | `r = {* tstr => any, "a" => int}` | `{"a":1}` | ✗ | ✗ | ✓ | ✗ | ✓ | flips |
| M05.0 | `r = {* tstr => any, ? a: int}` | `{"a":"x"}` | ✓ | ✓ | refused (map_cut) | ✗ | ✗ | Ruby RL; was refused |
| M06.0 | `r = {int => int, int => 6}` | `{3:5,4:6}` | ✓ | ✓ | refused (map_overlap) | ✓ | ✗ | was refused |
| M06.1 | `r = {int => int, int => 6}` | `{4:6,3:5}` | ✓ | ✓ | refused (map_overlap) | ✗ | ✗ | Ruby RO; was refused |
| M07.0 | `r = {* (a: int, b: int)}` | `{"a":1}` | ✗ | ✗ | ✗ | ✓ | ✓ | Ruby RI |
| M07.1 | `r = {* (a: int, b: int)}` | `{"a":1,"b":2}` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| M08.0 | `r = {? (a: int, b: int)}` | `{"a":1}` | ✗ | ✗ | ✗ | ✓ | ✓ | Ruby RI |
| M09.0 | `r = {? (a: int, b: int), * tstr => any}` | `{"a":1}` | ✓ | ✗ | ✓ | ✓ | ✓ | rfc differs |
| M10.0 | `r = {(? a: int) // (b: int)}` | `{"b":1}` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| M11.0 | `r = {(a: int) // (a: int, b: int)}` | `{"a":1,"b":2}` | ✗ | ✗ | ✓ | ✗ | ✗ | flips |
| M12.0 | `r = {kind: "a", x: int // kind: "b", y: tstr}` | `{"y":"s","kind":"b"}` | ✓ | ✗ | ✓ | ✓ | ✓ | rfc differs |
| M12.1 | `r = {kind: "a", x: int // kind: "b", y: tstr}` | `{"y":"s","kind":"c"}` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M13.0 | `r = {+ (email: tstr // phone: tstr)}` | `{"email":"a","phone":"b"}` | ✓ | ✓ | ✓ | ✓ | ✗ |  |
| M13.1 | `r = {+ (email: tstr // phone: tstr)}` | `{}` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M14.0 | `r = {2*2 (? a: int)}` | `{}` | ✓ | ✓ | ✓ | ✗ | ✓ | Ruby RZ |
| M14.1 | `r = {2*2 (? a: int)}` | `{"a":1}` | ✓ | ✓ | ✓ | ✗ | ✓ | Ruby RZ |
| M15.0 | `r = {* tstr => int, * tstr => tstr}` | `{"a":1,"b":"x"}` | ✓ | ✓ | ✓ | ✗ | ✗ | Ruby RK |
| M16.0 | `r = {(* tstr => int) // (* tstr => tstr)}` | `{"b":"x"}` | ✗ | ✗ | ✓ | ✓ | ✓ | Ruby RK; flips |
| M16.1 | `r = {(* tstr => int) // (* tstr => tstr)}` | `{"a":1}` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| M17.0 | `r = {1*2 tstr => int}` | `{"a":1,"b":2,"c":3}` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M18.0 | `r = {* (a: int, b: int), * tstr => any}` | `{"a":"x"}` | ✓ | ✗ | ✓ | ✓ | ✗ | rfc differs; rule A differs |
| M18.1 | `r = {* (a: int, b: int), * tstr => any}` | `{"a":1}` | ✓ | ✗ | ✓ | ✓ | ✓ | rfc differs |
| M19.0 | `r = {? ((a: int) // (b: int)), * tstr => any}` | `{"a":"x"}` | ✓ | ✗ | ✓ | ✓ | ✓ | rfc differs; rule A differs |
| M20.0 | `r = {(a: int, b: int) // (* tstr => any)}` | `{"a":1}` | ✓ | ✗ | ✓ | ✓ | ✓ | rfc differs |
| M21.0 | `r = {"a" => int, * tstr => any}` | `{"a":"x"}` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M22.0 | `r = {? "a" => int, * tstr => any}` | `{"a":"x"}` | ✓ | ✓ | ✓ | ✗ | ✗ | Ruby RL |
| M23.0 | `r = {* tstr ^=> uint, * any => any}` | `{"a":"x"}` | ✗ | ✗ | refused (map_cut) | ✗ | ✗ | was refused |
| M23.1 | `r = {* tstr ^=> uint, * any => any}` | `{1:"x"}` | ✓ | ✓ | refused (map_cut) | ✓ | ✗ | was refused |
| M24.0 | `r = {1*2 tstr ^=> uint, * tstr => tstr}` | `{"a":1,"b":2,"c":"x"}` | ✓ | ✓ | refused (map_cut) | ✓ | ✗ | was refused |
| M24.1 | `r = {1*2 tstr ^=> uint, * tstr => tstr}` | `{"a":"x","b":1,"c":2}` | ✗ | ✗ | refused (map_cut) | ✗ | ✗ | was refused |
| M25.0 | `r = {a: int, ? b: int, * tstr => tstr}` | `{"a":1,"b":"x"}` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M26.0 | `r = {a: int, $$x}` | `{"a":1}` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M27.0 | `r = {a: int, * $$x}` | `{"a":1}` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| M28.0 | `r = {(a: int // b: int), (a: int // b: int)}` | `{"a":1,"b":2}` | ✓ | ✓ | ✓ | ✓ | ✗ |  |
| M28.1 | `r = {(a: int // b: int), (a: int // b: int)}` | `{"a":1}` | ✗ | ✗ | ✗ | ✗ | ✓ |  |
| M29.0 | `r = {* (a: int // b: tstr)}` | `{"a":1,"b":"x"}` | ✓ | ✓ | ✓ | ✓ | ✗ |  |
| M30.0 | `r = {? (a: int, b: int), a: int}` | `{"a":1}` | ✓ | ✗ | ✓ | ✗ | ✓ | Ruby RI; rfc differs |
| M31.0 | `r = {(kind: "a", x: int) // (kind: "b")}` | `{"x":1,"kind":"b"}` | ✗ | ✗ | ✗ | ✗ | ✓ |  |
| M32.0 | `r = {? 1 => int, ? (5 => bstr // 6 => bstr)}` | `{5:h'00',6:h'00'}` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M32.1 | `r = {? 1 => int, ? (5 => bstr // 6 => bstr)}` | `{6:h'00'}` | ✓ | ✓ | ✓ | ✓ | ✗ |  |
| M33.0 | `r = {? a: int, ? a: tstr}` | `{"a":"x"}` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| M34.0 | `r = {? "a" => int, ? "a" => tstr}` | `{"a":"x"}` | ✓ | ✓ | ✗ | ✗ | ✗ | Ruby RL; flips |
| M35.0 | `r = {* int => tstr, 1 => tstr}` | `{1:"x"}` | ✗ | ✗ | ✓ | ✗ | ✓ | flips |
| N01.0 | `r = {? (a: int), * tstr => any}` | `{"a":"x"}` | ✓ | ✗ | ✓ | ✓ | ✗ | rfc differs; rule A differs |
| N02.0 | `r = {* (a: int), * tstr => any}` | `{"a":"x"}` | ✓ | ✗ | ✓ | ✓ | ✗ | rfc differs; rule A differs |
| N03.0 | `r = {(a: int) // (* tstr => any)}` | `{"a":"x"}` | ✓ | ✗ | ✓ | ✓ | ✓ | rfc differs |
| N04.0 | `r = {? ("a" => int), * tstr => any}` | `{"a":"x"}` | ✓ | ✓ | ✓ | ✓ | ✗ |  |
| N05.0 | `r = {(a: int, b: int) // (a: tstr)}` | `{"a":"x"}` | ✓ | ✗ | ✓ | ✓ | ✓ | rfc differs |
| N06.0 | `r = {? (a: int, b: tstr), * tstr => any}` | `{"a":1,"b":2}` | ✓ | ✗ | ✓ | ✓ | ✗ | rfc differs; rule A differs |
| N07.0 | `r = {a: int // b: int}` | `{"a":1,"b":2}` | ✗ | ✗ | ✗ | ✗ | ✗ |  |
| N08.0 | `r = {* tstr => int, ? "a" => tstr}` | `{"a":"x","b":1}` | ✓ | ✓ | ✓ | ✗ | ✗ | Ruby RK |
| N09.0 | `r = {+ a: int}` | `{"a":1}` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| N10.0 | `r = [* int, ? tstr, * int]` | `[1,"x",2]` | ✓ | ✓ | ✓ | ✓ | ✓ |  |

### 20.14 Open questions for the independent review

1. **Reference cut mode.** Is the D021 translation right? A cut failure
   fails the member, and an enclosing `?(…)`/`*(…)` or `//` may then
   recover. It reproduces Ruby and format 1, but it makes `? (k: v)` differ
   from `? k: v` (N01 vs M03). The alternative ("rule A": a cut failure also
   passes through repetitions and is absorbed only by `//`) honours §3.5.4's
   "later entries … no longer allowed", but no tool implements it (M18, M19,
   N01, N02, N06).
2. **RFC cut mode.** Is "commit on key match, value matching or not; then
   every enclosing choice *and repetition* in the map's group is disabled;
   an enclosing type choice is not" the right formalisation of App. A plus
   §3.5.4? It rejects `{? (a: int, b: int), * tstr => any}` / `{a: 1}` (M09).
3. **Pick order.** EC key order makes verdicts independent of the
   serialisation. It reuses §19.4's deferred duplicate check (its sort
   order for marked maps, wire order otherwise), so it adds no comparisons,
   only a kept permutation, but it couples P8.5 to §19's records. Is that
   better than wire order (simpler and Ruby's choice, but
   serialisation-dependent for §3.5.3's pathological schemas)?
4. **Zero-length iterations (R4).** Is "stop and count as satisfied" the
   right reading, or should a zero-length iteration count once and the loop
   continue up to the minimum (the same verdicts, different charges)?
5. **Lock-in consequences (R1, R5).** `[(int) // (int, int)]` rejects
   `[1, 2]`, and `{(? a: int) // (b: int)}` rejects `{b: 1}`. Is any RFC
   text an argument for retrying alternatives at the end of an array or for
   closedness?
6. **Superset lemma (§20.5).** Prove or break it for the relaxed automaton,
   including context-insensitive `CALL` approximation, unwrapped choices,
   generics and `.cborseq`.
7. **FL and B.** Is B (max FL over backtrack points) exactly the ring the
   incremental machine needs, so that it never rewinds before i − B? Check
   the last alternative of a choice, `REP` with lo > 0 inside a `SEQ`, and
   nested repetitions.
8. **Memoisation.** Do the re-entrancy and multi-start analyses plus link
   cells give O(|G|·n) as claimed? Should memo cells be left out of 2.0
   entirely (no A2 group in the corpus) and the budget relied on, with a
   reserved field for later?
9. **Tier equivalence.** Check the F pair-major proof with cut events and
   minimums. Check S when a root non-literal member *precedes* a literal
   subtree in source order: the member takes named slots before the
   subtree runs. Is the order of slot consumption then exactly the PEG's?
10. **Witnesses.** Are farthest-failure (arrays) and the failure trace with
    "most pairs consumed" (maps) deterministic and tier-independent? Is
    losing format 1's deep witness at end-of-map failures acceptable?
11. **`group_limit`.** Is a resource refusal of valid data acceptable, or
    should records be priced so that the budget always runs out before the
    arena?
12. **Charges.** Is one unit per PEG step, ⌈R/16⌉ per record and one per
    trail entry in line with D241's equal-CPU-per-unit target? Measure it
    before adopting.
13. **Format.** Is 2.0, with 1.x refused, the right call under D084, rather
    than a 1.2 that keeps both engines?
14. **Fail-fast pairs.** Is "a pair no member can take dooms the map" sound
    in both cut modes and every tier, so that early death never changes a
    verdict?
15. **Query supersets.** Relaxed queries can call EXT predicates and
    evaluate nested containers against positions the PEG never tests. Is
    that acceptable (it is deterministic), or should the PEG prune queries
    in A0, where the next tested positions are known exactly?
16. **Literal priority loss.** Format 1 gave literal entries priority over
    wildcards whatever the source order. PEG follows source order
    (`{* tstr => any, "a" => int}` now matches nothing containing `"a"`).
    Should the compiler warn when a required member can never match?
