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

---

# P6.2 — the resumable session vs the buffer driver

Recorded 2026-11-03 by the session-VM engineer. Reproduce with
`node bench/vmsession-bench.mjs` (`--quick` for a short pass). Apple M1 Pro,
macOS 14.6.1, Node v24.6.0; the machine was **shared** (load average 14 at
the start of this run, 50–90 earlier in the day from other agents' work), so
only ratios within one row mean much. Method: CPU time
(`process.cpuUsage`); per input the six variants run in **interleaved
rounds** (each round ~25 ms of CPU per variant), median of 11 rounds; every
variant's whole out array is checked against the buffer driver first.
Session arrays are allocated once per schema and re-initialised per call
(`vms-init`), as a pooled host would; windows are zero-copy `subarray` views
from an in-memory buffer, each starting where the session asks, of
max(window size, its need). Inputs and schemas are section 2's (budget
unlimited). JS only (generated); Rust/wasm sessions were not timed.

| input | schema | buffer | session, one window | one window, quantum 64 Ki | 64 KiB | 16 KiB | 1 KiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 216 profile vectors (per set) | `any` | 99.3 µs | 191 µs (1.92×) | 182 µs | 180 µs | 184 µs | 190 µs |
| RPC put, 287 B | `any` | 2.6 µs | 2.9 µs (1.14×) | 2.9 µs | 2.9 µs | 3.0 µs | 3.0 µs |
| | `{ * tstr => any }` | 3.9 µs | 4.4 µs (1.12×) | 4.4 µs | 4.4 µs | 4.4 µs | 4.4 µs |
| RPC put with 1 MiB bstr | `any` | 2.8 µs | 3.2 µs (1.15×) | 9.2 µs | 8.6 µs | 8.5 µs | 8.5 µs |
| | contract-shaped | 18.4 µs | 18.8 µs (1.02×) | 27.3 µs | 26.0 µs | 26.2 µs | 25.9 µs |
| 120,000-int array | `any` | 1.70 ms | 1.72 ms (1.01×) | 1.88 ms | 1.92 ms (1.13×) | 1.76 ms | 2.09 ms (1.23×) |
| | `{ v: [* int] }` | 3.26 ms | 3.20 ms (0.98×) | 3.49 ms | 3.55 ms (1.09×) | 3.44 ms | 4.11 ms (1.26×) |
| 1 MiB typed arrays | `any` | 486 µs | 481 µs (0.99×) | 507 µs | 505 µs (1.04×) | 519 µs | 790 µs (1.62×) |
| | typed-array tags | 506 µs | 507 µs (1.00×) | 516 µs | 529 µs (1.05×) | 548 µs | 813 µs (1.60×) |
| nested maps, 1.1 MB | `any` | 21.3 ms | 21.3 ms (1.00×) | 29.3 ms | 28.8 ms (1.35×) | 29.6 ms | 35.7 ms (1.68×) |
| | `{ docs: [* { * tstr => any }] }` | 38.7 ms | 38.6 ms (1.00×) | 50.4 ms | 49.5 ms (1.28×) | 51.1 ms | 73.3 ms (1.90×) |

Reading it:

* **One window = the buffer walk** (0.98–1.02× on every large input): the
  root item fits the window, so the session hands it to `eval-item` whole.
  The fixed cost of a session is ~0.3–0.5 µs per message (`vms-init`, the
  step loop): visible only on tiny messages (1.1× on 287 B, 1.9× over the 216
  vectors of a few bytes each).
* **Windows cost the prescan and the chain's frames.** Scalar-dense arrays
  run the buffer walk's streaks inside the frame (1.09–1.13× at 64 KiB); a
  head-dense document pays the structural prescan of each window (one pass
  over its heads, about a third of a dead walk) and a frame per crossing
  container: 1.28–1.35× at 64 KiB, 1.7–1.9× at 1 KiB. A 1 MiB byte string
  costs ~6 µs of window round trips whatever the size (its content is never
  read).
* **The quantum** (64 Ki units) on one whole window costs what 64 KiB windows
  cost: each quantum's cut is a window boundary for the walk.
* Before the frames ran the streaks (first draft of this item), the 120,000-int
  array cost 15–22× at 64 KiB: every element made a round trip through the
  session loop and the generic element step. Measured on this run's tree.
* A V8 artifact to know about: `array-streak` / `dead-int-streak` are entered
  from OSR code whose post-loop stores lacked type feedback, and in some
  orders of first use V8 deoptimises at every loop exit (≈ 20 µs a call):
  seen as 3.5× at 1 KiB windows on the int array in other process histories
  of this benchmark, 1.26× here. Rust and wasm do not have it.
