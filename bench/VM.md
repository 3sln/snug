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

## Extension-control worst cases under default limits — 2026-11-04

**Verdict: defaults do not keep EXT validation under ~50 ms on this machine.**
These are measured adversarial lower bounds, not proven CPU maxima. Arbitrary
custom predicates have **no finite CPU bound enforced by the VM**, even if
pure; provisional D140's per-byte cost assumption is insufficient.

Clean HEAD **`6c3237e1a18d098516387369f730bac6c7dd78a6`**, detached in
`.cache/unique-wt`; shared uncommitted kin/generated edits excluded. Machine:
Apple M1 Pro, 10 logical CPUs, 32 GiB; macOS 14.6.1 / Darwin 23.6.0 arm64;
Node v24.6.0 / V8 13.6.233.10-node.24, `--expose-gc --single-threaded-gc`.
Public `schema.validate`, **thread CPU user + system**, medians of 7 batches
after >=100 ms CPU warm-up and >=25 ms batch calibration; long rows use
3 single-call samples after one warm call. Construction, compilation and
counters are outside timing; normal allocation/result handling is included,
with no forced GC during timing. Only JS was timed; Rust below is a source audit.

Main run: **06:02:01–06:21:19 UTC**, load 1/5/15-minute **81.13/47.53/32.29 →
22.12/25.72/29.30**. Supplementary run: 06:07:19–06:15:00 UTC,
**42.57/44.42/35.46 → 22.29/29.92/31.94**, overlapping the main long samelen
rows in a separate isolate/thread. Final choice run ended 06:23:46 UTC at
**24.03/25.01/28.42**. Free RAM snapshots ranged down to 0.12 GB in these
processes' metadata. These are snapshots, not continuous monitoring. CPU time
excludes scheduling waits but remains sensitive to frequency, memory pressure,
GC and JIT; these numbers are not portable deadlines.

**All defaults:** input 1,500,000 B; depth 32; entries/container 65,536;
items/message 131,072; bignum 128 B; budget 2,300,000; control maximum
**65,536 B including the item head**. The harness asserts these compiled
limits and default registry maxima. All schemas use default compiler limits.
The item maximum does not cap the controller literal's bytes/name count.

| Control / stress case | Message B | Calls reached | Total steps | Median CPU | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| `.chars`: 22 full two-byte UTF-8 strings | 1,441,771 | 22 | 1,464,745 | 15.54 ms | ok |
| `.chars`: two arrays of 65,534 empty strings | 131,075 | 109,523 | 2,300,000 | 83.05 ms | budget |
| `.unique`: 65,533 one-byte integers cycling through 24 ranks | 65,536 | 1 | 131,087 | 55.04 ms | control |
| `.unique`: 22 arrays × 4,095 long-prefix bstrs | 1,441,507 | 22 | 1,532,043 | 138.44 ms | ok |
| `.unique`: 35 choices over the same ranked array, different controllers | 65,536 | 34 | 2,300,000 | 991.57 ms | budget |
| `.samelen`: 21,000 absent names, 16,400 integer keys | 65,323 | 1 | 114,537 | 4,749.30 ms | ok |
| `.samelen`: 22 maps × 2,978 long-prefix keys, 11,300 names | 1,441,419 | 22 | 1,703,907 | 58,638.25 ms | ok |
| `.samelen`: empty maps, 21,000 empty controller names | 131,075 | 109,523 | 2,300,000 | 50,687.43 ms | budget |
| No-op EXT on tiny integers until budget refusal | 131,075 | 104,545 | 2,300,000 | 79.30 ms | budget |
| Pure custom EXT: fixed 100M multiply/xor iterations on one byte | 1 | 1 | 16 | 303.51 ms | ok |

**Charging versus work.** `kin/vm-eval.kin:ext-eval` charges **1 + encoded
item bytes before calling**, once per queried EXT leaf/item. Oversized items
cost 1 and never call. The old 65,536 × 16-byte long-prefix input (1,048,581 B)
therefore returns `control_size`, zero callbacks, in **3.50 ms** under defaults;
even 4,096 × 16 B plus its array head is too large. Failed targets do not call.
The boolean port has no remaining-budget/interrupt mechanism. D143 sessions
take fitting EXT items whole and run that same predicate; quantum cannot
interrupt it. JS makes two subarray views per callback; Rust borrows slices.

* **`.chars`: proportional.** One count pass over every UTF-8 byte, after the
  profile scan; O(B) predicate work and O(1) argument parsing. ASCII/2/3/4-byte
  full-string batches took **9.78/15.54/13.11/10.79 ms**. One 65,535-B two-byte
  string took **0.716 ms**. The expensive case is dispatch/query/allocation
  overhead: 65,536 empty strings took **49.72 ms**, and budget refusal reached
  83.05 ms. The current calibration fails the ~50 ms target even for linear work.
* **`.unique`: not proportional.** Span recording, heap sort, swaps, then
  adjacent comparisons. The ranked array performs **1,837,356 comparisons and
  compared byte pairs** for **65,537 EXT units**; duplication is detected only
  after sorting. Distinct controller literals create distinct leaves: the
  35-choice case sorts the same item 34 times (**62,470,104 comparisons**).
  The 4,095-element case has 13 shared payload-prefix bytes and performs
  **89,796 comparisons / 1,362,986 compared byte pairs** per call for 65,524
  EXT units. Eight distinct-element sizes (64–21,844) were swept. Allocation
  is linear: `uniqueWords(B)=2B+2`, at most **524,296 B** scratch per call;
  JS retains it after warm-up, below its >2^20-word drop threshold, while Rust
  allocates/zeroes a fresh Vec each time. Nominal Rust allocation volume is
  8 bytes per EXT unit (<=18.4 MB if all budget went there), not a heap quota.
