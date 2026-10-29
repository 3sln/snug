// P1.4 code size: what a JS consumer ships for the scanner.
//
//     node bench/scan-size.mjs <wasm speed build> [wasm size build]
//
// JS: gen/js/snug/cbor/scan.mjs bundled with its imports into one ES module
// by esbuild (--bundle --format=esm), raw and --minify. The hand-written
// yardstick the same way. wasm: the modules kin/scripts/wasm-build makes
// (std built from source, panic=immediate-abort, LTO, stripped; opt-level 3 and
// "z"); no wasm-opt is available offline. The ~10 lines of JS glue a wasm
// consumer also needs are not counted.
// Compressed with node's zlib: gzip level 9, brotli quality 11.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const [wasmPath, wasmSizePath] = process.argv.slice(2);
const esbuild = process.env.SNUG_ESBUILD ?? `${process.env.HOME}/Projects/@3sln/3sln.me/node_modules/.bin/esbuild`;
const sizes = buf => ({
  raw: buf.length,
  gzip: gzipSync(buf, { level: 9 }).length,
  brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
});
const bundle = (entry, minify) => execFileSync(esbuild, [entry, '--bundle', '--format=esm', '--log-level=error', ...(minify ? ['--minify'] : [])]);
const rows = [];
if (existsSync(esbuild)) {
  rows.push(['generated JS scanner, bundled', sizes(bundle('gen/js/snug/cbor/scan.mjs', false))]);
  rows.push(['generated JS scanner, bundled + minified', sizes(bundle('gen/js/snug/cbor/scan.mjs', true))]);
  // The same API surface the wasm module exports (scan, options, error
  // offset; no code-name table), so the two compare like for like.
  mkdirSync('.cache', { recursive: true });
  writeFileSync('.cache/scan-entry.mjs', "export { scan, scanOptions, errorOffset } from '../gen/js/snug/cbor/scan.mjs';\n");
  rows.push(['generated JS scanner, bundled + minified, the wasm\'s API surface', sizes(bundle('.cache/scan-entry.mjs', true))]);
  rows.push(['hand-written JS scanner, minified', sizes(bundle('bench/scan-hand.mjs', true))]);
  rows.push(['cbor.mjs (whole codec, minified; context)', sizes(bundle('bench/baseline/cbor-3sln.mjs', true))]);
} else console.log(`(no esbuild at ${esbuild}: bundle sizes skipped)`);
if (wasmPath) rows.push(['wasm module, opt-level 3 (the one timed)', sizes(readFileSync(wasmPath))]);
if (wasmSizePath) rows.push(['wasm module, opt-level "z"', sizes(readFileSync(wasmSizePath))]);
console.log('| artefact | raw | gzip -9 | brotli 11 |');
console.log('| --- | ---: | ---: | ---: |');
for (const [name, s] of rows) console.log(`| ${name} | ${s.raw} | ${s.gzip} | ${s.brotli} |`);
console.log(`(esbuild ${existsSync(esbuild) ? execFileSync(esbuild, ['--version']).toString().trim() : 'n/a'}; node zlib)`);
