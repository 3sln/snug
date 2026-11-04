// Offline public-entry size gate. Uses the existing benchmark esbuild read-only.
import esbuild from '../../bench/compare/node_modules/esbuild/lib/main.js';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, platform, release, arch } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const argument = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = resolve(argument('root') ?? resolve(here, '../..'));
const pkg = JSON.parse(await readFile(resolve(root, 'host/js/package.json'), 'utf8'));
// Freeze sources once so concurrent edits cannot change one entry's dependencies
// halfway through measuring another. Hash the exact source supplied to esbuild.
const sources = new Map();
async function snapshot(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, item.name);
    if (item.isDirectory()) await snapshot(path);
    else if (path.endsWith('.mjs')) sources.set(path, await readFile(path, 'utf8'));
  }
}
await snapshot(resolve(root, 'host/js/src'));
await snapshot(resolve(root, 'gen/js'));
const frozenSources = { name: 'frozen-sources', setup(build) {
  build.onLoad({ filter: /\.mjs$/ }, ({ path }) => {
    if (!sources.has(path)) throw new Error(`Source appeared during measurement; rerun: ${relative(root, path)}`);
    return { contents: sources.get(path), loader: 'js' };
  });
} };
const compress = bytes => ({ min: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length,
  brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length });
const entries = Object.entries(pkg.exports).map(([name, spec]) => [
  name === '.' ? 'snug' : `snug/${name.slice(2)}`, resolve(root, 'host/js', spec.default),
]);
const entry = name => entries.find(([n]) => n === name)[1];
const reexports = names => names.map((name, i) => `export * as entry${i} from ${JSON.stringify(entry(name))};`).join('\n');
const workloads = entries.map(([name, path]) => [name, { entryPoints: [path] }]);
workloads.push(['runtime', { stdin: { contents: reexports(['snug', 'snug/schema']), resolveDir: root } }],
  ['all-runtime', { stdin: { contents: reexports(entries.map(([n]) => n).filter(n => !['snug/compile', 'snug/unicode'].includes(n))), resolveDir: root } }]);
const common = { absWorkingDir: root, bundle: true, minify: true, format: 'esm', platform: 'browser',
  target: 'es2022', charset: 'ascii', legalComments: 'none', treeShaking: true, write: false,
  metafile: true, logLevel: 'silent', plugins: [frozenSources] };
