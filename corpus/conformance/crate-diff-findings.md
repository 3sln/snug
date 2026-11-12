# P4.1 — Native cddl 0.10.7 differential findings

Run: 2026-10-29, offline, Apple arm64 / macOS 14.6.1 (23G93), Node v24.6.0. These are case counts, not performance measurements.

**No snug bugs found. No incorrect corpus verdicts found.** Every class below is a crate defect or documented implementation limitation, checked with a reduced witness and RFC reasoning. This finite corpus is not a correctness proof.

| Input | Attempted | Boolean comparisons | Agree | Disagree | Crate schema error | Panic | Timeout |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| study | 201 | 198 | 183 | 15 | 3 | 0 | 0 |
| adversarial | 786 | 717 | 584 | 133 | 67 | 2 | 0 |
| generated | 6000 | 6000 | 5846 | 154 | 0 | 0 | 0 |
| **Total** | **6987** | **6915** | **6613** | **302** | **70** | **2** | **0** |

## Method and reproduction

Run from the repository root:

```sh
bb crate-diff
# Equivalent; arguments can override the existing binary, seed, count, timeout:
node corpus/tools/crate-diff.mjs --cases=6000 --seed=0x5eed8610 --timeout=2000
```

The default native binary is the user-supplied scratchpad `cddlproj-oracle/cddl-native` at the absolute path in the harness. Its SHA-256 is `b96abfc4d49297a1d0269f6bb6c4811c5fe181d2b7baf6c4aaf2e5902db895e6`. The read-only local crate source identifies version 0.10.7. No network, installations, builds, commits, or validator modifications were performed by this item.

All 295 suites (1,123 cases) were offered to snug's compiler, including suites labelled `phase: later`. Of these, 264 suites / 987 cases compiled and were run through both implementations. The other 31 suites / 136 cases were refused by snug (all carry expected schema-refusal metadata); their names and refusal codes are in the cache summary. This explains why this run has four more study cases than P3.5's eligible-only count: the now-supported .cat and .plus probes each contribute two cases. Native parse errors are counted per attempted case, not per unique schema.

The generator extends export-adversarial.mjs's xorshift32 with constructive matching values, near misses, and arbitrary profile-valid values: 2,000 varied schemas × 3 values = 6,000 cases, seed 0x5eed8610. Each of the sixteen families contributes 375 cases: structs, open maps, tables, array occurrences, nested generics, type choices, signed-64-bit ranges, text size, byte size, bits, typed arrays/tags, tag 40, integer/biguint bignums, decfrac, literals, recursion. No map group choices or optional map groups, member/rule-name collisions, regexp/pcre/abnf, integers outside signed 64-bit literal bounds, uint/tag-2 distinctions, float-width probes, cborseq, or map unwrap are generated. Arrays use a single occurrence segment to avoid the known greedy-multiple-occurrence defect. Generated decimal and tag payloads obey the strict profile; near misses change the schema match without breaking that profile.

The intended correct subset exposed **112 nested-generic** and **42 zero-bits** crate failures; they are retained, not silently filtered out. The other 5,846 generated cases agree. Main-run panics/timeouts are 2/0 in the corpus and 0/0 in generation. Every native invocation has a 2,000 ms timeout and SIGKILL containment; a fresh process is used for each case.

Values are encoded by snug's host encoder, then decoded and re-encoded byte-identically with the independent baseline. Plain Uint8Array fixtures avoid the baseline's Buffer slice/typed-array pitfall. All 6,987 snug verdicts agree with the independent oracle. Four of these use explicitly recorded RFC 9165 literal folds before checking (`"a" .cat "b"` → `"ab"`; `1 .plus 2` → `3`), since oracle.mjs predates these controls. There are zero unknown oracle results and zero stored-expectation discrepancies. Every suspicious snug verdict is thus rechecked, including cases where the crate cannot return a verdict.

The native CLI validates its first rule only. The harness masks comments/literals, moves the actual requested rule definition to the front, preserves all other definitions/extensions, and asserts the CLI's reported root. It reads explicit success/failure messages: **validation failure also exits zero**, so exit status alone is not a verdict. Panics, timeouts, and schema errors are separate outcomes. Diagnostics retain reason/site metadata only; the crate's value-echoing error strings are not forwarded or logged by the harness.

`.cache/p41/results.jsonl` records every case, all three verdicts, exact schema/CBOR fixture, and assigned class. `summary.json` records totals, refusals, source fingerprint and binary hash. A new unclassified mismatch, oracle unknown, source change during the run, snug bug, or corpus bug makes the task fail; known crate defects are successful classified evidence. Input source fingerprint: `fc63999e1b76326d8a8253ab08f5c20bcd18c4c7cd3afbf5f218886dda3fe4ec`; unchanged throughout the final run. Evidence SHA-256: `27458978d24cb77aabfd8a5cb8197d81e9d63b892ffac97a5ff5c4bf80acbf6f`. Two independently executed 6,000-case runs had identical generated schemas, bytes, and all three verdicts (normalized digest `2f4eb5d8af9abc315bdefcbb081ce23c2ef379b09db32278f42830b346cf2e72`).

For each reduced witness below, save the CDDL to `.cache/p41/repro.cddl` and convert its hex into `.cache/p41/repro.cbor`:

```sh
node -e "require('node:fs').writeFileSync('.cache/p41/repro.cbor', Buffer.from('00', 'hex'))"
"$CDDL_NATIVE" validate --cddl .cache/p41/repro.cddl --cbor .cache/p41/repro.cbor
```

Set CDDL_NATIVE to the supplied binary and substitute the witness hex. Check snug with `(await compile(text)).validate(bytes, 'r', {top:'any'})`. All 33 reduced witnesses below were actually run against snug, the native crate, and oracle.mjs; all reproduced. These extra reduction/calibration invocations are excluded from the main-run counts.

## Classes

Counts are exclusive across classes. The 302 Boolean disagreements occupy 26 classes; 70 schema errors occupy five more; two panics occupy one. **The crate is wrong in all 32 classes; snug: 0, corpus: 0.** “Schema error” classes report missing support, not false Boolean verdicts.

