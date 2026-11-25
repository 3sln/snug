# Performance and size audit (D377) — 2026-11-25

**Analysis only.** No code, budget or build changed. The machine was CPU-loaded, so
nothing was built, benchmarked, size-gated or tested. Every number here comes from a record already on disk, or
from reading and counting the generated code. Anything that needs a run says
**measure when the machine is free**.

**Owner constraint:** no size reduction at the expense of performance. Every
candidate that touches a hot path is in §9's "hot path" table and gives a
neutral-or-better argument. Those arguments are reasoned, not measured.
Every one of them is **measure later**.

**Sources read:**
- `tools/size/budget.json`.
- The latest recorded `bb size` (`.cache/mgr/d374-size.log`, p-d374 over d1fa06a; main has changed only READMEs since).
- The wasm sizes recorded in DEVLOG D371, D373 and D374.
- DEVLOG D285, D286, D319, D322, D333, D341 (P9.12), D354, D358, D371, D373 and D374, and "Findings".
- `bench/size-audit.md` (P9.12), `bench/README.md`, `bench/D286-analysis.md` and `bench/VM.md`.
- The p920 esbuild metafile report (`.cache/p920-paths-size-new.json`, per-module `bytesInOutput`).
- `gen/js` and `gen/rust`, read and counted with grep and wc.
- The kin sources, the host glue and `kin/scripts/wasm-build`.

Earlier audits are not redone here. D341/P9.12 found the JS entries "close to the floor for what they do".
This audit looks at what changed since then (D358's Writer→scanner edge, the
caps after D373 and D374), at what P9.12 deferred, and at the performance side, which
P9.12 did not cover.

---

## 1. Size headroom per entry (where the next change lands)

Measured on p-d374 (`bb size`, esbuild 0.28.2, gzip 9, brotli 11). Headroom is
cap − measured, in bytes, with the percentage of the cap in brackets.

| entry | min headroom | gzip headroom | brotli headroom |
| --- | ---: | ---: | ---: |
| `snug` (codec) | **83** (0.13%) | **11** (0.05%) | 407 (2.1%) |
| `snug/schema` | 1,290 (0.84%) | 367 (0.67%) | 979 (2.0%) |
| `snug/compile` static | 29 (1.1%) | 18 (1.3%) | 27 (2.2%) |
| `snug/compile` full | 626 (0.22%) | **11** (0.01%) | **14** (0.02%) |
| `snug/view` | 172 (0.22%) | 250 (0.94%) | 196 (0.84%) |
| `snug/writer` | 1,126 (1.9%) | 392 (1.9%) | 329 (1.8%) |
| `snug/unicode` | 388 (2.0%) | 186 (2.0%) | 177 (2.0%) |
| `snug/sources` | **13** (0.01%) | 1,161 (1.7%) | 734 (1.3%) |
| `snug/sequence` | 271 (0.13%) | 1,161 (1.5%) | 1,017 (1.5%) |
| `snug/controls` | 110 (1.7%) | 36 (1.5%) | 30 (1.4%) |
| `snug/abnf` | 316 (2.0%) | 129 (2.0%) | 114 (2.0%) |
| `runtime` | 981 (0.56%) | 203 (0.32%) | **78** (0.15%) |
| `all-runtime` | 2,456 (0.87%) | 818 (0.80%) | 1,571 (1.8%) |

| wasm module | bytes (measured / cap) | headroom | gzip headroom |
| --- | ---: | ---: | ---: |
| SDK runtime (opt 3 + `wasm-opt -O3`) | 327,443 / 331,770 | 4,327 (1.3%) | 1,865 |
| compiler (opt "z" + `wasm-opt -Oz`) | 153,510 / 153,564 | **54** (0.04%) | 291 |

**What this means for upcoming work:**
- **Scanner changes.** Any change to the scanner (`kin/scan.kin`, `head.kin`, `text.kin`, `canon.kin`) adds bytes to `snug`, whose gzip headroom is 11 B. Every entry that holds the scanner grows with it: writer, view, schema, sources and sequence. So any scanner performance work (H5, H6 below) needs either a cap raise under D303 or a cut first.
- **Compiler changes.** Any change to the kin compiler trips `snug/compile` full (11 B gzip, 14 B brotli) and the wasm compiler module (54 B) together. D373 and D374 both had to raise caps. The next compiler fix will too, unless W1 or S7 lands first.
- **Session changes.** Any change on the session path (`vm-session*.kin`, `sources.mjs`, `session-pool.mjs`) trips `snug/sources` min (13 B). D371 already had to compact to fit.
- **`runtime` brotli (78 B)** is the tightest union cap.
- **The SDK runtime module is the only place with real room (1.3%).**

The size-only candidates that buy headroom where it is tight: S4 (sources),
S7 and W1 (compile, cc module), and K1 (every entry, kin-side).

---

## 2. Generated JS and Rust (kin codegen patterns)

These are facts from counting the generated code. They feed the candidates in §9.

- **No opcode VM.** The VM is a recursive-descent walk over the CBOR bytes, with a query list of schema leaves per frame.
  - `evalItem` (`gen/js/snug/vm/eval.mjs:2439`, `eval.rs:2381`, `kin/vm-eval.kin:1655`) dispatches on the major type through an if-chain of at most about 7 compares.
  - The only `switch` in the 15 VM modules is `evalLeaf` (`leaf.mjs:625`, `leaf.rs:603`), over dense kinds 1..10.
  - In JS its case labels are **imported `const` bindings, not literals**, so V8 may not build a jump table. This is unverified (K2).
