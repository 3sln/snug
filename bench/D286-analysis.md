# D286 — the canonical path's cost on non-deterministic input (analysis, 2026-11-11)

**Question** (D286's open item): on non-deterministic input the session driver
was measured up to 23× slower than `main`'s deterministic run (many small
reordered maps), the codec and buffer VM 1.2–8×. Where does the time go, and
which cheaper designs keep the D277/D280 contracts (budget identity across the
buffer and session routes and every window split; refusal replay)?

**Short answer.** The 23× is mostly not the canonical path: it is **grow-restart
amplification** in the session hosts. Every session starts with 512-word /
1024-byte valid-machinery buffers (`vs`, `cb`; JS `VmSession`, `sequence.mjs`,
Rust `Session`, the wasm SDK) and every `VMS_GROW` restarts the whole item —
scanner pass and canonical copy — from scratch. A 72 KB root took **7 full
passes** (bytes once, `vs` words doubling 1072→2400→5056→10368→20992 as the
events grow, then S for the events). With the buffers kept, the session costs
what the buffer driver costs (24.7 vs 24.0 ms). What remains on both drivers is
the canonical path itself: 4–8× the deterministic walk, spread over the
scanner pass, the prefix writer re-walking every child (`tskip` per child at
every depth), walks that find nothing (`visit` with no tag 24, `uvisit` with no
marked map), a units pass that redoes the scanner's duplicate-check sorts over
the copy, and the VM's walk over unsorted maps under `PF_CANON`.

## Environment and method

