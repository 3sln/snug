# snug — Program format 2.0 (draft, revision 3.1)

Status: **draft revision 3 (2026-11-04)**. Revision 2 answered the two
independent reviews: `docs/reviews/2026-11-04-peg-claude.md` ("C#") and
`docs/reviews/2026-11-04-peg-codex.md` ("X#"). Revision 3 answers the
re-review `docs/reviews/2026-11-04-peg-rereview.md` ("N#"). The changes are
summed activation bounds, a chunk heap for recursive frames, a capped
demand-grown arena with session relocation, sorted T traversal, `FAIL`
events, and refusal replay (D280). The disposition table is in architecture
§20.14. Nothing here is implemented, frozen or owner-approved (D272–D280).

**Note (2026-11-10, D301).** The default cut mode is `rfc`, the literal RFC
8610 cut (commitment epochs). Rule A is the non-default option, renamed
from `reference` to **`branch`**. The encodings follow the default: option
word 20 and the SOURCE_KEY `cuts` element are 0 for `rfc` and 1 for
`branch`, and FLAGS bit 5 is `CUTS_BRANCH` (set only under `branch`), so an
absent option and a zero-filled option array both mean `rfc`. "Rule A" and
"reference mode" below mean `cuts: 'branch'`.

This document implements architecture §20 (PEG group semantics, D270, D271)
on paper. It is a **delta** against [program.md](program.md) (format 1.1).
Every section, field, rule and charge not mentioned here is unchanged. That
includes leaves other than ARRAY/MAP, typesets, literal keys, regexps,
closure sets, EXT and the scanner block. When this draft is accepted it is
merged into program.md and this file is deleted.

**What revision 2 changes:**

* memo cells removed and their fields reserved (C8, X8, manager decision);
* exact block and frame layouts (X2);
* a contract for storing recursive activations (X1);
* key lookup on unordered input (X3);
* syntactic lengths with `ml(FAIL) = 0`, and a read-bound lemma (C2, X16);
* an exact fold table for map normalisation (C3, X6);
* F's stop-at-taker rule, and S importing its unnamed-pair state (C7, X12);
* T sorts its own records (C4);
* large minima stored saturated instead of lowered to FAIL (X7);
* the arena sized from the limits and grown on demand, with `group_limit`
  only under an explicit limit (C5, X11);
* one charging order on every route (X4);
* the verifier's cost stated (X13);
* a forced-tier test mode (C8).

---

## 1. Version and compatibility (D084, D279)

* `FORMAT_VERSION` (header word 1) = `2` (D100's spelling: major 2 in the low 16
  bits, minor 0 in the high 16; written `0x00020000` before D318). A format 2 loader refuses
  every 1.x Program, and a 1.x loader refuses 2.0.
* **Why a major version.** S5–S10 change meaning: format 1 encodes
  existential map tables and counter automata. The old engine is removed
  too. A 1.2 that added new ARRAY/MAP kinds beside the old ones is possible,
  but it keeps both engines and their compatibility cost. The reason for the
  bump is the deliberate support policy (snug is 0.0.0, and no external store
  holds Programs). It is not that recompiling the same text would give a
  different result (X Q13).
* A later 2.x minor may give the reserved memo fields a meaning, but only
  with a loader capability rule. A 2.0 loader refuses any Program with a
  non-zero reserved field (§3), so it can never run an unsupported memo
  Program by accident.
* **SOURCE_KEY preimage** (program.md §13.3, D039, D242). The format version
  element becomes 2. The option list gains `cuts` (the effective mode,
  always present: 0 `rfc`, the default; 1 `branch`, rule A — D301) and
  `groupWords` (−1 when not given). Old cache entries therefore never match.

## 2. Header changes

| Word | Format 1.1 | Format 2.0 | |
| --- | --- | --- | --- |
| 1 | `FORMAT_VERSION` | `2` (D318) | [V] |
| 6 | `FLAGS` bits 0–4 | unchanged; **bit 5** `CUTS_BRANCH` (rule A; clear for the default `rfc`, D301); **bit 6** `ARENA` (some ARRAY leaf is A2 or some MAP leaf is T) | bit 5 [V], bit 6 [D] |
| 19 | `N_GROUPS` | `N_PEGS` | [V] |
| 29 | `G_EMPTY` | `R_ITEM_MAX`: the maximum, over closure sets R, of the sum of the record words of the A2/T leaves in R (§9.4) | [D] |
| 41 | reserved | `LIM_GROUP_WORDS`: the arena cap in words (default 4 194 304; ≤ 2^24; §9.4) | [V] |
| 62 | reserved | `RECLEAF_MAX`: the most recursive ARRAY/MAP leaves in one closure set | [D] |
| 63 | reserved | `ACT_SUM`: the maximum, over closure sets, of the sum of per-element activation chunk words of their recursive leaves (§5.3) | [D] |

## 3. Sections S5/S6: PEG programs

S5 `PEG_INDEX` (1 word per program, [D]) and S6 `PEG_DATA` hold one
program per array or map group. Identical programs are hash-consed.

```
+0  kind            0 array, 1 map                                    [V]
+1  n_nodes         ≥ 1; node 0 is the root                           [V]
+2  n_kids                                                            [V]
+3  tier            arrays 0 A0, 1 A1, 2 A2; maps 0 F, 1 S, 2 T       [D]
+4  B               arrays: read-back bound (§3.2), 0 unless A1        [D]
+5  memo            reserved, must be 0                                [V]
+6  depth           max frames of one activation (§5.3)                [D]
+7  flags           bit 0 recursive; bit 1 order-sensitive member;
                    bit 2 has a cut member                             [D]
+8  n_calls         CALL nodes                                         [D]
nodes[n_nodes] × 5  op, a, b, c, d
kids[n_kids]
```

