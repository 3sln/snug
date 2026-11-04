# Decision brief: R9 (runtime bundle size)

Prepared 2026-11-04 by the manager for the owner. **Not decided.** R9
(architecture §1) says: runtime (VM + builder + encoder) ≤ 20 KB min+gzip,
compiler separate. This brief gives the measured position and the options.

## Where we are (measured, `bb size`, HEAD after P7.12, esbuild 0.28.2, gzip -9)

| Entry (static import graph) | gzip | brotli |
| --- | ---: | ---: |
| `snug` — codec (decode + encode + values + profiles) | **14.6 KB** | 13.0 KB |
| `snug/schema` — validate/decode against a schema, Programs, verifier | 34.1 KB | 29.5 KB |
| **runtime** = codec + schema | **41.9 KB** | 35.8 KB |
| `snug/view` | 18.8 KB | 16.8 KB |
| `snug/writer` | 13.4 KB | 12.0 KB |
| `snug/sources` (sessions, handles, streams) | 45.3 KB | 38.6 KB |
| `snug/compile` (lazy; loaded on first compile) | 1.3 KB static, 74.4 KB loaded | |
| everything except the compiler | 71.3 KB | 59.7 KB |

History of the runtime figure: 33 KB (P3.4, before fast paths and features)
→ 56.4 KB (P7.6 phase 1, with sessions statically reachable) → 41.2 KB (phase
2, sessions partitioned, D160) → 41.9 KB (after the any-tag level).

For comparison (bench/compare): cbor-x 11.3 KB, cborg 8.1 KB, cbor2 14.5 KB
(codecs only, no CDDL); @cbortech/cbor's CDDL module 61 KB; the `cddl` crate's
wasm 832 KB unstripped; snug's wasm runtime module 60 KB (opt-z) + 16 KB glue.

## What is left to cut (estimates from P7.6 phase 1, tools/size/report.md — not measured)

| Change | Estimated saving (gzip) | Cost |
| --- | ---: | --- |
| Generic-only VM build (drop D044 fast paths) | ~3.1 KB | 2–15× slower on arrays/structs (P3.6) — only as a separate "small" entry |
| Verifier refactor | 1–2 KB | moderate kin work |
| Load the verifier only for `fromProgram`/`fromSerialized` | up to ~6.3 KB | needs those APIs to become async, or a separate entry for trusted in-process Programs |
| Rare leaf kinds behind a lazy module | 0.1–1 KB each | API complexity |

Realistic floor with everything above: about **30–33 KB** for the full
runtime; about **24–26 KB** for a reduced "validate in-process-compiled
Programs, no fast paths" entry. **20 KB for codec + schema is not reachable
without dropping features**; the codec alone (14.6 KB) already meets 20 KB.

## Options

1. **Restate R9 to the measured design and gate it** (recommended): codec
   ≤ 15 KB, runtime (codec + schema) ≤ 42 KB, each other entry at its current
   size; `bb size` already fails on +2% regressions. No engineering cost;
   honest. Keep shrinking opportunistically (option 2's verifier refactor).
2. **Pursue the kin plan for the full runtime**: target ~33–36 KB. Several
   days of kin work; no API change except possibly an async verifier path.
3. **Add a `snug/schema-lite` entry** (generic VM, no verifier, Programs
   compiled in-process or embedded and trusted): ~24–26 KB, slower on large
   homogeneous data. Useful for browsers that validate small messages. Adds an
   entry point to maintain and document.
4. **Keep R9 at 20 KB as written**: would require dropping capabilities
   (regexps, embedded CBOR, sessions are already out) or moving validation to
   wasm, which is larger. Not recommended.

## Recommendation

Option 1 now, option 3 only if a browser consumer asks for it, and the
verifier refactor from option 2 as background work. Record as a revision of
R9 with the owner's sign-off.
