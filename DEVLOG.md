# snug — DEVLOG

The live tracker. `SPEC.md` says what snug is and changes only when a decision
changes; `docs/architecture.md` is the design; this file says what is being
built, in what order, and why that order. Steps, findings and decisions are
added here as work happens. Modelled on emon's `DEVLOG.md`.

**Status keys:** `[ ]` not started · `[~]` in progress · `[x]` done ·
`[!]` blocked (say on what) · `[?]` open question, must be answered before the
item starts.

**How to take an item.** Every item has a *Brief* (what to build), *Files*
(where), and *Done when* (the check that goes green). An item is done when its
check is green **and** its entry here says what was learnt, with the commit. A
decision taken while doing it gets the next `D###` in the Decisions section —
decisions do not block work, but they must be written down. Sign-off boxes are
the owner's and are never pre-ticked.

Origin: delegated by the 3sln.me coordinator on the owner's direction
(2026-10-29) as an experimental side project, managed by a Claude agent with
Claude and Codex subagents.

---

## Current milestones

1. [x] **P0 — Design and skeleton.** Architecture revision 2 after two
   independent reviews (Codex, Claude); every finding dispositioned.
2. [ ] **P1 — kin toolchain, JS target experiment, profile scanner.**
3. [ ] **P2 — JS host codec** (value builder, encoder) against 3sln.me's vectors.
4. [ ] **P3 — CDDL compiler and validator VM.**
5. [ ] **P4 — Differential, fuzz, benchmarks, recommendation.**

## The ordering principle

**1. The decision procedure before the host.** Everything that decides
accept/refuse is kin, so the kin toolchain (and the JS-target question) comes
first; hosts only build values and encode.

**2. Measure the experiment before betting on it.** The JS kin target is
built against a real hot loop (the CBOR profile scanner) and measured against
hand-written JS and the wasm build before the compiler and VM are written in
it (D005).

**3. Interfaces before parallel work.** The Program format (`docs/program.md`)
is frozen before the compiler and the VM are built in parallel (D015).

**4. Every claim is a gate.** Conformance, cross-host identity, drift,
vectors, fuzz and limits are scripts that print `ok`/`FAIL`, not prose.

---

## Phase 0 — Design and skeleton

- [x] **P0.1 — Name, repository, licence.**
  *Brief*: choose a short lower-case name, `git init`, MIT licence matching
  emon/nome (`Copyright (c) 2026 3sln`).
  *Files*: `LICENSE`, `.gitignore`.
  *Done when*: repository exists with no remote.
  *Done 2026-10-29.* Name `snug` (D001). No collision in `~/Projects/@3sln`.

- [x] **P0.2 — Corpus import.**
  *Brief*: copy the study's six transcribed contracts, 66 probes, differential
  and fuzz scripts and the oracle binding source, and 3sln.me's CBOR vectors,
  into `corpus/`, with provenance.
  *Files*: `corpus/cddl-study/`, `corpus/cbor-vectors/`, `corpus/PROVENANCE.md`.
  *Done when*: files present with source paths and the 3sln.me commit.
  *Done 2026-10-29.* 3sln.me commit `0daa2b6f`. The oracle's built wasm,
  the crate archive and the native CLI were preserved in the session scratch
  (`cddlproj-oracle/`), not committed (binaries; reproducible from the crate).
  cbor.mjs copied to `bench/baseline/cbor-3sln.mjs` as the benchmark baseline.

- [x] **P0.3 — Architecture and specification.**
  *Brief*: `docs/architecture.md` (compilation model, map/choice soundness,
  fused profile checks, memory, errors, limits, alternatives, benchmark
  plan), `SPEC.md`, this file.
  *Done when*: written; decisions D001–D017 recorded.
  *Done 2026-10-29.*

