# Profiles and deterministic CBOR

snug is a standalone library (D080). Bindle/3sln.me is an optional consumer
profile and test input in that design. **The current implementation has not
yet completed that separation:** all codec/scanner/VM paths still enforce
the legacy Bindle wire restrictions. P7.1 (D081) will add the general
`deterministic` default and selectable restrictions. No current option turns
on the planned general preset; `profile: 'deterministic'` is not supported.

## What exists now

`import { profiles } from 'snug'` exports a frozen
`profiles.bindle = { top: 'map', cose: false, strictArrays: true }` option object. Use it by
spreading, e.g. `decode(bytes, { ...profiles.bindle, top: 'any' })`.
It documents current defaults; the restrictive scanner policy is already
in force independently of that object. There is deliberately no
`profiles.deterministic` alias that would imply wider acceptance.

`strictArrays: true` refuses extra array own properties (including hidden
and symbol properties) with `unsupported`; default encode ignores those
properties. Both modes refuse holes/undefined elements and require the local
Array.prototype. `top` controls checking/decoding; encode and Writer accept
non-map roots even with this preset. `cose: false` retains text-only map keys.
Compiler `profile` is a separate option and does not select this object.

| Property | Current wire policy | Planned general default (D081) |
| --- | --- | --- |
| Determinism | RFC 8949 §4.2.1 core deterministic encoding, verified on read | Same core rule |
| Lengths/heads | Definite lengths, shortest arguments, one root, no trailing bytes | Same |
| Map ordering | Complete encoded-key bytes, lexicographic; duplicates refused | Same |
| Map key kinds | Text only; safe integer labels with `cose` in the top-level map | General key kinds selectable; default preset still pending |
| Scalar floats | Shortest exact width; no NaN, ±∞, −0, or safe-range integral floats | RFC deterministic float policy, with Bindle restrictions optional |
| Simple values | false, true, null only | General preset pending |
| Tags | Only the set below, with content checks | Standard set plus selectable restrictions, not implemented |
| Text | Valid UTF-8 scalar text without Unicode noncharacters | General options pending |
| Root | Codec/view/source default map; schema default any; `top` is explicit | Preset/API final behaviour pending |

The map ordering rule is **not** RFC 8949 §4.2.3's alternative length-first
ordering. Compare complete deterministic key encodings byte by byte. With
only text keys many cases coincide; COSE labels make the distinction matter.

Current tags:

| Tags | Content / JS representation |
| --- | --- |
| 2, 3 | Canonical bignum beyond the 64-bit major-type range; 9..128 magnitude bytes, no leading zero; bigint |
| 4 | Normalised decimal fraction `[exponent, mantissa]`; negative exponent ≥−1024, nonzero mantissa not divisible by 10; Decimal |
| 40 | Row-major ndarray `[shape, data]`; 1..8 positive dimensions, matching product; NDArray |
| 69, 70, 71 | Little-endian Uint16Array, Uint32Array, BigUint64Array |
| 72, 77, 78, 79 | Int8Array, little-endian Int16Array, Int32Array, BigInt64Array |
| 84, 85, 86 | Little-endian Float16, Float32, Float64 arrays; NaN refused, −0 and infinities allowed inside these arrays |

Other tags, including 0, 1, 21–24, 32 and 55799, are currently refused.
Tags 64/68 for uint8 arrays are refused; use a byte string. There is no
generic tagged-value host wrapper. Unrecognised `profile` fields on codec
options are not a selector and must not be relied on; pass only documented
options. The [Bindle handoff](profiles/bindle.md) is historical consumer
input, not the definition of snug's standalone product scope.

## Compiler profiles are a separate axis

`compile(text, { profile })` currently accepts these restriction sets:

| Compiler profile | Accepted CDDL |
| --- | --- |
| `full` (default) | All currently supported constructs, subject to exactness and resource bounds |
| `bindle` | No sockets, `.cborseq`, unwrap, explicit cuts, recursive generics, or non-text/integer map key domains |
| `bus` | Bindle set minus regexps and recursive types; strings, containers and embedded byte strings must be bounded; no unconstrained any/bare majors; schema text capped at 16 KiB |

These profiles only refuse schemas; they never relax wire checks or change
the meaning of an accepted construct. In particular `full` is not a lenient
CBOR mode. Colon-implied cuts remain ordinary struct syntax in `bindle`.

## Version policy

The package remains private at 0.0.0. Pin a repository revision and regenerate
the staged package when updating it. APIs and provisional decisions may
change before a release; no published compatibility promise is implied.
Check this matrix and rerun your wire fixtures when adopting P7.1, because
the default accepted CBOR language will expand. Explicitly request the Bindle
preset once the selectable implementation exists if your protocol needs its
restrictions.

Programs use the separate D084 format compatibility contract: same major,
minor no newer than the loader. SOURCE_KEY incorporates effective compiler
options and snug version; a matching digest does not authenticate a cache.
See [Programs](guide.md#programs-caching-and-compatibility) for loader errors
and migration/cache policy. Current JS buffer, view, writer and source tests
do not establish full Rust-host API support. The
[dated browser/Worker matrix](guide.md#browser-and-worker-recipes) covers
revision f275938's six entry points; Unicode and later schema sources are
outside that runtime evidence.
