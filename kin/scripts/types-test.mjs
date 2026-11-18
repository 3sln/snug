// P9.20 follow-up: types-test -- every published declaration compiles under a pinned
// TypeScript, as a consumer sees it.
//
//     node kin/scripts/types-test.mjs          (bb types-test; in the land and release sets)
//
// For each package (@3sln/snug in host/js, @3sln/snug-wasm in host/wasm-sdk), a consumer
// module imports every entry point of the package's exports map by bare specifier
// (node_modules links in .cache/types-test), strict, module and moduleResolution NodeNext,
// skipLibCheck off, target ES2022, under two libs:
//   es2022   ES2022's default lib (ES2022 + DOM): the declared floor, which has no
//            Symbol.dispose
//   esnext   ESNext + DOM: here VmSession must also be Disposable (`using` works)
// The declarations name web-platform globals (ReadableStream, WebAssembly, Response, URL),
// so a consumer needs the DOM lib or @types/node; a bare ES lib is not a supported setup.
// TypeScript: SNUG_TYPESCRIPT names a tsc (default bench/compare's, pinned by its
// lockfile: `npm ci` in bench/compare). Without one the gate prints SKIP (NOT RUN),
// which fails a gate set (release-policy §2).
//
// Every runtime export is declared (D370, P9.13 gates N3): every exports entry that is a
// module has a `types` condition (a plain string entry must be a .wasm or .json asset), and
// the consumer module reads every value its `default` module exports (`void entry3.Writer;`),
// so a runtime export with no declaration, or declared only as a type, fails tsc. The
// runtime names come from TypeScript's own reading of the JS module (allowJs: re-exports
// followed, nothing run; the wasm SDK's inline entry imports a module only a package build
// generates), and are held to Node's import of the module wherever that import loads.
// Watchdog caps (P9.1): 600 s wall / 1200 s CPU.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selfWatch } from './watchdog.mjs';
selfWatch('types-test', import.meta.url);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsc = process.env.SNUG_TYPESCRIPT || join(repo, 'bench/compare/node_modules/typescript/bin/tsc');
if (!existsSync(tsc)) {
  console.log(`SKIP types-test -- no TypeScript at ${process.env.SNUG_TYPESCRIPT ? 'SNUG_TYPESCRIPT' : 'bench/compare'} (npm ci in bench/compare, or set SNUG_TYPESCRIPT to a tsc): NOT RUN`);
  process.exit(0);
}
const run = args => execFileSync(process.execPath, [tsc, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
console.log(`types-test: ${run(['--version']).trim()} (${process.env.SNUG_TYPESCRIPT ? 'SNUG_TYPESCRIPT' : 'bench/compare'})`);

const work = join(repo, '.cache/types-test');
rmSync(work, { recursive: true, force: true });
const packages = [['host/js', '@3sln/snug'], ['host/wasm-sdk', '@3sln/snug-wasm']];
for (const [dir, name] of packages) {
  mkdirSync(join(work, 'node_modules', dirname(name)), { recursive: true });
  symlinkSync(join(repo, dir), join(work, 'node_modules', name), 'dir');
}
const configs = {
  'es2022': { target: 'ES2022' },
  'esnext': { target: 'ES2022', lib: ['ESNext', 'DOM'] },
};
let failed = 0;
// D370 (N3): TypeScript's compiler API, beside the tsc that checks the declarations
const tsLib = join(dirname(tsc), '../lib/typescript.js');
if (!existsSync(tsLib)) { console.log(`  FAIL types-test: no TypeScript compiler API at ${tsLib} (beside ${tsc})`); process.exit(1); }
const ts = createRequire(import.meta.url)(tsLib);
/** The value names each JS module exports, as TypeScript reads them (re-exports followed). */
function runtimeExports(files) {
  const program = ts.createProgram(files, { allowJs: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const checker = program.getTypeChecker();
  return files.map(f => {
    const sym = checker.getSymbolAtLocation(program.getSourceFile(f));
    return sym ? checker.getExportsOfModule(sym).map(s => s.name).sort() : null;
  });
}
for (const [dir, name] of packages) {
  const pkg = JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8'));
  const all = Object.entries(pkg.exports);
  // an entry a consumer imports as a module must be typed; a plain asset (.wasm, .json) is not a module
  for (const [key, e] of all) {
    const asset = typeof e === 'string' && /\.(wasm|json)$/.test(e);
    if (!asset && !(e && typeof e === 'object' && e.types && e.default)) {
      failed++;
      console.log(`  FAIL ${name}: exports ${JSON.stringify(key)} is ${JSON.stringify(e)}, a module entry without types and default conditions`);
    }
  }
  const typed = all.filter(([, e]) => e && typeof e === 'object' && e.types && e.default);
  const entries = typed.map(([key]) => key);
  const modules = typed.map(([, e]) => resolve(repo, dir, e.default));
  const names = runtimeExports(modules);
  let held = 0;
  for (let i = 0; i < entries.length; i++) {
    if (!names[i] || names[i].length === 0) { failed++; console.log(`  FAIL ${name} ${entries[i]}: TypeScript read no exports from ${modules[i]}`); continue; }
    let loaded = null;
    try { loaded = Object.keys(await import(pathToFileURL(modules[i]).href)).sort(); } catch { /* a module only a package build completes */ }
    if (loaded === null) continue;
    held++;
    if (loaded.join() !== names[i].join()) {
      failed++;
      console.log(`  FAIL ${name} ${entries[i]}: Node's import exports [${loaded}], TypeScript read [${names[i]}]`);
    }
  }
  const values = names.reduce((n, x) => n + (x?.length ?? 0), 0);
  console.log(`  info ${name}: ${values} runtime exports over ${entries.length} entry points to check (${held} read by Node's import too)`);
  const specifier = key => key === '.' ? name : `${name}/${key.slice(2)}`;
  for (const [config, options] of Object.entries(configs)) {
    const at = join(work, `${name.replace('/', '__')}-${config}`);
    mkdirSync(at, { recursive: true });
    const lines = entries.map((key, i) => `import * as entry${i} from '${specifier(key)}';`);
    lines.push(`export const entries = [${entries.map((_, i) => `entry${i}`).join(', ')}];`);
    // D370 (N3): every runtime export is a declared value
    entries.forEach((_, i) => { for (const n of names[i] ?? []) lines.push(/^[A-Za-z_$][\w$]*$/.test(n) ? `void entry${i}.${n};` : `void entry${i}[${JSON.stringify(n)}];`); });
    // VmSession: close() everywhere; Disposable exactly where the lib declares Symbol.dispose
    lines.push(`import type { VmSession } from '${name}/sources';`, 'export function use(s: VmSession): void { s.close(); }');
    if (config === 'esnext') lines.push('export function dispose(s: VmSession): void { const d: Disposable = s; d[Symbol.dispose](); using u = s; void u; }');
    // Fresh output buffers are Uint8Array<ArrayBuffer>: BodyInit and BlobPart accept them under TS 5.7+ with lib DOM
    lines.push(`import { encode as enc } from '${name}';`, `import { Writer as W } from '${name}/writer';`,
      `import type { Schema as S } from '${name}/schema';`, `import type { View as V } from '${name}/view';`,
      `import type { SequenceMessage as M } from '${name}/sequence';`,
      'export const response = new Response(enc({ id: 7 }));',
      'export const blob = new Blob([enc({ id: 7 })]);',
      'export const written = new Response(new W().value(1).finish());',
      'export function stored(s: S): Blob { return new Blob([s.program.serialize()]); }',
      'export function copied(v: V): Response { return new Response(v.copyBytes()); }');
    // View.release() is the wasm SDK's alone, on views from view() and from sequences
    if (name === '@3sln/snug-wasm') lines.push('export function release(v: V, m: M): void { v.release(); m.view.release(); }');
    else lines.push('export function noRelease(v: V): void {', '  // @ts-expect-error the native View has no release()', '  v.release();', '}');
    writeFileSync(join(at, 'check.mts'), lines.join('\n') + '\n');
    writeFileSync(join(at, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { ...options, strict: true, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext',
        types: [], skipLibCheck: false, forceConsistentCasingInFileNames: true },
      files: ['check.mts'],
    }, null, 2) + '\n');
    try {
      run(['-p', join(at, 'tsconfig.json')]);
      console.log(`  ok   ${name} ${config}: ${entries.length} entry points`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${name} ${config}:\n${String(e.stdout || '') + String(e.stderr || '')}`.trimEnd());
    }
  }
}
console.log(failed ? `  FAIL types-test: ${failed} problem(s) (entries or configurations)` : '  ok   types-test');
process.exit(failed ? 1 : 0);
