#!/bin/sh
T=$(rustup run nightly-2026-10-01 rustc --print sysroot)
DYLD_LIBRARY_PATH=$T/lib exec $T/lib/rustlib/aarch64-apple-darwin/bin/rust-lld "$@"
