// Analysis only: hypothetical ablations are bundled in memory, never executed
// and never written into kin/ or gen/. Their sizes are estimates, not products.
import esbuild from '../../bench/compare/node_modules/esbuild/lib/main.js';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const root = fileURLToPath(new URL('../..', import.meta.url));
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const sourceRoot = resolve(arg('root') ?? root);
const z = code => { const b = Buffer.from(code); return { min: b.length, gzip: gzipSync(b, { level: 9 }).length,
  brotli: brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length }; };
async function files(dir) {
  const result = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, d.name);
    if (d.isDirectory()) result.push(...await files(p));
    else if (p.endsWith('.mjs')) result.push(p);
  }
  return result;
}
const functions = [];
for (const path of await files(resolve(sourceRoot, 'gen/js/snug'))) {
  const source = await readFile(path, 'utf8');
  // Generated JS uses unindented top-level closes, indented nested closes.
  for (const m of source.matchAll(/^export function (\w+)\([^]*?^\}/gm)) {
    const min = await esbuild.transform(m[0], { minify: true, target: 'es2022', legalComments: 'none' });
    functions.push({ path: relative(sourceRoot, path), name: m[1], source: Buffer.byteLength(m[0]),
      ...z(min.code) });
  }
}
functions.sort((a, b) => b.min - a.min);
console.log('| function (isolated, external references retained) | source | min | gzip | brotli |');
console.log('| --- | ---: | ---: | ---: | ---: |');
for (const f of functions.slice(0, 35))
  console.log(`| ${f.path}:${f.name} | ${f.source} | ${f.min} | ${f.gzip} | ${f.brotli} |`);

const ablations = [];
const inputs = { schema: `export * from './host/js/src/public-schema.mjs';`,
  runtime: `export * as codec from './host/js/src/index.mjs'; export * as schema from './host/js/src/public-schema.mjs';` };
for (const [entry, contents] of Object.entries(inputs)) {
  for (const mode of ['baseline', 'no-sessions', 'no-verifier', 'no-sessions-or-verifier',
    'schedule2-only', 'no-force-generic-flag', 'buffer-generic-only', 'buffer-generic-no-verifier',
    'no-rare-leaf-helpers', 'long-identifiers']) {
    const changes = [];
    const plugin = { name: 'hypothetical', setup(build) {
      build.onResolve({ filter: /.*/ }, args => args.kind === 'dynamic-import' ? { path: args.path, external: true } : undefined);
      build.onLoad({ filter: /gen\/js\/snug\/.*\.mjs$/ }, async ({ path }) => {
        const original = await readFile(path, 'utf8');
        let text = original;
        if (['no-sessions', 'no-sessions-or-verifier', 'buffer-generic-only', 'buffer-generic-no-verifier'].includes(mode) && path.endsWith('/vm/session.mjs'))
          text = [...text.matchAll(/^export function (\w+)\(/gm)].map(m => `export function ${m[1]}(){return 0}`).join('\n');
        if (['no-verifier', 'no-sessions-or-verifier', 'buffer-generic-no-verifier'].includes(mode) && path.endsWith('/program/verify.mjs'))
          text = 'export function vmVerify(){return 0}';
        if (mode === 'schedule2-only' && path.includes('/vm/')) {
          text = text.replace(/(?<!function )\bsched2\(s\)/g, 'true').replace(/(?<!function )\bifS2\(s\)/g, '1');
          // These formals pass schedule selection through the streak helpers.
          text = text.replace(/^(export function (?:arrayStreak|mapStreak|arrayStep|mapPairFast)\([^]*?^\})/gm,
            f => f.replace(/\bs2\b/g, '1').replace(/\bps2\b/g, '1')
              .replace(/^(export function \w+\()([^]*?)(\) \{)/, (_, a, ps, b) => a + ps.split(', ').map((p, i) => p === '1' ? `unusedSchedule${i}` : p).join(', ') + b));
        }
        if (mode === 'no-force-generic-flag' && path.includes('/vm/'))
          text = text.replace(/\(s\[VM_GENERIC\] & 1\)/g, '0').replace(/s\[VM_GENERIC\] & 1/g, '0');
        if (mode.startsWith('buffer-generic') && path.endsWith('/vm/eval.mjs')) {
          // Model emission without array/map fast paths; preserve schedule-2
          // shape detection and the generic branches. Not a correctness proof.
          text = text.replace(/^\s*(?:let )?(?:fleaf|sleaf|fmode|smode) = [^;]*;\n/gm, '\n')
            .split('\n').map(line => line.startsWith('export function ') ? line
              : line.replace(/\bfleaf\b|\bsleaf\b/g, '(-1)').replace(/\bfmode\b|\bsmode\b/g, '0')).join('\n')
            .replace(/\(s\[VM_GENERIC\] & 1\)/g, '1');
        }
        if (mode === 'no-rare-leaf-helpers' && path.endsWith('/vm/leaf.mjs'))
          text = text.replace(/^export function (rxMatch|bitsOk)\([^]*?^\}/gm,
            (f, name) => `export function ${name}(){return 0}`);
        if (text !== original) changes.push(relative(sourceRoot, path));
        return { contents: text, loader: 'js' };
      });
    } };
    const result = await esbuild.build({ absWorkingDir: sourceRoot, stdin: { contents, resolveDir: sourceRoot },
      bundle: true, minifySyntax: true, minifyWhitespace: true, format: 'esm', target: 'es2022', platform: 'browser', legalComments: 'none',
      minifyIdentifiers: mode !== 'long-identifiers',
      write: false, logLevel: 'silent', plugins: [plugin] });
    const row = { entry, mode, ...z(result.outputFiles[0].contents), changed: changes.sort() };
    ablations.push(row);
    console.log(`${entry} ${mode}: ${row.min} min / ${row.gzip} gzip / ${row.brotli} brotli`);
  }
}
if (arg('report')) await writeFile(resolve(arg('report')), JSON.stringify({ functions, ablations }, null, 2) + '\n');
