# JavaScript API

This reference describes the package facades and is maintained with the
[declaration files](../host/js/types/) (one per entry point). `npm test` checks declarations
with Node's TypeScript parser, checks exported names against runtime exports,
and uses offline TypeScript for semantic checks if it exists in the permitted
neighbouring checkout. The original package gate had no offline TypeScript;
the [onboarding example](guide.md#typescript-onboarding) was separately
checked with offline TypeScript 5.8.3 on 2026-11-03. Declarations changed
since then (the `valid` preset, format 2.0 compile options) have been checked
against the runtime by `npm test` and by review, not by a semantic TypeScript
run. No installs are
required. Internal `src/schema.mjs`/`src/compile.mjs` are host interfaces;
their signatures and error classes are not the package contract.

## Option admission

Every public options bag uses the same host validator. Supply an ordinary
object (or one with a null prototype); arrays, null, primitives and class
instances are TypeErrors. Omitted bags and known fields set to `undefined`
use defaults. Unknown own keys, including non-enumerable and symbol keys,
throw TypeError. Invalid known values name the option; unknown-key errors
list allowed names without echoing the supplied key or value. No option
value is coerced. Limits, budgets, span depth/items and delay must be finite,
non-negative **safe integers**; chunk must be positive; quantum must be in
0..2^31−1. Boolean fields require booleans and enums require exact strings.

These checks run before CBOR checking, value walking or source reads.
Schema validation never turns malformed configuration into a data refusal;
valid limits that exhaust resources still produce the documented result or
SnugFault. Async entry points reject their Promise with TypeError.

The following named sets are the complete option-key lists used below:

| Set | Allowed keys |
| --- | --- |
| Preset fields | `wire`, `keys`, `tags`, `floats`, `undefinedValue`, `noncharacters`, `top`, `cose`, `strictArrays` |
| Limits | `maxBytes`, `maxDepth`, `maxEntries`, `maxItems` |
| DecodeOptions | Preset fields + Limits + `objects` |
| EncodeOptions | Preset fields + Limits + `objects`, `omitUndefined` |
| ValidationOptions | DecodeOptions + `maxBignumBytes`, `budget` |
| SpanOptions | ValidationOptions + `depth`, `items` |

| Entry point | Options bag | Additional bag |
| --- | --- | --- |
| `decode` | DecodeOptions | none |
| `encode` | EncodeOptions | none |
| `new Writer` | EncodeOptions + `keysSorted`, `limits` | nested `limits`: Limits only |
| `compile` | `profile`, `regexp`, `cuts`, `groupWords`, `limits`, `unicode`, `controls`, `controlsInBus` | nested `limits`: [CompileLimits](#compilation) only |
| `Schema.validate`, schema-first `validate` | ValidationOptions | none |
| `Schema.decode`, schema-first `decode` | ValidationOptions | none |
| `Schema.validateAt`, schema-first `validateAt` | SpanOptions | none |
| `openSession` (`snug/sources`) | ValidationOptions | scheduling: `quantum` |
| `view` | ValidationOptions + `schema`, `rule`, `borrow`, `directories` | none |
| `View.validateAt` | `schema` | none |
| `scanBuffer` | DecodeOptions | none |
| `scanHandle`, `scanHandleSync` | DecodeOptions | sourceOptions: `chunk`, `quantum` |
| `new ScanSession`, `pushScanner` | DecodeOptions | scheduling: `quantum` |
| `validateHandle`, `validateHandleSync` | ValidationOptions | sourceOptions: `chunk`, `quantum` |
| `pushValidator` | ValidationOptions | scheduling: `quantum` |
| `asyncHandle` | `delay` | none |
| `bufferHandle` | no options argument | none |

All runtime operations accept complete `profiles` objects: `strictArrays`
is checked but ignored while reading, and `top` is checked but ignored while
writing. `objects` is checked but has no effect on writing or validation-only
calls; encode accepts it so a codec round trip can reuse decode options.
Without a schema, views check `budget`/`maxBignumBytes` option types but use
only scanner limits. Compile has a separate vocabulary: `profile` selects
CDDL restrictions; `wire` selects a runtime wire preset. For example,
`maxByets` at any runtime boundary, top-level `compile({ maxBytes })`, and
unknown keys inside either grouped limits object are rejected.

## Codec: `snug`

```ts
decode(bytes: Uint8Array, options?: DecodeOptions): Value
encode(value: unknown, options?: EncodeOptions): Uint8Array
```

`Value` is the decoded union: null, undefined, boolean, number, bigint,
string, Uint8Array, admitted native typed arrays, Decimal, Float16Bytes,
NDArray, Tagged, Simple (an unassigned simple value, D284), arrays, string-keyed objects (maps with only text keys), or
`Map` (maps with any other key, and a top-level map with `cose`).
The recursive union cannot express every root-only admission restriction;
see the [host compatibility and integer tables](guide.md#decode-after-checking).
CDDL validation does not infer a narrower TS type.

| Option | Default | Meaning |
| --- | --- | --- |
| `wire: 'valid' \| 'deterministic' \| 'bindle'` | `'valid'` | The wire preset ([profiles](profiles.md#options)): any valid CBOR (RFC 8949 §5.3), RFC 8949 §4.2.1 deterministic CBOR, or the Bindle profile; the five options below override it |
| `keys: 'text' \| 'integer' \| 'any'` | preset (`'any'`; bindle `'text'`) | Map key kinds |
| `tags: 'bindle' \| 'standard' \| 'any'` | preset (`'any'`) | Tag level: the Bindle set, the standard set, or any tag number with the known tags' content rules (D180) |
| `floats: 'bindle' \| 'deterministic'` | preset (`'deterministic'`) | Scalar float rules |
| `undefinedValue: boolean` | preset (true) | `f7` and the unassigned simple values (`Simple`, D284) |
| `noncharacters: boolean` | preset (true) | Unicode noncharacters in text |
| `top: 'map' \| 'any'` | codec/view/source: the preset's (`'any'`; bindle `'map'`); schema: `'any'` | Decode/check root policy |
| `cose: boolean` | false | Under `keys: 'text'`: safe integer labels as well as text, top-level map only |
| `objects: 'null' \| 'plain'` | `'null'` | Decode ordinary maps into null/ordinary-prototype objects |
| `maxBytes` | decode: `LIMITS.maxBytes`; encode: unset | Input byte cap; encode/Writer check only when supplied, at finish: output acceptance, not peak allocation |
| `maxDepth`, `maxEntries`, `maxItems` | `LIMITS` | Nesting, per-container entries and total item bounds; see operational accounting in the guide |
| `omitUndefined: boolean` | false | Encode object-member omission; see guide |
| `strictArrays: boolean` | preset (false; bindle true) | Encode: refuse extra array own properties with `unsupported` |

The complete allowed lists are in [option admission](#option-admission).
Unknown keys and malformed values throw TypeError. `encode`
does not enforce a map root. Its `maxBytes` check happens only when supplied,
at finish, after allocation. Invalid CBOR/profile or inadmissible host values
throw `SnugFault`; argument misuse can throw `TypeError`.
Encode accepts any supported root and writes deterministic bytes under every
preset; codec decode accepts any root under the valid and deterministic
presets and requires a map under `wire: 'bindle'` unless
`top: 'any'` is given.

Arrays encode elements 0..length−1, ignoring extra named own properties
(including hidden and symbol properties) by default. `strictArrays: true`
retains the old own-key count check. Both modes refuse holes with
`unsupported`; a present undefined element encodes as `f7` when the profile
admits `undefinedValue` (the valid and deterministic presets) and is refused with
`unsupported` otherwise, regardless of `omitUndefined`.
Only when an element reads as undefined is absence checked (`!(i in array)`).
Arrays must pass Array.isArray and have exactly the local Array.prototype;
subclassed, foreign-realm and null-prototype arrays remain refused.

| Export | Members and contract |
| --- | --- |
| `Decimal` | `new Decimal(mantissa: bigint, exponent: number)` requires normalised nonzero mantissa not divisible by 10, exponent −1024..−1. Immutable value. |
| `Decimal.from(text: string)` | Returns Decimal, number or bigint; plain decimal notation, exact normalisation. `'1.50'` → Decimal 1.5, `'2.00'` → number 2, `'0.00'` → number 0. Use Writer.value for factory output. |
| `Decimal.normalize(mantissa: bigint, exponent: number)` | Returns Decimal or integral number/bigint. |
| `Decimal#toString()` | Exact decimal string; `valueOf`/numeric coercion/`toJSON` throw. |
| `Float16Bytes` | `new Float16Bytes(bytes: Uint8Array)`; `bytes`, `length`. Copies an even-length little-endian payload; NaN is checked when encoded. Byte storage is mutable by contract. |
| `NDArray` | `new NDArray(shape: number[], data: Value[] \| TypedArray \| Float16Bytes)`; readonly `shape`, `data`. Positive dimensions (1..8); product equals element count. Data is retained, not deeply frozen. |
| `SnugFault` | Error class; `code: string`; constructor `(code?: string, message?: string)`. Schema decode/view may also carry `reason`, `path`, `offset`, `subcode`. |
| `LIMITS` | Frozen defaults: maxBytes 1,500,000; maxDepth 32; maxEntries 65,536; maxItems 131,072; maxBignumBytes 128; minDecimalExponent −1024; maxDimensions 8. |
| `profiles` | Frozen `{ valid, deterministic, bindle }`: each a frozen option object spelling out its preset (`wire`, `keys`, `tags`, `floats`, `undefinedValue`, `noncharacters`, `top`, `cose`, `strictArrays`). Spread one into runtime options to select it and override fields. |
| `Tagged` | `new Tagged(tag: number \| bigint, value: Value)`; frozen, `tag` (0..2⁶⁴−1: a number up to 2⁵³−1, a bigint beyond) and `value`. Every tag but 2, 3, 4, 40 and the little-endian typed arrays decodes to it (tag 24's `value` is the payload bytes); encode checks the tag number and content with kin under the profile's tag level and refuses with `tag` (the invalid 65535, 2³²−1, 2⁶⁴−1 always; 2/3/4/40/typed arrays have their own value types). |

Native typed arrays: Int8, Uint16/32, BigUint64, Int16/32, BigInt64,
Float16 where available, Float32/64. `Uint8Array` is a byte string.
The declarations spell native Float16 structurally (`Float16ArrayLike`) to
avoid requiring newer TypeScript libraries; runtime admission still requires
the actual native type. Do not substitute an arbitrary structural lookalike.
Decimal is an exact numeric value, not fixed-scale money: normalisation
discards scale and integral results encode as integers. Use integer minor
units with explicit currency/scale, or a protocol-defined string, when scale
must be retained.

## Compilation

From `snug/compile`:

```ts
compile(text: string | Uint8Array, options?: CompileOptions): Promise<Schema>
```

Importing this entry point does not load the generated compiler; calling it
does. After loading, the compile is synchronous. `CompileOptions` is:

```ts
interface CompileOptions {
  profile?: 'full' | 'bindle' | 'bus';   // compiler restriction set; default 'full'
  regexp?: 'xsd' | 'iregexp';            // .regexp dialect; default 'xsd'
  cuts?: 'rfc' | 'branch';               // map cut semantics; default 'rfc'
  groupWords?: number;                   // PEG group arena cap in words; default 4,194,304, at most 2^24
  limits?: CompileLimits;
  unicode?: Int32Array;                  // tables from snug/unicode
  controls?: Controls;                   // extension controls (snug/controls, snug/abnf)
  controlsInBus?: boolean;               // admit extension controls under 'bus'
}
```

`profile` defaults to `full` and restricts accepted CDDL, not wire policy.
Schema refusals reject with `SchemaError`; invalid API options with TypeError.
`cuts` defaults to `'rfc'`, the literal RFC 8610 cut
(D301); `'branch'` is rule A, where a failed cut fails only its `//` branch
(see [Discriminated unions under the RFC cut](guide.md#discriminated-unions-under-the-rfc-cut)).
Any other value, including the pre-release name `'reference'`, is a TypeError.
The effective cut mode is part of the source key.
`abnf?: 'strict' | 'lenient'` (D340) is how `.abnf`/`.abnfb` controllers
parse: `'strict'` (the default) is RFC 5234 + RFC 7405 + RFC 9165 §3;
`'lenient'` also admits snug's non-RFC forms ([ABNF](#abnf-snugabnf)). Any
other value is a TypeError. It is part of the source key.

`CompileLimits` names:

| Compile resources | Compiled runtime resources |
| --- | --- |
| `schemaBytes`, `nesting`, `astNodes`, `instantiations`, `pegNodes`, `arrayPositions`, `regexpPositions`, `width`, `poolBytes`, `totalBytes`, `compileBudget`, `leaves` | `depth`, `inputBytes`, `entries`, `items`, `bignumBytes`, `budget` |

All are non-negative safe integers; defaults and ceilings are in the
[guide](guide.md#limits). kin applies effective defaults and ceilings before
computing the source key. `controls` registers extension controls
(D082/D140–D142, [Custom controls](guide.md#custom-controls), `snug/controls`
below): a name → `Control` object (malformed names or entries are TypeErrors;
built-in control names are refused). The whole registry is part of the source
key; `controlsInBus` admits controls under `bus`. Unicode tables are an
explicit option described below (D083/D110).

Omitted limits use defaults, zero means zero (not unlimited), valid requests
above compiler ceilings clamp, and per-call runtime limits can only lower
compiled caps. `bignumBytes` is currently fixed to 128 at compilation.
There is no public effective-limits object. See the [operational limits
reference](guide.md#limits), including root/item accounting. Malformed or
unknown options reject with TypeError before compilation.

`SchemaError` extends Error: constructor
`(code, line = 0, column = 0, rule?)`, fields `code`, `line`, `column`,
`rule`. The compiler supplies positions in code points and safe schema
metadata. The public error message uses the code and position.

## Extension controls: `snug/controls`

```ts
type Control = ((argument: Uint8Array, item: Uint8Array) => boolean) |
  { check(argument: Uint8Array, item: Uint8Array): boolean; maxBytes?: number;
    argument?(argument: Uint8Array): boolean | string; cost?(itemBytes: number): number };
type Controls = Record<string, Control>;
export const chars: Control, unique: Control, samelen: Control;
export const controls: { chars, unique, samelen };
```

`.chars n | lo..hi` (code points of a text string), `.unique <any>` (pairwise
distinct element encodings of an array), `.samelen "a" | [names]` (equal
element counts of the named array/typed-array members of a map). Their
verdicts are kin's (`snug.vm.controls`), identical on every host. A predicate
must be pure; it is asked only for a queried, whole, profile-checked item;
an item longer than `maxBytes` (default 65,536, at most 2³¹−1) fails with
`control_size` unasked (1 unit). Otherwise the call costs 17 units, then the
predicate's `cost(itemBytes)` (a non-negative safe integer; default
`itemBytes`), charged **before** it runs: a cost above the budget left stops
validation with `budget` without calling. A predicate's own CPU is the host's
responsibility; `cost` is how it stays inside the budget (~20 ns per unit by
default). The generic controls meter their work in kin (program.md §14), with
arguments prepared once per Program, so they cost the same on every host. A throwing
predicate makes the validation call throw (`cause` set). New reasons:
`control` (the predicate refused) and `control_size`. Programs using a control
are ordinary format 2.0 Programs but need the registry to load
(`fromSerialized(bytes, { controls })`, `fromProgram(P, B, { controls })`,
`new Program(P, B, { controls })`); a missing name is
`ProgramError('missing_control')` naming it; `program.controls` lists the
names used. Name rule: `[A-Za-z_][A-Za-z0-9_-]*`, at most 64 bytes, not a
built-in control. `argument(bytes)` is asked once per use at compile time:
anything but `true` refuses the schema (`control_value`), and a string answer
is the refusal's detail in the message.

## ABNF: `snug/abnf`

```ts
export const abnf: Readonly<{ abnf: Control; abnfb: Control }>;
export function abnfWith(o?: { maxBytes?: number; maxWords?: number }): typeof abnf;
export function checkAbnf(text: string | Uint8Array, options?: { abnf?: 'strict' | 'lenient' }): true | string;
```

RFC 9165 §3's `.abnf` (Unicode scalars) and `.abnfb` (bytes), an optional
module (D334): spread it into the registry of `compile` and of the loaders.

```js
compile(text, { controls: { ...abnf } })        // with others: { ...controls, ...abnf }
fromSerialized(bytes, { controls: { ...abnf } })
```

They are the only entries that may use these two built-in names. Without the
module, `.abnf`/`.abnfb` are `unsupported_control`, and the message names
`snug/abnf`. A stored Program that uses them fails to load with
`ProgramError('missing_control')`.

The controller is checked at compile time. Prose-val, syntax errors and
undefined rules are `control_value`, with a detail like `(.abnf argument:
prose-val (<...>) is not supported at ABNF line 2, column 11)`. Parsing is
strict RFC 5234 + RFC 7405 + RFC 9165 §3 by default (D340). The compile
option `abnf: 'lenient'` (`compile(text, { controls: { ...abnf }, abnf:
'lenient' })`; any other value is a `TypeError`) also admits snug's non-RFC
forms: a wider start, a rule-first controller, and the others listed in CDDL
support. Under the default each is `control_value`, and the detail names the
option. The option is in the Program's source key. The
controller is prepared once per Program. The match is metered in kin against
the budget left, so every host charges the same units. Past the budget, or
past the matcher's scratch cap, validation stops with `budget`.
`abnfWith({ maxBytes, maxWords })` gives both controls other bounds:
`maxBytes` is the item bound (default 65,536); `maxWords` is the scratch cap
in words (default 4,194,304 = 16 MiB, the PEG group arena's default, D281;
65,536 to 16,777,216, otherwise `TypeError`).

`checkAbnf(text, { abnf })` answers `true`, or the reason the compiler would
refuse under that parse mode (strict by default).
Semantics, leniencies and costs:
[CDDL support](cddl-support.md#abnf-abnf-abnfb).

## Unicode tables: `snug/unicode`

Exports `tables: Int32Array`, `categories: readonly string[]`,
`unicodeVersion: string` and `nodeVersion: string`. Tables are pinned to
Unicode 16.0 (Node v24.6.0 / ICU 77.1); treat them as immutable.
Pass `compile(text, { unicode: tables })` to enable RFC 9485
General_Category `\\p{…}` / `\\P{…}` escapes. Without tables those escapes
reject with SchemaError `regexp` naming `snug/unicode`. Categories are
case-sensitive; scripts, blocks and aliases are refused.
Table contents bind sourceKey. Neither validation nor Program loading needs
the module: Programs contain the compiled automata, with unchanged format.
See [category reference](cddl-support.md#unicode-regexp-categories) and the
[escaping cookbook](cddl-support.md#regexp-cookbook).

## Schemas and Programs: `snug/schema`

```ts
type ValidationResult = { ok: true } | {
  ok: false;
  reason: Reason;
  path: (string | number)[];
  offset: number;
  subcode?: Reason;
};
```

`ValidationOptions` extends DecodeOptions with `maxBignumBytes` and `budget`.
Per-call schema limits only lower compiled limits. SpanOptions adds
`depth?: number` and `items?: number`, both defaulting to 0.
A failure is one deterministic witness, not a full
error list or necessarily the application's intended branch explanation.
For `{ ok: true, id: uint } / { ok: false, error: tstr .size (1..120) }`,
`{ ok: false, id: 7 }` reports `value` at `['ok']`, offset 8, even though
false is valid in the second branch. The message as a whole fits neither.
The offset is where the witness was decided, which is not always the item
the path names: a failure decided at the map level (a cut that locked in, a
`missing` member) reports the map's own offset, so the same data can report
offset 0 under one spelling of a schema and the member's offset under
another. Use the path to explain, and the offset only to locate.

| API | Result / behaviour |
| --- | --- |
| `new Program(P: Int32Array, B: Uint8Array, { controls? }?)` | Copies and structurally verifies; throws ProgramError on refusal (`missing_control` when a control the Program uses is not in `controls`). Trusted origin is still required. |
| `program.P`, `program.B` | Fresh copies of verified words/pool; mutations do not affect the Program. |
| `program.sourceKey` | Lowercase 64-character SHA-256 hex cache key. |
| `program.rules` | Frozen array of sorted validatable rule names. |
| `program.controls` | Frozen array of the extension controls the Program uses (empty when it uses none). |
| `program.serialize(): Uint8Array` | Deterministic §13.3 container, synchronously hashed. |
| `new Schema(program: Program)` | Schema over a public verified Program. |
| `schema.program` | The immutable public Program. |
| `schema.validate(bytes, rule, options?)` | ValidationResult; default top any. |
| `schema.decode(bytes, rule, options?)` | Value, or SnugFault with the same witness; no values built before success. |
| `schema.validateAt(bytes, start, end, rule, options?)` | Detached ValidationResult over [start,end); absolute offsets; default top any. |
| `fromProgram(P, B, { controls? }?): Promise<Schema>` | Copies and verifies, without loading the compiler. |
| `fromSerialized(bytes: Uint8Array, { controls? }?): Promise<Schema>` | Checks container integrity/compatibility (format 2.0; 1.x is refused as `format_version`) and verifies; without the compiler. A Program using extension controls needs the registry it was compiled with. |

The entry also exports schema-first helpers:

```ts
validate(schema: Schema, bytes: Uint8Array, rule: string, options?: ValidationOptions): ValidationResult
decode(schema: Schema, bytes: Uint8Array, rule: string, options?: ValidationOptions): Value
validateAt(schema: Schema, bytes: Uint8Array, start: number, end: number,
           rule: string, options?: SpanOptions): ValidationResult
```

`ProgramError` extends Error with `code`; constructor `(code)`.
Load compatibility is equal format major and minor ≤ loader minor (D084),
currently 2.0 (D279, D318); every format 1.x Program is refused with `format_version`, so recompile it from CDDL. Container version is 1. Producer snug version is informational,
retained on reserialisation. The four-byte format word stores major in low
16 bits, minor in high 16 bits. P and B must remain semantically trustworthy;
SHA-256 is a corruption check, not authentication. See [caching](guide.md#programs-caching-and-compatibility).
`fromProgram`/`fromSerialized` have Promise-shaped facades; verification runs
synchronously, with no scheduling, background execution or cancellation
guarantee. `new Program` verifies and throws synchronously. Compile trusted
schemas ahead of time and load once at startup; isolate hostile compilation
in a worker/process. See the [worked isolation recipe](guide.md#programs-caching-and-compatibility).

## Views: `snug/view`

`view(bytes: Uint8Array, options?: ViewOptions): View` checks before opening.
ViewOptions extends ValidationOptions with `schema?`, `rule?`, `borrow?`
(false), `directories?` (false, experimental). A schema requires its rule.
The default owned view copies before checking; borrowed bytes and every alias
must remain unchanged. `View` is obtained through `view`, not constructed
directly; `new Cursor(view)` is also available.
Mutation of borrowed input or any alias invalidates the check; snug does not
detect it. Owned copying protects against the original input only.

| View member | Signature / meaning |
| --- | --- |
| `kind` | int, float, bytes, text, bool, null, undefined, simple, array, map, decimal, ndarray, typed, tagged |
| `tag`, `content()` | A tagged item's tag number (else undefined); a View of its content |
| `isUndefined()` | boolean |
| `simple()` | a simple value's number (kind `simple`: 0–19 or 32–255), else TypeError; `value()` gives the interned `Simple` |
| `length` | number or undefined; entries/bytes/elements according to kind |
| `offset`, `depth`, `borrowed` | Absolute item position, physical depth, ownership flag |
| `get(key: unknown)` | View or undefined; map only. Strings; integers (number or bigint) when the profile admits integer keys or in a top-level cose map; any value under `keys: 'any'`, compared by its deterministic encoding (a view of non-deterministic input reads its canonical copy) |
| `at(index: number)` | View or undefined; array only; negative/out-of-range integer → undefined, fractional → TypeError |
| `entries()` | IterableIterator of `[key or index, View]` |
| `keys()`, `values()` | IterableIterator of keys/indexes or Views |
| `number()` | number; unsafe integers throw RangeError |
| `bigint()`, `int()` | Exact bigint; or number when safe else bigint |
| `text()`, `bool()`, `isNull()` | string, boolean, boolean |
| `bytes()`, `raw()` | Uint8Array alias of content/encoded span; mutation invalidates the check without detection, even on owned views |
| `copyBytes()` | Copied byte content |
| `typedView()` | Readonly `{ tag, length, get(index): number \| bigint }`, no payload copy |
| `typed()` | Copied native typed array or Float16Bytes |
| `decimal()`, `ndarray()`, `value()` | Materialised Decimal, NDArray, or Value |
| `cursor()` | Cursor at this item |
| `validateAt(rule, { schema? }?)` | Detached ValidationResult; uses opener's schema by default |

Cursor members:

| Members | Contract |
| --- | --- |
| `depth`, `offset`, `kind`, `length` | Current position, same meanings as View |
| `key` | string, number, bigint, or undefined at its root |
| `keyIs(text: string): boolean` | Compare encoded map key |
| `enter()`, `next()`, `up()`, `find(key)` | boolean; false leaves position unchanged |
| `number()`, `bigint()`, `int()`, `text()`, `bool()`, `isNull()`, `simple()`, `value()` | Same scalar/materialisation semantics as View |
| `view()` | Small View object at the current item |

Conversion accessors on the wrong kind throw TypeError. `isNull()` is a
predicate and returns false for other kinds on both View and Cursor.
Use `copyBytes()` or `new Uint8Array(v.raw())` for writable data.
Detached validation says
nothing about enclosing constraints. No unchecked opener, raw VM state or
directory instrumentation is part of this entry point.

## Writer: `snug/writer`

`new Writer(options?: WriterOptions)` accepts EncodeOptions plus
`keysSorted?: boolean` (false) and `limits?: Limits`. The grouped limits
override top-level limit resolution; prefer using one spelling.
`strictArrays` applies to `value(v)` and its nested arrays just as in encode;
`new Writer(profiles.bindle)` enables the strict own-property check.
All methods return `this` except `finish`; `failure` is the first code or ''.

| Methods | Arguments |
| --- | --- |
| `value(v)` | unknown; host-value walk with encode's admission rules |
| `uint(n)` | number or bigint in 0..2⁶⁴−1; numbers must be safe integers |
| `int(n)` | safe integer number or exact bigint (bignum beyond 64 bits) |
| `bigint(n)` | bigint |
| `float(x)` | number; shortest width. Deterministic floats: NaN → `f97e00`, ±∞/±0 float16, `float(1)` → `f93c00`; Bindle floats refuse NaN, ±∞, ±0 and safe-range integers (`float`) |
| `bool(b)`, `null()`, `text(s)`, `bytes(b)` | boolean, no argument, string, Uint8Array |
| `undefined()` | `f7`; needs `undefinedValue` |
| `simple(n)` | number 0–19 or 32–255, or a `Simple`; shortest form (`f0`, `f8 ff`); needs `undefinedValue` (else `simple`) |
| `tagged(tag, content)` | `value(new Tagged(tag, content))` |
| `typed(a)`, `decimal(d)`, `ndarray(a)` | admitted typed array/Float16Bytes, known non-integral Decimal, NDArray; use value(Decimal.from(text)) for integral-or-decimal results |
| `beginArray(n)`, `beginMap(n)` | non-negative safe count, checked against entry bound |
| `key(k)` | string; an integer (number or bigint) with `keys: 'integer'`/`'any'`, or a safe integer label in a top-level cose map under `keys: 'text'`; any value with `keys: 'any'` (written by a value walk whose items count toward `maxItems`) |
| `end()` | close one complete container |
| `finish(): Uint8Array` | finish one complete root; return copied encoding |

Each key owes exactly one value. Unsorted keys are ordered at map close;
`keysSorted` checks order as keys arrive. Any writing error makes the Writer
unusable. `maxBytes` is an explicitly supplied finish-time check; growth is
not capped in advance: maxBytes bounds output acceptance, not peak allocation.
Wrong-type typed calls such as `new Writer().text(7)`, `.uint('7')` or
`.beginArray('2')` throw sticky SnugFault `unsupported`, not TypeError.
The first failure poisons the Writer; discard it and construct a new one.
Map comparison budget is currently internal (D073).

## Sources: `snug/sources`

Schema validators and profile-only scanners support known-length handles,
declared-length push sources and (D085) streams of unknown length in drain
mode. Validation builds no decoded value tree. The
adapters read on demand; push retention follows the session's replay needs
and can grow with the document, bounded by its declared length.

```ts
interface Handle {
  readonly size: number;
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
}
```

`SyncHandle` requires synchronous reads. SourceOptions is
`{ chunk?: number, quantum?: number }` (65536, 0). Use a positive safe integer chunk;
quantum 0 disables scheduling yields, while a positive quantum enables them
(all sessions accept up to 2^31−1). Async drivers yield through
`scheduler.yield`, `setImmediate`, `MessageChannel`, or finally `setTimeout(0)`,
according to runtime availability; synchronous drivers continue immediately.
Yields do not replenish the validation budget or change verdicts. Scan options
are DecodeOptions (objects is irrelevant); schema options are ValidationOptions,
with top defaulting to any and limits only lowering the compiled values.

| Function / class | Result |
| --- | --- |
| `openSession(schema, rule, length, options?, { quantum? }?)` | Synchronous advanced `VmSession`; length undefined selects drain mode; replaces Schema.session (D160) |
| `scanBuffer(bytes, options?)` | void, or SnugFault; specialised contiguous-buffer path |
| `scanHandle(handle, options?, sourceOptions?)` | Promise resolving true; demand-driven, one read in flight |
| `scanHandleSync(handle, options?, sourceOptions?)` | true; Promise reads refused |
| `validateHandle(schema, handle, rule, options?, sourceOptions?)` | Promise resolving ValidationResult; sync or async reads, one in flight |
| `validateHandleSync(schema, handle, rule, options?, sourceOptions?)` | ValidationResult; Promise reads refused |
| `pushValidator(schema, length, rule, options?, { quantum?, failFast? }?)` | PushValidator with `feed`, `resume`, `finalize`; `length` undefined: unknown length (drain mode; `end()` = finalize; `failFast` allowed only then; `bytesHeld`) |
| `streamSource(input)` | AsyncIterable over a ReadableStream, AsyncIterable or Iterable of Uint8Array (D085) |
| `validateStream(schema, source, rule, options?, { quantum?, failFast? }?)` | Promise resolving ValidationResult for a message of unknown length: the buffer's result (drain), or with failFast a certain refusal at once (accept/refuse equal, code may differ) |
| `scanStream(source, options?, { quantum?, failFast? }?)` | Promise resolving true / rejecting SnugFault, unknown length (the VM against `any`, D146) |
| `bufferHandle(bytes)` | SyncHandle; owns a copy of Uint8Array or Node Buffer input; each read returns an independent copy |
| `asyncHandle(bytes, { delay? }?)` | Handle; same snapshot ownership as bufferHandle; delay is a non-negative safe integer in milliseconds, default 0 (Promise microtask), positive delay uses a timer |
| `pushScanner(length, options?, { quantum?, failFast? }?)` | `{ feed(chunk), resume(), finalize() }`; `length` undefined: unknown length (drain mode, `end()`) |
| `new ScanSession(length, options?, { quantum? }?)` | Low-level profile session with `step(window, base)`, `length`, `done` |
| `SourceError` | Error subclass, `(code: string, message: string)`, field `code` |
| `sessionLimits(set?)` | The isolate's session policy (P9.7, D327): `{ maxLive, maxPooledBytes, live, pooledBytes }`; `set` changes `maxLive` (default 1024, at least 1) and/or `maxPooledBytes` (default 2 MiB). Also exported by `snug/sequence` |
| `releasePool()` | Drops every idle pooled session array now (P9.7), e.g. in a long-lived process trimming memory. Also exported by `snug/sequence` |

The Rust host has the same drivers, sync and async (P9.6), over the same
session, with the same verdicts for every chunking: `validateHandle` is
`Schema::validate_blob_async` (an `AsyncBlob`: `size()` and an async
`read(offset, len)`), `validateStream` is `Schema::validate_reader_async` (an
`AsyncSource`, a `poll_read` byte stream; drain mode and fail-fast as here) and
`readSequence` is `Schema::read_sequence_async` / `read_sequence_async`. A
positive quantum yields to the executor as `nextTurn` does here. See
[Rust: async sources](rust.md#async-sources):

```rust
let verdict = schema.validate_reader_async(&mut body, "event", &ValidationOptions::default(),
                                           65536, 0, false).await?;      // validateStream
let mut messages = schema.read_sequence_async(body, "event", &SequenceOptions::default())?;
while let Some(m) = messages.next().await { /* m?.view() */ }           // readSequence
```

`VmSession` is a public interface obtained through `openSession` from
`snug/sources`, with no public constructor. It exposes readonly `length`
(undefined for unknown length), `limit` (the unknown-length input limit),
`bytesHeld` (exclusive VM array bytes, excluding the shared Program and
supplied windows),
`step(window: Uint8Array, base: number): VmStep`, and `close()` /
`[Symbol.dispose]()`. Scratch and Program storage remain private. Each session
owns exclusive state across suspensions; share Programs, use separate sessions
for independent validations, and never resume one session concurrently.

**Live sessions and pooling (P9.7, D327).** A session counts as *live* from
its creation until it finishes (a `done` step or `end`), fails (an extension
predicate that threw, an internal error), or is closed. This covers
`openSession`, handles, push sources, streams and sequence readers; a sequence
reader counts once.

Creating one more session while `maxLive` sessions are live throws `SnugFault`
with code `sessions/limit` before anything is validated. To release a session:

- finish it;
- call `close()` on it, or on a push validator/scanner or sequence reader;
- dispose of it (`using s = openSession(...)`).

**A session abandoned mid-message holds its slot until it is
garbage-collected**, which in JavaScript can be much later. Close sessions you
stop driving.

A finished session's arrays go to its Program's pool. Every array is
zero-filled before reuse, so no byte of one session is visible to another, and
results are those of fresh arrays. Idle arrays are kept up to `maxPooledBytes`
in all (default 2 MiB, about 25 small sessions' worth); an entry above 1 MiB,
or above a quarter of `maxPooledBytes`, is dropped instead. `releasePool()`
drops them all at once, and a collected Program's go with it. The wasm SDK
(`snug-wasm-sdk/sources`, `/sequence`) has the same `sessionLimits`,
`releasePool` and `close()`, counted per instance.

`sessionLimits()` reports `live` and `pooledBytes` for monitoring. The limits
are isolate-wide policy; there is no per-call override.

`VmStep` is one of:

```ts
type VmStep =
  { state: 'need'; offset: number; length: number; keep: number } |
  { state: 'yield'; position: number; keep: number } |
  { state: 'held'; result: ValidationResult } |
  { state: 'done'; result: ValidationResult };
```

Start with an empty window at base 0. On `need`, supply a window containing
the entire requested absolute range; the request can exceed your preferred
chunk size. `base` is the window's absolute offset, and its span must stay
within the declared document (or input limit for unknown length). On `yield`,
give the event loop a turn, then resume with the current window. `keep` means no earlier byte will be requested
again; retain bytes from there for forward-only sources, since some checks
replay content. Keep every supplied byte immutable, including across awaits;
SharedArrayBuffer windows are refused. `done.result` has exactly buffer
validation's meaning. Discard sessions after completion or failure.
Prefer the source drivers below unless implementing a custom window driver.

Lengths are exact non-negative int32 document lengths (0..2^31−1), required
before validation starts for handles and known-length push sources. A handle
must represent an **immutable snapshot**:
size and every read must refer to the same bytes throughout the operation,
including repeated reads. Pin remote object versions/generations or ETags in
the caller's handle implementation and enforce the pin on every read. The
library does not inspect a `version` field or detect object changes. The
in-memory helpers own independent copies, including for Node Buffer subranges;
mutating the input or a returned read cannot change subsequent reads. Their
handles are frozen and SharedArrayBuffer input is refused. Each custom read
must return exactly the requested range as a Uint8Array, stable while used.
**Unknown length (D085):** every check that depends on the end (a length or
count past the bytes seen, trailing bytes, `too_large`) is held, a verdict found
earlier is held while the rest is read and dropped, and the end (stream end,
`end()` / `finalize()`) settles them: results equal the buffer's of the same
bytes (code, offset, path, budget, items). More bytes than `maxBytes` answer
`cbor/too_large` at once. `failFast` answers a certain refusal at once (its
code may be another than the buffer's `cbor/truncated` / `cbor/too_large`);
acceptance waits for the end. Unknown-length sessions allocate their key arena
for the input limit (`maxBytes`). Source decoding is unavailable. Default helper reads alone do not give the
event loop a turn per read; positive quantum enables cooperative scheduling.
Start with the [minimal schema-handle recipe](guide.md#validating-remote-objects-and-streams)
and known-length AsyncIterable adapter before implementing custom sessions.

Profile `ScanSession.step` returns
`{state:'need', offset, length}`, `{state:'yield', position}`, or
`{state:'done'}`. Push scanners return these states without range metadata.
`openSession(schema, rule, undefined, …)` is the raw unknown-length session: `step`
may also return `{state:'held', result}` (a verdict waiting for the end), and
`end(n)` returns `{state:'done', result}` or a `yield` to step on over the bytes
still held; a window `[base, base + length)` asserts those bytes exist, and
`limit` is the input limit.
Push validators' `feed(chunk)` / `resume()` return `{state:'need'}`,
`{state:'yield'}`, or `{state:'done', result: ValidationResult}`. Feed chunks
in order on `need`; on `yield`, resume on a later turn before feeding more.
Empty chunks do not signal EOF. Always deliver the declared byte count and
call `finalize()`, even after an early done/refusal. It checks delivered length
and returns the ValidationResult (true for profile scanners). Finalize runs
remaining work synchronously; drain yields via resume first for fairness.

CBOR/CDDL/budget refusals from schema sources are ValidationResult objects,
including `cbor/…` reasons. Profile scanners instead throw SnugFault. SourceError
identifies adapter protocol failures (`bad_chunk`, `short_read`,
`length_mismatch`), never a CBOR/CDDL verdict. Transport exceptions/rejections
propagate unchanged; sanitise them before logging. Wrong arguments/unknown
rules use TypeError. Session reuse after completion/failure is unsupported.

## CBOR sequences: `snug/sequence`

`readSequence(source, options?)` and `sequenceReader(options?)` read an RFC 8742
sequence (D210–D217, [guide](guide.md#cbor-sequences-and-sse)). Each message is
one root, checked in the pass that finds its end: the profile, plus the schema
rule when `schema` and `rule` are given. A separate entry from `snug/sources`
because it carries the View.

| Function | Result |
| --- | --- |
| `readSequence(source, options?)` | `SequenceIterator`: an async generator of `SequenceMessage`, with `stats` `{ messages, skipped, bytes, lastSkipped }`; `source` is a ReadableStream, AsyncIterable or Iterable of Uint8Array; leaving the loop cancels it |
| `sequenceReader(options?)` | `{ feed(chunk), end(), done, bytesHeld }`; `feed`/`end` answer `{ messages, skipped, error }`; after `error` (or `end`) the reader is done and `feed` throws TypeError |

`SequenceOptions`: the ValidationOptions (profile, `top`, `cose`, `maxDepth`,
`maxEntries`, `maxItems`, `maxBignumBytes`, `budget`, `objects`) with
`maxMessageBytes` instead of `maxBytes` (refused), `schema` + `rule`,
`onInvalid` (`'stop'` default | `'skip'`), `copy` (`'spanning'` default |
`'always'`), `failFast`; `readSequence` also takes `quantum`. Every limit
applies to each message from zero; `maxMessageBytes` defaults to the input
limit (1,500,000 profile-only, the schema's compiled one otherwise). Top
defaults as for the codec without a schema and to `'any'` with one.

`SequenceMessage` is `{ index, offset, length, bytes, borrowed, view }`:
`offset` is absolute; `bytes` is the exact encoding, a subarray of the chunk
it lay in when `borrowed` (one chunk held it and `copy` is `'spanning'`), else
a fresh buffer (a plain Uint8Array copy under `copy: 'always'`, Node
`Buffer` chunks included); `view` is a checked `View` minted from the bytes
the reader checked (message fields are read-only getters; View and Cursor
keep their state private and refuse construction outside `view()`).
Borrowing is safe only when the producer never mutates, recycles or
transfers a chunk's buffer after handing it over (a `fetch` body's byte
stream; not guaranteed by an arbitrary default `ReadableStream` reader);
otherwise use `copy: 'always'`. A retained borrowed message keeps its chunk's
buffer alive.

Delivery: an accepted message is released by the feed that completes it
(no wait for later bytes). `readSequence` runs one message ahead of the
consumer; `feed` returns every message its chunk completes (result storage
proportional to that). `bytesHeld` counts the message in progress's
assembled bytes, not buffer capacity, chunks or the session arena (sized for
`maxMessageBytes`).

A message's verdict equals the buffer validation of its window — the bytes
from its start, at most `maxMessageBytes` — with the root's end as the
boundary (architecture §18.1): exactly `schema.validate` / the codec check of
the message's own bytes when it is accepted (and for a schema refusal of a
complete message); a message that does not complete is judged over that
window, so its code can differ from the same bytes checked alone. Refusals are `SnugFault`s with
`code`, `reason`, `path`, `subcode`, `offset` (absolute), `index`,
`messageOffset` and `skippable`. Skippable (`onInvalid: 'skip'`): schema
reasons of a complete message. Not skippable: `cbor/*` codes (incl.
`truncated` at EOF inside a message and `too_large` for a message not ending
within `maxMessageBytes`) and `budget`. `failFast` answers a held refusal at
once (D145's contract). An empty source is an empty sequence. Non-Uint8Array
chunks reject with SourceError `bad_chunk`; SharedArrayBuffer chunks with
TypeError. An exception from an extension predicate ends the sequence after
the earlier messages (readSequence yields them, then throws; the push result
carries it as `error`). Transport exceptions (a rejected source read) pass
through unchanged; cancel a pending read with the fetch's AbortController.

The wasm SDK (`snug-wasm-sdk/sequence`, P7.13w) has the same API, options and
answers (`bb wasm-sdk-test` holds it to the native package per feed). Its
differences are the SDK's view contract (D132): `message.bytes` is borrowed or
assembled exactly as natively, but `message.view` copies the bytes into linear
memory on first use (so `view.borrowed` is false; `view.release()` frees it at
once); a reader whose instance was reset (`InstanceLost`) ends with an error.

## Errors

No library-produced refusal contains received values, bytes or unnamed data
keys. A validation failure has a safe path and absolute offset; embedded
failure adds its innermost reason as subcode. Only schema-named live keys,
indexes and the markers `*`, `#tag`, `cbor` appear in paths.

| Family | Codes |
| --- | --- |
| CBOR/profile (`SnugFault.code`) | `truncated`, `non_shortest`, `indefinite`, `malformed`, `key_type`, `key_order`, `duplicate_key`, `text`, `float`, `simple`, `tag`, `bignum`, `decimal`, `typed_array`, `ndarray`, `trailing`, `depth`, `too_many_entries`, `too_many_items`, `too_large`, `not_map` |
| Validation reason | `cbor/` plus a profile code; or `type`, `missing`, `unexpected`, `value`, `size`, `range`, `pattern`, `tag`, `bits`, `embedded`, `control`, `control_size`, `group_limit`, `budget` |
| Schema decode/checked-view SnugFault | Profile codes unchanged; schema reason prefixed `schema/`, e.g. `schema/type`, `schema/budget`; also carries reason/path/offset/subcode |
| Host encode / Writer | Profile codes where applicable; `unsupported`, `grammar`, `writer_failed` |
| Sessions (`snug/sources`, `snug/sequence`) | `sessions/limit` |
| ProgramError | `magic`, `container_version`, `format_version`, `length`, `version` (malformed producer metadata), `reserved`, `digest`, `verify`, `too_large`, `missing_control` |
| SourceError | `bad_chunk`, `short_read`, `length_mismatch` |

SchemaError codes:

- Syntax/resolution: `syntax`, `undefined_name`, `duplicate_rule`,
  `type_group_mismatch`, `generic_arity`, `nonproductive`, `group_recursion`,
  `unwrap`, `enum`, `range`, `float_literal`, `empty_schema`.
- Controls/matching: `control_target`, `control_value`, `unsupported_control`,
  `unknown_control`, `control_registry`, `regexp`, `map_key`, `tag`, `major`,
  `profile`. (`map_group_occurrence`, `map_cut` and `map_overlap` were
  format 1 refusals; format 2.0 never produces them.)
- Resources: `limit_schema_bytes`, `limit_nesting`, `limit_ast_nodes`,
  `limit_instantiations`, `limit_peg_nodes`, `limit_array_positions`,
  `limit_regexp_positions`, `limit_width`, `limit_pool_bytes`,
  `limit_total_bytes`, `limit_compile_budget`, `limit_leaves`, `limit_memory`.
- `internal` identifies an implementation problem; it is not a supported
  CDDL construct being deliberately refused.

Facade byte/rule/span misuse uses TypeError; exact integer view conversion
can use RangeError (use `bigint()` or `int()` instead of unsafe `number()`).
Writer typed argument/admission refusals are sticky SnugFaults; `.text(7)`
throws `unsupported`, and the next call throws `writer_failed`.
Every public options bag rejects malformed values and unknown keys with
TypeError before checking data (or rejects its Promise for async calls).
Known-option errors name the option without displaying its value;
unknown-key errors list permitted names. See [option admission](#option-admission).
Valid resource exhaustion remains a data result/fault; it is not TypeError.
SharedArrayBuffer input must first be copied into stable, exclusively owned
bytes; coordinate concurrent writers while taking that copy.
Unexpected internal invariant failures remain ordinary Error; they must not
be interpreted as successful validation or a schema verdict. Transport
exceptions propagate unchanged and need their own sanitisation policy.

Messages are explanatory text, sometimes generic; they are not a recovery
API. Codec/profile refusals need only a code, not an offset. Log selected
`code`, `reason`, `path`, `offset`, `subcode` fields from library refusals,
never received values/bytes or arbitrary transport errors. Schema rule names
are caller-controlled metadata; apply your logging policy to them too.

Recovery by CBOR/profile code (also applies to `cbor/<code>` reasons):

| Code | Meaning / next action |
| --- | --- |
| `truncated` | Missing bytes/head/content; check framing and retransmit a complete immutable document |
| `non_shortest` | Non-minimal argument or float width (`wire: 'deterministic'`/`'bindle'`); fix the producer's deterministic encoding |
| `indefinite` | Indefinite length/break form (`wire: 'deterministic'`/`'bindle'`); produce definite lengths |
| `malformed` | Invalid CBOR head/structure; reject and fix the producer |
| `key_type` | Key kind/label outside current policy; use text or permitted root COSE labels; check protocol compatibility |
| `key_order` | Encoded keys out of lexicographic order (`wire: 'deterministic'`/`'bindle'`); fix producer sorting |
| `duplicate_key` | Duplicate map key, compared by value (two encodings of one value are one key); reject, resolve duplicate at the producer |
| `text` | Invalid UTF-8 scalar text or forbidden noncharacter; fix text at the producer |
| `float` | Scalar width/value violates current policy; use shortest width, integers for safe integral values, and supported finite scalars |
| `simple` | Unsupported simple value, including undefined; use admitted false/true/null or revise the protocol |
| `tag` | Tag outside allowed set or invalid tag form; check current tag list, do not strip tags blindly |
| `bignum` | Invalid magnitude/size/canonical form; use major 0/1 when it fits, otherwise canonical 9..128-byte magnitude |
| `decimal` | Invalid tag-4 shape/normalisation; use Decimal factories and value(), not presentation-scale encodings |
| `typed_array` | Unsupported/invalid typed-array content, width or NaN; use admitted little-endian tags and valid elements |
| `ndarray` | Shape/data dimensions or product invalid; check positive dimensions and matching data count |
| `trailing` | More bytes after the one root; fix framing or use an explicit sequence schema where supported |
| `depth` | Nesting policy exhausted; simplify structure or deliberately raise the relevant cap |
| `too_many_entries` | Per-container pair/element cap exceeded; reduce that container or review its cap |
| `too_many_items` | Total item accounting exhausted; reduce document complexity or review its cap |
| `too_large` | Input/output byte acceptance cap exceeded; reduce size or review cap; encoding checks only at finish |
| `not_map` | The root is not a map under `top: 'map'` (the Bindle preset's default; valid and deterministic default to any root); drop `top: 'map'` if the protocol permits other roots |

The last five resource/root codes need not mean malformed CBOR. For schema
limits a larger per-call value cannot lift the compiled cap; recompile with
reviewed policy if appropriate. Retrying identical bytes and policy will not
help. Never raise caps automatically in response to an untrusted message.

| Schema reason (or `schema/<reason>` fault) | Meaning / next action |
| --- | --- |
| `type` | Wrong CBOR kind; check numeric and host-value representations against the rule |
| `missing` | Required member/position absent; supply required structure |
| `unexpected` | Extra member/position in a closed structure; remove it or revise the schema |
| `value` | Literal/choice predicate failed; check the whole alternative, not only the witness field |
| `size` | Byte length/count predicate failed; text size is UTF-8 bytes |
| `range` | Numeric bounds failed; fix value or reviewed schema bounds |
| `pattern` | Whole-string I-Regexp failed; fix text or intended pattern |
| `tag` | Schema tag predicate failed; check tag and content against rule |
| `bits` | Disallowed set bit; correct bit mask/content |
| `embedded` | Inner CBOR/sequence predicate failed; inspect safe subcode and fix embedded producer/schema |
| `control` | A registered extension control's predicate refused the item |
| `control_size` | The item is longer than the extension control's `maxBytes`; the predicate was not asked |
| `group_limit` | The PEG group arena (A2 array records, T map records, recursive group frames) reached its cap: compile option `groupWords`, else the default 4,194,304 words (D276, D281); a memory policy, not proof of invalid data |
| `budget` | VM work policy exhausted, not proof of invalid data; reduce complexity or review compiled/per-call budget and concurrency |

| Other code / class | Meaning / next action |
| --- | --- |
| SnugFault `unsupported` | Host value or typed Writer argument not admitted; use documented representations; replace failed Writer |
| SnugFault `grammar` | Writer root/count/key/end sequence invalid; fix call sequence and replace Writer |
| SnugFault `writer_failed` | Writer already poisoned; inspect failure for first code and replace Writer |
| SnugFault `sessions/limit` | `openSession` (or a source/sequence that opens one) found `sessionLimits().maxLive` sessions live; finish, `close()` or dispose sessions, or raise the limit deliberately |
| ProgramError `magic` | Wrong artifact type; load a snug Program container |
| ProgramError `container_version` | Unsupported framing version; regenerate with compatible toolchain |
| ProgramError `format_version` | Not format 2.0 (for example a cached 1.x Program) or a newer minor; evict and recompile from trusted CDDL |
| ProgramError `length` | Claimed/actual framing sizes disagree; evict and regenerate trusted artifact |
| ProgramError `version` | Malformed producer metadata, not producer-version inequality; regenerate artifact |
| ProgramError `reserved` | Nonzero reserved bytes; reject and regenerate artifact |
| ProgramError `digest` | Container integrity mismatch; evict/reload from trusted origin, never bypass verification |
| ProgramError `verify` | Structural Program verification failed; reject artifact and regenerate from trusted CDDL |
| ProgramError `too_large` | Container/program body exceeds loader cap; bound cache/artifact size |
| ProgramError `missing_control` | The Program uses extension controls the loader's registry lacks (the message names them); pass the registry it was compiled with |
| SourceError `bad_chunk` | Handle read returned the wrong type, or a Promise was supplied to a sync driver; fix adapter or use async driver |
| SourceError `short_read` | Handle returned other than the requested range length; fix exact immutable range reads |
| SourceError `length_mismatch` | Push delivery differs from declared count; correct framing, deliver remainder and finalize on normal EOF |

Push `feed` with a non-Uint8Array is argument misuse and throws TypeError;
it does not produce SourceError `bad_chunk`.

SchemaError recovery (line/column locate schema text, not payload):

| Code | Meaning / next action |
| --- | --- |
| `syntax` | Invalid CDDL/escape; correct syntax at reported position |
| `undefined_name` | Unresolved rule; define or correct reference |
| `duplicate_rule` | Repeated definition; use intended extension syntax or unique names |
| `type_group_mismatch` | Type/group used in wrong context; correct definition/reference |
| `generic_arity` | Generic argument count wrong; match parameters |
| `nonproductive` | Recursion makes no progress; pass through a container/tag |
| `group_recursion` | Unsupported recursive group; use regular tail recursion or finite structure |
| `unwrap` | Inapplicable unwrap target; use supported container/group target |
| `enum` | Inapplicable/recursive enumeration; use a supported finite group |
| `range` | Invalid/incompatible range endpoints; correct bounds and kinds |
| `float_literal` | Literal outside supported precision/range; use supported finite ≤17-significant-digit decimal or appropriate hex literal |
| `empty_schema` | No usable schema; supply a type rule |
| `control_target` | Control on wrong target kind; use supported target |
| `control_value` | Unsupported controller/value conversion; use documented exact controller forms |
| `unsupported_control` | Recognised control deliberately unsupported; rewrite with supported constraints |
| `unknown_control` | Unknown control/extensions pending; correct spelling or enforce application constraint separately |
| `control_registry` | The extension-control registry reached the compiler malformed (the facade usually refuses a bad registry earlier with TypeError); fix the registry |
| `regexp` | Unsupported I-Regexp/escaping or missing tables; use cookbook replacements for JS shorthands, pass snug/unicode for categories |
| `map_key` | Unsupported map-key schema; use allowed literal/key domain |
| `tag` | Invalid/unsupported schema tag constraint; correct syntax/content type |
| `major` | Invalid major/simple constraint; use supported major syntax |
| `profile` | Compiler restriction set disallows construct; simplify or deliberately choose another compiler profile, without relaxing wire policy |
| `limit_schema_bytes` | Schema text cap; reduce text or review schemaBytes |
| `limit_nesting` | Parser/lowering nesting cap; simplify or review nesting |
| `limit_ast_nodes` | AST cap; simplify or review astNodes |
| `limit_instantiations` | Generic expansion cap; bound expansion or review instantiations |
| `limit_peg_nodes` | PEG nodes in one group after inlining; simplify the group or review pegNodes |
| `limit_array_positions` | Array automaton cap; simplify repetition or review arrayPositions |
| `limit_regexp_positions` | Regexp automaton cap; simplify pattern/repetition or review regexpPositions |
| `limit_width` | Reachable leaf width cap; simplify choices or review width |
| `limit_pool_bytes` | Literal/automaton pool cap; reduce data or review poolBytes |
| `limit_total_bytes` | Program/pool/scratch cap; simplify or review totalBytes |
| `limit_compile_budget` | Compile work exhausted; simplify schema/tables or review compileBudget and isolation |
| `limit_leaves` | Leaf count cap; reduce choices/expansion or review leaves |
| `limit_memory` | Compiler arena capacity exhausted; simplify schema; investigate if unexpectedly small |
| `internal` | Implementation invariant failure; report a minimal schema reproducer, do not reinterpret as a deliberate feature refusal |