| Class | Count | Corpus / generated | Outcome |
| --- | ---: | --- | --- |
| optional-map-group | 60 | 60 / 0 | verdict; crate wrong |
| map-choice-coverage | 4 | 4 / 0 | verdict; crate wrong |
| regexp-unanchored | 13 | 13 / 0 | verdict; crate wrong |
| unsupported-cborseq | 9 | 9 / 0 | schema error; crate wrong |
| map-unwrap | 2 | 2 / 0 | verdict; crate wrong |
| prelude-bignum | 5 | 5 / 0 | verdict; crate wrong |
| native-integer-literal-limit | 48 | 48 / 0 | schema error; crate wrong |
| prelude-tag-dispatch | 17 | 17 / 0 | verdict; crate wrong |
| float-width-erased | 9 | 9 / 0 | verdict; crate wrong |
| member-rule-collision | 2 | 2 / 0 | verdict; crate wrong |
| repeated-map-choice | 2 | 2 / 0 | verdict; crate wrong |
| noncut-map-fallthrough | 1 | 1 / 0 | verdict; crate wrong |
| array-occurrence | 6 | 6 / 0 | verdict; crate wrong |
| composite-ne-target | 5 | 5 / 0 | verdict; crate wrong |
| socket-group-extension | 2 | 2 / 0 | verdict; crate wrong |
| byte-literal-panic | 2 | 2 / 0 | panic; crate wrong |
| byte-literal-text-confusion | 1 | 1 / 0 | verdict; crate wrong |
| variable-tag-unchecked | 1 | 1 / 0 | verdict; crate wrong |
| bare-major6 | 1 | 1 / 0 | verdict; crate wrong |
| base64-literal-parse | 5 | 5 / 0 | schema error; crate wrong |
| hex-subnormal-parse | 5 | 5 / 0 | schema error; crate wrong |
| byte-escape-parse | 3 | 3 / 0 | schema error; crate wrong |
| undefined-group-socket | 1 | 1 / 0 | verdict; crate wrong |
| named-group-extension | 2 | 2 / 0 | verdict; crate wrong |
| prelude-signedness | 2 | 2 / 0 | verdict; crate wrong |
| uint-size-range | 5 | 5 / 0 | verdict; crate wrong |
| bits-zero | 44 | 2 / 42 | verdict; crate wrong |
| bits-high | 1 | 1 / 0 | verdict; crate wrong |
| bignum-comparison | 2 | 2 / 0 | verdict; crate wrong |
| nested-control-target | 1 | 1 / 0 | verdict; crate wrong |
| embedded-trailing | 1 | 1 / 0 | verdict; crate wrong |
| nested-generic-scope | 112 | 0 / 112 | verdict; crate wrong |

### optional-map-group — 60

RFC 8610 §3.2 applies the occurrence to the entire group: zero copies are legal, and partial copies are not. The crate both rejects absent optional groups and loses member/coverage constraints. This includes the seeded optional-group schemas and the preferences contract.

```cddl
r = {? (a: uint, b: uint)}
```

CBOR hex: `a0`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### map-choice-coverage — 4

RFC 8610 §§3.4–3.5 require one complete alternative to cover the map. The witness has a wrong-typed b; neither alternative covers it. The crate mixes coverage across alternatives. The correlated optional-factor witness belongs here for the same reason.

```cddl
r = {a: int, b: int // a: int}
```

CBOR hex: `a261610161626178`. Snug / independent oracle: **refuse / refuse**; native crate: **accept**.

### regexp-unanchored — 13

RFC 8610 §3.8.3 requires matching the whole text string. !abc is not wholly in [a-z]+. All thirteen disagreements (including the escaped-code-point and real-contract cases) admit unmatched prefixes or suffixes. The isolated escaped-code-point witness also accepts five ASCII letters under a four-character bound, so escaping need not be blamed for this observed difference.

```cddl
r = tstr .regexp "[a-z]+"
```

CBOR hex: `6421616263`. Snug / independent oracle: **refuse / refuse**; native crate: **accept**.

### unsupported-cborseq — 9

RFC 8610 §3.8.4 defines .cborseq, including an empty sequence matched by [* uint]. Snug accepts; the crate cannot parse these schemas. Nine case invocations across three suites have no crate Boolean verdict.

```cddl
r = bstr .cborseq [* uint]
```

CBOR hex: `40`. Snug / independent oracle: **accept / accept**; native crate: **schema-error**.

### map-unwrap — 2

RFC 8610 §3.7 unwraps the map group of base into the enclosing group. Both required members are present with the right types; the crate fails to expand the map unwrap.

```cddl
r = {~base, b: bool}
base = {a: int}
```

CBOR hex: `a26161016162f5`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### prelude-bignum — 5

RFC 8610 Appendix D defines uint = #0, nint = #1, int = uint / nint, and number = int / float. Tagged bignums are outside those types; integer is the type that includes them. Five corpus probes expose the crate accepting them. This is another manifestation of its permissive named-type tag dispatch; these probes remain separate because this distinction is explicitly excluded from generation.

```cddl
r = uint
```

CBOR hex: `c249010000000000000000`. Snug / independent oracle: **refuse / refuse**; native crate: **accept**.

### native-integer-literal-limit — 48

RFC 8610 §2.2.1 and Appendix B do not restrict CDDL integer literals to machine usize/isize. The native parser refuses literals above u64 or below i64, including bignum ranges and comparison controllers. This is a documented crate implementation limit, not a false validation verdict. Generated literals stay inside signed 64-bit limits and all generated ranges parse.

```cddl
r = 18446744073709551616
```

CBOR hex: `c249010000000000000000`. Snug / independent oracle: **accept / accept**; native crate: **schema-error**.

### prelude-tag-dispatch — 17

RFC 8610 Appendix D defines number = int / float and named tag-specific prelude types precisely. A tag-4 decimal is not number, tdate, uri, undefined, or the other affected names. The crate tagged-value dispatcher accepts unhandled tags for these identifiers. Seventeen cases include the composite prelude schema and the tag-content-choice witness.

```cddl
r = number
```

CBOR hex: `c482200f`. Snug / independent oracle: **refuse / refuse**; native crate: **accept**.

### float-width-erased — 9

RFC 8610 §3.6 and Appendix D define float16 as #7.25, float32 as #7.26, and float64 as #7.27. The witness uses encoded binary64 for 1.1, not binary16. Widening during crate decoding erases this distinction. All nine cases are corpus width probes; none is generated.

```cddl
r = float16
```

CBOR hex: `fb3ff199999999999a`. Snug / independent oracle: **refuse / refuse**; native crate: **accept**.

### member-rule-collision — 2

RFC 8610 §3.5.1: a bareword before : names a literal text key; it is not a key type reference even if a rule has that name. The crate can accept a different key, and can also reject a valid basis: null member (the signaling contract). The second reduced witness below demonstrates that direction.

