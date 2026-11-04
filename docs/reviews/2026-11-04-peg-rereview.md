# Focused re-review: PEG group semantics, revision 2

2026-11-04. **Verdict: not ready to implement as an executable contract.**
Revision 2 fixes most of the original semantic counterexamples. The arena
bound still omits simultaneous recursive blocks, its allocation convention
does not cover their interleaved stacks, and the revised witness and charging
contracts have remaining counterexamples. Do not freeze Program 2.0 yet.

Reviewed commit `d4dd863`, architecture §20 and `docs/program-2.md`, both
original reviews, SPEC, relevant architectural dependencies, and DEVLOG
D272–D279. The working tree contains unrelated changes. In particular, while
this review was running, the working-tree §19.5 acquired the D277 charge-point
amendment and DEVLOG recorded P8.4's agreement. I give that amendment credit
below; it is additional to revision 2, whose §20.6 still calls it pending.
Program 2 and §20's substantive rules reviewed here match revision 2.

Evidence is distinguished throughout:

* **Prototype:** read and ran `.cache/peg/proto.mjs` in inline Node scripts,
  without writing scratch files. `cuts: 'branch'` implements revision 2's
  default rule A; `member` implements revision 1; `rfc` uses epochs. The
  prototype already had these modes; it has no tiers, arena, witnesses or
  charge scheduler. It is not an implementation test of those mechanisms.
* **Derivation:** re-ran the storage, normalization, trace and charging
  counterexamples against the written transitions, sometimes with small
  independent inline calculations. These calculations are not VM tests.
* **RFC:** checked the local `corpus/rfc/rfc8610.txt`, specifically §3.5.4
  and Appendices A, C and H. No network or Ruby invocation was used. Ruby
  observations in the design remain observations from the earlier runs.

Only this report was written. No project gates, emission, benchmark, build,
state-changing git operation or implementation change was performed.

## Every original blocker and major finding

`C#` identifies the Claude review; `X#` identifies the Codex review. A
**resolved** judgment concerns the original defect at design level, not an
unrun implementation gate. New defects are numbered N1–N9 below.

