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
  *Fixed from the VM engineer's finding:* `uint .size n` is now `0..256^n−1`
  (fits in n bytes, arch §4.6); only a controller written as a range,
  `uint .size (lo..hi)`, means "minimal byte length in lo..hi" (program.md
  §4.2's interval); the distinction is made on the controller's syntax.
  *Then:* `.plus` and `.det` implemented (D038 amended); SOURCE_KEY filled
  by both hosts (D039); pool bytes charged; hosts release an arena grown
  past 16 MiB; an arena exhausted while parsing a regexp was reported as a
  `regexp` error (fixed), which prompted a new gate: **outcomes independent
  of the starting arena size** (all 301 corpus schemas in `bb compile-test`,
  every 8th text in `bb compile-fuzz`). Current gate lines (`bb
  compile-test`, 2026-10-29): 268/268 compile on both hosts; 31/31 expected
  refusals; 301/301 identical across hosts; 270/270 Programs pass
  vm-verify on both; §15 exact on both; 301/301 arena-independent; 55/55
  SOURCE_KEYs equal an independent SHA-256 of the §13.3 preimage; 6/6
  normaliser structure checks; 27/27 profile cases; 2 429/2 429 seeded
  invalid Programs refused; 10 800 random corruptions, no crash, identical
  verdicts. `bb compile-fuzz` 8 000–10 000 texts on seeds 1–3, 11–14,
  21–22, 31–34, 41, 51–52, 61, 71–72: all ok. `bb drift` and `bb check`
  green.
  Container canonicalisation (`d450b56`): structurally equal containers
  (TAG/TAGSET/EMBED/ARRAY/MAP/AND/NOT, recursive ones included) now share
  one leaf through partition refinement to a fixpoint, the representative
  being the first member in leaf-numbering order; final typesets are
  deduplicated after replacement. signaling-message-v1 goes from 2 463 to
  2 427 words; §15 and every other corpus Program are unchanged. Gates were
  re-run after the change: `bb compile-test` all 11 lines ok (same counts
  as above), `compile-fuzz` 10 000 texts on seeds 71 and 1029 ok,
  `bb drift` ok.
  Open: `.plus` refuses floats.
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
  and scratch; 684 Programs pass vm-verify. Final runs (after the last VM
  commit): `bb vm-test 30000 {1,2,3} {2000,1000,1000}` — identity 62 720/
  62 720 per seed, oracle 16 000 + 8 000 + 8 000 agreeing, JS == Rust 79 778
  / 71 778 / 71 778, JS == wasm on every case, conformance 981/983 (the same
  2); `bb check` green; `bb scan-test 30000 1` 31 360/31 360 (JS, Rust,
  wasm); `bb rscan-test 30000 2` 255 481 policy runs identical; `cd host/js
  && node --test test/` 585/585; `bb drift`: every VM file matches its
  source — its one FAIL is the compiler engineer's uncommitted
  `kin/compile/{arena,main}.kin` work in progress.
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
  gains `pub mod schema;`. Scratch words 37–47 (program.md "reserved"; 43–47
  since P3.6: the generic/schedule/free flags and the fast paths' hand-off
  words) are the VM's per-call run state, re-initialised every call;
  vm-verify uses 37–38 only at load, so they never overlap in time.
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

- [~] **P3.6 — VM performance and budget calibration.** (manager, 2026-10-29)
  *Brief*: common-shape fast paths with identical observable results (verdict,
  reason, path, offset, items, budget used) and a gate holding them to the
  generic path; live validation ≤ 2× the scanner on the P1.4 inputs with
  permissive schemas and on the study contracts; `schema.decode` ≤ cbor.mjs on
  the codec set; optionally a revised §14 so units track CPU; a default budget
  keeping the worst budget-bounded input ≤ 50 ms CPU in Node with every valid
  benchmark message fitting.
  *Status 2026-10-29 (VM engineer)*: fast paths, generic tuning, the opt-in
  schedule 2 and the calibration are done and gated (commits `e732153`,
  `452f4d2`, `660bb80` and this entry's); the contracts' 2× target is not
  reachable this way (below); schedule 2 and the new default budget wait for
  the decisions D045/D046.
  Built (D044): `fast-child` (an item queried with exactly one answer leaf,
  no frame or marks; scalar leaves inline, INT over one interval and TEXT
  without a regexp without a call; `any`/bare major on an array or map walks
  the children dead directly); `array-step` and `array-streak` for `[* T]`;
  `map-pair-fast` and `map-streak` for single-block closed structs and pure
  tables `{* K => V}` (the key search probed without charging, then the exact
  units); `dead-int-streak` in the dead walk; generic maps: fused per-block
  loops (charges at one offset with no check between may be reordered) and
  struct-block key-phase/update routines for choices of structs. A streak
  checks an element or pair completely before charging it and stops BEFORE
  anything that would fail, run out of budget or need anything else; merged
  charges never cross an item count (the count is observable — the gate
  caught exactly that). `limits` word 8 (a VM extension beyond program.md
  §12.3's 8 words): bit 0 forces the generic path, bit 1 selects schedule 2.
  `kin/scripts/vm-emit` emits only the flat sources (scanner + VM), so a
  sibling's mid-edit compiler cannot block the VM's gates.
  Gates run (`bb vm-test 5000 {1,2} 400`, all ok): conformance 983/983 (the
  compiler's `.size` fix landed); profile identity 12 720/12 720 per seed;
  oracle 3 200/3 200; assembled 75/75 + 3 600 fast-path stress cases (long
  `[* int]`, `[* range]`, `[* tstr .size]`, structs and tables with bad
  elements, profile mutations, item limits and budgets landing at random
  points); **fast == generic 20 578/20 578** whole out arrays under schedule
  1 and again under schedule 2; schedule 2 changes nothing but the budget used
  on 20 578/20 578; JS == Rust 20 578/20 578 under each schedule; JS == wasm
  20 575/20 575; epochs 1 869/1 869; JS host == Rust host 1 033/1 033. Also
  `bb check`, `bb scan-test 30000 1`, `bb rscan-test 30000 2` (see below).
  Measured (`bench/VM.md` "P3.6"): `{v: [* int]}` 16.0 → 1.1 ms (scanner 1.3
  ms, 0.86×); typed arrays 1.0–1.3×; `{docs: [* {* tstr => any}]}` 42.6 →
  11–12 ms (2.2–2.4×); RPC put `{* tstr => any}` 3.7 → 1.2 µs (1.9×); the
  six-way choice 19.7 → 16.3 ns/unit. Contracts 10–29× the scanner (they were
  11–33×): **not met**, and not meetable with fast paths — their maps are
  choices of several map types and type-set evaluation advances every
  alternative in parallel, so the work is the §14 work itself (a 59-byte
  object-storage request is 253 units) at ~20 ns/unit on the generic path; a
  discriminator-first dispatch or the parked lazy DFA cache would be the next
  step, both larger designs. Mixed literal + wildcard maps also stay generic
  (8.9× on the 1 MiB put, 5.9 µs absolute). `schema.decode` ≤ cbor.mjs on
  every integer, map, struct and document workload (0.25–0.9×); the 1 MiB
  `Float64Array` (1.0–1.4×) and some runs of the 1 MiB put are decided by
  the builder's copy, not the VM.
  Calibration (`bench/vm-calib.mjs`, 19 event kinds incl. the worst shapes
  found: 20-way and mixed map choices, absorb factors, AND per element, wide
  automata, regexps, LITSETs): worst large-input rate ~22 ns/unit (schedule
  1) / ~21 ns/unit (schedule 2), both generic choice-of-maps work; fast shapes
  0.7–5 ns/unit under schedule 1. **Plainly: under §14 as it is, a budget
  bounding the worst case at 50 ms (~2.2–2.3 M) refuses valid 1.5 MB integer
  arrays (3.6 M units), 1.1 MB nested maps (2.5 M) and 0.95 MB of small maps
  (4.45 M), which validate in 3–31 ms; today's 4 M default still refuses the
  last and lets the worst input cost ~80–90 ms.** Under schedule 2 every
  valid benchmark message needs ≤ 1.45 M units; proposal: schedule 2 with a
  2.3 M default (D045, D046).
  Learnt: (1) the only safe way to make a fast path is to make it a different
  *implementation* of the same charges, with a switch to run the other one on
  every gate case — every bug the gate found was in charging order or state
  (items counted across a merged charge, a sentinel colliding with a real
  major type), none in verdicts; (2) once the fast paths run, the schedule,
  not the VM, decides what fits: units must be calibrated against the code
  that runs, which is why schedule 2 charges by shape; (3) the worst-case
  ns/unit is set by the generic choice-of-maps path (~20 ns), the floor by
  the dead walk (~5–13 ns/item), so the budget/CPU ratio cannot be tighter
  than those two without a faster generic path.
  *Follow-up 2026-10-29 (VM engineer)*: the manager accepted D045 and D046
  (provisional; owner sign-off pending) and the contracts' 10–29× as is for
  now (discriminator-first dispatch / lazy DFA → parking lot, with the
  analysis above). Schedule 2 is now the default: `limits` word 8 bit 1
  selects the legacy schedule 1 instead (kept: one flag test, shared code,
  and the gate's comparison arm). program.md §14 gains the three schedule-2
  rules; §15.3 re-derived (64 → 55 units: the one `[* tstr]` element's
  bookkeeping, filter and leaf units; §15.4 unchanged at 47); the compiled
  default `LIM_BUDGET` is 2 300 000 (`kin/compile/main.kin` option 17,
  §15.2 word 37, architecture §7's limits table and text). No other Program
  word changes. The hostile six-way case compiles with a 4 M budget (its
  valid 0.31 MB input needs ~3 M units — a refusal D046 records) and gains
  a case asserting that refusal at the 2.3 M default; the `[* int]` budget
  sweep uses 2 000 instead of 5 000 (1 000 ints cost 2 008 units now).
  Gates run: `bb vm-test` (all ok: §15 55/47, fast == generic 50 579/50 579,
  schedule 1 fast == generic and budget-only, JS == Rust under both, JS ==
  wasm, hosts, epochs, traps), `bb compile-test`, `bb compile-fuzz`,
  `bb check`, `bb scan-test`, `bb rscan-test`, host tests 585/585, `bb
  drift` after the commit. `node bench/vm-calib.mjs` at the new defaults:
  worst 23.6 ns/unit this run (contract object-storage request, generic
  choice; ~54 ms at 2.3 M — within the run-to-run spread of the 21–22 ns
  measured before on this shared machine, recorded as is); every valid
  benchmark message fits (largest 1 450 008 units).

## Phase 4 — Differential, fuzz, benchmarks

- [x] **P4.1 — Differential vs the `cddl` crate (native)** on its correct subset.
  *Done 2026-10-29; no commit requested or made.* Added
  `corpus/tools/crate-diff.mjs`, the single `bb crate-diff` task entry, and
  [the findings with reduced reproductions](corpus/conformance/crate-diff-findings.md).
  No validator sources were changed by this item.

  **Actual final run:** `bb crate-diff` (native `cddl` 0.10.7, Node v24.6.0,
  seed `0x5eed8610`, 2,000 ms timeout and SIGKILL per fresh native process).
  All 295 corpus suites were offered to snug's compiler, including later-phase
  annotations: 264 suites / **987 cases compiled**; 31 expected refusal suites /
  136 cases were recorded as skipped. Added **6,000 generated cases** on 2,000
  varied schemas: 375 cases each for structs, open maps, tables, array
  occurrences, nested generics, type choices, ranges, text size, byte size,
  bits, typed arrays/tags, tag 40, integer/biguint bignums, decfrac, literals,
  recursion. Generation follows the requested crate subset exclusions and
  includes constructive matches, near misses and arbitrary profile values.

  **6,987 cases attempted; 6,915 Boolean comparisons; 6,613 agreements;
  302 disagreements in 26 verdict classes.** Separately: **70 native schema
  errors in five classes; two crate panics in one class; zero timeouts.**
  Study: 198 compared / 183 agree / 15 disagree, plus three schema errors.
  Adversarial: 717 / 584 / 133, plus 67 schema errors and two panics.
  Generated: 6,000 / 5,846 / 154, no schema errors, panics or timeouts.

  **All 32 classes are crate defects or documented crate limitations;
  snug bugs: 0; incorrect corpus expectations: 0; unclassified: 0.**
  Verdict-class counts: optional map groups 60; map-choice coverage 4;
  regexp anchoring 13; map unwrap 2; prelude bignums 5; prelude tagged-value
  dispatch 17; float widths 9; member/rule-name collision 2; repeated map
  choices 2; non-cut fall-through 1; array occurrences 6; composite `.ne`
  targets 5; socket group extensions 2; byte-literal/text confusion 1;
  variable tag constraint ignored 1; bare major 6 refused 1; undefined group
  socket 1; named group extensions 2; prelude signedness 2; uint size range 5;
  zero/empty `.bits` 44; high `.bits` 1; bignum comparison 2; nested control
  target lost 1; embedded trailing CBOR ignored 1; nested generic scope 112.
  Schema-error classes: `.cborseq` 9; native integer literal limits 48;
  base64 byte literal 5; escaped byte literal 3; hex subnormal literal 5.
  Panic class: byte literal with byte-string input 2 (`cbor.rs:4957:29`).

  **Checks actually run:** `bb crate-diff` completed with exit 0, source
  fingerprint unchanged during the run; all 6,987 snug verdicts rechecked
  against `corpus/tools/oracle.mjs` (four `.cat`/`.plus` cases use explicit
  RFC 9165 literal folds because the interpreter predates those controls),
  zero unknowns; baseline decode/re-encode identity on every input;
  33 reduced witnesses run through all three implementations; two independent
  6,000-case generations had identical schemas, bytes and all three verdicts;
  `node --check corpus/tools/crate-diff.mjs`; `node --test corpus/tools/` —
  **301 passed, zero failures/skips**. Babashka printed a sandbox
  ProcessHandle/process-tree cleanup exception after its successful run;
  the harness itself completed successfully. Detailed evidence, binary/source
  hashes and skipped-suite codes are under `.cache/p41/`; durable counts,
  minimal reproductions and RFC arguments are in the findings file.

  **Learnt:** native CLI validation refusal exits **zero**; verdicts require
  explicit success/failure messages and an assertion of the selected first
  rule. The intended correct subset still contains two crate defects:
  **112 nested-generic scope failures and 42 zero-bits failures** in generation.
  They were retained and classified, not silently excluded. Native 64-bit
  literals remove the wasm32-only ceiling but not all native literal limits.
  Other work changed the shared tree between exploratory runs; the final
  unchanged-source run above is authoritative, and unrelated changes were
  left untouched. No timing benchmark or Rust-host identity claim is made.

  **D044 — Keep discovered crate defects as classified differential evidence.**
  **Decision:** retain every generated case and every snug-compiled corpus
  case; separate Boolean disagreements from native parse errors, panics and
  timeouts. Fail the harness for an unclassified result, an unknown independent
  verdict, a changed source set, a snug bug or a corpus bug.
  **Why:** deleting newly failing cases would overstate the oracle's correct
  subset; treating a native crash or parse failure as `false` invents a verdict.
  **Alternatives:** silently filter defects, trust process exit status, or
  abort on the first known crate defect (all lose useful evidence).
  - [ ] **Signed off** (owner)
- [x] **P4.2 — Fuzz** (schemas, values, mutated bytes; hosts agree; no crash;
  budget respected). *Done 2026-11-03; D115–D118.* `tools/proptest/`
  (`campaign.mjs`, `props.mjs`, `gen.mjs`, `shrink.mjs`, `worker.mjs`,
  `gates.mjs`) and one `bb proptest` task; findings, minimised witnesses and
  the hand triage in `tools/proptest/findings/` (`summary.json`,
  `P<n>-<class>-<k>.json`, `triage.json`). No kin, gen or host code changed.

  **Properties.** (1) schema × value: schemas from a new typed generator
  (maps with optional groups, group choices, wildcards, cuts, bounded
  wildcard counts, named groups, unwraps; arrays with occurrences and fixed
  counters; controls, tags incl. typed arrays/decfrac/ndarray, embedded
  CBOR, generics, recursion, regexps incl. `\p{…}` with `snug/unicode`),
  vm-oracle-gen's D022 shapes, conformance-corpus schemas and compile-fuzz's
  grammar; values constructive / near-miss / random; checks: verdict ==
  corpus/tools/oracle.mjs when it answers (D116), `cbor/<cbor.mjs code>` on
  bytes cbor.mjs refuses (D023), `\p` shapes == a JS `u` RegExp, validate ok
  ⇔ schema.decode succeeds (same value, same witness), validateAt(span) ==
  validate(slice) with shifted offsets (and the oracle on the slice),
  budget units ≤ budget and an unexhausted budgeted run == the full run,
  tables change no Program word outside the source key, and the committed
  resumable session (P6.2: validateHandleSync and pushValidator under random
  chunks and quanta) == Schema.validate. (2) codec: encode == Writer typed
  calls (given/sorted/shuffled) == Writer.value == cbor.mjs; decode(encode(v))
  == normalise(v) (D118) == cbor.mjs's decode, re-encodes identically
  (null and plain objects); 10 byte/structural mutations per value
  (non-shortest heads, swapped/duplicated entries, indefinite lengths, tag
  wraps, counts ±1, float widening, bad UTF-8, trailing, specials, nesting)
  refused with cbor.mjs's code or re-encoded identically; scanBuffer, view
  and an `any` schema agree. (3) views: four modes (owned/borrowed ×
  directories) walk to decode(), get/at/entries/find/cursor agree, offsets
  identical across modes, every subtree's raw span builds to its value(),
  schema-checked opening ⇔ validate, View.validateAt == validating the raw
  span. (4) serialised Programs: round trip identical (words, pool, key,
  rules, bytes, verdicts, decode); every container corruption refused with
  ProgramError; rehashed corruptions accepted by vm-verify validate,
  validateAt and budget without throwing; random files refused.
  (5) robustness: random/mutated bytes through decode, view, scanBuffer,
  scanHandleSync, pushScanner, schema validate/decode and sessions throw only
  documented errors and agree; random CDDL (compile-fuzz grammar plus new
  hostile `\p` texts) only SchemaError, never `internal`, compiled Programs
  pass Program/vm-verify; 33 API misuses throw only TypeError/RangeError/
  SnugFault/ProgramError/SchemaError/SourceError; a worker watchdog (30 s per
  case) for hangs; compile/validate > 2 s flagged. (6) the gates with seeds
  1001+ and 10× counts in the same snapshot.

  **Run** (authoritative): `bb proptest --minutes=65 --timeout=30000
  --gate-scale=10`, git archive of HEAD `2434b06` (D115), Apple M1 Pro
  (10 cores), macOS, Node v24.6.0; **66.9 min wall**; the machine was shared
  (load average 14–54, other agents' builds). Cases: **P1 369,404** (320,059
  compiled, 2,960,691 values, 8,682,199 oracle verdicts, 17 unknown,
  6,803,088 spans, 1,185,433 session runs, 258,448 `\p` evaluations, 815,935
  budget checks); **P2 1,236,143** (12,361,430 mutations, 3,999,807
  structural, 1,891,707 accepted); **P3 186,127** (40,768,160 view nodes,
  2,565,982 subtrees); **P4 186,473** (2,442,062 corruptions, 2,442,062
  rehashed of which 444,393 passed vm-verify, 523,299 random files);
  **P5 153,623** (921,738 byte inputs, 307,246 texts, 1,381,807 session runs,
  5,069,559 misuse calls). No hang, no worker crash. Gates: scan-test
  300000/1001 and /1002, rscan-test 200000/1001 and /1002, vm-test
  200000/1001/4000, nav-test 6000/1001, write-test 30000/1001, compile-test
  400/1001, unicode-test: all ok; compile-fuzz 30000/1001 and vmsession-test
  see below.

  **Failures by class** (counts; `findings/triage.json`):
  * **snug bug S1** — P5/source-verdict 384, P5/session-verdict 1,835,
    P1/session-verdict 49: `pushScanner` / `pushValidator` (host/js
    sources.mjs `pushSession`) under a nonzero quantum threw
    `SourceError('length_mismatch')` when the last step was a yield at the
    declared end, instead of the CBOR refusal every other driver gives.
    Minimal: `pushScanner(3, {top:'any'}, {quantum:1})` fed `821818` (or
    the campaign's minimisation `828100`); `pushValidator` on `r = any`,
    bytes `a16100`, quantum 2 → SourceError, where Schema.validate and
    validateHandleSync answer `cbor/truncated` at offset 3. Fixed meanwhile by
    the session engineer in `654cdf8` (not by P4.2); at `3551d7a` the minimal
    cases agree and a 15-min confirmation campaign (seeds 2000001+, P1 53,115,
    P2 79,280, P3 27,552, P4 24,336, P5 23,711 cases) found no session or
    source disagreement.
  * **generator (gate harness) bug** — `kin/scripts/write-test.mjs`
    `compare()` trims only the last Rust line (`stdout.trimEnd()`), so when
    the last of N cases prints an empty final field the gate reports
    N−1/N identical; seen in a trial run at seeds 1005 (close-map), 1009
    (put-head), 1011 (robustness), 3000 cases each. Not a host difference;
    a fix is one line in a file outside P4.2's write set.
  * **environment** — P5/slow-compile 249 (+83 in the confirmation run) and
    compile-fuzz 30000/1001's two 2,078/2,280 ms texts: wall time above the
    2 s criterion only under load. Unloaded on the same HEAD: the
    a_i = [a_{i+1}, a_{i+1}] chain of 400 rules 319–426 ms (1,572,297 compile
    units), `[\p{L}\p{N}]` × 80 376–378 ms (4,778,582 units), `\p{L}` × 80
    335 ms; every one compiled inside the default compile budget. The
    vmsession-test run was killed by another agent's `pkill` (SIGTERM, empty
    log) and is not counted; GATE_RERUN.
  * **harness bugs found and fixed while building** (not snug): an unbounded
    structural reader on mutated bytes (worker OOM), ANY-schema comparisons
    without the codec's map root, a COSE subtree built without `cose`, and
    the exponential oracle taking ~5 s on hostile texts (a false hang; D116).
  * **oracle bugs: 0; oracle mismatches: 0** in 8.7 M verdicts;
    documented differences: none needed beyond D118's normalisation.

  **Snug bugs: 1 (S1), already fixed upstream by `654cdf8`.**

  *Checks actually run*: the 66.9-min campaign above; the 15-min
  confirmation campaign at `3551d7a`; standalone gate re-runs at `3551d7a`
  (GATE_RERUN_LIST); `node --check` on every tools/proptest module.
  `npm test` was not run: P4.2 changes no SDK/core/host code. *Learnt*: the
  shared checkout changes under a long run (HEAD moved eight commits during
  P4.2 and an uncommitted encoder change briefly made `encode` throw), so a
  campaign has to pin a snapshot; per-case timeouts need a separate thread
  (a worker plus a shared heartbeat) because the code under test is
  synchronous; the oracle is fast enough for 8.7 M verdicts once hostile
  texts are kept from it; a `\p` class costs ~58 k compile units per
  regexp position against ~80 for an ASCII class (tables probed per class),
  inside the budget but ~730× more compile work.
- [ ] **P4.3 — Benchmarks** (architecture §12) and the 3sln.me recommendation.

## Phase 5 — Cursor, views and builder (D026)

- [x] **P5.0 — Review of architecture §16** (independent). *Done 2026-10-29*:
  Codex, 20 findings (3 blockers: byte ownership, literal key ≠ one typeset,
  subtree-validate contract); all accepted; §16 revision 3.
- [~] **P5.1 — Tape** written by the VM on request; navigation primitives in kin.

  *Status 2026-10-29 (compiler engineer, first slice per §16.4 rev. 3): the
  navigation primitives are done; the tape is not built (§16.4: its
  addressing and sizing are unspecified, and on-demand directories are the
  measured alternative, bench/VIEW.md).* `kin/nav/walk.kin` (`snug.nav.walk`):
  `nav-head` (major, ai, argument hi:lo, content start; bounds-checked),
  `nav-skip`/`nav-skip-n` (structural skip with an owed-items counter, no
  recursion, every head one charged step, NAV_BAD when owed items exceed the
  bytes left), `nav-length`, `nav-child` (sequential), `compare-key`,
  `nav-find` (linear, early exit on the proved key order), `nav-dir` (one
  word per child) and `nav-dir-find` (binary search). `kin/nav/trace.kin`
  is the cross-host trace. Generated into `gen/{js,rust}/snug/nav/`;
  `kin/scripts/nav-emit` / `nav-crate` keep these gates independent of other
  sources' mid-edit state (D055). D050.
- [~] **P5.2 — Views and cursor** (JS host): checked, indexed, lazy trusted.

  *Status 2026-10-29 (compiler engineer): first slice done (checked views,
  owned/borrowed, optional directories, cursor, accessors, value(),
  validateAt); the trusted opener (§16.2) and the Writer (§16.5) are not
  started.* `host/js/src/view.mjs`: `view(bytes, {schema, rule, borrow,
  directories, ...decodeOptions})` runs the full check (scanner, or the
  schema VM through `host/js/src/schema.mjs`) on the private copy (default)
  or the borrowed buffer, refuses SharedArrayBuffer, and returns a `View`
  (`kind`, `length`, `get`, `at`, `entries`/`keys`/`values`, `number`,
  `bigint`, `int`, `text`, `bool`, `isNull`, `bytes`, `copyBytes`,
  `typedView`, `typed`, `decimal`, `ndarray`, `raw`, `value`, `cursor`,
  `validateAt`); `Cursor` (`enter`, `next`, `up`, `find`, `key`, `keyIs`,
  `kind`, scalar accessors). Minimal Rust view: `host/rust/nav/view.rs`
  (borrowed only; open = scan; `get`, `at`, `raw`, `uint`, `text`). D051–D054.
  Gates (2026-10-29): `bb nav-test`: 1009/1009 traces identical across
  hosts; 250/250 traces agree with an independent structural reading;
  5 000 unchecked inputs, JS threw 0, Rust panicked 0, 5000/5000 identical;
  654/654 Rust View key paths answer the JS view's span.
  `host/js/test/view.test.mjs` (84 tests, in `npm test`):
  every profile accept vector and every Bindle-accepted oracle value walked
  in full through accessors only, four modes (owned/borrowed × directories),
  equal to build(); 400 seeded random documents, every subtree's raw span
  decodes to its value(); directory lookups equal linear; cose labels;
  1 500 mutations refused with decode()'s code in every mode; ownership;
  exact integer accessors; validateAt equal to validating the copied span
  standalone (reason, path, offset shifted by the span start) over 300
  schema documents; per-walk step budget. Measurements (bench/VIEW.md, M1
  Pro, Node 24.6, loaded machine): open + one field beats decode() + field
  2.5–2.7× on the 1.1 MB map-heavy body and 110× on the 1 MiB bstr put
  (borrowed; owned pays ~0.17 ms/MB for the copy); a field again costs
  0.2–0.5 µs, but linear lookup deep in large containers costs ms, 0.07–0.5 µs
  with directories; Cursor walks beat decode() + walk except on the
  120 000-int array (1.5× slower); a borrowed view retains ~0.5 KB. View
  module 10.5 KB min / 4.0 KB gzip alone, 26 KB / 9.5 KB bundled with scan
  and build.
- [ ] **P5.3 — Position-aware subtree validation** (lazy `validate()`).
- [~] **P5.4 — Builder** (kin deterministic core + JS writer); `encode` over it.

  *Status 2026-10-29 (writer engineer): built and gated; `[~]` until the
  owner disposes of D070–D074 (the D004 refinement in particular).*
  Commits `200fba1` (vocabulary), `4b9365d` (primitives, Writer, gates),
  `418e219` (encode over the Writer, sort-keys, bench).
  **kin** (`kin/write/*.kin`, `snug.write.*`, D074): `put-head` (shortest
  head from a 64-bit hi:lo), `float-width`/`put-float` (binary64 bits →
  refusal or the shortest exact f16/f32/f64, the inverse of
  `snug.cbor.float`), `put-int`/`int-len` (sign + magnitude bytes → major 0/1
  or tag 2/3 with 9..128 minimal bytes, else `bignum`), `compare-in`/
  `key-after` (encoded-key order), `close-map` (one map's complete pair
  ranges: n − 1 comparisons and no copy when already sorted, else a stable
  bottom-up merge sort of pair indices, duplicates refused where met, then a
  permutation through a scratch area) and `sort-keys` (orders keys before
  their values exist). Every write checks capacity first and answers
  `-(WR_NEED + need)` instead of overflowing; comparisons are charged
  against a budget (D070, D073). `snug.lang` gained `BytesW`, `bset`,
  `bcopy` (additive). **JS** `host/js/src/writer.mjs`: `new Writer({cose,
  keysSorted, omitUndefined, limits})`; `uint`, `int`, `bigint`, `float`,
  `bool`, `null`, `text`, `bytes`, `typed`, `decimal`, `ndarray`, `value`
  (any host value, encode's rules), `beginArray(n)`, `beginMap(n)`,
  `key(k)`, `end()`, `finish()`, `failure` (D071). `encode(value, opts)` is
  now `new Writer(opts).value(value).finish()` (D072); the Phase 2 encoder is
  frozen at `bench/baseline/encode-p2.mjs` as baseline and test oracle.
  **Rust**: the same primitives (`gen/rust/snug/write`) and a minimal Writer
  (`host/rust/write/writer.rs`: integers as magnitude bytes, float bits,
  text, bytes, bool, null, arrays, text-key maps, keysSorted) for the parity
  gate.
  **Gates run 2026-10-29** (all green): `bb write-test` (3000 seeded cases
  per arm, seed 1): put-head 3000/3000 JS == Rust, 2020/2020 written heads
  equal an independent BigInt encoding; floats 5213/5213 JS == Rust (every
  f16/f32 exponent, f64/f32/f16 subnormals and edges, ±0, NaN payloads, ±∞,
  random bits), 3999/3999 written floats equal cbor.mjs's encoding and pass
  the scanner, 447/447 refusals are numbers cbor.mjs writes as integers or
  refuses; put-int 3000/3000, 2615/2615 equal cbor.mjs, 206/206 bignum
  refusals; key-after 1500/1500; close-map 3000/3000 JS == Rust, 1532/1532
  sorted maps equal an independent sort, 1003/1003 duplicate answers
  justified, comparisons within n − 1 + n⌈log₂ n⌉; sort-keys 3000/3000,
  2545/2545 orders equal an independent stable sort; Writer streams
  4500/4500 identical across hosts (3000 values with shuffled keys + 1500
  misuse/keysSorted streams), 3000/3000 equal cbor.mjs's encode;
  robustness 3000/3000 junk-argument calls identical, 0 Rust panics, 0 JS
  throws. `node --test test/writer.test.mjs` 9/9: every accepted vector
  (389) re-encodes byte for byte through value() and typed calls with keys
  given, sorted and shuffled; 3000 seeded values: Writer (4 ways) == P2
  encoder == cbor.mjs, every output passes decode() (the generated scanner)
  and round-trips build(); 200 wide/nested shuffled maps; 30 refusal cases
  with encode's codes and no payload in messages; 24 limit cases equal to
  the P2 encoder and cbor.mjs; grammar misuse (17 cases: too many/few,
  value without key, key without value, key outside a map, end() mismatch,
  two roots, finish early, bad counts) throws and every later call throws
  `writer_failed`. `npm test` 585/585 with encode over the Writer;
  view/sources tests 99/99 together with writer's; `bb nav-test` green;
  `bb drift` green (run in a clean worktree of `418e219`). Mutants (gen JS
  edited, restored): no permutation, head boundary 24→25, f32-subnormal
  shift each turn the writer tests red (the last only after adding
  subnormal cases); f16 exponent 15→16 is equivalent (those values are
  integers, refused first).
  **Measured** (bench/WRITER.md, M1 Pro, Node 24.6, loaded): encode over
  the Writer is not slower than the P2 encoder anywhere (CPU-time A/B
  within 1 % on integers and typed arrays) and 1.2–1.7× faster on map-heavy
  bodies; typed calls with keys in order 3.4–6× the P2 encoder on maps,
  the document and integers; typed calls with shuffled keys move values (2×
  on the 1 MiB bstr put). Bundle: writer 7.1 KB min+gzip vs the P2
  encoder's 4.2 KB.
  **Learnt**: ordering keys before writing values (an object walk knows its
  keys) beats both a JS comparator over tuples and a byte permutation after
  the fact; the permutation is for streamed typed calls only. The
  dense-array check (`Reflect.ownKeys`, 120 000 index strings) dominates
  encoding a 120 000-integer array in both encoders (~10 ms; typed calls
  writing the same heads take 1.7 ms). Open: the +3 KB against R9; the comparison budget
  is not exposed as a limit (hosts pass 2³¹ − 1); the grammar lives in each
  host, not kin (review V17 asked for a portable grammar in kin; the brief
  kept it host-side, D071); the Rust Writer has no typed arrays, decimals,
  ndarrays, cose labels or value walk; `maxBytes` is checked at finish, as
  the P2 encoder did, so growth is not capped before it; `test/index.js`
  (npm test) does not import writer.test.mjs (not this item's file).
  #### D112 — Encoder performance follow-up (2026-11-03)
  **Decision**: keep all kin byte decisions and the existing array own-key
  check; optimize host bulk allocation/copying and native float-array NaN
  scanning. Finish may hand off exact-size private storage, with independent
  output ownership and the same sticky grammar. Big-endian typed payloads
  swap straight into output; Float16Bytes remains little-endian.
  **Why**: `node --cpu-prof` identifies array reflection, the JS NaN loop,
  buffer growth and final copying. Matched-history, alternating thread CPU
  medians on the shared M1 Pro/macOS 14.6.1/Node 24.6 machine: 1 MiB bstr put
  **1.218643 → 0.783683 ms (1.56×)**; mixed 1 MiB typed arrays
  **2.685833 → 1.543222 ms (1.74×)**. Integers remain
  **22.532500 → 22.307000 ms**; maps, document, text and CWT are near parity.
  Load 11.67 → 9.82 in that paired run, up to 35 during the session.
  `bench/WRITER.md` records profiles, method, both requested benchmark
  scripts' before/after CPU medians, and the full comparison-workload table.
  `npm --prefix host/js test`: **1,048 passed, 0 failed**; benchmark answer
  checks and `git diff --check` passed. Focused tests include forced
  big-endian output, byte-offset views, Float16Bytes, ownership and refusals.
  **Alternatives**: for-in/index checks miss hidden own properties;
  own names plus symbols still allocates all indices (7.98 vs 8.12 ms for
  Reflect.ownKeys). Therefore the requested non-allocating, behavior-identical
  array replacement remains unresolved. Tightening the old count check
  would also change refusal precedence for holes compensated by extra keys.
  Output-buffer transfer was discarded after an experimental regression;
  exact-size ownership handoff avoids detaching buffers. No kin changes.
  **Learnt**: fixture construction warms the current encoder, including
  10k separate messages. Giving the saved encoder the same complete type
  history removes misleading structured-workload regressions. CPU time
  still varies with core placement/frequency under load; use alternating
  measurements, not ratios between the unpaired runs.
  - [ ] **Signed off** (owner)

- [ ] **P5.5 — Benchmarks** (one field from 1.4 MB; writer vs encode vs cbor.mjs).

## Phase 6 — Sources: blob handles and streams (D027)

- [x] **P6.2 — Resumable session VM** (D027, architecture §17 rev 3, D029/D030).
  *Done 2026-11-03* (session-VM engineer; commits `d034d68`, `0d9d86e`,
  `3ed4739`, `4e8939d`, `654cdf8`, `3551d7a`, on the shared refactors of
  `d63868d`). D090–D095. The interrupted draft (`wip/vm-session.kin.wip`) was
  read and **restarted from**, keeping its frame machinery for arrays, maps,
  tag notes and embed runs but not its core: it evaluated in-window items
  speculatively with `end` cut to the window and rolled back on `truncated`,
  which is not exact (D091), re-read string content for every leaf, and asked
  for whole map keys in the window. `wip/` is removed.
  Built: `kin/vm-session{,-base,-str,-cont}.kin` (`snug.vm.session`, `sbase`,
  `sstr`, `scont`; ~2,600 lines; gen/ committed). A session runs one message of
  a declared length over windows: `vms-step` answers the verdict (out exactly
  as vm-validate's), `VMS_NEED(offset, length)` or `VMS_YIELD`. Items the
  window holds whole (structural prescan, once per step over the pending item
  and its siblings, recording the crossing chain) go to `eval-item` /
  `dead-item` themselves; crossing items get frames running the generic path
  with the shared block, query, witness, charging and leaf functions, the
  buffer walk's streaks with `end` cut to the cut, and inline evaluation of
  known-fitting children (D091). Heads never split; bounded pieces asked whole
  (D090); text content in one pass with UTF-8 and every regexp advancing per
  code point and the leaf charges dry-run then charged as one sum (D094);
  `.bits` from the pass; EMBED as a nested document on the frame stack with
  inner refusals caught; content read twice replayed with a `vms-keep` pin;
  crossing map keys copied into the per-session key arena, the copy then the
  previous key (D092); tag-4/40 notes from element heads; witness, path,
  profile-only continuation in the session's own scratch; budget charges
  identical for every split and quantum (gated). Hosts: JS `Schema.session` /
  `VmSession` (own scratch, session array and arena per session, no concurrent
  resume) and `sources.mjs` `validateHandle`, `validateHandleSync`,
  `pushValidator` over the scanner's drivers (made generic); Rust
  `schema::Session`, `trait Blob`, `validate_blob` (minimal, sync).
  **Gate** `bb vmsession-test [mutations] [seed] [schemas] [stress]`: every
  vm-test case (its case building moved to `kin/scripts/vm-allcases.mjs`; the
  3 `validateAt` span cases are not sessions) and a session stress set
  (`kin/scripts/vmsession-cases.mjs`: long keys at several levels, LITSET and
  regexp key typesets, multi-regexp long texts, LIT/LITSET on long strings,
  `.bits`+`.cbor`, `.cbor`+`.cborseq`, nested `.cbor`, float typed arrays with
  tails, ndarrays, decimals with bignum mantissas, cose keys; valid and broken)
  under whole windows, 1-byte windows, random 1..7 (with quanta 1–3) / 1..300 /
  1..4096-byte windows, whole windows under quanta 1–3, a split at every offset
  (≤ 48 bytes), part-way budgets, the generic path and schedule 1 (samples):
  vm-validate's whole out array each time; windows start exactly where asked;
  JS behind out-of-bounds traps; sessions interleaved step by step; the debug
  Rust build identical; JS sources == Rust `validate_blob` == `Schema.validate`.
  **Run** (defaults: 20,000 mutations, 400 schemas, 60 stress, seed 1;
  2026-11-03, final tree): 673,757/673,757 session runs identical over 50,576
  vm-test and 900 stress cases; 63,387 trapped runs; 6,936 interleaved; Rust
  434,209/434,209, no panic; hosts 4,701/4,701. Eight targeted mutants of the
  session sources (deferred text charge, key order, key arena copy, regexp
  first step, prescan of crossing strings, witness rebase, arena offset
  translation, shape note window) each turn it red. All other gates green on
  the same tree: `bb check`, `drift`, `scan-test`, `rscan-test`, `vm-test`,
  `compile-test`, `nav-test`, `write-test`, host/js `npm test` 1053/1053.
  The proptest campaign's S1 (a push source's finalize after a yield at the
  declared end threw `length_mismatch`) is fixed with a test; async drivers
  now yield by `scheduler.yield` / `setImmediate` / `MessageChannel` before
  `setTimeout` (P7.7's runtime finding), with a test.
  **Bench** (`bench/VM.md` "P6.2", JS, CPU, interleaved rounds, shared
  machine): one window = the buffer walk (0.98–1.02× on every large input;
  ~0.4 µs fixed cost per message); 64 KiB windows 1.04–1.13× on scalar and
  typed arrays, 1.28–1.35× on the 1.1 MB nested maps; 1 KiB windows 1.23–1.9×;
  the 64 Ki quantum on one window costs what 64 KiB windows cost.
  **Learnt**: (1) a speculative in-window walk with a cut `end` is inexact —
  the walk charges differently once it consults `end`, before it answers
  `truncated`; a structural prescan is exact and costs a third of a dead walk
  per window; (2) the frames must reuse the buffer walk's streaks: without
  them a scalar array crossing windows cost 15–22×; (3) the regex area the
  verifier sizes already holds every TEXT leaf of a depth, so concurrent
  regexps need no new scratch; (4) a LIT is decided by length, so long
  strings need no literal compare state; (5) a crossing point must stop at a
  refusal the walk stops at — an embedded document's refusal is caught and
  the outer walk goes on past it (a bug the gate found); (6) stream notes
  (tag 4/40) forbid streaks over a pair's elements.
  **Open**: D085's unknown-length drain mode (the end-dependent checks are
  `doc-start`'s `too_large`, `root-end`'s trailing and the `end` every item
  inherits from the root's `IT_END`: a drain session would carry an open end
  and pending checks); arena pooling and a bound on live sessions (each
  session allocates its arrays; JS `VmSession.bytesHeld` reports them); handle
  version pinning (W12) is the handle's contract, not checked; no Rust async
  driver and no wasm session exports; frames do not yet run `map-streak`, so a
  map that itself crosses windows takes the generic pair path; the V8 OSR
  deoptimisation seen on `array-streak` in small windows (Findings).

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

## P7.5 follow-up — Public session/source packaging

- [x] **Expose the P6.2 schema source APIs** (2026-11-03; no commit made).
  `snug/sources` now exports `validateHandle`, `validateHandleSync` and
  `pushValidator`; the public Schema supports `session`. D108 makes its
  `VmSession` window protocol an advanced interface while preserving D102's
  private verified storage. Added matching declarations, handle/push lifecycle
  documentation, the sources feature-table update, and
  `examples/validate-handle.mjs`, discovered by the existing example runner.
  The earlier P7.5/D106 profile-only scope describes the original package
  evidence; this follow-up exposes the subsequently completed P6.2 work.
  *Checks actually run*: **cd host/js && npm test — 1058 passed, 0 failed,
  0 skipped**, Node v24.6.0. Includes public export checks, buffer/async/sync/
  push verdict identity (success, CDDL, CBOR and budget refusals), independent
  interleaved sessions, protocol/transport failures, early completion's
  finalize obligation, private-state/window checks, seven runnable examples
  and staged-package execution of the new APIs. Focused public-source/package/
  example suite: 16 passed, 0 failed. New guide handle/push snippets executed
  through Node; git diff --check clean. Declaration syntax, exports/imports
  checked; offline TypeScript absent, so no semantic TypeScript check claimed.
  No kin/generated edits, installs, network, publishing or commits.
  *Learnt*: re-exporting the source functions alone is insufficient because
  they call `schema.session`; returning the internal VmSession directly would
  also expose mutable verified Program/scratch arrays. A small private-state
  facade keeps that boundary intact without changing VM/source hosts.
  Push completion can precede delivery, so even an early verdict still needs
  the declared byte count and finalize. Version pinning remains the caller's
  handle contract; unknown-length streams remain pending D085.

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
*Owner confirmation 2026-11-03* (relayed by the coordinator): "js/wasm/rust
is fine for first release" — first-release targets are JavaScript, Rust, and
WebAssembly built from Rust. D005 (JS target vs wasm for JS hosts) is to be
re-taken on the full library once the VM/validator is stable (P7.9).
- [x] **Confirmed by the owner** (2026-11-03, via coordinator) — targets only.
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
that walk with hash-consing by final content (containers are first
canonicalised: structurally equal container leaves, compared by partition
refinement over their shapes and children's classes, collapse to the
earliest member, so equal inline types share one leaf); groups and regexps by first
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
**Decision**: *(amended 2026-10-29: `.plus` adds two integer literals
exactly, any size; `.det` is `.cat` after dedenting each literal — the
common leading spaces of its non-blank lines removed, RFC 9165; floats under
`.plus` are refused)* `.cat` concatenates two literals of one kind; `.eq` with a
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
- [x] **Agreed** (compiler engineer, 2026-10-29): the compiler emits the
  control type's typeset as the EMBED SEQ content, and now refuses a
  `.cborseq` whose controller is not array types only (`control_value`), so
  the virtual array is always well defined.
- [x] **Accepted provisionally** (manager, 2026-10-29, relayed to the VM engineer)

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

### D044 — Fast paths are other implementations of the same charges, held to the generic path (VM engineer)
**Decision**: shape-specific paths (one-answer child without frames; `[* T]`
element step and success streak; single-block closed-struct and `{* K => V}`
pair step and streak; `any`/bare major on containers; dead integer streak;
struct-block routines and fused loops on the generic map path) must give the
identical out array — verdict, reason, subcode, offset, budget used, items,
path — for every input. Charges at one offset with no observable check
between may be merged or reordered; never across an item count, a profile
check or another offset. A streak checks an element or pair fully before
charging and stops before anything that would fail, exhaust the budget or
need the generic path. `limits` word 8 bit 0 forces the generic path; `bb
vm-test` compares both on every case (corpus, oracle generator, mutations,
assembled, a fast-path stress set) under both schedules.
**Why**: live validation was 8× the scanner on arrays and maps; the
observable contract (R6: same budget exhaustion point on every host) leaves
no room for fast paths that charge differently.
**Alternatives**: changing the schedule to whatever the fast paths do
(couples the schedule to the implementation); a lazy DFA cache over typesets
(parking lot; larger); compiling schemas to code (not kin's model).
- [ ] **Signed off** (owner)

### D045 — Schedule 2: simple-shape bookkeeping charged in proportion to its CPU (proposal; implemented opt-in)
**Decision (proposed)**: amend program.md §14 with three rules, everything
else unchanged: (i) an element of an array item whose one admitted ARRAY
block is one uncounted self-looping position with a one-answer typeset (no
evaluation list), while the block is alive, has no bookkeeping units (block
visit, W(|A|+1), candidate, typeset element, stamp, candidate, test); (ii) a
pair of a map item whose one admitted MAP block is a closed struct (one
factor, pool and alternative, the empty group) or a pure table (no literal
entry, one absorbing group entry, one-leaf key and value typesets), while the
block is alive and the pair is simple (an unnamed key, or a key named once
with a one-leaf value typeset; every table pair), costs exactly 1
bookkeeping unit at the map (replacing block visit, cursor steps, key and
value query elements, both stampings, key-phase entries and tests, naming
visits, candidate tests, naming update and pools; key-search probes and the
key-order comparison stay); (iii) a key, value or element of (i)/(ii) queried
with exactly one scalar answer leaf has no filter unit and no leaf unit (its
visit, profile scans and the leaf's variable work — interval and LITSET
probes, literal comparisons, regexp steps, `.bits` scans — stay). Implemented
in the VM behind `limits` word 8 bit 1 on the fast and generic paths alike
(the generic path marks the bookkeeping free while it runs), gated fast ==
generic and "changes only the budget used" on every vm-test case.
**Why**: with the fast paths, §14 charges simple shapes 0.7–5 ns of CPU per
unit against ~20 ns on generic choice-of-maps work, so no single budget both
bounds hostile input at 50 ms and admits valid 1–1.5 MB messages (bench/VM.md
P3.6). Under schedule 2 valid benchmark messages need 3–6× fewer units and
the per-unit CPU of every measured shape is 4.4–21 ns.
**Alternatives**: keep §14 and accept a 2.2–2.3 M default that refuses valid
large messages, or keep 4 M and accept ~80–90 ms worst cases; a budget that
grows with input size (does not bound per-byte cost); raising the charges of
generic map work instead (same ratio, larger numbers, §15 changes anyway).
**Needs**: program.md §14 amended and §15's worked totals re-derived (§15.3's
one-element `[* tstr]` changes; the two-leaf map choice does not), with the
compiler engineer's agreement (no Program byte changes); until then schedule
1 stays the default.
**Accepted (provisional, reversible) 2026-10-29 by the manager**: schedule 2
is the default; schedule 1 stays selectable behind `limits` word 8 bit 1
(cheap: one flag test). program.md §14/§15 amended by the VM engineer under
the manager's authorisation. Owner sign-off pending.
- [ ] **Signed off** (owner)
- [x] **Agreed** (compiler side: the manager, on behalf of the finished
  compiler work item, 2026-10-29)

### D046 — Default step budget: 2.3 M under schedule 2 (proposal)
**Decision (proposed)**: with schedule 2, the compiled default `LIM_BUDGET`
becomes 2 300 000 units: the worst large budget-bounded input measured costs
~21–22 ns/unit in Node v24.6 on an M1 Pro (≈ 50 ms), and the largest valid
benchmark message needs 1 450 008 units (63%). If schedule 2 is rejected:
either 2.3 M with the refusals listed in bench/VM.md P3.6, or 4 M with
~80–90 ms worst cases — an owner trade-off, not taken here.
**Why**: architecture §7's 50 ms target, recorded per event kind.
**Needs**: the compiler sets the default (`snug.compile.main`
`setup-limits`, option 17); the compiler engineer changes it after this
decision. workerd timings are still to be taken (Phase 4).
**Accepted (provisional, reversible) 2026-10-29 by the manager**: 2.3 M
under schedule 2. The VM engineer made the one-line compiler change under
the manager's authorisation (compiler-side agreement: the manager, on behalf
of the finished compiler work item). Owner sign-off pending.
- [ ] **Signed off** (owner)

---

### D050 — Navigation primitives: contract over checked bytes
**Decision**: `snug.nav.walk` assumes bytes that passed the full check and
re-checks no profile rule, but every primitive is total on any bytes: each
head is bounds-checked against `end` (≤ the buffer), a skip keeps a counter
of owed items (array n, map 2n, tag 1) and answers NAV_BAD as soon as more
items are owed than bytes remain, and each head read is one step charged
against `o[N_BUDGET]` (NAV_BUDGET). Child i of a map is pair i's key (its
value follows). Answers are positions or NAV_BAD −1, NAV_BUDGET −2,
NAV_NOT_FOUND −3, NAV_SMALL −4. Hosts charge each operation from zero (the
budget bounds one walk, not a view's life) and treat anything but a position
or NAV_NOT_FOUND as a broken invariant (an error, never a silent miss).
**Why**: §16.1 makes early exit and binary search sound only on proved
bytes; totality on unproved bytes keeps a borrowed view whose caller broke
the contract wrong-but-safe, and lets `bb nav-test` fuzz both hosts.
**Alternatives**: a recursive skip (stack depth = nesting); a per-view
budget (found by the benchmark: repeated linear lookups exhausted it and
read as "absent").
- [ ] **Signed off** (owner)

### D051 — View and Cursor API details §16 leaves open
**Decision**: `kind` is one of int, float, bytes, text, bool, null, array,
map, decimal, ndarray, typed (tags 2/3 are int). `get` takes a string (or an
integer label in the top-level map of a cose view) and `at` an integer;
both answer undefined when absent and throw TypeError on the wrong container
kind. `number()` also reads floats; `int()` is build()'s choice (number when
safe, else bigint); `bytes()`/`copyBytes()` also give a typed array's
little-endian payload; `typedView()` is `{tag, length, get(i)}` over a
DataView; `typed()`, `decimal()`, `ndarray()` and `value()` use the trusted
builder on the item's span. `Cursor.enter()` lands on the first element
(map: the first value, with `key`); `next()`/`up()` answer false without
moving at the ends; `find(key)` enters a map at that key; `keyIs(s)`
compares encoded bytes without allocating.
**Why**: exact, allocation-light accessors over one representation, and
materialisation identical to decode() by construction.
**Alternatives**: views for map keys; `at(i)` on maps; Cursor as an
iterator protocol (allocates per step).
- [ ] **Signed off** (owner)

### D052 — Ownership: copy before the check; the trusted opener deferred
**Decision**: an owned view copies the caller's bytes FIRST and checks the
copy; `borrow: true` checks and views the caller's buffer under the §16.2
contract; SharedArrayBuffer-backed input is refused in both modes. The
trusted opener (an explicit assertion that these exact bytes were checked)
is not in this slice.
**Why**: checking the copy leaves no window between check and copy; the
trusted opener needs its assertion argument specified with the cache that
would justify it.
**Alternatives**: check, then copy (correct for synchronous JS on a
non-shared buffer, but one more argument to make); `ArrayBuffer` transfer
(later, measured).
- [ ] **Signed off** (owner)

### D053 — Child directories: opt-in, lazy, per container of ≥ 8 children
**Decision**: `directories: true` (a private option until §16.4's
measurement is accepted) makes the view build, on first lookup in an array
or map of at least 8 children, an Int32Array of child offsets (array: each
element; map: each key), kept in a Map on the message state for the view's
life; map lookups binary-search it, array access reads it. No cap beyond
what the check already bounds (one word per checked entry).
**Why**: bench/VIEW.md: linear lookup in a 120 000-element array or a
9 000-document map costs ms per access; with directories, ~0.1–0.5 µs.
The threshold keeps small containers (where the linear scan is as fast)
free of allocations.
**Alternatives**: a whole-message tape (§16.4: unspecified); directories
by default (memory: up to ~half the message size for map-heavy bodies).
- [ ] **Signed off** (owner)

### D054 — `validateAt`: depth continues, items restart, top any
**Decision**: `View.validateAt(rule)` runs the VM's span entry over the
item's span with `depth0` = the view's depth, `items0` = 0, `top: 'any'`,
the view's limits, and cose only at depth 0. Offsets in the result are
absolute (in the message).
**Why**: §16.3's detached validation. The item count before a position is
not known without a walk, and the whole message already passed the same
item limit, so restarting the count cannot accept what the profile refused;
depth is known and is continued as §16.3 says.
**Alternatives**: counting the items before the span (an O(offset) walk).
- [ ] **Signed off** (owner)

### D055 — Navigation sources live in kin/nav with their own emit and crate
**Decision**: the navigation sources are `kin/nav/*.kin` (listed in
`snug.project/source-subdirs`, so `bb emit`/`bb drift` cover them), emitted
alone by `kin/scripts/nav-emit` (with `head.kin`/`codes.kin`, identical
output) and built by `kin/scripts/nav-crate` with the Rust view and the
`nav-test` binary from `host/rust/nav/` (not `host/rust/src`).
**Why**: the flat sources are another engineer's mid-edit work (P3.6);
`emit-all!` is all or nothing, and a binary in `host/rust/src/bin` would
break the other crates' SNUG_RS_ONLY module subsets.
**Alternatives**: flat `kin/nav.kin` (blocked whenever a flat source is
mid-edit).
- [ ] **Signed off** (owner)

### D070 — The host-to-kin writer representation
**Decision**: kin writes into a caller-owned writable byte buffer (`BytesW`:
`Uint8Array` / `&mut [u8]`, with `bset`/`bcopy` added to `snug.lang`) at an
explicit position. Arguments arrive as integers only: a head's 64-bit
argument as two i32 halves; an integer of any size as a sign and the
big-endian magnitude bytes of its CBOR argument (n, or −1 − n), leading
zeros allowed; a float as its binary64 bits (the host's only float act is
`Float64Array` aliasing); text as UTF-8 bytes the host produced after its
admissibility check. Every write checks the room it needs first and, when
short, writes nothing and answers `-(WR_NEED + need)` (WR_NEED = 64, above
every refusal code); other negatives are negated cbor.mjs codes. The host
grows and calls again.
**Why**: review V17 asked for a small specified representation; this keeps
every byte decision (head width, float width, bignum form, key order) in
kin and memory in the host, with no overflow path in either target.
**Alternatives**: one byte per i32 in an `Ints` buffer (4× memory, a copy
out); hosts pre-reserving 9 bytes per head (moves the capacity rule into
each host); a separate state array for the "short" answer (an extra argument
on every call).
- [ ] **Signed off** (owner)

### D071 — Writer grammar and failure contract
**Decision**: a host state machine (JS `Writer`, Rust `writer.rs`): one root;
an open array owes exactly n values, a map exactly n key/value pairs with
`key()` required before each value; `end()` only when the open container is
complete; `finish()` only with the root complete, returning a copy, after
which the writer is finished. Misuse throws `SnugFault('grammar')`; a
wrong argument type or value (`int(1.5)`, `int(-0)`, `uint(-1)`,
`uint(2n**64n)`, `typed(Uint8Array)`) throws `unsupported`; profile refusals
throw cbor.mjs's codes (`float`, `text`, `key_type`, `bignum`, `depth`,
`too_many_items`, ...). Any error leaves the writer failed: every later call
throws `writer_failed`; `failure` reports the first code. `float(x)` refuses
integral values within ±(2^53−1) (code `float`; use `int`/`value`), never
normalising. `keysSorted: true` checks each key against the previous one
(`key_order`, `duplicate_key`); otherwise keys may come in any order and are
sorted at `end()`. Keys are text; integer labels only in the top-level map
with `cose`. `typed`, `decimal`, `ndarray` and `value` write complete
values with encode's counting and depth rules; `maxBytes` (only when given)
is checked at `finish()`, as the P2 encoder did.
**Why**: review V16's cases each have one answer; sticky failure means no
partial output can be finished; refusing integral floats keeps one encoding
per value without silent conversion.
**Alternatives**: the grammar in kin (V17's suggestion; the item brief kept
it host-side, and it is host state the hosts must own anyway — recorded as
open); transactional rollback instead of sticky failure; normalising
integral floats to integers.
- [ ] **Signed off** (owner)

### D072 — `encode()` is the object walk over the Writer
**Decision**: `encode(value, opts)` = `new Writer(opts).value(value)
.finish()`, with unchanged semantics, options and refusal codes; the Phase 2
encoder is kept frozen at `bench/baseline/encode-p2.mjs` as the §16.5
baseline and as a test oracle. This refines D004: the host still owns the
value model and admissibility, but the encoder's byte decisions are now
kin's.
**Why**: the item's condition held: measured not slower on any of
bench/codec.mjs's workloads and 1.2–1.7× faster on map-heavy ones
(bench/WRITER.md); one implementation of the deterministic choices instead
of two.
**Alternatives**: keep the P2 encoder as `encode` and offer the Writer
beside it (no speed reason to; two shortest-form implementations); a
host-side key sort with kin verification only (not measured: a JS
comparator plus n − 1 kin comparisons per map). Cost: +3 KB min+gzip.
- [ ] **Signed off** (owner)

### D073 — Two map-ordering paths, both kin
**Decision**: streamed typed calls close a map with `close-map`: complete
`[key || value]` ranges from a pair table of offsets, the already-sorted
case n − 1 comparisons and no copy, else a stable merge sort of indices and
one permutation through scratch (map content copied twice; a byte at depth D
can move at D map ends). The object walk orders keys first with
`sort-keys` (keys encoded into a scratch buffer, ordered, then each pair
written in order), so no value moves. Both charge each comparison against a
budget (`WR_BUDGET` when exceeded); hosts pass 2^31 − 1 until a writer
limit exists. Duplicates are refused where the sort meets them (a
comparison sort compares every two keys adjacent in the final order).
Nested maps close before their parent, offsets survive buffer growth, and
no position inside a closed map is kept.
**Why**: review V15's ownership and offset rules; the measurement that
moving values is the cost (1 MiB bstr put 0.83 vs 0.40 ms) and that
ordering keys first is cheaper than the P2 encoder's tuple sort.
**Alternatives**: always permuting (the walk would move every value); a
cycle-following in-place permutation without scratch (O(1) memory, more
code, same copies); insertion sort for small maps (not measured).
- [ ] **Signed off** (owner)

### D074 — Writer sources live in kin/write with their own emit, crate and gate
**Decision**: `kin/write/*.kin` (`snug.write.*`, listed in
`snug.project/source-subdirs`), emitted alone by `kin/scripts/write-emit`
(with `codes.kin`/`float.kin`, identical output), built by
`kin/scripts/write-crate` with `host/rust/write/{writer,write-test}.rs`,
gated by `bb write-test` — the D055 arrangement.
**Why**: the flat sources and the VM's are other engineers' active work;
this keeps the writer's gates independent of their mid-edit state.
**Alternatives**: flat `kin/write.kin` (blocked by any mid-edit flat source).
- [ ] **Signed off** (owner)

### D080 — snug is a standalone library; Bindle becomes an optional profile (OWNER DIRECTION)
**Decision** (owner direction 2026-11-03, relayed by the coordinator: Bindle
and 3sln.me are paused; "Make it good, efficient, high quality"): snug is a
general-purpose CDDL validator and deterministic CBOR library, not shaped
around 3sln.me. The Bindle CBOR profile, its vectors and the study contracts
remain test inputs and a named, optional profile (`bindle`), and the
conformance floor for that profile. README/SPEC present snug on its own terms;
the Bindle requirements handoff is kept as historical input
(`docs/profiles/bindle.md`). A general default profile is planned (D081, P7.1).
- [x] **Directed by the owner** (2026-11-03, via coordinator).

### D081 — General default profile; Bindle's restrictions become options
**Decision** (manager, provisional): the scanner/VM/builder take profile
options — map key kinds (text only / integer and text / any), allowed tags
(the Bindle set, or a standard set adding e.g. 0, 1, 21–24, 32, 55799 with
their RFC 8949 content checks), scalar float policy (Bindle's refusals vs RFC
8949 deterministic only), and limits — with `bindle` and `deterministic`
presets. The default becomes `deterministic` (RFC 8949 §4.2.1 core
deterministic encoding, verified on decode). Every option only removes
acceptance relative to RFC 8949 §4.2.1; none adds a non-deterministic form.
**Why**: a standalone library cannot default to one application's tag list
and text-only keys (COSE, CWT and most CBOR protocols use integer keys).
- [ ] **Signed off** (owner)

### D082 — Extension controls are host predicates over item bytes
**Decision** (manager, provisional; answers the project-controls question):
a compiled schema may register custom control operators (`.name`) with the
compiler; each lowers to an `EXT` leaf whose verdict is a host predicate
`(id, argument literal bytes, item bytes) → bool`, called by the VM through a
kin host port only when that leaf is queried, with the item fully available.
Under type-set semantics this is an ordinary leaf, so exactness is preserved.
The predicate must be a pure function of its inputs (documented; the host's
responsibility); its cost is charged per item byte; extension leaves are
refused in the untrusted (`bus`) profile unless allowed explicitly. A small
module of generic controls ships separately: `.chars` (code-point length),
`.unique` (distinct array elements by encoded bytes), `.samelen`
(equal-length array/typed-array members of a map). No application names.
**Why**: keeps the VM pure for every built-in construct, needs no new VM
language, and lets applications express what CDDL cannot without forking.
**Alternatives**: a post-validation callback pass (rejected: under set
semantics there is no single accepting derivation to attach it to); built-in
application controls (rejected: not generic).
- [ ] **Signed off** (owner)

### D083 — `\p{…}` via an optional, separately loaded Unicode table module
**Decision** (manager, provisional): `compile(text, {unicode})` accepts a
category-table module (`snug/unicode`, generated from a pinned Unicode
version recorded in the module); without it `\p{…}` stays a schema error
naming the missing module. The tables are used only at compile time — a
compiled Program contains code-point ranges — so validation bundles never
carry them.
- [ ] **Signed off** (owner)

### D084 — A stable, versioned serialised Program with a compatibility rule
**Decision** (manager, provisional): program.md §13.3's container is the
public serialised form. A loader accepts a Program iff its format major
equals the loader's and its format minor is ≤ the loader's; a change altering
the meaning of existing Program words bumps the major; an additive change (new
leaf kinds, new optional sections) bumps the minor. SOURCE_KEY (SHA-256 over
text + effective options + format version) is the cache key; every loaded
Program goes through `vm-verify`; caches must be trusted stores (program.md
§17 q1). The current layout is format 1.0.
- [ ] **Signed off** (owner)

### D085 — Unknown-length streams drain to preserve refusal codes
**Decision** (manager, provisional; answers architecture §17.1's question):
an unknown-length stream session runs as a known-length one until a check
needs the document end; such checks (`truncated` precedence, `too_large`,
`trailing`, minimum-remaining lengths) are held pending and resolved at EOF or
when `maxBytes` is reached, consuming and dropping bytes meanwhile. Codes are
therefore identical to a buffer of the same bytes. An opt-in `failFast` mode
reports the first certain error and documents that its code may differ.
Bounded by `maxBytes` and the host's deadline.
**Why**: cross-source identity (SPEC §7) is the property tests can hold; the
cost (reading to EOF on a doomed message) is bounded and opt-out.
- [ ] **Signed off** (owner)

### D090 — The session asks for bounded pieces whole; a LIT is decided by length (P6.2)
**Decision** (session-VM engineer, provisional): besides heads (D029), a session
asks for these pieces whole, from their first byte: a bignum's tag, head and
content (≤ 139 bytes); the prefix of a string item that an admitted LITSET's
binary search may read (min(item length, its longest member) ≤ pool bytes);
the whole string item only when an admitted LIT has exactly its encoded length
(so ≤ pool bytes); the 73 / 11 bytes a tag-40 shape / data note reads and a
decimal mantissa's bignum (D029's summaries); a typed array's content head.
Every other content is read incrementally. A LIT whose length differs from the
item's is refused by length, without reading content, so no literal-compare
position is carried.
**Why**: what a stream must buffer stays bounded by the Program (its literal
pool) or by constants, never by the input; the shared leaf functions
(`leaf-lit`, `leaf-litset`, `eval-leaf`) run unchanged on window bytes.
**Alternatives**: carried compare state per LIT leaf (more state, no gain once
the length decides); copying LITSET prefixes into the key arena (the copies
would overlap embedded content's keys, so the arena bound by the message
length would no longer hold).
- [ ] **Signed off** (owner)

### D091 — Two tiers: the buffer walk takes whole items, frames run the generic path; a structural prescan decides (P6.2)
**Decision** (provisional): an item every byte of whose walk lies before the
step's CUT (the window's end, or the quantum's byte bound, D093) is evaluated by
`eval-item` / `dead-item` themselves; anything else gets a frame that runs
snug.vm.eval's GENERIC path phase by phase with the same block, query, witness
and charging functions (fast == generic is gated, D044). "Every byte before the
cut" is decided by a structural PRESCAN (heads and lengths, no charges) that
stops at the cut or at a refusal the walk cannot get past (a malformed head, a
length or count beyond end, an unsupported or 64-bit tag); once per step it
runs over the pending item and its siblings and records the crossing chain and
the crossing point, so later siblings and descendants are looked up, not
rescanned. Frames run the buffer walk's streaks (`dead-int-streak`,
`array-streak`) with `end` cut to the cut — a streak checks an element whole
before charging it and stops before one that would not do, so a short `end`
only ends it sooner — and evaluate known-fitting children inline.
**Why**: the D030 condition — two drivers, both kin, sharing every leaf check —
with nothing forked but control flow; a whole-window session IS the buffer
walk (≈ 1.0×). Exact by construction: the interrupted draft's speculation (run
the buffer walk with `end` cut to the window, roll back on `truncated`) is not:
once a cut `end` is consulted the walk can charge differently before it
returns `truncated` (`key-span-end` answers −1 and the key search's probes are
skipped), so a `budget` or `too_many_items` result there is not the buffer's.
**Alternatives**: speculation with rollback (inexact, above); framing every item
(the 120,000-int array cost 15–22× at 64 KiB windows before the streaks).
- [ ] **Signed off** (owner)

### D092 — Map keys whole: in the window or copied into the key arena (P6.2)
**Decision** (provisional): a pair's key is taken whole before any of the
pair's charges — from the window, or, when it crosses the window, copied into
the session's byte KEY ARENA (BytesW, min(declared length, input limit) bytes)
window by window — and the key search, the key's typeset evaluation
(`eval-item` over the copy, offsets moved back) and the order comparison run on
it; the copy then becomes the map's previous key. A previous key held as a
window span is copied out on suspension and before any frame push; each map's
region starts at its frame's floor (the arena is a stack in frame order).
**Why**: the key search is charged before the key's visit, so the stop point
needs the key whole first; keys are disjoint spans of the message, so the arena
never needs more than the message (architecture §17.2, W3–W6), and a key is
copied at most once (plus one move when it becomes the previous key).
**Alternatives**: asking for whole keys in the window (the host then buffers
arbitrarily long keys instead); copying every key (costs keys the window holds).
- [ ] **Signed off** (owner)

### D093 — The work quantum and the cut (P6.2)
**Decision** (provisional): a step yields once it has made progress and its
work (budget units charged + 1 per item begun + 1 per 64 content bytes scanned)
reaches the quantum, or when it would begin an item at or past its cut
(its starting position + quantum bytes); content scans chunk by what the
quantum leaves (64 bytes a unit). Yields depend only on the windows and the
quantum and change nothing in `out` (gated).
- [ ] **Signed off** (owner)

### D094 — String content in one pass; deferred dry-run charges; replay only for content read twice (P6.2)
**Decision** (provisional): a text item's UTF-8 scan (charged before, as
`eval-item` does) and every admitted regexp advance together, a code point at a
time, each regexp's active set in its own slot of the regex area (the verifier
sizes it for every TEXT leaf of the depth); the filter and leaf charges
(units, regexp steps, LITSET probes) are DRY-RUN (the budget word parked) and
charged as one sum at the item's offset after the scan — they are all at that
offset with nothing observable between, so the stop point is the buffer's; a
regexp's dry run stops once the sum exceeds the budget left. A byte string's
filter and leaves are charged in order at its start (a `.bits` charge does not
depend on content), the `.bits` verdict comes from the pass, and an EMBED
sub-walk runs as a nested document on the frame stack, the byte-string frame
catching an inner profile refusal (embed-run). Content read twice — `.bits`
with EMBED, `.cbor` with `.cborseq`, a float typed array whose content tail
reads content — is replayed: the frame pins `vms-keep` at the content start.
**Why**: the common shapes cost one pass and bounded buffering; replay only for
rare combinations. **Alternatives**: replaying every crossing string (the
draft: a stream buffers every such string); running every observer of a byte
string concurrently with deferred charges for embedded walks (much larger).
- [ ] **Signed off** (owner)

### D095 — The session API and its hosts (P6.2)
**Decision** (provisional): kin `snug.vm.session`: `vms-words(P)`,
`vms-arena(P, limits, total)`, `vms-init(P, B, rule, limits, s, ss, ka, total,
quantum)`, `vms-step(P, B, window, s, ss, ka, out, base)` → the code (out as
vm-validate's) | VMS_NEED (−64) | VMS_YIELD (−65), `vms-need-offset`,
`vms-need-length`, `vms-position`, `vms-keep`. JS: `Schema.session` →
`VmSession` (its own scratch, session array and arena; no concurrent resume)
and sources.mjs `validateHandle`, `validateHandleSync`, `pushValidator`. Rust:
`schema::Session`, `trait Blob` (an immutable snapshot), `validate_blob`.
Known length only (D085's drain mode is a later item); `validateAt` spans are
not sessions.
- [ ] **Signed off** (owner)

### D100 — Program container compatibility and format-word spelling
**Decision**: implement program.md §13.3's 96-byte header unchanged, with
explicit little-endian P words, byte pool, printable ASCII/NUL-padded snug
version, zero reserved bytes and host SHA-256 over [0,56) concatenated with
[88,end). Apply D084 instead of the older document's exact snug-version
equality: equal format major and minor no newer than the loader. The format
word's low 16 bits are major, high 16 bits minor; 1.0 therefore remains the
existing word value 1. Producer version is provenance, retained on reload.
Current loader is 1.0 and always runs kin vm-verify after framing/digest.
**Why**: retain existing Program/container bytes while making D084's
compatibility rule concrete; a digest catches corruption but does not
authenticate Programs or prove semantic compiler invariants.
**Alternatives**: exact snug-version equality (superseded by D084); a new
container layout or encoding 1.0 as 0x00010000 (unnecessary migration).
- [ ] **Signed off** (owner)

### D101 — Private package staging with generated dependencies inside it
**Decision**: expose six package entry points from host/js/package.json,
retain private:true and version 0.0.0, and provide npm run build. It stages
a self-contained package in a new scratch directory, copying gen/js and
rewriting generated import paths only in staged host copies. Include
declarations, docs, examples, licence/provenance and recorded benchmark docs;
staged examples use package imports. Never overwrite an existing target.
Checkout imports continue using committed gen/js. Runtime version metadata
is a compiler-free mirror checked against kin's version and package.json.
**Why**: portable package dependencies without changing gen/, kin/, existing
host imports or a sibling engineer's files; runtime import graphs must stay
compiler-free. No publish/install/network step is needed.
**Alternatives**: distribute host/js alone (generated imports break);
change every host import or add a Node-only import map (unnecessary shared
file changes or portability cost); publish (not authorised).
- [ ] **Signed off** (owner)

### D102 — Verified public Program ownership through host facades
**Decision**: new package facades compose the unchanged schema host. Every
public Program copies and verifies P/B; WeakMap storage keeps its live arrays
private, array getters return copies, and its schema/program objects are
frozen. Program exposes serialize(), sourceKey and sorted rule names.
fromProgram/fromSerialized resolve to Schema; serialize is synchronous and
uses the existing dependency-free host SHA-256. Cap container body at the
format's 64 MiB ceiling before allocation from claimed lengths. Shared
buffers are refused at the public buffer boundary.
**Why**: structural verification remains useful only while the verified
words stay unchanged; public package work must not modify session/scratch
internals being edited by another engineer.
**Alternatives**: expose mutable verified storage; mutate host prototypes;
copy the VM/verification rules into a new host implementation (all rejected).
- [ ] **Signed off** (owner)

### D103 — Public refusal families, without changing VM verdicts
**Decision**: public compile rejects with its exported SchemaError; validate
and validateAt retain validation result objects. Codec/profile refusals and
schema-decode/checked-view refusals share SnugFault. CBOR fault codes stay
unprefixed; schema faults use schema/<reason> and retain reason/path/offset
and optional embedded subcode. ProgramError distinguishes container/verify
failures; existing SourceError distinguishes source protocol failures.
Unknown rules/API misuse use safe TypeError messages. Internal invariant
failures are errors, never a fabricated validation verdict.
**Why**: one catchable public contract with no payload leakage and no
renaming of kin's result reasons. Compiler import stays lazy even when its
SchemaError class is imported.
**Alternatives**: expose legacy generic decode Error objects; turn every
error including programming/transport errors into a CBOR refusal.
- [ ] **Signed off** (owner)

### D104 — Describe the current profile honestly during P7.1
**Decision**: publish only profiles.bindle (current map-root/key defaults),
document its use by option spreading, and clearly distinguish compiler
restriction sets full/bindle/bus from wire policy. No deterministic alias
is exported while the scanner still enforces legacy Bindle restrictions.
README/SPEC present the standalone D080 purpose and state P7.1–P7.3 as
planned; this package task adds no profile accept/refuse semantics.
**Why**: users must know that generic deterministic CBOR can currently be
refused; naming a future preset is not an implementation of D081.
**Alternatives**: advertise the general default now; describe snug as a
Bindle-only product (both would misstate current implementation/direction).
- [ ] **Signed off** (owner)

### D105 — Hand-written declarations with bounded offline evidence
**Decision**: six .d.ts entry points describe the actual package facades,
including recursive decoded values, async compilation/loading, fault/result
families and source/view/Writer contracts. Tests use Node's TypeScript parser,
match runtime export names and resolve declaration imports. They run semantic
TypeScript checks only if ../3sln.me/node_modules supplies it offline.
Native Float16 is structurally spelled without requiring a newer TS library;
runtime admission still requires a native typed-array prototype.
**Why**: no network/install dependency, no false claim of semantic type
checking when the offline compiler is absent, no fabricated schema-inferred
return types.
**Alternatives**: introduce tsc as a dependency; export any for every API;
claim a full TypeScript check after parsing only (rejected).
- [ ] **Signed off** (owner)

### D106 — Runnable examples and profile-only source scope
**Decision**: six small Node examples cover hostile byte validation without
building a value tree, checked decode, deterministic encode/Writer, checked
navigation/detached validateAt, Program caching, and profile validation over
an async in-memory handle. Run every example in npm test, also execute staged
copies with bare package imports. Export the existing handle/push scanners;
do not present them as resumable CDDL validation or unknown-length streams.
**Why**: provide reviewable consumer migration fixtures without claiming the
parallel session work is complete or buffering whole sources as a substitute.
**Alternatives**: documentation-only examples; a fake streaming schema
adapter that materialises its entire source (rejected).
- [ ] **Signed off** (owner)

### D107 — Package evidence remains separate from broader release gates
**Decision**: README, guide, API, CDDL support, profiles and SPEC describe
the current JS package and its limits, including finish-time-only encode
maxBytes, trusted Program caches, view alias lifetimes, Node-only package
evidence and unfinished general profiles/streaming/runtime-size work. Leave
the wider milestone reconciliation and release gates to their owners.
**Why**: the successful host suite does not establish browser/Worker support,
fresh Rust/wasm identity, drift, fuzz or the bundle-size target. D080 requires
quality and reproducibility rather than unsupported completion claims.
**Alternatives**: replace every old milestone or rerun unrelated shared
generated gates during active parallel work (outside this item's scope).
- [ ] **Signed off** (owner)

### D108 — Public source validation and an encapsulated advanced session interface
**Decision** (provisional): expose the existing P6.2 `validateHandle`,
`validateHandleSync` and `pushValidator` through `snug/sources`. Expose
`Schema.session(rule, length, options?, scheduling?)` through `snug/schema`,
returning a VmSession interface with `length`, `bytesHeld` and `step` only;
there is no exported VmSession constructor. Keep the host session private,
including its Program, scratch and key arena. Refuse shared windows and
invalid window spans at the facade. Document need/yield/keep/done as advanced
use; recommend the handle/push drivers for normal callers. Schema sources
return ValidationResult, source protocol failures remain SourceError, and
transport exceptions propagate unchanged. Known exact length and immutable
snapshots are required; callers enforce version pins. This extends D106's
original profile-only package scope after P6.2's implementation.
**Why**: the drivers require Schema.session; publishing its window contract
also permits custom drivers while D102's verified Program ownership stays
intact. Separate sessions own exclusive state across awaits without changing
the shared host/kin implementation or accepting new wire forms.
**Alternatives**: re-export drivers without a public session bridge (broken
with public Schemas); return/export the internal VmSession (leaks live arrays);
hide session behind a separate driver-only adapter (adds an unnecessary
parallel Schema contract and prevents custom window drivers).
- [ ] **Signed off** (owner)

### D110 — Explicit Unicode data port and source-key binding
**Decision**: extend the kin compile entry point with a read-only flat int
array of `[category id, lo, hi]` triples; an empty array means no module.
Ids are first ASCII letter × 256 + suffix (zero for aggregate categories).
Kin checks category ids, sorted/disjoint/non-adjacent scalar ranges and the
surrogate gap, copies the data into the compiler arena, then resolves
`\p{X}` / `\P{X}` into existing regexp classes. Missing category ranges
are empty; Cs is always empty. Hosts provide data, never a matching callback.
JS uses `compile(text, {unicode: tables})` with `tables` from `snug/unicode`;
Rust has `CompileOptions {unicode: Some(&tables), …}` and
`compile_with_options` / `compile_bytes_with_options`. Existing Rust compile
calls keep working without tables. Table ingestion and source-key encoding
charge one unit per input word; category search, copied ranges and class
binary-search probes are charged, with existing sort/automaton charges and
position limits retained. Missing-module failures keep code `regexp` and
carry a message naming the module.

When tables are supplied, append their complete canonical word array as a
seventh CBOR element in D039's source-key preimage. With no tables D039's
preimage is unchanged. The Program/container layout is unchanged; the VM
and Program loader never import or retain the optional Unicode module.
**Why**: D003/D032 require explicit deterministic host data and kin-owned
accept/refuse decisions. The table content, rather than a mutable version
label, must determine the cache key; independently generated JS/Rust
Programs and independently recomputed hashes gate this. Charging class
probes closes the table-dependent binary-search work that a constant
per-atom charge alone would miss.
**Alternatives**: host regexp callbacks; bundling tables into the VM; hashing
only Unicode version metadata; changing the Program format (all unnecessary
or contrary to D083).
- [ ] **Signed off** (owner)

### D111 — Offline ICU generation pinned to Unicode 16.0
**Decision**: `tools/unicode/categories.json` lists RFC 9485 category names;
`gen-tables.mjs` tests all U+0000..U+10FFFF against Node's ICU
`\p{gc=…}` regexps, excluding surrogates, and emits JS and Rust from the same
packed byte stream. Both outputs name the generator, Node v24.6.0 and
Unicode 16.0; ICU is 77.1. Range gaps/spans use unsigned base-128 varints,
base64 in JS and a byte array in Rust. `--check` regenerates in memory and
requires byte-identical output, including the pinned Node header. Generator
inputs and generated data are checked in; runtime upgrades do not regenerate
or change category semantics implicitly. Treat exported tables as immutable.
**Why**: this environment has no network/install requirement or external
Unicode file dependency. Scalar-only tables implement RFC 9485's empty Cs;
C also excludes surrogates. Node supplies an independent category oracle for
VM boundary/neighbour/random tests. The existing wire profile's noncharacter
refusals are counted and asserted separately from category comparisons.
**Alternatives**: download UCD data; query a host regexp engine during
validation; inherit each host's possibly different installed Unicode version.
- [ ] **Signed off** (owner)

### D113 — Array elements by default; strict own-property checks opt in
**Decision** (manager, 2026-11-03): JS encode and Writer.value encode array
elements at indexes 0..length−1 and ignore extra named own properties,
including hidden and symbol properties. Keep Array.isArray and today's
exact Array.prototype rule. If an element reads as undefined, check
`!(i in v)` and refuse a hole with the existing `unsupported` code; present
undefined follows the existing undefined rules. `strictArrays: true` retains
the old Reflect.ownKeys count check; `profiles.bindle` sets it to preserve
Bindle byte/refusal compatibility with cbor.mjs.
**Why**: D080/D081 make snug a standalone library. Enumerating 120k array
index keys costs about 20 ms under load (D112), making encode about 6× slower
than cbor2 to refuse extra properties that JSON.stringify and other CBOR
libraries ignore. An undefined-only membership check avoids that enumeration
on the default path while continuing to refuse holes.
**Alternatives**: always enumerate (D112's unresolved bottleneck); for-in or
Object.keys (cannot enforce the old hidden/symbol-property contract); change
array prototypes or undefined handling (outside this decision).
- [ ] **Signed off** (owner)

### D115 — The property campaign tests a HEAD snapshot, not the shared checkout
**Decision** (P4.2): `bb proptest` (default `--tree=head`) extracts
`git archive HEAD` into a scratch directory beside a `kin` symlink, clones
`.cache`, overlays the working `tools/proptest/` and re-runs itself there:
properties 1–5 import that tree's host and generated JS, and the gates
(property 6) run `emit` and cargo in it. `--tree=working` tests the checkout
as it is. The summary records the HEAD tested.
**Why**: several agents share the checkout. During P4.2's trial runs an
uncommitted encoder change made `encode` throw `RangeError`, untracked session
sources sat beside the VM's, and HEAD moved eight commits; importing or
emitting the working tree would report half-finished work as snug bugs, and
the gates' `emit` would rewrite other people's gen/ files.
**Alternatives**: `git worktree` (writes shared `.git` metadata); running in
the checkout and filtering (an import cannot be partially excluded);
stashing others' work (not ours to touch).
- [ ] **Signed off** (owner)

### D116 — When the oracle's verdict counts
**Decision** (P4.2): corpus/tools/oracle.mjs is consulted only for string
schemas of at most 1,500 characters, compiled without limits, validated with
default options, on bytes cbor.mjs accepts; `unknown` and a snug `budget`
result are not verdicts. Bytes cbor.mjs refuses must instead give
`cbor/<its code>` (D023). `\p{…}` schemas, which the oracle cannot read, are
held to four fixed shapes whose verdict is a JS `u`-flag RegExp over Node's
ICU (the tables' own source, D111), with I-Regexp `.` written `[^\n\r]`.
**Why**: the oracle is deliberately exponential; a 200-rule hostile text takes
it ~5 s to exhaust its compile budget (a false P1 hang in a trial run).
Limits and options change snug's verdict for reasons the oracle does not model.
**Alternatives**: a longer watchdog (hides real hangs); a smaller oracle budget
(changes a shared tool); no `\p` coverage.
- [ ] **Signed off** (owner)

### D117 — Findings are signatures with minimised witnesses and a hand triage
**Decision** (P4.2): a failure's signature is `P<property>/<class>[/<sub>]`.
Every occurrence is counted (and appended to
`.cache/proptest/<run>/failures.jsonl`); the first three of each signature go
to `tools/proptest/findings/` with campaign seed, case index, inputs (hex or
text), expected and actual, and the first two are greedily minimised (bytes,
CDDL tokens, host values) under the same signature. `--replay=P:SEED:INDEX`
re-runs one case. `findings/triage.json` is hand-written (snug bug, oracle
bug, generator bug, documented difference, environment) and the summary
carries it forward. Gate failures are findings `P6/<gate>`.
**Why**: a frequent defect produces thousands of identical failures; the
evidence is the count, one exact case and one minimal case.
**Alternatives**: stop at the first failure (hides co-occurring defects);
commit every failure (megabytes of duplicates).
- [ ] **Signed off** (owner)

### D118 — The round-trip normalisation the codec property allows
**Decision** (P4.2): `decode(encode(v))` must deep-equal `normalise(v)`:
a bigint within ±(2^53−1) becomes a number and every ordinary map object a
null-prototype object with the same own keys in the same order (a `cose` Map
stays a Map); typed arrays, Float16Bytes, Decimal, NDArray and floats must not
change. `objects: 'plain'` decoding must re-encode to the same bytes.
**Why**: exactly the documented value model (exact integers, null-prototype
maps); anything wider would hide a codec change. 1.24 M values needed nothing
more.
**Alternatives**: compare bytes only (misses a decoder that loses what the
encoder recreates); compare to cbor.mjs only (a shared ancestor).
- [ ] **Signed off** (owner)

### D119 — Rust owns exact values and borrows checked documents
**Decision** (P7.11): add a crate-root facade alongside the legacy Rust test
hosts. Integers retain u64 major-0/1 arguments (negative means −1−argument),
with big-endian argument bytes for bignums and exact Integer decimal
coefficients; typed arrays own native vectors, including binary16 bits.
Decode uses the generated scanner before a trusted builder; schema decode
uses the VM before that builder. Encoding and Writer use kin byte-writing
and map-order primitives and a final generated scan. Rust output growth has
an explicit default byte cap, rather than JS's optional finish-only cap;
content refusals may occur at finish. Views/cursors borrow shared slices,
so safe Rust enforces the no-mutation lifetime without an input copy.
Programs share private verified storage and use D084/D100 containers unchanged.
The requested validate Result<(), Failure> also reports an unknown-rule API
failure with code −1/reason unknown_rule; this is distinct from VM verdicts
and from JS's TypeError. Other facade operations use one Error enum with
safe codes; the existing synchronous session driver supplies validate_blob.
**Why**: make first-release Rust useful without moving byte/schema decisions
out of kin or modifying parity files another engineer owns. Exact integer
and typed representations preserve every accepted vector byte, while shared
borrows implement D050/D052's ownership contract directly in the type system.
**Alternatives**: lossy f64 integers; mutable verified Program buffers;
duplicated profile checks; an unchecked view constructor; silently treating
unknown rules as successful validation; buffering source documents as a
replacement for the existing session driver (all rejected).
- [ ] **Signed off** (owner)

## Findings

- 2026-11-03 (manager): P7.7's side finding that the baseline codec "accepts a
  float32 typed array holding a NaN" in the cborg oracle file was **not
  reproduced**: snug and `bench/baseline/cbor-3sln.mjs` give the same verdict
  and code on all 930 oracle inputs, and no oracle case is labelled as a NaN
  refusal (cborg's `error` strings cover tag-content and length refusals). No
  test change made.
- 2026-10-29 (manager): **bundle sizes vs R9** (esbuild 0.28 minify, node
  zlib; tree at the P5.4 commits): codec only (decode + encode) 30.4 KB raw /
  10.7 KB gzip / 9.6 KB brotli (cbor.mjs: 6.1 KB gzip); runtime (codec + schema
  VM + verifier) 92.4 / 33.0 / 28.6 KB; runtime + view + Writer 104.4 / 37.1 /
  32.0 KB; compiler (lazily loaded) 118.5 / 38.2 / 32.8 KB. **R9's 20 KB runtime
  target is missed by ~13 KB gzip**; the VM (with P3.6 fast paths) is the bulk.
  Options: drop the verifier from bundles that only run in-process compiled
  Programs; strip the force-generic duplicate paths; measure per-module.
- 2026-10-29 (manager): commit `50b9a7c` was made with `git commit -a` and
  swept up the P1 engineer's uncommitted work (q21 `end` offsets, `IntsR`, the
  JS redeclaration guard, the smaller `read-arg`, gen/ output). Content correct
  and gated; the message is wrong; `d5b74d7` records it. Rule: commit by
  explicit path only, never `-a`, while several agents share the tree.
(Measured facts worth keeping, with dates.)

- 2026-11-03 (P6.2): V8 (Node 24.6) can enter a kin streak (`array-streak`,
  `dead-int-streak`) through OSR code compiled before the stores after its
  loop had type feedback, and then deoptimise at every loop exit ("insufficient
  type feedback for generic keyed access" at the post-loop store into `s`,
  ~20 µs a call, the same optimised code each time). One call per message is
  harmless; a session calling it once per small window can pay it per window
  (seen as 3.5× at 1 KiB windows on the 120,000-int array in some process
  histories, 1.26× in others). Not a correctness issue; Rust/wasm unaffected.

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

All four earlier questions were delegated to the manager on 2026-11-03 and
are answered as provisional decisions D082–D085. None is open now.

- [x] **Project controls** → D082 (generic host-predicate extension controls).
- [x] **`\p{…}` in regexps** → D083 (optional table module; compile time only).
- [x] **Program caching** → D084 (versioned serialised Program, compatibility rule).
- [x] **Unknown-length streams** → D085 (drain to EOF within maxBytes; opt-in fail-fast).

## Phase 7 — Standalone library (D080, 2026-11-03)

- [ ] **P7.1 — General default profile** (D081): key kinds, standard tag set,
  presets `deterministic` (default) and `bindle`; scanner, VM, builder, writer.
  D113 array-policy follow-up done: default ignores extras, strictArrays/Bindle retain the old check; **Learnt**: enumeration dominates 120k integers (paired CPU 29.6960 → 4.7339 ms); npm test 1,051 passed / 0 failed; method and evidence in bench/WRITER.md.
- [ ] **P7.2 — Extension controls** (D082) and the generic controls module.
- [x] **P7.3 — Unicode `\p{…}` / `\P{…}` table module** (D083).
  *Done 2026-11-03; manager commit pending; no commit made.* D110–D111.
  Offline Node v24.6.0 / ICU 77.1 / Unicode 16.0 generation produces the same
  **6,419 ranges across 37 category names** (empty Cs included) for both
  hosts. Optional `snug/unicode` export and types; JS/Rust explicit compile
  options; kin-owned property parsing, complements, class unions, canonical
  table checks and compile-budget charging. No VM/source-adapter changes,
  no Program format change, no implicit runtime or compiler table import.
  Complete table data binds the opted-in SOURCE_KEY; no-table keys remain
  unchanged. Headers preserve generator/runtime/Unicode provenance.

  *Sizes*: JS **19,875 source / 19,377 minified / 9,287 gzip-9 bytes**;
  Rust source **37,361 bytes**; packed shared data **14,109 bytes**; decoded
  Int32 triples **77,028 bytes**. Machine, versions and reproducible method
  are in `bench/README.md` (Apple M1 Pro, arm64, macOS 14.6.1, esbuild 0.28.2).

  *Checks actually run*: compiler-only `kin/scripts/compile-emit`;
  **bb unicode-test**: exact offline regeneration, **1 Rust API test**, **574
  JS == Rust outcomes (368 complete verified Programs / 206 errors)**,
  including **400 seeded Unicode schema mutations**, malformed table inputs,
  float-port retries, **1,037 arena-growth retries** across starting sizes
  and low budgets, independent baseline-CBOR/node:crypto source-key check;
  **40 JS VM/API tests**, **51,548 category/complement scalar comparisons**
  against Node and **270 noncharacter profile refusals** checked separately.
  **bb compile-test**: **301/301 identical outcomes**, **270/270 verified
  Programs**, unchanged §15 example (286 words / 14-byte pool), **55/55
  independently recomputed no-table source keys**, **13,229/13,229 corruption
  verdicts identical**. **bb compile-fuzz**: **3,000 texts**, seed 24,301,
  **441 compiled / 2,559 refused**, no crash/internal failure/budget overrun;
  **375** arena-size checks agree. **cd host/js && npm test**: **1,036 passed,
  0 failed, 0 skipped**, including Unicode tests, all seven export/declaration
  checks and existing staged-package checks. Unicode guide example and a scratch-staged bare
  `snug/unicode` import/compile/stored-Program validation executed
  successfully. Offline TypeScript was absent; no semantic tsc claim.
  Babashka printed a sandbox-denied process-descendant cleanup stack trace
  after successful gates; gate assertions completed successfully.

  *Learnt*: optional table semantics must be in the cache key, even without
  changing the Program format. Large category classes require charging each
  class probe as well as copying/sorting ranges. Cs must be empty before
  grouping C; complements can contain unreachable surrogate intervals in
  the automaton but no UTF-8 text can reach them. The current profile rejects
  noncharacters independently of I-Regexp; those are not category mismatches.
  Node's explicit `test/` runner uses `test/index.js`, so the new tests must
  be imported there. Tables are compile-time inputs; their decoded-size
  figure excludes temporary decode storage and compiler arena peak memory.

- [x] **P7.4 — Serialised Program API** (D084), JS host side.
  *Done 2026-11-03; manager commit pending; no commit made.* Public
  program.serialize() returns deterministic Uint8Array; fromSerialized checks
  magic, versions, lengths, producer metadata, reserved bytes and digest,
  then kin vm-verify. D100 specifies D084's compatibility rule over the
  existing format word. Runtime-only loading never imports the compiler.
  Arrays are owned/private through the new public Program facade (D102).
  Corpus round trips cover all 295 suites: **264 schemas loaded, 31 annotated
  refusal/later schemas refused**, **987 validation results preserved**.
  Recompilation and reserialisation are byte-identical. **3,848 single-bit
  mutations (every bit of every byte) and 481 truncations** of a small Program
  refused; targeted corruption tests include rehashed malformed Programs,
  major/newer-minor refusal, cross-snug-version acceptance, offset Buffer
  views, claimed-length bombs, trailing bytes, ownership and independent
  node:crypto SHA-256 comparison.
  *Learnt*: D084 supersedes program.md §13.3's exact producer-version check;
  the 1.0 word spelling can be preserved with major in the low 16 bits.
  Integrity checks do not prove semantic compiler properties: a cache still
  needs trusted origin. Copying with new Uint8Array avoids Buffer#slice aliases.

- [x] **P7.5 — Public package**: entry points, TypeScript declarations, docs,
  examples, a worked consumer example, README.
  *Done 2026-11-03; manager commit pending; no commit made.* D101–D107.
  Six explicit exports with declarations; lazy asynchronous public compile;
  safe coherent faults/results; a compiler-free runtime import graph; a
  scratch-only self-contained build containing generated dependencies; six
  runnable examples, also checked after staging. README, SPEC and four
  consumer docs describe snug as standalone, distinguish current/planned
  wire profiles and explain exact CDDL support, errors, limits and ownership.
  *Checks actually run*: **cd host/js && npm test — 996 passed, 0 failed,
  0 skipped**, Node v24.6.0. Includes the existing 684 host tests, all new
  corpus/container/public-package tests, six examples and isolated staged
  package execution through every entry point. Node parsed all declarations
  and checked runtime export/declaration imports; offline TypeScript was
  absent, so **no semantic TypeScript check is claimed**. All README/guide JS
  snippets executed through Node; local links in the new/updated consumer
  docs checked; npm run build produced a self-contained scratch package;
  git diff --check clean. Evidence is against HEAD
  677b9410efbe9ae33d244915f749032d3df9589e plus this uncommitted worktree;
  unrelated parallel work is not part of the package change. No fresh
  bb emit/drift, Rust/wasm, fuzz, browser/Worker or bundle measurement run.
  *Learnt*: host/js alone cannot be copied away from the tree while its
  imports point at gen/js; staged copies solve that without touching shared
  hosts/generated files. Public source support is still profile-only. The
  default wire policy still has Bindle restrictions despite D080's standalone
  direction; an exported deterministic alias would conceal that gap.
  *Requests to the schema/source owners and manager (not changed here)*:
  (1) expose the finished resumable CDDL session API through the public facade
  and declarations once its contract/gates settle; (2) harden
  bufferHandle/asyncHandle snapshot construction for Buffer inputs
  (Buffer#slice aliases), and clarify read-result immutability/session reuse;
  (3) reconcile program.md §13.3's older exact-version text with D084/D100,
  including the major/minor word spelling; that document is outside this
  task's write set. Browser/Worker and broader release evidence remain P7.7.
- [ ] **P7.6 — Bundle size** (R9: runtime 33 KB vs 20 KB gzip).
- [x] **P7.7 — Runtime evidence**: Node, a real browser, workerd.
  *Done 2026-11-03 by the P7.7 runtime engineer.* Harness and full record:
  `tools/runtime/` (`run.mjs`, `README.md`).
  - **What was tested**: the package staged by `package-build.mjs` from a
    clean worktree of **f275938**. The session-VM edits in the working tree
    were not in it.
  - **The suite**: 976 checks:
    - profile vectors (74 accept, 142 refuse) and 327 cborg-oracle inputs;
    - the six study contracts (45 cases) and 64 study probes;
    - serialise / fromSerialized / fromProgram;
    - a checked View plus Cursor walk;
    - the Writer;
    - `scanHandle` over `asyncHandle`.

    Each check runs twice: compiling the CDDL in the runtime, and loading
    Programs serialised in Node with `fromSerialized` and no compiler.
  - **Checks actually run**, all **976 / 0** in both arms:
    - **Node v24.6.0**, from a fresh temporary consumer directory
      (`node_modules/snug` copied from the staged package).
    - **Headless Chrome 156.0.8078.80**, as an esbuild 0.28.2 ESM bundle with
      code splitting, served on loopback with
      `Content-Security-Policy: default-src 'self'; script-src 'self'`.
      A control script confirmed that the policy blocks `eval` and
      `new Function`. Its two blocked probes were the only CSP violations.
    - **workerd 2026-11-02**, locally, with three module-syntax bundles:
      split (lazy compiler chunks), one file (compiler inlined), and no
      compiler.
    - **workerd 2025-12-17**: the same three bundles passed in a repeat run.

    Every verdict, value, encoding and Program container byte was identical
    across the runtimes.
  - **Dynamic code**: none. The 38 produced bundle files and the package's
    `src/` and `generated/` contain 0 `eval(`, `new Function`, `Function(`,
    `WebAssembly.*` compile/instantiate calls, string timers, or non-literal
    `import()`.
  - **Lazy compiler in Workers works**:
    - esbuild `--splitting` makes the compiler separate chunks.
    - workerd resolves `import()` of those chunks during a request when each
      chunk is listed as an `esModule`.
    - A one-file bundle inlines the compiler: still lazily initialised, but
      always shipped.
  - **Sizes** (min+gzip):

    | bundle | gzip |
    | --- | ---: |
    | runtime without the compiler | **56.2 KB** |
    | runtime + compiler, one file | **94.5 KB** |
    | split: loaded at import | 57.5 KB |
    | split: loaded by the first `compile()` | 38.9 KB |
    | `snug/schema` alone | 41.0 KB |
    | codec alone | 11.0 KB |

    For Workers: precompile Programs at build time, load them with
    `fromSerialized`, and leave `snug/compile` out of the bundle. That
    worker passed the full precompiled arm.
  - **CPU per warm call** is the same in Node, workerd and Chrome:

    | op | Node | workerd |
    | --- | ---: | ---: |
    | validate | 16.5 µs | 14.0 µs |
    | decode | 3.1 µs | 3.3 µs |
    | fromSerialized | 264 µs | 273 µs |
    | compile | 3.2 ms | 4.1 ms |

    Inputs: the object-storage `put` request and its 8,785-byte Program.
  - **workerd cold start** (21 interleaved samples, spawn to first response;
    load average 60–120, so wall figures are inflated):

    | worker | median wall − empty | CPU at first response − empty |
    | --- | ---: | ---: |
    | import only | +19 ms | +10 ms |
    | first request loads a Program and validates | +78 ms | **+40 ms** |
    | first request compiles | +281 ms | **+140 ms** |

    The first call runs cold generated code. A fresh Node process shows the
    same shape: first `fromSerialized` ≈ 10–14 ms, second ≈ 2 ms. On a Workers
    plan with a 10 ms CPU limit per request, the first `fromSerialized` in a
    request would exceed the limit. Calling it at module scope, where it runs
    synchronously during startup, is a likely mitigation; it was not measured.
  - **Incompatibility found** (performance only; not fixed here, since
    `host/js/src` is outside this item):
    - **Where**: cooperative yields in `src/sources.mjs`. The code is
      `nextTurn = setImmediate ? … : setTimeout(r, 0)`.
    - **Cause**: browsers and workerd without `nodejs_compat` have no
      `setImmediate`. Chained `setTimeout(0)` is clamped to ≥ 4 ms after five
      levels.
    - **Reproduction**:
      ```js
      scanHandle(bufferHandle(doc), {}, { chunk: doc.length, quantum: 1000 })
      ```
      `doc` is a ~200 KB document; the call yields 130 times.
    - **Measured** (no quantum → quantum 1000):

      | runtime | no quantum | quantum 1000 |
      | --- | ---: | ---: |
      | Chrome | 1.8 ms | **651 ms** |
      | workerd, wall per request | 4.6 ms | 263 ms |
      | workerd, CPU | 2.3 ms | 18.7 ms |
      | Node, CPU | 2.8 ms | 3.9 ms |

    - **Chrome cost per yield**: `setTimeout` 4.77 ms, `MessageChannel`
      0.010 ms, `scheduler.yield()` 0.021 ms.
    - **asyncHandle**: the test helper resolves each read through
      `setTimeout`, so it is clamped the same way.
    - **Proposed fix**: choose `scheduler.yield`, then `setImmediate`, then a
      shared `MessageChannel`, with `setTimeout` last. The session-VM drivers
      share `nextTurn`, so `validateHandle` will inherit the fix.
  - **Learnt**:
    - The npm `workerd/bin/workerd` is a Node launcher. Killing it leaves the
      native workerd running, so the harness resolves the native binary and
      kills process groups.
    - `../3sln.me/node_modules` is gone on this machine. workerd came from
      other read-only installs; set `SNUG_WORKERD`.
    - The repository's baseline codec accepts the NaN float32 typed-array
      oracle input labelled `profile:typed_array`, and mis-decodes it to
      1.6e19. snug refuses it, as labelled. `codec.test.mjs` therefore never
      checks that refusal.
    - Public sources are still profile-only (D106). Schema validation over
      handles is not covered.
- [ ] **P7.9 — Re-take D005** (owner directions 2026-11-03): on the full library
  once the VM is stable, compare the native-JS build against a **wasm build
  wrapped in a JS SDK with the same public API** — what a real JS user gets
  either way. Count the boundary: per-call overhead (fine-grained view/cursor
  navigation and per-field access), copying into linear memory and results out
  (and the zero-copy alternatives: reading wasm memory views,
  SharedArrayBuffer where allowed, streaming chunks into a reusable wasm
  buffer), materialising JS values from wasm output, TextDecoder over wasm
  memory, memory growth that never shrinks, instantiation/cold start (Node,
  browsers, Workers), bundle size including SDK glue, trap recovery. The SDK
  must be designed fairly (batched calls, no needless copies). Workloads:
  validate-only small RPC and ~1 MB messages, decode-to-values, encode, lazy
  navigation of a few fields from a large message, blob-handle/stream
  sources, refusal-heavy input. Deliver a matrix with environment details and
  a recommendation (native JS, wasm+SDK, or both with a rule for choosing),
  recorded as the D005 re-take.
- [x] **P7.8 — Comparison benchmarks** vs cbor-x, cborg, cbor (JS) and
  ciborium, minicbor (Rust) and the `cddl` crate. Done 2026-11-03 by the P7.8
  benchmark engineer; `bench/compare/README.md` (method, versions/licences,
  lockfile hashes, all tables), raw output in `bench/compare/results/`.
  Measured on an Apple M1 Pro (macOS 14.6.1), Node 24.6.0, rustc 1.92.0 native
  and 1.100-nightly for wasm, as thread CPU time on a shared machine (load
  7–12). Each JS library ran in its own isolate.
  - **Decode.** Packages: cbor-x 1.6.9, cborg 6.2.1, cbor2 2.4.1, node-cbor
    10.0.12 and @levischuck/tiny-cbor 0.3.6.
    - **cbor-x is 2–3.5× faster than snug** on every structured workload, and
      5.3× faster on typed arrays. It checks nothing beyond well-formedness.
    - **snug is 2–7× faster than cbor2 in its CDE configuration**
      (+ rejectDuplicateKeys + rejectLongFloats). That is the only JS decoder
      that verifies RFC 8949 §4.2.1 key order and shortest forms as snug does.
    - **cborg strict** checks less (no key order or float form). Against it,
      snug ranges from 1.32× slower (typed arrays) and 1.27× slower (text) to
      2.26× faster (integers).
    - **1 MiB bstr:** cbor-x, cbor2 and node-cbor alias the input buffer and
      snug copies it, so that row shows representation, not speed.
    - **Where the time goes:** snug's check pass is 14–41% of its decode (D017).
  - **Encode.** snug `encode()` is mid-pack.
    - On large integer arrays it is 6× slower than cbor2 CDE. The cause is the
      known dense-array check; the typed Writer does the same array in
      1.35 ms, against `encode()`'s 27.7 ms.
    - On typed arrays and the 1 MiB bstr it is 3–5× slower. Not profiled.
    - The typed Writer is the fastest deterministic producer on all five
      workloads that have a builder.
    - Every deterministic encoder's output was byte-equal to snug's, except
      cborg's typed arrays (untagged) and node-cbor's `Uint8Array` (tag 64).
  - **Found in other libraries:** node-cbor's `encode()`/`encodeCanonical()`
    silently truncate output at ~64 KiB, and `encodeCanonical` retains about
    170 MB per call on 10k maps.
  - **What snug's strict profile refuses that the others accept** (the probe
    table in the README):
    - output of cbor-x (16-bit map heads, float64), of cbor2, node-cbor and
      tiny-cbor defaults (key order), and node-cbor's tag 64;
    - tags 1 and 18, nested integer keys (COSE_Key in a CWT `cnf`),
      undefined, NaN and ±∞.

    D081/P7.1 is where the profile part of that changes.
  - **CDDL validation** (study probes, then the large workloads):
    - **The `cddl` crate 0.10.7:** snug is 7–197× faster in a JS host, where
      both run as wasm; the crate's wasm build was redone here with a plain
      ABI. It is 17–388× faster native. On the workloads: 1.2–91× (JS host)
      and 3.3–437× (native). The crate still gets the same two study verdicts
      wrong.
    - **@cbortech/cbor 0.27.3** is the only maintained JS CDDL validator over
      bytes. It agrees on all 22 probes. snug JS is 2.6–18× faster on the
      probes and 6–13× on the workloads, but 1.25× slower on the typed-array
      schema. @cbortech/cbor overflows the stack on a 120k-element `[* int]`.
    - **cddl.js 1.0.10** (Zod) parses none of the study contracts and has open
      maps.
    - The npm packages `cddl` and `@grinstead/cddl` only check CDDL syntax.
  - **Rust.** snug has no Rust value builder, so the comparison is limited.
    - snug's strict scan takes 0.84–1.43× the time of minicbor 2.3.1's
      unchecked `skip`.
    - ciborium 0.2.2, serde_cbor 0.11.2 and cbor4ii 1.2.4 Value decodes take
      1.3–11× the scan's time. Exceptions: the 1 MiB bstr, which they copy,
      and typed arrays, where snug reads every element.
  - **wasm vs JS.** snug wasm is 1.6–2× faster than JS for the scan and
    1.8–3.3× for the VM, input copy included. The exception is a large
    byte-string body, where the copy costs more than the JS scan.
  - **Sizes**, gzip:
    - snug codec 10.7 KB, against cbor-x 11.3, cborg 8.1, cbor2 14.5 and
      tiny-cbor 2.1 KB.
    - snug runtime 35.4 KB.
    - snug compile entry 67 KB, against @cbortech/cbor's CDDL module at 61 KB.
    - snug wasm 32.7 KB, against the crate's wasm at 832 KB (not stripped).
  - **Learnt (benchmark hygiene):** one library's leftovers distort the next
    library's numbers if they share a V8 isolate, and `process.cpuUsage` under
    parallel GC charges one library's garbage to another. Isolates per library
    plus `threadCpuUsage` with `--single-threaded-gc` fixed this.
  - **Caveats** (all in the README):
    - The machine was shared.
    - The JS runs used the working tree between `0f85e8e` and `d034d68`; Rust
      and wasm are pinned to `0f85e8e`. The working tree's
      `gen/rust/snug/vm/session.rs` did not compile mid-run.
    - Strict configurations are mine, taken from each library's documentation.
    - Not measured: browsers, workerd, cold start, memory, and hostile inputs
      against the other libraries.

- [ ] **P7.10 — usability API fixes** (2026-11-03; engineering follow-up
  to `docs/reviews/2026-11-03-usability.md`; code not changed by the doc pass).
  - **Finding 1 — consistent schema option admission:** validate documented
    limit/budget types (finite non-negative integers) and `top`/`objects`
    enums at all public schema boundaries: validate, decode, validateAt,
    schema-backed view, session, sync/async handle and push validation.
    Reject bad configuration with safe TypeError before inspecting bytes;
    retain ordinary resource exhaustion as ValidationResult. Cross-facade
    regression cases: `maxBytes: 'x'`, negative limits, string budget,
    `maxDepth: 1.5`, `maxBytes: Infinity`, `top: 'banana'` and invalid objects.
  - **Finding 2 — Buffer snapshot ownership:** make both bufferHandle and
    asyncHandle copy accepted byte input without dispatching to Buffer.slice
    (e.g. new Uint8Array(bytes)); retain stable independent reads. Regress
    both Buffer and ordinary Uint8Array inputs by mutating the original
    after construction and verifying unchanged read bytes/validation.
    Docs/examples show the explicit plain-Uint8Array copy until fixed.
  - **Finding 10 — alternative diagnostics:** preserve the existing
    deterministic witness contract by default. Investigate an explicit
    diagnostic mode preferring a matching literal discriminator, with a
    reviewed rule and cross-host tests before changing diagnostic semantics.
    Reproducer: `response = { ok: true, id: uint } /
    { ok: false, error: tstr .size (1..120) }`; `{ ok: false, id: 7 }`
    currently reports value at ['ok'], offset 8, while `{ ok: false }`
    reports missing error. Refusal is correct; document single-witness limits
    (done), do not treat this as an acceptance bug or silently change defaults.
  - **Finding 13 — option-key admission:** reject unknown keys consistently
    in compile, codec, schema/view/source and Writer options, while permitting
    documented preset fields when spread across operations. Regress misplaced
    compile `maxBytes` versus `limits.inputBytes`, `maxByets` at codec/schema
    calls, and unknown grouped limits. Preserve/document Writer grouped-limit
    precedence; review any unified/named options design separately. Compile
    limits and runtime spellings are mapped in the guide; unknown options
    currently being ignored is disclosed, not endorsed as validation.

  *Documentation completed 2026-11-03*: findings 3–6, 7 checklist, 8–9,
  11–12, 14–27 in the authorised files only. Decimal Writer example uses
  value() for integral factory results; Unicode/seven exports and schema
  sources reconciled; errors/recovery and current exceptions, limits,
  ownership/numerics/Map/regexp/source contracts, TypeScript, local package
  handoff and browser/Worker recipes documented. Program §13.3 changes only
  its compatibility paragraph to D084/D100; benchmark additions are the top
  evidence index and archival banners. Historical records remain historical.
  No accept/refuse implementation, host/kin/gen/tools files or declarations
  changed; no commits, dependency installs, publishing or network operations.

  *Checks actually run*: README staging/consumer recipe executed under
  `.cache/docfix/` (new TMPDIR-backed destination, separate ESM project with
  a copied node_modules/snug, file: dependency and producing-revision file);
  consumer printed 7 and all seven bare exports loaded. No npm install.
  The documented main.ts + strict ES2022/NodeNext configuration passed
  semantic checking with offline TypeScript **5.8.3**, read-only from
  `/Users/raystubbs/.nvm/versions/node/v18.20.5/lib/node_modules/@vtsls/language-server/node_modules/typescript/bin/tsc`;
  `bench/compare/node_modules/.bin/tsc` and PATH tsc were absent.
  Final guide snippets checked Decimal factory cases, Unicode and regexp
  escaping/matching, limits, ownership mutation, choice witness, known-length
  AsyncIterable validation and isolated compilation. Browser ESM split
  bundle retained dynamic imports; compiler-free Worker output contained
  no compiler/Unicode table contribution (esbuild 0.28.2 metafiles checked),
  and its handler validated a request in Node. No fresh Chrome/workerd run:
  their matrix remains scoped to f275938. Local doc links/anchors and
  git diff --check passed. Final **cd host/js && npm test: 1,058 passed,
  0 failed, 0 skipped**, Node v24.6.0 / npm 11.5.1, at c15a722 plus this
  worktree; includes all seven examples and isolated staged-package tests.
  Log: `.cache/docfix/npm-test.log`. Existing unrelated DEVLOG/bb.edn/
  tools/proptest work was preserved.
  *Learnt*: capability evidence must name its revision and API boundary:
  P7.7 tested f275938 before Unicode/schema sources; a Promise-shaped loader
  still verifies synchronously. Build destinations are guarded by runtime
  temporary roots, not gitignore status. Decimal factories preserve exact
  numeric values but discard scale and can return integers. Current schema
  option coercion and Writer sticky argument faults require explicit public
  caveats until the separate engineering fixes land.

## P7.11 — Rust public API

- **Status (2026-11-03): complete for the requested restricted-profile API;
  no commits.** D119 records the representation and boundary choices.
  New `host/rust/src/{value,error,decode,encode,writer,program,view,api}.rs`
  expose exact owned values, scanner-first decode, kin-backed encode/Writer,
  compiled Schema with caller-owned Scratch, serialised Programs, checked
  borrowed views/cursors and the existing blob session driver. Legacy hosts
  remain available. The assembler copies integration tests and supplies nav/
  write modules to legacy default-host subset callers; `bb rust-api-test`
  runs Cargo debug tests/doctests and optional offline Clippy.
- **Coordination:** schema.rs/compile.rs, kin/, gen/ and host/js are not edited
  by P7.11. During the gate, concurrent P7.1 generated Rust had missing type
  annotations in cbor/scan.rs (`scan_std_tag`) and vm/dead.rs, preventing a
  live build. A scratch snapshot of generated code/JS/corpus at
  `cbbe6b8f66565c35241bb1f4cc5a2a8f2a7c01c7` is used to isolate API defects;
  its initial 11 integration tests passed. The P7.1 owner then repaired the
  declarations, and live-tree gates passed too. The JS default changed to
  deterministic during the final gate; fixtures now select profiles.bindle
  explicitly, matching this Rust facade's scope. No change to protected
  schema.rs/compile.rs was needed.
- **Checks actually run:** final `bb rust-api-test` exited 0, assembling the
  live working tree at cbbe6b8f plus concurrent P7.1 edits and P7.11. Cargo
  **1.92.0**, rustc **1.92.0** (Homebrew), Node **24.6.0**, offline, debug with
  overflow checks on. **1 existing library test + 12 integration tests + 9
  rustdoc tests + 5 guide examples + 1 README example passed; 0 failed.**
  All existing test-host binaries also compiled under cargo test.
  - All **216 profile vectors (74 accept / 142 refuse)**: exact JS code
    identity; accepted decode→encode byte identity and checked-view values.
    **1,024 seeded byte mutations + 3 COSE probes** also match JS codes.
  - **512 independently generated Rust/JS values** encode byte-identically;
    Rust decoded values re-encode identically.
  - All **45 cases from six study contract suites** match JS verdicts,
    reasons, paths, offsets and subcodes. The same cases match buffer results
    through the session/blob driver at chunk sizes **1, 7 and 65,536** with
    quantum 7 (**135 source validations**).
  - Six JS contract Programs load and reserialize in Rust; Rust compilation
    produces identical containers and JS loads/reserializes those containers.
    An additional bounded compiler-profile/limit configuration has identical
    JS/Rust container bytes. Framing, digest, major/minor refusals, verifier
    refusal, and differing producer-version retention are checked.
  - **8,192 arbitrary byte inputs / malformed containers + 1,024 Program-word
    mutations** produced no panic in the exercised APIs. Exact numerics,
    typed bits/NaN refusal, Writer grammar/sticky failure/duplicates, borrowed
    cursor navigation, unaligned typed reads, safe diagnostics, source short
    reads/range overflow, shared schemas with separate thread scratch, zero
    VM budget, named caps, huge counts and the **depth-256 boundary** passed.
    A compile-fail doctest proves mutation while a checked view is live is
    rejected by Rust.
  - Offline **Clippy passed with `-A clippy::absurd_extreme_comparisons`**.
    Unmodified generated compile/ctl.rs compares i32 against INF == i32::MAX;
    the raw Clippy run fails that default-deny lint. Other lint levels remain
    intact; existing generated/legacy warnings remain, with no diagnostics in
    the new API modules/tests in the final log. `sh -n` on the scripts and
    `git diff --check` passed. Gate log: `.cache/rust-api-test.log`; Clippy:
    `.cache/snug-rs/clippy.log`. Babashka prints a sandbox ProcessHandle
    cleanup warning on shutdown; the final task and child checks exit 0.
- **Limitations:** the Rust facade intentionally selects Bindle restrictions,
  even as P7.1 adds general flags/presets elsewhere. Output growth defaults to
  a 1,500,000-byte cap; this differs from JS's optional finish-only cap.
  Writer content refusals may surface at finish. The requested validate
  signature reports unknown-rule API misuse as Failure code −1. Blob driving
  is synchronous/known-length, with no async/unknown-length adapter, source
  decode, unchecked opener, view directory or sorted-key Writer mode. Standard
  allocator exhaustion behavior remains; byte limits are not a total heap
  quota. Program origins must be trusted under D084. No wasm public facade,
  broader release gate, dependency installation, publishing or emission is
  claimed by this item.
- **Learnt:** preserve negative CBOR arguments rather than absolute magnitudes
  to cover −2^64 without overflow; retaining typed bit patterns also preserves
  signed zero/infinities and every accepted vector. Shared Rust borrows replace
  the JS copy-or-promise ownership contract directly. Corpus/oracle gates must
  name their wire profile explicitly when defaults evolve concurrently.
  Container byte identity tests cover named compiler-limit wiring as well as
  SHA-256/version framing; a pinned scratch baseline isolates API defects but
  must be followed by a live-tree gate. Clippy's generated-code diagnostics
  need a narrow documented allowance, not edits to emitted Rust.

## Parking lot

- Lazy DFA cache over typesets (architecture §4.1).
- Discriminator-first dispatch for choices of maps, or the lazy DFA cache
  above (P3.6, 2026-10-29; contracts accepted at 10–29× the scanner for now).
  Analysis: the study contracts' maps are choices of several map types, and
  type-set evaluation advances every alternative in parallel — e.g. a
  request's `args` value is evaluated against six map types until `method`
  decides — so the work is the §14 work itself (253 units for a 59-byte
  object-storage request) at ~20 ns/unit on the generic path; fast paths
  cannot remove it. Two ways out: (a) the compiler detects a literal-valued
  key whose literals partition the alternatives (a discriminator), and the
  VM looks that key up first and evaluates only the matching alternative —
  needs a Program addition, and the walk order (pairs in input order, with
  path and witness rules) must not change observable results; (b) a lazy
  DFA cache over (typeset, input class) transitions, which helps repeated
  shapes but not first sight. Both are larger designs with a §14 question
  (what does a discriminated pair cost?).
- Explicit-stack, resumable VM for chunked input (D016).
- Go/Java/C# targets (D006).
- CDDL over JSON.
