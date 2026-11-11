# Profiles: valid, deterministic and Bindle CBOR

snug is a standalone library (D080). A *wire profile* decides what every
decoder path — the scanner, the resumable scanner, the schema VM and its
resumable session, views, sources and sequences — accepts. The encoders write
RFC 8949 §4.2.1 core deterministic bytes under every profile. Three presets
exist (D081, D120–D125, D180, D260):

* **`valid`** (the default, P8.4, D260): any **well-formed, valid** CBOR (RFC
  8949 §5.3) — indefinite lengths, non-shortest heads and floats, map keys in
  any order, NaN payloads — refusing what is not valid: a duplicate map key
  *by value* (RFC 8949 §5.6.1: `1` twice, or `"a"` in two encodings), invalid
  UTF-8, invalid content of a tag snug knows (dates, URIs, bignums, tag-24
  payloads, typed-array lengths, …) and everything not well-formed. Its other
  options are the deterministic preset's (unassigned simple values included,
  D284).
* **`deterministic`**: general deterministic CBOR, checked on read: exactly
  the RFC 8949 §4.2.1 core requirements (definite lengths, shortest heads
  and floats, keys in bytewise order) **plus** §4.2.2's choice of a single
  NaN (D122): "If NaN is an allowed value, and there is no intent to support
  NaN payloads or signaling NaNs, the protocol needs to pick a single
  representation, typically 0xf97e00." So a shortest-form NaN with a payload
  (`f97e01`) is core-deterministic but refused here with `float`; the default
  `valid` preset accepts it. §4.2.1 alone is not offered as a preset. Any map key kind, any tag number with
  the content checks of the tags snug knows, RFC 8949 scalar floats,
  `undefined` and the unassigned simple values (`Simple`, D284), and any
  well-formed UTF-8 (noncharacters included). Choose it
  for signing, hashing and protocols that require deterministic encoding
  (dCBOR, CTAP2, COSE inputs to be signed).
* **`bindle`**: the Bindle/3sln.me wire profile, bit for bit as before P7.1:
  deterministic, text keys only (safe-integer labels in the top-level map
  with `cose`), the Bindle tag set and its application rules (normalised
  decimals, ndarrays, NaN-free typed arrays, 55799 at the top only; D265), no
  NaN/±∞/−0/safe-range integral floats, no simple values but `false`, `true`
  and `null`, no noncharacters, and
  a map at the codec's root. Every 3sln.me vector gives the same code under
  it.

Under `deterministic` and `bindle` every option only **removes** acceptance
relative to RFC 8949 §4.2.1; neither admits a non-deterministic form. Under
`valid` the same options remove acceptance relative to RFC 8949 §5.3.

```js
import { decode, encode, profiles } from 'snug';
decode(bytes);                                     // valid preset, any root
decode(bytes, { wire: 'deterministic' });          // RFC 8949 §4.2.1 checked
decode(bytes, { wire: 'bindle' });                 // the Bindle profile, map root
decode(bytes, { ...profiles.bindle, top: 'any' }); // the same, any root
decode(bytes, { keys: 'text' });                   // valid, text keys only
```

The wire selector is called `wire` because `compile(text, { profile })` names
a different thing: a compiler restriction set (below).

## Valid CBOR (P8.4, D260–D268)

What `valid` reads, and how:

| Input | Under `valid` | Under `deterministic` |
| --- | --- | --- |
| Indefinite-length arrays, maps, byte and text strings | accepted (chunks of the string's own major type, definite) | `indefinite` |
| Non-shortest integer, length or tag heads; floats wider than needed | accepted | `non_shortest` |
| Map keys out of bytewise order | accepted, read in wire order | `key_order` |
| Duplicate keys, compared by value: their canonical (EC) encodings, so `1` / `1801`, `0.0` / `-0.0`, two NaNs | `duplicate_key` | `duplicate_key` (or `key_order`, whichever comes first) |
| NaN with a payload or sign, any width | accepted | `float` |
| Bignums with leading zeros or below 2⁶⁴ (tags 2/3) | accepted (the integer) | `bignum` |
| `f8` with a value below 24 | `malformed` (RFC 8949 Appendix F) | `non_shortest` |
| `f8 18`–`f8 1f` (simple values 24–31, RFC 8949 §3.3) | `malformed` | `malformed` (Bindle: `simple`) |
| Unassigned simple values (`e0`–`f3`, `f8 20`–`f8 ff`) | accepted (`Simple`, D284) | accepted (Bindle: `simple`) |
| Invalid UTF-8, a refused known tag's content, a lone break, truncation | refused with its code | refused with its code |

Values: a decoded map keeps its keys in wire order (D267); a bignum with
leading zeros decodes to its integer; JavaScript numbers (and Rust's
`Value::Float(f64)`) do not keep a NaN payload — a View's `raw()` keeps the
bytes. `encode(decode(x))` is the deterministic encoding of `x`'s value.

How: the scanner walks valid CBOR in one pass and records the keys of maps
whose duplicates it cannot decide bytewise (keys out of order, not in their
canonical form, or EC-sensitive such as floats); a deferred check sorts and
compares their canonical forms within the budget (D263, D277). Views and the
decoder of non-deterministic input read the input's canonical copy (DC form,
wire order kept): a View's offsets are positions in that copy and `borrowed`
is false; Rust's borrowing `View::open` answers `Error::Usage("owned_view")`
and `snug::Document` owns the copy (D267). The schema VM first walks the
input as deterministic CBOR; if it meets an encoding only valid CBOR has (or
an EC-sensitive key), it validates the canonical copy instead, replaying the
input's refusals at their own positions so that the reason, offset, budget
and items are the same on both routes (D262, D264, D280). Resumable sessions
and sequences take such items whole (D283). Costs: bench/README.md
"Valid CBOR (P8.4)".

## What the presets share

