# Security policy

## Reporting a vulnerability

Email **contact+security@3sln.com**. Please do not open a public issue for a
security problem.

Include what you can of:

- the snug version, or the commit, and the artefact (npm `@3sln/snug`, the
  Rust crate, or the wasm SDK);
- the schema, the input and the options or preset that trigger the problem,
  or a description of them if they are sensitive;
- what you expected and what happened.

We will acknowledge the report, agree a disclosure date with you, and publish
the details after a fixed release is available.

## What counts

snug validates and decodes untrusted CBOR against CDDL schemas, so these are
security problems:

- a panic, trap or unbounded loop on any input, or on any Program the
  verifier accepts;
- work or memory beyond the documented budget and limits;
- a received value, input bytes or an unnamed map key appearing in an error,
  path or message;
- invalid CBOR accepted under a preset that refuses it;
- a verifier that accepts a Program that then misbehaves;
- data from one session visible in another through pooled arrays.

## Supported versions

Before 1.0, only the latest `0.y` release line receives security fixes. A fix
ships as a patch release. It may change behaviour that is otherwise stable (for
example, refusing a Program the verifier used to accept) only as far as the fix
needs, and the changelog's **Security** section says so.

How a fix is released is in section 5.2 of the
[release policy](https://github.com/3sln/snug/blob/main/docs/release-policy.md).
