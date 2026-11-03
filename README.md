# snug

snug is a standalone, MIT-licensed CDDL (RFC 8610) validator and strict
deterministic CBOR (RFC 8949 §4.2.1) library. It validates bytes directly,
offers checked views for reading selected fields, and encodes deterministic
bytes from JavaScript values or typed Writer calls.

The compiler, validator, profile checks and byte-writing primitives are
written in **kin** and generated into JavaScript and Rust; WebAssembly is
built from Rust. Host code supplies the API, memory and value representation.

Why snug:

- **Sound matching:** type and group alternatives remain live together.
  There is no greedy array matching or backtracking. Map schemas that cannot
  be proved exact under snug's assignment procedure fail at compile time.
- **One validation walk:** strict CBOR checks and CDDL predicates run together.
  `validate` builds no decoded value tree. Materialising decode checks first,
  then builds values in a second pass.
- **Explicit bounds:** schema complexity, scratch, input size, depth, entries,
  items and VM work have limits. Work budgets count operations, not elapsed
  milliseconds; callers still need transport deadlines and cache quotas.
- **Safe diagnostics:** errors contain codes, offsets and schema-named paths,
  never received values, bytes or arbitrary input map keys.
- **One semantic source:** generated targets share the matching and
  deterministic encoding decisions, with cross-host conformance gates.

**Experimental, private package, version 0.0.0.** The JS buffer APIs work.
The current wire policy still has Bindle's restrictions; the general
`deterministic` default is planned in P7.1 (D081). Bindle is one optional
consumer profile in the standalone design (D080), not snug's purpose. See
[profiles](docs/profiles.md) before using another CBOR protocol.

## Quick start

No dependency installation is needed. From the repository:

```sh
cd host/js
node --input-type=module
```

Paste this JavaScript (then EOF). Package self-reference works from `host/js`:

```js
import { encode, decode } from 'snug';
import { compile } from 'snug/compile';
import { view } from 'snug/view';

const schema = await compile('message = { id: uint, text: tstr .size (0..80) }');
const bytes = encode({ text: 'hello', id: 7 }, { maxBytes: 1024 });

const result = schema.validate(bytes, 'message'); // { ok: true }, no value tree
if (!result.ok) throw new Error(result.reason);
const message = schema.decode(bytes, 'message'); // validated, then materialised
console.log(message.id, decode(bytes).text);
console.log(view(bytes, { schema, rule: 'message' }).get('id').number());
```

Compile once and reuse the schema. Compilation is asynchronous at the public
boundary because the compiler loads on the first call; the compile work
itself is synchronous. All buffer operations are synchronous. There is no
wasm initialisation step for the pure JS package.

Run the worked examples from the repository root:

```sh
node examples/validate-hostile.mjs
node examples/decode.mjs
node examples/encode-writer.mjs
node examples/view.mjs
node examples/program-cache.mjs
node examples/async-handle.mjs
```

## Package layout and reproducibility

`host/js/package.json` exports only these supported entry points, each with
hand-written TypeScript declarations:

| Entry | Exports |
| --- | --- |
| `snug` | `decode`, `encode`, `Decimal`, `NDArray`, `Float16Bytes`, `SnugFault`, `LIMITS`, `profiles` |
| `snug/schema` | `Schema`, `Program`, `ProgramError`, `validate`, `decode`, `validateAt`, `fromProgram`, `fromSerialized` |
| `snug/compile` | lazy asynchronous `compile`, `SchemaError` |
| `snug/view` | `view`, `View`, `Cursor` |
| `snug/writer` | `Writer` |
| `snug/sources` | buffer/handle/push profile scanners, sessions, in-memory handles, `SourceError` |

In a checkout, host code imports the committed `gen/js` tree by relative
path. To produce a **self-contained private package**, run `npm run build`
from `host/js`. It prints a new scratch directory containing package metadata,
host sources, declarations, generated JS, licence/provenance and docs/examples.
An explicit destination is also supported:

```sh
npm run build -- /private/tmp/snug-local-package
```

The destination must be a new scratch directory. The build copies `gen/js`
and rewrites generated import paths in the **staged copies only**. It does
not regenerate kin, install dependencies or publish. Point a local package
dependency/bundler at the staged directory; pin the repository revision that
produced it. Deep imports into generated modules are blocked by `exports`.
The compiler stays outside the static runtime import graph, including when
`snug/compile` is imported; bundlers must preserve the dynamic import split.

## Features and status

| Capability | Current state |
| --- | --- |
| CDDL rules, choices, groups, occurrences, generics, productive recursion | Implemented; exact supported subset in [CDDL support](docs/cddl-support.md) |
| Direct schema validation of CBOR buffers | Implemented; strict profile fused with matching |
| Codec, exact integers, decimals, typed arrays, ndarrays | Implemented in JS under the current restrictive wire policy |
| Checked views, cursor, detached subtree validation | Implemented; owned by default, borrowing is an explicit lifetime contract |
| Typed Writer, deterministic map ordering | Implemented in JS; failures are sticky |
| Serialised Programs and runtime-only loading | Implemented; format 1.0, digest plus structural verification |
| Known-length handles and push sources | Profile scanning implemented; public CDDL sessions remain separate work |
| General deterministic preset, extension controls, Unicode category module | Planned: P7.1–P7.3 |
| Rust and wasm | Generated core and test hosts exist; public host APIs are less complete than JS |
| Real browser and Worker package evidence | Pending P7.7; current package gate runs on Node |
| Runtime ≤20 KB min+gzip | Target missed in the recorded runtime measurement; P7.6 remains open |

This work's `cd host/js && npm test` passes **996 tests, no failures or
skips**, on Node v24.6.0. It includes every example, isolated staged-package
execution, declaration syntax/export checks, and Program corruption tests.
TypeScript semantic checking was unavailable offline. This is not a fresh
Rust/wasm, compiler-fuzz, regeneration/drift, browser or Worker gate run.
Earlier evidence and remaining work are recorded in [DEVLOG](DEVLOG.md),
with measurements and methods under [bench](bench/README.md).

## Defaults and limits

Codec decode/view/source scanning require a top-level map by default; pass
`{ top: 'any' }` for another root. Schema validation/decode default to any
root. Maps use text keys, with safe integer labels allowed only in the
top-level map under `cose: true`. Decoded ordinary maps have a null prototype.

Default input cap: **1,500,000 bytes**, depth **32**, entries per container
**65,536**, items **131,072**, bignum content **128 bytes**; compiled schemas
default to a **2,300,000-unit validation budget**. Per-call schema limits can
only lower compiled limits. Encoding enforces `maxBytes` **only when supplied,
at finish**; it is not an allocation cap while writing. See the
[guide](docs/guide.md#limits) for compile bounds and the remaining caveats.

Read the [guide](docs/guide.md), [API reference](docs/api.md),
[CDDL support](docs/cddl-support.md), [profiles](docs/profiles.md),
[specification](SPEC.md), [architecture](docs/architecture.md) and
[Program format](docs/program.md). Licence: [MIT](LICENSE);
[third-party notices](THIRD_PARTY_NOTICES.md).
