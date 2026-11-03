# Writer benchmark (P5.4)

`node bench/writer-bench.mjs [trials]` — 2026-10-29, Apple M1 Pro, macOS 14.6.1,
Node v24.6.0 (V8 13.6.233.10-node.24), 9 trials, ≥ 15 ms per sample, 3 warm-up
rounds, operations rotated each round so none always runs warm; median per
operation. The machine was loaded (load average 8.6–16 during the runs below;
22–29 during earlier runs). Every answer is checked equal to the Phase 2
encoder's bytes outside the timed region.

Columns:

* **Writer typed** — the Writer driven by typed calls that build the same
  document (`beginMap`/`key`/`uint`/`text`/...), a hand-written builder per
  workload as a user would write it. *Keys in order*: keys supplied in encoded
  order with `keysSorted: true` (each key checked against the previous one by
  kin's `key-after`). *Keys shuffled*: every map's keys in reverse encoded
  order, sorted at `end()` by kin's `close-map` (pairs permuted in place). The
  vectors row drives the Writer generically (a `typeof` dispatcher, and an
  encoded-key sort in the driver for the in-order column), so it measures the
  driver as much as the Writer.
* **encode = walk over Writer** — `encode(value)` since P5.4 (D072): the object
  walk inside the Writer; an object's keys are ordered by kin's `sort-keys`
  before any value is written.
* **P2 encoder** — the Phase 2 encoder this replaced, frozen at
  `bench/baseline/encode-p2.mjs` (architecture §16.5's baseline).
* **cbor.mjs** — 3sln.me's codec (`bench/baseline/cbor-3sln.mjs`).

Workloads are bench/codec.mjs's. "Keys in order" / "shuffled" for the value
columns is the key order of the JS objects handed in.

## Run 1 (load 8.6)

| Workload | Bytes | Writer typed, keys in order (keysSorted) ms | Writer typed, keys shuffled ms | encode = walk over Writer, keys in order ms | encode = walk over Writer, keys shuffled ms | P2 encoder, keys in order ms | P2 encoder, keys shuffled ms | cbor.mjs encode, keys shuffled ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| vectors (74 profile + 315 oracle) | 71387 | 2.4997 | 1.5591 | 1.6975 | 1.4942 | 1.5520 | 1.5393 | 2.1694 |
| RPC put 287 B | 287 | 0.0017 | 0.0032 | 0.0039 | 0.0036 | 0.0043 | 0.0046 | 0.0111 |
| RPC put + 1 MiB bytes | 1048786 | 0.5137 | 0.8273 | 0.4147 | 0.4475 | 0.4432 | 0.4525 | 0.4443 |
| 120000 integers | 468653 | 1.7491 | 1.7539 | 11.5576 | 11.7177 | 10.3911 | 10.6042 | 11.1995 |
| 1 MiB Float64Array | 1048583 | 0.7487 | 0.7150 | 0.7381 | 0.7647 | 0.6863 | 0.7023 | 0.6732 |
| 1 MiB BigInt64Array | 1048583 | 0.3778 | 0.4681 | 0.3907 | 0.3762 | 0.3984 | 0.4129 | 0.3717 |
| 10000 maps x 8 short keys | 359723 | 2.9687 | 6.7333 | 10.5261 | 12.1786 | 16.8249 | 15.9540 | 58.6545 |
| map-heavy document 1.4 MB | 1400000 | 6.9528 | 11.9963 | 14.1073 | 15.6721 | 24.5491 | 26.4958 | 71.3279 |

## Run 2 (load 9.2)

| Workload | Bytes | Writer typed, keys in order (keysSorted) ms | Writer typed, keys shuffled ms | encode = walk over Writer, keys in order ms | encode = walk over Writer, keys shuffled ms | P2 encoder, keys in order ms | P2 encoder, keys shuffled ms | cbor.mjs encode, keys shuffled ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| vectors (74 profile + 315 oracle) | 71387 | 2.3901 | 1.4597 | 1.4300 | 1.4658 | 1.4216 | 1.4341 | 1.9879 |
| RPC put 287 B | 287 | 0.0017 | 0.0031 | 0.0034 | 0.0036 | 0.0045 | 0.0045 | 0.0106 |
| RPC put + 1 MiB bytes | 1048786 | 0.3950 | 0.8258 | 0.3856 | 0.4084 | 0.4031 | 0.4065 | 0.4456 |
| 120000 integers | 468653 | 1.7307 | 1.8073 | 10.7626 | 11.6756 | 10.7607 | 10.6408 | 10.7344 |
| 1 MiB Float64Array | 1048583 | 0.7204 | 0.7247 | 0.7059 | 0.7552 | 0.7388 | 0.7368 | 0.7007 |
| 1 MiB BigInt64Array | 1048583 | 0.4032 | 0.4326 | 0.3864 | 0.4100 | 0.3829 | 0.3982 | 0.4786 |
| 10000 maps x 8 short keys | 359723 | 3.0626 | 6.7767 | 11.2296 | 13.0632 | 16.6947 | 16.1095 | 58.8128 |
| map-heavy document 1.4 MB | 1400000 | 7.1888 | 12.2838 | 15.6629 | 17.1673 | 24.8067 | 24.8333 | 69.8815 |

## CPU-time A/B where the wall clock wavered

The 120 000-integer row moved by up to ±10 % between runs in both
directions, so it was re-measured as CPU time (`process.cpuUsage`), 25
alternating rounds of 20 encodes (Float64Array: 100), new encode vs P2:

| Workload | encode = walk over Writer, median / min ms | P2 encoder, median / min ms |
| --- | ---: | ---: |
| 120000 integers | 9.601 / 9.018 | 9.547 / 8.923 |
| 1 MiB Float64Array | 0.757 / 0.681 | 0.763 / 0.719 |

Both are dominated by the dense-array check both share (`Reflect.ownKeys`
builds 120 000 index strings); the integer heads themselves are the 1.7 ms
the typed Writer takes for the same array.

## Reading

* **encode over the Writer is not slower than the P2 encoder** on any
  bench/codec.mjs workload (parity within noise on vectors, the 1 MiB
  bstr put, integers and typed arrays; CPU-time A/B within 1 %), and faster
  where maps dominate: 1.2–1.6× on 10 000 eight-key maps, 1.4–1.7× on the
  1.4 MB document, 1.1–1.3× on the 287 B put. The gain is the key path: keys
  encoded once into a scratch buffer and ordered by kin over bytes, no
  `[key, bytes, value]` tuple per member and no JS comparator. Hence D072.
* **Typed calls with keys in order** are the fastest way to produce a
  document: 3.4–5.7× the P2 encoder on maps and the document, 6× on the
  integer array (no object walk, no dense-array check), equal on bytes and
  typed arrays (memcpy-bound).
* **Typed calls with keys shuffled** pay for moving values: `close-map`
  copies a map's content twice (into scratch and back). For small values this
  is ~2× the in-order cost and still faster than the P2 encoder; for the
  1 MiB bstr put it is 2× everything else (0.83 vs 0.40 ms: the megabyte is
  moved). Values that already exist as objects should go through `value()`,
  which orders keys before writing values and never moves one.
* cbor.mjs is 2.8–5.6× slower than either encoder on the map-heavy bodies.

## Size

esbuild `--bundle --format=esm --minify`, gzip -9 (node zlib):

| Bundle (with its imports: values, limits, fault, gen/js/snug/write) | min B | min+gzip B |
| --- | ---: | ---: |
| host/js/src/writer.mjs (Writer + walk) | 19816 | 7124 |
| host/js/src/encode.mjs (= the walk over the Writer) | 19800 | 7116 |
| bench/baseline/encode-p2.mjs (the Phase 2 encoder it replaced) | 10395 | 4162 |
| host/js/src/values.mjs alone (shared by both) | 3898 | 1701 |

The Writer costs ~3.0 KB gzip more than the P2 encoder (the grammar, the
typed methods, merge sort and both map paths). Against R9's 20 KB runtime
budget this is the open cost of D072.

## Encoder performance follow-up — 2026-11-03

Apple M1 Pro (10 cores, arm64, 32 GiB), macOS 14.6.1, Node v24.6.0,
V8 13.6.233.10-node.24. This was a shared machine: load started around 7,
climbed as high as 35, and varied substantially during measurement. CPU time
also varies with core placement and frequency; unpaired runs at different
loads must not be read as a speedup by themselves.

The baseline is a saved copy of the Writer at the start of this work, not
the frozen P2 encoder. `node --single-threaded-gc --cpu-prof` profiled all
eight comparison workloads (excluding the separate-message sequence), about
1.2 seconds each, before and after. Samples locate the integer-array cost
at the own-key enumeration, float-array work at the JS NaN loop, and bulk
byte costs at buffer allocation/growth and `finish()`'s slice. Little-endian
typed payloads already used `set()`; adding another memcpy fast path there
would not help. The object walk dominates the structured workloads; no kin
primitive was changed or replaced.

Changes: use the captured intrinsic typed-array `includes(NaN)` for ordinary
float views (keep the old length-based loop for views with their own
`length` property); reserve close to the known bulk payload size, leaving
256 bytes for following members; hand off an exact-size owned output buffer
at finish, copying otherwise. Big-endian payloads swap directly into the
output, without an intermediate payload allocation. Text retains its
existing growth policy. Header, float-width and map-order decisions still
use the generated kin primitives.

### Array check: the requested non-allocating replacement is unavailable

Standard JavaScript cannot enumerate *all* own properties without producing
a property list. `for…in` misses non-enumerable properties and symbols;
index membership tests cannot discover named properties. Combining either
with a symbol check still misses non-enumerable string properties. Reading
all own names to cover that case allocates every index string again.

Measured checks alone, 120,000 integers, 15 rotating rounds of 10 checks,
median thread CPU ms (load about 7):

| Check | ms | Covers the existing own-key count contract? |
| --- | ---: | --- |
| `Reflect.ownKeys` | 8.1204 | yes |
| own names plus own symbols | 7.9821 | yes; still allocates all indices |
| `for…in` plus `hasOwn` | 4.1094 | no |
| `Object.keys` | 2.3448 | no |
| `hasOwn` for each index | 0.7355 | no |

The existing check is retained, so the integer-array bottleneck remains.
There is also a pre-existing semantic wrinkle: counting keys does not prove
density. An extra own property can compensate a hole, changing refusal
precedence (e.g. `too_many_items` rather than `unsupported` with a small
item limit), or allowing inherited/virtual index values. Tightening that
check would change behavior and requires a separate correctness decision.

### Measurement method

Both `bench/codec.mjs` and `bench/writer-bench.mjs` were run before and after
using temporary copies with their relative imports resolved absolutely and
`performance.now()` replaced with a clock taking `t = process.threadCpuUsage()`
and returning `(t.user + t.system) / 1000` (one call per reading).
No workload, correctness check,
rotation or sampling policy was changed: 9 trials, target 15 ms CPU per
sample, 3 interleaved warm-up rounds, median ms per operation. Run with
`node --single-threaded-gc`. Each output was checked against the frozen
encoder/baseline outside timing as in the original scripts. Bundle sizes
were skipped because the benchmark's esbuild path is absent; no install.

An additional same-thread A/B runs the saved Writer and current Writer in
alternating order over `bench/compare/workloads.mjs`, 30 warm-up calls per
implementation, 9 rounds, target 25 ms CPU per sample, GC included. It checks
every answer against the workload bytes outside timing. Keeping both
implementations on one thread reduces the core-placement bias seen with
two workers. Before timing, **both implementations encode the entire fixture
set**, including the 10k separate messages. The workload factory itself calls
the current encoder: failing to give the saved encoder that same type history
produced misleading structured-workload differences (including an apparent
document regression that disappeared with matched warm-up).
Raw scripts, profiles and outputs are in
`/private/tmp/snug-encoder-perf/` on the measurement machine.

### Paired comparison workloads

Median thread CPU ms; load 11.67 → 9.82 (5-minute load 17.32 → 16.64).
Treat small differences as parity on this shared machine.

| Workload | Before ms | After ms | Before / after |
| --- | ---: | ---: | ---: |
| RPC put 287 B | 0.008888 | 0.007837 | 1.13× |
| RPC put + 1 MiB bstr | 1.218643 | 0.783683 | 1.56× |
| 120k integers | 22.532500 | 22.307000 | 1.01× |
| 1 MiB typed arrays (f32, f64, i16) | 2.685833 | 1.543222 | 1.74× |
| 10k maps × 8 short keys | 38.932000 | 36.547000 | 1.07× |
| Map-heavy document 1.4 MB | 21.830000 | 21.387500 | 1.02× |
| Text-heavy document 1.2 MB | 6.619000 | 6.451000 | 1.03× |
| CWT-like integer-key map | 0.002573 | 0.002570 | 1.00× |

### Existing benchmark scripts: unpaired CPU medians

These are the complete final before/after runs' encode columns. The baseline
controls and even untouched decode operations varied by about 3× within these
runs, so **use the paired table above for speed comparisons**. Writer run
start loads were 18.34 before and 26.93 after. Codec runs occurred immediately
before those Writer runs; the entire sequence spanned load roughly 18–27.

| Workload | codec encode before / after ms | Writer typed sorted before / after ms | Writer typed shuffled before / after ms | writer-bench encode sorted before / after ms | writer-bench encode shuffled before / after ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Vectors | 5.7630 / 1.5036 | 8.1060 / 2.4040 | 4.4935 / 1.5359 | 5.0970 / 1.6485 | 4.3048 / 1.5865 |
| RPC put 287 B | 0.0103 / 0.0030 | 0.0049 / 0.0016 | 0.0081 / 0.0060 | 0.0091 / 0.0031 | 0.0099 / 0.0033 |
| RPC put + 1 MiB bytes | 1.0900 / 0.5333 | 0.8110 / 0.4348 | 2.5391 / 0.8992 | 1.4538 / 0.5192 | 1.4843 / 0.4756 |
| 120000 integers | 11.2330 / 10.0510 | 5.0830 / 1.7227 | 5.1333 / 1.7292 | 30.0600 / 10.3570 | 29.7040 / 10.6610 |
| 1 MiB Float64Array | 0.8541 / 0.2823 | 1.7848 / 0.3038 | 1.8911 / 0.2145 | 1.7871 / 0.2833 | 1.9620 / 0.2406 |
| 1 MiB BigInt64Array | 0.6773 / 0.2187 | 0.9788 / 0.2193 | 1.0021 / 0.2369 | 1.1598 / 0.2077 | 1.1125 / 0.2049 |
| 10000 maps × 8 short keys | 11.1115 / 13.1855 | 2.9177 / 3.0424 | 6.6307 / 6.7937 | 11.7480 / 11.4240 | 12.0720 / 14.5055 |
| Map-heavy document 1.4 MB | 13.8020 / 45.7350 | 6.8253 / 12.6960 | 12.8480 / 22.1805 | 15.5300 / 31.4820 | 16.3600 / 29.7350 |

### Gates and limits of this result

`npm --prefix host/js test`: **1,048 passed, 0 failed**. New focused tests
cover sparse/extra-property/subclassed arrays and refusal precedence; every
typed-array family, non-zero-offset views, NaN refusals and decorated views;
forced big-endian Writer output and byte-copy branches; Float16Bytes; output
ownership, exact backing-buffer sizes, sticky Writer grammar and maxBytes.
Both benchmark scripts checked every answer. `git diff --check` passed.
No kin/generated source, acceptance policy or byte decisions were changed.
The array optimization is deliberately **not completed** under the combined
non-allocation and identical-behavior requirements above.
