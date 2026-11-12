# Release and version policy

Status: **proposed, 2026-11-12 (P9.11, D338).** Nothing has been released.
Writing this policy publishes nothing. No package is published, no tag is
pushed and no registry is touched until the owner gives an explicit go for
a named commit (§4). Every manifest is still `private: true` /
`publish = false` at version `0.0.0`.

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
| npm package (native JS, the default per D130) | `host/js`, staged by `npm run build` | `host/js/package.json`: `"name": "snug"`, `"version": "0.0.0"`, `"private": true`, no `engines` |
| Rust crate | `host/rust` + `gen/rust`, assembled by `kin/scripts/rust-crate` into `.cache/snug-rs/` | `host/rust/Cargo.toml`: `name = "snug"`, `version = "0.0.0"`, `publish = false`, edition 2021, no `rust-version`, no dependencies |
| wasm SDK (opt-in per D130; experimental) | `host/wasm-sdk` over the module built by `kin/scripts/wasm-build sdk` / `cc` | `host/wasm-sdk/package.json`: `"name": "snug-wasm-sdk"`, `"version": "0.0.0"`, `"private": true`, no build or staging script |

**Proposed: one version number for all artefacts, released in lockstep.**
The artefacts share one core: the same kin sources generate the compiler,
verifier and VM, cross-host identity is a gate (SPEC §7), and they share
the Program format. The snug version string is also inside every compiled
Program. It is part of the SOURCE_KEY preimage (`kin/compile/main.kin`,
`build-key-preimage`) and is written to the container's producer field.
A single number lets "snug x.y.z" name one semantics. A release in which
one artefact has no changes still bumps it, and its changelog entry says
"no changes in this artefact".

The version appears in several places, and all of them must agree: both
`package.json` files, `Cargo.toml` (and `host/wasm/Cargo.toml`),
`host/js/src/version.mjs`, and `snug-version` / `SNUG_VERSION_LEN` /
`version-byte` in `kin/compile/main.kin`, followed by a re-emit of `gen/`.
`host/js/test/package.test.mjs` already checks that package.json, the
runtime mirror and the compiler agree. Nothing checks the Rust manifests
(see §8).

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

Today, nothing is declared in a manifest: there is no `engines`, no
`rust-version` and no CI configuration in the repository. Gates are the
`bb` tasks in `bb.edn`, run by engineers on one macOS machine. The values
below are derived from the code and from what the gates actually ran.