---

# Extension controls and drain mode (P7.2/D085) — 2026-11-03

Measured **only the clean tracked files at
`aa7dd560491e7c733015562029be1562be37d56d`**, in detached
`.cache/extbench-wt`. The shared checkout's uncommitted scanner/kin work was
excluded. This sandbox denies writes to the shared `.git`, so the worktree
was registered in temporary `.cache/extbench-git` metadata with a read-only
object-store alternate. No builds, installs, network, commits or remote
operations were used. The worktree was removed with `git worktree remove`.
Only JS is measured; these figures do not establish Rust/wasm or browser costs.

Reproduction (from the main checkout, with the delivered benchmark file):

```sh
revision=aa7dd560491e7c733015562029be1562be37d56d
git init --bare --template= .cache/extbench-git
printf '%s\n' "$PWD/.git/objects" > .cache/extbench-git/objects/info/alternates
git --git-dir=.cache/extbench-git worktree add --detach .cache/extbench-wt "$revision"
cp bench/ext-drain-bench.mjs .cache/extbench-wt/bench/ext-drain-bench.mjs
(cd .cache/extbench-wt && node --expose-gc --single-threaded-gc bench/ext-drain-bench.mjs --out ../extbench-results.json > ../extbench-results.log)
git --git-dir=.cache/extbench-git worktree remove --force .cache/extbench-wt
```

On an unrestricted checkout, ordinary `git worktree add --detach` / `remove`
also suffice. `--force` discards only the copied, untracked benchmark script
in this disposable worktree. `--quick` shortens timing; `--check-only` runs
fixture/agreement checks without timings or memory children. The script
refuses modified tracked sources, prints complete result tables and caveats,
and optionally saves all round samples, input hashes, schema texts, verdicts
and 54 memory samples as JSON. Local raw output is under
`.cache/extbench-results.{json,log}`; those scratch artifacts are not required
to reproduce the fixtures.

**Machine and method.** Apple M1 Pro, 10 logical CPUs,
32 GiB RAM, macOS 14.6.1 (Darwin 23.6.0 arm64),
Node v24.6.0, V8 13.6.233.10-node.24, flags
`--expose-gc --single-threaded-gc`. Local date is 2026-11-03
(America/Merida); UTC run 2026-11-04T05:46:57.302Z to 2026-11-04T05:50:48.452Z.
The machine was shared: 1/5/15-minute load averages were
21.43, 14.46, 11.95 at start and
45.64, 37.28, 22.73 at end; free RAM snapshots
1.56 / 1.06 GiB.
These are load snapshots, not continuous monitoring.

CPU is `process.cpuUsage` user + system, **median of 11 rotated,
interleaved rounds** within each input's arms, after at least 200 ms CPU
warm-up per arm and separate iteration calibration targeting at least
25 ms CPU batches. Compile, input construction, assertions, callback counters
and memory sampling are excluded. Buffer times use public `schema.validate`;
stream times use public `pushValidator`, with a **new session per call**,
normal allocation/copying and finalization included. This differs from P6.2's
pooled low-level VM arrays. Scheduling quantum is 0; there is no actual I/O.
No forced GC occurs inside CPU timings. Fixed iteration counts can run faster
after calibration; the observed per-arm median batches ranged from 9.6 ms
to 248.8 ms CPU.

All Programs use deterministic wire rules, input cap 1,500,000 B,
`budget: 2^31−1`, `items: 2^24`, `entries: 2^24`. Registry `maxBytes` is
raised from the default 65,536 to **1,500,000 B** for all timed controls;
otherwise large controls would measure `control_size`, not predicate work.
Defaults are checked separately. These are throughput measurements with
raised work limits, not default-budget acceptance claims.

**EXT fixtures and cost.** The 287 B RPC is a synthetic `put` with
`args.name`, distinct `args.tags`, equal-count `args.x/y` and a byte payload,
padded to exactly 287 B; it differs from P1.4's RPC. Its base rule is
`{method: tstr, args: {name: tstr, tags: [* tstr], x: [* uint], y: [* uint], data: bstr}}`.
Every arm sees the same bytes. A `.pass true` predicate always returns true.
`.chars` checks the name, `.unique` the tags, and `.samelen ["x", "y"]`
the args map. The large text array/map each hold 4,096 ASCII strings of
253 characters (255 encoded bytes); the map uses fixed `k0000`…`k4095`
keys. The column map holds two 32,768-element bstr arrays.

