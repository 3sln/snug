// Where the SDK's two wasm modules come from. A source is one of
//
//   WebAssembly.Module      used as is (a Workers / wrangler `.wasm` import is one)
//   ArrayBuffer, a view     bytes (Uint8Array, Node Buffer, ...), compiled here
//   Response, Promise of one   fetch()'s answer: compileStreaming when it is
//                           served as application/wasm, else its bytes
//   URL, or a string with a scheme (https:, file:, data:, blob:, ...)
//                           file: is read with node:fs; anything else is fetched
//   any other string        Node: a file path (relative to the working
//                           directory); elsewhere: a URL relative to the page
//
// Nothing here compiles until init / initSync (the runtime module) or the first
// compile() (the compiler module, unless init was given one). The compiler's
// module lives in `compiler` below, so the root entry can take it without
// importing snug/compile.

const isNode = typeof process === 'object' && process !== null && typeof process.versions?.node === 'string';
// node:fs only for a file path or file: URL, and out of bundlers' sight (a Worker
// or browser bundle never reads files; wrangler warns on a visible node: import).
const NODE_FS = 'node:fs/promises';
async function readFile(path) {
  const fs = process.getBuiltinModule?.(NODE_FS) ?? await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_FS);
  return fs.readFile(path);
}
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;   // two letters at least: `C:\x` is a Windows path

function badSource(source) {
  return new TypeError(`snug wasm: a wasm source is a WebAssembly.Module, bytes, a Response, a URL or a path, not ${
    source === null ? 'null' : typeof source}`);
}

/** Is `x` the init options object ({ runtime, compiler }) rather than a source? */
export function isOptions(x) {
  return x !== null && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype;
}

/** Compile a source asynchronously (see above). */
export async function toModule(source) {
  if (source instanceof WebAssembly.Module) return source;
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return WebAssembly.compile(source);
  if (typeof Response === 'function' && source instanceof Response) {
    if (!source.ok) throw new Error(`snug wasm: fetching the module answered HTTP ${source.status}`);
    const type = source.headers.get('content-type') ?? '';
    if (typeof WebAssembly.compileStreaming === 'function' && /^application\/wasm\b/i.test(type))
      return WebAssembly.compileStreaming(source);
    return WebAssembly.compile(await source.arrayBuffer());
  }
  if (source !== null && typeof source === 'object' && typeof source.then === 'function') return toModule(await source);
  let url;
  if (source instanceof URL) url = source;
  else if (typeof source === 'string') {
    if (SCHEME.test(source)) url = new URL(source);
    else if (isNode) return WebAssembly.compile(await readFile(source));
    else return toModule(await fetch(source));
  } else throw badSource(source);
  if (url.protocol === 'file:') return WebAssembly.compile(await readFile(url));
  return toModule(await fetch(url));
}

/** Compile a source synchronously: only a WebAssembly.Module or bytes (a URL or path needs `await init`). */
export function toModuleSync(source) {
  if (source instanceof WebAssembly.Module) return source;
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return new WebAssembly.Module(source);
  if (typeof source === 'string' || source instanceof URL || (typeof Response === 'function' && source instanceof Response))
    throw new TypeError('snug wasm: initSync takes a WebAssembly.Module or bytes; for a URL, path or Response use `await init(source)`');
  throw badSource(source);
}

/** The compiler module's slot: `module` once compiled, else `source` (undefined: the default next to the SDK). */
export const compiler = { module: null, source: undefined };