| Finding | Status | Revised text and counterexample re-check |
| --- | --- | --- |
| **C1 — blocker: name transparency / verbose versus compact cuts** | **Resolved for the reported equivalence; RFC qualifications below** | §20.2: “`SEQ` and `REP` pass `cut` through” and “Only a `CHOICE` absorbs it”. Prototype: both `{rater-value, ? conf-value, * ext-value}` and `{rater:text, ? confidence:uint, * text=>any}` reject `{rater:"x",confidence:"bad"}` in `branch` and `rfc`; revision-1 `member` accepts the verbose form and rejects the compact form. App. H equivalence is restored. This does not prove rule A is the RFC's cut semantics. |
| **C2 — major: undefined maxlen / FAIL invalidates B** | **Resolved** | Program 2 §3.2: “`ml(EMPTY) = ml(FAIL) = 0`”, “`ml` is syntactic”, and “an unsatisfiable minimum does not shrink a `REP`'s length”; §3.1 requires recomputation. For the original `[* ((int,int,? (int,int,int,$$g),tstr)//int)]`, inner `ml=3`, inner `FL=3`, first alternative `ml=6`, `FL=5`; hence B=5 and six ring rows retain r₀ while processing `[1,2,3,4,5]`. The prototype accepts. `0·INF=0` is explicitly stated for the lo=1 case. This checks the finite-tree counterexample, not an implemented ring. |
| **C3 — major: invalid F occurrence fold** | **Resolved for verdicts** | Program 2 §3.3 restricts the basic fold to “`REP(lo, hi, MEMBER(1,1))`” and gives `REP(lo≥2,…,MEMBER(k≥1,INF)) → SEQ(MEMBER(k,INF),FAIL)`, permitting plain FAIL only without cuts. `{2*3 (+ tstr=>int)}` on `{a:1,b:2}` and `[2*3 (+ uint)]` on `[1,2]` both reject in the prototype: the first inner repetition exhausts its matches and the second cannot meet its minimum. There is no multiplied-bound acceptance. Synthetic FAIL witnesses remain unspecified (N5). |
| **C4 — major: T permutation unavailable on canonical path** | **Partially resolved** | Program 2 §6.5: “the machine heap-sorts a permutation of the records” and “It does not use §19.4's permutation”. Thus the original missing scanner permutation is no longer a dependency: `{int=>int,int=>6}` sorts its own records and makes the EC pick on every route. However, sorting is still restricted to finite-max nonliteral members. That is insufficient for the new failure-score semantics, and therefore for its work/diagnostic contract (N4). |
| **C5 — major: default arena rejects ordinary valid-size inputs** | **Partially resolved** | Program 2 §9.4 says “The arena is not preallocated”, derives `A_max`, and grows by retry or `VMS_GROW`; §8 restricts `group_limit` to an explicit limit. A 65,536-pair T map or 65,536-element A2 array no longer intrinsically hits the old 65,536-word ceiling: its record term scales with the effective item limit. But `A_max` is not a valid total bound, and the growth promise is not executable as specified (N1–N3). Moving the fixed ceiling does not establish “Neither route ever refuses at default limits”. |
| **X1 — blocker: recursive caller frames have no storage** | **Partially resolved** | Program 2 §5.3: “A recursive program has no static stack. Every frame lives in the arena's downward region”; CALL has a three-word activation record and return restores `act`, `sp`, `pc`. For `[g]`, `g=(0,?g,1)`, the outer SEQ/REP can now survive the inner call; prototype `[0,0,1,1]` accepts. This repairs a single block's convention, but not interleaving live blocks or their total storage (N1, N2). |
| **X2 — blocker: eight words contain nine or more fields** | **Resolved** | Program 2 §5.2 explicitly assigns array offsets +0…+13, including `ev_idx`, `ev_kind`, `ev_off`, `act`, `rec0`, `head`, followed by two W-word sets, and derives `ARRWORDS = 14 + 2W + …`. §6.3 likewise gives the map's sixteen-word prefix, per-member fields and eight-word frames. `[(uint,tstr)//(uint,bstr)]` on `[1,false]` rejects in the prototype; the layout now has distinct places for the failure tracker and retained offset. This is layout inspection, not a scratch execution. |
| **X3 — blocker: ascending-only key lookup** | **Resolved** | Program 2 §6.1: “From the first key that does not ascend, binary search the full range `[0, N_KEYS)`”; unordered naming lookup also uses binary search and charges per probe. For `{a:int,b:int}` on wire `{b:2,a:1}` (`a2616202616101`), finding b no longer excludes a from the next search. Prototype accepts; the revised lookup itself is verified mentally. |
| **X4 — blocker: duplicate-sort precharge versus session order** | **Partially resolved overall** | Revision 2 §20.6 and Program 2 §10 put duplicate units “At a map's logical end”. At `d4dd863` this was expressly still a requirement on §19.5. The working-tree §19.5 now says the scanner records each marked map's units and “the VM charges the units when it reaches that map's end”; DEVLOG D277 records agreement. That closes the original valid-input example `[uint,{0*1000 int=>int}]` with descending inner keys: prefix work precedes the duplicate units everywhere. The scanner's early refusal outcomes are not similarly deferred, so the broader route identity remains incomplete (N6). Stale pending-dependency wording is N9. |
| **X5 — major: F and T choose different cut witnesses** | **Partially resolved** | Program 2 §8 defines the “cut-violating pair with the smallest wire index in the member's scope” and makes T perform a diagnostic scan, one step per record. On `{*tstr ^=>int,?"a"=>any,?"b"=>any}` with wire `{b:"x",a:"y"}`, both pairs are in the unbounded member's entry scope and b is wire-first. The specified diagnostic scan therefore makes both tiers report b, fixing the original example. But selecting *which member's event* wins can still depend on unsorted traversal (N4), and FAIL has no event (N5). |
| **X6 — major: collapsing nested occurrences** | **Resolved for verdicts** | Program 2 §3.3 explicitly contrasts `{2*2 (+ int=>int)}` with `{2* int=>int}`. Prototype on `{1:1,2:2}` rejects the former and accepts the latter. The exact fold preserves this: one greedy body followed by FAIL is not a member with multiplied bounds. See N5 for the new event obligation caused by emitting FAIL. |
| **X7 — major: huge nullable minimum incorrectly becomes FAIL** | **Resolved** | Program 2 §3: “No count is lowered to `FAIL`” and “A saturated minimum is therefore unsatisfiable except through the zero-length rule, which stays available”; `0*0 g` becomes EMPTY. For `[16777216*16777216 (? int)]` on `[]`, the optional child succeeds without consumption, R4 satisfies the saturated minimum, and the array accepts. This is a textual execution: the prototype compiler returns `occurrence bound`, so it supplies no verdict for this case. |
| **X8 — major: memo storage lacks EOF row** | **Resolved by removing the mechanism** | §20.5: “Memo cells and link cells are withdrawn”; Program 2 §1 requires a future capability rule and §3 reserves the fields. On `[* ((*uint,tstr)//uint)]` / `[1,2]`, the final attempt may still test at n, but there is no memo store at n. The prototype accepts. EOF needs no verdict row, and the array end does not overwrite a ring row. |
| **X9 — major: rfc cut lifetime differs between prose and prototype** | **Resolved** | §20.2 now snapshots commits per alternative/iteration and says “A fresh iteration that sees no cut can still end its repetition normally”; it also explicitly calls these lifetime rules “snug's formalisation”. On `{*(a:int)}` / `{a:1}`, first-iteration commitment does not disable the fresh second iteration's stop, so the map accepts (prototype agrees). An enclosing attempt that later fails still sees the successful inner cut's epoch increment. The sticky-frame-bit interpretation has been replaced. |
| **X10 — major: unjustified general linear-time claim** | **Resolved by withdrawing it** | §20.7: “That claim is withdrawn”, including D270's nodes-times-elements claim. Memoization is not shipped; T is budget-bounded with a stated quadratic example, and the array coefficient may be exponential in nesting. Re-running the four-level nested `2*2` example on 32 zeroes accepts in the prototype; the failed sixteen-element prefix is still retried at successive starts. `{*(int=>int//tstr=>tstr)}` still makes n+(n−1)+… key examinations. Both are admitted rather than incorrectly called O(n·nodes). The separate A0/A1 proof and verifier-cost presentation need qualification (N8). |
| **X11 — major: incomplete arena sum and unavailable resource offsets** | **Partially resolved** | Program 2 §8 makes end-run allocations report “the container's `head`” and says “Every allocation comes after its charge”. The original trail-overflow example no longer needs an old pair offset: both tiers report the retained map head, with budget winning the same allocation event. Records, permutation/trail and recursive activations are now listed. The activation aggregation in the formula is nevertheless wrong, with additional allocator/growth gaps (N1–N3). |
| **X12 — major: trace score lost on undo; S omits unnamed counts** | **Partially resolved** | Program 2 §8 scores “the trail length at that moment, before any undo”, and map frames now retain score/events. On `("a"=>int,"b"=>int)//("c"=>int,"d"=>int,"e"=>int)` with `{a:1,c:1,d:1}`, scores are 1 and 2, so missing e survives undo and wins. §6.4 explicitly imports S's `ucount`, `ukey`, `ucut`; `{+tstr=>int,?(a:int)}` on `{z:1}` succeeds (prototype agrees). These repair the original examples. The score is still operationally order-sensitive in cases excluded from the T sort, and FAIL propagation is undefined (N4, N5). |
| **X14 — major: oracle cannot establish execution/resource correctness** | **Resolved as a testing design** | §20.12 distinguishes `rfc`, `policy`, `observed`, `invariant`, and says the oracle “cannot certify tiers, rings, the arena, charges or witnesses”. Separate forced-tier, encoding, split and resource gates are required. Tag unwrap is explicitly lowered in §20.2/R17 and required in the future oracle. `[~tagged]`, `tagged=#6.99(uint)` on `[1]` should accept; the existing prototype still returns `unknown`. No oracle completion or passing gate is implied. The gate assertions themselves need the N7 qualification. |

