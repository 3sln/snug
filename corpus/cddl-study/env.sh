# the study's nightly (rustup) and its rust-lld wrapper; sourced by build.sh, which sets S
T=$(rustup run nightly-2026-10-01 rustc --print sysroot)
export PATH=$T/bin:$PATH
export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER=$S/lld.sh
