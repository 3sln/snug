// The wasm modules' size gate (D341): the SDK runtime and compiler modules that
// kin/scripts/wasm-build sdk | cc produce (the files the wasm SDK loads), bytes and
// gzip -9 each against tools/size/budget.json's "wasm" caps (measured + 2%).
//
//     bb wasm-size [--no-gate]
//
// Without the pinned nightly or wasm-opt the build answers exit 3: this prints a
// SKIP line (NOT RUN; the gate runner fails a set on it) and exits 0.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { selfWatch } from '../../kin/scripts/watchdog.mjs';
selfWatch('wasm-size', import.meta.url);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const budget = JSON.parse(readFileSync(resolve(root, 'tools/size/budget.json'), 'utf8')).wasm;
const rows = [];
for (const [name, mode] of [['sdk-runtime', 'sdk'], ['compiler', 'cc']]) {
  const r = spawnSync('kin/scripts/wasm-build', [mode], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status === 3) { console.log(`SKIP bb wasm-size -- kin/scripts/wasm-build ${mode} answered SKIP (toolchain or wasm-opt missing); NOT RUN`); process.exit(0); }
  if (r.status !== 0) { console.error(`FAIL kin/scripts/wasm-build ${mode} exited ${r.status}`); process.exit(1); }
  const bytes = readFileSync(resolve(root, r.stdout.trim().split('\n').pop()));
  rows.push({ name, bytes: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length });
}
console.log('| module | bytes | gzip | brotli |\n| --- | ---: | ---: | ---: |');
for (const r of rows) console.log(`| ${r.name} | ${r.bytes} | ${r.gzip} | ${r.brotli} |`);
if (!process.argv.includes('--no-gate')) {
  let failures = 0;
  for (const r of rows) for (const metric of ['bytes', 'gzip']) {
    const cap = budget?.[r.name]?.[metric];
    if (!Number.isSafeInteger(cap) || r[metric] > cap) { console.error(`FAIL wasm ${r.name} ${metric}: ${r[metric]} > ${cap ?? 'missing budget'}`); failures++; }
  }
  if (failures) process.exitCode = 1;
  else console.log('wasm size budgets passed (D341).');
}