| op | Name | a | b | c | d | Semantics (arch §20.2) |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | `EMPTY` | – | – | – | −1 | succeed, consume nothing |
| 1 | `FAIL` | – | provenance: the member id (maps) or position (arrays) whose iteration a fold replaced, else −1 | – | −1 | fail, recording an event (§8) |
| 2 | `ENTRY` | position p | – | – | −1 | element at idx matched position p |
| 3 | `MEMBER` | member id | min | max | −1 | member loop with occurrence min..max (the cut flag is in the member record) |
| 4 | `SEQ` | first kid | count ≥ 2 | – | −1 | thread |
| 5 | `CHOICE` | first kid | count ≥ 2 | – | −1 | prioritised; cut outcomes per arch §20.2 |
| 6 | `REP` | child | min | max (≥ 1, ≥ min, INF) | −1 | greedy; a zero-length success satisfies the minimum |
| 7 | `CALL` | target node | – | – | −1 | `run(target)` |

Field d is reserved (it held the memo column) and must be −1 [V].

**Counts (X7).** `REP` and `MEMBER` store min = min(lo, 2^24), and store max
= INF when hi ≥ 2^24. No count is lowered to `FAIL`. Consumption cannot
reach 2^24, because entries ≤ 2^24 − 1. A saturated minimum is therefore
unsatisfiable except through the zero-length rule, which stays available.
`0*0 g` lowers to `EMPTY`, so a `REP` record always has max ≥ 1.

**Invariants [V]:**

* every index is in range;
* the graph is acyclic except through `CALL`;
* every non-root node is referenced exactly once, as a kid or as a `REP`
  child;
* a `CALL` may target any node of the same program, the root included (C13);
* `ENTRY` appears only in array programs and `MEMBER` only in map programs;
* 0 ≤ min ≤ max.

### 3.1 Derived fields and how the verifier computes them (X13)

The verifier recomputes every [D] field. Its cost is bounded by the verify
budget, which charges every word read and every bitset operation, the
fixed-point rounds included. The figure O(Program words +
npos·W·(n_calls + 1)) per round is a **proof obligation** (N8), not an
established bound. The verify budget
(program.md §11) is raised to `64·(PROGRAM_WORDS + POOL_BYTES/4 +
npos·W·(n_calls + 1) + 1)` to cover it.

Nullable, first and last sets over `CALL` are least fixed points, iterated
one strongly connected component at a time. Each iteration only adds bits,
so an SCC needs at most npos·(n_calls + 1) rounds. All length arithmetic
saturates at INF.

### 3.2 Syntactic lengths and the read bound (C2, X16)

```
ml(ENTRY) = 1          ml(EMPTY) = ml(FAIL) = 0
ml(SEQ)   = Σ ml(kids) ml(CHOICE) = max ml(kids)
ml(REP(lo,hi,g)) = hi · ml(g)   (0 · INF = 0)       ml(CALL) = INF
FL(ENTRY) = FL(FAIL) = 0        FL(EMPTY) = −∞ (cannot fail)
FL(SEQ(g₁…gₖ))   = max over j with FL(gⱼ) ≠ −∞ of ml(g₁…g_{j−1}) + FL(gⱼ)
FL(CHOICE(g…))   = max FL(gⱼ); −∞ if some gⱼ cannot fail
FL(REP(lo,hi,g)) = −∞ if lo = 0, else (lo − 1)·ml(g) + FL(g)  (0·INF = 0)
FL(CALL)         = INF
B = max over backtrack attempts of FL(attempted node), 0 if there are none.
    The backtrack attempts are every REP's child (each iteration attempt,
    including the last, failed one) and every CHOICE alternative except
    the last.
```

`ml` is syntactic. `FAIL` counts 0, and an unsatisfiable minimum does not
shrink a `REP`'s length.

**Read-bound lemma.** Take any attempt of node g that starts at index s.
Every record it reads has index ≤ s + ml(g). If the attempt fails, every
record it reads has index ≤ s + FL(g). Also FL(g) ≤ ml(g).

*Proof sketch* (structural induction):

* A SEQ prefix that succeeds reads only within its own ml.
* A child that fails reads only within its FL.
* A REP's last, failing iteration starts at most at s + (hi − 1)·ml(g) and
  reads within FL(g) ≤ ml(g).
* A failed sub-attempt is undone, but its reads stayed within its own bound.

So when the machine rewinds to the start s of a failed backtrack attempt of
g, the newest record is ≤ s + FL(g) ≤ s + B. **B + 1 ring rows therefore
suffice** in A1.

B is a safe upper bound, not the minimal storage. X16's
`[(* uint, tstr) // ()]` is classed A2 although constant memory would do.
Over-classification never gives a wrong verdict. Ring access is still
checked: a violation is an internal Program fault (not reason 44), never an
out-of-range read.

Tier: A0 iff B = 0; A1 iff 0 < B < INF and (B + 1)·W ≤ the ring-word limit;
otherwise A2. A recursive program is always A2.

### 3.3 Map normalisation (fold table) and tier [D] (C3, X6)

The folds apply bottom-up, before tier selection, in both cut modes. Every
row holds with cuts, under rule A and under rfc, and **preserves failure
events and scores**. The last row always keeps the `MEMBER`, cut or no cut
(revision 3.1, F1). Folding it to plain `FAIL` would drop the first
iteration's consumption, so the `FAIL` event's score would no longer equal
the unfolded repetition's. Provenance gives back the member id, not the
score.

| Before | After |
| --- | --- |
| `REP(lo, hi, MEMBER(1,1))` | `MEMBER(lo, hi)` |
| `REP(lo, hi ≥ 1, MEMBER(0, INF))` | `MEMBER(0, INF)` |
| `REP(0, hi ≥ 1, MEMBER(1, INF))` | `MEMBER(0, INF)` |
| `REP(1, hi ≥ 1, MEMBER(1, INF))` | `MEMBER(1, INF)` |
| `REP(lo ≥ 2, hi, MEMBER(k ≥ 1, INF))` | `SEQ(MEMBER(k, INF), FAIL)`, the `FAIL` with provenance = that member |
| anything else | unchanged |