- [x] **P0.4 — Independent design review.**
  *Brief*: two independent reviews of `docs/architecture.md` — one Claude
  agent, one Codex — each asked to break the soundness arguments, the
  linearity and budget claims, the error determinism, and the JS-target exit
  criteria. Findings answered here; the architecture revised.
  *Files*: `docs/reviews/2026-10-29-{codex,claude}.md`, `docs/architecture.md`.
  *Done when*: every finding is accepted (with a change) or rebutted (with a
  reason).
  *Done 2026-10-29.* Codex: 22 findings (5 blockers/majors on matching);
  Claude: 14 findings (3 blockers). They converged independently on the same
  three blockers: (1) map factors are not exact when a residual wildcard can
  take a factor's key (`{ ? (a: int, b: int), * tstr => any }` with `{a: 1}`);
  (2) group occurrence in maps is neither clampable nor multipliable in
  general (`{ + (email: tstr // phone: tstr) }`, `{ 0*2 (2*2 tstr => int) }`);
  (3) the array counter condition looked at the wrong side
  (`[? uint, 2*3 uint, tstr]`, `[* (int, int), 3*3 uint]`). Both confirmed the
  flat cut-free greedy lemma and the type-set core. Other accepted findings:
  AND/`.cbor` obligations and locality, `.eq`/`.ne` lowering, a real charging
  model and compile budget, closure-based scratch sizing, one scratch per
  isolate, profile errors winning over schema errors, cbor.mjs check order,
  witness rules, path leaks through unrelated schema keys, SharedArrayBuffer
  input, Program integrity, D003's host boundary, D005 evaluated twice.
  Every finding was accepted; none rebutted. Disposition table: architecture
  §15. Revision 2 written; D003 narrowed, D013 amended, D018–D024 added.
  Scanner-related findings forwarded to P1.3 while in flight.

## Phase 1 — kin toolchain, JS target experiment, profile scanner

- [ ] **P1.1 — kin wiring.**
  *Brief*: `deps.edn`, `bb.edn` (tasks `gen emit drift check`), project,
  targets (`:js`, `:rust`), vocabulary `snug.lang` (tags `I32 U8 Bool Bytes
  Ints`, byte and int-arena forms, `ushr`/`sar`), `kin/hello.kin`.
  *Files*: `kin/src/snug/*.cljc`, `kin/scripts/*`, `gen/`.
  *Done when*: `bb emit` writes JS and Rust; `bb check` runs both and they
  agree; `bb drift` green and red on a hand edit to `gen/`.

- [ ] **P1.2 — The JS kin target.**
  *Brief*: a `kin.lang` extension map for `:js` (every form `kin.lang` ships
  for Go) and a `:js` target map with an `:emit` producing an ES module, in
  snug's tree (D005). Integer semantics by tag.
  *Files*: `kin/src/snug/js.cljc`, `kin/src/snug/targets.cljc`.
  *Done when*: the P1.1 sources and a loop/case/defdata test source generate
  JS that `node --check`s and agrees with Rust.

- [ ] **P1.3 — Profile scanner in kin.**
  *Brief*: the CBOR profile walk (architecture §3, §4.5, profile §5) as kin:
  heads, lengths, UTF-8 and noncharacters, key order and duplicates, floats
  by bit tests, tags 2/3/4/40 and typed arrays, limits. Returns a profile
  error code and offset, or ok.
  *Files*: `kin/cbor/*.kin`, `gen/`.
  *Done when*: every accept vector passes and every refuse vector fails with
  cbor.mjs's code, on JS and Rust.

- [ ] **P1.4 — Measure the experiment (D005 gate).**
  *Brief*: generated JS scanner vs a hand-written JS scanner (same algorithm)
  vs the Rust build compiled to wasm, on the benchmark inputs of architecture
  §12; code size gzip/brotli.
  *Files*: `bench/`, `bench/README.md`.
  *Done when*: numbers recorded with environment; D005 confirmed or reversed.

## Phase 2 — JS host codec

- [ ] **P2.1 — Value builder and decode API.**
  *Brief*: trusted builder from validated bytes to JS values (profile §2, §6);
  `decode(bytes, opts)` = scanner + builder; options `top`, `cose`,
  `objects`, limits.
  *Files*: `host/js/src/*`.
  *Done when*: all 3sln.me CBOR vectors pass (accept values deep-equal,
  refuse codes equal); 3sln.me's seeded round-trip/mutation properties ported
  and green.

- [ ] **P2.2 — Encoder.**
  *Brief*: `encode(value, opts)` with cbor.mjs's semantics and refusals.
  *Done when*: vectors re-encode byte-identically; randomized
  decode(encode(v)) properties green; refusal codes match cbor.mjs.