There are no omitted blocker/major rows: C1–C5 and X1–X12/X14 are all
covered. X13 was minor; C6–C16 and X15–X17 were minor findings or notes.
Relevant remaining issues from those are addressed below.

## Rule A against the RFC: what follows, and what does not

The App. C name-substitution requirement and App. H's equivalent verbose and
compact `reputon` support fixing the old optional-group inconsistency. Both
rule A **and** the epoch mode satisfy that example. They do not select rule A
uniquely, or establish its treatment of explicit choices.

The local RFC supplies four separate constraints/tensions:

1. **§3.5.4:** the no-cut optional bad value is allowed through the wildcard;
   with a cut, “when it does not, the entire map fails to match”. Rule A
   passes both concrete optional-key examples: prototype results are accept
   without `^` and reject with `^`.
2. **Appendix A:** a cut is contrasted with ordinary lock-in because it
   disables “alternatives in choices containing this choice”. Rule A
   expressly lets such a containing `//` recover. This is its known RFC
   deviation, not resolved by name transparency.
3. **Appendix C:** occurrences act as a possibly infinite group choice with
   the group repeated the allowed numbers of times. Rule A gives REP a
   different cut boundary from explicit CHOICE. For `{a:"x"}`:

   ```cddl
   r = {? a: int, * tstr => any}          ; rule A rejects
   r = {(a: int) // (), * tstr => any}    ; rule A accepts
   ```

   Both verdicts were reproduced in the prototype. The second form is the
   greedy one-then-zero choice expansion of the optional group. Under the
   epoch mode both reject. Rule A therefore preserves the selected App. H
   equivalence while declining literal occurrence-as-choice expansion in
   the presence of cuts. §20.3 should name this policy exception explicitly.
