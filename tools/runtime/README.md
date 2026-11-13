# Runtime evidence (P7.7): Node, a real browser, workerd

`run.mjs` runs one conformance subset (`suite.mjs`) against the **staged
package**, unchanged, in three runtimes:

- **Node**, from a fresh consumer directory. `node_modules/@3sln/snug` there is a
  copy of the staged package, so every import goes through the package
  `exports` and nothing resolves into the repository.
- **Headless Chrome**, as an esbuild bundle served from loopback under
  `Content-Security-Policy: default-src 'self'; script-src 'self'`.
- **workerd**, locally, as a module-syntax Worker. It listens on loopback only
  and is never deployed.

It also records:

- bundle sizes, minified and compressed with gzip and brotli;
- a scan of every bundle and of the package source for dynamic code
  evaluation;
- CPU per call;
- workerd cold start, as spawn to first response against an empty worker.

Nothing is fetched from the network, and the tools are used read-only.

```sh
# Stage from a clean worktree when the working tree is mid-edit:
git worktree add --detach /tmp/…/snug-head HEAD
SNUG_WORKERD=…/workerd node tools/runtime/run.mjs --checkout /tmp/…/snug-head --out /tmp/…/run
#   --package DIR   reuse a staged package   --samples N   cold-start samples (21)
#   --skip browser,workerd,cold,cpu
```

`run.mjs` writes `OUT/results.json`, which holds every figure including the
raw cold-start samples. It prints the tables below to stdout.

## What the suite checks

All six entry points are imported by bare specifier (`@3sln/snug`,
`@3sln/snug/schema`, `/compile`, `/view`, `/writer`, `/sources`; the tables
below name them without the scope). The suite uses no
Node APIs. `fixtures.mjs` builds the fixtures in Node from the checkout's
corpus. They are served as a JSON file to the browser and as a JSON module to
workerd, so they are not part of any bundle.

| group | checks |
| --- | --- |
| codec: profile accept / refuse | 74 accept vectors: `decode` gives the expected value under strict structural equality, and `encode` of both the expected and the decoded value gives the exact bytes. 142 refuse vectors: `SnugFault` with the stated code. |
| codec: cborg oracle | 327 inputs that cborg accepts. The 12 that the oracle file labels `profile:<code>` must be refused with that code. The rest must decode and re-encode byte-identically. |
| contracts: compile / validate | The six study contracts in `corpus/conformance/study.json` are compiled through the lazy `snug/compile`. Their 45 cases are validated, and every verdict must equal `expect`. |
| study probes | The other 64 study suites, excluding phase "later". Each is compiled and its cases validated. The 5 expected compile refusals must fail with `SchemaError` and the stated code. |
| programs | `serialize()` must produce the same container bytes that Node produced when the fixtures were built. `fromSerialized` and `fromProgram` must validate identically. `sourceKey` and `rules` must be preserved, reserialisation must give the same bytes, and a flipped byte must give `ProgramError('digest')`. |
| view: walk | Each accepted contract case is opened with a checked `view`, then: <ul><li>`value()` must equal `schema.decode`;</li><li>a recursive `entries()` walk must agree with a `Cursor` enter/next/up walk;</li><li>`get`/`at` lookups must return the same offsets;</li><li>`validateAt` and borrowed `raw()` are checked.</li></ul> The `examples/view.mjs` span is also checked, and a refused message must fail at open. |
| writer | `new Writer().value(v)` must reproduce each accept vector's bytes. The typed calls from `examples/encode-writer.mjs` are checked, and an incomplete root must fail. |
| sources: asyncHandle | Every profile vector is scanned with `scanHandle(asyncHandle(…))` (chunk 64, quantum 2) and with `scanHandleSync(bufferHandle(…))`, including the refusal codes. A 256 KiB document is scanned in 16 KiB chunks. |

There are 976 checks in all. Each check runs twice:

- **compile arm**: the CDDL text is compiled in the runtime.
- **precompiled arm**: the Programs serialised in Node are loaded with
  `fromSerialized`. The compiler is never imported.

The browser page loads `control.js` before the bundle. That script is not
part of snug. It checks that the CSP really refuses `eval` and
`new Function`, so the suite passing shows that snug needs neither.

## Environment and method (2026-11-03)

