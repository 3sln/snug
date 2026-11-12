# snug

snug reads, writes and validates CBOR (RFC 8949) against CDDL schemas
(RFC 8610). It is built for untrusted input: every operation has explicit
limits, errors never echo the data, and validation runs directly over the
bytes without building a value tree.

The core (scanner, CDDL compiler, validator, encoder) is written once in kin
and generated into JavaScript and Rust. A WebAssembly build comes from the
Rust side. All three give the same verdicts, error codes and step counts for
the same input, and the test suite checks that they do.

> **Status:** pre-release. Nothing is published to npm or crates.io yet, and
> the API may change before 0.1.0. You can build and use it from this
> repository today. Requires Node ≥ 20 and Rust ≥ 1.87.

## What it does

- **Validates CBOR against CDDL in one pass.** Wire-level checks and schema
  matching happen in the same walk over the bytes. `validate` builds no
  values; `decode` validates first, then builds them.
- **Follows the RFCs.** Group matching follows RFC 8610 Appendix A (ordered
  choice, greedy repetition, no backtracking), cuts follow §3.5.4, and
  `.regexp` uses XSD regular expressions as §3.8.3 specifies. RFC 9165
  controls (including `.abnf` and `.abnfb`) and RFC 9682 syntax are
  supported. [Conformance](docs/conformance.md) lists every known deviation.
- **Bounds the work.** Input size, depth, entries, items and a step budget
  are all capped, and the budget counts operations, not time. Hostile schemas
  and hostile data both stop at the limit instead of eating CPU or memory.
- **Reads lazily.** A checked `View` or `Cursor` reads a few fields out of a
  large message without decoding the rest.
- **Works over more than buffers.** Validate from range-readable blobs (object
  storage, files), push streams, streams of unknown length, and CBOR
  sequences (RFC 8742), such as an event stream where each message is
  checked and handed over as soon as its last byte arrives.
- **Writes deterministic CBOR.** The encoder and the typed `Writer` always
  emit RFC 8949 §4.2.1 deterministic encoding.

## Quick start: JavaScript

No install step and no dependencies. From a checkout:

```sh
cd host/js
node --input-type=module
```

```js
import { encode } from 'snug';
import { compile } from 'snug/compile';
import { view } from 'snug/view';

const schema = await compile('message = { id: uint, text: tstr .size (0..80) }');
const bytes = encode({ id: 7, text: 'hello' });

schema.validate(bytes, 'message');   // { ok: true }, nothing decoded
schema.decode(bytes, 'message');     // validated, then decoded
view(bytes, { schema, rule: 'message' }).get('id').number();   // 7, read lazily
```

Compile a schema once and reuse it. `compile` is async only because the
compiler loads on first use; everything else is synchronous.

A refusal says what failed and where, without repeating the input:

```js
schema.validate(encode({ id: -1, text: 'hi' }), 'message');
// { ok: false, reason: 'type', path: ['id'], offset: 4 }
```

More examples, runnable from the repository root:

```sh
node examples/validate-hostile.mjs   # untrusted bytes, limits, safe errors
node examples/view.mjs               # lazy field access
node examples/encode-writer.mjs      # the typed Writer
node examples/sequence-sse.mjs       # a CBOR-sequence event stream over fetch
node examples/validate-handle.mjs    # range reads from a blob
node examples/program-cache.mjs      # compile once, ship the compiled schema
```

## Quick start: Rust

The crate has no dependencies.

```rust
use snug::{CompileOptions, EncodeOptions, Schema, Scratch, Value, encode};

let schema = Schema::compile("message = { id: uint }", &CompileOptions::default())?;
let bytes = encode(
    &Value::Map(vec![(Value::Text("id".into()), Value::Uint(7))]),
    &EncodeOptions::default(),
)?;
schema.validate(&bytes, "message", &mut Scratch::new())?;
```

Async drivers for blobs, readers and sequences work with any runtime. See
the [Rust guide](docs/rust.md) and the [crate README](host/rust/README.md).

## Watch out for tagged unions

RFC 8610 says a `name:` key carries a cut. Read literally, as snug does by
default, the usual one-map spelling of a tagged union only ever matches its
first branch:

```cddl
; Doesn't work: {"kind": "b", "y": "z"} is rejected
shape = { kind: "a", x: int // kind: "b", y: tstr }

; Works: a choice between two maps
shape = { kind: "a", x: int } / { kind: "b", y: tstr }

; Also works: a discriminator without a cut
shape = { "kind" => "a", x: int // "kind" => "b", y: tstr }
```

If you need to accept schemas written for other CDDL tools, compile with
`cuts: 'branch'` to get their behaviour. The
[guide](docs/guide.md#discriminated-unions-under-the-rfc-cut) explains why.

## What it accepts

By default snug reads any valid CBOR: indefinite lengths, non-shortest
encodings, keys in any order, any tag. It still refuses what the RFC calls
invalid, such as duplicate map keys (compared by value), malformed UTF-8 and
bad content in tags it knows.

Two stricter presets:

- `wire: 'deterministic'` also requires RFC 8949 §4.2.1 deterministic
  encoding. Use it for signed or hashed data, and for protocols such as
  dCBOR or CTAP2.
- `wire: 'bindle'` is a narrow profile kept for one existing consumer.

[Profiles](docs/profiles.md) covers every option and how CBOR maps to
JavaScript values.

Default limits: 1,500,000 bytes of input, depth 32, 65,536 entries per
container, 131,072 items, and a validation budget of 2,250,000 steps. That
budget covers about a megabyte of typical data with room to spare. Any limit
can be lowered per call.

## Entry points

| Entry | For |
| --- | --- |
| `snug` | `encode`, `decode` and the value types |
| `snug/compile` | `compile`; loads the compiler on first use |
| `snug/schema` | validating and decoding with a compiled schema; loading precompiled schemas |
| `snug/view` | lazy, checked `View` and `Cursor` |
| `snug/writer` | the typed `Writer` |
| `snug/sources` | blobs, push sources and streams |
| `snug/sequence` | CBOR sequences (RFC 8742) |
| `snug/controls` | `.chars`, `.unique`, `.samelen`, and your own controls |
| `snug/abnf` | optional `.abnf` / `.abnfb` support |
| `snug/unicode` | optional Unicode tables for `\p{…}` in regular expressions |

Gzipped, the codec alone is about 21 KB and validation about 54 KB. The
compiler is a separate chunk of about 98 KB that loads only when you
compile; if you ship precompiled schemas, it never loads.

Until snug is on npm, `npm run build` in `host/js` produces a self-contained
package you can depend on from another project. The [guide](docs/guide.md)
has the recipe, plus TypeScript, browser and Workers setup.

## Documentation

- [Guide](docs/guide.md): how to use it
- [API reference](docs/api.md)
- [Rust guide](docs/rust.md)
- [CDDL support](docs/cddl-support.md): what's supported and how it's read
- [Profiles](docs/profiles.md): wire options and value mapping
- [Conformance](docs/conformance.md): how snug lines up with each RFC
- [Release policy](docs/release-policy.md): versioning and what counts as breaking
- [Changelog](CHANGELOG.md)

Design: [specification](SPEC.md), [architecture](docs/architecture.md),
[Program format](docs/program.md).

## Security

Report vulnerabilities privately to contact+security@3sln.com.

## License

[MIT](LICENSE). The bundled Unicode data is under the Unicode License v3; see
[third-party notices](THIRD_PARTY_NOTICES.md).
