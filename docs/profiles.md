# Profiles and deterministic CBOR

snug is a standalone library (D080). Every decoder path — the scanner, the
resumable scanner, the schema VM and its resumable session, views and the
builder — checks **RFC 8949 §4.2.1 core deterministic encoding** on read, and
the encoders produce only that. A *wire profile* narrows what is accepted
further. Two presets exist (D081, D120–D125):

* **`deterministic`** (the default): general deterministic CBOR. Any map key
  kind, the standard tag set with RFC 8949 content checks, RFC 8949 scalar
  floats (the canonical NaN, ±∞, −0, integral floats), `undefined`, and text
  that is any well-formed UTF-8 (noncharacters included).
* **`bindle`**: the Bindle/3sln.me wire profile, bit for bit as before P7.1:
  text keys only (safe-integer labels in the top-level map with `cose`), the
  Bindle tag set, no NaN/±∞/−0/safe-range integral floats, no `undefined`, no
  noncharacters, and a map at the codec's root. Every 3sln.me vector gives the
  same code under it.

Every option, and so every preset, only **removes** acceptance relative to
RFC 8949 §4.2.1; none admits a non-deterministic form (an indefinite length,
a non-shortest head or float, unsorted or duplicate keys).

```js
import { decode, encode, profiles } from 'snug';
decode(bytes);                                     // deterministic preset, any root
decode(bytes, { wire: 'bindle' });                 // the Bindle profile, map root
decode(bytes, { ...profiles.bindle, top: 'any' }); // the same, any root
decode(bytes, { keys: 'text' });                   // deterministic, text keys only
```

The wire selector is called `wire` because `compile(text, { profile })` names
a different thing: a compiler restriction set (below).

## What both presets share

