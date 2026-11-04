# Using snug

The public JS package is private and experimental. Follow the repository
[quick start and staging instructions](../README.md#package-layout-and-reproducibility).
All imports below use public entry points. The [runnable examples](../examples/)
use repository-relative paths to those same facades so Node needs no install.

## Compile once

```js
import { compile, SchemaError } from 'snug/compile';

const schema = await compile(`
  message = { id: uint, body: bstr .size (0..1024), ? labels: [0*8 tstr] }
  identifier = uint
`, { limits: { inputBytes: 2048, depth: 8, entries: 16, items: 64, budget: 10000 } });
```

The first call imports the compiler, then runs it synchronously with its
compile budget. It returns a `Schema` containing a verified `Program`.
Reuse it for many messages. The Promise is a loading boundary, not background
execution or cancellation. A syntax/semantic/compile-limit refusal rejects
with `SchemaError { code, line, column, rule }`; line/column are 1-based,
columns count code points, and 0 means the error has no source position.
`program.rules` lists the user's validatable, non-generic type rules, sorted
by UTF-8 name. Groups, generic definitions and prelude rules are not
validation roots. [Supported CDDL](cddl-support.md) is an explicit subset.

`profile: 'full' | 'bindle' | 'bus'` selects a **compiler restriction set**.
It does not select the codec wire policy. The default is `full`. `bus`
refuses recursion, regexps and unbounded structures; it is useful for
untrusted schemas, within its supported subset. See [profiles](profiles.md).

## Regexp dialects

`compile(text, { regexp: 'xsd' })` is the default, following RFC 8610's
XSD Appendix F reference. Use `{ regexp: 'iregexp' }` for strict RFC 9485
interoperability and the previous compiler's regexp behaviour. Both match
the entire text; dot excludes CR/LF, and `^`/`$` are literal characters.

```js
const consonants = await compile('r = tstr .regexp "[a-z-[aeiou]]+"');
const xmlName = await compile(String.raw`r = tstr .regexp "\\i\\c*"`);
const asciiDigits = await compile('r = tstr .regexp "[0-9]+"', { regexp: 'iregexp' });
```

XSD adds nested class subtraction, XML 1.0 fifth edition name escapes and
`\s`/`\S` (TAB/LF/CR/SPACE). These need no Unicode module. `\d`/`\D` use
Nd, and `\w`/`\W` use the complement of P/Z/C and its inverse; those need
the optional tables below. XSD `\w` excludes underscore and includes emoji.
Block escapes such as `\p{IsBasicLatin}` explicitly fail with `regexp`:
the pinned Node ICU API exposes no block ranges. See the
[construct table](cddl-support.md#regexp-cookbook) for coverage and escaping.

All syntax lowers at compile time into existing bounded automata. Subtraction
and table operations spend compile budget; repetitions obey the existing
256-position default / 512-position hard cap. The Program format and runtime
are unchanged. The source key includes the effective dialect; explicit
`iregexp` preserves the previous preimage.

## Optional Unicode regexp tables

```js
import { tables, unicodeVersion } from 'snug/unicode';
const words = await compile(String.raw`word = tstr .regexp "[\\p{L}\\p{Nd}_-]+"`, {
  unicode: tables,
});
// unicodeVersion === '16.0'
```

The extra JavaScript module is 19,377 bytes minified, 9,287 bytes gzip-9,
with 77,028 bytes of decoded Int32 ranges; see the
[measurement method](../bench/README.md#unicode-table-module-p73).
It is pinned to Unicode 16.0, generated from Node v24.6.0 / ICU 77.1 without
network access. Exported `nodeVersion` and `unicodeVersion` identify its
inputs. A newer runtime does not silently update these checked-in tables.
Treat `tables` as immutable compile-time data.

Both `\p{X}` and `\P{X}` accept the RFC 9485 general-category names, inside
or outside character classes. `String.raw` preserves CDDL's doubled backslashes
in the example. Without the option, these escapes raise a `SchemaError`
with code `regexp` and a message naming `snug/unicode`. `Cs` matches nothing;
surrogates cannot occur in text. The Bindle wire profile refuses
noncharacters before regexp matching; the deterministic preset (the default)
admits them. [Category details](cddl-support.md#unicode-regexp-categories).

Compile where the tables are available, then serialize the Program for a
validation-only bundle. The runtime and Program loader need no Unicode
module. Table contents are included in the source key; even schemas without
category escapes get a different key when compiled with supplied tables.
There is no change to the Program format.

For basic ASCII patterns and both JS/CDDL escaping layers, see the
[regexp cookbook](cddl-support.md#regexp-cookbook). Cross-host generation
and maintenance evidence is recorded in [P7.3](../DEVLOG.md#phase-7--standalone-library-d080-2026-11-03)
and the [table measurement](../bench/README.md#unicode-table-module-p73).

## Custom controls

CDDL cannot say "at most 3 characters", "no duplicates" or "these columns have
the same length". Register a control and the schema can, without forking snug:

```js
import { compile } from 'snug/compile';
import { controls } from 'snug/controls';            // .chars, .unique, .samelen
import { encode } from 'snug';

const schema = await compile(`
  user  = { name: tstr .chars (1..32), tags: [* tstr] .unique true }
  table = { x: [* float], y: [* float] } .samelen ["x", "y"]
  even  = bstr .even 0`, {
  controls: {
    ...controls,
    even: { check: (argument, item) => item.length % 2 === 0, maxBytes: 4096 },
  },
});
schema.validate(encode({ name: 'Zoë', tags: ['a', 'b'] }), 'user');   // { ok: true }
schema.validate(encode({ name: 'Zoë', tags: ['a', 'a'] }), 'user');
// { ok: false, reason: 'control', path: ['tags'], offset: … }
```

`target .name argument` means *the target, and the predicate holds*: the
compiler lowers it to an ordinary AND of the target's leaves and an extension
leaf, so exactness under choices is unchanged — `(tstr .chars (1..3)) /
(tstr .size 10)` accepts `"0123456789"` through the second alternative. A
predicate receives the CBOR **encoding** of the argument (an integer, text,
bytes, a named simple value such as `true`, a range `lo..hi` as `[lo, hi]`,
or an array of those) and the item's **whole encoding**, already checked by
the wire profile. Only a strict `true` matches. The generic controls:

| Control | Item | Argument |
| --- | --- | --- |
| `.chars` | a text string of n / lo..hi Unicode code points | `n` or `lo..hi` |
| `.unique` | an array whose elements' encodings are pairwise distinct (so `1` and `1.0` differ) | anything, conventionally `true` |
| `.samelen` | a map whose named members, where present, hold arrays or typed arrays with one element count | a name or an array of names |

**Rules for a predicate.** It must be a pure function of its two inputs: no
I/O, clock, randomness, state, and no call back into snug (validation holds
the shared scratch; a re-entrant call throws). The VM asks it only for an item
its leaf is queried for, at most once per item, never for an item already
refused. An item longer than `maxBytes` (default 65,536) fails with the reason
`control_size` *without asking*; streams therefore never buffer more than `maxBytes` for a
control, and every source gives the same answer. If a predicate throws, the
call throws an `Error` whose `cause` is the original (the verdict is void).
An optional `argument(bytes) => boolean` is checked once per use at compile
time (`control_value` when false); the generic controls check theirs.

**Budget: a predicate's CPU is yours.** Each call costs 17 budget units, then
the predicate's **cost**, charged *before* it runs: by default one unit per
item byte, or what `cost(itemBytes)` answers (a non-negative integer). When
the cost is more than the budget has left, validation stops with `budget` and
the predicate is not called. snug cannot interrupt or measure host code, so
the cost is the host's promise: the default budget (2.25 M units) is sized for
about 20 ns of CPU per unit, and a predicate that does more work per byte
should declare it, or a hostile message can spend more CPU in it than the
budget suggests.

```js
// A predicate that does ~1 µs of work per item byte declares ~50 units per byte.
const registry = { ...controls, sig: { check: verifySignature, cost: n => 64 + 50 * n } };
```

The generic controls meter their own work in kin instead (a linear pass for
`.chars` and `.samelen`, hashing plus an O(n log n) sort for `.unique`, each
step charged as it happens, program.md §14), so JS and Rust charge them
identically and a run that would pass the budget stops in the middle.

**Errors and caching.** An unregistered `.name` is the `SchemaError`
`unknown_control`, and its message names the control. A Program that uses a
control is format 1.1 (others stay 1.0); its source key includes the whole
registry — names and `maxBytes` — so a cache keyed by `program.sourceKey`
never mixes registries. Loading needs the predicates again:
`fromSerialized(bytes, { controls })` (or `fromProgram(P, B, { controls })`);
a missing one is `ProgramError('missing_control')`, naming it.
`program.controls` lists the names a Program uses. The `bus` compiler profile
refuses extension controls unless `controlsInBus: true`. Rust: `snug::controls`
(`Control` trait objects, `Controls::generic()`, `CompileOptions::controls`,
`Schema::from_serialized_with`).

## Validate hostile bytes without decoding

```js
const result = schema.validate(Uint8Array.of(0xbf, 0xff), 'message');
if (!result.ok) console.log(result.reason, result.path, result.offset);
```

`validate` returns `{ ok: true }` or
`{ ok: false, reason, path, offset, subcode? }`. It does not build the data
tree. The validator checks the wire profile (the deterministic preset by
default, `wire: 'bindle'` for the Bindle one) while matching all live CDDL
alternatives; one compiled Program validates under either. On schema failure it continues checking the
profile; a profile error wins, unless the global step budget runs out first.
Missing rules, wrong argument types and SharedArrayBuffer input are API
misuse (`TypeError`), not validation results.
Malformed options and unknown keys throw TypeError before checking bytes;
the same shared option validator serves codec, schema, view, Writer and
source entry points. Invalid known values name the option without echoing
its value; unknown-key errors list allowed names. Resource exhaustion under
valid configuration remains a validation result.

A failure is one deterministic witness, not an exhaustive error list or an
explanation of the branch your application intended. For example:

```js
const response = await compile(`response = { ok: true, id: uint }
  / { ok: false, error: tstr .size (1..120) }`);
response.validate(encode({ ok: false, id: 7 }), 'response');
// { ok: false, reason: 'value', path: ['ok'], offset: 8 }
```

Here `false` is valid in the second alternative, but the whole message fits
neither. Do not turn the witness into a claim that `false` is always invalid.

The buffer default for schema methods is `top: 'any'`. Pass `top: 'map'`
when the protocol requires a map independently of its schema. Buffer
validation borrows input only for the synchronous call. Copy concurrently
mutable data first. No logging step needs to include received bytes.

## Decode after checking

```js
import { encode, decode } from 'snug';
const bytes = encode({ id: 7, body: new Uint8Array([1, 2]) }, { maxBytes: 2048 });
const message = schema.decode(bytes, 'message');
const profileOnly = decode(bytes);
const array = decode(encode([1, 2]), { top: 'any' });
```

Schema decode validates, then materialises; codec decode checks the profile,
then materialises. A refusal throws `SnugFault`. Maps with only text keys
become null-prototype objects; `objects: 'plain'` opts into ordinary objects
with safe own data properties for names such as `__proto__`. A map with any
other key (integer, byte string, array, ...) becomes a `Map` with decoded
keys, at any depth; under `wire: 'bindle'`, `cose: true` makes a top-level
map a `Map` with safe integer and text keys. Codec decode accepts any root
under the default deterministic preset; `wire: 'bindle'` requires a map
unless `top: 'any'` is given. Tags outside the Bindle set (the standard
ones, COSE/CWT and any other number, D180) decode to `Tagged`, `f7` to
`undefined` ([profiles](profiles.md#javascript-values-d123)).

Major-0/1 integers become numbers when safe and bigints otherwise. Tags 2/3
become bigints; byte strings are copied `Uint8Array`s; typed arrays are copied
into aligned native storage; tag 4 becomes `Decimal`; tag 40 becomes
`NDArray`. Float16 data uses `Float16Bytes` where native `Float16Array` is
unavailable. Decimals refuse implicit numeric coercion and JSON serialisation.
Use `toString()` and an explicit application representation. All decimal
normalisation discards presentation scale.

Encoding admits any supported root. Codec checking accepts any root under
the deterministic preset and defaults to a map root under `wire: 'bindle'`
(there `decode(encode([1, 2]), { wire: 'bindle' })` throws `not_map`);
schema decode defaults to any root. Choose `top` explicitly for your
protocol.

| Input to encode | CBOR kind | Decoded JS type/value | CDDL type |
| --- | --- | --- | --- |
| `7n` | major 0 integer | number `7` | `uint` (also `unsigned`, `integer`) |
| `2 ** 53` | float | number | `float`, not `uint` |
| `2n ** 53n` | major 0 integer | bigint | `uint` (also `unsigned`, `integer`) |
| `2n ** 64n` | tag 2 bignum | bigint | `unsigned` or `integer`, not `uint` |

Negative integers use major 1 or tag 3; `integer` includes both signs and
bignums, while `int` includes only major 0/1. Numeric value is preserved,
not JS number/bigint identity. Use bigint before arithmetic exceeds Number's
safe domain: snug cannot recover precision already lost in a Number.

| Host map representation | Deterministic preset (default) | `wire: 'bindle'` |
| --- | --- | --- |
| Plain or null-prototype object | Text keys at any depth; decodes to a null-prototype object | the same |
| `Map` with any admitted keys, at any depth | Encodes, keys sorted by encoding; maps with a non-text key decode to `Map` | Refused, except a root `Map` of safe integer/text keys with `cose: true` |
| `Map` whose keys collide as JS values on decode (`1` and `1.0`) | decode refuses with `unsupported`; read it with a view | refused by the profile |

For an application Map whose keys must all be text, validate the key types
before conversion (avoid numeric-key stringification or collisions):

```js
function textMapObject(map) {
  const object = Object.create(null);
  for (const [key, value] of map) {
    if (typeof key !== 'string') throw new TypeError('Text keys required');
    object[key] = value;
  }
  return object;
}
encode({ labels: textMapObject(new Map([['name', 'sample']])) });
// Apply the same conversion to nested Maps before encoding.
```

## Encode and write deterministic bytes

```js
import { Decimal } from 'snug';
import { Writer } from 'snug/writer';
const price = Decimal.from('1.50');
const encodedPrice = encode({ price, id: 7 }, { maxBytes: 256 });
const writer = new Writer({ maxBytes: 256 });
writer.beginMap(2).key('price').value(price).key('id').uint(7).end();
const sameBytes = writer.finish();
const prices = ['1.50', '2.00', '0.00'].map(text => Decimal.from(text));
// Decimal(15n, -1), number 2, number 0; Writer.value accepts all three.
const priceList = new Writer().value(prices).finish();
```

`Decimal.from` returns `Decimal | number | bigint`: integral results use
integer CBOR, including zero. `.decimal(d)` requires a known non-integral
Decimal; use `.value(Decimal.from(text))` for arbitrary factory results.
This is an exact numeric representation, not a fixed-scale money type.
`1.50` becomes `1.5` and `2.00` becomes `2`; scale is lost. For fixed-scale
money, define a protocol such as `{ currency: "USD", minor: 200 }`, using an
exact integer in minor units and explicit currency/scale rules, or preserve
a validated decimal string when presentation scale is part of the contract.

Map keys are ordered by their complete encoded bytes, independent of object
insertion order. Numbers that are safe integers encode as integers; other
admitted numbers use the shortest exact float width. `bigint` keeps exact
integer values, using a bignum tag beyond the 64-bit major-type domain.
`Uint8Array` is a byte string, not a tagged uint8 array. Other supported
typed arrays use the little-endian tags listed in [profiles](profiles.md).

The Writer writes exactly one root. Declare array item/map pair counts with
`beginArray(n)`/`beginMap(n)`, write each map key before its value, and call
`end()` when the declared content is complete. `finish()` returns a copy
and finishes the writer. `keysSorted: true` requires strictly increasing
encoded key order; otherwise `end()` sorts the map. A Writer error is sticky:
the first code is available as `failure`; later calls throw `writer_failed`.
`float(1)` writes the float `f93c00` under the deterministic preset and is
refused under `wire: 'bindle'` (use `int(1)` or `value(1)` for the integer).
`undefined()` writes `f7`, `tagged(tag, content)` a standard-set tag, and
`key(k)` takes any key the profile admits. There is no raw unchecked CBOR
insertion API.
Wrong-type calls such as `.text(7)`, `.uint('7')` and `.beginArray('2')`
also throw sticky `SnugFault('unsupported')`; discard the failed Writer.

Arrays encode elements at indexes 0..length−1. Extra named own properties,
including non-enumerable and symbol properties, are ignored without reading
their values, as with JSON.stringify. `strictArrays: true` retains the old
own-key count check and refuses extra properties with `unsupported`.
`encode(value, profiles.bindle)` and `new Writer(profiles.bindle)` select this
strict behavior (`profiles` is exported by `snug`). Both modes require genuine
arrays with exactly the local `Array.prototype`; subclassed, foreign-realm
and null-prototype arrays remain refused. Holes are refused in both modes;
a present undefined element encodes as `f7` under the deterministic preset
and is refused under `wire: 'bindle'`. A missing element is checked only when
its value reads as undefined, using `i in array`.

Plain/null-prototype objects with enumerable data properties, the documented
wrappers and the admitted scalars are also encodable. Classes, object
accessors and functions fail with `unsupported`. `omitUndefined: true` omits
undefined object members and symbol/non-enumerable object members; array
holes/undefined and enumerable object accessors remain refused. Writer.value
uses the same options and array behavior at every nesting level. Avoid proxies
or other executable objects at this boundary.

## Read selected fields through a view

```js
import { view } from 'snug/view';
const root = view(bytes, { schema, rule: 'message' });
const id = root.get('id');
if (id) console.log(id.number(), id.offset);
```

`view` checks the complete message before exposing a value. It copies first
by default, then validates the owned bytes. `borrow: true` avoids the copy;
the caller must keep bytes unchanged while **any** view, cursor or alias
remains live. SharedArrayBuffer is refused in both modes. `raw()` and
`bytes()` are aliases even on owned views: never mutate them. Use
`copyBytes()` for writable byte content or `new Uint8Array(v.raw())` for a
writable encoded span.
Mutation invalidates the check; snug does not detect it. Owned mode protects
against the original input, not against aliases obtained from the view:

```js
const original = encode({ id: 7 });
const owned = view(original);
const borrowed = view(original, { borrow: true });
original[original.length - 1] = 8; // deliberately violates borrowed lifetime
console.log(owned.get('id').number(), borrowed.get('id').number()); // 7, 8
owned.get('id').raw()[0] = 9; // deliberately invalidates owned check too
console.log(owned.get('id').number()); // 9; no revalidation
// Keep aliases read-only; copyBytes() or new Uint8Array(v.raw()) is writable.
```

Use `get(key)` on maps and `at(index)` on arrays; absent children return
`undefined`. `entries`, `keys` and `values` iterate in encoded order.
Negative or out-of-range integer array indexes return undefined; fractional
indexes throw TypeError. Conversion accessors on the wrong kind throw
TypeError; `isNull()` is a predicate returning false on other kinds, on both
View and Cursor.
`number()` throws `RangeError` for an unsafe integer; `bigint()` is exact;
`int()` chooses either. `typedView()` offers unaligned little-endian element
access without copying; `typed()` and `value()` materialise copies.
`length` means entries, UTF-8 bytes, byte content or typed-array elements
depending on kind. It is undefined for other scalar kinds.

A mutable `Cursor` avoids a new child View at each step:

```js
const cursor = root.cursor();
if (cursor.enter()) {
  do { console.log(cursor.key, cursor.kind); } while (cursor.next());
  cursor.up();
}
```

`enter` moves to the first child, `next` to the next sibling, `up` to the
parent. A false result leaves the cursor where it was. `find(key)` descends
from a map to its value. `keyIs(text)` compares a key without decoding it.
The experimental `directories: true` option builds lazy per-container
offset tables for containers with at least eight children; it spends memory
to speed repeated lookups. No trusted unchecked opener or full tape is public.

## Validate a nested span

```js
const nestedResult = root.get('id').validateAt('identifier');
// Or: schema.validateAt(bytes, start, end, 'identifier', { depth: knownDepth })
```

This is **detached** validation: it asks whether that item matches the
named rule as its own document. It does not prove an enclosing map, sibling
constraint or ancestor alternative. View validation continues the original
depth, restarts item counting, uses `top: 'any'`, and allows `cose` only at
the root. Failure offsets are absolute in the containing message; paths
start at the detached item. Span `end` is exclusive. Supply a schema to
`v.validateAt(rule, { schema })` if the view was opened without one.

## Validating remote objects and streams

```js
import { asyncHandle, validateHandle, pushValidator } from 'snug/sources';
const result = await validateHandle(schema, asyncHandle(bytes), 'message');
// Same ValidationResult as schema.validate(bytes, 'message'); no decoded tree.
```

```js
import { SourceError } from 'snug/sources';
try {
  const checked = await validateHandle(schema, asyncHandle(bytes),
    'message', {}, { chunk: 16384, quantum: 4096 });
  if (!checked.ok) console.log(checked.reason, checked.path, checked.offset);
} catch (error) {
  if (error instanceof SourceError) console.log(error.code); // adapter failure
  else throw error; // API misuse or transport failure; sanitise before logging
}
```

**Handles need a known length**, in bytes, before validation starts: handle
`size`, Content-Length or an application framing header. It must be an exact
integer in 0..2^31−1, subject to the schema's input limit. A stream whose
length is not known is validated in drain mode instead (below).
Source decoding is unavailable; these APIs validate without materialising.

A handle is `{ size, read(offset, length) }`, with reads returning a Uint8Array
or Promise of one. It must supply **one immutable snapshot** for the entire
validation: fixed size, identical bytes on every read, including rereads.
Version pinning is the caller's responsibility. For remote objects, capture
an object generation or ETag and enforce it on every range request (for
example, If-Match); fail the read if the snapshot is unavailable. snug does
not check a version field or detect remote mutations. Return exactly the
requested range and keep the returned bytes unchanged while used. The
[async in-memory example](../examples/validate-handle.mjs) needs no network.
`bufferHandle` and `asyncHandle` own a copy of Uint8Array and Node Buffer
input, including subranges. Later input mutation cannot change the snapshot.
Each read returns a fresh copy, so modifying a read cannot change subsequent
reads either. Handles are frozen; SharedArrayBuffer input is refused.

`validateHandleSync(schema, handle, rule, options?, sourceOptions?)` has the
same result contract for synchronous handles and refuses Promise reads.
Reads occur on demand, one at a time. Use a positive integer `chunk` size
(default 65536); requests may be larger to satisfy a VM need. `quantum`
defaults to 0, disabling scheduling yields; a positive value up to 2^31−1
enables them. The async driver gives the event loop a turn on yields through
the available scheduler, while the sync driver continues immediately. Yields
change neither verdict nor budget and do not reset a runtime's CPU allowance.
Set transport deadlines in your handle implementation.
Default `asyncHandle` reads resolve through Promise microtasks, not one
event-loop turn per read; `quantum` supplies cooperative scheduling.

For an ordered push source with a declared length:

```js
async function validateChunks(schema, chunks, length, rule) {
  // chunks: AsyncIterable<Uint8Array>, with an exact length from trusted framing.
  const push = pushValidator(schema, length, rule, {}, { quantum: 4096 });
  for await (const chunk of chunks) {
    let step = push.feed(chunk);
    while (step.state === 'yield') {
      await new Promise(resolve => setTimeout(resolve, 0));
      step = push.resume();
    }
    // Continue delivering after done, even if step.result is a refusal.
  }
  return push.finalize(); // unconditional on normal EOF, including early done
}
async function* exampleChunks(bytes) {
  for (let offset = 0; offset < bytes.length; offset += 16384)
    yield bytes.subarray(offset, offset + 16384);
}
const pushedResult = await validateChunks(schema, exampleChunks(bytes), bytes.length, 'message');
```

On transport exception, discard the session and propagate the failure; do
not convert it into a successful result by finalizing a partial stream.

Feed in order on `need`. A `yield` means stop feeding, give the event loop a
turn, then call `resume()` until it needs input or finishes. Empty chunks are
not EOF. `done` includes `result`, which may arrive before all bytes do.
Deliver the remaining bytes and **always call finalize**, even after an early
success or refusal: only finalize checks the delivered count. It returns the
ValidationResult and runs any remaining work synchronously. The adapter
retains bytes required for replay; some schema checks can retain a large span,
so buffering is bounded by the declared length rather than a fixed chunk size.

Each validation has exclusive session state across every await. Immutable
Programs can be shared, and independent sessions can interleave; never resume
one session concurrently. There is no live-session quota or pool, so bound
concurrency in the application. Advanced custom drivers can call
`openSession(schema, rule, length, options?, { quantum? }?)` from `snug/sources`
for a `VmSession` with `step(window, base)`, `length` and `bytesHeld`; its need/yield/keep protocol
is in the [API reference](api.md#sources-snugsources). Scratch
and verified Program arrays stay private. Discard sessions after completion
or failure.

CBOR/CDDL/budget refusals are results, identical to buffer validation.
Broken adapter contracts throw/reject with `SourceError` (`bad_chunk`,
`short_read`, `length_mismatch`); these are source failures, never validation
verdicts. Read exceptions/rejections propagate unchanged, so sanitise
transport errors before logging. Unknown rules/API misuse use TypeError.
The profile-only `scanBuffer`, `scanHandle`, `scanHandleSync`, `pushScanner`
remain available: profile refusals throw SnugFault, buffer success returns
undefined, and handle scanning / push finalize return true.

### Streams of unknown length

```js
import { streamSource, validateStream, scanStream, pushValidator } from 'snug/sources';
const res = await fetch(url);                       // no Content-Length needed
const result = await validateStream(schema, streamSource(res.body), 'message');
// the same ValidationResult as schema.validate(allTheBytes, 'message')

const quick = await validateStream(schema, streamSource(res2.body), 'message', {},
  { failFast: true });                              // a refusal as soon as it is certain
await scanStream(streamSource(chunks));             // profile only: true or SnugFault
const push = pushValidator(schema, undefined, 'message');   // feed(chunk) ... end()
```

Pass `undefined` as the length (or use `validateStream` / `scanStream` with a
`streamSource` of a ReadableStream, an AsyncIterable or an Iterable of
Uint8Array). snug then validates in **drain mode** (D085): it walks the bytes
as they come, exactly as with a known length, but every check that depends on
where the message ends — a length or count reaching past the bytes seen,
trailing bytes after the root, `too_large` — is held until the stream ends.
A verdict found earlier is held too, and the rest of the stream is read and
dropped (never kept). So the result is **identical to a buffer of the same
bytes**: code, offset, path, budget and items (gated on every corpus and
mutation input under random chunking). More bytes than `maxBytes` end the
stream at once with `cbor/too_large`, and a stream ending inside an item is
`cbor/truncated` where the buffer would say so. EOF is the stream's end (or
`push.end()` / `finalize()`); an empty chunk is not EOF.

`failFast: true` answers a **certain refusal** as soon as it is found and
stops reading. It never accepts what the buffer refuses and never refuses what
it accepts, but its code may differ: the whole stream might have been
`cbor/too_large`, or ended inside an enclosing item (`cbor/truncated`), and
the buffer reports that first. Acceptance always waits for the end.

Memory stays bounded: the driver holds only what the session asks for (a
head, a key, a bounded piece, an extension control's item) plus a chunk; a
long byte string is dropped as it streams. The session's own key arena is
sized for the input limit (`maxBytes`, default 1,500,000 bytes) because the
length is unknown — lower `maxBytes` for many concurrent streams. A raw
`openSession(schema, rule, undefined)` from `snug/sources` exposes the
protocol: `step` may answer
`{state: 'held', result}`, and `end(n)` settles the verdict (or answers a
`yield` to step on over the bytes it still holds).

Standard Blob/File/HTTP Range adapters and fused source decode remain pending.

## CBOR sequences and SSE

A CBOR sequence (RFC 8742, media type `application/cbor-seq`) is messages
written back to back with no framing: the natural body for a long-lived,
server-sent-events-like HTTP response. `readSequence` reads one and hands you
each message as soon as its last byte has arrived, already checked, as a lazy
View:

```js
import { readSequence } from 'snug/sequence';
const schema = await compile('event = { type: tstr, seq: uint, ? text: tstr }');

const abort = new AbortController();           // abort() cancels even while waiting for bytes
const res = await fetch(url, { headers: { accept: 'application/cbor-seq' }, signal: abort.signal });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
if (!res.headers.get('content-type')?.startsWith('application/cbor-seq')) throw new Error('not a CBOR sequence');
if (res.body === null) throw new Error('no body');
let expected = 1;                               // the application's own sequence numbers
for await (const m of readSequence(res.body, { schema, rule: 'event' })) {
  const seq = m.view.get('seq').number();       // reads the fields it needs, decodes nothing else
  if (seq !== expected) resync(expected, seq);  // a gap: reconnect / replay by your protocol
  expected = seq + 1;
  if (m.view.get('type').text() === 'note') show(m.view.get('text').text());
}
```

Check the HTTP status, the media type and a non-null body before reading.
Leaving the loop cancels the body, but an async generator cannot interrupt a
read that is still waiting for the network: cancel with the fetch's
`AbortController` (the pending read then rejects and the loop throws). RFC
8742 framing cannot tell that a whole final message never arrived (the
stream simply ends at a boundary), and it has no retry semantics: use your
own sequence numbers or end marker and reconnect rules when completeness
matters.

The [runnable example](../examples/sequence-sse.mjs) simulates such a response
locally. Each message `m` is `{ index, offset, length, bytes, borrowed, view }`:
its position in the sequence, the absolute byte offset of its first byte, its
exact encoding, and a View (`m.view.value()` materialises it when you want a
plain value).

**One pass per message.** The same walk finds where a message ends and checks
it — the wire profile, and the schema rule when you give one — so the View is
opened from that verdict without scanning again. Without `schema` each message
is profile-checked only. An **accepted** message's verdict is exactly what
`schema.validate` (or `decode`'s check) gives for that message's bytes, and a
schema refusal of a complete message likewise (offsets made absolute). A
message that does not complete has no bytes of its own: its refusal is the
buffer check's over the bytes from its start up to `maxMessageBytes` (the
following messages' bytes included), so a truncation inside a tag-24 payload
can be `cbor/too_large` when more than `maxMessageBytes` bytes follow while
the same bytes alone say `cbor/truncated` (architecture §18.1). All of this is
gated by `bb sequence-test` under every chunking.

**Delivery.** A message is yielded as soon as its own last byte has arrived:
the walk never waits for bytes past the message's end (gated: every accepted
message, with one-byte chunks, is released by the feed that completes it).
`readSequence` checks one message ahead of your loop, so `break` stops the
work at the next boundary; the push reader returns all the messages a chunk
completes. Single-document APIs
(`decode`, `view`, `validateStream`, …) still refuse a second root as
`cbor/trailing`; sequences are only read by these functions.

**Limits are per message.** `maxMessageBytes` (default 1,500,000 bytes, or the
schema's compiled input limit) bounds each message: one that does not end
within it is `cbor/too_large`, decided without buffering it. `maxDepth`,
`maxEntries`, `maxItems`, `maxBignumBytes` and `budget` start from zero for
every message. `maxBytes` is refused (it would be ambiguous). There is no
total cap: stop by leaving the loop, which cancels the stream. Each reader
holds a key arena of `maxMessageBytes` bytes, so lower it for many concurrent
readers.

**Refusals.** By default (`onInvalid: 'stop'`) the first refused message ends
the sequence: every earlier message has been yielded, then the loop throws a
`SnugFault` with `code`, `reason`, `path`, `offset` (absolute), `index`,
`messageOffset` and `skippable` — never payload. Messages already yielded
are not revoked. `onInvalid: 'skip'` skips a message only when its framing is
intact: the whole message passed the profile check and failed the schema
(`skippable: true`). A profile refusal (`cbor/*`, including truncation and the
limits) or `budget` always stops: CBOR has no safe point to resynchronise
after a malformed item. The iterator's `stats` (`messages`, `skipped`,
`bytes`, `lastSkipped`) tell you what was skipped.

**End of input.** The stream ending at a message boundary ends the loop —
an empty body is an empty sequence. Ending inside a message is
`cbor/truncated` with that message's index. `failFast: true` reports a
refusal as soon as it is certain (a message whose head already claims more
than `maxMessageBytes` is then `cbor/truncated` instead of waiting to tell it
from `too_large`).

**Borrowed bytes.** A message lying wholly inside one chunk is a subarray of
that chunk (`borrowed: true`, no copy); one spanning chunks is assembled into
a fresh buffer of its own. snug never writes to a chunk, but a borrowed
message and its View alias it, so the default `copy: 'spanning'` is safe only
when the producer never mutates, recycles or transfers a chunk's buffer after
handing it over. A `fetch` body's byte stream meets that requirement. A
default `ReadableStream` reader does not by itself: it hands over whatever
object the producer enqueued, so an arbitrary stream (or a custom Node
stream, a pooled-buffer source, a BYOB adapter that passes the previous view
back to `read`, a push caller that reuses its chunk after `feed`) needs
`copy: 'always'`, which gives every message a plain copy (Node `Buffer`
chunks included). A retained borrowed message keeps its whole chunk's buffer
alive. SharedArrayBuffer chunks are refused.

**Errors that are not refusals.** An extension predicate that throws ends the
sequence after the messages before it: `readSequence` yields those, then
throws; the push reader returns them with the exception as `error`. Transport
failures (a rejected read, a network error) pass through unchanged, as for
the other sources — they are not SnugFaults or SourceErrors and may carry
arbitrary text: sanitise before logging. A non-Uint8Array chunk is
SourceError `bad_chunk`.

**Push.** Without an async source, `sequenceReader(options)` gives
`feed(chunk)` and `end()`, each answering `{ messages, skipped, error }`;
after an `error` the reader is done. `quantum` (readSequence only) adds
scheduling yields inside long messages.

Rust has the same reader: `snug::read_sequence(reader, &SequenceOptions)` /
`Schema::read_sequence(reader, rule, &options)` iterate owned messages over
any `Read`, and `Schema::sequence` / `Sequence::new` give a push reader whose
`feed(&chunk)` answers messages borrowing the chunk (`Cow::Borrowed`) or
owning their assembly ([Rust guide](rust.md#cbor-sequences)).

## Limits

Configure compile-time policy inside `limits`, then optionally lower it per
validation call. The vocabularies differ:

| Compile `limits` | Runtime schema / codec | Writer top level or `limits` |
| --- | --- | --- |
| `inputBytes` | `maxBytes` | `maxBytes` (output acceptance only) |
| `depth` | `maxDepth` | `maxDepth` |
| `entries` | `maxEntries` | `maxEntries` |
| `items` | `maxItems` | `maxItems` |
| `bignumBytes` | schema `maxBignumBytes` | fixed profile bound |
| `budget` | schema `budget` | no public VM budget |
| `schemaBytes`, `compileBudget`, other compiler resources below | no equivalent | no equivalent |

```js
const bounded = await compile('message = { id: uint }', {
  limits: { inputBytes: 2048, depth: 8, entries: 16, items: 64, budget: 10000 },
});
const checked = bounded.validate(encode({ id: 7 }), 'message', {
  maxBytes: 1024, maxDepth: 4, maxEntries: 8, maxItems: 32, budget: 5000,
});
const output = new Writer({ limits: { maxBytes: 1024, maxDepth: 4,
  maxEntries: 8, maxItems: 32 } }).value({ id: 7 }).finish();
```

| Supplied limit | Current operational meaning |
| --- | --- |
| Omitted | Compiler uses defaults; schema calls inherit compiled caps; codec uses `LIMITS`; encode/Writer have no output byte cap unless explicitly supplied |
| Zero | A real zero bound, never “unlimited” (except the fixed compiler bignumBytes policy): zero input/items/budget can compile but refuse messages; zero schemaBytes/compileBudget refuses compilation; depth zero still admits an untagged scalar with `top: 'any'` |
| Valid integer above compiler hard ceiling | Clamped to the effective ceiling, not rejected; `bus` schemaBytes remains at most 16 KiB |
| Valid per-call value above compiled cap | Effective value is the smaller of call and compiled cap; it cannot raise the cap |
| Invalid type, negative, fractional, NaN, Infinity or unsafe integer | All public option bags reject with TypeError (async APIs reject their Promise); no coercion and no data refusal |
| Unknown key | TypeError at every public boundary, including compile/Writer grouped limits and source/scheduling bags; the error lists permitted names without echoing unknown keys |

There is no read-only effective-limits object on public Schema. Keep your
validated policy beside it and account for the documented clamps; sourceKey
identifies effective compilation inputs but is not a limits inspection API.
The shared host validator checks exact allowed names, finite non-negative
safe integers, booleans and enum strings before checking CBOR or reading a
source. Known fields set to undefined use defaults; null is malformed.
Options bags must be ordinary or null-prototype objects. See the complete
[per-entry-point option tables](api.md#option-admission). Writer grouped
limits override top-level spellings; both bags are validated even when a
grouped value overrides a top-level one. Use just one spelling.

```js
schema.validate(bytes, 'message', { maxDepth: 1.5 }); // throws TypeError naming maxDepth
schema.validate(bytes, 'message', { top: 'banana' }); // throws TypeError naming top
decode(bytes, { maxByets: 1024 }); // throws TypeError listing allowed options
// At compile time the byte limit is limits.inputBytes, not maxBytes:
const small = await compile('message = { id: uint }', { limits: { inputBytes: 1024 } });
```

Complete presets can still be spread into every runtime options bag:
`strictArrays` is ignored while reading and `top` while writing, but their
types are checked. Compile options are separate (`profile`, `regexp`, `limits`, `unicode`);
wire presets belong on validation/codec/view/Writer/source calls.

| Resource | Default | Hard ceiling for compiled schemas |
| --- | --- | --- |
| Schema UTF-8 bytes | 262,144 (`bus`: 16,384) | 1,048,576 |
| Parser nesting | 64 | 256 |
| AST nodes | 65,536 | 1,048,576 |
| Generic instantiations | 1,024 | 16,384 |
| Map alternatives per sequence | 64 | 1,024 |
| Array positions | 256 | 4,096 |
| Regexp positions | 256 | 512 |
| Reachable leaves per depth | 256 | 4,096 |
| Leaves | 65,536 | 1,048,576 |
| Pool bytes | 1 MiB | 16 MiB |
| Program + pool + scratch | 8 MiB | 64 MiB |
| Compile work units | 10,000,000 | 2³¹−1 |
| Input bytes | 1,500,000 | 2³¹−1 |
| Depth | 32 | 256 |
| Entries per container / items per document | 65,536 / 131,072 | 2²⁴ each |
| Bignum content bytes | 128 | Currently fixed at 128 |
| Validation work units | 2,250,000 | 2³¹−1 |

Root depth is 0. Entering an array, map or tag consumes a level; their
children are at depth +1. With maxDepth 1 a root array of scalars is allowed,
but a nested container is not. Map keys and values are both visited items;
maxEntries counts map pairs or array elements per container, not bytes.
maxItems counts the root, containers, keys, values and tags across the
document, not just leaves. Tags 2/3 and typed-array tags count as one item
with a specially checked byte payload, not one item per native element or
an extra bstr item. Tags 4/40 also count their inner arrays and elements.
Text/byte-string content bytes are not items; maxBytes counts the complete
encoded document. Embedded `.cbor`/`.cborseq` checks restart item accounting
but share the VM budget and remain physically depth-bounded. `validateAt`
continues depth but restarts items unless explicitly seeded.

Compile limit names are in the [API reference](api.md#compilation).
Runtime schema options are `maxBytes`, `maxDepth`, `maxEntries`, `maxItems`,
`maxBignumBytes`, `budget`; they can only lower compiled values. Bignum
content still has the scanner's 128-byte ceiling even if other format fields
suggest a higher future maximum. Compiler bignumBytes requests currently
leave the fixed 128-byte cap unchanged; schema maxBignumBytes can lower it.
LIMITS also fixes decimal exponent ≥−1024
and ndarray dimensions ≤8.

Codec/view-without-schema/profile-source options expose the four ordinary `max*`
limits. Schema source validation also exposes the VM budget. Writer
`limits` can group those four options; top-level names are also accepted.
Encoding only checks an explicitly supplied `maxBytes` **at finish** after
buffer growth: it bounds output acceptance, not peak allocation. Bound
constructed values and concurrent encodes as well. A depth bound stops
ordinary cyclic objects but does not make arbitrary getters/proxies safe.
Compilation and synchronous validation cannot be cancelled mid-call by a
timer; isolate especially hostile work in a worker/process when necessary.

## Programs, caching and compatibility

```js
import { fromSerialized, ProgramError } from 'snug/schema';
const cacheKey = schema.program.sourceKey; // SHA-256 hex, source + effective options
const stored = schema.program.serialize(); // synchronous Uint8Array
let cached;
try {
  cached = await fromSerialized(stored); // no compiler loaded
} catch (error) {
  if (!(error instanceof ProgramError)) throw error;
  console.log(error.code); // evict corrupt/incompatible entry; rebuild from trusted CDDL
  throw error;
}
```

Every public Program verifies before use and owns copies of its arrays.
`program.P` and `program.B` return copies for advanced interchange;
`fromProgram(P, B)` also verifies. They are not generated-module imports.
The cache key already includes the snug version; effective defaults are
normalised by kin (D039). The frozen source-key list does not include the
leaf limit: a successful compile's Program is the same under either leaf cap.

The 96-byte header carries `snugprog`, container version 1, format 1.0,
word/pool lengths, a NUL-padded ASCII producer version, SHA-256 content digest
and zero reserved bytes. Words are written/read little endian with DataView.
The digest covers the whole container except its own 32 bytes. See
[program.md §13.3](program.md#133-serialisation-container).

The current [D084 rule](../DEVLOG.md#d084--a-stable-versioned-serialised-program-with-a-compatibility-rule) is: format major
must equal the loader's, minor must be no greater than the loader's. In the
32-bit format word, low 16 bits are major and high 16 bits are minor; 1.0
therefore retains word value 1. Current loader 1.0 refuses every newer minor.
The producer snug version is retained as provenance and may differ. Every
load checks framing/digest and runs kin's structural verifier. Deterministic
bytes round-trip, including accepted producer metadata.

**Use trusted caches.** Neither the digest nor structural verification
authenticates a Program or proves semantic compiler properties such as map
determinism. An attacker can manufacture another valid Program and recompute
its digest. Load CDDL from an untrusted party through bounded compilation,
not through its supplied Program. Limit cache entries/bytes and evict by
application policy. Share immutable public Programs; synchronous validation
uses a shared per-isolate scratch lease. Async source sessions own their
state. There is no supported re-entrant internal VM API.

Because the package is still 0.0.0, namespace application caches by the pinned
repository/package revision as well as sourceKey. This is conservative cache
management, not a producer-version equality requirement.

At build time, compile trusted CDDL and save `schema.program.serialize()`
as a trusted artifact. At startup, load it once with `fromSerialized`, retain
the Schema and reuse `validate` for requests. Both loaders return Promises
for an awaitable facade consistent with compile; neither offloads verification.
`new Program(P, B)` verifies synchronously and throws synchronously. A Promise
does not make compilation/verification cancellable or background work.

For hostile compilation in Node, use a separate worker with application
deadlines and a live-worker quota. For example, these two files in the local
consumer project keep compilation off the parent event loop:

```js
// compile-worker.mjs
import { parentPort, workerData } from 'node:worker_threads';
import { compile, SchemaError } from 'snug/compile';
try {
  const schema = await compile(workerData, { profile: 'bus',
    limits: { schemaBytes: 16384, compileBudget: 1000000 } });
  const stored = schema.program.serialize();
  parentPort.postMessage({ stored }, [stored.buffer]);
} catch (error) {
  parentPort.postMessage({ code: error instanceof SchemaError ? error.code : 'compile_failed' });
}
```

```js
// isolated-compile.mjs (Node; bound input and concurrent workers in the caller)
import { Worker } from 'node:worker_threads';
import { fromSerialized } from 'snug/schema';
export async function isolatedCompile(text, timeoutMs = 30000) {
  const worker = new Worker(new URL('./compile-worker.mjs', import.meta.url), { workerData: text });
  try {
    const stored = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('compile_timeout')), timeoutMs);
      const fail = error => { clearTimeout(timer); reject(error); };
      worker.once('error', fail);
      worker.once('exit', () => fail(new Error('compile_worker_exited')));
      worker.once('message', message => {
        clearTimeout(timer);
        if (message.stored) resolve(message.stored);
        else reject(new Error(message.code));
      });
    });
    return await fromSerialized(stored); // trusted local producer; verification still synchronous
  } finally {
    await worker.terminate();
  }
}
```

Choose timeoutMs and concurrency for your deployment; the example default
is an application deadline, not a performance guarantee. This isolates
compilation, not parent-side Program verification. A separate
process can impose a stronger memory boundary when required.

## TypeScript onboarding

CDDL validation does not infer a TypeScript interface. `schema.decode`
returns the recursive `Value` union; narrow it or implement a checked domain
wrapper. There is no inferred `decode<T>()` contract.

In the ESM consumer from the README, save this as `main.ts`:

```ts
import { encode } from 'snug';
import { compile } from 'snug/compile';
import type { ValidationResult } from 'snug/schema';

const schema = await compile('message = { id: uint }');
const bytes = encode({ id: 7n });
const result: ValidationResult = schema.validate(bytes, 'message');
if (!result.ok) {
  console.log(result.reason, result.path, result.offset); // union narrowed here
  throw new Error('message refused');
}
// ValidationResult does not narrow an independently decoded Value.
const decoded = schema.decode(bytes, 'message');
if (decoded === null || typeof decoded !== 'object' || !('id' in decoded))
  throw new Error('expected message object');
const id = decoded.id;
if (typeof id !== 'number' && typeof id !== 'bigint')
  throw new Error('expected exact integer');
const message: { id: number | bigint } = { id };
console.log(message.id, 2n ** 53n);
```

Use `package.json` with `"type": "module"` and this `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"], "strict": true, "noEmit": true
  },
  "include": ["main.ts"]
}
```

ES2022 includes bigint and modern typed arrays; DOM supplies console in this
small example without installing Node declarations. A `.mts` file is also
ESM (adjust `include`); a `.ts` file needs the package's ESM setting above.
Run an already available `tsc -p tsconfig.json`; no compiler install is needed
for the JS package. Consumer evidence on 2026-11-03: TypeScript **5.8.3**
from an existing offline language-server dependency checked this example
against the staged package with these options. `bench/compare/node_modules/.bin/tsc`
was absent. This is the tested compiler version, not a claim for every TS release.

## Browser and Worker recipes

Use the staged consumer package; bare specifiers need a bundler (or an
application import map). With an already available esbuild, from the consumer
directory create `browser.mjs`:

```js
import { encode } from 'snug';
import { compile } from 'snug/compile';
const schema = await compile('message = { id: uint }');
document.body.textContent = JSON.stringify(schema.validate(encode({ id: 7 }), 'message'));
```

```sh
# Set SNUG_ESBUILD to an absolute existing binary; do not use npx/downloads.
"$SNUG_ESBUILD" browser.mjs --bundle --format=esm --platform=browser \
  --target=es2022 --splitting --outdir=browser-dist
```

Load `<script type="module" src="./browser-dist/browser.js"></script>`
from a locally served HTML file. Retain all emitted chunks and their relative
paths. `--splitting --format=esm --outdir` preserves the compiler's dynamic
import. A one-file bundle ships compiler bytes even if initialisation waits
until the first call. For CSP, use same-origin external scripts/chunks and
`default-src 'self'; script-src 'self'`; no `unsafe-eval` is needed in the
recorded evidence. CSP and a local HTTP origin must permit chunk loading.

For a compiler-free module Worker, generate a trusted Program before bundling:

```js
// prepare.mjs — run with Node, once at build time
import { writeFile } from 'node:fs/promises';
import { compile } from 'snug/compile';
const schema = await compile('message = { id: uint }');
await writeFile('program.json', JSON.stringify(Array.from(schema.program.serialize())));
```

```js
// worker.mjs — no snug/compile or snug/unicode import
import stored from './program.json'; // bundled by esbuild's JSON loader
import { fromSerialized } from 'snug/schema';
const ready = fromSerialized(Uint8Array.from(stored)); // one startup verification
export default {
  async fetch(request) {
    const schema = await ready;
    const bytes = new Uint8Array(await request.arrayBuffer());
    return Response.json(schema.validate(bytes, 'message'));
  },
};
```

```sh
node prepare.mjs
"$SNUG_ESBUILD" worker.mjs --bundle --format=esm --platform=browser \
  --target=es2022 --outfile=worker-dist/worker.js
```

This minimal Worker buffers the request: enforce transport size/deadline and
concurrency policy before using it with untrusted traffic. Retain the trusted
Program provenance. Startup verification still costs CPU; moving it to module
scope was suggested, not measured, in P7.7. For a Worker that compiles at
runtime, use the browser recipe's split flags and register **every** emitted
chunk as an `esModule` in workerd's config. For the compiler-free bundle a
minimal local `worker-dist/config.capnp` is:

```capnp
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "app", worker = (
    modules = [(name = "worker.js", esModule = embed "worker.js")],
    compatibilityDate = "2025-12-01"
  ))],
  sockets = [(name = "http", address = "127.0.0.1:8787", http = (),
    service = "app")]
);
```

Run an existing native binary with
`"$SNUG_WORKERD" serve worker-dist/config.capnp`; no deployment is required.
To reproduce the fuller local browser/workerd checks, from the repository:

```sh
SNUG_ESBUILD=/absolute/path/to/esbuild SNUG_WORKERD=/absolute/path/to/workerd \
  node tools/runtime/run.mjs --package .cache/docfix/staged --out .cache/docfix/runtime
```

The harness serves loopback only, runs Chrome and local workerd, and writes
`results.json`. It needs those existing tools (Chrome may be set with
`SNUG_CHROME`); it does not install them. See [method and fixtures](../tools/runtime/README.md).
These recipe commands are not a claim of a new browser/runtime gate run.

Recorded evidence, **2026-11-03**, staged revision **f275938** (esbuild 0.28.2):

| Runtime actually checked | Entry points / scope | Outcome |
| --- | --- | --- |
| Node v24.6.0, fresh consumer | `snug`, `/schema`, `/compile`, `/view`, `/writer`, `/sources`; compile and stored-Program arms | 976 checks per arm, 0 failures |
| Chrome 156.0.8078.80 headless, strict CSP | Same six entries, split ESM bundle, both arms | 976 per arm, 0 failures; eval/Function blocked by control probes |
| workerd 2026-11-02 (1.20261102.1), repeat 2025-12-17; compatibility date 2025-12-01, no nodejs_compat | Same six entries; split and one-file compile arms, compiler-free stored-Program arm | 976 per tested arm, 0 failures |
| Current Unicode and schema handle/push APIs, later scheduler changes | Absent from that revision's suite | No browser/Worker evidence claimed here |

The old source arm checks profile scanning, not the later CDDL source API.
The full compiler-free public runtime artifact was **56,226 bytes gzip-9**
in that record, covering codec/schema/view/writer/sources, not just a VM core.
See the [evidence index](../bench/README.md#current-evidence-index--2026-11-03)
for size boundaries and older snapshots.

## Errors and security

| Operation | Ordinary refusal |
| --- | --- |
| `compile` | rejected Promise with `SchemaError` |
| `schema.validate`, `validateAt`, `View.validateAt`, schema source validation | `ValidationResult` (async handles resolve it) |
| codec/schema decode, checked view, Writer, profile sources | `SnugFault` |
| Program loading | rejected Promise with `ProgramError` |
| Broken source protocol | `SourceError` |
| Facade byte/rule misuse, unknown rule, malformed or unknown options | `TypeError` (async APIs reject); view integer range uses `RangeError` |
| Writer wrong-type/admission arguments, e.g. `.text(7)` | sticky `SnugFault('unsupported')`; later calls throw `writer_failed` |

CBOR fault codes are unprefixed, such as `key_order` or `indefinite`.
Validation reasons spell these `cbor/key_order`, `cbor/indefinite`.
Schema decode/view faults use `schema/type`, `schema/missing`, etc., keeping
`reason`, `path`, `offset` and optional `subcode` from validation. Codec and
profile-source faults need only `code`; they do not promise offsets.
The complete families are in [errors](api.md#errors).
Messages can be generic and codec/profile refusals may lack offsets. Branch
on structured fields, not message text. Resource codes describe policy
exhaustion, not necessarily malformed CBOR; the API reference gives recovery
guidance per code. Unexpected invariant failures are ordinary Error; transport
errors propagate unchanged and are outside the library's safe-message promise.

Never log received bytes or values to explain a refusal. Unnamed input keys
become `*`; only keys named by a live schema alternative appear in paths.
Offsets and array indexes are structural metadata. Treat schema names as
untrusted metadata too, even though schema errors may identify a rule.
Snug checks data shape and wire encoding; applications still enforce
authentication, authorisation, freshness, quotas and field projection.
