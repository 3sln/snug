# snug for Rust

Experimental, dependency-free Rust API for the kin compiler, CBOR scanner,
schema VM, writer primitives and checked navigation. The wire policy is
`snug::Profile`: the valid preset by default (any valid CBOR, P8.4),
`Profile::DETERMINISTIC` for RFC 8949 §4.2.1 checking, `Profile::BINDLE` for
the Bindle restrictions (P7.1). Compiler `Full` does not relax wire policy.

Build from the repository root (Cargo 1.92, no network or installation):

```sh
kin/scripts/rust-crate .cache/snug-rs
cargo test --offline --manifest-path .cache/snug-rs/Cargo.toml
cargo doc --offline --no-deps --manifest-path .cache/snug-rs/Cargo.toml
bb rust-api-test
```

The assembler copies `host/rust/src`, `host/rust/tests` and committed
`gen/rust/snug` into `.cache/snug-rs`. Build that crate, not this directory.
It retains the existing test-host modules and binaries. The integration tests
need Node and the repository's JS host; they build their expected results in
memory from the current checkout without downloading dependencies. `bb
rust-api-test` runs debug Cargo tests (overflow checks enabled), doctests and
the guide/README examples and Clippy when installed. Clippy diagnostics,
including existing generated-code warnings, go to `.cache/snug-rs/clippy.log`.
The command allows `clippy::absurd_extreme_comparisons` for the existing
generated comparison against the int32 maximum; other lint levels stay intact.

A local consumer can depend on the assembled crate:

```toml
[dependencies]
snug = { path = "../snug/.cache/snug-rs" }
```

Adjust the path to the consumer directory. Keep the assembled directory and
pin its producing repository revision; version `0.0.0` alone is insufficient.
No crate publication is implied.

```rust
use snug::{CompileOptions, DecodeOptions, EncodeOptions, Schema, Scratch,
           Value, View, decode, encode};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let schema = Schema::compile("message = { id: uint }", &CompileOptions::default())?;
    let bytes = encode(&Value::Map(vec![
        (Value::Text("id".into()), Value::Uint(7)),
    ]), &EncodeOptions::default())?;
    let mut scratch = Scratch::new();
    schema.validate(&bytes, "message", &mut scratch)?;
    assert_eq!(schema.decode(&bytes, "message", &mut scratch)?,
               decode(&bytes, &DecodeOptions::default())?);
    assert_eq!(View::open(&bytes, &DecodeOptions::default())?.get("id")
               .and_then(|v| v.uint()), Some(7));
    Ok(())
}
```

The crate root exports:

| API | Contract |
| --- | --- |
| `Value`, `Integer`, `TypedArray` | Exact integers, owned byte/text/array/map values, specialized decimal/typed/ndarray variants and explicit tags |
| `decode`, `DecodeOptions`, `Top`, `Limits` | Generated scanner first, then trusted owned builder; map root by default |
| `encode`, `EncodeOptions`, `Writer` | Kin heads/integers/float widths/map ordering; any root; bounded output growth and final scanner check |
| `Schema`, `CompileOptions`, `CompileLimits`, `CompilerProfile` | Compile synchronously or load a verified Program; validate with reusable caller-owned `Scratch`; schema root defaults to any |
| `ValidationOptions`, `Failure`, `Segment` | Runtime caps only lower compiled limits; safe deterministic witnesses, preserving VM reasons, paths, offsets and embedded subcodes |
| `Program` | Immutable shared ownership, source key, rule names, raw read-only words/pool and D084 serialization/deserialization |
| `View`, `Cursor`, `TypedView`, `TypedElement` | Fully checked shared borrows; zero-copy byte/text access and portable unaligned typed reads |
| `Blob`, `BytesBlob`, `validate_blob` | Known-length immutable sources through the existing session driver |
| `AsyncBlob`, `AsyncSource`, `read_sequence_async`, `AsyncSequenceReader` | Async blob, unknown-length stream and sequence drivers over the same session (`Schema::validate_blob_async`, `validate_reader_async`, `read_sequence_async`); runtime-agnostic, no dependency |
| `Error` | CBOR, schema-decode, compile, Program, source, misuse and internal families; fixed codes and safe Display |

The older `compile`, `schema`, `sha256`, `unicode_tables` and generated `snug`
modules remain available for the existing test hosts. New consumers should use
the crate-root facade. See [the guide](../../docs/rust.md) and the rustdoc
examples for ownership, error handling and exact numeric conventions.

Current limits: no unchecked view opener, view directories or `keys_sorted`
Writer mode. The sync source drivers resume yields immediately; the async ones
(P9.6) yield to the executor. Rust
profile refusals for text/tag/decimal/typed content can surface at Writer
finish, after earlier builder calls succeed. Allocation failure follows the
standard library allocator contract; no application memory quota or recovery
from allocator exhaustion is provided.
