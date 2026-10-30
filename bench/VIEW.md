# Views and cursor measurements (P5, architecture §16.7)

Measured 2026-10-29 at commit `5501952` (host/js/src/view.mjs, gen/js/snug/nav).

```sh
node --expose-gc bench/view-bench.mjs 11
```

## Method

The inputs are the P1.4 inputs (`bench/scan-inputs.mjs`) plus a text-heavy body.
"nested maps" is the 1.1 MB map-heavy body: 9 000 twelve-key documents.

Each row times one operation. The operation runs in a loop calibrated to about
20 ms, and the table gives the median of 11 samples. Correctness checks run
outside the timed loops: every field, sum, materialised value and lookup is
compared with decode().

The columns compare against:

* **decode**: snug's scan + build.
* **cbor.mjs**: the baseline, `bench/baseline/cbor-3sln.mjs`.
* **schema.decode**: the compiled rule `r = { * tstr => any }`, compiled with
  entry and item limits raised to the inputs' options.

Memory is measured with `--expose-gc`: heap plus ArrayBuffer bytes retained per
open view, averaged over 2 000 views (small input) or 8 views (large inputs).

Other CBOR libraries (cbor-x, cborg, cbor) are named only. They are not
installed, because the machine is offline.

## Environment
- Apple M1 Pro (10 cores, 32 GiB), macOS 14.6.1, node v24.6.0 (V8 13.6.233.10-node.24); load 10.4 10.6 13.1; 11 samples

## open + one field (check included)
| input | view, owned | view, borrowed | decode + field | cbor.mjs + field | view+schema, borrowed | schema.decode + field |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| RPC put, 287 B | 1.4 µs | 1.2 µs | 3.2 µs | 5.9 µs | 1.5 µs | 3.3 µs |
| RPC put with 1 MiB bstr, 1048856 B | 177.1 µs | 1.3 µs | 147.8 µs | 152.0 µs | 1.7 µs | 148.7 µs |
| 120,000-int array, 584247 B | 2.68 ms | 2.64 ms | 3.06 ms | 2.49 ms | 3.26 ms | 4.03 ms |
| 1 MiB typed arrays (f32, f64, i16), 1048610 B | 406.8 µs | 317.4 µs | 380.6 µs | 476.1 µs | 225.9 µs | 374.4 µs |
| nested maps, short text keys, 1107041 B | 10.59 ms | 11.51 ms | 28.31 ms | 88.66 ms | 11.16 ms | 24.75 ms |
| text-heavy map (4,500 text values), 1228956 B | 2.25 ms | 1.86 ms | 3.52 ms | 2.74 ms | 1.80 ms | 3.40 ms |

## the field again, on an open view (no check)
| input | linear | with directories (warm) | property read on decode()d value |
| --- | ---: | ---: | ---: |
| RPC put, 287 B | 208 ns | 248 ns | 15 ns |
| RPC put with 1 MiB bstr, 1048856 B | 207 ns | 235 ns | 15 ns |
| 120,000-int array, 584247 B | 812.1 µs | 111 ns | 15 ns |
| 1 MiB typed arrays (f32, f64, i16), 1048610 B | 299 ns | 303 ns | 17 ns |
| nested maps, short text keys, 1107041 B | 3.55 ms | 225 ns | 21 ns |
| text-heavy map (4,500 text values), 1228956 B | 203.4 µs | 526 ns | 17 ns |

## sequential walk of every item (open view; decode includes its own check + build)
| input | Cursor walk | decode() + walk of the value | walk of an already decoded value |
| --- | ---: | ---: | ---: |
| RPC put, 287 B | 905 ns | 4.8 µs | 2.0 µs |
| RPC put with 1 MiB bstr, 1048856 B | 937 ns | 142.7 µs | 1.7 µs |
| 120,000-int array, 584247 B | 4.65 ms | 3.01 ms | 556.7 µs |
| 1 MiB typed arrays (f32, f64, i16), 1048610 B | 358 ns | 357.3 µs | 133 ns |
| nested maps, short text keys, 1107041 B | 13.95 ms | 50.62 ms | 25.18 ms |
| text-heavy map (4,500 text values), 1228956 B | 263.8 µs | 6.33 ms | 2.84 ms |

