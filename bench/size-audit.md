# Binary-size audit before release (P9.12 = P8.7, D303, D341) — 2026-11-12

The owner asked for an audit of every entry point for size reductions before
release (D303). This file holds the measurements and the method; DEVLOG D341
holds the decisions and P9.12 the checklist state.

Measured on main `b0c6d6b` (the tree P9.12 started from; later commits on
main before landing touched DEVLOG only). Apple M1 Pro, Node v24.6.0,
esbuild 0.28.2, gzip -9, brotli quality 11. Rust: Homebrew rustc 1.92.0 for
native builds; the wasm modules use `kin/scripts/wasm-build` (nightly
2026-09-16, `-Zbuild-std`, `panic=immediate-abort`).

## 1. JS entries (`node tools/size/size.mjs --details`)

| entry | min | gzip | brotli | cap headroom (gzip) |
| --- | ---: | ---: | ---: | ---: |
| `snug` | 62,329 | 21,397 | 18,708 | 2.0% |
| `snug/view` | 76,151 | 25,818 | 22,605 | 0.0% |
| `snug/writer` | 58,323 | 19,976 | 17,462 | 2.0% |
| `snug/schema` | 150,292 | 53,926 | 46,733 | 1.3% |
| `snug/sources` | 182,567 | 67,267 | 57,437 | 0.6% |
| `snug/sequence` | 211,481 | 75,437 | 65,332 | 0.5% |
| `snug/compile` static / full | 2,609 / 285,002 | 1,347 / 97,766 | 1,202 / 83,385 | 1.6% (full) |
| `snug/unicode` | 19,377 | 9,287 | 8,817 | 2.0% |
| `snug/controls` | 6,210 | 2,424 | 2,173 | 1.5% |
| `snug/abnf` | 14,506 | 5,951 | 5,302 | 2.1% |
| `runtime` | 172,652 | 61,906 | 52,901 | 1.4% |
| `all-runtime` | 277,312 | 99,905 | 84,145 | 2.0% |

Static and full are equal for every entry except `snug/compile` (the
compiler is its only dynamic import).

**Where the bytes are** (static minified attribution, `runtime`):
`program/verify` 27,071; `vm/eval` 20,511; `writer.mjs` 15,280; `vm/map`
13,910; `cbor/scan` 11,386; `cbor/vcopy` 11,223; `cbor/canon` 7,954;
`vm/leaf` 5,225; `vm/array` 5,072; `vm/dead` 5,067; `vm/api` 4,808; the
rest under 4.4 KB each. Session entries add `vm/scont` 17,206, `vm/sbase`
10,391, `cbor/rscan` 9,324, `vm/session` ~8,200, `vm/sstr` 6,796 and
`vm/svalid` 4,535.

**`snug/compile` full** (285,002 min) is two halves: the compiler, about
143 KB min (`compile/emit` 21,409, `lower` 15,197, `leaf` 14,910, `peg`
13,068, `ctl` 12,549, `regexp` 10,838, `lex` 8,436, `main` 7,621, `parse`
6,431, `glush` 4,503, the rest under 3.5 KB), and the whole of `snug/schema`
(the compiled Program is loaded and verified like any other). An application
that already loads `snug/schema` pays about 44 KB gzip for the compiler
chunk, not 97.8 KB.

**The verifier.** Stubbing `program/verify.mjs` out of the bundle (measurement
only) gives:

| entry | as is (min / gzip / brotli) | without the verifier | verifier's share |
| --- | ---: | ---: | ---: |
| `snug/schema` | 150,292 / 53,926 / 46,733 | 123,213 / 44,615 / 39,067 | 27,079 / 9,311 / 7,666 (17% of gzip) |
| `snug/compile` full | 285,002 / 97,766 / 83,385 | 257,582 / 88,913 / 76,104 | 27,420 / 8,853 / 7,281 |

**Duplicated code.** A token-level scan of the minified bundles (functions
alpha-equivalent after renaming identifiers): 31 groups across everything
including the compiler, 3.7 KB of source-named duplicates (2.7 KB
minified); 14 groups and 1.4 KB min in `all-runtime` (0.5%). The largest:
twelve one-line state accessors (`vmsNeedOffset`, `rscanPosition`, ...;
297 B), `bytesInput` in `public-schema.mjs` and `open-session.mjs` (235 B),
`lowerMap`/`lowerArray` (compiler, 232 B), three unsigned 64-bit compares
(207 B), a duplicated merge sort in the compiler (386 B, constants differ).
gzip and brotli already fold repeated text, so the compressed gain is smaller
still.

**Strings.** 253 string literals, 4,343 B, in the `snug/schema` bundle
(2.9%). They are the public error messages and option names.

**Generated-code patterns.** No large constant tables in any runtime entry
(no numeric array literal of more than 20 elements). kin emits `x >>> n | 0`
for an unsigned shift whose result is already a small int: 184 places, about
370 B min in `all-runtime`. That is the kin emitter's, outside this
repository.

**Coverage.** See §4: no retained function is dead (every one has a
caller), so coverage found no cut.

## 2. Rust

Consumer binaries (`.cache/p912-scratch/consumer`, a path dependency on the
assembled crate; `release`: opt-level 3, fat LTO, one codegen unit,
`panic = "abort"`, stripped). Bytes of the executable:

