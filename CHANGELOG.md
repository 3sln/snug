# Changelog

All notable changes to snug are recorded here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), with a
**Breaking** group listed first and a **Budget and limits** group. Versions
follow the release policy, `docs/release-policy.md` in the snug repository
(semantic versioning; one version for every artefact). Lines name an
artefact — `[js]`, `[rust]`, `[wasm-sdk]` — when they do not apply to all;
`(D###)` cites the decision in the repository's `DEVLOG.md`. These are plain
paths, not links, because this file ships in the npm package and the crate,
and neither contains those files.

## [Unreleased]

### Breaking

- `[rust]` `SequenceOptions` is `#[non_exhaustive]`: build it from
  `SequenceOptions::default()` and set its fields; a struct literal, even
  with `..SequenceOptions::default()`, no longer compiles outside the crate.
  It has a new field, `quantum`: work units between yields for
  `read_sequence_async` and `Schema::read_sequence_async`, which answer
  `Pending` (after waking themselves) once per yield, inside a long message
  too. The sync readers (`read_sequence`, `Schema::read_sequence`,
  `Sequence`) never yield, and refuse a nonzero quantum with
  `Error::Usage("options")`, as JS's `sequenceReader` refuses one (D371).
- `[rust]` `Sequence::feed` and `Sequence::finish` after the sequence has
  ended (`finish`, or a refusal that stops it) answer one
  `Error::Usage("ended")`; they answered nothing. JS and the wasm SDK throw
  `TypeError` there already (D371).
- `[rust]` `SourceError::TooLarge` is removed, and with it
  `Error::Source("too_large")`. A blob of 2³¹ bytes or more now gets the
  verdict `cbor/too_large` at offset 0, unread, as a smaller blob over the
  input limit does. `[js]` `[wasm-sdk]` The same for a handle, and for a
  push source's declared length: `validateHandle`, `validateHandleSync` and
  `pushValidator(schema, length, …)` answer that verdict, and `scanHandle`,
  `scanHandleSync` and `pushScanner(length)` throw `SnugFault` `too_large`
  (a push source at its first step, as one of 2³¹ − 1 bytes over the limit);
  they threw `TypeError`. `openSession(schema, rule, length)` still refuses
  such a length with `TypeError` (D371, D371a).
- `/=` on a prelude name extends the prelude rule instead of replacing it:
  RFC 8610 Appendix D adds the prelude to every schema. `uint /= tstr` now
  accepts `1` as well as `"a"`, and the prelude rules built on the name
  follow (`int /= bool` widens `int` and `integer`). Every prelude rule is a
  plain type, so `//=` on a prelude name is now `type_group_mismatch` and a
  generic `/=` on one is `generic_arity`. To replace a prelude rule, define
  it with `=` (D372).
- Tab-indented schemas need `lexing: 'lenient'` (Rust `Lexing::Lenient`).
  Schema text is lexed as RFC 8610 Appendix B says by default: whitespace is
  space, LF and CR LF, and a comment holds no control characters. A tab, a
  lone CR, or a C0, DEL or C1 character in a comment is now `syntax`, with a
  message naming the option (D373).

### Added

- The compile option `lexing: 'strict' | 'lenient'` (Rust
  `CompileOptions::lexing`, `Lexing`, `#[non_exhaustive]`): `'strict'` is the
  default; `'lenient'` is 0.1.0's lexer. A comment on the last line needs no
  newline in either. `'lenient'` is part of the source key (D373).

- Decimal float literals in a schema may have up to 20 significant digits
  (17 before), still rounded exactly and identically on every host, so
  `1.0000000000000001111` is 1 + 2⁻⁵². A longer one is `float_literal`
  (D372).

### Budget and limits

- Documented: under `wire: 'valid'` a validation call can do up to about
  twice its budget's work, plus passes linear in the input, and one compile
  can do up to (restarts + 1) × `compileBudget` (at most 9×, usually under
  2×). Size budgets for both (D371).

### Fixed

- `bstr .cborseq any` compiles: `any` matches every array, so the content
  is any CBOR sequence, as `[* any]` (RFC 8610 §3.8.4); it was
  `control_value`. Every other controller type must still be an array:
  `bstr .cborseq uint` and an AND of arrays such as
  `[* uint] .and [2*2 any]` stay `control_value` (D372, D373).