- [ ] **P2.3 — Codec benchmarks vs cbor.mjs.**
  *Done when*: decode and encode numbers recorded (architecture §12 items 1, 2).

### Phase 2 host implementation — 2026-10-29

Implemented the hand-written JS host in `host/js/`: `Decimal`, `NDArray`
and `Float16Bytes`; a trusted builder without profile checks or validating
constructor calls; the deterministic encoder with baseline refusal codes
and options; `SnugFault`; and the public scan-then-build decode seam.
The adapter attempts `gen/js/snug/cbor/scan.mjs` and reports `unavailable`
while absent or its verdict ABI is unknown. No changes to kin, generated
sources or toolchain files. Commit: pending the manager; no commit made.

P2.1 host work is implemented; scanner integration, refusal and mutation
gates remain pending. P2.2 host checks pass. P2.3 build-only and encoder
measurements are recorded in `bench/README.md`; full decode measurement
requires the scanner, so D017 remains unresolved. Tracker boxes above are
left for the manager to reconcile with the scanner work and commit.

Checks actually run: `cd host/js && node --test test/` — **585 tests,
430 passed, 155 skipped, 0 failed** (278.435959 ms final run);
`node bench/choices.mjs` and `node bench/codec.mjs` — completed with
answers checked. Tests cover all 74 profile accept vectors, all 315
profile-valid oracle accepts, encoder/wrapper refusals, 1,000 seeded
differential values/maps in both object modes with COSE cases, copied and
aligned Buffer inputs and a separate-process float16 fallback.

Learnt: the oracle's 327 cborg accepts include **12 deliberate Bindle
refusals** (2 non_shortest, 2 key_order, 3 float, 2 bignum, 1 typed_array,
2 text). These are individual scanner-dependent refusal tests, alongside
142 profile refusal vectors and the mutation/truncation property (155
skips total); none is passed to the trusted builder. The baseline only
enforces the encoder byte cap when `maxBytes` is explicitly supplied,
which this encoder preserves. Node 24 needs `test/index.js` to resolve
the requested explicit `node --test test/` directory argument.

On Apple M1 Pro/macOS 14.6.1/Node v24.6.0, the 287-byte put measured
0.0019 ms build / 0.0045 ms encode (baseline 0.0049 / 0.0106 ms);
10,000 eight-key maps 4.0060 / 17.9178 ms (baseline 28.7495 / 62.4214);
the 1.4 MB document 10.3653 / 27.6785 ms (baseline 35.1128 / 75.6380).
Float64Array encode measured slower (0.8751 vs 0.7177 ms). These compare
trusted build with strict baseline decode, not full snug decode; all
environment, limits, method and results are in `bench/README.md`.