4. **Appendix H:** its `? conf-value` / `? confidence: float16` equivalence
   is restored. Named groups introduce no dynamic cut scope in revision 2.

Consequences that should be part of the accepted policy, not described as
unqualified RFC conformance:

* `?` and `*` cannot hide a bad cut value, including through named groups.
  Explicit `//` can: `{(a:int)//(*tstr=>any)}` accepts `{a:"x"}` under
  rule A and rejects under epochs. Prototype confirms both.
* A **successful** cut does not commit a rule-A alternative against a later
  ordinary failure. `{(a:int,b:int)//(*tstr=>any)}` accepts `{a:1}` under
  rule A, rejects under epochs; both reproduced. D021's discriminated-union
  behavior is kept, including this fallback consequence.
* If all alternatives fail and any raised `cut`, rule A re-raises `cut`;
  an outer optional REP cannot then erase it. This is stronger than treating
  a cut as ordinary failure, but weaker than map-wide commitment.
* Neither mode revives a pair already taken by an earlier member. For
  example, an earlier `*tstr=>any` can make a later optional cut ineffective.
* The seven recorded RC disagreements and twenty-two extra corpus flips
  are disclosed migration consequences. I did not rerun those complete
  campaigns. Calling the default `reference` no longer describes agreement
  with Ruby, as the revision correctly acknowledges.

Choosing rule A is a recorded manager policy, not a new blocker by itself.
The misleading “It honours §3.5.4's ‘later entries … are no longer allowed’”
bullet in §20.2 needs the explicit-choice exception: a cut can be absorbed by
`(a:int)//()` and the same key taken by the later wildcard (N9).