- An occurrence `n*m` with m < n, such as `[3*2 uint]`, compiles and
  matches nothing (RFC 8610 §3.2); it was `syntax`. The new compile
  warning W9 flags it (D372).
- `[wasm-sdk]` A session or sequence reader closed by an extension
  predicate from inside its own step is freed when the step ends, and that
  step answers `TypeError` ("closed during its step"), as natively. Before,
  the close met the instance's guard and threw, and a predicate that caught
  that left the session live: the reader counted as ended, so nothing freed
  it until garbage collection. A reader whose close throws is no longer
  marked ended, so a later close still frees it (D371).
- `[wasm-sdk]` The runtime module no longer makes two mutable references
  to its state at once (navigation lookups read the key buffer while
  holding the navigation words); an export called while another runs now
  traps, which the SDK reports as `InstanceLost`. No verdict changes (D371).

### Security

- `[js]` `[wasm-sdk]` `view(bytes, { schema, rule })` and
  `View.validateAt(rule, { schema })` take only a Schema made by the same
  package; any other object is a `TypeError`. An object with a Schema's
  methods passed the options check: the JS view trusted its answer, so one
  that answered `ok` opened a View of bytes nothing had checked, and the
  wasm SDK's let it choose the rule the bytes were checked against (D371).

## [0.1.0] — 2026-11-17

The first release. The **Breaking**, **Fixed** and **Security** entries
compare it with development builds from the repository.

### Added

- CDDL (RFC 8610, with RFC 9165 controls and RFC 9682 grammar) compiled to
  a verified Program; `compile(text, options)` with compiler profiles
  `full`, `bindle` and `bus`, and compile-time resource limits. Compile
  warnings are `schema.warnings` (JS, wasm SDK) and `Schema::warnings()`
  (Rust) (D342).
- Validation directly over CBOR bytes in one pass, with no decoded value
  tree; `schema.validate`, `schema.decode`, `validateAt`. Refusals carry a
  code, an offset and a schema-named path, never payload values (SPEC §4).
- PEG semantics for groups in arrays and maps (D270), with the RFC's
  literal cut as the default and `cuts: 'branch'` as an option (D301);
  the compiler's warning W8 flags discriminated unions that the RFC cut
  makes fail, and such a refusal is `value` with the subcode `cut` (D342).
- `Schema` and `Program` refuse structured cloning: `postMessage` and
  `structuredClone` throw `DataCloneError` (a `brand` Symbol) instead of
  silently making a plain object without methods; send
  `program.serialize()` bytes (D342). `[js]` `[wasm-sdk]`
- `[js]` `npm run build` warns on stderr, listing the paths, when the
  package's sources have uncommitted or untracked changes.
- `[rust]` Every type a public signature names is re-exported at the crate
  root: `SchemaError`, `SourceError`, `Cuts`, `Regexp`, `AbnfMode`,
  `Controls`, `Control`, `Warning`, `IoError`, `SourceOptions` (D342).
- `[rust]` `Error::Io(IoError)` and `SourceError::Io` keep a transport's
  own `io::Error`, reachable through `std::error::Error::source()`;
  `code()` is still `read` (D342).
- `[rust]` Depending on `host/rust` without assembling the crate fails with
  one `compile_error!` naming `kin/scripts/rust-crate`.
- CBOR codec `encode` / `decode` with exact integers, bignums, decimal
  fractions, typed arrays and ndarrays; encoders always write RFC 8949
  §4.2.1 deterministic bytes.
- Wire presets: `valid` (the default: any valid CBOR, duplicate keys
  refused by value; D260), `deterministic` (RFC 8949 §4.2.1 checked on
  read) and the optional `bindle` preset (D080), with per-option overrides.
- Checked views and a cursor (`@3sln/snug/view`) and a typed `Writer`
  (`@3sln/snug/writer`).
- Sources (`@3sln/snug/sources`): handles, push sources and unknown-length
  streams validated by the resumable session VM, with verdicts identical
  to the buffer's (drain mode by default, opt-in fail-fast; D085).
- CBOR sequences (RFC 8742) in `@3sln/snug/sequence` and Rust `read_sequence` /
  `Sequence` (D210–D219).
- Extension controls: registered `.name` controls decided by host
  predicates, with generic `.chars`, `.unique` and `.samelen` in
  `@3sln/snug/controls` (D082, D140–D143).
