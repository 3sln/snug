// P7.8 part 5: bundle sizes. esbuild (bench/compare/node_modules) --bundle --minify --format=esm, one entry per row
// importing exactly the named functions (so tree-shaking applies equally); gzip -9 and brotli 11 by node:zlib.
//
//     node bench/compare/sizes.mjs [--json=results/sizes.json]
import { buildSync } from 'esbuild';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SNUG_WASM, CRATE_WASM } from './wasm-load.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const S = fileURLToPath(new URL('../../host/js/src/', import.meta.url));
const B = fileURLToPath(new URL('../baseline/', import.meta.url));
const rows = [
  ['snug codec (decode + encode)', `export { decode, encode } from '${S}index.mjs';`],
  ['snug codec + Writer', `export { decode, encode } from '${S}index.mjs'; export { Writer } from '${S}public-writer.mjs';`],
  ['snug runtime (codec + schema validate/decode, Program loader)', `export { decode, encode } from '${S}index.mjs'; export * from '${S}public-schema.mjs';`],
  ['snug compile entry (compiler + the runtime schema API it returns)', `export * from '${S}public-compile.mjs';`],
  ['3sln.me cbor.mjs (decode + encode)', `export { decode, encode } from '${B}cbor-3sln.mjs';`],
  ['cbor-x (decode + encode)', `export { decode, encode } from 'cbor-x';`],
  ['cborg (decode + encode)', `export { decode, encode } from 'cborg';`],
  ['cbor2 (decode + encode)', `export { decode, encode } from 'cbor2';`],
  ['cbor / node-cbor (decodeFirstSync + encode), platform=node, Node builtins external', `import c from 'cbor'; export const decode = c.decodeFirstSync, encode = c.encode;`, 'node'],
  ['@levischuck/tiny-cbor (decodeCBOR + encodeCBOR)', `export { decodeCBOR, encodeCBOR } from '@levischuck/tiny-cbor';`],
  ['@cbortech/cbor CDDL (CDDL.compile + validate; compiler included)', `export { CDDL } from '@cbortech/cbor/cddl';`],
];
const z = b => ({ raw: b.length, gzip: gzipSync(b, { level: 9 }).length, brotli: brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length });
const out = [];
console.log('| bundle | min B | min+gzip B | min+brotli B |');
console.log('| --- | ---: | ---: | ---: |');
for (const [name, contents, platform = 'browser'] of rows) {
  try {
    const r = buildSync({ stdin: { contents, resolveDir: here, loader: 'js' }, bundle: true, minify: true, format: 'esm', platform, write: false, logLevel: 'silent', target: 'es2022' });
    const s = z(Buffer.from(r.outputFiles[0].contents));
    out.push({ name, ...s });
    console.log(`| ${name} | ${s.raw} | ${s.gzip} | ${s.brotli} |`);
  } catch (e) { out.push({ name, error: e.message.split('\n')[0] }); console.log(`| ${name} | build failed: ${e.message.split('\n')[0]} | | |`); }
}
for (const [name, url] of [['snug wasm (scanner + VM, opt-level 3, no wasm-opt; JS glue not counted)', SNUG_WASM], ['cddl crate wasm (rust/cddl-wasm, opt-level 3, not stripped, no wasm-opt)', CRATE_WASM]]) {
  if (!existsSync(url)) { console.log(`| ${name} | not built | | |`); continue; }
  const s = z(readFileSync(url)); out.push({ name, ...s });
  console.log(`| ${name} | ${s.raw} | ${s.gzip} | ${s.brotli} |`);
}
const arg = process.argv.find(a => a.startsWith('--json='));
if (arg) writeFileSync(arg.slice(7), JSON.stringify(out, null, 1));
