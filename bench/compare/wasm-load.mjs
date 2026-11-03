// Loaders for the two wasm builds used by P7.8 (built by run-rust.sh into bench/compare/rust/target):
//   snug   host/wasm (integer ABI, no imports): scanner and VM; no value builder exists in wasm.
//   crate  bench/compare/rust/cddl-wasm: the `cddl` crate 0.10.7 with a plain integer ABI.
// Every call copies its input into linear memory; that copy is part of what is timed.
import { readFileSync, existsSync } from 'node:fs';

const T = new URL('./rust/target/', import.meta.url);
export const SNUG_WASM = new URL('snug-wasm/target/wasm32-unknown-unknown/release/snug_wasm.wasm', T);
export const CRATE_WASM = new URL('wasm32-unknown-unknown/release/cddl_wasm.wasm', T);

export async function snugWasm() {
  if (!existsSync(SNUG_WASM)) return null;
  const { instance } = await WebAssembly.instantiate(readFileSync(SNUG_WASM));
  const x = instance.exports, cap = x.snug_cap();
  const mem = () => x.memory.buffer;
  const scanArgs = o => [o.top === 'any' ? 1 : 0, o.cose ? 1 : 0, o.maxBytes ?? 1_500_000, o.maxDepth ?? 32, o.maxEntries ?? 65_536, o.maxItems ?? 131_072];
  return {
    cap,
    /** Profile scan: 0 or a scanner code. */
    scan(bytes, o) { new Uint8Array(mem(), x.snug_buf(), bytes.length).set(bytes); return x.snug_scan(bytes.length, ...scanArgs(o)); },
    load(P, B) {
      new Int32Array(mem(), x.snug_prog_buf(), P.length).set(P);
      new Uint8Array(mem(), x.snug_pool_buf(), B.length).set(B);
      if (x.snug_vm_load(P.length, B.length) !== 0) throw new Error('snug wasm: Program refused');
    },
    /** VM validate against the loaded Program: 0 or a reason code. lim: the 8 limit words (schema.mjs limitWords). */
    validate(rule, bytes, lim) { new Uint8Array(mem(), x.snug_buf(), bytes.length).set(bytes); new Int32Array(mem(), x.snug_lim_buf(), 8).set(lim); return x.snug_vm_validate(bytes.length, rule); },
    size: readFileSync(SNUG_WASM).length,
  };
}

export async function crateWasm() {
  if (!existsSync(CRATE_WASM)) return null;
  const module = new WebAssembly.Module(readFileSync(CRATE_WASM));
  // The crate's own wasm-bindgen exports import JS glue; this harness never calls them, so every import is a stub
  // that traps if reached.
  const imports = {};
  for (const i of WebAssembly.Module.imports(module)) (imports[i.module] ??= {})[i.name] = () => { throw new Error(`cddl crate called JS import ${i.name}`); };
  let x;
  const fresh = () => { x = new WebAssembly.Instance(module, imports).exports; };
  fresh();
  const put = bytes => { const p = x.cw_alloc(bytes.length); new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes); return p; };
  const te = new TextEncoder();
  return {
    /** A fresh instance (after a trap the instance is unusable, study §6); handles are lost. */
    reset: fresh,
    compile(text, rule) { const t = te.encode(text), r = te.encode(rule); const tp = put(t), rp = put(r); const h = x.cw_compile(tp, t.length, rp, r.length); x.cw_free(tp, t.length); x.cw_free(rp, r.length); return h; },
    /** 1 valid, 0 invalid, -1 CBOR decode error, -2 other. */
    validate(h, bytes) { const p = put(bytes); try { return x.cw_validate(h, p, bytes.length); } finally { x.cw_free(p, bytes.length); } },
    size: readFileSync(CRATE_WASM).length,
  };
}
