# snug for Rust

snug is a CDDL (RFC 8610) validator and CBOR (RFC 8949) library. It validates
bytes directly, without building a value tree. It also offers checked
zero-copy views for reading selected fields, and it encodes deterministic
bytes from owned values or typed `Writer` calls. The crate has no
dependencies.

**Experimental, version 0.0.0, not published.** The API may still change
before the first release.

The compiler, the validator and the byte-level decisions are written in kin
and generated into Rust, and the same sources generate snug's JavaScript
package. Both hosts give the same Programs, verdicts, reasons, paths and
budget use for the same input.

The wire policy is `snug::Profile`:

- the valid preset by default: any valid CBOR;
- `Profile::DETERMINISTIC` for RFC 8949 §4.2.1 core deterministic
  encoding;
- `Profile::BINDLE` for the Bindle restrictions.

`CompilerProfile` restricts which CDDL a schema may use. It is separate from
the wire policy, and `Full` does not relax it.

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

## API

The crate root exports:

| API | Contract |
| --- | --- |
| `Value`, `Integer`, `TypedArray` | Exact integers; owned byte, text, array and map values; dedicated decimal, typed-array and ndarray variants; explicit tags |
| `decode`, `DecodeOptions`, `Top`, `Limits` | The generated scanner checks the bytes first, then a trusted builder makes owned values. Any root by default (`Top::Map` or the Bindle preset requires a map) |
| `encode`, `EncodeOptions`, `Writer` | Heads, integers, float widths and map order are decided by the generated code. Any root; output growth is bounded, and the output is checked by the scanner at the end |
| `Schema`, `CompileOptions`, `CompileLimits`, `CompilerProfile`, `Cuts`, `Regexp`, `AbnfMode`, `Controls`, `Control`, `Warning`, `SchemaError` | Compile synchronously or load a verified Program; `Schema::warnings()` returns the compile warnings. Validate with a reusable, caller-owned `Scratch`. A schema accepts any root by default |
| `ValidationOptions`, `Failure`, `Segment` | Runtime caps can only lower the compiled limits. Refusals give a deterministic, safe witness: reason, path, offset and subcode (`embedded`'s inner reason, or `cut`) |
| `Program` | Immutable shared ownership; the source key, rule names, read-only words and pool; versioned serialisation and deserialisation |
| `View`, `Cursor`, `TypedView`, `TypedElement` | Fully checked shared borrows; zero-copy byte and text access; portable unaligned typed reads |
| `Blob`, `BytesBlob`, `SourceOptions`, `SourceError` | Sources of a known length, read in windows through a resumable session (`Schema::validate_blob`); unknown-length readers (`Schema::validate_reader`); `SourceOptions` holds `chunk`, `quantum` and `fail_fast` |
| `AsyncBlob`, `AsyncSource`, `read_sequence_async`, `AsyncSequenceReader` | Async drivers for blobs, unknown-length streams and CBOR sequences, over the same session (`Schema::validate_blob_async`, `validate_reader_async`, `read_sequence_async`). They work with any runtime and need no dependency |
| `Error`, `IoError` | CBOR, schema-decode, compile, Program, source, I/O, misuse and internal families, with fixed codes and a safe Display; `Error::Io` keeps a transport's own error behind `source()` |

Errors never contain input bytes, received values or unnamed map keys.
Some enums are `#[non_exhaustive]`, so a `match` on them needs a fallback
arm. The Rust guide lists which ones, and why.

Every type a public signature names is exported at the crate root; use those
paths. The `compile`, `schema`, `sha256`, `unicode_tables` and generated
`snug` modules are public for snug's own test hosts and may change in any
release; of them, only `unicode_tables::tables()` (the optional Unicode data)
is meant for users (see the Rust guide, `docs/rust.md`).

The Rust guide, `docs/rust.md` in the snug repository, covers ownership,
errors, sessions, sequences, extension controls and the exact numeric
conventions. The rustdoc examples are compiled and run as tests.

## Current limits

- There is no unchecked view opener, no view directory and no
  `keys_sorted` Writer mode.
- The sync source drivers resume after a yield immediately. The async
  drivers yield to the executor.
- A profile refusal of text, tag, decimal or typed-array content can
  surface when the `Writer` finishes, after earlier builder calls succeeded.
- Allocation failure follows the standard library allocator contract.
  There is no application memory quota and no recovery from allocator
  exhaustion.

## Building from the repository

The crate is assembled, not built in place: depending on `host/rust` directly
fails with one `compile_error!` that names `kin/scripts/rust-crate`, because
the generated modules are not there. It needs Rust 1.87 or later
(`rust-version`). From the repository root, with no network:

```sh
kin/scripts/rust-crate .cache/snug-rs
cargo test --offline --manifest-path .cache/snug-rs/Cargo.toml
cargo doc --offline --no-deps --manifest-path .cache/snug-rs/Cargo.toml
bb rust-api-test
```

`kin/scripts/rust-crate` copies `host/rust/src`, `host/rust/tests`, the
committed `gen/rust/snug`, this README and the licence, notices and
changelog into `.cache/snug-rs`. The integration tests need Node and the
repository's JS host. They build their expected results in memory from the
checkout, without downloading anything.

`bb rust-api-test` runs:

- the debug Cargo tests, with overflow checks on;
- the doctests, and the examples in this README and the Rust guide;
- `cargo doc` with warnings denied (broken intra-doc links included), for
  the library and the test-host binaries;
- Clippy, when it is installed.

Clippy's output goes to `.cache/snug-rs/clippy.log`. The gate allows one
lint, `clippy::absurd_extreme_comparisons`, for a generated comparison
against the int32 maximum; every other lint keeps its level.

`cargo package --list` in the assembled crate shows what a release would
ship: the library, its generated modules and these documents. The test-host
binaries and the integration tests stay out.

A local consumer can depend on the assembled crate:

```toml
[dependencies]
snug = { path = "../snug/.cache/snug-rs" }
```

Adjust the path for your consumer directory, and pin the repository
revision that produced the crate: version `0.0.0` alone does not identify
it.
