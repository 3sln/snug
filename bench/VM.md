# P3.4 — the validator VM: snug JS vs snug wasm vs the `cddl` crate

Recorded 2026-10-29 by the VM engineer. Reproduce with
`node bench/vm-bench.mjs` (this run; `--quick` for a short pass). Raw output
of this run at the end. `bench/README.md` (codec) and `bench/SCAN.md`
(scanner) are other work items' files.

## What is compared

| | what | source |
| --- | --- | --- |
| **snug JS** | the kin-generated VM, low-level `vm-validate` with a reused scratch (the per-isolate lease of `host/js/src/schema.mjs` is the same call plus a flag) | `gen/js/snug/vm/*.mjs` from `kin/vm-*.kin` |
| **snug wasm** | the same kin source, Rust → `wasm32-unknown-unknown` (`kin/scripts/wasm-build speed`: O3, LTO, build-std, `panic=immediate-abort`), timed **including the copy of the input into linear memory** (Program loaded once per schema) | `host/wasm/src/lib.rs` `snug_vm_validate` |
| **crate** | the Rust `cddl` crate's wasm build from the 3sln.me study, via its wasm-bindgen API (`compile` once, `validate_cbor(handle, rule, bytes)` per call, which returns a JSON string — part of its cost) | the study's `cddlproj-oracle/pkg` (session scratch, not committed) |
| **cbor.mjs** | 3sln.me's `decode` (builds values; strict profile, no schema) — for the end-to-end decode rows | `bench/baseline/cbor-3sln.mjs` |

Every verdict is checked outside the timed loops. A `!` marks a row where a
column disagrees with the expected verdict; both such rows are the crate's
(its known defects from the study: it accepts `javascript:https://x` against
the `https://` regexp, and it refuses a valid signaling `invite`).

## Environment and method

Apple M1 Pro (10 cores), macOS 14.6.1 (Darwin 23.6.0), Node v24.6.0. The
machine is **shared**: load average 8–16 during the run. Each cell measures
**CPU time** (`process.cpuUsage`, user + system), calibrates an iteration
count to ≥ 100 ms of CPU, then reports the **median of 7** repetitions per
call. Snug columns use the compiled default limits except where a row says
"budget unlimited" (Programs compiled with `budget: 2^31−1, items: 2^24,
entries: 2^24` so that the large inputs are measured to the end); "budget" is
the VM's units used (`out[3]`).

## 1. The six study contracts, with the study's probe values

Per call. Compile (snug JS, whole contract) in the last column of each group.

| contract | rule | bytes | verdict | snug JS | snug wasm | crate | budget |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| object-storage-v1 | request | 59 | valid | 5.6 µs | 3.1 µs | 331 µs | 253 |
| | request | 66 | invalid | 4.5 µs | 2.5 µs | 701 µs | 205 |
| | request | 51 | valid | 5.4 µs | 2.9 µs | 199 µs | 256 |
| | request | 71 | valid | 6.4 µs | 3.6 µs | 604 µs | 286 |
| | request | 27 | valid | 2.6 µs | 1.4 µs | 38 µs | 133 |
| | presign-result | 95 | valid | 3.3 µs | 1.8 µs | 243 µs | 265 |
| | presign-result | 92 | invalid | 0.84 µs | 0.51 µs | 225 µs ! | 55 |
| | *compile* | | | 8.9 ms | | | |
| item-classification-v1 | classify-args | 102 | valid | 5.5 µs | 2.8 µs | 218 µs | 403 |
| | classify-args | 163 | valid | 8.6 µs | 4.7 µs | 1.30 ms | 656 |
| | classify-args | 128 | invalid | 4.2 µs | 2.3 µs | 1.21 ms | 320 |
| | *compile* | | | 12.7 ms | | | |
| event-bus-tasks | payload | 21 | valid | 0.93 µs | 0.51 µs | 11.0 µs | 42 |
| | record (`.cbor`) | 29 | valid | 1.6 µs | 0.79 µs | 17.5 µs | 70 |
| | record (`.cbor`) | 27 | invalid | 1.2 µs | 0.64 µs | 18.1 µs | 50 |
| | *compile* | | | 1.2 ms | | | |
| preferences-v2 | result | 107 | valid | 4.7 µs | 2.7 µs | 303 µs | 483 |
| | result | 140 | valid | 5.3 µs | 2.9 µs | 309 µs | 489 |
| | result (decimal) | 56 | valid | 2.8 µs | 1.7 µs | 121 µs | 268 |
| | *compile* | | | 5.6 ms | | | |
| ledger-numeric | entry | 165 | valid | 5.2 µs | 2.5 µs | 58 µs | 271 |
| | entry | 39 | invalid | 0.74 µs | 0.47 µs | 52 µs | 41 |
| | *compile* | | | 1.5 ms | | | |
| signaling-message-v1 (as CBOR) | message | 207 | valid | 12.2 µs | 6.7 µs | 484 µs | 989 |
| | message | 262 | valid | 16.9 µs | 9.9 µs | 1.30 ms | 1489 |
| | message | 296 | valid | 16.4 µs | 8.7 µs | 1.60 ms ! | 1198 |
| | message | 260 | invalid | 15.8 µs | 9.2 µs | 1.65 ms | 1448 |
| | *compile* | | | 6.1 ms | | | |

