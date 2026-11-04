# Focused final check: PEG design, revision 3

2026-11-04. Reviewed revision 3 at `5890eb7`: architecture §20,
`docs/program-2.md`, DEVLOG D273–D280, and the N1–N9 re-review. Also read
SPEC and the relevant inherited profile, EMBED, scratch and charging rules.
The working tree contains unrelated changes; Program 2 matches that commit.
This review accepts the manager's N3 policy: a 16 MiB default arena cap,
allocation on demand and W7 replace the promise of no default refusal.

“Resolved” below means the reported design defect is addressed, not that an
implementation gate passed. Evidence consists of document inspection and
inline trace/arithmetic calculations. The existing prototype was run only
to confirm rejection of F1's schema/data in both cut modes; it has no
witnesses, chunk allocator or charge scheduler. No implementation tests,
builds, emission, benchmarks, network or state-changing git commands were
run. Only this report was written.

| Re-review finding | Status | Quoted revision-3 evidence and assessment |
| --- | --- | --- |
| **N1 — blocker: simultaneous activation accounting / EMBED** | **resolved** | Program 2 §5.3 defines `ACT_SUM` as the maximum over closure sets of the **“sum of ⌈n_calls·(3 + 8·depth)·64/54⌉ over the recursive leaves”**. §9.4 uses `VM_GROUP_ITEMS · (R_ITEM_MAX + ACT_SUM)` and a `(D + 1) · (ACT_SUM + 64 · RECLEAF_MAX)` allowance; the global counter **“is never reset (unlike the EMBED item counter)”**. Thus the twenty distinct live machines contribute twenty activation costs, with chunk overhead/slack explicit. Saturation no longer authorizes a giant allocation: demand is checked against the separate addressable cap. |
| **N2 — blocker: interleaved machines cannot share one LIFO stack** | **resolved** | Program 2 §5.3 gives each recursive block its **“own chunk list”**, with **“2 header words (next chunk index or −1, words used)”**, non-spanning entries, free-list reuse and reclamation. **“Each pushes and pops only in its own list, so no global LIFO order is needed.”** CALL saves three words; **“1 step per chunk link or unlink”** covers allocator work. A can resume/return while B remains suspended without popping B's storage. These are inspected storage/charging rules, not an executed allocator test. |
| **N3 — major: unsafe growth and unspecified relocation** | **resolved** | Program 2 §9.4: **“Allocation follows demand, never the bound”**; the default is **“4 194 304 words (16 MiB)”**, the hard maximum is `2^24`, outside `LIM_TOTAL_BYTES`. Sessions copy the upward region unchanged and the heap to the new end; **“Record offsets, chunk indices and chunk addresses … are all relative, so nothing else is rebased.”** Buffer retries explicitly repeat EXT calls under purity. This addresses the original jump-to-`A_max` and moving-pointer defects under the accepted cap policy. However, **“≤ log₂(cap/lease) ≤ 10”** holds only for the default 4,096-word lease and 16 MiB cap: the legal 64 MiB cap requires 12 doublings, hence 13 runs. Correct that qualification; it is not a separate major. |
| **N4 — major: unbounded cut traversal changes scores/steps** | **resolved** | Program 2 §6.5: **“T always traverses in pick order, because cut traversal, failure scores and step counts depend on it even with unbounded members”**; unordered or EC-sensitive maps get their own charged heap-sort permutation. §8 says a **“CHOICE that re-raises `cut` passes up its best event”**. N4's named a/b example therefore uses a,b for both alternatives on every route, retaining scores 1 versus 0 and the b event. The sort condition, comparison charges and F/S restrictions are consistent with this repair. |
| **N5 — major: FAIL lacks an event** | **partially** | Program 2 §8 now says **“A `FAIL` node also records an event … its score is the trail length and its kind is `missing`”**, with member provenance or no key for a socket. Arrays get **“E4, a `FAIL` node tested at index i”**, choosing unexpected versus missing at the input boundary. These close the empty-root/socket gaps. The stronger promise that a fold **“reports what the unfolded `REP` would”** fails for the allowed no-cut fold to plain FAIL: provenance restores the member, but not its consumed-prefix score. New F1 below. |
| **N6 — blocker: scanner refuses before earlier VM budget work** | **partially** | Architecture §20.6/D280 proposes recording **“its code, its input offset, and its logical event”** and replaying while preserving **“profile-only continuation after a schema failure (D023), and stopping on `budget`”**. This is the right direction, but the same section says **“This needs P8.4's agreement and a §19.5 amendment”**; Program 2 §10 and §20.16 still mark it pending. Moreover, the new head/prefix replay contract is insufficient as written (F2). N6 is not closed by recording the intention or by D277's completed valid-input charge amendment. |
| **N7 — minor: resource and re-encoding gate qualifications** | **partially** | Program 2 §8 now requires **“with sufficient budget and arena”** and gates each tight-resource run against **“that mode's own charge and allocation schedule”**. Architecture §20.12 agrees. But §20.9 still says equality on **“every vm-test case”**, allowing only budget-used differences. Also §20.12 still labels **“reason, schema path”** wire-independent in general. First-unacceptable-pair reporting can change both; see the short example below. The main qualification is present, but these assertions need narrowing. |
| **N8 — minor: proof claims exceed evidence** | **resolved** | Architecture §20.7 labels both verifier complexity and non-recursive A0/A1 linearity **“Proof obligation”**. Program 2 §3.1 calls its cost figure **“not an established bound”** and explicitly charges fixed-point rounds. §20.16 retains both obligations. This resolves the presentation issue; it does not establish the bounds or prove the proposed verify-budget multiplier sufficient. |
| **N9 — minor: stale dependency / cut-policy wording** | **resolved** | Architecture §20.6 now states **“P8.4 agreed to D277 and amended §19.5 in 531220f”**. §20.2 qualifies the later-entry restriction and explicitly says rule A **“does not follow App. C's literal ‘occurrence acts as a group choice’ expansion when cuts are involved”**. R9 records the explicit-choice exception and that App. H transparency selects neither mode uniquely. DEVLOG's amendments distinguish completed D277 from pending D280. |

