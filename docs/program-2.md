# snug — Program format 2.0 (draft)

Status: **draft for independent review (2026-11-04)**. Not implemented,
not frozen, not owner-approved. It implements architecture §20 (PEG group
semantics, D270, D271) on paper. It is a **delta** against
[program.md](program.md) (format 1.1): every section, field, rule and charge
not mentioned here is unchanged, including leaves other than ARRAY/MAP,
typesets, literal keys, regexps, closure sets, EXT and the scanner block.
When it is accepted it is merged into program.md and this file is deleted.

---

## 1. Version and compatibility (D084)

* `FORMAT_VERSION` (header word 1) = `0x00020000` (major 2, minor 0). A
  format 2 loader refuses every 1.x Program (1, `0x00010001`). A 1.x loader
  refuses 2.0 (its check is exact).
* **Why a major version.** Format 1's map tables (S5–S8: residual groups,
  factors, pools, alternatives) and array automata (S9/S10 with counters)
  encode existential semantics. Their words cannot be reinterpreted under
  PEG, and D084 says a change "altering the meaning of existing Program
  words bumps the major". A 1.2 that added new ARRAY/MAP leaf kinds beside
  the old ones would keep the existential engine in every VM, only to run
  old Programs whose meaning differs from recompiling the same text
  (architecture §20.12). snug is 0.0.0, so no external store holds
  Programs.
* **SOURCE_KEY preimage** (program.md §13.3, D039, D242). The format version
  element becomes 2. The option list gains two values, `cuts` (0 reference,
  1 rfc) and `pegWords` (the arena limit, default applied). Old cache
  entries therefore never match.

## 2. Header changes

| Word | Format 1.1 | Format 2.0 | |
| --- | --- | --- | --- |
| 1 | `FORMAT_VERSION` | `0x00020000` | [V] |
| 6 | `FLAGS` bits 0–4 | unchanged; **bit 5** `CUTS_RFC` (the Program was compiled with `cuts: 'rfc'`); **bit 6** `ARENA` (some ARRAY leaf is tier A2 or some MAP leaf is tier T, §5.4/§6.3) | [D] for bit 6; [V] for bit 5 |
| 19 | `N_GROUPS` | `N_PEGS`: PEG programs in S5/S6 | [V] |
| 29 | `G_EMPTY` | reserved, 0 | [V] |
| 41 | reserved | `LIM_PEG_WORDS`: compiled group-arena limit in words (default 65 536, hard maximum 2^24); 0 when bit 6 is clear | [V] |
| 42–61 | section offsets | same twenty sections; S5–S10 are redefined below | [V] |

Per-call limits may lower `LIM_PEG_WORDS` (limits array word 10, §9.3).

## 3. Sections S5/S6: PEG programs

S5 `PEG_INDEX` (1 word per program, [D]) and S6 `PEG_DATA`. One PEG
program per array or map group (one per ARRAY leaf and one per MAP leaf; equal
programs are hash-consed).

```
+0  kind              0 array, 1 map                                   [V]
+1  n_nodes           ≥ 1; node 0 is the root                          [V]
+2  n_kids                                                             [V]
+3  tier              arrays 0 A0, 1 A1, 2 A2; maps 0 F, 1 S, 2 T      [D]
+4  B                 arrays: ring bound (FL max), 0 unless tier A1;   [D]
                      maps: 0
+5  n_memo            memo columns (A2 only; else 0)                   [D]
+6  depth             maximum non-CALL nesting depth of the tree       [D]
+7  flags             bit 0 recursive (has CALL); bit 1 order-sensitive
                      member (maps); bit 2 has a cut member            [D]
nodes[n_nodes] × 5    op, a, b, c, d
kids[n_kids]          node indices, referenced by SEQ and CHOICE
```