- `.regexp` in the XSD dialect by default, RFC 9485 I-Regexp as an option
  (D242); Unicode categories through the optional `@3sln/snug/unicode` tables
  (Unicode 16.0; D083).
- `.abnf` / `.abnfb` (RFC 9165 §3) through the optional ABNF module:
  `@3sln/snug/abnf` (`abnf`, `abnfWith`, `checkAbnf`), Rust
  `Controls::with_abnf()`, wasm SDK `@3sln/snug-wasm/abnf`. It checks
  RFC 5234 + RFC 7405 grammar membership with a bounded, budget-metered
  Earley recognizer. Without the module these controls are
  `unsupported_control` (D334). Controllers parse as strict RFC 5234 +
  RFC 7405 + RFC 9165 §3 by default. The compile option `abnf: 'lenient'`
  (Rust `CompileOptions::abnf`, `AbnfMode::Lenient`) admits snug's wider
  forms, such as a wider start or a controller that begins with a rule. The
  option is in the source key; `checkAbnf(text, { abnf })` and Rust
  `check_abnf_in` check under either mode (D340).
- RFC 9682 head numbers `#7.<T>` (D336).
- Serialised Programs, format 2.0: `program.serialize()`,
  `fromSerialized` (verified, no compiler needed), `sourceKey` for caches
  (D084, D318).
- Session pooling and a bound on live sessions: `sessionLimits({ maxLive,
  maxPooledBytes })`, `releasePool()`, `close()` / `[Symbol.dispose]` on
  sessions, and the `sessions/limit` error; Rust
  `snug::sessions::{limits, set_limits, counts, release_pool}` (D327).
- `[rust]` The crate: compile, validate, decode, Writer, views, blob and
  reader sources, sequences, and async source drivers with no runtime
  dependency (`validate_blob_async`, `validate_reader_async`,
  `read_sequence_async`; D331).
- `[wasm-sdk]` Experimental: the same JS API over the Rust build as
  WebAssembly, opt-in (D130), as the npm package `@3sln/snug-wasm` (D345).
  `init` loads the runtime module from a path, URL, `Response`, bytes or a
  `WebAssembly.Module`, and `init({ runtime, compiler })` sets both
  modules; `@3sln/snug-wasm/inline` carries both modules as base64 for
  `initSync()` with no files; `/unicode` re-exports the Unicode tables; the
  `.wasm` files are exported for Workers module bindings. The raw modules
  are release artefacts too, with their SHA-256 and a build manifest.
- `SECURITY.md`: how to report a vulnerability (contact+security@3sln.com)
  and what counts; it ships in both npm packages and the crate.

### Breaking

These matter only to code written against development builds from the
repository.

- `.default` now carries RFC 8610 §3.8.6's implied `.ne`: `uint .default 1`
  refuses `1` (D359). The compile option `defaultControl: 'annotation'`
  (`[rust]` `CompileOptions::default_control = DefaultControl::Annotation`)
  restores the annotation-only reading, which RFC 8610 erratum 9229 (status
  Reported) proposes. It is bound into the source key. A `.default` whose
  `.ne` cannot be lowered (an array, a map or a range default, or the target
  `any`) is refused with `unsupported_control`.
- Under `valid`, a tag-24 payload need only be well-formed, as RFC 8949
  §3.4.5.1 asks: a duplicate key or invalid UTF-8 inside it is no longer
  refused (D358). Pass `tag24: 'valid'` (`[rust]` `wire: Profile { tag24:
  Tag24::Valid, ..Profile::VALID }`) to require a valid item. `.cbor T` still requires
  one, and so do `deterministic` and Bindle.
- Bignums under `valid` follow one rule (D363). `biguint`, `bignint`,
  `bigint` and `#6.2/3(bstr)` match every tag 2/3 bignum, leading zeroes
  and small values included. Ranges and numeric controls compare bignums by
  value: `0..5` and `unsigned .le 5` match `2(h'01')`, while `uint .le 5`
  and the literal `1` do not.
- `.size` and `.bits` on an integer type that admits negative values
  (`int .size 1`) are refused with `control_target`. They used to narrow it
  to `uint`.
- `[rust]` `Profile` has a new field, `tag24`, and `CompileOptions` has a
  new field, `default_control`: struct literals that name every field need
  them. The low-level compile option array is 23 words; the
  extension-control registry starts at word 23, and word 22 is the
  `.default` reading.