For N7, use `r = {a: int}` on the same invalid map encoded in orders
`{a:"x", b:1}` and `{b:1, a:"x"}`. The first unacceptable pair yields
`value` with named key a in the first encoding and `unexpected` with an
unnamed-key segment in the second. Profile-only continuation does not
replace either schema witness. Both semantic verdicts are rejection; neither
reason nor the complete returned schema-key path is invariant. This is the
remaining original N7 issue, not a new major.

**New F1 — MAJOR: plain FAIL folding discards the score that provenance is
supposed to preserve.**

Program 2 §3.3 still permits
`REP(lo≥2, hi, MEMBER(k≥1, INF))` to become plain FAIL when there is no cut.
Revision 3 now assigns that FAIL the *current* trail length and claims that
member provenance makes its report equal to the unfolded repetition.

```cddl
r = {
  ((2*2 (+ tstr => int)) // ("a" => int, "c" => int)),
  ? "a" => any, ? "b" => any, ? "c" => any
}
```

Use `{a:1, b:2}`. All pair values have matching members, so the map reaches
its end-run. The optional naming members keep the example independent of
whether folding drops the eliminated member from the query tables.

| Failed alternative | Unfolded score/event | With permitted plain FAIL |
| --- | --- | --- |
| `2*2 (+ tstr => int)` | First iteration consumes both pairs; second iteration has no pair: score **2**, missing `ANYKEY` | No consumption occurs: score **0**, missing `ANYKEY` |
| `("a" => int, "c" => int)` | Consumes a, then misses c: score **1**, missing `KEY c` | Same: score **1**, missing `KEY c` |