“Equivalent” means **same verdict on these timed fixtures**: controls add
redundant constraints to the same base target. There is no general
built-in-only schema equivalent of arbitrary uniqueness or Unicode
code-point length. ASCII makes byte/character counts coincide here;
non-ASCII, duplicates and unequal counts are covered by untimed assertions.

RPC CPU per call (extension delta includes VM AND/EXT query work, charging,
view creation and host dispatch; it is not an isolated JS call instruction):

| arm | controlled item B | CPU | delta vs built-in |
| --- | --- | --- | --- |
| built-in | — | 8.52 µs | — |
| pass-root | 287 | 9.38 µs | 0.86 µs |
| chars-name | 5 | 11.43 µs | 2.91 µs |
| unique-tags | 5 | 10.46 µs | 1.94 µs |
| samelen-args | 270 | 11.52 µs | 3.00 µs |

Large inputs; each delta is against the same input's built-in-only schema.
Item B is the sum of whole encoded items handed to the predicate, including heads.

| input | bytes | arm | calls | CPU | delta | delta ns/item B |
| --- | --- | --- | --- | --- | --- | --- |
| array-text-1MiB | 1,044,483 | built-in | 0 | 3.14 ms | — | — |
| array-text-1MiB | 1,044,483 | pass-root | 1 | 3.14 ms | 4.11 µs | 0.004 |
| array-text-1MiB | 1,044,483 | pass-item | 4096 | 8.24 ms | 5.10 ms | 4.885 |
| array-text-1MiB | 1,044,483 | chars-item | 4096 | 11.01 ms | 7.87 ms | 7.534 |
| map-text-1MiB | 1,069,059 | built-in | 0 | 3.71 ms | — | — |
| map-text-1MiB | 1,069,059 | pass-root | 1 | 3.74 ms | 29.26 µs | 0.027 |
| map-text-1MiB | 1,069,059 | pass-value | 4096 | 11.46 ms | 7.76 ms | 7.425 |
| map-text-1MiB | 1,069,059 | chars-value | 4096 | 14.34 ms | 10.63 ms | 10.177 |
| samelen-map-1MiB | 1,048,587 | built-in | 0 | 10.66 ms | — | — |
| samelen-map-1MiB | 1,048,587 | pass-root | 1 | 10.72 ms | 61.33 µs | 0.058 |
| samelen-map-1MiB | 1,048,587 | samelen-root | 1 | 11.46 ms | 796.33 µs | 0.759 |

The small root-level VM-to-host extension costs **0.86 µs/call**
in this comparison. Per-value no-op extensions add
**1.25 µs/call** on the text array and
**1.89 µs/call** on the map. Per-element extensions
also change VM fast-path/query work, so these are total integration costs,
not a universal host-call constant. `.chars` adds a content scan; root no-op
byte charging is arithmetic, not a second physical byte scan. Tiny or negative
large-root deltas are below this run's resolution and do not imply a speedup.

**Worst-case stress for `.unique`.** Distinct 15-byte bstrs share a
12-byte payload prefix; an odd multiplicative permutation (`(i * 40503) & (n−1)`) defeats an already-sorted input. Each encoded element is 16 B.
The generic control heap-sorts spans: **O(n log n) span comparisons**, with
additional cost for the compared prefix length. This stresses its 65,536-item
case; it is not a proof that this permutation maximises every comparison.

| elements | bytes | built-in | pass root | unique root | unique − pass ns/item B | unique − pass ns/(n log2 n) |
| --- | --- | --- | --- | --- | --- | --- |
| 4,096 | 65,539 | 672.67 µs | 672.12 µs | 6.50 ms | 88.89 | 118.5 |
| 16,384 | 262,147 | 2.69 ms | 2.69 ms | 32.31 ms | 113.00 | 129.1 |
| 65,536 | 1,048,581 | 10.69 ms | 10.58 ms | 175.99 ms | 157.75 | 157.7 |

At 65,536 elements, `uniqueWords(itemBytes) = 2 * itemBytes + 2` means
8,388,656 B of host Int32 scratch. `snug/controls` drops scratch larger than
2^20 words after each call, so this row includes repeated allocation; the
4,096/16,384-element rows reuse retained scratch after warm-up. This is an
implementation-derived allocation size, not a measured EXT memory peak.

**EXT under choices.** The base RPC target is `T`; the deny predicate
always returns false. Counter registries used only outside timing confirm
one call per queried extension item, and no call when a target fails.

