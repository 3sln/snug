# JS host codec measurements

## Budget calibration — 2026-11-04

[VM calibration and proposal](VM.md#calibration-2026-11-04): clean
`df612f5fdabbf38b05fd3f89e5913472ab7791b3`, Apple M1 Pro (10 cores,
32 GiB), macOS 14.6.1 / Darwin 23.6.0 arm64; Node v24.6.0 / V8
13.6.233.10-node.24 (`--expose-gc --single-threaded-gc`), rustc 1.92.0
Homebrew, native `-O`, offline. Forty charged-work shapes/kernels, JS/Rust
verdict and unit parity, thread CPU, medians of nine interleaved rounds,
each row bracketed by a map-choice reference; compilation/construction/
binding/IPC excluded. `uptime` before every engine/row batch. Waited 180 s
before a full preliminary pass and 60 s before the final pass; load never
fell below 2, final timing load 10.71–13.93. **No quiet-machine result.**
Raw samples and reference ratios: [JSON](calibration-2026-11-04.json).
D253/D254 before/after confirmation (P8.2): [VM.md](VM.md#calibration-2026-11-04--d253d254-confirmation),
[before](calibration-2026-11-04-d253-before.json) and [after](calibration-2026-11-04-d253-after.json) records.
P8.5 phase 2 (format 2.0 PEG groups, D316; 2026-11-11, `93f0520`, Apple M1 Pro,
macOS 14.6.1, Node v24.6.0, rustc 1.92.0 `-O`, nine interleaved rounds under load 32–45):
[VM.md](VM.md#calibration-2026-11-11--p85-phase-2-peg-groups-d316), [record](calibration-2026-11-11-p85.json).

Do not blanket-raise EXT prices 1.5×: proposal targets profile scans and
specific control steps, with a conditional 2.25 M public-dispatch default
(~50 ms using the historical quiet reference, 64.44% largest valid unit
requirement). The exact ±25% cross-host/all-path fit is mathematically
infeasible with shared constants; the VM record explains residuals and the
forced-generic/default-headroom conflict. No runtime source changes made.

## Current evidence index — 2026-11-03

This index points to recorded snapshots; no new performance measurements
were run for the documentation fixes. Do not add component sizes or treat
trusted build-only timings as public decode. Revision is stated where the
record supplies one; “worktree” is not a reproducible clean revision.

| Date / revision | Operation or artifact measured | Ownership / boundary | Runtime and record |
| --- | --- | --- | --- |
| 2026-11-04 / `9ce6310` | P7.13 CBOR sequences: 100,000 × 97 B events (16 KiB chunks) and 5 × 909 KB batches (64 KiB chunks) through sequenceReader / readSequence, profile and schema, vs manual framing + decode/view/validate and cborg/cbor2/cbor-x whole-buffer decoders | Each message read through its View (one field); borrowed subarrays inside a chunk, assembled across; shared, loaded machine | Node v24.6.0, process CPU, median of 7; [SEQUENCE](SEQUENCE.md) |
| 2026-11-03 / P7.6 hashed worktree snapshots | Every public entry and module, static/full/split graphs; codec + schema 53,452 gzip B; compile static 45,754 → 1,243 gzip B | All exports retained; generated inputs identical before/after; no timing claims | Node v24.6.0, esbuild 0.28.2; [P7.6 below](#bundle-size-p76-phase-1--2026-11-03) |
| 2026-11-04 / `f734753` | P7.12: scalar float scan per preset, one preset per process (deterministic = Bindle 172.9 µs; pre-P7.1 169.8 µs) | `scan()` only, no build; 12 processes per arm | Node v24.6.0, thread CPU; [P7.1 below](#profile-options-p71) (P7.12 follow-up) |
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

**P7.12 follow-up (2026-11-04, tree `f734753`): the deterministic float
scan is not slower than the Bindle one.** The 5000-float workload holds
`i + 0.25`, which the Bindle float rules accept, so `float-bad` never runs on
it and the explanation above cannot hold. Measured one preset per process
and no base tree in the process (the arrangement that removed the false
1.16–2× above): `scan()` of the same 23,979-byte array, 2,000 warm-up calls,
then 31 trials of 400 calls, median µs per call by `process.threadCpuUsage`,
`node --single-threaded-gc`, 12 processes per arm, interleaved: deterministic
median of medians **172.9 µs** (166.3–186.1), Bindle **172.9 µs**
(167.4–179.5), the pre-P7.1 tree `c37eaaf` (its `host/js/src` + `gen/js`
from `git archive`) **169.8 µs** (167.3–173.6). V8 inlines `scanFloat`
(283 bytes of bytecode, 279 before P7.1) into `item` in both trees
(`--trace-turbo-inlining`). So the presets are equal, both ~1.8% over the
pre-P7.1 tree, about the run-to-run spread; the 1.046 above comes from
`profiles-bench.mjs` running the base tree's codec in the same process (it
gives 1.14–1.16 for BOTH presets' float scans today). No change made (D185).
Apple M1 Pro, macOS 14.6.1, Node v24.6.0.

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


## Bundle size (P7.6 Phase 1) — 2026-11-03

Machine: Apple M1 Pro, arm64, 32 GiB; macOS 14.6.1 (23G93), Darwin
23.6.0. Node v24.6.0, V8 13.6.233.10-node.24, zlib 1.3.1-470d3a2,
brotli 1.1.0; esbuild 0.28.2 from bench/compare/node_modules, read-only;
Babashka 1.3.190. No installs/network. Size measurements only, no timing
or throughput inference. Local date 2026-11-03 (report timestamps are UTC
2026-11-04). This was a shared worktree, not a clean revision; baseline was
captured before the host edit, and exact source hashes/metafiles are saved.
Only public-compile and its new compile-runtime module differ among hashed
inputs; package sideEffects:false is also included in the aggregate hash.
All generated-module hashes match before/after.

```sh
node tools/size/size.mjs --no-gate --report=tools/size/before.json # before host changes
bb size --report=tools/size/after.json
node tools/size/size.mjs --details
node tools/size/analyze.mjs --report=/private/tmp/analysis.json
```

Method: every package export, all bindings retained, one ESM/browser/ES2022
bundle per entry; esbuild minify + tree shaking + metafile, ASCII charset,
no legal comments/source maps. Static measurement leaves dynamic imports
external; gzip level 9 and brotli quality 11 compress the complete minified
output with Node zlib. Runtime unions retain both entry namespaces; sizes
are not sums of individual entries. Unicode is optional compile-time data
and outside both runtime unions. Module compression is measured separately
with imports retained; only metafile bytesInOutput are attributed within
each bundle. Compressed module figures cannot be added. Every module size,
import edge and a proportional ranked list is in [the report](../tools/size/report.md).

| Entry | Before min B | After min B | Before gzip-9 B | After gzip-9 B | Before brotli-11 B | After brotli-11 B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| snug | 41,238 | 41,238 | 14,174 | 14,174 | 12,689 | 12,689 |
| snug/schema | 124,376 | 124,376 | 46,042 | 46,042 | 39,293 | 39,293 |
| snug/compile | 123,471 | 2,378 | 45,754 | 1,243 | 39,065 | 1,101 |
| snug/view | 53,988 | 53,988 | 18,328 | 18,328 | 16,334 | 16,334 |
| snug/writer | 37,750 | 37,750 | 12,996 | 12,996 | 11,640 | 11,640 |
| snug/unicode | 19,377 | 19,377 | 9,287 | 9,287 | 8,817 | 8,817 |
| snug/sources | 30,415 | 30,415 | 11,300 | 11,300 | 10,029 | 10,029 |
| runtime | 147,858 | 147,858 | 53,452 | 53,452 | 45,485 | 45,485 |
| all-runtime | 175,485 | 175,485 | 63,284 | 63,284 | 53,707 | 53,707 |

`runtime` = codec + public schema; `all-runtime` adds views, Writer and
sources. These are current all-export measurements; older ~11 KB codec,
~41 KB schema and ~56 KB full-runtime records used earlier revisions and/or
different retained exports. No regression ratio against those records is
claimed. R9 still misses its 20 KB target.

Host restructuring defers the compiler and public schema classes together
behind compile-runtime.mjs; the class/error identities and synchronous
Program verification, serialization and session methods remain intact.
Options still validate before the first await. Runtime modules have no
independent registration effects, so sideEffects:false is appropriate.

Full-closure bundles inline reachable lazy code: compile gzip grows from
84,074 to 85,118 B (+1,044), while runtime remains 53,626 B. Real code
splitting compresses each chunk separately: compile initial transfer is
46,746 → 1,371 gzip B; reachable total after compile is 84,612 → 84,779 B
(+167). Schema split initial/total is 47,010 B. esbuild emits orphan compiler
and verifier chunks from unused internal schema loader functions; schema
has no edge to them. The JSON reports distinguish initial, reachable total
and all emitted output, avoiding a false claim that orphan files are loaded.

Largest schema minified contributions: eval 19,391 B, verifier 18,903 B,
scont 14,664 B, sbase 7,730 B, map 6,700 B, sstr 6,647 B. Codec is led by
Writer 14,192 B, scanner 4,490 B, values 3,772 B and builder 2,866 B.
[DEVLOG P7.6](../DEVLOG.md) records why each dependency is present and the
prioritised kin plan: session partition (~13 KB marginal gzip), generic
buffer VM (~3.1 KB after session removal), verifier refactor (1–2 KB estimate;
~6.3 KB removal ceiling), rare leaves (~0.1–1 KB per useful partition), then
legacy schedule/generic flags (tens of bytes in the conservative probes).
Shorter source identifiers add approximately zero after existing mangling.
All probes change code only in memory and are never executed; their numbers
are size estimates, not validated replacements or additive predictions.

Budget caps in tools/size/budget.json are ceil(current bytes × 1.02) for min,
gzip and brotli, independently for static and full closure, all public
entries and both unions. bb size passed (exit 0); a scratch zero-gzip cap
failed (exit 1, 14,174 > 0). Babashka printed a sandbox process-enumeration
warning in its shutdown hook after the successful gate; Node invocation
avoids it. This regression gate does not mark R9 achieved.

Gates: host/js npm test 1,284 passed, zero failed/skipped; seven examples
executed successfully; npm run build staged successfully, and staged-package
examples also ran in the host suite. No emit/drift, Rust/wasm or browser
checks were run for this phase. No commits were made by this task.

Input hashes:

- Before: `0e00c8c9746d0cf44daa0771bbd2822534b828fe9e48bcc887e466d6b0441feb`.
- After: `16789fc85177e8d4063cbd6d1c278d14488118e47492b8dfeede1e33df3b6622`.

The other engineer regenerated compiler/verifier/session modules after the
paired measurements. Current.json preserves that later snapshot separately;
these additions are not host import savings or regressions. Final budgets
use this current snapshot +2%. Static min/gzip/brotli bytes:

| Entry | Current min | Current gzip-9 | Current brotli-11 |
| --- | ---: | ---: | ---: |
| snug | 41,238 | 14,174 | 12,689 |
| snug/schema | 125,518 | 46,456 | 39,604 |
| snug/compile | 2,378 | 1,243 | 1,101 |
| snug/view | 53,988 | 18,328 | 16,334 |
| snug/writer | 37,750 | 12,996 | 11,640 |
| snug/unicode | 19,377 | 9,287 | 8,817 |
| snug/sources | 30,415 | 11,300 | 10,029 |
| runtime | 149,000 | 53,870 | 45,815 |
| all-runtime | 176,627 | 63,720 | 54,145 |

Current input hash: `d25ff5e3d4416131a1d69e828afc883c0608a4bb401038d1a1ef8768e4c0b23c`. Full graphs and changed
module measurements: [report](../tools/size/report.md#current-shared-tree-after-concurrent-regeneration).

## XSD regexp compiler (P8.3)

2026-11-04 shared worktree, Apple M1 Pro (10 cores, 32 GiB), macOS
14.6.1 / Darwin 23.6.0 arm64; Node v24.6.0, V8
13.6.233.10-node.24, npm 11.5.1, ICU 77.1 / Unicode 16.0; native
Rust/cargo 1.92.0. Offline esbuild 0.28.2, ESM/browser/ES2022, all exports
retained, minification/tree shaking, gzip level 9 / brotli quality 11.
`node tools/size/size.mjs --no-gate --report=.cache/p83-size-final.json`
freezes sources in memory and measures static/full/split graphs using the
existing P7.6 method. No latency/performance inference.

| Entry | Static min | Static gzip | Full min | Full gzip | Full brotli |
| --- | ---: | ---: | ---: | ---: | ---: |
| snug | 41,837 | 14,426 | 41,837 | 14,426 | 12,873 |
| snug/schema | 92,437 | 34,026 | 92,437 | 34,026 | 29,342 |
| snug/compile | 2,550 | 1,308 | 222,828 | 75,707 | 64,360 |
| snug/view | 54,692 | 18,621 | 54,692 | 18,621 | 16,609 |
| snug/writer | 38,350 | 13,219 | 38,350 | 13,219 | 11,845 |
| snug/unicode | 19,377 | 9,287 | 19,377 | 9,287 | 8,817 |
| snug/sources | 122,038 | 45,337 | 122,038 | 45,337 | 38,626 |
| snug/sequence | 148,535 | 53,134 | 148,535 | 53,134 | 45,997 |
| snug/controls | 6,196 | 2,412 | 6,196 | 2,412 | 2,160 |
| runtime | 116,402 | 41,848 | 116,402 | 41,848 | 35,777 |
| all-runtime | 204,733 | 73,623 | 204,733 | 73,623 | 61,821 |

Full compiler: 219,238 → 222,828 min bytes; 74,472 → 75,707 gzip bytes.
The kin XSD parser adds metered range subtraction, static XML-name ranges,
shorthands and exact decimal ordering before bounded repetition expansion.
Only `snug/compile.full` caps were raised to ceil(measured × 1.02):
227,285 min / 77,222 gzip / 65,648 brotli bytes. Compiler static caps and
all runtime caps were preserved. Compile admission moved out of the runtime
option-shape graph; the embedded `any` Program changed only its source key.
Runtime: 116,794 → 116,402 min bytes; 42,028 → 41,848 gzip bytes.
Concurrent sequence/source and correctness edits were present, so these
shared snapshots are evidence for total sizes, not isolated attribution.
The optional Unicode module is unchanged. Block escapes explicitly refuse
unavailable pinned data; no guessed block table was shipped.

Before input hash: `0d0978da3c668779439f9b0cf2e00ec4d6be0fd5501b7dbd7f16e873581af69d`.
Final input hash: `71a22657290dfdfab3c550e24ce1969b6d71051c103a916d77da3d1854542ab9`.
Detailed graphs: `.cache/p83-size-before.json`, `.cache/p83-size-final.json`;
budget gate log: `.cache/p83-size-gate.log`.

P8.3 compile-fuzz timing diagnostic (same environment above; ordinary Node,
no flags): two default 3,000-text/seed-24301 runs had only wall-clock failures
on shared-array schemas without regexps (2-second threshold unchanged).
The second run saw load averages 66.65/144.15/124.21. To distinguish this
from a regexp regression, one sequential call per compiler compiled the
same `a0=[a1,a1] … a399=[a400,a400]; a400=int; r=a0` schema, including cold
retained arenas, ordinary arena retries and default limits. The unmodified
pre-P8.3 HEAD snapshot took **4,733.875 ms**, load 50.33/117.53/115.99;
current explicit I-Regexp took **3,603.243 ms**, load 47.58/115.84/115.41.
Both accepted and spent **1,572,297 compile units**. This single loaded pair
is diagnostic evidence, not a latency estimate or a performance improvement
claim. Raw record: `.cache/p83-fuzz-load.json`; gate logs:
`.cache/p83-compile-fuzz-first.log`, `.cache/p83-compile-fuzz.log`.

## Valid CBOR (P8.4, D269 / D286) — 2026-11-11

**Question:** what does the valid-CBOR machinery cost on deterministic input,
what does the canonical path cost, and is the deterministic-only fast path
(the VM's attempt over the input before the canonical copy, D262) material?
**Machine:** Apple M1 Pro (10 cores, 32 GiB), macOS 14.6.1, **shared** (1-minute
load average 12–15 for the VM and codec runs, 8 for the session runs; other
agents' builds). **Runtime:** Node v24.6.0 (V8 13.6.233.10-node.24),
`--single-threaded-gc`. **Trees:** `main` = `c48ac45` (detached worktree), p84 =
the P8.4 increment (`.cache/p84rb`). **Method:** one tree and one arm per process
(bench/README.md#profile-options-p71), `process.threadCpuUsage`, µs per call,
median of 9 trials; three processes per arm, arms rotated per round; the table
gives the median of the three process medians and the ratio to `main`'s
deterministic run. `nondet` inputs are the same values re-encoded valid but not
deterministic (indefinite arrays and maps, keys reversed, integers 0..23 with a
one-byte argument).

VM level — `node --single-threaded-gc bench/valid-vm-bench.mjs <tree> <arm> 9`
(scanner `scanCb`; buffer driver `vmValidateV` against a typed schema; `canon` =
`vmCanon` forced, i.e. the canonical path without the attempt; sessions = whole
windows through `kin/scripts/vmsession-run.mjs`):

| Workload | scan main | det | valid | nondet | VM main | det | valid | canon (no attempt) | nondet | session main | det | valid | nondet |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| RPC put (small) | 0.8 | 1.45 | 1.58 | 5.29 | 8.3 | 1.05 | 1.20 | **2.29** | 5.37 | 13.2 | 1.13 | 1.27 | 3.34 |
| 20000 integers | 409 | 1.01 | 1.02 | 1.31 | 476 | 0.96 | 0.99 | **6.92** | 7.47 | 377 | 1.44 | 1.43 | 8.23 |
| 2000 maps × 8 keys | 808 | 0.94 | 1.17 | 4.41 | 3,177 | 1.03 | 0.94 | **3.29** | 5.96 | 2,296 | 1.39 | 1.43 | 23.0 |
| map-heavy (2000 records) | 1,136 | 0.99 | 0.97 | 3.47 | 7,691 | 1.03 | 0.96 | **2.29** | 4.21 | 5,952 | 1.19 | 1.11 | 13.3 |
| 5000 floats | 151 | 0.80 | 0.79 | 1.03 | 523 | 1.08 | 0.92 | **2.87** | 3.19 | 369 | 1.30 | 1.41 | 2.94 |
| 5000 strings | 556 | 0.95 | 0.99 | 1.17 | 491 | 1.04 | 0.99 | **4.72** | 5.47 | 411 | 1.35 | 1.29 | 5.86 |

(`main` columns in µs; the others are ratios to them.)

Codec — `node --single-threaded-gc bench/valid-bench.mjs <tree> <preset> 9 [nondet]`
(public `decode`, `scan`, `encode`, compiled-schema `validate`; ratios to `main`'s
deterministic preset):

| Workload | op | main µs | p84 deterministic | p84 valid | p84 valid, nondet input |
| --- | --- | ---: | ---: | ---: | ---: |
| RPC put (small) | decode / scan / validate | 6.4 / 2.9 / 14.6 | 1.16 / 1.04 / 0.53 | 0.97 / 1.11 / 0.71 | 1.65 / 2.97 / 1.78 |
| 120000 integers | decode / scan / validate | 5,128 / 3,085 / 2,933 | 1.00 / 0.99 / 1.01 | 1.06 / 1.10 / 1.02 | 2.26 / 3.45 / 8.22 |
| 10000 maps × 8 keys | decode / scan / validate | 17,907 / 3,983 / 16,512 | 0.72 / 1.10 / 1.03 | 0.88 / 1.18 / 1.01 | 2.13 / 7.74 / 5.30 |
| map-heavy document | decode / scan / validate | 26,296 / 5,972 / 37,451 | 0.94 / 1.11 / 1.05 | 0.93 / 1.07 / 0.91 | 2.30 / 7.06 / 3.68 |
| 5000 floats | decode / scan / validate | 202 / 117 / 555 | 1.08 / 1.09 / 1.01 | 1.16 / 1.17 / 0.98 | 2.24 / 3.19 / 2.51 |
| 5000 strings | decode / scan / validate | 1,860 / 623 / 485 | 1.08 / 0.94 / 1.05 | 0.93 / 0.88 / 1.10 | 1.18 / 1.95 / 5.09 |

Encode (deterministic output under every preset): 0.84–1.05 of `main`.

**Reading.** (1) Deterministic input costs about the same as before P8.4 on the
scanner, the buffer driver and the codec under both presets (0.8–1.2, inside
this machine's run-to-run spread; the small RPC scan's 1.45–1.58 is 0.3 µs of
fixed set-up in `scanCb`). (2) The deterministic-only fast path is material:
forcing the canonical path on deterministic input (`canon`) costs 2.3–6.9× the
attempt, so the attempt stays (D286). (3) Sessions on deterministic input cost
1.1–1.4× `main` after the structural pre-check (`skim`, before it 1.2–2.0×): the
session decides per whole item between the walk in place and the copy before it
walks (D283), the buffer driver after. (4) Non-deterministic input is 1.2–8×
(codec, VM) and up to 23× for sessions over many small reordered maps (whole
items: the scanner pass, the copy and the deferred duplicate checks); recorded,
not optimised in P8.4.

## Session pooling (P9.7, D327) — 2026-11-11

**Question:** what do pooling a session's arrays per Program and the
live-session bound save, and how large must the idle pool be?
**Machine:** Apple M1 Pro (10 cores, 32 GiB), macOS 14.6.1, **shared** (other
agents' builds and gates). **Runtime:** Node v24.6.0. **Trees:** `main` =
`0b302fc`, P9.7 = `.cache/p97r`. **Method:**
`node --single-threaded-gc --expose-gc bench/sessions-bench.mjs <tree> <arm>`,
one arm per process: 100,000 small sessions (one RPC-sized message through
`openSession`, whole window), then 2,000 sessions over a 64 KiB text through
`validateHandleSync` in 4 KiB chunks. Thread CPU µs per session; peak RSS and
heap sampled during the run. `fresh` sets `maxPooledBytes: 0` (every session
allocates its arrays); `pool=N` sets an N MiB pool.

| arm | small session µs | 64 KiB session µs | peak RSS | peak heap |
| --- | ---: | ---: | ---: | ---: |
| main | 11.46 | 386 | 356 MiB | 13.1 MiB |
| fresh | 14.1 | 379 | 401 MiB | — |
| pool=1 | 10.25 | 350 | 264 MiB | 26.7 MiB |
| **pool=2 (default)** | **9.89** | **348** | **283 MiB** | **26.6 MiB** |
| pool=4 | 9.66 | 345 | — | — |
| pool=8 | 9.60 | 332 | — | — |

**Reading.** (1) The 2 MiB default keeps most of the gain: −14% CPU per small
session and −10% per 64 KiB session against `main`, and peak RSS 356 → 283
MiB. A larger pool adds 1–5%. (2) Without the pool (`fresh`) the P9.7 tree is
slower than `main` on small sessions (the lease, release and registry
bookkeeping), so the pool pays for that bookkeeping. (3) The higher peak heap is
transient garbage (lease objects and finalization-registry records between
collections); the pool's arrays are typed-array backing stores outside the V8
heap, and the heap at the end of the run is 8.3 MiB on every arm. (4) One
entry is about 75 KB; entries over 1 MiB or over a quarter of the pool are not
pooled.