CHOICE therefore reports missing `ANYKEY` before folding and missing c
after folding. Both reject, in both cut modes; the declared witness
preservation is false. An inline independent trail/event calculation
reproduced these scores. The prototype confirmed only the Boolean refusal.

Required: retain `SEQ(MEMBER(k,INF), FAIL)` for no-cut members as well, with
the existing provenance, or specify another mechanism that preserves the
eliminated consumption and failure score. If diagnostics are intentionally
defined after normalization instead, withdraw the unfolded-equivalence
promise and explicitly adopt/test that policy. A member id alone cannot
reconstruct the missing score. Gate this example with a competing branch;
a standalone folded FAIL would conceal the problem.

**New F2 — BLOCKER: D280's head event and valid prefix do not define a
native-equivalent replay.**

Architecture §20.6 step 1 defines the logical event as **“the head of the
refused item”** for ordinary item refusals. Steps 2–3 build **“the canonical
copy of the valid prefix, up to that event”**, then **“The VM walks the
prefix as usual.”** Two distinct parts of that new protocol fail without
additional rules:

1. **A location is not a charge/check phase.** Let `r = [tstr, any]` and
   use `98 02 00 78 10`, followed by fifteen `61` bytes and `ff`. The
   non-shortest root head selects the canonical path. Element 0 fails the
   schema, so the next text is walked profile-only. Its content length is
   16, with invalid UTF-8 at the last byte. The inherited schedule charges
   its visit (1), then its UTF-8 scan (2), **before** reporting `text`.
   `kin/vm-dead.kin`'s `dead-text` explicitly charges before scanning.
   With one unit remaining before the text visit, the native walk returns
   `budget`. Replaying `text` merely when its head is reached, even after
   the visit, returns the wrong code. The valid prefix excludes the refused
   text; code, error offset and head location do not specify its pending
   scan charge. The same concern applies to key comparisons and to whether
   deferred-duplicate units precede their recorded refusal at map end.
2. **A partial container is not an ordinary canonical item.** Use
   `99 00 20 00 fc` followed by thirty `00` bytes: a non-shortest head for
   a 32-element array, one valid integer, then reserved AI 28. The native
   root's minimum-byte check passes (32 bytes follow its head); it reaches
   `malformed` at offset 4, subject to the budget. With `r = [tstr]`, the
   preceding integer also puts it in profile-only continuation. The stated
   canonical prefix before the malformed item is `98 20 00`. Walking that
   prefix “as usual” fails the inherited minimum-byte check immediately:
   only one byte follows a head claiming 32 elements. It reports
   `truncated` at the root before reaching the recorded event. Replacing
   the count or fabricating an end would also need explicit rules to avoid
   premature PEG end-runs and charges.

These are executions of the written contracts, with inline checks of the
byte counts and scan charges; no revision-3 VM exists to test. Preserving
profile-only continuation in prose is necessary but does not specify the
missing replay state.

Required: define an executable partial-copy/replay representation and
check phases. Preserve original length/end claims, open containers and
refused-item metadata; apply the same item counting and all charges that
precede the native refusal, including when the budget fails *at that same
logical event*. Prevent synthetic truncation/end-runs and avoid charging
live schema work after D023 switches to profile-only continuation. Specify
the analogous embedded and deferred-duplicate cases, then agree D280 and
amend §19.5. Gate invalid text, malformed/truncated partial containers and
duplicates with budgets on both sides of every relevant charge, across
buffer, whole-item/framed sessions and EMBED. This is a concrete defect in
the new proposed N6 repair, not a renewed objection to D277's charge point.

No additional blocker/major was found in per-block chunk ownership,
free-list link/unlink charges, stable-index session relocation, or T's
expanded sort condition. Chunk size, price calibration, the explicitly
labelled proof obligations and the accepted finite-cap policy are not added
to the blocking list.

**Verdict: not ready — F1 (folded failure scores); F2 (replay phases and partial-copy representation), completing N6 with the agreed §19.5 amendment.**
