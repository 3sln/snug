// P7.9: memory that never shrinks, and cold start in Node. Every scenario runs
// in a fresh process (so one scenario's high water cannot hide another's).
//
//   memory     wasm linear memory after init, after the scenario, after
//              trim() (reusable buffers dropped; pages stay), and after a GC
//              (views/sessions freed by FinalizationRegistry); the native
//              package's retained JS memory (heapUsed + arrayBuffers) after
//              the same scenario and a GC, minus its own baseline
//   cold       fresh process: import + load a serialised Program + first
//              validate (and the wasm compile/instantiate inside it), thread
//              CPU and wall, interleaved native/wasm samples
//
//     node bench/d005-memory.mjs [--samples=15] [--json=out.json]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';

const SAMPLES = Number(process.argv.find(a => a.startsWith('--samples='))?.slice(10) ?? 15);
const JSON_OUT = process.argv.find(a => a.startsWith('--json='))?.slice(7);
const self = new URL(import.meta.url).pathname;
const child = (args) => JSON.parse(execFileSync(process.execPath, ['--expose-gc', self, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }));

const SCENARIOS = ['idle', 'rpc-1000', 'doc-validate', 'decode-1mib', 'encode-1mib', 'encode-ints', 'max-input-refused',
  'views-100-held', 'views-100-released', 'push-1k', 'trap', 'compile-hostile'];

