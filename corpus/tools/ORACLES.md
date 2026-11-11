# External reference oracles

Two third-party CDDL implementations serve as differential references. They
are not committed (binaries and gem trees); they live under the gitignored
`.cache/oracles/` and can be rebuilt with the commands below. Do not keep
them under `/tmp` or a session scratchpad: an OS temp cleanup removed the
previous copies on 2026-11-09.

| Oracle | Default path | Override | Used by |
| --- | --- | --- | --- |
| native `cddl` crate 0.10.7 CLI | `.cache/oracles/cddl-rs/bin/cddl` | `--oracle=` or `CDDL_NATIVE` | `bb crate-diff` (`corpus/tools/crate-diff.mjs`), reductions in `corpus/conformance/crate-diff-findings.md` |
| Ruby `cddl` gem 0.12.14 | `.cache/oracles/ruby-cddl.sh` | `RUBY_CDDL` (also `RFC_RUBY`, `PEG_RUBY` per script) | `corpus/tools/export-rfc.mjs`, `corpus/tools/peg-oracle.test.mjs`, review cross-checks |
| gem tree (for `diag2cbor.rb`) | `.cache/oracles/ruby-gems` | `RUBY_CDDL_GEM_HOME` (or `RFC_GEM_HOME`) | `corpus/tools/export-rfc.mjs` |

The `wasm` build of the crate used by `bench/vm-bench.mjs` (`CDDL_CRATE_PKG`)
is a separate artefact from the 3sln.me study and is not covered here.

## Native crate CLI (rebuilt 2026-11-11)

From the repository root (network needed only to fetch crates):

```sh
cargo install cddl --version 0.10.7 --root .cache/oracles/cddl-rs --locked \
  --no-default-features \
  --features std,json,cbor,csv-validate,additional-controls,ast-span,ast-comments
```

- Crate archive `cddl-0.10.7.crate` sha256
  `c5251326096ece604213e731457558294e178c9560fe3885436a1e465250edbe`
  (matches `corpus/PROVENANCE.md`).
- Toolchain: rustc 1.92.0 (ded5c06cf 2025-12-08, Homebrew), cargo 1.92.0,
  aarch64-apple-darwin, release profile, the crate's own `Cargo.lock`.
- Resulting binary sha256 (this machine):
  `1fdf32e31b8326aaf85f9cfd3814aa1a13b9f4912e006e76ffe9a8be8a052428`.
  The P4.1 binary (`b96abfc4…`, toolchain unrecorded) differs byte-wise; on
  the full 6,987-case `bb crate-diff` corpus every native outcome (verdict,
  schema error, panic) is identical between the two.
- The default feature set adds `ast-parent`, `wasm-bindgen` and `freezer`
  (fancy-regex); the list above is the one used for the P4.1-era offline
  rebuild and is kept so results stay comparable.
- CLI behaviour: `cddl validate --cddl S --cbor D` exits **0 even when
  validation fails** unless the global `--ci` flag is given
  (`cddl --ci validate ...` exits 1 on failure). It validates against the
  first rule only and colours its log lines (ANSI SGR) even into a pipe.
  `crate-diff.mjs` therefore moves the requested rule first, strips SGR codes
  and reads the explicit `Validation of ... is successful` / `failed` lines
  rather than the exit status.

Smoke check:

```sh
printf 'r = {a: uint}\n' > .cache/oracles/s.cddl
printf '\xa1\x61\x61\x20' > .cache/oracles/bad.cbor
.cache/oracles/cddl-rs/bin/cddl --ci validate --cddl .cache/oracles/s.cddl --cbor .cache/oracles/bad.cbor; echo $?   # 1
```

## Ruby gem (rebuilt 2026-11-11)

System Ruby 2.6.10 (`/usr/bin/ruby`), RubyGems 3.0.3.1. `json_pure` is
pinned first because newer releases need a newer Ruby:

```sh
export GEM_HOME="$PWD/.cache/oracles/ruby-gems" GEM_PATH="$PWD/.cache/oracles/ruby-gems"
gem install --no-document json_pure -v 2.6.3
gem install --no-document cddl -v 0.12.14
```

Resolved dependencies on 2026-11-11: cbor-diag 0.11.8, abnc 0.1.1,
abnftt 0.2.11, base32 0.3.4, base45_lite 1.0.1, cbor-canonical 0.1.2,
cbor-deterministic 0.1.3, cbor-packed 0.2.2, colorize 1.1.0,
neatjson 0.10.5, polyglot 0.3.5, regexp-examples 1.5.1, treetop 1.6.18.
To reproduce exactly, pin these with `-v` before installing `cddl`.

The wrapper `.cache/oracles/ruby-cddl.sh` (recreate it if missing):

```sh
#!/bin/sh
# Ruby cddl gem 0.12.14 wrapper (system Ruby 2.6). Usage: ruby-cddl.sh SCHEMA validate DATA
here=$(cd "$(dirname "$0")" && pwd)
GEM_HOME="${SNUG_RUBY_GEM_HOME:-$here/ruby-gems}"
GEM_PATH="$GEM_HOME"
export GEM_HOME GEM_PATH
exec /usr/bin/ruby "$GEM_HOME/bin/cddl" "$@"
```

`ruby-cddl.sh SCHEMA validate DATA` exits 0 for valid, 1 for invalid; other
statuses (65 for schema errors) and exceptions are not verdicts.

Check: `RUBY_CDDL=$PWD/.cache/oracles/ruby-cddl.sh node --test
--test-name-pattern="Ruby differential" corpus/tools/peg-oracle.test.mjs`
passes (2026-11-11: 300 pairs, agreement 116, RC 14, RL 42, RK 30, RI 15,
RZ 30, RR 27, RO 11, RX 15, new/unknown/timeout 0).
