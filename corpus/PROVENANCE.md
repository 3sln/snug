# Corpus provenance

Imported 2026-10-29 from read-only sources. Do not edit copied files in place;
add derived files beside them.

| Path | Source | Licence |
| --- | --- | --- |
| `cddl-study/contracts/*.cddl` | 3sln.me design study scratch (`cddl-study/contracts/`), transcriptions of 3sln.me contracts; see 3sln.me `docs/architecture/cddl-wasm-study.md` §3.2 | MIT (3sln.me contributors) |
| `cddl-study/probes.mjs`, `contracts.mjs`, `differential.mjs`, `fuzz.mjs`, `load.mjs`, `build.sh`, `env.sh`, `lld.sh` | same study scratch; scripts import 3sln.me's codec and the study wasm by absolute path and are kept as the source of the 66 probes and the case lists, not run as-is | MIT (3sln.me contributors) |
| `cddl-study/oracle-binding/` | the study's binding crate over `cddl` 0.10.7 (MIT, anweiss/cddl, crates.io sha256 `c5251326096ece604213e731457558294e178c9560fe3885436a1e465250edbe`) | MIT |
| `cbor-vectors/cbor-profile.json`, `cbor-cborg-oracle.json` | 3sln.me `tests/vectors/` at commit `0daa2b6f9c107871486d73b99e5accbc4333d24b` | MIT (3sln.me contributors) |
| `../bench/baseline/cbor-3sln.mjs` | 3sln.me `packages/core/cbor.mjs` at the same commit (benchmark baseline only) | MIT (3sln.me contributors) |

The study's expected verdicts follow the study's expectations; where they
differ from RFC 8610 the derived corpus (`corpus/conformance/`) records the
RFC answer and says why.