So `{2*2 (+ int => int)}` becomes `SEQ(MEMBER(1,INF), FAIL)` and matches
nothing, as PEG says. `{2* int => int}` is `MEMBER(2, INF)`, which differs.

Tier:

* **F** iff the normalised root is a `SEQ` of `MEMBER`s (or a single
  `MEMBER`, or `EMPTY`) and no member is order-sensitive (a non-literal key
  with a finite max);
* else **S** iff every non-literal member is class R (at the root sequence,
  max INF), no member is order-sensitive, and there is no `CALL`;
* else **T**.

## 4. Sections S9/S10: array tables

```
+0  npos            ENTRY nodes; ≤ 4 096                              [V]
+1  W               (npos + 31) >> 5                                   [D]
+2  peg             program id (kind 0)                                [V]
+3  reserved 0
    first[W]        relaxed initial positions                          [D]
    pos[npos]       typeset id per position                            [V]
    follow[npos × W] relaxed follow rows                               [D]
```

There are no counters, accept bits or nullable flag. `first` and `follow`
are the relaxed automaton of arch §20.5. They include a bypass edge for
every nullable `CALL` and an edge from each callee-last position to each call
site's follow set (C13, X15).

[S]: the lowering obligations of arch §20.5 (distinct generic
instantiations, unwrap, `.cborseq` roots). Debug builds assert that every
`ENTRY` test is of a position in Cᵢ (C15); a violation is an internal fault.

## 5. Array evaluation

### 5.1 Per element (live block)

1. Candidates: C = `first` for element 0, otherwise ∪ over p ∈ A of
   `follow[p]`. Add the typesets of C to the query. This is format 1's step
   without counters.
2. Evaluate the element.
3. Record r = {p ∈ C : typeset(p) matched}. Set A := r.
4. Store r. In A0, A is the record. In A1, write ring row i mod (B + 1). In
   A2, write the item's arena record (§9.4).
5. If r = ∅, run the machine to termination with no later record. The block
   dies at this element, and those steps are charged here (C16).
6. Otherwise, run the machine until it requests record i + 1 or terminates.
   A failure, or a root success at e ≤ i, kills the block at this element.

At the array's end, resume the machine with end-of-input (an `ENTRY` at n
fails) and run it to termination. The leaf matches iff the root succeeded at
n.

D044 streaks step the machine per element, exactly as above. A streak stops
before any element whose machine run is anything other than the `[* T]`
no-op (C16).

### 5.2 Array block layout (X2; as built, D311)

| Offset | Field |
| --- | --- |
| +0 | `qindex` |
| +1 | `alive` |
| +2 | `nactive` (\|A\|) |
| +3 | `status`: 0 running, 2 succeeded at `idx`, 3 failed |
| +4 | `pc`: current node |
| +5 | `idx`: current element index |
| +6 | `sp`: frame count of the current activation |
| +7 | `mode`: 0 enter `pc`, 1 returned ok, 2 returned fail, 3 the `ENTRY` at `pc` waits for record `idx` |
| +8 | `ev_idx`: farthest failure index, −1 for none |
| +9 | `ev_kind`: 1 E1, 2 E2, 3 E3, 4 E4; +256 for E1 with an empty record |
| +10 | `ev_off`: input offset of the event's element head (E1/E3), else the array head |
| +11 | `act`: the top chunk of a recursive program's frames, −1 for none |
| +12 | `rbase`: the container's record base in the arena (A2) |
| +13 | `stride`: the item's record stride Rₜ (A2) |
| +14 | `died`: the element the block died at (−1 alive) |
| +15 | `roff`: this block's word offset in the stride (A2) |
| +16 | `active[W]`, then `cand[W]` |
| … | `stack[4 · depth]` (non-recursive programs only) |
| … | `ring[(B + 1) · W]` (A1 only) |

An array frame is 4 words: `node, start, counter, aux`. `counter` is the SEQ
kid, the CHOICE alternative or the REP count. `aux` is the REP iteration
start. The array's head offset is the walk's own, not a block word.

`ARRWORDS(a) = 16 + 2W + (recursive ? 0 : 4·depth) + (A1 ? (B+1)·W : 0)`.

### 5.3 The machine and recursive activations (X1)

The machine executes `run` of arch §20.2 in node order. Each of the
following is one **step** (§10):

* entering a node at an index. This covers each `ENTRY` test (charged once,
  even if it then waits for a record), each SEQ kid, each CHOICE
  alternative, each REP iteration's entry into its child, and each `CALL`;
* each rewind of `idx`.

**Activation contract (X1, N2).**

* A non-recursive program keeps all its frames in the block's static stack
  (`depth` frames).