```cddl
r = {key: key}
key = tstr
```

CBOR hex: `a161786178`. Snug / independent oracle: **refuse / refuse**; native crate: **accept**.

```cddl
r = {basis: basis}
basis = null / {x: int}
```

CBOR hex: `a1656261736973f6`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### repeated-map-choice — 2

RFC 8610 §§3.2, 3.4 allow independent choices for successive repetitions. Choosing a once and b once covers the witness; the crate rejects it. Another corpus case wrongly accepts a bad a while choosing b.

```cddl
r = {+ (a: uint // b: uint)}
```

CBOR hex: `a2616101616201`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### noncut-map-fallthrough — 1

RFC 8610 §3.5.4: => has no implied cut. A failed optional non-cut entry may consume nothing; the remaining text-key table can consume a with its text value. The crate incorrectly commits to the optional entry.

```cddl
r = {? "a" => uint, * tstr => tstr}
```

CBOR hex: `a161616178`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### array-occurrence — 6

RFC 8610 §§3.2, 3.4 require existence of a matching occurrence split. Here the optional prefix can be absent, leaving two uints and the text suffix. The crate chooses a greedy split. Six cases also cover paired prefixes and the original adversarial generator.

```cddl
r = [? uint, 2*3 uint, tstr]
```

CBOR hex: `8301016178`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### composite-ne-target — 5

RFC 8610 §3.8.6 permits .ne with a type target; parentheses do not turn a valid range or constrained text type into an unsupported target. Zero belongs to 0..10 and differs from 5. The crate refuses valid values because it only handles selected target AST shapes.

```cddl
r = (0..10) .ne 5
```

CBOR hex: `00`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### socket-group-extension — 2

RFC 8610 §§3.4, 3.9: //= adds group alternatives, and the chosen group must still cover its members. In this witness selecting the a alternative cannot supply two distinct required a entries in a map with unique keys; selecting b requires b. The independent existential oracle refuses; the crate incorrectly accepts. The second corpus witness reverses the verdict.

```cddl
r = {a: int, $$ext}
$$ext //= (a: int)
$$ext //= (b: int)
```

CBOR hex: `a1616101`. Snug / independent oracle: **refuse / refuse**; native crate: **accept**.

### byte-literal-panic — 2

A matching or nonmatching byte string must produce a verdict for a byte-string literal (RFC 8610 §3.1). Instead the crate unwraps absent control state at src/validator/cbor.rs:4957:29 in both corpus calls. A separate text-literal/bstr calibration also panicked at :4907:29, as in study §6; that calibration is not included in the two measured corpus panics.

```cddl
r = h'00'
```

CBOR hex: `4100`. Snug / independent oracle: **accept / accept**; native crate: **panic**.

### byte-literal-text-confusion — 1

RFC 8610 §§2.2.2, 3.1 distinguish a byte-string literal from a text-string literal. Text containing NUL is not h'00'. The crate accepts it in the method-value corpus case.

```cddl
r = h'00'
```

CBOR hex: `6100`. Snug / independent oracle: **refuse / refuse**; native crate: **accept**.

### variable-tag-unchecked — 1

RFC 9682 variable tag constraints extend RFC 8610 §3.6: the actual tag must belong to the controller type. Tag 78 is outside 69..70, but the crate checks only content for variable tag controllers. The local crate source explicitly leaves type-expression tag checks unimplemented.

```cddl
r = #6.<69..70>(bstr)
```

CBOR hex: `d84e4401000000`. Snug / independent oracle: **refuse / refuse**; native crate: **accept**.

### bare-major6 — 1

RFC 8610 §3.6 allows an unspecified additional-information argument: #6 accepts any tagged item. Tag 4 is a tagged item. The crate incorrectly treats an omitted tag constraint as tag zero.

```cddl
r = #6
```

CBOR hex: `c482200f`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### base64-literal-parse — 5

RFC 8610 §2.2.2 / Appendix B permit b64-qualified byte strings. The crate fails parsing the b64 token in the three-spelling suite. Five case invocations are affected; the reduced schema retains only b64.

```cddl
r = b64'Y2Q='
```

CBOR hex: `426364`. Snug / independent oracle: **accept / accept**; native crate: **schema-error**.

### hex-subnormal-parse — 5

RFC 8610 §2.2.3 / Appendix B permit this hexadecimal float spelling. 3 × 2^−1075 rounds, ties to even, to binary64 bits 0000000000000002. Snug and the independent oracle agree; the crate reports Invalid hexfloat. All five invocations in the original three-literal suite are affected.

```cddl
r = 0x3p-1075
```

CBOR hex: `fb0000000000000002`. Snug / independent oracle: **accept / accept**; native crate: **schema-error**.

### byte-escape-parse — 3

RFC 8610 §2.2.2 / Appendix B permit escaped quote and newline in an unqualified byte string. The bytes encode it's followed by LF. The crate misparses this legal byte literal, affecting all three suite cases.

```cddl
r = 'it\'s\n'
```

CBOR hex: `45697427730a`. Snug / independent oracle: **accept / accept**; native crate: **schema-error**.

### undefined-group-socket — 1

*2026-11-11: withdrawn.* D251 (RFC 8610 §3.9: an unplugged socket is an empty group **choice**, zero derivations) reverses the reading below; snug and the independent oracle now refuse, so the crate's refusal agrees. Kept as P4.1 history.

RFC 8610 §3.9 makes an unextended group socket an empty group. Therefore a supplies all required members. The crate incorrectly demands content for $$nothing.

```cddl
r = {a: int, $$nothing}
```

CBOR hex: `a1616101`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### named-group-extension — 2

RFC 8610 §3.4 makes //= add an alternative to the named group. A map containing a alone is a complete instance of its first alternative. The crate rejects both valid corpus alternatives after the extension.

```cddl
r = {g}
g = (a: int)
g //= (b: tstr)
```

CBOR hex: `a1616101`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### prelude-signedness — 2

RFC 8610 Appendix D restricts nint to major type 1 and unsigned to uint / biguint. Zero is not nint, and −1 is not unsigned. The crate numeric aliases lose these sign restrictions in two cases.

```cddl
r = nint
```

CBOR hex: `00`. Snug / independent oracle: **refuse / refuse**; native crate: **accept**.

### uint-size-range — 5