snug JS is 11–270× faster than the crate on every probe; snug wasm is
1.6–2× faster than snug JS on these small messages (the input copy is
negligible here).

## 2. The P1.4 inputs against permissive schemas (budget unlimited)

| input | schema | snug JS | snug wasm | crate | budget |
| --- | --- | ---: | ---: | ---: | ---: |
| 216 profile vectors (all, per set) | `any` | 35.4 µs | 45.8 µs | — (traps; study §6) | |
| RPC put, 287 B | `any` | 1.1 µs | 0.57 µs | 3.3 µs | 62 |
| | `{ * tstr => any }` | 4.6 µs | 1.9 µs | 12.4 µs | 191 |
| RPC put with 1 MiB bstr | `any` | 1.1 µs | 26.2 µs | 113 µs | 62 |
| | `{ method: tstr, args: { key: tstr, data: bstr, * tstr => any }, * tstr => any }` | 6.8 µs | 29.2 µs | 34.3 ms | 296 |
| 120,000-int array, 584 KB | `any` | 2.67 ms | 0.92 ms | 4.23 ms | 120 009 |
| | `{ v: [* int] }` | 18.3 ms | 9.46 ms | 89.1 ms | 1 440 024 |
| 1 MiB typed arrays | `any` | 0.18 ms | 0.11 ms | 0.11 ms | 12 305 |
| | `{ f32: #6.85(bstr), f64: #6.86(bstr), i16: #6.77(bstr) }` | 0.18 ms | 0.11 ms | 0.25 ms | 12 363 |
| nested maps, 1.1 MB | `any` | 7.05 ms | 3.48 ms | 28.1 ms | 756 009 |
| | `{ docs: [* { * tstr => any }] }` | 48.5 ms | 19.0 ms | 162 ms | 2 484 024 |

Against `any` the VM's dead walk (D043) runs at the scanner's speed
(`bench/SCAN.md`: generated scanner 1.9 ms on the int array, 5.8 ms on the
nested maps; the VM adds one budget charge per item). A live schema costs
what the §14 schedule charges: ~12 units per array element of `[* int]`, ~23
per map pair of `{ * tstr => any }` (key and value are both evaluated
live). wasm loses only where the input copy dominates (1 MiB byte string:
26 µs of copy).

## 3. Hostile inputs (default limits unless stated)

| input | snug result | snug JS | snug wasm | crate |
| --- | --- | ---: | ---: | ---: |
| invalid 1.48 MB vs six-way choice of map types, default 4 M budget | `budget` at 4 000 000 units | 75.2 ms | 38.0 ms | 2 444 ms (refuses) |
| the same, budget unlimited | `value` at `[last, "kind"]`, 13 677 021 units | 257 ms | 130 ms | 2 417 ms |
| declared length 2^64−1 | `cbor/truncated` | 0.11 µs | 0.17 µs | 0.32 µs |
| 32-deep nesting (`r = [* r] / int`) | ok | 6.6 µs | 3.2 µs | 11.0 µs |
| 1.4 MB text vs `tstr .regexp "(a\|b\|ab\|ba)*c"` | `budget` at 4 000 000 | 18.1 ms | 14.9 ms | 208 ms |

**Budget calibration (input to Phase 4, not decided here).** Measured CPU per
budget unit in snug JS on this loaded machine: 4.5 ns (regexp), 12.7 ns
(live int array), 18.8 ns (six-way map choice), 19.5 ns (wildcard maps),
~22 ns (contract maps). At the default 4 M units the worst observed
budget-bounded input costs ~75–90 ms in Node here (wasm ~38 ms), above
architecture §7's 50 ms target for workerd; either the default budget drops
to ~2 M or the per-unit costs of map pairs come down. The schedule is the
same code on every host, so this is a calibration, not a correctness, issue.

## 4. End-to-end decode: `schema.decode` (VM, then the trusted builder) vs cbor.mjs

