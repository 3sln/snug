# Using snug from Rust

Assemble the crate with `kin/scripts/rust-crate .cache/snug-rs`; run the full
offline gate with `bb rust-api-test`. The [Rust host README](../host/rust/README.md)
explains local dependencies and the assembled layout. The crate has no external
Rust dependencies. Its examples are checked by Cargo doctests.

## Compile once, validate bytes

```rust
use snug::{Schema, CompileOptions, CompileLimits, Scratch};

let options = CompileOptions {
    limits: CompileLimits {
        input_bytes: Some(2048), depth: Some(8),
        entries: Some(16), items: Some(64), budget: Some(10_000),
        ..Default::default()
    },
    ..Default::default()
};
let schema = Schema::compile("message = { id: uint }", &options)?;
let mut scratch = Scratch::new();
schema.validate(&[0xa1, 0x62, b'i', b'd', 7], "message", &mut scratch)?;
# Ok::<(), Box<dyn std::error::Error>>(())
```

Compilation is synchronous. `CompilerProfile::{Full, Bindle, Bus}` restricts
CDDL; it is independent of wire policy. This Rust facade selects the
restricted Bindle scanner policy, with root `cose` integer labels as an option;
it does not yet expose general deterministic presets. `CompileOptions::unicode`
accepts `Some(&tables)` from `snug::unicode_tables::tables()` for pinned
Unicode 16.0 category regexps. Programs contain the compiled automata and do
not need the category tables at validation time.

Schemas and Programs clone cheaply through immutable shared storage. Share a
Schema between threads, and use one reusable `Scratch` per concurrent caller.
`validate` builds no decoded value tree. `validate_with_options` permits a
`ValidationOptions` root policy and per-call caps, which only lower compiled
limits. Schema methods default to any root; codec/view default to map root.

`Failure` preserves the generated VM's code, reason, offset, path, embedded
subcode and budget usage. It describes one deterministic witness, not all
failed alternatives. Only schema-named keys appear in paths. The requested
`Result<(), Failure>` signature also carries a missing-rule API failure as
`code == -1, reason == "unknown_rule"`; check rule names against
`schema.program().rules()` when configuring an application. JS instead throws
TypeError for this misuse.

## Decode and exact values

```rust
use snug::{decode, encode, DecodeOptions, EncodeOptions, Value};
let bytes = encode(&Value::Array(vec![Value::Uint(7), Value::Nint(0)]),
                   &EncodeOptions::default())?;
assert_eq!(decode(&bytes, &DecodeOptions::any())?,
           Value::Array(vec![Value::Uint(7), Value::Nint(0)]));
# Ok::<(), snug::Error>(())
```

`decode` scans the whole document with kin before materializing anything.
`schema.decode(bytes, rule, scratch)` validates first, then runs the same
trusted builder without another profile scan. Values own byte/text content,
typed elements and descendants. Map pairs retain canonical wire order; encode
accepts pairs in any order, sorts through kin and refuses duplicate keys.

| Value | Exact meaning |
| --- | --- |
| `Uint(u64)` | major 0 |
| `Nint(u64)` | **−1 − argument**; `Nint(u64::MAX)` is −2⁶⁴ |
| `BigInt { negative, magnitude }` | big-endian unsigned CBOR argument; negative means **−1 − argument**, not sign-magnitude |
| `Decimal { mantissa: Integer, exponent: i64 }` | normalized nonzero coefficient × 10^exponent; current exponent −1024..−1 |
| `TypedArray` | vectors of exact integer/native float elements; `F16(Vec<u16>)` stores raw binary16 bits |
| `NDArray { shape, data }` | tag 40, row-major shape and array/typed storage |
| `Tag(number, content)` | explicit wire tag; cannot bypass kin's allowed-tag/content checks |
| `Float(f64)` | a float, even when integral; kin chooses shortest width or refuses |

BigInt encoding strips leading zeroes and uses major 0/1 when possible;
decoding bignums produces their canonical bytes. There is no decimal string
parser/normalizer yet: supply normalized parts. Decimal values do not retain
presentation scale. `Float(1.0)` is refused by the current profile; choose
`Uint(1)` explicitly. NaN is refused in typed arrays; permitted typed infinities
and signed zero retain their bits. Byte strings use `Bytes`, not typed U8.

`DecodeOptions::bindle()` is the current default. `DecodeOptions::any()` changes
only root shape. `Top`, `cose` and `Limits` remain separate settings so future
wire presets can be added without mixing them with compiler profiles.

## Encode with typed Writer calls

```rust
use snug::{Writer, EncodeOptions};
let mut writer = Writer::new(&EncodeOptions::default())?;
writer.begin_map(2)?.key("z")?.uint(7)?.key("a")?
      .begin_array(1)?.text("hello")?.end()?.end()?;
let bytes = writer.finish()?;
# Ok::<(), snug::Error>(())
```