RFC 8610 §3.8.1 measures unsigned-integer storage capacity, not the numerical value against the controller range. 23 needs one content byte of capacity, within 1..2. The crate instead tests the value against the interval and refuses five valid corpus values.

```cddl
r = uint .size (1..2)
```

CBOR hex: `17`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### bits-zero — 44

RFC 8610 §3.8.2 prohibits set bits outside the allowed positions; it does not require any bit to be set. Zero and an empty byte string satisfy that condition vacuously. The crate rejects them: two corpus cases plus 42 generated cases.

```cddl
r = uint .bits 0
```

CBOR hex: `00`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### bits-high — 1

RFC 8610 §3.8.2 numbers unsigned-integer bits from zero. 2^63 has only permitted bit 63 set. This native build still rejects the witness; this is separate from the zero case and from the wasm32 literal limit.

```cddl
r = uint .bits 63
```

CBOR hex: `1b8000000000000000`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### bignum-comparison — 2

RFC 8610 Appendix D includes tag-2/3 bignums in integer; §3.8.7 compares their integer values. 2^64 exceeds 2^64−1. The crate mishandles the bignum comparison for both .gt and .ge.

```cddl
r = integer .gt 18446744073709551615
```

CBOR hex: `c249010000000000000000`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

### nested-control-target — 1

RFC 8610 §3.8.5 .default annotates its target; RFC 9165 .feature does not discard the target predicate when features are enabled. Text x is outside uint. The crate accepts it when .default is nested inside .feature.

```cddl
r = (uint .default 3) .feature "x"
```

CBOR hex: `6178`. Snug / independent oracle: **refuse / refuse**; native crate: **accept**.

### embedded-trailing — 1

RFC 8610 §3.8.4 requires .cbor content to be one CBOR data item. The byte string contains two independent unsigned integers (01 02), so it fails .cbor uint. The crate validates the first and ignores the trailing item.

```cddl
r = bstr .cbor uint
```

CBOR hex: `420102`. Snug / independent oracle: **refuse / refuse**; native crate: **accept**.

### nested-generic-scope — 112

RFC 8610 §3.10 instantiates generic parameters in the caller environment. box<box<uint>> denotes two boxes around a uint. The crate corrupts bindings when a generic is nested within another application of itself, rejecting valid inner values. The generator exposes 112 failures through box<list<box<T>>>; the smaller witness removes list and occurrences.

```cddl
r = box<box<uint>>
box<T> = {payload: T}
```

CBOR hex: `a1677061796c6f6164a1677061796c6f616401`. Snug / independent oracle: **accept / accept**; native crate: **refuse**.

## Checks and limits

`bb crate-diff` completed with status 0 and no unclassified differences. Its sandboxed Babashka shutdown printed a ProcessHandle/process-tree cleanup exception after completion; Node's harness summary and exit status were successful. `node --check corpus/tools/crate-diff.mjs` passed. `node --test corpus/tools/`: 301 passed, zero failures/skips. The reduced-witness run checked all 33 examples. No performance claim, Rust-host identity claim, or raw malformed-CBOR fuzz claim is made here. Other work changed the shared tree between exploratory runs; only the final unchanged-source run is tabulated. Those unrelated files were left untouched.

The crate remains useful only behind an explicit subset restriction. Nested re-entry into a generic and zero/empty .bits values must be added to its defect exclusions, while retaining these regressions in differential evidence. Native 64-bit literals remove the wasm32-only ceiling, but do not remove its native parser limits or other semantic defects.

## 2026-11-11 re-run on main `3c10a83` (rebuilt oracle)