* A **recursive** program has no static stack. Its frames live in its own
  **chunk list**, drawn from the arena's chunk heap (§9.4).
  * Chunks are 64 words: 2 header words (next chunk index or −1, words
    used) and 62 payload words.
  * A frame or an activation record never spans two chunks. When the current
    chunk lacks room, the block links a new chunk from the free list, or
    carves a new one from the heap.
  * When a chunk's last frame is popped, it is unlinked and returned to the
    free list.
  * The block's `act` word holds a **chunk address**, `chunk index · 64 +
    offset`, of its current top.
* A `CALL` pushes a 3-word activation record `{caller pc, caller act, frame
  count}`; the callee's frames follow it.
* A return, success or failure, pops them and restores `act`, `sp` and
  `pc`. Unwinding a failed call does the same.
* Several blocks can suspend interleaved, inside one container or across
  nested containers. Each pushes and pops only in its own list, so no global
  LIFO order is needed.
* Charges: 1 step per `CALL`, and 1 step per chunk link or unlink. Node
  entries cover frame pushes and pops. Nothing is ever copied.

**Activation bound.** Left recursion is refused: the verifier rejects any
`CALL` cycle reachable through nullable prefixes. So between two activations
of one cycle on a block's live chain, at least one of that block's elements
is consumed. A chain that consumes nothing contains at most `n_calls` calls.
A block's live activations therefore number at most
(its consumed elements + 1)·n_calls.

Each activation costs at most `a = 3 + 8·depth` words. Chunking wastes at
most 2 header words plus 8 words of tail per chunk, so it needs at most
⌈a·n_calls·64/54⌉ chunk words per consumed element, plus one partly filled
chunk per live block. Header word 63 `ACT_SUM` is the maximum, over closure
sets R, of the sum of ⌈n_calls·(3 + 8·depth)·64/54⌉ over the recursive
leaves in R. It sums simultaneous blocks (N1).

## 6. Sections S7/S8: map tables

```
header (8):  peg  n_members  n_named  key_ts  slot_words  rec_words  n_root  flags
members[n_members] × 5:  key id or −1, key typeset or −1, value typeset, class, cut
named[n_named] × 3:      key id, first naming member, naming count   (sorted by key id)
namers[Σ counts]:        member ids, ascending
root[n_root]:            class-R members, source order
```

| Field | Meaning | |
| --- | --- | --- |
| `key_ts` | union of the non-literal members' key typesets, or −1 | [D] |
| member `class` | 0 literal; 1 class R; 2 other non-literal | [D] |
| member `cut` | 0/1 (`^ =>`, `name:`, `value:`) | [V] |
| `slot_words` | S: 2 (wire index, pair offset) + ⌈namers_max/32⌉ + 2·⌈n_root/32⌉; else 0 | [D] |
| `rec_words` | T: 2 (key id; flags: consumed, has-rank) + ⌈2·n_members/32⌉; else 0 | [D] |
| `flags` | bit 0 order-sensitive; bit 1 has a cut member | [D] |

### 6.1 Per pair (live block), every tier

1. **Key id (X3).** Every route already compares each key with the previous
   one. While the map's keys have arrived strictly ascending, binary search
   `[lo, N_KEYS)` as format 1 does. From the first key that does not ascend,
   binary search the full range `[0, N_KEYS)`; the block flag `unordered` is
   set and stays set for the rest of the map. The format-1 naming cursor is
   used only while keys ascend. Once unordered, the naming record of k is
   found by binary search in `named`. Both cases charge 1 per probe, so the
   routes agree: they all see the same wire order.
2. The key query is `key_ts`. Key matches are the naming members of k and
   the non-literal members whose key typeset matched.
3. The value query is the union of the value typesets of the key-matching
   members.
4. **Unacceptable** pair: no key matched, or every key-matching member
   rejected the value. The block dies here (rule 3′).
5. Tier action (§6.2).

### 6.2 Tiers

* **F (C7).** Walk the members in source order. At each member whose key
  matches:
  * if the value matched and count < max, take the pair (count += 1) and
    **stop**;
  * if the value was rejected, the member has a cut and count < max, record
    a cut event (the first wire index per member) and continue. Under rule A
    the member will fail; under rfc the map will fail;
  * otherwise continue.

  At the end, the first member in source order that has a cut event or
  count < min fails the root (witness by §8). Under rfc, a cut member whose
  key matched sets its `ukey` bit. F has no enclosing choice, so this
  commitment has no further effect.
* **S (X12).** A pair with a named key k writes slot k: the wire index, the
  pair offset, the value bits of the naming members, and the key/value bits
  of the class-R members. A pair with an unnamed key runs the F walk over
  the class-R members only. Per class-R member it updates `ucount`, `ukey`
  (a key matched) and `ucut` (the wire index of the first cut violation).
  The machine runs at the map's end (§6.4).
* **T.** Append the pair's record to the item's arena record (§9.4). At the
  end, if the map is `unordered` or contained an EC-sensitive key (arch
  §19.2), the machine first sorts its records (§6.5), whatever its members
  (N4). Then it runs (§6.4) and checks closedness.

### 6.3 Map block layout (X2; as built, D311)

| Offset | Field |
| --- | --- |
| +0 | `qindex` |
| +1 | `alive` |
| +2 | `cursor` (the named table, while keys ascend) |
| +3, +4 | the block's first candidate in the pair's candidate list; its candidate count |
| +5 | the end's result (1 matched, 2 failed) |
| +6 | `sp` |
| +7 | `commits`: the rfc commitment epoch counter |
| +8 | `npairs` |
| +9 | bit 0 `unordered`, bit 1 `ecsens` |
| +10, +11, +12 | the reported failure (§8): `fail_score`; `fail_evA` (kind << 16 \| member); `fail_evB` (pair index, or −1); after the end, the witness |
| +13 | `act`: the top chunk of a recursive program's frames, −1 for none |
| +14, +15, +16 | T: the container's record base, the stride, this block's offset in it |
| +17 | the trail's base (T, in the arena) |
| +18 | the pick-order permutation (T, in the arena; −1 wire order) |
| +19 | the current pair's `named` index (−1 none) |
| +20 | S: the trail's length; +21 spare |
| +22 | 6 words per member: `count`, `cutpair` (wire index or −1), `ucount` (F: the cut pair's key id), `uflags` (bit 0 `ukey`; bits 8 and up hold `ucut` + 1), `min`, `max` |
| … | `stack[8 · depth]` (non-recursive programs) |
| … | S: `slots[n_named · slot_words]` and the trail `[n_named]`; T and F: `index[n_named]` (key id → record, −1 if absent; F keeps it for the forced-tier mode) |

A map frame is 8 words: `node, mark, counter, aux, commits0, score, evA,
evB`. `commits0` is the epoch at the attempt's start (rfc). `score`, `evA`
and `evB` hold the best failure seen among the frame's failed sub-attempts
(§8). S keeps its undo trail in the block (at most one entry per named slot),
so an S map never allocates arena words; T's trail and permutation are in the
arena.

`MAPWORDS(m) = 22 + 6·n_members + (recursive ? 0 : 8·depth) + (S ?
n_named·(slot_words + 1) : n_named)`. A T record is `rec_words = 4 +
⌈2·n_members/32⌉` words: key id, flags (bit 0 consumed), key offset, key
length, then two bits per member (key matched, value matched).

### 6.4 The map machine

Frames and steps are as in §5.3, with `mark` in place of `idx`. A `MEMBER`
looks at the unconsumed candidates in pick order (§6.5):

* **Literal member:** look up k's slot (S) or `index[k]` (T; filled at
  arrival, −1 if absent; X Format Q4). That costs 1 step, and consuming the
  pair costs 1 more.
* **Non-literal member (T):** examine records in pick order until count =
  max. It costs **1 step per record examined, consumed or not** (X10). As
  built (D323) each non-literal member keeps a cursor (its member word +2,
  0 at the start): the examination starts there, and the cursor moves to
  where it stopped. Every record before a cursor is consumed or can never be
  taken or cut by that member (its key typeset, or — for a member without a
  cut — its value typeset does not match), so the outcome is the full scan's;
  only the steps differ. A rewind that gives back a record moves every cursor
  above that record's pick position back to it. A record's pick position is
  its wire index, or after the T sort the value the sort stores above the
  consumed bit of its flags word.
* **Class-R member (S):** first import its saved unnamed-pair state:
  `ucount` adds to count, `ukey` counts as a key match for rfc commitment,
  and `ucut` is a cut violation. Then examine the named slots, 1 step each.
* **Consume:** push the pair on the trail (1 step). **Rewind:** pop to
  `mark`, 1 step plus 1 per entry popped; in a T map that gave a record
  back, ⌈n_members/16⌉ more for the cursors (D323).

Cut outcomes (arch §20.2):

* **Rule A** (`cuts: 'branch'`): the member returns `cut`. `SEQ` and `REP`
  propagate it. `CHOICE` absorbs it, remembers it, and tries the next
  alternative; if no alternative succeeds, it raises `cut` again.
* **rfc** (the default, D301): a cut key match increments `commits`. An attempt (a CHOICE
  alternative or a REP iteration) that fails with `commits > commits0`
  returns `fail!`, which unwinds to the map root. A value mismatch returns
  `fail!` at once.

### 6.5 Pick order and the T sort (C4)

Pick order is ascending EC key order (arch §20.2, R8).

F and S never need it. They have no order-sensitive member, so their results
do not depend on it, and their diagnostics use wire order (§8).

T always traverses in pick order, because cut traversal, failure scores and
step counts depend on it even with unbounded members (N4):

* If the map is neither `unordered` nor `ecsens`, wire order already is EC
  order and nothing is done.
* Otherwise the machine heap-sorts a permutation of the records (n words in
  the arena) by the keys' EC comparison. It uses kin's EC comparator over
  the keys' DC bytes (buffer and canonical copy) or over the session's
  retained key forms (§19.7).
* Each comparison is charged ⌈min(len₁, len₂)/8⌉, at least 1 (the D241
  quantum). The comparison sequence is a function of the record sequence,
  so every route charges the same.
* It does not use §19.4's permutation, so there is no coupling to the
  scanner.

## 7. Leaves, closure, verifier

Leaf kinds 14 and 15 keep d0 = table id and keep their masks.

Closure children: for ARRAY, every position typeset; for MAP, every member's
key typeset (if any) and value typeset.

Verifier: the §3 invariants; the §3.1–§3.3 derived fields; the §4 and §6
fields; header words 29, 41 and 63; FLAGS bits 5–6; reserved fields equal to
−1 or 0 as specified.

## 8. Errors and witness (replaces program.md §9.2 rules 3–5)

**Code 44 `group_limit`** is a validator code like 48 `budget`, and is not
skippable.

* **When.** An allocation misses with the arena already at its cap (§9.4).
  Below the cap a miss is growth, never a refusal.
* **Precedence.** Every allocation comes after its charge. If the charge
  exhausts the budget, `budget` is reported and nothing is allocated.
* **Offset.** An allocation made while processing an element or pair
  reports that item's head. An allocation made during an end-run reports
  the container's `head`. End-runs are the array end, the map end, the T
  sort, trails, and activations created during an end-run.
* **Inside an embedded sub-validation** the refusal is a resource outcome
  for the whole document. It is never swallowed as an EMBED failure (X
  Format Q3).

**Rule 3′ (map pair, M1).** An unacceptable pair kills the block. If no MAP
block of the item is live and the slot is empty, the witness is `value` if
some member's key matched, else `unexpected`, with the path to the value.

**Rule 4′ (map end, M2).**

* **Failure events.** When a `MEMBER` fails, it records an event: score =
  the trail length at that moment, before any undo; kind = `missing` or
  `cut`; the member; the pair. A `FAIL` node also records an event (N5):
  its score is the trail length and its kind is `missing`. The member is
  its provenance member. A folded `SEQ(MEMBER, FAIL)` reports what the
  unfolded `REP` would, with the same score, because the `MEMBER` still
  consumes before the `FAIL` scores: that member's next iteration met no
  pair, or none for an unplugged socket,
  which reports `missing` with no key segment.
* **Propagation.** A frame keeps the best event among its failed
  sub-attempts (higher score wins; ties go to the earlier). A failing `SEQ`
  passes up its failing child's event. A failing `CHOICE` passes up its best
  event. A `REP` below its minimum passes up its failing iteration's event.
  rfc `fail!` passes up the event that raised it. A rule-A `cut` raised by a
  `MEMBER` passes up that member's event, and a `CHOICE` that re-raises
  `cut` passes up its best event, by the same rule as any failing `CHOICE`
  (N4).
* **Order independence (N4).** Scores are compared only at a `CHOICE`. T
  traverses in pick order (§6.5), so its scores and steps do not depend on
  the serialisation. F has no `CHOICE`. In S, choices appear only in literal
  subtrees: a literal member's consumption does not depend on order, and
  the class-R members before such a subtree consume all their matches,
  whatever the order, so its scores do not depend on order either.
* **Reporting.** The root's event is reported:
  * `missing`: extra segment `KEY id` or `ANYKEY`;
  * a cut: `value` at the **diagnostic pair**. That is the cut-violating
    pair with the smallest wire index in the member's scope. The scope is
    the pairs that were unconsumed when the member was entered and that it
    would examine before reaching max if violations were skipped (all of
    them when max is INF). T finds it with a diagnostic scan (1 step per
    record). F and S already hold it in `cutpair`, `ucut` and their slots
    (X5).
* **Root success with leftovers.** Report the first leftover in wire order:
  `value` if some member's key matched it and that member rejected its
  value, else `unexpected`.
* The offset is the map head. Each trace or scan step costs 1.

**Rule 5′ (array).** Take the block that died last (ties: the lowest leaf
id) and read its tracker:

* E2: `missing` + `INDEX n`.
* E3: `unexpected` + `INDEX e`.
* E1 at i with an empty record: the slot, if it was recorded at element i
  and not cleared since. That always holds when this block was the item's
  last live block at i. Otherwise `type` + `INDEX i`.
* Any other E1: `type` + `INDEX i`.
* E4, a `FAIL` node tested at index i (N5): `unexpected` + `INDEX i` when
  i < n, else `missing` + `INDEX n`. It competes with E1–E3 by index (ties:
  run order), so `[$$g]` reports `missing` on `[]` and `unexpected` at 0 on
  `[1]`.

Rule 2 (clearing) applies while some block of the item is live and has not
failed.

**Forced-tier test mode (C8).** Limits word 8 bit 2 forces every map to T
and every array to A2, ignoring the natural tier (the programs stay valid).
Gate (`bb vm-test`): with sufficient budget and arena, on every case,
verdict, reason, subcode, path and offset must be equal with and without
the bit. Only the budget used may differ. With a tight budget or arena,
each mode's `budget`/`group_limit` outcome is gated against that mode's own
charge and allocation schedule. The forced mode can legitimately refuse
where the natural tier finishes (N7).

## 9. Scratch (delta to program.md §12)

### 9.1 VM block

As built (D311): word 39 `VM_ARENA` is the scratch offset of the arena's
8-word header, which holds the upward top, the chunks carved, the body's end,
the effective cap, the free-list head (−1) and, after a miss, the size asked
for; the body follows the header. The arena sits after the fixed scratch
words (`vm-scratch-words` = fixed + 8 + the lease). Word 35 `VM_PBASE` is the
absolute input offset of the window (0 on the buffer route), so events record
absolute offsets on every route. No global item counter is kept: growth
follows demand, and the bound below is only W7's (and a recursive session's
up-front growth, D314).

### 9.2 Frames

```
ARRAREA(R) = Σ over ARRAY leaves a ∈ R of ARRWORDS(a)
MAPAREA(R) = Σ over MAP leaves m ∈ R of MAPWORDS(m) + 4·cand_max(R)
```

`cand_max` is the maximum, over MAP leaves, of n_members plus the largest
naming count. As built (D311) the candidate list is sized per container as
the sum of n_members over its admitted MAP blocks, so MAPAREA(R) = Σ
MAPWORDS(m) + 4·Σ n_members.

### 9.3 Limits array

Word 10 (optional) is an explicit arena limit in words; −1 or absent means
none. The effective cap is min(word 10, `LIM_GROUP_WORDS`) when given, else
`LIM_GROUP_WORDS`.

### 9.4 The group arena: content, bound, cap, growth, relocation (C5, X11, N1–N3)

**Layout.** The arena is one region of scratch words with two parts.

* **The upward stack**, from `VM_ARENA`:
  * Element records: an item with A2/T blocks reserves one record of fixed
    stride Rₜ, the sum of the record words (A2: W; T: rec_words) of the A2/T
    blocks admitted when its container was entered. A dead block's words
    stay in the stride (X Format Q2).
  * End-run permutations and trails.
  * Nested items push above and pop at their end.

  Addresses here are offsets from `VM_ARENA`.
* **The chunk heap**, growing down from `VM_ARENA_END`:
  * Chunk c occupies `[END − 64·(c+1), END − 64·c)`.
  * Free chunks form a list headed by `VM_CHUNK_FREE`.
  * `VM_CHUNK_TOP` counts the chunks ever carved.

  Addresses here are chunk indices and in-chunk offsets.
* A push that would make the two parts meet is a **miss**: the arena must
  grow (below) or the cap is reached.
* An embedded sub-validation saves and restores the upward top. Chunks are
  per block and freed by their block.

**Bound (N1).** A global item counter `VM_GROUP_ITEMS` counts every item the
walk visits, at every embedding level, and is never reset (unlike the EMBED
item counter). At any moment,

```
need ≤ VM_GROUP_ITEMS · (R_ITEM_MAX + ACT_SUM)
       + (D + 1) · (ACT_SUM + 64 · RECLEAF_MAX)
       + 2 · maxEntries
