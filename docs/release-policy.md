# Release and version policy

Status: **proposed, 2026-11-12 (P9.11, D338).** Nothing has been released.
Writing this policy publishes nothing. No package is published, no tag is
pushed and no registry is touched until the owner gives an explicit go for
a named commit (§4). Every manifest is still `private: true` /
`publish = false`, and every version site holds the placeholder
`0.0.0-unreleased` (§1.1).

Each item below is one of three kinds:

- **Stated**: true of the repository today. It was checked against the
  manifests, `bb.edn`, the gate scripts or the code.
- **Proposed**: the policy this document recommends. It applies once the
  owner signs off D338.
- **Owner decision**: the owner chooses. Options and a recommendation are
  given, and a sign-off box is left unticked (§7).

## 1. Versioning

### 1.1 Artefacts and one shared version number

These artefacts could be published:

| Artefact | Source | Manifest today (stated) |
| --- | --- | --- |
| npm package (native JS, the default per D130) | `host/js`, staged by `npm run build` | `host/js/package.json`: `"name": "@3sln/snug"`, `"version": "0.0.0-unreleased"`, `"private": true`, `"engines": { "node": ">=20" }` (§2) |
| Rust crate | `host/rust` + `gen/rust`, assembled by `kin/scripts/rust-crate` into `.cache/snug-rs/` | `host/rust/Cargo.toml`: `name = "snug-cbor"` (library `snug`), `version = "0.0.0-unreleased"`, `publish = false`, edition 2021, `rust-version = "1.87"` (§2), no dependencies |
| wasm SDK (opt-in per D130; experimental) | `host/wasm-sdk` over the modules built by `kin/scripts/wasm-build sdk` / `cc` and staged by `bb wasm-release`; packaged by `host/wasm-sdk/package-build.mjs` (P9.17) | `host/wasm-sdk/package.json`: `"name": "@3sln/snug-wasm"`, `"version": "0.0.0-unreleased"`, `"private": true` |

Names (O4, owner 2026-11-12; D343): crates.io's `snug` belongs to an
unrelated project, so the crate is `snug-cbor`; `[lib] name = "snug"` keeps
`use snug::…`. Every
manifest's repository is `https://github.com/3sln/snug`.

**Proposed: one version number for all artefacts, released in lockstep.**
The artefacts share one core: the same kin sources generate the compiler,
verifier and VM, cross-host identity is a gate (SPEC §7), and they share
the Program format. The snug version string is also inside every compiled
Program. It is part of the SOURCE_KEY preimage (`kin/compile/main.kin`,
`build-key-preimage`) and is written to the container's producer field.
A single number lets "snug x.y.z" name one semantics. A release in which
one artefact has no changes still bumps it, and its changelog entry says
"no changes in this artefact".

**Stated (D343, O2): `version.edn` at the repository root is the single
source.** It holds two semver strings:

- `:version`, the version a release build stamps (0.1.0, O1);
- `:placeholder`, `0.0.0-unreleased`, which every version site holds in
  the tracked tree.

The version sites are both `package.json` files, both `Cargo.toml` files
(`host/rust`, `host/wasm`), `host/js/src/version.mjs`, and the literal
`snug-version` returns in `kin/compile/main.kin`, plus the two modules
`bb emit` generates from it. `kin/scripts/version-sites.mjs` lists them.

