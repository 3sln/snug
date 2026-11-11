# snug

snug is a standalone, MIT-licensed CDDL (RFC 8610) validator and CBOR
(RFC 8949) library. It validates bytes directly, offers checked views for
reading selected fields, and encodes deterministic bytes from JavaScript
values or typed Writer calls.

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
The default wire policy is the **valid preset** (P8.4, D260): any
well-formed, valid CBOR (RFC 8949 §5.3) — indefinite lengths, non-shortest
heads and floats, keys in any order — refusing duplicate keys by value,
invalid UTF-8 and invalid content of the tags snug knows. `wire:
'deterministic'` checks RFC 8949 §4.2.1 core deterministic encoding on read
(for signing, hashing, dCBOR/CTAP2-style protocols); the **Bindle** preset
(`wire: 'bindle'`) keeps the pre-P7.1 restrictions bit for bit — one optional
consumer profile in the standalone design (D080), not snug's purpose. Encoders
write deterministic bytes under every preset. See [profiles](docs/profiles.md)
for every option.

### Can it read my protocol?

| Your data | Valid preset (default) | `wire: 'deterministic'` | `wire: 'bindle'` |
| --- | --- | --- | --- |
| Producer emits shortest forms, definite lengths, keys sorted by encoded bytes (RFC 8949 §4.2.1 / CDE) | yes | yes | yes |
| Producer emits non-shortest heads or floats, indefinite lengths, unsorted or length-first-sorted keys | yes (read through a canonical copy; values in wire order) | no (`non_shortest`, `indefinite`, `key_order`) | no |
| The same key twice, in the same or another encoding (`1` and `18 01`, `0.0` and `-0.0`) | no (`duplicate_key`, compared by value) | no | no |
| Integer map keys at any depth (COSE, CWT `cnf` holding a COSE_Key) | yes (decodes to `Map`) | yes | no (`cose` admits safe integer labels in the top-level map only) |
| Keys that are byte strings, arrays, maps, tags, floats, `null`... | yes | yes | no |
| Tags 0 (RFC 3339 date/time text), 1 (epoch time), 24 (embedded CBOR), 32 (RFC 3986 URI-reference), 55799 | yes, content checked (`Tagged`, D252) | yes | no |
| Tags 21–23 (conversion hints) | yes, any content (`Tagged`) | yes | no |
| Other tags (16–18/96–98 COSE, 61 CWT, 5 bigfloat, 33–36, 1040, 64-bit numbers, ...) | yes, opaque: any valid content, its registered meaning unchecked (`Tagged`); `tags: 'standard'` refuses them | yes | no |
| `undefined`, NaN, ±∞, −0, integral floats such as 1.0 | yes (any NaN; JS numbers keep no payload) | yes (NaN only as `f97e00`) | no |
| Unicode noncharacters in text | yes | yes | no |
| Unassigned simple values (`e0`–`f3`, `f8 20`–`f8 ff`) | yes (`Simple`, D284) | yes | no |
| Bignums, decimal fractions (tag 4), typed arrays, ndarrays | yes (RFC 8949 / RFC 8746 rules) | yes, the same rules (D265) | yes, normalised forms only |