#### D018 — Host fast paths preserve the baseline value model
**Decision**: use a String.fromCharCode ASCII builder path for at most 8
bytes, arithmetic integer heads without per-head tuples, and ASCII text
key sorting/writing without per-key Writers. Build wrappers through
internal trusted factories; validating constructors remain for callers.
**Why**: measured 8-byte ASCII 64.0 ns vs TextDecoder 89.2 ns, but 16-byte
ASCII 116.8 vs 84.8 ns; safe uint64 arithmetic 10.8 vs BigInt conversion
25.2 ns. Short-key maps measured 7.18x build-only and 3.48x encode speedup
against the baseline. This implements D004/D017 without a second checker.
**Alternatives**: always TextDecoder; a longer ASCII cutoff (measured
slower); allocated head tuples; validating wrapper constructors in build
(would duplicate the scanner's decisions); per-key Writer buffers.
- [ ] **Signed off** (owner)

## Phase 3 — CDDL compiler and validator VM

- [x] **P3.1 — Program format frozen (`docs/program.md`).** (D015)
  *Status 2026-10-29:* format version 1 written as a **frozen candidate**,
  not frozen: it waits for the owner/manager to accept or reject the 22
  proposed resolutions in program.md §17. Each one is a point where
  architecture revision 2 is silent or ambiguous, plus one it cannot
  implement as written. What it contains: a 64-word header; fixed 8-word
  leaves for every §4.2 kind; typesets with operand-first evaluation lists
  (AND/NOT need no sort); a sorted key table; maps as factors → pools
  (alternatives sharing a residual group) → alternatives → literal entries,
  with a per-leaf key index and O(1) pool rejection; Glushkov arrays and
  regexps as bitset rows (justified against the §7 charge); sign-magnitude
  integer intervals and ordered-key float intervals; closure sets and
  per-rule chains with derived frame sizes; the scratch carve (scanner block
  reused as `o`, epoch marks, path stack, regex area, per-depth frames); the
  reason codes (profile 1–21 = `kin/codes.kin`, schema 32–41, budget 48);
  path segments; the kin API; the serialisation container; a precise
  charging schedule (§14); and a worked example with exact words and budget
  counts.
  Learnt: (1) the witness path needs no copying if dead subtrees never write
  the path stack; (2) per-pool counters are exact because the determinism
  rule keeps constrained typeset entries away from every literal key their
  pool names; (3) cross-leaf sharing for many open map types (A8) is not
  achieved, only within-leaf sharing (§17 Q7); (4) embedded `.cbor` needs
  end-bounded scanner helpers (§17 Q21, affects P1.3); (5) Rust needs a
  read-only Program tag in snug.lang (§17 Q9). No code, no gates run (this
  item is a document). Commit: pending the manager.
  *Frozen 2026-10-29 (manager).* `docs/program.md` format 1: all 22 proposed
  resolutions in its §17 accepted as proposed (D025). Architecture amended for
  q7 (per-leaf map cost; the A8 cross-leaf claim withdrawn), q17 (budget
  exhaustion preempts "profile errors win") and q8 (program.md §14 is the
  normative charge schedule). q9 (read-only Program tag) and q21 (end-bounded
  scanner helpers for embedded documents) handed to the P1 owner.

- [ ] **P3.2 — Compiler front end** (lexer, parser, resolver, generics,
  sockets, prelude).
- [ ] **P3.3 — Normaliser and lowering** (typesets, map factors and
  alternatives, determinism rule, array automata, regexps).
- [ ] **P3.4 — VM** (type-set evaluation fused with the profile walk, errors,
  budget).
- [~] **P3.5 — Conformance corpus** (study probes and contracts with expected
  verdicts corrected to RFC semantics; RFC 8610 examples; adversarial cases).

  *Implemented and checked 2026-10-29; manager commit pending (no commit made).*
  Independent oracle in `corpus/tools/oracle.mjs`, tests in
  `corpus/tools/oracle.test.mjs`, Node 24 directory entry in
  `corpus/tools/index.js`, reproducible generator in
  `corpus/tools/export-adversarial.mjs`, and vectors in
  `corpus/conformance/adversarial.json`. No implementation sources in `kin/`,
  `gen/` or `host/js/src/` were read or imported. Only the read-only baseline
  codec supplies encoding/decoding and its value wrappers.

  The oracle parses rules, groups, generics, sockets, choices, occurrences,
  unwraps, enums, cuts, literals (including exact BigInt and hex floats),
  ranges, tags, major types, all 40 Appendix D names and the requested
  controls. It enumerates map pair assignments and literal group repetitions;
  arrays and the small code-point I-Regexp interpreter retain all matching
  positions. Cuts follow D021 per alternative and source order, so an earlier
  wildcard can consume a pair before a later cut. Embedded decoding failures
  are local predicates. A shared 1,000,000-step validation budget returns
  `unknown` on exhaustion; callers may lower it for experiments. Compilation
  is also bounded. Invalid roots/host calls give `unknown`, not a fabricated
  refusal. No corpus case has an unknown verdict.

  **D025 — Independently generated, reviewable corpus expectations.**
  **Decision**: compute adversarial expectations with this AST interpreter;
  assert 510 hand-reasoned verdicts during generation, and add 400 cases from
  80 schemas using xorshift32 seed `0x5eed8610`. Store architecture refusals
  separately as `snugSchemaError`, retaining the oracle's Boolean verdicts
  (26 suites: six fixed witnesses and 20 generated overlap schemas).
  **Why**: D022 needs an independent existential oracle for the counterexamples
  that invalidated the first architecture; generation must not copy a VM's
  answers or quietly bless changed study expectations.
  **Alternatives**: the study's known-defective crate; manual verdicts alone;
  sharing the implementation's normalisation/matching algorithm.

  - [ ] **Signed off** (owner)

  **Coverage**: 223 suites / 910 adversarial cases: reviews 126; crate defects
  35; RFC examples 30; grammar 64; prelude 114; controls 141; generated 400.
  Includes map repetition/count coupling and residual factors, source-order
  cuts, ambiguous array counts, AND obligations, embedded locality, exact
  bignum boundaries, float widths/subnormals, UTF-8 sizes, bit numbering and
  anchored regexps. Review examples about invalid wire encodings, error
  precedence, mutable input, Program integrity, memory and code generation
  are not decoded-value CDDL verdicts; the strict profile forbids those
  malformed encodings. C15's valid empty typed-array witness additionally
  uses `maxItems: 1`.

  **Study agreement / disagreements**: 197/197 eligible cases agree across
  63 suites; **zero disagreements**. Seven suites / 16 cases are excluded
  exactly as requested (`schemaError` or `phase: "later"`). No expectation
  in `study.json` changed, and `export-study.mjs` needed no changes.

  **Checks actually run**: `node --test corpus/tools/` — **301 tests passed,
  0 failed, 0 skipped**. `node corpus/tools/export-adversarial.mjs` completed;
  a second regeneration was checked byte-for-byte identical. Every adversarial
  wire value decodes with the baseline using `top: "any"`, re-encodes
  identically, and gives the stored Boolean verdict.

  **Learnt**: the baseline's typed-array decoder assumes that `slice()` returns
  a fresh offset-zero byte array. A Node `Buffer` violates that assumption:
  pooled Buffer fixtures can produce a typed array over unrelated pool bytes.
  The initial test run therefore had three round-trip failures; copying hex
  fixtures into plain `Uint8Array`s fixed the adapter. The baseline was left
  untouched. Numeric tag syntax must retain its original digits (`#6.0`,
  `#6.20`, and large tag numbers), and a spaced `* 3` repeats literal 3 rather
  than setting an occurrence maximum. Dedicated tests cover both. Fourteen
  prelude names require tags/simple values forbidden by the profile, so no
  profile-valid accepting case exists for them; `any` has no profile-valid
  refusing case. These limits are explicit in the corpus. Scalar -0 likewise
  has no profile value and is exercised only inside typed arrays.

## Phase 4 — Differential, fuzz, benchmarks

- [ ] **P4.1 — Differential vs the `cddl` crate (native)** on its correct subset.
- [ ] **P4.2 — Fuzz** (schemas, values, mutated bytes; hosts agree; no crash;
  budget respected).
- [ ] **P4.3 — Benchmarks** (architecture §12) and the 3sln.me recommendation.

---

## Decisions

Append-only. Each entry says what was decided, why, and what else was
considered, so a later reader does not reopen it by accident. The sign-off
box is the owner's.

### D001 — The project is called `snug`
**Decision**: `snug`, at `~/Projects/@3sln/snug`.
**Why**: CDDL is pronounced "cuddle"; a value that fits its schema is snug.
Four letters, lower case, in the style of `emon`/`nome`/`kin`; no collision
in `~/Projects/@3sln`.
**Alternatives**: `hug` (too generic), `dill` (no meaning), `cuddle` (long).
- [ ] **Signed off** (owner)

### D002 — The CBOR codec is part of snug
**Decision**: snug includes the strict CBOR decoder and encoder.
**Why**: a CDDL validator for CBOR must walk CBOR bytes under the profile
anyway — that walk is most of a decoder. Fusing the profile checks with
validation (one pass, architecture §4) is the main performance and
robustness win; the study's crate re-decoded with a lenient decoder of its
own (study §0 item 6, §8 "double decoding"). Keeping the codec separate would
mean two implementations of the profile's refusals.
**Alternatives**: validate values decoded by 3sln.me's cbor.mjs (rejected:
architecture §11); a validator-only library (rejected: duplicate profile
logic). Evidence to confirm: P2.3/P4.3 benchmarks against cbor.mjs.
- [ ] **Signed off** (owner)

