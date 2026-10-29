# P1.4 — the D005 gate: generated JS vs hand-written JS vs wasm

Recorded 2026-10-29 by the Phase 1 engineer. Reproduce with
`bb bench-scan [rounds] [cold samples]` (this run: `bb bench-scan 21 21`).
`bench/README.md` (codec benchmarks) is another work item's file; scanner
numbers live here.

## What is compared

| | what | source |
| --- | --- | --- |
| **gen** | the kin-generated JS scanner | `gen/js/snug/cbor/scan.mjs` (+ 6 sibling modules), from `kin/*.kin` |
| **hand** | a hand-written JS scanner, same algorithm and check order | `bench/scan-hand.mjs` |
| **wasm** | the same kin source, generated to Rust, built for `wasm32-unknown-unknown`, timed **including the copy of the input into linear memory** | `host/wasm/src/lib.rs`, `kin/scripts/wasm-build` |
| **cbor** | 3sln.me's `cbor.mjs` `decode` (builds the values — context, not a competitor) | `bench/baseline/cbor-3sln.mjs` |

All four answers are checked before timing (every variant must give
cbor.mjs's code on every input), and gen, hand, Rust and wasm are all held to
cbor.mjs's code by `bb scan-test` (vectors, edge cases, seeded mutations).

**hand** is written the way a person writes a fast JS scanner: head argument,
item counter and limits in module-level variables, common head paths inlined,
refusals as negative returns, no error offsets. A first draft threw a code on
refusal (cbor.mjs's style); V8's throw made it ~9× slower than gen on the
refusal-heavy vector set (73 µs vs 8.5 µs), so the yardstick was rewritten to
be the stronger one.

**wasm** ABI: no wasm-bindgen, no imports, no allocator; a static 2 MiB input
buffer (`snug_buf`, `snug_cap`), `snug_scan(len, options…) → code`,
`snug_err()`. Built with std from source and `panic=immediate-abort` (the
scanner never panics), LTO, one codegen unit, stripped. The opt-level 3 module
is the one timed; an opt-level "z" module is reported for size. No `wasm-opt`
was available offline.

## Environment

- CPU: Apple M1 Pro (10 cores); **shared machine, load average 13–20 during
  the run** (other agents' builds), so times are **process CPU time**
  (`process.cpuUsage`), not wall time.
- OS: macOS 14.6.1 (23G93)
- Node v24.6.0 (V8 13.6)
- wasm toolchain: rustc 1.100.0-nightly (215a8af4b 2026-09-15) with rust-src;
  native Rust for the gates: rustc 1.92.0 (Homebrew)
- esbuild 0.28.2 and workerd 2026-10-06 (3sln.me's `node_modules`, used read-only)

## Method

Throughput (`bench/scan-bench.mjs`): per input, each variant's batch is sized
to ~40 ms of CPU; 3 warm-up rounds; then 21 rounds in a rotating order; the
figure is the **median over rounds of CPU time per call** (min also shown).
gen fills its options array once per options object, as a host adapter does.

Inputs (cbor.mjs-encoded): the 216 profile vectors (74 accept, 142 refuse;
`top: 'any'`); a 287-byte RPC-like `put`; the same `put` carrying a 1 MiB
byte string; a map holding a 120,000-integer array (`maxEntries` raised to
2^20 for it, on every variant); a map of 1 MiB of typed arrays (f32, f64,
i16); 9,000 maps of 12 short text keys each, ~1.1 MB (`maxItems` raised to
2^24 for it).

## Throughput

| input | gen | hand | wasm | cbor | gen / hand | gen / wasm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| vectors (216 profile vectors, all) | 8.1 µs | 6.5 µs | 14.3 µs | 1.42 ms | 1.26× | 0.57× |
| RPC put, 287 B | 0.8 µs | 0.7 µs | 0.4 µs | 5.8 µs | 1.18× | 2.03× |
| RPC put with 1 MiB bstr, 1,048,856 B | 0.9 µs | 0.7 µs | 21.9 µs | 236.8 µs | 1.22× | 0.04× |
| 120,000-int array, 584,247 B | 1.55 ms | 1.64 ms | 0.90 ms | 2.82 ms | 0.94× | 1.71× |
| 1 MiB typed arrays (f32, f64, i16), 1,048,610 B | 184.6 µs | 179.6 µs | 115.3 µs | 645.7 µs | 1.03× | 1.60× |
| nested maps, short text keys, 1,107,041 B | 6.01 ms | 5.51 ms | 2.93 ms | 95.85 ms | 1.09× | 2.05× |

Minimum over rounds gives the same ratios within 0.04 (vectors 1.26×, put
1.18×, bstr put 1.18×, ints 0.92×, typed 1.00×, maps 1.09×). Across four full
runs on the day the gen/hand ratio for the vector set ranged 1.19–1.27×.

## Size

| artefact | raw | gzip -9 | brotli 11 |
| --- | ---: | ---: | ---: |
| generated JS scanner, bundled (esbuild, not minified) | 18,950 | 4,421 | 3,920 |
| generated JS scanner, bundled + minified (full API incl. `codeName`) | 7,601 | 2,935 | 2,644 |
| generated JS scanner, bundled + minified, **the wasm's API surface** (`scan`, `scanOptions`, `errorOffset`) | 6,736 | 2,584 | 2,345 |
| hand-written JS scanner, minified | 5,526 | 2,309 | 2,096 |
| cbor.mjs (whole codec, minified; context) | 16,618 | 6,076 | 5,455 |
| wasm, opt-level 3 (the one timed) | 6,630 | 3,004 | 2,698 |
| wasm, opt-level "z" | 5,190 | 2,582 | 2,382 |

Compressed with node's zlib. The ~10 lines of JS glue a wasm consumer also
ships are not counted. Before `panic=immediate-abort` and the allocator-free
ABI the opt-level 3 module was 23,538 bytes raw (9,709 gzip): std's panic and
allocation machinery, not the scanner.

## Cold start

Node (`bench/scan-cold.mjs`): a fresh process per sample; time from before
loading the scanner to the end of its first call on the 287-byte put (Node's
own startup excluded). 21 samples each, interleaved.

| variant | median ms | min ms |
| --- | ---: | ---: |
| gen, as generated (7 ES modules) | 2.99 | 2.59 |
| gen, bundled into one file | 1.43 | 1.36 |
| hand | 1.47 | 1.34 |
| wasm (read file + compile + instantiate + copy + scan) | 0.75 | 0.52 |

workerd (`bench/scan-cold-workerd.mjs`): workerd freezes `performance.now()`
between I/O, so nothing can be timed inside a worker; this is spawn-to-first-
response of `workerd serve` per worker, 21 samples each, interleaved.

| worker | median ms | min ms | median − empty |
| --- | ---: | ---: | ---: |
| empty (holds the input) | 18.3 | 14.2 | 0.0 |
| bundled gen JS | 18.4 | 15.5 | 0.1 |
| wasm (module binding) | 18.3 | 15.4 | −0.0 |

Process start dominates; earlier runs gave +2.3/+0.4, −0.1/+1.4 and +1.1/+2.8
ms for js/wasm. **Both are within the noise (±2 ms) of an empty worker.**

## Where the generated JS spends its time (profiling, `--cpu-prof`)

- Int array: before P1.4, `readArg` was 522 bytes of bytecode, over V8's
  460-byte inlining limit, and took 42% of the time as a call per head. It was
  rewritten in the kin source to 339 bytes (one truncation check, one
  shortest-form check), now inlines into the item walk, and the input went
  from 2.12 ms to ~1.6 ms. The same source change applies to Rust and wasm.
- Nested maps: `item` (450 bytes) is not inlined into `scanMap` (412) — the
  cumulative budget — so each key and value is a call; hand-written has the
  same structure and the same limit (~10% apart).
- Small inputs: the remaining gap (0.1–0.2 µs per call) is the integer ABI:
  options and the item counter live in an `Int32Array` (`o`), every refusal
  records an error offset through `fail`, and `scan` resets two slots. hand
  keeps these in module variables and records no offsets.

## Verdict on D005 (provisional; the owner signs off)

D005 keeps the JS target if (1) the generated scanner is no worse than 1.25×
the hand-written one and (2) the JS is smaller than the wasm build after gzip.

1. **Speed: met on every input that does real work, at the line on the tiny
   ones.** 0.94–1.09× on the int array, typed arrays and nested maps;
   1.18–1.22× on the two RPC puts; the 216-vector set measured 1.26× in this
   run (1.19–1.27× across runs) — 0.01 over the line, ~1.6 µs per 216 calls.
   Strictly read, that input fails by a hair.
2. **Size: met against the timed wasm, a tie against the size-optimised one.**
   Like-for-like API: JS 2,584 gzip vs wasm 3,004 (O3) and 2,582 ("z").
   With the full JS API (the `codeName` table): 2,935, larger than the "z"
   module, smaller than the O3 one.

So the criteria as written are **met at the margin, not decisively.** And they
miss the largest effect measured: **the wasm build is 1.6–2.1× faster than both
JS scanners on the item-heavy 0.6–1.1 MB inputs and 2× faster on the small
put**, with no cold-start penalty in Node or workerd. JS wins only where the
copy into linear memory dominates (a 1 MiB byte string: 0.9 µs vs 22 µs) and
on many tiny refusals. (wasm's known costs — linear memory that does not
shrink, here a fixed 2 MiB buffer; a trap ends the instance; a separate module
type in Workers — are not measured here.)

Recommendation: keep the JS target for now (it is correct, gated against
cbor.mjs on four implementations, never panics or reads out of bounds, and the
generator costs ≈ hand-written within ~10% on real work), and re-take D005
after the VM exists with the throughput gap to wasm as an explicit input — the
current criteria compare generated JS with hand-written JS, and on this
evidence the stronger alternative for large bodies is wasm, not hand-written
JS. Not signed off.