* **`.samelen`: not proportional.** Every call reparses the entire controller
  via `names-arg`, then scans all names per key and compares equal-length
  prefixes. Duplicate names are legal. The 20-byte-name case uses a
  **259,924-B schema**, a **237,303-B controller**, **131,055 message items**,
  **740,330,800 name probes / 13,325,954,400 compared byte pairs**, all under
  defaults. Empty maps still cause **4,600,075,523 controller-item head visits**
  (42,001/call). These cases require a large admitted schema/controller;
  fixed short lists are linear (two ordinary columns: **1.22 ms**).

**Proposal only; no implementation change:** make generic controls cooperate
with kin's budget. Charge span recording, comparisons, swaps and compared-byte
chunks **inside interruptible loops**, with calibrated weights; alternatively
use charged hashing plus charged byte comparisons on collision. Prepare/index
samelen names once in kin and charge remaining argument/lookup work;
deduplication alone does not fix large distinct lists. Reuse per-context Rust
scratch, reduce JS per-call view allocations, and recalibrate tiny-item EXT
costs. Lowering item size alone cannot fix argument amplification or arbitrary
callbacks. Custom predicates need a trusted cost/cooperation contract or
external isolation with enforceable termination; purity does not bound CPU.

Reproduction (scratch Git metadata avoids writes to the shared `.git`):

```sh
git init --bare --template= .cache/unique-git
printf '%s\n' "$PWD/.git/objects" > .cache/unique-git/objects/info/alternates
git --git-dir=.cache/unique-git worktree add --detach .cache/unique-wt 6c3237e1a18d098516387369f730bac6c7dd78a6
cp bench/ext-worst.mjs .cache/unique-wt/bench/ext-worst.mjs
(cd .cache/unique-wt && node --expose-gc --single-threaded-gc bench/ext-worst.mjs --out ../ext-worst-results.json > ../ext-worst-results.log)
git --git-dir=.cache/unique-git worktree remove --force .cache/unique-wt
```

**Checks run:** `node --check`; final `--check-only`, **41 cases**; all 41 timed
cases reconciled against final fixture hashes, schemas, limits, verdicts,
callback/step/item counts and recomputed medians; `git diff --check` on the
three requested files. Sort counters instrument an in-memory generated-code
copy outside timing; large samelen counts are exact fixture formulas with a
small instrumented cross-check. `--quick` uses three rounds; `--only <substring>`
selects cases. Raw per-run data and merged results remain locally under
`.cache/ext-worst-{results,extra-results,slow-results,chain-results,combined}.*`.
The worktree was removed. No kin/host/generated changes, installs, builds,
network operations or commits; no Rust/wasm/browser/source-driver timing or
memory-peak measurement is claimed.

## Extension controls metered (D190–D194) — 2026-11-04