The Writer writes bytes immediately. `begin_array(n)` owes exactly n values;
`begin_map(n)` owes n key/value pairs. Supply `key` or `key_value` before each
map value, and `end` each complete container. Maps sort at end through kin.
`value` walks a borrowed `Value` without cloning the tree. `int(i128)` supports
the entire signed range; `nint` accepts the CBOR argument convention above.
`bigint`, `decimal`, `typed`, `ndarray`, `bytes`, `text`, `float`, `bool` and
`null` write complete values. `value` also handles allowed tagged forms.

Every error poisons the Writer: `failure()` retains the first error and later
calls return `writer_failed`. Finish checks the complete profile and transfers
the allocation; a second finish returns `grammar`. Some content refusals occur
at finish, unlike JS's eager typed calls. No partial output escapes. There is
no transport streaming or unchecked byte-insertion API.

`EncodeOptions` permits any root and caps output growth at `limits.max_bytes`
(default 1,500,000). This is an intentional Rust difference from JS's optional
finish-only byte cap. Map sorting and final checking use additional scratch;
the byte cap is not a total heap quota. Default depth/entry/item caps are
32 / 65,536 / 131,072. Zero means zero. Codec option ceilings are depth 256
and int32-range lengths/counts; invalid ceilings return `Error::Usage`.
Bignum/decimal/dimension restrictions still belong to kin.

## Borrow checked bytes

```rust
use snug::{View, DecodeOptions};
let bytes = [0xa1, 0x61, b'a', 7];
let root = View::open(&bytes, &DecodeOptions::default())?;
assert_eq!(root.get("a").and_then(|v| v.uint()), Some(7));
let mut cursor = root.cursor();
assert!(cursor.enter());
assert_eq!(cursor.key().and_then(|v| v.text()), Some("a"));
assert_eq!(cursor.view().uint(), Some(7));
# Ok::<(), snug::Error>(())
```

`Schema::view` first validates the entire document against the named rule.
`View::open` checks the complete profile. All views borrow `&[u8]`: safe Rust
prevents mutation while views, cursors or returned byte/text slices remain
live. Clone/copy a view without copying its document. To own a copy, retain a
copied Vec and open a view over it. No unchecked opener is exposed.

`get`, `get_key`, `at` and `entry` return optional checked views. Scalar
accessors return Option on the wrong kind; `raw` always returns the encoded
span. `int` handles major 0/1 exactly with i128; `value` materializes bignums
or a whole subtree. `typed_view` reads unaligned little-endian elements without
copying; its `get` returns `TypedElement::{Uint, Int, Float}`. `Cursor::enter`,
`next`, `up` leave their position unchanged on false. Sibling traversal skips
heads, without building sibling values or allocating per step.

## Cache Programs and validate blobs

```rust
use snug::{Schema, CompileOptions, Program, BytesBlob, ValidationOptions};
let schema = Schema::compile("r = uint", &CompileOptions::default())?;
let bytes = schema.program().serialize()?;
let loaded = Schema::from_program(Program::deserialize(&bytes)?);
loaded.validate_blob(&BytesBlob(&[7]), "r", &ValidationOptions::default(), 4096, 0)??;
# Ok::<(), Box<dyn std::error::Error>>(())
```

Programs use the same 96-byte-header container as JS: little-endian words,
SHA-256 integrity, format major 1 and minor 0. Loading requires equal major,
minor no newer than the loader, valid framing/digest and kin vm-verify.
Producer version is provenance and survives reserialization. `source_key()`
is the source/options SHA-256 hex cache key; namespace caches by the producing
revision while the library is experimental. **Use trusted Program origins**:
the hash is not authentication and structural verification does not establish
compiler semantic invariants. Raw words/pool accessors are shared read-only
slices; `Program::from_parts` copies and verifies them.

`Blob` is the existing host's synchronous size/read snapshot contract.
`validate_blob` folds in its session driver; it returns
`Result<Result<(), Failure>, Error>`, distinguishing source/API errors from
validation verdicts. Use a positive chunk size; needs may exceed that size.
A positive quantum creates VM yields, which this synchronous driver resumes
immediately. The driver does not buffer the entire document as an API shortcut.
Pin a remote object's version in the Blob implementation and return exactly
the requested bytes on every read. Unknown-length sources, async adapters,
source decode, view directories and Writer sorted-key mode remain unavailable.

## Handle errors safely

`Error` implements Display and `std::error::Error`. Match its family and use
`code()` for stable codes matching JS: unprefixed CBOR faults, `schema/...`
schema-decode faults, compiler codes, Program codes and source codes. Fixed
Rust API-misuse codes (`options`, `unknown_rule`, etc.) cover boundaries for
which JS uses TypeError. Display contains only a code; Debug retains safe
schema locations/paths. Library failures never contain input bytes, received
values or unnamed data keys. Transport implementations must sanitize their
own errors. Allocator exhaustion retains standard Rust allocator behavior.
