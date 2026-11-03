#!/bin/sh
# P7.8: build everything Rust/wasm under bench/compare/rust/target and run the native comparison.
#
#     bench/compare/run-rust.sh [rounds] [target ms]
#
#   target/snug-rs     snug's host crate, assembled by kin/scripts/rust-crate (modules cbor vm program compile)
#   target/snug-wasm   host/wasm assembled the same way, built as kin/scripts/wasm-build does (O3, LTO,
#                      build-std, panic=immediate-abort) -- into this directory instead of .cache/
#   target/wasm32-unknown-unknown/release/cddl_wasm.wasm   the cddl crate with a plain ABI (rust/cddl-wasm)
#   target/release/snug-compare                            the native harness (rust/native)
#   target/cases       inputs written by cddl-cases.mjs
#
#   target/head        git HEAD of gen/ host/ kin/scripts, the source of both crates
#
# wasm needs a nightly with rust-src (SNUG_WASM_TOOLCHAIN, default nightly-2026-09-16, as wasm-build).
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
t="$here/rust/target"
mkdir -p "$t"
# Build from the committed tree (git HEAD), not the working tree: other work items edit gen/ and host/ in place, and
# a half-emitted module must not break or silently change this measurement. The commit is printed.
rm -rf "$t/head"; mkdir -p "$t/head"
git -C "$root" archive HEAD gen host kin/scripts | tar -x -C "$t/head"
echo "snug commit: $(git -C "$root" rev-parse HEAD)"
cd "$t/head"
SNUG_RS_ONLY="cbor vm program compile" ./kin/scripts/rust-crate "$t/snug-rs"
rm -rf "$t/snug-rs/src/bin"   # host/rust's gate binaries are not needed as a dependency
SNUG_RS_ONLY="cbor vm" ./kin/scripts/rust-crate "$t/snug-wasm" host/wasm/src host/wasm/Cargo.toml
tc="${SNUG_WASM_TOOLCHAIN:-nightly-2026-09-16}"
cargo_n=$(rustup which --toolchain "$tc" cargo)
sysroot=$("$(rustup which --toolchain "$tc" rustc)" --print sysroot)
printf '#!/bin/sh\nDYLD_LIBRARY_PATH=%s/lib exec %s/lib/rustlib/aarch64-apple-darwin/bin/rust-lld "$@"\n' "$sysroot" "$sysroot" > "$t/lld.sh"
chmod +x "$t/lld.sh"
wasm() { PATH="$(dirname "$cargo_n"):$PATH" CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER="$t/lld.sh" \
  RUSTFLAGS="-Zunstable-options -Cpanic=immediate-abort" "$cargo_n" build --quiet --release --target wasm32-unknown-unknown -Zbuild-std=std,panic_abort "$@"; }
(cd "$t/snug-wasm" && wasm)
(cd "$here/rust" && wasm -p cddl-wasm)
(cd "$here/rust" && cargo build --quiet --release -p snug-compare)
node "$here/cddl-cases.mjs" "$t/cases"
rustc --version
"$t/release/snug-compare" "$t/cases" "${1:-9}" "${2:-25}"