| Runtime | Floor derived from the code (stated) | Actually tested (stated) | Proposed support statement |
| --- | --- | --- | --- |
| Node.js | ≥ 20. `String.prototype.isWellFormed` is used without a guard (`host/js/src/writer.mjs`). Other modern features are guarded: `Float16Array` and `scheduler.yield`, with a fallback to `setImmediate` and then `MessageChannel`. | Node v24.6.0 only: `npm test`, every gate, the P7.7 consumer run | **Proposed, needs owner/coordinator confirmation:** support the Node lines that are in active or maintenance LTS at release time. Declare `"engines": { "node": ">=22" }` only if a `npm test` run on Node 22 is added to the release gates; otherwise declare `>=24`. Node 20 meets the floor but is past upstream end of life. |
| Browsers | ES2022, which the guide's esbuild recipe targets (`--target=es2022`), plus `String.prototype.isWellFormed` (ES2024): Chrome/Edge 111+, Firefox 119+, Safari 16.4+ | Chrome 156 headless under a strict CSP, at revision `f275938` (2026-11-03) only (guide "Browser and Worker recipes") | **Proposed:** state the feature floor as "expected to work". Claim only evergreen Chrome as tested, and only after `tools/runtime/run.mjs` passes on the release commit (§4). Firefox and Safari are untested, and the release notes say so. |
| Workers | Same as browsers. The native package needs no wasm and no `eval`. | workerd 1.20261102.1, compatibility date 2025-12-01, no `nodejs_compat`, at `f275938` only | **Proposed:** as for browsers, re-run on the release commit. |
| Rust | MSRV ≥ **1.87**: generated code uses `cast_signed` / `cast_unsigned` (1.87). Also `Option::is_none_or` (1.82) and return-position `impl Trait` in traits (1.75, D331). Edition 2021. | rustc 1.92.0 (Homebrew stable) only: `rust-api-test`, `check` and every Rust gate | **Proposed, needs confirmation:** `rust-version = "1.87"`, but only after a `cargo +1.87 test` run on the assembled crate becomes a release gate. Until then declare `rust-version = "1.92"`, the only tested toolchain. MSRV policy: raised only in a minor release, with notice. |
| wasm SDK (build) | `wasm32-unknown-unknown`, nightly-only flags (`-Zbuild-std`, `panic=immediate-abort`), toolchain pinned to `nightly-2026-09-16` (`kin/scripts/wasm-build`, override `SNUG_WASM_TOOLCHAIN`) | `bb wasm-sdk-test` under Node 24.6.0; the D005 / D130 benches in Node, Chrome and workerd at `93f8718` | **Proposed:** consumers never need Rust, because the SDK ships prebuilt `.wasm`. The pinned nightly is a build requirement only, and the release records it with the module's SHA-256. Runtime: any engine with WebAssembly 1.0 plus the features rustc enables by default for that target at the pinned toolchain. The release must list those features after inspecting the module. Not done yet. Hosts need `'wasm-unsafe-eval'` under a CSP, and workerd needs a `.wasm` module binding (D130). |
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
   - set the version at every site listed in §1.1;
   - re-emit `gen/` and check that `bb drift` is clean;
   - fill in the manifest fields from §8 (`private`/`publish`, `engines`,
     `rust-version`, repository and licence metadata);
   - move `[Unreleased]` to `[x.y.z] — date`.
4. **Gates on that exact commit.** All must be green, and a SKIP counts
   as a failure. Each runs under the watchdog (D326), with the result
   recorded in DEVLOG:
   - `bb check`, `bb drift`;
   - `bb scan-test`, `bb rscan-test`, `bb vm-test`, `bb vmsession-test`,
     `bb sequence-test`, `bb valid-test` (with the cbor2 arm present);
   - `bb compile-test`, `bb compile-fuzz`;
   - `bb nav-test`, `bb write-test`, `bb unicode-test`;
   - `bb rust-api-test` (default mode, and the `full` mode once P9.6a
     lands);
   - `bb wasm-sdk-test`, if the SDK ships;
   - `bb size`, `bb watchdog-test`;
   - `npm test` in `host/js`;
   - `node corpus/tools/run-rfc-corpus.mjs --gate` (no unexplained or
     stale checks);
   - `bb proptest` (at least the 2-minute P1–P5 campaign);
   - the runtime-support gates of §2: the oldest declared Node line, the
     declared MSRV, and `tools/runtime/run.mjs` on Chrome and workerd.

   If the code changed after P9.9's full runs, the owner decides whether
   those runs are repeated, and the decision is recorded.
5. **Build the artefacts, locally, without publishing:**
   - npm: `npm run build` in `host/js` into a fresh scratch directory,
     then `npm pack --dry-run` there to review the file list;
   - crate: `kin/scripts/rust-crate`, then `cargo package --list` and
     `cargo package --no-verify`, offline, in the assembled crate;
   - SDK: `kin/scripts/wasm-build sdk` and `cc` with the pinned toolchain,
     plus the SDK staging that does not exist yet (§8).

   Record each artefact's SHA-256 and the producing commit in DEVLOG.
6. **Licence and notice check:**
   - every artefact contains `LICENSE` (MIT, "Copyright (c) 2026 3sln")
     and `THIRD_PARTY_NOTICES.md`;
   - the crate has no dependencies (`cargo tree` shows only `snug`);
   - neither npm package has `dependencies`;
   - nothing under `corpus/`, `bench/` or `tools/` is inside an artefact,
     because the notices call that material "not shipped";
   - the `snug/unicode` tables (generated from Node's Unicode 16.0
     property data, `tools/unicode/gen-tables.mjs`) are covered by the
     notices. **Open item:** whether the Unicode License v3 notice must
     ship with derived category ranges is for the owner to settle (§7,
     O6). This document does not decide it.
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