| Property | Rule (both presets) |
| --- | --- |
| Determinism | RFC 8949 §4.2.1, verified on read: definite lengths, shortest arguments, one root, no trailing bytes |
| Map ordering | Complete encoded-key bytes, lexicographic (not §4.2.3's length-first order); duplicates refused |
| Integers | Major 0/1 for −2⁶⁴..2⁶⁴−1; beyond that a bignum (tags 2/3) of 9..128 content bytes, no leading zero (RFC 8949 §3.4.3 preferred serialization) |
| Floats | Shortest exact width (float16 ⊂ float32 ⊂ float64) |
| Text | Well-formed UTF-8: no overlong, no surrogate, nothing above U+10FFFF |
| Simple values | `false`, `true`, `null`; unassigned simple values (`e0`–`f3`, `f8 xx`) refused |
| Limits | `maxBytes` 1,500,000; `maxDepth` 32; `maxEntries` 65,536; `maxItems` 131,072; bignum content 128 bytes |

Map ordering compares complete deterministic key encodings byte by byte.
With text keys only, many cases coincide with length-first ordering; integer
and mixed keys show the difference: `{10, 100, -1}` is ordered `0a`, `1864`,
`20`, and the length-first `0a`, `20`, `1864` is `key_order`.

## Options

| Option | Values | `deterministic` | `bindle` |
| --- | --- | --- | --- |
| `wire` | `'deterministic'`, `'bindle'` | (the preset) | (the preset) |
| `keys` | `'text'`, `'integer'` (text and major 0/1), `'any'` | `'any'` | `'text'` |
| `tags` | `'bindle'`, `'standard'` | `'standard'` | `'bindle'` |
| `floats` | `'bindle'`, `'deterministic'` | `'deterministic'` | `'bindle'` |
| `undefinedValue` | boolean (`f7`) | true | false |
| `noncharacters` | boolean (U+FDD0..FDEF, U+xFFFE/xFFFF in text) | true | false |
| `top` (codec, views, profile sources) | `'map'`, `'any'` | `'any'` | `'map'` |
| `cose` | boolean: safe-integer labels in the top-level map under `keys: 'text'` | false | false |
| `strictArrays` (encode, Writer) | boolean | false | true |

`wire` picks the preset; any other option given explicitly overrides the
preset's value. An unknown value is a `TypeError`. Schema methods default to
`top: 'any'` under both presets, as before. `profiles.deterministic` and
`profiles.bindle` are frozen option objects spelling the presets out; spread
them to override. Rust has the same model: `snug::Profile` (`DETERMINISTIC`,
`BINDLE`, or the fields `keys`, `tags`, `floats`, `undefined_value`,
`noncharacters`) in `DecodeOptions`, `EncodeOptions` and `ValidationOptions`,
all defaulting to the deterministic preset (`DecodeOptions::bindle()` and
`EncodeOptions::bindle()` select the Bindle one).

### Key kinds

`keys: 'text'` admits major 3 keys only (plus `cose` labels, below);
`'integer'` adds major 0/1 keys of any value in −2⁶⁴..2⁶⁴−1; `'any'` admits
any well-formed item as a key, ordered by its complete encoding. `cose`
remains the Bindle option: under `keys: 'text'` it admits integer labels in
the top-level map only, which must be safe integers (−(2⁵³−1)..2⁵³−1). Under
`'integer'` or `'any'` it changes nothing on the wire. A refused key kind is
`key_type`, decided by peeking the key's major type before the key is walked.

### Tag sets

| Tags | Content rule | Set |
| --- | --- | --- |
| 2, 3 | Canonical bignum: a byte string of 9..128 bytes, no leading zero | both |
| 4 | Normalised decimal fraction `[exponent, mantissa]`: exponent −1024..−1, mantissa an integer or bignum, nonzero, not divisible by 10 | both |
| 40 | Row-major ndarray `[shape, data]`: 1..8 positive dimensions whose product is the element count | both |
| 69–72, 77–79, 84–86 | Little-endian typed arrays; float arrays refuse NaN (−0 and ±∞ allowed) | both |
| 0 | Text in RFC 3339 `date-time` form: `YYYY-MM-DDThh:mm:ss`, optional `.` fraction, `Z` or `±hh:mm`; T and Z either case; month, day within its month (leap years), hour, minute, second 00..60 and offset ranges checked | standard |
| 1 | An integer (major 0/1) or a finite float | standard |
| 21, 22, 23 | Any item (expected base64url / base64 / base16 conversion hints) | standard |
| 24 | A byte string whose content is exactly one item, itself valid under the same profile | standard |
| 32 | Text that is an RFC 3986 `URI`, checked at the character level: a scheme and `:`, then only unreserved, gen-delims and sub-delims characters or `%HH` escapes, at most one `#`, `[` `]` only before the query and fragment (the authority, IP-literal and path structure is not parsed) | standard |
| 55799 | Any item; only at the top level of the document | standard |

Every other tag, and every tag number ≥ 2³², is refused with `tag` —
including 5 (bigfloat), 33–36, 64/68, and COSE/CWT tags such as 16–18 and 61.
For the standard additions the content is an ordinary item — counted, one
depth level below the tag — walked first with all its own refusals; then the
content rule refuses with `tag` at the tag's head. A tag-24 payload is then
walked as one item two levels below the tag, bounded by its byte string: its
refusals carry their own codes and offsets, `truncated` for an empty or short
payload and `trailing` after its one item; its items count toward
`maxItems`. "Top level" for 55799 means depth 0 of the document: not inside
a tag-24 payload, a `.cbor` byte string, or a span validated by `validateAt`
below the root.

### Scalar floats

`floats: 'bindle'` refuses NaN, ±∞, ±0 and integral values within
±(2⁵³−1) with `float`, before the width check. `floats: 'deterministic'` is
RFC 8949 §4.2.1 with §4.2.2's NaN rule (D122): every float in its shortest
exact width, so ±0, ±∞ and NaN occur only as float16 (`f90000`, `f98000`,
`f97c00`, `f9fc00`, `f97e00`); a NaN must be the canonical quiet NaN
`f97e00` — any other NaN (sign bit, signalling, payload) is `float`, and the
canonical NaN in a wider width is `non_shortest`. Integral floats such as
`f93c00` (1.0) are accepted as floats. JavaScript decodes them to the number
1, and `encode(1)` writes the integer `01`: a JS round trip of an integral
float changes the bytes. Use the Writer's `float(1)` (`f93c00`) to keep one.

## The option model (D120)

The options are one integer of **profile flags**, decided in kin
(`snug.cbor.codes`):

| Bits | Field | 0 (Bindle) | Other values |
| --- | --- | --- | --- |
| 0–1 | `PF_KEYS` | text (+ `cose` labels) | 1 text + integer; 2 or 3 any |
| 2–3 | `PF_TAGS` | the Bindle set | 1–3 the standard set |
| 4 | `PF_FLOATS` | Bindle float refusals | RFC 8949 deterministic floats |
| 5 | `PF_UNDEFINED` | `f7` refused | `f7` accepted |
| 6 | `PF_NONCHAR` | noncharacters refused | noncharacters accepted |
| 7 | `PF_SUB` | (internal, never from a host) | the walk's root is not the document's top: 55799 refused at depth 0 |

The deterministic preset is `2 | 4 | 16 | 32 | 64` = 118 (`PF_DETERMINISTIC`);
Bindle is 0. **Zero means the Bindle profile** and every set bit admits more,
so an options array a host never filled, or a caller that predates the word,
gets the strictest policy and the pre-P7.1 behaviour: every older gate, which
fills only the older words, runs the Bindle profile unchanged.

* **The scanner's `o` block.** The flags are `o[11]` (`O_PROFILE`), one of the
  five scanner-reserved words of program.md §12.1; the rest of the frozen
  16-word block is unchanged. `scanOptions` writes 0 there; `scanProfile(o,
  flags)` sets it (host bits 0–6 only). Both scanners and every VM walk read
  the same word, so the VM's fused profile walk sees exactly the scanner's
  policy.
* **VM limits word 9.** `vm-validate`, `vm-validate-span` and `vms-init` take
  the flags as `limits[9]`, a VM extension word like word 8: absent (fewer
  than ten words) or negative means 0. Setup copies them into `S[O_PROFILE]`,
  adding `PF_SUB` for a span whose depth is not 0.
* **Programs** do not record a wire profile, and compilation does not depend
  on one: the compiler and verifier never read these flags, so `SOURCE_KEY`,
  the Program and its container are unchanged and one Program validates under
  either preset. The profile is a run-time option of each call, like `top` and
  the limits. (Before P7.1 the compiler silently treated a `:` member with a
  byte-string, float or beyond-64-bit integer value key as never present; it
  now refuses it with `map_cut`, D125, since such keys reach the VM.)
* **The writer.** `put-float-rfc` writes deterministic floats (any NaN as
  `f97e00`, ±∞ and ±0 as float16, integral values in their shortest width)
  where `put-float` refuses; a `Tagged` value's tag and content are checked by
  the same kin functions as decoding (`std-allowed`, `std-content-ok`, and
  the scanner over a tag-24 payload) once its content is written.
* **Resumable drivers.** The content of tags 0, 24 and 32 is read whole
  before its rule runs: the resumable scanner asks for it whole before
  walking it (so it is processed without yielding), the session re-reads it
  after the walk (pinned, D094). A map key that is a container or a tag is
  likewise asked for whole (the session also asks for byte-string and float
  keys whole); byte content inside an active key goes through the windows
  into the key arena. Each costs memory up to the item's size (D124).

Nothing in the Program format or the frozen scanner layout changes, so this
is not a Program format version change (D084): there is no Program word to
bump.

## JavaScript values (D123)

| CBOR | Decoded | Encoded from |
| --- | --- | --- |
| Map with only text keys | null-prototype object (`objects: 'plain'`: ordinary object) | plain/null-prototype object |
| Map with any non-text key | `Map`, keys decoded as values (integers as number when safe, else bigint), in encoded order | `Map` (keys the profile admits) |
| Top-level map under `cose` | `Map` (as before) | top-level `Map` with `cose` |
| Tags 0, 1, 21–24, 32, 55799 | `Tagged { tag, value }` (tag 24: the payload `Uint8Array`; `decode(t.value)` reads it) | `new Tagged(tag, value)` |
| `f7` | `undefined` | `undefined` (array elements, map values, root; holes stay refused) |
| NaN, ±∞, −0 | the number | the number |

A map's representation depends on its keys: code that accepts integer keys
must accept a `Map`. Two distinct CBOR keys that are one JavaScript `Map` key
(`1` and `1.0`, `0.0` and `-0.0`) cannot be built: decode refuses such a map
with `unsupported` (a view still reads it). `Tagged` is frozen; `value` is the
decoded content. Bindle-preset decoding never produces `Tagged`, `undefined`
or a nested `Map`. Views report `kind` `'tagged'` (with `tag` and
`content()`) and `'undefined'` (`isUndefined()`); `get(key)` accepts any key
the profile admits, comparing non-text, non-integer keys by their encoding.

## CDDL and schemas

The VM checks the profile on every item, whatever the schema says (profile
errors win, D023). Under the deterministic preset the prelude's `tdate`
(`#6.0(tstr)`), `time` (`#6.1(number)`), `eb64url`/`eb64legacy`/`eb16`,
`encoded-cbor` (`#6.24(bstr)`), `uri` (`#6.32(tstr)`), `cbor-any`
(`#6.55799(any)`) and `undefined` (`#7.23`) match valid data, as do map key
types such as `{ * int => tstr }` nested anywhere and `bstr => T` entries.
Float ranges compare as IEEE 754 does: −0.0 is inside `0.0..1.0`, a NaN is
inside no range, +∞ is inside `float .ge 1.5`. Float literals still compare
encodings: `0.0` does not equal −0.0. A `:` member whose key is a byte
string or a float (`h'00': T`, `1.5: T`) is a `map_cut` schema error; write
`h'00' => T`. Under `wire: 'bindle'` all of those data are refused by the
profile before the schema sees them.

## Against cbor2 (an independent decoder)

`bb scan-test` runs the deterministic preset against cbor2 2.4.1 (CDE mode
plus `rejectDuplicateKeys`, `rejectLongLoundNaN`, `rejectSimple`; and
`rejectLongFloats` to confirm float widths) on the vectors, the fixed and
seeded profile-option cases and every Bindle-gate input, and compares
`encode()` with cbor2's CDE encoder on seeded values (byte for byte). Every
acceptance difference falls in one documented class, otherwise the gate
fails:

| Class | snug | cbor2 |
| --- | --- | --- |
| `tag` | the standard set only, with the content rules above | any tag; few content checks |
| `tag24` | a tag-24 payload must be one valid item | not looked inside |
| `floatwidth` | non-shortest floats refused | checked only with `rejectLongFloats` (confirmed there) |
| `intfloat` | integral floats (`f93c00`) accepted (RFC 8949 §4.2.1) | `rejectLongFloats` refuses them (a dCBOR rule) |
| `nan` | only `f97e00` | also accepts `f9fe00` (sign bit) |
| `snugtags` | bignum 9..128 bytes, normalised decimals, typed-array and ndarray rules | not checked |
| `limits` | the default limits | none |
| `cbor2tag1` | any epoch integer | tag-1 decoder needs a JS number |

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

The package remains private at 0.0.0. Pin a repository revision and
regenerate the staged package when updating it. **P7.1 changed the default
wire policy** from the Bindle restrictions to the deterministic preset:
adopters who relied on the old refusals pass `wire: 'bindle'` (or spread
`profiles.bindle`) to decode, encode, the Writer, views, sources and schema
calls (Rust: `Profile::BINDLE`), and rerun their wire fixtures. Programs are
unaffected.

Programs use the separate D084 format compatibility contract: same major,
minor no newer than the loader. SOURCE_KEY incorporates effective compiler
options and snug version; a matching digest does not authenticate a cache.
See [Programs](guide.md#programs-caching-and-compatibility) for loader errors
and migration/cache policy. The
[dated browser/Worker matrix](guide.md#browser-and-worker-recipes) covers
revision f275938's six entry points, before P7.1; the profile options are
outside that runtime evidence. The [Bindle handoff](profiles/bindle.md) is
historical consumer input, not the definition of snug's standalone scope.
