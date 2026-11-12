# The wasm SDK: `@3sln/snug-wasm`

`@3sln/snug-wasm` is snug's public JS API running on the WebAssembly build of
snug's Rust core. It is **experimental** and **opt-in**: the native package,
`@3sln/snug`, is the default and needs no wasm at all. The two packages have
the same functions, options, verdicts, error codes and Program bytes, and a
parity gate holds the SDK to the native package on the whole validator case
set. Everything in the [guide](guide.md) and the [API reference](api.md)
applies to both. This page covers only what differs: loading the wasm, the
inline entry, Workers, size and speed.

## When to choose it

Choose the SDK when all three hold:

1. **Your hot path is validation or compilation**: `validate`,
   `schema.decode`, views over large messages, handle and stream sources,
   refusal-heavy traffic, or compiling schemas at run time.
2. **Your host can run wasm**: a page's CSP allows `'wasm-unsafe-eval'`,
   a Cloudflare Worker can bind a `.wasm` module, and you can call `init`
   once before the first use.
3. **A memory high-water mark is acceptable.** wasm linear memory grows and
   never shrinks. Call `reset()` (or `view.release()`) if that matters.

Stay with the native package even then when:

- you validate large byte strings that are already in JS buffers (the copy
  into wasm memory costs about 61 µs per MiB, and can dominate);
- you encode large integer arrays in a browser or a Worker;
- you hold many views open at once;
- you only encode and decode: codec work is about even, and the native
  package is smaller.

## Speed

Ratio is the SDK's time over the native package's, so below 1 is faster.
Node rows are thread-CPU medians measured **2026-11-04** at `898434f`
(Node 24.6.0, Apple M1 Pro, macOS 14.6.1). Chrome and workerd rows were
measured **2026-11-03** at `93f8718` (Chrome 156, workerd 2025-12-17). The
full tables and the method are in [bench/D005.md](../bench/D005.md).

| operation | native | wasm | ratio |
| --- | ---: | ---: | ---: |
| validate, 287 B RPC message (Node) | 21.2 µs | 9.26 µs | 0.44 |
| validate, 120,000 ints (Node) | 3.98 ms | 1.78 ms | 0.45 |
| validate, 1.4 MB document (Node) | 60.0 ms | 26.2 ms | 0.44 |
| validate, 1 MiB byte-string body (Node; the copy in) | 20.6 µs | 66.4 µs | **3.22** |
| decode, 287 B (Node) | 5.40 µs | 4.95 µs | 0.92 |
| decode, 1.4 MB document (Node) | 39.3 ms | 32.9 ms | 0.84 |
| `schema.decode`, 287 B (Node) | 27.1 µs | 13.8 µs | 0.51 |
| compile, object-storage contract (Node) | 4.22 ms | 714 µs | 0.17 |
| validate, 287 B (Chrome / workerd) | | | 0.54 / 0.61 |
| validate, 1.4 MB document (Chrome / workerd) | | | 0.55 / 0.56 |
| encode, 120,000 ints (Chrome / workerd) | | | **1.25 / 1.54** |
| compile, object-storage (Chrome / workerd) | | | 0.24 / 0.10 |

Since 2026-11-12 the shipped modules go through binaryen's `wasm-opt`. Over
the same benchmark rows that left speed unchanged (geomean 0.987× of the
earlier build).

**Cold start** (2026-11-03): in Node, compiling and instantiating the
runtime module took 3.7 ms and 0.66 ms. The native package pays a similar
cost in cold JIT, so first-request costs come out close.

## Install and the entries

```sh
npm install @3sln/snug-wasm
```