- **No per-step allocation in the generated hot paths.**
  - JS `vm/*.mjs` and `cbor/*.mjs` have no `[]`, `{}`, closures or `slice` on the walk paths.
  - The only per-call objects are `subarray` views in `bcopy`/`ka.set`. These are 4 sites on the session key paths (`sbase.mjs:690 keysSave`, `scont.mjs:1297`, `svalid.mjs:467/579`) and 3 on the canonical path (`canon.mjs:995`, `vcopy.mjs:1171/1220`).
  - Rust `vm/*.rs` and `cbor/*.rs` have no `Vec`, `clone`, `to_vec` or `String`.
- **Per-step allocations in wrappers the hosts do not use.**
  - `vmsStepX` allocates two empty typed arrays per step (`session.mjs:837`).
  - `vmsStep`, `vmValidate` and `vmValidateSpan` allocate a closure per call (`session.mjs:956`, `api.mjs:666/680`).
  - Neither host calls them. The JS host calls `vmsStepV`/`vmValidateV` with a module-level `noExt` (`vm-session.mjs:104`, `sequence.mjs:39`, `schema-core.mjs:107`). **Not a finding for production; no action.**
- **Rust indexing.** All array access is a checked `x[(i) as usize]`, with zero `get_unchecked`.
  - VM counts: map.rs 372, scont.rs 370, eval.rs 332, sbase.rs 242, session.rs 225, sstr.rs 203, api.rs 189, the rest under 150.
  - Scanner counts: scan.rs 192, vcopy.rs 271, canon.rs 172, text.rs 15.
  - Constant-offset header loads such as `s[VM_BUDGET as usize]` are re-checked at every call, because the slice length is unknown to LLVM.
  - Overflow: `overflow-checks = false` in release. There are 10 `wrapping_*` and no `checked_*`.
- **Inlining.** There is no `#[inline]` in the generated Rust. Every generated module is in one crate, and both the crate and the wasm builds use `codegen-units = 1` (wasm with fat LTO), so LLVM can already inline across modules. No action is needed for snug's own builds. For consumers see R2.
- **Emitter redundancies.**
  - `(x >>> k) | 0` where `| 0` is redundant: 85 in vm JS and 184 across `all-runtime`, about 370 B min (D341 item 9).
  - `x ^ (-1)` for `~x`: 11.
  - These are size-only and V8 folds them. The fix is in kin's emitter (K1).
- **Comments.** Comments are 21% of the vm JS source bytes, and about 46 KB of the 214 KB in `cbor`. esbuild drops them, so **they do not count in any size gate**. They only add to the npm tarball's unpacked size, since `exports` points at unminified `src/*.mjs` and `gen/js`. They cost parse time when Node loads the package unbundled, and that cost is small (DEVLOG Findings 2026-10-29: 7 modules unbundled 3.0 ms vs 1.4 ms bundled). This is not proposed: the comments are the record that maps the generated code back to kin.
- **Duplicated helpers inside the generated code are small.**
  - Byte-identical across vm modules: `ifCode` (`eval.mjs:497`, `scont.mjs:1313`, 110 B) and `imax` (85 B).
  - P9.12's token-level scan found 1.4 KB min of duplicates in `all-runtime` and 2.7 KB min across everything. gzip folds most of that (D341 item 6).
- **Tables.**
  - No generated runtime module builds a table at load. `stdtags` is all branching, and `codes.mjs` is constants.
  - `compile/prelude.mjs` holds the prelude text as an `Int32Array.of` literal.
  - The only real load-time work is `host/js/src/unicode-tables.mjs`: it base64-decodes and varint-decodes 6,419 triples at import. That module is its own entry, imported only by applications that pass `unicode`.

---

## 3. Hot VM and scanner loops

