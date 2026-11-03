# P7.8: snug vs existing CBOR and CDDL libraries

Recorded 2026-11-03 by the P7.8 benchmark engineer. This directory is benchmark-only. Its npm and crates.io
dependencies are installed here and pinned. None of them is imported by, vendored into or linked from snug's
sources. Raw output from every run is in `results/`. The tables below are rendered from it by `report.mjs`.

**Headline.** snug does more checking than any other JS decoder measured here, and that costs it speed:

- **Against permissive decoders:** cbor-x (no deterministic-encoding checks, no UTF-8 validation) decodes **2–3.5×
  faster** than snug on every structured workload.
- **Against the one JS decoder that checks almost everything snug does:** cbor2 in its CDE configuration plus
  duplicate-key and long-float rejection. snug is **2–7× faster** than it.
- **Against cborg's strict mode:** cborg checks less (no key order, no float form). snug is between **1.3× slower
  and 2.3× faster**, depending on the workload.
- **Encode:** snug's `encode()` is middle of the pack. It loses badly on large integer and typed arrays.
- **CDDL validation:** snug is faster than every validator found, on all but one row.
  - **The `cddl` crate:** 7–197× faster on the six study contracts' probes, both in a JS host and natively (17–388×
    native). On the large workloads the margin is 1.2–91× in a JS host and 3.3–437× native.
  - **@cbortech/cbor (JS):** 2.6–18× faster on the probes and 6–13× on the large workloads. It is **1.25× faster
    than snug JS** on the typed-array schema.
  - **cddl.js (Zod):** 4–34× faster, but cddl.js does different work.

  The study contracts are choice-heavy and cost snug its §14 schedule, which is 10–29× its own scanner (P3.6). snug
  is still faster than all of the above on them.

## Reproduce

```sh
cd bench/compare && npm ci             # network, this directory only
node probe.mjs                         # what each decoder configuration checks (results/probe.md)
node js-codec.mjs --json=results/codec.json      # JS decode/encode (about 5 min)
node js-cddl.mjs  --json=results/cddl.json       # JS-host CDDL validation, incl. both wasm builds
./run-rust.sh 9 25                     # builds snug-rs / snug-wasm / cddl-wasm / the native harness; native run
node wasm.mjs --json=results/wasm.json           # snug wasm vs snug JS
node sizes.mjs --json=results/sizes.json         # bundle sizes
node report.mjs                        # tables below
```

Every JS script re-executes itself under `--expose-gc --single-threaded-gc` (see Method).

## Environment

- Machine: Apple M1 Pro (`sysctl -n machdep.cpu.brand_string`), 10 cores, macOS 14.6.1 (23G93).
- Runtimes: Node v24.6.0 (V8 13.6.233.10-node.24). The native Rust harness was built with rustc 1.92.0 (Homebrew).
  The wasm builds used rustc 1.100.0-nightly (215a8af4b 2026-09-15), the toolchain snug's `wasm-build` uses.
- **Load average:** the machine is shared with other agents' builds and was busy throughout. That is why every time
  here is **CPU time**, not wall time. Load per run:
  - codec run: 8.8 at the start, 12.0 at the end;
  - CDDL run: 7.1 to 7.1;
  - wasm run: 7.3 to 7.0;
  - Rust run: about 7–11.
- **snug source measured:**
  - The JS runs used the live working tree between commits `0f85e8e` and `d034d68`. Its tracked files matched HEAD
    except compiler edits (later committed as `5c3a9ce`). Untracked session-driver modules were present but not
    imported by anything measured.
  - The Rust and wasm builds are from **`0f85e8e`**. `run-rust.sh` exports git HEAD. The working tree's half-emitted
    `gen/rust/snug/vm/session.rs` from a concurrent work item does not compile.

## Packages (exact versions; `package-lock.json` sha256 `1dfcc3a66fdcbc5c8687c3df9956a46cc244d8cbd4066fcb9cdf06015e0da4b3`)

| package | version | licence | role |
| --- | --- | --- | --- |
| cbor-x | 1.6.9 | MIT | JS codec. In Node it loads the optional `cbor-extract` 2.2.3 (MIT) native addon for strings. A second isolate runs it with `CBOR_NATIVE_ACCELERATION_DISABLED=true` (column `cbor-x-js`, as in browsers) |
| cborg | 6.2.1 | Apache-2.0 | JS codec |
| cbor2 | 2.4.1 | MIT | JS codec (hildjj; successor of node-cbor) |
| cbor (node-cbor) | 10.0.12 | MIT | JS codec (Node-oriented: Buffer/streams) |
| @levischuck/tiny-cbor | 0.3.6 | MIT | JS codec ("tiny-cbor" has no unscoped npm package) |
| @cbortech/cbor | 0.27.3 | Apache-2.0 | JS CDDL validator over CBOR bytes |
| cddl.js | 1.0.10 | MIT | CDDL → Zod code generator (brings zod 4.6.6, MIT) |
| cddl | 0.23.0 | MIT | evaluated: parser only, no data validator |
| @grinstead/cddl | 1.0.0 | MIT | evaluated: CDDL syntax checker only, no data validator |
| esbuild | 0.28.2 | MIT | bundling for sizes and for cddl.js's generated TypeScript |

Rust (`rust/Cargo.lock` sha256 `e5f0b74bbcf22f0a92057dd527b7e5323f90a0ce38badeeaf1f584da78b5d31c`):

