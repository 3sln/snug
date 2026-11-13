# Using snug from Rust

The crate is `snug-cbor` on crates.io (once published: `cargo add snug-cbor`,
or `snug-cbor = "0.1"` under `[dependencies]`). Its library is `snug`, so code
says `use snug::…`.

Assemble the crate with `kin/scripts/rust-crate .cache/snug-rs`; run the full
offline gate with `bb rust-api-test`. The [Rust host README](../host/rust/README.md)
explains local dependencies and the assembled layout. The crate has no external
Rust dependencies. Its examples are checked by Cargo doctests. The minimum
supported Rust is 1.87 (`rust-version`); the release gates build and test the
crate on exactly 1.87 ([release policy §2](release-policy.md#2-supported-runtimes-and-toolchains)).

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
CDDL; it is independent of wire policy. The wire profile is `snug::Profile`
in `DecodeOptions`, `EncodeOptions`, `ValidationOptions` and
`SequenceOptions` (P7.1, D120, D126, D260): `Profile::VALID` (any valid CBOR)
by default, `Profile::DETERMINISTIC` to require RFC 8949 §4.2.1 encoding,
`Profile::BINDLE` for the Bindle restrictions (root `cose` integer labels an
option there), or the fields `keys`, `tags`, `floats`, `undefined_value`,
`noncharacters`, `valid`
([profiles](profiles.md)). `CompileOptions::unicode`
accepts `Some(&tables)` from `snug::unicode_tables::tables()` for pinned
Unicode 16.0 category regexps. Programs contain the compiled automata and do
not need the category tables at validation time. `CompileOptions::cuts`
selects the cut semantics (`Cuts::Rfc`, the literal RFC 8610 cut, by default;
`Cuts::Branch`, rule A; D301), and `CompileOptions::group_words` caps the PEG
group arena in words (default 4,194,304; a run that needs more refuses with
`group_limit`), as JS's `cuts` and `groupWords`.

Schemas and Programs clone cheaply through immutable shared storage. Share a
Schema between threads, and use one reusable `Scratch` per concurrent caller.
`validate` builds no decoded value tree. `validate_with_options` permits a
`ValidationOptions` root policy and per-call caps, which only lower compiled
limits. Schema methods, the codec and views all default to any root under
the valid preset; `Top::Map` (or the Bindle preset) requires a map.

`Failure` preserves the generated VM's code, reason, offset, path, subcode
and budget usage. It describes one deterministic witness, not all failed
alternatives. Only schema-named keys appear in paths. The subcode is the
embedded item's own reason for `embedded`, and `cut` for a `value` refusal a
cut decided: a key matched a cut member (`name:` or `^=>`) whose value failed,
and the cut stopped the alternatives after it (D342). The requested
`Result<(), Failure>` signature also carries a missing-rule API failure as
`code == -1, reason == "unknown_rule"`; check rule names against
`schema.program().rules()` when configuring an application. JS instead throws
TypeError for this misuse. Every API that returns `Error` reports it as
`Error::Usage("unknown_rule")`, and `?` from `validate` into an `Error`
converts the `Failure` to the same (D342).

**Tagged unions.** Map cuts follow RFC 8610 §3.5.4 literally, so
`{ type: "a", x: int // type: "b", y: tstr }` rejects every `"b"` message
(`value` with subcode `cut`). Write a type choice of maps
(`{ type: "a", x: int } / { type: "b", y: tstr }`) or a cut-free `"type" =>`
discriminator; see the [guide](guide.md#discriminated-unions-under-the-rfc-cut)
and its [PEG pitfalls](guide.md#group-matching-pitfalls-peg).
`Schema::warnings()` returns the compile warnings; W8 flags this idiom:

```rust
use snug::{CompileOptions, Schema};
let s = Schema::compile("e = { type: \"a\", x: int // type: \"b\", y: tstr }", &CompileOptions::default())?;
for w in s.warnings() {
    eprintln!("{} at {}:{} in {:?}: {}", w.code, w.line, w.column, w.rule, w.message);
}
assert_eq!(s.warnings()[0].code, "W8");
# Ok::<(), snug::Error>(())
```

A Schema loaded from a serialized Program has no warnings.

**Crate-root paths.** Every type a public signature names is re-exported at
the crate root: `SchemaError` (inside `Error::Compile`), `SourceError`
(returned by an `AsyncBlob` / `Blob` read), `IoError`, `Cuts`, `Regexp` and
`AbnfMode` (fields of `CompileOptions`), `Controls`, `Warning` and
`SourceOptions`. The modules `compile`, `schema`, `sha256`, `unicode_tables`
and the generated `snug` serve snug's own test hosts; of them, use only
`snug::unicode_tables::tables()` (the optional Unicode data).

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
decoding a bignum keeps its exact content bytes. Under the `valid` preset a
bignum with leading zeroes or a small value (`2(h'01')`) is a data item
distinct from the integer of the same value (RFC 8949 §5.6.1; D342), so it
decodes to `Value::BigInt`, never `Value::Uint`, as the duplicate-key check
and CDDL matching read it. The one decoded value that does not re-encode
(D348): a map whose keys are one key once such a bignum is written as its
integer has no deterministic encoding, so `encode` and the `Writer` answer
`Error::Cbor { code: "duplicate_key", subcode: Some("normalized"), .. }`
(`Error::subcode()`), naming no key. `a200f6c240f6` ({0: null,
2(h''): null}) decodes under `valid` but does not re-encode; `a1c240f6`
re-encodes as `a100f6`. There is no decimal string
parser/normalizer yet: supply normalized parts. Decimal values do not retain
presentation scale. `Float(1.0)` encodes as the float `f93c00` under the
valid and deterministic presets and is refused under `Profile::BINDLE`; choose
`Uint(1)` for the integer. `Value::Undefined` is `f7`; `Value::Simple(n)` is
any other simple value (D284), n in 0..=19 or 32..=255 (20..=31 are refused,
`simple`), written in its shortest form (`f0`, `f8ff`) and admitted under
`undefined_value` (`View::simple` reads it). NaN is refused in typed arrays under the Bindle tag set (D265); typed infinities
and signed zero retain their bits. Byte strings use `Bytes`, not typed U8.

`DecodeOptions::default()` (also `any()` and `valid()`) is the valid preset
with any root; `DecodeOptions::deterministic()` the deterministic preset with
any root; `DecodeOptions::bindle()` is the Bindle preset with a map root, and `EncodeOptions::bindle()` its encoder. `Top`,
`cose`, `Limits` and `profile` remain separate settings.

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

### Thread stacks (D357)

Every path whose native stack grows with input or schema depth fits a 2 MiB
thread (`std::thread::Builder`'s default) at the depth ceiling (256) and the
parser-nesting ceiling (256), in debug and release builds, on Rust 1.87 and
later. The `stack` test checks this on every gate run.

- `decode`, `Schema::decode`, `View::value`, `encode` and `Writer` build and
  walk value trees iteratively (heap stacks).
- The kin scanner, the VM (one native frame per nested item it validates)
  and the compiler's parser recurse, bounded by these limits.

Measured stack per level, the slope between depth 128 and 256 (bytes, 4 KiB
resolution; Rust 1.87, 1.92, 1.98.1 and 1.100.0 on aarch64-apple-darwin):

| Path | Debug | Release |
| --- | ---: | ---: |
| `decode` / `View::open` + walk / `View::value` (the scanner) | 384 | below resolution |
| `encode` / `Writer::value` | 384 | below resolution |
| `Schema::validate` against `any` | 384 | 256 |
| `Schema::validate` / `decode` with a schema live at every level (the VM) | 1,408–1,536 | 640 |
| Compiling nested schema text (the parser, per bracket) | 512 | below resolution |
| Dropping a `Value` | 256 | below resolution |
| `Value::clone` | 1,280 | 256 |
| `Value` `==` / `{:?}` | 768–896 | up to 384 |

At the ceilings the worst case is about 380 KB, for the VM in a debug build
at depth 256. Limits never exceed the ceilings, so no larger stack is needed.
`Value`'s derived `Clone`, `PartialEq`, `Debug` and `Drop` recurse. A tree a
caller builds deeper than the 256 ceiling, which `encode` refuses, needs
about these bytes per level of its own stack.

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
copied Vec and open a view over it. No unchecked opener is exposed. Valid
input that is not its own deterministic form (indefinite lengths, longer
heads, unsorted keys) is read through its canonical copy, which a borrowing
view cannot alias: `View::open` and `Schema::view` answer
`Error::Usage("owned_view")` for it, and `snug::Document::open(&bytes,
&options)?.view()` owns the copy (D267). Sequence messages' `view()` reads the
copy the same way.

`get`, `get_key`, `at` and `entry` return optional checked views. Scalar
accessors return Option on the wrong kind; `raw` always returns the encoded
span. `int` handles major 0/1 exactly with i128; `value` materializes bignums
or a whole subtree. `typed_view` reads unaligned little-endian elements without
copying; its `get` returns `TypedElement::{Uint, Int, Float}`. `Cursor::enter`,
`next`, `up` leave their position unchanged on false. Sibling traversal skips
heads, without building sibling values or allocating per step.

## Cache Programs and validate blobs

```rust
use snug::{Schema, CompileOptions, Program, BytesBlob, SourceOptions, ValidationOptions};
let schema = Schema::compile("r = uint", &CompileOptions::default())?;
let bytes = schema.program().serialize()?;
let loaded = Schema::from_program(Program::deserialize(&bytes)?);
loaded.validate_blob(&BytesBlob(&[7]), "r", &ValidationOptions::default(), &SourceOptions::default())??;
# Ok::<(), Box<dyn std::error::Error>>(())
```

Programs use the same 96-byte-header container as JS: little-endian words,
SHA-256 integrity, format 2.0 (format word `2`; a Program using extension
controls has the same format). Loading requires major 2, a
minor no newer than the loader (1.x Programs are refused; recompile them), valid framing/digest and kin vm-verify.
Producer version is provenance and survives reserialization. `source_key()`
is the source/options SHA-256 hex cache key; namespace caches by the producing
revision while the library is experimental. **Use trusted Program origins**:
the hash is not authentication and structural verification does not establish
compiler semantic invariants. Raw words/pool accessors are shared read-only
slices; `Program::from_parts` copies and verifies them.

There is no compile-time (macro or `const`) compilation. To skip compiling
at startup, serialize at build time and embed the bytes:

```rust
use snug::{Schema, CompileOptions, Program, Error};
// build step (for example a small bin run before release):
let bytes = Schema::compile("message = { id: uint }", &CompileOptions::default())?
    .program().serialize()?;
// std::fs::write("message.snugprog", &bytes)?;
// at startup: let bytes = include_bytes!("message.snugprog");
let schema = Schema::from_program(Program::deserialize(&bytes)?);
assert!(schema.program().rules().iter().any(|r| r == "message"));

// A compile error's Display is only its code; print the position yourself:
match Schema::compile("message = { id: }", &CompileOptions::default()) {
    Err(Error::Compile(e)) => eprintln!("{} at {}:{} in {:?}", e.code, e.line, e.column, e.rule),
    other => panic!("expected a schema error, got {:?}", other.map(|_| ())),
}
# Ok::<(), Box<dyn std::error::Error>>(())
```

`Blob` is the existing host's synchronous size/read snapshot contract.
`validate_blob` folds in its session driver; it returns
`Result<Result<(), Failure>, Error>`, distinguishing source/API errors from
validation verdicts. `SourceOptions` sets how a driver reads: `chunk` (bytes
per read, 1..=2³¹ − 1, default 65,536; a need may exceed it), `quantum` (work
units between yields; 0, the default, never yields; at most 2³¹ − 1) and
`fail_fast` (streams only). Out-of-range values are
`Error::Usage("options")`. A positive quantum creates VM yields, which a
synchronous driver resumes immediately. A blob backend's `io::Error` is best
returned as `SourceError::Io(err.into())`; the driver answers `Error::Io`
with it. The driver does not buffer the entire document as an API shortcut.
Pin a remote object's version in the Blob implementation and return exactly
the requested bytes on every read. The async forms are under
[Async sources](#async-sources); source decode, view directories and Writer
sorted-key mode remain unavailable.

A message of **unknown length** (D085) is read from any `std::io::Read` until
EOF in drain mode -- the verdict equals the buffer's of the same bytes:

```rust
use snug::{Schema, CompileOptions, SourceOptions, ValidationOptions};
let schema = Schema::compile("r = [* uint]", &CompileOptions::default())?;
let reading = SourceOptions { chunk: 4096, ..SourceOptions::default() };
let mut stream: &[u8] = &[0x83, 1, 2, 3];               // any std::io::Read
let verdict = schema.validate_reader(&mut stream, "r", &ValidationOptions::default(), &reading)?;
assert!(verdict.is_ok());
let mut cut: &[u8] = &[0x83, 1, 2];                       // ends inside the array
let truncated = schema.validate_reader(&mut cut, "r", &ValidationOptions::default(), &reading)?;
assert_eq!(truncated.unwrap_err().reason, "cbor/truncated");
# Ok::<(), Box<dyn std::error::Error>>(())
```

A read error is `Error::Io` with the reader's own `io::Error`
(`std::error::Error::source()` answers it; `code()` is `read`), so a server
can tell a reset from a timeout. With `SourceOptions::fail_fast` a certain refusal is answered at once (its
code may then be another than the buffer's `cbor/truncated` / `cbor/too_large`;
accept and refuse never differ). Only what the session asks for is held, plus a
chunk. The session's key arena grows with the input read (D342), so an idle
stream session holds about 19 KiB whatever `max_bytes` is (measured
2026-11-12 with a 4096-byte chunk and 9 bytes received; before D342 the arena
was sized for the input limit, about 1.4 MiB at the default 1,500,000 bytes).
A stream that has delivered n bytes can hold up to about 2n for its key arena.
Bound concurrent streams below `max_live` and size `max_bytes` to the
protocol. For an untrusted peer prefer fail-fast: drain mode reads up
to `max_bytes` from the peer after a refusal is already certain. The low-level
`schema::Session::new_unknown`, `Step::Held` and `Session::end(n)` expose the
protocol.

## Live sessions and pooling

A session (`validate_blob`, `validate_reader`, their async forms,
`schema::Session`, a `Sequence`, `SequenceReader` or `AsyncSequenceReader`) takes its arrays from its Program's pool. It gives them back
at its verdict, or when it is dropped. Dropping is deterministic in Rust, so an
abandoned session releases its slot as soon as it goes out of scope. Each array
is zero-filled before reuse, so nothing of one session is visible to another.

While `max_live` sessions are live in the process, creating one more fails with
`Error::SessionLimit`, whose code is `sessions/limit`. The low-level
`schema::Session::new` and `Session::new_unknown` return
`Result<Session, sessions::SessionError>`, with `SessionError::Limit`, which
converts into `Error::SessionLimit`. The free `snug::read_sequence` and
`read_sequence_async` now return `Result<_, Error>` (they answered the reader
directly), as `Schema::read_sequence` already did (changed before the first
release; see the [CHANGELOG](../CHANGELOG.md)). The test hosts' low-level
`schema::validate_blob` / `validate_reader` report the limit as
`SourceError::SessionLimit`; every public driver answers
`Error::SessionLimit`.

Idle arrays are kept up to `max_pooled_bytes` in all. One entry above 1 MiB, or
above a quarter of that, is dropped instead. `release_pool()` drops every idle
entry now, which suits a long-lived process trimming memory. A dropped
Program's entries go with it.

The counters and pools are thread-safe. The policy is process-wide:

```rust
use snug::sessions::{self, SessionLimits};
let before = sessions::limits();             // max_live 1024, max_pooled_bytes 2 MiB
sessions::set_limits(SessionLimits { max_live: 256, ..before })?;
assert_eq!(sessions::counts().live, 0);      // live sessions and pooled bytes, for monitoring
sessions::release_pool();
sessions::set_limits(before)?;
# Ok::<(), snug::Error>(())
```

## Extension controls

```rust
use snug::{Schema, CompileOptions, Scratch, Controls};
let controls = Controls::generic()                         // .chars .unique .samelen
    .with("even", |_arg: &[u8], item: &[u8]| item.len() % 2 == 0);
let options = CompileOptions { controls: Some(&controls), ..CompileOptions::default() };
let schema = Schema::compile("ids = [* uint] .unique true
b = bstr .even 0", &options)?;
assert!(schema.validate(&[0x82, 1, 2], "ids", &mut Scratch::new()).is_ok());
assert_eq!(schema.validate(&[0x82, 1, 1], "ids", &mut Scratch::new()).unwrap_err().reason, "control");
let bytes = schema.program().serialize()?;
let again = Schema::from_serialized_with(&bytes, &controls)?;   // the registry is needed again
# let _ = again;
# Ok::<(), Box<dyn std::error::Error>>(())
```

A control is a `snug::controls::Control` trait object (any
`Fn(&[u8], &[u8]) -> bool + Send + Sync` is one): `check(argument, item)`
over the encodings, optional `max_bytes()` (default 65,536; a longer item
fails with `control_size` unasked), `argument()` (checked at compile time) and
`cost(item_bytes) -> u64`, the budget units charged before `check` runs
(default: one per byte; more than the budget left stops with `budget`
unasked; a predicate's own CPU is the host's responsibility, D193).
Semantics, charging and caching are the JS host's ([guide](guide.md#custom-controls)).
An unregistered `.name` is `Error::Compile` with code `unknown_control` and
`detail` naming it; loading a Program without its controls is
`Error::MissingControls(names)` (code `missing_control`); `Controls::in_bus`
admits them under the `bus` profile.

### `.abnf` / `.abnfb` (RFC 9165 §3)

```rust
use snug::{Schema, CompileOptions, Scratch, Controls, AbnfMode,
           abnf::{Abnf, check_abnf, check_abnf_in}};
let controls = Controls::new().with_abnf();                // the optional ABNF controls (D334)
let options = CompileOptions { controls: Some(&controls), ..CompileOptions::default() };
let schema = Schema::compile(r#"id = text .abnf "(1*DIGIT)\nDIGIT = %x30-39\n""#, &options)?;
assert!(schema.validate(&[0x62, b'4', b'2'], "id", &mut Scratch::new()).is_ok());
assert!(check_abnf("a\na = <prose>").unwrap_err().starts_with("prose-val"));
// strict RFC parsing by default; AbnfMode::Lenient admits snug's other forms (D340)
assert!(check_abnf("1*DIGIT\nDIGIT = %x30-39").is_err());
assert_eq!(check_abnf_in("1*DIGIT\nDIGIT = %x30-39", AbnfMode::Lenient), Ok(()));
let lenient = CompileOptions { controls: Some(&controls), abnf: AbnfMode::Lenient, ..CompileOptions::default() };
Schema::compile(r#"id = text .abnf "1*DIGIT\nDIGIT = %x30-39""#, &lenient)?;
let mut wide = Controls::new();
wide.insert_abnf(Abnf::text().with_max_bytes(1 << 20).with_max_words(1 << 24)); // .abnf only, larger bounds
# let _ = wide;
# Ok::<(), Box<dyn std::error::Error>>(())
```

`Controls::with_abnf()` adds `.abnf` (Unicode scalars) and `.abnfb` (bytes).
They are the only entries that may use these built-in names. Without them a
schema using the controls is `unsupported_control` (the `message` names
`Controls::with_abnf`), and a stored Program using them is
`Error::MissingControls`. Compile-time refusals (prose-val, syntax,
undefined rules) are `control_value`, with `detail` such as `abnf argument:
prose-val (<...>) is not supported at ABNF line 1, column 5`. Parsing is
strict RFC 5234 + RFC 7405 + RFC 9165 §3 unless `CompileOptions::abnf` is
`AbnfMode::Lenient` (D340; non-exhaustive, in the source key); under the
default, snug's non-RFC forms are `control_value` with a detail naming the
option, and `check_abnf_in(text, mode)` checks under either mode. Verdicts and
budget units are kin's (`snug::snug::abnf`), the same as JS and the wasm SDK.
`with_max_bytes` sets the item bound (default 65,536). `with_max_words` sets
the matcher's scratch cap, clamped to 65,536..=16,777,216 words (default
4,194,304, the PEG group arena's default); past it, validation stops with
`budget`. Semantics: [CDDL support](cddl-support.md#abnf-abnf-abnfb).

## CBOR sequences

A CBOR sequence (RFC 8742) is messages written back to back, for example a
long-lived HTTP response body. Each message is checked in the one pass that
finds where it ends; its `View` borrows the message's bytes (architecture §18):

```rust
use snug::{CompileOptions, Error, OnInvalid, Schema, SequenceOptions};
let schema = Schema::compile("event = { type: tstr }", &CompileOptions::default())?;
// {"type": "a"} {"type": 5} {"type": "c"}: the middle one fails the schema
let body: &[u8] = &[0xa1, 0x64, b't', b'y', b'p', b'e', 0x61, b'a',
                    0xa1, 0x64, b't', b'y', b'p', b'e', 0x05,
                    0xa1, 0x64, b't', b'y', b'p', b'e', 0x61, b'c'];
let skip = SequenceOptions { on_invalid: OnInvalid::Skip, ..SequenceOptions::default() };
let mut types = Vec::new();
for item in schema.read_sequence(body, "event", &skip)? {   // any std::io::Read
    match item {
        Ok(m) => types.push(m.view().get("type").and_then(|v| v.text()).unwrap_or("").to_string()),
        Err(Error::Sequence(f)) if f.skippable => assert_eq!((f.index, f.failure.reason), (1, "type")),
        Err(e) => return Err(e.into()),
    }
}
assert_eq!(types, ["a", "c"]);

// Push: messages inside the fed chunk borrow it; those spanning chunks own an assembly.
let mut seq = schema.sequence("event", &SequenceOptions::default())?;
let first = seq.feed(&body[..12]);
assert!(first[0].as_ref().is_ok_and(|m| m.is_borrowed() && m.offset == 0));
let rest = seq.feed(&body[12..]);
assert!(rest[0].is_err());   // OnInvalid::Stop: the refusal ends the sequence
assert!(seq.is_done());
# Ok::<(), Box<dyn std::error::Error>>(())
```

`SequenceOptions` carries the per-message limits (`max_message_bytes`, depth,
entries, items, bignum bytes, budget), the profile, `top`, `cose`,
`on_invalid` (`Stop` by default; `Skip` skips only schema refusals of complete
messages), `fail_fast` and the read `chunk`. A refusal is
`Error::Sequence(MessageFailure { index, message_offset, offset, failure,
skippable })` with absolute offsets; EOF inside a message is
`cbor/truncated`, a message not ending within `max_message_bytes` is
`cbor/too_large`. `snug::read_sequence` / `Sequence::new` check the profile
only; they return `Err(Error::SessionLimit)` at the live-session bound
([Live sessions and pooling](#live-sessions-and-pooling)). The `Read` iterator copies each message out of its read buffer; the push
API borrows the caller's chunk instead.

## Async sources

The blob, stream and sequence drivers have async forms (P9.6, D027) over the
same resumable session: the VM never awaits; each driver asks the session what
it needs, awaits that one read and steps again. Verdicts, codes, offsets,
paths and budget are the sync forms' for every chunking (gated in `bb
rust-api-test`, `tests/async_sources.rs`). The crate stays dependency-free and
runtime-agnostic: any executor drives the futures (tokio, async-std, smol, or
the few lines of `block_on` hidden in this example).

```rust
use snug::{AsyncSource, CompileOptions, Schema, SequenceOptions, SourceOptions, ValidationOptions};
# fn block_on<F: std::future::Future>(f: F) -> F::Output {
#     struct W; impl std::task::Wake for W { fn wake(self: std::sync::Arc<Self>) {} }
#     let waker = std::task::Waker::from(std::sync::Arc::new(W));
#     let mut cx = std::task::Context::from_waker(&waker);
#     let mut f = std::pin::pin!(f);
#     loop { if let std::task::Poll::Ready(v) = f.as_mut().poll(&mut cx) { return v; } }
# }
let schema = Schema::compile("event = { type: tstr }", &CompileOptions::default())?;
block_on(async {
    // a message of unknown length (drain mode); `&[u8]` is an AsyncSource
    let mut body: &[u8] = &[0xa1, 0x64, b't', b'y', b'p', b'e', 0x61, b'a'];
    let reading = SourceOptions { chunk: 4096, quantum: 1024, fail_fast: true };
    let verdict = schema.validate_reader_async(&mut body, "event", &ValidationOptions::default(),
                                               &reading).await?;
    assert!(verdict.is_ok());

    // a CBOR sequence: next() answers what the sync iterator yields
    let two: &[u8] = &[0xa1, 0x64, b't', b'y', b'p', b'e', 0x61, b'a',
                       0xa1, 0x64, b't', b'y', b'p', b'e', 0x61, b'b'];
    let mut messages = schema.read_sequence_async(two, "event", &SequenceOptions::default())?;
    let mut types = Vec::new();
    while let Some(m) = messages.next().await {
        types.push(m?.view().get("type").and_then(|v| v.text()).unwrap_or("").to_string());
    }
    assert_eq!(types, ["a", "b"]);
    Ok::<(), Box<dyn std::error::Error>>(())
})?;
# Ok::<(), Box<dyn std::error::Error>>(())
```

| Sync | Async | JS |
| --- | --- | --- |
| `Schema::validate_blob(&dyn Blob, rule, options, &SourceOptions)` | `Schema::validate_blob_async(&impl AsyncBlob, rule, options, &SourceOptions).await` | `validateHandle` |
| `Schema::validate_reader(&mut dyn Read, rule, options, &SourceOptions)` | `Schema::validate_reader_async(&mut impl AsyncSource, rule, options, &SourceOptions).await` | `validateStream` |
| `read_sequence(impl Read, options)`, `Schema::read_sequence` | `read_sequence_async(impl AsyncSource, options)`, `Schema::read_sequence_async` → `AsyncSequenceReader::next().await` | `readSequence` |

`SourceOptions { chunk, quantum, fail_fast }` is JS's `SourceOptions`
(`chunk`, `quantum`, `failFast`). The results are the sync forms':
`Result<Result<(), Failure>, Error>` (source and API errors outside, verdicts
inside) and `Option<Result<Message<'static>, Error>>` per sequence item, with
the same argument checks (`chunk` 0 or above 2³¹ − 1, or a quantum above
2³¹ − 1, is `Error::Usage("options")`) and source errors (`short_read`,
`too_large`, and `Error::Io` for a transport error).

**Sources.** `AsyncSource` is a forward-only stream with the signature of
`futures_io::AsyncRead::poll_read` (`Ready(Ok(0))` is the end; `Interrupted`
is retried; any other error ends the validation with `Error::Io`, which keeps
the original `io::Error` behind `source()`). It is implemented for
`&[u8]`, `&mut S`, `Box<S>` and `Pin<P>`; the drivers take `S: Unpin` (pin a
`!Unpin` source in a `Box`). `AsyncBlob` is the async `Blob`: `size()` and
`read(offset, len)` returning any future (write `async fn read`), exactly
`len` bytes of an immutable snapshot. Adapters for other runtimes are a
newtype, for example:

```rust,ignore
use std::{io, pin::Pin, task::{Context, Poll}};
// futures-io (async-std, smol): same signature
struct Futures<T>(T);
impl<T: futures_io::AsyncRead + Unpin> snug::AsyncSource for Futures<T> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}
// tokio: through a ReadBuf
struct Tokio<T>(T);
impl<T: tokio::io::AsyncRead + Unpin> snug::AsyncSource for Tokio<T> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        let mut rb = tokio::io::ReadBuf::new(buf);
        match Pin::new(&mut self.0).poll_read(cx, &mut rb) {
            Poll::Ready(Ok(())) => Poll::Ready(Ok(rb.filled().len())),
            Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
            Poll::Pending => Poll::Pending,
        }
    }
}
```

**HTTP bodies.** A body that arrives as a `Stream` of `Bytes` frames (hyper,
axum) becomes an `AsyncRead` through `tokio_util::io::StreamReader` (map
the body's error into `io::Error`), then the tokio adapter above. Limit the
body length at the transport as well.

**Scheduling and backpressure.** One read is in flight, issued only when the
session asks for bytes its window lacks. A positive `quantum` makes the
session yield after about that many work units; the async driver then answers
`Pending` once, having woken itself, so a long validation shares its executor
thread (JS's `nextTurn`). Quantum 0 never yields. Neither changes a verdict or
the budget. A blob holds one window of `max(need, chunk)` bytes; a stream holds
what the session keeps plus one `chunk` (the key arena grows with the input
read, as sync); a sequence holds the message in progress (its
`max_message_bytes` bounds it) plus a `chunk` read buffer
(`AsyncSequenceReader::bytes_held`). A sequence feeds each read synchronously,
so its work per poll is bounded by `chunk`.

**Cancellation.** Dropping a validation future drops its session; nothing
else is left behind, and the Schema stays usable. The source is then at an
unspecified position (bytes already read are consumed). `next()` is
cancel-safe: a read that completes is fed before it returns and a `Pending`
read consumed nothing, so dropping a `next()` future loses no message.
`AsyncSequenceReader::poll_next` is the hook for a `Stream` adapter. The
futures are `Send` when the source, the blob and its read future are.

## Handle errors safely

`Error` implements Display and `std::error::Error`. Match its family and use
`code()` for stable codes matching JS: unprefixed CBOR faults, `schema/...`
schema-decode faults, compiler codes, Program codes and source codes. Fixed
Rust API-misuse codes (`options`, `unknown_rule`, etc.) cover boundaries for
which JS uses TypeError. `Failure.reason` and `Error::code()` spell the same
failure differently: a profile failure is `Failure.reason == "cbor/truncated"`
but `Error::code() == "truncated"`, and a schema failure is `"type"` versus
`"schema/type"` (the JS `ValidationResult.reason` and `SnugFault.code`
spellings). `Failure.code` is the VM's numeric code, for diagnostics only;
compare `reason`. Display contains only a code; Debug retains safe
schema locations/paths. Library failures never contain input bytes, received
values or unnamed data keys. `Error::Io` carries the transport's own error
(`IoError::kind()`, `get_ref()`, and `source()`); its Display stays the code,
and transport implementations must sanitize their own messages before
logging them. Allocator exhaustion retains standard Rust allocator behavior.

## Enums that may grow

Some public enums are `#[non_exhaustive]` (D339): a later release may add a
variant to them without a breaking release, so a `match` on one outside the
crate needs a fallback arm (`_ => …`). Treat an unknown error or source
variant as a refusal, and render an unknown path segment generically.

| `#[non_exhaustive]` | Why |
| --- | --- |
| `Error`, `SourceError`, `sessions::SessionError` | error families: new codes are additive (release-policy §1.3) |
| `Segment` | diagnostic paths; a new construct may need a new segment kind |
| `Top`, `Keys`, `Tags`, `Floats` (in `Profile`), `Cuts`, `Regexp`, `CompilerProfile`, `OnInvalid` | options: a new mode or preset is a minor change |

These stay exhaustive, so a `match` can cover every case without a fallback:

- `Value`, `Integer`, `TypedArray` and `TypedElement`: the decoded CBOR data
  model. Code that walks a value tree needs every case. A new tag gets no
  new variant (it decodes as `Value::Tag`). A new dedicated variant would
  change what `decode` returns for existing input, so it is breaking anyway.
- `schema::Step`: the session protocol. A driver that ignored a new step
  would be wrong, so adding one is deliberately a breaking change.