### D003 — kin owns every accept/refuse decision about bytes
**Decision**: the compiler, the VM and the profile scanner are kin; no host
contains a refusal of CBOR bytes or a schema verdict. *Amended 2026-10-29
(review C19, A10):* host-value admissibility in the encoder (classes with no
CBOR form, sparse arrays, cycles, lone surrogates, NaN) is the host's, pinned
by shared vectors.
**Why**: these must agree across hosts (SPEC §7), and they are integer logic
over bytes, which is what kin generates well.
**Alternatives**: compiler hand-written in JS with only the VM in kin
(rejected: architecture §11).
- [ ] **Signed off** (owner)

### D004 — Hosts own the value model, the encoder and the API
**Decision**: the value builder and the encoder are hand-written per host.
**Why**: a JS object, `bigint` or typed array has no kin spelling, and this is
the part that allocates; the builder runs only on validated bytes and so
contains no checks.
**Alternatives**: a kin "tape" the host consumes (kept in reserve if the
builder measures slow).
- [ ] **Signed off** (owner)

### D005 — A JavaScript kin target, as an experiment with an exit
**Decision**: build a `:js` target in snug's tree (a `kin.lang` extension map
and a target map; no change to kin). Keep it if, on the P1.4 benchmark, the
generated scanner is no worse than 1.25× a hand-written JS scanner and the
JS output is smaller than the wasm build after gzip; otherwise ship the Rust
build as wasm with a hand-written JS host, as emon and nome do.
**Why**: JS is the primary consumer, and the study measured wasm's costs in
exactly this setting: linear memory that never shrinks (71 MB after one
hostile request), an input copy per call, instance corruption after a trap,
async compile in browsers and a separate module type in Workers. A pure-JS
build has none of these. emon D001 rejected a JS target because wasm is "the
same code" — true, and the deciding question here is cost on the primary
host, which is measurable.
**Alternatives**: wasm only (the fallback); hand-written JS (rejected: a
second implementation to keep identical, the problem kin exists to remove).
- [ ] **Signed off** (owner)