| binary | release | opt-level 3, no LTO, unwind | opt-level "z" |
| --- | ---: | ---: | ---: |
| empty `fn main` (std only) | 319,152 | 369,504 | 286,224 |
| `decode` only | 369,088 | 472,352 | 352,864 |
| `Schema::from_serialized` + `validate` | 617,200 | 761,616 | 502,304 |
| `Schema::compile` + `validate` | 997,504 | 1,182,928 | 652,048 |

snug's own text in the load-and-validate binary (symbol sizes from address
deltas, unstripped): `vm::eval` 64,080, `program::verify` 48,204,
`cbor::scan` 15,932, `cbor::vcopy` 14,696, `cbor::canon` 12,480, `vm::api`
10,088, `vm::map` 10,084, `vm::dead` 9,512, `vm::leaf` 9,288, host
`program` 7,952, `cbor::stdtags` 7,208, the rest under 5.2 KB. The compiler
adds about 380 KB of text (`compile::emit` 72,124, `leaf` 48,472, `lower`
46,484, `peg` 42,204, `ctl` 34,548, `regexp` 27,408, ...).

**Monomorphization:** none to speak of. Across both binaries the only
symbol instantiated twice is a closure in `schema::run`. The generated code
is not generic; the host's generic surface (`validate_reader<R: Read>`,
the async drivers) is thin loops over the sans-IO cores (D335).

## 3. wasm

`kin/scripts/wasm-build <mode>`; bytes / gzip -9 / brotli 11:

| module | opt-level 3 (shipped default) | "s" | "z" |
| --- | ---: | ---: | ---: |
| SDK runtime (`sdk`) | 350,573 / 135,876 / 111,236 | 262,030 / 106,372 / 89,652 | 243,411 / 100,785 / 85,875 |
| compiler (`cc`) | 348,920 / 111,314 / 91,667 | 267,326 / 90,880 / 77,460 | 174,005 / 70,554 / 61,921 |

For reference, P7.9 (bench/D005.md) measured the runtime module at 226,331 /
83,419 gzip at opt-level 3: it has grown 55% (63% gzip) since, with valid
CBOR (P8.4), PEG groups (P8.5) and P9's fixes, and no gate watches it.

Code is 98% of the module (sections: code 345,109 of 350,573 at opt-level
3; data 3,622). By module (unstripped build, name section): `vm::eval`
56,064, `program::verify` 46,099, the SDK host (`sdk.rs`) 62,855 of which
`ses_step` alone is 23,139 (the session step functions inlined into it),
`vm::session` 21,083, `vm::scont` 19,656, `cbor::vcopy` 16,537, `cbor::scan`
13,892, `vm::sbase` 13,877, `cbor::canon` 11,721, dlmalloc 8,040.

**Speed of the smaller builds.** `bench/d005-node.mjs --quick --wasm=<module>`,
three runs per profile, interleaved; each row's wasm/native ratio is
normalised by the same row's native time, the median of three taken, and
compared with opt-level 3 (58 rows, compile rows excluded):

| SDK runtime | geomean slowdown | worst row | validate | view | sources |
| --- | ---: | ---: | ---: | ---: | ---: |
| "s" | 1.06× | 1.46× | 1.07× | 1.12× | 1.08× |
| "z" | 1.07× | 1.39× | 1.18× | 1.05× | 1.11× |

The compiler module, warm, the six `corpus/cddl-study` contracts, 15 rounds,
median per compile (this includes loading the result into the runtime
module): opt-level 3 0.245 ms, "s" 0.278 ms (1.13×), "z" 0.396 ms (1.62×).
Compiling and instantiating each module in a fresh process takes 0.8–1.4 ms
for every profile (V8 compiles lazily).

## 4. Coverage of retained code

Run under `NODE_V8_COVERAGE` (function counts merged over every process):
`npm test`, `bb vm-test`, `compile-test`, `valid-test`, `vmsession-test 200
1`, `sequence-test 50 1`, `abnf-test`, `nav-test`, `write-test`, `scan-test`
and `unicode-test`. Not run under coverage: `rscan-test`, `compile-fuzz`,
`proptest`, the RFC runner and `crate-diff`, so `cbor/rscan` is left out
below.

Of 1,954 named functions in `gen/js` and `host/js/src`, 116 (40,204 source
bytes) were never called. Every one that a bundle keeps has a call site, so
none is dead code. Esbuild already drops functions without callers. These
are paths the gates do not reach, not cuts. The larger ones that the
runtime entries keep:

* `vm/map` `ecMinAfter`, `ecCmpMap` (the EC comparator over maps as keys);
* `vm/sbase` `keyMaxClaim`;
* `cbor/scan` `typedNanChunks`, `deferText` (typed-array NaN checks over
  indefinite chunks, deferred text checks);
* `cbor/canon` `gatherWithin`;
* `cbor/vcopy` `unitsStrip` (D322's fallback, "never expected");
* `cbor/tags` `mod10Str`;
* `vm/eval` `singleScalar`;
* `vm/scont` `openDseq`;
* `vm/dead` `deadSeq`;
* `vm/base` `qAnyMatch`;
* `vm/svalid` `vmapped`;
* `vm/arena` `arenaFreeWords`;
* `program/verify` `magSucc`.

The compiler keeps these: `ctl` `dedentInto`, `filterLits`, `ctlDet` and
`bitsPass`; `leaf` `encArgLo`, `encArgHi`, `bitsOk` and `ivContains`;
`bytes` `magSub`, `magPow256` and `magSmall`; `glush` `walkFrame`; `emit`
`busFail`; `peg` `progUnbounded`; and `lower` `genericAncestor`. This list
goes to P9.13's reviewer as a coverage observation; it is not a size
item.