| Property | Rule (`deterministic` and `bindle`; `valid` relaxes the first four as above) |
| --- | --- |
| Determinism | RFC 8949 §4.2.1, verified on read: definite lengths, shortest arguments, one root, no trailing bytes (`valid`: one root, no trailing bytes) |
| Map ordering | Complete encoded-key bytes, lexicographic (not §4.2.3's length-first order); duplicates refused (`valid`: any order, duplicates by value refused) |
| Integers | Major 0/1 for −2⁶⁴..2⁶⁴−1; beyond that a bignum (tags 2/3) of 9..128 content bytes, no leading zero (RFC 8949 §3.4.3 preferred serialization; `valid`: any bignum of at most 128 content bytes) |
| Floats | Shortest exact width (float16 ⊂ float32 ⊂ float64; `valid`: any width). In schemas the prelude names `float16`/`float32`/`float64` are sets of values, not widths (D327): `float32` admits any float binary32 represents exactly, in any encoding, and `float64` every float |
| Text | Well-formed UTF-8: no overlong, no surrogate, nothing above U+10FFFF |
| Simple values | `false`, `true`, `null`; `deterministic` (and `valid`) also `undefined` and the unassigned values 0–19 and 32–255 (`undefinedValue`, D284), Bindle refuses them (`simple`); `f8` with a value below 32 is not well-formed (`malformed`; Bindle: `simple`, or `non_shortest` below 24) |
| Limits | `maxBytes` 1,500,000; `maxDepth` 32; `maxEntries` 65,536; `maxItems` 131,072; bignum content 128 bytes |

Map ordering compares complete deterministic key encodings byte by byte.
With text keys only, many cases coincide with length-first ordering; integer
and mixed keys show the difference: `{10, 100, -1}` is ordered `0a`, `1864`,
`20`, and the length-first `0a`, `20`, `1864` is `key_order`.

## Options

| Option | Values | `valid` (default) | `deterministic` | `bindle` |
| --- | --- | --- | --- | --- |
| `wire` | `'valid'`, `'deterministic'`, `'bindle'` | (the preset) | (the preset) | (the preset) |
| `keys` | `'text'`, `'integer'` (text and major 0/1), `'any'` | `'any'` | `'any'` | `'text'` |
| `tags` | `'bindle'`, `'standard'`, `'any'` | `'any'` | `'any'` | `'bindle'` |
| `floats` | `'bindle'`, `'deterministic'` | `'deterministic'` | `'deterministic'` | `'bindle'` |
| `undefinedValue` | boolean: simple values other than `false`/`true`/`null` — `f7` and the unassigned ones (D284) | true | true | false |
| `noncharacters` | boolean (U+FDD0..FDEF, U+xFFFE/xFFFF in text) | true | true | false |
| `top` (codec, views, profile sources) | `'map'`, `'any'` | `'any'` | `'any'` | `'map'` |
| `cose` | boolean: safe-integer labels in the top-level map under `keys: 'text'` | false | false | false |
| `strictArrays` (encode, Writer) | boolean | false | false | true |

`wire` picks the preset; any other option given explicitly overrides the
preset's value (`{ keys: 'text' }` is the valid preset with text keys). An
unknown value is a `TypeError`. Schema methods default to `top: 'any'` under
every preset, as before. `profiles.valid`, `profiles.deterministic` and
`profiles.bindle` are frozen option objects spelling the presets out; spread
them to override. Rust has the same model: `snug::Profile` (`VALID`,
`DETERMINISTIC`, `BINDLE`, or the fields `keys`, `tags`, `floats`,
`undefined_value`, `noncharacters`, `valid`) in `DecodeOptions`,
`EncodeOptions`, `ValidationOptions` and `SequenceOptions`, all defaulting to
the valid preset (`DecodeOptions::deterministic()` and `::bindle()`,
`EncodeOptions::bindle()` select the others).

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
| 64–68, 73–75, 80–83, 87 | RFC 8746 typed arrays outside the Bindle set (uint8, big-endian forms, clamped, float128): a byte string holding whole elements (1, 2, 4, 8 or 16 bytes); no NaN rule | any |
| 65535, 2³²−1, 2⁶⁴−1 | Refused: RFC 8949 §9.2's invalid tag numbers | any |
| every other number, up to 2⁶⁴−2 | Any item (COSE 16–18 and 96–98, CWT 61, 5 bigfloat, 33–36, 76, 256, ...) | any |

`tags: 'standard'` refuses every tag outside the first two groups, and every
tag number ≥ 2³², with `tag`; `tags: 'bindle'` refuses the standard
additions as well. Under `tags: 'any'` (the deterministic preset, D180) a
tag of any number is accepted with any well-formed content, except where the
table gives a rule: the known tags keep their rules, so `tag` still refuses
a malformed date, a nested 55799 or an RFC 8949 invalid number, and
`bignum`/`decimal`/`ndarray`/`typed_array` keep their codes for 2, 3, 4, 40
and the little-endian typed arrays. A tag number of more than 32 bits never
follows a 32-bit tag's rule (tag 2³²+2 is not a bignum: the whole number is
compared). The tag's head must be shortest like every head: `d812` for 18
is `non_shortest`. For every tag but 2, 3, 4, 40 and the little-endian typed
arrays (whose content is a byte string or a two-element array, as in
cbor.mjs) the content is an ordinary item — counted, one depth level below
the tag — walked first with all its own refusals; then the content rule
refuses with `tag` at the tag's head. A tag-24 payload is then
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
| 2–3 | `PF_TAGS` | the Bindle set | 1 the standard set; 2 or 3 any tag (D180) |
| 4 | `PF_FLOATS` | Bindle float refusals | RFC 8949 deterministic floats |
| 5 | `PF_UNDEFINED` | simple values but `f4`–`f6` refused (`simple`) | `f7` and the unassigned simple values (`e0`–`f3`, `f8 20`–`f8 ff`) accepted; `f8 18`–`f8 1f` `malformed` (D284) |
| 6 | `PF_NONCHAR` | noncharacters refused | noncharacters accepted |
| 7 | `PF_SUB` | (internal, never from a host) | the walk's root is not the document's top |
| 8 | `PF_VALID` | deterministic CBOR only | any valid CBOR (D260) |
| 9–10 | `PF_CANON`, `PF_VREL` | (internal) | the VM walks a canonical copy; a valid-CBOR run (the VM's translation of `PF_VALID`) |

The valid preset is `122 | 256` = 378 (`PF_VALID_PRESET`); the deterministic
preset is `2 | 8 | 16 | 32 | 64` = 122 (`PF_DETERMINISTIC`; 118 with
`tags: 'standard'`, the preset before D180); Bindle is 0. **Zero means the Bindle profile** and every set bit admits more,
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
  the same kin functions as decoding (`std-allowed`, `std-content-ok` by the
  *rule tag* — the number, −2 beyond 32 bits, −1 for 2⁶⁴−1 — and the
  scanner over a tag-24 payload) once its content is written.
* **Resumable drivers.** The content of tags 0, 24 and 32 is read whole
  before its rule runs: the resumable scanner asks for it whole before
  walking it (so it is processed without yielding), the session re-reads it
  after the walk (pinned, D094). A map key that is a container or a tag is
  likewise asked for whole (the session also asks for byte-string and float
  keys whole); byte content inside an active key goes through the windows
  into the key arena. Each costs memory up to the item's size (D124), and is
  bounded by `maxBytes` (and, for keys, by the key arena the host gives the
  session). The rule of an any-level typed array (64–68, ...) reads only
  its content's head: the resumable scanner records its verdict from the head
  and the session decides it from the head before the walk (holding the
  refusal until the content's own refusals have had their turn), so their
  byte strings stream through the windows like any other (D180, D183).

Nothing in the Program format or the frozen scanner layout changes, so this
is not a Program format version change (D084): there is no Program word to
bump.

## JavaScript values (D123)

| CBOR | Decoded | Encoded from |
| --- | --- | --- |
| Map with only text keys | null-prototype object (`objects: 'plain'`: ordinary object) | plain/null-prototype object |
| Map with any non-text key | `Map`, keys decoded as values (integers as number when safe, else bigint), in encoded order | `Map` (keys the profile admits) |
| Top-level map under `cose` | `Map` (as before) | top-level `Map` with `cose` |
| Every tag but 2, 3, 4, 40 and the little-endian typed arrays | `Tagged { tag, value }` (tag 24: the payload `Uint8Array`; `decode(t.value)` reads it); `tag` a number, a bigint beyond 2⁵³−1 | `new Tagged(tag, value)` (a number or a bigint below 2⁶⁴) |
| `f7` | `undefined` | `undefined` (array elements, map values, root; holes stay refused) |
| Other simple values (`e0`–`f3`, `f8 20`–`f8 ff`) | `Simple { value }` (interned and frozen: `new Simple(16) === new Simple(16)`, so Map keys compare by value) | `new Simple(n)`, n in 0–19 or 32–255 (anything else: `simple`), shortest form; `Writer#simple(n)` |
| NaN, ±∞, −0 | the number | the number |

A map's representation depends on its keys: code that accepts integer keys
must accept a `Map`. Two distinct CBOR keys that are one JavaScript `Map` key
(`1` and `1.0`, `0.0` and `-0.0`) cannot be built: decode refuses such a map
with `unsupported` (a view still reads it). `Tagged` is frozen; `value` is the
decoded content. Bindle-preset decoding never produces `Tagged`, `undefined`,
`Simple` or a nested `Map`. Views report `kind` `'tagged'` (with `tag` and
`content()`), `'undefined'` (`isUndefined()`) and `'simple'` (`simple()`: the
number); `get(key)` accepts any key
the profile admits, comparing non-text, non-integer keys by their encoding.

## CDDL and schemas

The VM checks the profile on every item, whatever the schema says (profile
errors win, D023). Under the valid and deterministic presets the prelude's `tdate`
(`#6.0(tstr)`), `time` (`#6.1(number)`), `eb64url`/`eb64legacy`/`eb16`,
`encoded-cbor` (`#6.24(bstr)`), `uri` (`#6.32(tstr)`), `cbor-any`
(`#6.55799(any)`) and `undefined` (`#7.23`) match valid data, as do `#7.n`
for the unassigned simple values (n 0–19, and 32–255 per RFC 9682 §3.2; `#7.24`–`#7.31`
match nothing yet, and RFC 9682's `#7.<type>` head numbers are not parsed), and so does
`#6.n(T)` for any tag number `n` (COSE_Sign1 `#6.18([...])`, `#6.61(...)`,
64-bit numbers compared whole) and bare `#6`, as do map key
types such as `{ * int => tstr }` nested anywhere and `bstr => T` entries.
Float ranges compare as IEEE 754 does: −0.0 is inside `0.0..1.0`, a NaN is
inside no range, +∞ is inside `float .ge 1.5`. Float literals still compare
encodings: `0.0` does not equal −0.0. A `:` member whose key is a byte
string or a float (`h'00': T`, `1.5: T`) is a `map_cut` schema error; write
`h'00' => T`. Under `wire: 'bindle'` all of those data are refused by the
profile before the schema sees them. Under `valid`, schema literals, keys and
duplicate checks compare values by their canonical forms (D261), so
`{ 1: int }` matches a key `1801`, and a non-deterministic `.cbor` payload is
validated through its canonical copy.

## Against cbor2 (an independent decoder)

`bb scan-test` runs the deterministic preset against cbor2 2.4.1 (CDE mode
plus `rejectDuplicateKeys`, `rejectLongLoundNaN` (not `rejectSimple`: both
admit the unassigned simple values, D284); and
`rejectLongFloats` to confirm float widths) on the vectors, the fixed and
seeded profile-option cases and every Bindle-gate input, and compares
`encode()` with cbor2's CDE encoder on seeded values (byte for byte; about a
quarter hold `Tagged` values of rule-free numbers, 64-bit ones included,
against cbor2's `Tag`). Every
acceptance difference falls in one documented class, otherwise the gate
fails:

| Class | snug | cbor2 |
| --- | --- | --- |
| `tag` | the content rules above (dates, epochs, URIs, tag-24 kind, typed-array lengths, 55799 only at the top); the gate fails if the refused tag has no rule | few content checks |
| `cbor2tags` | no rule for the tag (e.g. 33 base64url) | one of its tag decoders refuses the content; confirmed when cbor2 accepts with `ignoreGlobalTags` |
| `tag24` | a tag-24 payload must be one valid item | not looked inside |
| `floatwidth` | non-shortest floats refused | checked only with `rejectLongFloats` (confirmed there) |
| `intfloat` | integral floats (`f93c00`) accepted (RFC 8949 §4.2.1) | `rejectLongFloats` refuses them (a dCBOR rule) |
| `nan` | only `f97e00` | also accepts `f9fe00` (sign bit) |
| `snugtags` | bignum 9..128 bytes, normalised decimals, typed-array and ndarray rules | not checked |
| `limits` | the default limits | none |
| `cbor2tag1` | any epoch integer | tag-1 decoder needs a JS number |

`bb valid-test` holds the valid preset to cbor2's default decoding (with
`rejectDuplicateKeys`) on the RFC 8949 Appendix A, Appendix F and additional
vectors and seeded mutations; each difference falls in a class: cbor2's tag
decoders, snug's checks of known tags' contents (D121/D180/D265), limits,
and duplicates cbor2 compares as
decoded JavaScript keys. The same gate runs the RFC vectors under all three
presets, a canonical-equivalence property (a value's random valid
re-encodings decode, validate and refuse duplicates exactly as its
deterministic encoding) and the refusal replay at every budget.

## Compiler profiles are a separate axis

`compile(text, { profile })` currently accepts these restriction sets:

| Compiler profile | Accepted CDDL |
| --- | --- |
| `full` (default) | All currently supported constructs, subject to exactness and resource bounds |
| `bindle` | No sockets, `.cborseq`, unwrap, explicit cuts, recursive generics, or non-text/integer map key domains |
| `bus` | Bindle set minus regexps and recursive types; strings, containers and embedded byte strings must be bounded; no unconstrained any/bare majors; schema text capped at 16 KiB; **no extension controls** unless the compile option `controlsInBus: true` (Rust `Controls::in_bus`) admits them (D141) |

These profiles only refuse schemas; they never relax wire checks or change
the meaning of an accepted construct. `bus` is the profile for schemas from a
less trusted party: a registered extension control runs host code on every
item it judges, so such a schema may use one only when the host opts in
(`controlsInBus`; the flag is part of the source key). In particular `full` is not a lenient
CBOR mode. Colon-implied cuts remain ordinary struct syntax in `bindle`.

## Version policy

The package remains private at 0.0.0. Pin a repository revision and
regenerate the staged package when updating it. **P8.4 changed the default
wire policy to `valid`** (D260): input the deterministic preset refused for an
encoding reason only (indefinite lengths, non-shortest forms, key order, NaN
payloads) is now accepted; pass `wire: 'deterministic'` (Rust
`Profile::DETERMINISTIC`, `DecodeOptions::deterministic()`) where a protocol
requires deterministic input. Encoded bytes are unchanged. **D180 widened the default
tag level** from the standard set to any tag (pass `tags: 'standard'` for the
previous preset). **P7.1 changed the default
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