Run on a `git archive` snapshot of `3c10a83` (the shared tree had other
agents' uncommitted kin/gen/host edits), with only the harness changes of
this item applied: oracle path from `CDDL_NATIVE`, default
`.cache/oracles/cddl-rs/bin/cddl`, and ANSI colour stripping (the rebuilt CLI
colours its log lines into a pipe). Same seed `0x5eed8610`, 6,000 generated
cases, 2,000 ms timeout; Apple arm64, macOS 14.6.1, Node v24.6.0; 98 s wall.

The previous binary was lost in a /tmp cleanup on 2026-11-09. The oracle was
rebuilt from the crates.io archive (sha256 `c5251326…edbe`) with rustc 1.92.0
and features `std,json,cbor,csv-validate,additional-controls,ast-span,ast-comments`;
binary sha256 `1fdf32e31b8326aaf85f9cfd3814aa1a13b9f4912e006e76ffe9a8be8a052428`
(previously `b96abfc4…`). Rebuild steps: `corpus/tools/ORACLES.md`. Across all
6,987 cases the new binary's outcomes (verdict, schema error, panic) are
identical to the P4.1 binary's; only the panic site string gained the cargo
registry path prefix.

| Input | Attempted | Boolean comparisons | Agree | Disagree | Crate schema error | Panic | Timeout |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| study | 201 | 198 | 183 | 15 | 3 | 0 | 0 |
| adversarial | 786 | 717 | 585 | 132 | 67 | 2 | 0 |
| generated | 6000 | 6000 | 5846 | 154 | 0 | 0 | 0 |
| **Total** | **6987** | **6915** | **6614** | **301** | **70** | **2** | **0** |

Exit status 0: no snug bugs (all 6,987 snug verdicts equal oracle.mjs), no
corpus errors, no oracle unknowns, no unclassified class, sources unchanged
during the run (fingerprint `e36e5beb6696164ec638b653516c78c093f788764a5a0608e7314a0587273bb7`;
evidence SHA-256 `e3087aef70df067bf049883990ce7f81a19ad0aabb567fd1ba412c7c63b294c6`).
The same 264 suites compiled and the same 31 suites / 136 cases were refused.

**Changes against P4.1, row by row (keyed on suite, case, rule, bytes):**
exactly one verdict changed.

| Case | P4.1 snug / oracle / crate | Now | Classification |
| --- | --- | --- | --- |
| adversarial "undefined sockets" #0, `r = {a:int, $$nothing}`, `a1616101` | accept / accept / refuse | refuse / refuse / refuse | **snug change by decision D251**; class `undefined-group-socket` (1) withdrawn, the crate was right |

No new disagreement class; no crate defect, snug bug or corpus error is new.
The 31 remaining classes have the counts of the P4.1 table (bits-zero 44 =
2 corpus + 42 generated; nested-generic-scope 112 generated).

The other semantic changes since P4.1 leave this corpus unchanged:
**valid-CBOR default** (P8.4) is not exercised, because the harness requires
every fixture to round-trip byte-identically through the deterministic
baseline encoder, so all inputs are deterministic; **D250 floats**,
**D252 tags** and **XSD regexps** touch corpus cases (98 with float types or
literals, 3 tdate, 3 time, 8 uri, 74 regexp/pcre) but no snug verdict among
them changed, and their disagreements stay in `float-width-erased`,
`prelude-tag-dispatch` and `regexp-unanchored`. PEG semantics (D270/D271) are
not on main and were not measured. To cover these decisions the generator
would need non-deterministic encodings, float-width/NaN/zero literals, tag
0/1/32 payloads and XSD-only regexp syntax; that is a harness extension, not
done here.


## 2026-11-12 P9.8 re-run on main `b452c9d`

Run in a clean worktree of main (`.cache/p98`; first on `ac08ec2`, then on
`b452c9d` after rebasing, which only adds P9.14's 20 verification vectors to
`abnf.json`; the counts below are `b452c9d`'s), with the
same rebuilt oracle (binary sha256 `1fdf32e3…2428`, `corpus/tools/ORACLES.md`),
seed `0x5eed8610`, 6,000 generated cases, 2,000 ms timeout; Apple arm64,
macOS 14.6.1, Node v24.6.0; under the watchdog's `crate-diff` caps (3,600 s
wall / 7,200 s CPU; not approached; 52–69 s wall). Two full runs on each
commit gave identical verdicts (7,669 and 7,689 cases).

### The harness had to change first

The unchanged harness exits 1 on main: it reports **47 "snug bugs"**. All 47
are the old independent oracle being out of date, not snug. `oracle.mjs` is
the P4.1 set-semantics interpreter; since D270 snug matches groups as RFC 8610
Appendix A's PEG ("This appendix is normative"), and since D301 a cut is the
literal RFC cut. In all 47 rows snug equals the corpus's (D270/D301-migrated)
expectation, and the PEG oracle (`peg-oracle.mjs`, written from the RFC text
for D270) agrees with snug on all 7,111 cases of that run. So
`crate-diff.mjs` now:

- checks snug against **`peg-oracle.mjs`** with `cuts: 'rfc'` (snug's
  default, D301), and also records its `cuts: 'branch'` verdict (rule A);
- keeps `oracle.mjs` only as a label: on P4.1-source disagreements it
  records the set-semantics verdict, never as a check;
- adds the corpora behind the decisions the previous re-run could not reach:
  `numbers.json` (D328–D330), `heads.json` (D336, D284), `audit-2026-11-04.json`
  (D250, D252) and the `.abnf` hand vectors `abnf.json` (D334; independent
  check `abnf-oracle.mjs`; the controller is a text literal with RFC 9682
  escapes, as the crate cannot read it as `h''`). Only the P4.1 sources keep
  the deterministic round-trip check; the new corpora hold `valid`-wire
  fixtures, which the PEG oracle decodes itself;
- treats a snug **wire** refusal (reason `cbor/*`: D252 known-tag content
  under the D260 presets) as outside the PEG oracle, which does not check
  known-tag validity; there snug must equal the corpus's reasoned verdict
  (31 such checks, all equal);
- routes a disagreement to `d301-literal-cut` when the branch-mode verdict
  is the crate's, and to `d270-peg-groups` when the set-semantics verdict is
  the crate's and the PEG verdict is not.

### Results

| Input | Attempted | Boolean comparisons | Agree | Disagree | Crate schema error | Panic | Timeout |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| study | 201 | 198 | 181 | 17 | 3 | 0 | 0 |
| adversarial | 910 | 841 | 722 | 119 | 67 | 2 | 0 |
| generated | 6000 | 6000 | 5846 | 154 | 0 | 0 | 0 |
| *P4.1 sources* | *7111* | *7039* | *6749* | *290* | *70* | *2* | *0* |
| numbers | 52 | 52 | 33 | 19 | 0 | 0 | 0 |
| heads | 57 | 57 | 25 | 32 | 0 | 0 | 0 |
| audit-2026-11-04 | 300 | 300 | 260 | 40 | 0 | 0 | 0 |
| abnf | 169 | 134 | 80 | 54 | 5 | 30 | 0 |
| **Total** | **7689** | **7582** | **7147** | **435** | **75** | **32** | **0** |

Exit status 0: **snug ≠ independent oracle: 0**; corpus errors 0; oracle
unknowns 0; unclassified 0; sources unchanged during the run (fingerprint
`54889138c7c554da1360b501bb84b51029cb024800c14e60c20d273a9aa21f7d`, evidence
SHA-256 `d41f16643bb892f1c21f21905a22b58717c80232a988ed759943df8c563fc0b5`).
Snug refused 7 suites / 12 cases at compile time, all expected (two `.abnf`
study probes compiled without the optional module, `.pcre`, two
non-XSD regexps, two D336 refusal suites); the other 2,386 suites
(2,000 of them generated) compiled.

Every one of the 542 non-agreements (435 verdicts, 75 schema errors, 32
panics) is in a class below. Outside `d301-literal-cut` and `d270-peg-groups`,
every crate verdict differs from the PEG oracle in **both** cut modes and,
on the P4.1 sources, from the set-semantics interpreter too, so no reading of
the cut or of group matching makes the crate right.

### Changes against the 2026-11-11 run, row by row

Keyed on suite, case, rule and bytes against `3c10a83`'s evidence: no row
disappeared, 702 are new and 49 changed.

| Change | Rows | Cause |
| --- | ---: | --- |
| snug accept→refuse, crate refuse: disagreement gone | 29 | D270 (PEG): 23 left `optional-map-group`, all 6 of `array-occurrence` (the crate is greedy like Appendix A) |
| snug accept→refuse, crate accept: new disagreement | 15 | D301 literal cut 14 (`d301-literal-cut`); D270 prioritised choice 1 (`d270-peg-groups`) |
| snug refuse→accept, crate accept: disagreement gone | 4 | D328 (float widths by value): Appendix D `float32`/`float64`/`float32-64` on `f93e00`, `fa3f8ccccd` |
| snug accept→refuse, crate schema error | 1 | D270: `bstr .cborseq [? uint, 2*3 uint, tstr]` on 1, 2, "x"; still `unsupported-cborseq` |
| new: 26 adversarial suites snug used to refuse | 124 | D270 withdrew `map_overlap` (21 suites), `map_group_occurrence` (3), `map_cut` (2); 117 agree, 7 disagree (new classes below) |
| new: the four added corpora | 578 | numbers 52, heads 57, audit 300, abnf 169 |

So on the P4.1 sources: disagreements 301 − 29 − 4 + 15 + 7 = **290**;
agreements 6,614 + 29 + 4 − 15 + 117 = **6,749**; schema errors (70) and
panics (2) unchanged. The 6,000 generated verdicts are unchanged.
Class counts that moved: `optional-map-group` 60 → 37, `array-occurrence`
6 → 0 (class retired), `float-width-erased` 9 → 5 (+ 7 from numbers = 12),
`noncut-map-fallthrough` 1 → 3.

### Classes

Unchanged from the table above (same RFC arguments; each surviving row was
rechecked against the PEG oracle): map-choice-coverage 4, regexp-unanchored
13, unsupported-cborseq 9, map-unwrap 2, prelude-bignum 5,
native-integer-literal-limit 48, prelude-tag-dispatch 17, member-rule-collision
2, repeated-map-choice 2, composite-ne-target 5, socket-group-extension 2,
byte-literal-panic 2, byte-literal-text-confusion 1, variable-tag-unchecked 1,
bare-major6 1, base64-literal-parse 5, hex-subnormal-parse 5,
byte-escape-parse 3, named-group-extension 2, prelude-signedness 2,
uint-size-range 5, bits-zero 44, bits-high 1, bignum-comparison 2,
nested-control-target 1, embedded-trailing 1, nested-generic-scope 112.
Changed: optional-map-group 37, float-width-erased 12 (D328: the crate
accepts every float for every width; the 12 values are not representable in
the narrower format, so the crate is wrong by value and by encoded width),
noncut-map-fallthrough 3.

New. "Wrong" says who departs from the cited text. Every reduced witness
below was run through snug, the PEG oracle and the crate on 2026-11-12, and
all reproduce (a = accept, r = refuse).

| Class | Count | Wrong | Witness (rule `r`) | CBOR | snug / PEG / crate |
| --- | ---: | --- | --- | --- | --- |
| d301-literal-cut | 14 | neither: snug follows the RFC text (owner decision D301), the crate rule A | `{ kind: "a", x: int // kind: "b", y: tstr }` | `a261796173646b696e646162` | r / r / a |
| d270-peg-groups | 1 | crate (Appendix A; D270) | `{ ? (a: int, b: int), ((* tstr => int) // (* tstr => tstr)) }` | `a361610161620261636178` | r / r / a |
| map-group-repetition | 4 | crate (§3.2) | `{ 0*2 (2*2 tstr => int) }` | `a0` | a / a / r |
| | | | `{ 1*2 (tstr => uint, uint => uint) }` | `a30100616100616200` | r / r / a |
| map-member-source-order | 1 | crate (Appendix A) | `{ * tstr => any, ? "a": int }` | `a161616178` | a / a / r |
| noncut-map-fallthrough (+2) | 3 | crate (§3.5.4, Appendix C) | `{ tstr => 0, tstr => 1 }` | `a2616100616201` | a / a / r |
| numeric-control-across-kinds | 11 | crate (§3.8.6; D329) | `int .gt 0.5` | `01` | a / a / r |
| cat-text-bytes | 1 | crate (RFC 9165 §2.2; D330) | `h'01' .cat "x"` | `420178` | a / a / r |
| rfc9682-simple-head-numbers | 32 | crate (RFC 9682 §3.2; D336) | `#7.24` | `f820` | a / a / r |
| nan-ne-control | 5 | crate (§3.8.6; D250) | `float .ne 1.5` | `f97e00` | a / a / r |
| float-range-control-target | 5 | crate (§3.8.6; D250) | `(-1.0..1.0) .lt 0.0` | `f9bc00` | a / a / r |
| float-zero-equality | 2 | crate (§3.8.6; D250) | `0.0 .and (-1.0..-0.0)` | `f98000` | a / a / r |
| prelude-time-nonfinite | 2 | crate (Appendix D; D252.2) | `time` | `c1f97c00` | a / a / r |
| d252-known-tag-validity | 26 | crate (RFC 8949 §§3.4.1, 3.4.5.3, 5.3.2; D252, D260) | `uri` | `d8206a687474703a2f2f5b5d2f` | r / (wire) / a |
| abnf-element-only-unchecked | 37 | crate (RFC 9165 §3) | `tstr .abnf "%x30-39"` | `612f` | r / – / a |
| abnf-target-major | 6 | crate (RFC 9165 §3) | `bstr .abnf "*%x00-10FFFF"` | `40` | a / – / r |
| abnf-unanchored | 4 | crate (RFC 9165 §3, RFC 5234) | `tstr .abnf "a\na = \"x\" a / \"\""` | `63787879` | r / – / a |
| abnf-incremental-alternative | 4 | crate (RFC 5234 §3.3) | `tstr .abnf "r\nr = \"a\"\nr =/ \"b\""` | `6161` | a / – / r |
| abnf-rfc7405-strings | 3 | crate (RFC 9165 §3, RFC 7405) | `tstr .abnf "x\nx = %s\"aBc\""` | `63614263` | a / – / r |
| abnfb-bytes-as-utf8 (schema error) | 5 | crate (RFC 9165 §3) | `bstr .abnfb "oid\noid = 1*arc\narc = [nlsb] %x00-7f\nnlsb = %x81-ff *%x80-ff"` | `428100` | a / – / error |
| abnf-left-recursion-panic | 13 | crate (RFC 5234) | `tstr .abnf "a\na = a \"x\" / \"y\""` | `6179` | a / – / panic |
| abnf-start-element-panic | 17 | crate (RFC 9165 §3, RFC 5234 §2.1) | `tstr .abnf "Rule\nRULE = \"a\""` | `6161` | a / – / panic |

For the abnf rows the independent check is `abnf-oracle.mjs` (snug equals it
on all 169), shown as "–" in the PEG column.

- **d301-literal-cut.** `kind: "a"` has the colon's cut (§3.5.4: "the ':'
  shortcut is actually defined to include the cut semantics"). Under the
  literal text, once `kind` matches with a wrong value "the entire map fails
  to match"; the crate lets the `//` alternative take it (rule A, snug's
  `cuts: 'branch'`). This is the one class where both readings are
  documented and snug's default is an owner decision, not a crate defect.
