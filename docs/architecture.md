# snug — architecture

Status: **design, revision 1 (2026-10-29)**, provisional. Written before any
code; it is the thing the independent design review (DEVLOG P0.4) reviews.
Decisions it rests on are numbered in `DEVLOG.md` (`D###`) and cited inline.
Nothing here is owner-approved.

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
| R1 | **Sound** CDDL matching: closed maps under group choices, optional groups, member names equal to rule names, anchored regexps, cuts. | study §0 items 1, 3; §3.1 |
| R2 | **Linear time** in the input, with a hard, explicit **step budget**; no input can make validation super-linear or exceed the budget silently. | study §4 (323 ms, 205 ms), Worker 100 ms CPU |
| R3 | **Bounded memory**, sized when a schema is compiled; validation allocates nothing proportional to the input. | study §4 (71 MB linear memory that never shrinks) |
| R4 | **No panics or traps** on any input bytes or any schema text. Every failure is a value. | study §6 (32 + 94 traps) |
| R5 | Errors carry a **reason code and a path only**. Never a payload value, never input bytes; data map keys that the schema does not name are `*`. | study §1, §4; profile §5 |
| R6 | **Deterministic** across hosts: same verdict, same reason, same path, same budget exhaustion point in JS and Rust. | owner constraint; kin's purpose |
| R7 | **Strict CBOR profile** at least as strict as cbor.mjs, passing `tests/vectors/cbor-*.json` (corpus copies under `corpus/cbor-vectors/`). | owner constraint |
| R8 | **Single pass** over the bytes where possible; streaming-compatible structure. | owner constraint |
| R9 | **Small**: the JS bundle (compiler + validator + codec) targets ≤ 40 KB min+gzip. | browser and Worker bundles |
| R10 | **Untrusted schemas** (event-bus manifests) compile under explicit limits, and a profile can forbid features (regexp, sockets, unbounded containers). | study §8 |
| R11 | Integers of any size, exact; no host floats in any decision. | profile §3; study §3.1 (wasm32 integer bug) |

---

## 2. Shape of the system

