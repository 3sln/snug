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

- [x] **P1.1 — kin wiring.**
  *Brief*: `deps.edn`, `bb.edn` (tasks `gen emit drift check`), project,
  targets (`:js`, `:rust`), vocabulary `snug.lang` (tags `I32 U8 Bool Bytes
  Ints`, byte and int-arena forms, `ushr`/`sar`), `kin/hello.kin`.
  *Files*: `kin/src/snug/*.cljc`, `kin/scripts/*`, `gen/`.
  *Done when*: `bb emit` writes JS and Rust; `bb check` runs both and they
  agree; `bb drift` green and red on a hand edit to `gen/`.
  *Done 2026-10-29* (commit `470e622`). `deps.edn`/`bb.edn` (kin by path;
  tasks `gen emit drift check scan-test bench-scan`), `snug.project`
  (`[snug.lang snug.js kin.lang]`, sources flat in `kin/` because kin's disk
  vfs lists one level), `snug.targets` (`:js` ours, `:rust` = `kin.target/rust`
  with a place), `snug.lang` (tags `I32 Bool Bytes Ints`, later `IntsR Str`;
  no `U8` tag was needed: a byte read is an `I32` 0..255). Scripts as emon's:
  `emit` is `kp/emit-all!` (atomic, no input stamp — the batch takes seconds),
  `destinations` refuses a short answer, `drift` hashes before re-emitting and
  checks hand edits, stale commits, untracked, orphans and missing
  destinations; `rust-crate` assembles `.cache/snug-rs` with generated `mod`
  files. Gates run: `bb check` green (JS and Rust print the hand-worked line);
  `bb drift` green, and red on an appended line in `gen/js/snug/hello.mjs`
  and on a committed orphan. Learnt: a `defn` docstring is not a kin thing
  (it becomes the parameter vector) — use `(comment …)`; `defconst` needs a
  tag or Rust gets `const X:  = 5`.

