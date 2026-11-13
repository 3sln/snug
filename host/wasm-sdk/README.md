# @3sln/snug-wasm

CDDL (RFC 8610) validation and CBOR (RFC 8949) encoding, decoding and checked
views, running on the WebAssembly build of snug's Rust core.

**Experimental and opt-in.** The default package is `@3sln/snug`, which is
plain JavaScript and needs no wasm. This package has the same API and gives
the same answers. It validates about twice as fast and compiles 4–10× as
fast, but it needs an `init` step and a host that runs wasm, and its memory
grows and never shrinks. See
[when to choose it](docs/wasm-sdk.md#when-to-choose-it).

<!-- prerelease -->
> **Not yet on npm.** `npm install @3sln/snug-wasm` works from the first
> release on. Until then,
> [build it from a checkout](https://github.com/3sln/snug/blob/main/docs/guide.md#building-from-a-checkout).
<!-- /prerelease -->

```sh
npm install @3sln/snug-wasm
```

```js
import { init, encode } from '@3sln/snug-wasm';
import { compile } from '@3sln/snug-wasm/compile';

await init();   // loads wasm/snug.wasm from this package
const schema = await compile('message = { id: uint, ? name: tstr }');
schema.validate(encode({ id: 7 }), 'message');   // { ok: true }
```

`init` also takes a path, a URL, a `Response`, bytes or a `WebAssembly.Module`.
For synchronous start-up without any files there is
`@3sln/snug-wasm/inline`, with both modules inlined as base64. For Cloudflare
Workers, import the modules as `.wasm` bindings:

```js
import runtime from '@3sln/snug-wasm/wasm/snug.wasm';
import compiler from '@3sln/snug-wasm/wasm/snug-compiler.wasm';
import { initSync } from '@3sln/snug-wasm';
initSync({ runtime, compiler });
```

## Documentation

- [The wasm SDK](docs/wasm-sdk.md): init options, the inline entry and where
  synchronous init works, the Workers recipe, size and speed.
- [Guide](docs/guide.md) and [API reference](docs/api.md): the API is the
  same as `@3sln/snug`'s.
- [Building from a checkout](docs/guide.md#building-from-a-checkout): a
  build of a repository commit instead of the npm release.

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