- Package names (D343): the npm package is `@3sln/snug`, so imports read
  `@3sln/snug`, `@3sln/snug/compile` and so on, not `snug`. The wasm SDK
  is `@3sln/snug-wasm` (was `snug-wasm-sdk`). `[rust]` The crate is
  `snug-cbor`; its library is still `snug`, so `use snug::…` is unchanged.
- Prelude `float16` / `float32` / `float64` now match floats **by value**,
  not by encoded width. `float32` accepts a 1.5 encoded as float16, and
  `float64` accepts every float (D328; RFC 8610 §3.3). Use a wire preset
  to constrain encodings.
- The default wire preset is `valid`, no longer `deterministic` (D260).
  Pass `wire: 'deterministic'` to check §4.2.1 on read.
- The default cut is the literal RFC cut (D301). Some map choices that
  matched under the old per-alternative rule now fail; `cuts: 'branch'`
  restores it. The option value `'reference'` is refused.
- Program format 2.0: format 1.x Programs are refused with `ProgramError`
  `format_version`, so recompile from CDDL (D318, program-2 §1).
- `[rust]` `schema::Session::new` and `new_unknown` return
  `Result<Session, sessions::SessionError>`; `read_sequence` and
  `read_sequence_async` return `Result<_, Error>`; `Error` and
  `SourceError` gain `SessionLimit` (D327).
- `f8` followed by a byte below `0x20` is `malformed` under every preset,
  as RFC 8949 §3.3 says ("Such sequences are not well-formed"). The
  `deterministic` and `bindle` presets used to answer `non_shortest` (below
  24) or, under `bindle`, `simple` (D342, amends D284).
- `[js]` `[wasm-sdk]` A bignum outside preferred serialization (leading
  zeroes, or a value major type 0/1 can hold; accepted under `valid` only)
  decodes to `Tagged { tag: 2 | 3, value: Uint8Array }` of its exact bytes,
  not to a number or bigint: RFC 8949 §5.6.1 makes it a data item distinct
  from the integer, as the duplicate-key check and CDDL matching already
  treated it. A map with keys `1` and `2(h'01')` now decodes instead of
  throwing `unsupported`. Encode writes such a `Tagged` as its integer
  (D342).
- `[rust]` The source drivers take their read settings in one struct:
  `Schema::validate_blob(blob, rule, options, &SourceOptions)` and
  `validate_reader(reader, rule, options, &SourceOptions)`, and the async
  forms the same, instead of positional `chunk`, `quantum: u32` and
  `fail_fast` (D342). `SourceOptions { chunk, quantum, fail_fast }`
  defaults to 65,536 / 0 / false; `quantum` is `u32` everywhere public.
  The free `snug::validate_blob` (a duplicate of the method) is removed;
  `async_source::validate_blob` / `validate_reader` (the test hosts'
  low-level forms) are hidden from the docs.
- `[rust]` An unknown rule is `Error::Usage("unknown_rule")` from every API
  that returns `Error` (the blob and reader drivers, `decode`, `view` and
  `document` returned `Error::Validation` with reason `unknown_rule`), and
  `Error::from` a `Failure` with code −1 gives the same (D342).
- `[rust]` A transport error is `Error::Io` with the original error, not
  `Error::Source("read")`; `code()` stays `read` (D342).
- `[rust]` `Error::Cbor` gains `subcode: Option<&'static str>` (read it with
  `Error::subcode()`); code building or matching the variant needs the new
  field or `..` (D348).
- `[js]` `[wasm-sdk]` `VmSession` (the type `openSession` returns) is now a
  type alias, not an interface, so declaration merging into it no longer
  works (D356).

- `[rust]` The wire profile field is `wire`, not `profile`, in
  `DecodeOptions`, `EncodeOptions`, `ValidationOptions` and
  `SequenceOptions` (`CompileOptions::profile` stays the CDDL restriction
  set). The runtime limits are flat `Option<u32>` fields in every runtime
  options struct, as in the JS options bags: `DecodeOptions` and
  `EncodeOptions` lose `limits: Limits` for `max_bytes`, `max_depth`,
  `max_entries` and `max_items` (`None` is the default), and the `Limits`
  type is gone. Write `DecodeOptions { max_depth: Some(8), ..Default::default() }`
  (D360).
