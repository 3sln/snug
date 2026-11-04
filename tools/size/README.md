# Public entry size gate (P7.6)

Run from the repository root, with the already available benchmark esbuild:

```sh
bb size
node tools/size/size.mjs --details --report=/private/tmp/snug-size.json
node tools/size/analyze.mjs --report=/private/tmp/snug-size-analysis.json
```

No installation, network, generated-source edits or bundle files on disk.
`size.mjs` reads `host/js/package.json` exports, freezes the host/generated
sources in memory for that run, and uses esbuild 0.28.2's `metafile: true`
(the API equivalent of `--metafile`). Reports hash the exact inputs supplied
to esbuild. `--root=/private/tmp/snapshot` measures another source snapshot;
the esbuild installation still comes from this checkout, read-only.

All public exports are retained, one entry per bundle, ESM, browser platform,
ES2022, ASCII charset, minified, tree shaking enabled, legal comments removed.
`runtime` retains codec + public schema; `all-runtime` additionally retains
view, Writer and sources. Unicode tables are compile-time data and measured
as their own entry, outside both runtime unions. Bytes use Node gzip level 9
and brotli quality 11. Compression includes the entire minified file, not
source maps. No sizes are rounded to KB in the reports.

Three views prevent confusion about lazy imports:

* `static`: dynamic imports external, otherwise one bundled file. This is the
  entry's static graph, including retained dynamic import expressions. It is
  comparable across entries without chunk factoring or filenames affecting it.
* `full`: all dynamic imports inlined into one file. This exposes the entire
  retained lazy closure, including the compiler when compiling. Tree shaking
  still removes unreachable functions. It is not actual split HTTP transfer.
* `split`: real esbuild splitting. `initial` traverses static chunk imports;
  `total` traverses all reachable imports, counting each chunk once. Each chunk
  is compressed separately. `emitted` counts every output, even orphan chunks.
  In esbuild 0.28.2, the unused internal `schema.compile` / `schema.fromProgram`
  functions leave orphan compiler/verifier outputs when splitting. Those
  chunks have no path from the public schema entry: do not count them as
  downloads or infer an eager compiler dependency from their presence.

Each entry includes its static/full/split metafiles: imports, outputs,
original input sizes and `bytesInOutput` attribution. `ranked` is the static
minified attribution, with zero-byte candidates visible. Each module also
has source bytes, a SHA-256 and **isolated** min/gzip/brotli sizes (imports
retained). Isolated compression and attribution are descriptive, not
additive gzip contributions. Source graph membership is distinct from code
retained after tree shaking. [report.md](report.md) renders the tables and
ranked lists; [before.json](before.json) and [after.json](after.json) retain
the full evidence. Baseline sources were captured before the host edits;
generated-module hashes match between those reports. Concurrent regeneration
after the pair was measured is recorded separately in [current.json](current.json);
it is the budget baseline, so those additions are not attributed to this host edit.

`budget.json` caps **min, gzip and brotli independently, for static and full**,
for all seven package exports and both runtime unions. Each cap is
`ceil(current.json measurement * 1.02)`. Missing budgets and overruns exit 1.
Default runs never rewrite budgets. `--budget=/private/tmp/budget.json`
allows testing rejection; `--no-gate` is for collecting a deliberate new
baseline, not a successful gate. Any budget update requires reviewing the
size change and explicitly recording new measurements and caps. Split chunk
sizes are evidence, not additional caps. R9's 20 KB target remains open;
these regression caps do not redefine it.

`analyze.mjs` ranks generated functions by isolated minified size and bundles
hypothetical ablations **in memory only**. It stubs modules/helpers and
specialises branches to estimate marginal size. The results are never
executed, are not correctness-tested implementations, and cannot be summed
to predict combined savings. `analysis.json` records the baseline snapshot's
functions, ablations and changed modules. In particular, stubbing the
verifier is a size ceiling for moving/refactoring it, never permission to
skip verification. The DEVLOG P7.6 plan records compatibility and API limits.

On this sandbox, Babashka 1.3.190 exits 0 after a passing gate but its shutdown
hook prints a process-enumeration `Operation not permitted` warning. Direct
Node invocation avoids that warning. The zero-gzip-budget rejection was
also exercised and exited 1.
