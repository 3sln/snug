# snug — SPECIFICATION

A standalone, MIT-licensed CDDL (RFC 8610) validator and a strict deterministic
CBOR (RFC 8949 §4.2.1) library, written once in kin and generated into
JavaScript and Rust. Sound map and choice matching, one validation pass over
the bytes, bounded time and memory, errors
that never echo the payload.

Status: **experimental implementation, updated 2026-11-03**. The generated
compiler, verifier, scanner and buffer VM work, with JS codec, schema API,
checked views/cursor, Writer, source adapters (profile and schema) and serialised
Programs. Rust/wasm core and test hosts exist; public host coverage is less
complete. The deterministic and Bindle wire presets (P7.1) are implemented
in JS and Rust, as are extension controls (P7.2) and unknown-length streams in
drain mode (D085). Current package evidence in browsers/Workers and the bundle
size target remain work in progress. See the [feature matrix](README.md#features-and-status).
`DEVLOG.md` is the live tracker; this file is what the tracker derives from
and changes only when a decision changes. Decisions are `D###` in `DEVLOG.md`
and are provisional until signed off. The design is in
`docs/architecture.md`.

The name: CDDL is pronounced "cuddle", and a value that fits its schema is
snug (D001).

---

## 1. What snug is

A **standalone library** (D080) with four basic operations:

| Operation | Input | Output |
| --- | --- | --- |
| `compile(cddl, {profile, limits})` | CDDL text | a compiled schema (Promise in the JS package), or SchemaError with code, line and column |
| `schema.validate(bytes, rule, opts)` | CBOR bytes | `{ok: true}`, or `{ok: false, reason, path, offset, subcode?}` |
| `schema.decode(bytes, rule, opts)` / `decode(bytes, opts)` | CBOR bytes | host values, or SnugFault |
| `encode(value, opts)` | host values | deterministic CBOR bytes |

Validation works on CBOR bytes. Host values are validated by encoding them
first. Checked views and a cursor expose selected values without materialising
the entire message (D026, D050–D054); `validateAt` checks a detached span, not
ancestor constraints. Typed Writer calls produce deterministic bytes directly
(D070–D074). Handles, push sources and unknown-length streams validate the
profile or a schema through the resumable session VM (D027, D085, D095,
D160), with the buffer driver's verdicts.

JS package entry points, declarations, errors, ownership and examples are in
[README](README.md), [guide](docs/guide.md) and [API](docs/api.md).
`program.serialize()` and `fromSerialized(bytes)` provide runtime-only Program
loading through a versioned, hashed and structurally verified container
(D084, D100–D102); caches must have trusted origins. The package remains
`private: true`; no publication is implied.

### 1.1 What snug is not

* Not a JSON validator. CDDL over JSON is out of scope (revision 1).
* Not (yet) a general CBOR decoder: no current mode accepts valid
  non-deterministic CBOR (§3); D230/P8.4 will make that the default. It will
  never accept invalid CBOR (duplicate keys, malformed UTF-8 or items).
* Not a code generator for CDDL types.
* Not a complete RFC 8610 implementation: `.pcre`, `.abnf`, `.abnfb`,
  and unsupported regexp constructs are refused (D013, D242–D243), and maps the
  determinism rule cannot decide are refused (D011). Every refusal is a schema
  error at compile time, never a different meaning. `.feature` is a no-op
  annotation (D013 amended). The precise current subset and reasons for
  refusals are in [CDDL support](docs/cddl-support.md).

## 2. Semantics

CDDL as RFC 8610 with RFC 9165 controls and RFC 9682 grammar updates, with
these precise choices (each with a decision):

1. Matching is exact: type choices, group choices and array occurrences are
   evaluated as sets, without backtracking or greedy shortcuts (D010).
2. Maps are closed. Map matching follows RFC 8610's existential semantics,
   computed by a greedy priority assignment that the compiler proves
   equivalent or refuses (D011).
3. `.regexp` defaults to XSD Appendix F, with RFC 9485 I-Regexp as a compile
   option; both match the whole text. Unicode categories require explicit
   compile-time tables; block escapes are refused pending pinned block data
   (D242–D243).
4. `float16`/`float32`/`float64` mean the encoded width; under the profile's
   shortest-form rule this is narrower than it looks (architecture §4.8).
5. `uint` is major type 0 only; `integer` and `unsigned` include bignums.
6. `.size` on text counts UTF-8 bytes.
7. A **compiler profile** (`full`, `bindle`, `bus`) restricts the accepted CDDL; it
   never changes the meaning of what it accepts (architecture §5.3).

## 3. The CBOR profile

Every path verifies RFC 8949 §4.2.1 core deterministic encoding on decode
(definite lengths, shortest arguments and floats, bytewise encoded-key order,
no duplicates, one root) and produces only that. **The current default
therefore refuses valid but non-deterministic CBOR** — indefinite lengths,
non-shortest heads or floats, unsorted map keys, NaN payloads — even against
`any`; such input is valid RFC 8949 CBOR, and the refusal is a scope limit,
not a validity verdict. Owner direction D230 makes general valid-CBOR
acceptance the default, keeping deterministic checking as an option (Phase 8,
P8.4); it is not implemented yet. A wire profile narrows
acceptance further; every option only removes acceptance (D081, D120). Two
presets (P7.1):

* **`deterministic`** (default): any map key kind; **any tag number**
  except the invalid 65535, 2³²−1 and 2⁶⁴−1 (`tags: 'any'`, D180;
  `tags: 'standard'` keeps the former set of 2, 3, 4, 40, the RFC 8746
  little-endian typed arrays and 0, 1, 21–24, 32, 55799). Known tags have
  their content checked — 0 (RFC 3339/RFC 4287 date-time, leap seconds only
  at a UTC month end), 1 (integer or float), 24, 32 (RFC 3986
  URI-reference), 2/3/4/40 and the typed arrays — and every other tag is
  opaque (D252); RFC 8949 floats (canonical NaN `f97e00`, ±∞, −0, integral
  floats); `false`, `true`, `null`, `undefined`; any well-formed UTF-8
  text.
* **`bindle`**: text map keys (a `cose` option allows safe integer labels in
  the top-level map); the tags above without the standard additions;
  `false`, `true`, `null` and shortest floats only, with scalar NaN, ±∞, −0
  and integral floats within ±(2^53−1) refused; no noncharacters. It is the
  pre-P7.1 behaviour bit for bit, and the 3sln.me vectors' arbiter.

Both: bignums beyond 64 bits only (9..128 bytes, no leading zero),
normalised decimal fractions, unassigned simple values refused; resource
bounds are defaults (§5). Refusal codes retain the imported vector
vocabulary. Programs do not depend on the wire profile: it is a run-time
option of each call. Compiler profiles are a separate axis. See
[profiles](docs/profiles.md). The Bindle test input and its
[consumer checklist](docs/profiles/bindle.md) do not define snug's product
scope. Codec/view/source default to the preset's root (any for
deterministic, a map for bindle); schema methods default to any root; all
accept an explicit `top` option.