## repeated random access: time per lookup path (up to 3 get/at steps), on an open view
| input | linear | with directories | directory words | on the decoded value |
| --- | ---: | ---: | ---: | ---: |
| RPC put, 287 B | 312 ns | 157 ns | 9 | 21 ns |
| RPC put with 1 MiB bstr, 1048856 B | 310 ns | 134 ns | 9 | 21 ns |
| 120,000-int array, 584247 B | 695.3 µs | 75 ns | 120000 | 11 ns |
| 1 MiB typed arrays (f32, f64, i16), 1048610 B | 117 ns | 113 ns | 0 | 7 ns |
| nested maps, short text keys, 1107041 B | 1.90 ms | 245 ns | 81468 | 35 ns |
| text-heavy map (4,500 text values), 1228956 B | 99.7 µs | 473 ns | 4500 | 15 ns |

## full materialise
| input | view open (borrowed) + value() | value() on an open view | decode() | cbor.mjs decode() |
| --- | ---: | ---: | ---: | ---: |
| RPC put, 287 B | 3.2 µs | 2.4 µs | 2.9 µs | 5.7 µs |
| RPC put with 1 MiB bstr, 1048856 B | 120.3 µs | 135.6 µs | 122.2 µs | 128.5 µs |
| 120,000-int array, 584247 B | 4.04 ms | 2.72 ms | 2.72 ms | 2.58 ms |
| 1 MiB typed arrays (f32, f64, i16), 1048610 B | 343.5 µs | 136.7 µs | 368.6 µs | 430.7 µs |
| nested maps, short text keys, 1107041 B | 27.60 ms | 24.02 ms | 26.79 ms | 78.24 ms |
| text-heavy map (4,500 text values), 1228956 B | 3.65 ms | 1.78 ms | 3.26 ms | 3.04 ms |

## memory retained per open view
| input | owned | borrowed | borrowed + directories after the random lookups |
| --- | ---: | ---: | ---: |
| RPC put, 287 B | 961 B | 504 B | 937 B |
| RPC put with 1 MiB bstr, 1048856 B | 1025 KiB | 509 B | 1925 B |
| 120,000-int array, 584247 B | 571 KiB | 505 B | 471 KiB |
| 1 MiB typed arrays (f32, f64, i16), 1048610 B | 1025 KiB | 505 B | 1729 B |
| nested maps, short text keys, 1107041 B | 1082 KiB | 505 B | 558 KiB |
| text-heavy map (4,500 text values), 1228956 B | 1201 KiB | 505 B | 19 KiB |

## Reading

* **Open + one field.** The check dominates opening a view. The field read
  after it costs about 0.2–0.5 µs with no directory. On map-heavy and
  text-heavy bodies, open + one field beats decode() + the field: 2.5–2.7× on
  the nested maps, about 1.9× on text-heavy (borrowed). The reason is that no
  value is built. On the 1 MiB bstr put it is 110× faster borrowed. An owned
  view pays the copy, about 0.17 ms per MB on this loaded machine, so it lands
  close to decode(). On the int array it is only 1.15× faster: the check is the
  cost there.
* **Linear lookup in a large container is O(n).** A field deep in the
  120 000-int array, or in the 9 000-document map, costs ms per access without
  a directory. With `directories: true` it costs 0.07–0.5 µs per lookup path.
  Directories are built lazily, one word per child, only for containers with
  at least 8 children (D053). They are still 7–30× slower than a property read
  on a decoded object, which is the price of not materialising.
* **Cursor walk.** Walking every item with a Cursor beats decode() + walk
  everywhere except the 120 000-int array: 3.6× on nested maps, 24× on
  text-heavy, and 150× or more on the bstr/typed bodies, where no payload is
  copied. On the int array the Cursor walk is 1.5× slower than decode() +
  walk: about 39 ns per item, roughly three kin head reads per item. A cached
  current head would be the next optimisation.
* **Full materialise.** value() on an open view equals decode()'s builder
  pass. Open + value() is check + build, the same work as decode().
* **Memory.** A borrowed view retains about 0.5 KB: the View, the message
  state and its 8-word Int32Array. An owned view retains its copy. The
  directories after 2 000 random lookups take 471 KiB on the int array
  (120 000 words) and 558 KiB on the nested maps (81 468 words in about 9 000
  Int32Arrays). That is why directories are opt-in.

## Size (esbuild, minified ES module)

| artefact | raw | gzip -9 | brotli 11 |
| --- | ---: | ---: | ---: |
| `host/js/src/view.mjs` bundled (with scan, build, values, nav) | 26 234 | 9 549 | 8 631 |
| `host/js/src/view.mjs` alone (not bundled) | 10 476 | 3 952 | 3 601 |
| `gen/js/snug/nav/walk.mjs` bundled | 2 283 | 1 040 | 974 |
| for comparison: `host/js/src/index.mjs` (decode/encode) bundled | 21 213 | 8 029 | 7 231 |