## New and remaining findings

### N1 — BLOCKER: A_max takes a maximum where simultaneous blocks require a sum

Program 2 header word 63 is “the maximum, over recursive PEG programs, of
`n_calls · (8·depth + 3)`”. §9.4 then uses:

```text
A_max = maxItems·R_ITEM_MAX + 2·maxEntries
        + (maxItems + D + 1)·ACT_WORDS
```

Every admitted ARRAY/MAP leaf has its own live machine. The same input
element can advance twenty recursive machines, each retaining frames.
`R_ITEM_MAX` sums their **records**, but `ACT_WORDS` covers only one machine's
activation cost. Summing open physical containers does not account for this.

Concrete family:

```cddl
r = [g0] / [g1] / ... / [g19]
g0 = (uint, ? g0, 0)
g1 = (uint, ? g1, 1)
; ... twenty distinct, guarded recursive groups
g19 = (uint, ? g19, 19)
```

Feed an array of 1,000 zeroes, with effective `maxItems=1001`,
`maxEntries=1000`, D=32. Before EOF each block has followed its recursive
uint prefix and is waiting for the next element. These are distinct PEG
programs and ARRAY leaves, not identical arrays eligible for hash-consing. Each activation
retains at least a four-word SEQ frame, a four-word REP frame and the
three-word CALL record. The per-activation static depth is at most three.

Thus `R_ITEM_MAX=20` and `ACT_WORDS≤27`. The advertised bound is at most
`1001·20 + 2000 + 1034·27 = 49,938` words. The retained frames and records
alone require at least `1000·20·11 + 1000·20 = 240,000` words. These figures
were independently calculated inline; no full VM was executed. The query
width and per-group sizes fit the proposed defaults. The final verdict is
irrelevant: the storage is live before EOF.

**Required:** derive activation capacity over simultaneous closure leaves,
as is already done for records. Also account explicitly for embedded
sub-validations: the inherited EMBED contract resets the item counter while
outer arena state remains retained, so a global “at most one per item” proof
cannot simply use that reset counter. Define the addressable outcome when a
saturated bound exceeds the arena representation. The current bound cannot
justify a safe one-retry allocation or a default no-refusal guarantee.

### N2 — BLOCKER: one downward LIFO region does not implement interleaved suspended machines

Program 2 §5.3 says the callee's frames follow its activation record and
“A return, success or failure, pops the callee's frames and the record”.
That works for one machine. It does not specify an allocator for several
machines stepped once per element.

With two recursive ARRAY leaves, A suspends with live frames; B then pushes
and suspends. On the next element A resumes while B's frames are still above
its frames in allocation order. A cannot use an ordinary global stack pop
to return, nor assume its next frame is adjacent to its previous frame.
The same situation occurs when an inner container runs while an outer
container's machine remains suspended. Saving `act` and a frame count does
not make these allocations globally LIFO.

**Required:** specify per-block stack segments, a pool of individually
linked frames with reclamation, or another complete convention. Include
segment/link/allocator metadata in the bound and its work in the charges.
The per-activation layout is improved, but it is not yet a storage protocol
for the specified incremental execution.

### N3 — MAJOR: growth is neither a safe allocation bound nor a complete session relocation protocol

Program 2 §9.4 sends the buffer route from a 4,096-word lease directly to
“`A_max` words” on its first miss. For only one recursive program with
`n_calls=1`, depth=64 and one-word records, default item/entry/depth limits
give:

```text
ACT_WORDS = 515
A_max = 131072 + 131072 + (131072 + 32 + 1)·515
      = 67,781,219 words = 271,124,876 bytes
```

This is allocation arithmetic, not a memory measurement. It exceeds the
architecture's 128 MiB Worker environment and even the inherited 64 MiB hard
Program/pool/scratch limit. A small run that barely exceeds the lease need
not need anything close to that allocation. Larger legal products saturate
the signed-word range; “computed with saturation” does not make allocating
the saturated number safe or sufficient.