const staticOnly = { name: 'static-only', setup(build) {
  build.onResolve({ filter: /.*/ }, args => args.kind === 'dynamic-import'
    ? { path: args.path, external: true } : undefined);
} };
const measurements = [], moduleNames = new Set();
for (const [name, input] of workloads) {
  // Dynamic imports remain external here: this measures the initial static graph,
  // without accidentally inlining the compiler. full measures the entire closure
  // as one file, so lazy moves cannot hide a total-size regression from the gate.
  const initial = await esbuild.build({ ...common, ...input, plugins: [frozenSources, staticOnly] });
  const full = await esbuild.build({ ...common, ...input });
  const split = await esbuild.build({ ...common, ...input, splitting: true, outdir: '.size-output' });
  const splitOutputs = split.metafile.outputs;
  const initialChunks = new Set();
  const reachableChunks = new Set();
  function visit(path, seen, dynamic) {
    if (seen.has(path)) return;
    seen.add(path);
    for (const imp of splitOutputs[path].imports)
      if (!imp.external && (dynamic || imp.kind !== 'dynamic-import')) visit(imp.path, seen, dynamic);
  }
  const entryOutput = Object.keys(splitOutputs).find(path => splitOutputs[path].entryPoint === (input.stdin ? '<stdin>' : relative(root, input.entryPoints[0])));
  visit(entryOutput, initialChunks, false);
  visit(entryOutput, reachableChunks, true);
  const chunks = split.outputFiles.map(file => {
    const path = relative(root, file.path);
    return { path, initial: initialChunks.has(path), reachable: reachableChunks.has(path), ...compress(file.contents) };
  });
  const sum = files => Object.fromEntries(['min', 'gzip', 'brotli'].map(metric => [metric,
    files.reduce((n, file) => n + file[metric], 0)]));
  const inputs = initial.metafile.inputs;
  for (const path of Object.keys(inputs)) if (path !== '<stdin>') moduleNames.add(path);
  for (const path of Object.keys(full.metafile.inputs)) if (path !== '<stdin>') moduleNames.add(path);
  const output = Object.values(initial.metafile.outputs)[0];
  const ranked = Object.entries(output.inputs).filter(([path]) => path !== '<stdin>')
    .map(([path, info]) => ({ path, min: info.bytesInOutput }))
    .sort((a, b) => b.min - a.min || a.path.localeCompare(b.path));
  const row = { name, static: compress(initial.outputFiles[0].contents), full: compress(full.outputFiles[0].contents),
    split: { initial: sum(chunks.filter(c => c.initial)), total: sum(chunks.filter(c => c.reachable)),
      emitted: sum(chunks), chunks, metafile: split.metafile },
    ranked, metafile: initial.metafile, fullMetafile: full.metafile };
  measurements.push(row);
}
const modules = [];
for (const path of [...moduleNames].sort()) {
  const source = sources.get(resolve(root, path));
  // Isolated module compression is descriptive, never added to bundle totals.
  const minified = await esbuild.transform(source, { minify: true, format: 'esm', target: 'es2022',
    charset: 'ascii', legalComments: 'none' });
  modules.push({ path, source: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'),
    isolated: compress(Buffer.from(minified.code)) });
}
const sourceHash = createHash('sha256').update(JSON.stringify({ exports: pkg.exports, sideEffects: pkg.sideEffects,
  modules: modules.map(({ path, sha256 }) => [path, sha256]) })).digest('hex');
const report = { date: new Date().toISOString(), environment: { cpu: cpus()[0].model, os: platform(),
  release: release(), arch: arch(), node: process.version, v8: process.versions.v8, zlib: process.versions.zlib,
  brotli: process.versions.brotli, esbuild: esbuild.version }, sourceHash, measurements, modules };
console.log(`esbuild ${esbuild.version}; Node ${process.version}; gzip 9; brotli 11; bytes`);
console.log('| entry | static min | static gzip | static brotli | full min | full gzip | full brotli |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const { name, static: s, full: f } of measurements)
  console.log(`| ${name} | ${s.min} | ${s.gzip} | ${s.brotli} | ${f.min} | ${f.gzip} | ${f.brotli} |`);
if (process.argv.includes('--details')) {
  for (const { name, ranked } of measurements) {
    console.log(`\n${name}: static minified attribution (compression is not additive)`);
    for (const { path, min } of ranked) console.log(`${String(min).padStart(7)} ${'█'.repeat(Math.ceil(min / 2000))} ${path}`);
  }
  console.log('\n| module (isolated, imports retained) | source | min | gzip | brotli |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const { path, source, isolated: s } of modules.sort((a, b) => b.isolated.min - a.isolated.min))
    console.log(`| ${path} | ${source} | ${s.min} | ${s.gzip} | ${s.brotli} |`);
}
if (argument('report')) {
  const path = resolve(argument('report'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${relative(process.cwd(), path)} (graphs, attribution, isolated modules, source hashes)`);
}
if (!process.argv.includes('--no-gate')) {
  const budget = JSON.parse(await readFile(resolve(argument('budget') ?? resolve(here, 'budget.json')), 'utf8'));
  let failures = 0;
  for (const row of measurements) {
    for (const mode of ['static', 'full']) for (const metric of ['min', 'gzip', 'brotli']) {
      const cap = budget.entries[row.name]?.[mode]?.[metric];
      if (!Number.isSafeInteger(cap) || row[mode][metric] > cap) {
        console.error(`FAIL ${row.name} ${mode}.${metric}: ${row[mode][metric]} > ${cap ?? 'missing budget'}`);
        failures++;
      }
    }
  }
  if (failures) process.exitCode = 1;
  else console.log('Size budgets passed. R9 remains a separate 20 KB runtime target.');
}
