// P3.2/P3.3 compile timings and sizes (architecture §12 items 5 and 6).
//
//     node bench/compile-bench.mjs [cold runs] [warm samples]
//
// * COLD: a fresh `node` process per run imports host/js/src/compile.mjs and
//   compiles one contract once; the import and the first compile are timed
//   separately inside the child (performance.now), median of the runs.
// * WARM: in this process, every contract is compiled 300 times first; then
//   per contract, samples of a loop calibrated to ~20 ms; the median per-
//   compile time of the samples is reported (min in brackets).
// * HOSTILE: schemas built to spend the compile budget or hit a limit; one
//   warm compile each, wall time, budget units spent and the outcome.
// * SIZE: esbuild bundles (from 3sln.me's node_modules, read-only) of the
//   compiler entry point and of the verifier: raw, minified, gzip -9,
//   brotli 11.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import os from 'node:os';
import { compile, lastBudgetUsed, SchemaError } from '../host/js/src/compile.mjs';

const COLD = Number(process.argv[2] ?? 15), SAMPLES = Number(process.argv[3] ?? 21);
const root = new URL('../', import.meta.url);
const contracts = readdirSync(new URL('corpus/cddl-study/contracts/', root)).sort()
  .map(f => [f, readFileSync(new URL('corpus/cddl-study/contracts/' + f, root), 'utf8')]);
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const fmt = ms => ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`;

console.log('## environment');
console.log(`- ${os.cpus()[0].model} (${os.cpus().length} cores), ${os.platform()} ${os.release()}, node ${process.version}, V8 ${process.versions.v8}; load ${os.loadavg().map(x => x.toFixed(2)).join(' ')}`);

// ---------------------------------------------------------------- cold
console.log('\n## cold (fresh process: import, then the first compile)');
console.log('| contract | bytes | import | first compile |');
console.log('| --- | ---: | ---: | ---: |');
mkdirSync(new URL('.cache/', root), { recursive: true });
const child = new URL('.cache/compile-cold-child.mjs', root);
writeFileSync(child, `const t0 = performance.now();
const { compile } = await import(${JSON.stringify(new URL('host/js/src/compile.mjs', root).href)});
const t1 = performance.now();
compile(process.argv[2]);
const t2 = performance.now();
console.log(JSON.stringify([t1 - t0, t2 - t1]));
`);
for (const [name, text] of contracts) {
  const imp = [], first = [];
  for (let i = 0; i < COLD; i++) {
    const r = spawnSync(process.execPath, [child.pathname, text]);
    const [a, b] = JSON.parse(r.stdout.toString());
    imp.push(a); first.push(b);
  }
  console.log(`| ${name} | ${Buffer.byteLength(text)} | ${fmt(median(imp))} | ${fmt(median(first))} |`);
}

// ---------------------------------------------------------------- warm
console.log('\n## warm (same process, after 300 compiles of each)');
console.log('| contract | words | pool | median per compile (min) | budget units |');
console.log('| --- | ---: | ---: | ---: | ---: |');
for (let w = 0; w < 300; w++) for (const [, text] of contracts) compile(text);
for (const [name, text] of contracts) {
  const { program, pool } = compile(text);
  const units = lastBudgetUsed();
  let n = 1;
  for (;;) { const t0 = performance.now(); for (let i = 0; i < n; i++) compile(text); if (performance.now() - t0 > 20 || n > 1 << 16) break; n *= 2; }
  const per = [];
  for (let s = 0; s < SAMPLES; s++) { const t0 = performance.now(); for (let i = 0; i < n; i++) compile(text); per.push((performance.now() - t0) / n); }
  console.log(`| ${name} | ${program.length} | ${pool.length} | ${fmt(median(per))} (${fmt(Math.min(...per))}) | ${units} |`);
}

// ---------------------------------------------------------------- hostile
console.log('\n## hostile schemas (one warm compile each)');
console.log('| schema | outcome | wall | budget units |');
console.log('| --- | --- | ---: | ---: |');
const big = n => Array.from({ length: n }, (_, i) => `k${i}: int`).join(', ');
const hostile = [
  ['instantiation bomb `g<T> = [g<[T, T]>]`', 'g<T> = [g<[T, T]>]\nr = g<int>'],
  ['30 independent optional choices in one map', 'r = { ' + Array.from({ length: 30 }, (_, i) => `? (a${i}: int // b${i}: int)`).join(', ') + ' }'],
  ['a 4 000-member map', `r = { ${big(4000)} }`],
  ['a 10 000-rule alias chain', Array.from({ length: 10000 }, (_, i) => `a${i} = a${i + 1}`).join('\n') + '\na10000 = int\nr = a0'],
  ['nesting 64 deep', 'r = ' + '['.repeat(64) + 'int' + ']'.repeat(64)],
  ['[0*1048576 uint] (one counter)', 'r = [0*1048576 uint]'],
  ['[? uint, 200*250 uint] (unrolled: 251 positions)', 'r = [? uint, 200*250 uint]'],
  ['[? uint, 300*300 uint] (would unroll past 256)', 'r = [? uint, 300*300 uint]'],
  ['a 256-position regexp', 'r = tstr .regexp "[a-z0-9]{256}"'],
  ['20 000 text literals in one choice', 'r = ' + Array.from({ length: 20000 }, (_, i) => `"v${i}"`).join(' / ')],
  ['20 000 integer literals in one choice', 'r = ' + Array.from({ length: 20000 }, (_, i) => String(i * 3)).join(' / ')],
  ['a 255 KiB schema of 2 000 maps', Array.from({ length: 2000 }, (_, i) => `m${i} = { a${i}: tstr .size (1..10), ? b: [* uint], c: m${(i + 1) % 2000} / null }`).join('\n').slice(0, 255 * 1024)],
];
for (const [label, text] of hostile) {
  const t0 = performance.now();
  let outcome;
  try { const c = compile(text); outcome = `ok (${c.program.length} words)`; } catch (e) { outcome = e instanceof SchemaError ? e.code : 'THREW ' + e; }
  console.log(`| ${label} | ${outcome} | ${fmt(performance.now() - t0)} | ${lastBudgetUsed()} |`);
}

// ---------------------------------------------------------------- size
console.log('\n## size (esbuild bundle, ES module)');
const esbuild = process.env.SNUG_ESBUILD ?? `${os.homedir()}/Projects/@3sln/3sln.me/node_modules/.bin/esbuild`;
const sizes = buf => ({ raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length, brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length });
if (existsSync(esbuild)) {
  const bundle = (entry, minify) => execFileSync(esbuild, [entry, '--bundle', '--format=esm', '--log-level=error', ...(minify ? ['--minify'] : [])], { cwd: root.pathname });
  console.log('| artefact | raw | gzip -9 | brotli 11 |');
  console.log('| --- | ---: | ---: | ---: |');
  for (const [label, entry, min] of [
    ['compiler (host/js/src/compile.mjs + gen/js/snug/compile/*), bundled', 'host/js/src/compile.mjs', false],
    ['compiler, bundled + minified', 'host/js/src/compile.mjs', true],
    ['verifier (gen/js/snug/program/verify.mjs), bundled + minified', 'gen/js/snug/program/verify.mjs', true],
  ]) { const s = sizes(bundle(entry, min)); console.log(`| ${label} | ${s.raw} | ${s.gzip} | ${s.brotli} |`); }
} else console.log(`(no esbuild at ${esbuild}: sizes skipped)`);
