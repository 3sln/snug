# Stranger review (protocol engineer): RFC claims in snug's user docs, 2026-11-12

First impression: the RFC-facing behaviour I probed is mostly correct, and often more correct than the docs say. Since format 2.0, snug matches arrays and map groups with RFC 8610 Appendix A PEG semantics and applies the §3.5.4 cut literally. Several user documents still describe the format 1 engine, which was existential, had "all alternatives live", used priority-assignment maps and refused map overlap. They describe it in the present tense. The worst cases are the first bullet of the README's "Why snug", SPEC §2, the matching sections of cddl-support.md, the error-code and limit lists in api.md, and most of conformance.md. conformance.md ships in the package but is a dated 2026-11-04 audit, and many of its "defects" are now fixed. A newcomer who reads them will form the wrong mental model of matching, which is the one thing a CDDL validator must get right. The discriminated-union guidance is correct per RFC 8610 §3.5.4. However, the warning W8 that the guidance relies on cannot be reached through the public JS API.

What I read and ran: I read README.md, docs/{guide,api,rust,profiles,cddl-support,conformance,release-policy}.md, docs/profiles/bindle.md, CHANGELOG.md, host/rust/README.md, host/js/types/*.d.ts, the examples, and SPEC.md §§1–2 at `HEAD` (`ac08ec2`). I checked them against corpus/rfc/rfc8610.txt (§3.3, §3.5.4, §3.8.6, §3.9, Appendix A), rfc8949.txt (§3.3, §3.4, §3.4.3, §5.6.1, Appendix F) and rfc9682.txt (§3.2). I built the package with the README's consumer recipe, using scratch and `TMPDIR` under `.cache/p910-review-rfc/`. `npm run build` staged the package, the copied consumer printed `7`, and all nine examples exited 0. I then ran about 150 probes against the staged package through its public entry points only (`snug`, `snug/compile`), scripts `p1.mjs`–`p11.mjs` in `.cache/p910-review-rfc/consumer/`. **Note:** while I was reviewing, someone else's uncommitted edits to README.md, SPEC.md, api.md, cddl-support.md, conformance.md and guide.md appeared in this worktree. Line numbers below are for `HEAD`. Where an in-flight edit already fixes a finding, I say so. The code under test did not change: the diff touches docs only.

Verified correct, so not listed as findings:
- Prelude float widths match by value (RFC 8610 §3.3), e.g. `float32` ← `f93e00` and `float16` ← `fb3ff8…`.
- Numeric comparisons with −0, NaN and mixed int/float operands (D250, D329).
- Unplugged sockets are empty choices (§3.9).
- `#7.<T>` head numbers and `#7.24` meaning simple values 32..255 (RFC 9682 §3.2).
- Tag 0 leap-second rules (including offsets) and the tag 32 IP-literal check.
- The tag numbers 65535, 2³²−1 and 2⁶⁴−1 are refused.
- Simple values 24..31 are `malformed`.
- Duplicate keys `1`/`1801` and `0.0`/`-0.0` are refused, while `1`/`1.0` and NaNs with different significands stay distinct (§5.6.1).
- Indefinite, non-shortest and unsorted input passes under `valid` and fails under `deterministic`.
- `.size`, `.bits`, `.regexp` (XSD, literal `^`/`$`), `.cbor` through the canonical copy, and `.cborseq`.
- `.pcre` and `.abnf`-without-module both give `unsupported_control`.

---

## 1. Blocker: the headline matching model is the opposite of the implemented one

**Location:**
- README.md:14–16 ("Sound matching: type and group alternatives remain live together. There is no greedy array matching or backtracking. Map schemas that cannot be proved exact … fail at compile time")
- SPEC.md:76–80 (§2 items 1–2)
- docs/cddl-support.md:25 ("all alternatives evaluated as sets"), :283–296, :340–347 ("Arrays match Glushkov automata … no first-match or greedy occurrence shortcut")
- docs/guide.md:269 ("matching all live CDDL alternatives")

The CHANGELOG (:27) says the opposite: "PEG semantics for groups in arrays and maps (D270)".

**What happened:** The package implements RFC 8610 Appendix A PEG: prioritised `//` and greedy occurrences.

```
[* uint, uint]           [1]       -> invalid missing    (App. A: "*a a" "never can match anything")
[? uint, uint]           [1]       -> invalid missing
[? uint, 2*3 uint, tstr] [1,2,"x"] -> invalid type
[uint // uint, uint]     [1,2]     -> invalid unexpected  (first alternative locks in)
{ * tstr => any, a: uint }  {"a":1} -> invalid missing ["a"]
```

The last probe directly contradicts cddl-support.md:285–287 ("literal-key entries have priority, followed by key-typeset entries in source order"). Under that documented rule, `a: uint` would take `a` and the map would match. The behaviour is defensible under Appendix A ("occurrence indicators … are greedy"; "prioritized choice"). But it is the reverse of what the README promises, and the docs give a user no guidance on PEG pitfalls: put wildcards last, put the longer alternative first, and `[? x, x]` is a trap.

**Expected:** The README, SPEC §2, cddl-support and guide describe PEG matching and cite Appendix A. They state the consequences with these examples. They also say where snug departs from existential readings that other tools use (Ruby and Rust cddl accept `[* uint, uint]` on `[1,2]`, per conformance.md's own E4 runs).

**Suggested fix:** Replace README "Sound matching" with "RFC 8610 Appendix A matching: prioritised choice, greedy occurrences, literal cuts; no exponential backtracking". Rewrite SPEC §2.1–2.2 and the cddl-support sections "Map determinism and cuts" (priority paragraph) and "Arrays and repetition". Add a short "PEG pitfalls" table to the guide next to the union section.

## 2. Major: documented map refusals and limits no longer exist, and api.md disagrees with the types

**Location:**
- docs/cddl-support.md:294–296 (`{ 1*2 tstr => uint, 1*2 tstr => uint }` "refused with `map_overlap`"), :331–334 (`{ 0*2 (2*2 tstr => uint) }` "refused (`map_group_occurrence`)"), :429–430
- SPEC.md:66 ("maps the determinism rule cannot decide are refused (D011)")
- docs/api.md:169 (`alternatives` limit), :679–682 (`map_group_occurrence`, `map_cut`, `map_overlap`, `limit_alternatives`), :801–803, :811
- docs/guide.md:850 ("Map alternatives per sequence 64 / 1,024")
- docs/profiles.md:245, :307 (`h'00': T` "is a `map_cut` schema error")

**What happened:** Every one of those schemas compiles. Probes: `{ 1*2 tstr => uint, 1*2 tstr => uint }`, `{ 0*2 (2*2 tstr => uint) }`, `{ ? a: uint, * tstr => uint, * tstr => tstr }`, `{ h'00': uint }` and `{ * tstr ^=> uint }` all compile. `compile(t, { limits: { alternatives: 10 } })` throws `TypeError: Unknown limits key; allowed options: … pegNodes …`. host/js/types/compile.d.ts already declares `pegNodes` and `limit_peg_nodes` and has no `map_*` codes or `limit_alternatives`, so api.md and the types disagree.

**Expected:** api.md's code list and limits table match compile.d.ts. The cddl-support refusal table lists only current refusals. The guide's limits table has a "PEG nodes per group" row.

**Suggested fix:** Remove `map_overlap`/`map_cut`/`map_group_occurrence`/`limit_alternatives`/`alternatives` from api.md, guide.md, cddl-support.md and profiles.md, or mark them "format 1, retired". Add `pegNodes`/`limit_peg_nodes` with its default (1024) and ceiling (16384). Drop the D011 sentence from SPEC §1.1.

## 3. Major: warning W8, the safety net for the union pitfall, cannot be reached from JS

**Location:**
- docs/guide.md:94–97 ("The warning is in the compile result's `warnings` (JS)")
- docs/cddl-support.md:311 ("compile warning W8 flags the idiom")
- the in-flight README edit ("W8, in `warnings`")
- CHANGELOG.md:29

**What happened:** `compile()` resolves to a `Schema` whose only own key is `program`. `Program`'s prototype has `P, B, sourceKey, rules, controls, serialize`. compile.d.ts and api.md say nothing about warnings. `compile('r = { kind: "a", x: int // kind: "b", y: tstr }')` emits nothing on stdout or stderr, and `schema.warnings` and `schema.program.warnings` are both `undefined`.

**Expected:** Either a public `warnings` (for example `schema.warnings` or `program.warnings`, declared in schema.d.ts and documented in api.md), or docs that do not promise one.

**Suggested fix:** Expose warnings on the Schema or Program, type them, and document the W-codes in api.md. Until then, remove "(JS)" from the guide and the README edit.

## 4. Major: TypeScript declarations do not know the default preset

**Location:** host/js/types/index.d.ts:22–27 (`wire?: 'deterministic' | 'bindle'`, "Default 'deterministic'"), :24 ("only removes acceptance relative to RFC 8949 §4.2.1"), :44, :57, :82–86 (`profiles` has no `valid`)

**What happened:** At runtime `Object.keys(profiles)` is `['valid','deterministic','bindle']`, `profiles.valid.wire === 'valid'`, and `{ wire: 'valid' }` is accepted. A TS user who writes `wire: 'valid'` or `profiles.valid` gets a type error, and the doc comment tells them the wrong default.

**Expected:** `wire?: 'valid' | 'deterministic' | 'bindle'`, "Default 'valid'", a `valid` member in `profiles`, and the ProfileOptions comment relative to RFC 8949 §5.3 for `valid` (as profiles.md:41–42 says).

**Suggested fix:** Update index.d.ts, and add a declaration test that `profiles.valid` and `wire: 'valid'` type-check.

## 5. Major: conformance.md, shipped to users, still asserts fixed defects in the present tense

**Location:**
- docs/conformance.md:3 (the banner supersedes only "the wire default")
- :11 ("most consequential confirmed matching defects are signed-zero numeric controls and unplugged group sockets"; "URI syntax and leap-second validity have counterexamples")
- :94 and S28 (arrays: existential NFA, "non-conformant" against PEG)
- :311–317 (cut table: snug "valid")
- :321 ("unsupported cut placements … `{* tstr ^ => uint}` … byte/float/bignum colon keys")
- :416 (`float .ne`/`.lt` zero/NaN bugs; "Mixed `float .lt 1` is refused")
- :434 ("Default `wire:'deterministic'`")
- :475–482 (socket defect)
- :492 (unassigned simple values refused; `#7.<type>` a syntax error)
- :494 (float widths are encoded widths; fixed only in the in-flight edit of S14, not here)
- :498–499 (`http://[x` and `2024-01-01T00:00:60Z` accepted)
- S64/:291 (55799 depth-0 only)
- :505–522 (recommended fixes 1, 2, 3, 5 and 8 are done)

**What happened:** Each of these claims fails on the current package:

| Claim in conformance.md | Current behaviour |
| --- | --- |
| `{kind:"a", x:uint // kind:"b", y:tstr}` matches `{kind:"b",…}` (:311) | invalid (`value`) |
| `{(a:uint // a:tstr), b:bool}` matches `{a:"s",b:true}` | invalid |
| `{(a:uint // * tstr => any)}` matches `{a:"s"}` | invalid |
| `float .lt 0.0` admits −0 | invalid (`range`) |
| `float .ne 0.0` admits −0 | invalid (`range`) |
| `float .ne 1.5` refuses NaN | NaN is valid |
| `float .lt 1` does not compile | compiles |
| `[$$x]` accepts `[]` | invalid (`missing`) |
| `#7.32` does not compile | compiles; `f820` is valid |
| `32("http://[x")` is accepted | `cbor/tag` |
| `0("2024-01-01T00:00:60Z")` is accepted | `cbor/tag` |
| `[* uint, uint]` accepts `[1]` | invalid (now PEG) |

The inventory totals ("143 conformant … 10 non-conformant") are therefore wrong for the shipped code.

**Expected:** A shipped "conformance" document states current conformance. A historical audit is labelled as history on every stale section, or is not shipped.

**Suggested fix:** Either take conformance.md out of `PACKAGE_FILES` and keep it as a dated review, or put a current summary table at the top: item, classification at 2026-11-04, current classification, deciding change (D250/D251/D252/D270/D284/D301/D328/D329/D336). Mark each section (a)–(j) "historical" where it no longer holds.

## 6. Minor: discriminated unions are correct per RFC 8610 §3.5.4, with gaps in prominence and explanation

**Location:**
- docs/guide.md:43–107
- docs/cddl-support.md:298–316
- README (no mention at `HEAD`; an in-flight edit adds a section)
- docs/guide.md:45 ("branch `p85-peg`", fixed in the in-flight edit)
- docs/guide.md:72 (cites "architecture §20.3 R19", which is not shipped)

**What happened (RFC analysis):** §3.5.4 says that once a cut entry's key matches, the pick is "locked in … independently of whether the value matches as well, so when it does not, the entire map fails to match". `name:` and `"lit":` imply a cut. So inside one map, `{ kind: "a", … // kind: "b", … }` fails on any `kind` other than `"a"`. The guide is right. Both documented alternatives are also correct:

- **Type choice of maps:** §3.5.4's failure unit is "the entire map", so the next `/` alternative is still tried. One caveat: Appendix A's parenthetical, that a cut disables "alternatives in choices containing this choice", could be read as reaching an enclosing type choice. The guide should argue the scope from §3.5.4's "entire map" wording rather than from an unshipped architecture document.
- **`"kind" => "a"`:** `=>` without `^` has no cut.

Probes (default `cuts: 'rfc'` / `cuts: 'branch'`):

```
{ kind: "a", x: int // kind: "b", y: tstr }        {kind:b,y:z}  invalid value ["kind"] / valid
{ kind: "a", x: int } / { kind: "b", y: tstr }     {kind:b,y:z}  valid / valid
{ "kind" => "a", x: int // "kind" => "b", y: tstr } {kind:b,y:z} valid / valid
{ "kind" ^=> "a", … // "kind" ^=> "b", … }         {kind:b,…}    invalid / valid
{ "type" => "a", x: int } / { "type" => "b", y: tstr }  {type:b,y:z} valid
{ type: "a", x: int // type: "b", y: tstr }        {type:b,y:z}  invalid value ["type"]
msg = ping / data; ping = { kind: "a" }; data = { kind: "b", y: tstr }   {kind:b,y:z} valid
{ ping // data }; ping = ( kind: "a" ); data = ( kind: "b", y: tstr )   invalid (rfc) / valid (branch)
{ (kind: "a" // kind: "b") }                       {kind:"b"}    invalid value ["kind"]
{ kind: "a" / "b" }                                {kind:"b"}    valid
{ id: tstr, "kind" => "a" // id: tstr, "kind" => "b", y: tstr }  {id,kind:b,y}  invalid missing ["kind"]
```

The last probe confirms the guide's "keep the discriminator first" advice. The diagnostic there is misleading, though: it says `missing ["kind"]` when `kind` is present.

**Gaps:**
- (a) At `HEAD` the README says nothing about the pitfall, although a newcomer copies the group-choice spelling from most published CDDL. The in-flight README section fixes this, apart from its W8 claim (finding 3).
- (b) The minimal enum case `{ (kind: "a" // kind: "b") }` and its fix `kind: "a" / "b"` (a value choice inside one entry) are not shown.
- (c) For the failing idiom, the diagnostic reports `value` at `["kind"]` for a well-formed second alternative, with no hint about the cut.

**Expected:** The cut-scope argument rests on RFC text. The enum one-liner appears in the table. The README (once the in-flight edit lands) and the cddl-support callout match.

**Suggested fix:** Replace the "architecture §20.3 R19" justification with the §3.5.4 quotation, and note the Appendix A parenthetical. Add the `kind: "a" / "b"` row. Optionally add a refusal subcode such as `cut` when a cut-locked value fails, so users can tell this case from an ordinary wrong value.

## 7. Major: the profiles.md tag-content table contradicts the behaviour and cddl-support.md

**Location:**
- docs/profiles.md:157–158 (tags 2/3/4 "canonical"/"normalised", set "both")
- :161 (tag 0 "T and Z either case; second 00..60")
- :162 (tag 1 "finite float")
- :165 (tag 32 "the authority, IP-literal and path structure is not parsed")
- :166, :173–176 (55799 "only at the top level"; "Under `tags: 'any'` (the deterministic preset, D180) … `tag` still refuses … a nested 55799")
- :329
- docs/cddl-support.md:403–404 ("55799 only at the top")

**What happened:**

| Input | Result | Contradicts |
| --- | --- | --- |
| `0("2024-01-01t00:00:00z")` | `cbor/tag` under valid, deterministic and standard | profiles.md "either case"; cddl-support.md's "upper-case `T`/`Z`" is right |
| `0("2024-06-30T23:59:60+01:00")` | `cbor/tag` | profiles.md "second 00..60"; `…T00:59:60+01:00` is valid, as RFC 3339 §5.7 requires |
| `1(Infinity)`, `1(NaN)` | valid | profiles.md "finite float"; cddl-support.md:399 is right |
| `32("a/b")` (relative reference) | valid | profiles.md calls tag 32 a `URI` |
| `32("http://[::1]/")` | valid | profiles.md "not parsed" |
| `32("http://[x")` | `cbor/tag` | profiles.md "not parsed" |
| `[55799(1)]`, `55799(55799(1))` | valid under valid and deterministic, `cbor/tag` only under bindle | both docs |
| `4([1,1])`, `2(h'0001')` | valid under `tags: 'standard'` | profiles.md says the canonical/normalised rule applies in the standard set |

**Expected:** One authoritative tag table, with the rule for each wire preset.

**Suggested fix:** Rebuild the profiles.md tag table with per-preset columns (valid / deterministic / bindle). Say that the 55799 nesting and decimal-normalisation rules apply only under Bindle (D265). Align cddl-support.md:395–407 with it.

## 8. Minor: more stale or wrong statements in profiles.md

**Location:**
- docs/profiles.md:300 ("`#7.24`–`#7.31` match nothing yet, and RFC 9682's `#7.<type>` head numbers are not parsed")
- :304–306 ("Float literals still compare encodings: `0.0` does not equal −0.0")
- :245, :307 (`map_cut`)

**What happened:**
- `#7.<20..23>` compiles and matches `f7`.
- `#7.24` matches `f8ff` (cddl-support.md:34 says so correctly).
- `r = 0.0` matches `f98000`, and `r = -0.0` matches `f90000`.
- `{ h'00': uint }` compiles.

**Expected and suggested fix:** Delete these sentences or rewrite them to match cddl-support.md:34 and :366–371.

## 9. Minor: stale statements about the default preset, the format version and float widths

**Location:**
- README.md:191 ("current restrictive wire policy"), :194 ("format 1.0 (1.1 …)"), :198 ("Deterministic preset (default)")
- docs/guide.md:349 (table header "Deterministic preset (default)"), :919–928 (format 1.0)
- docs/api.md:304, :312, :325 (format 1.0/1.1)
- docs/cddl-support.md:33 ("encoded-width floats"), :188–189 (noncharacters: names only the deterministic preset), :387 ("the deterministic preset (the default …)")
- SPEC.md:85–86 (§2 item 4 "mean the encoded width")
- docs/release-policy.md:527 ("SPEC §1.1 lists `.abnf` as refused")

**What happened:** The CHANGELOG (:74–83) and the runtime say the default is `valid`, the Program format is 2.0, and float widths match by value. The in-flight edits fix README:191/194/198, guide:919–928, api:304/312/325 and cddl-support:33. Still stale in the working tree: guide.md:349, cddl-support.md:387 and :188–189, and SPEC §2.4. release-policy.md:527 is itself stale, since SPEC §1.1 at `HEAD` already says `.abnf` needs the optional module. SPEC §1.1 is otherwise current, apart from the D011 sentence in finding 2. SPEC §2 items 1, 2 and 4 are stale, as the brief expected.

**Suggested fix:** Apply the remaining replacements. Add a docs check that fails if a shipped doc contains "Deterministic preset (default)", "format 1.0" or "encoded-width".

## 10. Minor: the invalid tag numbers are cited to the wrong RFC 8949 section

**Location:** docs/cddl-support.md:389 ("RFC 8949 §9.2"), docs/profiles.md:168 ("RFC 8949 §9.2's invalid tag numbers")

**What happened:** The text about 65535, 4294967295 and 18446744073709551615 ("not intended to occur in actual CBOR data items; implementations MAY flag such an occurrence as an error") is in §3.4 (rfc8949.txt:1014–1021). §9.2 is the IANA registry. conformance.md's own quotation check (Q5) already corrected this, but the correction never reached these two files. The RFC also says MAY, not "invalid".

**Suggested fix:** Cite §3.4, and say "refused (RFC 8949 §3.4 permits flagging them as errors)".

## 11. Minor: `.default` deviates from RFC 8610 §3.8.6, but cddl-support.md presents it as plain support

**Location:** docs/cddl-support.md:55 ("`.default`, `.feature` | Accepted annotations, no effect on matching")

**What happened:** §3.8.6 says `.default` carries "the implied .ne control … to prevent this value from being sent over the wire". snug accepts `1` for `uint .default 1` and for `{ ? a: uint .default 1 }`. conformance.md (S46) records this as contested (Erratum 9229 is "Reported"), but the support table gives no hint of it.

**Suggested fix:** Add to the row: "deliberate deviation: RFC 8610 §3.8.6 implies `.ne`; snug follows the annotation-only reading proposed in Erratum 9229. Write `(T .ne v) .default v` for the RFC meaning." I checked that this form works: `{ ? a: (uint .ne 1) .default 1 }` refuses `{a:1}` with `range` and accepts `{a:2}`.

## 12. Minor: bignum keys and `valid`'s "duplicates compared by value"

**Location:**
- docs/profiles.md:64 ("Duplicate keys, compared by value: their canonical (EC) encodings … two NaNs"), :66 ("Bignums with leading zeros or below 2⁶⁴ … accepted (the integer)")
- README.md:30

**What happened:**
- `a2 01 00 c24101 00` (keys `1` and `2(h'01')`) validates under `valid` as two distinct keys. `decode` of the same bytes throws `unsupported` ("Two map keys decode to the same JavaScript value"), because it materialises `2(h'01')` as the integer 1.
- `r = 1` and `r = integer .eq 1` both refuse `c24101` with `type`.

RFC 8949 §3.4.3 says the basic generic data model keeps bignums distinct from integers, but the extended model that tags 2/3 define "defines equivalence based on numeric value". snug's decoder uses the extended model ("the integer"), while its duplicate check and literal matching use the basic one. Separately, "two NaNs" overstates the rule. §5.6.1 makes NaN keys equivalent only when their significands match. snug correctly accepts `f97e00` and `f97e01` as distinct keys and refuses `f97e00` with `fa7fc00000`.

**Expected:** One stated model for tags 2/3. If the decoder materialises bignums as integers, the duplicate check under `valid` should treat `1` and `2(h'01')` as duplicates (§3.4.3, extended model). Otherwise the docs should say that bignum keys are compared as tagged items.

**Suggested fix:** Decide the model and document it in profiles.md. Change "two NaNs" to "two NaNs with the same significand (§5.6.1)".

## 13. Minor: `f8` with a value below 0x18 is classified as `non_shortest` under deterministic and Bindle

**Location:** docs/profiles.md:67 (deterministic → `non_shortest`), :109 ("`f8` with a value below 32 is not well-formed (`malformed`; Bindle: `simple`, or `non_shortest` below 24)"), :79–80 ("Only `truncated` and `malformed` are well-formedness verdicts")

**What happened:** `f805` gives `malformed` under valid but `non_shortest` under deterministic and under bindle. `f81f` gives `malformed` under deterministic and `simple` under bindle. RFC 8949 §3.3 ("An encoder MUST NOT issue two-byte sequences that start with 0xf8 and continue with a byte less than 0x20") and Appendix F make both not well-formed. A consumer who follows :79–80 ("only truncated and malformed are well-formedness verdicts") will classify `f805` as well-formed but non-deterministic. The two rows of profiles.md also disagree about which presets report `non_shortest`.

**Suggested fix:** Report `malformed` under every preset, or at least make the two rows agree and drop the :79–80 claim for this case.

## 14. Minor (doc-only, not verified at runtime): Rust docs disagree about the default codec root

**Location:** docs/rust.md:48 ("codec/view default to map root"), host/rust/README.md:53 ("The root must be a map by default")

**What happened:** profiles.md:136–141 says Rust "has the same model … all defaulting to the valid preset", whose `top` is `'any'` (profiles.md:127). In JS, `decode(encode(1))` returns `1` with no options. I did not build Rust, so I cannot say which of the two is wrong.

**Suggested fix:** Check this with the crate and make the two documents agree.

## 15. Nit: api.md's `CompileOptions` signature is incomplete

**Location:** docs/api.md:155

**What happened:** The inline type omits `regexp`, `cuts` and `groupWords`. The next paragraph adds `cuts` and `groupWords`, but `regexp` appears only in the guide.

**Suggested fix:** Paste the compile.d.ts interface verbatim.

---

### Summary

| # | Sev | Topic |
| --- | --- | --- |
| 1 | Blocker | README, SPEC §2, cddl-support and guide promise existential "all alternatives live, no greedy" matching; the engine is Appendix A PEG (`[? uint, uint]` rejects `[1]`; `{* tstr => any, a: uint}` rejects `{a:1}`) |
| 2 | Major | `map_overlap`/`map_cut`/`map_group_occurrence`/`alternatives`/`limit_alternatives` are documented but no longer exist; api.md disagrees with compile.d.ts (`pegNodes`) |
| 3 | Major | Warning W8 is documented as a JS `warnings` result, but no public JS API exposes it |
| 4 | Major | index.d.ts: no `'valid'` wire value, "Default 'deterministic'", no `profiles.valid` |
| 5 | Major | Shipped conformance.md asserts many fixed defects as current |
| 6 | Minor | Union idioms are RFC-correct; the scope argument cites an unshipped doc; enum one-liner missing; misleading diagnostic; README prominence only in an in-flight edit |
| 7 | Major | profiles.md tag table wrong for tags 0, 1, 32, 55799 and 2/3/4 versus behaviour and cddl-support |
| 8 | Minor | profiles.md: `#7.<T>` "not parsed", `0.0` ≠ −0.0, `map_cut` |
| 9 | Minor | Remaining stale default-preset, format and float-width text; release-policy's own stale-list entry is stale |
| 10 | Minor | Invalid tag numbers cited as RFC 8949 §9.2 instead of §3.4 |
| 11 | Minor | `.default`'s implied `.ne` deviation is not disclosed in cddl-support |
| 12 | Minor | Bignum keys: decoder uses numeric equivalence, duplicate check does not; "two NaNs" imprecise |
| 13 | Minor | `f8 <0x18` reported `non_shortest` under deterministic/bindle although it is not well-formed |
| 14 | Minor | Rust docs say codec root defaults to map, against the "same model" claim |
| 15 | Nit | api.md `CompileOptions` signature incomplete |