| schema | built-in comparison | EXT CPU | delta |
| --- | --- | --- | --- |
| (T .pass true) / bstr | 9.70 µs | 10.64 µs | 0.95 µs |
| (T .deny true) / T | 9.72 µs | 10.57 µs | 0.85 µs |

**Drain versus known length versus fail-fast.** Every message is exactly
**1,400,000 B**. Valid and late-schema fixtures contain 10,000 records with
`id: uint`, `title: tstr`, `body: tstr`, plus text padding. Late-schema changes
the last title to a byte string without changing wire validity or length.
Early-wire replaces the first map-key head with `0xff` (`cbor/indefinite`).
Pending-truncation declares a 1,450,000-element array, then starts with
`0xff`: the known end proves truncation before that refusal; drain waits to
settle it. Limit-after-error is early-wire with `maxBytes: 1,350,000`.
Trailing starts with a complete integer root followed by the remaining bytes.

Below each cell is **CPU ms / delivered MiB/s**. Throughput divides bytes
actually delivered by CPU time: a fail-fast cell's rate must not be read as
processing the full 1.4 MB. Very high rejection throughput mostly counts and
drops bytes; it does not scan their contents. Known push keeps delivering all
bytes and always calls finalize, as its API requires, including after early
done. A known-length range-handle caller could stop reads earlier; that is a
different source contract. Drain stops when the cap is exceeded. Fast is
unknown-length with `failFast: true`; acceptance always waits for EOF.

| fixture | chunk KiB | known | drain | fast |
| --- | --- | --- | --- | --- |
| valid | 64 | 25.480 / 52.4 | 25.776 / 51.8 | 26.010 / 51.3 |
| valid | 16 | 26.993 / 49.5 | 26.805 / 49.8 | 26.661 / 50.1 |
| valid | 1 | 36.999 / 36.1 | 37.282 / 35.8 | 36.265 / 36.8 |
| early-wire | 64 | 0.694 / 1924.2 | 0.650 / 2054.4 | 0.836 / 74.8 |
| early-wire | 16 | 0.516 / 2587.2 | 0.726 / 1838.9 | 0.675 / 23.2 |
| early-wire | 1 | 0.992 / 1345.5 | 1.161 / 1150.1 | 0.600 / 1.6 |
| late-schema | 64 | 25.358 / 52.7 | 25.844 / 51.7 | 26.190 / 51.0 |
| late-schema | 16 | 26.541 / 50.3 | 26.460 / 50.5 | 26.368 / 50.6 |
| late-schema | 1 | 37.680 / 35.4 | 37.414 / 35.7 | 36.384 / 36.7 |
| pending-truncation | 64 | 0.719 / 1857.2 | 0.637 / 2096.7 | 0.630 / 99.2 |
| pending-truncation | 16 | 0.577 / 2314.6 | 0.782 / 1708.1 | 0.668 / 23.4 |
| pending-truncation | 1 | 1.142 / 1169.4 | 1.469 / 909.2 | 0.605 / 1.6 |
| limit-after-error | 64 | 0.592 / 2255.6 | 0.622 / 2109.3 | 0.703 / 88.9 |
| limit-after-error | 16 | 0.664 / 2011.7 | 0.726 / 1785.3 | 0.552 / 28.3 |
| limit-after-error | 1 | 1.087 / 1228.0 | 1.066 / 1208.0 | 0.619 / 1.6 |
| trailing | 64 | 0.651 / 2052.2 | 0.680 / 1964.6 | 0.732 / 85.4 |
| trailing | 16 | 0.708 / 1884.9 | 0.700 / 1906.2 | 0.687 / 22.8 |
| trailing | 1 | 0.988 / 1351.6 | 1.303 / 1024.4 | 0.627 / 1.6 |

Extra reads **after the chunk that first exposes a certain refusal**:
first-error read is the fail-fast delivered count, not the error offset.
This excludes the rest of that already-read chunk in both modes. For the
early wire/trailing examples the deciding prefix is only 2 B, or 6 B for
pending-truncation, but the whole input chunk has already arrived.

| chunk KiB | first-error read B | ordinary drain total B | ordinary drain extra B | limit drain total B | limit drain extra B | fast extra B |
| --- | --- | --- | --- | --- | --- | --- |
| 64 | 65,536 | 1,400,000 | 1,334,464 | 1,376,256 | 1,310,720 | 0 |
| 16 | 16,384 | 1,400,000 | 1,383,616 | 1,359,872 | 1,343,488 | 0 |
| 1 | 1,024 | 1,400,000 | 1,398,976 | 1,350,656 | 1,349,632 | 0 |