**Verdict.** No row runs unbounded any more. Every generic-control row either
finishes or is refused with `budget`, and the work is charged as it happens.
Per unit, each EXT row costs at most the VM's own worst walk measured beside
it (except rows whose per-unit cost is the profile walk's, see below). **The
absolute ≤ 50 ms gate failed on this run because the machine was heavily
loaded.** Six budget-bounded rows took 53–72 ms, while the reference VM work
took **114.9 ms** for 2.3 M units (49.9 ns/unit, against ~18.5 ns/unit at D046
calibration). Scaled by that load factor (×18.5/49.9), the worst EXT row is
~27 ms. A run on a quiet machine is still owed.

Clean commit **`e1a7910`** (code from `b0a7233`), detached in
`.cache/hard-wt` with scratch git metadata. Machine: Apple M1 Pro, 10 logical
CPUs, 32 GiB; macOS 14.6.1 / Darwin 23.6.0 arm64; Node v24.6.0 / V8
13.6.233.10-node.24, `--expose-gc --single-threaded-gc`. Run 07:22:49–07:23:17
UTC, load 1/5/15-minute **10.20/15.39/19.42 → 9.31/14.69/19.03**, with other
users' java/Rust processes (~3 cores) running throughout. Method as in the
2026-11-04 analysis: public `schema.validate`, thread CPU user+system, medians
of 7 batches after ≥100 ms warm-up, default limits and maxima (65,536 B). The
undeclared slow predicate is the only single-call row. The harness now takes
each row's verdict from the real run. It counts calls through the real port,
and adds a `reference-six-way-choice` row (bench/VM.md's six-way choice of
maps run to budget refusal under defaults).

| Row | Before (c189dda) | After | Steps after | ns/unit | Verdict after |
| --- | ---: | ---: | ---: | ---: | --- |
| reference: six-way choice of maps to refusal (VM only) | — | 114.87 ms | 2,300,000 | 49.9 | budget |
| `.chars` 22 full 2-byte strings | 15.54 ms | 15.55 ms | 113,439 | 137.1 † | ok |
| `.chars` 65,534 empty strings ×2 | 83.05 ms | 39.17 ms | 2,300,000 | 17.0 | budget |
| no-op host EXT on tiny ints ×2 | 79.30 ms | 46.55 ms | 2,300,000 | 20.2 | budget |
| `.unique` ranked 65,533 ints (one) | 55.04 ms | 3.90 ms | 172,074 | 22.6 | control |
| `.unique` 22 × 4,095 long-prefix bstrs | 138.44 ms | 68.16 ms | 2,300,000 | 29.6 | budget |
| `.unique` 21,844 elements ×4 | — | 71.82 ms | 2,300,000 | 31.2 | budget |
| `.unique` 35 choices over the ranked array | 991.57 ms | 70.89 ms | 2,300,000 | 30.8 | budget |
| `.samelen` 21,000 absent names, 16,400 int keys | 4,749.30 ms | 2.71 ms | 71,780 | 37.8 | ok |
| `.samelen` 22 maps × 2,978 long-prefix keys | 58,638.25 ms | 33.47 ms | 582,237 | 57.5 † | ok |
| `.samelen` 5,000 distinct 44-B names, 23 maps | — | 24.93 ms | 699,736 | 35.6 | ok |
| `.samelen` empty maps, 21,000 empty names | 50,687.43 ms | 52.81 ms | 2,300,000 | 23.0 | budget |
| host predicate, 100M iterations, cost declared (D193) | — | 0.001 ms | 2,300,000 | — | budget (not called) |
| host predicate, 100M iterations, undeclared | 303.51 ms | 352.49 ms | 32 | — | ok (host's responsibility) |

† Bounded by input size rather than the budget. Their per-unit cost is the
VM's own profile walk: the UTF-8 scan of 1.44 MB charged ⌈len/64⌉, and the
map/key walk. The `any` walk of the same 2,978-key map alone measures
48.7 ns/unit, against ~34 ns/unit for the samelen part. All 47 rows:
`.cache/hard-results.{json,log}` (local).

**What changed.** A predicate call costs 1 + 16 units. The generic controls
meter their own ticks (program.md §14): `.unique` hashes each element and
heap-sorts by (hash, bytes) with charged comparisons, and stops at the first
equal pair. `.samelen` prepares its names once and makes one charged pass.
`.chars` is one linear count at ⌈len/16⌉ units. Host predicates are charged
their declared cost before the call. The weights came from direct kin calls
(`scratchpad calib.mjs`, same machine and load). Hashing, heads, comparisons,
tie byte compares, probes and pairs each landed at 17–39 ns/unit while the
reference ran at ~50 ns/unit. The no-op/tiny rows' per-call overhead set
`EXT_CALL`.

**Rust** was not timed. Its units are identical by construction, and
`bb vm-test` / `bb vmsession-test` compare whole out arrays, budget included.
Rust reuses a thread-local scratch instead of allocating per call.
**Wasm** was not timed: its SDK is not adapted yet (DEVLOG P7.9c).

Reproduction: as in the 2026-11-04 section, with commit `e1a7910` and
`node --expose-gc --single-threaded-gc bench/ext-worst.mjs --out ../hard-results.json`.


## Calibration 2026-11-04

**Recommendation: do not raise EXT weights by 1.5×.** Dispatch is already
cheap per unit; the substantial undercharges are the VM's own UTF-8,
long-byte comparisons and `.bits` scans. Propose the targeted prices below
and a **2,250,000-unit default**, conditional on normal automatic dispatch.
This is a measurement and proposal, **not an implemented schedule change**.
The requested ±25% fit for **every kind in both hosts is infeasible with
one portable set of constants**, as demonstrated below. Neither a quiet run
nor a universal 50 ms bound is established here.

### Revision, environment and method

Clean detached **`df612f5fdabbf38b05fd3f89e5913472ab7791b3`** in
`.cache/calib-wt`; shared-tree kin/host/generated edits were excluded.
The worktree used disposable `.cache/calib-git` metadata copied from the
local repository because the sandbox makes the shared `.git` read-only.
No emit, installs, network, remotes, commits or publishing. The worktree
and its disposable git metadata were removed after measurement.

Apple M1 Pro, **10 logical CPUs, 32 GiB**, macOS **14.6.1**, Darwin
**23.6.0 arm64**. Node **v24.6.0**, V8 **13.6.233.10-node.24**,
`--expose-gc --single-threaded-gc`; rustc **1.92.0
(ded5c06cf 2025-12-08), Homebrew**, compiled offline with `--edition=2021 -O`.
No wasm measurement. The existing Rust `vm` test binary has no timed-repeat
protocol and prepares controls/parses input per case, so
`bench/calibrate.rs` supplies a small measurement protocol against the same
clean generated VM and the **unchanged Rust host control port**.

An earlier full pass waited **180 seconds** for 1-minute load < 2; the final
pass waited **60 more seconds**. It never qualified. Final invocation:
**16:15:39–16:18:41 UTC**; timing phase began **16:16:54 UTC**, load
**10.71–13.93**. This was a shared, loaded machine. Every engine/row batch
records `uptime` and all three load averages before its reference bracket.
The raw record also retains the earlier wait samples. Absolute figures
below are measured CPU, **not quiet-machine figures**.

Each row warms for ≥60 ms of thread CPU per host, then runs batches targeted
at ≥22 ms. Nine rounds rotate row order; JS/Rust order alternates each
round. Every sample is bracketed by the six-way map-choice reference in the
**same host and round**. `ns/reference-unit` is the ratio of the sample's
ns/unit to the mean of its two reference measurements. Medians of those
ratios are shown separately from the ratio to the median kind. This reduces
load/core-placement effects; it does not eliminate them. For example, the
JS `.bits` rescan/reference ratios ranged 3.948–4.299 (middle five
4.083–4.176). The final map-reference median was **19.83 ns/unit JS,
8.13 Rust**. A preliminary lower-load pass gave 17.41/7.84; no absolute
quiet timing is claimed from that either.

JS uses `threadCpuUsage().user + system`; Rust uses
`clock_gettime(CLOCK_THREAD_CPUTIME_ID)` (Darwin clock ID 16, checked against
the installed SDK header). Compilation, fixture construction, IPC, parsing,
control preparation, scratch growth and untimed counters are excluded.
Scratch is reused; no forced GC in samples. Rust black-boxes inputs and
answers. All **40 rows agreed on verdict and units in JS and Rust** before
timing. AND/NOT opcode assertions prevent compiler folding from silently
turning those cases into interval tests.

VM workloads exhaust 2.3 M units, except explicitly fixed whole-input scan
rows. They use raised input/items/entries caps to isolate the budget, as
P3.6 did; **not every fixture fits all other default limits**. In particular,
forced-generic rows select the internal diagnostic bit, not public automatic
dispatch. A claimed default envelope must distinguish those cases.
The 1.4 MB `.bits` rescan adversary, however, fits the default input, item,
depth and entry caps: 128 distinct `.bits` leaves over one zero-filled byte
string; it really exhausts the default budget.

Control-work rows call the actual generated kernels with one shared 2.3 M
meter until a spend fails. They exclude the outer profile/dispatch walk;
`EXT-*` rows retain it. Unused remainder is excluded from the direct-kernel
denominator (hash 2,293,586; chars 2,297,856 units). Untimed in-memory
instrumentation checks that successful tick charges sum to the real meter:
hashing is >99.9% hash ticks, sorting ~94.3% comparison ticks, long collision
comparison >99.97% byte ticks, and long name searches ~97% byte ticks.
The collision spans are **unequal valid bstr encodings with a real equal
FNV-1a hash**, found by a deterministic birthday search; comparisons are not
forced by inventing a hash. Short name probes mismatch early; long probes
use **equal-length encodings** to reach the common prefix.

A VM workload isolates a *shape*, not a single charge site: array, scalar,
map, combinator and embedded rows necessarily include their query/filter/
profile/bookkeeping charges. Their ns/unit must not be interpreted as an
independent regression coefficient for each constituent §14 event. Direct
kernels additionally include their small repeated-call loop overhead;
`unique-record-element` intentionally measures the one-element case.

### Measurements at the current prices

Units are consumed per validation, or per direct-kernel meter run. Code 48
in the raw record is VM budget exhaustion; direct-kernel sentinels differ.
The declared-cost refusal invokes no predicate and reports a full spent
budget despite negligible CPU; it is shown but excluded from the kind
median. The other **39 rows** define an unweighted median kind of
**16.35 ns/unit JS and 7.11 Rust**. This median depends on the chosen suite,
not a natural machine constant. `/med` divides the host's row median by
that median; `/ref` is the median of the interleaved reference ratios.

| Kind | Units | JS ns/unit | JS /med | Rust ns/unit | Rust /med | JS /ref | Rust /ref |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| array-fast | 2,300,000 | 3.18 | 0.19 | 1.53 | 0.21 | 0.162 | 0.183 |
| array-generic-same-charges | 2,300,000 | 67.92 | 4.16 | 38.56 | 5.42 | 3.396 | 4.566 |
| array-automaton | 2,300,000 | 11.19 | 0.68 | 5.86 | 0.82 | 0.592 | 0.693 |
| dead-walk | 2,300,000 | 2.98 | 0.18 | 1.07 | 0.15 | 0.153 | 0.129 |
| map-struct | 2,300,000 | 19.52 | 1.19 | 7.57 | 1.06 | 0.967 | 0.905 |
| map-struct-generic | 2,300,000 | 52.74 | 3.23 | 22.88 | 3.22 | 2.670 | 2.728 |
| map-table | 2,300,000 | 23.99 | 1.47 | 9.35 | 1.32 | 1.204 | 1.098 |
| map-table-generic | 2,300,000 | 67.76 | 4.15 | 29.60 | 4.16 | 3.333 | 3.528 |
| reference-map-choice | 2,300,000 | 19.83 | 1.21 | 8.13 | 1.14 | 0.981 | 0.997 |
| scalar-leaves | 2,300,000 | 6.90 | 0.42 | 3.44 | 0.48 | 0.358 | 0.424 |
| text-ascii | 21,881 | 136.14 | 8.33 | 32.62 | 4.59 | 7.142 | 3.936 |
| literal-long-compare | 43,786 | 115.58 | 7.07 | 38.04 | 5.35 | 5.952 | 4.556 |
| text-utf8 | 21,881 | 166.84 | 10.21 | 43.06 | 6.06 | 8.163 | 5.355 |
| bytes-bits-scan | 21,881 | 87.75 | 5.37 | 44.59 | 6.27 | 4.464 | 5.501 |
| bytes-bits-rescan | 2,300,000 | 82.60 | 5.05 | 45.14 | 6.35 | 4.123 | 5.508 |
| regexp | 2,300,000 | 5.23 | 0.32 | 3.68 | 0.52 | 0.269 | 0.446 |
| key-binary-search | 2,300,000 | 11.37 | 0.70 | 6.45 | 0.91 | 0.581 | 0.806 |
| key-long-prefix-search | 185,872 | 81.09 | 4.96 | 40.19 | 5.65 | 4.196 | 4.717 |
| AND | 2,300,000 | 9.11 | 0.56 | 4.86 | 0.68 | 0.465 | 0.587 |
| NOT | 2,300,000 | 9.61 | 0.59 | 4.25 | 0.60 | 0.481 | 0.499 |
| embedded | 2,300,000 | 23.28 | 1.42 | 8.59 | 1.21 | 1.171 | 1.027 |
| EXT_CALL | 2,300,000 | 8.03 | 0.49 | 2.97 | 0.42 | 0.404 | 0.348 |
| custom-declared-byte | 2,300,000 | 5.49 | 0.34 | 1.03 | 0.14 | 0.270 | 0.123 |
| custom-declared-3n+5 | 2,300,000 | 6.57 | 0.40 | 2.80 | 0.39 | 0.336 | 0.320 |
| custom-declared-refused | 2,300,000 | 0.00 | 0.00 | 0.00 | 0.00 | 0.000 | 0.000 |
| chars-ascii-work | 2,297,856 | 16.26 | 0.99 | 1.27 | 0.18 | 0.832 | 0.151 |
| chars-utf8-work | 2,297,856 | 16.71 | 1.02 | 1.36 | 0.19 | 0.855 | 0.152 |
| unique-heads | 2,300,000 | 14.93 | 0.91 | 7.11 | 1.00 | 0.735 | 0.871 |
| unique-hash | 2,293,586 | 10.82 | 0.66 | 10.86 | 1.53 | 0.558 | 1.299 |
| unique-record-element | 2,300,000 | 26.49 | 1.62 | 11.09 | 1.56 | 1.356 | 1.373 |
| unique-sort | 2,300,000 | 10.22 | 0.63 | 4.96 | 0.70 | 0.514 | 0.600 |
| unique-record-compare | 2,300,000 | 12.40 | 0.76 | 2.49 | 0.35 | 0.642 | 0.306 |
| unique-collision-byte-compare | 2,300,000 | 16.58 | 1.01 | 6.97 | 0.98 | 0.831 | 0.852 |
| byte-chunk-compare | 2,300,000 | 16.35 | 1.00 | 7.16 | 1.01 | 0.816 | 0.858 |
| samelen-pass | 2,300,000 | 20.03 | 1.23 | 8.81 | 1.24 | 1.022 | 1.090 |
| samelen-short-probes | 2,300,000 | 5.93 | 0.36 | 3.09 | 0.44 | 0.280 | 0.371 |
| samelen-long-probes | 2,300,000 | 17.22 | 1.05 | 7.24 | 1.02 | 0.860 | 0.851 |
| EXT-chars | 113,439 | 47.11 | 2.88 | 9.66 | 1.36 | 2.462 | 1.168 |
| EXT-unique | 2,300,000 | 9.80 | 0.60 | 4.95 | 0.70 | 0.511 | 0.579 |
| EXT-samelen | 1,409,639 | 5.65 | 0.35 | 2.49 | 0.35 | 0.286 | 0.299 |

The three fixed content-scan rows finish with 21,881 units; the long literal
finishes with 43,786, long-key maps with 185,872. Their rates identify bad
prices even when input size prevents budget exhaustion. The `.bits` rescan
provides the separate budget-bounded witness: **189.97 ms JS** for 2.3 M
units, or **175.43 ms** after normalising its paired reference ratio to
P3.6's 18.5 ns/unit quiet-reference estimate. End-to-end `.chars` costs
47.11 ns/unit while its count itself costs 16–17: inflating the control's
weight would conceal the undercharged profile text scan.

### Why a universal ±25% fit cannot be promised

* Identical `[* uint]` inputs and charges cost **3.18 vs 67.92 ns/unit** on
  fast and forced-generic JS paths (Rust **1.53 vs 38.56**). Multiplying any
  common charge preserves those ratios; two values both in ±25% of one
  median can differ by at most 1.25/0.75 = **1.667×**, not 21–25×. D044
  requires these paths to retain identical charges. This needs implementation
  optimisation or a changed requirement, not a path-dependent price.
* `.chars` is **0.995× the JS median but 0.179× the Rust median**. A common
  unit-price multiplier f would have to lie in [0.796, 1.326] for JS and
  [0.143, 0.239] for Rust; these intervals do not intersect. Hashing has the
  opposite relative-host mismatch. Host-specific units would break R6.
  Even letting both median targets move does not solve this: the JS/Rust
  CPU ratio is ~12.8 for the count and ~1.0 for hashing. Common per-kind
  prices preserve those ratios; both hosts fitting ±25% would allow their
  spread to be at most (1.25/0.75)² = 2.78, not 12.8.
* One visit/probe already costs the smallest positive whole unit. Making
  the cheapest events several times cheaper in units needs fractional VM
  ticks/batching, not a smaller positive integer. D191 supplies ticks only
  inside generic controls.
* D193's arbitrary host predicates have arbitrary CPU and declarations.
  Neither a default per-byte price nor EXT_CALL can equalise all of them.

These are limits of the requested fit, not reasons to leave the measured
undercharges unfixed. The following is a conservative portable proposal,
with explicitly unresolved residuals, not a claim that every table row
would then meet ±25%.

### Concrete price proposal (no source changes made)

| File / charge | Old → proposed | Measurement / intent |
| --- | --- | --- |
| `kin/vm-eval.kin`, `EXT_CALL` | **16 → 0** (the separate 1-unit EXT leaf charge stays) | Tiny no-op is 8.03 ns/unit, 37 units/item. Removing 16 makes 21 units/item and ~14.15 ns/unit JS (~5.23 Rust), close to the kind medians. Raising to 24 would lower it to ~6.60 and worsen the mismatch. |
| `kin/vm-controls.kin`, `T_ELEM` | **5 → 10** | One-element unique costs 26.49/11.09 ns/unit; 9 → 14 ticks/element models ~17.03/7.13, within both bands. |
| `kin/vm-controls.kin`, `T_CMP` | **8 → 6** | The sort is comparison-dominated and currently 10.22/4.96. Together with T_ELEM this models ~12.9/6.3. Isolated record comparisons remain cheap in Rust; no universal fit is claimed. |
| `kin/vm-controls.kin`, `T_PROBE` | **4 → 3** | Use with the next row; short probes currently ~5.93/3.09, much cheaper per unit than long probes. |
| `kin/vm-controls.kin`, **new `C_FIRST`** for `mcmp`'s initial spend | **implicit `C_TICKS` = 8 → 2 ticks** | Keep subsequent chunks at C_TICKS=8. Short probe total 12 → 5 ticks models ~14.23/7.42; long-byte work changes only slightly. Reusing the same price for the first and later chunks prevents fitting both. |
| §14 UTF-8 profile scan; `kin/vm-{eval,dead,session-str}.kin`, including streak/pre-scalar key charges | **⌈len/64⌉ → ⌈len/8⌉** | ASCII 136.14 and two-byte UTF-8 166.84 model ~17.0/20.9 JS; the latter is ~18.9 with its paired reference normalised to 18.5. Keep this separate from typed-float scans. |
| §14 VM byte comparisons; `kin/vm-base.kin`, `c64min`'s comparison quantum and threshold (and callers using full-span comparisons) | **64 → 8 bytes/unit**, minimum 1 unchanged | Long key search 81.09 and long literal 115.58 expose undercharged content comparisons. Reprice the comparison helper separately from the shared `c64` helper; long text literals also receive the UTF-8 change. |
| §14 `.bits`; `kin/vm-leaf.kin` and matching session byte-string charge | **⌈len/64⌉ → ⌈len/12⌉** | JS rescan ~82.60 models ~15.5; native ~45.14 models ~8.5. Direct fixed-scan results are noisier. |
| `kin/compile/main.kin`, `setup-limits`, option 17 fallback | **2,300,000 → 2,250,000** | Conditional default proposal below. |

**Keep** `TPU=8`, `T_HEAD=3`, `T_PAIR=5`, `C_BYTES=8`, continuation
`C_TICKS=8`, `B_HASH=1`, `B_TEXT=16`, and the §14 typed-float NaN scan
quantum 64. Do not globally replace `c64`: these events have different CPU
rates. A 1.5× increase is particularly wrong for short probes/dispatch and
does not change the undercharged VM profile scan at all. B_HASH is already
one byte per tick; a fractional reprice would need another numerator.

All projected rates hold measured work constant and change the denominator;
they are **not timings of a new implementation**. Adoption needs kin changes
across fast/generic and resumable paths, emit, deterministic exhaustion-point
regressions and a new timing pass. Current gate results below validate the
benchmark and unit model, not those future changes.

### Default budget and valid-message headroom

With **current** prices, the budget-bounded `.bits` witness normalises to
**76.27 ns/unit**. A 50 ms budget is then only **~655,548 units**, whereas
keeping 1,450,008 valid-message units below 65% requires at least
**2,230,782**. Lowering the default alone cannot satisfy both.

With the targeted scan/comparison repricing and normal automatic dispatch,
the remaining measured reference-normalised maximum is the map-table shape,
**1.204 × 18.5 ≈ 22.28 ns/unit** (embedded: ~21.66). Thus **2.25 M** models
**~50.1 ms**, and **1,450,008 / 2,250,000 = 64.44%**. The unnormalised final
map-table rate would give ~54.0 ms; that is why this is a **provisional
quiet-reference estimate**, not an actual quiet run. 18.5 is the historical
P3.6 reference, not a measured idle frequency for this session.

The P3.6 valid-message table above supplies the original counts. An
**untimed in-memory source-load-hook projection**, leaving every source file
unchanged, recomputed all seven messages under the proposed scan/comparison
prices and checked **fast == generic** units:

| P3.6 valid message | Current units (P3.6 table) | Proposed units | % of 2.25 M |
| --- | ---: | ---: | ---: |
| RPC put 287 B | 74 | 100 | 0.004% |
| 120k ints | 240,018 | 240,018 | 10.67% |
| nested maps 1.1 MB | 1,008,018 | 1,008,018 | 44.80% |
| typed arrays 1 MiB | 12,340 | 12,340 | 0.55% |
| 10k struct records | 880,008 | 950,008 | 42.22% |
| ints 1,456,219 B | 600,008 | 600,008 | 26.67% |
| 50k small maps 949,163 B | **1,450,008** | **1,450,008** | **64.44%** |

These are budget headroom figures; original benchmark overrides for entry/
item caps are still needed where P3.6 specifies them. Literal "largest"
by bytes is the 1,456,219 B integer message (26.67%); the **largest unit
requirement** is the 949,163 B small-map message (64.44%).

**If the ~50 ms requirement includes forced-generic diagnostic execution
with raised structural caps, no proposed default meets both targets.**
That array row still normalises to ~62.82 ns/unit after the price changes
(it contains no repriced text/comparisons/controls): ~141 ms at 2.25 M.
It needs a default near **0.79 M** for 50 ms, which loses the valid-message
headroom. The internal diagnostic flag is not exposed by the public API;
other default caps also stop some of these diagnostic fixtures earlier.
2.25 M is recommended for normal public dispatch after repricing, not as a
universal guarantee for every calibration mode. This residual and the
cross-host fit prevent calling the full owner target settled by constants
alone. A quiet rerun remains owed; new workloads can expose another maximum.

### Artifacts, reproduction and checks actually run

* `bench/calibrate.mjs`: fixtures, interleaved timing, per-sample uptime,
  thread CPU, charge parity and control tick attribution.
* `bench/calibrate.rs`: offline Rust measurement protocol, generated kernels
  and unchanged host control port; parsing/preparation outside timing.
* `bench/calibrate-proposal.mjs`: **untimed** valid-message projection, with
  load hooks only; seven fast/generic unit equalities and acceptance checks.
* `bench/calibration-2026-11-04.json`: machine/runtime/revision, harness SHA-256s,
  raw nine-round samples, all reference brackets, uptimes/load, tick shares,
  projection counts and earlier wait samples. No input bytes are stored.

Recreate using disposable local git metadata (no remote operations):

```sh
mkdir -p .cache/calib-git
cp -R .git/ .cache/calib-git/
git --git-dir="$PWD/.cache/calib-git" worktree add --detach "$PWD/.cache/calib-wt" df612f5fdabbf38b05fd3f89e5913472ab7791b3
cp bench/calibrate.mjs bench/calibrate.rs bench/calibrate-proposal.mjs .cache/calib-wt/bench/
(cd .cache/calib-wt && node --expose-gc --single-threaded-gc bench/calibrate.mjs --wait-load-seconds 180 --out ../calibrate-results.json)
(cd .cache/calib-wt && node bench/calibrate-proposal.mjs --out ../calibrate-projection.json)
git --git-dir="$PWD/.cache/calib-git" worktree remove --force "$PWD/.cache/calib-wt"
```

Checks actually run: 40-row JS/native verdict-and-unit parity; nine timed
interleaved rounds; instrumentation tick sums and instrumented/original
identity; explicit retained AND/NOT opcodes; seven projected valid-message
acceptances and fast/generic unit equalities; `node --check` on the delivered
JS scripts; Rust release compilation and rustfmt check; `git diff --check`.
No repository conformance/emit gates were run for this measurement-only work.

## Calibration 2026-11-04 — D253/D254 confirmation

Did the D241 repricing move the per-unit CPU ratios the way the proposal
predicted? The same harness (`bench/calibrate.mjs`, nine interleaved rounds,
every sample bracketed by the six-way map-choice reference) was run twice in
clean detached worktrees on the same machine, the same afternoon:

* **before**: `bc4bdbd` (P8.2 fixes 1–3, old prices), timing from 18:25:49
  UTC, load 20.2–28.6 (1-minute);
* **after**: `b1e05fd` (D253 prices, D254 forced generic on schedule 1; the
  only harness change attributes the new `C_FIRST` spend in the untimed tick
  audit), timing from 20:17:14 UTC, load 58–115.

Apple M1 Pro, 10 cores, 32 GiB, macOS 14.6.1, Darwin 23.6.0 arm64; Node
v24.6.0 (V8 13.6.233.10-node.24, `--expose-gc --single-threaded-gc`); rustc
1.92.0, `-O`. The machine was shared and heavily loaded throughout (other
engineers' gates; load peaked above 200 between the two runs), so **absolute
nanoseconds are not comparable and are not claimed**; the ratios below are
per-host row medians divided by that run's unweighted median kind, as in the
table above. Every row agreed on verdict and charged units in JS and Rust
before timing, in both runs. Raw records:
[before](calibration-2026-11-04-d253-before.json),
[after](calibration-2026-11-04-d253-after.json).

| Kind | Units before → after | JS /med before → after | Rust /med before → after |
| --- | ---: | ---: | ---: |
| text-ascii (fixed input) | 21,881 → 175,006 | 7.62 → **1.17** | 4.40 → **0.67** |
| text-utf8 (fixed input) | 21,881 → 175,006 | 10.92 → **1.57** | 6.13 → **0.84** |
| literal-long-compare | 43,786 → 350,036 | 6.11 → **1.00** | 5.49 → **0.78** |
| key-long-prefix-search | 185,872 → 1,385,532 | 4.84 → **0.75** | 5.85 → **0.92** |
| bytes-bits-scan (fixed input) | 21,881 → 116,673 | 4.76 → **1.07** | 6.41 → **1.26** |
| bytes-bits-rescan | 2.3 M | 4.78 → **0.99** | 6.46 → **1.24** |
| array-generic-same-charges (forced) | 2.3 M | 4.25 → **0.81** | 5.48 → **1.00** |
| map-struct-generic (forced) | 2.3 M | 3.32 → **1.50** | 3.27 → **1.58** |
| map-table-generic (forced) | 2.3 M | 4.21 → **1.54** | 4.26 → **1.63** |
| unique-record-element | 2.3 M | 1.66 → 1.39 | 1.66 → 1.22 |
| unique-sort | 2.3 M | 0.63 → 0.92 | 0.74 → 1.04 |
| samelen-short-probes | 2.3 M | 0.36 → 0.98 | 0.43 → 1.20 |
| samelen-long-probes | 2.3 M | 1.01 → 1.29 | 1.04 → 1.23 |
| EXT-chars (end to end) | 113,439 → 271,135 | 2.98 → 1.52 | 1.31 → 0.63 |
| EXT_CALL (unchanged price) | 2.3 M | 0.53 → 0.70 | 0.42 → 0.45 |
| array-fast | 2.3 M | 0.19 → 0.22 | 0.22 → 0.24 |
| array-automaton (natural generic) | 2.3 M | 0.70 → 0.77 | 0.85 → 0.92 |
| map-struct | 2.3 M | 1.24 → 1.48 | 1.14 → 1.31 |
| map-table | 2.3 M | 1.49 → 1.88 | 1.33 → 1.59 |
| reference-map-choice | 2.3 M | 1.26 → 1.42 | 1.19 → 1.40 |
| embedded | 2.3 M | 1.48 → 1.57 | 1.26 → 1.35 |

**Findings.** Every repriced kind moved as predicted, from 4.8–10.9× the
median (JS) to 0.75–1.57×, and in Rust from 4.4–6.5× to 0.67–1.26×. The
forced generic rows, charged by schedule 1 under D254, fell from 3.3–5.5× to
0.81–1.63×. The probes and the one-element `.unique` record landed near the
median, as D240 modelled. Unchanged kinds rose by roughly 10–25% relative to
the median because the median itself moved down: the expensive rows now buy
more units for the same work. The map shapes are now the dearest per unit
under normal dispatch (map-table 1.88× JS, 1.59× Rust). Taking map-table
against its own run's paired reference (53.04 / 40.20 = 1.32×, against
1.18× before) at P3.6's historical 18.5 ns quiet reference gives about
24.4 ns per unit, so **~55 ms for the 2.25 M default**. That is an estimate,
not a quiet measurement: the after run had 2–4× the load of the before
run, and the reference ratio itself moved by 12%. The 50 ms figure in D240
remains a modelled target, not a confirmed bound. Unresolved, as D240 said:
`.chars`' JS/Rust per-unit gap (JS 1.15×, Rust 0.22×) and `unique-hash`'s
opposite gap cannot both be fitted by one portable price.

## Calibration 2026-11-11 — P8.5 phase 2 (PEG groups, D316)

Does format 2.0's PEG machinery keep the per-unit CPU ratios in the band D241
and D253 left? `bench/calibrate.mjs` (nine interleaved rounds, every sample
bracketed by the six-way map-choice reference; the JS and Rust harnesses now
grow the group arena on −5 as the hosts do) was run in a clean detached
worktree at `93f0520` (branch `p85-peg`), timing from 12:35 UTC, load
32–45 (1-minute; other engineers' gates and this branch's own gates running).
Apple M1 Pro, 10 cores, 32 GiB, macOS 14.6.1, Darwin 23.6.0 arm64; Node
v24.6.0 (V8 13.6.233.10-node.24, `--expose-gc --single-threaded-gc`); rustc
1.92.0, `-O`. Every row agreed on verdict and charged units in JS and Rust
before timing. As before, absolute nanoseconds under this load are not
claimed; ratios are per-host row medians over the run's unweighted median
kind. Raw record: [p85](calibration-2026-11-11-p85.json).

Five rows were added for the PEG tiers: `array-A1-choice` (`[* ((uint, tstr)
// (uint, uint, tstr))]`, the A1 ring), `array-A2` (`[* (* uint, tstr)]`,
arena records and backtracking), `map-S-choice` (a `=>` group choice in a
struct, S slots and the end machine), `map-T-choice` (`{* (tstr => uint //
tstr => tstr)}`, T records) and `map-T-sort` (60,000 EC-sensitive array keys
holding a float zero: the T sort, D312).

| Kind | JS /med (D253 after → P8.5) | Rust /med (D253 after → P8.5) |
| --- | ---: | ---: |
| array-fast | 0.22 → 0.20 | 0.24 → 0.23 |
| array-automaton (A0 machine) | 0.77 → 1.01 | 0.92 → 1.11 |
| array-generic-same-charges (forced) | 0.81 → 1.06 | 1.00 → 1.10 |
| map-struct (pair streak, D315) | 1.48 → 1.53 | 1.31 → 1.36 |
| map-struct-generic (forced) | 1.50 → 1.39 | 1.58 → 1.28 |
| map-table (pair streak) | 1.88 → 1.97 | 1.59 → 1.72 |
| map-table-generic (forced) | 1.54 → 1.42 | 1.63 → 1.39 |
| reference-map-choice | 1.42 → 1.49 | 1.40 → 1.49 |
| embedded | 1.57 → 2.15 | 1.35 → 1.65 |
| **array-A1-choice** | — → 1.03 | — → 1.14 |
| **array-A2** | — → 0.93 | — → 1.04 |
| **map-S-choice** | — → 1.37 | — → 1.23 |
| **map-T-choice** | — → 1.44 | — → 1.23 |
| **map-T-sort** | — → 1.09 | — → 1.10 |

**Findings.** The new PEG charges (one unit per machine step, records
⌈R/16⌉, the T comparison ⌈min(len)/8⌉) land at 0.93–1.44× the median in JS
and 1.04–1.23× in Rust: inside the 0.75–1.97× band of the existing VM rows,
so no PEG price is changed. The A0 machine (`array-automaton`) moved from
0.77× to 1.01× JS: elements of `[* (uint, tstr, bool, null)]` now run the
incremental machine where format 1 stepped a counter automaton, at the same
charges. Without D315's pair streak `map-struct` measured 2.3× main's CPU per
unit in a quick probe (the pair machinery runs per pair); with it the map
rows are where D253 left them. `embedded` rose (1.57 → 2.15 JS, 1.35 →
1.65 Rust); the cause is not analysed here. It is the dearest row and the
first candidate for a price if the band is tightened. Rows not listed moved by less than the load noise
(see the raw record).

## ABNF calibration — 2026-11-12 (P9.14, D334)

**Method**: `node bench/abnf-calib.mjs` (CPU time from `process.cpuUsage`,
best of 7 rounds; short calls are repeated until a round takes ≥ 20 ms). Each
row calls kin's `abnfRun` directly under the default 2.25 M budget, and its
units are the run's own. The VM's EXT charge (1 + 16 per call) comes on top in
real validation. The VM's reference row (the six-way choice of maps, generic
dispatch, as in `vm-calib.mjs`) is measured in the same process. D191's rule
is that each kind of metered work costs no more CPU per unit than that row.
"cold" is a run from a fresh first scratch (`abnfScratchWords`), with any
growth reruns and allocations, as the hosts run it after giving a large
scratch back.

**Environment**: Apple M1 Pro, macOS (Darwin 23.6.0), Node v24.6.0. The
machine was shared: load average 56.7 / 35.7 / 22.8 at the start.

| Row | Verdict | Units | CPU ms | ns/unit | × VM | cold ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| VM reference (six-way choice of maps, 24k msgs) | — | 216,006 | 2.3 | 10.7 | 1 | — |
| ambiguous `a = a a / "x"`, 200 x | budget | 2,250,000 | 16.7 | 7.4 | 0.69 | 18.4 |
| ambiguous with `""`, 200 x | budget | 2,250,000 | 18.0 | 8.0 | 0.75 | 17.9 |
| right recursion, 3,000 x | budget | 2,250,000 | 17.1 | 7.6 | 0.71 | 23.1 |
| left recursion, 60,000 x | match | 1,770,026 | 16.2 | 9.2 | 0.86 | 16.4 |
| nested nullable stars, 20,000 x | budget | 2,250,000 | 17.8 | 7.9 | 0.74 | 18.4 |
| `1000*2000("x" / "x" "x")`, 1,500 x | budget | 2,250,000 | 17.8 | 7.9 | 0.74 | 18.6 |
| 300 alternatives, 3,000 `~` | refused | 2,236 | 0.02 | 10.9 | 1.02 | 0.1 |
| RFC 3339 date-time list, 4,000 dates | budget | 2,250,000 | 22.5 | 10.0 | 0.94 | 22.5 |
| long literal choice | match | 2,163,759 | 21.0 | 9.7 | 0.91 | 34.1 |
| 256 nested groups, 2,000 a | match | 38,757 | 0.4 | 9.2 | 0.86 | 0.4 |

The weights are in kin/abnf.kin and in program.md §14. They were raised
about 5× from the first draft, which measured 3–10× the VM per unit before
calibration. The worst row is at the reference's cost per unit. The
300-alternatives row is a 20 µs call, and its 1.02 is within the timer's
grain: an earlier run under heavier load measured 0.91. Every row stops
within about 23 ms of CPU (34 ms cold), under the ~50 ms the default budget
targets. A single 27-character date-time costs about 760 units.
