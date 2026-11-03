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
Reuse it for many messages. A syntax/semantic/compile-limit refusal rejects
with `SchemaError { code, line, column, rule }`; line/column are 1-based,
columns count code points, and 0 means the error has no source position.
`program.rules` lists the user's validatable, non-generic type rules, sorted
by UTF-8 name. Groups, generic definitions and prelude rules are not
validation roots. [Supported CDDL](cddl-support.md) is an explicit subset.

`profile: 'full' | 'bindle' | 'bus'` selects a **compiler restriction set**.
It does not select the codec wire policy. The default is `full`. `bus`
refuses recursion, regexps and unbounded structures; it is useful for
untrusted schemas, within its supported subset. See [profiles](profiles.md).

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
surrogates cannot occur in text. The current CBOR profile still refuses
noncharacters before regexp matching. [Category details](cddl-support.md#unicode-regexp-categories).

Compile where the tables are available, then serialize the Program for a
validation-only bundle. The runtime and Program loader need no Unicode
module. Table contents are included in the source key; even schemas without
category escapes get a different key when compiled with supplied tables.
There is no change to the Program format.

Rust uses the same generated data through an explicit compile option:

```rust
use snug::compile::{compile_with_options, CompileOptions};
let tables = snug::unicode_tables::tables();
let options = CompileOptions { unicode: Some(&tables), ..Default::default() };
let compiled = compile_with_options(r#"word = tstr .regexp "\\p{L}+""#, &options)?;
```

For maintainers, `node tools/unicode/gen-tables.mjs` regenerates both hosts
from the running Node's ICU. `--check` verifies exact reproducibility and
requires the pinned Node version; `bb unicode-test` also compares the two
hosts' Programs and checks VM matches against Node's pinned Unicode oracle.
Regeneration under a different Node/Unicode version is an explicit table
upgrade whose generated headers and measurements need review.

## Validate hostile bytes without decoding

```js
const result = schema.validate(Uint8Array.of(0xbf, 0xff), 'message');
if (!result.ok) console.log(result.reason, result.path, result.offset);
```

`validate` returns `{ ok: true }` or
`{ ok: false, reason, path, offset, subcode? }`. It does not build the data
tree. The validator checks the current strict CBOR policy while matching
all live CDDL alternatives. On schema failure it continues checking the
profile; a profile error wins, unless the global step budget runs out first.
Missing rules, wrong argument types and SharedArrayBuffer input are API
misuse (`TypeError`), not validation results.

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
```

Schema decode validates, then materialises; codec decode checks the profile,
then materialises. A refusal throws `SnugFault`. Ordinary maps become
null-prototype objects; `objects: 'plain'` opts into ordinary objects with
safe own data properties for names such as `__proto__`. `cose: true` makes a
top-level map a `Map`, with safe integer and text keys. Nested maps remain
text-keyed objects. Codec decode requires a map unless `top: 'any'` is given.

Major-0/1 integers become numbers when safe and bigints otherwise. Tags 2/3
become bigints; byte strings are copied `Uint8Array`s; typed arrays are copied
into aligned native storage; tag 4 becomes `Decimal`; tag 40 becomes
`NDArray`. Float16 data uses `Float16Bytes` where native `Float16Array` is
unavailable. Decimals refuse implicit numeric coercion and JSON serialisation.
Use `toString()` and an explicit application representation. All decimal
normalisation discards presentation scale.

## Encode and write deterministic bytes

```js
import { Decimal } from 'snug';
import { Writer } from 'snug/writer';
const price = Decimal.from('1.50');
const encodedPrice = encode({ price, id: 7 }, { maxBytes: 256 });
const writer = new Writer({ maxBytes: 256 });
writer.beginMap(2).key('price').decimal(price).key('id').uint(7).end();
const sameBytes = writer.finish();
```

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
`float(1)` is refused: use `int(1)` or `value(1)`. There is no raw unchecked
CBOR insertion API.

Only dense ordinary arrays, plain/null-prototype objects with enumerable
data properties, the documented wrappers and the admitted scalars are
encodable. Classes, accessors, functions and sparse arrays fail with
`unsupported`. `omitUndefined: true` omits undefined object members and
symbol/non-enumerable members; array holes/undefined and enumerable accessors
remain refused. Avoid proxies or other executable objects at this boundary.

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

Use `get(key)` on maps and `at(index)` on arrays; absent children return
`undefined`. `entries`, `keys` and `values` iterate in encoded order.
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

## Validate a source

```js
import { asyncHandle, scanHandle } from 'snug/sources';
await scanHandle(asyncHandle(bytes), {}, { chunk: 16384, quantum: 4096 });
```

The current public adapters perform **profile-only scanning**, not CDDL
schema validation or materialising decode. They support a buffer, an exact
known-length sync/async `{ size, read(offset, length) }` handle, and
`pushScanner(length)` with `feed`, `resume`, `finalize`. `scanBuffer` returns
undefined on success; the handle scanners and push `finalize` return true.
Profile refusals throw `SnugFault`; broken source contracts throw
`SourceError` (`bad_chunk`, `short_read`, `length_mismatch`). Transport reads
may also reject with the transport's own error; sanitise those before logging.

Use positive `chunk` sizes and non-negative `quantum`. Reads occur one at a
time on demand; async yields return control to the event loop. A pushed
`yield` means resume on a later turn before continuing. Empty chunks are not
EOF. A successful intermediate verdict does not waive the declared-length
contract: deliver the remaining bytes and call `finalize`. Do not reuse a
raw `ScanSession` after it finishes or fails. Real handle implementations
must provide stable snapshots, exact reads and their own deadlines. The
in-memory helpers copy ordinary Uint8Array input; pass a plain Uint8Array,
not a mutable Node Buffer, when relying on `bufferHandle` snapshot ownership.

Unknown-length streams, standard Blob/File/HTTP Range adapters, fused decode
and public resumable CDDL validation are pending. D085 defines future drain
versus fail-fast behaviour; it is not an implemented option here. No example
buffers an unbounded stream to pretend it supports streaming schemas.

## Limits

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
| Validation work units | 2,300,000 | 2³¹−1 |

Compile limit names are in the [API reference](api.md#compilation).
Runtime schema options are `maxBytes`, `maxDepth`, `maxEntries`, `maxItems`,
`maxBignumBytes`, `budget`; they can only lower compiled values. Bignum
content still has the scanner's 128-byte ceiling even if other format fields
suggest a higher future maximum. LIMITS also fixes decimal exponent ≥−1024
and ndarray dimensions ≤8.

Codec/view-without-schema/source options expose the four ordinary `max*`
limits. They do not expose a VM budget; schema validation does. Writer
`limits` can group those four options; top-level names are also accepted.
Encoding only checks an explicitly supplied `maxBytes` **at finish** after
buffer growth; bound the values you construct as well. A depth bound stops
ordinary cyclic objects but does not make arbitrary getters/proxies safe.
Compilation and synchronous validation cannot be cancelled mid-call by a
timer; isolate especially hostile work in a worker/process when necessary.

## Programs, caching and compatibility

```js
import { fromSerialized } from 'snug/schema';
const cacheKey = schema.program.sourceKey; // SHA-256 hex, source + effective options
const stored = schema.program.serialize(); // synchronous Uint8Array
const cached = await fromSerialized(stored); // no compiler loaded
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

D084 supersedes that older document's exact snug-version check: format major
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

## Errors and security

| Operation | Ordinary refusal |
| --- | --- |
| `compile` | rejected Promise with `SchemaError` |
| `schema.validate`, `validateAt`, `View.validateAt` | `ValidationResult` |
| codec/schema decode, checked view, Writer, profile sources | `SnugFault` |
| Program loading | rejected Promise with `ProgramError` |
| Broken source protocol | `SourceError` |
| Wrong API arguments or unknown rule | `TypeError` (view integer range: `RangeError`) |

CBOR fault codes are unprefixed, such as `key_order` or `indefinite`.
Validation reasons spell these `cbor/key_order`, `cbor/indefinite`.
Schema decode/view faults use `schema/type`, `schema/missing`, etc., keeping
`reason`, `path`, `offset` and optional `subcode` from validation. Codec and
profile-source faults need only `code`; they do not promise offsets.
The complete families are in [errors](api.md#errors).

Never log received bytes or values to explain a refusal. Unnamed input keys
become `*`; only keys named by a live schema alternative appear in paths.
Offsets and array indexes are structural metadata. Treat schema names as
untrusted metadata too, even though schema errors may identify a rule.
Snug checks data shape and wire encoding; applications still enforce
authentication, authorisation, freshness, quotas and field projection.
