# CBOR sequences (P7.13) — 2026-11-04

`node bench/sequence-bench.mjs 7` at `9ce6310`, Node v24.6.0, Apple M1 Pro
(10 cores), macOS 14 (Darwin 23.6.0). **Shared machine**: other agents were
running gates; load average 8.4 / 11.3 / 14.9 during the run (the machine
peaked near 185 earlier in the day). Figures are the median of 7 runs of
process CPU time (`process.cpuUsage`, user + system) after one warm-up;
messages/s and MB/s are per CPU second. Correctness is checked outside the
timed loops (every path must give each message's `type`).

Inputs, built once and pre-chunked (fresh `Uint8Array` slices, as a stream
delivers them):

* **small** — 100,000 events `{type, seq, ts, text}` of 96.7 B on average
  (9,668,615 B), in 16 KiB chunks;
* **large** — 5 batches `{type, seq, items: [9,000 × {k, v, ok}]}` of
  908,690 B on average (4,543,450 B), in 64 KiB chunks.

Every snug path reads one field (`type`) through the message's View. Paths:

* `sequenceReader` — the push reader fed the chunks synchronously; profile
  only, or validated against the schema rule (`event` / `batch`) in the same
  pass;
* `readSequence` — the async iterator over the same chunks (one `await` per
  chunk);
* manual framing — the message boundaries known in advance (as if an outer
  framing gave them), then `decode()`, `view({borrow: true})`, or
  `schema.validate` + `view({borrow: true})` per message;
* cborg `decodeFirst` loop, cbor2 `decodeSequence`, cbor-x `decodeMultiple` —
  whole-buffer sequence decoders (none of the three decodes incrementally
  from chunks), materialising every value, with their own (not snug's
  deterministic-profile) checks; versions from `bench/compare/node_modules`
  (cborg 6.2.1, cbor2 2.4.1, cbor-x 1.6.9).

## 100,000 × ~97 B, 16 KiB chunks

| Path | CPU ms | wall ms | messages/s (CPU) | MB/s (CPU) |
| --- | ---: | ---: | ---: | ---: |
| sequenceReader, profile | 119.4 | 114.1 | 837,851 | 81.0 |
| sequenceReader, schema | 176.2 | 174.7 | 567,498 | 54.9 |
| readSequence (async), profile | 143.9 | 135.9 | 694,715 | 67.2 |
| readSequence (async), schema | 185.7 | 190.9 | 538,610 | 52.1 |
| manual framing + decode() | 105.4 | 105.0 | 948,857 | 91.7 |
| manual framing + view(borrow) | 110.4 | 113.0 | 905,731 | 87.6 |
| manual framing + schema.validate + view(borrow) | 248.3 | 257.5 | 402,693 | 38.9 |
| cborg decodeFirst loop (whole buffer) | 74.7 | 73.7 | 1,337,990 | 129.4 |
| cbor2 decodeSequence (whole buffer) | 282.2 | 291.7 | 354,367 | 34.3 |
| cbor-x decodeMultiple (whole buffer) | 96.6 | 67.5 | 1,035,626 | 100.1 |

## 5 × ~909 KB, 64 KiB chunks

| Path | CPU ms | wall ms | messages/s (CPU) | MB/s (CPU) |
| --- | ---: | ---: | ---: | ---: |
| sequenceReader, profile | 21.8 | 26.8 | 229 | 208.5 |
| sequenceReader, schema | 55.9 | 55.2 | 89 | 81.3 |
| readSequence (async), profile | 19.7 | 19.5 | 254 | 230.7 |
| readSequence (async), schema | 62.2 | 66.1 | 80 | 73.1 |
| manual framing + decode() | 18.7 | 19.2 | 268 | 243.5 |
| manual framing + view(borrow) | 8.7 | 8.9 | 572 | 519.7 |
| manual framing + schema.validate + view(borrow) | 53.2 | 53.8 | 94 | 85.4 |
| cborg decodeFirst loop (whole buffer) | 15.3 | 16.2 | 327 | 297.3 |
| cbor2 decodeSequence (whole buffer) | 115.1 | 107.6 | 43 | 39.5 |
| cbor-x decodeMultiple (whole buffer) | 11.6 | 12.2 | 429 | 390.1 |

## Reading

* **Small events with a schema: the fused pass wins.** Finding the
  boundary, checking profile + schema and minting the View in one session
  pass costs 176 ms for 100,000 events — 0.71× the two-pass equivalent with
  the boundaries already known (`schema.validate` + `view`: 248 ms) — and it
  needs no outer framing. Profile-only (119 ms) is within 13% of
  `decode()` per message with known boundaries (105 ms), while decoding
  nothing beyond the one field read.
* **Large messages, profile only: the resumable session costs 2.5× the
  recursive scanner** (21.8 ms vs `view(borrow)` 8.7 ms; D030's measured
  gap between the session and the buffer driver). With a schema the VM's
  own work dominates and the paths meet (55.9 vs 53.2 ms). A message that
  spans chunks is assembled once (~2 ms of copying for 4.5 MB).
* **The async iterator** adds ~20% CPU on small messages (one `await` per
  chunk and per yielded message); on large ones it is within noise.
* The three external decoders materialise whole values from a complete
  buffer and do not check snug's deterministic profile; they are listed as
  reference rates, not equivalent work. cborg and cbor-x are faster per
  message than snug's checked, chunked path; cbor2 is slower than every snug
  path.

Not measured: Rust (`snug::read_sequence` / `Sequence`), the wasm SDK
(P7.13w, blocked), memory high water, and quanta (`quantum` > 0).
