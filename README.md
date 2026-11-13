# snug

snug reads, writes and validates CBOR (RFC 8949) against CDDL schemas
(RFC 8610). It is built for untrusted input: every operation has explicit
limits, errors never echo the data, and validation runs directly over the
bytes without building a value tree.

The core (scanner, CDDL compiler, validator, encoder) is generated from one
source into JavaScript and Rust, and a WebAssembly build comes from the Rust
side. All three give the same verdicts, error codes and step counts for the
same input, and the test suite checks that they do.

<!-- prerelease -->
> **Not yet on npm or crates.io.** The install commands below work from the
> first release on. Until then,
> [build from a checkout](https://github.com/3sln/snug/blob/main/docs/guide.md#building-from-a-checkout).
>
> Design: [specification](https://github.com/3sln/snug/blob/main/SPEC.md),
> [architecture](https://github.com/3sln/snug/blob/main/docs/architecture.md),
> [Program format](https://github.com/3sln/snug/blob/main/docs/program.md).
<!-- /prerelease -->

## Install

```sh
npm install @3sln/snug        # JavaScript: Node ≥ 20, browsers, Workers; no dependencies
npm install @3sln/snug-wasm   # optional: the same API on the WebAssembly build
cargo add snug-cbor           # Rust ≥ 1.87; the library is `snug`; no dependencies
```

Before 1.0, a minor release (0.y) may change the API; see the
[changelog](CHANGELOG.md). To build any of them from a clone instead, see
[Building from a checkout](docs/guide.md#building-from-a-checkout).

## What it does

- **Validates CBOR against CDDL in one pass.** Wire-level checks and schema
  matching happen in the same walk over the bytes. `validate` builds no
  values; `decode` validates first, then builds them.
- **Follows the RFCs.** Group matching follows RFC 8610 Appendix A (ordered
  choice, greedy repetition, no backtracking), cuts follow §3.5.4, and
  `.regexp` uses XSD regular expressions as §3.8.3 specifies. RFC 9165
  controls (including `.abnf` and `.abnfb`) and RFC 9682 syntax are
  supported. [Conformance](https://github.com/3sln/snug/blob/main/docs/conformance.md) lists every known deviation.
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

```js
import { encode } from '@3sln/snug';
import { compile } from '@3sln/snug/compile';
import { view } from '@3sln/snug/view';

const schema = await compile('message = { id: uint, text: tstr .size (0..80) }');
const bytes = encode({ id: 7, text: 'hello' });

schema.validate(bytes, 'message');   // { ok: true }, nothing decoded
schema.decode(bytes, 'message');     // validated, then decoded
view(bytes, { schema, rule: 'message' }).get('id')?.number();  // 7, read lazily
```

Compile a schema once and reuse it. `compile` is async only because the
compiler loads on first use; everything else is synchronous.

A refusal says what failed and where, without repeating the input:

```js
schema.validate(encode({ id: -1, text: 'hi' }), 'message');
// { ok: false, reason: 'type', path: ['id'], offset: 4 }
```

More examples, in `examples/` (in the repository, run them from its root):

```sh
node examples/validate-hostile.mjs   # untrusted bytes, limits, safe errors
node examples/view.mjs               # lazy field access
node examples/encode-writer.mjs      # the typed Writer
node examples/sequence-sse.mjs       # a CBOR-sequence event stream over fetch
node examples/validate-handle.mjs    # range reads from a blob
node examples/program-cache.mjs      # compile once, ship the compiled schema
```

## Quick start: Rust

The crate is `snug-cbor`; its library is `snug`, so code says `use snug::…`.

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
the [Rust guide](https://github.com/3sln/snug/blob/main/docs/rust.md) and the [crate README](https://github.com/3sln/snug/blob/main/host/rust/README.md).

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

The compiler warns about the first spelling (`schema.warnings` in JS, `Schema::warnings()` in Rust).

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
| `@3sln/snug` | `encode`, `decode` and the value types |
| `@3sln/snug/compile` | `compile`; loads the compiler on first use |
| `@3sln/snug/schema` | validating and decoding with a compiled schema; loading precompiled schemas |
| `@3sln/snug/view` | lazy, checked `View` and `Cursor` |
| `@3sln/snug/writer` | the typed `Writer` |
| `@3sln/snug/sources` | blobs, push sources and streams |
| `@3sln/snug/sequence` | CBOR sequences (RFC 8742) |
| `@3sln/snug/controls` | `.chars`, `.unique`, `.samelen`, and your own controls |
| `@3sln/snug/abnf` | optional `.abnf` / `.abnfb` support |
| `@3sln/snug/unicode` | optional Unicode tables for `\p{…}` in regular expressions |

Gzipped, the codec alone is about 21 KB and validation about 54 KB. The
compiler is a separate chunk of about 98 KB that loads only when you
compile; if you ship precompiled schemas, it never loads.

The [guide](docs/guide.md) covers TypeScript, browser and Workers setup.

## Documentation

- [Guide](docs/guide.md): how to use it
- [API reference](docs/api.md)
- [Rust guide](https://github.com/3sln/snug/blob/main/docs/rust.md)
- [wasm SDK](https://github.com/3sln/snug/blob/main/docs/wasm-sdk.md): the opt-in WebAssembly build, `@3sln/snug-wasm`
- [CDDL support](docs/cddl-support.md): what's supported and how it's read
- [Profiles](docs/profiles.md): wire options and value mapping
- [Conformance](https://github.com/3sln/snug/blob/main/docs/conformance.md): how snug lines up with each RFC
- [Release policy](https://github.com/3sln/snug/blob/main/docs/release-policy.md): versioning and what counts as breaking
- [Changelog](CHANGELOG.md)

## Security

Report vulnerabilities privately to contact+security@3sln.com. See
[SECURITY.md](SECURITY.md) for what to include and what counts.

## License

[MIT](LICENSE). The bundled Unicode data is under the Unicode License v3; see
[third-party notices](THIRD_PARTY_NOTICES.md).
