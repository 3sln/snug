# JavaScript API

This reference describes the package facades and is maintained with the
six [declaration files](../host/js/types/). `npm test` checks declarations
with Node's TypeScript parser, checks exported names against runtime exports,
and uses offline TypeScript for semantic checks if it exists in the permitted
neighbouring checkout. This run had no offline TypeScript. No installs are
required. Internal `src/schema.mjs`/`src/compile.mjs` are host interfaces;
their signatures and error classes are not the package contract.

## Codec: `snug`

```ts
decode(bytes: Uint8Array, options?: DecodeOptions): Value
encode(value: unknown, options?: EncodeOptions): Uint8Array
```

`Value` is the decoded union: null, boolean, number, bigint, string,
Uint8Array, admitted native typed arrays, Decimal, Float16Bytes, NDArray,
arrays, string-keyed objects, or a top-level Map with `cose`.

| Option | Default | Meaning |
| --- | --- | --- |
| `top: 'map' \| 'any'` | `'map'` for codec/view/source; `'any'` for schema | Decode/check root policy |
| `cose: boolean` | false | Safe integer labels as well as text, top-level map only |
| `objects: 'null' \| 'plain'` | `'null'` | Decode ordinary maps into null/ordinary-prototype objects |
| `maxBytes`, `maxDepth`, `maxEntries`, `maxItems` | `LIMITS` | Resource bounds |
| `omitUndefined: boolean` | false | Encode object-member omission; see guide |
| `strictArrays: boolean` | false | Encode: refuse extra array own properties with `unsupported`; Bindle preset sets true |

DecodeOptions includes `top`, `cose`, `objects` and the four limits.
EncodeOptions includes `cose`, `omitUndefined`, `strictArrays` and the four limits. `encode`
does not enforce a map root. Its `maxBytes` check happens only when supplied,
at finish, after allocation. Invalid CBOR/profile or inadmissible host values
throw `SnugFault`; argument misuse can throw `TypeError`.

Arrays encode elements 0..length−1, ignoring extra named own properties
(including hidden and symbol properties) by default. `strictArrays: true`
retains the old own-key count check. Both modes refuse holes and present
undefined elements with `unsupported`, regardless of `omitUndefined`.
Only when an element reads as undefined is absence checked (`!(i in array)`).
Arrays must pass Array.isArray and have exactly the local Array.prototype;
subclassed, foreign-realm and null-prototype arrays remain refused.

| Export | Members and contract |
| --- | --- |
| `Decimal` | `new Decimal(mantissa: bigint, exponent: number)` requires normalised nonzero mantissa not divisible by 10, exponent −1024..−1. Immutable value. |
| `Decimal.from(text: string)` | Returns Decimal, number or bigint; plain decimal notation, exact normalisation. |
| `Decimal.normalize(mantissa: bigint, exponent: number)` | Returns Decimal or integral number/bigint. |
| `Decimal#toString()` | Exact decimal string; `valueOf`/numeric coercion/`toJSON` throw. |
| `Float16Bytes` | `new Float16Bytes(bytes: Uint8Array)`; `bytes`, `length`. Copies an even-length little-endian payload; NaN is checked when encoded. Byte storage is mutable by contract. |
| `NDArray` | `new NDArray(shape: number[], data: Value[] \| TypedArray \| Float16Bytes)`; readonly `shape`, `data`. Positive dimensions (1..8); product equals element count. Data is retained, not deeply frozen. |
| `SnugFault` | Error class; `code: string`; constructor `(code?: string, message?: string)`. Schema decode/view may also carry `reason`, `path`, `offset`, `subcode`. |
| `LIMITS` | Frozen defaults: maxBytes 1,500,000; maxDepth 32; maxEntries 65,536; maxItems 131,072; maxBignumBytes 128; minDecimalExponent −1024; maxDimensions 8. |
| `profiles` | Frozen object containing only `bindle: { top: 'map', cose: false, strictArrays: true }`. Pass as options to encode/Writer for the old array-property refusals. The general deterministic preset is not implemented/exported. |

Native typed arrays: Int8, Uint16/32, BigUint64, Int16/32, BigInt64,
Float16 where available, Float32/64. `Uint8Array` is a byte string.
The declarations spell native Float16 structurally (`Float16ArrayLike`) to
avoid requiring newer TypeScript libraries; runtime admission still requires
the actual native type. Do not substitute an arbitrary structural lookalike.

