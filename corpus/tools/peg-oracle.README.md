# Independent PEG reference oracle

`peg-oracle.mjs` is a direct recursive interpreter for RFC 8610 Appendix A
and architecture §20 revision 3.1 (D250, D251, D270, D272–D274). It is a
semantic witness, not a production validator or a performance model.

Independence: the parser, decoder, canonical-key writer and matcher were
written here from the checked-in RFCs and the design's semantic rules. No
prototype, existing oracle matching/parser logic, `kin/`, `gen/`, or
`host/js/src/` was read or imported. The only implementation dependency is
`bench/baseline/cbor-3sln.mjs`, which has no imports. The test reads schemas,
CBOR fixtures and the documented comparison table, never a production
matcher. Evaluation tiers, storage, charging and witnesses are outside scope.

## API and value model

```js
import { compile, check, decode } from './peg-oracle.mjs';
const schema = compile('r = [* uint, uint]');
if (!schema.error) {
  check(schema, 'r', decode(Uint8Array.of(0x82, 1, 2)), {
    cuts: 'reference', // default; 'rfc' is commitment epochs
    steps: 100000,    // default interpreter work bound
  }); // false
}
```

`compile(text)` returns a schema or `{error, offset?}`. Errors are fixed
codes and optional schema offsets, without payloads. Names include the
Appendix D prelude; user definitions shadow it. An empty file compiles but
has no user root. `check(schema, rule, value, options)` returns `true`,
`false`, or `'unknown'`; a missing rule, exhausted step budget, stack bound,
or controller domain this small interpreter cannot enumerate is unknown.
An unknown result is never an invalid-data verdict.

Use exported `decode(bytes)` for test values. It first calls the baseline
with `{top: 'any'}`. On success its values supply scalar/container contents;
a separate wire walk retains integer/float kind, original float width, tag
wrappers and NaN bits that the baseline API would erase. On baseline refusal
the independent decoder supplies the value. Its tagged item records are:

| kind | contents |
| --- | --- |
| `int` | `value: bigint` (major 0/1) |
| `float` | `value: number`, `width: 16/32/64`, `bits: bigint` |
| `text`, `bytes` | `value: string` or `Uint8Array` |
| `simple` | `value: 0..23 or 32..255` |
| `array` | `items: item[]` |
| `map` | `pairs: [item, item][]`, retaining wire order |
| `tag` | `tag: bigint`, `item: item` |

`check` also accepts ordinary JS values for convenience: safe integer
numbers, bigints (using tag 2/3 beyond the native CBOR range), other numbers
as binary64 floats, strings, byte arrays,
arrays, Maps and plain objects. Use decoded items when kind, tags, width or
NaN payload matter. The record representation is intended for trusted test
fixtures, not arbitrary objects supplied by an application.

The fallback decoder implements RFC 8949 §3 definite and indefinite items,
non-shortest heads, independent UTF-8 chunk validation, all simple values,
and opaque tags. It rejects malformed structures, invalid UTF-8 and duplicate
keys by EC equality. It does not impose Bindle limits or application-specific
known-tag validity checks. A CDDL tag's content is checked by its schema.
`decodeSequence` returns a virtual array of items. Embedded `.cbor` and
`.cborseq` use the same independent decoder with the parent's step budget.
Decoder nesting is capped at 512; standalone decode can throw on malformed
input or excessive nesting. These are outside the three-valued `check` API.

`ecBytes(item)` produces the design's key comparison form: shortest heads,
shortest exact floats, positive float zero, NaN sign cleared with significand
preserved and zero-extended across widths, and recursive map sorting. It
keeps integer/float, bytes/text, simple/integer and tagged/untagged distinct.
Bignum content bytes stay intact. Map matching sorts by these bytes, never
by wire order, JS property order, decoded string order or key length alone.

## Coverage and intentional limits

| Area | Implementation |
| --- | --- |
| Groups | Source-order sequence; prioritised `//`; locked success; greedy occurrences; no retry at container completeness; failed-iteration rollback; empty success satisfies minima; count saturation; guarded recursion; unplugged sockets fail |
| Maps | Remaining pairs in EC key order; finite maxima stop examination; non-cut wrong values skipped; closedness after root success; direct member occurrences and group repetitions kept distinct |
| Cuts | Rule A propagates cut failure through sequence/repetition and explicit choices absorb it; RFC mode counts key-match commitments per alternative/iteration attempt, scoped to each map type |
| Types | Complete Appendix D prelude; type choices; literals; integer/float ranges; `.size`, `.bits`, numeric comparisons, `.eq/.ne`, `.and/.within`, tags, bare major types, representation AI constraints, RFC 9682 head-number types |
| Composition | Named groups/types, rule-order socket contributions, generics, array/map/tag unwrap, enum values with occurrences ignored, `.cbor`, virtual-array `.cborseq` |
| RFC 9165 | `.feature` annotation and finite `.plus/.cat/.det` products; integer-target mixed addition floors; concatenation works on bytes; dedent removes common leading spaces |
| Comparisons | Exact bigint arithmetic; IEEE float comparisons; both float zeros equal; NaN unordered and unequal; scalar numeric controls permit numeric comparison across kinds; nested integer/float kinds remain distinct |

