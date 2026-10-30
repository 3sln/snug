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

---

# P3.6 — VM performance and budget calibration

Recorded 2026-10-29 by the VM engineer, after the fast paths (D044), the
generic-path tuning and the opt-in schedule 2 (D045). Same machine and method
as above (M1 Pro, Node v24.6.0, shared, load 8–16; CPU time, best of rounds).
Reproduce: `node bench/vm-perf.mjs` (live validation vs the generated scanner,
and `schema.decode` vs cbor.mjs on the codec set), `node bench/vm-calib.mjs
[budget] [--s1]` (CPU per unit, worst budget-bounded inputs, units of valid
messages), `node bench/vm-bench.mjs [--quick]` (the three-way table above).

*Since 2026-10-29 (D045/D046 accepted, provisional)*: schedule 2 is the
default and the compiled default budget is 2.3 M; `vm-calib.mjs` takes
`--s1` for the legacy schedule (it took `--s2` when these tables were
recorded). The tables below are as recorded, labelled by schedule; the
4 M rows in section 3 above predate the change. A re-run at the new
defaults gave a worst of 23.6 ns/unit (contract object-storage request,
generic choice), within this machine's run-to-run spread.

## Live validation vs the scanner (`bench/vm-perf.mjs`)

| input :: schema | before P3.6 | now | scanner | now / scanner |
| --- | ---: | ---: | ---: | ---: |
| RPC put 287 B :: `{ * tstr => any }` | 3.69 µs | 1.20 µs | 0.63 µs | 1.9× |
| RPC put 1 MiB :: `{ method: tstr, args: { key: tstr, data: bstr, * tstr => any }, * tstr => any }` | 5.55 µs | 5.85 µs | 0.66 µs | 8.9× (mixed literal + wildcard maps take the generic path) |
| 120 000 ints :: `{ v: [* int] }` | 15.98 ms | 1.11 ms | 1.30 ms | 0.86× |
| 1 MiB typed arrays :: three tags | 0.19 ms | 0.17–0.22 ms | 0.17 ms | 1.0–1.3× |
| nested maps 1.1 MB :: `{ docs: [* { * tstr => any }] }` | 42.6 ms | 11.0–12.4 ms | 5.0 ms | 2.2–2.4× |
| object-storage request 59 B | 6.27 µs | 5.3 µs | 0.18 µs | 29× |
| object-storage presign-result 95 B | 3.49 µs | 2.4–2.7 µs | 0.24 µs | 10× |
| item-classification 163 B | 8.93 µs | 7.3–7.8 µs | 0.45 µs | 17× |
| event-bus record (`.cbor`) 29 B | 1.63 µs | 1.2–1.3 µs | 0.07 µs | 17× |
| preferences result 107 B | 4.57 µs | 4.2–4.6 µs | 0.28 µs | 15× |
| ledger entry 165 B | 5.14 µs | 4.5–5.6 µs | 0.41 µs | 11–14× |
| signaling message 296 B | 17.1 µs | 13.9–15.0 µs | 0.76 µs | 18–20× |

The ≤ 2× target is met for the integer arrays, the typed arrays and the small
table map, and nearly (2.2–2.4×) for the nested maps. It is **not met for the
study contracts (10–29×) or for mixed literal + wildcard maps**: their maps are
choices of several map types, and type-set evaluation advances every
alternative in parallel (the `args` value of an object-storage request is
evaluated against six map types until `method` arrives), so their cost is the
§14 work itself — 250 units for a 59-byte message — at ~20 ns per unit on
the generic path. Closing that gap needs a different evaluation strategy
(discriminator-first dispatch or the lazy DFA cache of the parking lot), not a
fast path.

## schema.decode (VM, then the trusted builder) vs cbor.mjs decode

| codec workload :: schema | snug decode | cbor.mjs | ratio |
| --- | ---: | ---: | ---: |
| RPC put 287 B :: `any` | 2.90 µs | 5.04 µs | 0.57× |
| RPC put 287 B :: `{ * tstr => any }` | 3.29 µs | 4.81 µs | 0.68× |
| RPC put + 1 MiB :: `any` | 172 µs | 229 µs | 0.75× |
| RPC put + 1 MiB :: `{ * tstr => any }` | 220–245 µs | 165–250 µs | 1.0–1.5× (noisy: the 1 MiB copy dominates both) |
| 120 000 integers :: `any` | 1.57–1.65 ms | 1.8–2.1 ms | 0.74–0.92× |
| 120 000 integers :: `[* int]` | 1.9–2.1 ms | 1.8–2.3 ms | 0.89–1.12× |
| 1 MiB Float64Array :: `any` | 0.39–0.48 ms | 0.40–0.45 ms | 0.9–1.2× |
| 1 MiB Float64Array :: `#6.86(bstr)` | 0.42–0.53 ms | 0.38–0.44 ms | 1.0–1.4× |
| 10 000 maps × 8 keys :: `any` | 6.6 ms | 26.6 ms | 0.25× |
| 10 000 maps × 8 keys :: `[* { * tstr => any }]` | 10.4–11.6 ms | 25.8–26.5 ms | 0.4× |
| 10 000 maps × 8 keys :: struct | 17.6–18.1 ms | 25.1–26.9 ms | 0.7× |
| map-heavy document 1.4 MB :: `any` | 12.9 ms | 31.1 ms | 0.42× |
| map-heavy document 1.4 MB :: nested structs | 25.6–26.3 ms | 31.6–31.8 ms | 0.8× |