| op | Name | a | b | c | d | Semantics (arch §20.2) |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | `EMPTY` | – | – | – | – | succeed, consume nothing |
| 1 | `FAIL` | – | – | – | – | fail (empty group choice, unplugged `$$g`) |
| 2 | `ENTRY` | position p (< npos of the array table) | – | – | – | arrays: element i matched position p (bit p of record i) |
| 3 | `MEMBER` | member id (< n_members of the map table) | min | max (INF) | cut 0/1 | maps: §20.2 member loop with occurrence min..max |
| 4 | `SEQ` | first kid index | count ≥ 2 | – | – | thread |
| 5 | `CHOICE` | first kid index | count ≥ 2 | memo column or −1 | – | prioritised, locks in |
| 6 | `REP` | child node | min | max (INF, ≥ 1, ≥ min) | memo column or −1 | greedy; zero-length iteration ends it, satisfied |
| 7 | `CALL` | target node (the root of a recursive group, inside this program) | – | – | – | `run(target)` |

Kinds of memo column: for `CHOICE` and finite-max `REP`, a result cell (0
unknown, 1 fail, 2 + consumed length). For `REP` with max INF, a link cell
pair (2 columns: end, iterations saturated at min). Columns are numbered
0..n_memo−1 in node order.

**Invariants [V].** Node and kid indices are in range. The tree is acyclic
except through `CALL`, and every `CALL` target is a node of the same
program. Each non-root node is referenced exactly once (as a kid, a `REP`
child, or a `CALL` target, which may be referenced more than once). `ENTRY`
appears only in array programs and `MEMBER` only in map programs.
0 ≤ min ≤ max. min < 2^24 or the node is `FAIL` (D035).

**Derived [D].** The verifier recomputes in O(nodes), with the formulas in
architecture §20.5: nullable, minimum and maximum length (arrays: elements;
maps: pairs, max INF for unbounded members), FL, B and the array tier;
`depth`; map tier (§6.3); order-sensitivity (a `MEMBER` whose key is a
typeset and whose max is finite); **re-entrancy** and **multi-start**
(below), and from them the memo columns. The verifier also checks the PEG
well-formedness condition: no `CALL` cycle is reachable through nullable
prefixes (no left recursion).

* *multi-start(N)*: N can be invoked at more than one index in one run. The
  root is not. A `SEQ` child after a variable-length sibling, or below a
  multi-start parent, is. A `REP` body with max ≥ 2 is. A `CHOICE`
  alternative or `REP` body of a multi-start node is. Every node reachable
  from a `CALL` target is.
* *re-entrant(N)*: N can be invoked twice at the same index. Its parent is
  re-entrant; or its parent is a multi-start `SEQ` and an earlier sibling
  has variable length; or its parent is a multi-start `REP` with max ≥ 2
  (iteration chains of two invocations can merge); or N is reachable from a
  `CALL` target.
* Memo columns (A2 only): a result column for each re-entrant `CHOICE` and
  finite-max `REP`; a link pair for each multi-start `REP` with max INF.

[S] (not checkable): the PEG program is the lowering of the schema group.

## 4. Sections S9/S10: array tables

S9 `ARRAY_INDEX` [D], S10 `ARRAY_DATA`. One table per ARRAY leaf:

```
+0  npos          ENTRY nodes of the program; ≤ 4 096                 [V]
+1  W             (npos + 31) >> 5                                     [D]
+2  peg           PEG program id (kind 0)                              [V]
+3  reserved 0
    first[W]      relaxed-automaton initial positions                  [D]
    pos[npos]     typeset id per position                              [V]
    follow[npos × W]  relaxed follow rows                              [D]
```

There are no counters, no `accept` and no `nullable`: acceptance is the
PEG's. `first` and `follow` are the relaxed automaton of architecture §20.5,
computed from the PEG program. Because they are [D], a corrupt table cannot
claim a smaller query than the lowering gives. The superset lemma itself is
[S]. Bits ≥ npos are 0 [V]. `ENTRY` node p ↔ position p, a bijection [V].

## 5. Array evaluation

### 5.1 Per element (live block)