- **Reports:** privately to **`[SECURITY CONTACT — OWNER TO FILL IN]`**.
  No contact address exists in the repository, and none is invented here.
  A `SECURITY.md` pointing to that contact should be added at release
  (§7, O5). Reports are not filed as public issues.
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

None of these is decided. Each has a recommendation.

- [ ] **O1 — First version: 0.1.0 or 1.0.0.**
  *Recommendation: 0.1.0.* The Rust API has just broken (D327), the async
  drivers are about to be refactored (P9.6b), P9.10's stranger pass and
  P9.13's review are still open, and the wasm SDK is experimental. 1.0
  would freeze all of that. Plan 1.0 after one release cycle with no
  breaking change.
- [ ] **O2 — Lockstep versions or independent versions.**
  *Recommendation: lockstep* (§1.1). Independent versions would need a
  matrix saying which crate version matches which npm version for Program
  and verdict identity.
- [ ] **O3 — Which artefacts the first release contains.** Options:
  (a) npm only; (b) npm and the crate; (c) npm, the crate and the wasm SDK
  marked experimental.
  *Recommendation: (b).* The crate is gated (`rust-api-test`) and has no
  dependencies. The SDK has no staging or build-for-publish path yet and
  depends on a pinned nightly, and D130 says it ships "if at all, marked
  experimental".
- [ ] **O4 — Registry names.** npm `snug` and crates.io `snug` are what the
  manifests and docs use today, and their availability has not been
  checked (offline). Options: an unscoped `snug`, if free; a scoped
  `@3sln/snug` (and `@3sln/snug-wasm-sdk`); a crate named `snug`, or e.g.
  `snug-cddl` if `snug` is taken.
  *Recommendation:* use `@3sln/snug` on npm, because it needs no name
  dispute and matches the owner's scope. The import specifiers in every
  doc and example then change from `'snug'` to `'@3sln/snug'`. For the
  crate, use `snug` if free, otherwise `snug-cddl`.
- [ ] **O5 — Security contact**, and whether to use a hosted private
  reporting channel. *Recommendation:* a dedicated address or the forge's
  private advisory feature, named in `SECURITY.md`.
- [ ] **O6 — Unicode data notice** for the `snug/unicode` tables (§4 step
  6). *Recommendation:* add the Unicode License v3 text to
  `THIRD_PARTY_NOTICES.md` under a "Unicode data (snug/unicode)" heading.
  It is cheap and removes the doubt.
- [ ] **O7 — Supported runtime statements** (§2): Node `>=22` or `>=24`,
  and MSRV 1.87 (after a gate on that toolchain) or 1.92.
  *Recommendation:* Node `>=22` and MSRV 1.87, each with its gate added.
- [ ] **O8 — The budget rule of §1.3** (price raises are breaking; price
  cuts are minor with notice). *Recommendation: adopt as written.*

## 8. What in the repository has to change before a release

Nothing below was changed by P9.11. The manifests are untouched. These
items are for the release commit or for earlier items:

- **Version sites**:
  - `kin/compile/main.kin` hard-codes `"0.0.0"`, and `version-byte`
    spells only that string: it answers `.` at odd positions and `0`
    elsewhere. `SNUG_VERSION_LEN` is 5, so any other version needs a
    kin change and a re-emit, not just a manifest edit.
  - No test ties `Cargo.toml` or `host/wasm-sdk/package.json` to the kin
    version. A check like `package.test.mjs`'s should cover them.
- **Manifests**:
  - Remove `private` / `publish = false` only with the owner's go.
  - Add `engines` (npm) and `rust-version` (crate).
  - Add `repository`, `description` and `readme` metadata (the crate has
    none), and an `include` list for the crate.
  - `host/wasm-sdk/package.json`'s description still reads "P7.9
    experiment".
- **Packaging**:
  - Add `CHANGELOG.md` to `package-build.mjs`'s copied files.
  - The SDK has no staging or build script.
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
