#!/bin/sh
set -e
S=$(cd "$(dirname "$0")" && pwd)
. $S/env.sh
cd $S/binding && cargo build --release --target wasm32-unknown-unknown 2>&1 | grep -E "^error|Finished" -A8
$S/tools/bin/wasm-bindgen --target web --out-dir $S/pkg $S/binding/target/wasm32-unknown-unknown/release/bindle_cddl_study.wasm
ls -l $S/pkg/*.wasm
# Study-only glue additions: discard a trapped instance and expose memory for measurements.
cat >> $S/pkg/bindle_cddl_study.js <<'JS'
export function __reset(module){wasm=undefined;wasmModule=undefined;wasmInstance=undefined;cachedDataViewMemory0=null;cachedUint8ArrayMemory0=null;return initSync({module});}
export function __memory(){return wasm.memory;}
JS