1. Candidates C = (first element) `first`, else ∪ over p ∈ A of
   `follow[p]`, where A is the previous record. Query += typesets of C. This
   is format 1's step without the counter clauses.
2. The element is evaluated (child).
3. Record r = {p ∈ C : typeset(p) matched}. A := r.
4. Store r: A0, nothing more (A is the record); A1, ring slot i mod (B + 1);
   A2, append to the item's arena record (§10.3), with the program's memo
   cells set to 0.
5. If r = ∅: run the machine to termination with record i treated as given
   and no later record (it cannot ask for one). Record the witness (§8).
   The block dies.
6. Else run the machine until it asks for record i + 1 (suspend) or
   terminates. A failure kills the block. A root success at e ≤ i also
   kills it (`unexpected` at e).

At the array end: if the machine is suspended, resume it with
end-of-input (an `ENTRY` at index n fails), and run it to termination. The
leaf matches iff the root succeeded at n.

### 5.2 The machine

State per block (8 words): `pc` (node), `idx` (current index), `sp` (stack
top), `status` (running, suspended, succeeded, failed), `want` (the index it
waits for), and the witness tracker (farthest event index, its kind, its
position, and for E1 whether the record was empty). Stack frame (4 words):
node, start index, counter (SEQ kid / CHOICE alternative / REP count), aux
(REP iteration start; for memoisation, the frame's own start). `depth`
frames are static, in the block. `CALL` frames go to the arena's downward
stack (§10.3).

The machine executes `run` of architecture §20.2 exactly, in node order.
Each of the following is one **step** (§12): entering a node at an index
(every `ENTRY` test, every `SEQ` kid, every `CHOICE` alternative, every `REP`
iteration's entry of its child, every `CALL`); a memo probe; a memo store; a
link follow; a link rewrite during path compression; a rewind of `idx` to a
backtrack point. An `ENTRY` that must wait for a record is charged once,
when it is entered; resuming it costs nothing. A memo hit replaces the node's evaluation: one entry step
plus one probe. A node whose index would be < i − B in tier A1 is
impossible by the [D] B; the access is checked, and violating it fails the
block, never reads out of range.

## 6. Sections S7/S8: map tables

S7 `MAP_INDEX` [D], S8 `MAP_DATA`. One table per MAP leaf:

```
header (8):  peg  n_members  n_named  key_ts  slot_words  rec_words  n_root  flags
members[n_members] × 4:  key id or −1, key typeset or −1, value typeset, class
named[n_named] × 3:      key id, first naming member, naming count   (sorted by key id)
namers[Σ counts]:        member ids, ascending, per named key
root[n_root]:            the class-R members, in source order
```

| Field | Meaning | |
| --- | --- | --- |
| `peg` | PEG program id (kind 1) | [V] |
| `key_ts` | union typeset of the non-literal members' key typesets, or −1 | [D] |
| member `class` | 0 literal; 1 class R (non-literal, at the root sequence, max INF); 2 other non-literal | [D] |
| `slot_words` | tier S: 1 (wire index) + ⌈namers_max/32⌉ (value bits of the naming members) + 2·⌈n_root/32⌉ (key and value bits of the class-R members); else 0 | [D] |
| `rec_words` | tier T: 2 (key id; flags: consumed, unacceptable, rank present) + ⌈2·n_members/32⌉ (+1 rank when order-sensitive); else 0 | [D] |
| `flags` | bit 0 order-sensitive; bit 1 has a cut member | [D] |

A member is a literal-key member iff its key id ≥ 0 (then its key typeset is
−1) [V]. Each `MEMBER` node's a is a member id, and every member is
referenced by exactly one node [V]. The members naming key k are the
literal members whose key id is k [D].

### 6.1 Per pair (live block), every tier

1. Key id k by binary search (format 1 §8.3 step 2). Key query =
   `key_ts`; the key is evaluated at d + 1 (keys never record a witness).
2. Key matches: literal members naming k; non-literal members whose key
   typeset matched.
3. Value query = union of the value typesets of key-matching members. The
   value is evaluated at d + 1.
4. The pair's verdict = for each key-matching member, value matched or not.
   **Unacceptable** if no member's key matched, or every key-matching
   member rejected the value. Then the block dies here (witness rule M1, §8).
5. Tier action (§6.2).

### 6.2 Tiers

* **F.** Pair-major. Members in source order; the first key-matching member
  with count < max whose value matched takes the pair (count += 1). A
  key-matching cut member with count < max that rejects the value records
  the pair's wire index as its cut event, if it has none yet. The pair then
  continues to later members (reference mode; in rfc mode a cut event is
  `fail!`: the block fails at the end, with the same witness). A pair
  nobody takes is unacceptable (step 4 already caught it) or skipped by
  every non-cut member, and then it is leftover: the block fails at the end
  with witness M2. End: for each member in source order, a cut event or
  count < min fails, and the first such is the witness.
* **S.** A pair whose key k is named writes slot k (wire index, value bits
  of the naming members, key/value bits of the class-R members). Other
  pairs go through the class-R members in source order as in F. End: run
  the machine over the slots (§6.4), then closedness: every slot consumed.
* **T.** Append the pair's record to the item's arena record (§10.3). End:
  if order-sensitive and the map is marked (architecture §19.4), take the
  deferred duplicate check's sort permutation as the pick order; run the
  machine over the records (§6.4); then closedness: every record consumed.

### 6.3 Tier selection [D]

F iff the root is a `SEQ` of `MEMBER`s (or a single `MEMBER`/`EMPTY`) and
there is no order-sensitive member. Else S iff every non-literal member is
class R and there is no order-sensitive member and no `CALL`. Else T.

### 6.4 The map machine

Same frames and steps as §5.2, with `idx` replaced by the arena's trail
mark. `MEMBER` evaluation:

* literal member: look up the slot/record of its key: 1 step for the
  lookup, plus 1 to consume (push the pair on the trail);
* non-literal member: examine unconsumed records or slots in pick order, 1
  step each, consuming per §20.2 up to max;
* rewind: pop the trail to the frame's mark, 1 step plus 1 per entry
  popped.

Under `CUTS_RFC`, a frame bit `committed` is set when a cut member's key
matches. `CHOICE` and `REP` read it on failure, and `fail!` unwinds to the
root without trying anything else.

## 7. Leaves, closure, verifier

* Leaf kinds 14 `ARRAY` and 15 `MAP` keep d0 = table id; masks are
  unchanged. Closure children: ARRAY, every position typeset (as format 1);
  MAP, every member's key typeset (if any) and value typeset (replacing
  "every literal entry's value typeset; every key and value typeset of
  every group its pools use").
* Verifier additions (program.md §11): §3 invariants and derived fields,
  §4 and §6 [V]/[D] fields, FLAGS bits 5–6, header word 41 ≤ 2^24, and
  `LIM_PEG_WORDS` counted in step 5's byte cap.

## 8. Errors and witness (replaces program.md §9.2 rules 3–5)

New reason code **44 `group_limit`**: the group arena would overflow (a
validator code like 48 `budget`; offset = the head of the element or pair
whose record, trail entry or frame did not fit; path empty). Not skippable
in sequences (architecture §18.4 is amended to list it beside `budget`).

* **Rule 3′ (map pair, M1).** An unacceptable pair (§6.1 step 4) kills the
  block. If no MAP block of the item is then live and the slot is empty:
  `value` if some member's key matched, else `unexpected`; path to the
  value. (This is format 1's rule with "a live alternative named the key"
  read as "a member's key matched".)
* **Rule 4′ (map end, M2).** The block that died last (at the end beats at
  a pair; ties: lowest leaf id); its failure trace (architecture §20.8); `value`
  with extra segment `KEY k`/`ANYKEY` (k if named by a member of this map)
  or `missing` with extra `KEY id`/`ANYKEY`; or `unexpected`/`value` at the
  first leftover in wire order. Offset: the map's head. A trace step costs
  1 (§12).
* **Rule 5′ (array, events).** The block that died last in walk order (ties:
  lowest leaf id). Its tracker gives E2 (`missing`, extra `INDEX n`), E3
  (`unexpected`, extra `INDEX e`) or E1 at i. For E1 with an empty record,
  the slot is used if it was recorded at element i and not cleared since,
  which always holds when this block was the item's last live block at i.
  Otherwise `type` with extra `INDEX i`. Offset: E1/E3 the element's head
  (kept in the tracker), E2 the array's head.
* Rule 2 (clearing) applies after each element or pair while a block of the
  item is live and not yet failed. A block whose machine failed at element
  i keeps its tracker but no longer prevents clearing; the slot then holds
  the witness only if every block failed.

## 9. Scratch (delta to program.md §12)

### 9.1 VM block

Words 37–39 (were reserved): `VM_ARENA` (offset of the arena),
`VM_ARENA_UP` (upward top: records and trails), `VM_ARENA_DOWN` (downward
top: `CALL` frames). Word 40 `VM_ARENA_END`.

### 9.2 Frames

```
ARRAREA(R) = Σ over ARRAY leaves a ∈ R of
             (4 + 2·W(a) + 8 + 4·depth(peg(a)) + (tier A1 ? (B + 1)·W(a) : 0))
MAPAREA(R) = Σ over MAP leaves m ∈ R of
             (4 + 8 + 2·n_members(m) + 4·depth(peg(m))
              + (tier S ? n_named(m)·slot_words(m) : 0)
              + (tier T ? n_named(m) : 0))            -- T: key id → record index
             + 4·cand_max(R)
```

Block layouts: array `qindex, alive, |A|, rsv, active[W], cand[W],
machine[8], stack[4·depth], ring[...]`; map `qindex, alive, cursor, rsv,
machine[8], count[n_members], cutpair[n_members], stack[4·depth],
slots[...]`. `cand_max` = n_members + max namers (the candidate list of a
pair). All of these are static and closure-sized (R3).

### 9.3 The group arena and the limits array

When FLAGS bit 6 is set, scratch gains `LIM_PEG_WORDS` words after the
frames. `rule.scratch_words` and `SCRATCH_MAX` include them. Limits array
word 10 (new, optional): arena words, effective = min(given,
`LIM_PEG_WORDS`).

### 9.4 Arena layout

An item with A2/T blocks reserves an **element record** per element or pair
at `VM_ARENA_UP`: the concatenation of its live A2/T blocks' records, in
query order, with a fixed total size Rₜ, so block b's record i is at base +
i·Rₜ + off_b. Nested items push above and pop at their end. A map's end-run
pushes its trail above its records, block after block, and discards it.
`CALL` frames grow down from `VM_ARENA_END`. An embedded sub-validation
saves and restores both tops. A push that would cross the other top is
`group_limit`. Sessions keep all of it (the scratch is theirs, architecture
§17.1); sequence mode resets the tops per message.

## 10. Charging (delta to program.md §14)

The rows "array element …", "array element, after the child …", "array end
…" and every "map pair …" / "map end …" row are replaced by:

| Event | Units |
| --- | --- |
| array element, per block visited | 1; live blocks + W·(\|A\| + 1) + 1 per candidate position (unchanged) |
| array element, after the child: each candidate position | 1 + its typeset test (unchanged) |
| array record stored (A1, A2) | ⌈R/16⌉ (R = W, or W + n_memo for A2) |
| array/map PEG step (§5.2, §6.4) | 1 each |
| array end, per block visited | 1; live blocks + W, then the machine's remaining steps |
| map pair, per block visited (live or dead) | 1, + 1 per cursor step (live blocks) |
| map pair, key phase: each non-literal member's key typeset test | 1 + the test |
| map pair, key phase: each naming member visited | 1 |
| map pair: each candidate | 1 + its value typeset test |
| map pair, F/S unnamed: each member visited in the pair-major pass | 1 |
| map pair, S named: slot write | slot_words |
| map pair, T: record stored | ⌈rec_words/16⌉ |
| map end, per block visited | 1; live blocks + 1 per member (F); + the machine's steps (S, T); + 1 per slot or record checked for closedness (S, T) |
| T pick order (order-sensitive, map marked by §19.4) | 1 per pair (keeping the deferred check's permutation); the sort itself is §19.4's, already charged |
| witness: trace step (rule 4′) | 1 |

Schedule 2 (D045): rule 1 also removes the PEG steps of that element (the
shape is A0 `REP(0, ∞, ENTRY)`). Rule 2's shapes (closed struct, pure
table) are tier F and keep exactly 1 bookkeeping unit per simple pair.
Rule 3 is unchanged. **Order of charges** within an element or pair:
format 1's order up to and including the candidates' tests; then the record
or slot store; then the machine's steps until it suspends. At an array or
map end: the end row, then the machine's steps, then closedness, then any
witness trace. Yields and window boundaries never move a charge.

## 11. Limits (delta to architecture §7)

| Limit | Default | Hard max | Where |
| --- | --- | --- | --- |
| PEG nodes per group (after inlining) | 1 024 | 16 384 | compile |
| positions per array (ENTRY nodes; no unrolling) | 256 | 4 096 | compile (unchanged values) |
| members per map | 256 | 4 096 | compile (replaces "alternatives per map sequence") |
| PEG nesting depth | 64 | 256 | compile |
| ring words (B + 1)·W per array | 4 096 | 65 536 | compile |
| memo columns per group | 16 | 256 | compile |
| group arena words | 65 536 | 2^24 | compile default, lowered per call |

## 12. Worked example (operational, not a unit total)

`r = [* uint, uint]` on `[1]` (A0, B = 0; positions p0 (`* uint`), p1
(`uint`); program: `SEQ(REP(0, ∞, ENTRY p0), ENTRY p1)`):

* Element 0: C = first = {p0, p1}; query = {uint} (hash-consed). 1 matches,
  so r₀ = {p0, p1}. Machine: enter SEQ, enter REP, enter ENTRY p0 at 0
  (bit set), REP iteration 2: enter ENTRY p0 at 1, which needs r₁, so it
  suspends (4 steps).
* End (n = 1): resume with end-of-input. The waiting ENTRY p0 at 1 fails
  (event E2 at 1; no new step). REP ends with count 1. Enter ENTRY p1 at 1:
  it fails (E2 at 1, 1 step). SEQ fails, root fails. Witness: the first E2,
  `missing`, extra `INDEX 1`.

`r = {? (a: int, b: int), * tstr => any}` on `{"a": 1}` (tier S; named keys
a, b; class R: the wildcard). Pair `"a"`: named, so slot a = (wire 0;
`a: int` value ✓; wildcard key ✓, value ✓). End: enter SEQ; enter REP;
enter SEQ; MEMBER a consumes slot a (2 steps); MEMBER b: slot b is empty
and min 1, so it fails; rewind (1 + 1 popped); REP ends with 0; MEMBER
wildcard consumes slot a; closedness ✓. Valid. Under `cuts: 'rfc'`, MEMBER
a's key matched (commit), so the REP's failed iteration is `fail!` and the
map fails.

## 13. Questions specific to the format

1. Should memo columns and link cells ship in 2.0, or be reserved
   (n_memo = 0 enforced) until an A2 schema needs them (architecture §20.14
   Q8)?
2. Should element records of different A2/T blocks of one item be
   concatenated (fixed Rₜ, simple addressing, wasted words when a block
   dies early), or should each block have its own arena run (needs a
   per-block index)?
3. Is `group_limit` a new reason code (44), or `budget` with a subcode?
4. Should a T map store a key-id → record index table in its frame (fast
   literal lookups, n_named words), or scan the records?
