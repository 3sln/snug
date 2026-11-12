# Offline RFC conformance corpus (P8.6)

Expectations come from the local RFC texts and D270 PEG semantics. Observed
snug or Ruby behaviour never changes an expectation. This is a findings
corpus for P8.2/P8.4/P8.5, with the literal-RFC cut case staged separately
(`D301`; it was `D271` before the owner's 2026-11-10 decision).

## Reproduce

From the repository root, with Node and the already installed Ruby reference:

```sh
node corpus/tools/export-rfc.mjs
node corpus/tools/run-rfc-corpus.mjs --json=corpus/conformance/rfc/current-results.json
node corpus/tools/run-rfc-corpus.mjs --depends=D270 --gate
```

The exporter uses `.cache/oracles/ruby-cddl.sh` and `.cache/oracles/ruby-gems`
by default (rebuild: `corpus/tools/ORACLES.md`). Set `RFC_RUBY` (or `RUBY_CDDL`)
to another wrapper and, if necessary, `RFC_GEM_HOME` (or `RUBY_CDDL_GEM_HOME`)
to its existing gem directory. No downloads, installs or network operations occur.
The installed `cbor-diag` executable converts RFC 9052 diagnostic notation.
The CDDL reference checks invoke the wrapper separately for each case:
exit 0 is valid, exit 1 invalid; other statuses, timeouts and detected
Ruby exceptions are **unavailable**, never invalid-data verdicts. At most
four reference processes run together. Scratch inputs are created under the
system scratch directory and removed afterwards.

`--reuse-ruby` reuses completed reference evidence (including explicit
schema/runtime errors, never process timeouts) only when the extracted
schema, context, rule, bytes, expectation and explanatory note are identical.
`--skip-ruby` is an extraction-development option and marks checks `not-run`;
it must not be used to claim a reference cross-check. The checked-in corpus
is generated with reference checks enabled.

The runner prints compile findings and pass/fail per suite, then exact
dependency groups (`baseline`, `D270`, `D301`, `P8.4`, or combinations).
Default report mode exits 0 even with findings; `--gate` exits 1 when a
selected expectation fails without a classification, or when a classified
check passes (a stale classification).

**Classifications (P9.2).** An expectation snug does not meet is either fixed
or carries `classification: {kind, decision, reason}`. The exporter writes it
(`corpus/tools/export-rfc.mjs`); a wire vector carries one per preset. Kinds:
`deviation` (a documented deviation with its D-entry), `contested` (an RFC
reading under an open erratum) and `pending` (work assigned to a checklist
item). As of 2026-11-11:

| Checks | Classification | Reason |
| --- | --- | --- |
| rfc8949-additional `f97e01`, `faffc00001` under `deterministic` | deviation, D122 | The `deterministic` preset is RFC 8949 §4.2.1 plus §4.2.2's single NaN ("the protocol needs to pick a single representation, typically 0xf97e00"); the default `valid` preset accepts both |
| RFC 8610 default-timer #1 | contested, S46 | §3.8.6's "implied .ne control" for `.default`; snug, like the Ruby reference, follows Erratum 9229 (Reported): `.default` is an annotation |
| RFC 9165 figures 3–5 (9 checks) | pending, P9.14 | `.abnf`/`.abnfb` arrive with the optional ABNF module |

The runner prints a suite whose failures are all classified as `CLASSIFIED`,
and counts `classified`, `unexplained` and `stale` in its summary.
`--depends=baseline` selects unstaged cases;
`--depends=P8.4` selects that exact group. The complete default report runs
every group. An invalid-data case whose schema cannot compile is a failure,
not a successful refusal. Compile findings are reported separately as well.

Until `wire:'valid'` is available, the runner measures the current default
against `valid` expectations and explicitly reports that fallback. Explicit
`deterministic`/`bindle` checks always use those selectors. Decoder vectors
use `top:'any'`: Bindle's default map-root application restriction would
otherwise hide scalar/array behaviour. Bindle expectations are a measured
compatibility snapshot, not a purported RFC policy. `current-results.json`
records the runtime source hashes before/after the run and `runtimeStable`;
this is working-tree evidence, not a release certification.

## Sources and extraction boundary

Only the unmodified texts in [../../rfc](../../rfc/README.md) are sources.
Each extraction records its RFC, section, source SHA-256 and selected line
span. The exporter checks source hashes against `corpus/rfc/README.md`
before using its audited selections. `logicalLines` counts both LF and form-feed separators (the Python
`splitlines()` convention used to audit printed page boundaries); ordinary
`lines` fields in diagnostic/hex extracts count LF lines. No errata are
silently applied. `extraction-inventory.json` accounts for every displayed
assignment-like line, including explicit exclusions for ABNF and
cryptographic pseudocode. It is an audit aid, not a CDDL parser.

| RFC | Extracted material |
| --- | --- |
| 8949 | Every Appendix A/Table 6 row, including all printed wide floats and indefinite encodings; every Appendix F.1 malformed byte list. Additional hand-made §3/§4/§5 witnesses are labelled separately. |
| 8610 | All displayed CDDL schema blocks and Figures 1–12, 14–16; Appendix D's full 40-name prelude; Appendix E subsets; both Appendix H schemas and the printed generated instance. Six displayed expression/name fragments receive explicitly labelled contexts. Figure 13 and Appendices B/C are ABNF, not CDDL schemas; Appendix A's ABNF/PEG productions are inventoried as such and its normative semantics have derived cases. |
| 9165 | All nine CDDL figures, including byte-string literal content containing ABNF. The separate `CRLF` production is ABNF. Figure 6 leaves `bar`/`baz` as ellipses; it is retained with a compile finding and no invented data membership. |
| 9682 | Figure 5 CDDL and its Figure 6 CBOR (checked independently against printed hex); §3.2 generic tag-number fragment; both Appendix B.1 hex-string examples. Other figures and Appendix A are ABNF, inventoried separately. Derived simple-head-number cases exercise the new grammar. |
| 8392 | No CDDL occurs in this RFC. The claims schema is explicitly **derived** from §§3–5. All nine Appendix A hex blocks are preserved, including example keys, signed/MACed/encrypted/nested envelopes and the floating-point date example. Envelope CDDL is assembled from RFC 9052. |
| 9052 | Every CDDL fragment from §§1.4–7, compiled separately and assembled without rewrites. All 17 diagnostic examples in Appendix B and C (including public/private test key sets) are converted locally; Appendix D contains no additional data example. |
| 8746 | All five §3 annotated CBOR figures: typed tag-40 array, basic tag-40 array, tag 1040 and two homogeneous tag-41 arrays. |
| 8742 | Both equivalent §4.2 notations for the three-item sequence, plus derived §2 empty, valid non-deterministic and truncated-tail cases. |

RFCs 3339 and 3986 supply the referenced tag/claim validity rules; RFC 9485
is relevant to the preceding regexp audit. They contain no additional CDDL
schema blocks in the requested extraction set. No CoSWID/EAT/full SenML
RFCs are present in this input set, so their schemas are not reconstructed
and passed off as extracts. RFC 9165's small SenML feature example is included.

## Fidelity and page artefacts

The `cddl` field preserves selected source text. Only document-wide left
indentation, page footers/headers/form-feeds and surrounding blank page
padding are removed. Each affected selection records `indentRemoved` and
`pageArtifactFixes`, including the exact footer/header removed. The RFC 8610
Appendix D prelude and verbose Appendix H schema cross page boundaries;
no schema token, literal, comment, operator or name is repaired. Layout
indentation is removed consistently, preserving indentation **inside**
RFC 9165 multiline literals relative to their enclosing code block.

The original `cddl` is always compiled with public `await compile(text)`.
`compileObservation` is evidence, not `schemaError`. Where a snippet needs
an array/map wrapper, generic instantiation or earlier definitions,
`context` separately records that added test harness and its own compile
observation. The RFC 9052 context is the concatenation of its extracted
definitions; it never imports a different COSE draft or silently inserts
cuts into `=>` entries. Intentionally undefined mixed ranges, ellipses and
the obsolete ambiguous hex literal retain explicit `noCasesReason` fields.

Appendix A diagnostics and hex cells are joined across printed table wraps;
the bytes are copied rather than re-encoded. Appendix F lists are split at
commas and spaces removed. All 94 F.1 items are **not well-formed**; that
appendix supplies no merely-invalid-but-well-formed example. Additional
UTF-8, duplicate-key and tag-content cases distinguish **invalid** data.
snug reports the first refusal in stream order, so a not-well-formed example
can still get a validity code. Under `valid`, F.1's `bf01020102` and
`bf000000ff` repeat a key before their well-formedness error and are
`duplicate_key` at offset 3; this is not a well-formedness bug
(docs/scanner.md, "Precedence across classes"). The other 92 are
`truncated` or `malformed`, as their Appendix F kind says (`bb sequence-test`).
For RFC 8746, annotated hex comments are removed and `<Tag N>` is expanded
to its preferred CBOR tag head. RFC 9052 EDN conversion preserves printed
map order, including embedded protected-map byte strings; it does not sort
maps to make the current decoder accept them. Printed binary size claims
can be compared directly with the saved `hex` length.

## Expectations and interpretation

`rfcNNNN.json` uses the existing suite format: `name`, `cddl`, and
`cases:[{rule,hex,expect,note,...}]`. `context`, `source`, `origin`,
`dependsOn` and reference/compile observations extend that format. The wire
files use `vectors:[{hex,diagnostic,expect:{valid,deterministic,bindle},...}]`.
The Appendix A wire file is at
[../../cbor-vectors/rfc8949-appendix-a.json](../../cbor-vectors/rfc8949-appendix-a.json).
Diagnostic/hex source archives are provenance for cases, not extra gates.

Hand-made fixtures use a small local CBOR constructor independent of snug's
encoder. Expectations are justified in each case's note. D270 means greedy
occurrence and first successful group choice with no later backtracking.
Pathological map-picking examples receive only unambiguous negative cases;
no Boolean verdict is invented for the RFC's indeterminate positive map.
The cut-scope witness uses the literal RFC cut reading. D301 (2026-11-10)
made that reading snug's default cut semantics in the format 2.0 PEG engine
(rule A is `cuts: 'branch'`); the case is staged as `dependsOn: ["D301"]`
until that engine is the one the runner measures (format 1's D021 VM fails
it). Re-derived with the independent oracle in its default `rfc` mode
(2026-11-10): both cases of the suite keep their expectations, and no other
RFC-corpus case changes verdict between the two cut modes. P8.4 covers valid non-preferred or
indefinite bytes, unsorted/embedded maps and currently restricted valid
simple/tag encodings. Reference results never determine those expectations.

Core deterministic expectations mean RFC 8949 §4.2.1, including preferred
heads/floats, definite lengths and bytewise map-key order. §4.2.2's extra
application choices are separate: the payload-preserving NaN and decimal
witnesses deliberately remain deterministic without imposing canonical NaN,
integer-vs-float unification, decimal normalization or typed-array endian
choices. The current strict decoder can therefore disagree even on core
deterministic input. Decoder refusal codes are recorded; a profile refusal
does not establish the RFC well-formedness/validity class of those bytes.

Structural COSE/CWT acceptance is not a cryptographic signature/MAC check,
decryption, expiration check or claim-authorization decision. The derived
CWT schema checks claim CBOR types, allows §3.1.3 audience arrays and rejects
tags on registered claims (§5); it does not express the StringOrURI
colon/URI syntax predicate. No case relies on omitting that predicate.

Two published-example issues are retained for review. RFC 9052's printed
`Sig_structure` optional bstr greedily consumes a field in the four-field
Signature1 shape, contrary to the prose's intended shape. RFC 8610's
Appendix H generated JSON uses rating values not representable in binary16
although the schemas specify `float16`; the exact decimal values are
preserved and expected not to match, without rounding them into validity.
Published `.default` semantics follow implied `.ne`; unverified erratum
9229's proposed annotation-only reading is recorded as a Ruby disagreement.

## Reproduction terms

The RFC excerpts are copyright the IETF Trust and the persons identified
as each document's authors, with years and notices in the accompanying
license files. The source RFCs remain unmodified and retain their notices.
They are subject to BCP 78 and the IETF Trust's
[Legal Provisions Relating to IETF Documents](https://trustee.ietf.org/license-info)
in effect at publication. This link is provenance, not a fetched dependency.

The local notices distinguish two licenses: RFCs 8392/8610/8742/8746/8949
specify the [Simplified BSD License](LICENSE-Simplified-BSD.txt);
9165/9052/9682 specify the [Revised BSD License](LICENSE-Revised-BSD.txt).
Those full license texts accompany these extracted Code Components and
must accompany redistribution. These derived fixture files are not RFCs,
errata, or IETF-endorsed changes. Original corpus tooling remains under
snug's project license.

## Current observations

See `extraction-summary.json` for counts and per-RFC compile/reference
findings, the `ruby` fields on every data case for disagreements and their
explanations, and `current-results.json` for the complete snug run. Counts
below are filled from the final verified generation/run, not inferred from
previous audit results.

Run: 2026-11-04, Node v24.6.0, supplied Ruby cddl 0.12.14 on Ruby 2.6.
The current runtime did not support `wire:'valid'`; the report labels the
default-policy fallback. Runtime source fingerprints were unchanged during
the full run. No performance measurement or cross-host claim is made.

| RFC | Wire/sequence vectors | CDDL suites | Data cases | Raw / contextual compile failures |
| --- | ---: | ---: | ---: | ---: |
| 8949 | 187 (81 A + 94 F + 12 additional) | — | — | — |
| 8746 | 5 | — | — | — |
| 8742 | 4 | — | — | — |
| 8610 | — | 68 | 286 | 13 / 5 |
| 9165 | — | 9 | 20 | 5 / 5 |
| 9682 | — | 5 | 11 | 2 / 2 |
| 8392 | — | 1 | 16 | 0 / 0 |
| 9052 | — | 25 | 68 | 22 / 0 |
| Total | 196 | 108 | 401 | 42 / 12 |

The case counts include all nine CWT hex examples and 17 COSE EDN examples,
also saved as source archives; these are not counted twice as independent
wire gates. The RFC 9682 printed CBOR is likewise a CDDL case. Of the 12
contextual compile findings, three are intentionally undefined/illustrative
excerpts (mixed ranges, ellipses, obsolete ambiguous literal); nine concern
data models with membership expectations. There are 25 cases without a
snug data verdict because their effective schema did not compile.

| Exact dependency group | Pass | Fail |
| --- | ---: | ---: |
| baseline | 731 | 29 |
| P8.4 | 179 | 45 |
| D270 | 3 | 11 |
| D271 (now D301) | 0 | 1 |
| Total | 913 | 86 |

There are 999 checks: 401 CDDL cases, 588 wire-policy verdicts and ten
applicable sequence item-count checks. Failure counts include unavailable
snug data verdicts as failures, so a compiler refusal cannot hide a bad
expectation. The D271-only `--gate` invocation exits 1 as expected. (This
run predates D301; the same case is now selected by `--depends=D301`.
`current-results.json` is that run's record and keeps the old group name.)

Ruby returned **320 data verdicts**, of which **seven disagree** (all in
RFC 8610): the cut-free wildcard example, accepting an untagged integer for
`biguint`, annotation-only `.default`, three float-width cases, and literal
global cut scope. Each disagreement carries its RFC rationale and a tool
explanation on the case. Source inspection confirmed Ruby synthesizes
bignum tags for decoded integers and checks floats using the shortest
re-encoded width. Those implementation choices are not used as RFC authority.

The other **81 attempts are reference errors**: all 79 explicit-prelude
cases conflict with Ruby's built-in, regexp-restricted `tdate` definition;
the escaped-hex positive case raises `ArgumentError`; and the `#7.24` simple
value case raises `RuntimeError`. These are not invalid-data verdicts or
disagreements. The four generic tag-range cases and the new simple-value
range's two cases do obtain verdicts. No case is marked `not-run`.

Executed checks: full exporter with the supplied reference wrapper, a
regeneration reusing identical completed reference evidence, the full
runner with JSON output, the D271-only failing gate, syntax checks for all
three new tools, source-hash checks, and independent counts confirming
81 Appendix A rows / 94 distinct Appendix F examples / no page furniture
left in extracted schemas. Implementation tests, `bb emit`, Rust/wasm,
network access, installs and commits were not run.