```
          CDDL text ──► [compiler] ──► Program (Int32Array + byte pool)
                          kin             │   cacheable, versioned, hashed
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
  profile's determinism rules (§5.3, §5.4), and lowers to a **Program**: a
  flat `Int32Array` plus a byte pool. No pointers, no host objects.
* **Validator VM** (kin): walks CBOR bytes once, checking the strict CBOR
  profile *and* the Program at the same time ("fused", §4). It reads bytes and
  32-bit integers only. It never allocates during a validation: its scratch
  arenas are sized by the compiler and owned by the compiled schema.
* **Value builder** (host): turns already-validated bytes into host values
  (JS objects, `bigint`, typed arrays, decimal and ndarray wrappers). Because
  the VM has proven the bytes valid, the builder performs no checks; it is the
  only part that allocates in proportion to the input.
* **Encoder** (host): host values to deterministic CBOR.
* **Profile-only decode** is the VM run against the built-in `any` Program
  followed by the builder, so there is exactly one implementation of the
  profile's refusals, and it is in kin.

Why this split (D003, D004): the value model is the one thing that is
genuinely different per host (a JS object, a Rust enum), and it is also the
part that allocates. Everything that decides *accept or refuse* is integer
logic over bytes, which is exactly what kin is for, and is where cross-host
determinism matters.

---

## 3. Representation: bytes and int32, nothing else

All kin code operates on `Uint8Array`/`&[u8]` input, `Int32Array`/`Vec<i32>`
arenas and 32-bit integers. This is what makes the VM fast in JS (no
allocation, monomorphic integer code V8 optimises well) and identical across
hosts.

* **Integers** are never materialised. A CBOR integer is (major, argument
  bytes); a bignum is (tag, content bytes). Range bounds in the Program are
  stored the same way: sign plus minimal big-endian magnitude. Comparison is
  sign, then magnitude length, then bytes (with the order flipped for major 1,
  whose value is −1−n). Any size works, 2^53 and 2^64 are not special, and the
  wasm32 integer bug of the study cannot exist (R11).
* **Floats** are never converted to host floats for a decision. The profile's
  float rules (shortest form, no NaN/±∞/−0, no integral float within
  ±(2^53−1)) are bit tests on the 16/32/64-bit pattern. Float ranges compare
  the pattern after widening to binary64 bits by integer operations and the
  standard sign-magnitude-to-ordered transform, as two 32-bit halves.
* **Text** is validated as UTF-8 (scalar values only, no noncharacters, as
  cbor.mjs) while it is read; `.size` counts bytes (RFC 8610); a regexp runs
  over code points decoded on the fly.
* **Literals** (text, bytes, ints, floats, `true`/`false`/`null`) are stored
  as their **deterministic encoding** in the byte pool. Equality with a literal
  is a byte comparison against the item's encoded span. This is correct
  because the profile admits exactly one encoding per value (profile §1), and
  it is why integer `1` and float `1.0` can never be confused (the latter is
  refused by the profile).
* **Map keys** are compared by their encoded bytes, which is also the
  profile's key order (RFC 8949 §4.2.1 bytewise lexicographic).

---

## 4. Validation semantics: one pass, type sets

### 4.1 The core idea

A CDDL schema denotes a **tree automaton** over CBOR items. The VM evaluates
it top-down with **on-the-fly subset construction**: each data item is visited
exactly once, against the **set** of leaf types it might still be, and returns
the **subset** that matched.

    eval(item, S) → M ⊆ S

* A type choice `A / B` contributes both `A` and `B` to the set; nothing is
  tried "first" and nothing is retried.
* For a container item, the VM computes from `S` the set each child might be,
  evaluates the child **once** against that set, and uses the matched subset
  to advance the state of every candidate in parallel.

Because no item is evaluated twice, there is no backtracking and no
exponential case, and no memo table is needed: the work is
`Σ over items of |S_item|`, bounded by `items × width`, where width is bounded
at compile time (§7). This is the same move RE2 makes for regular expressions
(simulate the NFA, never backtrack), lifted to trees. A lazy cache of
`(set, transition) → set` (a lazy DFA) is an optimisation for later (P3.x), not
part of the semantics.

The alternative most implementations take, and which the `cddl` crate takes,
is ordered trial with backtracking over a decoded tree. It is the root of the
study's CPU blowups (a choice re-validates a 1 MiB child per alternative and
formats an error each time) and, combined with greedy local decisions, of its
unsound map matching.

### 4.2 Leaves and sets

The compiler flattens every type expression into a **typeset**: a sorted list
of **leaf** ids. Leaves are hash-consed, so the same leaf reached through two
rules is one id and is evaluated once per item. Leaf kinds:

| Leaf | Matches |
| --- | --- |
| `ANY` | any item (still profile-checked) |
| `MAJOR m` | any item of major type m (`#0`, `#1`, `#2`, `#3`, `#4`, `#5`) |
| `INT lo hi` | major 0/1 (and, if the leaf allows bignums, tag 2/3) within bounds |
| `FLOAT widths lo hi` | float of the allowed encoded widths, optional bounds |
| `LIT k` | exactly the pool literal k (byte equality) |
| `NOTLIT k` | `.ne` against a literal |
| `TEXT size regexp chars` / `BYTES size bits cbor cborseq` | string with constraints |
| `UINTX size bits` | `uint .size n`, `uint .bits b` |
| `SIMPLE v` | `#7.v` |
| `TAG n content` | tag n whose content matches typeset `content` |
| `ARRAY nfa` | array accepted by an NFA (§4.4) |
| `MAP table` | map accepted by an alternative table (§4.3) |
| `AND a b` | `.and`/`.within`/control combinations that do not fold (§4.6) |

Each leaf has a precomputed **major mask** (which initial-byte major types it
can accept). On reading an item's head, the VM filters `S` by the mask in one
pass, so an item is only ever compared with leaves of its own kind.

### 4.3 Maps

**Normal form.** Each map type's group is expanded into **alternatives**
(disjunctive normal form over `//`, optional groups `? ( … )` and group
occurrences), each alternative being a list of **entries**
`(key, value-typeset, min, max, cut)`. A key is either a **literal key** (a
pool literal: `name:`, `"name" =>`, `1:`) or a **key typeset** (`tstr =>`,
`uint =>`, `any =>`). Within one alternative, literal keys are distinct
(duplicates are a schema error). The expansion is bounded (§7); independent
optional groups whose key sets are disjoint are kept as separate **factors**
rather than multiplied out (§4.3.4), so `{ ? (a, b), ? (c, d), … }` does not
blow up.