- **d270-peg-groups.** Appendix A: alternatives "are to be tested in
  left-to-right order, locking in the first successful match". After the
  optional group takes `a`, `b`, the first alternative `* tstr => int`
  succeeds with zero pairs and is locked; `c: "x"` is left over, so the map
  fails. The crate retries the second alternative (set semantics, which the
  old oracle shared).
- **map-group-repetition.** §3.2 applies an occurrence to the whole group.
  `0*2 (2*2 …)` admits zero repetitions (the empty map) and two (four pairs);
  the crate refuses both. In `1*2 (tstr => uint, uint => uint)` each repetition
  needs one pair of each kind; one integer key and two text keys cannot be
  covered, and the crate accepts.
- **map-member-source-order.** Appendix A matches the group in source order:
  `* tstr => any` takes `"a": "x"` before `? "a": int` is reached, so the
  cut never sees it. The crate applies the cut member to the key regardless
  of order.
- **noncut-map-fallthrough** (+2, C5). No cut: a pair whose key matches but
  whose value does not stays available to later members. `tstr => 0` takes
  `"a": 0`, `tstr => 1` takes `"b": 1`; the crate checks every text-keyed pair
  against the first member's value.
- **numeric-control-across-kinds, cat-text-bytes, rfc9682-simple-head-numbers,
  nan-ne-control, float-range-control-target, float-zero-equality.** D329,
  D330, D336 and D250 each quote the RFC text and record the crate's
  behaviour, and this run is consistent with what they record (D329: the
  crate refuses all 11 cross-kind cases; D330: `h'01' .cat "x"`; D336: the
  crate refuses `#7.<T>` and `#7.25` on `f93e00`, here 32 head-number cases;
  D250: NaN `.ne` and bounded float ranges; the audit notes name each case). §3.8.6's own example is
  `speed = number .ge 0`, which the crate refuses for `0.0`.