Ordinary-drain read counts apply to early-wire, pending-truncation and
trailing. Late-schema first becomes observable at all 1,400,000 B, so both
unknown modes have zero extra reads; valid has no error boundary. Known push
always receives 1,400,000 B, even in the limit case. These are adapter-delivery
counts, not kernel/network read-ahead measurements.

**Memory high water (approximate).** A separate fresh Node child for each
of the 54 stream cells runs one validation: it builds its selected
bytes/Program, forces GC, then samples `process.memoryUsage()` at session creation, after each chunk/resume
and finalization. Heap/external are increases from that baseline; RSS shows
the largest sampled absolute resident size and its increase. These are
**sampled high waters, not exact peaks or heap snapshots**: transient work
inside a feed can be missed, GC/allocator/JIT activity affects RSS, and the
in-memory input/Program are already in the baseline. Sampling is outside all
CPU timing. These children are not warmed like the timing process.
ArrayBuffers are included in external and must not be added to it.

Valid-message samples (MiB except exact exclusive VM-array bytes):

| chunk KiB | mode | VM arrays B | heap increase MiB | external increase MiB | sampled RSS high MiB (+increase) |
| --- | --- | --- | --- | --- | --- |
| 64 | known | 1,411,356 | 1.44 | 1.41 | 117.7 (+12.0) |
| 64 | drain | 1,511,356 | 1.34 | 1.51 | 122.9 (+17.1) |
| 64 | fast | 1,511,356 | 1.57 | 1.51 | 113.8 (+9.7) |
| 16 | known | 1,411,356 | 1.70 | 1.41 | 113.3 (+12.2) |
| 16 | drain | 1,511,356 | 2.17 | 1.49 | 115.8 (+13.7) |
| 16 | fast | 1,511,356 | 1.47 | 1.49 | 111.0 (+6.7) |
| 1 | known | 1,411,356 | 3.62 | 1.41 | 116.8 (+10.0) |
| 1 | drain | 1,511,356 | 3.64 | 1.45 | 133.0 (+28.0) |
| 1 | fast | 1,511,356 | 3.63 | 1.45 | 116.8 (+12.6) |

Invalid-message sample ranges across all five refusal fixtures and three
chunk sizes, 15 fresh children per mode (MiB):

| mode | heap increase | external increase | sampled RSS high | RSS increase |
| --- | --- | --- | --- | --- |
| known | 0.05–3.65 | 1.36–1.41 | 100.5–122.5 | 0.0–15.5 |
| drain | 0.10–3.61 | 1.30–1.51 | 99.5–127.9 | 0.0–22.8 |
| fast | 0.05–3.64 | 1.30–1.51 | 103.8–118.9 | 0.0–13.8 |

The reproducible structural difference is the key arena: for these valid
messages the known session owns **1,411,356 B**, unknown **1,511,356 B**
(**100,000 B more**), because unknown length sizes the arena to the 1.5 MB
input cap instead of 1.4 MB. These figures exclude the Program and host push
buffer. The post-feed retained-byte getter is not a peak buffer-capacity
measurement (a whole chunk can be consumed within feed). Small chunks also
produce more host objects; these samples do not establish a concurrency quota.

**Agreement actually checked (before timing).** Comparisons use the full
public result, including reason, path, offset and optional subcode; public
results do not expose the VM's budget/items words.

| comparisons | count | outcome |
| --- | --- | --- |
| timed EXT inputs/arms × 3 chunks × 3 modes | 261 | all full results equal to buffer |
| 8 independent semantic/size/choice probes × 3 chunks × 3 modes | 72 | all full results equal to buffer and expected reason |
| 6 stream fixtures × 3 chunks × 3 modes | 54 | 48 full results equal; 6 D145 early-code differences |
| fail-fast indefinite → buffer/drain truncated | 3 | pending-truncation, all chunk sizes |
| fail-fast indefinite → buffer/drain too_large | 3 | limit-after-error, all chunk sizes |
| unexpected code differences / verdict mismatches | 0 | none |

All **387 session comparisons agree on accept/refuse**; 381 also agree on
the full public result. Additional untimed counter checks confirm the
expected EXT call counts/item-byte totals. `node --check`, a check-only pass,
a short timing/memory pass, and this full timing/memory pass completed. No
compiler, scanner, VM, host implementation or generated files were changed.
The shared load, public API allocation policy, ASCII text, elevated limits,
long-prefix uniqueness data, chunk-boundary first-error definition and
approximate memory method limit extrapolation.