| input | schema | snug decode | (validate) | cbor.mjs | ratio |
| --- | --- | ---: | ---: | ---: | ---: |
| RPC put, 287 B | `any` | 3.3 µs | 1.1 µs | 5.6 µs | 0.59× |
| | `{ * tstr => any }` | 6.5 µs | 4.3 µs | 5.6 µs | 1.15× |
| RPC put with 1 MiB bstr | `any` | 294 µs | 1.1 µs | 303 µs | 0.97× |
| | contract-shaped | 320 µs | 6.3 µs | 302 µs | 1.06× |
| 120,000-int array | `any` | 3.67 ms | 2.53 ms | 2.66 ms | 1.38× |
| | `{ v: [* int] }` | 18.7 ms | 18.0 ms | 2.61 ms | 7.14× |
| 1 MiB typed arrays | `any` | 0.51 ms | 0.17 ms | 0.72 ms | 0.71× |
| | typed-array tags | 0.50 ms | 0.18 ms | 0.70 ms | 0.72× |
| nested maps, 1.1 MB | `any` | 25.6 ms | 6.9 ms | 88.4 ms | 0.29× |
| | `{ docs: [* { * tstr => any }] }` | 66.4 ms | 48.3 ms | 92.2 ms | 0.72× |

Profile-only decode (VM against `any` + builder) beats cbor.mjs everywhere
except the int array (1.38×: the builder's per-int cost plus one budget
charge per item). With a live schema the validation dominates on scalar-heavy
arrays (7.1× on 120 000 ints): that is D017's two-pass question with a
schema; the per-element VM cost (12 units, ~150 ns in JS) is the lever.

## Raw output (this run)

