# CDDL support

snug implements a bounded, explicit subset of RFC 8610 with RFC 9165 controls
and RFC 9682 grammar updates. Unsupported or unprovable constructs fail at
compile time; an accepted construct keeps its documented meaning. This is
not a claim of complete RFC coverage. The current wire profile can make a
perfectly valid CDDL type uninhabited: `undefined`, for example, is parsed
from the prelude but its CBOR simple value is refused by the scanner.

The compiler and matcher are kin, shared by JS and Rust. This document
describes the current implementation, informed by D010–D014, D020–D025,
D031–D043, D083/D110–D111, and the [architecture](architecture.md#4-validation-semantics).

## Grammar and types

| Construct | Supported behaviour |
| --- | --- |
| Type/group rules, references, `/=`, `//=` | Supported; duplicate `=` definitions refused. User rules may shadow prelude names (D031). |
| Type choices `/`, group choices `//`, nested groups | Supported; all alternatives evaluated as sets. |
| Maps `{}`, arrays `[]`, labelled members | Supported; array member names are labels, not matching constraints. |
| Occurrence `?`, `*`, `+`, `n*m`, fixed counts | Supported within the exactness/size conditions below. |
| Generic type/group rules and instantiation | Supported, memoised with limits; unresolved/wrong-arity uses refused. |
| Sockets `$name`, `$$name` and extensions | Supported in `full`; undefined type socket is empty, undefined group socket is an empty group. |
| Unwrap `~`, group enumeration `&` | Supported for applicable targets; map/enumeration recursive groups refused. |
| Productive recursive types | Supported when recursion passes through a container/tag; depth bounded. |
| Recursive array groups | Regular tail recursion only, e.g. `g = (int, ? g)`; see D036. |
| Numeric, text and byte literals, ranges `..`/`...` | Exact integer comparison, encoded-width floats; hexadecimal/decimal floats and h'/b64'/byte literals supported. |
| Major-type syntax, tags | `#0`…`#7`, simple values `#7.n`, tag content `#6.n(T)`, RFC 9682 tag constraints supported where well formed. Runtime profile still restricts actual tags/simple values. |
| Appendix D prelude | Compiled from CDDL text; includes exact bignum integer types. Some names have no value under the current wire profile. |
| UTF-8 schema text and escapes | Whole schema must be valid UTF-8; code-point columns, HT whitespace, Unicode escapes/surrogate pairs, RFC 9682 braced escapes, byte-literal whitespace/comments supported. |

Only user non-generic **type** rules become validation roots. Productive
recursive schema instantiation must fit the compile budget and limits;
ever-growing generic expansion is refused rather than exhausting resources.

## Controls

| Controls | Meaning and limits |
| --- | --- |
| `.size` | Text/bytes count UTF-8/content bytes. `uint .size n` admits 0..256ⁿ−1; a range controller uses the minimal byte-length interval (lower length 0 includes zero). |
| `.bits` | Permitted bit positions on uint or bstr; bstr bit n is byte n>>3, bit n&7, least significant first. Zero/all-zero masks still constrain. |
| `.lt`, `.le`, `.gt`, `.ge` | Intersect numeric intervals; exact any-size integers and float bit-pattern bounds. |
| `.eq` | Target intersected with controller, not replacement of target; `(tstr .size 1) .eq "aa"` is empty. Composite controllers lower to AND (D038). |
| `.ne` | Numeric exclusion splits intervals; other targets exclude a literal while retaining target constraints. Composite nonliteral controllers refused. |
| `.and`, `.within` | Intersections, with operands evaluated as same-item dependencies; they do not create extra accepting alternatives. |
| `.regexp` | Whole-string RFC 9485 I-Regexp, compiled to a bounded code-point automaton; details below. |
| `.cbor T` | Byte content must be exactly one current-profile CBOR item matching T. |
| `.cborseq [G]` | Byte content is a sequence matching the controller's array group, including positions/occurrences. Controller must be array types only (D040). |
| `.default`, `.feature` | Accepted annotations, no effect on matching (D013, D038). |
| `.cat`, `.det` | Compile-time concatenation of two literals of the same text/byte kind; `.det` dedents each literal first. |
| `.plus` | Compile-time addition of two integer literals, any size; float operands refused (D038). |

Numeric controls mixing an integer target and float controller (or vice
versa) require exact conversion within the compiler's restricted |x|<2⁵³
domain; otherwise `control_value` (D038). Decimal schema float literals have
at most 17 significant digits, must be finite, and a nonzero value may not
round to zero. Hex floats are rounded by kin (D020/D032). Unsupported
control targets/controllers are errors rather than ignored controls.

Embedded checks are local predicates: `bstr .cbor uint / bstr .size (0..16)`
can accept bytes that fail the embedded branch. An embedded failure is
reported as `embedded` with its subcode only when it makes the outer rule
fail. Embedded item accounting restarts; budget is shared. Physical scratch
depth still bounds embedding. A schema querying both `.cbor` and `.cborseq`
on the same bytes can cause separate inner walks; the work budget bounds it
(D040). The one-pass claim does not promise one visit across independent
embedded interpretations.

## Unicode regexp categories

`.regexp` matches the whole text as RFC 9485 I-Regexp. Opt in to Unicode
General_Category escapes with `compile(text, { unicode: tables })`, importing
`tables` from `snug/unicode`. `\p{X}` selects category X and `\P{X}` its
complement; both work inside classes, including `[\p{L}\p{Nd}_-]` and
negated classes. Escapes are case-sensitive. Supported names are:

```
L Lu Ll Lt Lm Lo   M Mn Mc Me   N Nd Nl No
P Pc Pd Ps Pe Pi Pf Po   Z Zs Zl Zp   S Sm Sc Sk So
C Cc Cf Co Cn Cs
```

`Cs` is empty: surrogate code points never occur in Unicode text. `C` also
excludes surrogates; `\P{Cs}` matches any single scalar allowed by the wire
profile. The Bindle profile (`wire: 'bindle'`) rejects noncharacters with
`cbor/text`, even when a category would otherwise match; the deterministic
preset admits them, and they match their categories (Cn). Category aliases, scripts, blocks,
`gc=…` spellings in CDDL and host-engine extensions are refused.

Tables are pinned to **Unicode 16.0**, generated offline from **Node
v24.6.0 / ICU 77.1**, and checked in for JS and Rust. The separate JS module
is **19,377 bytes minified / 9,287 bytes gzip-9** (complete exported module;
[method](../bench/README.md#unicode-table-module-p73)). It is never imported
implicitly by the compiler or runtime. Without tables, category escapes
remain a `regexp` schema error whose message names `snug/unicode`.

Kin checks the sorted scalar-range data and charges table ingestion, lookup,
class normalisation and atom construction against the compile budget.
A category consumes one regexp position regardless of its range count;
quantifiers still obey the position limit. Compiled Programs contain only
the resulting automata and use the existing format. Unicode tables and
version metadata are unnecessary for validation or loading stored Programs.
The source key includes supplied table contents (D110), so regenerating with
another Unicode version cannot reuse a key for different category semantics.
See the [loading example](guide.md#optional-unicode-regexp-tables).

## Regexp cookbook

Patterns match the **whole string**; use `.*` explicitly when you mean
surrounding text. There are no JS flags or slash delimiters. The grammar is
RFC 9485 I-Regexp, with literals, code-point classes/ranges, grouping,
alternation, `.`, and `?`, `*`, `+`, `{n}`, `{n,m}` repetitions; see the
recorded [regexp design](architecture.md#47-regular-expressions). JS shorthands `\d`,
`\w`, `\s`, lookarounds and backreferences are not supported. Use explicit
classes, e.g. `[0-9]`, `[A-Za-z0-9_]` or `[ \t]` as appropriate to your protocol.

These paired JavaScript strings produce identical CDDL text:

```js
const digits = 'digits = tstr .regexp "[0-9]+"';
const digitsRaw = String.raw`digits = tstr .regexp "[0-9]+"`;
const identifier = 'identifier = tstr .regexp "[A-Za-z][A-Za-z0-9_-]{0,15}"';
const identifierRaw = String.raw`identifier = tstr .regexp "[A-Za-z][A-Za-z0-9_-]{0,15}"`;
const word = 'word = tstr .regexp "[\\\\p{L}\\\\p{Nd}_-]+"';
const wordRaw = String.raw`word = tstr .regexp "[\\p{L}\\p{Nd}_-]+"`;
// Compile word/wordRaw with { unicode: tables } from snug/unicode.
```

Actual CDDL text (the CDDL string parser consumes each doubled backslash):

```cddl
digits = tstr .regexp "[0-9]+"
identifier = tstr .regexp "[A-Za-z][A-Za-z0-9_-]{0,15}"
word = tstr .regexp "[\\p{L}\\p{Nd}_-]+"
```

`digits` accepts `123`, refuses `x123` and the empty string. `identifier`
admits 1..16 ASCII code points with a leading letter. `word` admits Unicode
letters/digits plus `_`/`-` and needs the explicit category tables. Regexps
operate on code points, while text `.size` measures UTF-8 bytes.
The position limit counts consuming automaton positions after bounded
repetition expansion, not JS/CDDL source characters: `[0-9]` or `\p{L}`
is one position; copies from `{n,m}` consume more. Unbounded loops reuse
positions. Complex alternatives/classes also consume compile work/pool
space. Exceeding the limit is `limit_regexp_positions`, never truncation.

## Map determinism and cuts

Maps are **closed** unless an explicit entry covers remaining pairs. Every
pair must be assigned, including under optional groups and choices.
Top-level map `//` choices are separate map candidates. Within one
alternative, literal-key entries have priority, followed by key-typeset
entries in source order. An entry accepts only when both key and value
match and its occurrence capacity remains.

To prove greedy priority assignment equivalent to existential CDDL matching,
overlapping key domains require the lower-priority entry to be **absorbing**
(minimum 0, unbounded maximum). Overlap is conservative; a schema can be
refused even if a more expensive proof could establish disjointness (D011).
For example, `{ a: uint, * tstr => any }` is admitted, whereas overlapping
constrained domains such as `{ 1*2 tstr => uint, 1*2 tstr => uint }` are
refused with `map_overlap`.

`name:` and literal colon keys imply cuts; `^ =>` makes the cut explicit.
A matching cut key whose value fails kills **that alternative**, not all
other alternatives (D021). This permits discriminated choices such as
`{ kind: "a", x: uint // kind: "b", y: tstr }`.
Cuts on key typesets and cut literals after an overlapping wildcard are
refused (`map_cut`), because the priority transformation would otherwise
change the source-order cut meaning. A literal colon key that is a byte
string, a float or an integer beyond 64 bits (`h'00': T`, `1.5: T`) is a cut
on a key that only a key typeset can hold, also refused with `map_cut`
(D125); write `h'00' => T`. (Before P7.1 such a member silently compiled as
never present.)

Optional groups are expanded exactly. Repeated literal-only groups combine
key-disjoint alternatives, including empty ones; duplicate literal keys
make an alternative unsatisfiable and it is dropped. Repeated key-typeset
groups are multiplied only if each entry is absorbing or the repetition
count is fixed. Mixed literal/typeset groups repeated more than once, or
non-interval count combinations such as `{ 0*2 (2*2 tstr => uint) }`, are
refused (`map_group_occurrence`). Independent factors are retained only
when disjointness or a shared absorbing predicate proves exactness;
otherwise expansion must fit the alternatives limit.

## Arrays and repetition

Arrays match Glushkov automata, retaining every matching position. There is
no first-match or greedy occurrence shortcut. Ambiguous repetitions such as
`[? uint, 2*3 uint, tstr]` unroll within the position limit. A bounded
single-entry occurrence can use one counter only when its domain is disjoint
from every other predecessor that could enter it and an enclosing loop
cannot re-enter it without reset (D012/D036). Otherwise it is unrolled and
rechecked until stable, or refused at the position limit. Non-tail group
recursion is `group_recursion`; nonproductive recursion is `nonproductive`.

## Semantic notes

- `uint` is CBOR major type 0 only. `int` is major 0/1. `unsigned` includes
  tag-2 bignums and `integer` includes tag-2/3 bignums. `number` is `int / float`,
  so it does not include decimal fractions or arbitrary bignums.
- `float16`, `float32`, `float64` constrain **encoded width**. Shortest-form
  CBOR encodes 1.5 as float16, so `float32` refuses it. Use `float` when the
  encoded width is not a protocol constraint. Under the deterministic
  preset NaN (only `f97e00`), ±∞, −0 and integral floats are valid floats;
  float ranges compare as IEEE 754 (−0.0 is in `0.0..1.0`, NaN is in no
  range, +∞ is in `float .ge 1.5`), while literals compare encodings (`0.0`
  does not match −0.0). The Bindle profile refuses NaN, ±∞, −0 and integral
  floats within the safe range before the schema sees them.
- Text `.size` is UTF-8 byte length, not code-point or grapheme length.
  Regexps operate on code points; `.chars` is only planned (D082).
- CDDL numeric bounds compare bytes/bit patterns, not rounded JS values;
  integers beyond Number's safe range stay exact. Literal comparisons rely
  on the unique admitted wire encoding.
- The wire profile, not the schema, decides which data reach the schema:
  under the deterministic preset (the default) integer and other non-text
  map keys, the prelude's `tdate`, `time`, `uri`, `encoded-cbor`, `eb64url`,
  `eb64legacy`, `eb16`, `cbor-any` and `undefined` match valid data; tags
  outside the standard set (`bigfloat`, `b64url`, `regexp`, `mime-message`
  …) are refused by the profile whatever the schema says. Under `wire:
  'bindle'` the Bindle restrictions apply. Compiler `profile: 'full'` never
  disables strict CBOR, and a compiled Program validates under either preset
  ([profiles](profiles.md#cddl-and-schemas)).
- Profile errors outrank schema errors, except that budget exhaustion stops
  the walk immediately (D023/D025). Errors never echo a data value or unnamed
  map key. See [errors](api.md#errors).
- A schema-choice refusal is one deterministic witness, not a preferred
  application branch explanation. In `{ ok: true, id: uint } /
  { ok: false, error: tstr .size (1..120) }`, `{ ok: false, id: 7 }` can report
  `value` at `['ok']` (offset 8); the complete message fits neither branch.
  See [validation diagnostics](guide.md#validate-hostile-bytes-without-decoding).

## Refused and planned features

| Construct | Current refusal / reason |
| --- | --- |
| `.pcre`, `.abnf`, `.abnfb` | `unsupported_control`; portable, bounded engines required (D013). |
| Unknown/custom controls, including `.chars`, `.unique`, `.samelen` | `unknown_control`; extension leaf/predicate mechanism and optional generic controls are planned in P7.2 (D082). |
| Regexp `\\p{…}`/`\\P{…}` without tables | `regexp`; load `snug/unicode` and pass `unicode: tables` (D083). |
| Regexp `\d`, `\w`, `\s`, `\x..`, lookarounds, backreferences, host-engine extensions | `regexp`; use the supported I-Regexp grammar. No host regex engine/ReDoS path. |
| Regexp repetition/positions beyond limits | `limit_regexp_positions`; bounded automata, no silent truncation. |
| Unprovable map overlap / unsupported cut placement | `map_overlap` / `map_cut`; exact existential meaning must be provable. |
| Non-exact repeated map groups | `map_group_occurrence`; cannot represent coupled/non-interval counts as independent counters. |
| Non-regular group recursion / recursion without progress | `group_recursion` / `nonproductive`; finite automata/productivity required. |
| Composite `.ne`, nonliteral `.plus`/`.cat`/`.det`, float `.plus` | `control_value` or `unsupported_control`; currently exact supported folds only (D038). |
| JSON validation, generated host types from CDDL | Outside current scope; handwritten API declarations describe the library, not schema output types. |

The compiler restriction sets `bindle` and `bus` refuse additional otherwise
supported CDDL with `profile`; see [profiles](profiles.md). Limits and their
codes are part of support, not optional implementation hints.