### 3.1 Budget charging (`kin/vm-base.kin:82 charge`)
- **What a call does.** Each call loads and tests `s[VM_GENERIC] & 4` (schedule 2's "free" bit), loads `s[VM_BUDGET]`, compares it and stores it back.
  - There are about 104 call sites: eval 33, map 25, array 9, dead 9, leaf 8, base 6, sstr 6 and the rest.
  - A scalar item pays about 3 calls: `evalItem`'s 1, `qAdd`/`qFilter` per element, and text's `c8(len)`.
- **Charges of zero.** `evalScalars` (`leaf.mjs:652`, `vm-leaf.kin:462`) calls `charge(s, unit, pos)` inside its per-leaf loop even when `unit` is 0.
  - `unit` is 0 for schedule 2's one-leaf child (D045, the default schedule). That is the common struct-field case.
  - A charge of 0 can never fail as long as `VM_BUDGET` is never negative: the budget is set from a validated non-negative limit and only ever reduced by a charge that fits. The implementer confirms this.
  - So skipping the call when `unit == 0` cannot change a verdict, an offset or `budgetUsed`. → **H2**.
- **A second counter.** `evalItem` also bumps `O_ITEMS` and compares it with `O_MAX_ITEMS` on every item. That counter is the public `maxItems` limit, not redundant. No action.

### 3.2 Session frames: `keysSave` on every `fpush` (`kin/vm-session-base.kin:473/493`)
- **The cost.** `fpush` calls `keys-save` first, and `keys-save` loops over **every** frame (`for i 0 sp`) looking for a map frame whose previous key is still a window span. The kin comment says that only the top-most map can hold one, because every push saves first (D092).
  - So every container push costs O(depth), and a message nested d deep costs O(d²) frame checks.
  - At the default `maxDepth` 32 that is about 500 checks for the deepest path. At the maximum of 256 it is about 33,000.
  - Sessions only: sources, sequence and the SDK. The buffer driver does not use frames.
- **The change.** Walk down from `sp − 1` and stop at the first map frame. → **H1**.

### 3.3 Scanner (`kin/scan.kin item`, `head.kin read-arg`)
- **Per item.** The scan is recursive. Each item does a count/max-items check, `pos >= end`, a head decode, then `read-arg` for `ai >= 24`.
  - `read-arg` returns through memory (`o[O_HI]`, `o[O_LO]`): two stores and two loads per long head.
  - It is kept under V8's 460-byte inlining limit on purpose (Findings 2026-10-29: about 25% on item-heavy input). Any change here must keep it there.
- **Profile tests.** These are runtime loads of `o[O_PROFILE]`.
  - On deterministic text-keyed maps there are none per key.
  - On valid or non-text-key maps there are up to 4 loads per key.
  - D286 measured the valid branches at 0.8–1.2× and rejected a separate deterministic scanner, so specialisation is not proposed again.
- **UTF-8 (`text.kin utf8-invalid-at:86`).** The loop goes one byte at a time, with `c < 128 → i + 1` as the only ASCII fast path.
  - There is no chunked ASCII skip. → **H6**.
- **Allocations.** The scanner allocates nothing per item in either target.

### 3.4 The canonical path under `valid` (D262/D264/D286; SEC-F6)
- **The passes on non-deterministic input** (`vm-api.kin:426–460`):
  1. The VM's deterministic attempt, discarded on `indefinite`/`non_shortest`/`key_order`/an EC-sensitive key.
  2. The scanner (`scan-x` + `run-defer`).
  3. `canon-build`. This `bcopy`s the input to `cb[0,n)`, then runs the prefix writer `pw` (a re-walk) or, for an accepted item that is its own DC form, a **second** `bcopy` to `cb[n,2n)`. It adds a `may-tag24` byte scan, then the optional `visit`/`uvisit`.
  4. The VM again over the copy, plus `map-back`.
- **SEC-F6.** Under `valid` a call can spend about twice its budget, plus linear passes. This was closed by documentation only (D371): docs/api.md.
- **Work still duplicated after D286 A–D:**
  - `kclass` (`canon.kin:247`, a recursive key walk) runs in the scanner (`key-step`), again in `dup-input`/`dup-forms`, and again in `pw` per map key (`vcopy.kin:357/464/750`).
  - `dup-input` (`canon.kin:558`) `tskip`s each key and value twice per pair, so nested marked maps re-walk their content once for each enclosing marked map.
  - The double `bcopy` when `same == 1`.
- **Cost today** (D286 summary, after A+B+C): 3.4–6.2× the deterministic buffer run on reordered maps. D's estimate was about 2.6–4.7×.
- **Not tried yet.** Option E (a tolerant attempt: no scanner pass and no copy for reordered keys) was deferred "until PEG phase 2 lands". PEG has landed. → **H7**.
- **The deterministic attempt itself costs nothing extra.** It is the fast path: dropping it costs 2.3–6.9× (D286). Keep it.

### 3.5 Duplicate keys (`canon.kin`)
- Adjacent compare on the fast path.
- Marked maps: 3 words per key of scratch, a heap sort, then a neighbour scan. That is O(n log n) byte compares through `fbyte`, which branches per byte on which buffer the form lives in.
- A hash set was rejected in D263 (adversarial collisions). Not revisited.

### 3.6 `rscan` vs `scan`
- About 450–550 lines of `rscan.kin` re-implement about 350–450 lines of `scan.kin`'s dispatch as a frame-stack state machine. `rscan.mjs` is 42.6 KB of source and 9,324 B min in sources.
- Unifying them would mean the recursive scanner becoming the state machine. That is a size win and a likely speed loss on the buffer path (recursion with locals vs frames in a typed array).
- **Not proposed** under the owner constraint.

---

## 4. Compile

- **The prelude is lexed and parsed on every compile** (`kin/compile/main.kin setup`, `prelude.kin`).
  - D374 measured a fixed cost of about 16,600 arena words per compile. Small corpus schemas are 1–3 KB of text against about 900 B of prelude.
  - Compiles in a warm process (wasm 0.245 ms opt-3, about 0.34 ms shipped `-Oz`) pay this every time. → **C1**.
- **Unicode tables are validated and copied into the arena on every compile that passes `unicode`** (`regexp.kin:72 unicode-init`).
  - That is 6,419 triples = 19,257 words checked, pushed and charged, whether or not the schema uses `\p{…}`. → **C2**.
- **Arena growth (D374).** The first arena is sized from the text. A restart on `ERR_ARENA` remains only above `RETAIN_WORDS`. No action.
- **Float-literal restart (`ERR_NEED_FLOATS`).** It is requested right after lexing, so it costs one lex pass plus setup (SEC-F7 docs). No action.
- **Rule lookup** is hashed (`rules.kin:42 name-hash`). No action.
- **Duplicated compiler code (P9.12 §1).**
  - A merge sort duplicated with different constants: 386 B min.
  - `lowerMap`/`lowerArray`: 232 B min.
  - They are on the compiler's main passes, but they run once per rule or group, not per byte. → **S7**, with a measured-compile check.
- **The source copy.** `setup` copies the source into the arena one Int32 word per byte (`vpush1`). That is a linear 4× expansion. It is inherent to kin's one-array arena. No action.

---

## 5. wasm modules

- **Configuration as found** (`kin/scripts/wasm-build`, `host/wasm/Cargo.toml`):
  - `lto = true`, `codegen-units = 1`, `panic = "abort"`, `strip = true`.
  - `-Zbuild-std` with `panic=immediate-abort`: no `core::fmt` or panic symbols (D341).
  - The SDK is built at opt-level 3 and then `wasm-opt -O3`. The compiler is built at opt-level "z" and then `wasm-opt -Oz`.
  - The wasm-opt flags enable bulk-memory, sign-ext, mutable-globals, nontrapping-float-to-int, multivalue and reference-types. These match the defaults of rustc's wasm32 target on the pinned nightly.
  - SIMD (`simd128`) is not enabled.
- **Composition** (P9.12 §3, opt-3 unstripped): code is 98% and data 3.6 KB.
  - `vm::eval` 56 KB.
  - `program::verify` 46 KB.
  - `sdk.rs` 63 KB, of which `ses_step` is 23 KB with the session steps inlined into it.
  - dlmalloc 8,040 B.
- **Compiler module, 54 B headroom.** Size levers that leave the runtime alone:
  - (a) `wasm-opt -Oz --converge`, which reruns passes until fixpoint;
  - (b) a lighter allocator for the cc module only, since the compiler's memory is one reused arena plus small vectors;
  - (c) the S7 dedups, which also shrink it.
  → **W1**, **W2**.
- **SDK runtime.**
  - D341 rejected opt "s"/"z" (1.06–1.07× slower). That stands.
  - Speed-only levers:
    - `wasm-opt -O4` or `-O3 --converge`;
    - `simd128` for the UTF-8 check and copies, which is an owner compatibility decision (Safari 16.4+, workerd yes).
  → **W3**, **W4**.
- **Rejected: `--traps-never-happen` / `-tnh`.** With `panic=immediate-abort`, every Rust bounds-check failure is a wasm trap. `-tnh` lets binaryen assume they never happen, which turns a safe abort into undefined behaviour. That is a security regression on an untrusted-input parser, for either module.
- **Rejected: `--low-memory-unused` / `--zero-filled-memory`.** The data segment is 3.6 KB, so there is nothing to gain.

---

## 6. Host glue

- **Options are validated more than once per call** (`host/js/src/options.mjs`). `checked` does a `Reflect.ownKeys`, then `Object.hasOwn` and a predicate per key.
  - `encode` validates `'encode'` (`encode.mjs:22`), then `new Writer` validates `'writer'` again (`writer.mjs:84`).
  - `Schema.decode` validates at `schema-core.mjs:172` and again in `check` (`:184`).
  - The rule name is looked up twice (`public-schema.mjs:76–78` and `schema-core.mjs:152`).
  - `view.mjs:540–551` calls `selectOptions` 2–3 times and `validateOptions` twice per view.
  - `selectOptions` allocates `Object.keys` + `filter` + `map` + `fromEntries` on every call.
  - For a 287 B RPC message, encode is about 4.5 µs and the VM validate 8.3 µs (bench/README.md), so a few hundred ns of option work is a visible share. → **G1**.
- **Session pool** (`session-pool.mjs:38–72`).
  - Every reuse does a linear `findLastIndex` + `splice`, then `fill(0)` of **all** of `s`, `ss` and `ka`.
  - One pooled entry is about 75 KB (bench/README.md P9.7). So every small session memsets about 75 KB, roughly 2 µs at memset speed, against a 9.89 µs session (P9.7 default arm).
  - The SDK does the same zero-fill in `sdk.rs:704`.
  - The `scribble` test hook (`sessions.test.mjs:115`) already exists to prove that results do not depend on stale contents. → **H8** (session start is on the sessions hot path).
- **Writer** (`writer.mjs`, 15.9 KB min, the largest module in `snug`, writer and view).
  - Allocations per value:
    - `keys` and `values` arrays per object or Map (`:284`);
    - `getOwnPropertyDescriptor` per key (`:296`);
    - a closure per typed-array value (`:267`);
    - an options spread per tag-24 or tag-4/40 value (`:378/:396`).
  - D113 and WRITER.md already measured the Writer at 2.7–3.5× the baseline on maps.
  - Only the typed-array closure and the tag-24 options spread are clear waste. → **G2**, minor.
  - `writeValue` (`:565`) duplicates `encode` and is used only by a test. esbuild drops it if nothing exports it; check before counting it.
- **Duplicated host helpers.**
  - `bytesInput` appears twice, word for word (`public-schema.mjs:57`, `open-session.mjs:6`: 235 B min, P9.12).
  - `asBytes` (`schema-core.mjs:142`) repeats the same check, so `Schema.validate` checks `instanceof`/SAB twice.
  - `isShared` is defined twice (`view.mjs:42`, `sequence-core.mjs:29`).
  - `clamp` is defined twice (`scan.mjs:16`, `sources.mjs:62`), and **both are in the `snug/sources` bundle**.
  - The `pick(options, [...profile keys])` + limits block is repeated in `sources.mjs:323–327` and `:330–334`.
  - `anyProgram ??= …` appears twice (`sources.mjs:319`, `sequence.mjs:19`).
  → **S4**.
- **Rust host.**
  - `Session::new` and `new_unknown` allocate a 2,088 B `out` Vec per session that is not pooled (`host/rust/src/schema.rs:451/465`). The arrays `s`, `ss` and `ka` are pooled. → **R1**, minor.
  - The crate's `[profile.release]` (`opt-level 3`, `codegen-units 1`) applies only to builds of the crate itself. A consumer's binary uses the consumer's profile, so it gets no LTO and 16 codegen units by default. P9.12 measured snug in consumer binaries with fat LTO, which consumers do not get by default. → **R2**, docs only.

---

## 7. npm module graph and lazy loading

Static graph, from `host/js/package.json` exports and the p920 metafile:

| entry | pulls | notes |
| --- | --- | --- |
| `snug` | writer.mjs 15.9 K, cbor/scan 11.3 K, canon 7.9 K, values, build, stdtags, tags | canon is reached through host `scan.mjs` (`dcCopy`) and gen `scan`; no vcopy, no verify |
| `snug/writer` | writer.mjs 15.9 K, **cbor/scan 11.3 K, canon 7.9 K** | `writer.mjs:14` imports host `scan.mjs` for two rare paths: tag 24 (D358) and tag 4/40 above the Bindle set |
| `snug/view` | nav/walk, scan, canon, **writer.mjs 15.9 K** | `view.mjs:32`: the Writer is used only to encode an *any-kind* map key (`view.mjs:251`) |
| `snug/schema` | **program/verify 27.1 K**, vm/eval 20.5 K, vm/map 13.9 K, vcopy 11.3 K, scan, canon | verify is static only here (`public-schema.mjs:3`) |
| `snug/sources` | vm/eval, scont 17.2 K, map, scan, vcopy, sbase, rscan 9.3 K, session | no verify, view or writer |
| `snug/sequence` | as sources, plus view.mjs → **writer.mjs** | |
| `snug/compile` | 2.7 K static; the compiler is a dynamic `import('./compile-runtime.mjs')` | already lazy |
| `snug/unicode`, `snug/abnf`, `snug/controls` | own entries | already outside the runtime unions |

- **Laziness has a hard limit.** kin emits static ESM imports one-to-one with kin modules. So laziness is only possible at host-module boundaries, and the sync APIs rule out `await import()`:
  - `Writer.value()` is synchronous.
  - `view.get()` is synchronous.
  - `validate` is synchronous (D285: a lazy `vcopy` would need an await).
  That leaves three ways in:
  - (a) **injection**: the caller hands in the capability;
  - (b) **registration**: importing the capability's entry registers it. That is a side effect, which breaks `"sideEffects": false` for that one module;
  - (c) **a narrower synchronous module.**
- **`sideEffects: false` holds** for everything except module-level scratch arrays, `TextDecoder`s, two `FinalizationRegistry`s and `pickYield()` at load. All of these are idempotent, so tree-shaking assumptions hold.
- **Writer → scanner (S1).**
  - About 19.3 KB min (scan 11,312 + canon 7,945; roughly 6–7 KB gzip, estimated with the entry's own min:gzip ratio of 0.34) sits in `snug/writer` for two rare tag paths.
  - Every writer user pays for it, even one that never writes a Tagged(24).
  - Dropping it changes behaviour unless the check moves somewhere else:
    - D358 requires a tag-24 payload to get the decoder's rule;
    - under `tag24: 'valid'` or the non-valid presets that is a *valid* item, so the full scanner.
  - The only behaviour-preserving way is injection or registration, which is an API decision. → **owner decision 1**.
  - The `snug` codec entry already imports the scanner, so it would gain nothing.
- **View → Writer (S2).**
  - About 16–19 KB min (writer.mjs plus the `write/*` modules not shared with view; roughly 5.5–6.5 KB gzip, estimated) sits in `snug/view` and `snug/sequence`.
  - It is only used for any-kind map keys: maps, arrays and floats as keys.
  - Integer and text keys are already encoded inline (`view.mjs:237–247`).
  - Same constraint as S1: the any-key path needs a full deterministic encoder. → **owner decision 1**.
- **Verifier (S3).** 27.1 KB min / 9.3 KB gzip in `snug/schema`. D341 deferred this past the RC. The options are unchanged:
  - a trusted-in-process entry without `program/verify`;
  - a table-driven verifier, estimated 15–30% smaller, which must keep every corruption's first refusal (compile2-test).
  The internal `schema.mjs` already loads verify with a dynamic `import()` (`schema.mjs:11/19`). `schema-core` takes `verify` as an injected option (`schema-core.mjs:60–73`), so the injection seam already exists. → **owner decision 2**.

---

## 8. Things checked and not proposed

- **SDK runtime at opt "s"/"z":** D341 rejected it, and it stays rejected.
- **A generic-only VM (dropping D044 fast paths):** about 3.1 KB gzip, but 2–15× slower (R9 brief). Rejected.
- **A lazy `vcopy`, a deterministic-only scanner, dropping the attempt:** D285 and D341 item 4 stand.
- **Unchecked indexing in the generated Rust (`get_unchecked`):**
  - It would need `unsafe` in the generated code and kin emitter support.
  - snug's Rust is safe today, and that is a security property of a parser for untrusted input.
  - Not proposed. A safe alternative that may remove some checks is K3.
- **Merging rscan into scan:** a speed loss (§3.6).
- **Stripping comments from the shipped JS:** no gate effect (§2).
- **A hash set for duplicate keys:** rejected in D263.
- **Per-call closures in `vmsStep`/`vmValidate`:** the hosts do not call those wrappers (§2).
- **`#[inline]` in the generated Rust:** single-CGU builds already inline (§2).

---

## 9. Candidates

Columns:
- **Gain:** the expected gain and how it was estimated.
- **Identity risk:** the risk to JS == Rust == wasm verdict identity.
- **Effort:** S is under a day, M is a few days, L is a week or more.
- **Measure:** the run that confirms the gain.

Every candidate in a kin file changes gen/js, gen/rust and the wasm modules together, so identity rests on the existing gates (vm-test, valid-test, vmsession-test, sequence-test, compile2-test, crate-diff, wasm-sdk-test).

### 9a. Safe, size-only (or size + perf), off the hot path

| id | location | change | expected gain (method) | identity risk | effort | measure |
| --- | --- | --- | --- | --- | --- | --- |
| S4 | `host/js/src/sources.mjs:62` + `scan.mjs:16` (`clamp`), `sources.mjs:323–334` (`pick` block), `public-schema.mjs:57` / `open-session.mjs:6` (`bytesInput`), `schema-core.mjs:142` (`asBytes`), `view.mjs:42` / `sequence-core.mjs:29` (`isShared`) | one shared helper each | ~100–250 B min in `snug/sources` (the two `clamp`s and the repeated `pick` block, counted from source); 235 B min `bytesInput` in `all-runtime` (P9.12 token scan); gzip folds most of it | none (JS host only; the same checks, the same errors) | S | `bb size` (sources min must drop; the TypeError texts unchanged) |
| S7 | compiler: the duplicated merge sort (386 B min, P9.12) and `lowerMap`/`lowerArray` (232 B min) in `kin/compile/*.kin` | parameterise / share | ~600 B min in `snug/compile` full and some bytes of the wasm cc module (P9.12 token scan; gzip less) | low: the Program bytes must stay identical (compile2-test JS == Rust, the corpus Program hashes) | M | `bb size`, `bb wasm-size`, compile2-test; compile-bench (a sort call per rule: neutral expected) |
| W1 | `kin/scripts/wasm-build` (cc mode) | `wasm-opt -Oz --converge` | 0.5–2% of the cc module (binaryen's usual `--converge` gain on -Oz; **unmeasured**), i.e. ~0.8–3 KB against 54 B of headroom | none (the same Rust; wasm-opt is semantics-preserving) | S | `bb wasm-size`; wasm-sdk-test; compile-bench wasm (the build is slower, the module is not) |
| W2 | `host/wasm/src/cc.rs` (compiler module only) | a smaller global allocator than dlmalloc (8,040 B in the SDK's name section; the cc share is unmeasured) | up to ~4–7 KB of the cc module (dlmalloc's size, assuming a simple allocator replaces it) | none for verdicts; memory behaviour changes (peak and reuse across compiles), so `limit_memory` must stay the arena's | M | `bb wasm-size`; wasm-sdk-test; compile-bench wasm; peak memory over repeated compiles |
| R2 | `docs/rust.md` | recommend `lto = "fat"`, `codegen-units = 1`, `panic = "abort"` to consumers who want P9.12's numbers | consumer speed and size (P9.12 §2: "release" vs "no LTO, unwind": 617 KB vs 762 KB for load+validate) | none | S | none needed (docs); optionally rerun P9.12's consumer binaries |
| S3 | `host/js/src/public-schema.mjs:3`; `kin/program/verify.kin` | a trusted-Program entry, or a table-driven verifier (D341 item 2) | 27,079 min / 9,311 gzip / 7,666 brotli out of `snug/schema` for the entry; 15–30% of the verifier for the rewrite (P9.12 stubbing) | the rewrite: high (every corruption's first refusal must match, JS == Rust); the entry: none, but it drops the load-time check | L | `bb size`; compile2-test; the verifier fuzz |
| S1 / S2 | `writer.mjs:14` → `scan.mjs`; `view.mjs:32` → `writer.mjs` | inject or register the scanner and the any-key encoder | ~19.3 KB min (~6–7 KB gzip est.) from `snug/writer`; ~16–19 KB min (~5.5–6.5 KB gzip est.) from `snug/view` and `snug/sequence` (p920 `bytesInOutput`, gzip by the entry's own ratio) | none for verdicts if the same check runs; **API change** (a tag-24 write or an any-key lookup needs the capability) | M | `bb size`; write-test; nav-test; types-test |

### 9b. Hot path: measure later (each with its neutral-or-better argument)

| id | location | change | expected gain (method) | why it is neutral or better | identity risk | effort | measure |
| --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | `kin/vm-session-base.kin:473 keys-save`, called by `fpush:493` | scan from `sp−1` down and stop at the first map frame (D092: only the top-most map can hold a window key) | removes O(depth) frame checks per container push: ~500 per deepest path at depth 32, ~33,000 at 256 (counted from the loop) | strictly less work, with the same stores, *if* the D092 invariant holds; adds one `break` | low–medium: if the invariant is ever false, a key is lost (an assertion under vmsession-test proves it before the change lands) | S | vmsession-bench / sessions-bench on nested inputs (depth 8, 32, 256); vmsession-test, sequence-test, wasm-sdk-test; `bb size` (sources has 13 B: aim for ≤ 0) |
| H2 | `kin/vm-leaf.kin` `eval-scalars` (gen `leaf.mjs:652`) | skip `charge` when `unit == 0` (schedule 2's one-leaf child, D045) | one call fewer per one-leaf child item, about 1 of the 3+ charge calls such an item makes (counted from the code) | a charge of 0 cannot fail or change a non-negative budget, so verdicts, offsets and `budgetUsed` are identical; it only removes a call | none by construction | S | vm-bench, valid-vm-bench (scalar-heavy rows); vm-test calibration identity; `bb size` (+~10–20 B in every VM entry) |
| H8 | `host/js/src/session-pool.mjs:44`; `host/wasm/src/sdk.rs:704` | zero only what the last lease dirtied (a high-water mark from `ss`/arena top), not all ~75 KB | ~1–2 µs of a 9.89 µs small session (75 KB memset at ~40 GB/s; P9.7 data) | less memset, same contents in every word the VM reads | medium: a session must never read a stale word; the `scribble` test (sessions.test.mjs:115) is the proof tool, extended to scribble *only* above the mark | M | sessions-bench (100,000 small sessions; 64 KiB); the scribble test; wasm-sdk-test |
| G1 | `host/js/src/options.mjs` and its callers (`encode.mjs:22`, `writer.mjs:84`, `schema-core.mjs:172/184`, `public-schema.mjs:76`, `view.mjs:540–551`) | validate each options bag once per call; pass the validated form inward; cache `selectOptions` results per options object where one is reused | a few hundred ns per small call (estimate: one `Reflect.ownKeys` + per-key predicates + `fromEntries` removed per duplicate; RPC encode 4.5 µs, validate 8.3 µs) | removes work only; the same TypeError on the same first bad key | none (JS host only) | S–M | valid-bench / codec RPC rows (small messages); npm-test (option error texts) |
| H6 | `kin/text.kin:86 utf8-invalid-at` | skip 4 bytes (JS) or 8 bytes (Rust) at a time while `(w & 0x80808080) == 0`, then the existing byte loop | ASCII-heavy text: the per-byte branch becomes a per-word one; est. 1.3–2× on the UTF-8 loop and 5–20% on text-heavy scans (`5000 strings`: scan 556 µs) | the same answer: chunks are skipped only when all-ASCII, and the first non-ASCII byte goes through the old loop; the function must stay under V8's 460-byte inline limit (Findings 2026-10-29), so split the chunk loop into its own function if needed | low (the first invalid offset is unchanged by construction; scan-test and proptest compare JS == Rust) | S–M | scan-bench / valid-bench text rows; d005 wasm; **`snug` has 11 B gzip**, so a cap raise under D303 or a cut first |
| H7 | `kin/canon.kin` (`kclass`, `dup-input:558`), `kin/vcopy.kin` (`canon-build:899`, `pw`) | cache each key's class once per key (the scanner's unit records already carry per-map data, D286 D); one `tskip` per pair in `dup-input`; no second `bcopy` when `same == 1`; then re-evaluate D286 option E against the PEG map machine | non-deterministic `valid` input only: today 3.4–6.2× deterministic (D286); est. 10–30% off that from the caches, and E est. ~2× deterministic (D286 E estimate) | deterministic input never enters these paths (the attempt answers first), so the common case is untouched; the canonical path only loses work | **medium–high**: refusal replay (D280), offset identity (D030/D350), deferred-check order (D353) and budget equality under `valid` (D277) all live here | L | valid-vm-bench nondet rows (`rev`, `all`, `ind`, `nsh`); valid-test, vmsession-test, sequence-test, proptest; `bb size` (every VM entry) |
| C1 | `kin/compile/main.kin setup`, `prelude.kin` | lex/parse the prelude once into a constant table, copied into the arena per compile | ~16,600 fixed words of lex/parse per compile (D374); est. 10–25% of a small schema's warm compile | a table copy replaces a lex+parse of the same text | medium: the Program bytes and the source key must be identical (compile2-test, the corpus hashes); a precomputed table must be regenerated with the prelude (one more drift check) | M–L | compile-bench warm/cold (small corpus schemas, prelude-only schema); compile2-test; `bb size` / `bb wasm-size` (the table adds bytes to cc: **54 B headroom**) |
| C2 | `kin/compile/regexp.kin:72 unicode-init` | when the schema has no `\p{…}`, keep the charge `n` but skip validating and copying the 19,257 words | ~19k word pushes and range checks per compile that passes `unicode` | the same charge, so the same `limit_compile_budget` outcomes; less work | low (charge equality kept on purpose; a schema with `\p` takes the old path) | S–M | compile-bench with `unicode` passed; compile2-test; unicode-test |
| W3 | `kin/scripts/wasm-build` (sdk mode) | `wasm-opt -O3 --converge` or `-O4` | unknown; may be ±1% size, 0–3% speed | more optimisation of the same semantics, kept only if d005 says neutral or better (the D341 method: 58 rows, 5 interleaved rounds) | none | S | `bb wasm-size`; d005 `--quick --wasm` against the shipped module |
| W4 | `kin/scripts/wasm-build` (sdk mode): `-C target-feature=+simd128`, `--enable-simd` | let LLVM vectorise the copies and the UTF-8 and compare loops | unknown (unmeasured) | more instructions available; kept only if d005 shows neutral or better | none (the same Rust) | S (+ owner decision 3) | d005 `--quick --wasm`; the SDK's supported-runtime list |
| H5 | `kin/head.kin read-arg` → `scan.kin item` | return the argument in locals rather than `o[O_HI]`/`o[O_LO]` (if kin can express it) and hoist `o[O_PROFILE]` into a local once per map | 2 stores + 2 loads per long head; up to 4 profile loads per key on valid / non-text-key maps | fewer memory ops; `read-arg` must stay under V8's 460-byte inline limit | low | M (kin expressiveness) | scan-bench, vm-bench item-heavy rows; d005; **`snug` 11 B gzip** |
| R1 | `host/rust/src/schema.rs:451/465` | take `out` from the pooled arrays | one 2,088 B allocation fewer per Rust session | less allocation | none | S | sessions bench (Rust) |
| G2 | `writer.mjs:267` (closure per typed array), `:378/:396` (options spread per tag) | hoist the closure; compute the decode options once per Writer | an allocation per typed-array or tag-24 value | less allocation | none | S | writer-bench typed-array rows |

### 9c. Kin emitter (kin is read-only here: "Found in kin" suggestions, owner and kin side)

| id | pattern | gain | risk | measure |
| --- | --- | --- | --- | --- |
| K1 | drop `\| 0` after `>>> k` (k ≥ 1) and emit `~x` for `x ^ -1` | ~370 B min across `all-runtime` (D341), spread over every entry, including the tight ones | none (V8 folds both; size only) | `bb size` |
| K2 | emit literal case labels (or inline imported constants) in JS `switch`es (`evalLeaf`) | possibly a jump table in Ignition/TurboFan (unverified) | none | vm-bench leaf-heavy rows; check the bundled output first: esbuild may already inline the constants |
| K3 | safe bounds-check elision in Rust: re-slice to a known length once per function (`let s = &mut s[..N]`), or `assert!(len >= HDR)` before header loads | fewer bounds checks in native and wasm (est. 0–10% in VM-heavy rows; unmeasured) | none for verdicts (still safe Rust) | d005 native + wasm; crate-diff |

---

## 10. Ranking

Expected value is set against risk and effort, best first in each group.

**Safe, size-only, off the hot path**

| rank | id | value | risk | effort | why this rank |
| ---: | --- | --- | --- | --- | --- |
| 1 | W1 | high: buys the cc module out of 54 B | none | S | the next compiler fix needs it |
| 2 | S4 | medium: `snug/sources` out of 13 B | none | S | the next sessions change needs it |
| 3 | R2 | medium (consumers) | none | S | docs only |
| 4 | S7 | medium: compile full (11 B gzip) and cc | low | M | relieves the compile caps |
| 5 | W2 | medium | low | M | the largest cc lever after W1 |
| 6 | S1 / S2 | high (≈ 6 KB gzip each, est.) | API change | M | needs owner decision 1 |
| 7 | S3 | high (9.3 KB gzip) | high (rewrite) / API (entry) | L | needs owner decision 2; D341 deferred it |

**Hot path, needs measurement**

| rank | id | value | risk | effort | why this rank |
| ---: | --- | --- | --- | --- | --- |
| 1 | H2 | low–medium (every one-leaf child item, every VM entry; TurboFan may already inline `charge`) | none by construction | S | identical outcomes |
| 2 | H1 | medium (sessions, deep input; quadratic → linear) | low–medium | S | prove the invariant first |
| 3 | G1 | medium (small-message calls) | none | S–M | host only |
| 4 | H8 | medium (small sessions, ~10–20%) | medium | M | the scribble test is the proof |
| 5 | C2 | low–medium (compiles with `unicode`) | low | S–M | |
| 6 | H6 | medium (text-heavy) | low | S–M | blocked by `snug`'s 11 B gzip cap |
| 7 | W3 | unknown | none | S | a measurement, not a change |
| 8 | C1 | medium (small compiles) | medium | M–L | adds bytes to cc |
| 9 | H7 | high on non-deterministic `valid` input only | medium–high | L | the riskiest code in the tree |
| 10 | H5, R1, G2 | low | low | S–M | |

**Kin emitter:** K1 first (size, no risk, every entry), then K3, then K2.

---

## 11. Owner decisions

1. **S1/S2: sync capability injection.** Should `snug/writer` and `snug/view` stop carrying the scanner (writer) and the Writer (view) for their rare paths? That needs either an injected capability or a registration import, which is a side effect in one module. Without it, those bytes stay, and both are about 6 KB gzip, estimated.
2. **S3: the verifier.** D341's deferral was "past the RC". Is it now a trusted-Program entry, a table-driven rewrite, or left as it is?
3. **W4: `simd128` in the SDK runtime.** This is a runtime-compatibility floor: Safari 16.4+ and Node 16.4+. Should it be allowed for speed?
4. **Cap policy for hot-path speed work.** H5/H6 grow the scanner, and `snug` has 11 B of gzip headroom. Is a measured speed gain a standing reason to raise a cap under D303 (as D374 was), or must a cut come first?
5. **K1–K3:** these are for kin, outside this repository.
