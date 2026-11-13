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
// Watchdog caps (P9.1): 600 s wall / 1200 s CPU.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
for (const [dir, name] of packages) {
  const pkg = JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8'));
  const entries = Object.entries(pkg.exports).filter(([, e]) => e && typeof e === 'object' && e.types).map(([key]) => key);
  const specifier = key => key === '.' ? name : `${name}/${key.slice(2)}`;
  for (const [config, options] of Object.entries(configs)) {
    const at = join(work, `${name.replace('/', '__')}-${config}`);
    mkdirSync(at, { recursive: true });
    const lines = entries.map((key, i) => `import * as entry${i} from '${specifier(key)}';`);
    lines.push(`export const entries = [${entries.map((_, i) => `entry${i}`).join(', ')}];`);
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
console.log(failed ? `  FAIL types-test: ${failed} configuration(s)` : '  ok   types-test');
process.exit(failed ? 1 : 0);