- **Package**: staged by `host/js/src/package-build.mjs` from a clean
  `git worktree` of **f275938** (HEAD at the time). The working tree had
  uncommitted session-VM edits in `gen/js/snug/vm/*` and `kin/vm-session*.kin`;
  those are not in the package.
- **Machine**: Apple M1 Pro (10 cores, 32 GiB), macOS 14.6.1, arm64.
- **Load**: the machine was heavily shared. Load average was 60–120 during
  the runs, from other agents' fuzz and proptest campaigns. **Every wall-clock
  figure is inflated and noisy.** CPU figures hold up better.
- **Node**: v24.6.0.
- **esbuild**: 0.28.2, from `bench/compare/node_modules`. It bundles ESM;
  `--splitting` is used for the browser and the split worker.
- **Chrome**: Google Chrome 156.0.8078.80, run `--headless=new` with a
  throwaway profile. The page is served by a Node static server on
  127.0.0.1, port chosen at random, with COOP/COEP set so that it is
  `crossOriginIsolated` and `performance.now()` is fine-grained. Results come
  back to the server by `POST`.
- **workerd**:
  - Main runs: **2026-11-02**, the native binary from `workerd` 1.20261102.1.
    That binary sat in another project's scratch `node_modules` and was used
    read-only. `../3sln.me/node_modules` was not present on this machine.
  - Repeat run: **2025-12-17**, from the global bun install. All three workers
    passed the suite there as well (976/976 in every arm).
  - Config: `compatibilityDate = "2025-12-01"`, no compatibility flags, so no
    `nodejs_compat`.
- **Cold start**: the method of `bench/scan-cold-workerd.mjs`. workerd
  freezes timers between I/O, so nothing is timed inside the isolate; each
  sample is spawn of `workerd serve` to the first HTTP response. There were 21
  samples per worker, interleaved, after one warm-up each. The workerd
  process's CPU time at that first response was also read with
  `ps -o time=`, which has 10 ms resolution.
- **CPU per call**:
  - Node: `process.threadCpuUsage` over batches, median of 7.
  - workerd: process CPU over 20 requests of n calls each, minus 20 `/noop`
    requests, median of 3.
  - Chrome: wall time only (a page has no CPU clock).

## Results

### Pass counts: 976 / 0 everywhere

| runtime | compile arm pass / fail | precompiled arm pass / fail |
| --- | ---: | ---: |
| Node (fresh consumer dir) | 976 / 0 | 976 / 0 |
| Chrome headless, strict CSP | 976 / 0 | 976 / 0 |
| workerd, split bundle (lazy compiler chunk) | 976 / 0 | 976 / 0 |
| workerd, one-file bundle (compiler inlined) | 976 / 0 | 976 / 0 |
| workerd, no compiler (fromSerialized only) | — | 976 / 0 |

Per group, compile arm. Times are wall ms on the loaded machine. workerd
cannot time itself, so its column has counts only.

| group | Node | Chrome | workerd |
| --- | ---: | ---: | ---: |
| codec: profile accept | 74/0, 34.7 | 74/0, 9.6 | 74/0 |
| codec: profile refuse | 142/0, 69.5 | 142/0, 1.7 | 142/0 |
| codec: cborg oracle | 327/0, 133.7 | 327/0, 37.8 | 327/0 |
| contracts: compile | 6/0, 1022.5 | 6/0, 94.1 | 6/0 |
| contracts: validate | 45/0, 167.7 | 45/0, 17.2 | 45/0 |
| study probes: compile + validate | 64/0, 561.8 | 64/0, 52.3 | 64/0 |
| programs: serialize / fromSerialized | 6/0, 126.3 | 6/0, 25.0 | 6/0 |
| view: walk | 19/0, 133.3 | 19/0, 13.5 | 19/0 |
| writer | 76/0, 15.9 | 76/0, 1.6 | 76/0 |
| sources: asyncHandle | 217/0, 1508.3 | 217/0, **11519.1** | 217/0 |

Node's group times look slow next to Chrome's because the Node arm ran while
the load average was at its worst. Its CPU-per-call figures below are close
to Chrome's. The Chrome `sources` time is a real effect, explained under
incompatibilities below.

Other checks:

