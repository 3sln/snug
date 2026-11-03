> **Historical input (2026-11-03).** Bindle and 3sln.me are paused (owner
> direction, D080). snug continues as a standalone library; the Bindle CBOR
> profile remains an optional named profile (`bindle`) and its vectors and
> contracts remain test inputs. The requirements below are kept as one
> consumer's checklist; most of them (public API, wire compatibility for the
> profile, hostile-input bounds, runtime evidence, reproducibility, a worked
> example) are also simply what a good library owes any user, and are tracked
> as Phase 7 items in DEVLOG.

# Bindle adoption requirements for Snug

Handoff from the Bindle coordinator, 2026-11-02. These are consumer requirements and proposed adoption gates, not a claim that Snug is finished or an instruction to rewrite its architecture. Owner will drive completion in the existing Snug session. No Snug implementation changes were made during this audit.

## Direction and scope

Bindle is being redesigned around an open, self-hostable, interoperable specification and reference provider. 3sln.me will be one branded hosted instance. Prefer a clean implementation against the revised contracts, selectively reusing independently verified components. Snug is a strong reuse candidate; adopting it is still provisional.

Keep Snug an independent MIT library. Bindle should consume a reproducible pinned release/revision through a small adapter rather than copy its implementation or depend on private generated internals. Changes here must follow AGENTS.md, including kin-owned accept/refuse semantics and generated-source provenance.

## Observed state

The repository contains substantial implementation: generated JS/Rust scanner and validator machinery, CDDL compiler, JS codec/value wrappers, schema API, lazy views/writer and source abstractions. `host/js/src/index.mjs` currently exports codec operations/value wrappers, while schema functionality is in `src/schema.mjs`; the package is private. The initial “nothing is implemented” SPEC status and milestone checkboxes do not describe all of the later work.

Fresh check: `node --test test/` from `host/js` passed **684 tests, zero failures/skips**, on Node v24.6.0, 2026-11-02. This verifies that host suite only. Compiler regeneration, Rust/Wasm parity, fuzz, benchmarks, real browsers and Workers were not freshly verified by this audit. There are existing uncommitted compiler/VM changes and a resumable-validation work in progress; preserve them and identify the exact revision/worktree used for any final evidence.

## Required before adoption

1. **Supported public JS API.** Document and export compile, schema validation/decode, strict encode/decode, value wrappers, limits and safe faults through stable package entry points. Define asynchronous compilation, initialization, ownership/lifetime of byte buffers and views, scratch reentrancy, and serialized-program verification. Consumers must not need deep imports into generated internals. Compilation can be a separate lazy entry point.
2. **Exact wire compatibility.** Run the Bindle CBOR corpus and differential fixtures against `3sln.me/packages/core/cbor.mjs` and `docs/spec/cbor.md`. Cover deterministic bytes, refusal precedence, duplicate/map ordering rules, exact integers, decimal and binary values, tags, invalid UTF-8, malformed/trailing input and limits. Document intentional differences before changing a protocol contract. Preserve hash/signature/fingerprint bytes; host object equality alone is insufficient.
3. **Bounded hostile-input handling.** Demonstrate enforced limits on bytes, nesting, items, schema size, compile work, VM steps, scratch and decoded allocations. Invalid/untrusted compiled programs must be rejected safely. Cover adversarial schema choices and inputs; no hidden unbounded backtracking. Faults must not disclose payloads or arbitrary input keys. Include cache quotas and safe immutable-program sharing guidance for a multi-tenant provider.
4. **Runtime evidence.** Test the supported JS package in Node, a real browser and a Cloudflare Worker isolate. Verify bundling/CSP compatibility, absence of required Node APIs or runtime dynamic code generation, and explicit initialization requirements. If Wasm is optional, JS must remain usable without it. Report bundle size, cold start and memory/CPU with methodology; the recorded roughly 33 KB gzip versus 20 KB target and choice-heavy cost need a measured disposition rather than an unsupported performance promise.
5. **Reproducibility and confidence.** Run the repository's appropriate drift/regeneration, compiler/VM, cross-host parity, differential, fuzz and malformed-program gates. Record exact commands, revision, generated outputs and limitations. Reconcile stale status summaries with actual completion. Retain MIT/provenance notices. A supported package/version policy and migration notes are needed before routine consumption; publishing itself is not requested here.
6. **Consumer migration fixture.** Supply a small executable example: compile a bounded schema once, validate hostile CBOR without constructing values, decode valid data, encode it deterministically, and validate a nested span/view. Bindle will separately test an adapter for its decimal/value types, RPC envelopes, fingerprints and event contracts. Snug validation does not replace application authorization or the explicit projection/redaction of response fields.

## Streaming: staged requirement, not a reason to delay every use

Bounded contiguous-buffer validation/codec operation can qualify for initial adoption independently. Define that supported subset clearly. Before Bindle relies on large-object streaming, finish and test resumable **schema validation**, including partial headers/UTF-8/choices, chunk boundaries, cancellation, truncated input, backpressure and bounded retained memory. Incremental scanning alone is not completed streaming CDDL validation.

Real Blob/File, HTTP Range, FileHandle and ReadableStream adapters, fused decoding and broad large-object streaming support can follow when their consumer exists. Range sources need a stable version/ETag or equivalent snapshot contract so bytes cannot change between validation and use. Do not silently buffer an unbounded source or imply zero-copy ownership guarantees that the API cannot enforce.

## Ownership boundary

Snug owns strict CBOR/CDDL correctness and its documented resource limits. Bindle owns wire-profile selection, protocol schema/version policy, authorization through preference fragments, response projection, transport framing, tenant budgets and adapter compatibility. A new rewrite must not make all old JSON Schema contracts or old runtime assumptions mandatory Snug features. Rust/Wasm and size targets remain Snug project goals; an adoption decision must state which backends and capabilities were actually tested.

## Decision record for the existing session

Resolve each required item with evidence or a named limitation. Produce an adoption recommendation naming: supported API/profile/runtime set; exact revision; tests and measurements; remaining exclusions; and whether buffer-only adoption is safe ahead of streaming. Bindle integration remains a separate change with its own compatibility tests.

Reviewer: __________  Date: __________  Outcome: __________
