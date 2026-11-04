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
| R9 | **Small**: runtime (VM + builder + encoder) ≤ 20 KB min+gzip; compiler a separate, lazily loadable module (target to be measured). | browser and Worker bundles |
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
| a registered `.name` | extension control (D082, D140–D142): `AND(target leaf, EXT)` per target leaf; the EXT is decided by a host predicate over the item's encoding, only when the AND needs it, after the item's profile walk, charged per item byte, bounded by the control's maximum item size (program.md §4.2, format 1.1). Unregistered: `unknown_control` naming it. |

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
* Undefined sockets: an undefined type socket `$x` matches nothing; an
  undefined group socket `$$x` is the empty group (so `{ a: int, $$x }`
  accepts `{a: 1}`; crate issue #838).

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
