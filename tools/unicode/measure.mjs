// Offline size measurement; pass an existing esbuild executable, never install.
// node tools/unicode/measure.mjs path/to/esbuild
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import { tables, nodeVersion, unicodeVersion } from '../../host/js/src/unicode-tables.mjs';
const esbuild = process.argv[2];
if (!esbuild) throw new Error('pass an existing esbuild executable (offline; no install)');
const min = execFileSync(esbuild, ['host/js/src/unicode-tables.mjs', '--bundle', '--format=esm', '--minify', '--log-level=error']);
console.log(JSON.stringify({
  machine: os.cpus()[0].model, arch: os.arch(), os: os.version(), release: os.release(),
  node: process.version, unicode: process.versions.unicode, icu: process.versions.icu,
  esbuild: execFileSync(esbuild, ['--version'], { encoding: 'utf8' }).trim(),
  pinnedNode: nodeVersion, pinnedUnicode: unicodeVersion,
  jsSourceBytes: readFileSync(new URL('../../host/js/src/unicode-tables.mjs', import.meta.url)).length,
  jsMinBytes: min.length, jsMinGzip9Bytes: gzipSync(min, { level: 9 }).length,
  rustSourceBytes: readFileSync(new URL('../../host/rust/src/unicode_tables.rs', import.meta.url)).length,
  expandedInt32Bytes: tables.byteLength, ranges: tables.length / 3,
}, null, 2));