- **Same Program bytes everywhere.** The Programs serialised in Chrome and in
  workerd are byte-identical to the ones Node produced, for all six
  contracts.
- **Float16Array** exists natively in Chrome 156 and in workerd. The f16
  vectors decode to native `Float16Array` in both.

### CSP and dynamic code: none

- **CSP**: under the strict CSP, Chrome blocked both control probes, `eval`
  and `new Function`. Those two are the only CSP violations and the only CSP
  reports, and both come from `control.js`. No page errors were recorded.
- **Bundles**: none of the 38 produced bundle files (2.6 MB) contains `eval(`,
  `new Function`, `Function(`, `WebAssembly.compile/instantiate/Module/…`, a
  string `setTimeout`/`setInterval`, or a non-literal `import()`.
- **Package source**: the same patterns appear 0 times in the staged
  package's `src/` and `generated/`.

### Sizes (esbuild `--minify`, bytes)

| bundle | raw | gzip -9 | brotli 11 |
| --- | ---: | ---: | ---: |
| snug (codec: decode, encode, values) | 31,267 | 10,974 | 9,881 |
| snug/schema (Program, Schema, fromSerialized; no compiler) | 110,567 | 41,034 | 35,328 |
| snug/view | 26,457 | 9,646 | 8,666 |
| snug/writer | 20,438 | 7,282 | 6,568 |
| snug/sources | 20,230 | 7,842 | 6,976 |
| runtime: snug + schema + view + writer + sources (no compiler) | 155,193 | **56,226** | 48,142 |
| runtime + snug/compile, one file (compiler inlined by esbuild) | 276,768 | **94,456** | 80,604 |
| runtime + snug/compile, split: loaded at import (4 files) | 156,668 | 57,456 | 49,409 |
| runtime + snug/compile, split: loaded by the first compile() (2 files) | 121,430 | 38,932 | 33,612 |
| test worker: split (suite + ops + snug, 7 files) | 287,642 | 100,616 | 87,442 |
| test worker: one file | 287,766 | 99,373 | 84,358 |
| test worker: no compiler (`snug/compile` aliased to a stub) | 164,714 | 59,690 | 51,210 |

#### Workers and the lazy compiler

**esbuild and workerd both handle the lazy compiler import.**

- With `--splitting`, the `import('./compile.mjs')` in `snug/compile` becomes
  separate chunks. workerd loads them through `import()` **during a request**
  when every chunk is listed as an `esModule` in the config. All 976 checks
  passed this way.
- Without splitting, esbuild inlines the compiler into the one file. The
  compiler is still initialised only on the first `compile()`, but its bytes
  ship with the worker.
- Wrangler-style single-file deploys therefore pay the full **94 KB gzip**.
  A runtime-only Worker can avoid the compiler entirely:
  1. Serialise Programs at build time with `schema.program.serialize()`.
  2. Load them with `fromSerialized`.
  3. Never import `snug/compile`, or alias it away.

  That Worker costs **56 KB gzip**. It passed the precompiled arm (976/976)
  with no compiler in the bundle.

#### Comparison with earlier figures

- `snug/schema` alone is 41 KB gzip.
- The runtime figure (56 KB) is larger than the 35.4 KB recorded in P7.8,
  which used a different entry set, and well over the R9 target of 20 KB.
  That gap is P7.6's.

### CPU per call: the object-storage `put` request (Program 8,785 B)

| op | Node CPU µs | workerd CPU µs | Chrome wall µs |
| --- | ---: | ---: | ---: |
| decode | 3.1 | 3.3 | 3.7 |
| encode | 6.5 | 7.6 | 9.2 |
| validate | 16.5 | 14.0 | 16.6 |
| schema.decode | 19.5 | 17.8 | 16.8 |
| checked view + one lookup | 18.1 | 15.8 | 16.0 |
| fromSerialized (digest + vm-verify) | 263.5 | 273 | 269.5 |
| compile (object-storage contract) | 3,212 | 4,100 | 2,535 |
| scanHandle, ~200 KB, no quantum | 2,801 | 2,333 | 1,818 |
| scanHandle, same, quantum 1000 (130 yields) | 3,888 | 18,667 | **651,265** |

Warm per-call cost is the same in all three runtimes, within the noise.

