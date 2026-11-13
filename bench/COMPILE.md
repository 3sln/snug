# CDDL compiler measurements (P3.2/P3.3)

Measured 2026-10-29 on the compiler at the commit that adds this file.

```sh
node bench/compile-bench.mjs 15 21          # JS: cold, warm, hostile, size
kin/scripts/compile-crate .cache/snug-compile-rel
(cd .cache/snug-compile-rel && cargo build --release --bin compile-bench)
.cache/snug-compile-rel/target/release/compile-bench 15 corpus/cddl-study/contracts/*.cddl
```

## Environment

Apple M1 Pro (10 cores, 32 GiB), macOS 14.6.1 (23G93), Node v24.6.0 (V8
13.6.233.10-node.24), rustc 1.92.0 (Homebrew). The machine was shared and
loaded (load average 10–16 during the runs; other agents were building),
so absolute numbers are pessimistic; medians are reported to damp that.
esbuild from a sibling 3sln.me checkout's `node_modules` (read-only) for bundle
sizes; gzip -9 and brotli 11 by Node's zlib.

## Method

* **Cold**: a fresh `node` process per run imports `host/js/src/compile.mjs`
  and compiles one contract once; import and first compile are timed inside
  the child with `performance.now()`; median of 15 runs.
* **Warm**: one process compiles every contract 300 times, then per contract
  21 samples of a loop calibrated to ~20 ms; median per-compile time (min).
* **Hostile**: one warm compile each of schemas built to spend the compile
  budget or reach a limit; wall time and compile budget units spent.
* **Native**: the Rust release build (`host/rust/src/bin/compile-bench.rs`),
  same warm-up and sampling.

## Results

### Study contracts

| contract | bytes | words | pool | cold import | cold first compile | warm JS median (min) | warm Rust median | budget units |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| event-bus-tasks | 303 | 308 | 72 | 7.97 ms | 7.75 ms | 189 µs (183 µs) | 50.5 µs | 1 321 |
| item-classification-v1 | 1 095 | 2 197 | 238 | 8.00 ms | 18.91 ms | 1.95 ms (1.90 ms) | 494.4 µs | 43 415 |
| ledger-numeric | 433 | 702 | 77 | 8.20 ms | 10.20 ms | 311 µs (302 µs) | 85.8 µs | 2 641 |
| object-storage-v1 | 1 753 | 2 057 | 461 | 8.01 ms | 11.49 ms | 664 µs (642 µs) | 193.0 µs | 6 602 |
| preferences-v2 | 836 | 1 276 | 214 | 7.98 ms | 12.89 ms | 707 µs (684 µs) | 177.4 µs | 9 948 |
| signaling-message-v1 | 1 125 | 2 463 | 333 | 8.56 ms | 14.17 ms | 1.05 ms (1.01 ms) | 261.7 µs | 17 363 |

Every contract compiles in well under 10 ms in Node after warm-up (the
slowest, item-classification with four I-Regexps, 1.95 ms); the first
compile in a fresh process, which pays for JIT warm-up, takes 8–19 ms.
Native Rust is 3.5–4× faster than the generated JS.

### Hostile schemas (default limits; JS, warm)

| schema | outcome | wall | budget units |
| --- | --- | ---: | ---: |
| instantiation bomb `g<T> = [g<[T, T]>]` | limit_instantiations | 18.16 ms | 73 789 |
| 30 independent optional choices in one map | limit_alternatives | 561 µs | 1 804 |
| a 4 000-member map | ok (48 140 words) | 45.08 ms | 460 694 |
| a 10 000-rule alias chain | limit_nesting | 32.21 ms | 113 426 |
| nesting 64 deep | limit_nesting | 140 µs | 489 |
| `[0*1048576 uint]` (one counter) | ok (126 words) | 200 µs | 714 |
| `[? uint, 200*250 uint]` (unrolled to 251 positions) | ok (2 645 words) | 527 µs | 6 022 |
| a 256-position regexp | ok (2 204 words) | 564 µs | 17 918 |
| 20 000 text literals in one choice | ok (40 090 words) | 119.36 ms | 796 460 |
| 20 000 integer literals in one choice | ok (120 090 words) | 98.17 ms | 952 754 |
| a 255 KiB schema of 2 000 maps | ok (314 109 words) | 148.07 ms | 2 343 432 |

The default compile budget is 10 000 000 units; the costliest schema found
spends a quarter of it in 150 ms. Before this measurement the 10 000-rule
chain overflowed the host stack (the alias resolver recursed), 20 000 text
literals took 12 s (an uncharged quadratic literal grouping), and the
4 000-member map ran out of arena (pairwise alternative products); all
three were fixed (iterative resolver, n log n canonicalisation, an n-ary
product) — see DEVLOG P3.2/P3.3.

### Size (esbuild, one ES module)

| artefact | raw | gzip -9 | brotli 11 |
| --- | ---: | ---: | ---: |
| compiler (`host/js/src/compile.mjs` + `gen/js/snug/compile/*`), bundled | 276 278 | 55 725 | 45 550 |
| compiler, bundled + minified | 118 693 | 38 257 | 32 861 |
| verifier (`gen/js/snug/program/verify.mjs`), bundled + minified | 20 622 | 7 539 | 6 543 |

Compiler sizes re-measured after container canonicalisation (commit
`d450b56`, +8 KB minified, +3 KB gzip). The same commit shrinks
signaling-message-v1 from 2 463 to 2 427 words (its two `{ * tstr => any }`
share one map leaf); the other contracts' Programs are unchanged. A quick
re-run of the warm loop (200 compiles after 300 warm-up, same loaded machine,
no sampling) gave 0.23–2.2 ms per contract, within the noise of the table
above, plus or minus about 15 %.

The compiler is a separate, lazily loadable module (architecture R9): a
runtime-only bundle that validates with Programs compiled elsewhere does not
ship it. The verifier belongs to the runtime (it runs at Program load).