Apple M1 Pro (10 cores, 32 GiB), macOS 14.6.1, **heavily shared** (1-minute
load average 21–32 during the A/B run: other agents' builds and gates), Node
v24.6.0 (V8 13.6.233.10-node.24), `--single-threaded-gc`. Thread CPU time
(`process.threadCpuUsage`), µs per call, median of 5 trials per process, three
processes per arm with arms rotated per round, the table giving the median over
rounds. Trees (detached worktrees under `.cache/`; the prototype diff is
`.cache/d286wt/.prof/proto-BC.diff`, not committed): **base** = `main`
`3c10a83`; **B** and **C** = base plus the prototypes below (kin edited,
`bb emit`, generated JS measured). Driver: `bench/d286/variants.mjs` and
`ab.sh` in `.cache/d286wt` (not committed): the workloads of
`bench/valid-vm-bench.mjs` with each kind of non-determinism separated —

| variant | encoding |
| --- | --- |
| `det` | deterministic (sorted keys, shortest heads, definite) |
| `rev` | every map's keys reversed; otherwise deterministic (input is its own DC form, `VC_UNSORTED` only) |
| `ind` | every array and map indefinite-length; keys sorted |
| `nsh` | integers 0..23 with a one-byte argument (`18 xx`) |
| `istr` | every text string of ≥ 2 characters as an indefinite string of two chunks |
| `all` | `ind` + `rev` + `nsh` (D286's `nondet`) |

Arms: `vm` = `vmValidateV` against the typed schema, buffers kept across calls
(as the host's per-isolate lease does); `sess` = one session over whole windows
(`kin/scripts/vmsession-run.mjs`), fresh 512/1024 buffers per session as every
host does today; `sessL` = the same with `vs`, `cb` and S kept from the
previous session (a harness switch, `D286_LEASE`). Budget used (`out[3]`) was
checked equal on every route and variant (e.g. maps `det`/`ind`/`nsh` 94,008,
`rev`/`all` 172,008: the deferred checks' units, D277). Profiles:
`node --cpu-prof`, self time and inclusive time per function of the generated
JS.

## Where the time goes

### Sessions: restarts on growth

Instrumented once (counters in `svalid.mjs`), 2000 maps × 8 keys, `rev`:

| | `vitem` calls | bytes scanned + copied | `VMS_GROW` requests (words, bytes, S, arena) |
| --- | ---: | ---: | --- |
| `det` | 1 (skim: walked in place) | 0 | — |
| `rev` | 7 | 7 × 71,723 | (1072, 220385, 0, 0), (2400), (5056), (10368), (20992), (0, 0, 16408, 0) |

`canon-build` learns its event count only as it writes (`ev-add` asks for
`2 × ilen + 256` when full), and S is grown in a separate round after `vs`.
Each round reruns `vscan` and `canon-build` up to the point of failure. The
buffer driver has the same protocol (`-5`, `vm-need`), but its host keeps `vs`
and `cb` per isolate, so it pays the rounds once per isolate, not per call;
the session hosts allocate fresh buffers per session, so **every session pays
them**.

### The canonical path (both drivers), by profile

Share of the driver call (`vmValidateV` inclusive = 100%), base tree:

| workload / variant | scanner pass (`scanRun`) | copy (`canonBuild`) | of which units pass (`uvisit`, `mapUnits`) | VM walk over the copy (`evalItem`) | top self-time functions |
| --- | ---: | ---: | ---: | ---: | --- |
| 20000 integers / `ind` | 13% | 73% | ~15% (finds nothing) | 12% | `pw`, `uvisit`, `cw`, `pwIndef`, `tskip`, `visit`, `moveWithin` |
| 2000 maps / `nsh` | 22% | 45% | 7% (finds nothing) | 32% | `tskip`, `pw`, `visit`, `compareSpans`, `mapStreak` |
| 2000 maps / `rev` | 17% | 41% | 18% (redoes 2000 sorts) | 41% | `evalMap`, `tskip`, `rsift`, `dupFinish`, `kclassRec` |
| 5000 strings / `istr` | 18% | 67% | ~4% | 14% | `pwIstr`, `cw`, `tskip`, `utf8Seq` |

Findings:

1. **`tskip` everywhere** (6–9% self). `pw` writes a child and then calls
   `tskip` on the source child to find where the next one starts; `region` does
   it once more for the root; `pw-keys-canon` walks every map again (key and
   value `tskip`s). A byte at depth d is re-walked about d + 1 times.
2. **Walks that find nothing.** `visit` (tag-24 / `.cbor` content) walks the
   whole copy even when the item has no tag 24 and the Program no `.cbor`;
   `uvisit` walks the whole copy and runs `map-units` on every map (keys
   `tskip`ed, `kclass`, `compare-spans`) even when the scanner marked none.
3. **Duplicate checks twice.** For a marked map the scanner already ran the
   records, the heap sort and the neighbour pass (its verdict); `map-units`
   rebuilds the same records over the copy and sorts again to get the same
   units (D277 says they are equal by construction). `rsift` + `dupFinish` +
   `kclassRec` are ~12% self on `rev`.
4. **Copies that change nothing.** A `rev` item is its own DC form (only the key
   order differs; `VC_NONDET` clear), yet the prefix writer rewrites it byte
   for byte.
5. **The walk over unsorted maps** (`PF_CANON`): every descending key leaves the
   fast paths (`mapPairFast`, `mapStreak`) for the generic walk and restarts the
   key search; on `rev` the walk alone is ~2.5× the deterministic walk. This is
   the map matcher the PEG work (§20, `p85-peg`) is replacing.
6. Not significant: the deterministic attempt (it fails at the first
   non-deterministic byte or descending key, here within the first map), the
   events' binary search (`rfind`), copying events into S, offset remapping
   (accepted inputs remap nothing).

## Candidates

### A — no per-session grow restarts (sessions; host + small kin)

**A1, host lease:** the session hosts take `vs`/`cb` from a per-isolate pool
(as `schema-core.mjs` does for the buffer driver) instead of allocating
512/1024 per session; they are step-local (nothing in them survives a step:
kept keys live in the key arena, events are copied into S), so sharing them
across sessions is safe with a lease flag against re-entry from an extension
predicate (fresh buffers on re-entry). S and the key arena stay per session.
**A2, one-round growth in kin:** the scanner counts marked maps (one header word,
one increment in `dup-map`); `vbuild` sizes `vs` words and S together from that
count (events ≤ 2 per marked map + stops + embedded regions) and `cb` from the
item length, so a first session grows at most once.

| | maps `rev` | maps `all` | map-heavy `rev` | map-heavy `all` |
| --- | ---: | ---: | ---: | ---: |
| session today (`base-sess`) | 88,262 | 95,879 | 124,092 | 147,591 |
| buffers kept (`base-sessL`, A1 measured) | 24,669 | 26,854 | 37,999 | 40,804 |
| buffer driver (`base-vm`) | 24,022 | 25,804 | 35,665 | 41,557 |

**Gain: 3.3–3.6× on these sessions (measured), session = buffer driver.** A2
alone (estimated from the per-round cost, ~10 ms per round here): a first
session at most one restart, ~1.4× its leased cost instead of ~3.6×.
Contracts: none touched — the out array is a function of the input; growth
only changes how often the same step is retried (the gates already run
sessions from minimal buffers). Size: A1 host-only (~20 lines per host, no kin
bundle change); A2 ~10 kin lines. PEG: A1 touches `host/js/src/vm-session.mjs`,
`sequence.mjs`, Rust `schema.rs`/`sequence.rs`, wasm `sdk.rs` — `p85-peg`
touches `host/rust/src/sequence.rs`/`schema.rs` lightly and `sdk.rs`;
A2 touches `vbuild`, where `p85-peg` already changed the event base
(`arena-after`): do A2 on top of PEG.

### B — a leaner prefix writer and no empty walks (both drivers; `vcopy.kin`, 2 lines in `scan.kin`) — prototyped

* `pw` leaves the source end of the item it wrote in a free header word
  (`O_S_XEND`, word 45); container loops, `pw-indef` and `region` read it
  instead of `tskip`; the key-canonical test (`pw-keys-canon`) folds into the
  loop (removed).
* `visit` runs only when the scanner saw a tag 24 (a new outcome bit, 2048) or
  the Program has `.cbor` (`FL_EMBED`).
* `uvisit` is skipped for an accepted item when the scanner charged no units and
  noted no unsorted or EC-sensitive key and there is no embedded copy: then no
  map in the copy is marked (the scanner marks under the same rules, §19.4, and
  a marked map always charges ≥ 1 unit).

| µs | base `vm` | B `vm` | base `sessL` | B `sessL` |
| --- | ---: | ---: | ---: | ---: |
| 20000 integers `ind` | 4,180 | 2,765 | 4,178 | 2,841 |
| 20000 integers `nsh` | 4,040 | 2,235 | 3,755 | 2,325 |
| 2000 maps `ind` | 13,235 | 9,416 | 13,126 | 9,212 |
| 2000 maps `nsh` | 12,061 | 9,093 | 13,044 | 8,459 |
| map-heavy `ind` | 24,163 | 18,088 | 24,980 | 17,453 |
| map-heavy `istr` | 23,121 | 16,907 | 25,556 | 17,545 |
| 5000 strings `istr` | 4,064 | 3,432 | 4,244 | 3,599 |
| any `det` (B never runs on it) | — | 1.03–1.16 (noise at this load) | — | — |

**Gain: 1.2–1.8× on indefinite / non-shortest / indefinite-string input;
nothing on `rev`** (its cost is the units pass and the walk). Contracts: the
copy, its events and every charge are unchanged (no units are skipped that
could be non-zero; `visit` finds nothing without a tag 24 or `.cbor`). Gates on
the prototype: `valid-test` all ok (RFC 561/561, equivalence 589/589 same
budget, replay 2,720 buffer + 2,133 session runs at every budget, regressions
103/103, sequences 36/36; cbor2 differential skipped: not installed in the
worktree); `bb vmsession-test` (default size) ok: 999,880 session runs ==
buffer, JS == Rust, hosts. Size: −1 function, +2 small ones; with C below
+314 B min / +150 B gzip on `runtime` (149,258 → 149,572), inside D285's +2%
caps. PEG: `p85-peg` does not touch `vcopy.kin`, `canon.kin` or `scan.kin` —
no conflict; can land before or after the PEG merge.

### C — no copy when the bytes would not change (both drivers) — prototyped

For an accepted item with `VC_NONDET` clear (only key order or EC-sensitive
keys differ from deterministic), no tag 24 and no `.cbor`: `canon-build` puts
the input's bytes at the copy position (`bcopy`, a native `set` in JS) instead
of running the prefix writer; units and events are computed as before. The VM
still walks under `PF_CANON` with the same events, so charges and offsets
(an identity lockstep map) are unchanged. Refused items keep the prefix writer
(they need planting, D280).

| µs | base `vm` | C `vm` | base `sessL` | C `sessL` |
| --- | ---: | ---: | ---: | ---: |
| 2000 maps `rev` | 24,022 | 20,359 | 24,669 | 19,980 |
| map-heavy `rev` | 35,665 | 28,933 | 37,999 | 30,689 |
| `all` (non-det bytes: path not taken) | 25,804 / 41,557 | 24,657 / 36,622 | 26,854 / 40,804 | 23,857 / 37,238 |

**Gain: 1.15–1.25× on reordered-only input.** Contracts unchanged (same copy
bytes, same events); on B + C `valid-test` ok and `bb vmsession-test`
(default size) ok: 999,880 session runs == buffer, 564,188 unknown-length
streams, JS == Rust, hosts. Size: included in B's figure. PEG: `vcopy.kin` only.

### D — the scanner's units reused (both drivers) — estimated

The scanner records (map position, units) for each marked map it checks; the
prefix writer (or C's identity copy) turns each into an `EV_UNITS` event at the
map's copy position; `map-units`' second sort goes. Equal units by
construction (same records, same comparison sequence — what D277 already
relies on and the gates assert). **Estimated 1.25–1.35× on `rev`/`all`** (profile
of C on maps `rev`: `uvisit` 29% of the call, `map-units` 21%). Cost: a list of
2 words per marked map in the scanner's scratch (a new region past the
deferrals, grown by the existing `scratch` protocol), ~40 kin lines; the
deferred EC-form maps (`run-defer`) record theirs when they run. PEG: no
conflict (`scan.kin`, `vcopy.kin`).

### E — bounded per-map canonicalisation / tolerant attempt — not recommended now

Instead of a whole-item copy, the VM's attempt would tolerate descending keys
(walk on as `PF_CANON` does, mark the map) and run the deferred check at the
map's end over the input (`dup-input` + `dup-finish`, a per-map scratch of 3
words per key), falling back to the canonical path only for bytes that change
(`VC_NONDET`) or EC-sensitive keys. Expected on `rev`: about the `PF_CANON` walk
plus the sorts (~12–14 ms on maps `rev`, ~1.6× over C, ~2× over base), no
scanner pass, no copy. But it adds a map-end hook with charging to every map
walk of `vm-eval`/`vm-dead` (live and dead, fast paths), which is exactly the
map matcher `p85-peg` is rewriting (vm-eval +/−1,193 lines, vm-map +/−1,610),
and it creates a third charging route that must match D277 at every budget.
"Lazy copy on the first EC-sensitive event" and "per-container canonical form
only where unsorted" collapse into C + D (no copy when bytes do not change;
where bytes do change, a per-container copy saves nothing over the linear
whole-item copy, which B makes cheap, while making offset mapping and
planting per region). Revisit after PEG phase 2 lands, measured against the
new map machine; E would also reduce cost 5 (the unsorted-map walk) only if
the PEG map tiers handle descending keys cheaply.

## Summary

| non-deterministic input (µs, this run) | base session | base buffer | A (lease) | A + B + C (measured) | + D (estimated) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2000 maps `rev` (det 3,843) | 88,262 (23×) | 24,022 (6.3×) | 24,669 | 19,980 (5.2×) | ~15,000 (~3.9×) |
| map-heavy `rev` (det 9,115) | 124,092 (13.6×) | 35,665 (3.9×) | 37,999 | 30,689 (3.4×) | ~24,000 (~2.6×) |
| 2000 maps `all` (det 3,843) | 95,879 (25×) | 25,804 (6.7×) | 26,854 | 23,857 (6.2×) | ~18,000 (~4.7×) |
| 2000 maps `ind` | 14,800 | 13,235 | 13,126 | 9,534 (2.5×) | — |
| 20000 integers `nsh` (det 544) | 4,883 | 4,040 | 3,755 | 2,264 (4.2×) | — |

Ratios in brackets against the base buffer driver's deterministic run; the
session's own deterministic run is 1.3–1.7× that (`skim` and the session loop,
D286). Load was high and variable; ratios within a row came from the same
rotated rounds.

**Recommendation.** (1) A1 now (host-only, no kin, no contract change; removes
the 23× → session = buffer); A2 on top of the PEG merge (touches `vbuild`).
(2) B and C as one P8.4 follow-up in `vcopy.kin`/`scan.kin`, independent of
PEG (no shared files), gated by `valid-test`, `vmsession-test` and
`sequence-test`. (3) D after B/C, also PEG-independent. (4) E only after PEG
phase 2, if the remaining unsorted-map cost still matters.