- [x] **P1.2 — The JS kin target.**
  *Brief*: a `kin.lang` extension map for `:js` (every form `kin.lang` ships
  for Go) and a `:js` target map with an `:emit` producing an ES module, in
  snug's tree (D005). Integer semantics by tag.
  *Files*: `kin/src/snug/js.cljc`, `kin/src/snug/targets.cljc`.
  *Done when*: the P1.1 sources and a loop/case/defdata test source generate
  JS that `node --check`s and agrees with Rust.
  *Done 2026-10-29* (commit `470e622`; guard and `IntsR` in `50b9a7c`). D018.
  `snug.js` is a second `kin.lang` map for `#{:js}` (in a one-element vector:
  `load-vocabulary` only accepts a foreign `:namespace` that way). It reuses
  `kin.lang`'s own `if while forever break continue case comment do defdata .
  declare*` (their non-Rust path is valid JS) and adds `defn` (`export
  function`), `let` (`const`, `let` for `^:mut`), `local`, `return`, `set`
  (JS compound operators), `for`, `defconst` (`export const`), `doc` (JSDoc),
  `panic` (`throw`), the generic operators (`===`, `quot`/`rem` coerced) and
  the `snug.js/table` data emitter. The ES module `:emit` writes named imports
  computed from what each body referenced. Integer semantics live in
  `snug.lang`'s operators (see D018). `kin/hello.kin` covers loops, `forever`,
  `break`/`continue`, `case` with a comment arm and a constant label,
  `defconst` (incl. hex), `defdata`, byte reads, int-array writes, a
  read-only `IntsR`, and every operator where JS and Rust would disagree if
  spelled naively; `bb check` builds Rust with `-D warnings` and debug
  overflow checks, `node --check`s every module, and requires both targets to
  print the line worked out by hand. Learnt: Rust infers an unsuffixed
  literal's type from `as u32` (so `(-16) as u32` does not compile) and cannot
  call `.wrapping_mul` on `{integer}` — the templates use `i32::cast_unsigned`
  and `i32::wrapping_mul(a, b)`; a `let` shadowing a parameter is legal Rust
  and a SyntaxError in JS, so the JS target now refuses a second declaration
  of a name in one function at generation time.

- [x] **P1.3 — Profile scanner in kin.**
  *Brief*: the CBOR profile walk (architecture §3, §4.5, profile §5) as kin:
  heads, lengths, UTF-8 and noncharacters, key order and duplicates, floats
  by bit tests, tags 2/3/4/40 and typed arrays, limits. Returns a profile
  error code and offset, or ok.
  *Files*: `kin/cbor/*.kin`, `gen/`.
  *Done when*: every accept vector passes and every refuse vector fails with
  cbor.mjs's code, on JS and Rust.
  *Done 2026-10-29* (commit `2f837c7`; `read-arg` compacted and explicit
  `end` offsets (q21) in `50b9a7c`). D019. `kin/{codes,head,text,float,keys,
  tags,scan}.kin` → `snug.cbor.*`; the ordered check list and the per-tag
  item/depth table are `docs/scanner.md` (review C15/C16 included). Gate
  `bb scan-test [mutations] [seed]`: both vector files (1,146 cases; the
  oracle file's expected code is cbor.mjs's own), 214 fixed edge cases (every
  limit at and one past, length bombs, cose labels at ±2^53, precedence on
  multiply-invalid inputs) and seeded mutations of encoded values and of
  structured byte-level items aimed at the bit tests, under random options —
  through generated JS, a DEBUG Rust build (overflow checks on, panics caught
  per case), the wasm build and the hand-written yardstick; every case must
  give cbor.mjs's code, JS/Rust/wasm the same error offset, and a re-run behind
  a throwing out-of-bounds trap shows the JS never reads past the input. Run:
  200,000 mutations × seeds 2, 3, 4 and 21 green (201,360 cases each).
  Mutating a threshold turns it red (20 mutants tried: 17 red; the 3
  survivors are equivalent mutants, e.g. float16 `x >= 10` vs `>= 11`, where
  the next check refuses the same inputs; one float-exponent survivor led to
  targeted float generation, after which it went red). Learnt: integer-only
  float rules are short (shortest form = "the low k fraction bits are zero"
  for an exponent-dependent k); `(1 << k) - 1` overflows i32 at k = 31 in a
  debug Rust build, so masks are `-1 >>> (32 - k)`; a forward call
  (`declarefn`) carries no return tag, so its `let` needs `^I32`.

- [x] **P1.4 — Measure the experiment (D005 gate).**
  *Brief*: generated JS scanner vs a hand-written JS scanner (same algorithm)
  vs the Rust build compiled to wasm, on the benchmark inputs of architecture
  §12; code size gzip/brotli.
  *Files*: `bench/`, `bench/README.md`.
  *Done when*: numbers recorded with environment; D005 confirmed or reversed.
  *Done 2026-10-29* (commit `d5b74d7`); numbers in `bench/SCAN.md` (scanner
  numbers kept out of `bench/README.md`, which the codec work item owns).
  CPU-time medians, shared machine (load 13–20). generated/hand-written:
  0.94–1.09× on the int array, typed arrays and nested maps; 1.18–1.22× on the
  RPC puts; 1.26× on the 216-vector set (1.19–1.27× across runs). Size, gzip:
  JS 2,584 (wasm's API surface) / 2,935 (full) vs wasm 3,004 (O3) / 2,582
  ("z"). wasm is 1.6–2.1× FASTER than both JS scanners on the 0.6–1.1 MB
  item-heavy inputs; JS wins where the input copy dominates (1 MiB bstr:
  0.9 µs vs 22 µs). Cold start: Node, bundled JS 1.4 ms vs wasm 0.75 ms
  (7 unbundled modules 3.0 ms); workerd, both within noise of an empty worker.
  **D005 verdict: the criteria hold at the margin, not decisively** (one tiny
  input 0.01 over 1.25×; size a tie with the size-optimised wasm), and they
  miss wasm's throughput lead — recommend keeping the JS target for now and
  re-taking D005 after the VM with that gap as an input. Learnt: V8 inlines
  functions under 460 bytes of bytecode — `read-arg` at 522 was 42% of the int
  array, at 339 it inlines (2.1 → 1.6 ms); exception-based refusals cost ~9×
  on refusal-heavy input; a wasm module is mostly std (23.5 KB → 6.6 KB with
  build-std, `panic=immediate-abort` and no allocator).

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

#### D028 — Host fast paths preserve the baseline value model (renumbered from a duplicate D018)
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

- [~] **P3.2 — Compiler front end** (lexer, parser, resolver, generics,
  sockets, prelude).
- [~] **P3.3 — Normaliser and lowering** (typesets, map factors and
  alternatives, determinism rule, array automata, regexps).

  *Status 2026-10-29 (compiler engineer): working end to end; gates green.*
  The compiler is kin in `kin/compile/*.kin` (namespaces `snug.compile.*`:
  arena, lex, parse, prelude, rules, bytes, regexp, glush, leaf, ctl, maps,
  arrays, lower, emit, main), the structural verifier `vm-verify`
  (program.md §11) in `kin/program/verify.kin` (`snug.program.verify`; **the
  compiler engineer builds it**, VM engineer please do not duplicate), both
  generated into `gen/js` and `gen/rust` (`snug.project` now also lists
  `kin/compile/` and `kin/program/`). Hosts: `host/js/src/compile.mjs`
  (`compile(text, {profile, limits}) -> {program, pool, rules}`, throws
  `SchemaError {code, line, column, rule}`) and `host/rust/src/compile.rs`
  (`compile(text, profile, limits) -> Result<Compiled, SchemaError>`).
  **compile() works on the whole corpus** (VM engineer: Programs are ready to
  consume; the verifier needs `len(S) >= 48 + 2·VM_MARK_CAP` with
  `VM_MARK_CAP >= N_LEAVES` and answers −2 otherwise; it checks lit runs in
  ascending order, a stricter reading of "runs may not overlap").
  Pipeline as architecture §5.1: lexer (RFC 8610 App. B + RFC 9682: `\u{…}`,
  surrogate pairs, h''/b64'' with whitespace and h'' comments, hex floats),
  depth-limited recursive descent into an int AST, rule table (sockets,
  `/=` `//=`, generics), lowering with monomorphised memoised generics and the
  instantiation limit, nonproductive-recursion detection, containers via a
  worklist, maps (§4.3: top-level `//` split, group occurrence exact or
  refused, unsatisfiable alternatives dropped, determinism rule, cut rules,
  factors under §4.3.3 only), arrays (Glushkov, counters under the
  predecessor condition else unrolled, regular tail recursion), I-Regexp
  (§4.7, refusing `\p \d \w \s \x`), controls (§4.6), closure chains and
  scratch sizing (§10, §12), and the exact program.md layout. Every phase
  charges the compile budget; every limit of §7 (plus leaves, q18) is checked
  prospectively.
  Gates run (all ok, 2026-10-29): `bb compile-test` — 268/268 corpus
  schemas compile on JS and Rust (debug); 31/31 expected refusals with the
  expected code family; 301/301 identical across hosts (words, pool, or
  error fields); 269/269 Programs pass `vm-verify` on both hosts; program.md
  §15 compiles to exactly its 286 words and 14-byte pool on both hosts;
  2 420/2 420 seeded invalid Programs refused; 10 760 random corruptions with
  no crash and identical verdicts across hosts. Fuzz, drift and timings:
  see the next entries as they land.
  Learnt: (1) kin's JS target requires every local name unique per function
  (not per block) and Rust's borrow checker forbids nesting a call that
  takes the arena mutably inside another such call's arguments (read-only
  `IntsR` reads may nest: two-phase borrows) — so every arena reader takes
  `IntsR` and is checked, writers are checked and record a sticky
  ERR_INTERNAL; (2) a corrupt Program's words must never size host memory
  (the gate clamps the mark cap to 2^20 before verifying); (3) container
  leaves made at once and filled from a worklist make recursion through maps,
  arrays, tags and `.cbor` a reference, never a host recursion, and the leaf
  numbering walk is iterative, so no schema can exhaust a host stack.

  *Update 2026-10-29 (later):* `bb compile-fuzz` added (gate 5): seeded
  texts from a random CDDL grammar, a well-formed generator (defined names,
  so lowering is exercised), corpus mutations and hostile shapes, some under
  tiny limits and the bindle/bus profiles; JS must throw only SchemaError,
  the debug Rust build must never panic, no `internal`, JS == Rust (words,
  pool, error fields), vm-verify accepts every Program, < 2 s each. Runs of
  10 000 texts on seeds 1, 2, 3, 11–14, 21, 22, 31–34 pass. It found, and
  the commits fix: INT masks for bignum regions computed against bogus
  bounds; reversed/empty float ranges emitted as invalid intervals; a
  zero-length `.bits` mask; group rules whose definition parsed as a type
  (`g1 = (g)`) failing silently; phases that failed without an error code
  passing as success (now `internal`, and the hosts refuse a Program under 64
  words); a repetition of a zero-position group walked once per copy (a
  million copies). Profiles (§5.3): bindle refuses sockets, `.cborseq`,
  unwrap, explicit cuts, recursive generics (instantiation ancestry) and
  non-text/integer keys; bus adds `.regexp`, unbounded strings, arrays,
  maps and embedded byte strings, any/bare majors, recursion (a cycle in the
  leaf graph) and a 16 KiB text cap; 27 profile cases in `bb compile-test`,
  and every profile-accepted Program is identical to `full`'s except the
  PROFILE word. A disassembler pass over representative Programs found the
  `.cbor`/`.cborseq` content memo collision (the EMBED's content pointed at
  itself in every profile): fixed. Measurements: `bench/COMPILE.md` — warm
  JS 0.19–1.95 ms per study contract, cold first compile 8–19 ms, native Rust
  3.5–4× faster; compiler 35.2 KB min+gzip (30.5 KB brotli), verifier 7.5
  KB. The measurement itself found a host-stack overflow on a 10 000-rule
  alias chain (now an iterative resolver; lowering depth capped at 512),
  uncharged quadratic loops (literal grouping, float merging, typeset
  sorting, interval sorting, literal-entry ordering, key indexes, rule
  ordering: all n log n and charged now) and a pairwise map product that ran
  out of arena on a 4 000-member map (now an n-ary product); a merge-sort
  bug introduced by that rewrite was caught by new normaliser structure
  checks in `bb compile-test`.
- [~] **P3.4 — VM** (type-set evaluation fused with the profile walk, errors,
  budget).

  *Status 2026-10-29 (VM engineer): the D030 buffer driver is complete and
  gated; open: the one compiler lowering below, Phase 4 budget calibration,
  the resumable session driver (D030, later).* Commits `056c0ab`, `100cf27`,
  `41fdc35`, `e278de9` and this entry's. The validator VM is kin in
  `kin/vm-*.kin` (`snug.vm.layout base dead leaf map array eval api`),
  generated into `gen/{js,rust}/snug/vm/`: a bounded recursive walk over a
  contiguous buffer with `vm-validate`, `vm-validate-span` (§16.3
  `validateAt`), `vm-scratch-words` (O(1) from the verified
  `rule.scratch_words`; the chain formula stays as `vm-scratch-words-slow`
  and is cross-checked on every gate Program), `vm-scratch-init`,
  `vm-rule-index` (program.md §13.1). vm-verify is the compiler engineer's
  and is consumed. The live walk (`snug.vm.eval`) is the scanner's walk with
  the schema evaluated alongside — same checks, order, codes, offsets and
  item counts, reusing `snug.cbor.*` with explicit `end` offsets — over
  query lists (epochs/marks, operand-first AND/NOT, major-mask filter),
  every §4.2 leaf kind (INT/FLOAT interval lists over sign+magnitude and
  ordered binary64 keys widened by integer operations, LIT/LITSET by bytes,
  TEXT size + I-Regexp bitset simulation, BYTES size/`.bits`, UINTX, SIMPLE,
  TAG/TAGSET, EMBED sub-validations, ARRAY Glushkov with counters, MAP blocks
  with factors, pools, per-key index, O(1) pool rejection and cuts), the
  witness slot and path stack (§9.2, §9.3), the §14 schedule (D041) and a
  saturating budget, per-call limits that only lower compiled ones. A dead
  item is walked by `snug.vm.dead` (scanner + charges): the profile-only
  continuation of arch §4.5 and the hot path of profile-only decode (D043).
  Hosts: `host/js/src/schema.mjs` (Program copied on load and verified,
  per-isolate scratch lease, `Schema.validate` / `validateAt` / `decode`
  (VM then the trusted builder), async `compile` over the compiler host
  (lazily loaded, R9), `fromProgram`, results `{ok} | {ok:false, reason,
  path, offset[, subcode]}` with paths rendered from KEYS only);
  `host/rust/src/schema.rs` (`Program::new` verifies, `Scratch` owned by the
  caller as `&mut`, `Options`, `validate`, `validate_at`, `Failure`);
  `host/wasm/src/lib.rs` gains `snug_vm_load` / `snug_vm_validate` over
  static buffers (the module with scanner + resumable scanner + VM is 63.8 KB
  at O3; `kin/scripts/wasm-build` now builds `cbor vm` by default). Tools:
  `kin/scripts/vm-asm.mjs` (a Program assembler computing every [D] field —
  it reproduces program.md §15 word for word, pool included),
  `vm-oracle-gen.mjs` (seeded schemas with value samplers), `vm-cases.mjs`
  (hand-reasoned cases), `vm-test` / `vm-test.mjs` (`bb vm-test [mutations]
  [seed] [schemas]`).
  **Gates run 2026-10-29** (`bb vm-test 5000 1 400` unless stated):
  program.md §15 worked executions exact (`[0,0,0,64,6,0,0,0]`,
  `[33,0,0,47,3,1,1,0,1,0]`, the contrast case `type` at `["x"]`) and the
  compiler's §15 Program bit-identical to the document; **profile identity
  12 720/12 720 runs** — every scan-test input (1 146 vectors, 214 fixed
  cases, 5 000 seeded mutations under random options) through the VM against
  `any` AND against a recursive schema that keeps every map, array, tag,
  decimal, ndarray, typed array and embedded document live: the scanner's
  exact code and offset on every refusal (profile errors win, D023) and
  acceptance with its item count otherwise; **conformance 981/983** cases
  from 262 compiled suites (31 refusal suites refused as expected, 2
  phase-later skipped) — the 2 misses are `uint .size n` (below); **oracle
  differential (D022) 3 200/3 200** values on 400 generated schemas (seeds
  2, 3, 4 × 2 000 schemas: 16 000/16 000 each; verdicts ~half true);
  assembled/hand-reasoned 75/75 (witness reasons, paths and offsets incl.
  the A10 key-leak rule, profile errors win, budget exhaustion points,
  limits only lowering, hostile lengths/nesting/regexp/six-way choice,
  `validateAt` spans, embedded roots at D); epochs: 1 542 cases re-run from
  an epoch just below the restart give identical output; **JS == Rust
  (debug, overflow checks on) 16 978/16 978 whole out arrays** (code,
  subcode, offset, budget used, items, path), no panic; **JS == wasm
  16 975/16 975**; JS host rendering == Rust host rendering 1 033/1 033;
  6 000 JS cases re-run behind throwing out-of-bounds traps on P, B, input
  and scratch; 684 Programs pass vm-verify. `bb check`, `bb scan-test 30000
  1`, `bb rscan-test 30000 2` green (earlier in the session; re-run at the
  end, see below).
  **Benchmarks** (`bench/VM.md`, `node bench/vm-bench.mjs`; M1 Pro, Node 24.6,
  shared machine, CPU-time medians): the six study contracts validate in
  0.5–17 µs in snug JS and 0.5–10 µs in snug wasm against 11 µs–1.7 ms in
  the crate's wasm build (11–270× faster in JS); permissive schemas over the
  P1.4 inputs 1.1 µs–48 ms JS, 0.6 µs–19 ms wasm, crate 3.3 µs–162 ms (and
  34 ms vs 6.8 µs on the 1 MiB put with a contract-shaped schema); the
  invalid 1.48 MB six-way choice stops at the 4 M default budget in 75 ms JS
  / 38 ms wasm (the crate: 2.4 s); profile-only decode (VM against `any` +
  builder) is 0.29–0.97× cbor.mjs except the int array (1.38×).
  **For the compiler engineer (found by vm-test, not fixed here):** `uint
  .size n` lowers to `[256^(n−1), 256^n − 1]` (`.size 1` refuses 0); arch
  §4.6 says `uint .size n` = `0..256^n−1` (only `uint .size (lo..hi)` has a
  lower bound) — adversarial `uint .size 1`/`8` with value 0. Resolved on
  your side meanwhile: inline `.cbor`/`.cborseq` control types (`7fac033`)
  and a transient 2-byte `.bits` mask in your working tree. Please confirm
  D040 (the VM consumes `.cborseq` content = the control's array typeset,
  which you already emit).
  Shared-script changes: `kin/scripts/{check,scan-test,rscan-test}` build
  with `SNUG_RS_ONLY="cbor vm compile program hello.rs"` (the committed
  `lib.rs` declares `pub mod compile`; `bin/vm.rs` needs `vm`; absent
  directories are skipped); `wasm-build` defaults to `cbor vm`; `lib.rs`
  gains `pub mod schema;`. Scratch words 37–42 (program.md "reserved") are
  the VM's per-call run state, re-initialised every call; vm-verify uses
  37–38 only at load, so they never overlap in time.
  Learnt: (1) the §15 worked example is a precise spec of the charging
  schedule's ambiguous corners — reproducing its 64/47 units exactly fixed
  six readings (D041); (2) "profile identity" must be tested with a schema
  that keeps everything live, not only `any` (whose children are dead): it
  is the live map/array/tag/embed paths that re-implement the scanner's
  order; (3) program.md §8.4's per-item `.cborseq` query cannot express
  positional arrays — a virtual array item over the sequence reuses the
  format unchanged (D040); (4) an epoch restart test must only move
  VM_EPOCH forward: the contract is monotone, and a harness that sets it
  back makes stale marks look current; (5) a byte string at depth D has no
  frame (and no path slot) for an embedded root, so the guard must come
  before any write at d + 1; (6) per-unit CPU varies 4.5–22 ns in JS
  across event kinds, so the default 4 M budget costs up to ~90 ms in Node on
  map-heavy hostile input — a Phase 4 calibration input (bench/VM.md §3).
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

## Phase 5 — Cursor, views and builder (D026)

- [x] **P5.0 — Review of architecture §16** (independent). *Done 2026-10-29*:
  Codex, 20 findings (3 blockers: byte ownership, literal key ≠ one typeset,
  subtree-validate contract); all accepted; §16 revision 3.
- [ ] **P5.1 — Tape** written by the VM on request; navigation primitives in kin.
- [ ] **P5.2 — Views and cursor** (JS host): checked, indexed, lazy trusted.
- [ ] **P5.3 — Position-aware subtree validation** (lazy `validate()`).
- [ ] **P5.4 — Builder** (kin deterministic core + JS writer); `encode` over it.
- [ ] **P5.5 — Benchmarks** (one field from 1.4 MB; writer vs encode vs cbor.mjs).

## Phase 6 — Sources: blob handles and streams (D027)

- [x] **P6.0 — Review of architecture §17** (independent). *Done 2026-10-29*:
  Codex, 24 findings (3 blockers: unknown-length streams cannot keep the
  check order by suspending; shared scratch corrupts across `await`; checked
  blob views need immutable snapshots); all accepted; §17 revision 3. The
  proposed key-length limit was withdrawn (it changed accepted language vs
  cbor.mjs). P6.1's brief was corrected in flight.
- [x] **P6.1 — Resumable scanner spike** (P1.5 in effect): explicit stack,
  windows, `NEED`/resume; buffer cost vs the recursive scanner (§17.4's 15%
  rule); random-window-split equivalence gate.
  *Done 2026-10-29* (commit `262b7e7`). D029, D030. `kin/rscan.kin`
  (`snug.cbor.rscan`, layout in `docs/scanner.md` "Resumable scanner"):
  known-length sessions, per-session scratch, `NEED` and `YIELD`, never
  splitting what a check reads, a packed key arena for every active map's
  previous key, tag-4/40 facts noted from child heads. Brief corrected in
  flight per the s17 review: no key length limit (and no new code), known
  length only, exclusive session state, deterministic yields, mid-string
  suspension. Gate `bb rscan-test [mutations] [seed]`: every `scan-test` case
  plus 600 key-arena maps (long keys, order/duplicate faults at every level),
  each under whole, 1-byte, random 7/300/4096-byte windows and tiny quanta
  (1–3 units), plus a split at every offset for inputs ≤ 48 bytes; each new
  window starts exactly at the requested offset (nothing earlier is
  available) and is a fresh copy. Run: 30,000 mutations × seeds 2 and 3 —
  ~255,000 policy runs and ~265,000 split-at-every-offset runs each, all
  identical to the recursive scanner (code, offset, items); Rust (debug)
  identical to JS including step counts, no panic; JS behind an
  out-of-bounds trap on 20% of runs. Mutants that break the arena move or
  the region shift turn it red. `host/js/src/sources.mjs` (buffer fast path,
  sync and async in-memory handles, push source with declared length and
  `finalize`) with `host/js/test/sources.test.mjs`: all sources agree with
  the buffer on every vector and a 0.2 MB nested document; async reads are
  pulled one at a time, forward, only on `NEED`; three interleaved async
  sessions with tiny quanta; declared-length mismatch is a `SourceError`, an
  empty chunk is not EOF. `npm test`-equivalent run: 585/585 host tests.
  Benchmark (`bench/SCAN.md`): the resumable walk over one whole buffer costs
  1.15–2.8× the recursive one in JS (3.8× on the tiny vector set), 1.03–1.9×
  in wasm; windows of 64/16/1 KiB cost within a few % of one window. **The
  15% rule fails; recommendation D030.** Learnt: (1) asking for indivisible
  pieces whole from their first byte removes all decoder state from the
  scanner (the host's tail carries it); (2) previous keys are per active map,
  so the arena is a stack of regions; copying them only at suspension keeps
  the whole-buffer path copy-free; (3) a skipped byte string lets the walk's
  position run AHEAD of what a push source has delivered — the source must
  then drop arriving bytes up to it, and a verdict can arrive before the
  last byte (finalize still checks the declared length); (4) a tiny quantum
  must still allow one whole UTF-8 sequence per step or it never progresses;
  (5) the explicit-stack walk's cost is the phase loop and frame fields in
  memory, not the windows — three changes (note hook only under a pair,
  folded next-child phase, cached top-frame fields) took the int array from
  4.2 to ~2.3 ms. A sibling item's uncommitted `kin/compile-arena.kin`
  generated Rust that did not compile, which broke every Rust gate:
  `rust-crate` now takes `SNUG_RS_ONLY` and this item's gates build only
  `snug::cbor` and `snug::hello`.
- [ ] **P6.2 — Blob handle adapters** (JS: object `{size, read}`, `Blob`,
  `fetch` Range, `FileHandle`; Rust trait) with chunk cache and read-ahead.
- [ ] **P6.3 — Stream source** (ReadableStream/AsyncIterable, push `feed`),
  backpressure, fused stream decode.
- [ ] **P6.4 — Benchmarks** §12 items 9–11.

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

### D016 — ~~The VM recurses (bounded); an explicit-stack VM is deferred~~ (superseded by D027)
**Why**: depth is bounded (32 default, 256 max); recursion is faster in JS;
3sln.me receives whole bodies. Resumable chunked input would need the
explicit stack.
- [ ] **Signed off** (owner)

### D017 — Two-pass decode (check, then build); fused single pass deferred
**Why**: nothing is allocated before a message is known valid; no host calls
in the hot loop. Revisit if P2.3 shows the second pass costs more than ~25%.
- [ ] **Signed off** (owner)

### D018 — The JavaScript kin target: integer semantics by operator, named imports, one declaration per name
**Decision**: JS is added to `kin.lang` as a second map in snug's tree
(`snug.js`), with no kin change. Integer meaning is in `snug.lang`'s
operators, not in tags: `+ - *` are plain arithmetic the source guarantees not
to overflow i32; `add32 sub32 mul32` wrap (`| 0`, `Math.imul` / `i32::
wrapping_*`); `quot`/`rem` are `(a / b) | 0` and `(a % b) | 0`; `shl`, `sar`
(arithmetic) and `ushr` (logical, `(a >>> n) | 0` / `cast_unsigned`) are
separate words; `ult` compares u32 patterns; `==` is `===`. Byte and arena
forms (`u8 blen ia iset ilen`) check nothing — the source checks every index
explicitly, and the gates prove it (debug Rust panics, a JS out-of-bounds
trap). Every function is exported (as Rust's are at least `pub(crate)`);
cross-module references are named imports computed from use. A name is
declared once per function (Rust's legal shadowing is a JS SyntaxError).
**Why**: the JS traps (`/` is float division, `*` loses bits past 2^53, `>>>`
is unsigned, `-0` from `%`) are all integer-semantics differences, and a word
per meaning is the only spelling that cannot be misread on either target;
reusing `kin.lang`'s own forms where their non-Rust path is valid JS keeps the
extension small (D005's "no change to kin").
**Alternatives**: unsigned or wrapping TAGS that change what `+` means (rejected:
a form would have to inspect both operands' tags and a mismatch is silent);
checked byte reads (`b[i] ?? 0` / `.get()`) (rejected: slower in both, and
hides a missing bounds check that the gates now catch); namespace imports
`import * as head` (works with kin's default cross-unit spelling, rejected as
less idiomatic; it would also lift the `defdata` limitation in "Found in kin").
- [ ] **Signed off** (owner)

### D019 — The scanner ABI: an Int32Array of options and scratch, negative-code returns, explicit `end`
**Decision**: `scan(bytes, o) → 0 | code` over a 16-word `Int32Array` /
`[i32; 16]` (`scanOptions` fills slots 0–5; 6 error offset, 7 items, 8–10
scratch — frozen by program.md §12); walk functions return a position or a
negated code and take an explicit `end` offset; codes are cbor.mjs's, as
integers, with `codeName`. The error offset is snug's own (cbor.mjs has none)
and is identical on every target. The wasm build exports the same thing over
a static input buffer (no allocator, no imports).
**Why**: kin has no structs, objects or multiple returns, and an integer ABI
is the same in JS, Rust and wasm; returning negative codes keeps the hot path
free of exceptions (V8 throws cost ~9× on refusal-heavy input, P1.4);
explicit `end` lets the VM and the D026 cursor walk embedded documents.
**Alternatives**: a JS options object and string results (no kin spelling);
state in module variables (no Rust equivalent without `static mut`); throwing.
- [ ] **Signed off** (owner)

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

### D026 — One library around an opaque message and a cursor (OWNER DECISION)
**Decision** (owner, 2026-10-29, relayed by the 3sln.me coordinator):
combine the CBOR codec and the CDDL validator in one library, designed around
an opaque, unparsed message and a cursor: zero-copy views, navigate and parse
only what is needed, apply the validation for the cursor's position, skip
unneeded subtrees, or validate fully in one pass when required; compiled CDDL
as a small instruction program; strict-profile checks fused with schema
checks; an encoder writing deterministic output directly from typed values;
a materialising decode for convenience. The 3sln.me profile and vectors are
the conformance floor. "The best CBOR library in the world, if we can do it
without too much hassle."
**How it is folded in**: architecture §16 (checked view, checked + indexed
view with a VM-written tape, lazy trusted view; position-aware validation;
cursor; builder). It confirms D002 and extends it; revision 2's core is
unchanged. Lazy (partial) checking is opt-in and named as not satisfying
profile §5, because untrusted messages must be refused whole before use.
**Why**: owner direction; CBOR's length prefixes and deterministic sorted
keys make lazy navigation cheap, and the received bytes are canonical spans.
- [x] **Decided by the owner** (2026-10-29, via coordinator) — design of §16
  itself is provisional, pending review.

### D027 — Buffers, blob handles and streams through one resumable VM (OWNER DIRECTION)
**Decision** (owner direction 2026-10-29, relayed by the 3sln.me coordinator;
design provisional): the codec/validator works over three sources — an
in-memory buffer, an opaque random-access blob handle (size + sync/async range
reads; object storage via HTTP range requests) and a forward-only stream
(validate as bytes arrive, bounded buffering, resumable, backpressure) — with
the same Program. The VM never does I/O: it suspends with `NEED(offset,
length)` and the host resumes it with a new window (plan/fulfil, as emon
D008). This requires an explicit-stack resumable VM: **D016 is superseded**.
Strings are scanned incrementally; look-back is per active map's previous
key and split scalars. *Amended 2026-10-29 after review (§17 revision 3):* no
key length limit (it would change accepted language vs cbor.mjs); sessions
declare the exact document length (unknown-length streams deferred to the
owner); each live session owns its scratch arena; a `YIELD` quantum bounds
uninterrupted work. D017 is amended: stream decode builds while validating and
releases values only on success. The buffer keeps a monomorphic host fast
path; whether the kin walk also needs a specialised recursive driver is
decided by measurement (≤ 15% overhead → one VM), with a random-window-split
differential gate if two drivers exist. Architecture §17.
**Why**: owner direction; and plan/fulfil keeps async and I/O out of kin, so
JS and Rust stay identical.
**Alternatives**: host callbacks for reads (rejected: async cannot be awaited
from generated synchronous code, and callbacks put the host in the hot loop);
buffering whole messages from handles and streams (rejected: defeats the
purpose).
- [x] **Directed by the owner** (2026-10-29, via coordinator) — the design in
  §17 is provisional, pending review.

### D029 — The resumable scanner: indivisible pieces asked for whole; keys in a per-session arena
**Decision**: a resumable walk never splits what a check reads — a head (with
any float payload), a UTF-8 sequence, a typed-array element, a bignum's first
content byte, a decimal's bignum mantissa — and asks for each whole from its
first byte (`NEED(offset, length)`), so it carries no decoder state. Every
ACTIVE map's previous key stays a window span while the window lasts and is
copied into a packed per-session key arena when the walk suspends or
yields; the arena is a stack of regions in frame order, bounded by
`min(declared length, maxBytes)` bytes. Tag-4/40 element facts are noted from
each child's head. Sessions are known-length; the scratch is exclusive to a
session; yields come after a deterministic work quantum. Layout in
docs/scanner.md (the VM work item reuses it).
**Why**: identical verdicts, offsets and item counts to the recursive
scanner for every split (gated), bounded memory with no new profile code
(the s17 review withdrew the key limit), and a buffer that never copies.
**Alternatives**: carried UTF-8 / element remainder state (more scanner
state, no benefit once the host keeps its tail); a key length limit with a
new code (changed accepted language vs cbor.mjs); eager key copies (costs
the buffer path on every key).
- [ ] **Signed off** (owner)

### D030 — Two drivers: recursive for buffers, resumable for handles and streams (recommendation)
**Decision** (provisional, from P6.1's measurement): §17.4's 15% rule fails
for the scanner — the resumable walk costs 1.15–2.8× the recursive one over a
whole buffer in JS and 1.03–1.9× in wasm — so buffers keep a specialised
recursive driver and handles/streams use the resumable one, both kin,
sharing the leaf checks, held identical by `bb rscan-test`'s split
differential (code, offset, items under every split and quantum).
**Why**: the buffer is the hot path; the resumable path's extra CPU is small
next to the I/O it waits on, and windows themselves cost almost nothing.
**Alternatives**: one resumable walk for everything (simpler, one walk to
review; costs the buffer 15–180% on this evidence); re-take at P3.4, where
per-item VM work is larger and the walk's share smaller.
- [ ] **Signed off** (owner)

### D031 — The prelude is CDDL text in kin; schema rules shadow prelude rules
**Decision**: RFC 8610 Appendix D is a `defdata` byte table in
`kin/compile/prelude.kin` (the text is in its comment), parsed with every
schema after the schema's rules. A schema rule with a prelude name replaces
the prelude rule (no error); duplicate `=` definitions within the schema are
`duplicate_rule`. `#6.2(bstr)` / `#6.3(bstr)` (the prelude's `biguint`,
`bignint`, or any unconstrained byte-string content) lower to INT ranges with
BIGOK, so `integer` is one INT leaf over (−∞, +∞).
**Why**: one prelude by construction on every host (D003); shadowing is the
reading under which existing schemas that define e.g. `text` keep working;
the profile admits only canonical bignums, so tag 2/3 over `bstr` IS the
bignum range and controls like `.lt` apply to it.
**Alternatives**: a host-provided constant (two copies to keep equal);
refusing prelude redefinition.
- [ ] **Signed off** (owner)

### D032 — The decimal-float port is a two-round call, not a kin host form
**Decision**: the lexer rounds hex floats itself (exact, ties to even) and,
for decimal float literals (≤ 17 significant digits, D020), records their
spans and stops with `ERR_NEED_FLOATS`; the host converts each span with
`Number()` / `str::parse::<f64>` and calls again with the bit patterns. kin
refuses ±∞ and a nonzero literal that rounds to zero (`float_literal`).
**Why**: D020's port without a host-linkage form in `snug.targets` /
`snug.project` (another work item's files) or generated code importing host
modules; the hosts already loop for the arena (D033), so one more round costs
nothing and the decision stays in kin.
**Alternatives**: a `@kin:link` port (`:link` on both targets, `:host` scan);
big-integer decimal parsing in kin (rejected by D020).
- [ ] **Signed off** (owner)

### D033 — The compiler works in one host-allocated int arena, grown by retry
**Decision**: the compiler allocates nothing: vectors live in an `Int32Array`
/ `Vec<i32>` arena the host passes; when it is full the compile stops with
`ERR_ARENA` and the host retries from scratch with twice the arena, up to
2^24 words (then `limit_memory`). Every arena access is checked. The result
never depends on the arena size because every limit and the compile budget
are counted, not measured.
**Why**: kin has no allocation forms and both targets need identical
behaviour; one arena reused across compiles (JS: module-level; Rust:
thread-local) keeps warm compiles allocation-free.
**Alternatives**: growable host vectors through new vocabulary forms
(`Vec<i32>` has no `&mut [i32]` spelling in kin calls); fixed per-limit
tables (megabytes for tiny schemas).
- [ ] **Signed off** (owner)

### D034 — Normaliser policies that decide Program bytes
**Decision**: integer literals and ranges are INT leaves (not LIT); an INT
leaf is canonical (BIGOK exactly when an interval reaches a bignum region);
in one typeset all INT leaves merge, FLOAT leaves merge when widths or
intervals agree, ≥ 2 text (or byte) literals become one LITSET, ANY absorbs
the rest; `#0`/`#1`/`#2`/`#3` are INT/INT/BYTES/TEXT leaves; a key typeset
that is one text literal or one major 0/1 integer is a literal key; a map
leaf whose every alternative is unsatisfiable is dropped (with AND/NOT over
it). Leaf numbering (program.md §17 q11) visits a leaf's children in this
order: a map's alternatives' literal entries (factor, pool, alternative,
source order), then each pool's group entries (key, value); an array's
positions; a tag's or embedded document's content; TS_ANY for ANY and bare
`#4/#5/#6`; AND/NOT operands. Typesets are numbered in first-reach order of
that walk with hash-consing by final content; groups and regexps by first
use; interval/float-interval/LITSET runs per leaf in leaf order.
**Why**: program.md fixes the format and the worked example, not these
choices; writing them down makes the bytes reproducible from the text alone
(the worked example's int-as-one-INT policy is the first item).
**Alternatives**: LIT leaves for integer literals; per-occurrence leaves.
- [ ] **Signed off** (owner)

### D035 — Map normal form: where the architecture leaves room
**Decision**: only a literal top-level `//` of a map's group splits it into
map leaves; factor candidates are non-member entries whose altset has ≥ 2
literal-only alternatives; factors are decided in three phases (a key shared
with the residual or another candidate merges; then DISJOINT by §4.3.3 (1);
then all remaining are ABSORB if the residual has one alternative and every
overlapping residual entry absorbs, else all merge, so the ABSORB condition
holds for the final residual); the determinism rule is checked before
entries with max 0 are dropped (adversarial `seeded-001` expects
`map_overlap` for `0*0 tstr => uint`); a keyless type entry in a map is
`map_key`; a literal key the profile cannot carry (bytes, float, bignum) makes
a required member unsatisfiable and an optional one absent; occurrence
counts ≥ 2^24 are unbounded for maxima and unsatisfiable for minima.
**Why**: each is the narrowest reading consistent with §4.3 and the corpus.
**Alternatives**: splitting top-level choices reached through named groups
(changes only witness order and cost); refusing unrepresentable keys.
- [ ] **Signed off** (owner)

### D036 — Arrays: counters, unrolling and regular recursion, precisely
**Decision**: a repetition of ONE entry with min ≥ 2 or 2 ≤ max < ∞ is a
tentative counter; after building, it keeps the counter only if no
predecessor q ≠ p can match a value p can match (conservative typeset
overlap) and p does not follow itself through an enclosing loop; otherwise
it unrolls and the automaton is rebuilt until stable. Group recursion in an
array is allowed only where every step from the recursive reference to the
group's end is the last entry of a sequence under occurrences ≤ 1 (tail
position); anything else is `group_recursion`, as is any group recursion in a
map or an enumeration.
**Why**: §4.4's predecessor condition plus the one case it does not cover
(re-entry through an outer loop would need a counter reset).
- [ ] **Signed off** (owner)

### D037 — Schema errors: names, positions, lexing leniency
**Decision**: errors carry a stable code name (`snug.compile.main
error-name`: syntax, limit_*, undefined_name, duplicate_rule,
type_group_mismatch, generic_arity, nonproductive, group_recursion, unwrap,
enum, range, float_literal, control_target, control_value,
unsupported_control, unknown_control, regexp, map_key,
map_group_occurrence, map_cut, map_overlap, tag, major, profile,
empty_schema), a 1-based line, a 1-based column counted in code points (0, 0
when not about the text), and the innermost schema rule being compiled. The
lexer accepts HT as whitespace and requires the whole text to be
well-formed UTF-8; string literals follow RFC 8610's SCHAR/BCHAR ranges.
**Why**: hosts must report identically (columns in UTF-16 units would make
JS and Rust disagree); HT appears in real schemas and changes no meaning.
- [ ] **Signed off** (owner)

### D038 — Controls the architecture left open
**Decision**: `.det` and `.plus` are refused (`unsupported_control`) until
there is a use; `.cat` concatenates two literals of one kind; `.eq` with a
composite controller (e.g. `[1]`) is an AND, `.ne` with one is refused;
comparisons mixing integer targets and float controllers (or the reverse)
convert exactly for |x| < 2^53 and refuse otherwise; `.bits` masks keep at
least one byte (an all-zero mask still constrains); `.feature` and
`.default` return the target.
**Why**: exact or refused, never a different meaning (R1).
- [ ] **Signed off** (owner)

### D039 — SOURCE_KEY: kin builds the preimage from the effective options
**Decision**: after a successful compile, kin writes program.md §13.3's
preimage (deterministic CBOR: `"snug/program-key"`, 1, the snug version, the
profile, the 17 option values *as the compiler used them* — defaults applied,
clamped to hard maxima, bus's 16 KiB text cap, bignum bytes 128 — and the
schema text as a byte string) into the arena; the host hashes it with
SHA-256 (host/js/src/sha256.mjs, host/rust/src/sha256.rs) into header words
7..14. The snug version (`0.0.0`) is defined once, in kin
(`snug.compile.main/snug-version`). The leaf limit is not in the key (the
frozen list has no slot): a Program that compiled under a lower leaf limit
is identical under a higher one.
**Why**: two spellings of the same options (absent vs explicit default)
must share a cache key, and both hosts must hash identical bytes; the
encoding is kin's, the hash the host's (no SHA-256 in kin, §13.3).
`bb compile-test` recomputes the key with the baseline encoder and
node:crypto.
**Alternatives**: hashing the options as passed (absent ≠ default);
leaving the words zero (§13.2 says the host fills them).
- [ ] **Signed off** (owner)

### D040 — `.cborseq` is matched as a virtual array of the sequence's items (VM engineer; needs the compiler engineer's agreement)
**Decision**: an EMBED leaf with `SEQ` treats its content typeset (the
control type, an array type: the compiler already emits the array's typeset)
as the query of a VIRTUAL array item at physical depth d + 1 (path segment
`EMBED`, rendered `cbor`) whose elements are the sequence's items at d + 2
(segments `INDEX i`, so a path renders `cbor, i` as §9.3's `EMBEDSEQ i`
would; the VM never writes `EMBEDSEQ`). The virtual array is not an item
(not counted, no visit charge); its filter, blocks and elements are charged
as an array's. Inner depth limit for a sequence: min(limit, D − d − 2).
`.cbor` and `.cborseq` leaves on one byte string run as two sub-validations
(so the content is walked twice; nested through such byte strings the factor
compounds per level — bounded by the budget, and only for schemas mixing both
kinds on one byte string). The depth guard is by depth, not content: an empty
sequence in a byte string at depth D − 1 also fails it.
A byte string at a depth with no frame for the embedded root (d + 1 > D, or
d + 2 > D for a sequence) fails its EMBED leaves with inner `cbor/depth`
(program.md §17 q6) instead of writing past the scratch.
**Why**: program.md §8.4 queries each sequence item with the content
typeset, which only expresses `[* T]`; RFC 8610 §3.8.4 matches the sequence
against an array type, so `[? uint, 2*3 uint, tstr]` (adversarial "embedded
sequence with backtracking") needs the array automaton. The virtual array
reuses the existing format: R_{d+1} holds the ARRAY leaf (its frame has the
array block), R_{d+2} its position typesets. No Program byte changes.
**Alternatives**: the compiler lowers `.cborseq [* T]` to content `{T}` and
refuses other arrays (loses RFC cases); a format change giving `.cborseq`
its own automaton reference (unnecessary).
- [ ] **Signed off** (owner)
- [ ] **Agreed** (compiler engineer)

### D041 — The VM's reading of program.md §14 where the table is not exact
**Decision**: (1) a binary-search probe that compares bytes (key table,
LITSET) costs ceil(min(len)/64), at least 1, comparison included — the §15
trace charges a key probe 1; a LIT costs its leaf unit + one such
comparison; (2) interval and float-interval probes cost 1 each, the final
upper-bound check is part of the leaf's unit; (3) "map pair, update: each
live pool" charges every pool of every block alive at the update (§15.4
charges a pool emptied by a cut in the same pair); (4) "map end: + 1 per
alternative and 1 per pool" is the leaf's n_alts + n_pools; (5) stamping a
child charges |Q′| whenever Q′ is non-empty, matched or not (§15.4), and a
fresh epoch is taken even for an empty Q′; (6) AND/NOT cost 2 each, their
stamping pass is covered by the item's filter charge; (7) within an item:
visit, count, head, length / UTF-8 (charged before the scan), filter,
blocks, children, scalar leaves, EMBED, combinators; (8) an EMBED leaf costs
1 when admitted; a live tag's byte-string content (bignum, typed array)
costs 1 visit even when walked dead, a dead walk charges counted items
only; (9) on exhaustion `out[3]` is the whole budget (nothing is deducted
for the charge that failed) and `out[2]` the item being visited when it
failed; hosts agree on that stop point because the schedule is the same
code.
**Why**: §14 is normative but leaves these choices; R6 needs one answer.
The §15 worked executions (64 and 47 units) reproduce exactly under it.
**Alternatives**: charging a key probe 1 + its comparison (contradicts the
§15 trace); counting only live pools after the pair's kills.
- [ ] **Signed off** (owner)

### D042 — Witness details the architecture leaves open
**Decision**: (1) rule 2's "live candidate" is an alive MAP/ARRAY block or
an admitted scalar leaf (ANY, MAJOR, LIT, …) of the container; for a tag
or an embedded byte string, a matched admitted leaf after the child step;
(2) end-of-item records happen only when the item failed overall (after
combinators): rule 4 / rule 5 `missing` when an alive block failed at the
end, else rule 1; (3) leaf failure reasons for containers, used by rule 1
and by AND/NOT: a map leaf that died at a pair `value`/`unexpected`, an
array leaf that died at an element `type` (`unexpected` when it had no
candidate position), either at the end `missing`, a tag whose content
failed `type`; (4) an embedded profile/limit failure (incl. `.cbor`
trailing) sets the slot to its code, the path to the byte string plus
`cbor`, and the inner error offset, overriding inner schema witnesses
(profile errors win inside the sub-validation too); rule 7 then rewrites it
to `embedded` with that subcode.
**Why**: one deterministic answer per input (D024), consistent with §9.2's
rules and the §15 examples.
- [ ] **Signed off** (owner)

### D043 — ANY and bare major types give their children no query
**Decision**: the children of an item matched by ANY or `MAJOR 4/5/6` are
walked dead (profile only) unless another candidate queries them; the
closure still contains TS_ANY for them (it only over-sizes scratch).
**Why**: program.md §8.1/§8.3/§8.4 build child queries from positions,
entries and tag contents only; ANY's answer cannot depend on its children,
and the dead walk makes profile-only decode (the VM against `any`) cost one
unit per item plus scans instead of five.
**Alternatives**: arch §4.1's literal "ANY gives {ANY}" (same verdicts and
witnesses, ~5× the budget per item under `any`).
- [ ] **Signed off** (owner)
---

## Findings

- 2026-10-29 (manager): commit `50b9a7c` was made with `git commit -a` and
  swept up the P1 engineer's uncommitted work (q21 `end` offsets, `IntsR`, the
  JS redeclaration guard, the smaller `read-arg`, gen/ output). Content correct
  and gated; the message is wrong; `d5b74d7` records it. Rule: commit by
  explicit path only, never `-a`, while several agents share the tree.
(Measured facts worth keeping, with dates.)

- 2026-10-29 (P1.4, `bench/SCAN.md`): on the CBOR scanner the kin-generated
  JS runs within 0.94–1.09× of a hand-written JS scanner on real inputs and
  1.18–1.27× on sub-10 µs calls; the same kin source built as wasm is
  1.6–2.1× faster than both on 0.6–1.1 MB item-heavy inputs, 22 µs slower on a
  1 MiB byte string (the copy), and no slower to start.
- 2026-10-29: V8 (Node 24.6) inlines a function only under 460 bytes of
  bytecode (`--max-inlined-bytecode-size`); keeping hot kin helpers under it
  is worth ~25% on item-heavy input. Generated module count matters for cold
  start unbundled (7 modules 3.0 ms vs 1.4 ms bundled).
- 2026-10-29: a Rust wasm module of ~600 lines of scanner is 23.5 KB with std's
  panic and allocator machinery and 6.6 KB (5.2 KB at opt-level "z") with
  `-Zbuild-std`, `panic=immediate-abort` and a static buffer.
- 2026-10-29: cbor.mjs's decode of 9,000 small maps (1.1 MB) takes ~96 ms of
  CPU (defineProperty per member), 16× the scan.

## Found in kin, not ours to fix here

(Bullets: issue — REAL / WRONG / ours — explanation and workaround.)

- `kin.lang`'s call machinery (`declared-call`, `qualifier`, `home-unit`,
  `const-reference`) is private — REAL — so a language added in a project's
  own tree restates ~40 lines of it (`snug.js` `js-call`/`qualify`/
  `const-ref`); kin's Go map lives inside `kin.lang` for exactly this reason.
  Workaround: restated. Suggest a public "register a callable / a name with
  cross-unit linking" helper.
- `kin.lang`'s `defn`, `defconst` (`:generate`) and `defdata` (binding) throw
  for a target outside their `case`, and `const-spellings` knows only
  `:rust :go :java :csharp` — REAL, minor — so a new target replaces
  `defconst` whole (both slots). `defdata` works via `:helpers`.
- A `defdata` accessor used from ANOTHER module hands the target's
  `:cross-unit` an empty name (its `{unit}` prefix is `(qualified "")`) —
  REAL — so a target importing by name cannot import the table. Workaround:
  read a table through a `defn` in its own module.
- A call to a function known only by `declarefn` carries no return tag, so an
  unannotated `let` of it emits `let q:  = …` in Rust — REAL (or by design) —
  annotate (`^I32`).
- An untagged `defconst` emits `pub const X:  = 5;` in Rust rather than being
  refused — REAL, minor — tag every constant.
- `kin.vfs/disk-vfs` lists one directory level, so sources are flat in `kin/`
  (the brief's `kin/cbor/*.kin` was not possible without a custom vfs) — known
  and documented in kin; ours to live with.

## Open questions for the owner

- [ ] **Project controls** (equal-length columns, uniqueness, code-point
  length, decimal value bounds): in snug, or a 3sln.me extension hook? Names?
- [ ] **`\p{…}` in regexps**: worth ~10–20 KB of tables?
- [ ] **Program caching**: a stable serialised Program across snug versions?
- [ ] **Unknown-length streams** (D027, architecture §17.1): drain to EOF and
  keep cbor.mjs's refusal precedence, or accept a documented different
  precedence for unframed streams?

## Parking lot

- Lazy DFA cache over typesets (architecture §4.1).
- Explicit-stack, resumable VM for chunked input (D016).
- Go/Java/C# targets (D006).
- CDDL over JSON.
