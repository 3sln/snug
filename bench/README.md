# JS host codec measurements

Measured 2026-10-29. Commands (from the snug root):

```sh
node bench/choices.mjs
node bench/codec.mjs
cd host/js && node --test test/
```

Machine: Apple M1 Pro, arm64 MacBook Pro (10 cores, 32 GiB RAM), macOS
14.6.1 (23G93), Node v24.6.0, V8 13.6.233.10-node.24. The requested
`sysctl -n machdep.cpu.brand_string` was attempted and refused by the sandbox
(`Operation not permitted`); CPU model comes from `os.cpus()[0].model`.
macOS version was read with `sw_vers`; runtime with `node --version`.
No dependencies, network access, or installations are involved.

## Method

Baseline: the unchanged `baseline/cbor-3sln.mjs` snapshot, byte-identical to
`../3sln.me/packages/core/cbor.mjs` when checked in this session. Both codecs
receive the same options and values, translating only the wrapper class
identities (`BindleDecimal` ↔ `Decimal`, `NDArray`, `Float16Bytes`). Fixture
creation, baseline validation, wrapper translation and answer comparisons
are outside the timing region.

Each workload runs four operations: snug build, baseline strict decode,
snug encode and baseline encode. After three interleaved warmup rounds,
each operation is calibrated once for a target 15 ms sample (1–2,000
iterations; small workloads can fall below the target). Nine samples follow,
rotating the order of the four operations on each round. Results are medians
of elapsed milliseconds per workload, with no forced GC. Each warm fixture
is checked before measurement and each timed sample's final answer is
checked afterward: deep equality for values and byte equality for encodings.
The vector row is one complete batch of 389 inputs, not a per-vector time.
The final codec and primitive measurements were run sequentially.

**build is trusted build-only time. Public decode = scan + build.** The
generated scanner is unavailable, so these numbers do not measure snug
strict decode and cannot settle D017's two-pass cost question. Baseline
decode includes all profile checks; this difference accounts for part of
the apparent build speedup, especially float-array NaN scanning.

The 120,000-element array exceeds the default 65,536-entry limit; the two
map-heavy workloads exceed the default item count. Those three cases use
`maxEntries: 120000, maxItems: 500000, maxBytes: 1500000` on both codecs.
Other workloads retain the defaults (`top: 'any'` for baseline decode).
The small put is an actual envelope with a byte-string argument adjusted
to exactly 287 encoded bytes. Its large counterpart holds 1 MiB of bytes.
The short-key case contains 10,000 maps with eight ASCII keys and mixed
scalar values. The document contains 10,000 records with nested metadata
maps and text bodies, plus a final padding string to reach 1,400,000 bytes.

## Results

Times are milliseconds. Speedup = baseline time / snug time; below 1 means
snug was slower in that measurement.

| Workload | Bytes | build ms | baseline decode ms | build speedup | encode ms | baseline encode ms | encode speedup |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| vectors (74 profile + 315 oracle) | 71387 | 0.8683 | 1.4424 | 1.66x | 1.5172 | 2.2658 | 1.49x |
| RPC put 287 B | 287 | 0.0019 | 0.0049 | 2.63x | 0.0045 | 0.0106 | 2.35x |
| RPC put + 1 MiB bytes | 1048786 | 0.1395 | 0.1617 | 1.16x | 0.4035 | 0.4602 | 1.14x |
| 120000 integers | 468653 | 1.1449 | 2.4511 | 2.14x | 10.3233 | 10.9919 | 1.06x |
| 1 MiB Float64Array | 1048583 | 0.1434 | 0.5050 | 3.52x | 0.8751 | 0.7177 | 0.82x |
| 1 MiB BigInt64Array | 1048583 | 0.1466 | 0.1527 | 1.04x | 0.4261 | 0.4348 | 1.02x |
| 10000 maps x 8 short keys | 359723 | 4.0060 | 28.7495 | 7.18x | 17.9178 | 62.4214 | 3.48x |
| map-heavy document 1.4 MB | 1400000 | 10.3653 | 35.1128 | 3.39x | 27.6785 | 75.6380 | 2.73x |

Iterations per sample, in column order (build / decode / encode / baseline
encode): vectors 15/5/9/6; small RPC 1500/1500/1500/1233; large RPC
241/42/46/46; integer array 16/8/2/2; Float64Array 350/26/18/21;
BigInt64Array 104/109/47/42; short-key maps 5/1/1/1; document 2/1/1/1.

The largest improvements occur on maps: the builder uses safe assignment
for null-prototype maps and defines `__proto__` specially for plain maps;
the encoder avoids a Writer and encoded byte buffer for every ASCII key.
Integer-array encoding remains dominated by the baseline-compatible dense
array inspection. BigInt64 bulk copying is approximately at parity.
Float64Array encoding was **22% slower** here (0.8751 vs 0.7177 ms); no
universal encoder speedup is claimed. Its NaN checks remain mandatory.

