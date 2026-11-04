# Independent review of architecture §20 / program-2.md (Claude reviewer) — 2026-11-04

Recorded by the manager from the reviewer's report (read-only reviewer; it ran
`.cache/peg/proto.mjs` without writing files). Subject: cd7c33c.

## Findings
1. **BLOCKER** — reference cut mode is not invariant under replacing a group name by its definition (RFC 8610 App. C; App. H gives verbose and compact `reputon` forms as equivalent). Verbose `{rater-value, ? conf-value, * ext-value}`, `conf-value = (confidence: uint)`, data `{rater:"x", confidence:"bad"}`: reference ✓ but compact `{rater: text, ? confidence: uint, * text => any}` ✗. No D021-style reading satisfies §3.5.4's example, the D021 idiom, App. C's "occurrence acts as a group choice" and name transparency together. Fix: make `cuts:'reference'` "rule A" — a cut failure is a distinct failure kind that propagates through SEQ and REP and is absorbed only by `//` (re-raised if all alternatives fail); keeps M12 and the D271 case; costs Ruby agreement on 5 probes (new Ruby deviation class, App. H as evidence).
2. **MAJOR** — the ring bound B is correct only with maxlen(FAIL) = 0 (never stated). Counterexample `r = [* ((int, int, ? (int, int, int, $$g), tstr) // int)]` with `[1,2,3,4,5]`: alt 2 needs r₀ already overwritten. Fix: syntactic maxlen with maxlen(FAIL)=0 (also unsatisfiable-min REP), state the invariant/lemma, verifier recomputes; 0·∞ = 0 in FL(REP) for lo=1.
3. **MAJOR** — the F-tier fold "REP around a single cut-free member is that member's occurrence" is false: `{2*3 (+ tstr => int)}` matches nothing under PEG; `[2*3 (+ uint)]` likewise. Exact fold table: REP(lo,hi,M(1,1))→M(lo,hi); REP(*,M(0,∞))→M(0,∞); REP(0,≥1,M(1,∞))→M(0,∞); REP(1,≥1,M(1,∞))→M(1,∞); REP(≥2,M(≥1,∞))→FAIL; otherwise no fold; with a cut only under rule A/rfc. Align §20.5 with program-2 §6.3.
4. **MAJOR** — the T-tier pick-order permutation does not exist on the buffer canonical path (§19.5 sorts in the scanner, the VM never sorts; session sorts in the VM). Fix: the T machine sorts its own records by EC bytes, charged identically on every route.
5. **MAJOR** — `group_limit` refuses valid data within default limits (T map refused from ~16k pairs; A2 65k elements). Fix: arena bounded by maxItems × max record words + trails + CALL bound; size and grow on demand via the scratch regrow protocol; `group_limit` unreachable at defaults.
6. **MINOR** — App. C's existential "can be ordered in such a way" differs from R8/R15 on order-sensitive groups (`{int => int, int => 6}` with `{3:6, 4:5}`; M24.1); state EC order as a legitimate resolution of §3.5.3's indeterminacy and warn on order-sensitive overlapping members.
7. **MINOR** — F cut events must stop at the pair's taker (`{* tstr => int, ? "a" ^=> tstr}` with `{"a":1}` is ✓).
8. **MINOR** — witness gaps (fail! trace; "most pairs consumed" before undo; F cut event vs count<min order; T "smallest wire index" set and charge; "member naming its key" for non-literal members); add a forced-max-tier test mode and gate verdict+witness equality across tiers.
9. **MINOR** — relaxed queries degrade witnesses and add EXT calls/charges (`[2*2 {a: int}, {b: {c: int}}]`); acceptable, document.
10. **MINOR** — T-tier steps can be Θ(n²) (`{* (tstr => int, int => tstr)}`); state or keep per-member cursors.
11. **MINOR** — §3.11 basis misattributed; keep R5, warn on dead alternatives.
12. **MINOR** — `{* tstr => any, "a" => int}` matches no map at all; compile warnings for shadowed required members, greedy repetition superset of a following required entry, REP(lo≥2) around a greedy non-nullable body, alternatives after one that cannot fail, order-sensitive members.
13. **MINOR** — program-2 consistency: root as CALL target; `0*0` → EMPTY; relaxed automaton through nullable callees; refuse growing generic recursion before lowering.
14. **NOTE** — the rfc formalisation is sound (equals the persistent key-lock reading for literal keys); add R19 (scope narrowed to the map type, per "entire map"); document surprises (M09, M20, M30; typeset cut keys commit on any matching key).
15. **NOTE** — the superset lemma holds (proof by induction on consecutive consumptions; cover R4 stop, FAIL, CALL, unwrap, generics, `.cborseq`); add a test-build assertion.
16. **NOTE** — charge determinism holds if the buffer driver steps the machine per element (streaks included) and a dying block's run is charged at the element where it dies.

## Answers to the 20 open questions
1 disagree (rule A); 2 agree (+R19); 3 EC order, T sorts its own records; 4 agree; 5 agree, warn; 6 holds; 7 B sound only with maxlen(FAIL)=0; 8 leave memo out of 2.0 (reserve fields); 9 F correct with taker rule and exact fold, S exact; 10 deterministic, add forced-tier gate; 11 not acceptable at defaults; 12 plausible, measure (consider free A0 single-entry steps); 13 2.0, 1.x refused; 14 agree; 15 acceptable, document; 16 warn. P1 reserve memo fields; P2 concatenate with fixed Rₜ; P3 no new code if arena sized from maxItems; P4 keep the key-id → record table.

## Verdict
Direction sound; not ready to implement as written. Top changes: rule A as `reference`; storage/tier spec fixes (findings 2, 3, 7); arena sizing and T self-sort (findings 4, 5); then warnings and the forced-tier witness gate.
