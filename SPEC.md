# snug — SPECIFICATION

A CDDL (RFC 8610) validator and a strict deterministic CBOR (RFC 8949 §4.2)
codec, written once in kin and generated into JavaScript and Rust. Sound map
and choice matching, one pass over the bytes, bounded time and memory, errors
that never echo the payload.

Status: **specification, revision 1 (2026-10-29)**. Nothing is implemented.
`DEVLOG.md` is the live tracker; this file is what the tracker derives from
and changes only when a decision changes. Decisions are `D###` in `DEVLOG.md`
and are provisional until signed off. The design is in
`docs/architecture.md`.

The name: CDDL is pronounced "cuddle", and a value that fits its schema is
snug (D001).

---

## 1. What snug is

A **library** with four operations:

| Operation | Input | Output |
| --- | --- | --- |
| `compile(cddl, {profile, limits})` | CDDL text | a compiled schema, or a schema error with line and column |
| `schema.validate(bytes, rule, {limits})` | CBOR bytes | `ok`, or `{reason, path}` |
| `schema.decode(bytes, rule, opts)` / `decode(bytes, opts)` | CBOR bytes | host values, or the same error |
| `encode(value, opts)` | host values | deterministic CBOR bytes |

Validation works on CBOR bytes. Host values are validated by encoding them
first (which 3sln.me does anyway for anything it sends).

### 1.1 What snug is not

* Not a JSON validator. CDDL over JSON is out of scope (revision 1).
* Not a lenient decoder. There is no mode that accepts non-deterministic or
  out-of-profile CBOR (§3).
* Not a code generator for CDDL types.
* Not a complete RFC 8610 implementation: `.pcre`, `.abnf`, `.abnfb`,
  `.feature` and non-I-Regexp regexps are refused (D013, D014), and maps the
  determinism rule cannot decide are refused (D011). Every refusal is a schema
  error at compile time, never a different meaning.

## 2. Semantics

CDDL as RFC 8610 with RFC 9165 controls and RFC 9682 grammar updates, with
these precise choices (each with a decision):

1. Matching is exact: type choices, group choices and array occurrences are
   evaluated as sets, without backtracking or greedy shortcuts (D010).
2. Maps are closed. Map matching follows RFC 8610's existential semantics,
   computed by a greedy priority assignment that the compiler proves
   equivalent or refuses (D011).
3. `.regexp` is RFC 9485 I-Regexp, anchored at both ends; `\p{…}` is refused
   in revision 1 (D014).
4. `float16`/`float32`/`float64` mean the encoded width; under the profile's
   shortest-form rule this is narrower than it looks (architecture §4.8).
5. `uint` is major type 0 only; `integer` and `unsigned` include bignums.
6. `.size` on text counts UTF-8 bytes.
7. A **profile** (`full`, `bindle`, `bus`) restricts the accepted CDDL; it
   never changes the meaning of what it accepts (architecture §5.3).

## 3. The CBOR profile

snug implements the Bindle CBOR profile (3sln.me `docs/spec/cbor.md`) exactly:
RFC 8949 core deterministic encoding verified on decode; text map keys (a
`cose` option allows integer labels in the top-level map); definite lengths;
`false`, `true`, `null` and shortest floats only, with scalar NaN, ±∞, −0 and
integral floats within ±(2^53−1) refused; tags 2 and 3 (bignums beyond 64
bits, 9..128 bytes, no leading zero), 4 (normalised decimal fractions), 40
(row-major multi-dimensional arrays) and the RFC 8746 little-endian typed
arrays 69–72, 77–79, 84–86; nothing else. The resource bounds of profile §5
are defaults (§5). Refusal codes are cbor.mjs's.

## 4. Errors

A validation error is a reason code and a path (architecture §6). It never
contains a payload value, input bytes, or a data map key the schema does not
name. The reported failure is a deterministic function of the bytes and the
compiled schema, identical on every host.

## 5. Limits

Every resource is bounded by an explicit limit with a default and a hard
maximum (architecture §7): schema size and structure at compile time; input
size, depth, entries, items and a step budget at validation time. Exceeding a
limit is an ordinary error with its own reason. No input and no schema can
cause a panic, a trap, unbounded allocation or super-linear time.

## 6. Targets and kin

* **kin** owns everything that decides accept or refuse: the CDDL compiler and
  the validator VM, including every CBOR profile check (D003).
* **Hosts** own the value model: the JS value builder, the JS encoder, and
  the public API (D004).
* **Targets**: JavaScript (a kin target defined in this tree, D005) and Rust
  (kin's), with WebAssembly built from Rust. Go, Java and C# are not targets in
  revision 1 (D006).
* kin's rule applies: generated code may not be worse than the hand-written
  code it replaces, judged by measurement (architecture §10, §12).

## 7. Determinism

For the same schema text, options and input bytes, every host produces the
same compiled Program bytes, the same verdict, the same reason, the same path
and the same budget exhaustion point. This is a gate (`bb identity`).

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