```

where:

* `VM_GROUP_ITEMS` ≤ the input bytes;
* `RECLEAF_MAX` is the most recursive leaves in any one closure set;
* the D + 1 term covers each open container's "+1" activation and its
  partly filled chunks;
* 2·maxEntries covers one end-run's permutation and trail.

All arithmetic saturates at 2^31 − 1. The compiler evaluates the bound at
the compiled limits, with items = the input limit, and warns **W7** when it
exceeds the default cap.

**Cap (N3).** The arena never exceeds its cap:

* the explicit limit if one is given (compile option `groupWords`, or limits
  word 10);
* else `LIM_GROUP_WORDS` (header word 41), which defaults to 4 194 304
  words (16 MiB);
* never more than 2^24 words (64 MiB).

The arena is counted outside `LIM_TOTAL_BYTES`, the 64 MiB
Program/pool/scratch cap, which is unchanged. A miss at the cap is
`group_limit`.

**Growth (N3).** Allocation follows demand, never the bound.

* **Buffer route.** The VM starts with the host's lease (default 4 096
  words). On a miss below the cap it ends with the hosts' growth answer −5
  (P8.4's canonical-path protocol; D313, replacing the internal code 22),
  out word 7 holding the scratch words it asks for (the arena doubled, at
  most to the cap). The host grows the scratch and runs the validation
  again.
  * Charges are a pure function of the run, so the final run's out array is
    the answer.
  * CPU is at most (1 + number of doublings) × one run. With the default
    4 096-word lease there are at most log₂(cap/lease) doublings: ≤ 10
    (11 runs) at the default 16 MiB cap, and ≤ 12 (13 runs) at the 64 MiB
    hard cap.
  * EXT predicates may be called again on a re-run. They must be pure
    (D140), so the outcome is unchanged.
* **Session route.** The session suspends with `VMS_GROW` *before* any
  charged work that could miss (as built, D314): an item that will open
  A2/T blocks first checks headroom for its records, a T map's end for its
  permutation and trail (2·pairs), and a recursive Program grows once at the
  message's start to the bound below (items ≤ bytes, at most the cap), since
  one machine run can rebuild an activation chain. A machine therefore never
  yields mid-run. The host allocates a scratch array with the arena doubled
  (at most to the cap) and relocates (the VM adopts it at the next step):
  1. copy the words below `VM_ARENA_UP` to the same offsets;
  2. copy the chunk heap so that each chunk keeps its index counted from the
     new end, i.e. it moves by the growth amount;
  3. set `VM_ARENA_END` to the new end.

  Record offsets, chunk indices and chunk addresses (`act`, saved `caller
  act`, chunk links, `VM_CHUNK_FREE`) are all relative, so nothing else is
  rebased. Nothing is re-run, and growth costs no units on either route.

## 10. Charging (delta to program.md §14): one order on every route (X4)

| Event | Units |
| --- | --- |
| array element, per block visited | 1; live blocks + W·(\|A\| + 1) + 1 per candidate position |
| array element, after the child: each candidate | 1 + typeset test |
| array record stored (A1, A2) | ⌈R/16⌉ (R = W) |
| PEG step (§5.3, §6.4; including chunk link/unlink) | 1 |
| array end, per block visited | 1; live blocks + W, then the machine's steps |
| map pair, per block visited | 1, + 1 per cursor step (ascending) or per probe of `named` (unordered) |
| map pair, key phase: each non-literal member's key typeset test | 1 + the test |
| map pair, key phase: each naming member visited | 1 |
| map pair: each candidate | 1 + value typeset test |
| map pair, F/S pair-major walk: each member visited | 1 |
| map pair, S named: slot write | slot_words |
| map pair, T: record stored + index entry | ⌈rec_words/16⌉ + 1 |
| map end, per block visited | 1; live blocks + 1 per member (F); S/T: the T sort (§6.5), then the machine's steps, then 1 per slot/record checked for closedness |
| witness trace / diagnostic scan step | 1 |

**Order (normative, every route).**

* **Within an item:** format 1's order up to the candidates' tests; then the
  record or slot store; then the machine's steps until it suspends or the
  block dies.
* **At a map's logical end** (after its last value): first the deferred
  duplicate check's units (arch §19.4); then the map end row; then the T
  sort, the machine, closedness, and the witness trace.
* **At an array's end:** the end row, then the machine.
* Yields and window boundaries never move a charge.

**Dependency on §19.** D277 is in place: §19.5 (531220f) charges the
deferred duplicate check at the map's logical end on every route. **D280**
(refusal replay, arch §20.6) is still to be agreed and amended into §19.5.
Under it, the canonical route reports a scanner refusal when the VM's walk
reaches the refusal's logical event, not before the VM runs. That makes
the refusal order the same as the session's (N6).

**Schedule 2 (D045).** Rule 1 also removes the machine steps of a `[* T]`
element. Rule 2's shapes are tier F and keep 1 unit per simple pair. Rule 3
is unchanged.

These prices are provisional bounded-work charges. They are not an
equal-CPU claim until the implemented paths are measured with D241's method
(X Q12).

## 11. Limits (delta to architecture §7)

| Limit | Default | Hard max | Where |
| --- | --- | --- | --- |
| PEG nodes per group (after inlining) | 1 024 | 16 384 | compile |
| positions per array | 256 | 4 096 | compile |
| members per map | 256 | 4 096 | compile |
| frames per activation (`depth`) | 64 | 256 | compile |
| A1 ring words (B + 1)·W | 4 096 | 65 536 | compile (above it the array is A2) |
| group arena cap (words) | 4 194 304 | 2^24 | compile option `groupWords` / per call (lower only) |

## 12. Worked examples (operational)

**`r = [* uint, uint]` on `[1]`** (A0; `SEQ(REP(0, INF, ENTRY p0), ENTRY
p1)`).

1. Element 0: C = {p0, p1}, so r₀ = {p0, p1}.
2. Steps so far (4): SEQ; REP; `ENTRY p0` at 0 ✓; `ENTRY p0` at 1, which
   waits for record 1.
3. End of input: the waiting `ENTRY p0` at 1 fails (E2 at 1). The REP ends
   with count 1.
4. `ENTRY p1` at 1 fails (E2, 1 step). The root fails.
5. Witness: `missing`, `INDEX 1`.

**`r = {? (a: int, b: int), * tstr => any}` on `{"a": 1}`** (tier S; class R
is the wildcard).

1. Arrival: slot a = (wire 0; `a: int` ✓; wildcard key ✓, value ✓).
2. End-run: SEQ; REP; SEQ; `MEMBER a` consumes slot a.
3. `MEMBER b` fails (`missing`, score 1). The REP iteration fails and is
   undone (rewind 1, plus 1 popped). The REP ends with 0 iterations.
4. The wildcard member imports its unnamed state (none) and consumes slot a.
   Closedness ✓.
5. Valid under `branch` (rule A). Under the default rfc, `MEMBER a`'s key match raised
   `commits`, so the failed iteration returns `fail!`: invalid, witness
   `missing` b.

**`r = {? (a: int, b: int), * tstr => any}` on `{"a": "x"}`.** Under `branch`
(rule A), `MEMBER a`'s value fails and the member has a cut, so it
returns `cut`. That passes through SEQ and REP to the root: invalid, with
`value` at a. Format 1 and Ruby both accepted this.

## 13. Questions remaining for the format

1. Is up to 10 doubling re-runs on the buffer route acceptable for A2/T
   inputs that outgrow the lease? The alternative is a resumable buffer
   driver that relocates like the session.
2. Should `ACT_SUM` use 4-word frames for array programs instead of the
   common 8?
3. Is a 64-word chunk the right size?

## 14. Implementation notes (P8.5 phase 1, branch `p85-peg`, 2026-11-04)

The compiler (`kin/compile/peg.kin`, `lower.kin`, `emit.kin`) writes and
`vm-verify` checks this format; the VM does not run it yet (phase 2). Where
the draft is silent or wrong, the implementation decided as follows (DEVLOG
D290–D299, all unsigned):

* **§2, word 62.** Format 1.1's word 62 was `S_END`, not reserved. Format 2.0
  drops `S_END` (the last section ends at `PROGRAM_WORDS`) and word 62 is
  `RECLEAF_MAX` (D296). `FORMAT_VERSION` is always 2 (D318); the 1.1
  extension table is part of 2.0.
* **§3.** `depth` is the root's height counting every node, a `CALL` being a
  leaf (D295). `B` is stored only for A1. Positions and members are numbered
  in node order and nodes in preorder; the verifier checks the numbering and
  that no `REP` of a `MEMBER` the fold table rewrites remains (D291, D297).
  An occurrence `n*m` with m < n is a schema error (`syntax`, D293).
* **§3.1.** The verifier's working area follows the marks; `vm-verify-words(P,
  mark_cap)` gives the scratch length. The verify budget is raised before each
  fixed point by 4·(n_calls + 2)·n·(2W + 2) + 4·n·npos·W per array table and
  4·(n_calls + 2)·n per program (D297). New check ids: 25 `C_VERSION`, 26
  `C_RECURSION`.
* **§6.** `named`'s second word is the offset of the key's run in `namers`.
  `key_ts` is the exact union of the non-literal members' key typesets (no
  normalisation), so each member's own key leaves are queried (D294).
* **§9.4.** W7 compares the bound with the compiled cap `LIM_GROUP_WORDS`
  (the default unless `groupWords` was given).
* **§11.** Compile option 5 is `pegNodes` (default 1024, hard 16384); members
  per map and frames per activation are bounded by it; the ring limit is the
  default 4096 words (D292).
* **Keys.** A byte-string, float or beyond-64-bit integer before `:` is a cut
  key typeset (withdraws D125's `map_cut`, D294).

## 15. Implementation notes (P8.5 phase 2, branch `p85-peg`, 2026-11-11)

The VM runs this format on both routes (buffer and session, sequences,
EMBED and `.cborseq`); format 1 is gone from the VM, compiler and harnesses.
Decisions D310–D319 (DEVLOG, unsigned) record where the build departs from
or fills in the draft:

* **Layouts (§5.2, §6.3, §9.1, §9.2; D311).** The block tables above are the
  built ones: a 16-word array header, a 22-word map header with 6 words per
  member, S's trail in the block (MAPWORDS + n_named), `rec_words = 4 +
  ⌈2·n_members/32⌉`. The compiler's frame sizes and the verifier use the same
  formulas; `vm-scratch-words` adds the arena header and the lease.
* **T sort (§6.5; D312).** A heap sort of a permutation in the arena, by an
  in-VM EC comparator over the checked DC key bytes (nested maps compared by
  selecting each side's next key in EC order); each comparison is charged
  ⌈min(len)/8⌉, at least 1, before it is made.
* **Growth (§9.4; D313, D314).** The buffer route answers −5 with out word 7
  (the hosts' existing growth loop); the session gates before charged work and
  relocates at the next step. `group_limit` (44) is a miss at the effective cap
  (D276 as amended), with the offset of the item or container whose work
  missed.
* **Limits word 8.** Bit 2 is the forced-tier mode (every array A2, every map
  T); bit 3 turns off the multi-item streaks with the schedule unchanged
  (D315), for the gate that a streak charges what the item-by-item walk
  charges.
* **Streaks (D315).** D044's `[* T]` element streak (A0, steady at its
  `ENTRY`) and the map pair streak (a single-block tier-F map in a simple
  shape, schedule 2) are kept; everything else runs the machines.
* **Format word (§1; D318)** is 2, D100's spelling of 2.0; W7 (D317) fires
  only when the bound at the compiled limits exceeds the cap.