Compiler `profile: 'full'` does not relax any wire restriction; it is a
separate, schema-side restriction set.

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
console.log(decode(encode([1, 2]), { top: 'any' })); // non-map codec round trip
```

Compile once and reuse the schema. Compilation is asynchronous at the public
boundary because the compiler loads on the first call; the compile work
itself is synchronous. All buffer operations are synchronous. There is no
wasm initialisation step for the pure JS package.
The returned Promise does not make compilation or Program verification
background or cancellable work. See [startup and isolation](docs/guide.md#programs-caching-and-compatibility).

Run the worked examples from the repository root:

```sh
node examples/validate-hostile.mjs
node examples/decode.mjs
node examples/encode-writer.mjs
node examples/view.mjs
node examples/program-cache.mjs
node examples/async-handle.mjs
node examples/validate-handle.mjs
```

## Package layout and reproducibility

`host/js/package.json` exports only these supported entry points, each with
hand-written TypeScript declarations:

| Entry | Exports |
| --- | --- |
| `snug` | `decode`, `encode`, `Decimal`, `NDArray`, `Float16Bytes`, `Tagged`, `SnugFault`, `LIMITS`, `profiles` |
| `snug/schema` | `Schema`, `Program`, `ProgramError`, `validate`, `decode`, `validateAt`, `fromProgram`, `fromSerialized` |
| `snug/compile` | lazy asynchronous `compile`, `SchemaError` |
| `snug/view` | `view`, `View`, `Cursor` |
| `snug/writer` | `Writer` |
| `snug/sources` | Sessions via `openSession(schema, rule, length, options?, scheduling?)` (replaces `Schema.session`); CDDL handle/push/stream validation, profile scanners, in-memory handles, `SourceError` |
| `snug/unicode` | optional Unicode 16.0 regexp category `tables` and provenance metadata; compile-time only |

In a checkout, host code imports the committed `gen/js` tree by relative
path. To produce a **self-contained private package**, run `npm run build`
from `host/js`. It prints a new scratch directory containing package metadata,
host sources, declarations, generated JS, licence/provenance and docs/examples.
An explicit destination is also supported:

```sh
npm run build -- /private/tmp/snug-local-package
```

An explicit destination must not exist, its parent must exist, and its
resolved path must be beneath Node's `os.tmpdir()`, `/private/tmp/`, or
`/tmp/`. Being gitignored or outside the repository alone is insufficient.
With no destination, the build creates a fresh directory under `os.tmpdir()`.
Set `TMPDIR` to an absolute project scratch path to stage inside the checkout.
The build copies `gen/js`
and rewrites generated import paths in the **staged copies only**. It does
not regenerate kin, install dependencies or publish. Point a local package
dependency/bundler at the staged directory; pin the repository revision that
produced it. Deep imports into generated modules are blocked by `exports`.
The compiler stays outside the static runtime import graph, including when
`snug/compile` is imported; bundlers must preserve the dynamic import split.

Here is a complete local consumer recipe, from the repository root. It
copies the package into a separate project without running an installer or
using the network. Use fresh `staged` and `consumer` paths on a repeat run:

```sh
mkdir -p .cache/docfix
SNUG_DOCFIX="$(pwd)/.cache/docfix"
git rev-parse HEAD > "$SNUG_DOCFIX/producing-revision.txt"
(cd host/js && TMPDIR="$SNUG_DOCFIX" npm run build -- "$SNUG_DOCFIX/staged")
mkdir -p "$SNUG_DOCFIX/consumer/node_modules"
cp -R "$SNUG_DOCFIX/staged" "$SNUG_DOCFIX/consumer/node_modules/snug"
cp "$SNUG_DOCFIX/producing-revision.txt" "$SNUG_DOCFIX/consumer/snug-revision.txt"
cat > "$SNUG_DOCFIX/consumer/package.json" <<'JSON'
{"private":true,"type":"module","dependencies":{"snug":"file:../staged"}}
JSON
cat > "$SNUG_DOCFIX/consumer/main.mjs" <<'JS'
import { encode } from 'snug';
import { compile } from 'snug/compile';
const schema = await compile('message = { id: uint }');
console.log(schema.decode(encode({ id: 7 }), 'message').id);
JS
(cd "$SNUG_DOCFIX/consumer" && node main.mjs) # 7
```

The `file:` dependency records the local source for a package manager; the
copy above supplies it immediately. Retain the complete staged directory
(including `generated/`), and adjust the relative `file:` path if relocating
the project. Copying `host/js` alone is insufficient. Version `0.0.0` does
not identify the producing revision; keep `snug-revision.txt` and record
uncommitted package changes separately. No registry installation is promised.
See [TypeScript onboarding](docs/guide.md#typescript-onboarding) and
[browser/Worker bundling](docs/guide.md#browser-and-worker-recipes).

## Features and status

| Capability | Current state |
| --- | --- |
| CDDL rules, choices, groups, occurrences, generics, productive recursion | Implemented; exact supported subset in [CDDL support](docs/cddl-support.md) |
| Prelude float widths (**changed 2026-11-11**) | `float16`/`float32`/`float64` are sets of values, as RFC 8610 §3.3 says, not encoded widths: `float32` matches a shortest-form 1.5 (encoded as float16), and `float64` matches every float (D327). Numeric controls compare across int and float exactly (`number .ge 0` compiles, D328) |
| Direct schema validation of CBOR buffers | Implemented; strict profile fused with matching |
| Codec, exact integers, decimals, typed arrays, ndarrays | Implemented in JS under the current restrictive wire policy |
| Checked views, cursor, detached subtree validation | Implemented; owned by default, borrowing is an explicit lifetime contract |
| Typed Writer, deterministic map ordering | Implemented in JS; failures are sticky |
| Serialised Programs and runtime-only loading | Implemented; format 1.0 (1.1 for a Program using extension controls), digest plus structural verification |
| Handles, push sources and streams | CDDL validation over known-length handles and push sources; streams of unknown length in drain mode (results equal the buffer's) with opt-in fail-fast (D085, D144–D147); JS, minimal Rust |
| CBOR sequences (RFC 8742) | Implemented (P7.13, D210–D219): `readSequence` / `sequenceReader` in `snug/sequence`, `snug::read_sequence` / `Sequence` in Rust; one fused check per message (profile + optional schema rule), lazy Views without a re-scan, borrowed or assembled bytes, stop/skip policy; [guide](docs/guide.md#cbor-sequences-and-sse); wasm SDK `snug-wasm-sdk/sequence` (P7.13w) |
| Unicode regexp categories | Implemented with explicit `snug/unicode` tables; no runtime table dependency |
| Wire profiles | Deterministic preset (default) and Bindle preset with per-option overrides, P7.1 (D120–D127); JS and Rust |
| Extension controls | Implemented (P7.2, D140–D143): registered `.name` controls decided by pure host predicates; generic `.chars`, `.unique`, `.samelen` in `snug/controls` / `snug::controls`; [guide](docs/guide.md#custom-controls) |
| Rust and wasm | Generated core and test hosts exist; public host APIs are less complete than JS |
| Real browser and Worker package evidence | P7.7 tested revision `f275938` on 2026-11-03; later Unicode/schema sources not covered; [matrix](docs/guide.md#browser-and-worker-recipes) |
| Bundle size | Gated per entry by `bb size` at the measured sizes (codec ≈ 14.6 KB gzip, codec + schema ≈ 41.9 KB gzip; owner decision D200, 2026-11-04) |

Documentation gate on **2026-11-03**, Node v24.6.0, revision `c15a722`
plus the documentation worktree: `cd host/js && npm test` recorded
**1,058 passed, 0 failed/skipped** ([P7.10 record](DEVLOG.md)).
Earlier gate runs on **2026-11-03**, Node v24.6.0: P7.5 ran
`cd host/js && npm test` with **996 passed, 0 failed/skipped**
([record](DEVLOG.md#phase-7--standalone-library-d080-2026-11-03)); the later
D113 run recorded **1,051 passed, 0 failed/skipped**
([record](bench/WRITER.md#d113--array-elements-by-default-strict-arrays-opt-in--2026-11-03)).
These are dated runs, not evergreen test totals. They include examples,
staged-package execution, declaration syntax/export checks and Program
corruption tests. Semantic TypeScript checking was unavailable in those runs;
the onboarding section records separate consumer evidence. These runs do
not establish fresh Rust/wasm, fuzz, drift or current browser/Worker coverage.
Earlier evidence and remaining work are recorded in [DEVLOG](DEVLOG.md),
with measurements and methods under [bench](bench/README.md).

## Defaults and limits

The wire profile defaults to the **valid preset**: any valid CBOR, any
root, any map key kind, any tag number, RFC 8949 floats, `undefined` and
noncharacters admitted; `{ wire: 'deterministic' }` additionally requires
RFC 8949 §4.2.1 deterministic encoding. `{ wire: 'bindle' }` (or `...profiles.bindle`)
restores the Bindle profile: a top-level map required by codec decode, views
and profile sources, text keys only (safe integer labels in the top-level map
under `cose: true`), Bindle tags and floats. Schema validation/decode default
to any root under every preset. Decoded text-keyed maps have a null prototype; maps
with other keys decode to `Map` ([values](docs/profiles.md#javascript-values-d123)).

Default input cap: **1,500,000 bytes**, depth **32**, entries per container
**65,536**, items **131,072**, bignum content **128 bytes**; compiled schemas
default to a **2,250,000-unit validation budget**. Per-call schema limits can
only lower compiled limits. Encoding enforces `maxBytes` **only when supplied,
at finish**; it is not an allocation cap while writing. See the
[guide](docs/guide.md#limits) for compile bounds and the remaining caveats.

Read the [guide](docs/guide.md), [API reference](docs/api.md),
[CDDL support](docs/cddl-support.md), [profiles](docs/profiles.md),
[specification](SPEC.md), [architecture](docs/architecture.md) and
[Program format](docs/program.md). Licence: [MIT](LICENSE);
[third-party notices](THIRD_PARTY_NOTICES.md).