```
# 1. study contracts: per call, median CPU (snug JS | snug wasm | cddl crate wasm)
object-storage-v1.cddl       request            59 B valid   |    5.6 µs  |    3.1 µs  |  331.3 µs  | budget 253
object-storage-v1.cddl       request            66 B invalid |    4.5 µs  |    2.5 µs  |  701.4 µs  | budget 205
object-storage-v1.cddl       request            51 B valid   |    5.4 µs  |    2.9 µs  |  198.5 µs  | budget 256
object-storage-v1.cddl       request            71 B valid   |    6.4 µs  |    3.6 µs  |  604.0 µs  | budget 286
object-storage-v1.cddl       request            27 B valid   |    2.6 µs  |    1.4 µs  |   38.3 µs  | budget 133
object-storage-v1.cddl       presign-result     95 B valid   |    3.3 µs  |    1.8 µs  |  243.1 µs  | budget 265
object-storage-v1.cddl       presign-result     92 B invalid |    839 ns  |    513 ns  |  224.6 µs ! crate says true | budget 55
                             compile (snug JS): 8.88 ms
item-classification-v1.cddl  classify-args     102 B valid   |    5.5 µs  |    2.8 µs  |  217.9 µs  | budget 403
item-classification-v1.cddl  classify-args     163 B valid   |    8.6 µs  |    4.7 µs  |   1.30 ms  | budget 656
item-classification-v1.cddl  classify-args     128 B invalid |    4.2 µs  |    2.3 µs  |   1.21 ms  | budget 320
                             compile (snug JS): 12.70 ms
event-bus-tasks.cddl         payload            21 B valid   |    929 ns  |    510 ns  |   11.0 µs  | budget 42
event-bus-tasks.cddl         record             29 B valid   |    1.6 µs  |    790 ns  |   17.5 µs  | budget 70
event-bus-tasks.cddl         record             27 B invalid |    1.2 µs  |    637 ns  |   18.1 µs  | budget 50
                             compile (snug JS): 1.17 ms
preferences-v2.cddl          result            107 B valid   |    4.7 µs  |    2.7 µs  |  302.7 µs  | budget 483
preferences-v2.cddl          result            140 B valid   |    5.3 µs  |    2.9 µs  |  308.5 µs  | budget 489
preferences-v2.cddl          result             56 B valid   |    2.8 µs  |    1.7 µs  |  121.0 µs  | budget 268
                             compile (snug JS): 5.60 ms
ledger-numeric.cddl          entry             165 B valid   |    5.2 µs  |    2.5 µs  |   58.3 µs  | budget 271
ledger-numeric.cddl          entry              39 B invalid |    738 ns  |    469 ns  |   52.0 µs  | budget 41
                             compile (snug JS): 1.53 ms
signaling-message-v1.cddl    message           207 B valid   |   12.2 µs  |    6.7 µs  |  484.3 µs  | budget 989
signaling-message-v1.cddl    message           262 B valid   |   16.9 µs  |    9.9 µs  |   1.30 ms  | budget 1489
signaling-message-v1.cddl    message           296 B valid   |   16.4 µs  |    8.7 µs  |   1.60 ms ! crate says false | budget 1198
signaling-message-v1.cddl    message           260 B invalid |   15.8 µs  |    9.2 µs  |   1.65 ms  | budget 1448
                             compile (snug JS): 6.14 ms

# 2. P1.4 inputs against permissive schemas (budget unlimited): snug JS | snug wasm | crate wasm
vectors (216 profile vectors, all)             r = any                                  |   35.4 µs |   45.8 µs | -
RPC put, 287 B                                 r = any                                  |    1.1 µs |    566 ns |    3.3 µs | budget 62
RPC put, 287 B                                 r = { * tstr => any }                    |    4.6 µs |    1.9 µs |   12.4 µs | budget 191
RPC put with 1 MiB bstr, 1048856 B             r = any                                  |    1.1 µs |   26.2 µs |  113.0 µs | budget 62
RPC put with 1 MiB bstr, 1048856 B             r = { method: tstr, args: { key: tstr, d |    6.8 µs |   29.2 µs |  34.26 ms | budget 296
120,000-int array, 584247 B                    r = any                                  |   2.67 ms |  919.0 µs |   4.23 ms | budget 120009
120,000-int array, 584247 B                    r = { v: [* int] }                       |  18.28 ms |   9.46 ms |  89.08 ms | budget 1440024
1 MiB typed arrays (f32, f64, i16), 1048610 B  r = any                                  |  176.4 µs |  112.9 µs |  114.3 µs | budget 12305
1 MiB typed arrays (f32, f64, i16), 1048610 B  r = { f32: #6.85(bstr), f64: #6.86(bstr) |  177.7 µs |  113.5 µs |  245.5 µs | budget 12363
nested maps, short text keys, 1107041 B        r = any                                  |   7.05 ms |   3.48 ms |  28.12 ms | budget 756009
nested maps, short text keys, 1107041 B        r = { docs: [* { * tstr => any }] }      |  48.47 ms |  18.96 ms | 162.12 ms | budget 2484024

# 3. hostile inputs
invalid 1484048 B vs six-way choice, default 4 M budget      code 48 budget 4000000 | 75.21 ms | 38.02 ms | crate 2443.66 ms false
invalid 1484048 B vs six-way choice, unlimited budget        code 35 budget 13677021 | 257.32 ms | 130.13 ms | crate 2417.27 ms false
declared length 2^64-1 (byte string)                         code 1 budget 2 | 110 ns | 166 ns | crate 322 ns false
32-deep nesting                                              code 0 budget 491 | 6.6 µs | 3.2 µs | crate 11.0 µs true
regexp, 1.4 MB text, default budget                          code 48 budget 4000000 | 18.08 ms | 14.89 ms | crate 208.20 ms false

# 4. end-to-end decode: schema.decode (VM + builder) vs cbor.mjs decode
RPC put, 287 B                                 r = any                                  | decode    3.3 µs (validate 1.1 µs) | cbor.mjs    5.6 µs | 0.59x
RPC put, 287 B                                 r = { * tstr => any }                    | decode    6.5 µs (validate 4.3 µs) | cbor.mjs    5.6 µs | 1.15x
RPC put with 1 MiB bstr, 1048856 B             r = any                                  | decode  293.9 µs (validate 1.1 µs) | cbor.mjs  303.2 µs | 0.97x
RPC put with 1 MiB bstr, 1048856 B             r = { method: tstr, args: { key: tstr, d | decode  320.2 µs (validate 6.3 µs) | cbor.mjs  301.7 µs | 1.06x
120,000-int array, 584247 B                    r = any                                  | decode   3.67 ms (validate 2.53 ms) | cbor.mjs   2.66 ms | 1.38x
120,000-int array, 584247 B                    r = { v: [* int] }                       | decode  18.65 ms (validate 17.95 ms) | cbor.mjs   2.61 ms | 7.14x
1 MiB typed arrays (f32, f64, i16), 1048610 B  r = any                                  | decode  508.7 µs (validate 173.6 µs) | cbor.mjs  716.3 µs | 0.71x
1 MiB typed arrays (f32, f64, i16), 1048610 B  r = { f32: #6.85(bstr), f64: #6.86(bstr) | decode  499.5 µs (validate 178.6 µs) | cbor.mjs  697.7 µs | 0.72x
nested maps, short text keys, 1107041 B        r = any                                  | decode  25.63 ms (validate 6.93 ms) | cbor.mjs  88.38 ms | 0.29x
nested maps, short text keys, 1107041 B        r = { docs: [* { * tstr => any }] }      | decode  66.41 ms (validate 48.26 ms) | cbor.mjs  92.16 ms | 0.72x

{"cpu":"Apple M1 Pro","cores":10,"os":"Darwin 23.6.0","node":"v24.6.0","load":"8.2 13.1 13.0","wasm":true,"crate":true,"date":"2026-10-29T23:56:06.303Z"}
```
