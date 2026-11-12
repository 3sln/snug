#!/bin/sh
# D286 (bench/D286-analysis.md): A/B rotation for bench/d286/variants.mjs. For each round, runs
# one process per label=tree:arm, in order, so trees and arms are interleaved on a shared machine;
# prints variants.mjs's JSON lines tagged with the label and the round (take the median per label).
#
#     sh bench/d286/ab.sh <rounds> <trials> <label=tree:arm>...
#     e.g. sh bench/d286/ab.sh 5 9 main=.:vm old=../snug-old:vm
#
# Each tree is a checkout (`git worktree add <dir> <commit>` for an older one); this checkout's
# variants.mjs drives every tree.
here=$(cd "$(dirname "$0")" && pwd)
R=$1; T=$2; shift 2
for r in $(seq 1 "$R"); do
  for spec in "$@"; do
    label=${spec%%=*}; rest=${spec#*=}; tree=${rest%%:*}; arm=${rest#*:}
    node --single-threaded-gc "$here/variants.mjs" "$tree" "$arm" "$T" 2>&1 | sed "s/^{/{\"label\":\"$label\",\"round\":$r,/"
  done
done