`schema.decode` ≤ cbor.mjs holds on every map, struct and integer workload.
The exceptions are the 1 MiB `Float64Array` (1.0–1.4×) and, in some runs, the
1 MiB byte-string put: there the builder's copy of the megabyte, not the VM,
decides (the VM takes 1–6 µs on those inputs).

## Budget calibration (`bench/vm-calib.mjs`)

CPU per budget unit (ns), schedule 1 (program.md §14, the default) and
schedule 2 (D045, opt-in), on large inputs that run to the end with an
unlimited budget:

| event kind | units (s1) | ns/unit s1 | units (s2) | ns/unit s2 |
| --- | ---: | ---: | ---: | ---: |
| dead walk, 120k ints (`any`) | 120 006 | 4.9–13.6 | 120 006 | 5.5–12.7 |
| dead walk, nested maps (`any`) | 756 009 | 7.5–10.3 | 756 009 | 8.0–9.1 |
| `[* int]` (fast) | 1 440 007 | 0.7–0.8 | 240 008 | 4.4–4.7 |
| `[* tstr]` (fast) | 1 200 007 | 1.0 | 200 008 | 6.0–6.4 |
| `{docs: [* {* tstr => any}]}` (fast) | 2 484 024 | 4.2–5.2 | 1 008 018 | 12.8–13.5 |
| struct records (fast struct + generic `bool` pairs) | 1 620 007 | 10.0–11.0 | 880 008 | 20.9–21.4 |
| six-way choice of maps (generic) | 3 048 007 | 19.2–19.4 | 3 048 007 | 18.3–18.6 |
| 20-way choice of maps, late discriminator | 4 512 007 | 18.2–19.3 | 4 512 007 | 17.6–17.7 |
| 20-way mixed (literal + wildcard) maps | 6 714 007 | 18.3–19.6 | 6 714 007 | 18.1–19.1 |
| absorb factor `{ ? (a: int, b: int), * tstr => any }` | 1 740 007 | 15.6–17.5 | 1 580 008 | 17.8–18.5 |
| array of 6-way struct choices, discriminator first | 3 288 007 | 18.3–20.4 | 3 288 007 | 17.6–18.5 |
| 12k object-storage requests (choices) | 3 504 007 | 19.4–21.7 | 3 276 007 | 20.6–20.7 |
| AND per element (text `.size` ∧ `.regexp`) | 1 950 007 | 3.6–4.8 | 1 450 008 | 5.8–5.9 |
| regexp `(a\|b\|ab\|ba)*c`, 200k code points | 1 303 128 | 4.3–4.8 | 1 303 128 | 4.6–4.7 |
| LITSET of 200 text literals | 375 307 | 7.6–8.1 | 175 308 | 17.3–17.6 |
| wide array automaton `[* (uint, tstr, bool, null)]` | 510 007 | 9.3–10.8 | 510 007 | 10.8–10.9 |

(One 253-unit contract message reaches 22–25 ns/unit, the per-call setup
dominating; it is not budget-bounded.) The worst large-input rate is
**~22 ns/unit** under schedule 1 and **~21 ns/unit** under schedule 2, both
on generic choice-of-maps work (and, under schedule 2, struct records whose
`bool` members leave the one-leaf shape).

Units needed by valid benchmark messages:

| message :: schema | bytes | units s1 | units s2 | CPU |
| --- | ---: | ---: | ---: | ---: |
| RPC put :: `{ * tstr => any }` | 287 | 191 | 74 | < 0.01 ms |
| 120k ints :: `{ v: [* int] }` | 584 247 | 1 440 024 | 240 018 | 1.2 ms |
| nested maps :: `{ docs: [* { * tstr => any }] }` | 1 107 041 | 2 484 024 | 1 008 018 | 11–14 ms |
| typed arrays :: tags | 1 048 610 | 12 363 | 12 340 | 0.2 ms |
| struct records (10k) :: nested struct | 1 269 723 | 1 620 007 | 880 008 | 16–19 ms |
| ints :: `[* int]` | 1 456 219 | 3 600 007 | 600 008 | 2.8–3.1 ms |
| 50k small maps :: `[* { * tstr => int }]` | 949 163 | 4 450 007 | 1 450 008 | 23–31 ms |

**The trade-off, plainly.** With program.md §14 as it is (schedule 1), a
default budget that keeps the worst budget-bounded input at ≤ 50 ms of CPU in
Node here is ~2.2–2.3 M units; at that budget valid messages of 1.5 MB of
integers (3.6 M), 1.1 MB of nested maps (2.5 M) and 0.95 MB of small maps
(4.45 M) are refused although they validate in 3–31 ms. The current 4 M
default admits the first two but still refuses the third, and lets the worst
input cost ~80–90 ms. Schedule 1 charges simple shapes 20–30× more units than
their CPU once the fast paths run. Under schedule 2 every valid benchmark
message needs ≤ 1.45 M units, so **schedule 2 with a 2.3 M default** keeps the
worst case at ≈ 50 ms (21–22 ns/unit) and leaves the largest valid benchmark
message at 63% of the budget (D045, D046). Schedule 2 needs program.md §14
and §15 amended (§15.3's `[* tstr]` element charges change) with the compiler
engineer's agreement before it can become the default; the default budget
itself is a compile option the compiler sets (D046).
