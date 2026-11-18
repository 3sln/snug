#!/bin/bash
# Run one gate's command the way kin/scripts/gates runs it, where Babashka and kin are not
# installed (the Linux job, D356/D368): under kin/scripts/watchdog.mjs with the gate map's caps,
# from DIR, failing on a non-zero exit or on a NOT RUN line on stdout or stderr (the patterns of
# kin/scripts/gates' not-run?).
#
#     ci/run-gate.sh GATE DIR CMD...     e.g. ci/run-gate.sh npm-test host/js npm test --gate-wall=1800 --gate-cpu=3600
set -uo pipefail
[ $# -ge 3 ] || { echo "usage: ci/run-gate.sh GATE DIR CMD..." >&2; exit 2; }
gate=$1 dir=$2; shift 2
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
