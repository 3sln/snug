// One isolate per validator for js-cddl.mjs (same method as codec-worker.mjs).
import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, writeFileSync } from 'node:fs';
import { compile as snugCompile } from '../../host/js/src/schema.mjs';
import { snugWasm, crateWasm } from './wasm-load.mjs';
import { studyCases, workloadCases } from './cddl-cases.mjs';

const group = workerData.group;
const cpu = () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; };
const cases = [...studyCases(), ...workloadCases()];
// Programs for large inputs need the budget and item/entry caps raised (as VM.md §2 does); the study probes use the
// compiled defaults.
const LIMITS = c => c.id.startsWith('workload:') ? { budget: 0x7fffffff, items: 1 << 24, entries: 1 << 24 } : {};
const lim = (v) => v === undefined || v === null ? -1 : v;
const limitWords = o => Int32Array.of(o.top === 'map' ? 0 : 1, o.cose ? 1 : 0, lim(o.maxBytes), lim(o.maxDepth), lim(o.maxEntries), lim(o.maxItems), -1, -1);

let impl;
async function setup() {
  if (group === 'snug-js' || group === 'snug-wasm') {
    const w = group === 'snug-wasm' ? await snugWasm() : null;
    const schemas = new Map();
    const schemaOf = async c => { const k = c.schema; if (!schemas.has(k)) schemas.set(k, await snugCompile(c.text, { limits: LIMITS(c) })); return schemas.get(k); };
    let loaded = null;
    return {
      async prepare(c) {
        const s = await schemaOf(c);
        if (!w) return { run: () => c.list.map(b => s.validate(b, c.rule, c.opts).ok), extra: { units: c.list.length === 1 ? s.program.run(s.rule(c.rule), c.list[0], c.opts)[3] : undefined } };
        if (c.list.some(b => b.length > w.cap)) return { skip: `input > wasm buffer (${w.cap} B)` };
        const rule = s.rule(c.rule), L = limitWords(c.opts);
        const load = () => { if (loaded !== s) { w.load(s.program.P, s.program.B); loaded = s; } };
        return { run: () => { load(); return c.list.map(b => w.validate(rule, b, L) === 0); } };
      },
    };
  }
  if (group === 'crate-wasm') {
    const cr = await crateWasm();
    if (!cr) return null;
    return {
      async prepare(c) {
        let h = cr.compile(c.text, c.rule), note;
        if (!h) { const t2 = c.text.replace('safe-uint = 0..9007199254740991', 'safe-uint = uint'); if (t2 !== c.text && (h = cr.compile(t2, c.rule))) note = 'study workaround (safe-uint = uint)'; }
        if (!h) return { skip: 'the crate does not parse this schema' };
        return { note, run: () => c.list.map(b => { const r = cr.validate(h, b); if (r < 0) throw new Error(`crate answered ${r}`); return r === 1; }), onTrap: () => cr.reset() };
      },
    };
  }
  if (group === 'cbortech') {
    const { CDDL } = await import('@cbortech/cbor/cddl');
    const schemas = new Map();
    return {
      async prepare(c) {
        let s = schemas.get(c.schema);
        if (!s) { try { s = CDDL.compile(c.text); } catch (e) { return { skip: `compile: ${e.message.slice(0, 100)}` }; } schemas.set(c.schema, s); }
        const warnings = s.warnings?.length ? `schema warnings: ${s.warnings.map(w => w.message ?? String(w)).join('; ').slice(0, 120)}` : undefined;
        return { note: warnings, run: () => c.list.map(b => s.validate(b, { rule: c.rule, maxDepth: 64, maxSteps: Number.MAX_SAFE_INTEGER }).valid) };
      },
    };
  }
  if (group === 'cddl.js') {
    const { parse } = await import('cddl.js/parse');
    const { emitModule } = await import('cddl.js/emitter');
    const { transformSync } = await import('esbuild');
    const cbor2 = await import('cbor2');
    const dir = new URL('./node_modules/.cache/cddljs/', import.meta.url); mkdirSync(dir, { recursive: true });
    const mods = new Map();
    return {
      async prepare(c) {
        let m = mods.get(c.schema);
        if (!m) {
          try {
            const f = new URL(`${c.schema}.cddl`, dir); writeFileSync(f, c.text);
            const js = transformSync(emitModule(parse(f.pathname)), { loader: 'ts', format: 'esm' }).code;
            const out = new URL(`${c.schema}.mjs`, dir); writeFileSync(out, js);
            m = await import(out.href);
          } catch (e) { m = { error: e.message.slice(0, 120) }; }
          mods.set(c.schema, m);
        }
        if (m.error) return { skip: `cddl.js: ${m.error}` };
        const camel = c.rule.replace(/-([a-z0-9])/g, (_, x) => x.toUpperCase()).replace(/^\$/, '');
        const z = m[`${camel}Schema`];
        if (!z) return { skip: `no ${camel}Schema export` };
        return { note: 'cbor2 decode + Zod safeParse of the decoded value', run: () => c.list.map(b => z.safeParse(cbor2.decode(b)).success) };
      },
    };
  }
  throw new Error(`unknown group ${group}`);
}

const ops = new Map();
let sink;
parentPort.on('message', async m => {
  try {
    if (m.cmd === 'load') {
      impl ??= await setup();
      const report = [];
      for (const c of cases) {
        if (!impl) { report.push({ id: c.id, status: 'skip', note: 'not built' }); continue; }
        let p;
        try { p = await impl.prepare(c); } catch (e) { report.push({ id: c.id, status: 'skip', note: e.message.slice(0, 120) }); continue; }
        if (p.skip) { report.push({ id: c.id, status: 'skip', note: p.skip }); continue; }
        let verdicts;
        try { verdicts = p.run(); } catch (e) { p.onTrap?.(); report.push({ id: c.id, status: 'error', note: e.message.slice(0, 120) }); continue; }
        const ok = verdicts.every(Boolean);
        ops.set(c.id, { ...p, expect: ok });
        report.push({ id: c.id, status: 'ok', verdict: ok, agrees: ok === c.valid, note: p.note, extra: p.extra });
      }
      parentPort.postMessage({ ok: true, report });
    } else if (m.cmd === 'calibrate') {
      const op = ops.get(m.id);
      for (let i = 0; i < 2; i++) sink = op.run();
      let n = 1;
      for (;;) { const t = cpu(); for (let i = 0; i < n; i++) sink = op.run(); const d = cpu() - t;
        if (d >= m.targetMs || n >= 1 << 20) break; n = d < 1 ? n * 8 : Math.max(n + 1, Math.ceil(n * m.targetMs * 1.1 / d)); }
      parentPort.postMessage({ ok: true, n });
    } else if (m.cmd === 'sample') {
      const op = ops.get(m.id);
      globalThis.gc?.();
      const t = cpu(); for (let i = 0; i < m.n; i++) sink = op.run(); const ms = (cpu() - t) / m.n;
      if (sink.every(Boolean) !== op.expect) throw new Error(`${m.id}: verdict changed`);
      parentPort.postMessage({ ok: true, ms });
    }
  } catch (e) { parentPort.postMessage({ ok: false, error: e.stack }); }
});