| entry | what it is |
| --- | --- |
| `@3sln/snug-wasm` | the codec (`encode`, `decode`, the value classes), plus `init`, `initSync`, `reset`, `trim`, `memoryBytes`, `InstanceLost` |
| `@3sln/snug-wasm/schema`, `/compile`, `/view`, `/writer`, `/sources`, `/sequence`, `/controls`, `/abnf`, `/unicode` | as in `@3sln/snug` |
| `@3sln/snug-wasm/inline` | the root with both modules inlined as base64 ([below](#the-inline-entry)) |
| `@3sln/snug-wasm/wasm/snug.wasm` | the runtime module (validate, decode, encode, views, sessions) |
| `@3sln/snug-wasm/wasm/snug-compiler.wasm` | the compiler module, used by `compile()` |

`/schema` also has `fromSerializedSync(bytes, options?)`, which loads a stored
Program without a promise. `/compile` also has `compilerSource(source)`,
`releaseCompiler()` and `compilerMemoryBytes()`.

## Initialising

Call `init` once before anything else. Any call before it throws
`snug wasm: call init() first`.

```js
import { init, encode } from '@3sln/snug-wasm';
import { compile } from '@3sln/snug-wasm/compile';

await init();   // the package's own wasm/snug.wasm
const schema = await compile('message = { id: uint }');
schema.validate(encode({ id: 7 }), 'message');   // { ok: true }
```

**`await init(source?)`** compiles and instantiates the runtime module.
**`initSync(source)`** does the same synchronously. Both also take
`{ runtime, compiler }`, to set either module or both.

| source | `init` | `initSync` |
| --- | :---: | :---: |
| nothing: the module next to the SDK (`new URL('../wasm/snug.wasm', import.meta.url)`, read from disk in Node, fetched elsewhere) | yes | no |
| a file path string (Node), relative to the working directory | yes | no |
| a `URL`, or a string with a scheme (`https:`, `file:`, `data:`, `blob:`) | yes | no |
| a `Response`, or a promise of one (`fetch(url)`); compiled while it downloads when served as `application/wasm` | yes | no |
| bytes: `Uint8Array`, `ArrayBuffer`, a Node `Buffer` | yes | yes |
| a `WebAssembly.Module` (for example a Workers `.wasm` import) | yes | yes |

Outside Node, a string without a scheme is fetched relative to the page.

- **The compiler module** is loaded on the first `compile()`, from the
  default next to the SDK, unless you passed `init({ compiler })` or called
  `compilerSource(source)`. A compiler given to `init` or `initSync` is
  compiled right there, which is what a Worker needs (below).
- **Calling again.** `init()` with no argument does nothing once initialised.
  With a source, it replaces the instance, as `reset()` does.
- **`reset()`** drops the instance and its memory. Programs reload into the
  new instance lazily. Open views and sessions become unusable.
- **`trim()`** releases the reusable input buffers. The memory pages stay.
- **`InstanceLost`.** wasm code can still trap, for example on an allocation
  beyond 4 GiB, or on stack exhaustion under limits raised far past the
  defaults. The SDK then starts a fresh instance, and the failing call throws
  `InstanceLost`, never a verdict.
- **Content Security Policy.** A page needs `'wasm-unsafe-eval'` in
  `script-src` to compile wasm. The native package needs nothing.

## The inline entry

`@3sln/snug-wasm/inline` carries both modules as base64 strings, so there is no
file, URL or bundler rule to set up. Its `initSync()` and `init()` take no
argument, and both compile the runtime and the compiler modules on the spot.

```js
import { initSync, encode } from '@3sln/snug-wasm/inline';
import { compile } from '@3sln/snug-wasm/compile';

initSync();
const schema = await compile('message = { id: uint }');
```

The other entries (`/schema`, `/compile` and so on) share the same instance,
so import them as usual.

**Where `initSync()` works.** It compiles about 476 KB of wasm synchronously.
Tested 2026-11-12 with these modules:

| host | synchronous compile from bytes |
| --- | --- |
| Node 24.6.0 | yes: about 4 ms for the runtime module and 2 ms for the compiler |
| Chrome 157, main thread and a dedicated worker, under `script-src 'self' 'wasm-unsafe-eval'` | yes |
| workerd 2025-12-17 (the Cloudflare Workers runtime), **at module scope** | yes |
| workerd, **inside a request handler** | **no**: `new WebAssembly.Module` and `WebAssembly.compile` both throw "Wasm code generation disallowed by embedder" |
| Firefox, Safari | not tested |

Chrome has in the past refused synchronous compiles of more than 4 KB on
the main thread, and a synchronous compile blocks the page while it runs.
**In a page's main thread, use `await init()`.** In a Worker, call
`initSync()` at module scope, never in `fetch`. The
[Workers recipe](#cloudflare-workers) below avoids the base64 cost
altogether.

**Size cost.** Base64 is 4/3 of the bytes, and it compresses worse than the
wasm. Bytes, gzip -9 and brotli 11 (2026-11-12):

| | raw | gzip | brotli |
| --- | ---: | ---: | ---: |
| runtime module, `.wasm` | 325,264 | 131,831 | 108,824 |
| runtime module, base64 | 433,688 | 173,442 | 142,272 |
| compiler module, `.wasm` | 151,007 | 68,697 | 60,645 |
| compiler module, base64 | 201,344 | 83,778 | 73,873 |
| both modules, `.wasm` | 476,271 | 199,918 | 168,135 |
| both modules, inline (the generated JS module) | 635,209 | 256,887 | 213,451 |

So the inline entry costs about 28% more over the wire than the two `.wasm`
files, and it always includes both modules. The JS glue comes on top: the
root and `/schema` bundle to 42,794 B minified (16,502 B gzip), and every
entry except `/unicode` and `/abnf` to 138,376 B (47,584 B gzip). Measured
with esbuild 0.28.2.

## Cloudflare Workers

Workers do not compile wasm from bytes inside a request, so bind the modules
as `.wasm` imports. Wrangler turns an imported `.wasm` file into a compiled
`WebAssembly.Module` by default.

```js
// src/worker.js
import runtime from '@3sln/snug-wasm/wasm/snug.wasm';
import compiler from '@3sln/snug-wasm/wasm/snug-compiler.wasm';
import { initSync } from '@3sln/snug-wasm';
import { compile } from '@3sln/snug-wasm/compile';

initSync({ runtime, compiler });   // WebAssembly.Module values: nothing is compiled from bytes

let schema;
export default {
  async fetch(request) {
    schema ??= await compile('message = { id: uint, ? name: tstr }');
    const bytes = new Uint8Array(await request.arrayBuffer());
    const result = schema.validate(bytes, 'message');
    return Response.json(result, { status: result.ok ? 200 : 422 });
  },
};
```

```toml
# wrangler.toml
name = "snug-validator"
main = "src/worker.js"
compatibility_date = "2025-12-01"
```

This Worker buffers the whole request. Enforce a body size limit before you
use it with untrusted traffic.

**Without the compiler.** If you compile your schemas at build time, drop the
compiler import and load the Program at module scope with
`fromSerializedSync` from `@3sln/snug-wasm/schema`. The guide's "Browser and
Worker recipes" shows how to store a Program. The only change is to call
`initSync(runtime)` first.

**How this is tested** (`bb wasm-package-test`): the recipe above is copied
from this page and bundled twice, by esbuild with the `.wasm` imports kept
as modules, and by `wrangler deploy --dry-run` when wrangler is installed
(wrangler 4.56.0 on 2026-11-12). Each bundle is served by a local workerd
2025-12-17, compatibility date 2025-12-01, without `nodejs_compat`. The
wrangler upload, both modules included, is 532 KiB (216 KiB gzip). The
inline entry with `initSync()` at module scope passes there too.

## Browsers and bundlers

- **No bundler:** serve the package directory and import
  `/node_modules/@3sln/snug-wasm/src/public-index.mjs` (or map the bare
  specifiers with an import map). `await init()` then fetches
  `wasm/snug.wasm` next to the code.
- **Bundlers** that understand `new URL('...', import.meta.url)` (Vite,
  webpack 5, Parcel) copy the `.wasm` files as assets, so `await init()`
  works as is. esbuild leaves the URL alone: copy
  `node_modules/@3sln/snug-wasm/wasm/` next to your bundle, or pass
  `init({ runtime, compiler })` your own URLs.
- **Or use the inline entry**, with `await init()` on the main thread.

## The release artefacts

Each release also publishes the two modules on their own, for hosts that load
them without npm: `snug.wasm` (runtime), `snug-compiler.wasm` (compiler),
`SHA256SUMS` and `MANIFEST.json`. The manifest records the version, the
commit, the toolchain, the `wasm-opt` version and, for each module, its size,
SHA-256 and the wasm features it needs. The npm package holds the same bytes
in `wasm/`, along with the manifest.

- **Features:** WebAssembly 1.0 plus `bulk-memory` and `sign-ext`. Current
  browsers, Node 20 and later, and workerd all have both.
- **ABI:** not a public interface. The modules export a plain integer ABI
  that only this SDK's JS calls, and it can change in any release. Load the
  modules through the SDK.
- **Building them yourself** needs Rust `nightly-2026-09-16` with the
  `wasm32-unknown-unknown` target and `rust-src` (for `-Zbuild-std`), and
  binaryen 132's `wasm-opt`. In the repository, run `bb wasm-release`.
  Consumers never need Rust.