- **prelude-time-nonfinite.** Appendix D: `time = #6.1(number)`, `number = int
  / float`; ±∞ are floats. RFC 8949 §3.4.2 only discourages them (D252 item 2).
- **d252-known-tag-validity.** Tag 0 content must be an RFC 3339 date-time
  (RFC 8949 §3.4.1), tag 32 an RFC 3986 URI-reference (§3.4.5.3), tag 1 a
  number (§3.4.2); §5.3.2 makes other content invalid. Snug's default presets
  check known-tag validity (D252, D260); the crate checks only CDDL. The
  audit corpus already recorded each crate disagreement in its notes.
- **abnf-element-only-unchecked.** RFC 9165 §3 allows "one valid element,
  followed by zero or more valid rules". The crate's `validate_abnf`
  (`validator/control.rs:783`) only validates when the controller contains a
  newline; a one-line controller accepts every string.
- **abnf-target-major.** RFC 9165 §3: "Both control operators can be applied
  to targets of either string type". The crate refuses `.abnf` on a byte
  string and `.abnfb` on a text string.
- **abnf-unanchored.** The crate translates the ABNF to pest and accepts
  when a prefix matches (`s\ns = 1*DIGIT…` accepts `"12a3"`); RFC 5234 defines
  a language, so membership is of the whole string.
- **abnf-incremental-alternative.** RFC 5234 §3.3's `=/` adds alternatives;
  the crate loses the rule (`r` refuses `"a"`, also when `=` and `=/` are
  followed by continuation lines, which the crate handles on their own).
- **abnf-rfc7405-strings.** RFC 9165 §3 brings in ABNF as "[RFC5234]
  [RFC7405]"; RFC 7405 adds `%s"…"` and `%i"…"`. The crate's ABNF parser
  fails on them ("in CrLf") and the control then refuses every input, so the
  RFC 5234 §2.3 / RFC 7405 §2.1 example `%s"aBc" / %d97.98.99 / %x41.42.43`
  refuses `"aBc"`, `"abc"` and `"ABC"`. (One-line controllers using `%s` are
  in `abnf-element-only-unchecked`, which the crate never parses.)
- **abnfb-bytes-as-utf8.** `.abnfb` reads bytes (RFC 9165 §3); the crate
  decodes the target as UTF-8 and fails with "error parsing utf8" on `81 00`
  (counted as a schema error because of that message).
- **abnf-left-recursion-panic.** pest refuses left recursion and the crate
  `unwrap`s the result (`control.rs:801:55`). RFC 5234 permits left recursion.
- **abnf-start-element-panic.** The crate passes the controller's first line
  to pest as a rule name, so any start that is not exactly a pest rule name
  panics (`pest_vm lib.rs:178`, "undefined rule"): `Rule` against `RULE` (RFC
  5234 §2.1: rule names are case-insensitive), a start with a trailing
  comment, a concatenation or alternation start, and D334's rule-first
  leniency (`s = 1*DIGIT…`: "undefined rule s = 1*DIGIT"). Some of these
  starts are snug leniencies (D334), but a panic is not a verdict, so there
  is no verdict to disagree with. D334's remark that the Rust crate also
  starts at a leading rule does not hold for the 0.10.7 CLI.

**Not covered here:** `xsd-regexp.json` (pattern vectors with no CDDL
wrapper; regexp dialect differences stay in `regexp-unanchored`) and the RFC
corpus (it has its own runner and Ruby cross-check). PEG semantics, D301,
D328–D330, D334, D336, D250 and D252 are now all exercised. D284 (simple
values) is exercised through `heads.json`; no disagreement is about it
alone. D260 (`valid` wire) is exercised through the `valid`-wire fixtures in
`numbers.json` and `heads.json`; no disagreement comes from it. Snug bugs
found: **0**.

### Ruby gem

`RUBY_CDDL=… node --test --test-name-pattern="Ruby differential"
corpus/tools/peg-oracle.test.mjs` (PEG oracle vs the Ruby cddl 0.12.14 gem,
300 seeded pairs) passes with the 2026-11-11 counts exactly: agreement 116,
RC 14, RL 42, RK 30, RI 15, RZ 30, RR 27, RO 11, RX 15, new/unknown/timeout 0
(41 s). That test compares the PEG oracle with Ruby, not snug; snug equals
the PEG oracle on every crate-diff case. `node corpus/tools/run-rfc-corpus.mjs --gate`: 999
checks, 996 pass, 3 classified, 0 unexplained, 0 stale; its Ruby column is the
checked-in evidence (320 checked, 7 known disagreements), not re-run.

## 2026-11-12 P9.8 follow-up: `.regexp` differential (`bb regexp-diff`)