The session side says the host “copies the scratch into a larger array” and
resumes. Its downward frames contain arena offsets and live next to an
upward record region. Copying at unchanged offsets does not open the gap
between those regions; moving downward frames to the new end requires
rebasing `act`, saved caller pointers, stack/segment pointers and relevant
tops. That procedure and its capacity/charge rules are absent. Preserving
the old downward top while only increasing the end leaves an unusable hole.

**Required:** an addressable checked maximum, an explicit reconciliation
with the existing scratch caps and allocation-failure contract, and a
growth algorithm that allocates for demand rather than the entire loose
worst case. Specify pointer relocation or stable segmented addressing on
sessions. If incremental retries replace the single jump, revise the
“at most twice one run” CPU claim and replay/EXT accounting accordingly.

### N4 — MAJOR: unbounded cut members make failure scores and steps order-sensitive

Program 2 §3.3 defines order-sensitive as a nonliteral key with finite max;
§6.5 consequently skips sorting other T programs. But §8's new score is the
trail length at the first operational failure. This counterexample uses
only unbounded nonliteral members:

```cddl
r = {
  ((* tstr ^=> int) // (* tstr ^=> tstr)),
  ? "a" => any,
  ? "b" => any
}
```

Use `{a:1,b:"x"}` under rule A. Both branches fail with cut; the optional
literal members name a and b for diagnostics and prevent an M1-only
explanation. The prototype confirms refusal. The revised event rules give:

| Traversal | int branch | tstr branch | Winning event |
| --- | --- | --- | --- |
| EC order a,b | consumes a, cut at b; score 1 | cut at a; score 0 | value at b |
| Unsorted wire order b,a | cut at b; score 0 | consumes b, cut at a; score 1 | value at a |

The prescribed T path does not sort this schema. Each member has only one
violating pair, so the new diagnostic scan cannot repair the difference.
An independent inline trace calculation reproduced these scores. One
interpretation of “`cut` … pass up the event that raised them” instead of
CHOICE's best-event rule would introduce a further ambiguity; §8 must make
their priority explicit.

The same stopping-order issue changes MEMBER examination/consume charges.
The claim “F and S never need [pick order]” can still hold for their restricted
root forms; extending that argument to every T without finite maxima is
incorrect. **Required:** sort T whenever operational cut traversal affects
the trace, or define and charge an order-independent failure-score rule.
Gate this example in named-key form, including permuted valid encodings.

### N5 — MAJOR: the fold table emits FAIL, but FAIL has no failure event

The new fold table can turn `{2*2 (+ tstr=>int)}` into plain FAIL, or retain
`SEQ(MEMBER(k,INF),FAIL)` for a cut member. Program 2 §8 creates map events
only “When a `MEMBER` fails”. On `{}`, the plain FAIL form rejects without
ever executing MEMBER; no root event exists to report. With a successful
cut member followed by synthetic FAIL, there is likewise no failing child's
event for SEQ to pass up. An unplugged `$$g` is another source of this gap.

Arrays have the analogous boundary: `r=[$$g]` on `[]` executes FAIL without
an ENTRY failure or root-success E3, while rule 5′ assumes an event tracker
that identifies one of those cases.

**Required:** define events for FAIL and initial empty/failing roots, and
their score, schema position/path, offset and propagation. Alternatively
retain provenance for the eliminated failed iteration. Define whether
normalization intentionally changes diagnostics. The new explicit layout
does not by itself define the missing event's contents.

### N6 — BLOCKER: D277 defers units, but not early scanner refusal outcomes

The working-tree §19.5 amendment repairs the original *valid-input* charging
counterexample. It still first checks the input with the scanner, builds a
trusted copy only after checking it, and then runs the VM. Ordinary scanner
refusals are not recorded for logical replay as embedded refusals are.
Architecture §4.5 and Program 1 §17 Q17 explicitly say budget exhaustion
stops the walk and a later profile error cannot be found.

