// `@3sln/snug-wasm/inline`: the package root with both wasm
// modules inlined as base64, so no file, URL or bundler rule is needed.
//
//   initSync()   compiles both modules synchronously (Node, web workers, a
//                Worker's module scope; see docs/wasm-sdk.md for where a host
//                refuses synchronous compiles)
//   await init() the same, asynchronously (any host that runs wasm)
//
// Each takes no argument. The compiler module is compiled with the runtime, so
// compile() works afterwards even where compiling at request time is refused.
// The bytes are decoded once, on the first call, then dropped.
//
// inline-wasm.mjs (the base64 strings) is written by the package build
// (host/wasm-sdk/package-build.mjs); a checkout has none.
import { init as initFrom, initSync as initSyncFrom } from './index.mjs';
import { RUNTIME_BASE64, COMPILER_BASE64 } from './inline-wasm.mjs';

export * from './public-index.mjs';

function bytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
let done = false;
const sources = () => ({ runtime: bytes(RUNTIME_BASE64), compiler: bytes(COMPILER_BASE64) });
function noArgument(a) {
  if (a !== undefined) throw new TypeError('snug wasm: the inline entry carries its modules; init and initSync take no argument');
}

/** Compile and instantiate the inlined modules synchronously. A second call does nothing. */
export function initSync(none) {
  noArgument(none);
  if (done) return;
  initSyncFrom(sources()); done = true;
}
/** Compile and instantiate the inlined modules. A second call does nothing. */
export async function init(none) {
  noArgument(none);
  if (done) return;
  await initFrom(sources()); done = true;
}