**Combined evaluation.** For a map item and set `S`, the VM gathers every
alternative of every `MAP` leaf in `S` into one live set and makes one pass
over the pairs:

1. Read the key. Look its encoded bytes up **once** in the schema-wide literal
   key table (open addressing over a hash of the key bytes), giving a literal
   key id or none. If any live alternative has key-typeset entries, evaluate
   the key item once against the union of those key typesets.
2. Collect the **value set**: the union of value typesets of every entry, in
   any live alternative, whose key matched. Evaluate the value item once
   against it.
3. For each live alternative, assign the pair (§4.3.2) or kill the
   alternative.
4. If no alternative is live, fail here (§6).

At the end, kill alternatives with an entry below its minimum. The matched
subset is the `MAP` leaves with a surviving alternative. Because keys arrive
in the profile's sorted order and duplicates are refused by the profile scan,
a literal key can be consumed at most once per alternative without a "seen"
check beyond the entry counter.

#### 4.3.1 Why this is sound where the crate is not

The crate decides membership with local, greedy checks against one
alternative at a time and reuses state across alternatives, which is how
`{ a: int, b: int // a: int }` accepts `{a: 1, b: "x"}` and how `key: key`
loses track of a required member. Here every alternative carries its own
counters; an alternative is closed (a pair no entry of *that* alternative takes
kills it); and an optional group is an alternative with and without the whole
group, never a set of independently optional members. Rule names and member
names live in different namespaces after parsing (a member name is a pool
literal), so `key: key` cannot collide.

#### 4.3.2 Assignment: greedy priority, proven equal to RFC semantics

RFC 8610 map matching is existential: some assignment of pairs to entries
satisfies every occurrence. Searching assignments is a bipartite matching
problem; snug instead assigns greedily and **refuses at compile time any map
in which greedy and existential could disagree** (D011):

* Priority: literal-key entries first, then key-typeset entries in source
  order. A pair goes to the first entry whose key and value matched and whose
  counter is below its maximum.
* A **cut** (`^ =>`, and every `name:`/`value:` member, which implies a cut,
  RFC 8610 §3.5.4) on a literal-key entry whose key matched and whose value did
  not kills the alternative. Without a cut the pair may fall through to a
  key-typeset entry.
* **Determinism rule.** If two entries of one alternative have overlapping key
  domains, the lower-priority one must be *absorbing* (min 0, max unbounded).
  Under that rule greedy succeeds whenever some assignment does: giving a pair
  to the higher-priority entry only raises that entry's count toward its
  minimum, and the absorbing entry has no constraint to violate. Overlap is
  decided conservatively at compile time (literal vs literal: byte equality;
  literal vs typeset: run the VM on the literal's encoding; typeset vs
  typeset: overlapping major masks and not provably disjoint), so a schema can
  be refused that RFC semantics would allow; it is never accepted with a
  different meaning. Everyday maps (`{ a: int, ? b: tstr }`, open maps
  `{ a: int, * tstr => any }`, tables `{ * tstr => T }`) all pass.

#### 4.3.3 Occurrence on groups inside maps

A group with occurrence inside a map: a group of only literal-key entries
cannot repeat (keys are unique), so `*`/`+`/`n*m` on it clamps to at most one
copy (and a minimum above one is unsatisfiable, a schema error). A group of only
key-typeset entries multiplies the entries' occurrences. A mixed group with a
maximum above one is refused. This is the reading under which the RFC's
existential semantics and unique keys coincide.

#### 4.3.4 Factors

Alternatives are stored as a product of **factors**. Each factor owns a set of
literal keys disjoint from every other factor's and has its own small
alternative list; key-typeset entries live in one residual factor. A pair is
routed to the factor owning its literal key (or to the residual), and the map
matches when every factor has a surviving alternative. `k` independent
optional groups cost `2k` alternatives instead of `2^k`. Factorisation is
exact because factors share no key, so their assignments do not interact
(the residual is evaluated last against the pairs no factor owns).

### 4.4 Arrays

Each array type's group compiles to a **Glushkov automaton** (no ε-moves):
positions, each with a typeset, a `first` set, `follow` sets and accepting
positions. Member names inside arrays are labels only (RFC 8610 §3.4).

