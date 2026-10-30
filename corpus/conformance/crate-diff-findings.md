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
