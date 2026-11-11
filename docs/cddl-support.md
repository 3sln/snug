# CDDL support

snug implements a bounded, explicit subset of RFC 8610 with RFC 9165 controls
and RFC 9682 grammar updates. Unsupported or unprovable constructs fail at
compile time; an accepted construct keeps its documented meaning. This is
not a claim of complete RFC coverage. The wire profile decides which CBOR
reaches the schema: the default valid preset (any tag, D180) gives
every prelude name values, while `wire: 'bindle'` makes 14 of them
uninhabited (`undefined`, for example, is parsed from the prelude but its
simple value is refused by the scanner; [conformance §f](conformance.md)).
Since P8.4 the default byte check accepts any valid CBOR (indefinite lengths,
non-shortest heads/floats, keys in any order; duplicates compared by value),
validating non-deterministic input through its canonical copy;
`wire: 'deterministic'` refuses it ([profiles](profiles.md#valid-cbor-p84-d260d268)).

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
| Sockets `$name`, `$$name` and extensions | Supported in `full`; an unplugged `$x` is the empty type choice and an unplugged `$$x` the empty group choice (RFC 8610 §3.9): nothing matches through them, so `{ a: int, $$x }` matches nothing until plugged, while `? $$x` matches by absence (D251). |
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
| `.lt`, `.le`, `.gt`, `.ge` | Intersect numeric intervals; exact any-size integers; floats compare numerically (−0.0 = +0.0, so `float .lt 0.0` excludes both zeros) and NaN satisfies no ordered comparison (D250). |
| `.eq` | Target intersected with controller, not replacement of target; `(tstr .size 1) .eq "aa"` is empty. Composite controllers lower to AND (D038). |
| `.ne` | Numeric exclusion splits intervals: `float .ne 0.0` excludes both zeros and `float .ne 1.5` keeps NaN (NaN equals no number, D250); other targets exclude a literal while retaining target constraints. Composite nonliteral controllers refused. |
| `.and`, `.within` | Intersections, with operands evaluated as same-item dependencies; they do not create extra accepting alternatives. |
| `.regexp` | Whole-string XSD Appendix F by default; `regexp: 'iregexp'` selects strict RFC 9485. Both compile to the same bounded code-point automata; details below. |
| `.cbor T` | Byte content must be exactly one current-profile CBOR item matching T. |
| `.cborseq [G]` | Byte content is a sequence matching the controller's array group, including positions/occurrences. Controller must be array types only (D040). |
| `.default`, `.feature` | Accepted annotations, no effect on matching (D013, D038). |
| `.cat`, `.det` | Compile-time concatenation of two text or byte string literals, of either kind; the result has the target's type and, as text, must be valid UTF-8 (RFC 9165 §2.2, D330); `.det` dedents each literal first. |
| `.plus` | Compile-time addition of two integer literals, any size; float operands refused (D038). |
| registered `.name` | An **extension control** (D082, D140–D142): `target .name argument` with `.name` registered at compile time; the target AND a host predicate over the item's encoding. The argument must be a literal: integer, text, bytes, a named simple value (`true`), a range `lo..hi` (passed as `[lo, hi]`) or an array of those. Generic ones ship in `snug/controls` / `snug::controls`: `.chars`, `.unique`, `.samelen`. Refused under the `bus` profile unless `controlsInBus`. See the guide's "Custom controls". |

The numeric controls compare values exactly across integers and floats
(D329): an integer target with a float controller takes the nearest integer
inside the half-line (|x| ≥ 2⁶⁴ admits every integer or none); a float target
with an integer controller takes the controller's binary64 value, or, when no
binary64 holds it, the nearest binary64 inside the half-line. So `number .ge
0`, `float .lt 1` and `int .eq 1.0` compile; `.eq` across the kinds matches
only an exactly equal value.
Decimal schema float literals have
at most 17 significant digits, must be finite, and a nonzero value may not
round to zero. Hex floats are rounded by kin (D020/D032). Unsupported
control targets/controllers are errors rather than ignored controls.

An unregistered `.name` is the schema error `unknown_control`, and the message
names the control. Literal membership in an extension control is unknown at
compile time, so `.eq`/`.ne`/`.and` never fold through one (they keep the AND /
NOT), and map determinism treats it as possibly matching any key (stricter,
never looser).

Embedded checks are local predicates: `bstr .cbor uint / bstr .size (0..16)`
can accept bytes that fail the embedded branch. An embedded failure is
reported as `embedded` with its subcode only when it makes the outer rule
fail. Embedded item accounting restarts; budget is shared. Physical scratch
depth still bounds embedding. A schema querying both `.cbor` and `.cborseq`
on the same bytes can cause separate inner walks; the work budget bounds it
(D040). The one-pass claim does not promise one visit across independent
embedded interpretations.

## Unicode regexp categories

`.regexp` matches the whole text in either dialect (D242–D243). Opt in to Unicode
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
preset admits them, and they match their categories (Cn). Category aliases,
scripts, `gc=…` spellings in CDDL and host-engine extensions are refused.
XSD block escapes `\p{IsBasicLatin}` / `\P{Is…}` are also refused with a
message explaining unavailable pinned Unicode block data: the pinned Node
ICU API exposes no Block property, and the repository has no authoritative
block-name/range input. Category tables do not supply blocks (D243).

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

`compile(text, { regexp: 'xsd' | 'iregexp' })` selects the dialect; **`xsd`
is the default**, following RFC 8610 §3.8.3's reference to XSD 1.0 Part 2
Appendix F. The corrected XSD 1.0 class grammar is used, with XML 1.0 fifth
edition name classes and Unicode 16.0 categories; this does not implement
XSD 1.1's relaxed escape/block-name rules. `iregexp` keeps the previous
strict RFC 9485 admissions and refusals. Patterns valid in both have the
same meaning: dot excludes CR/LF, `^` and `$` are ordinary characters,
category escapes are case sensitive, and matching covers the whole text.
There are no JS flags or slash delimiters. Use `.*` explicitly for surrounding
text. Neither dialect supports backreferences, lookaround or `\x..` escapes.

| Construct | XSD | I-Regexp | Tables needed |
| --- | --- | --- | --- |
| Literals, ranges/classes, negation, grouping, alternation, dot | Yes | Yes | No |
| `?`, `*`, `+`, `{n}`, `{n,m}`, `{n,}` | Bounded expansion | Same | No |
| `[a-z-[aeiou]]`, nested subtraction | Range-set difference; negate base before subtraction | Refused | Only if operands use categories |
| `\s` / `\S` | TAB, LF, CR, SPACE / complement | Refused | No |
| `\i` / `\I` | XML NameStartChar / complement | Refused | No |
| `\c` / `\C` | XML NameChar / complement | Refused | No |
| `\d` / `\D` | Nd / complement | Refused | `snug/unicode` |
| `\w` / `\W` | Complement of P/Z/C / P/Z/C | Refused | `snug/unicode` |
| `\p{L}` / `\P{L}` and other categories | Yes | Yes | `snug/unicode` |
| `\p{IsBlock}` / `\P{IsBlock}` | Explicit data-unavailable error | Refused | Pinned block data unavailable |

XSD `\w` includes letters, marks, numbers and symbols (including emoji),
but excludes underscore (`Pc`), punctuation, separators and other/control
characters. It is different from JavaScript's `\w`. For ASCII protocols use
explicit `[0-9]` or `[A-Za-z0-9_]` classes. XML names include colon; for a
colon-free name, subtract it, e.g. `[\i-[:]][\c-[:]]*`. A hyphen in a
class is literal at the beginning/end or when escaped; subtraction must be
last in the class. It can produce an empty class, which matches no code point.

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
XSD compares decimal quantifier bounds before saturating expansion counts,
including bounds on empty expressions. I-Regexp retains its historical
saturation behaviour for extreme bounds on zero-position expressions
([P8.3 finding](../DEVLOG.md#findings)); ordinary bounded patterns are unchanged.

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

*Format 2.0 (PEG groups; D270, D294, D301; the VM since P8.5 phase 2, D310), 2026-11-10:*
the cut follows RFC 8610 §3.5.4 literally by default (`cuts: 'rfc'`). Once
a cut member finds its key, that pick is locked in: if the value fails,
"the entire map fails to match", whatever `//` alternatives or later
entries remain; a cut that succeeds inside an alternative or an optional
group that later fails also fails the map (commitment epochs, architecture
§20.2). Its scope is the map type, so a type choice of maps is outside it.
Consequently the discriminated-union idiom
`{ kind: "a", x: uint // kind: "b", y: tstr }` rejects `{kind: "b", y: "z"}`;
write `{ kind: "a", x: uint } / { kind: "b", y: tstr }` or
`{ "kind" => "a", x: uint // "kind" => "b", y: tstr }` (see the
[guide](guide.md#discriminated-unions-under-the-rfc-cut); compile warning W8
flags the idiom). The previous behaviour, where a failed cut kills only its
own alternative (D021, rule A, the reference tools' reading), is the
non-default option `cuts: 'branch'`. Cuts on key typesets (`tstr ^=> uint`)
and byte-string, float and beyond-64-bit colon keys (`h'00': T`) are
supported in format 2.0 (D294); `map_cut` is withdrawn.

*Format 1 (before P8.5; retired):* a matching cut key whose value fails kills **that
alternative**, not all other alternatives (D021), so the idiom above
works there. Cuts on key typesets and cut literals after an overlapping
wildcard are refused (`map_cut`), because the priority transformation
would otherwise change the source-order cut meaning. A literal colon key
that is a byte string, a float or an integer beyond 64 bits (`h'00': T`,
`1.5: T`) is a cut on a key that only a key typeset can hold, also refused
with `map_cut` (D125); write `h'00' => T`. (Before P7.1 such a member
silently compiled as never present.)

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
- **`float16`, `float32`, `float64` are sets of values (changed 2026-11-11,
  D328).** As RFC 8610 §3.3 says, "#7.25 specifies the set of values that
  can be represented as half-precision floats; it does not mandate that these
  values also do have to be serialized as half-precision floats". So a float
  matches `float16` when binary16 represents its value exactly, and `float32`
  when binary32 does, whatever width encodes it. `float64` admits every
  float. NaN, ±∞ and ±0 are in every width. 1.5 encoded as float16 (the
  shortest form) now matches `float32`, and 1.5 encoded as float64 matches
  `float16`; 1 + 2⁻²³ matches `float32` but not `float16`. Before D328 these
  names constrained the encoded width, so `float32` refused a shortest-form
  1.5. (The Ruby cddl gem reads them as "needs at least this width"; the cddl
  crate ignores the width.) Under the deterministic
  preset NaN (only `f97e00`), ±∞, −0 and integral floats are valid floats.
  Float literals, ranges and controls compare numerically, as RFC 8610
  §3.8.6 asks (D250): −0.0 and +0.0 are one number (`0.0` and `-0.0` each
  match both zeros; −0.0 is in `0.0..1.0`; `-1.0...0.0` excludes both), NaN
  is in no range and fails `.lt .le .gt .ge .eq` but passes `.ne` of any
  number, and +∞ is in `float .ge 1.5`. An integer literal and a float
  literal stay distinct CBOR kinds (`1` does not match `1.0`), but the
  numeric controls compare values across the kinds exactly (D329): `number
  .ge 0` admits `0`, `0.0` and `-0.0`; `int .gt 0.5` admits `1`; `float .ge
  9007199254740993` (2⁵³ + 1, which no binary64 holds) admits 2⁵³ + 2 and
  refuses 2⁵³; `int .eq 1.0` admits `1`. `.cat` and `.det` join a text and a
  byte string, the result taking the target's type (RFC 9165 §2.2, D330). The Bindle
  profile refuses NaN, ±∞, −0 and integral floats within the safe range
  before the schema sees them.
- Text `.size` is UTF-8 byte length, not code-point or grapheme length.
  Regexps operate on code points; for a code-point length use the `.chars`
  extension control from `snug/controls` (D082, D140–D142).
- CDDL numeric bounds are exact (integers compare as integers of any size,
  floats by their binary64 value), never rounded JS values. Non-float
  literal comparisons rely on the unique admitted wire encoding.
- The wire profile, not the schema, decides which data reach the schema:
  under the deterministic preset (the default, `tags: 'any'`, D180) integer
  and other non-text map keys, every prelude name and every tag number
  except the invalid 65535, 2³²−1 and 2⁶⁴−1 (RFC 8949 §9.2) match valid
  data. `tags: 'standard'` restores the former set, under which `bigfloat`,
  `b64url`, `b64legacy`, `regexp` and `mime-message` have no values. Under
  `wire: 'bindle'` the Bindle restrictions apply. Compiler `profile: 'full'`
  never disables strict CBOR, and a compiled Program validates under either
  preset ([profiles](profiles.md#cddl-and-schemas)).
- **Validated versus opaque tags.** The profile checks the content of the
  tags it knows, whatever the schema says (D252): tag 0 must be an RFC 3339
  `date-time` refined by RFC 4287 §3.3 (upper-case `T`/`Z`; second 60 only
  as 23:59:60 UTC on the last day of a month); tag 1 an integer or any float
  (non-finite floats are discouraged by RFC 8949 §3.4.2, not invalid); tag
  24 one valid item; tag 32 an RFC 3986 `URI-reference` (scheme, authority
  with IPv6/IPvFuture literals, path, query, fragment; no RFC 6874 zone
  identifiers); tags 2/3 (minimal bignums), 4 (normalised decimals, a local
  rule), 40 and the RFC 8746 typed arrays (whole elements); 55799 only at
  the top. Every other tag, including 5 (bigfloat), 21–23, 33–36, 1040
  (column-major arrays) and unassigned numbers, is **opaque**: its content
  is any valid item and a match proves nothing about its registered
  meaning. A schema (`bigfloat`, `#6.1040([...])`) can still constrain it.
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
| Unregistered controls | `unknown_control`, naming the control; register it as an extension control at compile time (D082, D140–D143), e.g. `.chars`, `.unique`, `.samelen` from `snug/controls`. |
| Regexp `\\p{…}`/`\\P{…}` without tables | `regexp`; load `snug/unicode` and pass `unicode: tables` (D083). |
| Regexp XSD shorthands/subtraction in `iregexp` mode; `\x..`, lookarounds, backreferences in either mode | `regexp`; no host regex engine/ReDoS path. |
| Regexp XSD `\p{IsBlock}` / `\P{IsBlock}` | `regexp`; pinned block data is unavailable (D243), even with category tables. |
| Regexp repetition/positions beyond limits | `limit_regexp_positions`; bounded automata, no silent truncation. |
| Unprovable map overlap / unsupported cut placement | `map_overlap` / `map_cut`; exact existential meaning must be provable. |
| Non-exact repeated map groups | `map_group_occurrence`; cannot represent coupled/non-interval counts as independent counters. |
| Non-regular group recursion / recursion without progress | `group_recursion` / `nonproductive`; finite automata/productivity required. |
| Composite `.ne`, nonliteral `.plus`/`.cat`/`.det`, float `.plus` | `control_value` or `unsupported_control`; currently exact supported folds only (D038). |
| JSON validation, generated host types from CDDL | Outside current scope; handwritten API declarations describe the library, not schema output types. |

The compiler restriction sets `bindle` and `bus` refuse additional otherwise
supported CDDL with `profile`; see [profiles](profiles.md). Limits and their
codes are part of support, not optional implementation hints.
