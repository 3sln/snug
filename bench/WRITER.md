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