### D006 — Revision 1 targets: JavaScript and Rust (+ wasm)
**Decision**: `:js` and `:rust`. Go, Java and C# are not targets yet.
**Why**: JS is the consumer; Rust is the native oracle host and the wasm
comparison. Each further target costs a vocabulary arm per form and a host,
with no consumer asking.
**Alternatives**: all four of emon/nome's targets from day one (rejected: no
consumer; adding later is adding arms).
- [ ] **Signed off** (owner)

### D007 — Licence MIT, `Copyright (c) 2026 3sln`
**Decision**: as emon and nome.
- [ ] **Signed off** (owner)

### D008 — Validation is over CBOR bytes, not host values
**Decision**: the VM validates bytes; host values are validated by encoding
them.
**Why**: one implementation for every host; no allocation before refusal;
3sln.me encodes what it sends anyway.
**Alternatives**: a value walker per host (rejected: per-host logic).
- [ ] **Signed off** (owner)

### D009 — No host numbers or strings in any decision
**Decision**: integers compare as sign + magnitude bytes, floats as bit
patterns, literals and keys as deterministic encodings (architecture §3).
**Why**: exactness at any size (study's wasm32 bug), cross-host identity, and
allocation-free JS.
- [ ] **Signed off** (owner)

### D010 — Type-set evaluation, never backtracking
**Decision**: each item is evaluated once against the set of leaf types it
may be; containers advance all candidates in parallel (architecture §4.1).
**Why**: linear time, no memo memory, soundness by construction.
**Alternatives**: ordered trial with backtracking (+ memo) (rejected:
architecture §11).
- [ ] **Signed off** (owner)

### D011 — Maps: greedy priority assignment under a compile-time determinism rule
**Decision**: architecture §4.3.2. Overlapping key domains within one
alternative require the lower-priority entry to be absorbing; otherwise the
schema is refused.
**Why**: exact RFC semantics without bipartite matching; every map in the
study's contracts passes.
**Alternatives**: bipartite matching (deferred until a refused schema
matters).
- [ ] **Signed off** (owner)

### D012 — Arrays: Glushkov automata; counters only where unambiguous
**Decision**: architecture §4.4; ambiguous bounded repetitions unroll up to
the position limit, else the schema is refused.
- [ ] **Signed off** (owner)

### D013 — Refused controls: `.pcre`, `.abnf`, `.abnfb` (`.feature` amended)
*Amended 2026-10-29 (review A12):* `.feature` is accepted as a no-op
annotation (RFC 9165: it always matches).
**Why**: non-portable or unbounded engines; the study found `.abnf` wrong in
the crate and the profile excludes them.
- [ ] **Signed off** (owner)

### D014 — `.regexp` is anchored I-Regexp without `\p{…}` in revision 1
**Why**: RFC 8610 §3.8.3 anchoring; RFC 9485 for portability; category tables
cost bundle size and no current contract needs them.
- [ ] **Signed off** (owner)

### D015 — The Program format is frozen in `docs/program.md` before parallel build
**Why**: it is the only interface between the compiler and the VM work items.
- [ ] **Signed off** (owner)

### D016 — The VM recurses (bounded); an explicit-stack VM is deferred
**Why**: depth is bounded (32 default, 256 max); recursion is faster in JS;
3sln.me receives whole bodies. Resumable chunked input would need the
explicit stack.
- [ ] **Signed off** (owner)

### D017 — Two-pass decode (check, then build); fused single pass deferred
**Why**: nothing is allocated before a message is known valid; no host calls
in the hot loop. Revisit if P2.3 shows the second pass costs more than ~25%.
- [ ] **Signed off** (owner)

### D018 — (reserved for P1)
### D019 — (reserved for P1)

### D020 — Float literals in schemas through a host port, ≤ 17 significant digits
**Decision**: the compiler converts decimal float literals with a host port
(`Number()` / `str::parse::<f64>`), refusing more than 17 significant digits
or out-of-range values.
**Why**: both are correctly rounded in that domain, so hosts agree bit for
bit; kin-side exact decimal→binary64 needs big-integer code for a
compile-time-only step (review A9b). Validation never uses host floats.
**Alternatives**: a kin big-integer parser (deferred unless a host disagrees).
- [ ] **Signed off** (owner)

### D021 — A cut kills the alternative, not the whole map
**Decision**: RFC 8610's "the entire map fails" for a matched cut key with a
failing value is applied per alternative (architecture §4.3.2).
**Why**: otherwise `{ kind: "a", … // kind: "b", … }` cannot work, which is
the main reason to write a group choice. Documented as a deliberate reading.
Cut literal entries following an overlapping wildcard, and cuts on key
typesets, are refused.
- [ ] **Signed off** (owner)

### D022 — A brute-force existential map matcher is the oracle for map semantics
**Decision**: the fuzz corpus includes an exhaustive-assignment matcher over
small maps; it must agree with the VM on every generated schema the compiler
accepts.
**Why**: three of revision 1's map/array rules were wrong in ways an oracle
would have caught (review A2).
- [ ] **Signed off** (owner)

### D023 — Profile errors always win over schema errors
**Decision**: after a schema failure the VM continues in profile-only mode;
any profile refusal is reported instead.
**Why**: reproduces decode-then-validate (3sln.me's 400-vs-contract split) at
cost only on invalid messages (review A5a).
- [ ] **Signed off** (owner)

### D024 — Failure witness rule
**Decision**: the reported schema failure is the deepest emptied query set on
the chain that empties the root; ties broken by leaf id, latest-dying
alternative, source order (architecture §6).
**Why**: one host-identical answer without payload (reviews C14, A4, A10).
- [ ] **Signed off** (owner)

### D025 — Program format 1 frozen with program.md §17's resolutions
**Decision**: `docs/program.md` is frozen as format 1 with its 22 proposed
resolutions accepted. Changes after this need a DEVLOG decision and both the
compiler and VM owners' agreement.
**Why**: D015; the resolutions are consistent with architecture revision 2
and close the gaps the designer found (embedded depth, witness paths, Rust
read-only Programs, budget vs profile precedence).
- [ ] **Signed off** (owner)

---

## Findings

(Measured facts worth keeping, with dates.)

## Found in kin, not ours to fix here

(Bullets: issue — REAL / WRONG / ours — explanation and workaround.)

## Open questions for the owner

- [ ] **Project controls** (equal-length columns, uniqueness, code-point
  length, decimal value bounds): in snug, or a 3sln.me extension hook? Names?
- [ ] **`\p{…}` in regexps**: worth ~10–20 KB of tables?
- [ ] **Program caching**: a stable serialised Program across snug versions?

## Parking lot

- Lazy DFA cache over typesets (architecture §4.1).
- Explicit-stack, resumable VM for chunked input (D016).
- Go/Java/C# targets (D006).
- CDDL over JSON.