## Compilation

From `snug/compile`:

```ts
compile(text: string | Uint8Array, options?: CompileOptions): Promise<Schema>
```

Importing this entry point does not load the generated compiler; calling it
does. After loading, the compile is synchronous. `CompileOptions` is
`{ profile?: 'full' | 'bindle' | 'bus', limits?: CompileLimits }`.
`profile` defaults to `full` and restricts accepted CDDL, not wire policy.
Schema refusals reject with `SchemaError`; invalid API options with TypeError.

`CompileLimits` names:

| Compile resources | Compiled runtime resources |
| --- | --- |
| `schemaBytes`, `nesting`, `astNodes`, `instantiations`, `alternatives`, `arrayPositions`, `regexpPositions`, `width`, `poolBytes`, `totalBytes`, `compileBudget`, `leaves` | `depth`, `inputBytes`, `entries`, `items`, `bignumBytes`, `budget` |

All are non-negative integers; defaults and ceilings are in the
[guide](guide.md#limits). kin applies effective defaults and ceilings before
computing the source key. No custom controls or Unicode module option is
currently exposed (D082/D083 are planned).

`SchemaError` extends Error: constructor
`(code, line = 0, column = 0, rule?)`, fields `code`, `line`, `column`,
`rule`. The compiler supplies positions in code points and safe schema
metadata. The public error message uses the code and position.

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

| API | Result / behaviour |
| --- | --- |
| `new Program(P: Int32Array, B: Uint8Array)` | Copies and structurally verifies; throws ProgramError on refusal. Trusted origin is still required. |
| `program.P`, `program.B` | Fresh copies of verified words/pool; mutations do not affect the Program. |
| `program.sourceKey` | Lowercase 64-character SHA-256 hex cache key. |
| `program.rules` | Frozen array of sorted validatable rule names. |
| `program.serialize(): Uint8Array` | Deterministic §13.3 container, synchronously hashed. |
| `new Schema(program: Program)` | Schema over a public verified Program. |
| `schema.program` | The immutable public Program. |
| `schema.validate(bytes, rule, options?)` | ValidationResult; default top any. |
| `schema.session(rule, length, options?, { quantum? }?)` | Advanced `VmSession` over an exact known-length document; default top any. |
| `schema.decode(bytes, rule, options?)` | Value, or SnugFault with the same witness; no values built before success. |
| `schema.validateAt(bytes, start, end, rule, options?)` | Detached ValidationResult over [start,end); absolute offsets; default top any. |
| `fromProgram(P, B): Promise<Schema>` | Copies and verifies, without loading the compiler. |
| `fromSerialized(bytes: Uint8Array): Promise<Schema>` | Checks container integrity/compatibility and verifies; without the compiler. |

The entry also exports schema-first helpers:

```ts
validate(schema: Schema, bytes: Uint8Array, rule: string, options?: ValidationOptions): ValidationResult
decode(schema: Schema, bytes: Uint8Array, rule: string, options?: ValidationOptions): Value
validateAt(schema: Schema, bytes: Uint8Array, start: number, end: number,
           rule: string, options?: SpanOptions): ValidationResult
```

`ProgramError` extends Error with `code`; constructor `(code)`.
Load compatibility is equal format major and minor ≤ loader minor (D084),
currently 1.0. Container version is 1. Producer snug version is informational,
retained on reserialisation. The four-byte format word stores major in low
16 bits, minor in high 16 bits. P and B must remain semantically trustworthy;
SHA-256 is a corruption check, not authentication. See [caching](guide.md#programs-caching-and-compatibility).

`VmSession` is a public interface obtained through `schema.session`, with no
public constructor. It exposes readonly `length`, `bytesHeld` (exclusive VM
array bytes, excluding the shared Program and supplied windows), and
`step(window: Uint8Array, base: number): VmStep`. Scratch and Program storage
remain private. Each session owns exclusive state across suspensions; share
Programs, use separate sessions for independent validations, and never resume
one session concurrently. There is no session pool or live-session cap.

`VmStep` is one of:

```ts
type VmStep =
  { state: 'need'; offset: number; length: number; keep: number } |
  { state: 'yield'; position: number; keep: number } |
  { state: 'done'; result: ValidationResult };
```

Start with an empty window at base 0. On `need`, supply a window containing
the entire requested absolute range; the request can exceed your preferred
chunk size. `base` is the window's absolute offset, and its span must stay
within the declared document. On `yield`, give the event loop a turn, then
resume with the current window. `keep` means no earlier byte will be requested
again; retain bytes from there for forward-only sources, since some checks
replay content. Keep every supplied byte immutable, including across awaits;
SharedArrayBuffer windows are refused. `done.result` has exactly buffer
validation's meaning. Discard sessions after completion or failure.
Prefer the source drivers below unless implementing a custom window driver.

## Views: `snug/view`

`view(bytes: Uint8Array, options?: ViewOptions): View` checks before opening.
ViewOptions extends ValidationOptions with `schema?`, `rule?`, `borrow?`
(false), `directories?` (false, experimental). A schema requires its rule.
The default owned view copies before checking; borrowed bytes and every alias
must remain unchanged. `View` is obtained through `view`, not constructed
directly; `new Cursor(view)` is also available.

| View member | Signature / meaning |
| --- | --- |
| `kind` | int, float, bytes, text, bool, null, array, map, decimal, ndarray, typed |
| `length` | number or undefined; entries/bytes/elements according to kind |
| `offset`, `depth`, `borrowed` | Absolute item position, physical depth, ownership flag |
| `get(key: string \| number \| bigint)` | View or undefined; map only; integer lookup only for top-level COSE maps |
| `at(index: number)` | View or undefined; array only |
| `entries()` | IterableIterator of `[key or index, View]` |
| `keys()`, `values()` | IterableIterator of keys/indexes or Views |
| `number()` | number; unsafe integers throw RangeError |
| `bigint()`, `int()` | Exact bigint; or number when safe else bigint |
| `text()`, `bool()`, `isNull()` | string, boolean, boolean |
| `bytes()`, `raw()` | Uint8Array alias of content/encoded span; read-only by contract |
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
| `number()`, `bigint()`, `int()`, `text()`, `bool()`, `isNull()`, `value()` | Same scalar/materialisation semantics as View |
| `view()` | Small View object at the current item |

Accessors on the wrong kind throw TypeError. Detached validation says
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
| `float(x)` | number; shortest width, current scalar-float restrictions |
| `bool(b)`, `null()`, `text(s)`, `bytes(b)` | boolean, no argument, string, Uint8Array |
| `typed(a)`, `decimal(d)`, `ndarray(a)` | admitted typed array/Float16Bytes, Decimal, NDArray |
| `beginArray(n)`, `beginMap(n)` | non-negative safe count, checked against entry bound |
| `key(k)` | string; safe integer number only for top-level map with cose |
| `end()` | close one complete container |
| `finish(): Uint8Array` | finish one complete root; return copied encoding |

Each key owes exactly one value. Unsorted keys are ordered at map close;
`keysSorted` checks order as keys arrive. Any writing error makes the Writer
unusable. `maxBytes` is an explicitly supplied finish-time check; growth is
not capped in advance. Map comparison budget is currently internal (D073).

## Sources: `snug/sources`

Schema validators and profile-only scanners support known-length handles and
declared-length push sources. Validation builds no decoded value tree. The
adapters read on demand; push retention follows the session's replay needs
and can grow with the document, bounded by its declared length.

```ts
interface Handle {
  readonly size: number;
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
}
```

`SyncHandle` requires synchronous reads. SourceOptions is
`{ chunk?: number, quantum?: number }` (65536, 0). Use a positive integer chunk;
quantum 0 disables scheduling yields, while a positive quantum enables them
(schema sessions accept up to 2^31−1). Async drivers yield through
`scheduler.yield`, `setImmediate`, `MessageChannel`, or finally `setTimeout(0)`,
according to runtime availability; synchronous drivers continue immediately.
Yields do not replenish the validation budget or change verdicts. Scan options
are DecodeOptions (objects is irrelevant); schema options are ValidationOptions,
with top defaulting to any and limits only lowering the compiled values.

| Function / class | Result |
| --- | --- |
| `scanBuffer(bytes, options?)` | void, or SnugFault; specialised contiguous-buffer path |
| `scanHandle(handle, options?, sourceOptions?)` | Promise resolving true; demand-driven, one read in flight |
| `scanHandleSync(handle, options?, sourceOptions?)` | true; Promise reads refused |
| `validateHandle(schema, handle, rule, options?, sourceOptions?)` | Promise resolving ValidationResult; sync or async reads, one in flight |
| `validateHandleSync(schema, handle, rule, options?, sourceOptions?)` | ValidationResult; Promise reads refused |
| `pushValidator(schema, length, rule, options?, { quantum? }?)` | PushValidator with `feed`, `resume`, `finalize` |
| `bufferHandle(bytes)` | SyncHandle; use ordinary Uint8Array for snapshot copying |
| `asyncHandle(bytes, { delay? }?)` | Handle, default delay 0 (Promise microtask); positive delay uses a timer |
| `pushScanner(length, options?, { quantum? }?)` | `{ feed(chunk), resume(), finalize() }` |
| `new ScanSession(length, options?, { quantum? }?)` | Low-level profile session with `step(window, base)`, `length`, `done` |
| `SourceError` | Error subclass, `(code: string, message: string)`, field `code` |

Lengths are exact non-negative int32 document lengths (0..2^31−1), required
before validation starts. A handle must represent an **immutable snapshot**:
size and every read must refer to the same bytes throughout the operation,
including repeated reads. Pin remote object versions/generations or ETags in
the caller's handle implementation and enforce the pin on every read. The
library does not inspect a `version` field or detect object changes. Each read
must return exactly the requested range as a Uint8Array, stable while used.
Unknown-length streams remain pending D085; no drain/failFast option exists.

Profile `ScanSession.step` returns
`{state:'need', offset, length}`, `{state:'yield', position}`, or
`{state:'done'}`. Push scanners return these states without range metadata.
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

## Errors

No library-produced refusal contains received values, bytes or unnamed data
keys. A validation failure has a safe path and absolute offset; embedded
failure adds its innermost reason as subcode. Only schema-named live keys,
indexes and the markers `*`, `#tag`, `cbor` appear in paths.

| Family | Codes |
| --- | --- |
| CBOR/profile (`SnugFault.code`) | `truncated`, `non_shortest`, `indefinite`, `malformed`, `key_type`, `key_order`, `duplicate_key`, `text`, `float`, `simple`, `tag`, `bignum`, `decimal`, `typed_array`, `ndarray`, `trailing`, `depth`, `too_many_entries`, `too_many_items`, `too_large`, `not_map` |
| Validation reason | `cbor/` plus a profile code; or `type`, `missing`, `unexpected`, `value`, `size`, `range`, `pattern`, `tag`, `bits`, `embedded`, `budget` |
| Schema decode/checked-view SnugFault | Profile codes unchanged; schema reason prefixed `schema/`, e.g. `schema/type`, `schema/budget`; also carries reason/path/offset/subcode |
| Host encode / Writer | Profile codes where applicable; `unsupported`, `grammar`, `writer_failed` |
| ProgramError | `magic`, `container_version`, `format_version`, `length`, `version` (malformed producer metadata), `reserved`, `digest`, `verify`, `too_large` |
| SourceError | `bad_chunk`, `short_read`, `length_mismatch` |

SchemaError codes:

- Syntax/resolution: `syntax`, `undefined_name`, `duplicate_rule`,
  `type_group_mismatch`, `generic_arity`, `nonproductive`, `group_recursion`,
  `unwrap`, `enum`, `range`, `float_literal`, `empty_schema`.
- Controls/matching: `control_target`, `control_value`, `unsupported_control`,
  `unknown_control`, `regexp`, `map_key`, `map_group_occurrence`, `map_cut`,
  `map_overlap`, `tag`, `major`, `profile`.
- Resources: `limit_schema_bytes`, `limit_nesting`, `limit_ast_nodes`,
  `limit_instantiations`, `limit_alternatives`, `limit_array_positions`,
  `limit_regexp_positions`, `limit_width`, `limit_pool_bytes`,
  `limit_total_bytes`, `limit_compile_budget`, `limit_leaves`, `limit_memory`.
- `internal` identifies an implementation problem; it is not a supported
  CDDL construct being deliberately refused.

Public API misuse uses TypeError; exact integer view conversion can use
RangeError. Unexpected internal invariant failures remain ordinary Error;
they must not be interpreted as successful validation or a schema verdict.
