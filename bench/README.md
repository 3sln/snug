# JS host codec measurements

## Current evidence index — 2026-11-03

This index points to recorded snapshots; no new performance measurements
were run for the documentation fixes. Do not add component sizes or treat
trusted build-only timings as public decode. Revision is stated where the
record supplies one; “worktree” is not a reproducible clean revision.

| Date / revision | Operation or artifact measured | Ownership / boundary | Runtime and record |
| --- | --- | --- | --- |
| 2026-11-03 / `f1a78c0` | P7.1 profile options: this tree under each preset vs the pre-P7.1 tree `c37eaaf` (decode, scan, encode; 8 workloads) | Same public calls on both arms; one preset per process; Bindle arm with `strictArrays: false` (D113 measured separately) | Node v24.6.0, thread CPU; [P7.1 below](#profile-options-p71) |
| 2026-11-03 / `f275938` | **Full public runtime bundle:** codec + schema + view + writer + sources, no compiler; 155,193 minified / **56,226 gzip-9 bytes** | Staged package, all five runtime entries together; no fixtures; esbuild 0.28.2, not an internal-core size | Node v24.6.0; [P7.7 sizes/method](../tools/runtime/README.md#sizes-esbuild---minify-bytes) |
| 2026-11-03 / `f275938` | Public decode, encode, validate, schema.decode, checked view + lookup, Program load, compile, profile handle scan; 976 conformance checks per arm | Decode builds copies; checked view owned by default; staged package in fresh consumers; compiler/precompiled arms separate | Node v24.6.0, Chrome 156.0.8078.80, workerd 2026-11-02 and repeat 2025-12-17; [P7.7](../tools/runtime/README.md). Later Unicode/schema sources not tested there |
| 2026-11-03 / D113 worktree (clean revision not recorded) | encode and Writer.value array-policy follow-up; gate 1,051 passed, 0 failed/skipped | Input values reused; output ownership/hand-off described in record; strictArrays compared separately | Node v24.6.0; [WRITER D113](WRITER.md#d113--array-elements-by-default-strict-arrays-opt-in--2026-11-03), supersedes mandatory-array-enumeration status |
| 2026-11-03 / P6.2 worktree (clean revision not recorded) | Resumable VM vs buffer validation | Reused low-level session storage and zero-copy subarray windows; **not** allocating public async-handle facade | Node v24.6.0; [VM P6.2](VM.md#p62--the-resumable-session-vs-the-buffer-driver) |
| 2026-11-03 / P7.3 worktree (clean revision not recorded) | Optional Unicode table module, 19,377 minified / 9,287 gzip-9 bytes | Complete exported module only; 77,028 decoded range bytes exclude temporary/compiler storage | Node v24.6.0 / ICU 77.1, esbuild 0.28.2; [method below](#unicode-table-module-p73) |
| 2026-11-03 / JS worktree between `0f85e8e`–`d034d68`; Rust/wasm `0f85e8e` | Public JS codec/schema comparisons and package size boundaries | Per-operation checking/ownership and competitor policy differences in record | Node v24.6.0, native/Rust/wasm versions in [comparison record](compare/README.md) |
| 2026-10-29 / `5501952` | Checked view/cursor, selective lookup and full materialisation vs decode | Owned copy and borrowed modes separate; repeated lookup excludes open/check | Node v24.6.0; [VIEW](VIEW.md) |
| 2026-10-29 / P3.6 snapshot (clean revision not recorded) | VM validation, schema.decode and schedule-2 budget calibration | Validation borrows synchronous input; decode includes VM then builder; not a universal deadline guarantee | Node v24.6.0; [VM P3.6](VM.md#p36--vm-performance-and-budget-calibration) |
| 2026-10-29 / original codec snapshot (clean revision not recorded) | Trusted build-only, encode and primitives below | Build omits scanner; baseline decode includes checks | Node v24.6.0; archived tables below |

All these measurement records identify Apple M1 Pro / macOS 14.6.1 and their
sampling methods and load; consult each before comparing numbers. The
original scanner-unavailable status below is archival, not today's API.

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

> **Archive — 2026-10-29:** the following method/status describes the early
> build-only snapshot. The scanner now works; use the evidence index above
> for checking-plus-building decode and current package size boundaries.

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

> **Archive — 2026-10-29:** this entire section records the former partial
> codec and scanner-unavailable state, including skipped tests and
> `decode` throwing `unavailable`. It is preserved as historical evidence;
> it does not describe the current codec. See the dated gate/runtime records
> in the current evidence index above.

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

## Profile options (P7.1)

**Question:** does the Bindle preset cost anything after P7.1, and what does
the deterministic preset cost? **Machine:** Apple M1 Pro, macOS 14.6.1,
32 GiB, **shared** (1/5/15-minute load average 8–9 / 21–25 / 35–38 during
the runs). **Runtime:** Node v24.6.0 (V8 13.6.233.10), `--single-threaded-gc`.
**Method:** `node --single-threaded-gc bench/profiles-bench.mjs <base> <preset> 11`
with `<base>` a detached worktree of `c37eaaf` (the last commit before
P7.1), tree `f1a78c0`. Each process runs one preset (V8 inlines differently
when a process exercises both presets' paths; a library process uses one)
and interleaves the base arm and this tree's arm, rotated each round;
`process.threadCpuUsage`, µs per call, median of 11 trials; answers checked
equal across the arms first. Three processes per preset; the table gives the
three ratios (this tree / base) and their median. Option objects are built
outside the timed calls. The Bindle arm passes `strictArrays: false`, as the
base encoder behaves; the preset's own-key check is D113's cost
([WRITER](WRITER.md#d113--array-elements-by-default-strict-arrays-opt-in--2026-11-03)).

| Workload | op | Bindle / base (3 runs) | median | deterministic / base (3 runs) | median |
| --- | --- | --- | ---: | --- | ---: |
| RPC put (small) | decode | 1.043 1.076 1.065 | 1.065 | 1.012 0.959 0.997 | 0.997 |
| RPC put (small) | scan | 0.909 0.956 0.977 | 0.956 | 1.007 0.979 0.997 | 0.997 |
| RPC put (small) | encode | 1.042 1.046 0.879 | 1.042 | 1.160 1.003 1.042 | 1.042 |
| RPC put + 1 MiB bytes | decode | 0.674 0.965 1.106 | 0.965 | 1.295 1.149 1.072 | 1.149 |
| RPC put + 1 MiB bytes | scan | 1.014 1.017 0.946 | 1.014 | 0.941 0.990 1.018 | 0.990 |
| RPC put + 1 MiB bytes | encode | 1.129 1.033 1.280 | 1.129 | 0.972 0.809 0.950 | 0.950 |
| 120000 integers | decode | 1.033 0.988 1.001 | 1.001 | 1.043 1.008 0.986 | 1.008 |
| 120000 integers | scan | 0.999 1.015 1.015 | 1.015 | 1.002 1.017 1.004 | 1.004 |
| 120000 integers | encode | 1.071 0.975 0.969 | 0.975 | 1.053 0.990 1.068 | 1.053 |
| 1 MiB Float64Array | decode | 1.153 0.982 1.035 | 1.035 | 1.080 1.055 0.881 | 1.055 |
| 1 MiB Float64Array | scan | 0.994 0.997 1.009 | 0.997 | 1.018 1.025 1.003 | 1.018 |
| 1 MiB Float64Array | encode | 1.027 0.870 0.839 | 0.870 | 0.854 0.851 0.844 | 0.851 |
| 10000 maps x 8 short keys | decode | 1.178 0.996 1.017 | 1.017 | 1.031 1.143 1.057 | 1.057 |
| 10000 maps x 8 short keys | scan | 0.967 1.001 0.996 | 0.996 | 1.025 0.968 0.998 | 0.998 |
| 10000 maps x 8 short keys | encode | 0.987 1.002 1.000 | 1.000 | 0.983 1.010 1.005 | 1.005 |
| map-heavy document | decode | 1.017 1.013 0.985 | 1.013 | 1.008 1.045 0.956 | 1.008 |
| map-heavy document | scan | 1.011 0.995 1.004 | 1.004 | 1.008 1.013 1.003 | 1.008 |
| map-heavy document | encode | 0.998 0.994 1.058 | 0.998 | 1.001 1.020 0.988 | 1.001 |
| 5000 floats (scalar) | decode | 1.049 0.990 1.867 | 1.049 | 1.046 0.991 0.975 | 0.991 |
| 5000 floats (scalar) | scan | 1.048 1.033 0.989 | 1.033 | 1.264 1.046 1.027 | 1.046 |
| 5000 floats (scalar) | encode | 1.036 0.958 0.942 | 0.958 | 0.926 1.101 0.933 | 0.933 |
| text-heavy (5000 strings) | decode | 1.004 0.957 0.999 | 0.999 | 1.026 0.990 0.997 | 0.997 |
| text-heavy (5000 strings) | scan | 1.018 0.996 1.006 | 1.006 | 0.930 1.009 1.011 | 1.009 |
| text-heavy (5000 strings) | encode | 0.995 1.046 1.046 | 1.046 | 0.844 0.884 0.850 | 0.850 |

**Reading:** the scanner — the code P7.1 changed — is within 0.96–1.03 of
the base for the Bindle preset on every workload (medians), so Bindle did not
regress there. Decode and encode medians are within 0.87–1.13; the outliers
(1 MiB bytes decode 0.67–1.11, encode 1.03–1.28; floats decode 1.87 once) are
single runs on large copies or allocation-bound work on a loaded machine and
move both ways, not a reproducible change. The deterministic preset costs
about 3–5% on a float-only scan (median 1.046; earlier runs ~1.09): a float
the Bindle rules refuse, such as an integral one, is re-checked by
`float-bad`. Its text-heavy and Float64Array encodes measured 0.85 of the base in all
three runs; the cause was not investigated.

An earlier draft of P7.1 regressed Bindle scans of floats and maps (up to
1.16) by adding a profile test and a parameter to the hot strict functions;
moving the new rules into separate functions consulted only after a strict
refusal (`text-bad`, `float-bad`) removed it. Measuring both presets in one
process also showed a false 1.16–2× on the Bindle float path (inlining), hence
one preset per process.

`node bench/codec.mjs bindle|deterministic` (wall-clock, the original codec
table's method) was also run on `f1a78c0`; on this loaded machine its absolute
times are about 2–3× the archived 2026-10-29 table for both arms, so only its
ratios to the in-process baseline are meaningful: decode speedups 0.84–4.84×
(Bindle) and 0.81–4.88× (deterministic), with the same shape as before. Its
Bindle 120000-integer encode (33.8 ms vs 8.6 ms deterministic) is the
`strictArrays` own-key check that the Bindle preset keeps (D113), not P7.1.