| crate | version | licence |
| --- | --- | --- |
| ciborium | 0.2.2 | Apache-2.0 |
| minicbor | 2.3.1 (features std, half) | BlueOak-1.0.0 |
| serde_cbor | 0.11.2 (archived upstream, still builds) | MIT/Apache-2.0 |
| cbor4ii | 1.2.4 (use_std, serde1) | MIT |
| cddl | 0.10.7 (std, ast-span, cbor, json, additional-controls, as the study's binding) | MIT |
| serde | 1.0.229 | MIT OR Apache-2.0 |

`node_modules/` and `rust/target/` are ignored by the repository's existing `node_modules/` and `target/` rules.

## Method

- **CPU time, one isolate per library.** Each JS library family runs in its own `worker_thread`, which is a separate
  V8 isolate. Its time is `process.threadCpuUsage()` under `--single-threaded-gc`, with a forced GC before each
  sample.
  - This was not optional. In a shared isolate, node-cbor's `encodeCanonical` left about 170 MB retained per call on
    the 10k-map workload.
  - That retained heap slowed every library that ran after it. cbor2 encode went from 0.26 s to 3.8 s, and snug
    encode from 13 to 30 ms.
  - `process.cpuUsage` (all threads) under parallel GC also charged one library's garbage to whichever op ran next.
- **Sampling.** Each op gets 3 warm-up calls and is calibrated to ≥ 25 ms of CPU per sample. Then come 9 rounds (7
  for CDDL) over every op of a row in a rotating order, one op at a time, so libraries interleave in time. The
  reported figure is the median per call.
- **Rust.** Rust uses `clock_gettime(CLOCK_THREAD_CPUTIME_ID)`, `black_box` on inputs and results, and the same
  calibration and rotation. criterion was not used, to keep one method across hosts.
- **Answers are checked outside timing**, before timing and after every sample:
  - **Decoders:** the value must equal snug's modulo representation. Map ≈ object, Buffer ≈ Uint8Array, and a typed
    array ≈ its RFC 8746 tag. A decoder that refuses or differs is reported and not timed.
  - **Encoders:** the bytes are compared with snug's. A cbor2 permissive decode compares values, and snug's strict
    decoder records whether it accepts the output.
  - **Rust decoders:** each must accept, and all must produce the same number of data items (tags not counted,
    because serde Value types cannot carry them).
  - **Validators:** each verdict is compared with the expected one; `!` marks a disagreement.
- **Inputs.** Every decoder gets the same bytes: snug's deterministic encoding of each workload (`workloads.mjs`).
  These are the codec benchmark's standard workloads, plus a CWT-like integer-key map and 10,000 small messages
  (separate buffers, so per-call overhead counts).

## 1. What each decoder checks (`probe.mjs`, results/probe.md)

A = accepted, R = refused. Each "strict" configuration is the library's strictest documented decode option set that
still decodes ordinary data:

- `cborg-strict`: `strict`, `rejectDuplicateMapKeys`, `allowIndefinite:false`, `allowUndefined:false`, `strictUtf8`,
  `allowNaN:false`, `allowInfinity:false`.
- `cbor2-strict`: `cdeDecodeOptions` + `rejectDuplicateKeys` + `rejectLongFloats`.
- `node-cbor-dup`: `preventDuplicateKeys`.

cbor-x and tiny-cbor have no strictness options.

| input | rule | snug | cbor.mjs | cbor-x | cborg | cborg-strict | cbor2 | cbor2-strict | node-cbor | node-cbor-dup | tiny-cbor | snug cose |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| valid control: {"a":1,"b":[1.5,-2]} | valid | A | A | A | A | A | A | A | A | A | **R** | A |
| non-shortest integer (1 as 0x18 0x01) | shortest form (int) | **R** | **R** | A | A | **R** | A | **R** | A | A | **R** | **R** |
| non-shortest length (text len 1 as 0x78 0x01) | shortest form (length) | **R** | **R** | A | A | **R** | A | **R** | A | A | **R** | **R** |
| non-shortest map head (cbor-x style 0xb9 0x0001) | shortest form (length) | **R** | **R** | A | A | **R** | A | **R** | A | A | **R** | **R** |
| non-shortest float (1.5 as float64) | shortest form (float) | **R** | **R** | A | A | A | A | **R** | A | A | A | **R** |
| non-shortest float (1.5 as float32) | shortest form (float) | **R** | **R** | A | A | A | A | **R** | A | A | A | **R** |
| indefinite-length array | definite lengths | **R** | **R** | A | A | **R** | A | **R** | A | A | **R** | **R** |
| indefinite-length text | definite lengths | **R** | **R** | **R** | **R** | **R** | A | **R** | A | A | **R** | **R** |
| map keys out of order {"b":1,"a":2} | key order | **R** | **R** | A | A | A | A | **R** | A | A | A | **R** |
| map keys out of order, int keys {2:0,1:0} | key order | **R** | **R** | A | A | A | A | **R** | A | A | A | **R** |
| duplicate map key {"a":1,"a":2} | duplicate keys | **R** | **R** | A | A | **R** | A | **R** | A | **R** | **R** | **R** |
| invalid UTF-8 (c3 28) | UTF-8 validity | **R** | **R** | A | A | **R** | **R** | **R** | **R** | **R** | A | **R** |
| UTF-8-encoded surrogate (ed a0 80) | UTF-8 validity | **R** | **R** | A | A | **R** | **R** | **R** | **R** | **R** | A | **R** |
| overlong UTF-8 (c0 af) | UTF-8 validity | **R** | **R** | A | A | **R** | **R** | **R** | **R** | **R** | A | **R** |
| invalid UTF-8 in a map key | UTF-8 validity | **R** | **R** | A | A | **R** | **R** | **R** | **R** | **R** | A | **R** |
| trailing bytes after the item | no trailing data | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** |
| truncated text | well-formed | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** |
| declared length 2^64-1 | well-formed | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** |
| reserved additional info 28 | well-formed | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** |
| bignum that fits in 64 bits (tag 2, 0x01) | preferred bignum | **R** | **R** | A | **R** | **R** | A | **R** | A | A | A | **R** |
| bignum with leading zero byte (tag 2) | preferred bignum | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** |
| undefined (0xf7) | profile: simple values | **R** | **R** | A | A | **R** | A | A | A | A | A | **R** |
| unassigned simple value 16 | profile: simple values | **R** | **R** | **R** | **R** | **R** | A | A | A | A | **R** | **R** |
| scalar NaN (f9 7e00) | profile: NaN | **R** | **R** | A | A | **R** | A | A | A | A | A | **R** |
| scalar +Infinity (f9 7c00) | profile: infinities | **R** | **R** | A | A | **R** | A | A | A | A | A | **R** |
| negative zero (f9 8000) | profile: -0 | **R** | **R** | A | A | A | A | A | A | A | **R** | **R** |
| integral float 1.0 (f9 3c00) | profile: integral floats | **R** | **R** | A | A | A | A | **R** | A | A | **R** | **R** |
| unknown tag 100 | profile: tag allow-list | **R** | **R** | A | **R** | **R** | A | A | A | A | A | **R** |
| integer map key {1:0} (top level) | profile: text keys (cose allows top level) | **R** | **R** | A | A | A | A | A | A | A | A | A |
| nested integer-key map {"k":{1:0}} (COSE_Key in a CWT cnf) | profile: text keys | **R** | **R** | A | A | A | A | A | A | A | A | **R** |
| COSE_Sign1 (tag 18 array) | profile: tag allow-list | **R** | **R** | A | **R** | **R** | A | A | A | A | A | **R** |
| epoch date (tag 1) | profile: tag allow-list | **R** | **R** | A | **R** | **R** | A | A | A | A | A | **R** |
| deep nesting: 33 nested arrays | depth limit (snug default 32) | **R** | **R** | A | A | A | A | A | A | A | A | **R** |

Reading:

- **What every decoder checks:** only well-formedness, trailing data and bounds.
- **Strictness by library:**
  - **cbor-x** checks nothing else. No UTF-8 validation, no duplicate keys, no key order, no shortest form.
  - **cborg strict** adds shortest integers/lengths, duplicates and UTF-8. It does not check key order or float
    form; its README says so.
  - **cbor2 CDE** (+ dups + long floats) is the only JS decoder that verifies RFC 8949 §4.2.1 like snug does: key
    order, shortest ints, lengths and floats.
- **Beyond that, snug refuses by profile.** snug (and cbor.mjs, the same profile) also refuses inputs that every
  other library accepts:
  - NaN, ±∞, −0 and integral floats;
  - undefined and unassigned simple values;
  - tags outside its allow-list (e.g. tag 1 dates, tag 18 COSE_Sign1, tag 100);
  - integer map keys (top level only, with `cose`);
  - nesting beyond 32.
  
  **These are profile refusals, not bugs.** But they mean snug's strict profile refuses real protocol data today:
  COSE_Sign1 and CWTs with a nested COSE_Key `cnf` are refused until D081 / P7.1 lands.
- **tiny-cbor** refuses valid input it does not implement (half floats) and does not validate UTF-8.

**Inputs other libraries produce that snug's strict decoder refuses:**

| Encoder | Output | snug's refusal |
| --- | --- | --- |
| cbor-x default | 16-bit map heads (`b9 0006`), float64 for 1.5, insertion order | `non_shortest` |
| cbor2 default, node-cbor `encode`, tiny-cbor | insertion key order | `key_order` |
| node-cbor (even `encodeCanonical`) | a `Uint8Array` as tag 64 | `tag` |
| cbor-x with `mapsAsObjects` | a `Map` as tag 259 | `tag` |

The deterministic encoders (cborg default and `rfc8949EncodeOptions`, cbor2 `cdeEncodeOptions`, node-cbor
`encodeCanonical` without byte strings) produced bytes identical to snug's on every workload except two:

- cborg writes typed arrays as untagged byte strings, so their value differs.
- node-cbor writes `Uint8Array` as tag 64.

## 2. JS decode

snug decode = generated scanner + trusted builder (two passes, D017), strict. `snug-scan` is the check alone.

| workload | bytes | snug | fastest permissive (no deterministic checks) | snug vs it | cborg strict (partial checks) | snug vs it | cbor2 CDE strict (closest checks) | snug vs it | cbor.mjs (same profile) | snug vs it |
| --- | ---: | ---: | --- | --- | ---: | --- | ---: | --- | ---: | --- |
| RPC put 287 B | 287 | 3.7 µs | cbor-x 1.2 µs | 3.14× slower | 4.1 µs | 1.13× faster | 12 µs | 3.26× faster | 6.5 µs | 1.76× faster |
| RPC put + 1 MiB bstr | 1048786 | 154 µs | cbor-x 1.2 µs | 123.66× slower | 143 µs | 1.08× slower | 16 µs | 9.76× slower | 176 µs | 1.14× faster |
| 120k integers | 468653 | 3.60 ms | cbor-x-js 1.03 ms | 3.48× slower | 8.13 ms | 2.26× faster | 26.19 ms | 7.28× faster | 2.77 ms | 1.30× slower |
| 1 MiB typed arrays (f32,f64,i16) | 1048610 | 380 µs | cbor-x-js 72 µs | 5.31× slower | 289 µs | 1.32× slower | 2.66 ms | 6.98× faster | 770 µs | 2.02× faster |
| 10k maps x 8 short keys | 359723 | 12.17 ms | cbor-x-js 4.28 ms | 2.84× slower | 11.71 ms | 1.04× slower | 79.10 ms | 6.50× faster | 54.19 ms | 4.45× faster |
| map-heavy document 1.4 MB | 1400000 | 21.84 ms | cbor-x 9.51 ms | 2.30× slower | 27.96 ms | 1.28× faster | 96.19 ms | 4.41× faster | 54.84 ms | 2.51× faster |
| text-heavy document 1.2 MB | 1200000 | 9.44 ms | cbor-x 4.57 ms | 2.06× slower | 7.45 ms | 1.27× slower | 19.36 ms | 2.05× faster | 12.75 ms | 1.35× faster |
| CWT-like integer-key map | 204 | 1.9 µs | cbor-x 796 ns | 2.43× slower | 2.8 µs | 1.45× faster | 12 µs | 6.16× faster | 3.0 µs | 1.57× faster |
| 10k small messages (separate buffers) | 559743 | 19.13 ms | cbor-x-js 7.38 ms | 2.59× slower | 20.59 ms | 1.08× faster | 76.80 ms | 4.02× faster | 49.11 ms | 2.57× faster |

All configurations:

| workload | snug | snug-scan | cbor.mjs | cborg-strict | cbor2-strict | node-cbor-dup | cbor-x | cbor-x-js | cborg | cbor2 | node-cbor | tiny-cbor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| RPC put 287 B | 3.7 µs | 633 ns | 6.5 µs | 4.1 µs | 12 µs | 37 µs | 1.2 µs | 1.7 µs | 3.5 µs | 13 µs | 33 µs | 8.5 µs |
| RPC put + 1 MiB bstr | 154 µs | 657 ns | 176 µs | 143 µs | 16 µs | 40 µs | 1.2 µs | 1.8 µs | 154 µs | 13 µs | 39 µs | 161 µs |
| 120k integers | 3.60 ms | 1.48 ms | 2.77 ms | 8.13 ms | 26.19 ms | 58.23 ms | 1.05 ms | 1.03 ms | 7.83 ms | 27.11 ms | 61.03 ms | 7.77 ms |
| 1 MiB typed arrays (f32,f64,i16) | 380 µs | 218 µs | 770 µs | 289 µs | 2.66 ms | 254 µs | 73 µs | 72 µs | 280 µs | 2.65 ms | 262 µs | 144 µs |
| 10k maps x 8 short keys | 12.17 ms | 2.08 ms | 54.19 ms | 11.71 ms | 79.10 ms | 88.83 ms | 4.54 ms | 4.28 ms | 11.98 ms | 72.93 ms | 87.91 ms | 53.84 ms |
| map-heavy document 1.4 MB | 21.84 ms | 2.99 ms | 54.84 ms | 27.96 ms | 96.19 ms | 99.46 ms | 9.51 ms | 12.62 ms | 28.21 ms | 87.92 ms | 93.80 ms | 53.22 ms |
| text-heavy document 1.2 MB | 9.44 ms | 3.01 ms | 12.75 ms | 7.45 ms | 19.36 ms | 21.01 ms | 4.57 ms | 5.62 ms | 7.02 ms | 18.62 ms | 24.68 ms | 10.35 ms |
| CWT-like integer-key map | 1.9 µs | 490 ns | 3.0 µs | 2.8 µs | 12 µs | 30 µs | 796 ns | 942 ns | 2.5 µs | 9.2 µs | 29 µs | 4.6 µs |
| 10k small messages (separate buffers) | 19.13 ms | 3.15 ms | 49.11 ms | 20.59 ms | 76.80 ms | 137 ms | 7.58 ms | 7.38 ms | 16.66 ms | 71.21 ms | 147 ms | 46.52 ms |

Why the numbers look the way they do:

- **cbor-x is 2–3.5× faster than snug everywhere.** It checks nothing beyond well-formedness. In Node it extracts
  strings with a native addon, but its pure-JS isolate (`cbor-x-js`) is about as fast. It also decodes in one
  pass, while snug runs a full check pass first. That pass, `snug-scan`, is 14–32% of snug's decode on maps, text
  and messages, and 41% on integers. On typed arrays snug is 5.3× slower than cbor-x.
- **The 1 MiB byte-string row is a representation difference, not speed.**
  - cbor-x, cbor2 and node-cbor return byte strings that **alias the input buffer**: zero-copy, but the caller must
    not reuse or mutate the input.
  - snug, cbor.mjs, cborg and tiny-cbor copy them. Among copying decoders snug is at parity.
  - `snug-scan` validates the megabyte in 0.66 µs, by length.
- **Typed arrays.** snug refuses NaN inside float arrays (a profile rule), so it reads every element, and it copies
  each array. cbor-x copies without the NaN check (73 µs vs snug's 380 µs). cborg here uses tag decoders written in
  this harness (`lib.mjs`), because cborg refuses unknown tags.
- **Versus cborg strict:** snug is faster on documents (1.28×), CWT (1.45×), RPC (1.13×), small messages (1.08×) and
  integers (2.26×), and at parity on 10k maps (1.04× slower). It is slower on text-heavy data (1.27×), typed arrays
  (1.32×) and the 1 MiB byte string (1.08×). snug's text check is its own UTF-8 validator in the scan pass,
  followed by `TextDecoder` in the build pass.
- **Versus cbor2 CDE:** snug is 2–7× faster for the same class of checks. The exception is the 1 MiB byte string,
  where cbor2 aliases the input and snug copies.
- **Versus cbor.mjs:** snug is faster everywhere except 120k integers (1.30× slower). There, cbor.mjs's one-pass
  decoder beats scan + build.

## 3. JS encode

| workload | snug encode | snug Writer | fastest other deterministic encoder (byte-equal to snug) | snug encode vs it |
| --- | ---: | ---: | --- | --- |
| RPC put 287 B | 14 µs | 6.3 µs | cborg 7.1 µs | 1.92× slower |
| RPC put + 1 MiB bstr | 445 µs | — | cborg 132 µs | 3.37× slower |
| 120k integers | 27.66 ms | 1.35 ms | cbor2-cde 4.63 ms | 5.98× slower |
| 1 MiB typed arrays (f32,f64,i16) | 939 µs | — | cbor2-cde 193 µs | 4.87× slower |
| 10k maps x 8 short keys | 39.51 ms | 9.04 ms | cborg 46.45 ms | 1.18× faster |
| map-heavy document 1.4 MB | 59.41 ms | — | cborg 47.67 ms | 1.25× slower |
| text-heavy document 1.2 MB | 14.29 ms | — | cborg 9.72 ms | 1.47× slower |
| CWT-like integer-key map | 7.9 µs | 4.3 µs | cborg 6.0 µs | 1.30× slower |
| 10k small messages (separate buffers) | 68.17 ms | 26.25 ms | cborg 41.60 ms | 1.64× slower |

All configurations († = not byte-equal to snug's output):

| workload | snug | snug-writer | cbor.mjs | cborg | cborg-8949 | cbor2-cde | node-cbor-canon | cbor-x | cbor2 | node-cbor | tiny-cbor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| RPC put 287 B | 14 µs | 6.3 µs | 22 µs | 7.1 µs | 15 µs | 40 µs | 174 µs † | 1.1 µs † | 38 µs † | 34 µs † | 12 µs † |
| RPC put + 1 MiB bstr | 445 µs | — | 472 µs | 132 µs | 164 µs | 236 µs | 471 µs † | 109 µs † | 229 µs † | 230 µs † | 161 µs † |
| 120k integers | 27.66 ms | 1.35 ms | 20.21 ms | 9.96 ms | 9.91 ms | 4.63 ms | 65.53 ms | 1.60 ms | 4.81 ms | 65.53 ms | 55.82 ms |
| 1 MiB typed arrays (f32,f64,i16) | 939 µs | — | 1.02 ms | 121 µs † | 131 µs † | 193 µs | 296 µs | 114 µs † | 187 µs | 233 µs | failed |
| 10k maps x 8 short keys | 39.51 ms | 9.04 ms | 111 ms | 46.45 ms | 85.01 ms | 285 ms | 880 ms | 2.92 ms † | 241 ms † | 91.41 ms † | 110 ms † |
| map-heavy document 1.4 MB | 59.41 ms | — | 112 ms | 47.67 ms | 119 ms | 339 ms | 836 ms | 9.57 ms † | 250 ms † | 88.25 ms † | 100 ms † |
| text-heavy document 1.2 MB | 14.29 ms | — | 23.10 ms | 9.72 ms | 15.51 ms | 39.73 ms | 118 ms | 4.37 ms † | 41.27 ms † | 19.56 ms † | 14.32 ms † |
| CWT-like integer-key map | 7.9 µs | 4.3 µs | 14 µs | 6.0 µs | 11 µs | 53 µs | 120 µs † | 2.0 µs † | 56 µs † | 34 µs † | 9.2 µs † |
| 10k small messages (separate buffers) | 68.17 ms | 26.25 ms | 88.16 ms | 41.60 ms | 73.21 ms | 226 ms | 745 ms | 10.68 ms † | 223 ms † | 156 ms † | 63.56 ms † |

Encode notes (rows not byte-equal):

- RPC put 287 B: cbor-x 295 B, snug refuses (non_shortest); cbor2 287 B, snug refuses (key_order); node-cbor 289 B, snug refuses (key_order); node-cbor-canon 289 B, snug refuses (tag); tiny-cbor 287 B, snug refuses (key_order)
- RPC put + 1 MiB bstr: cbor-x 1048794 B, snug refuses (non_shortest); cbor2 1048786 B, snug refuses (key_order); node-cbor 1048788 B, snug refuses (key_order); node-cbor-canon 1048788 B, snug refuses (tag); tiny-cbor 1048786 B, snug refuses (key_order)
- 1 MiB typed arrays (f32,f64,i16): cbor-x 1048612 B, snug refuses (non_shortest); cborg 1048604 B, value differs; cborg-8949 1048604 B, value differs; tiny-cbor failed (Not implemented)
- 10k maps x 8 short keys: cbor-x 379723 B, snug refuses (non_shortest); cbor2 359723 B, snug refuses (key_order); node-cbor 359723 B, snug refuses (key_order); tiny-cbor 359723 B, snug refuses (key_order)
- map-heavy document 1.4 MB: cbor-x 1440002 B, snug refuses (non_shortest); cbor2 1400000 B, snug refuses (key_order); node-cbor 1400000 B, snug refuses (key_order); tiny-cbor 1400000 B, snug refuses (key_order)
- text-heavy document 1.2 MB: cbor-x 1204002 B, snug refuses (non_shortest); cbor2 1200000 B, snug refuses (key_order); node-cbor 1200000 B, snug refuses (key_order); tiny-cbor 1200000 B, snug refuses (key_order)
- CWT-like integer-key map: cbor-x 213 B, value differs, snug refuses (tag); cbor2 204 B, snug refuses (key_order); node-cbor 210 B, snug refuses (tag); node-cbor-canon 210 B, snug refuses (tag); tiny-cbor 204 B, snug refuses (key_order)
- 10k small messages (separate buffers): cbor-x 579743 B, snug refuses (non_shortest); cbor2 559743 B, snug refuses (key_order); node-cbor 559743 B, snug refuses (key_order); tiny-cbor 559743 B, snug refuses (key_order)

Where snug's `encode()` loses:

- **120k integers: 27.7 ms**, against 1.35 ms for snug's own typed Writer and 4.6 ms for cbor2 CDE. WRITER.md
  traced this to `encode()`'s dense-array check (`Reflect.ownKeys` builds 120,000 index strings). This is an easy
  target.
- **Typed arrays: 4.9× slower than cbor2.**
- **1 MiB byte string: 3.4× slower than cborg.**

The typed-array and byte-string costs were not profiled here. They are likely the per-element NaN check and buffer
growth or copies, but that is unverified.

Where it wins: with the typed Writer and keys in order, snug produces deterministic bytes faster than every other
deterministic encoder on all five workloads that have a hand-written builder (e.g. 10k maps in 9.0 ms, against
cborg's 46 ms). cbor-x is faster than everything, but its
output is not deterministic, and snug refuses it.

Two library findings, outside snug:

- **node-cbor truncates.** node-cbor 10.0.12's `encode()` and `encodeCanonical()` **silently truncate output at
  ~64 KiB**. Measured: 65,605 B returned for the 1.2 MB document, with no error. The harness uses
  `encodeOne(v, {highWaterMark: 32 MiB})`.
- **node-cbor retains memory.** `encodeCanonical` retains about 170 MB per call on the 10k-map workload.

## 4. CDDL validation in a JS host (`js-cddl.mjs`)

**Validators:**

- **snug-js:** the public `Schema.validate`, including rule lookup and result object.
- **snug-wasm:** host/wasm's VM; the Program is loaded once per schema, and the input is copied per call.
- **crate-wasm:** the `cddl` crate 0.10.7 as wasm. It uses the study binding's calls (pest parser, target rule
  first, `decode_cbor` then `CBORValidator`) but a plain integer ABI with no JSON result string, so it is slightly
  cheaper per call than VM.md's binding. It was rebuilt here because the study's `pkg/` no longer existed. It is
  built at opt-level 3, where the study used "s".
- **cbortech:** @cbortech/cbor's validator over the same bytes, with `maxSteps` unlimited.
- **cddl.js:** cbor2 `decode` + the generated Zod schema's `safeParse`.

**Budgets.** Workload schemas were compiled with the budget and item caps raised, as VM.md §2 does. "snug units" is
the budget used: all are under the default 2.3 M, but the default `maxItems` would refuse the large inputs.

| case | bytes | expected | snug-js | snug-wasm | crate-wasm | cbortech | cddl.js | snug units |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| object-storage-v1#0 | 59 | valid | 6.0 µs | 2.7 µs | 270 µs | 26 µs | skip | 253 |
| object-storage-v1#1 | 66 | invalid | 5.0 µs | 2.2 µs | 620 µs | 34 µs | skip | 205 |
| object-storage-v1#2 | 51 | valid | 5.3 µs | 2.4 µs | 176 µs | 21 µs | skip | 237 |
| object-storage-v1#3 | 71 | valid | 6.7 µs | 3.2 µs | 550 µs | 31 µs | skip | 286 |
| object-storage-v1#4 | 27 | valid | 2.9 µs | 1.3 µs | 34 µs | 7.6 µs | skip | 133 |
| object-storage-v1#5 | 95 | valid | 3.2 µs | 1.6 µs | 165 µs | 23 µs | skip | 195 |
| object-storage-v1#6 | 92 | invalid | 1.2 µs | 582 ns | 154 µs ! | 14 µs | skip | 46 |
| item-classification-v1#0 | 102 | valid | 5.9 µs | 2.8 µs | 191 µs | 34 µs | skip | 384 |
| item-classification-v1#1 | 163 | valid | 9.0 µs | 4.3 µs | 1.08 ms | 70 µs | skip | 618 |
| item-classification-v1#2 | 128 | invalid | 4.9 µs | 2.2 µs | 963 µs | 33 µs | skip | 301 |
| event-bus-tasks#0 | 21 | valid | 666 ns | 373 ns | 9.2 µs | 11 µs | skip | 23 |
| event-bus-tasks#1 | 29 | valid | 1.6 µs | 721 ns | 15 µs | 14 µs | skip | 44 |
| event-bus-tasks#2 | 27 | invalid | 2.0 µs | 672 ns | 14 µs | 13 µs | skip | 35 |
| preferences-v2#0 | 107 | valid | 5.7 µs | 2.7 µs | 187 µs | 39 µs | skip | 455 |
| preferences-v2#1 | 140 | valid | 6.2 µs | 3.0 µs | 198 µs | 38 µs | skip | 461 |
| preferences-v2#2 | 56 | valid | 3.4 µs | 1.7 µs | 64 µs | 39 µs | skip | 240 |
| ledger-numeric#0 | 165 | valid | 6.0 µs | 2.6 µs | 49 µs | 60 µs | skip | 228 |
| ledger-numeric#1 | 39 | invalid | 1.1 µs | 512 ns | 41 µs | 19 µs | skip | 32 |
| signaling-message-v1#0 | 207 | valid | 12 µs | 5.9 µs | 429 µs | 53 µs | skip | 989 |
| signaling-message-v1#1 | 262 | valid | 17 µs | 8.7 µs | 1.17 ms | 99 µs | skip | 1489 |
| signaling-message-v1#2 | 296 | valid | 16 µs | 7.4 µs | 1.36 ms ! | 61 µs | skip | 1169 |
| signaling-message-v1#3 | 260 | invalid | 17 µs | 8.1 µs | 1.40 ms | 115 µs | skip | 1448 |
| workload:rpc287 | 287 | valid | 3.1 µs | 1.4 µs | 22 µs | 36 µs | 15 µs | 107 |
| workload:rpc1m | 1048786 | valid | 3.1 µs | 22 µs | 284 µs | 208 µs | 15 µs | 107 |
| workload:ints | 468653 | valid | 1.18 ms | 548 µs | 70.19 ms | error | 40.25 ms | 240008 |
| workload:typed | 1048610 | valid | 192 µs | 110 µs | 231 µs | 155 µs | skip | 12340 |
| workload:maps | 359723 | valid | 14.70 ms | 5.86 ms | 237 ms | 187 ms | 70.84 ms | 870008 |
| workload:doc | 1400000 | valid | 17.83 ms | 7.59 ms | 267 ms | 194 ms | 85.30 ms | 962061 |
| workload:text | 1200000 | valid | 4.60 ms | 2.53 ms | 33.77 ms | 39.17 ms | 19.32 ms | 109142 |
| workload:cwt | 204 | valid | 5.9 µs | 2.5 µs | 9.5 µs | 37 µs | skip | 292 |
| workload:seq | 559743 | valid | 16.28 ms | 7.53 ms | 105 ms | 125 ms | 66.44 ms |  |

- **The crate's verdicts.** It disagrees with the expected verdict on the two study cases VM.md already recorded:
  - it accepts `javascript:https://x` against an `https://` regexp;
  - it refuses a valid signaling `invite`.

  Two study contracts parse only with the study's `safe-uint = uint` workaround.
- **@cbortech/cbor.** It agrees on all 22 study probes and is the strongest JS alternative. It is 2.6–18× slower than
  snug-js on the probes and 6–13× on the large workloads, but 1.25× faster on the typed-array schema (155 vs
  192 µs). It overflows the stack ("Maximum call stack size
  exceeded") on a flat 120,000-element `[* int]`.
- **cddl.js is not a comparable validator.**
  - It parses none of the six study contracts. Its errors are logged in results/cddl.txt: group choices, `.size`
    ranges and integer keys are outside its subset.
  - It validates decoded JS values with Zod semantics. `z.object` strips unknown keys instead of refusing them, so
    its maps are open, and its regexps are unanchored.
  - Its timings on the workload schemas are shown only as a data point. It measures decode + Zod, not RFC 8610
    matching.
- **No other npm package validates data against CDDL.** `cddl` (webdriverio) is a parser with a CLI that checks CDDL
  syntax. `@grinstead/cddl` likewise only validates CDDL files.

## 5. Rust (`run-rust.sh`, results/rust.txt)

snug's Rust host has **no value builder**. Only the profile scanner and the VM exist in Rust. So the fair Rust
comparisons are:

- snug scan (strict profile check, no allocation) against minicbor `skip` (well-formedness only, no allocation);
- snug VM against the `cddl` crate.

The Value decoders do strictly more work (allocation) and strictly less checking. They are shown for scale.

| workload | bytes | snug scan (strict) | snug VM vs `any` | minicbor skip | minicbor tokens | ciborium Value | serde_cbor Value | cbor4ii Value | cddl crate decode_cbor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| rpc287 | 287 | 191 ns | 346 ns | 201 ns | 279 ns | 1.3 µs | 994 ns | 615 ns | 741 ns |
| rpc1m | 1048786 | 192 ns | 342 ns | 198 ns | 275 ns | 45 µs | 24 µs | 22 µs | 32 µs |
| ints | 468653 | 823 µs | 442 µs | 576 µs | 825 µs | 4.48 ms | 1.48 ms | 1.36 ms | 1.80 ms |
| typed | 1048610 | 88 µs | 88 µs | 69 ns | 135 ns | 72 µs | 35 µs | refused | 48 µs |
| maps | 359723 | 835 µs | 1.22 ms | 1.00 ms | 1.63 ms | 8.82 ms | 8.37 ms | 4.58 ms | 5.32 ms |
| doc | 1400000 | 1.37 ms | 2.25 ms | 1.36 ms | 2.03 ms | 10.06 ms | 9.92 ms | 5.79 ms | 6.36 ms |
| text | 1200000 | 1.76 ms | 1.86 ms | 1.53 ms | 1.62 ms | 2.83 ms | 2.67 ms | 2.29 ms | 2.31 ms |
| cwt | 204 | 173 ns | 268 ns | 141 ns | 239 ns | 1.1 µs | 706 ns | 394 ns | 524 ns |
| seq | 559743 | 817 µs | 1.92 ms | 970 µs | 1.47 ms | 6.85 ms | 4.66 ms | 2.91 ms | 3.64 ms |

Reading:

- **Scan against `minicbor::skip`.** snug's strict scan takes 0.84–1.43× the skip's time. It is faster on 10k maps
  and the message batch, and slowest on the integer array. Its extra checks are key order, UTF-8 and the profile
  rules.
- **Typed arrays are the exception.** minicbor skips the byte string by length in 69 ns. snug reads every element
  for the NaN rule (88 µs).
- **The VM against `any`** takes 1.1–2.4× the scan, except on the integer array. There it takes 0.54× the scan,
  because the VM's dead walk has an integer-streak fast path (P3.6).
- **cbor4ii refuses the typed-array tags** through serde.

CDDL validation, native:

| case | rule | bytes | expected | snug | cddl crate (decode_cbor + CBORValidator) | snug result |
| --- | --- | ---: | --- | ---: | ---: | --- |
| object-storage-v1#0 | request | 59 | valid | 2.2 µs | 211 µs | ok |
| object-storage-v1#1 | request | 66 | invalid | 1.8 µs | 475 µs | unexpected (units 205) |
| object-storage-v1#2 | request | 51 | valid | 1.9 µs | 132 µs | ok |
| object-storage-v1#3 | request | 71 | valid | 2.7 µs | 416 µs | ok |
| object-storage-v1#4 | request | 27 | valid | 990 ns | 28 µs | ok |
| object-storage-v1#5 | presign-result | 95 | valid | 1.3 µs | 131 µs | ok |
| object-storage-v1#6 | presign-result | 92 | invalid | 392 ns | 122 µs ! | pattern (units 46) |
| item-classification-v1#0 | classify-args | 102 | valid | 2.1 µs | 143 µs | ok |
| item-classification-v1#1 | classify-args | 163 | valid | 3.6 µs | 817 µs | ok |
| item-classification-v1#2 | classify-args | 128 | invalid | 1.9 µs | 737 µs | pattern (units 301) |
| event-bus-tasks#0 | payload | 21 | valid | 173 ns | 6.8 µs | ok |
| event-bus-tasks#1 | record | 29 | valid | 495 ns | 11 µs | ok |
| event-bus-tasks#2 | record | 27 | invalid | 504 ns | 10 µs | embedded (units 35) |
| preferences-v2#0 | result | 107 | valid | 2.3 µs | 142 µs | ok |
| preferences-v2#1 | result | 140 | valid | 2.5 µs | 146 µs | ok |
| preferences-v2#2 | result | 56 | valid | 1.3 µs | 53 µs | ok |
| ledger-numeric#0 | entry | 165 | valid | 2.2 µs | 38 µs | ok |
| ledger-numeric#1 | entry | 39 | invalid | 353 ns | 32 µs | bits (units 32) |
| signaling-message-v1#0 | message | 207 | valid | 5.5 µs | 354 µs | ok |
| signaling-message-v1#1 | message | 262 | valid | 8.1 µs | 927 µs | ok |
| signaling-message-v1#2 | message | 296 | valid | 6.8 µs | 1.10 ms ! | ok |
| signaling-message-v1#3 | message | 260 | invalid | 7.6 µs | 1.10 ms | value (units 1448) |
| workload:rpc287 | r | 287 | valid | 1.2 µs | 17 µs | ok |
| workload:rpc1m | r | 1048786 | valid | 1.2 µs | 524 µs | ok |
| workload:ints | r | 468653 | valid | 553 µs | 50.78 ms | ok |
| workload:typed | r | 1048610 | valid | 86 µs | 477 µs | ok |
| workload:maps | r | 359723 | valid | 5.34 ms | 193 ms | ok |
| workload:doc | r | 1400000 | valid | 7.07 ms | 213 ms | ok |
| workload:text | r | 1200000 | valid | 2.41 ms | 28.82 ms | ok |
| workload:cwt | r | 204 | valid | 2.2 µs | 7.2 µs | ok |
| workload:seq | r | 559743 | valid | 5.90 ms | 79.32 ms | ok |

snug native is **17–388× faster** than the `cddl` crate on the study probes and **3.3–437×** on the workloads. The
rpc1m row is 437× because the crate decodes and copies the megabyte into a Value first. The smallest margins are the
CWT map (3.3×) and typed arrays (5.5×). The crate's verdict
disagreements are the same two as in its wasm build.

## 6. snug wasm vs snug JS in Node (`wasm.mjs`)

Every wasm call includes copying the input into linear memory. wasm has no builder, so "decode" on the wasm side is
the wasm scan followed by the JS build. The VM rows are low-level `vm-validate` with a reused scratch on both sides.

| workload | bytes | scan JS | scan wasm (incl. copy) | copy alone | decode JS | wasm scan + JS build | validate JS (VM) | validate wasm (VM, incl. copy) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| RPC put 287 B | 287 | 580 ns | 290 ns | 25 ns | 3.3 µs | 3.2 µs | 2.9 µs | 1.4 µs |
| RPC put + 1 MiB bstr | 1048786 | 585 ns | 21 µs | 21 µs | 163 µs | 293 µs | 2.8 µs | 22 µs |
| 120k integers | 468653 | 1.51 ms | 798 µs | 8.4 µs | 3.00 ms | 2.11 ms | 1.06 ms | 555 µs |
| 1 MiB typed arrays (f32,f64,i16) | 1048610 | 215 µs | 107 µs | 21 µs | 366 µs | 337 µs | 270 µs | 108 µs |
| 10k maps x 8 short keys | 359723 | 1.90 ms | 1.02 ms | 6.3 µs | 6.41 ms | 5.62 ms | 18.50 ms | 5.68 ms |
| map-heavy document 1.4 MB | 1400000 | 2.96 ms | 1.69 ms | 29 µs | 14.13 ms | 12.87 ms | 21.10 ms | 7.29 ms |
| text-heavy document 1.2 MB | 1200000 | 2.90 ms | 1.86 ms | 24 µs | 9.30 ms | 7.94 ms | 4.65 ms | 2.54 ms |
| CWT-like integer-key map | 204 | 449 ns | 264 ns | 25 ns | 2.0 µs | 1.8 µs | 5.5 µs | 2.6 µs |
| 10k small messages (separate buffers) | 559743 | 2.73 ms | 1.66 ms | 143 µs | 13.34 ms | 11.78 ms | 15.41 ms | 7.46 ms |

- **wasm is 1.6–2× faster** than generated JS for scanning and 1.8–3.3× faster for the VM, except where the input copy
  dominates. A 1 MiB byte string costs 21 µs to copy and 0.6 µs to scan in JS.
- **Swapping in the wasm scanner saves 3–30% of decode,** because the JS build pass dominates decode. On the 1 MiB
  byte string it is slower (293 vs 163 µs), because the copy costs more than the JS scan.
- **Caveat: the same JS VM call varies with the isolate's history.** The maps row validates in 18.5 ms here (the
  isolate also ran decode and other schemas), against 14.7 ms through the public API in js-cddl.mjs's isolate and
  16.2 ms in an isolate running nothing else (spot check). Treat about ±25% on VM JS figures as JIT state, not code.

## 7. Bundle sizes (`sizes.mjs`)

esbuild 0.28.2 `--bundle --minify --format=esm`, importing only the named functions. gzip -9 and brotli 11 by
node:zlib.

| bundle | min B | min+gzip B | min+brotli B |
| --- | ---: | ---: | ---: |
| snug codec (decode + encode) | 30472 | 10750 | 9680 |
| snug codec + Writer | 30482 | 10756 | 9684 |
| snug runtime (codec + schema validate/decode, Program loader) | 98387 | 35418 | 30474 |
| snug compile entry (compiler + the runtime schema API it returns) | 198853 | 67113 | 57333 |
| 3sln.me cbor.mjs (decode + encode) | 15717 | 5684 | 5110 |
| cbor-x (decode + encode) | 30282 | 11260 | 10168 |
| cborg (decode + encode) | 26253 | 8107 | 7251 |
| cbor2 (decode + encode) | 43050 | 14471 | 13141 |
| cbor / node-cbor (decodeFirstSync + encode), platform=node, Node builtins external | 43136 | 12974 | 11732 |
| @levischuck/tiny-cbor (decodeCBOR + encodeCBOR) | 5462 | 2060 | 1833 |
| @cbortech/cbor CDDL (CDDL.compile + validate; compiler included) | 209540 | 61185 | 52232 |
| snug wasm (scanner + VM, opt-level 3, no wasm-opt; JS glue not counted) | 86559 | 32688 | 27688 |
| cddl crate wasm (rust/cddl-wasm, opt-level 3, not stripped, no wasm-opt) | 3192826 | 832247 | 515313 |

- **Codec size.** snug's codec (10.7 KB gzip) is in the same range as cbor-x (11.3 KB) and smaller than cbor2
  (14.5 KB). It is larger than cborg (8.1 KB), cbor.mjs (5.7 KB) and tiny-cbor (2.1 KB).
- **Writer is free.** "codec + Writer" equals the codec because `encode()` is the walk over the Writer.
- **The runtime is not small.** snug's runtime (35.4 KB gzip) is the codec plus the VM and the verifier, still
  above R9's 20 KB target (P7.6).
- **Compile entry against the other validator.** snug's compile entry (compiler and runtime, 67 KB gzip) is about
  the size of @cbortech/cbor's CDDL module (61 KB), which also includes its compiler.
- **The `cddl` crate's wasm is 832 KB gzip.** It is not stripped and wasm-opt was not run, which no offline tool
  here provides.
- **node-cbor is bundled for Node.** Its browser use needs Buffer and stream polyfills, which are not counted.

## Where snug wins, loses, and why

**Wins:**

- **CDDL validation:** usually one to two orders of magnitude over the `cddl` crate (native and wasm), with verdicts
  that agree where the crate's do not. Typically 4–18× over @cbortech/cbor, which is the best JS alternative; the
  typed-array schema is the one row it wins.
- **Strict decoding:** 2–7× faster than the only other JS decoder that verifies RFC 8949 deterministic encoding
  (cbor2 CDE). At parity or better against cborg's partial strict mode on most workloads, while checking more.
- **Rust:** the strict scan runs at the speed of minicbor's unchecked skip.
- **Writing deterministic bytes:** the typed Writer is the fastest way to produce deterministic bytes in JS here.

**Losses:**

- **Raw decode speed** against cbor-x: 2–3.5×. Three causes:
  - snug does strictly more checking: UTF-8, key order, shortest forms, duplicates and profile rules;
  - it decodes in two passes (D017; the check pass is 14–41% of decode);
  - it copies byte strings where cbor-x aliases the input.
- **`encode()` on large integer arrays (6× cbor2) and typed arrays or byte strings (3–5×).** The integer cost is a
  known dense-array check. The typed-array and byte-string costs were not profiled.
- **Typed arrays in general.** The NaN-in-float-array rule makes snug read every element where others memcpy.
- **Profile refusals.** The current profile refuses common real-world CBOR: tags 1 and 18, nested integer keys,
  undefined, NaN. That is a profile decision (D081 / P7.1), not a defect, but adopters of snug as a general decoder
  hit it first.
- **Choice-heavy schemas.** These cost snug its §14 schedule: the study contracts run at 10–29× the scanner (P3.6),
  and a 1.4 MB six-way choice takes ~75 ms per VM.md. They still beat every other validator measured, but the
  discriminator-first dispatch in the parking lot is where the remaining time is.

## Caveats

- **Shared machine, so treat ~10% differences as noise.** The load was 7–12 throughout. CPU time removes waiting,
  not cache or memory-bandwidth contention, and medians of 9 rounds can still move about 10% between runs.
- **Only my configurations are measured.** "Strict" columns are the strictest configurations I could assemble from
  each library's documentation. Other options might change a library's speed.
- **Workloads are snug's.** cbor-x's records/structures extension (`useRecords`), which speeds up its repeated
  shapes, was disabled for interoperability, and its encode output is not deterministic.
- **Representation differences are normalised away in the checks but cost time in the libraries:**
  - tiny-cbor is Map-only and leaves tags uninterpreted;
  - cbor2, cbor-x and node-cbor alias byte strings;
  - cborg typed arrays use this harness's tag decoders.
- **The crate's wasm build is mine, not the study's:** a different ABI, opt-level 3 and a fresh build.
  @cbortech/cbor was given unlimited `maxSteps`.
- **snug's sources were changing during the runs.** The JS runs used a moving working tree (see Environment); the
  Rust and wasm builds are pinned to `0f85e8e`.
- **Not measured:** browsers, workerd, cold start, memory high-water, and hostile inputs against the other libraries.