if (process.argv[2] === '--memory') {
  const [, , , build, scenario] = process.argv;
  const out = await memoryScenario(build, scenario);
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
if (process.argv[2] === '--cold') {
  const out = await cold(process.argv[3]);
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

async function memoryScenario(build, scenario) {
  const { readFileSync } = await import('node:fs');
  const { workloads, mutations, BIGL } = await import('./d005-inputs.mjs');
  const root = new URL('../', import.meta.url);
  const os = readFileSync(new URL('corpus/cddl-study/contracts/object-storage-v1.cddl', root), 'utf8');
  const W8 = workloads(os), by = id => W8.find(w => w.id === id);
  const wasm = build === 'wasm';
  const lib = wasm ? await import('../host/wasm-sdk/src/index.mjs') : await import('../host/js/src/index.mjs');
  const { compile } = wasm ? await import('../host/wasm-sdk/src/compile.mjs') : await import('../host/js/src/public-compile.mjs');
  const { view } = wasm ? await import('../host/wasm-sdk/src/view.mjs') : await import('../host/js/src/public-view.mjs');
  const src = wasm ? await import('../host/wasm-sdk/src/sources.mjs') : await import('../host/js/src/sources.mjs');
  if (wasm) await lib.init();
  const settle = async () => { for (let i = 0; i < 4; i++) { globalThis.gc(); await new Promise(r => setTimeout(r, 10)); } };
  const js = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
  const schemas = {};
  for (const w of W8) schemas[w.id] = await compile(w.cddl, w.cddl === os ? {} : { limits: BIGL });
  await settle();
  const r = { build, scenario, init: wasm ? lib.memoryBytes() : 0, jsBase: js() };
  let keep = null, threw = null;
  try {
    switch (scenario) {
      case 'idle': break;
      case 'rpc-1000': { const w = by('rpc287'); for (const m of [w.bytes, ...mutations(w.bytes, 999)]) schemas.rpc287.validate(m, 'request'); break; }
      case 'doc-validate': { const w = by('doc'); schemas.doc.validate(w.bytes, 'r', w.opts); break; }
      case 'decode-1mib': keep = lib.decode(by('put1m').bytes); break;
      case 'encode-1mib': keep = lib.encode(by('put1m').value); break;
      case 'encode-ints': keep = lib.encode(by('ints').value, by('ints').opts); break;
      case 'max-input-refused': { // a 1,499,999-byte byte string, one byte short: refused, at the input bound
        const b = new Uint8Array(1_499_999); b[0] = 0x5a; b[1] = 0; b[2] = 0x16; b[3] = 0xe3; b[4] = 0x5b;
        try { lib.decode(b, { top: 'any' }); } catch (e) { threw = e.code; } break;
      }
      case 'views-100-held': { const b = by('doc').bytes; keep = []; for (let i = 0; i < 100; i++) keep.push(view(b, by('doc').opts)); break; }
      case 'views-100-released': { const b = by('doc').bytes; for (let i = 0; i < 100; i++) view(b, by('doc').opts).get('padding'); break; }
      case 'push-1k': { // the native schema drivers take the host Schema (not public yet, D106)
        const sch = wasm ? schemas.doc : await (await import('../host/js/src/schema.mjs')).compile(by('doc').cddl, { limits: BIGL });
        const w = by('doc'), b = w.bytes, p = src.pushValidator(sch, b.length, 'r', w.opts); for (let i = 0; i < b.length; i += 1024) p.feed(b.subarray(i, i + 1024)); p.finalize(); break; }
      case 'trap': { const d = new Uint8Array(1_000_001).fill(0x81); d[d.length - 1] = 0; try { lib.decode(d, { top: 'any', maxDepth: 2e6, maxBytes: 2e6 }); } catch (e) { threw = e.name; } break; }
      case 'compile-hostile': { // a wide schema: 4,000 rules of 8-way choices, about 0.5 MB of CDDL
        let t = 'r = [* a0]\n'; for (let i = 0; i < 4000; i++) t += `a${i} = ${i + 1 < 4000 ? `a${i + 1} / ` : ''}{ k${i}: uint, ? x${i}: tstr .size (1..${i + 2}) } / [${i}, bstr] / "s${i}" / ${i}..${i + 9} / #6.${100 + (i % 50)}(int) / bool / null\n`;
        try { keep = await compile(t, { limits: { schemaBytes: 1 << 22, astNodes: 1 << 22, instantiations: 1 << 22, alternatives: 1 << 22, width: 1 << 22, poolBytes: 1 << 26, totalBytes: 1 << 28, compileBudget: 0x7fffffff, leaves: 1 << 22 } }); }
        catch (e) { threw = e.code ?? String(e); }
        if (wasm) { const c = await import('../host/wasm-sdk/src/compile.mjs'); r.compilerMemory = c.compilerMemoryBytes(); c.releaseCompiler(); }
        break;
      }
    }
  } catch (e) { threw = e.name + ':' + e.code; }
  r.threw = threw;
  if (wasm) r.after = lib.memoryBytes();
  r.jsAfter = js() - r.jsBase;
  if (scenario !== 'views-100-held') keep = null;
  await settle();
  r.jsAfterGc = js() - r.jsBase;
  if (wasm) { r.afterGc = lib.memoryBytes(); lib.trim(); r.afterTrim = lib.memoryBytes(); lib.reset(); r.afterReset = lib.memoryBytes(); }
  r.keep = keep ? 1 : 0;
  return r;
}

async function cold(build) {
  const t0 = performance.now(), c0 = process.threadCpuUsage();
  const ms = () => performance.now() - t0, cpu = () => { const u = process.threadCpuUsage(c0); return (u.user + u.system) / 1000; };
  const { readFileSync } = await import('node:fs');
  const root = new URL('../', import.meta.url);
  const prog = readFileSync(new URL('.cache/d005-object-storage.snugprog', root));
  const input = readFileSync(new URL('.cache/d005-rpc287.cbor', root));
  const r = { build };
  if (build === 'wasm') {
    const lib = await import('../host/wasm-sdk/src/index.mjs');
    const S = await import('../host/wasm-sdk/src/schema.mjs');
    r.importMs = ms(); r.importCpu = cpu();
    const bytes = readFileSync(new URL('.cache/snug-wasm-sdk/target/wasm32-unknown-unknown/release/snug_wasm.wasm', root));
    const a = performance.now(); const mod = await WebAssembly.compile(bytes); r.compileMs = performance.now() - a;
    const b = performance.now(); lib.initSync(mod); r.instantiateMs = performance.now() - b;
    const s = S.fromSerializedSync(prog); r.loadMs = ms(); r.loadCpu = cpu();
    r.ok = s.validate(input, 'request').ok; r.firstMs = ms(); r.firstCpu = cpu();
    const c = performance.now(); s.validate(input, 'request'); r.secondUs = (performance.now() - c) * 1000;
  } else {
    const S = await import('../host/js/src/public-schema.mjs');
    r.importMs = ms(); r.importCpu = cpu();
    const s = await S.fromSerialized(prog); r.loadMs = ms(); r.loadCpu = cpu();
    r.ok = s.validate(input, 'request').ok; r.firstMs = ms(); r.firstCpu = cpu();
    const c = performance.now(); s.validate(input, 'request'); r.secondUs = (performance.now() - c) * 1000;
  }
  return r;
}

// ---------------------------------------------------------------- driver
{
  const { readFileSync, mkdirSync } = await import('node:fs');
  const { workloads } = await import('./d005-inputs.mjs');
  const { compile } = await import('../host/js/src/public-compile.mjs');
  const root = new URL('../', import.meta.url);
  const os = readFileSync(new URL('corpus/cddl-study/contracts/object-storage-v1.cddl', root), 'utf8');
  mkdirSync(new URL('.cache/', root), { recursive: true });
  writeFileSync(new URL('.cache/d005-object-storage.snugprog', root), (await compile(os)).program.serialize());
  writeFileSync(new URL('.cache/d005-rpc287.cbor', root), workloads(os)[0].bytes);
}
const result = { load: loadavg().map(x => +x.toFixed(1)), memory: [], cold: { native: [], wasm: [] } };
for (const s of SCENARIOS) for (const b of ['native', 'wasm']) {
  const r = child(['--memory', b, s]); result.memory.push(r);
  const mb = x => x === undefined ? '' : (x / 1048576).toFixed(1);
  console.log(`${s.padEnd(20)} ${b.padEnd(7)} ${b === 'wasm' ? `linear init ${mb(r.init)} -> after ${mb(r.after)} -> after GC ${mb(r.afterGc)} -> trim ${mb(r.afterTrim)} -> reset ${mb(r.afterReset)} MiB` : ''} js retained ${mb(r.jsAfter)} -> after GC ${mb(r.jsAfterGc)} MiB${r.threw ? ` (threw ${r.threw})` : ''}${r.compilerMemory ? ` compiler memory ${mb(r.compilerMemory)} MiB` : ''}`);
}
for (let i = 0; i < SAMPLES; i++) for (const b of i % 2 ? ['wasm', 'native'] : ['native', 'wasm']) result.cold[b].push(child(['--cold', b]));
const med = (a, k) => { const x = a.map(r => r[k]).sort((p, q) => p - q); return x[(x.length - 1) >> 1]; };
for (const b of ['native', 'wasm']) {
  const a = result.cold[b];
  console.log(`cold ${b.padEnd(6)} import ${med(a, 'importMs').toFixed(1)} ms (cpu ${med(a, 'importCpu').toFixed(1)}), +Program ${med(a, 'loadMs').toFixed(1)} ms (cpu ${med(a, 'loadCpu').toFixed(1)}), +first validate ${med(a, 'firstMs').toFixed(1)} ms (cpu ${med(a, 'firstCpu').toFixed(1)}), second validate ${med(a, 'secondUs').toFixed(1)} µs` +
    (b === 'wasm' ? `; wasm compile ${med(a, 'compileMs').toFixed(2)} ms, instantiate ${med(a, 'instantiateMs').toFixed(2)} ms` : ''));
}
result.loadEnd = loadavg().map(x => +x.toFixed(1));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(result, null, 1));