## Primitive choices

`choices.mjs` measures nine interleaved samples, 100,000 iterations/sample,
after 10,000 warmup calls per variant, checking answers outside timing.
Results are ns/op; microbenchmarks isolate primitives rather than predicting
whole-codec speedups.

| ASCII bytes | String.fromCharCode loop | TextDecoder with subarray |
| --- | ---: | ---: |
| 4 | 34.1 | 94.9 |
| 8 | 64.0 | 89.2 |
| 16 | 116.8 | 84.8 |
| 32 | 216.2 | 89.4 |
| 64 | 399.9 | 132.6 |
| 128 | 852.8 | 120.2 |

The builder therefore uses the ASCII loop only up to **8 bytes**, falling
back to TextDecoder on any non-ASCII byte and on longer strings. BOM is
preserved (`ignoreBOM: true`).

Uint32 byte arithmetic / DataView / allocated head tuple: **5.7 / 5.6 /
11.9 ns/op**. Arithmetic and DataView are effectively tied; the builder
keeps direct arithmetic and never creates a head tuple. Safe uint64 direct
arithmetic / `getBigUint64` then Number: **10.8 / 25.2 ns/op**. The builder
uses the arithmetic fast path when the high word is at most `0x1fffff`,
materializing bigint only beyond the safe range (including major-1's
negative boundary adjustment).

## Tests and outstanding scanner work

Final `cd host/js && node --test test/`: **585 tests, 430 passed, 155
skipped, 0 failed**, 278.435959 ms on this run. This includes 74 profile
accepts, 315 profile-valid cborg accepts, encoder and wrapper refusals,
1,000 seeded differential maps/values in both object modes and COSE mode,
unaligned Buffer input, fresh typed-array copies, and a separate-process
Float16Bytes fallback check.

The skips are 142 profile refusal vectors, 12 cborg/profile disagreements,
and one seeded mutation/truncation property. The cborg fixture contains
327 accepts, but 12 deliberately belong to the broader cborg profile:
non_shortest (2), key_order (2), float (3), bignum (2), typed_array (1),
text (2). The unchanged strict baseline refuses those 12, so feeding them
to the trusted builder would violate its contract. They remain visible as
individual scanner-dependent refusal tests. Scanner integration and full
decode benchmarks remain pending; `decode` currently throws
`SnugFault('unavailable')`. The adapter has a provisional null/undefined
success and code-string/`{code}` failure ABI and refuses unknown verdict
shapes until the generated API is wired.

## CDDL compiler (P3.2/P3.3)

Compile timings (cold and warm, JS and native), hostile schemas against the
compile budget, and the compiler's bundle size are in `bench/COMPILE.md`,
with machine, OS, runtime versions and method (`node bench/compile-bench.mjs`).

Views and cursor (P5, architecture §16.7): open + one field (owned and
borrowed), field reads, cursor walks, random access with and without child
directories, full materialisation and memory per view are in `bench/VIEW.md`
(`node --expose-gc bench/view-bench.mjs`).


## Unicode table module (P7.3)

Measured 2026-11-03 on Apple M1 Pro, arm64, macOS 14.6.1 (23G93), Darwin
23.6.0. Node v24.6.0, V8 13.6.233.10-node.24, ICU 77.1, Unicode 16.0,
zlib 1.3.1-470d3a2; esbuild 0.28.2. Commands:

```sh
node tools/unicode/gen-tables.mjs --check
node tools/unicode/measure.mjs bench/compare/node_modules/.bin/esbuild
```

The already available benchmark esbuild binary was used read-only; no
network or installation. The measurement script reports machine/runtime
versions, bundles the whole `snug/unicode` entry as ESM with `--minify`, and
uses Node `gzipSync` with level 9. Headers and whitespace are included in
source sizes and removed by esbuild for the minified size. All exported
metadata is retained. This measures the optional module alone, not the
compiler or a runtime bundle.

| Artifact | Bytes |
| --- | ---: |
| JS generated source (base64 varints + decoder + metadata) | 19,875 |
| JS complete module, minified | 19,377 |
| JS minified + gzip-9 | 9,287 |
| Rust generated source (same packed bytes + decoder + metadata) | 37,361 |
| Packed range data (before base64/source syntax) | 14,109 |
| Decoded Int32 triples (both hosts; 6,419 ranges) | 77,028 |

Data is generated by testing every code point against each general category
in the pinned Node ICU, excluding surrogates. It covers 37 category names
including empty Cs. Deltas encode each range as a gap from the previous hi
plus one, followed by its span; unsigned base-128 varints encode counts,
category ids, gaps and spans. Programs contain only the compiled automata;
there is no runtime table-module import. Temporary decode arrays and compiler
arena memory are outside the decoded-Int32 figure; no peak-memory claim.