**Combined evaluation.** For an array item and set `S`, the live state is the
union of the active position sets of all `ARRAY` leaves in `S`. For each
element: the element's candidate set is the union of the typesets of every
position reachable in one step; the element is evaluated once; the next state
is every reachable position whose typeset matched. At the end, a leaf matches
if one of its accepting positions is active (or its group is nullable and the
array is empty). This is exact regular-language semantics, not greedy: unlike
the crate (whose README warns that occurrences beyond the first indicator are
matched greedily), `[* int, tstr]` and `[* int, int]` mean what the RFC says.

**Counters.** `[* T]` is a loop. Bounded occurrence `n*m` on a **single
entry** compiles to one position with a counter, provided the entry's typeset
is disjoint from every position that can follow it (so the count is never
ambiguous; checked at compile time). Otherwise bounded repetitions are
unrolled, up to the position limit (§7); beyond it the schema is refused
(D012). `[0*1048576 uint]` is therefore one counted position.

### 4.5 Tags, typed arrays and the fused profile checks

The profile allows tags 2, 3, 4, 40 and the RFC 8746 little-endian typed
arrays only. The VM checks their structure whatever the schema says (bignum
length 9..128 with no leading zero; decimal `[exp, mant]` normalised with
`−1024 ≤ exp < 0`; tag 40 shape 1..8 positive dimensions whose product equals
the element count, data a typed array or array; typed array length a multiple
of the element size; no NaN in float arrays). A `TAG n` leaf then evaluates
the content against its content typeset like any other child. Tag-40 element
counts and typed-array lengths are checked from the bytes, without decoding
elements.

### 4.6 Controls

| Control | Lowering |
| --- | --- |
| `.size` | text/bytes: byte-length bounds; uint: value bound `< 256^n` |
| `.bits` | allowed-bit mask in the pool (uint: bit positions; bstr: RFC 8610 §3.8.2 numbering) |
| `.lt .le .gt .ge .eq .ne` | numeric literal: folded into `INT`/`FLOAT` bounds; `.eq`/`.ne` with any literal: `LIT`/`NOTLIT` |
| `.and`, `.within` | folded when both sides are the same scalar kind (range intersection); otherwise an `AND` leaf whose operands join the item's set |
| `.regexp` | RFC 9485 I-Regexp, anchored, compiled to a code-point NFA run bit-parallel (§4.7) |
| `.cbor T` | content of the byte string is validated as one CBOR item against T, in the same pass, counting toward depth, items and budget |
| `.cborseq T` | content is a sequence of items matched against array type T's automaton |
| `.default` | annotation; no effect on validation |
| `.cat`, `.det`, `.plus` (RFC 9165) | compile-time constant folding (later phase) |
| `.pcre`, `.abnf`, `.abnfb`, `.feature` | refused (D013) |

### 4.7 Regular expressions