## 4. Errors

A validation error is a reason code and a path (architecture §6). It never
contains a payload value, input bytes, or a data map key the schema does not
name. The reported failure is a deterministic function of the bytes and the
compiled schema, with cross-host identity as a gate. Public codec, checked
view and schema-decode refusals use SnugFault; compilation uses SchemaError;
validation uses result objects. ProgramError and SourceError distinguish
container/source failures from CBOR or CDDL verdicts (D103). Codes and the
limits of this contract are documented in [API errors](docs/api.md#errors).

## 5. Limits

Every resource is bounded by an explicit limit with a default and a hard
maximum (architecture §7): schema size and structure at compile time; input
size, depth, entries, items and a step budget at validation time. Exceeding a
limit is an ordinary error with its own reason. Bounded work without panics,
traps or unbounded scratch is a core requirement, tested through the corpus,
fuzz and cross-host gates. The [guide](docs/guide.md#limits) states the current
defaults and ceilings. Work budgets are not wall-clock deadlines; schemas,
decoded values and caches require host-level quotas. The Writer checks an
explicit maxBytes only at finish, after growth (D071); it is not yet an
advance allocation cap. Profile-only scanners expose size/structure bounds,
while the schema VM also exposes its step budget.

## 6. Targets and kin

* **kin** owns everything that decides accept or refuse: the CDDL compiler and
  the validator VM, including every CBOR profile check (D003).
* **Hosts** own the value model, allocation, the object walk and the public
  API (D004, refined by D070–D074); kin owns the Writer's byte decisions.
* **Targets**: JavaScript (a kin target defined in this tree, D005) and Rust
  (kin's), with WebAssembly built from Rust. Go, Java and C# are not targets in
  revision 1 (D006).
* kin's rule applies: generated code may not be worse than the hand-written
  code it replaces, judged by measurement (architecture §10, §12).

## 7. Determinism

For the same schema text, options and input bytes, every host produces the
same compiled Program bytes, the same verdict, the same reason, the same path
and the same budget exhaustion point. This is a gate (`bb identity`). The
public serialisation uses explicit little-endian words and a host SHA-256
digest; format major must equal the loader's and minor be no newer (D084).
The producer snug version is provenance, not an equality gate (D100).

## 8. Testing

* **Conformance corpus** (`corpus/`): CDDL + CBOR + expected verdict and
  reason; run on every host.
* **CBOR vectors**: 3sln.me's `cbor-profile.json` and `cbor-cborg-oracle.json`.
* **Differential**: against the Rust `cddl` crate (native build), on the
  subset where the crate is known correct (study §3.1, §5).
* **Fuzz**: seeded generators of schemas, values and mutated bytes; hosts must
  agree, no crash, no budget overrun.
* **Benchmarks**: architecture §12, recorded with environment in
  `bench/README.md`.

## 9. Repository layout

```
SPEC.md DEVLOG.md README.md LICENSE THIRD_PARTY_NOTICES.md AGENTS.md
bb.edn deps.edn            kin wiring (kin from ../kin by path)
kin/*.kin                  the logic: compiler, VM, profile scanner, tests
kin/src/snug/              project.cljc targets.cljc lang.cljc js.cljc
kin/scripts/               gen emit drift check ... (gates)
gen/js/ gen/rust/          generated, committed
host/js/                   JS package: API, value builder, encoder
host/rust/                 Rust crate host; host/wasm/ wasm exports
corpus/                    conformance corpus, CBOR vectors, study material
bench/                     benchmarks and recorded results
docs/                      architecture.md, program.md, profiles
ci/gate-map.edn            which gates run
```

## 10. Open questions

See architecture §13 and DEVLOG "Open questions for the owner".