- `[rust]` The generated core modules are no longer the public module
  `snug::snug` (now an undocumented `snug::generated` for the test hosts), so
  `use snug::*;` compiles. `schema::Session` and `schema::Step` are internal;
  the drivers (`Schema::validate_blob`, `validate_reader`, their async forms)
  and `Sequence` are the session API (D361).
- A codec `maxDepth` above 256 is refused with `TypeError` in JS and the
  wasm SDK (decode, encode, the Writer, schema-less views, scans and
  profile-only sequences), as Rust's codec options already were; a deeper
  bound let input exhaust the stack or the wasm instance instead of
  answering `depth`. A schema's per-call `maxDepth` still only lowers the
  Program's compiled depth (at most 256).
- `[rust]` A `Sequence` whose `feed` or `finish` did not return (an
  extension predicate panicked) answers `Error::Usage("poisoned")` from every
  later call instead of running on half-updated state. The free
  `read_sequence` / `read_sequence_async` refuse `chunk: 0` with
  `Error::Usage("options")`, as `Schema::read_sequence` does.

### Changed

- Encoding a map whose keys are one key once a non-preferred bignum (a
  decoded `Tagged` 2/3 of bytes, or Rust's `Value::BigInt`) is written as
  its integer fails with `duplicate_key` and the subcode `normalized`: such
  a map has no deterministic encoding. `a200f6c240f6` ({0: null,
  2(h''): null}) decodes under `valid` but does not re-encode; this is the
  one decoded value that does not (D348).
- Minimum supported toolchains: `[js]` Node 20 (`engines`), `[rust]` Rust
  1.87 (`rust-version`). Each is tested on exactly that version before a
  release. Node 20 is past upstream end of life, so its floor may rise in
  a minor release, with notice (D344).
- Numeric controls compare integer and float values exactly, across kinds
  (`number .ge 0` compiles; D329).
- `.cat` and `.det` join text with byte strings, and the result has the
  target's type (D330).
- Under `valid` and `deterministic`, unassigned simple values are accepted
  as `Simple`; `bindle` still refuses them (D284).

### Budget and limits

- Default validation budget: 2,250,000 units (D241). Unit prices were
  calibrated so that kinds of work cost about equal CPU per unit (D241,
  D253, D316). Exact unit counts are not stable between releases (see the
  release policy).
- Default input limits: 1,500,000 bytes, depth 32, 65,536 entries per
  container, 131,072 items, 128-byte bignums.
- Default session limits: 1024 live sessions and 2 MiB of pooled arrays
  per isolate or process (D327).

### Fixed

- `[js]` `[wasm-sdk]` A value that decodes under `valid` with a tag-24
  payload that is only well-formed (invalid UTF-8 or a duplicate key inside
  it) encodes again: `encode` and the `Writer` check the payload with
  decode's rule, as the Rust host already did (D358).
- A resumable session (a source, a handle or a push validator) over a
  valid, non-deterministic map that is refused partway could spend minutes
  of uncharged CPU on the bytes past the refusal before answering; it now
  answers at once with the same result (D367).
- `.det` dedents lines that end in CR LF: a line of spaces before CR LF is
  blank, as RFC 9165 §2.3 says.
- `tstr .size -1` matches nothing; a negative size was read as 0.
- The integer literal `-0` is 0; it matched nothing.
- `#0.n` to `#3.n` compile, by value (RFC 8610 §2.2.3: `n` is the head's
  additional information, so `#0.24` is 0..255). `#4.n` and `#5.n` are still
  refused with `major`.
- `bool .default false` and `.ne` on a single simple value compile.
- A recursive Program's session arena grows with the input read instead of
  reserving the whole message's bound up front (D337).
- `[rust]` The unknown-length reader no longer panics when a positive
  quantum yields after the end (D331).
- A stream session's key arena grows with the input read instead of being
  sized for the input limit: an idle unknown-length session holds about
  19 KiB (Rust) / 50 KiB (JS) instead of about 1.4 MiB at the default
  1,500,000-byte limit (D342).
- `[rust]` A driver `chunk` above 2³¹ − 1 is `Error::Usage("options")`; it
  used to panic (`capacity overflow`) or reserve that much.
- `[rust]` A decoded decimal fraction whose mantissa is a bignum outside
  preferred serialization stays a `Value::Tag`, as in JS (D342).
- A view under a schema of valid input that is not its own deterministic
  form (an indefinite-length item, a non-preferred head) reads its canonical
  copy again under a Program with `.cbor` (or a tag-24 payload). It used to
  walk the raw bytes and throw `navigation failed` (`[rust]`
  `Schema::view` borrowed them). A map out of canonical order in such an
  item was searched as if sorted, so lookups could miss keys (D351).
- `[js]` `view(bytes, { schema, rule })` with a Schema from `@3sln/snug/compile`
  or `@3sln/snug/schema` reads valid, non-deterministic input through its
  canonical copy; it threw `navigation failed` (D351).
- `[rust]` `decode`, `Schema::decode`, `View::value` and `encode`/`Writer`
  build and walk value trees iteratively. In a debug build on Rust 1.98, the
  recursive versions overflowed a 2 MiB thread at the 256-level depth
  ceiling (about 8.8 KB per level). Every depth path now fits a 2 MiB thread
  at the ceilings, in debug and release, on Rust 1.87 and later; the limits
  are unchanged (D357).
- `[js]` `[wasm-sdk]` The type declarations failed to compile under ES2022
  (TS2550 on `[Symbol.dispose]`). The dispose member is now conditional: a
  session is `Disposable` where the consumer's lib declares
  `Symbol.dispose`, and plain ES2022 types it with `close()` only (D356).
- `[js]` `[wasm-sdk]` On an engine without `Symbol.dispose`, a session's
  prototype no longer gets a method named `undefined`; `[Symbol.dispose]()`
  is defined only where the symbol exists. `close()` is unchanged (D356).

- `[wasm-sdk]` After `trim()`, rule and key lookups (view `get`, a new rule
  name) trapped and the instance was lost on every later call: `trim()` now
  forgets the key scratch it frees.
- `[wasm-sdk]` A failed push source, a session refused with an internal
  error, and every View/Cursor navigation call now free their session or
  reset the instance (`InstanceLost`) like every other entry point.
- `[js]` `[wasm-sdk]` `sessionLimits` refuses limits above 2³¹ − 1 on both
  builds; validateAt clamps the enclosing `depth` and `items` instead of
  wrapping them to 32 bits.
- `[rust]` A reader or async source that reports more bytes than the buffer
  holds is an error (`read`), never a slice panic.
- `[js]` `fromSerializedSync(bytes, options?)` loads a stored Program
  synchronously, as the wasm SDK's does.
- `[js]` `[wasm-sdk]` `pushValidator` with a declared length accepts
  `failFast` without effect, as `pushScanner` and the handle drivers do (it
  threw `TypeError`); `failFast` changes only an unknown-length message.

### Security

- `[js]` A session or sequence reader closed from inside its own step (by
  an extension predicate) gave its arrays back to the pool while the step
  was still writing them, so a session opened next on the same Program,
  for example in the same predicate, shared them with it: each could see
  and change the other's state. The arrays now go back when the step ends,
  and that step throws `TypeError` instead of answering. Predicates are
  documented as never calling back into snug; the Rust API and the wasm
  SDK already prevented this (D347).
- `[js]` `[wasm-sdk]` A stream that failed (its source threw, or yielded a
  non-`Uint8Array`) held its session's live slot until garbage collection
  (the wasm SDK: until the reader was collected), so a peer that
  disconnected mid-message repeatedly could exhaust `sessions/limit`.
  `validateStream`, `scanStream` and the push sources now release the
  session when they fail.
- `[js]` `end()` on an unknown-length session after an extension predicate
  threw wrote into the session's arrays, which were already back in the
  pool and possibly another session's. It now answers the predicate's
  error, as `step()` does, and is refused inside the session's own step.
- `[js]` An extension control received a view of an isolate-shared buffer
  (the canonical copy of valid input), through which it could read other
  requests' bytes, and a view of the Program's pool. It now receives copies
  holding exactly its argument and its item.
- `[wasm-sdk]` Input longer than `maxBytes` (or the Program's compiled
  input limit) is refused with `too_large` before it is copied into linear
  memory, which never shrinks; it used to grow the instance by the whole
  input first.
- `[wasm-sdk]` Loading a Program sizes the verifier's scratch from its
  words, not from an unverified count in them (also `[js]` `[rust]`).
- `[rust]` A map with alternative members, after a head whose argument was
  2³¹−1 or more, overflowed a counter in the VM's map cursor. A build with
  overflow checks panicked on valid input such as `a261621a7fffffff616300`,
  and a release build wrapped the counter, which was never read on that
  path. The counter is now kept only where it is read (D362).
