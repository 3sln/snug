#!/bin/bash
# Run one gate's command the way kin/scripts/gates runs it, where Babashka and kin are not
# installed (the Linux job, D356/D368): under kin/scripts/watchdog.mjs with the gate map's caps,
# from DIR, failing on a non-zero exit or on a NOT RUN line on stdout or stderr (the patterns of
# kin/scripts/gates' not-run?).
#
#     ci/run-gate.sh GATE DIR CMD...     e.g. ci/run-gate.sh npm-test host/js npm test --gate-wall=1800 --gate-cpu=3600
#
# Like kin/scripts/gates (D370), the gate never sees a coverage knob (ci/gate-map.edn :knobs
# :clear; `bb gates --check` holds this list to it). The :floor knobs are set by ci.yml only on
# their floor's cells, which `bb gates --check` checks.
set -uo pipefail
[ $# -ge 3 ] || { echo "usage: ci/run-gate.sh GATE DIR CMD..." >&2; exit 2; }
gate=$1 dir=$2; shift 2
knobs="SEQ_SLOW SEQ_DRY SEQ_HOSTONLY SNUG_GEN SNUG_RS_ONLY SNUG_WASM_TOOLCHAIN SNUG_SCAN_WASM SNUG_VM_WASM SNUG_PARITY_MUTATIONS SNUG_PARITY_SEED SNUG_PARITY_SCHEMAS SNUG_PARITY_SEQ_MATCH SNUG_ASYNC_CASES SNUG_ASYNC_FULL SNUG_PROPTEST_SELFTEST SNUG_WASM_RELEASE SNUG_STAMPED_VERSION"
removed=
for k in $knobs; do if [ -n "${!k+x}" ]; then removed="$removed $k"; unset "$k"; fi; done
[ -z "$removed" ] || echo "  env  removed$removed (coverage knobs: ci/gate-map.edn :knobs)"
root=$(cd "$(dirname "$0")/.." && pwd)
out=$(mktemp); trap 'rm -f "$out"' EXIT
echo "==== gate $gate (node $(node --version), $(uname -sm))"
(cd "$root/$dir" && node "$root/kin/scripts/watchdog.mjs" "$gate" -- "$@") 2>&1 | tee "$out"
status=${PIPESTATUS[0]}
[ "$status" = 0 ] || { echo "::error::$gate exited $status"; exit 1; }
if skip=$(grep -E -m1 -e '^[[:space:]]*SKIP\b' -e '^[[:space:]]*ℹ (skipped|todo) [1-9]' -e '^# (skip|todo) [1-9]' "$out" \
          || grep -E -i -m1 '\b(unavailable|missing|not installed|not found)\b.*\bskipped\b' "$out"); then
  echo "::error::$gate NOT RUN: $skip"; exit 1
fi
echo "ok $gate"