Numeric bignum ranges and controls use the mathematical integer. Literal
bignums retain their generic tag/content form for matching, consistent with
the inherited DC model: an added leading zero byte distinguishes a literal
match, although a numeric `.eq` control can equate the integer values.

The parser is a small recursive-descent implementation of the updated
RFC 9682 grammar. Tests reverify ambiguity at parentheses, the difference
between `* 3` and `*3 int`, optional commas, multiple rules per line,
rule-order extensions, generic binding, tag unwrap, Unicode scalar/surrogate
escapes, bytes and binary/hex numbers. Hex floats round once to binary64,
including ties and subnormals. Direct/left group recursion is refused;
non-growing guarded generic recursion is shared. Compile expansion has a
20,000-work-unit bound and a one-million-character source cap. This is not
a complete static CDDL type checker: malformed controller domains can be
reported as unknown at check time instead of compile errors.

Singleton controllers and finite construction domains are intentionally
simple. Non-singleton `.eq/.ne` controllers and infinite `.plus/.cat/.det`
products return unknown; integer constant ranges are enumerated only up to
4,097 values. `.abnf`, `.abnfb`, `.pcre` and unknown controls are explicit
compile refusals. These are coverage limits, not alternative semantics.

`.regexp` uses a JS `RegExp` with `u`, a noncapturing wrapper and full-string
anchoring, including refusal of a trailing newline outside the match. This
is expressly a test approximation: JS and XSD differ on character classes,
subtraction, escapes, Unicode categories, anchors and other constructs.
Invalid JS expressions return unknown. The oracle cannot establish XSD
conformance, and regexp execution is not interrupted by the interpreter's
step counter. No resource, throughput or complexity claim is made.

## Reproduce

```sh
node --test --test-reporter=tap corpus/tools/peg-oracle.test.mjs
# Semantic tests without invoking Ruby:
node --test --test-skip-pattern='Ruby differential' corpus/tools/peg-oracle.test.mjs
```

The default Ruby executable is the scratch wrapper named in the task.
Set `PEG_RUBY=/path/to/offline-wrapper` to override it. If absent, only the
Ruby test is skipped explicitly. The suite installs nothing and uses no
network. Temporary CDDL/CBOR files are created under the OS scratch directory
and removed in `finally`. Four CLI processes run concurrently, with a
60-second per-invocation timeout. Only rc 0/1 are data verdicts. Rc 65 is a
parse error; timeout/spawn failure/other status is separate evidence.

The seeded differential sample uses xorshift32 seed `0x86109165`: 20
stratified grammar families, 15 samples per family, with seeded labels,
values, counts and shuffling. The families deliberately exercise the eight
known deviation mechanisms as well as ordinary agreements; this is not a
uniform sample of CDDL and its rates are not population estimates. A
candidate class is assigned by family, then accepted only for the documented
direction and mechanism of disagreement. Other observations are `new`;
unknown/timeouts remain separate. Every unexpected result prints its sample
ID and schema. No Ruby result is used to change the oracle's semantics.

The 117 comparison rows are loaded from architecture **§20.15** (the task
calls this §20.13); both verdict columns are asserted separately, so each
mismatch is its own failing test. Semicolons in the table's compact schemas
are rendered as newlines before parsing; actual CDDL semicolons are comments.
The migration's expected case indices are explicit in the test. The complete
910-case non-schema-error adversarial corpus is also checked: its only
verdict changes must be precisely the 33 documented true-to-false flips.

## Findings: design versus RFC text

The interpreter follows the design in each case below. These findings do
not change the documented table's expected verdicts.

1. **F1 — Prioritised group choice versus generative union (R5).**
   [RFC 8610 §2.2.2](../rfc/rfc8610.txt) says “union of the sets”. Appendix A
   and Appendix C instead supply PEG choice. The design chooses lock-in,
   including an empty first alternative. `{(? a: int) // (b: int)}` therefore
   rejects `{b:1}`. This is a real textual tension already acknowledged in
   §20.3, not evidence to silently switch to an existential matcher.
