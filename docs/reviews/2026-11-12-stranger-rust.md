# Stranger review: snug from Rust (streaming over async I/O, sync buffers, wasm SDK), 2026-11-12

First impression: the core works. Every Rust snippet in the docs compiles and
runs. With the tokio adapter from the docs, a 2.2 MB discriminated-union
message validated correctly when delivered 7 bytes at a time, and the result
matched the synchronous buffer verdict. Cancellation via `tokio::time::timeout`
released the session cleanly. The weak points sit in what a server author
reaches for next. Transport errors are collapsed to an opaque `Source("read")`.
The memory each live stream holds is large and not documented: about
0.93 × `input_bytes`, which is roughly 1.4 MiB per idle connection at the
defaults, and up to about 1.4 GiB at the default 1024-session cap. Several
public signatures make you name types from modules that the README calls
"test-host only". The compile warning (W8) that the docs tell you to rely on
for tagged unions is unreachable from the public `Schema` API. The README, the
Rust guide and rustdoc disagree on the default root and the Program format
version. The wasm SDK has no user documentation at all.

What I read and ran: README.md, host/rust/README.md, host/rust/Cargo.toml,
docs/rust.md, and the relevant parts of docs/guide.md, docs/api.md,
docs/profiles.md, docs/release-policy.md, docs/conformance.md and
CHANGELOG.md. I also read host/wasm-sdk/package.json and the rustdoc HTML I
generated (`cargo doc --offline --no-deps`). I read no sources under
host/*/src, kin/ or gen/. Checkout: the p910 worktree at `ac08ec2`, plus
uncommitted doc edits by someone else that were present while I read
(README.md, docs/api.md, docs/guide.md and others). I assembled the crate with
`kin/scripts/rust-crate ../p910-review-rust/snug-rs`, the documented script,
pointed at my scratch directory. A depending crate lives in
`.cache/p910-review-rust/review` with `CARGO_TARGET_DIR` inside it, and tokio
1.54 and futures 0.3 came from the offline cargo cache. I ran:

- every `rust` block of docs/rust.md and host/rust/README.md as doctests via `include_str!` (12 passed; 1 is `ignore`);
- the tokio and futures-io adapters from rust.md, completed with imports;
- streaming validation of a 2,236,028-byte `{events: [* event]}` union batch through `tokio::io::duplex` in 7-byte writes;
- synchronous `validate`;
- truncation, trailing bytes and injected I/O errors;
- short-reading `AsyncBlob`s;
- `tokio::spawn` of all three async drivers (Send check);
- timeout cancellation;
- async sequences over 3-byte writes;
- argument edge cases;
- an RSS measurement of N pending stream sessions.

Scratch code: `.cache/p910-review-rust/review/src/{main.rs,bin/mem.rs,bin/edge.rs}`.

## Findings

1. **Major — unsafe default / missing info: each live stream session holds about 0.93 × the compiled `input_bytes` resident, so the default session cap allows about 1.4 GiB for idle peers.**
   - Location: docs/rust.md:218-220, 456-459; host/rust/README.md:60; CHANGELOG.md:105-108.
   - What happened: I started `validate_reader_async` on N duplex streams. Each stream had received only `a1 66 "events" 9f` (9 bytes) and then stalled. Measured RSS per pending session:

     | `input_bytes` | RSS per pending session |
     | --- | --- |
     | 100,000 | 148 KiB |
     | 1,500,000 (default) | 1,426 KiB |
     | 4,000,000 | 3,575 KiB |
     | 8,000,000 | 7,088 KiB |

     With 1100 sessions at the defaults, 1024 went live and RSS grew by 1.24 GiB. The per-call `ValidationOptions { max_bytes: Some(4096) }` dropped this to about 26 KiB per session. That mitigation exists but is not presented as one. At 16 MB and above, RSS stayed at about 37 KiB per session, which suggests lazily touched pages. The docs only say "the key arena is sized for the input limit" and "holds what the session keeps plus one chunk", which reads as "bounded by what has arrived".
   - Expected: the memory cost of a live stream, quantified, next to `max_live`.
   - Suggested fix: document the per-session arena (bytes ≈ f(input_bytes)) and that `max_live × arena` is the worst case. Recommend lowering per-call `max_bytes` for network streams. Consider growing the arena with input read (as D337 does for recursive Programs), or lowering the default `max_live`.

2. **Major — errors / confusing API: every transport error becomes `Error::Source("read")`, with no `source()`, no `io::ErrorKind` and no way to recover the original error.**
   - Location: docs/rust.md:420-422, 478-480; rustdoc `Error::Source`, `AsyncSource`.
   - What happened: an `AsyncSource` returning `ConnectionReset`, `TimedOut`, `WouldBlock` or `UnexpectedEof` always yields `Err(Source("read"))`. Display is `snug: operation refused (read)` and `std::error::Error::source()` is `None`. A server cannot tell a client reset from a read timeout, and so cannot map them to different status codes or metrics. JS passes transport exceptions through unchanged (docs/api.md:647-648). `AsyncBlob::read` must return `snug::schema::SourceError`, whose variants (`ShortRead`, `Read`, `TooLarge`, `SessionLimit`) have no slot for a backend error either.
   - Expected: transport errors carried through (for example `Error::Io(io::Error)`, `Error::Source { code, source: Option<Box<dyn Error + Send + Sync>> }`, or a generic `E`), with the safe Display kept. The library already says sanitizing transport errors is the transport's job (rust.md:479).
   - Suggested fix: carry the source error behind `source()`. At least document that the original error is dropped and that callers should record it in their adapter before returning it.

3. **Major — confusing API / contradiction: the public API makes you name items from modules the README says are not for users.**
   - Location: host/rust/README.md:67-69 vs docs/rust.md:221-222, 233-243, 314; rustdoc `Error::Compile(SchemaError)`, `AsyncBlob::read`, `CompileOptions::{cuts, regexp}`.
   - What happened: the README says `compile`, `schema`, `sha256`, `unicode_tables` and the generated `snug` module are "public only for snug's own test hosts. Use the crate-root API instead". Yet these are not re-exported at the crate root:
     - `SchemaError` (the payload of `Error::Compile`) is `snug::compile::SchemaError`;
     - `SourceError` (required to implement `AsyncBlob`/`Blob`) is `snug::schema::SourceError`;
     - `Cuts` and `Regexp` (fields of the root `CompileOptions`) are in `snug::compile`;
     - `unicode_tables::tables()` is the documented way to pass Unicode tables (rust.md:36);
     - `Controls` is `snug::controls::Controls`.

     There are also two `CompileOptions` types (`snug::CompileOptions` and `snug::compile::CompileOptions`) and two `BytesBlob` types (`snug::BytesBlob`, which implements `Blob` and `AsyncBlob`, and `snug::schema::BytesBlob`, which implements `Blob` only).
   - Expected: everything reachable from a public signature is re-exported at the root, and the internal modules are hidden.
   - Suggested fix: re-export `SchemaError`, `SourceError`, `Cuts`, `Regexp`, `Controls` and `Warning` at the root. Make `compile`, `schema` and the generated `snug` module `#[doc(hidden)]` or `pub(crate)`, or soften the README sentence.

4. **Major — missing API / stale statement: the W8 tagged-union warning is unreachable from `Schema::compile`.**
   - Location: docs/guide.md:95-97 ("`Compiled::warnings` (Rust)"); README.md:125; CHANGELOG.md:29.
   - What happened: I compiled `event = { type: "click", x: int, y: int // type: "key", code: uint }` with `Schema::compile`. It compiles silently, and `{type:"key",code:3}` is refused with `value`. `Schema` has no `warnings()` accessor. W8 is only visible through the "test-host" `snug::compile::compile(text, profile: i32, limits: &[i32])`, which returned `[Warning { code: "W8", line: 2, column: 44, ... }]`. The type choice of maps (`{ type: "click", ... } / { type: "key", ... }`) and the `"type" =>` forms both accepted the key event, as the guide says.
   - Expected: a Rust user writing a discriminated union sees W8.
   - Suggested fix: add `Schema::warnings() -> &[Warning]`, or return the warnings from a `compile_with_warnings`. Fix guide.md:97 to name the real API. Add the tagged-union guidance to rust.md, which never mentions it.

5. **Major — contradiction / stale statement: the docs disagree on the default root for codec and views.**
   - Location: host/rust/README.md:53 ("The root must be a map by default"); docs/rust.md:48 ("codec/view default to map root") vs docs/rust.md:97-98 and rustdoc `DecodeOptions` ("any root").
   - What happened: `decode(&[0x82,1,2], &DecodeOptions::default())` returned `Ok(Array([1,2]))`, and `View::open(&[0x82,1,2], &DecodeOptions::default())` returned `Ok`. Debug output shows `DecodeOptions { top: Any, ... }`.
   - Expected: one statement, matching behaviour.
   - Suggested fix: change README:53 and rust.md:48 to "any root by default (`Top::Map` or `DecodeOptions::bindle()` to require a map)".

6. **Major — contradiction / stale statement: the Program format version differs across docs.**
   - Location: docs/rust.md:180-181 ("format major 1 and minor 0 (1 for a Program using extension controls)"); rustdoc `Program::serialize` ("Current format major/minor is 1.0") vs README.md:218, guide.md:917-927, CHANGELOG.md:56,83 and rustdoc `compile::Compiled` ("format 2.0").
   - What happened: `schema.program().serialize()` bytes 12..16 are `02 00 00 00`, which is format 2.0 per guide.md:922.
   - Expected: 2.0 everywhere, and a note on whether the controls minor still exists.
   - Suggested fix: update rust.md:180-183 and the `Program::serialize` doc comment.

7. **Minor — confusing API: verdicts and API errors are not separated the way the docs say.**
   - Location: docs/rust.md:52-56, 192-194, 414-415.
   - What happened: an unknown rule is handled four different ways:

     | Call | Result for unknown rule `"nope"` |
     | --- | --- |
     | `validate` | inner `Err(Failure{code:-1, reason:"unknown_rule"})` |
     | `validate_blob` / `validate_reader` | outer `Err(Error::Validation(Failure{unknown_rule}))` |
     | `decode` / `view` | `Err(Error::Validation(..))` |
     | `sequence` / `read_sequence` | `Err(Error::Usage("unknown_rule"))` |

     The blob and reader forms put a validation-typed error in the "source and API errors outside" slot. `Error::code()` then reports it as `schema/unknown_rule`. A rule-name typo is easy to miscount as "client sent invalid data" in `validate`.
   - Expected: one convention. The docs promise "source/API errors outside, verdicts inside".
   - Suggested fix: return `Error::Usage("unknown_rule")` everywhere `Error` is available. Consider a `Schema::rule(&str) -> Result<RuleId, Error>` handle so the rule is resolved once at startup.

8. **Minor — confusing API: there are two code vocabularies for the same failure.**
   - Location: docs/rust.md:213, 473-476; rustdoc `Error::Validation`.
   - What happened: for `[0x83,1,2]` against `r = [* uint]`, `Failure.reason` is `cbor/truncated` but `Error::from(failure).code()` is `truncated`. For a schema miss, `reason` is `type` but `code()` is `schema/type`. The prefix moves from the CBOR side to the schema side depending on which type you hold. `Failure.code` (the i32: 1, 20, 32, -1) is undocumented, and `Failure` has no field docs at all.
   - Expected: either one vocabulary, or a documented mapping table.
   - Suggested fix: document `Failure`'s fields, including the meaning and stability of `code`. Add a table "Failure.reason ↔ Error::code()" to rust.md "Handle errors safely".

9. **Minor — confusing API: positional parameters with mismatched arity across the sync and async forms.**
   - Location: docs/rust.md:409-411; rustdoc `Schema::validate_reader{,_async}`.
   - What happened: `validate_reader(r, rule, opts, chunk: usize, fail_fast: bool)` and `validate_reader_async(src, rule, opts, chunk: usize, quantum: u32, fail_fast: bool)` take bare positional integers and a bool, in a different order and count. `SequenceOptions` already carries `chunk` and `fail_fast` as fields. `quantum` is `u32` on `Schema` but `i32` on `async_source::validate_*`, and values above 2^31−1 are rejected anyway.
   - Expected: one options struct, for example `StreamOptions { chunk, quantum, fail_fast }`, or extra fields on `ValidationOptions`.
   - Suggested fix: move `chunk`, `quantum` and `fail_fast` into an options struct, as `SequenceOptions` does.

10. **Minor — errors: a huge `chunk` panics or reserves memory instead of returning `Error::Usage`.**
    - Location: docs/rust.md:194, 416-417.
    - What happened: `validate_reader(.., usize::MAX, ..)`, `validate_reader_async(.., usize::MAX, ..)` and `read_sequence(.., SequenceOptions{chunk: usize::MAX, ..})` all panic with `capacity overflow`. `chunk = 1<<33` is accepted, which suggests an 8 GiB buffer. `chunk = 0` correctly returns `Usage("options")`. `validate_blob(.., usize::MAX, ..)` is fine.
    - Expected: an upper bound check, the same as for `quantum`, or at least clamping to the input limit.
    - Suggested fix: reject `chunk > i32::MAX`, or clamp it to `max_bytes`, and document the bound.

11. **Minor — missing info: drain mode is the default and keeps reading after a certain refusal.**
    - Location: docs/rust.md:202-220; rustdoc `validate_reader_async`.
    - What happened: on a stream whose first 44 bytes are a complete invalid message followed by 3 MB of zeros:
      - `fail_fast=false` read 1,503,232 bytes before answering `cbor/too_large`;
      - `fail_fast=true` read 4,096 bytes and answered `cbor/trailing`.

      On the default-limit 2.2 MB batch, drain mode read 1,500,032 bytes (`cbor/too_large`), and fail-fast read 768,640 bytes (`cbor/too_many_items`). This matches the docs, but the docs never say which mode to pick for untrusted network peers. `SequenceOptions` also defaults `fail_fast: false`.
    - Expected: guidance that drain mode reads up to `max_bytes` from a hostile peer, and that fail-fast suits network input.
    - Suggested fix: add a sentence to "Async sources" → "Scheduling and backpressure".

12. **Minor — missing info: no Rust recipe for push-style HTTP bodies.**
    - Location: docs/rust.md:366-470.
    - What happened: hyper and axum bodies are `Stream<Item = Bytes>` or `Body::frame()`, not `AsyncRead`. For a single message, the only push-style API is the low-level `schema::Session` (rust.md:221-222), which lives in the "test-host" module. `Sequence::feed` exists only for sequences.
    - Expected: either a high-level push validator for one unknown-length message (JS has `pushScanner` and push sources), or a documented adapter (for example `tokio_util::io::StreamReader`) with an example.
    - Suggested fix: add an `UnknownLengthValidator { feed(&[u8]), end() }` facade, or document the adapter route.

13. **Minor — examples that don't compile as written / not checked: the runtime adapters in rust.md are `ignore` and incomplete.**
    - Location: docs/rust.md:429-449.
    - What happened: the block omits `use std::{io, pin::Pin, task::{Context, Poll}};`. Once I added those, both adapters compiled and worked against tokio 1.54 and futures 0.3. Because the block is `ignore`, nothing will catch drift. The docs/api.md:476-480 `rust` fragment is also not compiled anywhere.
    - Expected: copy-pasteable adapters, and checked snippets.
    - Suggested fix: add the imports. Check the adapters in a dev-only example crate, or ship optional `tokio` / `futures-io` features. Mark the api.md fragment `rust,ignore` or move it to rust.md.

14. **Minor — stale statement: the top-level README undersells Rust and never links the Rust guide.**
    - Location: README.md:215, 217, 219, 225, 264-267.
    - What happened:
      - the codec and Writer rows say "Implemented in JS";
      - streams say "JS, minimal Rust";
      - "Rust and wasm: … public host APIs are less complete than JS" — yet Rust has encode, decode, Writer, views, and sync plus async blob, stream and sequence drivers;
      - the reading list links guide, api, cddl-support, profiles, SPEC, architecture and program, but neither docs/rust.md nor host/rust/README.md.

      A Rust user landing on the repo finds the Rust guide only through a sequences cross-link in guide.md:783.
    - Expected: Rust status as in the CHANGELOG, plus a link to docs/rust.md.
    - Suggested fix: update the four rows and add docs/rust.md to the reading list and Quick start.

15. **Minor — missing info: the wasm SDK has no user documentation.**
    - Location: host/wasm-sdk (no README); README.md:220, 224; docs/api.md:515-517, 650-655; docs/release-policy.md:28, 243.
    - What happened: the user docs never explain how to obtain the `.wasm` file or how to instantiate or load the SDK in a browser. The release policy says the SDK "ships prebuilt `.wasm`", but none exists in the checkout. The manifest has "no build or staging script". The only build route (`kin/scripts/wasm-build sdk`, nightly-2026-09-16) is mentioned in release-policy.md, where neither the output location nor the browser loading is stated, so I did not try it. Separately, conformance.md:223 says the wasm SDK sequence API is "deferred; no claimed implementation", while README.md:220 and api.md:650 say `snug-wasm-sdk/sequence` exists. The audit is dated, but it is not marked as superseded on that row.
    - Expected: a README in host/wasm-sdk covering the build command, its output, the browser import and init, CSP (`wasm-unsafe-eval`) and its differences from native JS.
    - Suggested fix: add that README, and annotate the conformance row as superseded.

16. **Minor — stale statement: guide.md describes the Rust push sequence reader as returning `Cow::Borrowed`.**
    - Location: docs/guide.md:782.
    - What happened: `Sequence::feed` returns `Vec<Result<Message<'c>, Error>>`. `Message` is a struct with `is_borrowed()` and `into_owned()`, not a `Cow`.
    - Suggested fix: say "messages borrowing the chunk (`Message::is_borrowed`)".

17. **Minor — missing info: rust.md has no build-time Program caching recipe and no compile-error display guidance.**
    - Location: docs/rust.md:169-189.
    - What happened: the JS guide has a "compile at build time, load at startup" recipe. Rust users must infer `include_bytes!` plus `Schema::from_serialized`. That route works and is fast: 2.3 KB Program, compile 108 µs, load 20 µs in release. Also, `Error::Compile` Display is `snug: operation refused (syntax)`, with line and column only in Debug or by matching `SchemaError`. For trusted schemas compiled at startup this makes panics and logs uninformative.
    - Suggested fix: add a short recipe, including that there is no compile-time (macro or `const`) compilation. Show how to print `SchemaError { line, column, rule }`.

18. **Nit — confusing naming: the valid preset reports `floats: Floats::Deterministic`.**
    - Location: docs/profiles.md:124; Debug of `Profile::VALID`.
    - What happened: `Profile { keys: Any, tags: Any, floats: Deterministic, ..., valid: true }`, yet the valid preset accepts non-shortest floats (README.md:45, 52). The `valid` flag evidently overrides `floats`, but nothing says so.
    - Suggested fix: document the interaction in profiles.md "Options", or rename the variant.

19. **Nit — stale statement / jargon: decision and plan IDs, and links to unshipped docs, throughout rust.md and rustdoc.**
    - Location: docs/rust.md:30, 39, 238-240 ("noted for P9.11's version policy"), 324, 368; rustdoc crate root ("D003"), `async_source` ("P9.6, D027 … NEED / YIELD, D030"), `Scratch` ("program.md §13.1"), `Blob` ("architecture §17.3, W12").
    - What happened: per CHANGELOG.md:9-11 and Cargo.toml `include`, the crate ships without DEVLOG, architecture.md or program.md, so these references cannot be resolved by a crate user. The crate-root rustdoc ("the generated modules … and nothing that decides accept or refuse (D003)") says nothing about how to use the crate.
    - Suggested fix: give the crate root a usage overview (it could reuse the host/rust README via `#![doc = include_str!]`), and strip or explain the IDs.

20. **Nit — rustdoc hygiene: doc build noise and undocumented items.**
    - Location: rustdoc / assembled crate.
    - What happened:
      - `cargo doc` without `--lib` also documents the test-host binaries (`abnf`, `check`, `compile_test`, `scan`, `vm`, …), and `abnf` alone produces 14 warnings;
      - the lib has 2 broken intra-doc links (`src/snug/cbor/vcopy.rs:1116-1117`);
      - `snug::validate_blob` (a root re-export) has no doc and duplicates `Schema::validate_blob`;
      - the `impl` block holding `Schema::validate_reader` is documented as "Validate a known-length snapshot", which is wrong for an unknown-length reader;
      - `Schema` and `Sequence` are `!UnwindSafe`, which is unexplained;
      - offsets are `i32` in `Failure`, `Option<usize>` in `Error::Cbor` and `u64` in `Message` and `MessageFailure`.
    - Suggested fix: add `[[bin]] doc = false` or `autobins = false` for the test hosts, escape the brackets, document or hide `validate_blob`, fix the impl-block doc, and pick one offset type.

21. **Nit — missing info: consuming the crate needs an extra assembly step that is easy to miss.**
    - Location: host/rust/Cargo.toml; host/rust/README.md:87-128.
    - What happened: `snug = { path = ".../host/rust" }` fails with 14 `could not find vm in snug` errors (E0433/E0583) and no hint. The README explains assembly, and the Cargo.toml comment does too, but rust.md:3 is the only place a Rust user would see it. There is also no `rust-version`, and Cargo 1.92 is the only toolchain tested (README:90), while release-policy.md gives an MSRV floor of 1.87.
    - Suggested fix: add a `compile_error!` in host/rust/src/lib.rs when the generated tree is missing, pointing at `kin/scripts/rust-crate`. State the MSRV.

## Verified as documented (no finding)

- All 12 runnable `rust` blocks in docs/rust.md and host/rust/README.md compile and pass.
- Async verdicts equal sync verdicts:
  - the 2.2 MB batch over 7-byte writes gave `Ok`, with `poll_read` never asked for more than `chunk` (256) bytes;
  - the half-truncated message gave `cbor/truncated` at offset 1,117,985 in both forms;
  - an empty stream gave `cbor/truncated` at 0;
  - a trailing byte gave `cbor/trailing` in both forms.
- A short-reading `AsyncBlob` returns `Source("short_read")`.
- `chunk` 0 and `quantum` `u32::MAX` both return `Usage("options")`.
- `tokio::spawn` (multi-thread) accepts all three async drivers when the Schema is shared through an `Arc`, with a `Send` source and blob. Dropping a pending validation via `timeout` left `sessions::counts().live == 0`. At 1024 live sessions, further sessions fail, as the docs say.
- Async sequence over 3-byte writes with `chunk: 16`: 2000 messages, maximum `bytes_held` 15. A truncated tail is reported as `Sequence(MessageFailure{index:1999, reason:"cbor/truncated"})`.
- The defaults match the docs:
  - `EncodeOptions` and `DecodeOptions` limits 1,500,000 / 32 / 65,536 / 131,072;
  - `SequenceOptions::chunk` 65,536;
  - `sessions::limits()` 1024 / 2 MiB;
  - the default schema refuses inputs over 1.5 MB with `cbor/too_large` at offset 0.
