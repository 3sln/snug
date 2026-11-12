# Changelog

All notable changes to snug are recorded here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), with a
**Breaking** group listed first and a **Budget and limits** group. Versions
follow [docs/release-policy.md](docs/release-policy.md) (semantic versioning;
one version for every artefact). Lines name an artefact — `[js]`, `[rust]`,
`[wasm-sdk]` — when they do not apply to all; `(D###)` cites the decision in
[DEVLOG](DEVLOG.md).

Nothing has been released. Every manifest is `private` at `0.0.0`.

## [Unreleased]

What a first release would contain, summarised from DEVLOG Phases 7–9.

### Added

- CDDL (RFC 8610, with RFC 9165 controls and RFC 9682 grammar) compiled to
  a verified Program; `compile(text, options)` with compiler profiles
  `full`, `bindle` and `bus`, compile-time resource limits and warnings.
- Validation directly over CBOR bytes in one pass, with no decoded value
  tree; `schema.validate`, `schema.decode`, `validateAt`. Refusals carry a
  code, an offset and a schema-named path, never payload values (SPEC §4).
- PEG semantics for groups in arrays and maps (D270), with the RFC's
  literal cut as the default and `cuts: 'branch'` as an option (D301);
  warning W8 flags discriminated unions that the RFC cut makes fail.
- CBOR codec `encode` / `decode` with exact integers, bignums, decimal
  fractions, typed arrays and ndarrays; encoders always write RFC 8949
  §4.2.1 deterministic bytes.
- Wire presets: `valid` (the default: any valid CBOR, duplicate keys
  refused by value; D260), `deterministic` (RFC 8949 §4.2.1 checked on
  read) and the optional `bindle` preset (D080), with per-option overrides.
- Checked views and a cursor (`snug/view`) and a typed `Writer`
  (`snug/writer`).
- Sources (`snug/sources`): handles, push sources and unknown-length
  streams validated by the resumable session VM, with verdicts identical
  to the buffer's (drain mode by default, opt-in fail-fast; D085).
- CBOR sequences (RFC 8742) in `snug/sequence` and Rust `read_sequence` /
  `Sequence` (D210–D219).
- Extension controls: registered `.name` controls decided by host
  predicates, with generic `.chars`, `.unique` and `.samelen` in
  `snug/controls` (D082, D140–D143).
- `.regexp` in the XSD dialect by default, RFC 9485 I-Regexp as an option
  (D242); Unicode categories through the optional `snug/unicode` tables
  (Unicode 16.0; D083).
- RFC 9682 head numbers `#7.<T>` (D336).
- Serialised Programs, format 2.0: `program.serialize()`,
  `fromSerialized` (verified, no compiler needed), `sourceKey` for caches
  (D084, D318).
- Session pooling and a bound on live sessions: `sessionLimits({ maxLive,
  maxPooledBytes })`, `releasePool()`, `close()` / `[Symbol.dispose]` on
  sessions, and the `sessions/limit` error; Rust
  `snug::sessions::{limits, set_limits, counts, release_pool}` (D327, P9.7).
- `[rust]` The crate: compile, validate, decode, Writer, views, blob and
  reader sources, sequences, and async source drivers with no runtime
  dependency (`validate_blob_async`, `validate_reader_async`,
  `read_sequence_async`; D331).
- `[wasm-sdk]` Experimental: the same JS API over the Rust build as
  WebAssembly, opt-in (D130).

### Breaking

These matter only to users of pre-release builds from this repository.

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

### Changed

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

- A recursive Program's session arena grows with the input read instead of
  reserving the whole message's bound up front (D337).
- `[rust]` The unknown-length reader no longer panics when a positive
  quantum yields after the end (D331).