2. **F2 — Determinate EC picks versus existential map wording (R8/R15).**
   RFC 8610 Appendix C says “can be ordered”; §3.5.3 leaves picks
   indeterminate. EC order is the design's policy. `{int => int, int => 6}`
   rejects `{3:6,4:5}` even though another permutation would succeed. Input
   wire order cannot change that verdict.
3. **F3 — Rule-A cut scope (R9/R19).**
   RFC 8610 §3.5.4 says “entire map fails to match”. Rule A permits an
   explicit enclosing group choice to recover; literal RFC mode does not.
   It also propagates a cut failure through `?`/`*`, whereas Appendix C's
   occurrence expansion says “acts as a” group choice. Thus explicit
   `(a: int) // ()` and `? a: int` differ under rule A. Both modes preserve
   named-group substitution. The lifetime of *successful* cut commitments
   across failed alternatives/iterations is the design's formalisation,
   not explicit RFC pseudocode.
4. **F4 — Zero-length iteration (R4).**
   The RFC does not prescribe a terminating evaluation rule for a repeated
   empty success. The design stops and satisfies even a saturated minimum.
   `[16777216*16777216 (? int)]` accepts `[]`. This is an explicit policy
   extension, not an observed Ruby behaviour.
5. **F5 — Inherited float-width semantics versus representability.**
   RFC 8610 §2.2.3 says “can be represented” when explaining `#7.25`.
   Architecture §4.2/§4.8 instead describe encoded widths, inherited by
   §20. The oracle preserves original wire width: binary32 encoding of
   `1.5` matches `float32` and does not match `float16`, although that value
   fits binary16. This conflict is outside the 117 group probes. It is
   recorded rather than concealed by shortening decoded floats.
6. **F6 — Inherited `.default` annotation.**
   RFC 8610 §3.8.6 specifies “implied .ne”; architecture §4.6 lists no
   effect. The oracle follows the inherited architecture policy, so
   `uint .default 1` accepts `1`. `.default` was not among the task's required
   controls, but the implemented convenience support exposes this existing
   conflict explicitly.

The rules for RFC 9682 tag/simple head numbers are followed directly: majors 6/7 use tag
numbers/simple values (25–27 select floats), while majors 0–5 use
representation additional information. The JS regexp approximation is an
explicit task requirement and a coverage limit, not an inferred RFC rule.

## Recorded verification

Executed offline on 2026-11-04 with Node v24.6.0 and Ruby `cddl` 0.12.14
through the supplied wrapper.

* Documented probes: **117/117 in reference mode, 117/117 in RFC mode**;
  **zero design-verdict mismatches**. F1–F6 above document textual/policy
  findings separately from probe agreement.
* Corpus: **910/910** cases match their post-PEG expectations. Exactly
  **33 flips**, comprising 11 structural and 22 rule-A cases; 103 individual
  migration-suite case tests also check the unchanged neighbouring cases.
* Final local command with Ruby excluded: **470 passed, zero failed**.
  This includes 234 probe verdict tests, 126 supplemental semantic/wire
  cases, decoder/EC/compile/budget checks and corpus checks.
* The full command including the completed Ruby sample passed **467/467**
  tests before the final four regression additions. The final local command
  above covers those additions; the later edits do not change this sample's
  schemas, values or matching paths. No final 471-test combined rerun is
  claimed.

Ruby's 300 sampled attempts produced 285 rc-0/1 verdicts: **116 agreements**
and **169 classified verdict disagreements**, plus **15 parse errors**.
Unknowns, timeouts, other statuses and new disagreements: **zero**.

| Classification | Count | Direction/evidence |
| --- | ---: | --- |
| agreement | 116 | Same data verdict |
| RC | 14 | Oracle refuses, Ruby accepts; repetition absorbs cut failure |
| RL | 42 | Oracle accepts, Ruby refuses; literal-key cut/whole-map lookup |
| RK | 30 | Non-literal key match with wrong value fails instead of skipping |
| RI | 15 | Oracle refuses, Ruby accepts; failed iteration leaks consumption |
| RZ | 30 | Oracle accepts, Ruby refuses; empty iteration does not satisfy minimum |
| RR | 27 | Oracle accepts, Ruby refuses; guarded array group recursion |
| RO | 11 | Oracle accepts, Ruby refuses; wire-order versus EC-order picking |
| RX | 15 | Rc 65 on `.cborseq`; **not** a data refusal |
| new | 0 | No unexplained observation |

A preliminary four-second Ruby invocation allowance was inconclusive due
to process-startup timeouts. Those attempts are excluded from the table;
the completed run uses the documented 60-second allowance.