**Stamped versions are never checked in** (owner, 2026-11-12: "Stamped
versions in the project files are never checked in."):

- main and every working branch hold the placeholder at every site.
  `bb versions` fails otherwise; it is the first gate of the `land` and
  `release` sets. `kin/scripts/pre-commit` is the same check on the index,
  as an optional git hook (not installed by anything).
- `bb stamp [version]` writes `:version` (or the given version) onto every
  site and re-emits `gen/`. It refuses a checkout with a branch checked
  out, so it runs only in a detached release worktree or an exported copy.
  It rewrites only the version text, so it is deterministic and
  idempotent.
- The only stamped trees are build output: the release artefacts, the npm
  and crate tarballs, and the generated commits of the `dist` branch
  (P9.19).

Because the source key reads its length and bytes from the literal, any
semver string works, up to 32 bytes: the Program container's producer field
holds 32 printable ASCII bytes, and `bb stamp` refuses a longer version.
`bb stamp-test` stamps two scratch copies and checks that every site
agrees, that the stamped tree passes the version, serialised-Program and
package tests, that a second stamp changes nothing, and that the two
copies give byte-identical trees, npm tarballs and `.crate` files.

### 1.2 Semantic versioning, and what 0.x means

**Proposed:** every artefact follows [Semantic Versioning 2.0.0](https://semver.org/).

**While the major version is 0**, the project uses the convention that
both Cargo and npm's caret ranges already apply (`^0.y.z` means
`>=0.y.z <0.(y+1).0`):

- A change to **`0.y`** (minor) may be breaking. Every breaking change
  goes here, and only here.
- A change to **`0.y.z`** (patch) is compatible. Fixes, additions and
  notices go here.

So a 0.x patch release never contains anything that §1.3 classes as
breaking, except a security fix that §5.2 allows. "0.x" also tells users
that the surfaces in §1.3 can still change at any `0.y` bump without a
deprecation period, though each one still gets a changelog entry.

**From 1.0.0 on**, the usual semver rules apply:

- a breaking change needs a major release;
- an addition needs a minor release;
- a fix is a patch release.

Whether the first release is 0.1.0 or 1.0.0 is an owner decision (§7, O1).

### 1.3 What counts as breaking

A change is **breaking** if code, a stored Program or a deployed
configuration that worked with the previous release can, without
modification, either stop compiling or loading, or get a different verdict
under the same options. The snug-specific surfaces are listed below.

**Public APIs.**
- JS: the entry points in `host/js/package.json` `exports`, with their
  exported names, signatures, option keys and value types, and the
  hand-written declarations in `host/js/types/`.
- Rust: every `pub` item reachable from the crate root, judged by the
  [Cargo SemVer reference](https://doc.rust-lang.org/cargo/reference/semver.html).
  For example, adding a variant to an enum without `#[non_exhaustive]` is
  breaking, and so is changing a return type to `Result`.
- wasm SDK: its `exports` and the functions behind them.

Removing or renaming any of these is breaking, and so is narrowing an
accepted type. Adding a new optional option, a new export or a new entry
point is a minor change. Options bags reject unknown keys with TypeError
(api.md "Option admission"), so code that passes a key a newer release
introduced will fail on an older release. That is expected forward
incompatibility, not a break.

**Error and refusal codes.**
- **Stable**: the code strings of `SnugFault.code`, validation `reason`
  (including the `cbor/` and `schema/` prefixes), `subcode`,
  `SchemaError.code`, `ProgramError.code`, `SourceError.code` and the
  session-limit error `sessions/limit` (P9.7, D327). Also stable: the
  numeric codes the Rust `Failure` exposes, and the Rust `Error` /
  `SourceError` variants.
  - Removing a code, renaming it, or reusing it for a different meaning is
    breaking.
  - **Adding a new code is a minor change.** Consumers must treat an
    unknown code as a refusal (it is never a success). The TypeScript
    unions and the Rust enums are widened in the same release.
- **Witness: which code, offset and path a refused input gets.** This is
  deterministic for a given version and identical across hosts (SPEC §7,
  gated). Between releases it may change only as a documented fix:
  - a patch release may change it to correct a documented-rule violation
    (e.g. precedence, scanner.md "Precedence across classes"), with the
    corpus cases listed in the changelog;
  - any other change to the witness rule (architecture §6,
    program-2 §8) is breaking.
  The safety property never changes: no payload values, input bytes or
  unnamed keys appear in errors (SPEC §4). A change that weakens it is a
  security bug (§5.2), not a version question.
- **Not API**: error message text (api.md: "Messages are explanatory text
  … not a recovery API"), compiler warning wording, and anything the docs
  call informational.

**The Program binary format.** A serialised Program
(`program.serialize()` / `fromSerialized`, `program.P` / `program.B` /
`fromProgram`) is a public interchange format.
- Stated:
  - The current format is **2.0**, and the format word is `2`: major in
    the low 16 bits, minor in the high 16 (D100, D318).
  - Container version is 1.
  - A loader accepts a Program if its major equals the loader's major and
    its minor is no greater than the loader's minor (D084).
  - Every load runs the structural verifier.
  - A 2.x loader refuses every 1.x Program (program-2 §1).
- Proposed:
  - A **format major bump is a breaking release**, because stored Programs
    stop loading with `ProgramError` `format_version`.
  - A **format minor bump** (an additive leaf kind or optional section,
    D084) is a minor release. Older loaders refuse the newer minor.
  - **Within one release line** (one `0.y` before 1.0; one major after),
    every release must load every Program that earlier releases of the
    line produced, and must give it the same verdicts, apart from the
    changes the changelog lists under §1.3's semantics and budget rules. A
    gate should prove it: stored Programs from the line's first release,
    loaded by the new build (§8).
  - **Verifier**: a newer verifier refuses a Program an older one accepted
    only when accepting it was a bug. That is a security or soundness fix
    (§5.2), and the changelog says so.
  - Compiling the same text with a newer release may give different
    Program bytes. Program bytes are not stable across releases.
    SOURCE_KEY contains the snug version, so caches keyed by `sourceKey`
    miss after an upgrade and recompile. That is intended.

**Budget unit prices and the default budget.**
- Stated:
  - The charging schedule (program.md §14, program-2 §10) is part of the
    VM code, not of the Program.
  - The default budget, 2,250,000 units (D241), and the other default
    limits are compiled into each Program's limits. Per-call limits can
    only lower them.
  - Prices are calibrated to roughly equal CPU per unit (D241, D253, D316;
    bench/VM.md).
  - Units used are visible in the Rust `Failure` and are compared across
    hosts by the gates.
- Proposed:
  - **Raising any price, or lowering a default budget or default limit, is
    breaking.** It can turn an accepted message into a `budget` (or limit)
    refusal with the same schema, input and default options. That is a
    verdict change on unchanged code. A stored Program also keeps its old
    compiled budget while the new prices apply to it.
  - **Lowering prices, or raising a default budget or limit, is a minor
    change with notice.** It cannot reject anything that was accepted, but
    it loosens a resource bound that operators may have sized
    deployments against (DoS headroom). It can also turn a `budget`
    refusal into an accept or into a different refusal.
  - A re-pricing that lowers some rows and raises others counts as a raise.
  - Every price or default change appears in the changelog's **Budget and
    limits** section, with the D-entry and the calibration evidence.
  - Exact unit counts are **not** stable between releases, only within a
    release across hosts. Callers should leave headroom rather than set
    budgets to observed usage.
  - Exception: if a price is raised to fix an under-charged path that
    allowed unbounded or disproportionate work, it is a security fix
    (§5.2) and may ship in a patch, flagged as such.

**Defaults.** Changing any of these is breaking:
- the default wire preset, `valid` (D260);
- the default cut mode, `cuts: 'rfc'` (D301);
- the default `.regexp` dialect, `xsd` (D242);
- the default tag policy, root policy, compiler profile and limits.

Adding a new preset or option value is a minor change. The **Bindle
preset** is an optional profile (D080), and its definition is the
pre-P7.1 behaviour bit for bit (profiles.md). Any change to what
`wire: 'bindle'` accepts is breaking.

**CDDL semantics.** These are breaking:
- any change that flips a verdict for some schema and input under the
  default options, for example a conformance-corpus expectation flip;
- any change that newly refuses a schema that used to compile;
- any change that refuses a stored Program.

Pre-1.0, they go in a `0.y` bump. Every corpus expectation the release
changes is listed, with its D-entry. D328 (float widths by value) is the
model: it changed what a documented prelude type means, so it is a
breaking, highlighted change. A change that makes a previously refused
construct compile, without changing any existing verdict, is a minor
change; P9.14's `.abnf` is an example. From 1.0, a verdict flip that
corrects a deviation from snug's own published semantics (cddl-support.md,
SPEC §2) may ship in a minor release with a prominent notice. A flip that
changes the published semantics needs a major release.

**Supported runtimes.** Dropping a runtime line that is still supported
upstream is breaking. Dropping one that has reached end of life upstream,
or raising the Rust MSRV, is a minor change with notice (common Rust
practice). See §2.

**Not part of the API:**
- bundle and binary size: the caps of D200 and D303 are an internal
  regression gate, and growth is not breaking;
- performance;
- generated modules under `gen/`, which `exports` blocks;
- internal Program word layouts beyond the container contract and the
  format version;
- D-entry numbers;
- DEVLOG and bench records;
- test-only hooks.

## 2. Supported runtimes and toolchains

**Declared (O7, P9.18, D344):** `"engines": { "node": ">=20" }` in
`host/js/package.json` and `rust-version = "1.87"` in `host/rust/Cargo.toml`.
These are the oldest versions that pass the gates today (2026-11-12). The
release set holds a gate on exactly each: `node-oldest` runs `npm test` on
the newest installed Node 20.x (nvm), and `msrv` builds and tests the
assembled crate, doctests included, on Rust 1.87 (rustup). Both read the
floor from the manifest. Without the toolchain they answer SKIP, which
fails the release set. There is still no hosted CI. Gates are the `bb`
tasks in `bb.edn`, run by engineers on one macOS machine.

**Node 20 has been past upstream end of life since 2026-04-30.** It is the
floor because the library works on it today, which is the owner's rule.
The floor may rise in a minor release, with notice in the changelog.

What was tried (P9.18, macOS arm64, 2026-11-12):

| Toolchain | Result |
| --- | --- |
| Node 18.20.8 | fails: `TypeError: s.isWellFormed is not a function` (`host/js/src/writer.mjs`, ES2024, unguarded); the suite aborts |
| Node 20.20.2 | `npm test` passes (1491 tests) under `SNUG_NODE_OLDEST=1`, which leaves out one test-only oracle Node 20 lacks: `node:module` `stripTypeScriptTypes` (Node 22.13+), used to parse the `.d.ts` files. `bb abnf-test` also passes on it. |
| Node 22.23.5, 24.6.0 | `npm test` passes with no oracle left out |
| Rust 1.75, 1.82, 1.86 | `cargo build` fails: 1.86 and 1.82 with 516 × `E0658 use of unstable library feature integer_sign_cast` (`cast_signed` / `cast_unsigned` in generated code); 1.75 also lacks `Option::is_none_or` |
| Rust 1.87.0 | `cargo build`, `cargo test` and both doctest files pass. Clippy stays on the current toolchain (`rust-api-test`), because its lints change between releases. |
| Rust 1.92.0 | every Rust gate (unchanged) |

The Unicode category tests no longer depend on the running Node's ICU.
They compare the VM with Node's `\p{gc=…}` only when Node's Unicode
version equals the tables' pinned one (16.0). Otherwise they compare it
with the committed tables, with a logged note. Node 20.20.2 and 22.23.5
ship Unicode 17.0. Regenerating the tables (`tools/unicode/gen-tables.mjs`,
`bb unicode-test`'s `--check`) still needs the pinned Node v24.6.0.

The table below is the P9.11 record, derived from the code before the
floors were tested; the Node and Rust rows are superseded by the above.

| Runtime | Floor derived from the code (stated) | Actually tested (stated) | Proposed support statement |
| --- | --- | --- | --- |
| Node.js | ≥ 20. `String.prototype.isWellFormed` is used without a guard (`host/js/src/writer.mjs`). Other modern features are guarded: `Float16Array` and `scheduler.yield`, with a fallback to `setImmediate` and then `MessageChannel`. | Node v24.6.0 only: `npm test`, every gate, the P7.7 consumer run | **Proposed, needs owner/coordinator confirmation:** support the Node lines that are in active or maintenance LTS at release time. Declare `"engines": { "node": ">=22" }` only if a `npm test` run on Node 22 is added to the release gates; otherwise declare `>=24`. Node 20 meets the floor but is past upstream end of life. |
| Browsers | ES2022, which the guide's esbuild recipe targets (`--target=es2022`), plus `String.prototype.isWellFormed` (ES2024): Chrome/Edge 111+, Firefox 119+, Safari 16.4+ | Chrome 156 headless under a strict CSP, at revision `f275938` (2026-11-03) only (guide "Browser and Worker recipes") | **Proposed:** state the feature floor as "expected to work". Claim only evergreen Chrome as tested, and only after `tools/runtime/run.mjs` passes on the release commit (§4). Firefox and Safari are untested, and the release notes say so. |
| Workers | Same as browsers. The native package needs no wasm and no `eval`. | workerd 1.20261102.1, compatibility date 2025-12-01, no `nodejs_compat`, at `f275938` only | **Proposed:** as for browsers, re-run on the release commit. |
| Rust | MSRV ≥ **1.87**: generated code uses `cast_signed` / `cast_unsigned` (1.87). Also `Option::is_none_or` (1.82) and return-position `impl Trait` in traits (1.75, D331). Edition 2021. | rustc 1.92.0 (Homebrew stable) only: `rust-api-test`, `check` and every Rust gate | **Proposed, needs confirmation:** `rust-version = "1.87"`, but only after a `cargo +1.87 test` run on the assembled crate becomes a release gate. Until then declare `rust-version = "1.92"`, the only tested toolchain. MSRV policy: raised only in a minor release, with notice. |
| wasm SDK (build) | `wasm32-unknown-unknown`, nightly-only flags (`-Zbuild-std`, `panic=immediate-abort`), toolchain pinned to `nightly-2026-09-16` (`kin/scripts/wasm-build`, override `SNUG_WASM_TOOLCHAIN`) | `bb wasm-sdk-test` under Node 24.6.0; the D005 / D130 benches in Node, Chrome and workerd at `93f8718` | **Proposed:** consumers never need Rust, because the SDK ships prebuilt `.wasm`. The pinned nightly is a build requirement only, and the release records it with the module's SHA-256. Runtime: any engine with WebAssembly 1.0 plus the features rustc enables by default for that target at the pinned toolchain. The release lists them: `bb wasm-release` checks each module with `wasm-opt` and records the features it needs in `MANIFEST.json` (bulk-memory and sign-ext, 2026-11-12, P9.17). Hosts need `'wasm-unsafe-eval'` under a CSP, and workerd needs a `.wasm` module binding (D130). |
| TypeScript | The declarations are hand-written. The guide's tsconfig uses ES2022 with NodeNext. | TypeScript 5.8.3, consumer check on 2026-11-03 | **Proposed:** "tested with 5.8". Declarations change with the API rules of §1.3. |

**How support is tested (proposed):** a runtime or toolchain counts as
supported only if a gate ran on it for the release commit and the result
is recorded in the release's DEVLOG entry. A gate that answers SKIP does
not count. For example, `wasm-sdk-test` exits 0 with "SKIP" when the
nightly is missing, and `valid-test` skips its cbor2 arm without
`bench/compare/node_modules`. A SKIP is recorded as not run.

## 3. Changelog

**Proposed:**

- **Where:** `CHANGELOG.md` at the repository root. It is copied into each
  artefact: the npm staging in `host/js/src/package-build.mjs` copies
  `LICENSE`, `THIRD_PARTY_NOTICES.md`, `README.md`, `SPEC.md` and
  `DEVLOG.md` today, and `CHANGELOG.md` should be added to that list (§8).
  The crate gets it through its `include` list.
- **Format:** [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
  There is one `## [Unreleased]` section, and one `## [x.y.z] — YYYY-MM-DD`
  section per release. Within a section, the groups come in this order:
  - **Breaking**, first and always explicit (Keep a Changelog has no such
    group; it is added because §1.3 makes breaking a distinct class);
  - Added;
  - Changed;
  - **Budget and limits**;
  - Deprecated;
  - Removed;
  - Fixed;
  - Security.

  Each line names the artefact(s) when not all of them: `[js]`, `[rust]`,
  `[wasm-sdk]`.
- **From D-entries:** DEVLOG and its D-entries stay the engineering
  record. The changelog is for users.
  - A D-entry gets a changelog line only if a user can observe it: an API,
    a verdict, a code, a default, a price, the format or a runtime.
  - The line says what changed and what to do, then cites the D-entry in
    parentheses, e.g. "(D328)".
  - Gate, harness, size-cap and process entries (D326, D303, D333, …) do
    not appear.
  - An engineer who lands a user-visible change adds its Unreleased line
    in the same commit. The release checklist (§4) checks that every
    D-entry since the last release is either cited or deliberately left
    out.

## 4. How a release is cut

**Who decides.** The release is the **owner's call**. The manager declares
the release candidate (RC). The owner decides whether, when and what to
publish. **Nothing is published, pushed to a registry, or tagged for one
without the owner's explicit go for a named commit and version.** The
go is recorded in DEVLOG. A coordinator or manager instruction is not a
go. Delegations such as D303 cover size caps only, not releases.

**Steps (proposed):**

1. **RC.** Every Phase 9 item in DEVLOG is ticked, including "RC declared".
   That covers:
   - P9.8, the crate-diff re-run;
   - P9.9, the full-length proptest, vmsession-test and `rust-api-test`
     `full` runs, chunked under the P9.1 watchdog caps with their seeds
     recorded;
   - P9.12, the binary-size audit;
   - P9.13, the final review with its blocking findings fixed.
2. **Owner decisions.** Every box in §7 is decided. Package names and
   registries must be settled before any manifest changes.
3. **Release commit** on main, landed like any change:
   - set `:version` in `version.edn` (the version sites keep the
     placeholder: stamped versions are never checked in, §1.1);
   - fill in the manifest fields from §8 (`private`/`publish`, `engines`,
     `rust-version`, repository and licence metadata);
   - move `[Unreleased]` to `[x.y.z] — date`.
4. **Gates on that exact commit.** All must be green, and a SKIP counts
   as a failure. Each runs under the watchdog (D326), with the result
   recorded in DEVLOG:
   - `bb versions`, `bb check`, `bb drift`, `bb stamp-test`;
   - `bb scan-test`, `bb rscan-test`, `bb vm-test`, `bb vmsession-test`,
     `bb sequence-test`, `bb valid-test` (with the cbor2 arm present);
   - `bb compile-test`, `bb compile-fuzz`;
   - `bb nav-test`, `bb write-test`, `bb unicode-test`, `bb abnf-test`;
   - `bb rust-api-test` (default mode, and the `full` mode once P9.6a
     lands);
   - `bb wasm-sdk-test` and `bb wasm-package-test` (the SDK ships, O3);
   - `bb size`, `bb watchdog-test`;
   - `npm test` in `host/js`;
   - `node corpus/tools/run-rfc-corpus.mjs --gate` (no unexplained or
     stale checks);
   - `bb proptest` (at least the 2-minute P1–P5 campaign);
   - the runtime-support gates of §2: the oldest declared Node line, the
     declared MSRV, and `tools/runtime/run.mjs` on Chrome and workerd.

   If the code changed after P9.9's full runs, the owner decides whether
   those runs are repeated, and the decision is recorded.

   The identity gates (`bb identity`) also run on the stamped tree of
   step 5, because the version is in every source key.
5. **Build the artefacts, locally, without publishing,** from a stamped
   tree that is never committed: `git worktree add --detach .cache/release
   <commit>`, then `bb stamp` there (it stamps `version.edn`'s
   `:version` and re-emits `gen/`). In that tree:
   - npm: `npm run build` in `host/js` into a fresh scratch directory,
     then `npm pack --dry-run` there to review the file list;
   - crate: `kin/scripts/rust-crate`, then `cargo package --list` and
     `cargo package --no-verify`, offline, in the assembled crate;
   - SDK: `kin/scripts/wasm-build sdk` and `cc` with the pinned toolchain
     (`nightly-2026-09-16` with `wasm32-unknown-unknown` and `rust-src`,
     which `-Zbuild-std` needs; the default in `kin/scripts/wasm-build`,
     overridden only by `SNUG_WASM_TOOLCHAIN`, and the manifest records
     which was used) and the pinned `wasm-opt` (binaryen in `bench/compare`, D341). The
     shipped modules are `.cache/snug-wasm-sdk/snug.wasm` (opt-level 3, then
     `wasm-opt -O3`) and `.cache/snug-wasm-cc/snug.wasm` (opt-level "z",
     then `wasm-opt -Oz`). `bb wasm-size` gates their sizes.
     `bb wasm-release` runs both builds and stages the release artefacts in
     `.cache/release/wasm`: `snug.wasm`, `snug-compiler.wasm`, `SHA256SUMS`
     and `MANIFEST.json` (version, commit, toolchain, `wasm-opt` version,
     sizes, SHA-256, required wasm features). Then
     `node host/wasm-sdk/package-build.mjs` stages `@3sln/snug-wasm` from
     those exact bytes into `.cache/release/npm/snug-wasm`, and
     `npm pack --dry-run` there lists its files. `bb wasm-package-test` does
     all of this and installs the packed tarball into a scratch project
     (docs/wasm-sdk.md).

   Record each artefact's SHA-256 and the producing commit in DEVLOG. The
   same commit and `version.edn` give byte-identical artefacts
   (`bb stamp-test` checks this for the npm tarball and the `.crate`).
6. **Licence and notice check:**
   - every artefact contains `LICENSE` (MIT, "Copyright (c) 2026 3sln"),
     `THIRD_PARTY_NOTICES.md` and `SECURITY.md`;
   - the crate has no dependencies (`cargo tree` shows only `snug-cbor`);
   - neither npm package has `dependencies`;
   - nothing under `corpus/`, `bench/` or `tools/` is inside an artefact,
     because the notices call that material "not shipped";
   - the `@3sln/snug/unicode` tables (generated from Node's Unicode 16.0
     property data, `tools/unicode/gen-tables.mjs`) are covered by the
     Unicode License v3 text in `THIRD_PARTY_NOTICES.md` (O6).
7. **Owner go.** The owner reviews:
   - the gate record;
   - the changelog;
   - the artefact listings and checksums.

   Then the owner gives (or withholds) the go. Publishing, tagging (for
   example `vX.Y.Z` on the release commit) and pushing are done by the
   owner or on the owner's instruction, never by an engineer on their own
   initiative.
8. **After the release:** open a new `[Unreleased]` section, and record
   the release (version, commit, artefact checksums) in DEVLOG.

## 5. Deprecation and security fixes

### 5.1 Deprecation (proposed)

- **What gets a deprecation:**
  - before removal or a breaking rename, a public API item, option, option
    value, preset or error code is deprecated first, when that is
    feasible;
  - semantic changes (verdicts, prices, defaults) cannot be deprecated in
    place. They follow §1.3 and get a changelog **Breaking** entry
    instead.
- **How:**
  - a JSDoc `@deprecated` in `types/`;
  - `#[deprecated(since = "x.y.z", note = …)]` in Rust;
  - a changelog **Deprecated** line naming the replacement;
  - a note in api.md, rust.md or the guide.
- **No runtime warnings** by default. A library that validates hostile
  input should not write to the console.
- **How long:** at least one minor release before removal, in 0.x and 1.x
  alike. Removal is breaking (§1.2).
- **Options and spellings:** an old spelling is either kept as a documented
  alias through the deprecation, or refused loudly with a TypeError that
  names the replacement. It is never silently mapped to a different
  meaning (the D301 `'reference'` precedent).

### 5.2 Security fixes (proposed)

- **Reports:** privately to **contact+security@3sln.com** (O5).
  `SECURITY.md` at the repository root says how to report and what to
  include; it ships in the npm package and the crate. Reports are not
  filed as public issues.
- **In scope** (snug's own guarantees, from SPEC §4 and §5 and D327):
  - a panic, trap or unbounded loop on any input or any verified Program;
  - work or memory beyond the documented budget and limits;
  - a received value, input bytes or an unnamed key in an error, path or
    message;
  - invalid CBOR accepted under a preset that refuses it;
  - a verifier that accepts a Program that misbehaves;
  - data from one session visible in another through pooled arrays (the
    D327 zero-fill property).
- **Supported lines:**
  - before 1.0, only the latest `0.y` line gets fixes;
  - from 1.0, the latest minor of the current major gets fixes, plus, as a
    proposal, the previous major's latest minor for 6 months after a new
    major.
- **Shipping a fix:**
  - a fix ships as a patch release, through the same gates (§4) and with
    the owner's go;
  - a fix may break the rules of §1.3, for example a verifier refusal or a
    price raise on an under-charged path, but only as far as the fix
    needs, and the changelog's **Security** section says so;
  - disclosure is coordinated with the reporter, and the details are
    published after the fix is available.

## 6. Relation to other documents

- Decisions: D338 (this policy), D084, D100 and D318 (Program format),
  D130 (native default, wasm SDK opt-in), D200 and D303 (size, not API),
  D241 and D316 (prices), D080 (Bindle optional).
- [CHANGELOG.md](../CHANGELOG.md) holds the user-facing record.
- [api.md "Errors"](api.md#errors), [rust.md](rust.md) and
  [profiles.md](profiles.md) define the codes and presets that §1.3
  protects.

## 7. Owner decisions

All eight were decided by the owner on 2026-11-12, in session, through the
coordinator. The owner's answers are recorded below; the original options
and recommendations are in git history. Implementation is tracked in
DEVLOG under P9.15 and P9.17–P9.19.

- [x] **O1 — First version: 0.1.0.** Owner: the first version is 0.1.0,
  "because it is a pre-release and no stable SDK/API is claimed yet".
- [x] **O2 — One version for every artefact, from one source.** Owner: all
  artefacts share one version.
  - The single source is `version.edn` at the repository root.
  - The release process stamps it onto every version site: package.json
    files, Cargo.toml, kin's version literal, the SDK and so on.
  - The versions checked into project files are placeholders.
  - Owner clarification (2026-11-12): "Stamped versions in the project
    files are never checked in."
    - main and every working branch hold placeholders, and a guard test
      enforces it (D343).
    - Stamping happens only in a release build directory or worktree.
    - A stamped tree exists only as build output: release artefacts, npm
      and crate tarballs, and generated `dist` commits if O3's git-source
      route uses them (P9.19).
  - Implemented in P9.15 (D343): `version.edn`, `bb stamp`, the
    `bb versions` gate, `kin/scripts/pre-commit` and `bb stamp-test`
    (§1.1).
- [x] **O3 — What ships: JS, wasm and Rust; the wasm SDK ships.** Owner:
  JS, wasm and Rust are the priority, and the wasm SDK does ship.
  - Planned wasm artefacts:
    - the raw `.wasm` binary as a release artefact;
    - `@3sln/snug-wasm` on npm, holding the raw `.wasm` and a JS SDK
      that loads it from a path, URL, bytes or a `WebAssembly.Module` the
      user supplies;
    - an "easy" entry with the wasm inlined as base64, with synchronous
      init where the host allows and its size cost documented;
    - a Workers recipe using the module-binding entry.
  - Consumers that install from git source (Go modules, deps.edn and
    babashka git deps, and similar) get an orphan distribution branch of
    stamped trees with tags. This waits on a target assessment
    (DEVLOG P9.19).
- [x] **O4 — Names.** Owner: `@3sln/snug` (JS) and `@3sln/snug-wasm`
  (wasm SDK). Other targets get similar names that don't conflict. The
  Rust crate name is proposed in P9.15 (crates.io `snug` is likely
  taken).
  - Owner decision (2026-11-12): the crate is **`snug-cbor`**, with
    `[lib] name = "snug"` so users still write `use snug::…`. crates.io
    `snug` is taken by an unrelated 0.0.0 crate; `snug-cbor` was free
    (checked 2026-11-12). `@3sln/snug` and `@3sln/snug-wasm` were
    unclaimed on npm. Set in `host/rust/Cargo.toml` by P9.15 (D343).
  - Repository URL: `https://github.com/3sln/snug`, confirmed by the owner
    on 2026-11-12. The repository exists and is private for now;
    visibility is the owner's choice. Every manifest's repository field
    holds it (P9.15).
- [x] **O5 — Security contact:** `contact+security@3sln.com` (owner),
  named in `SECURITY.md` (P9.15; it ships in the npm package and the
  crate).
- [x] **O6 — Unicode data notice:** yes (owner). The Unicode License v3
  text goes in `THIRD_PARTY_NOTICES.md` (P9.15: under "Unicode data
  (snug/unicode)", the text of unicode.org/license.txt).
- [x] **O7 — Minimum supported versions: whatever works today, tested
  and pinned.** Owner: test which versions work today and pin those.
  - Find the oldest Node and the oldest stable Rust that pass the gates.
  - Add gates on exactly those toolchains.
  - State them in the manifests (`engines`, `rust-version`).
  - Done (P9.18, D344): Node ≥ 20 and Rust ≥ 1.87, gated by `node-oldest`
    and `msrv` (§2).
- [x] **O8 — Budget pricing rule of §1.3:** adopted as recommended (owner).
  Raising a price is breaking; cutting one is minor, with notice.

Publishing, pushing and tagging a remote remain the owner's call (§4).

## 8. What in the repository has to change before a release

Nothing below was changed by P9.11. The manifests are untouched. These
items are for the release commit or for earlier items:

> **Status (P9.15, 2026-11-12).** Done: the version sites and their test;
> the description, keywords, readme and `include` metadata; the SDK
> description; `CHANGELOG.md` in the npm staging and the crate; a crate
> layout that `cargo package` accepts; `#[non_exhaustive]` (D339); and
> `ci/gate-map.edn` with `bb gates` and `bb identity`. `engines` and
> `rust-version` (O7) were set by P9.18 (D344), and the SDK staging (O3)
> by P9.17 (D345). The P9.15 rework (D343) added `version.edn` with
> `bb stamp`, `bb versions` and `bb stamp-test` (O1, O2); the names
> `@3sln/snug`, `@3sln/snug-wasm` and the crate `snug-cbor` (O4);
> the repository URL in every manifest; `SECURITY.md` (O5); and the
> Unicode notice (O6). Still open: `private` / `publish` (only with the
> owner's go). The stale statements listed at the end were corrected by
> P9.10 (2026-11-12). The text below is the P9.11 record.

- **Version sites**:
  - `kin/compile/main.kin` hard-codes `"0.0.0"`, and `version-byte`
    spells only that string: it answers `.` at odd positions and `0`
    elsewhere. `SNUG_VERSION_LEN` is 5, so any other version needs a
    kin change and a re-emit, not just a manifest edit.
  - No test ties `Cargo.toml` or `host/wasm-sdk/package.json` to the kin
    version. A check like `package.test.mjs`'s should cover them.
- **Manifests**:
  - Remove `private` / `publish = false` only with the owner's go.
  - Add `engines` (npm) and `rust-version` (crate). *Done (P9.18, D344).*
  - Add `repository`, `description` and `readme` metadata (the crate has
    none), and an `include` list for the crate.
  - `host/wasm-sdk/package.json`'s description still reads "P7.9
    experiment".
- **Packaging**:
  - Add `CHANGELOG.md` to `package-build.mjs`'s copied files.
  - The SDK has no staging or build script. *Done in P9.17 (D345):
    `bb wasm-release` and `host/wasm-sdk/package-build.mjs`.*
  - The crate is assembled into `.cache/snug-rs/` and has no
    publish-ready layout.
- **Rust API**: `SourceError`, `Value`, `OnInvalid` and the option enums
  (`Top`, `Keys`, `Tags`, `Floats`, `Cuts`, `Regexp`, `CompilerProfile`,
  …) are not `#[non_exhaustive]`; only `Error` is. Adding a variant to
  them is breaking under §1.3. P9.7 adds `SourceError::SessionLimit`.
  Before the first release, decide which enums to mark (P9.10/P9.13).
- **CI**: none exists. SPEC §9 lists `ci/gate-map.edn` and SPEC §7 a
  `bb identity` gate, and neither exists. The gates are run by hand.
- **Stale statements** for P9.10:
  - README, api.md and guide.md still describe Program format 1.0/1.1;
    it is 2.0 (D318).
  - SPEC §2 item 4 still says float widths are encoded widths (D328
    changed that).
  - The README features table still calls `deterministic` the default
    preset (D260 made `valid` the default).
  - SPEC §1.1 lists `.abnf` as refused (P9.14 pending).