### workerd cold start (spawn to first response, 21 samples, interleaved)

| worker | min+gzip | wall median ms | min | max | median − empty | process CPU median ms | CPU − empty |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| empty (holds the input) | 220 | 50.5 | 36.1 | 113.1 | 0 | 30 | 0 |
| import (snug/schema imported, not called) | 41,328 | 69.9 | 40.6 | 145.0 | 19.4 | 40 | 10 |
| runtime (first request: fromSerialized + validate) | 43,736 | 128.4 | 74.6 | 324.4 | 77.9 | 70 | 40 |
| compile (first request: compile + validate) | 79,975 | 332.0 | 141.2 | 606.7 | 281.4 | 170 | 140 |

The wall figures carry the machine load. P1.4 measured an empty worker at
18 ms on a quieter day; here it is 50 ms. **CPU at first response is the
steadier signal**:

- Importing snug costs about one 10 ms tick.
- The first request costs about **40 ms CPU** when it loads a Program and
  validates.
- The first request costs about **140 ms CPU** when it compiles the contract
  instead.

Node shows the same first-call shape in a fresh process (5 runs):

| first call | Node thread CPU |
| --- | ---: |
| `fromSerialized` | ≈ 10–14 ms |
| `validate` | ≈ 6–12 ms |
| `compile` | ≈ 80–94 ms |
| `fromSerialized`, second call | 1.5–2.5 ms |
| `compile`, second call | 7–10 ms |

The cold cost is unoptimised first execution of the generated verifier and
VM, not parsing.

#### What this means for Workers CPU limits

On a plan with a 10 ms CPU limit per request, the first request on a new
isolate that calls `fromSerialized` will exceed it. This was not tested on
Cloudflare.

`fromSerialized` does its work synchronously inside the call. Calling it at
module scope should move the verification into Worker startup, which has a
separate budget. That was not measured.

## Incompatibilities found

1. **Cooperative yields cost a 4 ms timer clamp in browsers (performance).**
   Affects `snug/sources` with a non-zero `quantum`, in browsers and workerd.
   - **Cause**: in `src/sources.mjs`, the drivers yield with
     `setImmediate` when it exists and otherwise with `setTimeout(r, 0)`.
     Browsers and workerd without `nodejs_compat` have no `setImmediate`.
     HTML clamps chained `setTimeout` to ≥ 4 ms after five nested levels.
   - **Chrome, per yield**: `setTimeout` 4.77 ms, `MessageChannel` 0.010 ms,
     `scheduler.yield()` 0.021 ms.
   - **Effect**: a 200 KB scan with 130 yields took 651 ms in Chrome instead
     of 1.8 ms. In workerd, the same scan took 263 ms of wall time per request
     instead of 4.6 ms, and the timers alone cost about 16 ms CPU.
   - **`asyncHandle`** resolves every read with `setTimeout`, so it is clamped
     the same way. That is why the browser `sources` group takes 11.5 s. It is
     a test helper; real handles such as `Blob.slice().arrayBuffer()` are not
     affected.
   - Correctness is unaffected: all verdicts passed.
   - **Proposed fix** (not made here): pick the yield primitive in this order,
     with `setTimeout` last: `scheduler.yield`, then `setImmediate`, then a
     shared `MessageChannel`.

2. Nothing else. No dynamic code evaluation, no Node-only API on any runtime
   import path, no CSP violation from snug, and no difference in any verdict,
   value, encoding or Program byte between Node, Chrome and workerd.

## Notes

- **cborg oracle labels.** The repository's baseline codec
  (`bench/baseline/cbor-3sln.mjs`) agrees with 11 of the 12 `profile:` labels.
  It accepts the float32 typed array holding a NaN (`a16161d855440000c07f`,
  labelled `profile:typed_array`) and decodes the payload as
  1.6 × 10¹⁹. snug refuses it with `typed_array`, as labelled.
  `host/js/test/codec.test.mjs` decides its oracle verdicts with the
  baseline, so it runs only the trusted builder on that input and never
  checks the refusal. The suite here uses the labels instead.
- **Public sources.** The public `snug/sources` entry is still profile-only
  (D106), so the async handle is exercised through `scanHandle`. Schema
  validation over handles, the P6.2 session VM, is not public at f275938 and
  is not covered here.