`.regexp` is RFC 9485 I-Regexp, matched against the **whole** string (RFC
8610 §3.8.3; the crate does not anchor). It compiles to a position automaton
over code-point ranges and runs bit-parallel over the code points (one word
per 32 positions), so matching is `O(length × ⌈positions/32⌉)` with no
backtracking, independent of the host regex engine (JS `RegExp` backtracks and
differs from Rust's `regex` at the edges). Counted repetition `{n,m}` unrolls
up to the regexp position limit. Revision 1 refuses `\p{…}`/`\P{…}` (Unicode
category tables would cost about 10–20 KB in every bundle); the multi-character
escapes `\d \w \s` are not in I-Regexp either and are refused with a reason
naming the I-Regexp rule (D014).

### 4.8 Semantic notes that follow from the profile

* `float16`/`float32`/`float64` mean the **encoded width**. Under shortest-form
  encoding, `float64` matches only values that need 64 bits and `float32`
  refuses `1.5` (encoded as float16). This is RFC-correct and surprising;
  contracts should say `float`. The compiler warns on `float32`/`float64`.
* `uint` is major type 0 only (RFC 8610 prelude `uint = #0`); `integer` and
  `unsigned` include bignums. The crate accepts tag 2 for `uint`; snug does
  not.
* `number` is `int / float` per the prelude; decimals are not numbers.

---

## 5. The compiler

### 5.1 Pipeline

1. **Lex** UTF-8 bytes (RFC 8610 Appendix B, RFC 9682 updates) into tokens
   held as integer spans.
2. **Parse** with a hand-written recursive-descent parser into an AST arena
   (node kind, children, span), depth-limited. Ambiguous `name = ( … )` rules
   are parsed as type-or-group and settled by the resolver, following the
   grammar's ordered choice.
3. **Resolve** names (rules, sockets `$x /=`, `$$x //=`), compose `/=` and
   `//=` additions, unwrap `~`, enumerations `&`, and instantiate generics
   by monomorphisation memoised on `(rule, argument typesets)`, with an
   instantiation limit.
4. **Check productivity**: a rule that reaches itself without passing through
   a map, array or tag is refused (`a = a / int`, `g = (x: int, g)`).
   Recursion through structure (`node = [* node]`) is fine; its runtime depth
   is bounded by the profile's depth limit.
5. **Normalise**: flatten choices into typesets, fold controls, hash-cons
   leaves, expand map groups into factors and alternatives (§4.3), build array
   automata (§4.4), compile regexps (§4.7), and apply the determinism rules,
   each refusal naming the rule and source line.
6. **Lower** to the Program (§5.2) and compute the scratch sizes the VM needs
   (§8).

The prelude (RFC 8610 Appendix D) is CDDL text compiled with the user's text,
so it is defined in exactly one place. Tags the profile refuses (`tdate`,
`uri`, `bigfloat`, …) remain in the prelude and simply never match valid
profile data.

### 5.2 The Program (interface between compiler and VM)

One `Int32Array` with a header and sections, plus one `Uint8Array` pool. All
references are section-relative integer offsets; there are no host objects.

| Section | Contents |
| --- | --- |
| header | magic `SNUG`, format version, hash of the schema text and options, section offsets, scratch sizes, limits baked in |
| rules | exported rule names (pool spans) → root typeset |
| typesets | length-prefixed sorted leaf id lists |
| leaves | `kind, major-mask, operands…` fixed-width records |
| literal keys | open-addressing table: key-bytes hash → literal key id; per id, pool span |
| maps | per `MAP` leaf: factors → alternatives → entries `(key-lit-id or key typeset, value typeset, min, max, cut)`; per alternative a small sorted `(key-lit-id → entry)` index |
| arrays | per `ARRAY` leaf: positions `(typeset, min, max)`, first, follow lists, accepting set |
| regexps | per regexp: position count, code-point range classes, follow masks |
| bits/ranges | `.bits` masks, numeric bounds (pool spans) |
| pool | literal encodings, rule and member names, bound magnitudes |

The exact field layout is specified in `docs/program.md` (owned by the
compiler work item, reviewed by the VM work item, frozen before either is
implemented past a spike; D015). A Program is produced in-process by the
compiler. If a host caches it, it is loaded through a structural verifier
(every offset in range, every id below its count, acyclic where required) so
that a corrupted cache can only be refused, never crash the VM.

### 5.3 Profiles

The compiler takes a **profile**: a set of feature switches and limits.

* `full` — everything §4 supports.
* `bindle` — the study's §9.1 profile: no sockets, no `.cborseq`, no unwrap,
  no cuts beyond the implied ones, non-recursive generics, text and integer
  map keys only.
* `bus` — `bindle` minus `.regexp`, every string and container bounded, schema
  text ≤ 16 KiB (study §9.1 "bus manifests").

Profiles only ever refuse; they never change the meaning of a schema they
accept.

---

## 6. Errors

A failed validation returns `{reason, path}`.

* **Reasons** (stable codes): `type`, `missing`, `unexpected`, `value`,
  `size`, `range`, `pattern`, `tag`, `bits`, `embedded`, `cbor` (profile
  refusal, with the profile sub-code: `non_shortest`, `indefinite`,
  `key_order`, `duplicate_key`, `key_type`, `text`, `float`, `bignum`,
  `decimal`, `typed_array`, `ndarray`, `simple`, `trailing`, `truncated`), and
  limit codes (`depth`, `too_many_entries`, `too_many_items`, `too_large`,
  `budget`). The CBOR sub-codes are cbor.mjs's `CBORFault` codes, so 3sln.me's
  vectors can assert them.
* **Path**: a list of segments, each an array index, a schema literal key
  (named by its pool id, rendered from the schema text, never from the data),
  `*` for a data key the schema does not name, or `#tag`.
* **Which failure is reported.** Validation fails at the first point, in
  document order, where the set of live possibilities becomes empty, or at the
  first profile violation, whichever comes first; the VM stops there. A child
  item whose own set empties reports from inside itself. If the child matched
  something but every parent alternative died at that pair, the parent reports
  `value` (a key some alternative named) or `unexpected` (none did) at the
  pair's path. Missing members are reported at map end from the first
  alternative, in compile order, among those that survived longest. All of
  this is a function of the bytes and the Program only (R6).
* Schema compile errors are `{code, line, column, rule}` and may quote schema
  text (the schema is not payload).

---

## 7. Limits

Every limit is explicit, has a default and a hard maximum, and is part of the
Program header so a Program records what it was compiled under.

| Limit | Default | Hard max | Where |
| --- | --- | --- | --- |
| schema text bytes | 256 KiB (`bus`: 16 KiB) | 1 MiB | compile |
| AST nodes | 65 536 | 1 048 576 | compile |
| generic instantiations | 1 024 | 16 384 | compile |
| alternatives per map factor | 64 | 1 024 | compile |
| array positions per array type | 256 | 4 096 | compile |
| regexp positions | 256 | 2 048 | compile |
| typeset width (leaves in any reachable set) | 256 | 4 096 | compile, checked conservatively |
| Program size (int32 words) | 1 Mi | 16 Mi | compile |
| input bytes | 1 500 000 | 2^31 − 1 | validate (profile) |
| depth (a tag counts) | 32 | 256 | validate (profile) |
| entries per container | 65 536 | 2^24 | validate (profile) |
| items per message (typed array = 1) | 131 072 | 2^24 | validate (profile) |
| bignum content bytes | 128 | 4 096 | validate (profile) |
| step budget | 4 000 000 | 2^31 − 1 | validate |

**The step budget** charges one unit per (item, leaf) evaluation, one per
(pair, live alternative) assignment, one per (element, active position)
transition, and `⌈positions/32⌉` per code point per regexp. Exhausting it is
the `budget` reason, reached at the same point on every host. The default is
sized from measurement in Phase 4 so that the worst budget-bounded input stays
under 50 ms in workerd on the reference machine (to be recorded).

---

## 8. Memory model

* **Compiled schema** = Program + scratch arenas, sized by the compiler from
  the limits and widths: a set stack (depth × max width), map alternative
  counters (depth × max live alternatives × entries), array state (depth × max
  positions), regexp state vectors, the path stack. All `Int32Array`, allocated
  once per compiled schema, reused by every validation. JS is single-threaded
  and validation is synchronous, so a schema's scratch is never shared by two
  validations at once; a re-entrant call (from a host callback) is impossible
  because the VM calls no host code.
* **Validation** allocates nothing. Input is read in place (no copy into
  another heap, unlike the wasm build in the study, which copies every input
  into linear memory that never shrinks).
* **Builder** allocates exactly the output values.
* **Recursion.** The VM recurses on containers, bounded by the depth limit
  (default 32, max 256) plus `.cbor` nesting (which counts toward depth), so
  host stack use is bounded and small. An explicit-stack VM, which would allow
  resuming on chunked input, is deferred (D016): 3sln.me receives whole bodies
  of at most 1.5 MB, and recursion is faster in JS.

---

## 9. The codec

* **decode(bytes, opts)** = VM against `any` (profile checks), then the
  builder. **schema.decode(bytes, rule)** = VM against the rule, then the
  builder: one checking pass and one building pass, no allocation before the
  message is known to be valid, so a hostile 1.5 MB message costs one scan.
* **Value mapping** follows profile §2 and §6 exactly (numbers within
  ±(2^53−1), otherwise `bigint`; fresh `Uint8Array` copies; null-prototype maps
  by default or `Object.prototype` maps with members defined, never assigned;
  `Decimal` (tag 4), `NDArray` (tag 40), native typed arrays or `Float16Bytes`).
  snug names its wrapper classes generically; 3sln.me can adopt them or pass
  its own constructors.
* **encode(value, opts)** is hand-written JS mirroring cbor.mjs's rules
  (shortest heads and floats, key sort by encoded bytes, refusals, `cose` and
  `omitUndefined` options). Its output is checked by decoding it in tests.
* A **fused single-pass decode** (the VM driving the builder through
  callbacks) is the obvious next step if the two-pass design measures badly; it
  is deferred (D017) because it puts host calls in the hot loop and gives up
  "nothing allocated before the message is valid".

---

## 10. Targets

* **JavaScript** through a kin JS target defined in snug's own tree (a
  `kin.lang` extension map plus a target map), the experiment the owner
  allowed (D005). Output: ES2022 modules, `Int32Array`/`Uint8Array`, integer
  operations coerced with `| 0` and `>>> 0` where the vocabulary's tag says
  so.
