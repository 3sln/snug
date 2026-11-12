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
    log) and is not counted. Standalone at `3551d7a` (session VM committed):
    `vmsession-test 60000 1001 1200 180` **ok** in 1,488 s (1,841,136 session
    runs == vm-validate's whole out array, 1,205,083 JS == Rust, 8,028
    validateHandleSync == validate_blob == Schema.validate); the 10× run
    (200000/1001/4000/600) was stopped by P4.2 after 5,497 s without
    output at load average 60–130. `compile-fuzz 30000 1001` **ok** in 344 s
    (4,491 compiled / 25,509 refused; slowest 1,838 ms, the same chain).
  * **harness bugs found and fixed while building** (not snug): an unbounded
    structural reader on mutated bytes (worker OOM), ANY-schema comparisons
    without the codec's map root, a COSE subtree built without `cose`, and
    the exponential oracle taking ~5 s on hostile texts (a false hang; D116).
  * **oracle bugs: 0; oracle mismatches: 0** in 8.7 M verdicts;
    documented differences: none needed beyond D118's normalisation.

  **Snug bugs: 1 (S1), already fixed upstream by `654cdf8`.**

  *Checks actually run*: the 66.9-min campaign above; the 15-min
  confirmation campaign at `3551d7a`; standalone gate re-runs at `3551d7a`
  (vmsession-test 60000/1001/1200/180 ok, compile-fuzz 30000/1001 ok, write-test 3000/1005 and 3000/1009 FAIL by the harness trailing-space bug above, reproduced exactly); `node --check` on every tools/proptest module.
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
  **Open**: ~~D085's unknown-length drain mode~~ (done: P6.4b, D144–D147); arena pooling and a bound on live sessions (each
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
- [x] **P6.4b — Unknown-length streams (D085)**: drain mode in the session
  VM, fail-fast, host APIs. *Done 2026-11-03 by the VM-features engineer
  (Claude); the commit after `48ed8ea`.* Decisions **D144–D147**.
  - **kin** (`vm-session*.kin`): `vms-init-unknown` (provisional end = the
    input limit), `vms-eof`, `vms-held-code`, `vms-unknown-total`,
    `VMS_HELD` (-67) / `VMS_RESUME` (-68), `PH_HELD`; session header words 38
    `SS_UNK`, 39/40 the pending area (4 words a check, frames + 2 entries;
    `SS_HDR` 40 -> 44). Pending checks at `open-text`, `open-bstr`,
    `enter-pend` (4 container frames), a typed array's content (tag frames)
    and `skip-bstr` (byte strings walked from their head); held verdicts via
    `settle`; root-end's trailing probe; prescan refusal stops inside a
    container make it cross in unknown mode (`pstop`, `rstop`); no dead-typed
    shortcut; at EOF the ends equal to the provisional one become the real one
    and a crossing key being copied finishes over its arena copy (D144).
  - **JS:** `schema.session(rule, undefined)` (`held`, `end(n)`, `limit`),
    `pushValidator(schema, undefined, …)` / `pushScanner(undefined, …)` with
    `failFast`, `end()`, `bytesHeld`; `streamSource`, `validateStream`,
    `scanStream` (an early verdict cancels the stream); the scanner's drain
    mode runs the VM against a built-in `any` Program (`any-program.mjs`,
    checked against the compiler by a test) (D146); `failFast` admitted in
    options.mjs; types. **Rust:** `Session::new_unknown`, `Session::end`,
    `Session::limit`, `Step::Held`, `schema::validate_reader`,
    `Schema::validate_reader` (any `std::io::Read`).
  - **Gates (actual runs, Node v24.6.0, rustc 1.92, this tree, defaults
    unless noted):** **vmsession-test** (seed 1) session == buffer
    969,521/969,521, traps 91,201, interleaved 9,501, JS == Rust 628,417, hosts
    8,247; **unknown length (drain) 474,486/474,486 streams give the buffer's
    whole out array** (whole / byte / rnd7 / rnd300 73,834 each, split 164,383,
    part-way budgets 14,767; 36,351 behind traps); **fail-fast 73,834/73,834
    accept iff the buffer accepts** (71,440 with the buffer's out, 2,394 refused
    early with another code / offset); **unknown length JS == Rust
    99,677/99,677**; seed 7 also green (476,082 drain, 99,677 JS == Rust).
    The runner never tells the session the length, gives no window past the
    bytes "delivered" and fails any ask before a keep already given. `bb
    check`, scan-test, rscan-test, compile-test, compile-fuzz, nav-test,
    write-test, unicode-test, **rust-api-test** (new `tests/streams.rs`:
    `validate_reader` == buffer under read sizes 1/2/3/64, fail-fast verdicts,
    too_large past `max_bytes`; the docs/rust.md doctest), **vm-test**
    (unchanged numbers) all ok; **npm test 1,298 passed / 0 failed** (6 new in
    `stream.test.mjs`: every chunking == buffer and fail-fast accept/refuse,
    ReadableStream sources and early cancellation, drain reads to the end,
    too_large at once, ≤ 2 KiB held while a 200 KB byte string streams, the
    built-in `any` Program == the compiler's and unknown-length scanning == the
    scanner); `bb drift` ok after the commit.
  - **Learnt:** (1) "an item the window holds whole cannot diverge" is the
    whole argument, but "whole" had two leaks -- a byte string walked from its
    head (its content claim passes against the provisional end), and a
    prescan that stops at a refusal *inside* a container (the container's
    count was checked against the provisional end, not the bytes); both found
    by the runner on mutated inputs. (2) A forward-only stream must never be
    asked for a byte before a `keep` it was given: the first EOF handling of a
    crossing key reset the pair to its start and asked for its head again --
    bytes a real stream had dropped; finishing the pair over the arena copy
    needs nothing dropped. The gate's runner now enforces the keep rule. (3) A
    window is a claim that its bytes exist (D147): an empty window past the
    end silently settled a pending check. (4) Three more leaks the full gate
    found: a bignum decided from its content's head (its content claim; live
    ones take the check's moment from a trial walk ending at the window, since
    the tag's filter and number tests come first, and a depth refusal
    precedes it), a non-text map key refused inside after a count that claims
    past the window (`key-max-claim`: the window must reach the claim), and an
    out-of-window head read the Rust debug build caught (JS reads `undefined`).
  - **Open:** the unknown-length key arena is sized for the input limit
    (1.5 MB by default per session) -- an on-demand arena would need a grow
    protocol at every arena write; no Rust async driver; the wasm shim and
    SDK have no unknown-length or extension-control port; unknown-length
    profile scanning costs the VM's dead walk, not the resumable scanner's;
    no benchmark of drain mode yet (P6.4).

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
*Re-taken 2026-11-03 on the full library (P7.9): see **D130**. The generated
JS stays the default JS package; a wasm build behind a JS SDK with the same API
is the opt-in for VM-heavy hosts that can run wasm (bench/D005.md).*
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

### D120 — Profile options are one kin flags word, zero being the Bindle profile (P7.1)
**Decision** (profile engineer, provisional; implements D081): every
wire-profile option is a bit field of one integer, `PF_KEYS` (bits 0–1: text,
text + integer, any), `PF_TAGS` (bits 2–3: Bindle set, standard set),
`PF_FLOATS` (bit 4), `PF_UNDEFINED` (bit 5), `PF_NONCHAR` (bit 6), plus the
internal `PF_SUB` (bit 7: the walk's root is not the document's top). It
lives in the scanner block's word 11 (`O_PROFILE`, one of program.md §12.1's
scanner-reserved words), set by `scan-profile` after `scan-options` (which
writes 0); the VM takes it as limits word 9 (absent or negative = 0) and
copies it there in setup, adding `PF_SUB` for spans below the root. **0 is
the Bindle profile** and every set bit admits more; the deterministic preset
is 118. Every check reads that one word (scanner, resumable scanner, buffer
VM, dead walk, session), so the fused VM walk is the scanner's policy by
construction. Programs do not record a profile and compilation never reads
it: Program words, the container and `SOURCE_KEY` are unchanged, so this is
not a format version change (D084). Hosts resolve options to flags only
(`host/js/src/profiles.mjs`, Rust `snug::Profile::flags`).
**Why**: the frozen 16-word block had reserved words, so no layout change;
an all-zero (never filled) word failing safe to the strictest policy means
every existing gate, host and stored caller keeps its exact pre-P7.1
behaviour, and the default changes only where a host deliberately sets 118.
A run-time option keeps one Program usable under either preset.
**Alternatives**: separate words per option (more ABI for no gain); zero as
the deterministic preset (an unfilled array would silently widen
acceptance); recording the profile in the Program (couples caches to a
run-time choice); a new limits array layout (breaks D084 callers).
- [ ] **Signed off** (owner)

### D121 — The standard tag set and its content rules (P7.1)
**Decision** (profile engineer, provisional): the standard set is the Bindle
set plus 0, 1, 21, 22, 23, 24, 32 and 55799 (32-bit tag numbers only; no
"any tag" level yet). Their content is an ordinary item (counted, one level
below the tag) walked first; then, refused with `tag` at the tag's head:
tag 0 needs RFC 3339 `date-time` text (T/Z either case, field ranges, the
day within its month and leap years, seconds to 60); tag 1 an integer or a
finite float (RFC 8949 §3.4.2 discourages non-finite epochs); tag 32 text
matching RFC 3986 `URI` at the character level (scheme, permitted
characters, `%HH`, one fragment, brackets only before the query/fragment —
the authority/IP-literal grammar is not parsed); tag 24 a byte string whose
payload is then walked as one item two levels below the tag under the same
profile, bounded by the string (its own codes and offsets; `trailing` after
the item); 21–23 any item; 55799 any item, only at depth 0 of the document
(`PF_SUB` clear). The Bindle tags keep their rules in both sets. Kin owns the
rules (`kin/stdtags.kin`); the Writer runs the same functions after writing
a `Tagged` value's content. VM charges: 1 unit per standard tag check, plus
⌈len/64⌉ for a tag-0/32 text's form scan; the payload walk is charged as
dead items.
**Why**: these are RFC 8949's registered core tags whose decoders a general
library is expected to read; checking their content keeps "valid snug CBOR"
meaningful (a date tag holds a date) and every rule only refuses. Walking
the content first keeps refusal precedence uniform across all walkers.
**Alternatives**: accept any tag (a later `PF_TAGS` value can add it; COSE
tags 16–18/61 are refused today); type-only content checks (weaker for no
gain); full RFC 3986 parsing in kin (large; deferred and documented).
- [ ] **Signed off** (owner)

### D122 — Deterministic floats: shortest forms and the canonical NaN only (P7.1)
**Decision** (profile engineer, provisional; answers D081's open question):
under `PF_FLOATS` every float must be in its shortest exact width, so ±0,
±∞ and NaN occur only as float16; the only NaN is the canonical quiet NaN
`f97e00` (RFC 8949 §4.2.2's recommendation): any other NaN — a sign bit, a
signalling NaN, a payload — is `float`, and the canonical NaN in a float32 or
float64 is `non_shortest`. Integral floats are accepted (RFC 8949 §4.2.1 does
not forbid them; dCBOR does). The writer's `put-float-rfc` maps every NaN to
`f97e00`. Float ranges compare as IEEE 754: a NaN is in no range and a zero is
in a range holding the key of +0 or −0 (two adjacent keys); literals still
compare encodings.
**Why**: one encoding per value is the point of a deterministic profile, and
NaN payloads are not portable values; refusing the rest keeps the rule exact
and testable by bit tests. Integral floats are distinct CBOR values in RFC
8949's data model.
**Alternatives**: accept any shortest NaN (non-unique encodings of "NaN");
refuse integral floats (dCBOR's rule, not §4.2.1's); keep Bindle's
refusals as the default (contrary to D081).
- [ ] **Signed off** (owner)

### D123 — JavaScript values for the deterministic data (P7.1)
**Decision** (profile engineer, provisional): a map with only text keys
decodes to an object as before; a map with any other key decodes to a `Map`
whose keys are decoded values (a cose top-level map stays a `Map`); the
builder restarts a map as a `Map` when a non-text key follows text keys (only
majors 4–7 sort after text). Distinct CBOR keys that are one JS `Map` key
(1 and 1.0, 0.0 and −0.0) are refused by decode with `unsupported` (a view
still reads them). Standard-set tags decode to a frozen `Tagged { tag, value }`
(tag 24: the payload bytes); `f7` to `undefined`; floats to the number.
Encoding takes `Map` (keys as the profile admits), `Tagged` (kin-checked) and
`undefined`; holes stay refused. Rust: `Value::Undefined`, the existing
`Value::Tag` and `Value::Map` pairs.
**Why**: a general CBOR library must round-trip integer-keyed (COSE/CWT)
data; Maps are the only JS container with value keys. A generic Tagged keeps
round trips exact without guessing Date semantics; silent key collisions
would lose data.
**Alternatives**: always a Map (breaks every text-keyed caller); Date for tag
0 (loses offsets and precision); lazily decodable wrappers for tag 24 (left
to `decode(t.value)`).
- [ ] **Signed off** (owner)

### D124 — Resumable drivers read tag-0/24/32 contents and non-text keys whole (P7.1)
**Decision** (profile engineer, provisional): the content rules of tags 0,
24 and 32 need the whole content; the resumable scanner asks for it whole
before walking it (and walks it without yielding), the session pins the
content start (D094) and re-reads it after the content's walk (`T_STDCHK`).
A map key that is a container or tag is asked for whole and walked by the
recursive scanner (rscan) or the buffer walk (session; the session also asks
for byte-string and float keys whole, by a structural extent `key-end-any`
that asks for doubling windows); byte-string, bignum and integer typed-array
content inside an active rscan key goes through the windows (`PH_KSKIP`) so
the key arena receives it. The session's prescan admits standard tags.
**Why**: these are bounded by the document (`maxBytes`), the existing
replay/whole-piece mechanisms (D090, D092, D094) cover them, and nested keys
would otherwise need a stack of key arenas.
**Alternatives**: incremental date/URI/payload automata across windows
(much more state for rare large contents); a per-frame key arena stack.
- [ ] **Signed off** (owner)

### D125 — The compiler no longer assumes the wire profile (P7.1)
**Decision** (profile engineer, provisional): a `:` member whose key is a
byte-string, float or beyond-64-bit integer value (`h'00': T`) was compiled
as a member that can never be present (absent if optional, the alternative
unsatisfiable if required) — a Bindle assumption. It is now a `map_cut`
schema error under `full` (the compiler restriction sets still answer
`profile` first): colon implies a cut, and cuts are supported only on text
and integer literal keys. `h'00' => T` (no cut) compiles as before.
**Why**: under the deterministic preset such keys reach the VM, so the old
lowering silently refused valid data; Programs must not depend on a run-time
profile (D120). Refusing is exact; supporting cuts on these keys needs KEYS
entries of majors 2/7 (a D084 minor) and is left open.
**Alternatives**: drop the cut (changes the meaning when another entry's key
domain overlaps); extend the KEYS table now (a format change beyond P7.1).
- [ ] **Signed off** (owner)

### D126 — The JS wire selector is `wire`; both hosts default to the deterministic preset (P7.1)
**Decision** (profile engineer, provisional): JS options gain `wire:
'deterministic' | 'bindle'` (the preset) and the per-option overrides `keys`,
`tags`, `floats`, `undefinedValue`, `noncharacters`, on decode, encode, the
Writer, views, profile sources and schema calls; `profiles.deterministic` and
`profiles.bindle` spell them out (bindle also `top: 'map'`, `strictArrays:
true`). The codec/view/source root default is the preset's (`any` for
deterministic). Rust: `Profile` (`DETERMINISTIC`, `BINDLE`, fields) in
`DecodeOptions` / `EncodeOptions` / `ValidationOptions`, defaulting to the
deterministic preset; `schema::Options.profile` carries the flags. Tests that
hold the codec to cbor.mjs select the Bindle preset explicitly.
**Why**: usability review finding 7 asked for a wire selector distinct from
the compiler's `profile` (a restriction set); D081 makes deterministic the
default, in both hosts alike.
**Alternatives**: reuse `profile` (two meanings, and spreading a preset into
compile options would select a compiler profile); keep Rust on Bindle
(cross-host defaults would differ).
- [ ] **Signed off** (owner)

### D127 — The deterministic preset admits Unicode noncharacters (P7.1)
**Decision** (profile engineer, provisional): a sixth option, `noncharacters`
(`PF_NONCHAR`), beyond D081's list: the deterministic preset accepts text
holding U+FDD0..U+FDEF and U+xFFFE/U+xFFFF (well-formed UTF-8 scalar values);
Bindle refuses them as before. The UTF-8 functions take the flag
(`utf8-seq`, `utf8-invalid-at`, `utf8-window`).
**Why**: RFC 8949 text is any well-formed UTF-8; noncharacters are valid
scalar values that JS strings, cbor2 and the Unicode tables (D083) all carry.
Refusing them by default would contradict "deterministic = §4.2.1".
**Alternatives**: keep the refusal in every preset (a Bindle-only rule in the
general default).
- [ ] **Signed off** (owner)

### D130 — D005 re-taken: native JS stays the default; wasm + SDK is an opt-in, chosen by rule (P7.9)
**Decision** (recommendation; the owner signs off):
- **Default: the generated-JS package (`snug`)** for every JS host.
- **Opt-in: the Rust build as wasm behind the JS SDK** (`host/wasm-sdk`, the
  same public functions). A user should choose it when all three hold:
  1. the hot path is the validator VM or the compiler: validate,
     `schema.decode`, views over large messages, handle/stream sources,
     refusal-heavy traffic, or runtime compile;
  2. the host can run wasm: `'wasm-unsafe-eval'` in a page's CSP, a `.wasm`
     module binding in Workers, and one `await init()`;
  3. a linear-memory high water that never shrinks is acceptable, or the app
     calls `reset()` / `view.release()`.
- **Stay native even then** when validating large byte-string bodies held in
  JS buffers (the copy in), when encoding large integer arrays in a browser or
  workerd, and when many views are held.
- **First release:** native ships; the SDK ships, if at all, marked
  experimental, with its parity test made a gate.

**Why** (bench/D005.md, measured at 93f8718 on a load-100–150 machine;
Node CPU medians, interleaved):
- **wasm is faster on VM and scanner work.** In Node, Chrome and workerd the
  wasm SDK takes 0.38–0.62× native's time on validate, views, sources and
  refusal-heavy input. Compile takes 0.10–0.24×, with byte-identical Programs.
- **The boundary is small.** A per-step wasm call costs about 5–8 ns more
  than the same kin function in JS. Batched navigation (`path()`, paged
  `entries()`) measured the same as per-step calls.
- **Codec work is mixed:**
  - decode 0.65–1.40× (the JS builder dominates);
  - encode 0.44–1.01× in Node, but 1.25–1.54× on large integer arrays in
    Chrome and workerd.
- **The copy can dominate.** Validating a 1 MiB bstr body takes 3.4×
  native's time: 75 µs against 22 µs, because the copy costs 61 µs per MiB.
  With the bytes already in linear memory it is 9 µs.
- **Native wins on the rest:**
  - It runs under a strict CSP. wasm needs `'wasm-unsafe-eval'`.
  - It needs no init. workerd refuses to compile wasm from bytes at run time.
  - Its memory returns to the GC. 100 dropped 1.4 MB views keep 136 MiB of
    linear memory until reset; native returns to 0.1 MiB after GC.
  - It is smaller: 57 KB gzip for the runtime, against 60–83 KB for the wasm
    module plus 16 KB of glue.
- **Cold start is close.** Node, Chrome and workerd first-request costs come
  out similar: wasm pays the compile, native pays cold JIT.

**Alternatives** (all rejected):
- wasm only: CSP, Workers packaging, init and memory costs for every user,
  including codec-only users who gain nothing;
- native only: leaves the 1.6–2.5× (compile 4–10×) VM speed unused for the
  hosts that can take it;
- a hybrid, wasm check plus JS navigation: a sum of measured medians,
  13.4 ms, against 9.1 ms all-wasm.
- [x] **Signed off** (owner, 2026-11-04, in session via the coordinator): native JS is
  the default and the wasm SDK is opt-in. Approved.

### D131 — The wasm SDK's shape (P7.9)
**Decision**:
- **wasm modules:** a plain integer ABI, no wasm-bindgen, no imports.
  - The runtime module is `host/wasm/src/sdk.rs` (cargo feature `sdk`). It
    uses std's allocator, so it starts at 1.06 MiB and grows on demand.
  - The compiler is a second, lazily loaded module: `host/wasm/src/cc.rs`
    over the unchanged `host/rust/src/compile.rs` (feature `compiler`).
  - The P1.4/P3.4 module, the default build used by the gates, is unchanged.
- **The SDK, per API:**

  | API | Design |
  | --- | --- |
  | decode | wasm check, then the native JS builder over the caller's bytes |
  | encode | the JS walk (native admission rules) writes a tape into linear memory; one wasm call applies kin's writer primitives, with keys sorted before values |
  | validate | one call over a reusable, growable input buffer; out words read in place |
  | Programs | live in wasm; JS keeps copies for the public accessors and reloads after instance loss |
  | views | a per-view copy in linear memory, a call per navigation step, plus `path()` and paged `entries()` |
  | sessions | state and window in linear memory; the push buffer *is* the window |

- **Instance loss:** a `WebAssembly.RuntimeError` or engine RangeError
  escaping a wasm call resets the instance and throws `InstanceLost`.
**Why**: each choice crosses the boundary once per unit of work, and copies
only what JS must own. V8 reports wasm stack exhaustion as a RangeError and
leaves the shadow-stack pointer behind, so the instance cannot be trusted
afterwards.
**Alternatives**:
- a value-builder tape for decode (not built: the bytes are already in JS);
- a wasm call per head when encoding (measured: 22 ns against 14 ns per
  call);
- unpaged batched `entries()` (measured: 10× slower when iteration stops
  early);
- static buffers sized for the default bounds (that is the old module, with
  about 17 MiB of initial memory);
- SharedArrayBuffer memory (needs a threads build, and reintroduces
  mutation-under-check).
- [ ] **Signed off** (owner)

### D132 — API differences a wasm SDK cannot avoid (P7.9)
**Decision**: if the SDK ships, document these as its contract:
- `await init(source)` or `initSync(module)` first;
- `bytes()`, `raw()` and `typedView()` copy, and `borrow` is ignored;
- view memory is freed by a FinalizationRegistry, or now by
  `view.release()`;
- `reset()` and `trim()` exist, with `memoryBytes()` to observe;
- with several encode faults in one message, the one reported may differ;
- the encode tape refuses nesting beyond 4,096 levels;
- Unicode compile tables and the public `Writer` are not ported yet.
**Why**: aliases into linear memory are detached when memory grows and freed
with the view. Browsers deliver wasm asynchronously, and workerd only as an
imported module.
**Alternatives**: hide init behind top-level await (rejected: workerd and
some bundlers refuse it); keep aliases valid until the next SDK call
(rejected: a silent use-after-free class).
- [ ] **Signed off** (owner)

### D140 — Extension controls: an EXT leaf decided by a host predicate inside the combinator pass (P7.2)
**Decision** (VM-features engineer, provisional; implements D082): `target
.name argument` with `.name` registered lowers to one EXT leaf (control id,
the argument's CBOR encoding, the control's maximum item bytes) and
`AND(t, EXT)` for every leaf t of the target, so the EXT never answers alone.
The VM decides an EXT only in `finish-comb` (the item's end, after its whole
walk, so the item's encoding [pos, end) is known and profile-checked), only
when a combinator needs it -- an AND's first operand, its second operand once
the first matched, a NOT's target -- and at most once per item. Charge: 1,
then (when the item is no longer than the maximum) 1 per item byte, then the
predicate; longer than the maximum: reason `control_size` (43) for the 1 unit,
never asking; predicate false: `control` (42). The host port is a value, not a
global: a kin tag `Ext` (snug.lang; JS a function, Rust `&dyn Fn(i32, &[u8],
i32, i32, &[u8], i32, i32) -> bool`) threaded as the last argument through
the 30 live-walk and session functions that reach `finish-comb`; the
existing entry points keep their signatures and pass `ext-none`
(`vm-validate-x`, `vm-validate-span-x`, `vms-step-x` take a predicate).
**Why**: an ordinary leaf keeps type-set exactness (D010) for free; deciding
it lazily never asks about an item whose target already failed; deciding it
at the item's end gives containers their whole encoding; a threaded value is
reentrant and thread-safe, and needs neither a `@kin:link` host module nor
generated code importing host files (the package staging rewrites only
generated imports). Charging per byte bounds a hostile message's predicate
work by the budget (predicates are arbitrary host code).
**Alternatives**: a `@kin:link` host form with a global/thread-local registry
(not reentrant; generated JS would import a host path); D032's two-round call
(the recursive buffer walk cannot suspend: one restart per query); a
post-validation callback pass (D082 rejected it: no single derivation);
deciding every admitted EXT eagerly (asks about items the target refused);
charging ⌈len/64⌉ like built-in scans (host code is not kin's cost).
- [ ] **Signed off** (owner)

### D141 — Format 1.1, the registry in the compiler options and the source key, binding at load (P7.2)
**Decision** (provisional): Program format **1.1** (D084: an additive minor)
= leaf kind 18 EXT (d0 id, d1/d2 argument pool span, d3 maximum, mask ALL),
FLAGS bit 4, header words 30 `N_EXTS`, 31 / 39 the pool span of the used
controls' names (deterministic CBOR text strings, strictly ascending, 1..64
bytes `[A-Za-z_][A-Za-z0-9_-]*`; id = position). The compiler writes 1.1 only
when an EXT is used: every other Program stays byte-identical 1.0. vm-verify:
format word 1 or 0x00010001; under 1.0 words 30/31/39 zero and no kind 18;
the name table (check `C_EXT` 24); EXT fields; no EXT as a typeset answer.
The registry rides after the 19 compile option words (`opt[19]` n, `opt[20]`
flags with bit 0 = admitted under `bus`, then name length, maximum, name
bytes, sorted; kin refuses a malformed one as `control_registry`, 55), so the
compile entry point and every older host are unchanged. SOURCE_KEY: with a
registry the preimage has 8 elements -- the 7th the D110 Unicode words or
`[]`, the 8th `[flags, [[name, max]...]]` over the WHOLE registry. Loading a
1.1 Program (`fromSerialized(bytes, { controls })`, `fromProgram`, `new
Program(P, B, { controls })`; Rust `deserialize_with`, `from_parts_with`,
`Schema::from_serialized_with`) binds each named control; a missing one is
`ProgramError('missing_control')` / `Error::MissingControls`, naming it.
The `bus` profile refuses EXT (`profile`) unless the flag admits them. An
unregistered `.name` stays `unknown_control`; hosts add the name to the
message from kin's new `error-offset`.
**Why**: additive and opt-in (D084's minor rule), caches cannot mix
registries, untrusted-schema profiles do not run host code by default.
**Alternatives**: a 20th Program section (moves S_END; a 1.0 loader would
mis-walk it); ids in registry order (Programs would need unused controls at
load); max bytes as a call option (sessions and buffers must agree; a
Program-carried value makes every source give the same answer).
- [ ] **Signed off** (owner)

### D142 — Generic controls in kin, argument literals, compile-time argument checks (P7.2)
**Decision** (provisional): `.chars n | lo..hi` (code points of a text
string), `.unique <any>` (pairwise distinct element encodings of an array:
heap sort of element spans in host scratch, O(n log n), no allocation in
kin), `.samelen "a" | [names]` (equal element counts of the named, present,
array / typed-array members of a map) are kin functions (`snug.vm.controls`)
wrapped by `snug/controls` and `snug::controls`, so JS == Rust by
construction. A control argument is the CBOR encoding of a literal
controller: integer, text, bytes, a named simple value, a range `lo..hi` as
`[lo, hi]` (inclusive; `...` already normalised), or an array of those;
anything else is `control_value`. A registered control may supply
`argument(bytes) -> bool`, checked once per use after compilation
(`control_value` naming it); the generic controls do. Compile-time literal
membership in an EXT is unknown, so `.eq`/`.ne`/`.and` never fold through one
(AND / NOT kept) and map determinism treats it as possibly matching (stricter
only).
**Why**: one implementation for both hosts; arguments as plain CBOR keep
predicates host-agnostic. **Alternatives**: host-written generic controls
(two implementations to keep equal); arguments as typesets (no literal form
to hand a predicate).
- [ ] **Signed off** (owner)

### D143 — Sessions take an EXT item whole up to its maximum (P7.2)
**Decision** (provisional): before routing an item whose query list holds an
EXT leaf, the session asks for min(largest EXT maximum, bound − pos) bytes from
the item's start and prescans with that cut: if the item ends there, the
buffer walk takes it whole (whatever the quantum); otherwise it is longer
than every such maximum, so each EXT fails by size before asking and the walk
goes on as routed (frames need no item bytes for that). A byte string no
leaf reads is otherwise walked from its head alone, so the rule runs whatever
`direct` was decided. Map keys are already whole (D092).
**Why**: verdict, offset, budget and items equal the buffer's under every
split (gated); a stream buffers at most the control's maximum for it.
**Alternatives**: retaining every crossing item's bytes (unbounded); a
per-item EXT byte cursor (predicates take whole items).
- [ ] **Signed off** (owner)

### D144 — Drain mode: a provisional end, pending end checks, held verdicts, settled at EOF (D085)
**Decision** (VM-features engineer, provisional; implements D085): an
unknown-length session (`vms-init-unknown`) is a known-length session whose
end is the effective input limit P. Every check whose outcome depends on the
real end n is either (a) re-run once n is known, or (b) recorded as a
**pending check** when it passes against P with a claim beyond the window:
`(claim, offset, budget used, items)` -- exactly what the buffer walk answers
(`cbor/truncated`) if n < claim. (b) is needed only where the walk commits to
a claim before reading it: the length / count checks of items that cross the
window (`open-text`, `open-bstr`, `enter-pend` before `enter-container` in the
four container frames, a typed array's content in tag frames) and a byte
string the walk skips from its head (`skip-bstr`, its snapshot taken from the
prologue's known charges). An item the window holds whole cannot diverge; a
prescan that stops at a refusal inside an item no longer calls that item whole
(its enclosing levels cross: `pstop`/`rstop`), and the dead-typed shortcut is
off. A verdict is **held** (`VMS_HELD`, out filled); the root's trailing check
asks for one byte past the root; doc-start's `not_map` for n = 0 waits for the
first byte. `vms-eof(n)`: n > P -> `too_large`; else drop the pending checks n
covers; the earliest left -> its truncated; else a held verdict stands; else
(the walk was waiting) every end equal to P becomes n and the walk resumes
(`VMS_RESUME`) -- a crossing map key being copied past n finishes its pair over
the arena copy (head included), so no dropped byte is ever asked again. Each
step drops pending checks its window covers. The key arena is sized for P.
**Why**: codes equal a buffer of the same bytes (D085's requirement) with no
retention beyond what the session asks for; the only divergence points are a
handful of frame checks, so the walk itself is unchanged.
**Alternatives**: replay from a checkpoint at EOF (needs the dropped bytes);
re-validating the retained message (unbounded memory); a different documented
precedence (rejected by D085).
- [ ] **Signed off** (owner)

### D145 — Fail-fast reports a held refusal at once (D085)
**Decision** (provisional): with `failFast`, a held verdict that is a refusal
is answered immediately and the source is no longer read; acceptance always
waits for the end; more bytes than the limit is `too_large` at once in both
modes. Guarantee: fail-fast never accepts what the buffer refuses and never
refuses what it accepts (a held refusal means the buffer answers it, or the
earlier pending `truncated`, or `too_large`); only its code / offset may
differ, and only when it answers early (gated: accept iff the buffer accepts,
equal out whenever it accepts).
- [ ] **Signed off** (owner)

### D146 — Unknown-length host APIs; the scanner's drain mode is the VM against `any` (D085)
**Decision** (provisional): JS -- `schema.session(rule, undefined)` (`step` may
answer `held`, `end(n)` settles, `limit`), `pushValidator(schema, undefined,
rule, options, { quantum, failFast })` / `pushScanner(undefined, …)` (`feed`,
`resume`, `finalize` = `end()`, `bytesHeld`), `streamSource(ReadableStream |
AsyncIterable | Iterable)`, `validateStream`, `scanStream` (an early verdict
stops reading). Rust -- `schema::Session::new_unknown`, `Session::end`,
`Step::Held`, `schema::validate_reader(… impl Read …)`,
`Schema::validate_reader`. Unknown-length profile scanning runs the VM's drain
session against a built-in `r = any` Program (largest limits; a test checks it
against the compiler), which gives the scanner's code on every input (vm-test's
profile identity), instead of a second drain mode in `rscan`.
**Why**: one drain implementation, gated once. **Alternatives**: drain mode in
the resumable scanner too (a second set of pending checks to keep equal).
- [ ] **Signed off** (owner)

### D147 — In an unknown-length session a window asserts its bytes exist (D085)
**Decision** (provisional): a window `[base, base + length)` given to an
unknown-length session claims that those bytes were delivered (pending checks
it covers are dropped). A driver must not offer a window starting past the
bytes delivered -- a need or yield past them waits for data or is the end
(`vms-eof`). The gate's runner and both host drivers enforce it, and check that
no byte before a `keep` already given is asked for again.
- [ ] **Signed off** (owner)

### D150 — One host option validator with per-operation allowlists (P7.10)
**Decision**: all public JS option bags, including compile/grouped limits,
view detached checks and source/scheduling bags, use options.mjs. Require
ordinary/null-prototype objects, exact enum strings, real booleans and
non-negative safe integer limits/budgets/seeds/delay; chunk is positive and
quantum is 0..2^31−1. Known undefined fields are omitted. Reject unknown own
keys (including symbols/non-enumerables), naming allowed fields rather than
echoing unknown names or values. Validate overridden Writer limits too;
grouped limits retain precedence. Preserve preset spreading: reading ignores
checked strictArrays; writing ignores checked top and objects (the latter
retains existing codec round-trip option reuse). Forward only receiver
options from views/Writer internal scanner calls. kin keeps all CBOR/schema
verdicts and effective caps; a valid call cannot raise compiled bounds.
**Why**: configuration mistakes must throw TypeError before byte checks or
source reads, rather than looking like rejected data. One checked allowlist
per bag prevents typo-driven policy omissions and enum coercion.
**Alternatives**: separate partial validators/coercion at each boundary;
ignore unknown keys; echo arbitrary unknown keys; reject complete presets;
change VM verdict semantics (all rejected).
- [ ] **Signed off** (owner)

### D151 — In-memory handles own snapshots for every accepted byte type (P7.10)
**Decision**: bufferHandle and asyncHandle require unshared Uint8Array input
(including Node Buffer), copy with new Uint8Array(bytes), freeze the handle,
and return independent plain-Uint8Array copies on every read. No borrow
option. The snapshot is stable after input mutation, and a returned range
cannot mutate the private snapshot. Reject SharedArrayBuffer input with
TypeError, as other checked public byte boundaries do.
**Why**: Buffer.slice aliases the original, unlike Uint8Array.slice. A
snapshot helper must have the same ownership contract for both; independent
reads also close the sync helper's alias to private storage.
**Alternatives**: retain the documented Buffer workaround; expose a borrow
flag and lifetime promise; return mutable aliases of the private copy. The
extra range copy makes immutability enforceable for these testing helpers.
- [ ] **Signed off** (owner)

### D160 — Partition sessions behind snug/sources (P7.6 phase 2)
**Decision** (manager; supersedes D108's JS entry placement): remove
`Schema.session()` and expose synchronous
`openSession(schema, rule, length, options?, scheduling?)` from `snug/sources`.
Keep the existing positional rule/length/options/scheduling order after the
schema argument, matching the former method and minimising driver migration.
All session APIs and their types live behind sources; `snug/schema` keeps
buffer validate/decode/validateAt, Programs and synchronous verification and
serialisation. Extract a buffer core without internal async loader wrappers;
a private WeakMap bridge supplies the already verified Program to sources.
No public mutable Program/scratch access or global factory registration.
**Why**: D108 is days old and pre-release; moving its method boundary removes
the session drivers from schema's static graph without making synchronous
operations async. Keep the kin session implementation and its SS_UNK/pending
area, held/EOF protocol, extension controls and fail-fast driver unchanged.
Public synchronous Program construction still requires vm-verify; move other
host dependencies only where measurement and synchronous contracts allow it.
**Alternatives**: retain Schema.session (keeps the session graph); a new
buffer-only entry (duplicates the public Schema contract); async sessions or
constructors, deferred input snapshots, side-effect factory registration or
skipped verification (change behaviour). An options-only openSession bag adds
an unnecessary option shape; positional arguments preserve existing checking.
- [ ] **Signed off** (owner)

### D170 — The wasm SDK asks host predicates through one import (P7.9 follow-up)
**Decision** (wasm SDK engineer, provisional; implements D140 for the SDK):
the SDK runtime module (`host/wasm/src/sdk.rs`) imports exactly one function,
`env.snug_ext(id, argPtr, argLen, itemPtr, itemLen) -> i32`, and passes kin's
`-x` entry points (`vm-validate-x`, `vm-validate-span-x`, `vms-step-x`) a
closure that answers each EXT query through it. The JS side
(`runtime.mjs withExt`) sets the Program's bound predicate (the native
`ext.mjs bindControls`, so `missing_control`, the strict `true`, the recorded
throw and `rethrow` are the native code) for the duration of that one wasm
call, hands the predicate COPIES of the argument and the item, and replaces
the export object with a guard while the predicate runs, so a predicate that
calls back into the SDK throws (recorded and rethrown after the call, as
"extension control .x threw") instead of re-entering an instance whose Rust
state is borrowed. A session whose predicate threw is void, as natively.
**Why**: the VM decides an EXT inside the combinator pass at the item's end
(D140); the buffer walk cannot suspend, so the predicate has to be callable
from inside the walk. One import is the whole cost; Programs without controls
never call it (the hot path tests header word 30 once). Copies, because an
alias into linear memory changes under the predicate's feet at the next SDK
call (D132's rule for every alias); items are bounded by the control's
maximum (65,536 B default).
**Alternatives**: no import and D032's two-round call (the recursive walk
restarts per query: quadratic on arrays of controlled items); a JS
post-validation pass (D082 rejected it: no single derivation); wasm-bindgen
(a glue layer for one function); passing views into linear memory (a silent
use-after-grow class, rejected in D132); a Rust host-port change (none was
needed: `host/rust/src/schema.rs`'s closure shape is reused, the generated
`-x` functions take `&dyn Fn`).
- [ ] **Signed off** (owner)

### D171 — The generic controls run inside wasm, recognised by their check function (P7.9 follow-up)
**Decision** (provisional): at load the SDK binds each control id of a format
1.1 Program to a kind: 1 `.chars`, 2 `.unique`, 3 `.samelen` when the
registry entry's `check` IS the function of the native `snug/controls`
object (also when spread with another `maxBytes`, as `{...controls.chars,
maxBytes: 8}`), else 0, the import (`sdk_prog_bind`). Kinds 1–3 call kin's
Rust (`snug::vm::controls`, the same functions `snug::controls` wraps) with no
boundary crossing; `.unique` keeps one scratch, dropped past 4 MiB. The SDK's
`snug/controls` re-exports the native objects, so one registry serves both
packages. Kinds are re-bound after instance loss.
**Why**: verdicts are kin's either way (D142), so running them where the VM
runs is exact and saves a copy and a crossing per item (measured: `.chars` on
100 strings 43 µs wasm vs 91 µs native). Identity, not name: a user may
register their own `.chars`.
**Alternatives**: always the import (correct, slower); recognise by name
(would silently replace a user's predicate); a wasm-side registry API (more
ABI for the same three functions).
- [ ] **Signed off** (owner)

### D172 — The SDK reuses the native host modules for everything that is not a boundary (P7.9 follow-up)
**Decision** (provisional): the SDK imports, rather than restates, the native
option validator (`options.mjs`, D150: every bag, same allowlists and
messages), the profile resolution (`profiles.mjs`: flags, `codecTop`,
`strictArraysOf`), `ext.mjs` (registry words, Program control tables,
binding, argument checks), `serialized.mjs`, the builder, the values, the
public `SchemaError` class (`instanceof` works across both packages) and the
public `Writer` (the typed-call Writer has no batch for a tape to win, so
`snug-wasm-sdk/writer` is the native one). ABI changes, all additive to P7.9's
or rewritten in place (no external users): the profile flags are the last
argument of `sdk_scan`, `sdk_validate`, `sdk_validate_span`, `sdk_rs_new`,
`sdk_vs_new`; `sdk_enc_run(flags, cose, maxBytes, maxDepth, maxEntries,
maxItems)` with tape op 7 (a tag: hi, lo, rule tag, content; kin's
std-content-ok and, for tag 24, the scanner under the encode options) and map
keys that are any item; `sdk_enc_keys` orders a Map's keys before its values
are walked when two or more of them are not text (so a duplicate is refused
where the native walk refuses it); the compiler module takes the option words
plus kin's registry words (`cc_opt(n)`), the Unicode tables (`cc_unicode`),
and reports the unknown control's name and the tables flag (`cc_error`). The
JS walk computes the rule tag and calls kin's `std-allowed` (JS) for tag
membership, with the native messages (D180, D184).
**Why**: one validator means one set of TypeErrors (the gate checks 298
option cases across 14 entry points); restating them was the P7.9 SDK's main
drift risk. The tape keeps one wasm call per encode (D131).
**Alternatives**: restated validators (drift); per-head wasm writes (D131
measured them slower); porting the Writer over the tape (no batch to gain).
- [ ] **Signed off** (owner)

### D173 — SDK sessions: openSession, drain mode and fail-fast in linear memory (P7.9 follow-up)
**Decision** (provisional): the SDK's `snug/sources` has the native surface
after D160 -- `openSession(schema, rule, length?, options, scheduling)` (a
frozen facade with `length`, `limit`, `bytesHeld`, `step`, `end`), no
`Schema.session` -- and the native drivers including `streamSource`,
`validateStream`, `scanStream`, unknown-length `pushValidator` /
`pushScanner` with `failFast`, and D151's snapshot handles. `sdk_vs_new` with
a negative total starts `vms-init-unknown` (its limit in INFO[0]); a step may
answer held (out copied); `sdk_ses_eof` is `vms-eof` (resume or verdict).
Unknown-length profile scans run the VM against the built-in `r = any`
Program loaded into wasm (D146). Push buffers are the session's window in
linear memory for both kinds. A session is freed at its verdict, before a
scan's settle throws its refusal, and on every driver error; a feed after
instance loss throws before writing (a stale pointer would land in the new
instance's memory). `bytesHeld` counts the session's window only (the kin
arrays are inside wasm).
**Why**: the native protocol (D144–D147) is kin's, so the drivers are the
native loops over another buffer; linear memory is not collected, so every
exit path frees (found by the gate: unfreed refused scans grew memory past
2 GiB, where i32 pointers turn negative -- pointers are now read unsigned).
**Alternatives**: a JS-side push buffer copied into wasm per step (a copy per
step); relying on the FinalizationRegistry alone (memory grows until GC).
- [ ] **Signed off** (owner)

### D174 — The SDK parity test is a gate on vm-test's case set (P7.9 follow-up)
**Decision** (provisional): `bb wasm-sdk-test [mutations seed schemas]`
(`host/wasm-sdk/test/run`) builds the sdk and cc modules -- without the
nightly wasm toolchain it prints SKIP, says parity was not run, and exits 0
-- and runs `host/wasm-sdk/test/parity.test.mjs`, which takes bb vm-test's
cases (`kin/scripts/vm-allcases.mjs`, defaults 20,000 / 1 / 400: 73,691 cases,
706 Programs, the extension-control cases under the test registry) and
requires wasm SDK == native JS through the public API on: Program loading;
validate (whole result; validateAt for spans); schema.decode and codec decode
(values or the whole fault: name, code, reason, path, offset, message); encode
of every decoded value under the case's profile and of a value set (Maps of
every key kind, Tagged incl. 64-bit and refused tags, undefined, NaN, -0,
noncharacters) × 18 option sets; views (open with profile and schema check,
walks with lookups, cursor, values, raw); sessions (one VM session per case,
rotating handle / declared push / unknown-length push, seeded chunk 1 B–64 KiB,
quantum 0–50, failFast; a profile scan session every fourth case);
openSession, async handles, streams; compile of every schema text of the case
set plus seeded truncations, bindle/bus profiles, registries, arguments and
Unicode tables (serialised Program bytes, source key, rules, controls, or the
SchemaError with its message); extension-control binding and errors;
option validation; instance loss. Messages are compared too.
**Why**: the SDK restates the view, the drivers and the encode walk (D130's
cost of offering both); this holds them to the native package on the same
breadth as the VM gate. A session costs 0.3–1.7 ms to set up on either side
(an unknown-length one sizes its arena for the input limit), so every flavour
on every case took 16 minutes; rotating keeps 2.5 minutes.
**Alternatives**: the P7.9 six-test sample (too narrow to see drift); every
session flavour on every case (16 min).
- [ ] **Signed off** (owner)

### D175 — D130 still holds with the new features (P7.9 follow-up)
**Decision** (recommendation; measurement in bench/D005.md "Re-measured at
898434f"): keep D130 unchanged -- native default, the SDK opt-in by the same
three conditions and the same "stay native" list. At 898434f the SDK is 0.39–0.47
of native's time on validate (3.22× on the 1 MiB bstr body: the copy), 0.17–0.21
on compile, 0.51–0.62 on schema.decode, 0.65–1.10 on codec decode; extension
controls and drain mode do not change the picture (host predicate 0.72, in-wasm
generic `.chars` 0.47, unknown-length push 0.43–0.45). The runtime module grew
from 83 to 94 KB gzip (any-tag level, extension controls, drain mode).
**Why**: every key ratio moved by at most 0.05 against 93f8718's.
**Alternatives**: none raised by the data.
- [ ] **Signed off** (owner)

### D176 — The SDK's remaining API differences (amends D132) (P7.9 follow-up)
**Decision** (provisional): D132's list stands except: the public `Writer`
is the native one (ported by re-export) and Unicode compile tables work.
Added or restated: a predicate receives copies of its argument and item (the
native host passes aliases of the caller's bytes and the Program's pool);
`bytesHeld` of an SDK session is its window in linear memory; `view(…, {
batch })` and `view.path()` / `release()` are SDK extras (`batch` is checked
by the SDK, every other view option by the native validator); with several
faults in one encoded value the reported one may differ (map values walked in
host order, writer-primitive and tag-content faults found when the tape
runs), every single fault and every accepted value matching the native.
- [ ] **Signed off** (owner)

### D180 — An "any tag" level, and the deterministic preset uses it (P7.12)
**Decision** (profile engineer, provisional; answers D121's open "any tag"
level): `PF_TAGS` 2 or 3 (`PF_TAGS_ANY` = 8; JS `tags: 'any'`, Rust
`Tags::Any`) admits every tag number, 64-bit ones included, with any
well-formed content — the content an ordinary item one level below the tag,
counted, walked first — except where a rule is known: the Bindle tags (2, 3,
4, 40, the little-endian typed arrays) and the standard set keep theirs
(55799 still only at the top), RFC 8949 §9.2's invalid numbers 65535,
2^32−1 and 2^64−1 are refused (`tag`), and the RFC 8746 typed-array tags
outside the Bindle set (64–68, 73–75, 80–83, 87) need a byte string of whole
elements (D182). **The deterministic preset defaults to it**:
`PF_DETERMINISTIC` = 2 | 8 | 16 | 32 | 64 = 122 (118, the P7.1 preset, is
`tags: 'standard'`). Tag heads stay shortest like every head.
**Why**: a general deterministic CBOR library must read COSE (COSE_Sign1 18,
Encrypt0 16, Mac0 17, Encrypt/Mac/Sign 96–98), CWT (61) and the long tail of
registered and private tags; RFC 8949 §4.2.1 restricts encodings, not tag
numbers, and cbor2's CDE mode accepts them. Refusing them by default made
"valid snug CBOR" narrower than CDE for no determinism gain. Schemas are where
a protocol narrows tags (`#6.18(...)`), and `tags: 'standard'` keeps the
narrower policy one option away. The invalid numbers are never data (cbor2
refuses them too).
**Alternatives**: keep the standard set as the default (COSE/CWT refused
out of the box, D123's motivation half met); accept the invalid numbers
(RFC 8949 reserves them as sentinels); a registry of IANA tags with content
checks for each (large, and every rule is a refusal a caller might not want);
a new flag bit instead of the free PF_TAGS values (PF_TAGS had 2 bits, values
2 and 3 meant "standard" with no caller relying on them).
- [x] **Signed off** (owner, 2026-11-04, in session via the coordinator): any-tag is
  the deterministic default. Approved.

### D181 — Bignum minimality stays in every tag level (P7.12)
**Decision** (profile engineer, provisional): tags 2/3 keep the P7.1 rule
under every level: a byte string of 9..128 bytes with no leading zero, i.e.
a value that does not fit major 0/1 and is written in its shortest
magnitude. **Why**: RFC 8949 §4.2.1 requires preferred serialization, and
§3.4.3 defines it for bignums (no leading zeros; integers that fit 64 bits
use major 0/1); draft-ietf-cbor-cde and cbor2's CDE mode refuse
non-preferred bignums as well (checked: cbor2 refuses `c24100`). 128 bytes
is a resource bound (`maxBignumBytes`), not a determinism rule, and keeps its
code (`bignum`). **Alternatives**: accept leading zeros under the any level
(two encodings of one value); lift the 128-byte cap with the level (an
unbounded integer is a resource choice, separate from tag numbers).
- [ ] **Signed off** (owner)

### D182 — Rule tags: what a tag number's rules are (P7.12)
**Decision** (profile engineer, provisional): every walker decides a tag by
its *rule tag* (`snug.cbor.stdtags/rule-tag`): the 32-bit number itself, −1
for 2^64−1 (2^32−1's rule: refused) and −2 for any other number of more than
32 bits (no rule). A 64-bit number therefore never takes a 32-bit tag's path
— tag 2^32+2 is not a bignum, 2^32+24 not an encoded item — while schema
`TAG`/`TAGSET` leaves compare the whole number (the VM's tests had compared
the high word with 0; they now compare it with the head's). The any-level
RFC 8746 tags check only that the content is a byte string whose length is a
multiple of the element size (1/2/4/8/16), read from the content's head; no
NaN rule (the Bindle NaN rule is for the little-endian floats it decodes to
JS typed arrays); 76 (reserved) has no rule. Their content is an item like
every non-Bindle tag's (counted, a level), unlike the Bindle typed arrays'.
**Why**: one integer per tag keeps the four walkers, the resumable scanner
and the session on one path (`std-allowed`, `std-content-ok`) with no extra
state; −1/−2 are the only 32-bit values whose own rules are "refused" and
"none", so no rule changes meaning. A whole-element length is the one check
every RFC 8746 decoder makes. **Alternatives**: carry hi:lo through the rule
functions (wider signatures in hot paths for no extra behaviour); decode the
BE forms to typed values (a host-value question, D123); refuse 64–87 outside
the Bindle set even under the any level (contradicts "any tag").
- [ ] **Signed off** (owner)

### D183 — Resumable drivers: head rules from the head, tag numbers structural (P7.12)
**Decision** (profile engineer, provisional): the any-level typed-array rule
is a head rule. The resumable scanner records it from the content's head in
the `K_STD` frame (as tag 1's); the session decides it at `T_STD` from the
content's head (asking for at most 9 bytes) before the walk, holds a refusal
in `F_TNOTED` and reports it after the content's own refusals, so such
content is never pinned (D094) and streams through the windows. `key-end-any`
(and the D085 `key-max-claim`) treat any tag head as one owed item: a tag
number is not a length, so a 64-bit tag inside a key no longer reads as
"refused inside the window". The session prescans admit tags by rule tag.
**Why**: refusal precedence (content first, then the rule) stays the buffer
walk's; pinning a large byte string just to re-read its 9-byte head would be
the whole-buffering D124 tries to bound. **Alternatives**: pin and re-read
like tag 1 (buffers the content); check the rule before the walk (changes
precedence).
- [ ] **Signed off** (owner)

### D184 — JS `Tagged` numbers and the Writer's tag refusals (P7.12)
**Decision** (profile engineer, provisional): `Tagged.tag` is a non-negative
integer below 2^64 — a number up to 2^53−1, a bigint beyond, a bigint within
the safe range normalised to a number (as decoded integers are); views'
`tag` likewise. The builder makes a `Tagged` of every tag but 2, 3, 4, 40 and
the little-endian typed arrays, which keep their value types (bigint,
`Decimal`, `NDArray`, typed arrays); encoding a `Tagged` with one of those
numbers is refused with `tag` (use the value type). Rust's `Value::Tag(u64,
_)` already carried any number. **Why**: decode and encode stay inverse
without two representations of one value; bigints only where a number would
lose bits. **Alternatives**: always bigint (breaks every `t.tag === 18`);
allow `Tagged(2, bytes)` (a second encoder path for bignums whose result the
scanner would then judge).
- [ ] **Signed off** (owner)

### D185 — The deterministic float scan needs no fix (P7.12)
**Decision** (profile engineer, provisional): no change to `scan-float` /
`float-bad`. Measured one preset per process, the deterministic and Bindle
float scans are equal (172.9 µs median of 12 processes each on 5,000 scalar
floats) and ~1.8% over the pre-P7.1 tree (169.8 µs), within run-to-run
spread; V8 inlines `scanFloat` into `item` in both trees. P7.1's "~5%"
(median 1.046) came from `bench/profiles-bench.mjs` running the base tree's
codec in the same process, which today shows 1.14–1.16 for both presets; its
explanation (a `float-bad` re-check) could not apply, since the workload's
floats pass the Bindle rules ([bench](bench/README.md#profile-options-p71)).
**Why**: nothing to fix that a measurement can see. **Alternatives**: inline
the RFC rules into `scan-float` (grows the hot function past what V8 inlines,
the P7.1 Finding).
- [ ] **Signed off** (owner)

### D186 — Whole reads in the resumable drivers stay, bounded and documented (P7.12)
**Decision** (profile engineer, provisional): D124 stands — tag-0/32 text
and tag-24 byte-string contents, and map keys that are containers, tags,
byte strings or floats, are read whole by the resumable scanner and the
session. Each is bounded by the item's size, so by `maxBytes` (and keys by
the session's key arena); docs/profiles.md says so. D180 adds no new whole
read: rule-free tags stream like tags 21–23, and the any-level typed-array
rule is decided from the content's head (D183). **Why**: these rules need
their whole content (a date, a URI, a nested item, a key's bytes for order);
incremental automata across windows would add much state for rare large
contents. **Alternatives**: incremental date/URI/payload automata; a stack of
key arenas for nested keys (both open in the Parking lot).
- [ ] **Signed off** (owner)

### D187 — snug.js renders calls to declared functions at once (P7.12)
**Decision** (profile engineer, provisional): snug's JS target gives
`declarefn` its own `:generate`: kin.lang's reservation, then, for each
unqualified name, the callable a `defn` registers (bare name, this unit, no
return tag) filled into the placeholder at once; the later `defn` fills it
again with its own. kin itself is unchanged. `kin/scripts/js-target-test`
(run by `bb check`) generates two in-memory probe namespaces and requires the
import and the answer under node; it fails on the previous js.cljc. One
workaround in the sources (`scan-std`'s `cs` local) is removed so real code
exercises the fix. **Why**: kin defers a call to a declared-but-undefined
function into a promise settled at join, after the module header is
formatted, so imports registered while rendering its arguments were lost
(Findings, P7.1). JS hoists function declarations, so nothing the definition
adds is needed to spell the call. **Alternatives**: a lazy header settled
after the body's promises (relies on kin's settle order); keep the
local-binding workaround (a trap for every new forward call).
- [ ] **Signed off** (owner)

### D188 — Cut keys of byte-string and float kinds stay a `map_cut` error (P7.12)
**Decision** (profile engineer, provisional): D125 stands. Supporting
`h'00': T` / `1.5: T` needs KEYS entries of majors 2 and 7; `vm-verify`'s
`check-keys` accepts only major 0/1/3 keys, so such Programs would be refused
by every existing verifier — a Program format change (a D084 minor), which
this item may not make. **Why**: the rule "no Program format change"; the
refusal is exact and names the rewrite (`=>`). **Alternatives**: format 1.2
with major 2/7 KEYS (owner's call, with the compiler's naming records and the
VM's key search, which compare encodings and so need no other change).
- [ ] **Signed off** (owner)

### D190 — The extension-control port answers a verdict word and is told the budget left (P7.2 hardening)
**Decision** (provisional): the kin port `Ext` becomes `(id, pool, ao, al, b,
s, e, room) -> i32` (was `-> bool`): `room` is the budget the VM has left
after charging 1 + `EXT_CALL` (16) units for the call; the answer is u >= 0
matched after u units, -2 - u refused after u units, or -1 "more than
`room`". `ext-eval` charges u (or stops with `budget` at the item, exactly
like any other charge that exceeds the remainder). No Program word changes:
format 1.1 as before; program.md §14 gains the EXT schedule.
**Why**: R2 (architecture §1, §7) needs every unit of work charged; a bool
port cannot report work, and an EXT predicate's work depends on the item
(and, for `.samelen`, on the argument). Passing `room` lets the work stop
inside a run (generic controls) or before it (declared costs), so one call
can never overshoot the budget.
**Alternatives**: a per-leaf declared cost in a Program word (a format
change, refused by the brief); charging a worst-case bound before the call
(`.unique`'s n log n bound would overcharge every valid array several
times); running the generic controls inside the VM by name (a registry could
rebind the names).
- [ ] **Signed off** (owner)

### D191 — Generic controls are metered in kin, in ticks (P7.2 hardening)
**Decision** (provisional): `snug.vm.controls` runs `.chars`, `.unique` and
`.samelen` against a meter (host scratch m[0] ticks spent, m[1] allowed =
room × 8) and charges every step BEFORE doing it: heads skipped 3 ticks;
`.chars` ⌈len/16⌉ units before its single linear count; `.unique` 5 per
element + 1 per byte hashed (FNV-1a over the element's encoding), 8 per
record comparison of a heap sort by (hash, bytes) + 8 per 8 bytes examined
only on equal hashes, stopping at the first equal pair; `.samelen` 5 per pair
+ a binary search over prepared names, 4 per probe + 8 per 8 bytes examined.
u = ⌈ticks / 8⌉. Weights calibrated (bench/VM.md, 2026-11-05) so that each
kind of generic work costs no more CPU per unit than the VM's own worst
walk measured alongside it (the six-way choice of maps, D046's reference).
**Why**: identical units on every host by construction (JS == Rust == wasm),
work proportional to the item (O(B) for `.chars`/`.samelen`, O(B log n) worst
for `.unique`, which hash collisions cannot push further), and a run that would
pass the budget stops in the middle.
**Alternatives**: whole units per step (coarse: overcharges cheap steps 2-4×);
an open-addressing hash set for `.unique` (expected O(n) but adversarial
multi-collisions make it O(n²) probes — charged, but valid arrays would then
be refused); merging sorted keys against sorted names (relies on map key
order).
- [ ] **Signed off** (owner)

### D192 — Generic control arguments are prepared once, at bind (P7.2 hardening)
**Decision** (provisional): `chars-prep` (lo, hi) and `samelen-prep` (the
distinct names' spans, heap-sorted bytewise) run once per (control id,
argument offset) when a host binds a Program (JS `bindControls`, Rust
`Program::bind` / `controls::prepare_all`), not per item; bind-time work over
the schema's own literal is not charged. Hosts reuse one meter/`.unique`
scratch per thread (JS module, Rust `thread_local`), three words per element
of the largest array (bounded by the entries limit), released past 2^20 words.
**Why**: the 2026-11-04 analysis found `.samelen` re-parsed and linearly
searched a 237 KB controller per item (58.6 s under defaults); duplicates
collapse and lookup becomes O(log names). **Alternatives**: charging argument
bytes per call (bounded but still argument-amplified); preparing in the
compiler (a Program change).
- [ ] **Signed off** (owner)

### D193 — Host predicates: a declared cost, charged before the call; their CPU is the host's (P7.2 hardening)
**Decision** (provisional): a registered control may declare `cost(itemBytes)
-> units` (JS, a non-negative safe integer) / `Control::cost(item_bytes) ->
u64` (Rust); default `itemBytes` (D140's one unit per item byte). The binding
computes it before calling; more than `room` answers -1 (`budget`) without
calling. The per-control maximum item size stays 65,536 B. Documented
plainly (guide, api, rust.md, program.md §14): the VM cannot interrupt or
measure host code, so a predicate's own CPU is the host's responsibility and
`cost` is how a host keeps it inside the budget (~20 ns per unit by default).
**Why**: an arbitrary pure predicate is unbounded (303 ms for 16 steps in the
analysis); the only enforceable bound without isolation is a trusted
declaration charged before the work. **Alternatives**: a units-per-byte
integer in the registry words (needs a compiler/source-key change and is
less expressive); timing predicates (non-deterministic, hosts would disagree);
lowering the default maximum (does not bound per-byte cost).
- [ ] **Signed off** (owner)

### D194 — EXT_CALL = 16 units per predicate call (P7.2 hardening)
**Decision** (provisional): every call (generic or host) costs 1 + 16 units
before it, on top of its own units. **Why**: the per-call dispatch, walk and
combinator overhead of a tiny item was charged ~22 units for ~760 ns (34 ns
per unit, the 79 ms no-op row); at 16 the tiny-item rows run at ~17–20 ns per
unit even on the loaded machine (bench/VM.md 2026-11-05). **Alternatives**: 8
(about 25 ns/unit loaded, past the 50 ms gate under load); a per-byte view
charge (views are O(1)). Cost: 65,536 tiny items each asked by a control now
exhaust the default budget (they took ~40–50 ms before).
- [ ] **Signed off** (owner)

### D200 — R9 restated at the measured sizes and enforced as a gate (OWNER DECISION)
**Decision** (owner, 2026-11-04, in session via the coordinator; option 1 of
`docs/briefs/r9-bundle-size.md`): the bundle-size requirement R9 is restated
at the measured sizes — codec (`snug`) ≈ 14.6 KB gzip, runtime (codec +
`snug/schema`) ≈ 41.9 KB gzip, every other public entry at its measured size
— and enforced by `bb size` (`tools/size/budget.json`, +2% regression caps),
which is part of the gate set. The earlier 20 KB runtime figure is withdrawn.
Further shrinking (the verifier refactor, a possible `schema-lite` entry) is
opportunistic, not required.
- [x] **Signed off** (owner, 2026-11-04, in session via the coordinator).

### D210 — CBOR sequences are an explicit mode over the session VM; profile-only runs it against `any` (P7.13, W21)
**Decision** (sequences engineer, provisional): RFC 8742 sequences get their
own entry points (`readSequence`, `sequenceReader` in a new package entry
`snug/sequence`; Rust `read_sequence`, `Sequence`); every single-document API keeps refusing `trailing`. Each
message is one root validated in ONE fused pass (profile + optional schema
rule) by the resumable session VM in a new sequence mode (D212); boundaries
come from that walk, not from a separate framing pass. Without a schema the
session runs against the built-in `r = any` Program, as unknown-length
scanning does (D146). The resumable scanner (`rscan`) is not changed.
**Why**: the session already fuses profile and schema checks over windows
and holds end-dependent checks (D144); a sequence only changes what happens
at the root's end. One implementation of pending end checks is gated once.
**Alternatives**: a sequence mode in `rscan` too (the brief's suggestion: a
second set of pending checks to keep equal, for a path the VM-against-`any`
already covers with identical codes, D146); frame with a structural skip and
validate each framed message with the buffer driver (two passes, and the
skip trusts unchecked bytes); speculative buffer runs cut at the chunk end
(inexact budget/items stop points, D091).
- [ ] **Signed off** (owner)

### D211 — A message's verdict is the buffer driver's over its message window (P7.13)
**Decision** (provisional): for a message at absolute offset o with limit P
and R bytes following, the verdict is the buffer driver's over
W = S[o, o + min(R, P)) with `trailing` read as a boundary: a root ending at
t gives the buffer verdict of S[o, o + t) (offsets + o) and the next message
at o + t; `truncated` with R > P is `too_large` at o; any other refusal
stands (architecture §18.1). The gate's oracle is this definition.
**Why**: for a valid message it is exactly "the buffer driver on the
message's own bytes"; for an invalid one (whose bytes are undefined) it is a
function of (S, o, P) alone, independent of chunking, that never needs input
beyond o + P — so a refusal is answered without draining a live stream.
**Alternatives**: D085's drain semantics per message (the message would run
to the end of the stream: every refusal in a long stream becomes
`too_large`, and a live stream that stalls never answers); `too_large` at
once on any claim past P (cheaper, but it differs from the buffer driver for
a truncated tail and cannot tell an embedded payload's truncation from P).
- [ ] **Signed off** (owner)

### D212 — The session's sequence mode: a boundary at the root's end, held while claims are open (P7.13)
**Decision** (provisional): kin `vms-init-seq` starts an unknown-length
session (provisional end P = the effective input limit) with `SS_SEQ` set.
At the root's end it skips the trailing check, records the message length
(`vms-message-length`, −1 until a root completes) and finishes the root's
typeset test and witness. A verdict is held (`VMS_HELD`) while a pending end
check remains or while it is `truncated`; every later step drops the checks
its window covers and answers the verdict once none remains (a truncation
stays held for `vms-eof`). `vms-eof` is unchanged. Offsets are relative to
the message start; hosts add o. Per message the host re-runs `vms-init-seq`
on the same arrays.
**Why**: the smallest change to a gated walk: the root end, `settle` and the
held state's step; everything before the root's end is drain mode's walk,
already held identical to the buffer (bb vmsession-test).
**Alternatives**: a `vms-next` that keeps the session array across messages
(re-init is cheap next to a message's walk; one more state to gate); 64-bit
offsets in kin (a later ABI change; per-message offsets suffice).
*Note (D230, 2026-11-04):* the sequence layer assumes nothing about the
wire profile: a boundary is wherever the session's walk completes the root,
and the bytes of a message are the bytes received (never a re-encoding), so
when P8.4 gives the session VM a valid-CBOR mode (indefinite lengths ended by
a break, unsorted keys), sequences pick it up through the same options with
no change here — an indefinite item simply has no length claim to hold, and
its end is the break the walk reads. The View's key-order early exits are
the view module's concern under P8.4, not the reader's. *Correction (review
2026-11-04 #12):* "no change" is too strong for the planned implementation:
the hosts' drivers must also learn any new session status (§19.7's
`VMS_GROW`: growth and resume with fixed arrays), the option admission of a
`valid` wire, and split-at-every-byte tests around breaks.
*Amendment (liveness, review 2026-11-04 #1):* a complete message must be
released by its own bytes. The session no longer asks past an item's end: an
extension leaf's maximum span and a tag-40 note's fixed span are asked for
only when the item does not already end in the window (prescan), and then one
more byte at a time; key reads ask for exactly what `key-end-any` needs
(no doubled window). `bb sequence-test` asserts it.
- [ ] **Signed off** (owner)

### D213 — Limits apply per message; no per-sequence cap in this slice (P7.13)
**Decision** (provisional): `maxMessageBytes` (default the input limit:
1,500,000 profile-only, the compiled input limit with a schema), `maxDepth`,
`maxEntries`, `maxItems`, `maxBignumBytes` and `budget` apply to each
message from zero. `maxBytes` is refused in sequence options (TypeError
naming `maxMessageBytes`). No total-bytes or message-count cap: a consumer
stops by leaving the loop, which cancels the source.
**Why**: a sequence is a series of documents; per-message limits are the ones
every other API has. A total cap's meaning on refusal (which message is
refused, with which code?) is a decision with no consumer yet.
**Alternatives**: reuse `maxBytes` as the per-message limit (ambiguous in a
sequence); `maxTotalBytes` / `maxMessages` with a new code.
- [ ] **Signed off** (owner)

### D214 — `onInvalid: 'stop' | 'skip'`; only schema refusals of complete messages are skippable (P7.13)
**Decision** (provisional): `stop` (default) ends the sequence at the first
refused message after delivering every earlier one. `skip` drops a refused
message only when its root completed (profile-valid, end known, bytes
delivered) and its reason is a schema reason (`type`, `missing`,
`unexpected`, `value`, `size`, `range`, `pattern`, `tag`, `bits`,
`embedded`, `control`, `control_size`); everything else stops: every
`cbor/*` code, `budget`, a throwing extension predicate, source failures.
JS push answers skipped refusals in `skipped`; `readSequence` counts them in
`stats`; Rust yields them as `Err` items and goes on.
**Why**: after a profile refusal there is no safe resynchronisation point in
CBOR (any byte can start an item); a schema refusal of a complete message
leaves the framing intact. `budget` can stop the walk before the end is
known, so it is never skippable.
**Alternatives**: skip `budget` refusals found at the root's end (the
answer would depend on where the allowance ran out); a callback option.
- [ ] **Signed off** (owner)

### D215 — Borrowed messages inside a chunk, one assembly across chunks, views minted internally (P7.13)
**Decision** (provisional): a message wholly inside one delivered chunk is a
subarray of it; a spanning message is copied once into one fresh buffer.
`copy: 'spanning'` (default) | `'always'` (every message copied). The View
is minted from the session's verdict by an unexported function of the view
module (the internal capability); no public trusted opener. Rust: push
messages are `Cow<'chunk, [u8]>`, iterator messages owned.
**Why**: zero copy for the common case (small events in large chunks) and a
contiguous buffer for the View; the capability keeps §16.2's rule that a View
means "checked" (V1/V2).
*Amendment (review 2026-11-04 #2–#5):* `copy: 'always'` copies with
`new Uint8Array` (Node `Buffer#slice` aliases); message fields are private
getters and the View is minted from the checked bytes, not a public field;
View and Cursor keep their state in private fields and refuse construction
outside the view module (a brand check on its private Message class), which
closes the pre-existing `new View(fakeState)` escape; assembly growth is
capped at P and splitting messages out of an assembly is linear (a view of
the tail, exact copies out; Rust keeps an offset instead of `split_off`);
`readSequence` pauses after each message. Borrowing requires a producer that
never mutates, recycles or transfers a handed-over buffer — a default
`ReadableStream` reader does not guarantee it by itself.
**Alternatives**: always copy (simplest, costs a memcpy per message); a
public `view(bytes, {trusted: true})` (rejected by V1/V2); views over a
chunk list (every accessor would need to handle discontiguous bytes).
- [ ] **Signed off** (owner)

### D216 — Sequence refusals carry index and absolute offsets in the SnugFault family (P7.13)
**Decision** (provisional): JS throws (stop) or reports (skip) a SnugFault
with `code`, `reason`, `path`, `offset` (absolute), `subcode`, `index`,
`messageOffset`, `skippable`. Rust: `Error::Sequence(MessageFailure {index,
message_offset, offset, failure, skippable})`, `failure.offset` relative.
**Why**: D103's one catchable family; no payload.
*Amendment (review 2026-11-04 #6, #8):* an exception from an extension
predicate ends the sequence after the messages before it (readSequence yields
them, then throws; the push result carries it as `error`); transport
exceptions pass through unchanged, as for the other sources.
**Alternatives**: a SequenceError class (a fourth family); result objects in
the stream (every loop would test `ok`).
- [ ] **Signed off** (owner)

### D217 — End of input in a sequence (P7.13)
**Decision** (provisional): EOF at a boundary ends the sequence (the empty
sequence is valid); EOF inside a message is `truncated` with its index;
`too_large` is answered once more than P bytes follow the message start
while the walk still needs one (bytes counted, not kept); `failFast`
reports a held refusal at once (D145's contract). The drain machinery runs
only inside a message.
**Why**: §18.1 needs no byte past o + P; counting rather than buffering keeps
an oversize message's memory at zero after its refusal is known.
**Alternatives**: report `truncated` at once for any held truncation
(`failFast` gives that when wanted).
- [ ] **Signed off** (owner)

### D218 — `bb sequence-test` (P7.13)
**Decision** (provisional): a gate of its own: the vm-test case sets and the
scanner's vectors/mutations as sequences under whole / 1-byte / random /
every-offset chunkings against D211's oracle (every out word, absolute
offsets, lengths, stop/skip outcome), JS == Rust at kin level (debug, panics
caught), JS behind out-of-bounds traps, and the JS and Rust host APIs
(borrowed vs assembled bytes, walk-equal views).
**Why**: the D030 condition for a new mode: the oracle is the buffer driver.
- [ ] **Signed off** (owner)

### D219 — The wasm SDK's sequence reader is deferred (P7.13; waits on P7.9c)
**Decision**: `host/wasm*/` is not changed in this item. *Update 2026-11-04:*
P7.9c is done, but the edit was refused by this session's permissions
pending the owner's authorisation (P7.13w lists the exact edits); the native
driver now takes a backend (`sequence-core.mjs`) so the SDK can reuse it. The SDK will need
the `vms-init-seq` / `vms-message-length` exports, the native sequence host
driven through its session wrapper (D173: views re-derived after every step,
windows copied into linear memory), and views minted over a JS-side copy of
each message (linear memory cannot be borrowed across steps).
*Done 2026-11-10 (P7.13w, under D300):* the exports above plus
`sdk_ses_step_at` (steps inside the backend's copy of a chunk, so a chunk is
copied about once); the SDK reader is the shared driver over a wasm sequence
session, given exactly the native windows; `message.bytes` is borrowed or
assembled as natively, and the View copies it into linear memory on first use
(D132's contract). `bb wasm-sdk-test` holds it to native per feed.
- [ ] **Signed off** (owner)

### D230 — Owner directions 2026-11-04: spec compliance first (OWNER DECISION)
**Decision** (owner, 2026-11-04, in session via the coordinator), recorded
verbatim in substance:
1. **Calibration**: "use good defaults" — the D190–D194 weights and the
   default budget are chosen by the manager from quiet-machine measurement,
   with the rationale recorded (D190–D194's own owner boxes stay unticked).
2. **snug must be spec compliant as a general CBOR/CDDL library**; optimise
   where possible but compliance first; the conformance audit (P8.1) is the
   worklist.
   - Default decode, view, scan and validate accept any well-formed, valid
     CBOR per RFC 8949 §5.3 — indefinite lengths, non-shortest heads,
     unsorted keys, NaN payloads — and still refuse what the RFC calls
     invalid: duplicate map keys, invalid UTF-8, invalid tag content for known
     tags.
   - Encoders keep emitting deterministic output.
   - Deterministic checking (RFC 8949 §4.2) and the `bindle` preset remain
     available as options, not the default; a specialised deterministic-only
     fast path is kept only if measurement shows it is material (the checking
     option itself stays: dCBOR, CTAP2 and signing protocols need it).
   - Literal and key comparisons and duplicate detection must be correct on
     non-canonical encodings: compare by value where the RFC says values are
     equal; duplicate detection on unsorted maps within the budget.
   - CDDL: accept every schema the RFCs define. Keep the proven fast paths;
     add general, budget-metered algorithms where exactness is not provable
     (maps now refused as `map_overlap`/`map_group_occurrence` — bipartite or
     bounded search; non-regular group recursion; composite `.ne`; non-literal
     `.cat`/`.plus`/`.det`; `.abnf`/`.abnfb`); every new algorithm charged; the
     brute-force oracle must agree.
   - Cuts follow what the audit concludes RFC 8610 and the reference
     implementation mean; change D021 if they differ.
   - Prelude types that can never match must be matchable under the default.
3. **Regex**: offer I-Regexp (RFC 9485) and XSD regex (RFC 8610's reference)
   as options, only if XSD can be supported on every target via a kin-written
   bounded automaton (no host regex engine); the default is chosen from the
   audit; if XSD cannot be done portably and bounded, report back rather than
   ship half of it.
4. **CBOR sequences** (D210+) proceed and must work under the new valid-CBOR
   default.
Sequencing: audit, then the decode-default change, then CDDL coverage; every
change gated (oracle, JS == Rust == wasm — the wasm SDK part waits on P7.9c);
the conformance corpus gains RFC vectors including non-deterministic ones.
This supersedes D081/D120/D126's choice of `deterministic` as the default
wire profile, D013 (refused controls), D014 (I-Regexp only) and, subject to
the audit, D011/D012's refusals and D021.
- [x] **Directed by the owner** (2026-11-04, in session via the coordinator).

## P8.1 — Spec-conformance audit (2026-11-04)

- **Report delivered:** [docs/conformance.md](docs/conformance.md). Independent
  offline review of all **142 declared D decisions** (including D028/D112,
  D210–D219 and newly added D230) and **74 documented semantic/refusal items**.
  Inventory counts: **147 conformant; 45 conformant but incomplete;
  18 deliberate deviation; 6 non-conformant**. Counts include overlapping
  decision/semantic rows, not six independent implementation bugs.
- **Findings:** D021's branch-local cuts agree with Ruby and Rust; do not
  introduce global map poisoning. Confirmed accepted-schema defects include
  signed-zero float comparisons/exclusions and unplugged group sockets;
  NaN exclusion and known date/URI validity also need attention. Current
  byte APIs cannot validate valid non-deterministic CBOR, even against any.
  Canonical-NaN-only and several tag/decimal/typed restrictions exceed core
  deterministic encoding. Default any-tag policy has prelude witnesses that
  older docs incorrectly call impossible. D230 is pending implementation.
- **Checks actually run:** public JS compile/validate/decode/view/Writer,
  detached spans, handles, known/unknown push/streams; Ruby cddl **0.12.14**
  and offline-rebuilt Rust cddl **0.10.7** CLI (supplied native binary absent;
  use --ci for failing exit statuses); **1,840** selected map/array comparisons
  with the independent local interpreter, zero differences/unknown;
  **42** public JS sequence scenarios after those exports appeared during
  the audit. All scratch fixtures, scripts, tool output and source-state
  records are in .cache/audit/. Node v24.6.0, Ruby 2.6.10, rustc/Cargo 1.92.0.
  No project gates, snug Rust/wasm build, emission, installs, network or
  commits were performed by this audit. Only the report and this new item
  were edited; concurrent engineers' changes were preserved.
- **Evidence limits/learnt:** a reference validator can implement greedy
  matching or host-regexp semantics incorrectly; disagreement is evidence,
  not an RFC verdict. Empty group choice is not empty group. Separate wire
  policy, schema coverage and host representation. No authoritative local
  RFC copies were available for sentence-exact quotation verification;
  quotes are limited/qualified in the report. Six representative protocol
  fragments compiled; no full published-schema census or coverage percentage
  is claimed. Working-tree sequence work changed during the audit.
- **Ranked fixes** (impact/effort and acceptance examples in the report):
  1. Fix float signed-zero comparisons/exclusions and NaN inequality.
  2. Fix unplugged group sockets, including oracle/corpus expectations.
  3. Complete known-tag URI/date validity and distinguish opaque tags.
  4. Reconcile public scope, prelude/profile and float documentation.
  5. Deliver D230's valid-CBOR input policy with value-correct comparisons
     and lossless host representation; keep explicit strict policies.
  6. Add budget-metered general map assignment/group matching fallback.
  7. Complete standard controls and mixed numeric-controller coverage.
  8. Provide precise portable XSD/I-Regexp options per D230.
  9. Separate inherited decimal/typed/ndarray/tag restrictions from general
     policy and complete advertised tag1040 support.
  10. Broaden recursive/group/simple-value coverage and sequence parity.
- **RFC quotation check (2026-11-04, independent reviewer):** fetched the
  RFC texts into corpus/rfc/ (unmodified, README with URLs, hashes and IETF
  Trust terms) and checked every quotation/paraphrase:
  [docs/reviews/2026-11-04-rfc-quotation-check.md](docs/reviews/2026-11-04-rfc-quotation-check.md).
  40 rows: 7 exact, 1 minor wording, 1 misquote ("implicitly anchored at
  both ends" is not RFC 8610 text), 5 wrong section (tags 65535/2^32-1/2^64-1
  are 8949 §3.4, "MAY flag"; I-Regexp syntax is 9485 §3), 9 unfaithful
  paraphrases, 17 faithful. Six reclassifications, applied in
  docs/conformance.md with a dated note: D012/D036/S28 -> non-conformant
  (RFC 8610 Appendix A, normative, makes arrays greedy PEG: snug accepts
  [1] for [* uint, uint]); D021/S26 -> deliberate deviation (§3.5.4 "the
  entire map fails to match" and Appendix A cuts are literally global);
  S46 -> non-conformant (§3.8.6 .default carries an "implied .ne"; contested
  by Erratum 9229, status Reported). Totals now 143/43/20/10. Also: tag-40
  zero extents are RFC-required (8746 §3.1.1); RFC 9682 adds #7.<type> and
  touches neither prelude nor sockets. No code changed.
- [ ] **Signed off** (owner)

### D240 — Calibration: targeted prices, with an explicit limit on the fit (proposal only)
**Decision (proposed, 2026-11-04)**: do not blanket-raise EXT weights 1.5×.
Use the concrete price proposal in [bench/VM.md](bench/VM.md#calibration-2026-11-04):
EXT_CALL 16→0; T_ELEM 5→10; T_CMP 8→6; T_PROBE 4→3; new C_FIRST 2
instead of the initial 8-tick chunk, continuation chunks unchanged; profile
UTF-8 and VM comparison quanta 64→8 bytes/unit; `.bits` 64→12. Propose a
2.25 M default for normal automatic dispatch after repricing, conditional
on a quiet confirmation. **No kin/gen/host/program.md changes made.**
**Why**: 40 shapes/kernels at clean df612f5, nine interleaved thread-CPU
rounds, JS/native verdict-and-unit parity. Dispatch is cheap; a default-cap
`.bits` rescan exhausts 2.3 M in 190 ms on the loaded machine. Targeted
repricing models ~50 ms at 2.25 M against the historical quiet reference;
all seven valid benchmarks still need ≤1,450,008 units (64.44%). One shared
schedule cannot put every measured path/host within ±25%: identical array
charges differ 21–25× by implementation path; `.chars` has disjoint JS/Rust
price-fit intervals. The forced-generic diagnostic mode with raised caps
would still need ~0.79 M for 50 ms. These are unresolved constraints, not
an approved exception or a claimed universal deadline. Load never reached
<2; absolute quiet confirmation remains open.
**Alternatives**: blanket +1.5× EXT (worsens cheap calls/probes and misses
profile scans); lower default alone (~0.66 M for the existing scan witness,
losing valid-message headroom); host/path-specific units (breaks R6/D044);
optimise slow paths or extend fractional VM metering (future engineering,
not implemented by this measurement).
- [ ] **Signed off** (owner)

### D241 — Calibration adopted from the 2026-11-04 measurement (manager, per D230.1)
**Decision** (manager, provisional; the owner delegated calibration, D230
item 1): adopt D240's measured repricing so that kinds of work cost roughly
equal CPU per budget unit: UTF-8 profile scan and the byte-comparison quantum
`c64min` 64 → 8 bytes/unit; `.bits` scan 64 → 12 bytes/unit; `T_ELEM` 5 → 10,
`T_CMP` 8 → 6, `T_PROBE` 4 → 3 ticks, a cheaper first comparison chunk; default
budget 2,300,000 → 2,250,000. **Not adopted**: `EXT_CALL` 16 → 0 — the
measured 8 ns/unit for a no-op call already includes the 16-unit charge, so
removing it would make a call several times dearer per unit than the median.
**Why**: per-unit ratios measured in the same interleaved rounds cancel most
machine load; the machine never reached a quiet state (load 10.7–13.9 during
timing), so absolute milliseconds are recorded but not relied on. Forced-
generic paths cost 4–5× per unit more than their fast paths with identical
charges; one shared schedule cannot fit both, and the default favours normal
dispatch (the forced-generic flag is a test mode).
- [ ] **Signed off** (owner) — calibration was delegated; recorded for review.

### D242 — `.regexp` defaults to XSD; I-Regexp remains an explicit interop option
**Decision** (P8.3, provisional): `compile(text, {regexp: 'xsd' | 'iregexp'})`
defaults to `xsd`, following RFC 8610 §3.8.3's normative XSD 1.0 Part 2
Appendix F reference. Use the corrected XSD 1.0 class grammar, XML 1.0 fifth
edition NameStartChar/NameChar, and the existing pinned Unicode 16.0 scalar
categories. This is not the XSD 1.1 regex language: do not add its relaxed
escapes/block-name rules. Both dialects match the whole string; dot excludes
LF and CR, ^/$ are literals, category names are case sensitive, and class
complements operate on Unicode scalar text. No differing meaning was found
for patterns valid in both grammars. Explicit `iregexp` retains the existing
parser's admissions, refusals, automata and source keys. XSD source keys add
a ninth preimage element `0` (with empty Unicode/registry placeholders when
absent), binding the dialect without changing any Program field or version.
**Why**: audit §(e) identifies I-Regexp-only coverage as a deliberate deviation;
the larger regular language needs no new runtime machinery. RFC 9485 remains
a useful strict interoperability mode.
**Alternatives**: keep I-Regexp as default (does not follow the normative
reference); host regexps (different anchoring/escapes and no shared budget).
- [ ] **Signed off** (owner)

### D243 — XSD lowers to existing bounded range automata at compile time
**Decision** (P8.3, provisional): kin parses XSD into the existing Glushkov
tree. Class subtraction computes sorted range-set difference, after applying
the base's negation; nested subtraction shares the compiler nesting cap.
Each compared/copied range consumes compile budget. XML name classes are
small static ranges in kin, needing no optional module; `\s` is exactly
TAB/LF/CR/SPACE. `\d` is Nd; `\w` complements P/Z/C (so underscore is not
a word character); their complements and categories require `snug/unicode`.
Existing position limits (256 default, 512 hard), saturating repetition
counts, expansion checks, arena cap and compile budget apply. VM and Program
format are unchanged, including runtime work prices and scratch.

The pinned Node v24.6.0 / ICU 77.1 generator cannot query Block properties:
both `\p{Block=Basic_Latin}` and `\p{IsBasicLatin}` are syntax errors under
`u` and `v`. No authoritative block-name/range input is pinned in this tree.
Use the task's explicit fallback: refuse XSD `\p{Is…}`/`\P{Is…}` with a
`regexp` error explaining unavailable pinned block data, even with category
tables. The generator checks and reports this limitation; do not substitute
scripts or guess blocks from category runs. Block support remains a stated
coverage limitation pending an authoritative pinned offline input.
**Why**: all matching stays portable kin over ranges; explicit data refusal
is preferable to incorrect Unicode blocks. Ruby cddl uses Ruby regexps and
is not an XSD oracle; fixed expectations come from Appendix F and XML's name
productions, with Node `v` checks only for equivalent translated patterns.
**Alternatives**: change Program/VM (unnecessary); infer blocks from scripts
(incorrect); fetch/install Unicode data (forbidden by this task).
- [ ] **Signed off** (owner)

### D260 — The `valid` wire preset is the default; profile bit `PF_VALID` (P8.4, D230.2)
**Decision** (valid-CBOR engineer, provisional): a new host bit `PF_VALID`
(bit 8, 256) in the profile word (scanner `o[11]`, VM limits word 9) admits
RFC 8949's non-deterministic encodings: indefinite strings (definite chunks of
the same major type), arrays and maps; non-shortest heads (integers, lengths,
counts, tag numbers); floats of any width and NaNs with any sign, payload or
signalling bit; map keys in any order; bignums with leading zeros or small
values (§3.4.3). It still refuses every Appendix F well-formedness error
(`malformed` for the indefinite-structure ones, `truncated` for a missing
break), duplicate keys by value (D261, D263), invalid UTF-8 including a code
point split across chunks, invalid content of known tags (§5.3.2), §9.2's
invalid tag numbers, unassigned simple values (coverage gap left to P8.5) and
the limits. Presets: `valid` = 378 (= `PF_DETERMINISTIC | PF_VALID`, the
default of every host entry), `deterministic` = 122, `bindle` = 0; `PF_HOST`
= 383; internal `PF_CANON` = bit 9 (a walk over a canonical copy, D264). Zero
is still Bindle and every bit still admits more, so every old flag word keeps
its meaning. Architecture §19.1.
**Why**: D230.2 verbatim; one bit keeps the D120 model (and D200's size
budget) instead of a second axis; the deterministic walkers' codes and
offsets are untouched when the bit is clear.
**Alternatives**: a separate "wire mode" word (a second axis every API and
gate would carry); a lenient mode that skips validity (D230 forbids:
duplicates, UTF-8 and tag content stay checked).
- [ ] **Signed off** (owner)

### D261 — Values are compared by their canonical forms: DC for matching, EC for duplicates (P8.4)
**Decision** (provisional): an item's **DC** form is the §4.2.1 encoding of
its data-model value with map pairs in wire order (shortest heads, definite
lengths, chunks concatenated, floats in the shortest width that keeps their
exact bits, bignum content unchanged); CDDL literals, LITSET members, KEYS
entries and the key-order test compare DC bytes (`1` = `1801`, `"a"` =
`7f6161ff`, `1.5` = `fa3fc00000`, `1` ≠ `1.0`). Its **EC** form (§5.6.1) is DC
with float zeros positive, NaN signs cleared and every map's pairs sorted by
EC key bytes; two map keys are duplicates iff their EC bytes are equal. A key
is EC-sensitive when it contains a float zero, a NaN or a map of ≥ 2 pairs.
§5.6.1 read in `corpus/rfc/rfc8949.txt`: integer vs float, tag 2/3 vs integer,
text vs bytes, tagged vs untagged and simple vs integer are distinct;
`-0.0` = `0.0`; NaNs equal by zero-extended significand; arrays element-wise;
maps as sets of pairs. `2(h'0001')` ≠ `2(h'01')` at this level (the RFC notes a
tag-aware decoder may not distinguish them; snug's generic level does).
Architecture §19.2.
**Why**: for deterministic input DC is the input, so no existing verdict
moves; one definition serves the scanner, VM, sessions and views.
**Alternatives**: numeric equality across int/float (the RFC forbids it at
the generic level); bytewise equality (wrong for every non-canonical
encoding, and already wrong for `0.0`/`-0.0` keys under the deterministic
preset — fixed by D263).
- [ ] **Signed off** (owner)

### D262 — The scanner walks valid CBOR natively; the VM attempts deterministically and falls back to a canonical copy (P8.4)
**Decision** (provisional): `kin/scan.kin` checks valid CBOR natively and can
write the canonical copy (D264). The VM's buffer walks stay deterministic:
under `PF_VALID` a run first walks the input as the deterministic profile does
(the attempt); a refusal only a non-deterministic encoding causes
(`indefinite`, `non_shortest`, `key_order`) or an EC-sensitive key discards
the attempt (budget, items, witness and query flags restored) and takes the
canonical path: scanner + copy, then the unchanged VM over the copy under
`PF_VALID | PF_CANON`, offsets mapped back. What `PF_VALID` admits without
changing bytes (shortest-width NaNs with payload, bignum leading zeros,
D265's tag rules) both walks admit directly. `decode` and views read the copy
for non-deterministic input (an owned copy; `borrow` cannot apply). The
session walks natively (D266). Architecture §19.3.
**Why**: deterministic input costs what it costs today on every path; the VM
(1,570 + 557 + 426 lines of fused live walk with D044 fast paths, being
reworked by P8.2/P8.5 in parallel) gains no per-byte branches; one
canonicaliser serves decode, views, the VM and sessions.
**Alternatives**: a natively valid VM (every leaf, fast path and embedded
walk made chunk- and head-aware; reconsidered by D269's measurement);
canonicalising every input first (a copy and a second pass for deterministic
input too); views navigating indefinite items natively (every nav primitive
and directory chunk-aware, for no caller benefit: `raw()` was already the
canonical encoding).
- [ ] **Signed off** (owner)

### D263 — Duplicate detection: immediate while ascending, a deferred sorted check otherwise (P8.4)
**Decision** (provisional): per map, each key's DC form is compared with the
previous key's (the existing charge, on DC lengths): equal → `duplicate_key`
at once; descending → `key_order` under the deterministic profiles, else the
map is marked; an EC-sensitive key marks the map under every profile (this
fixes the deterministic preset's acceptance of `{0.0: 1, -0.0: 2}`). At a
marked map's end, after its pairs: records (comparison form, key offset),
heap sort, neighbours; `duplicate_key` at the earliest second occurrence (the
smallest offset of a key equal to an earlier one). Charges (program.md §14):
1 per record, ⌈min(len₁, len₂)/64⌉ (≥ 1) per sort or neighbour comparison.
The scanner rebuilds records by re-walking the marked map's keys; sessions
retain them. Architecture §19.4.
**Why**: deterministic and mostly-sorted maps pay nothing extra; n·log n with
n ≤ `maxEntries` is bounded and charged; reporting at the map's end is one
rule every walker (recursive, resumable, canonical) can implement identically,
so session == buffer holds in every word.
**Alternatives**: a hash set (adversarial collisions without a secret key);
immediate detection via an insertion-sorted run (O(n²) moves) or a √n tail
(O(n√n)); reporting at the duplicate key (needs the whole map's keys before
its pairs are walked, i.e. a second structural pass first, and changes
precedence against errors inside earlier values).
- [ ] **Signed off** (owner)

### D264 — The canonical copy: DC in wire order, an embedded table, offsets by lockstep, host scratch by retry (P8.4)
**Decision** (provisional): the scanner's walk (`scan-cb`, `scan-x`) checks; a
second trusted pass (`canon-build`) writes the item's DC form in wire order
only when the walk admitted an encoding that changes bytes (`VC_NONDET`),
≤ n + ⌊n/128⌋ + 16 bytes. Embedded table: every tag-24 payload and, with
`FL_EMBED`, every byte string whose content is valid non-deterministic CBOR
gets its own copy, and refused contents their refusal, consulted by the VM's
embedded walks under `PF_CANON`. Offsets map back by a lockstep walk of copy
and input (`map-back`), once per reported offset; no offset table. The
scanner's three buffer-needing checks (EC-form duplicate checks, tag-0/32
rules and tag-24 payloads over indefinite strings) are recorded and run after
the walk in walk order (exact precedence; a replay settles `maxItems`). ABI:
the scanner's options array is any length (words 16–23 a scratch header, the
rest records and deferrals) plus a byte buffer; `o[12..15]` carry outcomes,
needs and the copy length; too small answers the internal code `scratch` (22);
the VM's `vm-validate-v`/`-span-v` take the two buffers and answer −5 with the
sizes in `out[5..7]`; hosts grow and retry (D033). Charges per D277: the pass
is unmetered (linear), the run over the copy is charged as usual (key-order
comparisons included), each marked map's duplicate-check units at that map's
logical end. Architecture §19.5.
**Why**: wire order keeps the witness and the charges equal to the session's
native walk (D266), so all routes give one out array; deterministic input gets
neither a copy nor a second pass.
**Alternatives**: a sorted (fully deterministic) copy (reorders witnesses and
charges, so sessions could not match it); an offset table (memory per item for
a once-per-call mapping); charging the pass (the same value would cost
differently by encoding); threading a byte buffer through the scanner's walk
(a parameter on every hot function, and nested gathers alias the buffer).
- [ ] **Signed off** (owner)

### D265 — Decimal, ndarray, typed-NaN and 55799 rules belong to the Bindle tag set (P8.4; audit rank 9)
**Decision** (provisional): at tag level 0 (Bindle) the rules stay. At levels
1–3 (the deterministic and valid presets): tag 4 is RFC 8949 §3.4.4 (a
two-element array: integer exponent, integer or bignum mantissa); tag 40 is
RFC 8746 §3.1.1 (`[shape of unsigned integers "distinct from zero", data
array, typed array or homogeneous array (tag 41)]`, element count = product;
any rank — the audit's S58 reading of zero extents as valid is corrected by
the RFC text; tag 1040 stays opaque); LE float
typed arrays admit NaN; 55799 is admitted at any depth. Bignum minimality
(9..128 bytes, no leading zero) stays under the deterministic profile
(§3.4.3 preferred serialization) and is relaxed by `PF_VALID` (content
0..`maxBignumBytes` bytes). Hosts build `Decimal`/`NDArray` only from content
within their invariants, else `Tagged`. Architecture §19.6.
**Why**: audit S11, S57, S58, S59, S64 (rank 9): application restrictions are
not RFC validity; the Bindle preset keeps every 3sln.me code.
**Alternatives**: a separate "application rules" flag (another axis; the
Bindle tag level already names that model); keeping them in `deterministic`
(§4.2 does not require them).
- [ ] **Signed off** (owner)

### D266 — Sessions walk valid CBOR natively and take non-deterministic whole items by the canonical path (P8.4)
**Decision** (provisional): in the resumable session, frame heads may be
non-shortest; indefinite arrays and maps are frames with count −1 that look
for a break before each element (break in a map's value position:
`malformed`; end of input inside: `truncated`; entries counted as they
arrive); indefinite strings and every non-deterministic item the session takes
whole (the prescan scans to breaks) go through the attempt/canonical path
inside the step; map frames retain every key's comparison form and a record
in the key arena under `PF_VALID` (EC-sensitive keys only under the
deterministic profiles) and run D263's deferred check at the map's end; a key
that is not canonical is asked for whole and canonicalised into the arena for
the KEYS lookup; arena and record area grow on a new `VMS_GROW` suspension.
Profile-only handles under `PF_VALID` use the session against `any`; `rscan`
stays deterministic/Bindle (an EC-sensitive key there hands the handle to the
session). Sequences: an indefinite root ends at its break (D212 unchanged).
Architecture §19.7.
**Why**: a stream cannot be copied; frames already carry everything an
indefinite container needs except its count; taking non-deterministic whole
items by the canonical path makes the result independent of window
boundaries and equal to the buffer driver's.
**Alternatives**: buffering a non-deterministic stream message whole
(unbounded by design for streams); a streaming canonicaliser in front of the
session (a second resumable machine with its own offset map).
- [ ] **Signed off** (owner)

### D267 — Host defaults and values under `valid` (P8.4)
**Decision** (provisional): JS `wire: 'valid'` (default; `profiles.valid`),
Rust `Profile::VALID` (the `Default` of `DecodeOptions`, `EncodeOptions`,
`ValidationOptions`, sequence options); encoders write deterministic bytes
under every preset. Maps keep wire order; `Decimal`/`NDArray` only within
their invariants, else `Tagged`; bignums with leading zeros
decode to their integer (Rust keeps the content bytes); neither JS numbers nor
Rust's `Value::Float(f64)` keep every NaN payload (a View's `raw()` keeps the
bytes). Views over non-deterministic input own a canonical copy (`offset` is a
copy position; `borrowed` false); Rust's borrowing `View::open` and
`Schema::view` answer `Error::Usage("owned_view")` for such input and a new
`snug::Document` owns the copy; a view whose scan noted keys out of canonical
order searches maps linearly. Architecture §19.8.
**Why**: D230; the value model stays lossless where a host value can hold the
distinction and says so where it cannot (audit S66).
**Alternatives**: always `Decimal.normalize` (lossy, can fail for large
positive exponents); presenting maps in canonical order (surprising for
JSON-like data; no RFC meaning either way, §5.6).
- [ ] **Signed off** (owner)

### D268 — Gates under the new default; RFC vectors, equivalence property and a cbor2 differential (P8.4)
**Decision** (provisional): every gate that holds deterministic input names
its preset explicitly (flags 122 / `wire: 'deterministic'`, or Bindle 0) and
keeps its expectations. New: RFC 8949 Appendix A complete (every row,
including the non-deterministic encodings) and Appendix F (every example,
its code under each preset); duplicate keys by value; D265's cases; a
canonical-equivalence property (random values and their non-canonical
variants — indefinite splits, widened heads and floats, permuted keys —
decode and validate under `valid` exactly as the canonical encoding, and are
refused under `deterministic` with the documented code); a differential
against cbor2 2.4.1's default decoder (and with `rejectDuplicateKeys`) where
every difference falls in a documented class; JS == Rust; session == buffer
under `valid`. Architecture §19.9.
**Why**: D230's gate rule (oracle, JS == Rust, RFC vectors including
non-deterministic ones) and "without weakening".
**Alternatives**: flipping the old gates' default and re-deriving their
expectations (would hide a regression in the deterministic checker).
- [ ] **Signed off** (owner)

### D269 — The deterministic-only fast path: measured, decision recorded with the numbers (P8.4)
**Decision** (provisional, pending the measurement in P8.4): the VM attempt
(D262) and `rscan` are deterministic-only fast paths; the scanner has none
(its valid walk shares the deterministic code path). Measure, on the standard
inputs of bench/README.md and on their non-deterministic variants: `valid` vs
`deterministic` for decode, validate and sessions; the canonical path's cost;
and the scanner's deterministic path with and without the valid-mode branches.
Keep the split only where it is material; the deterministic **checking**
option stays regardless (dCBOR, CTAP2, signing).
**Why**: D230: "a specialised deterministic-only fast path is kept only if
measurement shows it is material".
**Alternatives**: decide without numbers.
- [ ] **Signed off** (owner)

### D270 — Group matching follows RFC 8610 Appendix A (PEG): prioritised choice, greedy occurrence
**Decision** (manager, provisional, per D230 "spec compliance first"; the
RFC quotation check of 2026-11-04 verified the text in `corpus/rfc/rfc8610.txt`):
RFC 8610 Appendix A is normative ("This appendix is normative") and gives
CDDL groups PEG semantics: `//` (and `/` for types) is a prioritised choice —
"tested in left-to-right order, locking in the first successful match" — and
occurrence indicators are greedy ("`*a a` in CDDL syntax never can match
anything"). snug's array and map matching currently computes exact
regular/existential semantics (D010–D012, with D011's determinism rule and
refusals); it therefore accepts data the RFC rejects (`[* uint, uint]` accepts
`[1]`; `[? uint, 2*3 uint, tstr]` accepts `[1,2,"x"]`) and refuses schemas
the RFC defines. Both reference tools (Ruby `cddl` 0.12.14, cddl-rs 0.10.7)
match greedily. New semantics, for **arrays and maps**:
- Groups are PEG expressions over the container's elements (arrays: in
  order; maps: entries tested in source order, each greedily consuming the
  remaining pairs it matches); choices are prioritised; occurrences greedy;
  no backtracking into a locked choice or a completed repetition.
- **Type** evaluation of a single item stays set-based (D010): an item's
  verdict for each candidate type is computed once, and the PEG runs over
  those per-element verdict vectors, so bytes are still read once (buffer,
  session and sequence drivers alike) and the PEG cost (≤ group nodes ×
  elements, packrat-memoised where needed) is charged to the budget.
- D011's determinism rule, factors and the `map_overlap` /
  `map_group_occurrence` refusals and D012's counter/unrolling refusals are
  withdrawn: PEG makes every such schema determinate.
- The D022 oracle must be re-based on PEG semantics (and differentially
  checked against the Ruby reference tool, noting its known defects).
- Likely a Program format major bump (2.0) for map/array group tables (D084
  rule); decided in the P8.5 design.
Supersedes D011, D012 and the group parts of D010/D035/D036; reframes P8.5
(no bipartite search is needed). P8.4 (valid CBOR) proceeds first.
- [ ] **Signed off** (owner)

### D271 — Cut scope: RFC text vs reference tools (OWNER QUESTION, interim: keep D021)
RFC 8610 §3.5.4 says that after a cut "the entire map fails to match", and
Appendix A says a cut disables "alternatives in choices containing this
choice"; both reference tools (and snug's D021) instead let another
group-choice branch match. D230 said to follow what the audit concludes the
RFC *and* the reference implementation mean; they disagree. Interim: keep
D021 (reference behaviour, now classified a deliberate deviation) as the
default, and implement the literal RFC cut as an option (`cuts: 'rfc'`) in the
PEG engine, where a cut is a commit. **Question for the owner:** default to
the reference behaviour (D021) or the literal RFC text? Recommendation: the
reference behaviour, because the literal reading makes the common
discriminated-union idiom `{ kind: "a", … // kind: "b", … }` unmatchable and
both reference tools agree.
- [ ] **Owner decision pending**
*Superseded 2026-11-10 by D301 (owner):* the default is the literal RFC cut
(this entry's `cuts: 'rfc'`); D021's reading survives as the non-default
`cuts: 'branch'` (rule A, D273). Implemented on `p85-peg` (P8.5 D301 note).

### D250 — Float literals, ranges and controls compare numerically: one zero, NaN unordered (P8.2, audit S15/S16/D038)
**Decision** (compliance engineer, provisional, 2026-11-04): RFC 8610 §3.8.6
compares numbers, so the float interval algebra treats −0.0 and +0.0 as one
number and NaN as a value outside every ordered comparison that is unequal to
every number. Compiler (kin/compile/{leaf,ctl,lower}.kin): a FLOAT run holds
both zero keys or neither (`mk-float-from` widens a bound on one to the other
and merges); a zero controller is the pair, so `.lt` stops below key(−0),
`.le` at key(+0), `.gt` starts above key(+0), `.ge` at key(−0), `.eq` is the
pair and `.ne` its complement; an exclusive range bound at zero stops below
key(−0); `.lt .le .gt .ge` clamp to [key(−∞), key(+∞)]; `.ne` complements
over the whole key space. VM (kin/vm-leaf.kin): a NaN of any width, sign or
payload is looked up as the key of `f97e00` (fff80000:00000000), so it
matches exactly the runs that reach past +∞ — those of an unbounded target
minus a point — instead of never matching a bounded leaf. No Program format
change (program.md §4.4 restated). Literal `0.0` and `-0.0` both match both
zeros (as before at run time, now also inside `.and` and range algebra), and
integer and float literals stay distinct kinds (S17).
**Why**: the audit's counterexamples (`float .lt 0.0`, `float .gt -0.0`,
`float .ne ±0.0` admitted a zero; `float .ne 1.5` refused NaN; bounded and
unbounded spellings disagreed). The new verdicts equal the Ruby cddl 0.12.14
reference on all 198 float vectors in corpus/conformance/audit-2026-11-04.json;
Rust cddl 0.10.7 differs on NaN `.ne` and on bounded ranges (its bugs).
**Alternatives**: a NaN flag bit in the FLOAT leaf (format change; the key
point is equivalent and keeps one interval algebra); a VM-only rule (cannot
fix `.and` of a zero literal with a range ending at −0); leave literal zero
as one key and special-case each control (several places to get wrong).
- [ ] **Signed off** (owner)

### D251 — An unplugged group socket is an empty group choice (P8.2, audit S32; amends architecture §4.8)
**Decision** (compliance engineer, provisional, 2026-11-04): an undefined
`$$x` lowers to an altset with no alternatives in maps (`as-none`) and to an
empty `G_ALT` in arrays — zero derivations, so `[ $$x ]` and `{ a: int, $$x }`
match nothing until plugged, while `? $$x` / `* $$x` / `0*0 $$x` match by
absence and `//=` plugs keep their meaning. The local oracle
(corpus/tools/oracle.mjs) resolves an undefined `$$x` to an empty `gchoice`
instead of `seq([])`. Corpus repair: adversarial.json "undefined sockets",
`{a:1}` against `r = {a:int, $$nothing}` is now **false** (regenerated by
export-adversarial.mjs; that one verdict was the only change); no other
corpus, proptest or oracle-differential expectation encoded the old reading
(the D022 oracle differential and vm-test stayed 3200/3200 after both sides
changed). architecture §4.8 is amended in place with a dated note; the old
text cited crate issue #838 for the empty-group reading, which §3.9's
"empty group choice" does not support. No D-decision stated the old
semantics (it lived in architecture §4.8, A12's coverage note and
cddl-support).
**Why**: §3.9 says an unplugged socket is an empty type/group *choice*;
the empty group has one empty derivation, the empty choice none. Ruby 0.12.14
and Rust 0.10.7 refuse both examples (25 socket vectors in the new corpus;
Ruby also refuses a plugged `[ $$x ]` with `[1]`, a Ruby defect — RFC kept).
**Alternatives**: a compile error for unplugged sockets (valid CDDL; an
extension point may be deliberately empty); keep the empty group (wrong).
- [ ] **Signed off** (owner)

### D252 — Known-tag validity: RFC 3339/4287 dates with leap-second placement, any-float epochs, RFC 3986 URI-reference (P8.2, audit S60/S61/S62, D121)
**Decision** (compliance engineer, provisional, 2026-11-04), in
kin/stdtags.kin (shared by scanner, resumable scanner and VM dead walk):
1. **Tag 0**: RFC 8949 §3.4.1 asks for RFC 3339 `date-time` "as refined by
   Section 3.3 of RFC 4287", so `T` and `Z` must be upper case (lower case
   was accepted). Second 60 is accepted only where a leap second can be:
   23:59:60 **UTC** (local time minus the offset) on the last day of a UTC
   month — ITU-R TF.460-6 places leap seconds at the end of any month (June
   and December preferred). What is checked statically: the placement, not
   the IERS announcements; which month ends actually carry a leap second is
   time-dependent data (announced months ahead), so every month end is
   admitted and no table is consulted. Negative leap seconds (a missing
   23:59:59) cannot be detected without that table and are not.
   `2024-01-01T00:00:60Z` (the audit's counterexample), second 60 mid-month
   or at 23:58 are refused; `1990-12-31T15:59:60-08:00` (RFC 3339 §5.7's
   example) and `2017-01-01T00:59:60+01:00` are accepted.
2. **Tag 1**: an integer of major 0/1 or a float of any width, **including
   NaN and ±∞**: RFC 8949 §3.4.2 makes other contained types invalid and only
   discourages non-finite values (it recommends null/undefined instead).
   D121's finite-only rule was stricter than the RFC; bignums and text stay
   invalid.
3. **Tag 32**: RFC 8949 §3.4.5.3 requires the RFC 3986 `URI-reference`
   production, so relative references (`/a/b`, `//host`, `?q`, `""`) are now
   valid (they were refused) and the full grammar is checked: scheme, a
   relative first segment without `:`, authority = [userinfo@]host[:port]
   with reg-name, IPv6address (pieces, one `::`, embedded IPv4) and
   IPvFuture literals, pchar paths, query and fragment. `http://[x`,
   `http://[1::2::3]/`, nine IPv6 pieces, a non-digit port, `1a:b` are
   refused. RFC 6874 zone identifiers (`%25eth0`) are outside RFC 3986 and
   refused. A linear, bounded recogniser (each byte read at most twice).
4. **Opaque versus validated tags** is now stated in cddl-support: tags
   0/1/24/32, 2/3/4/40, the typed arrays and 55799 are validated; every
   other tag (5, 21–23, 33–36, **1040**, unassigned) is opaque — admitted
   with any valid content. Tag 1040 (column-major arrays, RFC 8746 §3.2) is
   opaque under `tags:'any'`; structural validation, if advertised, belongs
   to P8.4's application-rule split (audit rank 9).
**Why**: audit rank 3; S61 non-conformant, S60 deliberately under-checked.
Checked against the RFC texts in corpus/rfc (fetched by 7850146): RFC 8949
§3.4.1 ("as refined by Section 3.3 of [RFC4287]"), §3.4.2 (non-finite values
"interpreted as determined by the application"; null/undefined recommended
instead), §3.4.5.3 ("doesn't match the "URI-reference" production ... is
invalid"); RFC 3339 §5.7 (60 "at the end of months in which a leap second
occurs", 58 when one is subtracted). Reference tools are no oracle here:
Ruby 0.12.14 refuses **every** second-60 time, including real leap seconds
and RFC 3339's example, and accepts tag 1 over text; neither Ruby nor Rust
checks URI syntax. Verdicts: corpus/conformance/audit-2026-11-04.json and
corpus/cbor-vectors/deterministic.json (vectors changed: lower-case tag 0
now refused; tag 1 NaN/−∞ and the relative tag-32 reference now accepted;
new leap-second and URI vectors).
**Alternatives**: a leap-second table (stale the day it ships; time-dependent
validity); keep `URI` only (contradicts RFC 8949's production); keep finite
epochs as the default (a local rule; the Bindle preset already refuses
non-finite floats outright).
- [ ] **Signed off** (owner)

### D253 — D241 implemented: the repriced schedule and the 2.25 M default (P8.2)
**Decision** (compliance engineer, provisional, 2026-11-04; implements D241):
the UTF-8 profile scan (live, dead, session, the streak and pre-scalar key
charges) costs ⌈len/8⌉ (was ⌈len/64⌉); every byte comparison (`c64min`:
literal, LITSET member, key, key order; the name is kept, the quantum is now
8 bytes, minimum 1) ⌈min/8⌉; the `.bits` scan ⌈len/12⌉; `.unique` records
T_ELEM 10 (was 5) and compares T_CMP 6 (was 8); `.samelen` probes T_PROBE 3
(was 4); the generic controls' byte comparison charges its first 8-byte
chunk C_FIRST 2 ticks up front (was C_TICKS 8), later chunks 8; the compiled
default budget (option 17) is 2,250,000 (was 2,300,000). `EXT_CALL` stays 16
(D241). Also repriced, by analogy and not separately measured: the tag-0/32
form scan after its content, ⌈len/8⌉ (was ⌈len/64⌉) — D252 made the URI scan
a full RFC 3986 recogniser, byte-wise work of the UTF-8 scan's kind. Kept:
the typed-array float NaN scan ⌈len/64⌉, TPU 8, T_HEAD 3, T_PAIR 5, C_BYTES 8,
B_HASH 1, B_TEXT 16. program.md §14 restated; §15's worked totals are
unchanged (every text and comparison there is under 8 bytes); the §15 header
word LIM_BUDGET is 2,250,000. Budget-used expectations changed only where they
are budget numbers (vm-cases' D046 case now runs at the 2.25 M default).
**Why**: D241 (the owner delegated calibration, D230.1). Before/after
calibration: P8.2 and bench/VM.md "Calibration 2026-11-04 — D253/D254
confirmation".
**Alternatives**: as D240/D241.
- [ ] **Signed off** (owner) — calibration was delegated; recorded for review.

### D254 — The forced generic path is charged by its own schedule, the table (amends D044, D045) (P8.2; manager's D241 follow-up)
**Decision** (compliance engineer, provisional, 2026-11-04): schedule 2's free
bookkeeping (D045) prices what the fast paths do for the simple shapes; the
reference VM's diagnostic switch that forces every item onto the generic walk
(`limits` word 8 bit 0, not public API) now selects schedule 1 — the table,
which is the bookkeeping that walk actually does. One line in vm-api: word 8
bit 0 or 1 → schedule 1. D044's identity becomes: **the same input under the
same schedule gives identical charges on every host and driver** (buffer and
session, every window split and quantum, JS, Rust and wasm), and the fast
paths equal the generic walk under schedule 1 word for word. vm-test's
fast == generic arm now compares the forced run with the schedule-1 fast run
(whole out array) and keeps the existing check that schedule 1 differs from
the default only in the budget used (verdict, reason, offset, items and path
equal unless either run hits the budget).
**Not done, and why**: charging *natural* generic dispatch by a second
schedule. In this VM the fast paths are streaks inside the same walk, taken
or not per element; in the resumable session whether a streak runs depends
on the window and the quantum's cut (D091, D093). Example: `r = [* uint]`
over 100,000 small integers. Through the buffer driver every element after
the first runs in the integer streak; through a push source fed 1-byte
chunks, the streak stops at each window end and the element straddling it
takes the generic step, about 100,000 times; fed 64 KiB chunks, a handful of
times. With per-path prices the units used would differ across those three
runs, and a budget set between them would refuse the 1-byte-chunked stream
with `budget` while accepting the same bytes from a buffer — a verdict that
depends on chunking, breaking the buffer == session identity vmsession-test
holds under every split and yield.
**Compile-time-known generic paths**: these can carry their own price
without that dependence, because the choice is a property of the Program
(and the item's query), not of the window — and they already do. Schedule 2
rules 1–3 apply only to the shapes the fast paths serve (a `[* T]` block with
a one-answer typeset; a closed-struct or pure-table map leaf; one scalar
leaf); a map whose table is neither (`map-fast-mode` 0), or an array whose
group is not one self-looping position, can never take a fast path in any
driver and is always charged by the table, which is the generic walk's own
schedule. No *further* surcharge is applied to them: their measured CPU per
unit is already in band (array automaton 0.68×, six-way map choice 1.21× of
the JS kind median; Rust 0.82×, 1.14×; bench/VM.md calibration), so a
separate price would have no measurement behind it. The 4–25× outliers were
the fast-path shapes forced onto the generic walk under schedule 2 — exactly
what this decision reprices.
**Alternatives**: per-element dispatch-dependent charges (chunk-dependent
verdicts); leave forced generic on schedule 2 (its units would mean 4–25× the
CPU of everything else; harmless for users, misleading for calibration).
- [ ] **Signed off** (owner)

### D272 — PEG group semantics for arrays and maps, with R1–R19 resolved (P8.5)
**Decision** (designer, provisional; architecture §20.2–§20.3 rev 2): adopt
the `run` definitions for arrays and maps. Arrays: prioritised `//` that
locks in; greedy occurrences; no retry from the end-of-array test; a
zero-length iteration satisfies its repetition; minima ≥ 2^24 saturate and
are not lowered to `FAIL`; `0*0` is `EMPTY`. Maps: members run in source
order, each taking remaining pairs whose key and value match, up to its max;
non-cut members skip a key-only match; choices lock in; closedness is tested
after the root; an unplugged `$$g` is `FAIL`; guarded recursion is allowed
and left recursion refused; `~tag` gives the content type.
**Why**: RFC 8610 App. A/C are normative. Every ambiguity is resolved and
labelled as RFC text or snug policy (two independent reviews).
**Alternatives**: an existential reading of maps (App. C's "can be ordered")
was rejected because it brings back permutation search and §3.5.3 allows
either pick.
- [ ] **Signed off** (owner)

### D273 — Cut modes: `reference` = rule A (default), `rfc` = commitment epochs (P8.5; refines D271)
**Decision** (manager 2026-11-04, after review C1). `reference`: a cut
member that meets a key match with a wrong value returns `cut`. `SEQ` and
`REP` pass it through; only `//` absorbs it, and re-raises it if every
alternative fails. `rfc`: per-attempt commitment epochs; `fail!` scope is
the map type (R19).
**Why**: name transparency. App. C says a rule's semantics "does not change
when the name is replaced by its (parenthesized if needed) definition", and
App. H calls its verbose and compact `reputon` forms "equivalent". Revision
1's mode made them differ. Rule A keeps D021's discriminated unions.
**Alternatives**: the D021-DNF/Ruby reading (revision 1; Codex Q1) breaks
transparency. It is recorded as Ruby class RC (7 probes) and as 22 corpus
flips.
**Owner questions**: which mode is the default (D271), and whether to rename
`reference`. *Answered 2026-11-10 by D301 (owner):* `rfc` is the default and
`reference` is renamed **`branch`**; no `reference` alias is accepted
(pre-release). Kin option word 20 / SOURCE_KEY `cuts`: 0 `rfc`, 1 `branch`;
FLAGS bit 5 is `CUTS_BRANCH` (P8.5 D301 note).
*Amended (revision 3, 2026-11-04; re-review N9):* rule A honours §3.5.4's later-entry restriction through `?`, `*` and named groups only. An explicit `//` absorbs a cut (`{(a: int) // (), * tstr => any}` accepts `{a: "x"}` while `{? a: int, * tstr => any}` rejects it), so rule A deliberately departs from App. C's occurrence-as-choice expansion when cuts are involved. App. H transparency is satisfied by both modes and does not select rule A alone.
- [ ] **Signed off** (owner)

### D274 — Pick order is EC key order; T sorts its own records (P8.5)
**Decision** (manager decision 2): a member with a finite max takes the
first matching pairs in EC key order (§19.2). F and S never need an order.
T heap-sorts a permutation of its records with kin's EC comparator, only
when it has an order-sensitive member and the map was unordered or had an
EC-sensitive key. Comparisons are charged identically on every route.
§19.4's permutation is not used.
**Why**: verdicts depend on the value, not the serialisation (§2.2.3, D230).
No dependency on the scanner path, which exists only on the buffer
canonical route (review C4).
**Alternatives**: wire order (Ruby; depends on the serialisation); reusing
§19.4's permutation (not available on every route).
*Amended (revision 3; N4):* T sorts its records whenever the map is unordered or EC-sensitive, whatever its members, because cut traversal, failure scores and steps depend on order even with unbounded members. F and S scores do not depend on order (program-2 §8).
- [ ] **Signed off** (owner)

### D275 — Evaluation: relaxed query automaton, verdict records, incremental machine, tiers; no memo in 2.0 (P8.5)
**Decision**: arrays are evaluated once against relaxed Glushkov candidates
(with `CALL` fixed points). A per-element record is the A′ bitset. The
incremental PEG machine runs in tiers A0/A1/A2 by B, the maximum FL over
backtrack attempts, with syntactic `ml` and `ml(FAIL) = 0`. Recursive
programs keep all their frames in the arena behind activation records.
Maps are evaluated once per pair, in tiers F (stop-at-taker), S (slots plus
imported unnamed state) or T (records), after the exact fold table. Key
lookup covers the full range once keys stop ascending. Memo fields are
reserved and must be 0.
**Why**: single-pass reading on every driver; the superset and read-bound
lemmas (proved by both reviewers); the memo design was incomplete (EOF rows,
link proofs).
**Alternatives**: evaluating against the whole group alphabet (more work,
same verdicts); shipping memo cells (deferred).
*Amended (revision 3; N2, N5):* recursive frames live in per-block lists of 64-word chunks from a chunk heap with a free list (not one LIFO region). Folded `FAIL` nodes carry provenance.
- [ ] **Signed off** (owner)

### D276 — The group arena is sized from limits and grown on demand; `group_limit` only under an explicit limit (P8.5)
**Decision** (manager decision 3): `A_max = maxItems·R_ITEM_MAX +
2·maxEntries + (maxItems + D + 1)·ACT_WORDS`. The buffer route grows by
code 22 and a single re-run; sessions grow by `VMS_GROW`. Code 44
`group_limit` applies only under an explicit `groupWords` limit. A charge
always precedes its allocation, so `budget` wins on the same event.
Offsets are the item head, or the container head for end-runs.
**Why**: no refusal of valid data at default limits (C5); memory and CPU
stay separate resources (X Q11).
**Alternatives**: a fixed 65,536-word arena (revision 1; refuses valid T
maps from about 16k pairs); pricing records so the budget always runs out
first.
*Amended (revision 3; N1, N3):* the bound sums activation words over simultaneous recursive leaves (`ACT_SUM`) and counts items globally (`VM_GROUP_ITEMS`, not reset by EMBED). Allocation follows demand by doubling (buffer: re-run per doubling; session: `VMS_GROW` with relocation by stable chunk indices), up to a cap: the explicit limit, else `LIM_GROUP_WORDS` (default 4,194,304 words, at most 2^24, outside `LIM_TOTAL_BYTES`). `group_limit` is a miss at the cap. **Partly rebuts** "never at defaults": no finite default can promise it. Instead: no refusal below the cap, and compile warning W7 when the worst case exceeds the cap.
- [ ] **Signed off** (owner)

### D277 — One charging order on every route; duplicate-check units at the map's logical end (P8.5; requirement on P8.4)
**Decision**: buffer, canonical-copy and session routes charge the same
events in the same logical order (program-2 §10). At a map's end the order
is: deferred duplicate check, end row, T sort, machine, closedness, witness
trace. **This requires amending architecture §19.5**, which today charges
the duplicate check before the VM starts: the scanner records per-map unit
counts and the VM charges them at that map's end.
**Why**: Codex X4's counterexample exhausts at different points on the two
routes.
**Alternatives**: precharging on the session route too (the session cannot
know the sort cost before reaching the map).
*Note (revision 3):* agreed by P8.4 and amended into §19.5 in 531220f. Refusal order is D280.
- [ ] **Signed off** (owner)
- [x] **Agreed** (P8.4 / §19 owner, 2026-11-04): §19.5 amended — the scanner
  records each marked map's duplicate-check units with the map's position, the
  copy writer translates it, the VM charges at the map's logical end (before
  its end row), as the session does. Same exhaustion point on every route.

### D278 — Witnesses (amends D024), forced-tier test mode, compile warnings (P8.5)
**Decision**: arrays report the farthest event (E1/E2/E3). Maps report the
first unacceptable pair at that pair, or else an end trace that scores each
failure by trail length before undo. A cut is reported at its diagnostic
pair (smallest wire index in scope). End-of-map witnesses are shallow. A
forced-tier test mode (limits word 8 bit 2) gates equality of verdict and
witness. Compile warnings W1–W6 never refuse.
**Why**: the witness must be the same in every tier and on every route
(C8, X5, X12); the warnings flag PEG surprises (C12, X Q16).
**Alternatives**: deep witnesses at map end (needs path copies); witnesses
that depend on the tier.
*Amended (revision 3; N4, N5, N7):* `FAIL` events (arrays E4; maps scored `missing` with provenance). A `CHOICE` re-raising `cut` passes its best event. Forced-tier equality holds under sufficient resources, with resource outcomes gated per schedule. Encoding invariance covers the verdict and the wire-independent witness parts. Warning W7 added.
- [ ] **Signed off** (owner)

### D279 — Format 2.0, the PEG oracle, and proven complexity contracts only (P8.5)
**Decision**: Program format 2.0; 1.x is refused (D084 major bump). An
independent PEG oracle replaces D022's existential oracle. Corpus
expectations are tagged rfc / policy / observed / invariant. D270's
nodes × elements claim and revision 1's O(|G|·n) claim are withdrawn; only
the contracts of architecture §20.7 are stated.
**Why**: S5–S10 change meaning; the oracle checks semantics, not mechanisms
(X14); the linear claims were false (X10, C10).
**Alternatives**: a format 1.2 keeping both engines.
*Amended (revision 3; N8):* the verifier cost figure and the A0/A1 linear bound are proof obligations, not established bounds.
- [ ] **Signed off** (owner)

### D280 — Refusal replay on the canonical path (P8.5/P8.4; re-review N6)
**Decision** (designer, provisional; needs P8.4's agreement and a §19.5
amendment): when the canonical path's scanner refuses, it records the code,
input offset and logical event (the refused item's head; a map's end for a
deferred duplicate check; the break / end-of-input position). The copy
writer builds the copy of the valid prefix, and the VM reports the recorded
refusal when its walk reaches that event. Before that, profile-only
continuation (D023) and `budget` stopping (program.md §17 Q17) apply as on
every route.
**Why**: D277 deferred units but not refusals. On
`9f00a3020001000200ff` under `r=[uint,{* int=>int}]` the buffer route
refused `duplicate_key` before the VM ran, while a session spent its budget
first. Replay makes the out arrays identical. §19.5 already does this for
embedded content.
**Alternatives**: making the session pre-scan whole items (breaks
streaming); accepting route-dependent codes (breaks R6/§17.5).
- [ ] **Signed off** (owner)
- [x] **Agreed** (P8.4 / §19 owner, 2026-11-04): §19.5 amended with an F2
  checklist. Implementation: a refused input's canonical copy is a partial
  copy written by a prefix writer that checks well-formedness in the scanner's
  order and stops at the first item that cannot be read; the stop is planted
  (a malformed head of the source's major type; a string running past the end
  where the source has no byte; a text of an indefinite text's chunks with the
  invalid byte at its offset), so the VM's ordinary walk reaches the refusal
  at its own check phase after the same visits, counts and charges; the end
  of input where a key or indefinite entry would begin, too many entries in
  an indefinite container and deferred duplicates are end events of their
  container (after its D277 units, before its end-run); immediate duplicates
  (and `key_order` under deterministic profiles) are key events after the
  key-order charge; definite containers keep their counts and zero padding
  keeps every length claim true. Embedded content is copied by the same writer.
  A planted refusal is reported with the stop's own code and offset.

### D281 — PEG group arena: 16 MiB default cap with compile warning W7 (manager)
**Decision** (manager, provisional; answers architecture §20.16's arena
question): the PEG group arena grows on demand to a default cap of 4,194,304
words (16 MiB; hard cap 2^24 words), counted separately from the
Program/scratch cap; `group_limit` (code 44) applies only under an explicit
`groupWords` limit, and the compiler emits warning W7 when a schema's worst
case can exceed the cap. **Why**: the final PEG check accepted the partial
rebuttal that no finite default can promise "never refuses at default limits"
(the twenty-recursive-leaf family needs memory linear in leaves × items); a
documented, explicit cap with a warning is the honest contract, like the step
budget.
- [ ] **Signed off** (owner)

### D283 — Sessions under valid CBOR, as built: whole items checked by the scanner first, keys kept as DC forms, `vms-step-v` with `VMS_GROW` (P8.4; implements D266)
**Decision** (P8.4, provisional): D266's session design is built with these
choices. (1) The valid machinery runs only when a step is given its buffers
(`vms-step-v(…, vs, cb)`); a buffer too small suspends with `VMS_GROW`
(-69; `vms-grow-words/-bytes/-scratch/-arena`), the host grows it (S and the
key arena keep their contents) and steps again over the same window;
`vms-step-x`/`vms-step` (no buffers) walk as before P8.4. It runs for valid
runs and for any-key profiles (EC-sensitive keys, D263). (2) A whole item is
checked by the scanner over the window first (one byte more window asked while
it may be truncated by the window, so an item is walked in the feed that
completes it): clean (own DC form, no marked map, no EMBED content) → the
buffer walk in place; else the canonical copy with its events (D264, D280),
offsets mapped back; under deterministic profiles only an EC-sensitive key
sends it to the copy. Refused items whose bounds pass the window always take
the copy (the in-place walk may read ahead). (3) Map keys are asked for whole
(no arena copy across windows) and kept as DC forms with a 12-byte header;
the deferred check at the map's end recomputes the scanner's records from
them. (4) The prescans treat indefinite items as levels closed by their break.
(5) `rscan` answers `scratch` for valid handles and EC-sensitive keys; hosts
route profile-only streams under `PF_VALID` or any-key profiles to the session
against `any` (native and wasm SDK). Architecture §19.7 amended.
**Why**: the scanner pre-check avoids rolling back a failed in-place attempt
inside a session; asking keys whole keeps one key form; buffers by suspension
keep the step free of allocation (D033).
**Alternatives**: the attempt-then-canonical order of the buffer driver
(needs a rollback of S per item); keys copied across windows into the arena
(a second form to canonicalise).
- [ ] **Signed off** (owner)

### D284 — Unassigned simple values are values: `Simple(n)`, admitted under `valid` and `deterministic` (P8.4 follow-up; coordinator under the owner's standing rule)
**Decision** (coordinator, 2026-11-11, applying the owner's standing rule
"spec conformance is the default", D230.2; supersedes the provisional
"refused under every preset" of P8.4): RFC 8949 §3.3's unassigned simple
values — `e0`–`f3` (0..19) and `f8 20`–`f8 ff` (32..255) — are well-formed,
valid and deterministic (§4.2.1 does not exclude them), so the `valid` and
`deterministic` presets accept them and `bindle` keeps refusing them
(`simple`). `f8 xx` with xx < 32 is not well-formed (§3.3, Appendix F):
`malformed` under every preset but Bindle (which keeps `simple`, and
`non_shortest` below 24 under the deterministic head rule as before).
- **Flag**: the existing `PF_UNDEFINED` (bit 5) now admits every simple value
  other than false/true/null — `undefined` and the unassigned ones — and makes
  `f8 18`–`f8 1f` `malformed`; no new bit, so the presets (378, 122, 0) and
  every flag word keep their numbers. JS `undefinedValue` / Rust
  `undefined_value` govern both.
- **kin**: `scan-simple` (scanner, rscan, VM attempt, dead walk, session via
  the eval walk); the VM's SIMPLE leaf matches `#7.n` for n 32..255 by the
  `f8` argument; the compiler lowers `#7.32`..`#7.255` (RFC 9682 §3.2) to a
  SIMPLE leaf (`#7.24`..`#7.31` stay the empty type; RFC 9682's `#7.<type>`
  head numbers are not parsed) and writes `f8 n` for one in a control
  argument; `vm-verify` admits SIMPLE leaves 0..23 and 32..255. The canonical
  copy, DC/EC forms and duplicate detection needed no change: a simple value
  has one encoding, so keys compare by value bytewise (`{f0: 1, f0: 2}` is
  `duplicate_key`, `{f8ff: 1, f0: 2}` `key_order` under `deterministic`).
- **Values**: JS `Simple` (exported; `value` 0..19 or 32..255, else
  SnugFault `simple`; interned and frozen, so `===` and `Map` keys compare by
  value); decode builds it; `encode`/`Writer#value` and the new
  `Writer#simple(n)` write the shortest form, `simple` without
  `undefinedValue`; views report kind `'simple'` with `simple()` (View and
  Cursor). Rust `Value::Simple(u8)` (encode refuses 20..=31 with `simple`),
  `Writer::simple`, `View::simple`. The wasm SDK shares the native builder and
  gains the same encoder branch and view accessor (D300).
- **Not a Program format change** (D084 left at its version): a SIMPLE leaf
  above 23 was unrepresentable before (`#7.32` was `ERR_MAJOR`); an older
  verifier refuses such a Program (`C_LEAF`) rather than misreading it. The
  format-2.0 branch (`p85-peg`) inherits the widened check when it rebases.
**Why**: the standing rule; RFC 8949 Appendix A's `f0` and `f8ff` must
decode under the default; cbor2's default decoder agrees on every one of
these inputs (it refuses `f818`–`f81f` and accepts the rest).
**Alternatives**: a new profile bit (renumbers every preset that gates,
hosts and stored callers carry); a non-interned class (Map keys by identity
would make `get(new Simple(16))` miss); returning a bare number (collides
with integers); admitting them under `valid` only (§4.2.1 does not exclude
them, so `deterministic` would refuse deterministic CBOR).
*Done 2026-11-11* (the D284 engineer): vectors — deterministic.json's
Appendix A `f0`/`f8ff` move to accept and a simple-values section (accept
`e0`, `f3`, `f820`, arrays, keys, values; refuse `f818`/`f81f` `malformed`,
`f8` truncated, out-of-order and duplicate simple keys); valid-test's two
kept differences for them are gone (RFC 8949 Appendix A now 243/243 in the
RFC runner, which had expected this all along); the cbor2 differential drops
`rejectSimple` (cbor2 then agrees on every simple input); vm-allcases' live
schema lists the 244 `#7.n`. **Learnt**: `scan-simple`'s answer is the item's
end, so the two-byte form needed `pos + 2` (every walker returns it); RFC 9682's
`#7.<32..255>` suite still fails on the unparsed `#7.<type>` syntax.
- [ ] **Signed off** (owner)

### D285 — Bundle growth for valid CBOR, attributed and cut; caps at measured + 2% (P8.4; R9 per D200, owner sign-off)
**Decision** (P8.4, provisional): the caps of the entries below rise to their
measured size + 2% (Ceil, each of min/gzip/brotli, static and full), after the
cuts listed; every other entry keeps its cap. Measured with `node
tools/size/size.mjs --details` (esbuild 0.28.2, Node 24.6.0) on main `c48ac45`
and on the P8.4 increment, minified bytes unless gzip is said:

| Entry | before min / gzip | after min / gzip |
| --- | ---: | ---: |
| `snug` (codec) | 43,382 / 14,988 | 60,895 / 20,927 |
| `snug/writer` | 39,900 / 13,800 | 57,050 / 19,562 |
| `snug/view` | 56,483 / 19,306 | 74,534 / 25,313 |
| `snug/schema` | 94,104 / 34,615 | 127,127 / 45,405 |
| `snug/sources` | 123,849 / 45,985 | 165,795 / 60,823 |
| `snug/sequence` | 151,945 / 54,323 | 193,871 / 68,871 |
| `runtime` | 118,069 / 42,474 | 148,837 / 53,322 |
| `all-runtime` | 208,149 / 74,901 | 251,727 / 90,625 |
| `snug/compile` (full closure) | 224,494 / 76,287 | 257,592 / 87,176 |

**Attribution** (`runtime`, minified, module deltas): `cbor/vcopy` +9,490 (the
VM's canonical copy of non-deterministic or refused input and its replay events,
D264/D280); `cbor/canon` +7,968 (keys' DC/EC forms for duplicate-by-value and
EC-sensitive detection, their sort and comparison, the codec's DC copy via `cw`,
indefinite-string gathering); `cbor/scan` +6,584 (indefinite arrays, maps and
strings, the valid key step and records, the deferred checks of marked maps,
tag-0/32 text and tag-24 payloads over indefinite strings, any-width tag 4/40
content); `cbor/tags` +1,520 (RFC 8949 §3.4.4 / RFC 8746 rules above the Bindle
tag set, D265); `vm/api` +1,370 (`-v` entries, `vm-canon`, offset remapping);
`vm/dead` +1,103 (replay hooks, `head-fail`, `pair-v`); `vm/eval` +711; host
glue (scan, schema-core, build, profiles) about +1,600. Sessions and sequences
add `vm/svalid` +3,703 and `vm/scont` +4,518 (D283's whole items, kept DC keys,
`vms-step-v`).

**The codec entry** (`snug`: decode, scan, encode, no schema) holds only
`cbor/scan`, `cbor/canon`, `cbor/tags`, `cbor/head`, `cbor/stdtags` and host
modules: no `vcopy`, no `vm/*` module is reachable from it (the per-entry module
list in the attribution; the codec's copy is `canon.kin dc-copy`, P8.4 changed
it from a second writer to `cw` over a copy of the input). What a schema-free
decode needs of the growth: the valid walk (indefinite lengths, non-shortest
heads and floats, any key order), duplicate keys by value on unsorted maps and
EC-sensitive keys (the keys' canonical forms, sorted), the known tags' content
over indefinite strings, and the DC copy the trusted builder reads.

**Cut** (before the caps were set): the codec's second canonical writer
(`cw-dc`, -950 min in every entry with the codec) replaced by `cw` over a copy;
the duplicated typed-array NaN check (one `typed-nan-at` shared by the scanner,
the buffer walk and the session, -364 in VM entries); `scan-x` and
`scan-item-x` as one walk (`scan-run`); dead `map-back`/`map-seq` in canon.kin.
**Considered, not done**: loading the canonical copy (`vcopy`) lazily or from a
separate entry (synchronous `validate` cannot await a dynamic import, and under
the `valid` default any VM user can meet non-deterministic input); dropping the
refusal replay (D280, agreed; it is what makes a refusal's code, offset and
budget equal on both routes); a deterministic-only scanner beside the valid one
(duplicates the walk in every entry that needs both); dropping the VM's
deterministic attempt (no code saved -- the attempt is the VM walk the canonical
path also runs -- and 2.3-6.9x slower on deterministic input, D286).
**Why**: duplicate keys by value on unsorted maps need the keys' canonical forms;
non-deterministic input in a schema needs the canonical copy and replay for
D277/D280; no smaller correct walk was found.
- [x] **Signed off** (owner, 2026-11-11, via coordinator: "sure the bundle
  size increase is fine"). A pre-release size pass is queued as P8.7, on the
  coordinator's recommendation.

### D286 — The deterministic-only fast path is kept: the VM attempt; sessions pre-check structurally (P8.4; D269's measurement)
**Decision** (P8.4, provisional): the buffer driver keeps its attempt over the
input (D262) before the canonical path: forcing the canonical path on
deterministic input costs 2.3-6.9x (bench/README.md "Valid CBOR (P8.4)"), and
the attempt costs no code (it is the VM walk). The scanner and `rscan` keep no
separate deterministic path (the scanner's valid branches cost 0.8-1.2x on
deterministic input; `rscan` answers `scratch` for valid handles). Sessions
take a whole item through a structural pre-check (`skim`, vm-session-valid.kin:
well-formed, definite, no EC-sensitive key, no tag-24 payload; in a valid run
also shortest heads, ascending keys and no `.cbor` byte strings) before the
scanner's pass; a clean item is walked in place. Measured on deterministic
input: decode/validate/scan 0.8-1.2x of main under both presets; sessions
1.1-1.4x (1.2-2.0x before the pre-check). Non-deterministic input: 1.2-8x
(codec, VM), sessions up to 23x on many small reordered maps -- recorded as an
open performance item.
**Why**: D230: a deterministic-only path is kept only where it is material;
the attempt is (2.3-6.9x), a separate scanner is not.
**Alternatives**: always the canonical path (slower, no smaller); a second,
deterministic-only scanner (larger, no faster).
- [ ] **Signed off** (owner)

**D286 open item analysed (2026-11-11, performance analyst;
[bench/D286-analysis.md](bench/D286-analysis.md)).** The sessions' 23x is mostly
grow-restart amplification, not the canonical path: every session host (JS
`VmSession` and `sequence.mjs`, Rust `Session`, wasm SDK) starts its valid
buffers at 512 words / 1024 bytes, and each `VMS_GROW` reruns the item's
scanner pass and copy from scratch -- 7 full passes for a 72 KB root (events
grow `vs` by doubling; S grows in its own round). With the buffers kept the
session equals the buffer driver (maps `rev` 88.3 -> 24.7 ms; buffer 24.0).
The canonical path itself (both drivers, 4-8x the deterministic walk) goes to:
the prefix writer re-walking every child (`tskip` per child at every depth),
`visit`/`uvisit` walking copies with no tag 24 / no marked map, the units pass
redoing the scanner's duplicate-check sorts, copying input whose bytes do not
change (reordered keys only), and the PF_CANON walk over unsorted maps.
Prototyped in `.cache/d286wt` (kin edits, emitted; `valid-test` and
`bb vmsession-test` ok, budgets equal on every route): B -- `pw` returns the
source end, `visit` only with a tag 24 or `.cbor`, `uvisit` skipped when the
scanner charged no units: 1.2-1.8x on indefinite / non-shortest / indefinite
strings; C -- no prefix writer for an accepted item that is its own DC form:
1.15-1.25x on reordered keys; +314 B min / +150 B gzip `runtime`, inside D285's
caps. Estimated: D -- the scanner's per-map units reused instead of re-sorting
over the copy, 1.25-1.35x on reordered keys. Not recommended now: a tolerant
attempt with per-map duplicate checks over the input (E, ~2x on `rev`) -- it
adds charging hooks to every map walk, which `p85-peg` is rewriting.
**Recommendation** (for the owner's call; nothing landed): (1) now, host-only:
lease the sessions' `vs`/`cb` per isolate as `schema-core.mjs` does (no kin,
no contract change; 3.3-3.6x on these sessions); after the PEG merge, size
`vs`, `cb` and S in one round from a scanner count of marked maps (`vbuild`,
which `p85-peg` changed). (2) B + C as one P8.4 follow-up in
`vcopy.kin`/`scan.kin` -- no file shared with `p85-peg`, so before or after the
merge -- then D. (3) E only after PEG phase 2, re-measured on its map machine.
Expected after (1)+(2)+D: sessions on maps `rev` ~23x -> ~4x the deterministic
buffer run, indefinite/non-shortest input ~4-8x -> ~2.5-4x.
**A1 done (2026-11-11; the coordinator accepted the recommendation).** The
session hosts lease the valid machinery's `vs`/`cb` (step-local) per isolate /
thread / wasm instance instead of 512 words / 1 KiB per session: JS
`withValidBuffers` (`vm-session.mjs`, used by `VmSession` and the sequence
backend; a re-entered step takes fresh buffers), Rust `session_step` over a
thread-local pair (`Session` and `Sequence` lose their own; `session_step` no
longer takes `vs`/`cb`), wasm SDK `svs`/`scb` in its state (D300). Real host,
fresh session per call: maps `rev` 84.3 -> 40.2 ms, map-heavy `rev` 130.1 ->
57.2 ms; deterministic and indefinite input unchanged. The rest of the gap is
S, still grown once per session for the copy's events -- follow-ups **A2**
(size `vs`, `cb` and S in one round from a scanner count, `vbuild`: after the
PEG merge) and **A3** (a per-Program S size hint in the hosts). E waits for
PEG phase 2. Gates and numbers: bench/D286-analysis.md "Implementation log".
**B+C done (2026-11-11, on the PEG merge `920a3e1`).** `kin/vcopy.kin` only:
the prefix writer leaves each item's source end in `O_S_XEND` (no `tskip` per
child at every depth; `pw-keys-canon` folded into the loops); `visit` runs
only when the writer copied a tag 24 (`O_S_T24`), the Program has `.cbor`, or
the item was refused; `uvisit` is skipped for an accepted item whose scanner
charged no units and saw no unsorted or EC-sensitive key; an accepted item that
is its own DC form (`VC_NONDET` clear, no `.cbor`) is copied with `bcopy`
instead of the writer (`build-region`; a byte search, `may-tag24`, decides its
visit). The scanner and the codec entry are untouched (a scanner tag-24 bit
did not fit the `snug` cap). **Fixed with it (D277 budget identity):** an
indefinite-length map with a key that is not its own DC form was never marked
on the canonical copy (`pw-indef` tested the copied keys, always canonical),
so the buffer driver charged no deferred-check units where the session's
frames did (`bf 7f6161ff 01 ff`: budget 9 vs 10); 4 vectors added to
valid-test's fixed regressions. The copy and its events equal `920a3e1` plus
that fix on 200,000 random items (`.cache/d286d/bench/d286/units-diff.mjs`).
Buffer driver, `920a3e1` -> B+C: integers indefinite / non-shortest 1.6-1.7x,
maps and map-heavy indefinite / non-shortest / indefinite strings 1.2-1.4x,
reordered keys 1.15-1.2x, deterministic unchanged; `runtime` +529 min / +206
gzip, within the caps. Gates (clean worktree on `920a3e1`): valid-test (cbor2
differential, D321 144/144, regressions 139/139), vmsession-test (1,059,010
session runs == buffer; JS == Rust 692,451; 523,529 untold-length streams;
hosts), sequence-test (735,997 oracle runs; JS == Rust 182,190; release
latency 0/67,257), vm-test (JS == Rust 80,509, forced tiers, JS == wasm
78,215), scan-test, rscan-test, drift, rust-api-test, wasm-sdk-test 14/14, npm
1,450/1,450, size: ok.

### D287 — Bundle growth for `Simple` values (D284; R9 per D200)
**Decision** (D284's engineer, provisional): no cap changes; every entry stays
within D285's caps. Measured with `node tools/size/size.mjs` (esbuild 0.28.2,
Node 24.6.0), main `3c10a83` → the D284 change, minified / gzip bytes:
`snug` 61,238 / 21,000 → 62,107 / 21,304 (+869 / +304); `snug/view` +1,041 /
+348; `snug/writer` +764 / +269; `snug/schema` +592 / +231; `snug/sequence`
+1,113 / +377; `snug/sources` +107 / +42; `runtime` +957 / +338;
`all-runtime` +1,144 / +362; `snug/compile` (full) +684 / +262; `controls`
and `unicode` unchanged. **Attribution**: the `Simple` class with its intern
table and validity check (`values.mjs`, about 0.5 KB minified, in every entry
that builds or writes values), the builder's two branches, the Writer's
`simple()`/`#simple`, the views' `simple()` and kind, and the kin changes
(`scan-simple`, the SIMPLE leaf, the `#7.n` lowering, `vm-verify`), each a
few lines.
**Why**: a value class is the smallest form of D284's model change; no cut
available without dropping the public API it asks for.
- [ ] **Signed off** (owner)

### D300 — Standing approval for wasm edits (OWNER DECISION, 2026-11-10)
**Decision** (owner, in session via the coordinator): agents may edit
`host/wasm*/` in the snug repository for the rest of this project — covering
P7.13w (SDK sequence reader and view-privacy fix), P8.4w (valid-CBOR flags),
P8.5w (`vm-verify-words` scratch sizing) and future wasm SDK work. Edits are
plain, reviewable file edits; if the permission system still refuses an
edit, it is not worked around: the exact edit is recorded and reported so
the owner can add a settings rule. The earlier review note on the
`host/wasm/src/cc.rs` / `host/wasm-sdk/src/compile.mjs` pass-through edits
(`f23aea0`, `p85-peg`) is closed: they are covered.
- [x] **Decided by the owner** (2026-11-10, via coordinator).

### D301 — Cut default is the literal RFC 8610 semantics; rule A is the non-default `cuts: 'branch'` (OWNER DECISION, 2026-11-10)
**Decision** (owner, in session via the coordinator; answers D271/D273):
the default cut semantics is **spec conformance** — RFC 8610 §3.5.4 /
Appendix A literally: a cut commits (commitment epochs per D273–D279) and its
failure fails the whole map type (fail scope = the map, R19). The reference
tools' behaviour (rule A: a cut failure is absorbed by an enclosing `//`)
stays available as the non-default option, named **`cuts: 'branch'`**
(manager's naming: the failure scope is the choice branch). Owner's words:
"Follow the spec, if it's not too difficult, and if the other behavior is
somehow more intuitive or common, then it can be supported optionally via
non-default options." The documentation must show prominently how to write a
discriminated union that works under the RFC default — without a
colon-implied cut, using `=>` (e.g. `{ "kind" => "a", x: int } / { "kind" =>
"b", y: tstr }` or a type choice of maps). Default applies in the PEG engine
(format 2.0, `p85-peg`); if the RFC default proves really difficult, report
before deviating. Supersedes the interim default in D271 and the naming
question in D273.
- [x] **Decided by the owner** (2026-11-10, via coordinator).

### D302 — Free rein in the snug repository; D300 extended to the whole repo (OWNER DIRECTION, 2026-11-11)
**Decision** (owner, in session via the coordinator): "You have free rein in
this in the snug repo, you're free to edit anything in there." D300's
standing approval for `host/wasm*/` now covers every path in the snug
repository. What still applies:
- edits are plain file edits (Edit/Write), not shell rewrites of files;
- commits name their paths explicitly (no `git commit -a`, and shared files
  such as this DEVLOG are staged by filtered hunks);
- nothing is pushed or published;
- agents kill only processes they started, by PID.

This direction does not cover owner sign-offs. The size-cap raises in
D285 and D319 were signed off separately, also on 2026-11-11. Outside snug, 3sln.me, emon, nome
and kin stay read-only. First use: P7.13x (`b1a3fac`), the wasm SDK parity
regression added with a plain edit.
- [x] **Decided by the owner** (2026-11-11, via coordinator).

### D303 — Size-cap raises are delegated to the coordinator; binary-size audit before release (OWNER DECISION, 2026-11-11)
**Decision** (owner, in session via the coordinator): "I'll allow any size
budget increases you deem worthy; at the end we should do an audit to look
for binary size reduction opportunities though. Yes, you approve cap
raises."
- The coordinator approves size-cap raises on the owner's behalf. This
  amends how D200's R9 gate is signed off; the gate itself (`bb size`, caps
  that do not rise freely) is unchanged.
- Every raise still needs a D-entry that attributes the growth, lists the
  cuts considered, and sets caps at measured + 2%.
- A raise is signed off as "coordinator, <date>, under owner delegation
  D303", never as "owner".
- Engineers bring the numbers to the manager before landing. The manager
  forwards them to the coordinator, who approves or pushes back. Small,
  clearly attributed raises needed for correctness or speed fixes will
  normally be approved.
- P8.7 becomes an owner requirement: a binary-size audit before release
  across every entry point.
- First use: D323 (+620 B min), approved by the coordinator on 2026-11-11.
- *Coordinator's rule of thumb (2026-11-11):* a raise under about 1 KB,
  paid for by a measured correctness or speed gain, needs no hunt for cuts
  first: record it in a D-entry, land it, and tell the coordinator. A larger
  raise, or one with no measured gain, goes to the coordinator before it
  lands. P8.7 catches small growth. D325 was approved on these terms.
- [x] **Decided by the owner** (2026-11-11, via coordinator).

### D290 — P8.5 phase 1: the compiler and verifier move to format 2.0 on a branch; a reference interpreter checks semantics before the VM (P8.5)
**Decision** (P8.5 compiler engineer, provisional): branch `p85-peg` replaces
the format 1 group lowering (map normal form, factors, pools, counters,
unrolling, the determinism and overlap rules) by PEG lowering
(`kin/compile/peg.kin`) and writes only format 2.0 Programs; `vm-verify`
accepts only format 2.0. The VM is untouched, so every VM-running gate is
red on the branch until phase 2 lands the VM with the compiler. The phase 1
gate is `bb compile2-test`; it includes a test-only interpreter of the
compiled Programs (`kin/scripts/peg2-ref.mjs`, architecture §20.2's `run`
read off the PEG programs and tables, scalar leaves matched directly) whose
verdicts must equal §20.15's and the independent oracle's.
**Why**: the owner asked for compiler and VM to switch main together; the
interpreter gives semantic evidence for the Programs (3266 oracle verdicts,
234 probe verdicts, 52 targeted ones) before a VM exists, and an executable
reading of program-2 for phase 2.
**Alternatives**: a format 1.2 keeping both engines (rejected in D279);
gating phase 1 on structure only (would not catch fold, cut or recursion
lowering bugs: mutants 1 and 2 of the phase 1 record are caught only
semantically).
- [ ] **Signed off** (owner)

### D291 — PEG lowering: one MAP leaf per map type, CALLs to open expansions, structural simplification, node-order numbering (P8.5)
**Decision**: a map type is one MAP leaf whose top-level `//` is a PEG
`CHOICE` (R5), no longer one leaf per alternative. A group rule (with its
generic environment) or an unwrapped container being expanded is a CALL of
its open expansion, so guarded recursion of any shape lowers; left recursion
(a CALL cycle through nullable prefixes, including a target that simplifies
to the very CALL, `g = (g, 0*0 x)`) is `group_recursion`. Simplification is
structural only: SEQ drops EMPTY kids, SEQ and CHOICE splice same-op kids
that no CALL targets and collapse to an only kid (none: EMPTY / FAIL), a REP
of EMPTY is EMPTY; then, in maps, program-2 §3.3's fold table. Nodes are
numbered in preorder; positions and members in node order (the verifier
checks this canonical numbering). An unwrap's alternatives follow the
typeset's creation order, as format 1 did.
**Why**: these keep every failure event (no FAIL is created or removed except
the fold's and the empty CHOICE's), make Programs canonical, and give a
CALL target an ancestor id.
**Alternatives**: lowering recursion by unrolling (unbounded); flattening a
CALL target (breaks the CALL).
- [ ] **Signed off** (owner)

### D292 — Format 2.0 compile limits: `pegNodes` replaces `alternatives`; members and depth bounded through it; ring words fixed (P8.5)
**Decision**: compile option 5 (source-key slot 4) is `pegNodes`, PEG nodes
per group after inlining (default 1024, hard 16384; error
`limit_peg_nodes`, code 16, which was `limit_alternatives`). Members per map
and frames per activation have no separate options: both are at most the
node count. The A1 ring limit is fixed at program-2 §11's default (4096
words). A group's builder tree is refused at 8 x `pegNodes` + 1024 nodes, so
a pathological expansion fails on the limit, not on memory.
**Why**: program-2 §1 adds only `cuts` and `groupWords` to SOURCE_KEY; §20.11
removes the alternatives limit; the node bound already bounds members and
depth.
**Alternatives**: three new options (members, depth, ring words) in the
SOURCE_KEY preimage.
- [ ] **Signed off** (owner)

### D293 — `n*m` with m < n is refused as `syntax` (P8.5)
**Decision**: an occurrence whose maximum is below its minimum is a schema
error (`syntax`, at the entry).
**Why**: such a repetition can never succeed (its count stops at m < n, and a
zero-length iteration sets the count to m), program-2 §3 requires
min <= max, and the independent oracle refuses it too.
**Alternatives**: lowering it to FAIL (a FAIL no source spells).
- [ ] **Signed off** (owner)

### D294 — Byte-string, float and big-integer `:` keys are cut key typesets (withdraws D125's refusal) (P8.5)
**Decision**: a byte-string, float or beyond-64-bit integer value before `:`
is a member whose key is the typeset of that value, with the cut (R11); under
`bindle`/`bus` it stays `profile`. A map's `key_ts` is the exact union of its
non-literal members' key typesets (no ANY absorption or merging), so every
member's own key leaves are evaluated.
**Why**: D125 refused these because format 1 had no cut on key typesets;
§20.11 withdraws `map_cut`. A normalised union would query merged leaves the
members' typeset tests never see.
**Alternatives**: keep the refusal; extend KEYS to every key kind.
- [ ] **Signed off** (owner)

### D295 — Derived fields program-2 leaves open (P8.5)
**Decision**: `depth` is the root's height in nodes, every node counting and
a CALL a leaf (every activation's paths are suffixes of root paths); a map's
`named` record stores the offset of its run in `namers`; `B` is stored only
for A1 (0 otherwise, maps 0); per-leaf activation words are program-2 §5.3's
ceil(n_calls (3 + 8 depth) 64 / 54); R_ITEM_MAX / RECLEAF_MAX / ACT_SUM are
maxima over the S16/S17 closure sets.
**Why**: each is the conservative reading of the text; the verifier
recomputes all of them.
**Alternatives**: frames only for composite nodes (one frame less, phase 2 may
tighten it with a minor version).
- [ ] **Signed off** (owner)

### D296 — Format 2.0 header: word 62 is RECLEAF_MAX, the section end is PROGRAM_WORDS (P8.5)
**Decision**: program-2 §2 calls word 62 "reserved" in format 1.1; it was
`S_END`. Format 2.0 drops `S_END` (the last section ends at PROGRAM_WORDS,
word 3) and uses word 62 for RECLEAF_MAX as program-2 numbers it. The format
word is always 0x00020000; format 1.1's extension table (words 30, 31, 39)
is part of 2.0. The serialisation loaders (JS, Rust) accept major 2, minor 0
only.
**Why**: keeps program-2's numbering and removes a redundant word.
**Alternatives**: move RECLEAF_MAX elsewhere and keep `S_END`.
- [ ] **Signed off** (owner)

### D297 — Format 2.0 verifier: a sized working area, per-fixed-point budget, new check ids (P8.5)
**Decision**: `vm-verify` keeps its PEG working arrays after the marks; the new
`vm-verify-words(P, mark_cap)` gives the scratch length (read defensively,
bounded by the hard maxima), and the hosts size the verifier scratch with
it. The verify budget is 64 (PROGRAM_WORDS + POOL_BYTES / 4 + 1), raised
before each fixed point by 4 (n_calls + 2) n (2W + 2) + 4 n npos W per array
table and 4 (n_calls + 2) n per program (instead of program-2 §3.1's
npos W (n_calls + 1) term: rounds iterate over nodes, and rounds <= targets
+ 2; still a proof obligation, N8). Check ids: 25 C_VERSION (any format word
but 0x00020000, D084), 26 C_RECURSION (left recursion), 10 is C_PEG.
Canonical form is verified: a tree through kids and REP children with
children of larger id, node-order numbering of positions and members, no
REP of a MEMBER the fold table would rewrite.
**Why**: the derived fields need per-node sets; the budget must cover what a
valid Program needs.
**Alternatives**: recomputing lazily per CALL target (less memory, more code).
- [ ] **Signed off** (owner)

### D298 — Compile warnings W1-W7: analyses, attribution, API (P8.5)
**Decision**: W1/W2 look along the root sequence (an earlier unbounded member
with an `any` value whose key domain contains the member's: identical
typesets, `any`, or the literal tested exactly; extension controls prove
nothing); W3 looks at adjacent SEQ kids (`REP(_, INF, ENTRY t1)` then a
required ENTRY t2 subsumed by t1); W4 is a REP with minimum >= 2 whose child
is a REP or MEMBER with an INF maximum; W5 is a CHOICE alternative after one
with FL = -inf (cuts ignored); W6 is an order-sensitive member whose key
overlaps another member's (conservative overlap); W7 compares program-2
§9.4's bound with the compiled cap LIM_GROUP_WORDS. A warning names the rule
whose definition holds its offset; repeats (one AST node in several generic
environments) are dropped; the order is (offset, code). *Amended 2026-11-10
(D301):* W8, under the default `rfc` cuts only, is a map CHOICE whose later
alternative's first member (through SEQ's first kid, REP's child, CALL's
target) is a cut member on the same literal key as an earlier
alternative's first member -- the `{kind: "a", ... // kind: "b", ...}` idiom. Hosts expose
`warnings: [{code, rule, line, column, message}]` on the compile result (JS)
and `Compiled::warnings` (Rust).
**Why**: cheap, conservative, deterministic on every host (gated).
**Alternatives**: whole-group subsumption analyses (costly, not needed).
- [ ] **Signed off** (owner)

### D299 — Compile options `cuts` and `groupWords`; SOURCE_KEY version 2 (P8.5)
**Decision**: JS `compile(text, {cuts: 'reference' | 'rfc', groupWords})`,
Rust `CompileOptions { cuts: Cuts, group_words: Option<i32> }`, the wasm
compiler's option words 20 and 21 (*amended 2026-11-10 by D301:*
`cuts: 'rfc' | 'branch'`, default `'rfc'`; `Cuts::{Rfc (default), Branch}`;
word 20 is 0 or absent for `rfc`, 1 for `branch`, and SOURCE_KEY carries
the effective value); kin's option words are 22 (`cuts` 20,
`groupWords` 21), the extension registry starts at word 22. `groupWords`
(<= 2^24) sets LIM_GROUP_WORDS (default 4,194,304). The SOURCE_KEY preimage's
version element is 2 and its limits array gains `cuts` and `groupWords` (-1
when not given), as program-2 §1 says.
**Why**: program-2 §1; D273, D276, D281.
**Alternatives**: none considered.
- [ ] **Signed off** (owner)

### D310 — P8.5 phase 2: the VM runs format 2.0 PEG groups on every route (P8.5)
**Decision** (P8.5 VM engineer, provisional): on branch `p85-peg` the VM runs
program-2 §5–§10 and nothing of format 1's group machinery: per ARRAY leaf a
block with the relaxed query automaton, verdict records by tier (A0 the
active set, A1 a ring in the block, A2 an arena record) and an incremental
PEG machine run as records arrive; per MAP leaf a block with candidates by
key, the F pair-major walk, S slots or T records, and the map machine at the
end (rfc commitment epochs by default, rule A under `cuts: 'branch'`);
farthest-failure events with provenance and the witness rules 3′/4′/5′; the
forced-tier mode (limits word 8 bit 2); limits word 10 (`groupWords`) and
`group_limit` (44). The buffer walk (`kin/vm-eval.kin`) and the session
(`kin/vm-session-cont.kin`) call the same block functions
(`kin/vm-array.kin`, `kin/vm-map.kin`, `kin/vm-arena.kin`) in the same order,
so §10's charging order holds on both routes, through sequences, EMBED,
`.cborseq` and D280's replay. A session never yields inside a machine run:
the machines run to their next wait within one step (D314).
**Why**: program-2 as reviewed (D272–D281); one set of block functions is the
cheapest way to make the routes charge alike, which every gate checks with
whole out arrays.
**Alternatives**: resumable machines with mid-run yields (more state in every
frame, no gain: a run is bounded by the records it has); keeping the format 1
fast struct/table engine beside the machines (two semantics).
- [ ] **Signed off** (owner)

### D311 — Block layouts and frame sizes as built (amends program-2 §5.2, §6.3, §9.1, §9.2) (P8.5)
**Decision** (P8.5 VM engineer, provisional): `ARRWORDS = 16 + 2W + (rec ? 0
: 4·depth) + (A1 ? (B+1)·W : 0)`; `MAPWORDS = 22 + 6·n_members + (rec ? 0 :
8·depth) + (S ? n_named·(slot_words + 1) : n_named)`; T `rec_words = 4 +
⌈2·n_members/32⌉` (key id, flags, key offset, key length, two bits per
member); a container's candidate list is 4·Σ n_members of its MAP blocks;
the arena is an 8-word header at `S[VM_ARENA]` (word 39) after the fixed
words, `vm-scratch-words` = fixed + 8 + the lease; `VM_PBASE` (word 35) makes
event offsets absolute on every route. S keeps its undo trail in the block
(one entry per named slot at most), so an S map never allocates arena words;
F keeps `n_named` index words for the forced-tier mode. The compiler
(`emit.kin`) and the verifier use the same formulas. No global item counter
is kept (§9.1's `VM_GROUP_ITEMS`): growth follows demand.
**Why**: per-member `min`/`max` and the walk's own offsets save re-reading
the PEG nodes on every pair; S's trail in the arena made a session's S map
suspend for growth mid-pair (found by vmsession-test), the block bound is
exact.
**Alternatives**: the draft's 14/16-word headers with the occurrence read off
the nodes per pair; S's trail in the arena with a per-pair gate.
- [ ] **Signed off** (owner)

### D312 — T's pick order: an in-VM EC comparator over the checked DC key bytes (P8.5; implements D274)
**Decision** (P8.5 VM engineer, provisional): when a T block's keys stopped
ascending or one is EC-sensitive, its end run heap-sorts a permutation of its
records (in the arena) with a comparator over the keys' DC bytes as their EC
forms (`ec-cmp-item`; nested maps by selecting each side's next key in EC
order, `ec-min-after`), each comparison charged ⌈min(len)/8⌉, at least 1,
before it is made. The same bytes are the input on the buffer route, the
canonical copy on the valid path and the kept DC forms in a session (D283).
**Why**: D274 asks the VM to sort its own records independently of the
scanner (§19.4); a function of the records alone charges alike everywhere.
**Alternatives**: borrowing the scanner's permutation (couples the VM to
§19.4's order and to the valid machinery); EC re-encoding each key (memory per
key).
- [ ] **Signed off** (owner)

### D313 — Buffer-route arena growth answers -5, not code 22 (amends program-2 §9.4, D276) (P8.5)
**Decision** (P8.5 VM engineer, provisional): a miss below the cap ends the
buffer run with the hosts' existing growth answer −5 and out word 7 = the
scratch words wanted (the arena doubled, at most to the cap); the hosts (JS,
Rust, wasm SDK, harnesses) already loop on −5 for P8.4's canonical path, grow
S and run again. A miss at the effective cap is `group_limit` (44) at the
offset of the item, or of the container for end runs — at the default cap
too (D276 as amended: "no finite default can promise it"). D281's wording
"applies only under an explicit `groupWords` limit" cannot hold with a finite
default cap; flagged for the manager.
**Why**: one growth protocol for the hosts; no new internal code to map.
**Alternatives**: code 22 with a separate host branch (D276's text).
- [ ] **Signed off** (owner)

### D314 — Session arena growth: headroom gates before charged work, a recursive Program grown at the message start (P8.5)
**Decision** (P8.5 VM engineer, provisional): the session asks for growth
(`VMS_GROW`) only at points where nothing has been charged since the last
step: before an item that may open A2/T blocks (its records), before a map's
end runs (2·pairs words) and before a pair's record. A Program with recursive
groups (`ACT_SUM` or `RECLEAF_MAX` > 0) grows once at the message start to
§9.4's bound for the message (items ≤ bytes; at most the cap), because one
machine run can rebuild an activation chain longer than any gate foresees.
The arena is adopted at the next step (`arena-take`/`arena-adopt`: the chunk
heap moved up, every address relative). At the cap a gate passes and the
work's own miss is `group_limit` with the buffer route's offset (the valid
path maps it back to the input like `budget`).
**Why**: a mid-run suspension would need resumable machines (D310); gates
keep the session's out array equal to the buffer's.
**Alternatives**: resumable machines; growing every session to the bound
(memory for nothing on flat schemas). **Known cost**: a recursive Program's
session holds the whole-message bound from the start (open problem).
- [ ] **Signed off** (owner)

### D315 — D044's streaks kept under program-2; limits word 8 bit 3 turns them off (P8.5)
**Decision** (P8.5 VM engineer, provisional): two multi-item streaks stay:
`[* T]` elements while the single A0 block waits at its `ENTRY` (the REP
frame counts k iterations at once), and the map pair streak — a single-block
tier-F map in a simple shape (a closed struct whose key is named by one
member with a one-leaf INT/TEXT value, or `{* K => V}` with one-leaf K and
V), schedule 2 only, each pair checked uncharged and then charged exactly as
the pair-by-pair walk charges a simple pair (D045 ii), the block left as the
walk leaves it. Limits word 8 bit 3 (`G_NOSTREAK`) turns both off with the
schedule unchanged; vm-test's new gate requires the whole out array equal.
Format 1's per-pair `map-pair-fast` is not restored.
**Why**: without the pair streak `map-struct` cost 2.3× main's CPU per unit
(the pair machinery per pair); with it 1.0–1.2×. The gate makes the streak's
charges checkable (D045's schedule-2 charges had no generic twin).
**Alternatives**: repricing pairs to the machinery's CPU (raises every map's
units); no streaks (calibration band broken).
- [ ] **Signed off** (owner)

### D316 — PEG charges calibrated, no price changed (P8.5; per D241/D253)
**Decision** (P8.5 VM engineer, provisional): program-2 §10's prices stand
(1 unit per PEG step, records ⌈R/16⌉, T records ⌈rec_words/16⌉ + 1, the T
comparison ⌈min(len)/8⌉). `bench/calibrate.mjs` gained five PEG rows (A1
choice, A2 backtracking, S choice, T choice, T sort); measured at `93f0520`
(bench/VM.md "Calibration 2026-11-11"), they cost 0.93–1.44× the median kind
per unit in JS and 1.04–1.23× in Rust, inside the 0.75–1.97× band of the
existing VM rows.
**Why**: D241/D253 aim at roughly equal CPU per unit; the new rows are no
outliers, and the machine's work is mostly the same per-unit kind as the
query automaton's.
**Alternatives**: pricing PEG steps at 2 (would put A1/A2 under the median's
half the work); repricing `embedded` (2.15× JS, the dearest row; the rise
from 1.57× is not analysed) — left for a band tightening.
- [ ] **Signed off** (owner)

### D317 — W7 fires only when the bound at the compiled limits exceeds the cap (amends D281, D298) (P8.5)
**Decision** (P8.5 VM engineer, provisional): W7 evaluates program-2 §9.4's
bound with items = the compiled item limit (the input limit only when the
Program has EMBED, whose items are counted separately), and the end-run term
2·maxEntries only when some MAP is T; it warns when that exceeds the
compiled cap. Phase 1's W7 used the input limit and the end-run term always,
and fired on every T map and recursive group (26 corpus warnings).
**Why**: the plan asked for W7 to be tuned so it fires only when the bound
actually exceeds the cap; the item limit bounds the records, the input limit
does not add to it without EMBED.
**Alternatives**: no warning (D281 wants one); a per-schema analytic
bound (not proven).
- [ ] **Signed off** (owner)

### D318 — The format word of 2.0 is `2` (D100's spelling) (amends program-2 §1) (P8.5)
**Decision** (P8.5 VM engineer, provisional): Program word 1 is the major in
the low 16 bits, the minor in the high 16 bits, as D100 spells 1.1 (`1 |
1 << 16`): format 2.0 is `2`, not program-2's draft `0x00020000`. Loaders
(JS, Rust, wasm SDK, the serialised-Program check) read the major from the
low half and refuse anything but 2.
**Why**: the hosts' loaders already compared the low half; the draft's
spelling was refused by them as major 0.
**Alternatives**: changing every loader to the draft's spelling.
- [ ] **Signed off** (owner)

### D319 — Bundle growth for PEG groups, attributed; caps at measured + 2% (P8.5; R9 per D200, owner sign-off)
**Decision** (P8.5 VM engineer, provisional): the caps of the entries that
hold the VM rise to their measured size + 2% (Ceil; min/gzip/brotli, static
and full); `snug/compile`'s static entry +51 bytes (the `cuts`/`groupWords`
option admission) likewise. Measured with `node tools/size/size.mjs
--details` (esbuild 0.28.2, Node 24.6.0) on main `3c10a83` and on the branch:

| Entry | main min / gzip | p85-peg min / gzip |
| --- | ---: | ---: |
| `snug/schema` | 127,263 / 45,456 | 146,527 / 52,281 |
| `snug/sources` | 165,975 / 60,892 | 176,707 / 64,773 |
| `snug/sequence` | 194,403 / 69,042 | 205,182 / 72,843 |
| `runtime` | 149,258 / 53,424 | 168,522 / 60,229 |
| `all-runtime` | 252,259 / 90,796 | 270,405 / 97,120 |
| `snug/compile` (full closure) | 257,731 / 87,225 | 278,747 / 95,328 |

The codec entries (`snug`, `snug/view`, `snug/writer`, `snug/unicode`,
`snug/controls`) are unchanged. Measured before the rebase onto `cfbdda3`;
after it (D284's simple values, D321) `snug/schema` is 147,159 / 52,545 and
`all-runtime` 271,594 / 97,568, inside the caps (`bb size` passes). **Attribution** (`runtime` and
`snug/schema`, minified, module deltas, +19,264 in all): `program/verify`
+7,292 (format 2.0's PEG program, array table and map table checks and the
fixed points over them, D297 — a loaded Program is untrusted, so the
verifier ships with the VM); `vm/map` +6,985 (F/S/T blocks, the map
machine, the EC comparator and T sort, witnesses); `vm/array` +3,653 (the
array machine, records by tier, events); `vm/arena` +1,610 (the arena and
its chunk heap); `vm/api` +303; `vm/eval` −607 (format 1's struct/table
engine removed, the PEG walk and the streaks added). **Cuts considered, none
made**: dropping the forced-tier support (it is the same code path as T and
A2); loading the verifier lazily (a synchronous Program load cannot await
it); sharing the array and
map machines' frame code (their frames differ in size and meaning, the
shared part — `fs-push`/`fs-pop` in `vm-arena.kin` — already is).
**Why**: PEG semantics need the machines; the growth is attributed to them.
- [x] **Signed off** (owner, 2026-11-11, via coordinator: "sure the bundle
  size increase is fine"). A pre-release size pass is queued as P8.7, on the
  coordinator's recommendation.

### D320 — Format 1's harnesses retired; the property campaign uses the PEG oracle (P8.5)
**Decision** (P8.5 VM engineer, provisional): `kin/scripts/compile-test.mjs`,
`vm-example.mjs` and `vm-asm.mjs` (format 1 Program assembly) are deleted;
`bb compile-test` runs `compile2-test` and the regexp gate (whose SOURCE_KEY
preimage is program-2 §1's). vm-test's hand-assembled cases are replaced by
program-2 §12's worked examples, compiled; its oracle arm is the PEG oracle on
generated schemas and the corpus in both cut modes (`vm-peg-gen.mjs`);
`tools/proptest` checks the VM against the PEG oracle instead of D022's
existential oracle. The conformance corpus is migrated in place (destructive
cleanup is allowed pre-release): 47 expectations flip true → false with a
note each (11 structural, 22 rule A — also false under the default rfc cut —
and 14 D301 rfc flips), plus the RFC suite's staged D301 case, 48 in all as
§20.13 and D301's record predicted; 26 suites refused by the withdrawn
D011/D012 checks compile and run as VM cases.
**Why**: format 1 Programs no longer load; the PEG oracle is D279's
reference.
**Alternatives**: porting the assembler to format 2.0 (program-2 §12's
examples compiled by the real compiler cover what it did).
- [ ] **Signed off** (owner)

### D321 — A valid-CBOR buffer attempt that runs out of budget takes the canonical path (amends P8.4's `vm-run-v`; D277, D286) (P8.5)
**Decision** (P8.5 VM engineer, provisional; the manager assigned it to
P8.5): under `PF_VALID`, the buffer route's deterministic attempt (D286)
that ends with `budget` no longer returns its own result: the canonical path
(`vm-canon`) decides, as for an attempt that met a non-deterministic
encoding. **The rule now**: on wire `valid` a budget-exhausted attempt falls
back to the canonical walk, so the buffer's code, offset, budget used and
items equal the session's on every split (vmsession-test, valid-test §3c).
**CPU**: the canonical walk restarts the budget (`vm-canon` runs `vm-setup`,
which sets `VM_BUDGET` from the limits), so it is bounded by the same
budget and charges exactly what the session charges (its walk is the
session's canonical walk); the reported budget used is the canonical walk's.
Worst case per call: one exhausted attempt, one scanner pass and copy, one
canonical walk — at most about twice the budget's CPU bound plus the scan,
on hostile valid input. Over deterministic input the copy is the input, so
only the cost changes, and only on a `budget` refusal.
Repro (main `3c10a83` and the branch before the fix): `r = { ? a: any, *
tstr => any }` over `a2616b006161a0` (keys unsorted), profile flags 378,
budget 27: buffer `48 0 4 27 3`, session `48 0 0 27 3`; after: both `48 0 0
27 3` (budget 28: buffer was `48 0 4 28 4`, now both `48 0 0 28 3`); 0
differences over budgets 1–79 for this schema and for the vmsession-test
schema that found it.
**Why**: the attempt can run out of budget before reaching the input's first
non-deterministic encoding; it then reported the original order's offset and
item count while the session (whole items checked by the scanner first,
D283) walks the canonical copy. D277 requires one charging order on every
route.
**Alternatives**: aborting the attempt early once the scanner has flagged the
input as non-deterministic — not available: on the buffer route the scanner
runs only after the attempt (D286 keeps the attempt precisely to avoid a
pre-scan), so there is no flag to consult; a structural pre-check before every
attempt (the cost D286 measured and rejected); the session walking the
original order until a refusal (its canonical events are per whole item).
- [ ] **Signed off** (owner)

### D322 — Bundle growth for D286 D (the canonical copy's units from the scanner's records); caps of the grown entries at measured + 2% (R9 per D200, owner sign-off)
**Decision** (D286 perf analyst, provisional): the caps that D286 D pushes over
rise to their measured size + 2% (Ceil); only those caps change (budget.json):
`snug` min/gzip/brotli (static and full), `snug/view` min, `snug/writer`
min/gzip, `snug/schema` brotli. Measured with `node tools/size/size.mjs
--details` (esbuild 0.28.2, Node 24.6.0) on main `51eb54c` and on `51eb54c` + D,
minified / gzip bytes:

| Entry | before | after | delta |
| --- | ---: | ---: | ---: |
| `snug` (codec) | 62,107 / 21,305 | 62,329 / 21,397 | +222 / +92 |
| `snug/view` | 75,918 / 25,728 | 76,151 / 25,818 | +233 / +90 |
| `snug/writer` | 58,090 / 19,888 | 58,323 / 19,976 | +233 / +88 |
| `snug/schema` | 147,799 / 52,842 | 149,148 / 53,308 | +1,349 / +466 |
| `snug/sources`, `snug/sequence`, `runtime`, `all-runtime` | | | +1,349 / +439..461 |

**Attribution** (minified module deltas): `cbor/scan` +222 in every entry
holding the scanner: `unit-rec` (a 7-word kind-4 record per marked map, in the
order maps end), `dup-map`'s head argument and units, `defer-map` writing a
deferred map's units into its record, and `defer` growing the options array by
doubling (it grew by 256 words: hundreds of retries for an item with thousands
of marked maps). `cbor/vcopy` +1,127 in entries holding the VM: `pw-units`
(the writer emits a completed map's EV_UNITS event from the next record),
`units-ready`, `units-same` (the identity copy), `units-left`/`units-strip` (the
fallback to the units pass when an item has a tag 24, or when the records and
the writer's maps disagree, which is never expected), `ev-shift` moving the
units events' map positions. The rest (`snug/view` +11, `snug/writer` +11) is
the minifier's renaming.
**Gain** (buffer driver, `920a3e1` + B+C + the tag-4 fix -> + D, five rotated
rounds, load ~28): reordered keys 1.15-1.18x (maps `rev` 31.2 -> 26.5 ms,
map-heavy `rev` 38.6 -> 33.1 ms), `all` 1.11-1.16x, other inputs unchanged. The
second duplicate-check sort per marked map is gone: the copy's units are the
scanner's (the same records and comparisons, D277). Gates and the differential
(events and copy equal on 240,000 random items): bench/D286-analysis.md
"Implementation log".
**Cuts considered**: the records outside the codec entry -- not possible:
the scanner is what computes the units, and the codec entry holds it (only a
control bit could stop the recording, and a bit saves no code); the fallback
(`units-left`/`units-strip`, about 300 B) -- kept: a tag 24's payload maps are
recorded by the scanner and not written as maps, so that case needs it, and it
is the safety net for the writer's order; deciding the tag-24 case before the
copy with a byte search -- tried, cost 20% on text-heavy input (a pass over
every item), dropped for the writer's own note; a VM-side tolerant attempt
(analysis candidate E) -- after the PEG work, re-measured on its map machine.
**Why**: the second sort is up to a quarter of the canonical path's cost on
reordered keys, and the copy needs those exact units for D277's charges.
- [x] **Signed off** (owner, 2026-11-11, via coordinator: "yes").

### D323 — T maps: non-literal members scan from a cursor (linear end runs); the map streak takes `any`; `map-pair-fast` not restored (P8.5 follow-up)
**Decision** (P8.5 VM engineer, provisional):
1. **T cursors.** Each non-literal member of a T block keeps a cursor (its
   member word +2, 0 at the start). Its examination of the records in pick
   order (program-2 §6.4) starts at the cursor and leaves the cursor where it
   stopped. Every record before a cursor is consumed or can never be taken
   or cut by that member: its key typeset does not match, or, for a member
   without a cut, its value typeset does not match. So the member reads
   what a scan from 0 would read; only the steps change. A rewind that gives
   records back moves every cursor above the lowest returned pick position
   back to it, charged ⌈n_members/16⌉ on top of the rewind's 1 + popped. The
   T sort stores each record's pick position above the consumed bit of its
   flags word (no layout change).
2. **The map streak takes `any`.** D315's pair streak also takes a value
   leaf `any`, walked by `fast-child` after the key's charges, so `{* tstr =>
   any}` tables run the streak again (format 1's streak did). The streak ==
   item-by-item gate (limits word 8 bit 3) and a 5,600-case schedule-2
   differential with `any` values show unchanged charges. The streak's key
   check and key-order charge are inlined (same charges).
3. **Block init** zeroes only the header and member words (the frame stack,
   slots and trail are written before they are read; the loop bound is
   hoisted). The charge stays ⌈MAPWORDS/16⌉.
4. **Format 1's per-pair `map-pair-fast` is not restored.** In
   `reference-map-choice` each element opens six map blocks (a choice of six
   map types), where a single-block pair fast path cannot apply. The
   map-heavy record's remaining generic pairs are a nested map and a
   two-leaf `bool` typeset, which are not simple pairs either.

**Before/after, T maps** (units; `{* (tstr => uint // tstr => tstr)}`, keys
in order / reversed under the `valid` preset):

| pairs | before (main 920a3e1) | after |
| ---: | ---: | ---: |
| 1,000 | 1,034,516 / 1,068,445 | 34,016 / 67,945 |
| 3,000 | 9,103,516 / 9,224,589 | 102,016 / 223,089 |
| 10,000 | 100,345,016 / 100,818,379 | 340,016 / 813,379 |
| 30,000 | not run | 1,020,016 / 2,631,389 |

CPU at 10,000 pairs fell from 6.8–8.2 s to 30–200 ms (single runs at load
30–75, so indicative only). The mixed shape `{ a: uint, * (…) }` and the
struct-like shape `{ ? k00000: uint, * ("t" => uint // tstr => any) }` move
the same way: at 3,000 pairs, 7.6 M → 101k and 4.6 M → 81k. **Default-budget
limits** (2.25 M units; also in architecture §7):

| shape | keys in order | unsorted (sorted by T) |
| --- | ---: | ---: |
| table | ~66,000 pairs (the default 65,536 entries per container comes first) | ~25,900 |
| mixed | ~66,800 | ~25,700 |
| struct-like | ~83,000 | ~27,000 |

So the reversed 30,000-pair table (2.63 M) needs a larger `budget`. That is
within the n log n contract.

**D286's workloads** (buffer VM on deterministic input; ms per call,
in-process interleaved, best of 7; the after-numbers are re-measured on the
final tree in the P8.5 follow-up section below):

| workload | cfbdda3 | 920a3e1 | after | units cfbdda3 → after |
| --- | ---: | ---: | ---: | ---: |
| 2000 maps × 8 keys `[* {* tstr => any}]` | 4.72 | 19.59 | 5.19 | 94,008 → 96,010 |
| map-heavy typed (2000 records) | 10.77 | 13.26 | 11.60 | 194,020 → 214,023 |
| reference-map-choice (2000) | 13.12 | 16.83 | 16.13 | 254,007 → 268,011 |

**Charge change recorded (from D311, not from this decision)**: each map
block opened is charged ⌈MAPWORDS/16⌉ with format 2.0's larger layout, so
these workloads use +2 units per map, +10 per typed record and +7 per
reference-choice element. D316's calibration covers those rows (map-struct
1.53×, map-table 1.97×, reference-map-choice 1.49× the median in JS), so no
price changes. **Size** (`node tools/size/size.mjs --details`, esbuild 0.28.2,
main `eea15a9` → this branch with D324, minified / gzip bytes): `runtime`
171,508 / 61,284 → 172,128 / 61,535; `snug/schema` 149,148 / 53,308 →
149,768 / 53,549; `snug/sequence` 208,535 / 74,061 → 209,220 / 74,323.
Attribution (`runtime`, module deltas): `vm/map` +336 (the cursors: `t-pos`,
the positions after the sort, the rewind's cursor reset, the scan's start
and store), `vm/eval` +306 (the streak's `any` arm, `streak-value`, the
inlined key check and order charge); the rest is minifier noise (−25). The
session entries carry the same deltas plus D324's `arena-fit` (`snug/sequence`
+685 in all). Main already stood within 0.3%
of these caps after D322, so they no longer fit: the failing caps (`runtime`
min/gzip/brotli, `snug/schema` min/gzip, `snug/sequence` gzip/brotli) rise
to measured + 2% (Ceil), **provisional, owner sign-off pending (R9 per
D200)**. Cuts considered: dropping the `any` arm (it is the D286 workload's
fix) and the cursor reset (needed for correctness after rewinds). No smaller
form was found. **Gates**: vm-test gains section 3e (36 cases, 1k–30k pairs; table,
mixed, struct-like; rfc and branch; in order and reversed). Each must be
accepted, a 3,000-pair one within the default budget, with units ≤ 8 n log₂ n;
the oracle confirms the 1,000-pair verdicts in both modes. vmsession-test
runs them under every split policy. The bench rows `maps8-any`,
`map-heavy-typed` and `map-T-large` in bench/calibrate.mjs now track these
workloads.
**Why**: a valid 3,000-pair T map exhausted the default budget (9.1 M units
against 2.25 M), and the D286 engineer measured `[* {* tstr => any}]` 3.9×
slower after the PEG merge.
**Alternatives**: a per-key hash index of the records (arena words per
record, and no help to non-literal members, which match by typeset);
repricing T's examination steps (would hide the CPU, not remove it);
restoring `map-pair-fast` (see 4).
- [x] **Signed off** (coordinator, 2026-11-11, under owner delegation D303:
  +620 B min, needed by both fixes).

### D324 — A session's group arena starts at the lease, not all of S (P8.5 follow-up; found by the D286 engineer)
**Decision** (P8.5 VM engineer, provisional): `vms-init` (and so every
message of a sequence, `vms-init-seq`) cuts the fresh arena's body to the
lease (`arena-fit`, `kin/vm-arena.kin`). It grows only on demand
(`VMS_GROW`, `arena-take`/`arena-adopt`, unchanged). The buffer route keeps
`vm-setup`'s body of all of S (its re-run after −5 needs the grown room).
**Why**: `arena-init` gave the arena all of S, and a session's canonical
event table sits after the arena (`arena-after`). In a sequence S is reused
for every message: each new arena swallowed the room the previous message's
events had grown S by, and the events asked for S + need again, repeating
that message's scan and copy. On `920a3e1`, over 1000 messages of 50 maps
with reversed keys, S grew from 1,554 to 469,086 words (~470 per message,
never reclaimed). With the fix it stays at 1,554 (JS host instrumentation,
`.cache` only; and sequence-test's new kin-level check). Units, events and
verdicts are unchanged, since the arena's size is not charged: vmsession-test,
sequence-test, the PEG differential and the session == buffer gates are
green.
**Regressions**: sequence-test "scratch bound (D324)": S after 5 and after
1000 canonical-path messages is equal (1,554 words; 3,426 vs 469,086 before).
The Rust unit test `sequence::scratch_tests` (run by `bb rust-api-test`) checks
the same through `snug::Sequence`. The wasm SDK runs the same generated
session code (`vm/session.rs`). It has no hook that exposes S, so it is
covered by that code path and by `bb wasm-sdk-test`'s parity, not by its own
assertion.
**Open problem 1** (a recursive Program's session holds the whole-message
arena bound from the start, D314) is **not** addressed: `arena-doc` still
grows a recursive Program's arena to §9.4's bound at the message start. That
growth now happens per message (the arena restarts at the lease), adopted
from the S already grown, so S stays bounded by one message's bound plus its
events.
**Alternatives**: the event table before the arena (impossible in a session:
the arena holds open containers' records while an item's events are built);
re-sizing the arena from the previous message's end (reads a header across
`vms-init`, which may meet an uninitialised S).
- [ ] **Signed off** (owner)

### D325 — Bundle growth for D286 A3 (a session's VM scratch sized from the Program's high-water mark); `snug/sources` brotli cap at measured + 2%
**Decision** (D286 perf analyst): only the `snug/sources` brotli cap rises
(static and full) to ceil(56,341 × 1.02) = 57,468. Measured with `node
tools/size/size.mjs` (esbuild 0.28.2, Node 24.6.0) on `3715bdd` and on it +
A3, minified / gzip / brotli: `snug/sources` 179,513 / 66,043 / 56,284 ->
179,510 / 66,050 / 56,341 (-3 / +7 / +57; over its brotli cap by 12 B);
`snug/sequence` 209,083 / 74,360 / 64,448 -> 209,038 / 74,349 / 64,513 (within
its caps); every other entry unchanged.
**Attribution**: `host/js/src/vm-session.mjs` only. A new session's S starts
at `max(vm-scratch-words, program.sw)` (since D324 a session's arena starts at
the lease, so the room past it holds a canonical item's events), and a
`VMS_GROW` of S records `program.sw` (at most 2^18 words: one huge item does not
pre-grow every later session). The same in Rust (`Program::session_words`, an
`Arc<AtomicUsize>`) and the wasm SDK (`Prog::sw`, a `Cell`), outside the JS
entries. Minified the entry shrinks; brotli moves with the reshuffle.
**Gain**: a fresh `VmSession` per call (`bench/d286/host-sess.mjs`, three
rotated rounds) on `3715bdd` -> + A3: maps with reversed keys 19.3 -> 12.5 ms
(1.55x), map-heavy reversed 25.2 -> 18.2 ms (1.38x); deterministic and
indefinite input within noise. Units, events and verdicts unchanged (S's
size is not observable: the arena starts at the lease either way).
**Cuts tried** (each keeping units and events identical): A2 dropped entirely
(the session route's one-round S sizing, +174 B min in `vm/svalid`, put
`snug/sequence` over its cap, and A3 alone gives the same gain); A1's lease
rewritten as one `{vs, cb}` object with a shared `growValid` (the vs/cb growth
was duplicated in `vm-session.mjs` and `sequence.mjs`); S sized at allocation
rather than copied after the init; four encodings of the high-water update
(the one kept compresses best); factoring the repeated result/yield objects and
a smaller vs/cb growth rule (both smaller minified, larger under brotli). The
remaining 12 B is left to the P8.7 size pass.
- [x] **Signed off** (coordinator, 2026-11-11, under owner delegation D303:
  +12 B brotli over cap, for 1.38–1.55× on reordered-map sessions)

### D326 — Every gate runs under a watchdog: per-gate CPU and wall caps, process-group kill (P9.1)
**Decision** (P8.5 VM engineer, provisional): `kin/scripts/watchdog.mjs` runs
a gate in its own process group, samples the group's CPU time once a second
(`ps`: the gate's node, its cargo builds and Rust binaries), and on reaching
a cap prints `WATCHDOG FAIL <gate> exceeded its <wall-clock|CPU-time> cap`
with the gate, its command and arguments, the caps and how to override them.
It then kills only that group (SIGTERM, SIGKILL after 5 s) and exits 124.
Otherwise it passes the gate's status through. Every gate is under it:
* the sh gates (`scan-test`, `rscan-test`, `compile-test`, `compile2-test`,
  `unicode-test`, `vm-test`, `vmsession-test`, `sequence-test`,
  `compile-fuzz`, `nav-test`, `write-test`, `drift`, `check`, and the
  `rust-api-test` and `wasm-sdk-test` runners) re-execute themselves under it
  unless `SNUG_WATCHDOG` is set;
* the node gates (`valid-test.mjs`, `regexp-test.mjs`, `tools/size/size.mjs`,
  `tools/proptest/campaign.mjs`, `tools/unicode/check.mjs`,
  `tools/runtime/run.mjs`, `corpus/tools/crate-diff.mjs`,
  `corpus/tools/run-rfc-corpus.mjs`) call `selfWatch` first;
* the bb `js-target-test` re-executes itself under it.

So a direct run and a `bb` run are both watched. Defaults are per gate
(`DEFAULTS` in watchdog.mjs; e.g. `scan-test` 2400 s wall / 4800 s CPU,
`vmsession-test` 7200 / 14400, `proptest` 10800 / 43200). They can be
overridden by `SNUG_GATE_WALL`/`SNUG_GATE_CPU`, by
`SNUG_GATE_<GATE>_WALL`/`_CPU`, or by `--gate-wall=S`/`--gate-cpu=S` on the
gate's command line; the watchdog removes those flags before the gate sees
its arguments. proptest's property-6 gates each run under their own watchdog
(`SNUG_WATCHDOG` removed for them), and a campaign timeout now ends a gate's
whole group, not only its shell. `bb watchdog-test` proves it: a busy loop
trips the CPU cap; `sleep 60 --gate-wall=2` trips the wall cap; a gate's
grandchild is killed with it; status and arguments pass through; and a real
`scan-test 300 1` (the 6.5-day run's arguments, dec5975) and a node gate
(`size`) trip.
**Why**: a gate must fail, never hang silently. The CPU sum misses a process
that lives less than one sampling period, so the CPU cap is a backstop and
the wall cap the guarantee.
**Alternatives**: caps inside each harness (many places, and the cargo builds
and Rust binaries would escape them); `timeout(1)` (not on macOS by default,
no CPU cap, and it kills only its child).
- [x] **Signed off** (manager, 2026-11-11). This is test infrastructure, so
  no owner decision is needed. Verified on main at `d903515`: drift is ok,
  and the engineer ran `bb watchdog-test` 7/7, which includes a real
  `scan-test 300 1` tripping its cap. (The P9.7 pooling entry, approved
  earlier as "D326", is renumbered D327 because this entry landed first.)

### D327 — Session arrays pooled per Program; a bound on live sessions; `releasePool` (P9.7)
**Decision** (D286 engineer): every host pools a session's arrays per Program
and bounds the sessions live at once. A session is *live* from its creation
until its verdict, `close()`, dispose or (Rust) drop; `Sequence`/sequence
readers count once for their life.
* **Bound**: `maxLive`, default 1024 per isolate (JS, and per wasm instance
  in the SDK) or per process (Rust). The session past it is refused with
  error code `sessions/limit` and the message `snug: N sessions are live
  (sessionLimits); finish, close() or dispose sessions to release them`.
  Validation calls (`validate_blob`, `validate_reader`, `validateHandle*`)
  open and release their own session, so they count only while they run.
* **Pool**: on release a session's arrays go to its Program's idle list
  while the total idle bytes stay under `maxPooledBytes` (default 2 MiB per
  isolate/process); the next session of that Program takes one whose S is
  large enough and whose SS matches. One entry is dropped instead of pooled
  if it is over 1 MiB or over a quarter of `maxPooledBytes`, so one huge item
  cannot pin memory or crowd out the small sessions. `maxPooledBytes: 0`
  turns pooling off.
* **Zero-fill on reuse** is a security property: reused arrays are
  zero-filled before the new session sees them, so nothing of an earlier
  message survives into a later one. The differential gates prove it by
  scribbling released arrays (a test hook) and comparing with fresh arrays.
* **APIs**:
  - JS (`snug/sources`, `snug/sequence`) and the wasm SDK:
    `sessionLimits({ maxLive, maxPooledBytes })` sets and reads the limits
    and counts; `releasePool()` drops every idle entry; `close()` and
    `[Symbol.dispose]` on sessions, push drivers and sequence readers.
  - Rust: `snug::sessions::{limits, set_limits, counts, release_pool}`,
    with process-wide atomics and a `Mutex` pool per Program (thread-safe;
    a dropped Program uncounts its idle entries).
* **JS GC**: a JS session abandoned before its verdict holds its slot until
  garbage collection (a `FinalizationRegistry` releases it), so code that
  drops sessions should `close()` them; documented in docs/api.md.
* **Breaking (Rust)**: `schema::Session::new` and `new_unknown` now return
  `Result<Session, sessions::SessionError>`, and `Error`/`SourceError` gain a
  `SessionLimit` variant. Record this for P9.11's release notes.

**Pool size** (`node --single-threaded-gc --expose-gc bench/sessions-bench.mjs
<tree> <arm>`: 100,000 small sessions through `openSession`, then 2,000 64 KiB
sessions through `validateHandleSync` in 4 KiB chunks; thread CPU µs per
session; one arm per process, on a shared machine):

| pool | small session | 64 KiB session | peak RSS | peak heap |
| --- | ---: | ---: | ---: | ---: |
| main (`0b302fc`) | 11.46 | 386 | 356 MiB | 13.1 MiB |
| fresh (`maxPooledBytes: 0`) | 14.1 | 379 | 401 MiB | — |
| 1 MiB | 10.25 | 350 | 264 MiB | 26.7 MiB |
| **2 MiB (default)** | **9.89** | **348** | **283 MiB** | **26.6 MiB** |
| 4 MiB | 9.66 | 345 | — | — |
| 8 MiB | 9.60 | 332 | — | — |

2 MiB is the smallest pool that keeps most of the gain: against `main`,
−14% CPU per small session and −10% per 64 KiB session, and peak RSS
356 → 283 MiB. 1 MiB loses about a quarter of the small-session gain; 4
and 8 MiB add only 1–5% more. An entry is about 75 KB, so 2 MiB holds about
28.
**Heap**: the higher peak heap (26.6 against 13.1 MiB) is transient
garbage (the lease objects and the finalization registry's records between
collections), not the pool: the pool lives in typed-array backing stores,
outside the V8 heap. Heap at the end of the run is 8.3 MiB on every arm.
**Leak found by the wasm parity test**: the wasm SDK's parity test
(`host/wasm-sdk/test/parity.test.mjs`, running the native JS package against
the SDK) failed 14,041 runs with native `sessions/limit`. A push driver whose
`feed`, `resume` or `finalize` threw (a bad chunk, a fault) never released
its session, so the bound filled up. Fixed in `host/js/src/sources.mjs`:
`guarded()` wraps a push session's API so a throw releases it;
`driveSession` and the sync/async runners close in a `finally`. The SDK frees
on its own `length_mismatch` path. Without the bound this leak would have
held memory silently.
**Size**: `snug/sources` 179,510 / 66,050 / 56,341 → 181,681 / 66,906 /
57,131 (+2,171 / +856 / +790 min / gzip / brotli), `snug/sequence`
209,038 / 74,349 / 64,513 → 210,595 / 75,063 / 65,091 (+1,557 / +714 /
+578), `all-runtime` 274,115 / 98,612 / 83,014 → 276,376 / 99,535 / 83,788
(+2,261 / +923 / +774). Only the session/stream entries grow, by
`host/js/src/session-pool.mjs` and the close/release paths. The failing caps
(`snug/sources` min and gzip, `snug/sequence` min, `all-runtime` all three)
rise to ceil(measurement × 1.02) (esbuild 0.28.2, Node 24.6.0; on `0b302fc` +
P9.7).
**Alternatives**: one global pool rather than per Program (arrays differ in
SS shape per Program, so reuse would mostly miss); no bound and pooling
only (a leaked session would grow memory silently, as the leak above shows);
no zero-fill (cheaper, but leaks one message's data into the next).
- [ ] **Design signed off** (manager).
- [x] **Cap raise signed off** (coordinator, 2026-11-11, under owner
  delegation D303: session/stream entries only (+0.7–0.9 KB gzip), pooling,
  the live-session bound and releasePool (P9.7); measured −14% small-session
  and −10% 64 KiB-session CPU, peak RSS 356→283 MiB at the 2 MiB default
  pool)

### D331 — The Rust async source drivers: dependency-free, runtime-agnostic, ports of the sync loops (P9.6, D027)
**Decision** (P9.6 engineer, provisional): the Rust host gets async forms of its
three source drivers over the same `schema::Session` / `Sequence`, in a new
module `async_source`: `Schema::validate_blob_async` (an `AsyncBlob`: `size()`
and `read(offset, len) -> impl Future`), `Schema::validate_reader_async` (an
`AsyncSource`, unknown length, drain mode / fail-fast, D085, D144–D147) and
`read_sequence_async` / `Schema::read_sequence_async` (an
`AsyncSequenceReader` with `next().await` and `poll_next`), plus the low-level
`async_source::validate_blob` / `validate_reader` beside `schema::`'s. No
dependency and no cargo feature: `AsyncSource::poll_read` has
`futures_io::AsyncRead::poll_read`'s signature, so a futures-io or tokio
adapter is a user newtype (docs/rust.md shows both); THIRD_PARTY_NOTICES is
unchanged. A positive quantum yields to the executor by waking itself and
answering `Pending` once (JS's `nextTurn`). Each async driver is the sync
loop with the read awaited: the same window policy, keep/drop bookkeeping,
argument checks, error mapping and result types. The sync drivers are not
refactored (P9.7 is changing Session/Sequence), so they stay an independent
reference for the differential. `AsyncSequenceReader::next` is cancel-safe;
dropping a validation future drops its session and nothing else.
The differential found one bug in the SYNC unknown-length driver, fixed here
in both: after `Session::end` resumed the walk (`VMS_RESUME`), a positive
quantum could yield at the end, and the driver called `vms-eof` again, which
answers -1 (the session already had its end): `schema::validate_reader`
panicked ("vms-eof answered -1"). The public `Schema::validate_reader` passes
quantum 0 and never reached it. After the end, the drivers now step again over
what they hold (a yield at the end needs no byte), as JS's `settleEnd` does.
**Why**: the owner's direction (D027) is one resumable VM for every source with
the host doing the I/O; ports of the sync loops make "identical to the sync
driver" a property one differential can hold. Dependency-free keeps the crate's
stated contract and its offline gates; one trait shape serves every runtime.
**Alternatives**: a `futures-io` feature (a blanket impl collides with the std
impls, so it still needs a wrapper type, plus a vendored dependency, a licence
notice and a second build in every gate); tokio (pins the runtime); one sans-IO
core shared by the sync and async drivers (less code, but rewrites the sync
drivers while P9.7 changes them, and loses the independent reference); a
`Stream` impl for sequences (needs futures-core; `poll_next` is the hook).
- [x] **Signed off** (manager, 2026-11-11). This is an engineering and API
  decision, so no owner decision is needed. Verified on main at `aa93229`
  (drift ok); the engineer ran the full gates and `rust-api-test` on main.
  Follow-up: the async and sync loops are duplicates. After P9.7 settles the
  sync drivers, consider one shared sans-IO core, keeping the differential
  as the reference. This goes to P9.13 review and does not block the
  release candidate.

### D328 — The prelude float widths are sets of values: `float16`/`float32`/`float64` match by value, not by encoded width (P9.2; VISIBLE CHANGE)
**Decision** (P8.5 VM engineer, provisional; coordinator's P9.2 triage): a
float matches `float16` (`#7.25`) when IEEE binary16 represents its value
exactly, `float32` (`#7.26`) when binary32 does, and `float64` (`#7.27`)
always, whatever width encodes it. NaN, ±∞ and ±0 are in every width.
Before, a float matched only the width it was encoded in, so a
deterministic encoder's 1.5 (`f93e00`) was not a `float32`, and `float64`
refused every shortest-form float that fits in a narrower width.
* The VM: `float-cls` (vm-eval.kin) gives a float item the class bits of
  every width that holds its value (256 binary16, 512 binary32, 1024
  binary64), from its exponent and the trailing zero bits of its
  significand (`fits`, `low-zero`). The leaf filter already tests
  `class & leaf-mask`, so a multi-bit class needs no other change. It is a
  constant amount of work per float item, inside the item's existing
  charge; no price changes.
* The oracles: the PEG oracle (`fitsWidth`), `peg2-ref.mjs` and the
  independent oracle (`corpus/tools/oracle.mjs`, with
  `export-adversarial.mjs`'s reasoned verdicts) all read widths by value.
* Corpus: `corpus/conformance/numbers.json` "float widths by value (D328)",
  24 cases: subnormals of both narrow formats, ±∞, NaN and −0.0 encoded
  wide, 65504 and 65520, the binary32 extremes, values exact in binary32
  but not binary16, and binary64-only values. The adversarial "Appendix D:
  float32 / float64 / float32-64" cases on `f93e00` and `fa3f8ccccd` are
  migrated from false to true, with a D328 note on each.
* Docs: the guide's "Changed 2026-11-11" callout, README's features table,
  `profiles.md`'s Floats row, `cddl-support.md`'s semantic note, and a
  correction note (not a deletion) on `conformance.md`'s old argument that
  "`float32` refusing 1.5 is correct encoded-width semantics".

**Why**: RFC 8610 §3.3: “"#7.25" specifies the set of values that can be
represented as half-precision floats; it does not mandate that these values
also do have to be serialized as half-precision floats: CDDL does not
provide any language means to restrict the choice of serialization
variants.” A schema that cares about encoded width uses a wire preset.
**Other implementations** (measured on `numbers.json`):
* The Ruby cddl gem 0.12.14 reads `float16` by value, but `float32` and
  `float64` as "needs at least this width": it refuses `f93e00` for both.
* The cddl crate 0.10.7 accepts every float for every width, so it accepts
  the 7 cases here that no narrower format holds.

Neither matches §3.3, so snug follows the RFC text.
**Alternatives**: keep encoded widths and classify the RFC 8610 cases as a
deviation (rejected by the coordinator's triage: §3.3 is explicit); the
Ruby reading (contradicts the same sentence).
- [ ] **Signed off** (owner): a visible semantic change.

### D329 — Numeric controls compare int and float values exactly, across kinds (P9.2)
**Decision** (P8.5 VM engineer, provisional): `.lt .le .gt .ge .eq .ne` with
a numeric controller now apply to every numeric branch of the target, with
the controller converted to the branch's kind, exactly:
* **An integer controller on a float branch** (`number .ge 0`,
  `float .ge 9007199254740993`) becomes the binary64 ordered key of its
  value (`int-fkey`, ctl.kin). When no binary64 holds the integer, it is the
  nearest one inside the half-line: `x > n` and `x >= n` become
  `x >= ceil(n)`, and `x < n` and `x <= n` become `x <= floor(n)`. −2^64
  is exact.
* **A float controller on an integer branch** (`int .gt 0.5`,
  `int .ge -1.8446744073709552e19`) goes through `float-to-int`, which now
  covers every finite float:
  - 2^53 ≤ |x| < 2^64: the significand shifted left;
  - |x| ≥ 2^64: every integer satisfies the comparison, or none does
    (exactly −2^64 is a point);
  - a fractional x moves the bound inside.
* **`.eq`/`.ne` across kinds** match only an exact value: an integer
  controller is a float point when binary64 holds it exactly, and an
  integral float controller is an integer point. Otherwise the controller
  equals nothing of the other kind, and `.ne` keeps the whole branch.

Before, a numeric control on `number` was a compile error unless controller
and target had the same kind. This also fixes an existing bug: `int .gt
0.5` refused 1, because `float-to-int` left `H_R3` stale on the |x| < 1
path. A second bug, found by a new vector while writing this entry, is
also fixed: `.ne` with a float key whose low word is all ones carried into
the wrong high word (`nebig` in the corpus).
Corpus: `numbers.json` "numeric controls across int and float (D329)", 24
cases, and 36 hand-reasoned checks during development. RFC 8610 default-timer
case 1 stays classified on S46 (`.default` adds no `.ne`).
**Why**: RFC 8610 §3.8.6's controls compare numeric values. `number = int
/ float` (Appendix D), so `number .ge 0` is the RFC's own idiom.
**Other implementations**: the Ruby gem agrees on all 24 cases. The cddl
crate refuses all 11 cases that should match across kinds.
**Alternatives**: compare in binary64 (wrong above 2^53); refuse
mixed-kind controls (the old behaviour, which rejects the RFC idiom).
- [ ] **Signed off** (owner)

### D330 — `.cat` and `.det` join a text and a byte string; the result has the target's type (P9.2)
**Decision** (P8.5 VM engineer, provisional): `ctl-cat` and `ctl-det`
accept any mix of text and byte strings. The result is the target's bytes
followed by the controller's, with the target's major type. A text result
must be well-formed UTF-8 (`vec-utf8`, RFC 3629); otherwise compiling
fails with `control_value`. Before, mixed kinds were a compile error.
Corpus: `numbers.json` ".cat of a text and a byte string (D330)", 4 cases,
including RFC 9165 Figure 2's text-with-bytes example. The RFC 9165 Figure 2
corpus suite passes.
**Why**: RFC 9165 §2.2: "The target and controller both MUST be strings.
The result of the operation has the same type as the target. The
concatenation is performed on the bytes in both strings. If the target is
a text string, the result of that concatenation MUST be valid UTF-8." Its
Figure 2 joins a text target with a byte-string controller.
**Other implementations**: the Ruby gem also lets `h'01' .cat "x"` match
the text string "\u0001x". The cddl crate refuses `h'01' .cat "x"` in both
types.
**Alternatives**: a text result from any text operand (contradicts "the
same type as the target"); accepting ill-formed UTF-8 text literals
(contradicts the MUST, and they could never match a valid text item).
- [ ] **Signed off** (owner)

### D333 — Bundle growth for P9.2 (D328–D330); the grown caps at measured + 2% (D303)
**Decision** (P8.5 VM engineer; signed off under D303 below): the caps that
P9.2 pushes over are raised to ceil(measured × 1.02). These are the
`snug/compile` full gzip and brotli caps, the `snug/sources` gzip caps,
the `snug/sequence` min caps and the `all-runtime` brotli caps. Every other
cap is unchanged.

Growth against main `5a1bb84`, measured on `p92-rfc` (esbuild 0.28.2):

| Entry | min | gzip | brotli | Cause |
| --- | ---: | ---: | ---: | --- |
| `snug/compile` full | +2,149 | +771 | +736 | the compiler's controls (`kin/compile/ctl.kin`), plus the VM |
| `snug/schema` | +597 | +265 | +257 | the VM (`kin/vm-eval.kin`) |
| `snug/sources` | +597 | +281 | +192 | the VM |
| `snug/sequence` | +597 | +277 | +105 | the VM |
| `runtime` | +597 | +277 | +283 | the VM |
| `all-runtime` | +597 | +255 | +215 | the VM |

What grew:
* **VM** (D328): `float-cls`, `fits` and `low-zero`, the float's width
  classes by value.
* **Compiler** (D329): `int-fkey` and `dbl-key`, which make the exact
  float key of an integer controller; `float-to-int` covering every
  finite float; and `ctl-eq`'s cross-kind points.
* **Compiler** (D330): `vec-utf8` and `vcont`, for the text result's UTF-8
  check, which RFC 9165 §2.2 requires: "If the target is a text string,
  the result of that concatenation MUST be valid UTF-8".

**Cuts**:
* Done: `int-fkey` rewritten as one normalisation loop, about 330 B min
  smaller than the shift-case version.
* Considered and kept: dropping the UTF-8 check (about 470 B min) would
  break the RFC's MUST.

New caps:
* `snug/compile` full: gzip 99,313, brotli 84,682.
* `snug/sources` static and full: gzip 67,658.
* `snug/sequence` static and full: min 213,828.
* `all-runtime` static and full: brotli 84,894.

**Gain**:
* The RFC runner is at 984 pass and 0 unexplained.
* The `numbers.json` corpus passes, with 52 cases.
* `float32` matches the shortest-form 1.5.
- [x] **Signed off** (coordinator, 2026-11-11, under owner delegation D303: compile +0.77 KB gzip, VM entries +0.27 KB gzip, for RFC 8610 §3.3 float widths by value, numeric controls on `number` and RFC 9165 `.cat` text/bytes (P9.2); RFC corpus 984 pass, 0 unexplained)

### D336 — RFC 9682 §3.2 head numbers for `#7`: `#7.<T>`, and `#7.24`–`#7.31` as additional information; SIMPLE leaves are ranges (P9.3)
**Decision** (P8.5 VM engineer, provisional):
* **Grammar.** `#7.<T>` parses like `#6.<T>`. `#m.<T>` for any other major
  is a syntax error, as before.
* **Meaning.** A head number `n` for `#7` is:
  - the simple value `n` for 0..23 and 32..255;
  - for 24, every simple value 32..255. This is additional information
    24, whose argument is the value; `f8 00`–`f8 1f` are not well formed
    (RFC 8949 §3.3, D284), so they never reach a schema;
  - for 25, 26 and 27, `float16`, `float32` and `float64`, by value (D328);
  - for 28..31, nothing. No data item has that head, and 31 is the break
    code.
* **`#7.<T>`** takes T's integers in 0..255 as head numbers: `#7.<0..255>`
  is every major-7 item. T must be an integer type, otherwise compiling
  fails with `major`. T's values outside 0..255 match nothing, as
  `#6.<T>` keeps only 0..2^64−1. A generic argument works as T.
* **Program format.** A SIMPLE leaf (kind 5) is now `d0..d1`, a range of
  simple values both in 0..23 or both in 32..255. It used to be the single
  value `d0`. The verifier checks the range, and the VM's `leaf-simple`
  compares the item's value (its ai below 24, the `f8` argument otherwise)
  against it. The cost is the same as before. `.and` intersects simple
  ranges, and the overlap test compares them. An extension control's
  argument still needs a single simple value. Format 2.0 is not released,
  so the leaf changes in place rather than in a new format version.
* **Corpus.**
  - `corpus/conformance/heads.json`: 57 cases and 2 refusal suites, all
    agreeing with the PEG oracle. That oracle (`#7.24` matches simple
    32..255; `#7.24..27` are not constants) and the independent oracle are
    updated to match.
  - The RFC runner's "RFC 9682 simple head numbers" suite compiles and
    passes; its P9.3 classification is removed.

**Why**: RFC 9682 §3.2: "For #7, the head-number stands for the simple
value if it is in the ranges 0..23 or 32..255 (as per Section 3.3 of RFC
8949 [STD94], the simple values 24..31 are not used). For 24..31, the
head-number stands for the "additional information", e.g., #7.25 or
#7.<25> is a float16, etc."
**Other implementations** (one-rule schemas):
- The Ruby cddl gem 0.12.14 supports `#7.<T>`. It reads `#7.24` as the
  simple value 24, so it refuses `f8ff` and `f820`.
- The cddl crate 0.10.7 refuses `#7.<T>` (`#6.<T>` works), and also refuses
  `f93e00` for `#7.25`.

**Alternatives**:
- One SIMPLE leaf per value: `#7.<32..255>` would become 224 leaves.
- Refusing `#7.24`–`#7.31`: this contradicts §3.2.

**Size** (D303's rule of thumb, accepted by the manager):
- `snug/compile` full grows by +632 B min, +286 gzip and +213 brotli
  (`head7`, `lower-head7`, the `#7.<T>` parse; the range in `.and` and
  the overlap test are folded into the TEXT/BYTES code).
- The VM entries change by +5 B min and at most +15 gzip.
- Only the `snug/compile` full min cap is over. It is raised to
  ceil(284,731 × 1.02) = 290,426.
- Measured on `p93-heads` over main `74b903f`.
- [ ] **Signed off** (owner)

### D337 — A recursive Program's session grows its group arena with the input read, not to the whole message's bound at the start (amends D314; P9.4, PEG open problem 1)
**Decision** (P8.5 VM engineer, provisional):
* **The gate.** Every session arena gate (`arena-gate`,
  `kin/vm-session-base.kin`) now also gets `upto`, the furthest message
  offset the gated work can read:
  - the end of the window or child for an element, a pair, or an item
    taken whole;
  - the position just reached for `arr-ret` and `map-ret`;
  - the map's end for `map-end`.

  For a Program with recursive groups (`ACT_SUM` or `RECLEAF_MAX` > 0), the
  gate makes sure the arena holds `arena-prefix(upto)`. That is program-2
  §9.4's bound, which `arena-doc` applied to the whole message, applied to
  the first `upto` bytes: `upto·(R_ITEM_MAX + ACT_SUM) + (depth+1)·(ACT_SUM +
  64·RECLEAF_MAX) + 2·upto`. `arena-doc` and its call at the message start
  are gone.
* **Why the prefix bound is enough.** A machine run can rebuild an
  activation chain only from items already read: a recursive cycle
  consumes an item before it calls again, or it is `group_recursion`. So
  the work read up to `upto` can never have pushed more than the bound for
  `upto` items.
* **Growth requests are capped** (`arena-want-cut`). For a recursive
  Program they never exceed the whole message's bound, which is what D314
  reserved at the start. Growth by doubling can therefore never end larger
  than D314's single reservation.

The buffer route is unchanged, as are charges, verdicts and events: the
arena's size is not charged.
**Evidence**:
* A differential against the previous code on every vm-test case whose
  Program is recursive, plus generated deep recursive messages (`[* g]` with
  a recursive group, 1–200 deep; a recursive `[g]` and a recursive map).
  It runs D314's sessions (P9.3's tree) and D337's side by side under 6
  window policies: whole, 1-byte, 7-byte and 300-byte random windows, plus
  the unknown length whole and in 7-byte windows. Result: 1050 runs, 0
  differences in the whole out array (code, subcode, offset, budget used,
  items, path).
* Peak scratch S summed over those runs: 789,139,954 words before,
  12,814,776 after. It was smaller in 198 runs and larger in none.
* After the first step, S summed over the runs: 789,139,954 words before,
  8,057,609 after. With an unknown length, D314 grew S to 4,194,456 words
  (the input limit's bound) before reading anything; it now stays at
  4,248.
* `vmsession-test` has a new check, "recursive arena growth (D337)". A
  202-item recursive-group array, run under 7-byte windows with known and
  unknown length, gives the buffer's out array, and S does not grow in the
  first step.
* The session == buffer gates (`vmsession-test`, `sequence-test`) are the
  standing differential.

**Alternatives**:
- Resumable machines (D310): a mid-run suspension. Much larger.
- Gating on the current container's items only: the end-of-container runs
  of the enclosing containers need their own items too, so the prefix
  bound is simpler and still tight to the input read.

**Size** (D303's rule of thumb, accepted by the manager):
- The session entries grow:
  - `snug/sources`: +283 B min, +76 gzip, +136 brotli;
  - `snug/sequence`: +283 B min, +78 gzip, +38 brotli;
  - `all-runtime`: +283 B min, +85 gzip, −30 brotli.
- The cause is `arena-prefix`, `arena-gate`'s `upto`, `arena-in-use` and
  `arena-want-cut`.
- Only the `snug/sources` min caps are over. They are raised to
  ceil(180,389 × 1.02) = 183,997.
- Measured on `p94-arena` over `p93-heads`.
- [ ] **Signed off** (owner)

## Findings

- 2026-11-11 (manager): **the 6½-day `scan-test.mjs 300 1` process
  (PID 44512, killed by the owner) was not reproducible — recorded as a
  work-in-progress-tree artefact.** It ran `node kin/scripts/scan-test.mjs ""
  300 1` (empty Rust-binary argument, 300 mutations, seed 1) from P8.4's
  scratch worktree `scratchpad/p84/wt`, started about 2026-11-05, which the
  OS `/tmp` cleanup of 2026-11-09 then deleted (node kept the loaded code).
  The same invocation finishes in seconds, every case correct, on main
  `add16f8` and on P8.4's checkpoint `8e8016a` (2026-11-04, the closest
  surviving state), both with and without the cbor2 differential arm
  (`bench/compare/node_modules` linked in). The exact uncommitted state of
  that tree is unrecoverable, so a hang in mid-edit code (e.g. a partially
  emitted gen/ or an unfinished scanner loop) cannot be ruled in or out; no
  committed scanner reproduces it. **Gap noted:** the scanner and VM loops are
  synchronous, so an in-process timer cannot interrupt a real hang; gates and
  property runs should run cases under a watchdog (a worker thread or child
  process with a per-case CPU limit, as `tools/proptest` already does) so a
  non-terminating input would be reported with its bytes instead of running
  for days. Proposed as a small follow-up for the gate scripts.
- 2026-11-04 (P8.3): quantifier counts must be compared as decimal strings
  before saturating the expansion count. The pre-P8.3 I-Regexp parser accepts
  `(){100000000001,100000000000}` (invalid decreasing bounds), and refuses
  the valid `(){999999999999,1000000000000}`, because it loses that ordering
  during saturation. XSD mode now handles both correctly, with charged digit
  comparisons and zero-position expansion still constant work. Explicit
  I-Regexp intentionally preserves the old outcomes/compile units under this
  task's compatibility requirement; a separate fix would change that contract.

- 2026-11-03 (P7.1): snug's own JS target (`kin/src/snug/js.cljc`) emits no
  import for a function named only inside the arguments of a call to a
  `declarefn`-declared function — `(item b o (std-inner b p) …)` in scan.kin,
  `(dead-item b s (std-inner b q) …)` in vm-dead.kin: the JS module throws
  ReferenceError at run time while Rust (glob imports) builds. Workaround:
  bind the inner call to a local first. Ours (snug.js). **Fixed 2026-11-04
  (P7.12, D187)**: kin defers such a call into a promise settled after the
  header is formatted; snug.js's `declarefn` now fills the callable at once;
  `kin/scripts/js-target-test` in `bb check`.
- 2026-11-03 (P7.1): V8 inlining is the cost model of the hot scanner paths.
  A one-line profile test at the top of `scan-float` made the Bindle float
  scan 1.16–2.1× slower when one process also ran the deterministic path (not
  inlined into `item` any more), and passing the noncharacter flag into
  `utf8-invalid-at` cost text/map-heavy scans ~6%. The strict functions are
  kept exactly as they were and the new behaviour lives in separate ones
  (`rfc-f*` via `float-bad`, `utf8-*-nc` via `text-bad`, each consulted only
  after a strict refusal): measured alone, the Bindle preset is within noise of
  the pre-P7.1 tree ([bench](bench/README.md#profile-options-p71)).
- 2026-11-03 (P7.1): another agent's commit `ea87d06` (a write-test harness
  fix, by explicit path) swept this item's uncommitted RFC-float section of
  `kin/scripts/write-test.mjs` into HEAD before the kin functions it imports
  were committed (`20fe2e6`); HEAD's write-test was broken in between. A file
  two agents edit is not safe to commit by path either.

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

**Open as of 2026-11-04 (manager):**

- [x] **P7.13w — authorise wasm SDK edits for the sequence reader (D219).** *Authorised 2026-11-10 (D300).*
  The sequences engineer's edit to `host/wasm/src/sdk.rs` was refused by the
  session's permission system (P7.9c's authorisation covered specific edits
  only); not worked around. Needed: `sdk_vs_new` with total −2 →
  `vms_init_seq`; new `sdk_vs_reseq(h, quantum)`; `INFO[4]` = `vms_held_code`,
  `INFO[5]` = `vms_message_length`; an SDK sequence backend over WasmSession;
  an internal `mintView` module. Native side ready (`host/js/src/sequence-core.mjs`).
- [x] **P8.5w — authorise a wasm SDK edit for format 2.0 Programs** *Authorised 2026-11-10 (D300).*: size the
  verifier scratch in `host/wasm/src/sdk.rs` with `vm-verify-words` (needed
  before `p85-peg` merges, else the SDK cannot load 2.0 Programs).
- [x] **P8.4w (likely) — authorise wasm SDK edits for the valid-CBOR default** *Authorised 2026-11-10 (D300).*
  if P8.4's edit is refused the same way; until then the SDK stays on an
  explicit profile and `bb wasm-sdk-test` stays green.
- [x] **Review note (closed 2026-11-10, D300):** commit `f23aea0` (P8.3) includes two small Codex edits
  in `host/wasm/src/cc.rs` and `host/wasm-sdk/src/compile.mjs` (regexp option
  pass-through). They were not refused and are not `sdk.rs`; flagged in case
  the owner wants every wasm edit gated.
- [x] **D271/D273 — cut-scope default** *Decided 2026-11-10 (D301): literal RFC default; rule A as `cuts: 'branch'`.* (literal RFC global cut vs the
  reference tools' per-alternative cut, refined to rule A) and the name of the
  reference mode.

- [x] **P7.13x — permission refusal despite D300 (2026-11-11).** *Resolved
  2026-11-11:* the shell append was what got refused. The test was then
  applied as a plain file edit under D302 (`b1a3fac`, with a `valid` wire
  added). Original note: adding the
  scaled-run sequence regression case (input `a1 61 61 59 ffff` + zeros to
  1,500,000 bytes, then `a0`; limits `0,0,1500000,…`; whole window, split at
  65,536, random chunks, fail-fast) to the wasm SDK parity test
  (`host/wasm-sdk/test/parity.test.mjs`) was refused by the session's
  permission system. Not worked around. D300 authorises it; a settings rule is
  needed. The native JS/Rust tests and `bb sequence-test` already cover the
  case (5365939); the SDK shares the native driver.

**Open as of 2026-11-11 (P8.4):**

- [ ] **D284 — unassigned simple values under `valid`.** *Applied 2026-11-11
  by the coordinator under the owner's standing rule (spec conformance is the
  default): `Simple(n)` admitted under `valid` and `deterministic`, Bindle
  refuses; owner sign-off on D284 still open.* RFC 8949's unassigned simple
  values (`e0`–`f3`, `f8 20`–`f8 ff`) are valid CBOR.

## Phase 7 — Standalone library (D080, 2026-11-03)

- [x] **P7.1 — General default profile** (D081): key kinds, standard tag set,
  presets `deterministic` (default) and `bindle`; scanner, VM, builder, writer.
  D113 array-policy follow-up done: default ignores extras, strictArrays/Bindle retain the old check; **Learnt**: enumeration dominates 120k integers (paired CPU 29.6960 → 4.7339 ms); npm test 1,051 passed / 0 failed; method and evidence in bench/WRITER.md.
  *Done 2026-11-03 by the P7.1 profile engineer; commits `20fe2e6`, `aaabb57`
  and the docs/bench commit after them.* Decisions **D120–D127**;
  [profiles](docs/profiles.md) is the user-facing description.
  - **Option model (D120):** one kin flags word, `O_PROFILE` = scanner word 11
    (`scan-profile`) and VM limits word 9; zero = Bindle, every bit admits
    more (`PF_KEYS` 2 bits, `PF_TAGS` 2 bits, `PF_FLOATS`, `PF_UNDEFINED`,
    `PF_NONCHAR`; internal `PF_SUB`); deterministic = 118. No Program,
    container or SOURCE_KEY change; Programs validate under either preset.
  - **kin:** key kinds (`key-peek`/`key-label`); `kin/stdtags.kin` (RFC 3339
    date-time, finite epoch numbers, URI characters, 55799 at the top only,
    the tag-24 payload walked as one item) in the scanner, dead walk, live
    walk and session (D121); RFC floats with the canonical NaN, consulted
    only after a Bindle float refusal (`float-bad`), and `put-float-rfc`
    (D122); `undefined`; noncharacters through `utf8-*-nc`, consulted only
    after a strict failure (`text-bad`, D127); float ranges compare as IEEE
    (NaN in none, −0 = +0). Resumable: rscan `K_STD` frames with whole reads
    for tags 0/24/32, container/tag keys walked whole, `PH_KSKIP` streams
    byte content of an active key into the arena; session `T_STD`/`T_STDCHK`
    with a pinned re-read, `key-end-any` for non-text keys, the prescan
    admits standard tags (D124). Compiler: `h'00': T`-style cut keys are now
    `map_cut`, not silently never present (D125).
  - **JS:** `wire`, `keys`, `tags`, `floats`, `undefinedValue`,
    `noncharacters` on every operation; `profiles.{deterministic,bindle}`;
    Map for non-text keys (collisions refused), `Tagged`, `undefined`;
    Writer `undefined()`, `tagged()`, any keys, RFC floats; views with any
    keys and `tagged`/`undefined` kinds; declarations (D123, D126).
    **Rust:** `snug::Profile` in `DecodeOptions`/`EncodeOptions`/
    `ValidationOptions`, `Value::Undefined`, `schema::Options.profile`,
    deterministic by default, `bindle()` constructors; bins and the wasm
    shim's limits buffer take the flags. Rust API tests that compare with
    Bindle fixtures select the Bindle preset explicitly.
  - **Vectors:** `corpus/cbor-vectors/deterministic.json` (generator
    `corpus/tools/export-deterministic.mjs`): **92 accept / 85 refuse** with
    hand-written codes and offsets — RFC 8949 Appendix A (deterministic
    examples accepted; non-shortest ±∞/NaN, unassigned simple values and
    indefinite examples refused), integer/negative/64-bit keys, the RFC 8392
    A.1 CWT, a CWT `cnf` holding a COSE_Key, mixed key kinds in bytewise
    order and the length-first trap, tags 0/1/21–24/32/55799 valid and
    invalid, undefined, every NaN/±∞/±0 form, non-shortest heads/lengths —
    each with the Bindle code of the same bytes (checked against cbor.mjs).
  - **Gates (actual runs, Node v24.6.0, rustc 1.92, the final tree):**
    `bb check` ok; **scan-test** 31,360/31,360 Bindle cases = cbor.mjs on JS,
    Rust and wasm; profile options 354/354 vector runs (code and offset) +
    92 fixed + 20,000 seeded cases under random flags, JS == Rust 20,446/20,446;
    **rscan-test** 259,081 policy runs + 267,541 every-offset splits ==
    recursive, Rust 259,032/259,032 identical (incl. the profile-option
    cases); **vm-test** profile identity 63,612/63,612 (VM against `any` and a
    schema keeping the new shapes live, under the flags), 983/983 conformance,
    71,471/71,471 JS == Rust == fast/generic, wasm 71,468/71,468;
    **vmsession-test** 949,035/949,035 session runs == buffer, 612,517/612,517
    JS == Rust, 0 panics, traps clean; **compile-test** 301/301 identical,
    270/270 verified, §15 unchanged, 55/55 SOURCE_KEYs; **nav-test** 1,106/1,106
    traces (deterministic documents included), 670/670 Rust View paths;
    **write-test** incl. 5,213/5,213 RFC float patterns JS == Rust, 4,371/4,371
    pass the scanner's RFC rules, 3,980/3,980 equal put-float where Bindle
    writes them; **unicode-test** ok (noncharacters compared with the Node
    oracle under the deterministic preset); **rust-api-test** ok (12
    integration, 10 doc, 5 + 1 docs/README doctests, clippy); **cd host/js &&
    npm test 1,241 passed / 0 failed / 0 skipped** (183 new profile tests);
    **bb drift** ok (88 destinations).
  - **Differential (cbor2 2.4.1, CDE + rejectDuplicateKeys/LongLoundNaN/
    Simple):** 38,086/40,420 inputs same verdict; every other one in a
    documented class (tag 621, snugtags 1,211, floatwidth 391 confirmed by
    rejectLongFloats, tag24 56, nan 41, limits 12, cbor2tag1 2), 0
    unexplained; `encode()` == cbor2 `encode({cde:true})` on 4,000/4,000
    seeded values byte for byte.
  - **Learnt:** a Program must not encode a wire-profile assumption — the
    compiler's "never present" lowering of non-text cut keys only looked
    correct because Bindle refused such keys (D125). Nested keys need either
    whole-key reads or a stack of key arenas; whole reads were simpler and
    bounded (D124). V8's inlining budget is the scanner's cost model: new
    behaviour belongs in separate functions consulted after the hot path
    refuses (Findings). A file two agents edit is not safe to commit by path
    (Findings).
  - **Bench** ([bench/README.md](bench/README.md#profile-options-p71),
    `bench/profiles-bench.mjs`, thread CPU, one preset per process, 3 × 11
    trials vs `c37eaaf`, shared M1 Pro, Node v24.6.0): Bindle scan medians
    0.96–1.03 of the base on all 8 workloads (no regression); decode/encode
    medians 0.87–1.13 with single-run outliers both ways on a loaded machine.
    Deterministic float scan median 1.046 (the `float-bad` re-check);
    `bench/codec.mjs` takes `bindle|deterministic`.
  - **Open:** an "any tag" level (COSE/CWT tags) and full RFC 3986 URI
    parsing (D121); cut literal keys of byte-string/float kinds (KEYS majors
    2/7, a D084 minor; D125); the deterministic float scan is ~5% slower than
    the Bindle one (the `float-bad` re-check); host/wasm-sdk (D130–D132) and the wasm
    scan shim have no profile option yet; `wire` should be added to P7.10's
    option-key admission; cbor2's `rejectLongFloats` cannot separate float
    width from integral floats, so that class is confirmed, not compared.
- [x] **P7.2 — Extension controls** (D082) and the generic controls module.
  *Done 2026-11-03 by the VM-features engineer (Claude); commits `6d63892`,
  `0012463` and the host/docs commit after them.* Decisions **D140–D143**.
  - **kin:** snug.lang tag `Ext` + forms `ext-call` / `ext-none`; the predicate
    is threaded as the last argument of the 30 live-walk and session functions
    reaching `finish-comb` (a rewrite-clj script; `vm-validate`,
    `vm-validate-span`, `vms-step` keep their signatures, `-x` variants take
    one). EXT leaves (kind 18) are decided lazily in the combinator pass at the
    item's end, once per item: 1 unit, + 1 per item byte and the predicate, or
    `control_size` (43) past the leaf's maximum; `control` (42) when refused
    (D140). Compiler: registry after the 19 option words (snug.compile.ext,
    `control_registry` 55), `lower-ext` (AND per target leaf), argument
    literals (`ext-arg`), `.eq`/`.ne`/`.and` never fold through an EXT,
    `lit-member` answers a conservative yes; emit writes format 1.1 only for a
    Program using a control (header words 30/31/39, names table, FLAGS bit 4);
    SOURCE_KEY's 8th element is the whole registry; `error-offset` for hosts
    to name an unknown control (D141). vm-verify: 1.0/1.1 format word, the
    names table (check 24), EXT fields, no EXT answer. Session: an item whose
    query holds an EXT is asked for whole up to the largest maximum (D143).
    Generic `.chars`/`.unique`/`.samelen` in `snug.vm.controls` (D142).
  - **Hosts:** JS `snug/controls` (new export; `controls.mjs`, `ext.mjs`),
    `compile(text, { controls, controlsInBus })`, `new Program(P, B, {
    controls })`, `fromProgram`/`fromSerialized(bytes, { controls })`,
    `program.controls`, `ProgramError('missing_control')` naming them, reasons
    `control` / `control_size`, a throwing predicate makes the call throw
    (`cause`), loader minor 1, options admitted in options.mjs, types. Rust
    `snug::controls` (`Control` trait objects, closures included,
    `Controls::generic()`, `in_bus`), `CompileOptions::controls`,
    `Program::{from_parts_with, deserialize_with, controls}`,
    `Schema::from_serialized_with`, `Error::MissingControls`, `SchemaError::detail`;
    the compiler sees a registry through `compile::Registry` (the compile crate
    builds without the VM).
  - **Gates (actual runs, Node v24.6.0, rustc 1.92, this tree, defaults):**
    `bb check` ok; **scan-test** 31,360/31,360 + profile options ok;
    **rscan-test** 259,081 policy + 267,541 split runs, Rust 259,032 identical;
    **compile-test** 301/301 identical, 270/270 verified, §15 unchanged, 55/55
    SOURCE_KEYs (format 1.0 Programs byte-identical); **compile-fuzz** 3,000
    texts, 441/2,559, ok; **nav-test** ok; **write-test** ok; **unicode-test**
    ok (574 JS == Rust); **rust-api-test** ok (incl. the new
    `tests/controls.rs`: shared table, compile/serialise/refuse, closures and
    `max_bytes`; clippy; docs/rust.md doctest of the controls example);
    **vm-test** profile identity 63,612/63,612, conformance 983/983, oracle
    3,200/3,200, 5,142/5,142 §15 + assembled + **1,466 extension-control cases
    (26 with fixed verdicts: exactness under choices, keys, `.ne`, size bound,
    embedded)**, fast == generic 72,937/72,937 (both schedules), JS == Rust
    72,937/72,937, hosts 2,215/2,215, wasm 71,468/71,468 (EXT cases excluded:
    no wasm port); **vmsession-test** 969,521/969,521 session runs == buffer
    over 72,934 vm-test cases (the EXT ones included) and 900 stress, traps
    91,201, interleaved 9,501, JS == Rust 628,417/628,417, hosts 8,247/8,247;
    **npm test 1,292 passed / 0 failed** (8 new in `controls.test.mjs`: shared
    table + an independent decode-based oracle, exactness, `maxBytes` under
    every source, every split and budget, unknown/argument/registry errors,
    `bus`, format 1.1 + source key + serialised loading, encoded arguments and
    a throwing predicate); **bb drift** ok after the commit.
  - **Learnt:** the first session run went red on `{x: …, y: [* (bstr .even
    0)]}` under 1-byte windows: `direct = 1` does not mean "whole in the
    window" -- a byte string no leaf reads is walked from its head alone, so
    the EXT rule has to run whatever routing decided (D143). Rust: a generic
    `&dyn Fn` port needs no host module in any of the five crates; a trait
    reference in `compile.rs` must not name host modules the compile crate
    lacks. Exactness needed nothing new: AND already made an EXT an ordinary
    same-item dependency.
  - **Open:** the wasm shim and host/wasm-sdk have no extension-control port
    (EXT Programs are excluded from the wasm comparison); per-call lowering of
    a control's maximum is not offered (the Program carries it); predicates
    are trusted to be pure -- a host could memoise by (id, argument, item) but
    snug does not; `.unique` compares encodings (so `1` and `1.0` differ, as
    documented).
  - [x] **P7.2 hardening: extension controls charged for their work** (R2;
    D190–D194; 2026-11-04, commits `b0a7233`, `e1a7910`). Brief: the
    2026-11-04 analysis below (and bench/VM.md). *Done*:
    * The kin `Ext` port now takes `room` and answers a verdict word (D190).
      `ext-eval` charges 1 + `EXT_CALL` 16, then the units the port reports.
    * `.chars`, `.unique` and `.samelen` are metered in kin, in ticks charged
      before each step (D191). `.unique` hashes elements, heap-sorts by
      (hash, bytes) and stops at the first equal pair. `.samelen` makes one
      pass with a binary search over names prepared and de-duplicated once at
      bind (D192). `.chars` is one count at ⌈len/16⌉ units.
    * Host predicates are charged `cost(itemBytes)` (default `itemBytes`)
      before the call, and are not called when it exceeds `room`. Their own
      CPU is documented as the host's responsibility (D193).
    * Scratch is reused: a JS module array, and a Rust `thread_local`.
    * program.md §14 has the normative EXT schedule. No Program format change.
    * Docs: guide (custom controls), api, rust.md, architecture (lowering table, §7).
    * vm-test and vmsession-test EXT arms add `.costly` (declared 3n + 5),
      `.huge` (refused unasked), a big `.unique`, an 8-name `.samelen` with
      duplicates, and a `.chars` budget sweep. Part-way budgets up to 6,000
      exercise refusals inside a metered run.
    * The snug/controls size budget is now 2,460 B gzip (+2% over the
      measured 2,412 B, for the metered kin code).
    **Gates run 2026-11-04, all ok:** check, drift, scan-test, rscan-test,
    vm-test (JS == Rust == wasm-vm on 74,300 cases, whole out array incl.
    budget; 2,075 EXT cases), vmsession-test (989,773 session runs; JS ==
    Rust 643,044), compile-test, compile-fuzz, nav-test, write-test,
    unicode-test, rust-api-test, host/js npm test (1,346), size.
    **Not ok:** `bb wasm-sdk-test` fails to build the SDK module (P7.9c,
    blocked).
    **Benchmark** (bench/VM.md, 2026-11-04 metered section): `.samelen`
    58.6 s → 33.5 ms, `.unique` 35 choices 992 ms → 70.9 ms (budget), no-op
    tiny calls 79 → 46.6 ms (budget). A declared-cost slow predicate is
    refused unasked. **The absolute 50 ms gate failed** on six budget-bounded
    rows (53–72 ms), on a machine where 2.3 M units of plain VM work took
    114.9 ms (load ~10). Per unit, every EXT row costs at most that
    reference, so the scaled worst is ~27 ms. A quiet-machine run is open.
    **Learnt:** a bool port cannot be made R2-compliant: the work has to be
    reported, and to be stoppable it needs `room`. A fixed per-byte charge
    overcharges `.chars` by 64× and undercharges `.unique` sorts. Measured
    under load, CPU per unit moves ~2.7× (E-cores, contention), so the
    weights were set as ratios to a VM reference measured at the same time.
  - **Calibration follow-up 2026-11-04 (measurement/proposal only; D240):**
    clean detached `df612f5fdabbf38b05fd3f89e5913472ab7791b3` under
    `.cache/calib-wt`; 40 charged-work cases, JS/native verdict-and-unit
    parity, nine rotated interleaved thread-CPU rounds, per-batch uptime and
    paired map-reference ratios. Apple M1 Pro / macOS 14.6.1 / Node 24.6.0 /
    rustc 1.92.0 -O. Waited 180 s before a preliminary pass and 60 s before
    the final pass; never load <2, final 10.71–13.93. Results, all concrete
    proposed prices and the conditional 2.25 M default are in
    [bench/VM.md, Calibration 2026-11-04](bench/VM.md#calibration-2026-11-04)
    and `bench/calibration-2026-11-04.json`. No broad 1.5× EXT increase:
    dispatch 8.03 ns/unit versus map reference 19.83; expensive `.chars`
    totals are substantially the profile's UTF-8 scan. A 1.4 MB `.bits`
    rescan fits other default caps and spends 2.3 M units in 189.97 ms;
    its paired-reference-normalised estimate is 175.43 ms. Proposed targeted
    scan prices fix that imbalance; an untimed in-memory price projection
    leaves the largest valid budget requirement at 1,450,008 (64.44% of
    2.25 M), including seven fast/generic unit equalities. **Exact ±25%
    equalisation across all hosts/paths is infeasible with common constants;
    no quiet confirmation or universal 50 ms bound is claimed.**
    **Checks run:** benchmark parity/retained-combinator/tick-sum assertions,
    native release build and rustfmt, JS syntax, projected valid-message
    acceptance/unit parity, diff whitespace. No emit/conformance gates,
    network, installs, commits or protected-source edits. Worktree removed.
    **Learnt:** constant multipliers cannot correct fast/generic CPU ratios
    when D044 requires equal charges, or disjoint relative-host costs. An
    early CBOR length-head mismatch can hide the intended common-prefix
    work; long-probe fixtures must have equal encoded lengths. Compiler
    folding can erase AND examples; assert retained opcodes. Separating
    first-byte comparison overhead from continuation chunks improves probe
    pricing; lowering the default alone loses valid-message headroom.
  - **P7.2/D085 benchmark, 2026-11-03:** clean detached HEAD
    `aa7dd560491e7c733015562029be1562be37d56d` (shared kin/scanner edits
    excluded), Apple M1 Pro/macOS 14.6.1/Node v24.6.0. Median CPU over 11
    interleaved rounds after warm-up: 287 B RPC + always-true EXT
    **+0.86 µs/call**; long-prefix `.unique` on 65,536 elements
    (1,048,581 B) **176.0 ms**.
    Valid 1.4 MB / 64 KiB known/drain/fast **25.48 / 25.78 / 26.01 ms**;
    early-refusal drain reads **1,334,464–1,398,976 B** more than fail-fast
    (64/16/1 KiB chunks). Unknown session arrays use **100,000 B** more
    than known at the 1.5 MB cap; sampled process memory is approximate.
    **387** session comparisons: no verdict mismatches; **6** permitted D145
    early-code differences (3 truncated precedence, 3 too_large precedence).
    **Learnt:** per-item EXT includes query/fast-path changes; large-root no-op
    deltas can be noise, `.unique` includes per-call large-scratch allocation,
    and known push must still deliver/finalize after early done. Full method,
    timings, memory caveats and reproduction: [bench/VM.md](bench/VM.md#extension-controls-and-drain-mode-p72d085--2026-11-03),
    harness `bench/ext-drain-bench.mjs`. Worktree removed; no commit made.
  - **Default-limit EXT worst-case analysis, 2026-11-04:** clean HEAD
    `6c3237e1a18d098516387369f730bac6c7dd78a6` in `.cache/unique-wt`;
    Apple M1 Pro/macOS 14.6.1/Node v24.6.0, thread CPU medians (7 batches;
    3 single calls for long predicates), heavily shared machine (initial
    1/5/15-minute load 81.13/47.53/32.29). All compiler/runtime limits and
    the 65,536-B per-control maximum left at defaults. `.chars` 22 full
    UTF-8 strings: **15.54 ms**; tiny strings reach **83.05 ms** before
    budget refusal. `.unique`: **55.04 ms** for a single 65,536-B repeated-rank
    array (1,837,356 comparisons, only 131,087 total steps); **138.44 ms**
    for 22 capped long-prefix arrays, and **991.57 ms** / 34 sorts of one
    capped item under 35 distinct EXT choices before budget refusal.
    `.samelen`: **58,638.25 ms** for 22 long-prefix maps (1,703,907 steps); empty
    maps take **50,687.43 ms** before budget refusal through repeated argument
    parsing (4.60 billion controller-item heads). No-op EXT reaches
    **79.30 ms** at budget exhaustion; a pure fixed-loop custom predicate
    takes **303.51 ms** on one byte for just 16 total steps.
    **Learnt/verdict:** defaults do **not** bound EXT CPU near 50 ms. D140's
    byte precharge tracks `.chars`' linear scan, but ignores `.unique`'s sort
    comparisons/prefix bytes and `.samelen`'s per-call argument validation
    and keys × names × prefix search. Custom predicate CPU is not bounded
    by purity or VM steps. Default JS uniqueness scratch is retained after
    warm-up (~0.5 MiB); Rust allocates it per call. **Proposal only:** charge
    generic comparisons/byte chunks/argument work inside interruptible kin
    loops (or charged hashing with collision compares), prepare/index names
    once, reuse per-context scratch, and recalibrate tiny-item dispatch costs;
    lowering item size alone cannot fix argument amplification/custom code.
    Details, fixtures, counters, load and reproduction: [bench/VM.md](bench/VM.md#extension-control-worst-cases-under-default-limits--2026-11-04),
    new harness `bench/ext-worst.mjs`. **Checks run:** node syntax, final
    check-only (41 cases), all timed fixture hashes/charges/counts/medians
    reconciled, scoped diff check. Worktree removed; no kin/host/generated
    changes, installs, network operations or commit.
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
- [x] **P7.6 — Bundle size.** R9 restated at the measured sizes and gated by `bb size` (owner decision D200, 2026-11-04).
  *Phase 1 completed 2026-11-03; R9 remains open. No kin/generated edits,
  network, installs or commits by this task.* Offline esbuild 0.28.2; full
  machine/method and before/after tables: [bench](bench/README.md#bundle-size-p76-phase-1--2026-11-03).
  Exact source hashes, static/full/split metafiles, isolated per-module sizes
  and ranked attribution: `tools/size/{before,after}.json`,
  [rendered report](tools/size/report.md). The same generated-module hashes
  occur before and after; only public-compile, its new import adapter and
  package sideEffects metadata changed. This is a shared worktree snapshot,
  not a clean-revision benchmark; historical 11/41/56 KB figures have older
  revisions/entry sets and are not substituted for this baseline.

  **Static graph findings (all public exports retained):**
  - `snug`: scanner + trusted builder + encode -> Writer. Writer's class
    methods retain kin write/{out,int,float,map}, CBOR profile primitives,
    values, limits and option validation. Standard tag 24 encoding scans the
    embedded bytes (`Writer` line containing `scan`); this is a real scanner
    dependency even in `snug/writer`. Profiles/values implement the selected
    wire representation and value classes, not accidental compiler imports.
  - `snug/schema`: public-schema -> schema -> vm/api and vm/session.
    Synchronous Program construction imports vm-verify; synchronous
    serialize imports framing + SHA-256. Schema.decode needs the trusted
    builder and values. Session pulls sbase/scont/sstr, sharing eval, leaf,
    map, array, dead and base with the buffer driver. No compiler host,
    generated compiler or Unicode table is retained in the static bundle.
    cbor/scan contributes **1,480 minified B** of codeName/profile helpers;
    there are not two copies of a recursive scanner. rscan is absent.
    Different VM/session walkers duplicate some traversal logic, not module
    instances. The 31 retained modules are listed in the report.
  - `snug/compile` originally imported Program/Schema statically: **45,754 B
    gzip** before any compile call. Now it imports only options and its
    public error class (**1,243 B gzip**); first compile imports
    compile-runtime, a narrow re-export of the compiler and public classes.
    Public constructor/error identities, verification and synchronous
    instance methods are preserved. The adapter exports only the four
    bindings needed, avoiding a dynamic namespace over the entire schema API.
  - `snug/view`: scanner + navigation + builder/values + Writer (encode
    lookup keys of arbitrary admitted kinds). `snug/writer`: Writer and its
    primitives/checks above. Neither imports schema or its session VM.
    `snug/sources`: source loops + recursive scanner + rscan; schema drivers
    receive a schema and call its session, without importing schema/VM.
    `snug/unicode`: optional packed data and decoder, imported by no runtime
    entry; the compiler receives tables as an explicit port.
  - esbuild splitting emits **orphan compiler/verifier chunks** because
    unused internal schema.compile/fromProgram contain dynamic imports.
    The public schema output has no import edge to those outputs. Report
    `split.total` traverses reachable chunks; `split.emitted` also counts
    orphans. Actual compile startup gzip is **46,746 -> 1,371 B**; reachable
    split transfer after calling compile is **84,612 -> 84,779 B** (+167 B).
    One-file compiler+runtime gzip is **84,074 -> 85,118 B** (+1,044 B),
    explicitly recorded rather than presented as a total-size saving.

  **Concurrent regeneration after the paired measurement:** another engineer
  regenerated compiler, verifier and session modules during the final audit.
  `tools/size/current.json` records these separately: codec is still **14,174
  gzip B**, schema **46,456 B**, codec+schema **53,870 B**, all-runtime
  **63,720 B**; compile's static stub stays **1,243 B**, full closure is
  **86,871 B**. Before/after above continue to isolate the host-only change;
  final budget caps use **ceil(current.json bytes × 1.02)** instead of the
  earlier paired after values. Full current module hashes/graphs and changed
  module sizes are in the report. The analysis/proposals below use the paired
  baseline, not the other engineer's subsequent additions.

  **Phase 1 decision — Preserve synchronous APIs while splitting the async compiler.**
  *Session placement below is superseded by D160 (phase 2).*
  **Decision:** defer compiler + its schema facade together through the new
  compile-runtime re-export adapter; mark the package sideEffects:false.
  Keep vm-verify, serializer/SHA and session imports synchronous where the
  public API requires them. Add `bb size` and recorded +2% regression caps.
  **Why:** Program(P,B) verifies before returning; serialize() returns bytes;
  Schema.session() returns a session. Lazy-importing any of those changes
  the contract. fromSerialized is async but currently snapshots and parses
  input before returning its Promise: adding an await lets caller mutations
  affect loading. No such timing change is shipped. Top-level runtime work
  only creates/freezes module-owned values/prototypes/scratch, or checks the
  fixed kin profile constant; it has no independent global registration or
  required bare-import effect. Used exports retain their initialization;
  sideEffects:false allows unused modules to disappear. Existing modules
  already share scanner/VM/hash helpers through named imports.
  **Alternatives:** asynchronous constructors/serialize/session, deferring the
  input snapshot, side-effect registration of session factories, or skipping
  verification (all change behavior); a broad schema-core extraction now
  (collides with the concurrent schema/extension/stream work, deferred below).
  - [ ] **Signed off** (owner)

  **Prioritised kin/emitter and subsequent API plan (not implemented):**
  `tools/size/analyze.mjs` and `analysis.json` rank generated functions and
  run in-memory size probes on the frozen baseline. Stub/constant probes
  are never executed and are not verified implementations. Compression is
  nonadditive; the following savings cannot be summed without rebuilding.
  1. **Separate buffer core from sessions at the source/API boundary.**
     Session-only generated modules contribute **33,917 minified B** in the
     schema bundle (session 4,876; sbase 7,730; scont 14,664; sstr 6,647).
     Stubbing session exports reduces schema **46,042 -> 32,893 gzip B**
     (13,149 B); codec+schema **53,452 -> 40,458 B** (12,994 B). Expected
     initial-graph opportunity **12–13 KB gzip**, with real drivers still
     downloaded when used. Keep predicates/charges in kin and shared across
     drivers. Preserve existing Schema.session on the full entry; a new
     buffer-only entry or async prepared facade needs an explicit API
     decision. Moving all sessions to snug/sources cannot preserve today's
     independent synchronous Schema.session. First extract a shared schema
     core with the other engineer; leave internal async compiler/loader
     wrappers outside it. This also avoids orphan outputs and their shared
     chunk overhead (~**968 B gzip** for schema startup in this bundler).
  2. **Offer a kin-emitted generic VM variant (`snug/schema-small`).**
     Keep schedule 2 and exact verdict/path/budget accounting; omit array/
     map streaks, fastChild and specialised pair/element helpers at emit
     time. On the no-session probe, generic specialisation reduces schema
     **32,893 -> 29,765 gzip B** (3,128 B; 7,945 minified B), codec+schema
     **40,458 -> 37,334 B** (3,124 B). Estimate **3–4 KB gzip**, then run
     bb vm-test's complete out-array equality, both hosts, plus throughput/
     budget calibration; do not replace the default fast VM without those
     measurements. Biggest runtime functions by isolated minified bytes:
     rscanStep **7,603**; evalMap **4,364**; scont.mapPair **2,946**;
     scont.tagRun **2,804**; evalArray **2,725**; verifier.checkMap **2,359**;
     fastChild **1,988**; mapPairFast **1,870**; mapStreak **1,711**;
     arrayStreak is also separately ranked. Session code shares evalItem,
     arrayStreak and leaf checks but implements resumable container/tag
     phases separately; merge repeated scans/checks before merging whole
     drivers (D030/D091 deliberately retain two performance tiers).
  3. **Verifier size/loading design.** Generated verify is **61,862 source /
     18,903 retained minified B**. Stubbing it saves **6,459 gzip B** for
     schema and **6,245 B** for codec+schema: this is a ceiling for removal
     from the initial graph, not a safe optimization. It MUST run for every
     untrusted Program, including direct synchronous public construction.
     A new async-loader-only small entry can fetch it before exposing a
     verified schema; full entry must retain it. For a behavior-preserving
     kin refactor, target repeated header/section/range/record checks, using
     checkMap/checkLeaf/checkHeader rankings; **1–2 KB gzip** is an engineering
     estimate, not measured savings. Moving it never removes end-to-end
     verification bytes or authenticates Program provenance.
  4. **Rare leaf groups only after a prepared-schema design.** Regexp,
     embedded-CBOR, bits and extended leaves are synchronous decisions today.
     A kin-owned feature partition could load required evaluators while an
     async loader prepares a verified Program, then keep validate synchronous.
     Shared leaf functions, flag interpretation and failure precedence must
     remain kin-owned. Conservatively expect **0.1–1 KB gzip** per useful
     partition, not the sum of isolated functions. Stubbing rxMatch/bitsOk
     alone saved only **106 B schema / 74 B runtime gzip** because sessions
     still need shared regexp/bit primitives; first remove session coupling.
     Do not lazy-load Unicode here: no runtime entry includes it already.
  5. **Low priority: remove legacy schedule 1 / generic-selection switch.**
     D045 was provisionally accepted and schedule 2 is the default. limits
     word 8 bit 1 still selects schedule 1 (vmSetup flips it into VM_GENERIC
     bit 1); bit 0 forces generic; bit 2 is transient free-bookkeeping state.
     Hosts pass 0, so production specialization is possible, but the low-level
     ABI and program.md document schedule 1 and bb vm-test compares both.
     A schedule-2-only probe saves just **70 B schema / 79 B runtime gzip**;
     eliminating the force-generic branch saves **36 B / 15 B**. Budget
     **under 0.5 KB gzip** pending a proper emitter implementation. Keep the
     generic oracle and legacy-schedule tests in test builds; retiring the
     selectable schedule is a compatibility decision, not a host import fix.
  6. **Emitter naming/tables: establish the actual opportunity first.**
     js.cljc delegates parameter/local spelling to kin/local-name and
     function spelling to kl/target-name; the camelCase namers are actually
     in **kin/src/snug/targets.cljc:83–84**, not js.cljc. esbuild already
     mangles locals and bundled internal names. Disabling identifier
     minification increases schema gzip **46,042 -> 50,181 B** and runtime
     **53,452 -> 58,948 B**; shorter source locals would not recover those
     bytes again. Expected extra saving from merely shortening locals:
     **approximately zero**. No per-function long constant tables were found;
     layout constants are module-level primitive exports, and numeric data
     tables use module-level Int32Array.of. Consider emitter control-flow/
     coercion factoring and share actual duplicate numeric tables only after
     an attributed prototype; no numerical saving is claimed for an unseen
     table problem. The compiler's largest function, emitProgram (**5,025
     isolated minified B**), stays entirely outside the runtime graph.

  **What was learnt:** the largest removable initial dependency is the
  synchronous session API, not Unicode, repeated module instances, long local
  names or the legacy bit. Even the deliberately unsafe combined no-session,
  generic, no-verifier probe leaves codec+schema at **31,061 gzip B**, above
  R9. Meeting 20 KB needs additional kin/host implementation reductions and
  an explicit definition of which prepared/loading operations count; lazy
  imports alone cannot establish it. Phase 2 was outstanding at this point
  (completed below).

  **Gates actually run:** host/js npm test **1,284 passed, 0 failed/skipped**;
  all seven examples executed; npm run build staged successfully (also
  exercised by package tests). bb size exits **0** against **ceil(current
  bytes × 1.02)** for min/gzip/brotli, static and full, every entry and both
  runtime unions. A scratch budget with snug.static.gzip = 0 exits **1**,
  reporting 14,174 > 0. Babashka 1.3.190's sandbox shutdown hook additionally
  prints a process-enumeration permission warning after success; direct Node
  avoids it. No drift/emit, Rust, wasm or browser gates were run by phase 1.

  **Phase 2 — Session partitioning (completed 2026-11-03, D160).**
  `openSession(schema, rule, length, options?, scheduling?)` in `snug/sources`
  replaces `Schema.session`; positional arguments keep rule/length/options
  checking and synchronous construction. Session types moved to sources.
  `schema-core.mjs` holds buffer validation, decode, validateAt and Programs;
  `schema.mjs` remains an internal compatibility entry for async compile/load
  helpers. Public schema imports the core directly. A private WeakMap supplies
  the same owned, verified Program to source sessions, without exposing arrays
  or importing the public constructor/verifier from sources. No factory
  registration, top-level await or dynamic session import.

  The host VmSession class was moved **byte-for-byte unchanged** to
  `vm-session.mjs`; the protective public window facade moved to
  `open-session.mjs`. Handle and known/unknown push drivers now call the
  factory. Unknown-length profile scanning constructs the same raw session
  against ANY_P/ANY_B. SS_UNK/pending-area sizing still comes from kin's
  vmsWords/vmsInitUnknown; held/EOF/keep/replay and fail-fast paths are
  unchanged. Buffer, detached, encode/view and Rust/wasm implementations were
  not edited. The default gate harness uses internal HostSchema through the
  migrated source drivers and needed no edit.

  **Additional host split:** extracting the buffer core removes the unused
  internal compile/fromProgram lazy edges and their orphan emitted chunks.
  Schema split initial/reachable/emitted gzip is now **33,575 B each**
  (before: 50,475 / 50,475 / 91,245 B). Compile's actual reachable split gzip
  falls **89,886 → 73,095 B**; its initial stub is 1,438 → 1,435 B.
  Synchronous public `new Program(P,B)` still must verify before returning:
  the verifier remains **19,732 retained minified B** in schema. No further
  verifier/serializer loading move can preserve that constructor and
  synchronous serialize while retaining this entry's complete public surface.
  Verification and the fromSerialized input snapshot still run before the
  Promise is returned. No verification was skipped or made asynchronous.

  **Measurements:** Apple M1 Pro, Darwin 23.6.0 arm64; Node v24.6.0,
  V8 13.6.233.10-node.24, esbuild 0.28.2, zlib 1.3.1-470d3a2,
  brotli 1.1.0. Offline `tools/size/size.mjs`, browser ESM/ES2022,
  minification and tree shaking, all exports retained; gzip 9, brotli 11.
  Before uses a frozen source snapshot taken immediately before these edits;
  generated module hashes common to both snapshots are identical. This
  baseline includes the already landed drain/control additions and differs
  from phase 1's older snapshots. Static excludes dynamic edges; full inlines
  reachable dynamic imports. Both runtime unions exclude compiler/Unicode.
  Persistent metrics, module hashes, ranked attribution, static graph edges
  and split totals: `tools/size/phase2.json`. Measurements are recorded here
  and there because this task's explicit write set excludes bench/README.md.
  `tools/size/budget.json` now caps every min/gzip/brotli metric, static and
  full independently, at **ceil(current shared-tree bytes × 1.02)**, including the
  controls entry added since phase 1.

  | Entry | Static min before → after | Static gzip before → after | Static brotli before → after | Full gzip before → after |
  | --- | ---: | ---: | ---: | ---: |
  | snug | 41,353 → 41,353 | 14,213 → 14,213 | 12,739 → 12,739 | 14,213 → 14,213 |
  | snug/schema | 132,411 → 91,184 | 48,794 → 33,575 | 41,742 → 28,916 | 49,065 → 33,575 |
  | snug/compile | 2,535 → 2,535 | 1,296 → 1,296 | 1,154 → 1,154 | 89,692 → 73,853 |
  | snug/view | 54,103 → 54,103 | 18,366 → 18,366 | 16,406 → 16,406 | 18,366 → 18,366 |
  | snug/writer | 37,865 → 37,865 | 13,035 → 13,035 | 11,662 → 11,662 | 13,035 → 13,035 |
  | snug/unicode | 19,377 → 19,377 | 9,287 → 9,287 | 8,817 → 8,817 | 9,287 → 9,287 |
  | snug/sources | 119,575 → 120,430 | 44,115 → 44,641 | 37,833 → 38,012 | 44,310 → 44,641 |
  | snug/controls | 3,429 → 3,429 | 1,378 → 1,378 | 1,259 → 1,259 | 1,378 → 1,378 |
  | runtime | 155,893 → 114,666 | 56,413 → 41,224 | 47,925 → 35,139 | 56,624 → 41,224 |
  | all-runtime | 190,741 → 191,126 | 68,663 → 69,338 | 58,105 → 58,253 | 68,828 → 69,338 |

  Schema saves **15,219 gzip B**; codec + schema saves **15,189 B**.
  Sources grows **526 B**, and all-runtime grows **675 B** (static gzip);
  partitioning relocates the drivers rather than deleting them. R9 remains
  open at **41,224 B** codec + schema versus 20 KB.

  **Validation:** `cd host/js && npm test` **1,303 passed, 0 failed/skipped**;
  all eight examples ran independently and from the staged package;
  `npm run build` produced a self-contained scratch package. Its existing
  copy/rewrite staging includes the new core/session files automatically;
  the package smoke test now calls openSession through the public export.
  Added regression checks for the complete schema static graph (no
  session*/sbase/scont/sstr or session facades), source graph without verifier
  or internal loaders, raw unknown-length pending/held EOF settlement,
  loaded-control Program ownership, forged schemas, private arrays and a
  throwing predicate's session isolation. Declaration syntax/exports/imports
  passed; offline TypeScript was unavailable (no semantic TS check claimed).
  `bb size` **exit 0**, all +2% caps passed. `bb rust-api-test` **exit 0**,
  public API/JS parity, stream/control tests, doctests and offline clippy;
  no Rust API source/test edits. Babashka prints its known sandbox
  process-enumeration shutdown warning after these successful gates.
  `bb vmsession-test` **exit 0 at defaults** (20,000 mutations, seed 1,
  400 oracle schemas, 60 stress): **969,521/969,521** whole-out-array matches,
  91,201 trapped runs, 9,501 interleaved; JS == Rust **628,417/628,417**,
  0 panics; hosts **8,247/8,247**. Unknown-length arm: drain
  **474,486/474,486**, 36,351 behind traps; fail-fast **73,834/73,834**
  (2,394 early refusals with another code/offset); unknown JS == Rust
  **99,677/99,677**. Total 403.2 s. These full differential and Rust API gates
  ran on the phase 2 paired snapshot, before the other engineer's subsequent
  tag-level regeneration; no claim is made that they gate those later edits.

  **Concurrent changes after the paired gates:** the tag-level engineer
  subsequently regenerated kin and edited the host profile/value/view/Writer
  paths. `tools/size/phase2.json.current` measures that later shared tree;
  final caps use it +2%, without attributing those additions to this split.
  Static gzip now: snug **14,549**, schema **33,761**, compile **1,296**,
  view **18,746**, Writer **13,358**, Unicode **9,287**, sources **45,000**,
  controls **1,378**, runtime **41,553**, all-runtime **69,970 B**.
  A fresh npm test on that in-progress tag tree reported **1,294 pass / 9
  fail**: old profile tests expecting newly admitted tags to be refused, and
  the option allowlist still rejecting the new default `tags: 'any'` preset.
  These changes belong to the concurrent tag task; they were not reverted or
  repaired as part of session partitioning. The paired phase 2 suite above
  passed before those edits.

  **What was learnt:** a synchronous factory in sources can preserve verified
  Program identity and private session storage while making schema genuinely
  buffer-only. Removing the internal loader edges also removes real split
  chunk overhead; the static byte reduction alone understates the startup
  transfer change. The synchronous Program constructor keeps the verifier in
  schema, and the all-runtime measurement makes the small relocation overhead
  visible. No kin implementation optimization is claimed by this phase.
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
- [x] **P7.9 — Re-take D005** (owner directions 2026-11-03): on the full library
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
  *Done 2026-11-03 by the P7.9 engineer.*
  - **Result:** both, with a rule (**D130**). D131 records the SDK design
    and D132 its unavoidable API differences.
  - **Record:** `bench/D005.md` holds the matrix, environment and method.
    `bench/d005-node.mjs` (Node CPU), `d005-memory.mjs` (memory and cold
    start), `d005-runtimes.mjs` (Chrome, workerd, sizes), `d005-ops.mjs` and
    `d005-inputs.mjs` reproduce it.
  - **What was built:**
    - The SDK, `host/wasm-sdk/` (about 1,300 lines of JS). Its
      `host/wasm-sdk/test/parity.test.mjs` passes 6/6. Each test compares
      the same inputs through the SDK and the native package:
      - the 216 profile vectors;
      - encodings;
      - byte-identical Programs for the six study contracts;
      - whole validation results;
      - views, cursor and `path()`;
      - handle and push sources over 1 B–64 KiB chunks;
      - instance-loss recovery.
    - Additive wasm exports: `host/wasm/src/sdk.rs` and `cc.rs`, under cargo
      features.
    - `kin/scripts/wasm-build` modes `sdk|sdk-size|sdk-s|cc|cc-size|cc-s`.
  - **Measured at:** a worktree of **93f8718** (P7.1's in-flight edits not
    included).
  - **Gates:** `bb vm-test` passed (JS == wasm on 50,576 cases) and
    `bb scan-test` passed (wasm on 31,360 cases), with the gated `lib.rs`.
  - **Learnt:**
    - wasm is 1.6–2.5× faster on all VM work in Node, Chrome and workerd,
      and compile is 4–10× faster. The JS builder and walk cap decode and
      encode near parity.
    - A wasm call costs about 5–8 ns more than the same kin function in JS,
      so batching navigation buys nothing measurable. An unpaged batch is
      10× worse when iteration stops early.
    - The input copy costs 61 µs per MiB, which is decisive for large
      byte-string bodies.
    - Chrome blocks wasm under `script-src 'self'`; it needs
      `'wasm-unsafe-eval'`.
    - workerd refuses `WebAssembly.compile` and `new WebAssembly.Module` on
      bytes ("disallowed by embedder"). The module must be a `wasm` module
      binding.
    - V8 reports stack exhaustion inside wasm as a RangeError, not a trap.
    - Linear memory keeps 136 MiB after 100 dropped 1.4 MB views, until
      `reset()`. A hostile schema leaves the compiler instance at 66 MiB
      until it is dropped.
    - The SDK runtime module is 83 KB gzip at opt-level 3 and 60 KB at z.
      It is much larger than the scanner + VM module (33 KB), because of
      vm-verify, both session machines, nav, the writer and the allocator.
    - wasm-opt was unavailable offline.
  - **Not done:** a decode tape, SharedArrayBuffer memory, a codec-only
    module, Firefox and Safari, Cloudflare production.
- [x] **P7.9b — The wasm SDK level with the native API** (follow-up to P7.9;
  owner direction 2026-11-03). *Done 2026-11-04 by the wasm SDK engineer
  (Claude); commits `d8baee9`, `898434f` and the DEVLOG/bench commit after
  them.* Decisions **D170–D176**.
  - **What changed:** profile options (D120–D127, D180–D184) through every
    wasm scanner / VM / writer export as an explicit flags argument; the
    encode tape gained tags (rule tag, kin's content checks, tag 24 by the
    scanner), Maps of every key kind, undefined, deterministic floats and the
    native messages; views gained the `tagged`/`undefined` kinds, any-kind
    keys, `tag`/`content()`/`isUndefined()`; extension controls through one
    import with the generic controls in wasm (D170, D171); format 1.1 and the
    registry in the compiler module, control arguments, Unicode tables,
    `controlsInBus`; unknown-length sessions, fail-fast, streams and
    `openSession` (D173, after D160); the native option validator and profile
    resolution everywhere (D172); `snug-wasm-sdk/controls` and `/writer`.
  - **Gate:** `bb wasm-sdk-test` (D174).
  - **Gates (actual runs, clean worktree of `898434f` in the scratch
    directory with `../kin` linked; Node v24.6.0, rustc 1.100.0-nightly
    2026-09-15 for wasm):** **bb wasm-sdk-test** defaults ok: 73,691 cases
    over 706 Programs, every section wasm == native (validate 73,691,
    schema.decode 73,688, codec decode 73,691, encode 22,702 + 3,204, views
    73,688 + 73,688, sessions 24,563 handle / 24,563 declared / 24,562
    unknown / 18,422 scans, compile 1,695, extension controls 14, options
    298, instance loss), 2 min 27 s; **bb vm-test** ok (JS == wasm 72,222/72,222
    on the older shim, JS == Rust 73,691/73,691); **bb scan-test** ok (wasm
    31,360/31,360; cbor2 differential SKIP, not installed); **host/js npm
    test 1,346 passed / 0 failed**. Also green at `d8baee9` (P7.12 not yet
    in): vm-test, scan-test, npm test 1,346/1,346; wasm-sdk-test then
    failed 6 handle cases, fixed in `898434f` (below).
  - **Measured:** bench/D005.md "Re-measured at 898434f" (D175).
  - **Learnt:**
    - Linear memory is not the GC's: the first full gate run grew the SDK
      instance past 2 GiB, because a refused unknown-length scan threw from
      its settle step before the session was freed; past 2 GiB the i32
      pointers wasm returns are negative in JS. Every exit path now frees and
      pointers are read `>>> 0`.
    - A session step can grow memory (key arena copies, the EXT window), so
      the JS views must be re-derived after every step, not only after
      allocations; a stale view reads a detached buffer as length 0.
    - A push buffer pointer that outlives an instance writes into the next
      instance's memory unless every feed checks liveness first (the
      instance-loss test caught it).
    - Session set-up dominates small inputs on both sides (0.3–1.7 ms per
      session; an unknown-length session's arena is sized for the input
      limit, 1.5 MB by default), so gate time is set by session count.
    - The concurrently landing any-tag level and session move needed only
      host-side mirroring (rule tags, messages, openSession); no kin source
      or generated code was edited, and the Rust host port (`&dyn Fn`) needed
      no change.
  - **Open:** the SDK is still experimental and unpublished (D130); a `Writer`
    over the tape, a codec-only module, wasm-opt, Firefox/Safari and
    workerd re-runs of the new rows were not done; EXT CPU bounds (the
    2026-11-04 worst-case analysis) apply to the SDK exactly as to native,
    since the predicates are kin's or the host's; `bytesHeld` does not count
    the session's kin arrays inside wasm.
- [x] **P7.9c — wasm SDK EXT port adaptation.** *Done 2026-11-04 (commit
  `88263f1`): the owner explicitly authorised both edits in session, and the
  coordinator made them (only `host/wasm/src/sdk.rs` and
  `host/wasm-sdk/src/runtime.mjs`); `bb wasm-sdk-test` passes 11/11, extension
  controls 14/14 wasm == native, unknown-length sessions included. The new
  metered EXT cases (costly, huge, unique-big, samelen-many, chars-budget) are
  in the parity set through `kin/scripts/vm-allcases.mjs` → `addExtCases`.
  The wasm parts of sequences (D219) and Phase 8 are unblocked.* Original
  entry (2026-11-05 dating as written): D190–D193 changed the kin `Ext` port, so the
  wasm SDK module does not compile any more: `bb wasm-sdk-test` was run on
  2026-11-05 and failed at `kin/scripts/wasm-build sdk` (5 rustc errors in
  `sdk.rs`: the `kc::*_ok` imports and the closures' signature). It stays red
  until these edits land. The P7.2 hardening engineer was given
  ownership of these files by the manager, but the session's permission
  classifier refused the edit; it was not worked around. The exact edits:
  * `host/wasm/src/sdk.rs`: the import becomes `fn snug_ext(id, ap, al, ip,
    il, room: i32) -> i32`, returning kin's verdict word as it is. `use` changes
    from `chars_ok, samelen_ok, unique_ok, unique_words` to `chars_prep,
    chars_run, meter_init, samelen_prep, samelen_run, samelen_words,
    unique_run, unique_words, M_WORDS`. `Prog` gains `preps:
    BTreeMap<(i32, i32), Vec<i32>>`, filled in `sdk_prog_bind`. For every
    leaf with kind 18 (P[43] + 8l: id P[o+2], ao P[o+3], al P[o+4]) whose
    kind is 1 it takes `chars_prep` into 2 words (`[1, 0]` if it refuses);
    for kind 3 it takes `samelen_prep` into `samelen_words` words (empty if
    it refuses). `ext_call(pr, id, pool, ao, al, b, s, e, room) -> i32`:
    kind 0 calls the import with `room`. Otherwise it sizes UNIQ to
    `unique_words(b, s, e)` (kind 2) or `M_WORDS`, runs `meter_init(m,
    room)`, then `chars_run(t, b, s, e, m)` / `unique_run(b, s, e, m)` /
    `samelen_run(pool, ao, t, b, s, e, m)` (-2 if the prepared table is
    missing), and frees UNIQ past 2^20 words. All three closures (validate,
    validate_span, ses_step) gain the `room: i32` parameter and return i32.
  * `host/wasm-sdk/src/runtime.mjs`: `snugExt(id, ap, al, ip, il, room)`
    answers `-2` (not 0) when unbound or failed, and returns `bound.call(id,
    arg, 0, al, item, 0, il, room)` as it is (the native binding charges the
    declared cost, D193).
  * `host/wasm-sdk/src/schema.mjs` needs no change: its `GENERIC` map by
    `check` still recognises the generic controls, since `{...chars,
    maxBytes}` keeps `check` and the `Symbol.for('snug.metered')` key.
  Done when: `kin/scripts/wasm-build sdk` builds, and `bb wasm-sdk-test` is
  green, including the new EXT cases (`costly`, `huge`, `unique-big`,
  `samelen-many`, `chars-budget`).
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
  to `docs/reviews/2026-11-03-usability.md`; host fixes implemented, gate
  held on one legacy assertion requiring permission to update).
  Decisions D150–D151; no kin/generated edits in this work.
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
    Implemented for both helpers, with frozen handles and independent reads;
    removed the obsolete Buffer workaround from API/guide.
  - **Finding 10 — alternative diagnostics:** preserve the existing
    deterministic witness contract by default. Investigate an explicit
    diagnostic mode preferring a matching literal discriminator, with a
    reviewed rule and cross-host tests before changing diagnostic semantics.
    Reproducer: `response = { ok: true, id: uint } /
    { ok: false, error: tstr .size (1..120) }`; `{ ok: false, id: 7 }`
    currently reports value at ['ok'], offset 8, while `{ ok: false }`
    reports missing error. Refusal is correct; document single-witness limits
    (done), do not treat this as an acceptance bug or silently change defaults.
    **Proposal/analysis (no VM change):** an opt-in diagnostic could report a
    bounded, deterministically sorted set of named schema rules/alternatives
    considered at the choice, plus a schema location or stable alternative
    index for anonymous branches. Those are Program metadata, independent of
    payload values; never include observed discriminator values, bytes or
    unnamed keys. Reporting which branch matched a literal discriminator
    would require an explicit kin witness rule, tie-breaks, work/memory bounds
    and cross-host tests. Even schema names need caller logging policy. The
    current result carries only one witness, so the host cannot reconstruct
    the actual candidate set at failure reliably from reason/path alone.
    A future Program/VM diagnostic extension should carry that provenance;
    preserve the existing witness and accept/refuse behavior by default.
  - **Finding 13 — option-key admission:** reject unknown keys consistently
    in compile, codec, schema/view/source and Writer options, while permitting
    documented preset fields when spread across operations. Regress misplaced
    compile `maxBytes` versus `limits.inputBytes`, `maxByets` at codec/schema
    calls, and unknown grouped limits. Preserve/document Writer grouped-limit
    precedence; review any unified/named options design separately. Compile
    limits and runtime spellings are mapped in the guide. Implemented one
    shared validator with allowlists for each public bag, including wire
    options and compile, and documented every entry point's accepted keys.

  **Host checks/learnt (2026-11-03):** new table-driven package-boundary
  regression tests cover malformed values and unknown keys across 33 option
  bags, safe diagnostics, no source reads before rejection, preset spreading,
  limits/cap semantics and Writer precedence. Buffer and Uint8Array subrange
  tests mutate inputs and returned reads, covering sync, microtask and timer
  helpers. The new option/snapshot suite plus codec differential suite passed
  592/592, including non-enumerable limit forwarding. First full npm test: 1,281 passed,
  2 failed, 0 skipped: existing round-trip tests reuse objects on encode
  (now retained as a checked no-op); a legacy omitUndefined: 1 assertion
  expects a data fault and conflicts with the requested TypeError contract.
  Requested permission for that one assertion because existing test edits
  were scoped to index.js. **Learnt:** validating outer option bags requires
  filtering internal forwarding (view metadata and Writer knobs are not
  schema/scanner options), and Buffer copying alone is insufficient if reads
  still expose the helper's private storage. Latest full gate on Node v24.6.0 /
  npm 11.5.1: 1,283 passed, 1 failed, 0 skipped (the legacy omitUndefined
  assertion alone). git diff --check passed. Permission for that assertion
  update remains pending; P7.10 is not marked complete while this gate fails.

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

- [x] **P7.12 — Tag levels and small items** (follow-up to P7.1's open list).
  *Done 2026-11-04 by the profile engineer (Claude); commits `f734753` (any
  tag) and the small-items commit after it.* Decisions **D180–D188**.
  - **Any tag (D180–D184):** `PF_TAGS` 2/3 = any tag number (JS `tags:
    'any'`, Rust `Tags::Any`), now the deterministic preset (flags 122; 118 =
    `tags: 'standard'`). Known tags keep their rules (2/3/4/40/LE typed
    arrays, the standard set, 55799 only at the top); RFC 8949 §9.2's
    invalid 65535, 2^32−1, 2^64−1 refused; RFC 8746 tags outside the Bindle
    set need a byte string of whole elements; everything else any content,
    an item one level below. Bignum minimality kept (D181). One *rule tag*
    per head (`rule-tag`: the number, −2 beyond 32 bits, −1 for 2^64−1) keeps
    the scanner, dead walk, live walk, resumable scanner and session on the
    `std-allowed`/`std-content-ok` path; schema `TAG`/`TAGSET` tests compare
    the whole 64-bit number (they compared the high word with 0). Session:
    the typed-array head rule is decided at `T_STD` from the head and held
    (`F_TNOTED`), never pinned; `key-end-any`/`key-max-claim` treat tag heads
    structurally (D183). JS: builder `Tagged` for every non-Bindle tag,
    `Tagged.tag` number|bigint (D184), Writer/encode any number (bigint
    heads), views read 64-bit numbers; CDDL `#6.n(T)` for any n matches.
  - **Small items:** (a) the "~5%" deterministic float scan cost does not
    reproduce one preset per process (deterministic = Bindle = 172.9 µs,
    pre-P7.1 169.8 µs; no change, D185, bench/README.md). (b) D124's whole
    reads stay — bounded by `maxBytes`/the key arena, documented; D180 adds
    none (D186). (c) The snug.js `declarefn` import bug is fixed in snug's JS
    target (`js-declarefn`), with `kin/scripts/js-target-test` in `bb check`
    (fails on the old target) and one source workaround removed (D187).
    (d) Byte-string/float cut keys stay `map_cut`: they need major 2/7 KEYS,
    which `vm-verify` refuses — a Program format change (D188).
  - **Vectors:** `corpus/cbor-vectors/deterministic.json` **117 accept / 102
    refuse** (was 92/85): COSE_Sign1 (RFC 9052 C.2.1), CWT = 61(18(...)) over
    the RFC 8392 A.1 claims, COSE 16/17/96/97/98, 55799 over COSE_Sign1,
    nested unknown tags, tag numbers 256, 65534, 65536, 2^32−2, 2^32,
    2^53−1, 2^63+2^32−1, 2^64−2, 2^32+2 (not a bignum), 2^32+24 (not tag
    24), unknown and 64-bit tags as map keys, tag 24 over an unknown tag,
    typed arrays 64/65/82/87 and 76; refused: the invalid numbers (also
    nested), odd/short BE typed arrays, tag 64 over text, content-first
    precedence, non-shortest tag heads (1/2/4/8-byte), an indefinite tag
    head, truncated 64-bit heads, 55799 nested in an unknown tag, unknown
    tags past maxDepth, non-preferred bignums. New `standard` column (the
    code under `tags: 'standard'`), checked by the gates. det-cases: seeded
    tags of 35 numbers (COSE/CWT, 64–87, 2^32±, 2^64−1) and fixed depth/item/
    key/typed cases under 9 flag values. vm-test's live schema holds
    `#6.18(v)`, `#6.4294967296(v)`, `#6.18446744073709551614(v)`, `#6`.
  - **Differential (cbor2 2.4.1 CDE + rejectDuplicateKeys/LongLoundNaN/
    Simple):** 38,563/40,503 same verdict, the rest in documented classes
    (floatwidth 412, nan 44, tag 196, tag24 41, limits 20, snugtags 1226,
    cbor2tags 1), 0 unexplained. The `tag` class now fails the gate unless
    the refused tag has a rule (0, 1, 24, 32, 55799, the any-level typed
    arrays), so snug refuses no rule-free tag number cbor2 accepts; new
    `cbor2tags` (cbor2's own tag decoders, e.g. 33 base64url, confirmed with
    `ignoreGlobalTags`). `encode()` == cbor2 `encode({cde: true})` on
    4,000/4,000 seeded values, 945 holding `Tagged` of rule-free numbers
    (64-bit included) against cbor2 `Tag`.
  - **Gates (actual runs, Node v24.6.0, the final tree):** `bb check` ok
    (incl. js-target-test); **scan-test** 31,360/31,360 Bindle cases on JS,
    Rust, wasm; 657/657 profile vector runs, 20,823/20,823 JS == Rust;
    **rscan-test** 262,097 policy + 272,354 split runs == recursive, Rust
    262,048/262,048; **vm-test** profile identity 64,366/64,366, 983/983
    conformance, 73,691/73,691 JS == Rust == fast/generic; **vmsession-test**
    982,778/982,778 session runs == buffer,
    638,986/638,986 JS == Rust, 481,536/481,536 unknown-length streams, 0 panics; **compile-test** 301/301
    identical, 270/270 verified, 55/55 SOURCE_KEYs; **nav-test** 1,131/1,131;
    **write-test** ok; **unicode-test** ok; **rust-api-test** ok (13
    integration incl. `any_tag_level_d180`, doctests, clippy); **host/js npm
    test 1,346 passed / 0 failed / 0 skipped**; **bb size** within budgets;
    **bb drift** ok after each commit.
  - **Sizes** (esbuild min / gzip vs `6c3237e`): snug 42,312 / 14,586 B
    (+959 / +373), snug/schema +620 / +216, snug/view +1,062 / +411,
    snug/writer +960 / +351, snug/sources +928 / +384, runtime +1,103 / +369,
    all-runtime +1,592 / +673; under the P7.6 budgets, no budget change.
  - **Learnt:** a 64-bit tag head must not take a 32-bit tag's path — the
    walkers had refused hi ≠ 0 before looking at lo, so nothing noticed that
    the VM's tag tests compared the high word with 0. An explanation in a
    bench record ("float-bad re-check") must be checked against the workload's
    data: the floats never reached the re-check. kin's deferred calls render
    after the module header, so a target that computes imports while
    rendering must not let calls defer.
  - **Open:** README/guide/architecture tag sentences were corrected in
    passing; host/wasm-sdk and the wasm scan shim still take no profile
    option (their defaults follow `Profile::DETERMINISTIC`, now 122);
    full RFC 3986 URI parsing (D121); cut keys of byte-string/float kinds
    (a format 1.2 decision, D188); incremental automata for whole reads
    (D186); bignum content cap under the any level stays 128 bytes (D181).

- [ ] **P7.13 — CBOR sequences (RFC 8742; review W21)** (2026-11-04, sequences
  engineer; architecture §18, decisions D210–D219). Owner use case: an
  SSE-like HTTP response whose body is a CBOR sequence, each message checked
  and handed out as a lazy View as soon as its last byte arrives.
  - **kin:** the session VM's sequence mode (`vms-init-seq`,
    `vms-message-length`; `SS_SEQ` 41, `SS_MLEN` 42): an unknown-length
    session whose root end is a boundary (no trailing check), the verdict held
    while a pending end claim is open or while it is `truncated`, released by
    a later window that covers the claims; `vms-eof` unchanged. Profile-only
    sequences run it against the built-in `any` Program (D146's reasoning);
    `rscan` is unchanged (D210).
  - **JS:** new entry `snug/sequence` — `readSequence(source, options)` (async
    iterator, `stats`, cancels the source when the loop is left) and
    `sequenceReader(options)` (`feed`/`end` → `{messages, skipped, error}`);
    messages `{index, offset, length, bytes, borrowed, view}`; borrowed
    subarrays inside a chunk, one assembly across chunks, `copy: 'always'`;
    views minted by `view.mjs`'s unexported `mintView` (D215);
    `validateSequenceOptions` (maxBytes refused for maxMessageBytes, D213).
    **Rust:** `snug::sequence` — `Sequence` (push, `Cow` messages),
    `read_sequence` / `Schema::read_sequence` (iterator over `Read`),
    `Schema::sequence`, `SequenceOptions`, `OnInvalid`, `MessageFailure`,
    `Error::Sequence`; `schema::Program::{words, pool, session_step}`.
  - **Gate:** `bb sequence-test` (D218; kin/scripts/sequence-{run,test}.mjs,
    host/rust/src/bin/sequence.rs). Actual run (defaults: 6,000 mutations,
    200 oracle schemas, seed 1; 31,063 vm-test cases → 70,445 sequences,
    651,598 runs; 5 min on a shared M1 Pro): kin sequence mode == D211's
    oracle on 637,516/637,516 runs (every line and out word; 3,108,385
    messages, 29,898 skipped, 106,780 stops, 34,108 clean ends); fail-fast
    14,084/14,084 (2,116 stopped early with another code); 5,429 runs behind
    out-of-bounds traps clean; JS == Rust (debug, overflow checks)
    154,608/154,608, 0 panics; JS hosts (readSequence spanning, sequenceReader
    always) == oracle on 31,310 host runs (3,021,635 messages: 3,014,544
    borrowed, 7,091 assembled; 604,327 view walks equal to a View on the
    bytes); Rust `Sequence` == oracle 31,310/31,310. Release latency: 1,481 of
    50,185 accepted messages in 1-byte runs waited for a byte past their end.
  - **Host fixes after the first commit** (the gate's host section was red
    at 8d78f1e): a held verdict is stepped with an empty window at the
    frontier, and before deciding `too_large` whenever bytes arrived since
    its last step (a held complete message was released a chunk late, and a
    held refusal could turn into `too_large`); a leftover assembly is dropped
    when the chunk being read holds those bytes; the gate checks D215's exact
    borrow rule — borrowed iff inside one chunk **and** released during that
    chunk's feed (a message completed later, after an item whose walk asked
    past its end, owns its assembly: a chunk is never retained after `feed`
    returns). The driver is now `host/js/src/sequence-core.mjs` (backend-
    agnostic) + `sequence.mjs` (gen-JS backend), ready for the wasm SDK.
  - **Docs:** guide "CBOR sequences and SSE", api.md `snug/sequence`, Rust
    guide "CBOR sequences", README feature row, architecture §18;
    `examples/sequence-sse.mjs` (a simulated `fetch` Response, run by the
    examples test). **Size:** `snug/sequence` budget added and `all-runtime`
    re-capped (`tools/size/budget.json` `p7_13`); `snug/sources` unchanged
    because sequences live in their own entry (they carry the View).
  - **Learnt:** the test runner must not re-slice from the walk's position
    while a verdict is held (an oversize message waits for P bytes: quadratic
    copying); one 1,500,001-zero-byte vector is 1.5 million messages as a
    sequence, so the gate cuts sequences at 2,000 messages and keeps one uncut
    run. Release latency: an accepted message waited for a byte past its end
    whenever the walk asked for more than the item (tag-40 notes, non-text
    keys crossing a window, extension-control whole reads — including
    text-keyed events using a control such as `.chars`); the first commits
    only counted it. Fixed after the review (below): now asserted zero.
  - **wasm SDK (deferred, D219):** needs `vms-init-seq` / `vms-message-length`
    exports and the native sequence host driven through the SDK session
    wrapper; views over a JS-side copy of each message.
- [x] **P7.13x — wasm SDK parity regression case** (2026-11-11). First
  attempted as a shell append, which the auto-mode permission classifier
  refused; it was not retried or worked around. Applied by the coordinator
  with a plain file edit after the owner gave free rein over the snug repo
  (2026-11-11), with `'valid'` added to the wires. The new test passes:
  wasm == native, under all three wires and every split. The hunk as
  appended to `host/wasm-sdk/test/parity.test.mjs`:
  ```js
  test('sequences: regression 2026-11-11 -- a complete 65,541-byte message followed by more than maxMessageBytes', () => {
    const big = new Uint8Array(1500001); big.set([0xa1, 0x61, 0x61, 0x59, 0xff, 0xff]); big[1500000] = 0xa0;
    const run = (api, wire, cuts) => {
      const r = api.sequenceReader({ wire, top: 'map', maxMessageBytes: 1500000 }), got = [];
      let from = 0;
      for (const to of cuts) {
        const res = r.feed(big.subarray(from, to)); from = to;
        got.push(...res.messages.map(m => `m${m.index}+${m.length}`));
        if (res.error) { got.push(`x${res.error.index} ${res.error.code} @${res.error.offset}`); break; }
      }
      return got;
    };
    for (const wire of ['bindle', 'deterministic'])
      for (const cuts of [[big.length], [65536, big.length], [6, 65541, big.length]]) {
        assert.deepEqual(run(WSEQ, wire, cuts), ['m0+65541', 'x1 not_map @65541'], `wasm ${wire} ${cuts}`);
        assert.deepEqual(run(NSEQ, wire, cuts), ['m0+65541', 'x1 not_map @65541'], `native ${wire} ${cuts}`);
      }
  });
  ```
  - **2026-11-11 regression (P8.4's scaled run `sequence-test 30000 1001`):**
    `a1 61 61 59 ffff` + zeros to 1,500,000 bytes + `a0`, P = 1,500,000, one
    chunk, answered `too_large` for the complete 65,541-byte first message.
    Root cause in the gate's kin-level runner (`sequence-run.mjs` and its Rust
    port `bin/sequence.rs`), not kin or the hosts: the runner caps a window at
    64 KiB past its position, so the string's length claim stayed open and the
    verdict was held; with more than P bytes delivered it called `vms-eof`
    (→ `too_large`) without first asserting the delivered frontier, which
    releases the claim. Fixed as the hosts already do (9ce6310): a held
    verdict is stepped at the frontier before too_large/EOF is decided. Kin
    answers this input correctly for every window. Fixed case in the gate
    (both hosts, Rust runner included), JS and Rust host tests; the SDK
    parity test addition was refused by this session's permissions (the SDK
    shares the native driver).
  - **Review 2026-11-04 (docs/reviews/2026-11-04-sequences.md) addressed:**
    #1 liveness in kin (`vm-session.kin` `note-live` and the EXT whole read,
    `vm-session-cont.kin` key reads; D212 amendment), gated; #2 Buffer copy;
    #3 private message/View/Cursor state; #4 per-message pacing in
    readSequence; #5 linear assembly (JS and Rust); #6 exception after the
    earlier messages; #7, #8, #10 docs (ownership precisely, transport
    exceptions, verdict wording for refusals, SSE recipe with status /
    media type / null body / AbortController / sequence numbers); #9 the gate
    asserts last-byte release and the strict borrow rule, npm tests cover
    Buffer, read-only fields, exception order, work before the first yield and
    assembly retention. Not done: an independent RFC framer in the gate (the
    reviewer's own 40,400-comparison parity probe is the independent check for
    now) -- *added by P9.5 (2026-11-11)*; the SDK's view.mjs has the same public-state escape (host/wasm-sdk
    is under the P7.13w block) -- *closed by P7.13w (2026-11-10).*
- [x] **P7.13w — wasm SDK sequence reader and view privacy** (2026-11-10, wasm
  SDK engineer; authorised by D300; earlier blocked 2026-11-04, see D219).
  - **ABI (host/wasm/src/sdk.rs; additions only):** `sdk_vs_new` with total −2
    → `vms_init_seq` (INFO[0] the input limit, as −1); `Sess::Vm` keeps its
    `rule` and limit words; new `sdk_vs_reseq(h, quantum)` (vms-init-seq again
    on the session's arrays; 0, a negative vms-init answer, −100 bad handle);
    after every vms step and `sdk_ses_eof` INFO[4] = `vms_held_code`, INFO[5] =
    `vms_message_length`; new `sdk_ses_step_at(h, off, n, base)` stepping over
    window[off..off+n) (`sdk_ses_step` is `ses_step(h, 0, n, base)`). The last
    one is beyond the 2026-11-04 list: without it every message of a large
    chunk would recopy its window (up to maxMessageBytes) into linear memory.
  - **JS:** `host/wasm-sdk/src/sequence.mjs` (`./sequence` export):
    `readSequence` / `sequenceReader` from the shared driver
    (`host/js/src/sequence-core.mjs`) over a `SequenceSession` backend. The
    session gets exactly the native windows (a first draft handed it only
    the copied part of a window and changed fail-fast timing on one split
    run; the gate caught it). The backend keeps one copy per chunk: a later window
    inside it steps at an offset, one reaching further appends only the
    tail, and it is compacted when most of it lies behind; invalidated on each
    feed (backend `chunk()` hook). INFO/OUT are snapshotted after every call
    (any other SDK call overwrites them; `Inner.result(o, at)` renders a
    copy). Sessions are freed at the end, when a readSequence loop is left
    (core `close()` hook, also used by the native core as a no-op), or by a
    FinalizationRegistry. `sequenceTarget` moved into sequence-core.mjs (both
    hosts). Views: `host/wasm-sdk/src/view.mjs` → `view-core.mjs` (internal:
    View/Cursor state in private fields, a private-brand check on Message,
    `mintView`, `directoryWords`); the new `view.mjs` exports only `view`,
    `View`, `Cursor`. This closes the SDK's `new View(fake)` / `_m` escape. A
    minted View copies the message into linear memory on first use
    (`view.borrowed` false; `message.borrowed` as native).
  - **Gate (`bb wasm-sdk-test`, actual, defaults 20,000 mutations / seed 1 /
    400 schemas, shared M1 Pro, 14.4 min total):** 13/13 tests pass. Sequences
    are built from the whole case set (74,666 cases → 168,743 sequences, as
    bb sequence-test builds them; 4 cut at 2,000 messages). The policy and
    chunking rotate (not every combination per sequence):
    `sequenceReader` runs on every sequence (whole / 1-byte or 4096 / random
    1..7 / 1..300 chunks; stop, skip, copy always, failFast and combinations).
    `readSequence` runs on every other sequence (another chunking; quantum 7/50
    on about a quarter, 1 rarely). Every-offset splits run on every fourth
    small sequence. Results: sequenceReader per-feed answers ==
    native 335,853/335,853; readSequence (messages, the chunk being read at
    each yield, fault, stats) 84,372/84,372; view walks + cursor walks on every
    third sequence's sampled messages inside both. Release latency is 0 (wasm)
    and 0 (native) of 33,404 accepted messages in 1-byte runs. API behaviours
    32/32 (one message ahead, predicate exception order, Buffer copy,
    last-byte release, option validation, cross-package schema). The privacy
    checks pass (read-only fields, no own keys on View/Cursor, forged
    construction refused, `snug-wasm-sdk/view` = {Cursor, View, view},
    view-core not exported). Instance loss ends a pending reader with an error,
    and a fresh one works. Sequence section 683 s, of which wasm 166 s and
    native 444 s in the readers.
  - **Fixed in the gate:** the openSession section was red at HEAD
    (1538677): the harness called `end()` again after vms-eof's resume, and
    both hosts answered "vms-eof answered −1". The harness now ends once (the
    hosts agree, with real verdicts).
  - **Other gates (actual):** bb sequence-test ok (kin == oracle
    637,516/637,516; fail-fast 14,084/14,084; latency 0/50,185; JS hosts
    31,310 runs; JS == Rust 154,608/154,608; Rust Sequence 31,310/31,310;
    1,244 s); vm-test ok (JS == wasm 72,588/72,588); scan-test ok (wasm
    31,360/31,360); host/js npm test 1,438/1,438; bb size: budgets pass
    (snug/sequence unchanged at 151,945 / 54,323 gzip).
  - **Size:** SDK runtime wasm (release) 268,070 → 269,042 B (+972), gzip
    98,843 → 99,382 (+539); opt-level z build 175,735 B / 72,136 gzip (after).
    SDK glue, esbuild min/gzip: `./sequence` 84,771 / 30,186; `./view`
    64,171 / 22,369.
  - **Open:** P8.4 moves session steps to `vms_step_v`; `sdk_ses_step_at`'s
    (off, n) window semantics must survive that rebase (noted to the
    manager). The SDK reader inherits D219's SDK view contract (D132).

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

## Phase 8 — Spec compliance (D230; audit P8.1, 2026-11-04)

Plan (manager, 2026-11-04), in the owner's order: audit (done, `docs/conformance.md`)
→ correctness fixes and documentation → valid-CBOR default → CDDL coverage.
Every item is gated by the oracle, JS == Rust (and wasm when P7.9c is
authorised), the existing gate set, and conformance-corpus vectors.

- [x] **P8.2 — Correctness fixes and repricing** (audit ranks 1–4; D241):
  float comparison/exclusion lowering for ±0 and NaN (S15, S16, D038);
  unplugged group sockets are empty choices, not empty groups (S32; repair
  the oracle and corpus assumption); known-tag validity — RFC 3339 leap-second
  rules for tag 0, RFC 3986 grammar for tag 32 (S61, D121); documentation
  drift (S74); adopt the calibration repricing D241.
  **Done 2026-11-04** (compliance engineer; bc4bdbd, 88d6352, b1e05fd and
  the calibration-record commit). Decisions D250–D254, sign-offs unticked.
  1. **Floats (D250)**: numeric comparison — one zero, NaN unordered but
     unequal; bounded == unbounded spellings; no format change. 198 vectors
     equal Ruby 0.12.14's verdicts (Rust 0.10.7 differs on NaN `.ne`, bounded
     ranges and `.and`: its bugs).
  2. **Sockets (D251)**: unplugged `$$x` = empty group choice. Repaired:
     corpus/tools/oracle.mjs (empty `gchoice`, was `seq([])`) and one
     adversarial verdict (`{a:1}` against `r = {a:int, $$nothing}` → false);
     no other corpus, proptest or oracle-differential expectation depended on
     it. architecture §4.8 amended with a dated note; no D-decision had
     stated the old reading.
  3. **Known tags (D252)**: tag 0 upper-case T/Z (RFC 4287 §3.3) and second
     60 only at 23:59:60 UTC on a month end (no leap table: time-dependent);
     tag 1 any float incl. non-finite; tag 32 full RFC 3986 URI-reference.
     Quotations checked against corpus/rfc. Ruby refuses every leap second
     (RFC wins). Opaque vs validated tags (incl. 1040, opaque) documented.
  4. **Repricing (D253) and schedules by path (D254)**: D241's prices, 2.25 M
     default, EXT_CALL 16; forced generic charged by schedule 1. Before/after
     calibration (bench/VM.md "Calibration 2026-11-04 — D253/D254
     confirmation"): repriced kinds 4.8–10.9× → 0.75–1.57× of the JS median
     kind (Rust 4.4–6.5× → 0.67–1.26×); forced generic 3.3–5.5× →
     0.81–1.63×; ~55 ms estimated at 2.25 M (load-affected, not quiet).
  5. **Docs (S74)**: SPEC §1/§3, README, cddl-support (prelude witnesses,
     tag scope, float/socket notes, mixed numeric controllers), program
     §4.4/§8.4/§13/§14/§15, api loader 1.1, architecture §4.1/§4.8/§7,
     guide; the default's refusal of valid non-deterministic CBOR and
     D230/P8.4 stated plainly in README and SPEC.
  Regression corpus: corpus/conformance/audit-2026-11-04.json (40 suites,
  300 cases, deterministic wire; consumed by vm-test, compile-test,
  compile-fuzz, JS serialized/sources tests and the wasm parity test);
  deterministic.json vectors updated for D252.
  **Gates** (on the committed trees, in scratch worktrees): check, drift,
  scan-test, rscan-test, vm-test, vmsession-test, compile-test, compile-fuzz,
  nav-test, write-test, unicode-test, rust-api-test, size, host/js npm test,
  and wasm-sdk-test (11/11, after P7.9c) green. sequence-test is not in
  HEAD's bb.edn (uncommitted sequences work); a main-tree run with everyone's
  changes was stopped at 30 min under load ~200 and is not claimed.
  **Learnt / open**: a reference tool is evidence, not a verdict (Ruby has
  no leap seconds, checks no URI syntax and takes the first rule as root);
  dispatch-dependent prices would make budget verdicts chunk-dependent
  (D254); the size gate grew ~2 KB min for the URI recogniser (caps raised
  with justification); `.chars`/hash cross-host fit still unresolved (D240);
  a quiet-machine timing confirmation of the 2.25 M default is still owed.
- [~] **P8.3 — Regexp: XSD and I-Regexp options** (audit rank 8):
  **Implemented 2026-11-04; timing gate pending; no commits.** D242/D243 are
  before Findings, owner sign-offs unticked. Default `regexp: 'xsd'` follows
  RFC 8610's XSD 1.0 Appendix F reference; `iregexp` retains previous
  admissions/refusals, automata, source keys and compile units. Kin lowers
  nested class subtraction (including negated operands), `\i/\I`, `\c/\C`,
  `\s/\S`, `\d/\D`, `\w/\W`, categories and bounded quantifiers into the
  existing Glushkov automata. XML 1.0 fifth edition name ranges are static
  compiler data; digits/words/categories use optional `snug/unicode`.
  **Allowed block-data fallback:** `\p{Is…}`/`\P{Is…}` explicitly refuse
  unavailable pinned block data even with category tables. The pinned Node
  ICU API exposes no Block property; the generator checks/reports this.
  No Program format, VM, scratch or runtime-charge change. XSD source keys
  bind the dialect; the embedded JS `any` Program's key was regenerated.
  JS validation/types, Rust raw/public options, wasm compiler/SDK option
  transport, guide, support/spec/architecture/Program docs and generated
  compiler output are updated. Compile admission is outside the runtime
  option-shape graph. Two integer annotations in concurrent float-control
  bindings were needed for a warnings-denied Rust build; no semantic change.

  **Checks actually run:** `bb emit` passed; `bb compile-test` passed
  (301 existing cross-host outcomes, 270 verified Programs; old corpus cases
  and assertions retained under explicit I-Regexp). New regexp gate:
  **158 JS == Rust == wasm compiler outcomes** (62 complete Programs,
  96 schema errors), **229 equivalent Node v reference verdicts**, independent
  dialect/Unicode source-key hashes, **6,696 complete JS == Rust VM outputs**
  including both schedules, fast/generic and partial budgets. Hand-derived
  Appendix F/XML vectors are in `corpus/conformance/xsd-regexp.json`; Ruby
  cddl's host-regexp anchoring/escape differences supply no expectations.
  Direct final comparison to pre-P8.3 HEAD: **126/126 identical I-Regexp
  Programs/errors and compile units**, with/without Unicode. `bb unicode-test`
  passed (574 cross-host compiler outcomes, arena retries, 40 category tests);
  `bb vm-test` passed (74,300 JS == Rust whole outputs, 72,222 JS == wasm);
  **host/js npm test: 1,387 passed, 0 failed**, including 40 XSD tests.
  Rust public regexp integration tests: 2/2 passed. `bb size` and
  `git diff --check` passed. Logs: `.cache/p83-*.log`.

  **Gate still red:** two full `bb compile-fuzz` runs checked 3,000 texts
  (seed 24301, both dialects; 427 compiled / 2,573 refused) and 375 arena-size
  comparisons without identity/verifier/panic/budget/arena differences, but
  the unchanged **2-second wall-clock threshold** failed on non-regexp
  shared-array chains: first run 1 case (2,820 ms); second 4 cases
  (2,527–3,998 ms). System load at the second failure was 66.65/144.15/124.21.
  A subsequent same-schema sequential diagnostic also exceeds that threshold
  on the **unmodified pre-P8.3 compiler** (4,734 ms vs current 3,603 ms;
  both accept, both 1,572,297 units; method/environment in bench/README).
  No threshold was relaxed or case removed. A quiet-machine compile-fuzz
  pass remains required before this item is ticked complete.

  **Sizes** (esbuild min / gzip, full closure): compiler **222,828 / 75,707 B**;
  runtime **116,402 / 41,848 B** (shared before snapshot 116,794 / 42,028).
  Only this task's compiler-full caps rose, with 2% margin and justification
  in budget.json; runtime caps were preserved by P8.3. Concurrent sequence
  budget updates belong to that item. Unicode stays 19,377 / 9,287 B.
  Environment/method/source hashes and complete entry sizes: bench/README
  "XSD regexp compiler (P8.3)".

  **Learnt:** negation precedes subtraction; XSD word excludes underscore and
  includes symbols, while whitespace is only TAB/LF/CR/SPACE. XML names do
  not need category tables. Compare arbitrary decimal bounds before saturating
  expansion counts, including empty expressions; the old I-Regexp extreme
  bound quirks are preserved and recorded under Findings. Raw U+10FFFF is
  outside CDDL's unescaped string production, so boundary schemas must use
  a CDDL Unicode escape. Compile-time options can be tree-shaken out of all
  runtime entries; changes to source-key construction also require updating
  embedded compiled constants. Wall-clock fuzz thresholds require a quiet
  host even when semantic outcomes and charged work are unchanged.
- [x] **P8.4 — Valid-CBOR default** (audit ranks 5 and 9; D230): a `valid`
  wire preset as the default — indefinite lengths, non-shortest heads and
  floats, unsorted keys, NaN payloads, decimal/typed-array/ndarray/tag-55799
  application rules moved out of the general policy; duplicate keys by value
  on unsorted maps within the budget; literal, key and duplicate comparison by
  value; scanner, both VM drivers, views, builder, sessions and sequences;
  `deterministic` and `bindle` stay as options; measure whether a specialised
  deterministic-only fast path is material and keep it only if so.
  - 2026-11-04 design: architecture §19, D260–D269 (unsigned). Implementation
    order: (1) scanner valid walk + canonical copy (`kin/scan.kin`,
    `head.kin`, `float.kin`, `keys.kin`, `tags.kin`, `codes.kin`, a new
    `kin/canon.kin`) and the host codec/views; (2) the VM attempt and
    canonical path (`vm-api.kin` new `-v` entries, `vm-dead.kin` `key-order`
    under `PF_CANON` and the EC-sensitive mark, the embedded walks in
    `vm-eval.kin`/`vm-dead.kin`); (3) sessions after the sequences commit;
    (4) the default flip, differential, properties, benchmarks, docs.
  - Coordination with P8.2 (regions P8.4 edits in shared files):
    `kin/stdtags.kin` — only `std-allowed` (55799 depth rule by tag level) and
    a tag-1040 branch in `std-content-ok`'s dispatch, not `date-time-ok` /
    `uri-ok`; `kin/vm-leaf.kin` — `leaf-float`'s NaN test for float32/64 widths
    (a canonical copy can hold a NaN with a payload in those widths) and
    `leaf-int`'s bignum magnitude with leading zeros (`cmp-mag` callers); if
    P8.2's float rework already covers NaN in every width, P8.4 takes it as is;
    `docs/program.md` — a new paragraph after §14's schedule-2 text ("Valid
    CBOR input"), not the table rows.
  - 2026-11-10 increment 1 (the `valid` preset exists; the default stays
    `deterministic` until the flip): scanner valid walk and canonical key
    records (`kin/scan.kin`, new `kin/canon.kin`, `head.kin`, `tags.kin`,
    `stdtags.kin`, `codes.kin`); the VM canonical path with refusal replay
    (new `kin/vcopy.kin`, `vm-api.kin` `-v` entries, hooks in `vm-dead.kin` /
    `vm-eval.kin`; D264, D280); sessions and sequences on `vms-step-v` (D283,
    new `kin/vm-session-valid.kin`); `rscan` answering `scratch` for valid
    handles; hosts (JS, Rust, wasm and the wasm SDK under D300) routing valid
    and any-key profile-only streams to the session VM; sequence messages'
    Views read the canonical copy (JS, SDK, Rust); D265's Bindle-only rules;
    `bb valid-test` (RFC 8949 Appendix A/F, equivalence property, F2 replay
    incl. sessions, cbor2 differential with classes, fixed regressions,
    RFC 8742 sequences of indefinite-length items through `sequenceReader`).
    `sdk_ses_step_at` keeps its (off, n) window semantics. Found and fixed
    while gating: a tag-24 payload's copy is bounded two levels below its tag
    (as the scanner) when only the tag-24 walk reads it, and a container
    stop planted after its depth check lets a tighter walk refuse depth first
    (`pw-bad-df`, `head-fail`; event word 7); a map's deferred duplicate
    check reports the items walked to the map's end; tags 4/40 take the
    any-width content path on the VM in a valid run under the Bindle tag
    set, as in the scanner; a session's integer streak in an indefinite
    array stops at the entry bound (the last four found by the scaled
    gates). Size: D285 (attributed, cut, caps at measured + 2%; owner
    sign-off); fast path: D286 (attempt kept; session pre-check `skim`);
    measurements in bench/README.md "Valid CBOR (P8.4)". Open: D284, docs,
    the default flip, session cost on non-deterministic input (D286).
    Gates (2026-11-11, on this increment): vmsession-test (999,880 session
    runs == buffer; drain 488,625/488,625; JS == Rust 648,515), sequence-test
    (635,945 oracle runs; release latency 0/50,480; JS == Rust 154,170),
    valid-test (RFC 561/561; equivalence 589/589; replay 2,720 buffer + 2,133
    session runs; regressions 99/99; cbor2 0 unexplained; sequences 36/36),
    wasm-sdk-test 14/14 (valid sequences 18/18), drift, check, scan-test,
    rscan-test, vm-test, compile-test, nav-test, write-test, unicode-test,
    rust-api-test, compile-fuzz, host/js npm test 1,438/1,438, bb size: all
    ok. Scaled: scan-test 300000/1001, rscan-test 200000/1001, vm-test
    200000/1001/4000 ok (proptest P6 run); vmsession-test 60000/1001/1200/180
    ok (2,706,044 session runs; drain 1,326,118; JS == Rust 1,764,081).
    sequence-test 30000/1001 fails one run here and not on
    main: a pre-existing sequence-mode discrepancy its new random sequence
    reaches -- a message stream longer than maxMessageBytes in one window
    answers too_large for its first (complete, 65,541-byte) message where
    D211's oracle accepts it; reproduced on main `c48ac45` with the same
    input (`a1 61 61 59 ff ff` + zeros to 1,500,000 bytes, then `a0`, limits
    `0,0,1500000,…`, whole window); not P8.4's, reported. Not run:
    crate-diff (its native oracle binary is absent here). proptest P1/P2
    show the same five signatures on main (2-minute runs; the oracle
    predates the deterministic default) -- not P8.4's.
  - 2026-11-11 increment 2 (*P8.4 done*): the default is `wire: 'valid'` —
    JS `DEFAULT_WIRE`, Rust `Profile::default()` and the `Default` of
    `DecodeOptions`, `EncodeOptions`, `ValidationOptions`, `SequenceOptions`
    and `schema::Options` (`DecodeOptions::deterministic()` now selects the
    deterministic preset; new `DecodeOptions::valid()`); the wasm SDK follows
    the JS option resolution. Encoded bytes are unchanged. Docs: profiles.md
    (three presets, "Valid CBOR" section, option table, flags), scanner.md
    (the `PF_VALID` walk), guide.md, api.md, rust.md, host/rust/README.md,
    cddl-support.md, README (the "Can it read my protocol?" table), SPEC §1.1
    and §3, program.md §14 ("Valid CBOR input"), a superseded-default note
    on conformance.md. Value fixes found with the flip: a bignum (tags 2/3)
    holding a safe integer decodes to a number (D123's integer rule); the JS
    encoder writes `Tagged` tag 4/40 values (decimal fractions and ndarrays
    outside `Decimal`/`NDArray`'s invariants) above the Bindle tag set, their
    content checked by the scanner, and typed float arrays with NaN above the
    Bindle tag set (D265), so every value the default decodes re-encodes.
    Engine fix: a replayed refusal's source position at a region's end is the
    region's, not the embedded copy starting there (`vmap-x`; an embedded
    map cut short at a key reported the content's start; valid-test
    regression). Tests and examples now name `wire: 'deterministic'` where they
    meant it. `tools/proptest` (P1/P2): the profile-precedence check uses
    snug's own scanner under the call's options; the oracle (a
    deterministic-data arbiter) is held to `wire: 'deterministic'`
    verdicts; cbor.mjs is held to `wire: 'bindle'`; the default is held to
    properties (a superset of Bindle acceptance with the same values, values
    re-encode and decode to themselves, entry points agree). The five
    signatures known on main are gone; a 3-minute campaign of properties
    1–5 on this increment found none (P1 76,529, P2 89,973, P3 38,257, P4
    34,955, P5 30,589 cases; 0 failure signatures). The wasm SDK's own encoder
    got the same Tagged 4/40 and typed-NaN changes (`host/wasm-sdk/src/
    encode.mjs`, D300). Gates on this increment: drift, check, scan-test,
    rscan-test, vm-test, vmsession-test (999,880 session runs == buffer),
    sequence-test (635,945 oracle runs), valid-test (regressions 103/103),
    wasm-sdk-test 14/14, nav-test, write-test, compile-test, unicode-test,
    rust-api-test, compile-fuzz, host/js npm test 1,438/1,438, bb size
    (within D285's caps; runtime 53,424 gzip): all ok. For the PEG
    engineer (p85-peg): this increment touches host option defaults (JS
    profiles.mjs, Rust decode/encode/api/sequence/schema Default impls),
    the JS writer, build.mjs, kin/vcopy.kin (`vmap-x`), tests, docs and
    tools/proptest; no `host/wasm/src/sdk.rs` change; rebase onto it.
  - 2026-11-11 verification note (on `3c10a83`, a `git archive` snapshot in
    `.cache/runs/`; the shared tree held uncommitted kin/gen/host edits).
    **Oracles** lost in the 2026-11-09 /tmp cleanup are rebuilt under
    `.cache/oracles/` (crate 0.10.7 CLI, Ruby cddl 0.12.14; steps, hashes and
    toolchain in `corpus/tools/ORACLES.md`); the scripts take `CDDL_NATIVE` /
    `RUBY_CDDL`. **crate-diff** (previously not run): 6,915 compared,
    6,614 agree, 301 disagree, 70 crate schema errors, 2 panics, 0 snug bugs;
    the only change from P4.1 is D251's "undefined sockets" (class withdrawn;
    `corpus/conformance/crate-diff-findings.md`). **vmsession-test at 10×**
    (200,000 mutations / 4,000 schemas / 600 stress) as five 2× chunks
    `40000 <seed> 800 120`, seeds 1001–1005, two at a time at load 20–60:
    1001 ok (1,848,807 session runs == buffer, 3,601 s), 1002 ok (1,847,609,
    3,444 s), 1003 ok (1,854,151, 3,735 s), 1004 ok (1,856,370, 3,720 s),
    **1005 FAIL** (1,849,127/1,849,132; drain 907,273/907,276; 10 failure
    lines, all one input; 2,999 s). Totals: 9,256,069 session runs,
    9,256,064 == buffer; JS == Rust 6,035,559/6,035,559 (0 panics);
    drain 4,538,330/4,538,333; host identity 56,787/56,787.
    **Snug bug (open, not fixed here): a session misnames the refusal when
    the item bound falls inside a tag-4 decimal split across windows.**
    Public reproducer, still present at `cfbdda3`: `compile('r = any')`,
    bytes `c4 82 21 19 6a b3` (4([-2, 27315]), a valid decimal), options
    `{top:'any', wire:'deterministic', tags:'bindle', maxItems:1}`:
    `Schema.validate` answers `cbor/too_many_items` at 1, but
    `validateHandleSync(..., {chunk:1})` (also chunk 3) answers
    `cbor/decimal` at 0. Not with `tags: 'standard'`/`'any'` or `wire:
    'valid'`, nor with a whole window. Both refuse, so no verdict flips; the
    D030 identity (reason, offset, budget, items) breaks. The Rust session
    agrees with JS, so the defect is in the kin session VM. Harness input:
    seed 1005, `detmut 17994`, `a4181845c756adefb3182138fb1827c48221196ab3f97c00fa7fc00000`,
    limits `1,0,36,4,5,7,-1,-1,0,2`, byte windows or a split at 17.
    **Fixed 2026-11-11 (D286 perf analyst).** Cause: keys of any kind put
    the session's whole items through the valid machinery (`vitem`). The
    scanner refused this item with `too_many_items` before reading past the
    window, so the item was walked over its canonical copy. There the array
    whose declared length ran past the window was planted as a malformed head
    (`pw-bad-df`, byte 0x9c), and the Bindle-level pair check (0x82 exactly)
    refused `decimal` on the planted byte, where the input passes it and
    counts the array first. The valid preset's pair check only tests the
    major type, so it never showed. Fix: the planted head's EV_HEAD word 7
    carries `1 + 2 * the source byte` (`vcopy.kin` `plant`); `head-fail`
    tests its low bit; `pair-check` over a copy checks the source byte
    (`vm-dead.kin`). Both reproducers are fixed cases in vmsession-test (18
    failures without the fix in a small run). Gates (clean worktree on
    `920a3e1` + D286 B+C): vmsession-test (1,059,067 session runs == buffer;
    JS == Rust 692,470; 523,510 untold-length streams; hosts 10,140),
    sequence-test (735,997; JS == Rust 182,190), valid-test, vm-test,
    scan-test, rscan-test, drift, rust-api-test, wasm-sdk-test 14/14, npm
    1,450/1,450, size: ok.
- [ ] **P8.5 — CDDL coverage, rescoped by D270 (PEG group semantics)** (audit ranks 6, 7, 10; D230): budget-metered
  general map assignment where D011 cannot prove greedy exact (bounded
  search / bipartite matching), coupled and non-interval group repetitions,
  non-regular group recursion, composite `.ne`, non-literal `.cat`/`.plus`/
  `.det`, `.abnf`/`.abnfb` as a bounded kin engine; proven fast paths kept;
  oracle agreement on all of it.
  - **Design delivered (2026-11-04, group-semantics designer; for
    independent review, nothing implemented):** architecture §20 "PEG group
    semantics" and a draft [docs/program-2.md](docs/program-2.md) (format 2.0,
    a major bump under D084; 1.x refused). Semantics: arrays are the App. A
    PEG with prioritised choice, greedy occurrence, no retry from the
    end-of-array test, and a zero-length iteration ending a repetition as
    satisfied. In maps, entries run in source order, each taking the matching
    remaining pairs greedily up to its maximum in EC key order; non-cut
    members skip pairs whose key matches but whose value does not (§3.5.4);
    choices lock in and closedness is tested after the root. Cuts:
    `'reference'` (D021 in PEG: a cut-failed member fails, ordinarily) and
    `'rfc'` (commit on key match). §20.3 resolves R1–R18.
    Evaluation: elements and pairs are still evaluated once. Arrays get a
    relaxed Glushkov query automaton plus per-element verdict records and an
    incremental PEG machine, in tiers A0/A1/A2 by failing-prefix length;
    maps get pair-major F, slot-based S or record-based T. A bounded group
    arena brings a new `group_limit` refusal; one unit per PEG step. The
    D011/D012 refusals are withdrawn; only left recursion stays refused.
    Evidence (scratch, `.cache/peg/`, not committed): 108 probes. Ruby
    0.12.14 agrees on 87; its 21 disagreements fall in seven classes
    (RL/RK/RI/RZ/RR/RO/RX, §20.4). 11 current corpus expectations flip
    (§20.11), and the D271 suite becomes mode-dependent. A syntactic tier
    census of the corpus: 799 A0, 25 A1, 0 A2 arrays; 61 F, 37 S, 26 T maps.
    Proposed decisions, to be numbered D272+ after the review: the §20.2
    semantics and §20.3 resolutions; the `cuts` option and its default; EC
    pick order; the tiered evaluation and the arena with `group_limit`;
    format 2.0; the PEG oracle replacing D022's existential oracle; the
    witness rules of §20.8. Open questions for the reviewer: §20.14 (16) and
    program-2 §13 (4).
  - **Revision 2 (2026-11-04, after the two independent reviews,
    docs/reviews/2026-11-04-peg-claude.md and -codex.md):** architecture §20
    and docs/program-2.md were rewritten. Every finding is dispositioned in
    §20.14: all accepted except Codex Q1, which the manager decided against
    (rule A). Manager decisions applied: rule A as `reference`; T sorts its
    own records; the arena is derived from limits and grown on demand; memo
    reserved; proven bounds only.
    Decisions D272–D279 recorded (unsigned). D277 needs P8.4's agreement to
    move §19.5's duplicate-check charge to the map's logical end.
    Probes now number 117: Ruby agrees on 88 and every one of the 29
    disagreements is classified (new class RC: 7 probes, App. H evidence).
    Corpus flips under rule A: 33 (11 structural, 22 rule A).
  - **Revision 3 (2026-11-04, after the focused re-review
    docs/reviews/2026-11-04-peg-rereview.md):** N1–N9 answered (architecture
    §20.14), with amendments to D273–D279 and new D280.
    * Summed activation bound (`ACT_SUM`) and a global item counter.
    * Per-block chunk lists, so interleaved suspended machines need no LIFO
      order.
    * Demand growth to a cap (16 MiB default) with stable-index session
      relocation. "Never refuses at defaults" is partly rebutted and
      replaced by W7.
    * T always sorts when not in EC order.
    * `FAIL` events with provenance.
    * D280 refusal replay, pending P8.4's agreement.
    * Gate wording qualified; proof obligations labelled.
  - **Merge plan for `p85-peg` (manager, 2026-11-10).** Phase 1 (compiler +
    verifier, format 2.0) is on local branch `p85-peg` (40af89c, befbbf8,
    dcc1d82; `bb compile2-test` green, 3,266 corpus verdicts equal the
    independent PEG oracle in both cut modes). Main switches to format 2.0
    only when compiler and VM land together:
    1. P8.4 (valid-CBOR default; session support D266, D277/D280 replay) lands
       on main first.
    2. `p85-peg` is rebased onto that main (expected conflicts: host option
       admission, Rust compile/api, DEVLOG text — compiler files are disjoint
       from P8.4's scanner/VM files).
    3. Phase 2 on the branch: the VM PEG machines (program-2 §5–§10: per-tier
       array/map machines, records and rings, chunked arena with growth and
       session relocation, T self-sort, FAIL events and witnesses, forced-tier
       mode, §10 charging order), D280 replay integration, `vm-scratch-words`
       from ARRWORDS/MAPWORDS, limits word 10 (`groupWords`) and
       `group_limit`; W7 tuned so it fires only when the compiled-limits bound
       actually exceeds the cap (phase 1 found it fires on every T map and
       recursive group — noise); the old `compile-test` and VM harnesses moved
       to format 2.0.
    4. Gates on the branch before merge: compile2-test, vm-test,
       vmsession-test, sequence-test, scan/rscan, nav, write, unicode,
       rust-api-test, size, npm, drift, the PEG oracle differential (new
       vm-level arm), the RFC corpus runner (D270-dependent cases flip to
       pass), and `bb wasm-sdk-test`.
    5. **Wasm dependency (P8.5w):** loading format 2.0 Programs in the wasm
       SDK needs `host/wasm/src/sdk.rs` to size the verifier scratch with
       `vm-verify-words` — an owner-gated wasm edit (with P7.13w/P8.4w); if
       not authorised by merge time, the SDK cannot load 2.0 Programs and
       `wasm-sdk-test` would go red, so the merge waits for that answer or
       the SDK is explicitly marked unsupported for 2.0 by an owner decision.
  - **Phase 2 done and merged (2026-11-11):** the VM runs format 2.0 on every
    route (D310–D321); merge steps 1–5 complete (P8.4 on main first; rebased
    onto `cfbdda3`; the wasm SDK edit authorised by D300 and made). See
    "P8.5 — PEG groups, phase 2" below. P8.5's other coverage items above
    (controls, `.abnf`) were not part of this phase; the box stays open.
- [ ] **P8.6 — Conformance corpus**: RFC 8949 Appendix A including the
  non-deterministic encodings, RFC 8610/9165/9682 examples, published
  protocol CDDL (COSE, CWT, CoSWID, EAT, SenML) as compile + validate cases.
- [ ] **P8.7 — Binary-size audit before release** (added 2026-11-11 on the
  coordinator's recommendation; made an **owner requirement** the same day,
  D303: "at the end we should do an audit to look for binary size reduction
  opportunities"). Before release, audit every entry point (JS bundles, Rust
  crate, wasm module and SDK) for ways to reduce size, attributing every
  candidate and measuring it with `bb size` (and the wasm/Rust equivalents).
  Candidates so far:
  - Load the Program verifier only for Programs that were not compiled
    locally. A Program from `compile` in the same process is trusted; a
    loaded one is not. This is the largest D319 item, `program/verify`
    +7.3 KB min. D319 rejected loading it lazily because a synchronous load
    cannot await an import; the pass looks for a design that keeps the
    synchronous API.
  - Re-check the forced-tier support. D319 found it shares its code path
    with T and A2.
  - Re-check D285's rejected cuts in light of P8.5.
  - Look at the reference-map-choice gap: it is still about 1.34× slower
    than before PEG. Consider the parked discriminator-first dispatch.
  - Review the full `snug/compile` entry first: about 97 KB gzip after
    D333. It loads lazily, but it is the largest single target for the
    audit (coordinator, 2026-11-11).
  Lowered caps follow the measurement. Any cap raise still follows D303.

## Phase 9 — Release candidate (checklist, 2026-11-11)

The coordinator asked for this phase on 2026-11-11. This checklist is what
it takes to reach a release candidate (RC). Reaching the RC does not
release anything: nothing is published, pushed or tagged for a registry,
and the release itself is the owner's decision. An item is ticked only
when its gate has actually run on main and the result is recorded here.
The order follows dependencies: correctness first, then the long runs on
the final code, then documentation, then the size audit, then the final
review.

**Correctness and coverage**
- [x] **P9.1 — Gate watchdog.** Every gate script under `kin/scripts/` and
  `tools/` gets a CPU-time cap and a wall-clock cap, with sensible defaults
  per gate that can be overridden. A gate that hits a cap fails loudly,
  naming the gate, its arguments and the cap; it never hangs silently.
  Background: the 6.5-day `scan-test 300 1` (dec5975).
  *Done 2026-11-11 (D326):* `kin/scripts/watchdog.mjs`, with every sh, node
  and bb gate under it. Gates run on the final tree (on `0d52521`, plus
  `cf7093a`'s DEVLOG):
  * `bb watchdog-test` 7/7: the CPU cap, the wall cap, the group kill and
    pass-through, plus a real `scan-test 300 1` and `size` tripping.
  * `vm-test`: all ok, including PEG oracle 8600/8600, JS == Rust 80,545 and
    JS == wasm 78,251.
  * `vmsession-test 2000 1 100 60`: 304,747 runs. `sequence-test 300 1`:
    441,806 runs. `wasm-sdk-test` 15/15.
  * `compile-test`, `scan-test`, `rscan-test`, `valid-test`, `nav-test`,
    `write-test`, `unicode-test`, `rust-api-test`, `npm test` 1450/1450,
    `compile-fuzz`, the RFC runner, `size`, `proptest` (2 min, P1–P5, no
    failure), `check` and `drift`: all ok.
  * Interrupting a running gate's watchdog with SIGTERM left no process of
    its group behind.
- [x] **P9.2 — RFC corpus all passing or classified.** Regenerate
  `corpus/conformance/rfc/current-results.json` (it predates P8.4). Then
  work through each remaining failure (27 at `920a3e1`), fixing it or
  classifying it with a written reason (outside scope, an RFC erratum, a
  documented deviation with its D-entry). Done when there are no
  unexplained failures.
  *Done 2026-11-11 (D328, D329, D330; size D333):*
  - The runner now gives 999 checks: 984 pass, 15 classified, 0
    unexplained and 0 stale. `--gate` fails on an unexplained or stale
    check.
  - `current-results.json` is regenerated.
  - The classified checks:
    - NaN payloads under `deterministic`: D122, quoting §4.2.2.
    - default-timer: contested, on S46.
    - The 9 RFC 9165 figure 3–5 checks: pending P9.14.
    - The 3 "RFC 9682 simple head numbers" checks: pending P9.3, which
      removes that classification.
  - Fixed:
    - float widths by value (D328, a visible change);
    - exact numeric controls across int and float (D329);
    - `.cat`/`.det` of text with bytes (D330).

  Quotations were checked against `corpus/rfc`. The default `valid`
  preset accepts `f97e01` and `faffc00001` (the rfc8949-additional
  vectors).

  Gates on the final tree (`54a6468`; after the rebase onto `dd54b6d`:
  drift, `size` and `rust-api-test` again):
  - `vm-test`: conformance 1459/1459, PEG oracle 8704/8704, JS == Rust
    80,701, JS == wasm 78,407.
  - `vmsession-test 2000 1 100 60`: 306,479 runs.
  - `sequence-test 300 1`: 444,110 runs, and the Rust host 21,636/21,636.
    That needed a fix to the Rust host check: under a valid-CBOR profile a
    message's view is its canonical copy (D262).
  - `wasm-sdk-test` 15/15 and `npm test` 1450/1450.
  - `compile-test`, `valid-test`, `scan-test`, `rscan-test`, `nav-test`,
    `write-test`, `unicode-test`, `compile-fuzz`, the RFC runner, the PEG
    oracle tests, `watchdog-test`, `check` and `drift`: all ok.
  - `proptest`, 2 min, P1–P5: 73,353 cases, no failure.
  - `size`: ok with D333's caps.
- [x] **P9.3 — RFC 9682 head numbers.** Parse the `#7.<type>` syntax, and
  match `#7.24`–`#7.31` as RFC 9682 §3.2 reads them, so the "RFC 9682
  simple head numbers" suite compiles and passes.
  *Done 2026-11-12 (D336):*
  - `#7.<T>` parses.
  - `#7.24` is the simple values 32..255, `#7.25`–`#7.27` are the float
    widths by value, and `#7.28`–`#7.31` match nothing.
  - SIMPLE leaves are ranges.
  - The suite passes, and its P9.3 classification is removed. The RFC
    runner gives 999 checks: 987 pass, 12 classified, 0 unexplained and 0
    stale.
  - The new `corpus/conformance/heads.json` has 57 cases and 2 refusal
    suites, all agreeing with the PEG oracle.
  - Ruby and crate differences are recorded in D336.

  Gates on `07ad4d7`, all ok:
  - `vm-test`: conformance 1516/1516, PEG oracle 8818/8818, JS == Rust
    80,872, JS == wasm 78,578.
  - `vmsession-test 2000 1 100 60`: 307,751 runs.
  - `sequence-test 300 1`: 447,786 runs, and the Rust host 21,809/21,809.
  - `wasm-sdk-test` 15/15 and `npm test` 1450/1450.
  - `compile-test`, `valid-test`, `scan-test`, `rscan-test`, `nav-test`,
    `write-test`, `unicode-test`, `rust-api-test`, `compile-fuzz`, the RFC
    runner, the PEG oracle tests, `watchdog-test`, `check` and `drift`.
  - `proptest`, 2 min, P1–P5: 108,530 cases, no failure.
  - `size`: ok after the compile full min cap raise (D336).
- [x] **P9.4 — PEG open problem 1.** A recursive Program's session should
  not reserve the whole-message arena bound when a message starts.
  *Done 2026-11-12 (D337):* a recursive Program's session arena now grows
  to §9.4's bound for the bytes read so far. Every arena gate takes the
  furthest offset its work reads, and growth requests are capped at the
  whole message's bound.
  - The differential against D314's code covers every recursive-Program
    vm-test case plus deep generated messages, under 6 window policies
    including unknown length: 1050 runs, 0 differences in the whole out
    array.
  - Peak S summed over those runs went from 789,139,954 words to
    12,814,776. It was never larger.
  - With an unknown length, S after the first step went from 4,194,456
    words to 4,248.
  - A new `vmsession-test` check is "recursive arena growth (D337)".

  Gates on `58f0475` (the same tree as main plus this DEVLOG text), all
  ok:
  - `vm-test`: as P9.3's.
  - `vmsession-test 2000 1 100 60`: 307,751 runs, plus the D337 check.
  - `sequence-test 300 1`: 447,786 runs, and the Rust host 21,809/21,809.
  - `wasm-sdk-test` 15/15 and `npm test` 1450/1450.
  - `rust-api-test`, `compile-test`, `valid-test`, `scan-test`,
    `rscan-test`, `nav-test`, `write-test`, `unicode-test`,
    `compile-fuzz`, the RFC runner, the PEG oracle tests, `watchdog-test`,
    `check` and `drift`.
  - `proptest`, 2 min, P1–P5: 105,201 cases, no failure.
  - `size`: ok after the sources min cap raise (D337).
- [x] **P9.5 — Independent RFC framer in the sequence gate.** An RFC 8742
  framer written independently of snug's own sequence code, used as the
  oracle in `sequence-test`.
  - **Framer:** `corpus/tools/rfc8742-framer.mjs`, from RFC 8949 Appendix C
    and Appendix F alone. It imports nothing from snug. It frames items, stops
    at too little data (`truncated`, with the innermost cut head) or at a
    syntax error (`malformed` + why: reserved ai, `f8` < 0x20, ai 31 on major
    type 0/1/6, bad chunk, misplaced break, break as a map value), and can
    report byte-string spans and the items open at a stop. One deliberate
    departure from Appendix C's order: a bad chunk is refused at its initial
    byte, because adding data cannot repair it (Appendix F's kind 3). Unit
    vectors (`rfc8742-framer.test.mjs`, run first by `bb sequence-test`):
    Appendix A one by one, concatenated and cut at every byte; all 94 F.1
    examples with their kind; the RFC 8742 and §5.3.1 vectors; indefinite
    lengths, nested tags, break misuse with offsets; nesting 10^6 deep.
  - **Mapping** (`kin/scripts/sequence-framer.mjs`, every oracle answer the
    gate uses): accepted and skipped messages are the framer's items byte for
    byte, and a clean end is the framer's end. A stop maps by reason class:
    - `truncated`: the same head, or an enclosing item. snug names the
      outermost item whose claim runs past the input; the framer names the
      innermost cut head.
    - `malformed`: the same head.
    - `too_large`: the item is longer than P, or cut short or malformed only
      past P.
    - An open claim outranks a later syntax error (§18.1). For example,
      `98 b6 ... 5f 7f`: an array claiming 182 items in 100 bytes is
      `truncated` at 0, before its bad chunk at 58.
    - Embedded payloads: a refusal inside a byte string the framer reads as
      opaque.
    - Every other code (validity, determinism, limits, schema, budget) must lie
      within P and no later than where the framer stops. Schema stops need a
      complete item, `indefinite` an ai-31 head, `not_map` the root.

    Nothing is skipped silently; each class is counted. Items the framer reads
    past a stop are counted, not compared, because a sequence ends at its first
    refusal (D214).
  - **Found by the framer (fixed here, gate tooling only):** the gate's D211
    oracle took a root's end from `snug.nav.walk`, which walks definite-length
    items only. As a result, under `valid` an indefinite root followed by more
    bytes read as `trailing`. Repro: RFC 8742 §4.2's `01 9fff 1817`. The kin
    session (JS and Rust), the hosts and the framer all find a boundary there.
    `oracleSequence` now asks the framer when `navSkip` cannot walk the root.
    The Rust host runner's view check compared `raw()` with the message length,
    but a non-deterministic message's View reads its canonical copy (§19.3).
    P9.2 fixed the same check independently (`0df5d39`, a `Document`'s view);
    P9.5 takes main's version. The case set
    never held this combination. Valid-wire groups now get indefinite-root
    fillers. The RFC 8742 and F.1 vectors run as sequences under the bindle,
    deterministic and valid presets, with expected outcomes (F.1 under
    `valid`: exactly `truncated`/`malformed`, except `bf01020102` and
    `bf000000ff`, whose repeated key comes first: `duplicate_key`). That
    precedence rule (the first refusal in stream order decides, whatever its
    class) is now stated in scanner.md ("Precedence across classes"),
    profiles.md and the RFC corpus README, with these two examples. No snug
    core bug. `navSkip`'s -1 on indefinite items is its contract: architecture
    §16.4 now says so plainly.
  - **Gate on the landed code (a82cab0, on main's 2c3c8f1 after P9.3 and
    P9.4; main differs from it only in this DEVLOG entry):** `bb
    sequence-test` with defaults under the P9.1 watchdog, exit 0 in 534 s
    (the same counts on 871ad08, on P9.3 alone, in 815 s). Framer unit vectors
    9/9; framer == oracle on 176,869/176,869 oracle answers. Classes:
    - accepted 3,150,171; skipped 41,111; clean ends 49,423;
    - `truncated`: same head 13,571; enclosing claim 5,188; claim before a
      syntax error 258; embedded 96;
    - `malformed`: same head 3,509 (reserved ai 3,329, bad simple 124, chunk
      24, break 22, ai 31 on 0/1/6 7, break as value 3);
    - `too_large`: 12,781 (longer than P 10,604, cut short 1,671, malformed
      past P 434, claim past P before a syntax error 64, embedded 8);
    - other refusals: 92,043 in 94 code × position classes.

    RFC vector sequences 294/294 as expected. kin == oracle 745,589/745,589;
    JS == Rust 184,870/184,870, 0 panics; JS hosts and Rust `Sequence` ==
    oracle on 36,345 host runs; check and drift exit 0 on the same tree. The
    full set ran before P9.3 landed, on b65f5a3 (on 74b903f), all exit 0:
    sequence-test (176,093/176,093 framer agreements), check, drift,
    scan-test, rscan-test, vm-test, vmsession-test, valid-test, compile-test,
    nav-test, write-test, unicode-test, rust-api-test, wasm-sdk-test, size
    (unchanged), and `npm test` in host/js. P9.3 (compiler, VM leaf,
    vm-allcases) and P9.4 (session arena) touch what feeds sequence-test,
    which is why it was re-run after each. **Timing:** the framer comparison
    takes 8.5 s of a 523 s run, plus about 1 s of unit vectors (about 1.8%);
    12.7 s of 801 s on 871ad08. Under heavier load:
    23.8 s of 2,677 s and 25.0 s of 2,361 s. Main before P9.5 ran 1,754 s under
    load, and run-to-run load noise is larger than the framer's cost.
- [x] **P9.6 — Rust async source driver.** The async counterpart to the JS
  stream sources (D027), over the existing session, with the same gates as
  the sync Rust driver.
  *Done 2026-11-11 (merged to main at `ac24e08`).* **Gate on main:** `bb
  rust-api-test` on `ac24e08` (a detached worktree of main): exit 0 in 608 s;
  every Cargo test, doctest and guide/README example passed (`async_sources`
  7/7: the same counts as below, blob 89 s, reader 146 s, sequences 564 s);
  Clippy clean with the generated-code allowance.
  *Built (2026-11-11, branch `p96-async`; D331):* `host/rust/src/async_source.rs`
  -- `AsyncSource` (futures-io's `poll_read` shape), `AsyncBlob` (`read ->
  impl Future`), `Schema::validate_blob_async`, `validate_reader_async`
  (drain / fail-fast), `read_sequence_async` + `AsyncSequenceReader`
  (`next().await`, `poll_next`, cancel-safe), low-level
  `async_source::validate_blob` / `validate_reader`. No dependency, no
  feature, THIRD_PARTY_NOTICES unchanged, no kin/gen/JS change (bundles
  unchanged). Docs: docs/rust.md "Async sources" (doctested, with futures-io
  and tokio adapter sketches), docs/api.md Sources (Rust counterparts),
  host/rust/README.md. The differential found a SYNC driver bug, fixed in both
  (D331): `schema::validate_reader` with a positive quantum called `vms-eof`
  twice after the end resumed the walk and panicked.
  **Gate** (in `bb rust-api-test`): `tests/async_sources.rs` with
  `tests/async-cases.mjs`, which exports a seeded slice of vmsession-test's
  case set (vm-test's cases, the session stress set, extension controls;
  defaults 1500 / 1 / 40 / 30, `SNUG_ASYNC_CASES` to change). Every verdict
  (code, reason, subcode, offset, path, budget) compared whole, with reads
  that answer `Pending` at random, `Interrupted` retried, and quanta that
  yield. Run on this tree (actual, 2026-11-11, Node v24.6.0, rustc 1.92, debug):
  **20,492 cases on 1,016 Programs**; blob **188,412 runs async == sync ==
  buffer** (chunks 1/2/7/random/whole by size × quantum 0 and 1–3 / 1–64 /
  1024–5119), 65,744 that yielded; reader **61,424 drain runs async == sync ==
  buffer + 61,424 fail-fast runs async == sync** (accept iff the buffer,
  equal out when it accepts) under 1-byte, random 1..7 / 1..300 / 1..4096 and
  whole reads, 53,920 that yielded; sequences **10,164 bodies, 60,984 runs,
  35,329,590 items async == sync** (schema and profile-only, the three
  presets, Stop/Skip, fail-fast, read chunks 1/5/64/65536); ~19.6 M `Pending`
  polls in all. Plus: argument and source errors identical to the sync forms
  (`options`, `unknown_rule`, `short_read`, `too_large`, `read`); a 200 KB
  byte string streamed; fail-fast stops reading early; a sequence holds one
  message; validation futures dropped at every await point; `next()`
  dropped while Pending loses no message; the futures are `Send`. A mutant
  (one byte misplaced in the async reader's buffer) turns it red in 6 s.
  **All gates on this tree** (the branch at `6f791f6`, on main `5a1bb84`;
  rebasing onto `0b302fc` changed only DEVLOG; watchdog on): check, drift,
  scan-test, rscan-test, vm-test, vmsession-test (session == buffer
  1,059,298; drain 523,615; JS == Rust unknown length 109,950; hosts
  10,140), sequence-test, valid-test (cbor2 differential SKIP: not
  installed), compile-test, nav-test, write-test, unicode-test,
  rust-api-test (all Cargo tests, doctests incl. the new ones, Clippy clean
  with the generated-code allowance; no diagnostics in the new files),
  wasm-sdk-test 15/15, size (budgets passed; esbuild through a temporary
  symlink to the main checkout's bench/compare/node_modules), npm test
  1,450/1,450.
  **Learnt:** (1) a differential against the sync driver needs the sync
  driver's own corners exercised -- a positive quantum on the unknown-length
  path had never run in Rust (the public form passes 0), and it panicked; (2)
  a `Pending` that consumed nothing keeps the read sizes identical, so one
  split sequence drives both sides; (3) RPITIT (`read -> impl Future`) lets
  implementors write `async fn` and keeps `Send` inferred for concrete types.
  **Open:** the async test costs ~11–19 min of rust-api-test wall time
  (three parallel tests; 19 min on a loaded machine, within the
  watchdog's 2,400 s) -- the sequence half dominates (the sync reader's
  per-message cost in debug); no `Stream` / futures-io impls (newtype
  adapters documented); a dropped validation future leaves its source at an
  unspecified position.
- [ ] **P9.7 — Arena pooling and a live-session bound.** Hosts pool session
  arenas and enforce a documented, configurable bound on live sessions.
  This item was left open in P6.

**Long runs on the final code**
- [ ] **P9.8 — crate-diff re-run** against the rebuilt cddl crate oracle
  (`corpus/tools/ORACLES.md`). Every difference is explained.
- [ ] **P9.9 — Full-length proptest and vmsession-test runs**, split into
  chunks that fit under the P9.1 caps, with the seeds and chunking
  recorded so anyone can reproduce them. Includes `rust-api-test` in its
  `full` mode (the P9.6 async differential at full scale; see P9.6a), which
  also runs again before the RC is declared.
- [ ] **P9.6a — Split `rust-api-test` into two modes** (coordinator,
  2026-11-11). The default mode takes a few minutes and is for routine
  gating. A `full` mode runs the async differential at the scale it ran at
  when P9.6 landed. Assigned to the P9.6 engineer.
- [ ] **P9.6b — One shared sans-IO core for the sync and async Rust
  drivers** (coordinator, 2026-11-11), D335. It starts after P9.7 lands and
  must be done before P9.13, so the final review sees the deduplicated
  code. The full differential (async == sync == buffer) stays as the
  reference. Assigned to the P9.6 engineer.
- [ ] **P9.14 — `.abnf` / `.abnfb` (RFC 9165 §3).** Added 2026-11-11 by
  the coordinator. The owner direction D230 names these controls explicitly,
  so leaving them out is not an option. Requirements:
  - a bounded, metered ABNF engine covering RFC 5234 plus RFC 7405's
    case-sensitive strings, which RFC 9165 references;
  - an optional module that loads separately, like the unicode tables, so
    the core bundles do not grow;
  - `prose-val` refused with a clear error;
  - an oracle-checked gate.
  It needs its own engineer, after P9.1–P9.4 or sooner if a slot opens
  within the four-engineer cap. Until it lands, the 8 RFC 9165 figure 3–5
  corpus cases are marked "pending P9.14", not "outside scope".

**Documentation and API**
- [ ] **P9.10 — Stranger-pass re-review of docs and API.** Independent
  reviewers who have not seen the code use the README, docs/ and the
  public APIs (JS, Rust, wasm SDK). Every finding is addressed or
  explicitly deferred. This includes making the D301 idiom for
  discriminated unions prominent.
- [ ] **P9.11 — Release and version policy.** A written policy covering
  versioning (semver and what counts as breaking, including the Program
  format, error codes and the budget-unit prices), the supported runtimes,
  the changelog, and how a release is cut. Writing this policy publishes
  nothing.

**Last**
- [ ] **P9.12 — P8.7 binary-size audit** (owner requirement, D303), done
  after the code above is settled.
- [ ] **P9.13 — Final independent whole-library review** of the code,
  spec, docs and gates by a reviewer who did not build it. Blocking
  findings are fixed before the RC is declared.
- [ ] **RC declared** (manager, recorded with the main commit). The release
  itself is the owner's decision.

**Assignment (2026-11-11):** P9.1–P9.4 go to the P8.5 VM engineer, in that
order. P9.5 onward are scheduled as the earlier items land.
*Update:* P9.5 and P9.6 went to new engineers and P9.7 to the D286
engineer, in parallel (coordinator: at most 3–4 engineers live). P9.14 is
next when a slot frees.
*P9.2 triage, agreed with the coordinator 2026-11-11:*
- NaN payloads under `deterministic` are classified under D122.
- Float widths are fixed to match by value: float16 accepts values exactly
  representable in binary16, float32 the same for binary32, and float64
  accepts any float. This is a visible change, documented prominently in
  the guide and in profiles.md / cddl-support.
- Numeric controls on `number` are fixed by distributing them over the
  numeric branches; default-timer #1 stays classified on S46.
- `.cat` of text and bytes is fixed.
- `.abnf` / `.abnfb` go to P9.14.

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


## P8.6 — RFC corpus (2026-11-04, requested offline slice delivered)

- **Artifacts:** corpus/conformance/rfc/ (README, exact extracts, inventory,
  compile/reference observations and current-results.json),
  corpus/cbor-vectors/rfc8949-appendix-a.json, and new tools
  corpus/tools/{export-rfc,run-rfc-corpus,rfc-fixtures}.mjs. No existing corpus
  file or implementation source was edited by this item. The Phase 8 master
  checkbox is left unchanged; RFCs for full CoSWID/EAT/SenML were not supplied.
- **Counts:** RFC 8949: 81 Appendix A + 94 Appendix F.1 + 12 additional
  wire vectors; RFC 8746: all 5 annotated CBOR figures; RFC 8742: 4 sequence
  vectors. CDDL suites/cases: RFC 8610 68/286, 9165 9/20, 9682 5/11,
  8392 1/16, 9052 25/68: **108 suites / 401 cases**. Published data includes
  all 9 CWT hex blocks and 17 COSE EDN examples (included in case counts).
- **Compile findings:** 42 extracted-text refusals, 12 after labelled context;
  three of those 12 are deliberately undefined/illustrative excerpts, nine
  are models with data expectations. No compile refusal is a schemaError
  expectation. Mixed numeric controls, verbose Appendix H repetition,
  RFC 9165 controls and simple-head grammar expose P8.2/P8.5 work.
- **Current JS findings:** full run **999 checks: 913 pass / 86 fail**. Exact
  dependsOn groups, pass/fail: baseline **731/29**, P8.4 **179/45**,
  D270 **3/11**, D271 **0/1**. Includes 25 cases with no snug data verdict
  because effective compilation failed. wire:'valid' was unavailable, so
  its group measures the explicitly labelled current default fallback.
  Both explicit strict selectors were exercised; runtime fingerprints were
  identical before/after the run. This is a working-tree observation, not
  certification or JS/Rust/wasm parity.
- **Ruby:** supplied cddl 0.12.14 wrapper attempted every case: 320 data
  verdicts, **7 disagreements**, **81 reference errors**, zero not-run.
  Disagreements (all RFC 8610): cut-free wildcard fallback; synthetic
  bignum-tag matching of an untagged integer; annotation-only .default;
  three representable-float-width cases; D271 global cut. Explanations
  accompany each case. Errors: 79 exact-prelude cases conflict with Ruby's
  builtin regexp-restricted tdate; one escaped-hex ArgumentError; one
  #7.24 RuntimeError. Errors were not counted as invalid data.
- **Learnt:** RFC 8392 contains no CDDL; its claims schema must be labelled
  derived from prose (including audience arrays despite the summary table).
  Core deterministic CBOR does not impose unique-NaN/decimal normalization.
  RFC 9052's literal Sig_structure has a greedy optional-bstr/prose conflict;
  RFC 8610 Appendix H prints ratings not representable in its float16 type.
  The original bytes/definitions and resulting expectations are retained.
  All displayed rule-like lines are inventoried, with ABNF/pseudocode
  exclusions rather than passing them off as CDDL.
- **Checks actually run:** exporter with reference checks; regeneration with
  identical completed reference evidence reused; full runner/JSON report;
  D271-only --gate (exit 1, expected finding); Node syntax checks; eight RFC
  SHA-256 matches; 81 A rows / 94 unique F examples / no residual page
  furniture. Node v24.6.0, Ruby cddl 0.12.14 / Ruby 2.6. No product edits,
  emission, implementation gates, performance measurements, installs,
  network, remotes, pushes or commits. Concurrent DEVLOG edits preserved
  by appending this item only.

### D282 — RFC corpus expectations and observations stay separate (P8.6; renumbered from a duplicate D280 on 2026-11-10)
**Decision** (contributor, provisional): preserve exact RFC excerpts and
page-furniture fixes, label added contexts/derived schemas, and retain
RFC-derived PEG expectations independently of snug or Ruby. Compilation
errors and reference exceptions are findings, never expected refusals.
Core deterministic and additional application restrictions are separate;
D271 uses staged literal-RFC witnesses without changing the interim engine.
**Why:** a corpus that learns expectations from the implementation or treats
reference errors as invalid data cannot expose conformance gaps.
**Alternatives:** normalize published examples to the current profile,
replace refused schemas, or adopt Ruby verdicts as truth; rejected because
these conceal the byte, coverage and semantic differences being tested.
- [ ] **Signed off** (owner)


## P8.5 — Independent PEG reference oracle (2026-11-04)

Delivered `corpus/tools/peg-oracle.mjs`, `peg-oracle.test.mjs` and
`peg-oracle.README.md`. This is an independent semantic interpreter for
D270 / architecture §20 revision 3.1, with a fresh RFC 9682 parser,
Appendix D prelude, direct PEG array/map evaluation, both D273 cut modes,
EC key order, guarded group recursion, unwrap (including tag content),
sockets, inherited controls and a permissive generic CBOR decoder behind
baseline decoding with `top: 'any'`. No prototype, existing oracle logic,
kin/generated matcher or JS host source was read/imported. No production
implementation, corpus expectation, design text or decision was changed.

Checks actually run:

* 117 documented probes (the table is §20.15, while §20.13 lists migration)
  agree in both modes: 234/234 verdicts, zero design-probe discrepancies.
* All 910 non-schema-error adversarial cases checked: exactly the 33
  documented true-to-false flips (11 structural, 22 rule A), no others.
* Final local `node --test --test-skip-pattern='Ruby differential'
  --test-reporter=tap corpus/tools/peg-oracle.test.mjs`: 470 passed, zero
  failed. Includes 103 individually named migration cases and 126 focused
  semantic/wire regressions, plus EC/decoder/compile/budget checks.
* Completed full test command with the supplied offline Ruby wrapper:
  467/467 passed before four final regression additions; those additions
  passed in the final local run. The same seeded 300-pair Ruby sample
  completed with rc 0/1 for 285 pairs: 116 agreements, 169 classified
  disagreements; 15 further attempts were rc-65 parse errors (RX), never
  refusals. Counts: RC 14, RL 42, RK 30, RI 15, RZ 30, RR 27, RO 11,
  RX 15, new 0, unknown 0, timeout 0. Seed `0x86109165`, 20 stratified
  families; rates are not estimates of arbitrary-schema agreement.
* Syntax checks for both modules and path-scoped whitespace diff check ran.
  No installs, network access, emission, publishing or commits were done.

Learnt: direct immutable remaining-pair state makes failed-iteration undo
and per-attempt cut commitment straightforward to audit. A broader corpus
check caught spaced-occurrence parsing, subnormal hex-float rounding and
bignum numeric comparison gaps; these were corrected from the RFC/semantic
rules and regression-tested. A preliminary four-second Ruby timeout was
inconclusive; rerunning with a 60-second invocation allowance completed
without timeouts. README findings F1–F6 distinguish zero probe mismatches
from the RFC/design tensions: union versus lock-in, existential versus EC
picks, cut scope/occurrence expansion, empty iteration, inherited encoded
float widths versus representability, and inherited no-op `.default`
versus the RFC's implied `.ne`. JS regexp matching is explicitly an
approximation; non-enumerable controllers and bounds can return unknown.
This oracle does not certify production tiers, resources or witnesses.
No new semantic decision or owner sign-off is asserted.

## P8.5 — PEG groups, phase 1: compiler and verifier, format 2.0 (2026-11-04, branch `p85-peg`)

Implements architecture §20 rev 3.1 / program-2 rev 3.1 on the compiler side
(D270–D281; decisions D290–D299). The VM is unchanged: the branch writes and
verifies only format 2.0 Programs, so the VM-running gates (vm-test,
vmsession-test, sequence-test, rust-api-test, proptest, wasm-sdk-test) and
compile-test's format 1 expectations are red on it until phase 2.

* **Compiler** (`kin/compile/peg.kin`, new; `lower.kin`, `emit.kin`,
  `main.kin`; `maps.kin` and `arrays.kin` removed): PEG builder lowering,
  CALLs to open expansions, the fold table with FAIL provenance, `0*0` →
  EMPTY, minima saturation, ml / FL / B, depth, n_calls, nullable / first /
  last least fixed points and relaxed follow rows, left-recursion refusal,
  map classes / F-S-T tiers / key_ts / slots / records, A0-A1-A2, hash-consed
  programs, header words 19 / 29 / 41 / 62 / 63, FLAGS bits 5-6, ACT_SUM /
  RECLEAF_MAX / R_ITEM_MAX, W1–W7, options `cuts` / `groupWords`, SOURCE_KEY
  version 2. Withdrawn refusals gone (map_overlap, map_group_occurrence,
  map_cut incl. D125's, counters/unrolling, non-tail group recursion).
* **Verifier** (`kin/program/verify.kin`): format 2.0 only (1.x refused,
  check C_VERSION); PEG records, map and array tables, every derived field
  recomputed (incl. the relaxed automata), left recursion (C_RECURSION),
  `vm-verify-words`.
* **Hosts**: JS / Rust compile options and warnings, the wasm compiler's
  option words (`cc.rs`, `wasm-sdk/src/compile.mjs`: registry moved to word
  22, `cuts`, `groupWords`); verifier scratch sized by `vm-verify-words` in
  the JS and Rust Programs; serialisation loaders accept major 2 only. The
  wasm SDK's `sdk.rs` (owner-gated, see the open items) is untouched: its
  verifier scratch is still format 1's size, a phase 2 item.
* **Gates**: `bb compile2-test` (new; `kin/scripts/compile2-test.mjs`, Rust
  `compile2-test` bin, test-only reference interpreter
  `kin/scripts/peg2-ref.mjs`).

Checks actually run (on the branch, macOS, node 24.6, cargo debug):

* `bb compile2-test`: all ok — 308/308 corpus schemas compile (both cut
  modes, both hosts); 26/26 suites that expected a withdrawn refusal now
  compile; 5/5 remaining expected refusals; RFC corpus 68/108 compile (2
  newly: indeterminate-map, reputon-verbose; 40 refused exactly as observed
  before; no withdrawn refusal left); 164/164 §20.15 probe schemas compile;
  10/10 remaining refusals; 12/12 formerly refused schemas compile; 976/976
  JS == Rust comparisons (Programs, pools, warnings) identical; 916/916
  compiled Programs verified (JS and Rust); 8796 seeded corruptions refused, 1215
  format 1.0 / 1.1 / 2.1 Programs refused with C_VERSION, 9720 random
  corruptions with no crash and identical verdicts; 165/165 SOURCE_KEYs;
  341/341 arena-size independent; 234/234 §20.15 probe verdicts and 52/52
  targeted lowering cases (26 schemas, both modes, against the oracle)
  reproduced by the compiled Programs; 3266/3266
  corpus verdicts equal the independent oracle's (both modes; 96 undecided:
  regexps, extension controls, oracle unknowns).
* `bb compile-fuzz` (3000, default seed) and 12000 texts each at seeds 7,
  99, 2026, 31337: ok (only SchemaError, no panic, JS == Rust, vm-verify
  accepts). The larger seeds found two compiler bugs, fixed: an empty
  non-literal key typeset left key_ts at -1, and a group rule simplifying to
  its own CALL was an internal error instead of `group_recursion`.
* Full Rust crate (`kin/scripts/rust-crate`, lib + bins, `-D warnings`) and
  the wasm `cc` / `sdk` modules build.
* Mutation: 6 targeted mutants — cuts dropped, REP loop edges dropped, F tier
  ignoring order sensitivity: red at once; the fold's FAIL dropped and an
  off-by-one minimum saturation first SURVIVED (no corpus data exercised
  them), so targeted semantic cases and verification of the gate-9 Programs
  were added; both are now red.

**Tier census** (compiled Programs, live leaves after canonicalisation, the
design's file set: adversarial, study, rfc*.json; 336 distinct schemas):
arrays 130 A0 / 25 A1 / 0 A2 (+1 recursive, A2); maps 63 F / 41 S / 24 T.
On the 332 schemas the design's script (`.cache/peg/tiers.mjs`) parses:
128 A0 / 25 A1 / 0 A2 (+1) and 59 F / 41 S / 24 T against its 799 / 25 / 0
(+1) and 61 / 37 / 26. A1, A2 and recursion agree exactly. A0: the script
counts syntactic nodes, duplicates across rules and nodes that are not arrays
(e.g. `{ 1*2 (2*2 tstr => uint) }` adds 2 A0), 663 in all; compiled leaves
are deduplicated. Maps, per schema: two single non-literal members with max 1
(`{int => int, int => 6}`) are order-sensitive by program-2 §3.3 (T, the
script said F); `{a: int, $$x}`'s root has a FAIL (S, not F); 4 schemas
whose only non-literal member is `0*0` (EMPTY once lowered) are S, not T;
`reputon-verbose` folds `? conf-value` to MEMBER(0, 1) and is F (the design
text predicts "the published T cases are F once normalised"); generic
instantiations count once per instance.

**Warnings over the corpus** (reference mode): W2 1, W5 1, W6 19, W7 26.
Finding: W7 fires on every T map and recursive group at default limits —
any R_ITEM_MAX >= 3 times 1,500,000 input bytes exceeds the 4 Mi-word cap —
so it is a worst-case notice, not a signal of an unusual schema (D281/§20.6
may want the bound per document size or the warning reworded).
Finding: byte-string and float literal keys are non-literal members, so
`{h'01': int}` is order-sensitive and T; a one-value key typeset could be
treated as literal-like (a phase 2 / design question).
Finding: DEVLOG has two D280 entries (P8.5 refusal replay, P8.6 corpus).

Learnt: semantic agreement with the oracle is the gate that catches lowering
mistakes; structure, verification and JS/Rust identity cannot. Programs
whose CALL target collapses into the CALL, empty key typesets and corrupted
section words near 2^31 (an `i32` add overflow in `vm-verify-words`, fixed
with wrapping adds) were found only by fuzzing and random corruption.

Phase 2 (VM) needs: program-2 §5–§10 in the VM (machines per tier, records,
rings, the arena with chunk heap and growth, map F/S/T with the T sort,
witnesses incl. FAIL events and provenance, forced-tier mode), the charging
order of §10, D280's replay (P8.4), `vm-scratch-words` with ARRWORDS /
MAPWORDS (the compiler's cset frame words already use them), the limits word
10 arena limit, `group_limit` (code 44), the wasm SDK's warnings and its
`sdk_prog_load` verifier scratch (`vm-verify-words`; owner authorisation for
`sdk.rs`), and the `cc.rs` / `wasm-sdk/src/compile.mjs` option-word edits made
here (same category as f23aea0's, flagged for the owner). The
reference interpreter (`peg2-ref.mjs`) is the semantic baseline the VM's
verdicts can be compared with.

## P8.5 — D301: the literal RFC cut is the default; rule A is `cuts: 'branch'` (2026-11-10, branch `p85-peg`)

Implements owner decision D301 (recorded on main, 1538677) on the format 2.0
compiler. D271's interim default and D273's naming question are superseded
(amendments on D271, D273, D298, D299 above).

* **Rename, no alias.** `reference` → `branch` everywhere it names the
  option: JS `cuts: 'rfc' | 'branch'` (types, options validation; anything
  else, `'reference'` included, is a TypeError), Rust `Cuts::{Rfc, Branch}`,
  wasm `cc.rs` / `wasm-sdk/src/compile.mjs`, the oracle (`check` throws on an
  unknown mode), `peg2-ref.mjs` (also refuses a mode that disagrees with the
  Program's FLAGS bit 5), compile2-test, architecture §20, program-2.
  Historical review records keep their names; §20 has a dated note.
* **Default.** `rfc` on every host. The encodings were swapped so the zero
  value is the default: kin option word 20 and the SOURCE_KEY `cuts` element
  are 0 `rfc` / 1 `branch` (-1 or absent = `rfc`); FLAGS bit 5 is
  `CUTS_BRANCH` (was `CUTS_RFC`). The effective mode is always in the
  preimage; compile2-test checks that no option gives the `rfc` Program
  byte for byte, and that `'reference'` is refused.
* **W8** (kin/compile/peg.kin `warn-cut-unions`; "choice alternative starts
  with the same cut key as an earlier one ... (see the guide, Discriminated
  unions under the RFC cut)"): only under `rfc`; a map CHOICE whose
  alternatives' first members are cut members on the same literal key. Over
  the corpus it fires 3 times (adversarial "D021: cut is alternative local",
  study "group choice in map //" and "dependent members: group choice //")
  plus the RFC corpus's derived cut-scope suite; never on a printed RFC
  schema or a cddl-study contract. Gate 10: 20/20 cases (positions, named
  groups through CALL, `^=>`, nested choice, the working forms silent,
  arrays silent, silent under `branch`), JS == Rust.
* **Docs.** guide.md "Discriminated unions under the RFC cut" (after
  "Compile once"): the failing idiom and why (`:` implies a cut; App. A
  order; §3.5.4 "the entire map fails"), the two working forms -- a type
  choice of maps (R19: the cut's scope is the map type; checked with the
  oracle and the compiled Programs) and `"kind" =>` discriminators -- a
  verdict table checked with the oracle in both modes, the
  successful-cut case `{id: tstr, token: tstr // id: tstr}`, W8, and
  `cuts: 'branch'`. architecture §20 (dated note, §20.2 modes, R9, W8 row,
  §20.13 flips, §20.15 column `branch`, §20.16 Q1 answered), program-2
  (note, §1, header word 6, cut outcomes, examples), cddl-support (format
  2.0 cut paragraph, format 1 kept), api.md (`cuts`), conformance.md
  (D021 bullet superseded note), oracle README (D301 re-run).
* **Corpus.** Re-derived with the oracle in `rfc` mode (both modes over
  1697 decided corpus cases): 15 cases differ between the modes, all
  true under `branch`, false under `rfc`: adversarial C3/A1 #0 #3, A1 #2,
  A1c #3, D021 #0, seeded-008 #1, -012 #1, -020 #1, -024 #3, -036 #3,
  -052 #1 #3; study "group choice in map //" #1, "dependent members: group
  choice //" #0; RFC 8610 cut-scope #1. Adversarial/study expectations are
  still the pre-PEG ones (the 33 PEG flips are not migrated on the branch
  either), so the 12 adversarial flips are recorded in the oracle test
  (`rfcFlips`; the complete corpus is checked in both modes: 33 differences
  under `branch`, 33 + 12 under `rfc`). The RFC suite "literal cut scope
  D271" is renamed "literal cut scope (D301 default)", its staged case is
  `dependsOn: ["D301"]` (runner group D301; exporter updated), and both of
  its expectations are confirmed by the oracle's `rfc` mode;
  `current-results.json` stays the 2026-11-04 run record.
* **RFC-default difficulty: none found.** In the RFC corpus (390 cases the
  oracle decides, contexts included) the only verdict that differs between
  the modes is the derived cut-scope case, which `rfc` brings into
  agreement with its literal-RFC expectation (380/390 → 381/390; the
  remaining 9 are the known F5/F6 float-width and `.default` findings and
  two P8.4 cases). No printed RFC example becomes unmatchable.

Checks actually run (macOS, node 24.6, cargo debug):

* `bb compile2-test`: all ok -- 976/976 JS == Rust, 916/916 verified,
  165/165 SOURCE_KEYs (with the default-mode identity and the
  `'reference'` refusal), 234/234 probe verdicts and 298/298
  probe/targeted schemas (6 new targeted schemas for the union forms, both
  modes, against the oracle), 3266/3266 corpus verdicts equal the oracle's in
  both modes, 20/20 W8 cases. Warnings over the corpus (default `rfc`): W2 1,
  W5 1, W6 19, W7 26, W8 3.
* Mutant: the JS default flipped back to `branch` is red at once (gate 6).
* `node --test corpus/tools/peg-oracle.test.mjs` (Ruby differential
  skipped): 482/482.
* `bb compile-fuzz` (3000, default seed): ok.
* Full Rust crate (lib + bins, `-D warnings`) and the wasm `cc` module
  build; the wasm compiler equals JS on 12 Programs (option word 20 absent,
  -1, 0, 1).
* `node corpus/tools/run-rfc-corpus.mjs --depends=D301` selects the one
  staged case (it fails, as expected, until the phase 2 VM).

Learnt: making the zero value of an option word the default keeps every
caller that zero-fills (the Rust gate binary, the wasm option array) on the
decided semantics without host changes; a renamed enum value needs a loud
refusal of the old spelling, not a silent `unknown`.

## P8.5 — PEG groups, phase 2: the VM, format 2.0 on every route; merged to main (2026-11-11)

Implements program-2 §5–§10 in the VM on branch `p85-peg`, rebased onto main
`cfbdda3` (P8.4 done, D284, D286 A1) and merged per the merge plan above.
Decisions D310–D321 (all unsigned).

* **Arrays** (`kin/vm-array.kin`): per ARRAY leaf a block; the relaxed query
  automaton picks each element's candidates; verdict records by tier (A0 the
  active set, A1 a ring of B + 1 rows in the block, A2 an arena record of the
  item's stride); an incremental PEG machine (`a-run`) runs to its next
  record request after each element; events E1–E4 with absolute offsets
  (`VM_PBASE`), rule 5′ (`array-witness`).
* **Maps** (`kin/vm-map.kin`): per MAP leaf a block; key search, cursor or
  binary search of `named`, candidates (key phase), value tests; F's
  pair-major walk, S slots (trail in the block), T records; at the end the map
  machine (rfc commitment epochs by default, rule A under `branch`), scored
  events, rule 4′, leftovers; T's pick order by an in-VM EC comparator and
  heap sort (D312).
* **Arena** (`kin/vm-arena.kin`): upward record stack and a 64-word chunk
  heap for recursive frames, relative addresses; buffer growth by −5 (D313),
  session gates and relocation at the step start (D314); `group_limit` (44)
  at the effective cap; limits word 10.
* **Walks**: `kin/vm-eval.kin` and `kin/vm-session-cont.kin` call the same
  block functions in the same order (one charging order, §10); EMBED and
  `.cborseq` save/restore the arena top; the valid path (D280 replay) maps
  `group_limit`'s offset back to the input like `budget`.
* **Streaks** (D315): D044's `[* T]` streak and the map pair streak, schedule
  2, gated by limits word 8 bit 3 against the item-by-item walk.
* **Compiler/verifier**: ARRWORDS/MAPWORDS/rec_words as built (D311), frame
  sizes, W7 (D317), the format word 2 (D318).
* **Hosts**: format 2.0 Programs everywhere (the built-in `any` Program
  regenerated); the wasm SDK sizes the verifier scratch with
  `vm-verify-words` (D300 authorised the `sdk.rs` edit; not refused); reason
  44 is `group_limit` in JS, Rust and the wasm SDK; Rust `CompileOptions`
  gains `cuts` and `group_words` (JS had them since phase 1).
* **Harnesses** (D320): vm-test's oracle arm is the PEG oracle (generated
  schemas and the corpus, both cut modes), plus program-2 §12's worked
  examples, the forced-tier gate, arena cases (`groupWords`), and the new
  streak == item-by-item gate; vmsession-test, sequence-test, the Rust gate
  binaries and benches pass limits word 10; format 1's assembler harnesses are
  gone; proptest checks against the PEG oracle.
* **Corpus**: 47 adversarial/study expectations flipped true → false, each
  with a note (11 structural, 22 rule A, 14 D301), and 26 suites lost their
  withdrawn refusal (D320). The flips: adversarial seeded-000 #1–3, -004 #1,
  -008 #1 (rfc) #2 #3, -012 #1 (rfc) #2 #3, -016 #1–3, -020 #1 (rfc), -024 #1
  #3 (rfc), -028 #1–3, -036 #3 (rfc), -041 #4, -043 #4, -044 #2, -048 #2,
  -049 #4, -050 #2, -052 #1 (rfc) #2 #3 (rfc), -056 #1–3, -068 #1; "A1:
  choices correlate…" #1 #3 (structural) #2 (rfc); A1c #3; C3/A1 #0 #3; D021
  #0; C6 #2; A3 #3 #5 #7; "embedded sequence with backtracking" #0; study
  "group choice in map //" #1 and "dependent members: group choice //" #0.
  With the RFC suite's staged D301 case these are the 33 + 15 predicted.
* **P8.4 fix found by the rebase's gates (D321)**: on wire `valid` a buffer
  attempt that ran out of budget before the input's first non-deterministic
  encoding reported the original order's offset and items, the session the
  canonical walk's; now the canonical path decides on `budget` too.
  Pre-existing on main `3c10a83`; regression in valid-test §3c.
* **Performance**: without the pair streak `map-struct` cost 2.3× main's CPU
  per unit; restored (D315). Calibration (D316, bench/VM.md "Calibration
  2026-11-11"): PEG rows 0.93–1.44× the median kind (JS), 1.04–1.23× (Rust),
  no price changed. Bundle growth +19.3 KB min in VM entries, attributed and
  capped per D319.

Checks actually run after the rebase (macOS 14.6.1, M1 Pro, Node 24.6.0,
rustc 1.92.0, cargo debug unless said; machine shared, load 25–45):

* `bb vm-test` (20,000 mutations, 400 generated schemas, seed 1): all ok —
  80,509 cases; conformance 1407/1407; PEG oracle differential 8600/8600
  (6400 on 400 generated schemas, 2200 on the corpus, both cut modes);
  forced tiers 80,212/80,212 (297 resource-bound held to their own
  schedule); fast == generic (schedule 1) 80,509; **streaks == item by item
  (word 8 bit 3) 80,509**; JS == Rust 80,509, schedule-1 and forced-tier JS
  == Rust; hosts 2850/2850; JS == wasm 78,215/78,215.
* `bb vmsession-test 2000 1 100 60`: all ok — session == buffer 304,458 runs
  (incl. the arena cases with `groupWords`), untold length 147k streams,
  JS == Rust 193,787. (Before D321 one untold-length stream differed; before
  the valid path mapped `group_limit`'s offset, 60 arena runs did.)
* `bb sequence-test 300 1`: ok (441,517/441,517 runs == D211's oracle, JS ==
  Rust, hosts). `bb valid-test`: ok, incl. the new D321 regression 144/144.
* `bb wasm-sdk-test`: 14/14 (Program load 1397/1397, validate 80,509,
  sessions, sequences 364,672 — wasm == native).
* `bb compile-test` (compile2-test + regexp): ok — 976/976 JS == Rust,
  916/916 verified, 3266/3266 corpus verdicts == the oracle (both modes);
  corpus warnings W2 1, W5 1, W6 19, **W7 1** (was 26, D317), W8 3.
* `bb scan-test 300 1`, `rscan-test 300 1`, `nav-test`, `write-test`,
  `unicode-test`, `drift`, `bb compile-fuzz` (3000): ok.
* `npm test` (host/js): 1450/1450, incl. the new group-arena test. `bb
  rust-api-test`: ok (public_api 14, incl. the new group-arena test; clippy).
* `node corpus/tools/run-rfc-corpus.mjs`: D270 14/14 (main 3/14), D301 1/1;
  P8.4 222/2 and baseline 735/25; the 27 failures are all in suites P8.5 does
  not touch (RFC 8610 speed/default-timer/prelude, RFC 9165 figures 2–5,
  RFC 9682 simple heads, two additional RFC 8949 vectors), as before the
  branch.
* `bb size`: passes with D319's caps.
* `bb proptest --minutes=2 --props=1,2,3,4,5`: P1 16,559, P2 21,869, P3
  9,069, P4 7,507, P5 7,163 cases; one signature, P5/slow-compile ×2 (wall
  clock at load 50–75; the case replays without it). Two harness fixes first
  (the PEG oracle decodes valid `.cbor` content, so P1 compares with the
  `valid` preset; `pegNodes` replaces `alternatives` in P5's limits). The
  property-6 gates were run directly (above), not through the campaign.
* Calibration: bench/VM.md "Calibration 2026-11-11" (D316).

Open problems (for the manager):

* A recursive Program's session grows its arena to the whole message's
  §9.4 bound at the start (D314): correct, but memory for nothing on inputs
  that never recurse deeply.
* D281 says `group_limit` applies only under an explicit `groupWords`; with a
  finite default cap a miss at the default cap is `group_limit` too (D276 as
  amended). Flagged in D313.
* T maps are quadratic (architecture §20.7): `{* (tstr => uint // tstr =>
  tstr)}` with 3,000 pairs exhausts the default budget.
* `embedded` is the dearest calibration row (2.15× JS); not analysed.
* Format 1's per-pair `map-pair-fast` (single pairs outside a streak) was not
  restored; `reference-map-choice` is 1.49× the median against 1.42× before.
* *Follow-up (2026-11-11, branch `p85-tlin`):* T maps are linear after the
  sort (D323); `map-pair-fast` stays out (D323 item 4: its workloads are
  multi-block maps). A further problem found by the D286 engineer is fixed:
  a sequence's session scratch grew ~470 words per canonical-path message,
  never reclaimed (D324: the arena now starts at the lease). The first open
  problem (a recursive Program's whole-message arena bound) remains; D324
  only stops it accumulating across a sequence's messages.

Learnt: one set of block functions called by both walks made session ==
buffer cheap to keep; every session-only divergence found (S's trail, the
valid path's `group_limit` offset) was state or mapping outside those
functions. A streak needs its own gate against the item-by-item walk under
the *same* schedule — D254's fast == generic gate compares schedule 1 only.

## P8.5 follow-up — linear T maps, the D286 map regression, the sequence scratch bound (2026-11-11, branch `p85-tlin`)

D323 (T maps' non-literal member cursors; the map streak takes `any`; block
init trimmed; `map-pair-fast` not restored) and D324 (a session's arena
starts at the lease), both unsigned, on main `e3fa424` (after D286 B+C, the
tag-4 fix and D286 D).

Measured on the final tree (in-process interleaved, best of 7, ms per call;
load 25–45):

| workload | cfbdda3 | main e3fa424 | p85-tlin | units (main = p85-tlin) |
| --- | ---: | ---: | ---: | ---: |
| 2000 maps × 8 keys `[* {* tstr => any}]` | 4.53 | 18.00 | 5.15 | 96,010 (cfbdda3 94,008) |
| map-heavy typed (2000 records) | 10.61 | 12.18 | 11.47 | 214,023 (194,020) |
| reference-map-choice (2000) | 11.72 | 16.23 | 15.66 | 268,011 (254,007) |

T table `{* (tstr => uint // tstr => tstr)}`, units in order / reversed: 1k
34,016 / 67,945; 3k 102,016 / 223,089; 10k 340,016 / 813,379; 30k 1,020,016
/ 2,631,389 (main: 3k 9.1 M; 10k 100 M). Units per n log₂ n fall with n.
The sequence scratch stays at 1,554 words over 1000 canonical-path messages;
main grows it to 469,086.

Checks actually run on the final tree (macOS 14.6.1, M1 Pro, Node 24.6.0,
rustc 1.92.0):

* `bb vm-test`: all ok — 80,545 cases, including the 36 large-T cases; PEG
  oracle differential 8600/8600 (both cut modes); forced tiers 80,249/80,249;
  streaks == item by item 80,545; JS == Rust 80,545; JS == wasm 78,251.
* `bb vmsession-test 2000 1 100 60`: ok — session == buffer 304,747 runs,
  untold length 147,181, JS == Rust 193,966.
* `bb sequence-test 300 1`: ok — 441,806 runs == the oracle, scratch bound
  1,554 words after 5 and after 1000 messages. `bb valid-test`: ok.
* `bb wasm-sdk-test`: 15/15. `bb rust-api-test`: ok (50 tests, including
  `sequence::scratch_tests`; clippy). `npm test`: 1450/1450.
* `bb compile-test` (3266/3266 corpus verdicts == the oracle; W7 1),
  `scan-test 300 1`, `rscan-test 300 1`, `nav-test`, `write-test`,
  `unicode-test`, `compile-fuzz`, `drift`: ok.
* RFC corpus runner: D270 14/14, D301 1/1; P8.4 222/2 and baseline 735/25 as
  on main.
* `bb size`: passes with D323's provisional caps (`runtime`, `snug/schema`,
  `snug/sequence`; unsigned).
* `bb proptest --minutes=2 --props=1,2,3,4,5`: P1 25,053, P2 31,757, P3
  13,404, P4 11,107, P5 10,488 cases, no failure signature.

Learnt: a gate that accepts any code ≥ 32 (the arena section's 3,000-pair T
maps) hid a budget exhaustion on valid data. Large-input gates need to assert
the verdict and a unit bound, not just that a verdict exists. And a loop
bound in kin is re-evaluated per trip in the emitted JS, so a function-call
bound in a hot loop costs a call per iteration.

## P8.5 follow-up — the map streak over canonical copies (2026-11-11, branch `p85-rev`)

From the D286 engineer's analysis E: on `b25a0fe`, 2000 maps × 8 keys took
4.2× longer with reversed keys than deterministic, 74% of it in the VM walk
over the canonical copy. A profile confirmed the cause. The map pair streak
was never entered there, because eval-map refused it when an event table was
present or the map was unordered, and it stopped at any key that did not
ascend. So every pair took the generic path.

* **The streak over a canonical copy.** Under `PF_CANON` a key that does not
  ascend sets the block's `unordered` bit, exactly as eval-map's
  `map-unordered` does. From then on the key search starts at 0 and a
  struct's named key is binary-searched without moving the cursor, as
  `map-cursor` does unordered. The key-order charge stays `c64min`. The
  streak takes no pair that has a recorded event (D280) inside it: the next
  event's position comes from the event table's lower bound (`ev-next`), and
  an `any` value's end from `tskip`. Those pairs, including every refused
  duplicate key, go to the pair-by-pair walk, which replays them. No charge
  changes.
* **Proof of identity.**
  * vm-test's streak == item-by-item gate: 80,545/80,545 under schedule 2,
    the generated unsorted-key cases included.
  * JS == Rust 80,545 and JS == wasm 78,251.
  * A differential in `.cache` (24,000 runs: canonical-path maps with
    unsorted and duplicate keys, non-shortest and indefinite values, nested
    maps, random budgets): streak on == streak off == main `b25a0fe`, whole out
    array (code, offset, units, items, path), 0 differences.
  * Units on the workloads are unchanged: 174,010 / 274,023 / 69.
* **Cuts, to stay within the caps** (charges and events identical, same
  differential):
  * one binary search (`ev-lb`) behind `rfind` and `ev-next`;
  * the streak's struct cursor walk replaced by `named-index` (the ascending
    cursor stops at the key's entry, so the search answers what it would);
  * `map-open` answers the candidate list's offset and capacity (`map-cl`
    and `map-ccap` removed);
  * the record base found in `map-close`'s and `arr-close`'s own loops
    (`map-mark` and `array-mark` removed).

  A key-search built on key-probe saved 130 B min but cost brotli, so it was
  dropped. Net against `b25a0fe`: `runtime` 172,128 → 171,999 min (−129);
  `snug/sources` 179,650 → 179,513, brotli 56,307 → 56,284 (cap 56,329);
  `snug/sequence` 209,220 → 209,083 (cap 209,286). No cap changes and no
  D-entry. The margins are thin: D286 A2+A3's +329 B in the session entries
  will need its own room.
* **Bench** (`bench/valid-vm-bench.mjs`, now with `vm-rev` / `sess-rev` arms:
  keys reversed, otherwise deterministic; vm arms report units; one process
  per tree, 7 trials, µs, load ~30). Main `b25a0fe` → branch:

  | workload | vm-rev | sess-rev | vm-det |
  | --- | ---: | ---: | ---: |
  | 2000 maps × 8 keys | 26,989 → 14,702 (1.84×) | 46,224 → 35,546 | 4,721 → 4,691 |
  | map-heavy | 32,232 → 25,610 (1.26×) | 57,898 → 49,318 | 10,510 → 11,267 (noise) |
  | RPC put | 95.7 → 74.1 | 164.8 → 131.5 | 13.4 → 15.8 |

  The rest of maps-rev's time is the canonical copy and the scan (D286's
  area). map-heavy keeps its generic pairs (a nested map, the two-leaf `bool`
  typeset).

Checks run on the final tree:

* `bb vm-test`: all ok (above; PEG oracle differential 8600/8600; the 36
  large-T cases).
* `bb vmsession-test 2000 1 100 60`: session == buffer 304,747, JS == Rust
  193,966.
* `bb sequence-test 300 1`: 441,806 runs; scratch bound held.
* `bb valid-test`, `bb compile-test`, `scan-test 300 1`, `rscan-test 300 1`,
  `nav-test`, `write-test`, `unicode-test`, `compile-fuzz`, `drift`: ok.
* `bb rust-api-test`: ok. `npm test`: 1450/1450. `bb size`: passes.
* RFC runner: D270 14/14, D301 1/1, baseline 735/25 as on main.
* `bb proptest --minutes=2 --props=1,2,3,4,5`: P1 22,599, P2 28,755, P3
  12,006, P4 10,087, P5 9,679 cases, no failure signature.
* `bb wasm-sdk-test`: 15/15.