Consider `r=[uint,{* int=>int}]` with an indefinite root array containing
`0` and a map in wire order `{2:0,1:0,2:0}`. Example bytes are
`9f00a3020001000200ff`. Choose a budget sufficient to enter the root and
discover its indefinite head, but exhausted before the native framed walk
reaches the later duplicate. Increase the map/prefix length if needed to
separate those events.

* Buffer: the deterministic attempt discovers the indefinite head, is
  discarded, and the unmetered scanner discovers `duplicate_key` before
  the canonical VM runs.
* Native framed session: it admits the indefinite head and spends its
  budget on the prefix/pairs; it stops with `budget` before that duplicate.

The duplicate-unit table cannot reconcile different refusal codes. A
malformed later item has the same problem. This is a mental execution of
the specified routes, not a claim about an executed new VM. It is a remaining
dependency defect, not a request to change PEG's Boolean semantics.

**Required:** canonical preprocessing must retain enough partial structure
and refusal information to replay failures at the same logical events, or
the route/precedence contract must be redesigned consistently. Test invalid
CBOR as well as valid encodings, with budgets around the first divergence,
whole versus framed sessions, and EMBED. Moving sort units alone is not a
proof of full out-array identity.

### N7 — MINOR: two new gates need resource and wire-order qualifications

§20.12 requires every valid re-encoding to give “the same verdict and
witness”, but §20.9 deliberately chooses the first unacceptable wire pair
and the wire-first diagnostic cut. In X5's named a/b example, swapping the
two pairs deliberately swaps the diagnostic key. Error offsets can also
move under re-encoding. Serialization-independent acceptance does not imply
identical wire-dependent diagnostics.

The forced-tier gate allows only budget-used differences, although forced
T/A2 uses more charges and arena than natural F/A0. At a tight budget or
explicit arena limit it can correctly return `budget`/`group_limit` where
the natural tier finishes. **Required:** state verdict/witness equality
under sufficient resources; gate resource outcomes against their own event
schedule. Restrict encoding invariance to the semantic verdict and the
documented invariant parts of diagnostics, or change the witness policy.

### N8 — MINOR: distinguish proposed proofs from established complexity bounds

Program 2 §3.1 announces verification cost
`O(Program words + npos·W·(n_calls+1))`, then supplies SCC iteration with up
to `npos·(n_calls+1)` **rounds**, without costing the nodes/edges and bitset
operations processed in each round. Architecture §20.7 more cautiously adds
“plus the fixed points”. The announced verify-budget formula does not
explain that extra work. This partially repairs original minor X13, but
does not prove the displayed cost bound.

Similarly, the A0/A1 fixed-group linear bound is expressly a “review item”
in §20.16. I found no new finite-tree counterexample to B or that narrower
linear claim; the stated sketch is not an executed proof/test. Keep these
as proof obligations, or supply a worklist/amortized algorithm and budgets
that cover it, before calling all displayed contracts proven.

### N9 — MINOR: clean up policy and dependency wording

The current §19.5 and D277 agreement now contradict §20.6, §20.14, §20.16,
Program 2 §10 and the DEVLOG revision note that still call the amendment
pending. Mark the charge-point dependency completed while retaining the N6
failure-order obligation. Qualify §20.2's claim that rule A honours the
later-entry restriction, and explicitly record the Appendix C occurrence
expansion exception discussed above. Neither naming transparency nor
Ruby disagreement alone selects the complete cut policy.

## Verdict

**Not ready to implement/freeze as written.** Keep the repaired semantics,
exact block layouts, unordered lookup, memo removal and restricted folds.
Before handing off the executable format, fix simultaneous activation
accounting and allocation, specify safe growth and FAIL events, reconcile
cut-score traversal with T sorting, and complete the D277 refusal-order
contract. Then tighten the gate assertions and proof labels. No additional
Boolean vote from the current prototype can establish those storage,
witness or driver properties.