* **Rust** through kin's shipped Rust target; the Rust host is used for
  native tests, differential testing against the `cddl` crate (natively, so
  the crate's wasm32 integer bug does not muddy the oracle), and a
  `wasm32-unknown-unknown` build for the JS-host comparison.
* **Go, Java, C#** are not targets in revision 1 (D006). The vocabulary is
  written so that adding them is adding arms.

**The JS target is an experiment with an exit.** Phase 1 builds it and
measures the generated profile scanner against a hand-written JS scanner and
against the same kin source compiled to wasm. Criteria (D005): generated JS no
worse than 1.25× hand-written on the scanner benchmark and smaller than the
wasm build after gzip; otherwise JS consumers get the wasm build with a
hand-written JS host, as emon and nome do (emon D001).

---

## 11. Alternatives considered

| Alternative | Verdict |
| --- | --- |
| Validate host values decoded by the strict codec (the study's §9.1 recommendation: a JS validator over decoded values) | Rejected as the core: it is host-specific (one implementation per language, no kin), it allocates the whole value before refusing, and set-based evaluation over a tree is the same algorithm either way. Value-level checks remain possible as encode-then-validate, which 3sln.me does anyway for results it sends. |
| Ordered trial with backtracking plus memoisation of `(item, type)` | Rejected: memo tables are memory proportional to the input (R3) and still need error-shaping per alternative. |
| Precompiled full DFA over typesets | Rejected: state explosion on choice-heavy schemas. A lazy, bounded cache is a later optimisation. |
| Bipartite matching for maps | Rejected for revision 1: the determinism rule (§4.3.2) makes greedy exact on every map the study transcribed; matching can be added for refused schemas if one matters. |
| Host regex engines | Rejected: backtracking (ReDoS) in JS, divergent semantics across hosts (R6). |
| The Rust `cddl` crate, patched, compiled to wasm | Rejected per the study §9.2; kept as a native development oracle. |
| Fused single-pass decode + validate + build | Deferred (D017); measured in Phase 4. |
| Writing the compiler by hand in JS only, with only the VM in kin | Rejected: the compiler enforces the untrusted-schema limits and the determinism rules, which must agree across hosts; and a Rust consumer would have no compiler. |

---

## 12. Benchmark plan (Phase 4; numbers recorded in `bench/README.md` with environment)

All on one machine, Node 24 and local workerd, median of interleaved runs,
warm and cold, answers checked:

1. **Profile decode** of the 3sln.me vectors and synthetic RPC bodies (small
   287 B put; 1 MiB `bstr` put; 120 000-item array; 1 MiB typed arrays; nested
   maps): snug decode vs cbor.mjs decode.
2. **Encode**: snug vs cbor.mjs on the same values.
3. **Validate** the six study contracts with their probe values: snug (JS) vs
   snug (wasm via Rust) vs the `cddl` crate's wasm build from the study.
4. **Hostile**: the study's crafted inputs (invalid 1.4 MB against a six-way
   choice; 2^32−1 declared lengths; 10^6-deep nesting) — time and memory high
   water, must be bounded.
5. **Compile** time for each contract and for a 16 KiB generated schema.
6. **Size**: min+gzip and brotli of the JS bundle; wasm size after
   `wasm-opt -Oz`.
7. **Kin cost**: the generated JS scanner vs a hand-written JS scanner (the
   D005 criterion).

---

## 13. Open questions (not to be guessed)

1. Project controls 3sln.me needs and CDDL lacks (equal-length columns,
   uniqueness, code-point length, decimal value bounds): names and whether
   they belong in snug or in a 3sln.me extension hook. Deferred to the owner.
2. Whether `\p{…}` support is worth its table size.
3. Whether a Program serialisation format should be stable across snug
   versions (cacheable in Workers KV) or always recompiled.