`corpus/tools/regexp-diff.mjs` (`bb regexp-diff`, watchdog gate `regexp-diff`,
300 s wall / 600 s CPU; 20 s here) runs snug's `.regexp` in its default XSD
dialect (D242, D243), with the `snug/unicode` tables, beside the Ruby cddl gem
0.12.14 and the cddl crate 0.10.7 CLI:

- **`xsd-regexp.json`:** 36 cases (203 texts), checked against the file's
  hand-derived XSD verdicts, and its 24 invalid patterns (snug must refuse
  each at compile time; the oracles get two probe texts).
- **Generated:** 120 seeded patterns (seed `0x5eed9898`) over `{a, b, c}`, 948
  texts. They use only constructs whose meaning XSD, ECMAScript `v`, Onigmo
  and Rust `regex` share: literals, simple classes, groups, `|`, `? * +`,
  `{n}`, `{n,}`, `{n,m}`. Snug is checked against Node's `RegExp(…, 'v')`
  anchored over the whole text.

The pattern is a CDDL text literal with JSON/RFC 9682 escapes. Ruby runs one
process per pattern (`cddl SCHEMA vv files…`, reading only the per-file
`ann:` lines), and the crate one process per text.

**Result:** 180 patterns, 1,199 texts, **snug differences 0**: 203/203 hand
verdicts, 948/948 Node verdicts, 24/24 invalid patterns refused. Every oracle
difference is classified (exit 0).

| | Texts | Ruby agrees | Ruby differs | Crate agrees | Crate differs |
| --- | ---: | ---: | ---: | ---: | ---: |
| xsd-regexp cases | 203 | 138 | 65 | 118 | 85 |
| invalid patterns (2 probes each) | 48 | 22 | 26 | 28 | 20 |
| generated | 948 | **948** | 0 | 496 | 452 |
| **Total** | **1199** | **1108** | **91** | **642** | **557** |

**What the oracles are.** The Ruby gem compiles
`Regexp.new("\\A(?:#{pattern})\\z")` (`lib/cddl.rb`, `REGEXP_FOR_STRING`), that
is **Onigmo** in Ruby 2.6.10 with whole-string anchors. That makes it
XSD-like: it agrees with snug on all 948 generated texts. It is not XSD. The
crate calls `regex::Regex::new(format_regex(pattern)).is_match(text)`
(`validator/cbor.rs`), which is **Rust `regex`**, unanchored. Its
`format_regex` (`validator/mod.rs:1343`) drops the backslash before every
character that is not a regex metacharacter, except `d`, so `\s` becomes
`s`, `\i` becomes `i`, `\n` becomes `n` and `\p{L}` becomes `p{L}`.

The standard is RFC 8610 §3.8.3. It points at XSD 1.0 Part 2 second edition
Appendix F ("XSD regular expressions are defined in Appendix F of
[W3C.REC-xmlschema-2-20041028]"), which D242 follows; the XSD 1.1 regex
language is deliberately not used (D242). §3.8.3.1 adds:

- "XSD regular expressions support character class subtraction, a feature
  often not found in regular expression libraries";
- "\w and \d is based on Unicode character properties";
- "\s and \S do have their more conventional meanings, and '.' matches any
  character but the line-ending characters \r or \n";
- "XSD regular expressions do not support the usual \x or \u escapes".

The XSD verdicts themselves are the hand-derived ones in `xsd-regexp.json`
(Appendix F with the corrected class grammar, and XML 1.0 fifth edition
productions [4]/[4a] for `\i`/`\c`).

| Class | Ruby | Crate | Why the oracle is not XSD |
| --- | ---: | ---: | --- |
| anchor-metacharacters | 2 | 2 | Appendix F has no anchors: `^x$` matches the text `^x$` only. Onigmo and Rust treat `^`/`$` as anchors. |
| dot-matches-cr | 1 | 1 | §3.8.3.1: `.` excludes `\r` and `\n`. Onigmo and Rust exclude only `\n`. |
| no-class-subtraction | 14 | 17 | §3.8.3.1: subtraction `[a-z-[aeiou]]`. Onigmo reads `-[…]` as a union with a nested class (with a warning), and refuses `[\p{L}-[\p{Lu}]]` (RegexpError). Rust reads a nested class too, or fails to parse (`[a-[a]]`). |
| host-class-escapes | 18 | – | §3.8.3.1: `\d`/`\w` are Unicode (`\d` = Nd, `\w` = not P/Z/C, D243), and `\s` is TAB/LF/CR/SPACE. Onigmo's `\d` and `\w` are ASCII (`\w` includes `_`), and its `\s` adds `\v` and `\f`. |
| no-xml-name-escapes | 28 | – | Appendix F's `\i \I \c \C` (XML names). Onigmo reads `\i`/`\I` as letters, `\c` as a control escape, and `\C` is a RegexpError. |
| escape-stripped | – | 54 | `format_regex` turns `\s \S \w \W \D \i \I \c \C \n \r \t \p \P` into plain letters. The crate's `\d` survives and is Unicode, so it agrees there. |
| unanchored | – | 461 | Appendix F matches the whole string. Each case was checked: the crate accepts exactly where an unanchored search of the Node translation finds a match (9 corpus texts, 452 generated). |
| repetition-limit | 2 | 2 | `(){999999999999,1000000000000}` is valid XSD and matches `""`. Onigmo gives "too big number for repeat range"; Rust gives "decimal literal invalid". |
| invalid-xsd-admitted | 26 (13 patterns) | 20 (10 patterns) | Host syntax outside Appendix F. Ruby: `[a-z-[aeiou]x]`, `[a-z-[a]-[b]]`, `[a-b-c]`, `\x41`, `A`, `(?=a)`, `(?:a)`, `a*?`, `a++`, `a{,2}`, `a{2`, `\b`, `\p{Letter}`. Crate: the first six of those, minus `(?=a)`, plus `\1` (after stripping, the literal `1`), `(?:a)`, `a*?`, `a++`, `\b`. |

Every difference is the oracle's host dialect against the cited text. **No
snug bug and no new snug decision.** Snug's own I-Regexp option
(`regexp: 'iregexp'`, D242) is not part of this run. Reproduce:

```sh
RUBY_CDDL=$PWD/.cache/oracles/ruby-cddl.sh CDDL_NATIVE=$PWD/.cache/oracles/cddl-rs/bin/cddl bb regexp-diff
```

Evidence is in `.cache/regexp-diff/results.jsonl` (every text with all
verdicts and the class) and `summary.json`.
