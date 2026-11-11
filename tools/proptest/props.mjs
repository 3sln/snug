// P4.2 properties. Each property is { id, name, gen(r) -> inputs, check(inputs) -> {failures, stats} }.
// gen is a pure function of the case PRNG (so the watchdog can rebuild the
// inputs of a case that hung); check draws any further randomness from
// inputs.seed2. Inputs hold only JSON-friendly data plus Uint8Arrays.
import { isDeepStrictEqual } from 'node:util';
import { compile as hostCompile, SchemaError as HostSchemaError } from '../../host/js/src/compile.mjs';
import { compile as publicCompile, SchemaError as PublicSchemaError } from '../../host/js/src/public-compile.mjs';
import { Program, Schema, ProgramError, fromSerialized, fromProgram } from '../../host/js/src/public-schema.mjs';
import { Program as HostProgram, Schema as HostSchema } from '../../host/js/src/schema.mjs';
import { serializeProgram } from '../../host/js/src/serialized.mjs';
import { encode, decode, SnugFault, Decimal, NDArray, Float16Bytes } from '../../host/js/src/index.mjs';
import { build } from '../../host/js/src/build.mjs';
import { Writer } from '../../host/js/src/writer.mjs';
import { typedInfo } from '../../host/js/src/values.mjs';
import { view } from '../../host/js/src/view.mjs';
import { codecTop } from '../../host/js/src/profiles.mjs';
import { scanBuffer, scanHandleSync, bufferHandle, pushScanner, SourceError, validateHandleSync, pushValidator } from '../../host/js/src/sources.mjs';
import { tables as unicodeTables } from '../../host/js/src/unicode-tables.mjs';
import * as baseline from '../../bench/baseline/cbor-3sln.mjs';
import { compile as oracleCompile, check as pegCheck, decode as pegDecode } from '../../corpus/tools/peg-oracle.mjs';
// P8.5 (D279): the independent PEG oracle (the default literal RFC cut) replaces D022's existential
// oracle; it reads the bytes with its own decoder (kind, width and tags kept)
const oracleCheck = (o, rule, bytes) => { try { return pegCheck(o, rule, pegDecode(bytes)); } catch { return 'unknown'; } };
import { translate } from '../../host/js/test/values.mjs';
import * as G from './gen.mjs';
import { minimize, byteCandidates, textCandidates, valueCandidates } from './shrink.mjs';

export const hex = b => Buffer.from(b).toString('hex');
export const unhex = h => Uint8Array.from(Buffer.from(h, 'hex'));
const MAX_SAFE_N = BigInt(Number.MAX_SAFE_INTEGER);
const errInfo = e => e == null ? null : { name: e.name ?? typeof e, code: e.code, reason: e.reason, message: String(e.message ?? e).split('\n')[0].slice(0, 300) };
const short = s => (typeof s === 'string' ? s : hex(s)).slice(0, 4000);

/** JSON-friendly description of a host value. */
export function describe(v) {
  if (typeof v === 'bigint') return { $big: v.toString() };
  if (typeof v === 'number' && !Number.isFinite(v)) return { $num: String(v) };
  if (Object.is(v, -0)) return { $num: '-0' };
  if (v instanceof Uint8Array && v.constructor === Uint8Array) return { $bytes: hex(v) };
  if (v instanceof Decimal) return { $decimal: v.toString() };
  if (v instanceof Float16Bytes) return { $f16bytes: hex(v.bytes) };
  if (v instanceof NDArray) return { $nd: v.shape, data: describe(v.data) };
  if (ArrayBuffer.isView(v)) return { $typed: v.constructor.name, hex: hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (Array.isArray(v)) return v.map(describe);
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [describe(k), describe(x)]) };
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = describe(v[k]); return Object.getPrototypeOf(v) === null ? o : { $plain: o }; }
  return v;
}

function compileSync(text, opts = {}) {
  const { program, pool } = hostCompile(text, opts);
  return new Schema(new Program(program, pool));
}
const ANY = compileSync('r = any');
const MAPANY = compileSync('r = { * tstr => any }');

function normalise(v) {
  if (typeof v === 'bigint') return v >= -MAX_SAFE_N && v <= MAX_SAFE_N ? Number(v) : v;
  if (Array.isArray(v)) return v.map(normalise);
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, normalise(x)]));
  if (v instanceof NDArray) return new NDArray([...v.shape], Array.isArray(v.data) ? v.data.map(normalise) : v.data);
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && !(v instanceof Decimal) && !(v instanceof Float16Bytes)) {
    const o = Object.create(null);
    for (const k of Object.keys(v)) Object.defineProperty(o, k, { value: normalise(v[k]), enumerable: true, writable: true, configurable: true });
    return o;
  }
  return v;
}

/** The Writer's typed calls (writer.test.mjs's drive). */
function drive(w, v, order, r) {
  switch (typeof v) {
    case 'number': return Number.isSafeInteger(v) && !Object.is(v, -0) ? w.int(v) : w.float(v);
    case 'bigint': return r.chance(0.5) ? w.bigint(v) : w.int(v);
    case 'string': return w.text(v);
    case 'boolean': return w.bool(v);
  }
  if (v === null) return w.null();
  if (v instanceof Uint8Array && v.constructor === Uint8Array) return w.bytes(v);
  if (typedInfo(v)) return w.typed(v);
  if (v instanceof Decimal) return w.decimal(v);
  if (v instanceof NDArray) return w.ndarray(v);
  if (Array.isArray(v)) { w.beginArray(v.length); for (const x of v) drive(w, x, order, r); return w.end(); }
  let entries = v instanceof Map ? [...v] : Object.keys(v).map(k => [k, v[k]]);
  const keyBytes = k => encode(k, { top: 'any' });
  if (order === 'sorted') entries.sort((a, b) => Buffer.compare(Buffer.from(keyBytes(a[0])), Buffer.from(keyBytes(b[0]))));
  else if (order === 'shuffled') entries = r.shuffle(entries);
  w.beginMap(entries.length);
  for (const [k, x] of entries) { w.key(k); drive(w, x, order, r); }
  return w.end();
}

const attempt = f => { try { return { ok: true, value: f() }; } catch (e) { return { ok: false, error: e }; } };
const codeOf = res => res.ok ? 'ok' : (res.error instanceof SnugFault || res.error instanceof baseline.CBORFault) ? res.error.code : `throw:${res.error?.name}:${String(res.error?.message).slice(0, 80)}`;
const sameResult = (a, b, shift = 0) => a.ok === b.ok && (a.ok || (a.reason === b.reason && isDeepStrictEqual(a.path, b.path) && a.offset === b.offset + shift && a.subcode === b.subcode));
const validShape = res => res && typeof res === 'object' && (res.ok === true ? Object.keys(res).length === 1 :
  res.ok === false && typeof res.reason === 'string' && Array.isArray(res.path) && Number.isInteger(res.offset));

function budgetCheck(schema, rule, bytes, budget, full) {
  // out[3] (budget units used) never exceeds the budget; a run the budget did not stop answers the full verdict.
  const P = schema.program.P, hp = new HostProgram(P, schema.program.B);
  const idx = hp.ruleIndex(rule), o = hp.run(idx, bytes, { top: 'any', budget });
  if (o[3] > budget) return `units used ${o[3]} > budget ${budget}`;
  if (o[0] !== 48) {
    const res = hp.result(o);
    if (!sameResult(res, full)) return `budget ${budget} run answered ${JSON.stringify(res)} but the unbudgeted run ${JSON.stringify(full)}`;
  }
  return null;
}

const hosts = new WeakMap();
const hostOf = s => { let h = hosts.get(s); if (!h) { h = new HostSchema(new HostProgram(s.program.P, s.program.B)); hosts.set(s, h); } return h; };

// ======================================================================== P1 schema x value
const P1 = {
  id: 1, name: 'schema-value',
  gen(r) {
    const p = r.next();
    let src, text, unicode = false, entries = [], uni = null;
    const push = (v, kind, rule = 'r') => { try { entries.push({ bytes: encode(v, { top: 'any' }), kind, rule }); } catch { /* not encodable */ } };
    if (p < 0.45) {
      const s = G.typedSchema(r, { unicode: r.chance(0.25), depth: 1 + r.int(4) });
      src = 'typed'; text = s.text; unicode = s.unicode;
      for (const { v, kind } of G.valuesFor(r, s.sample, 6 + r.int(8))) push(v, kind);
      for (const name of s.rules.slice(1)) if (s.samplers[name] && r.chance(0.5)) for (const { v, kind } of G.valuesFor(r, s.samplers[name], 2)) push(v, kind, name);
    } else if (p < 0.65) {
      const s = G.oracleGenSchema(r, 8);
      src = 'oracle-gen'; text = s.text;
      for (const v of s.values) { push(v, 'oracle-gen'); if (r.chance(0.4)) push(G.nearMiss(r, v), 'near'); }
    } else if (p < 0.8) {
      const s = r.pick(G.corpusSuites);
      src = 'corpus'; text = s.cddl;
      for (const c of s.cases) {
        if (!c.hex) continue;
        const bytes = unhex(c.hex);
        entries.push({ bytes, kind: 'corpus', rule: c.rule ?? 'r' });
        let v; try { v = decode(bytes, { top: 'any' }); } catch { continue; }
        if (r.chance(0.6)) push(G.nearMiss(r, v), 'near', c.rule ?? 'r');
      }
    } else if (p < 0.9) {
      const s = G.unicodeSchema(r);
      src = 'unicode'; text = s.text; unicode = true; uni = { shape: s.shape, pat: s.pat };
      for (let i = 0; i < 8; i++) push(r.chance(0.85) ? s.sample() : G.randomValue(r, { maxDepth: 1 }), 'unicode');
    } else {
      src = 'fuzz'; text = G.fuzzText(r); unicode = r.chance(0.3);
      for (let i = 0; i < 6; i++) push(G.randomValue(r, { maxDepth: 3 }), 'random');
    }
    const limits = r.chance(0.05) ? { [r.pick(['budget', 'depth', 'items', 'entries', 'inputBytes', 'leaves'])]: r.pick([0, 1, 2, 8, 64, 1000]) } : {};
    const vopts = r.chance(0.08) ? { [r.pick(['maxDepth', 'maxItems', 'maxEntries', 'budget'])]: r.int(6) } : {};
    return { src, text, unicode, uni, entries, limits, vopts, seed2: r.int(0x7fffffff) + 1 };
  },
  check(inp) {
    const F = [], st = { cases: 0, compiled: 0, refused: 0, values: 0, oracle: 0, oracleUnknown: 0, decode: 0, spans: 0, budget: 0, unicodeEval: 0 };
    const r = G.createRandom(inp.seed2);
    const copts = { limits: inp.limits, ...(inp.unicode ? { unicode: unicodeTables } : {}) };
    st.cases = 1;
    let schema;
    try { schema = compileSync(inp.text, copts); }
    catch (e) {
      if (e instanceof HostSchemaError) {
        st.refused = 1;
        if (e.code === 'internal') F.push({ cls: 'compile-internal', detail: 'compiler answered internal', actual: errInfo(e), repro: { text: inp.text, limits: inp.limits, unicode: inp.unicode } });
        return { failures: F, stats: st };
      }
      F.push({ cls: 'compile-crash', detail: 'compile threw a non-SchemaError', actual: errInfo(e), repro: { text: short(inp.text), limits: inp.limits, unicode: inp.unicode },
        shrink: { kind: 'text', input: inp.text, pred: t => { try { compileSync(t, copts); return false; } catch (x) { return !(x instanceof HostSchemaError); } } } });
      return { failures: F, stats: st };
    }
    st.compiled = 1;
    // Unicode tables change only the source key of a schema without \p.
    if (inp.unicode && typeof inp.text === 'string' && !/\\[pP]/.test(inp.text) && r.chance(0.3)) {
      try {
        const a = hostCompile(inp.text, { limits: inp.limits }).program, b = schema.program.P;
        const diff = a.length !== b.length || a.some((w, i) => w !== b[i] && !(i >= 7 && i <= 14));
        if (diff) F.push({ cls: 'unicode-tables-change-program', detail: 'tables changed Program words outside the source key', repro: { text: inp.text } });
      } catch (e) { F.push({ cls: 'unicode-tables-change-verdict', detail: 'compiles with tables, refused without', actual: errInfo(e), repro: { text: inp.text } }); }
    }
    const rules = schema.program.rules;
    // The oracle is exponential by design: hostile texts (thousands of rules) take it seconds to exhaust its budget.
    const osch = typeof inp.text === 'string' && inp.text.length <= 1500 && !Object.keys(inp.limits).length ? oracleCompile(inp.text) : { error: 'skipped' };
    const plainOpts = !Object.keys(inp.vopts).length && !Object.keys(inp.limits).length;
    const uniEval = inp.uni ? G.unicodeEvaluator(inp.uni.shape, inp.uni.pat) : null;
    for (const e of inp.entries) {
      if (!rules.includes(e.rule)) continue;
      st.values++;
      const { bytes, rule } = e;
      const repro = { text: short(inp.text), rule, bytes: hex(bytes), kind: e.kind, vopts: inp.vopts, limits: inp.limits, unicode: inp.unicode };
      let res;
      try { res = schema.validate(bytes, rule, inp.vopts); }
      catch (x) { F.push({ cls: 'validate-throw', detail: 'validate threw', actual: errInfo(x), repro }); continue; }
      if (!validShape(res)) { F.push({ cls: 'validate-shape', detail: 'malformed ValidationResult', actual: res, repro }); continue; }
      // the profile's verdict: snug's own scanner under the options validate ran with (the default wire preset,
      // `valid` since P8.4), any root; the oracle's values: cbor.mjs's decode (the Bindle subset) when it accepts
      let bval, bcode, bindleCode;
      try { scanBuffer(bytes, { ...inp.vopts, top: 'any' }); } catch (x) { bcode = x.code; }
      try { bval = baseline.decode(bytes, { top: 'any' }); } catch (x) { bindleCode = x.code; }
      if (bcode !== undefined && plainOpts) {
        if (res.ok || res.reason !== 'cbor/' + bcode) F.push({ cls: 'profile-precedence', detail: 'a profile refusal must be the reason (D023)', expected: 'cbor/' + bcode, actual: res, repro });
      } else if (bcode === undefined && bindleCode === undefined && plainOpts && !osch.error && res.reason !== 'budget') {
        // the oracle decides deterministic data (its `.cbor` reads deterministic content): held to the
        // deterministic preset's verdict
        const o = oracleCheck(osch, rule, bytes);
        if (typeof o === 'boolean') {
          st.oracle++;
          const resD = schema.validate(bytes, rule, { wire: 'deterministic' });
          if (resD.reason !== 'budget' && o !== resD.ok) F.push(p1Mismatch(inp, rule, bytes, o, resD, copts, repro));
        } else st.oracleUnknown++;
      }
      if (uniEval && bcode === undefined && bindleCode === undefined && plainOpts && res.reason !== 'budget') {
        st.unicodeEval++;
        const want = uniEval(decode(bytes, { top: 'any' }));
        if (want !== res.ok) F.push({ cls: 'unicode-mismatch', detail: 'verdict differs from a JS /u RegExp over Node ICU', expected: want, actual: res, repro: { ...repro, value: describe(decode(bytes, { top: 'any' })) } });
      }
      // validate ok <=> schema.decode succeeds; same value / same witness
      st.decode++;
      const d = attempt(() => schema.decode(bytes, rule, inp.vopts));
      if (res.ok) {
        if (!d.ok) F.push({ cls: 'decode-mismatch', detail: 'validate ok but schema.decode threw', actual: errInfo(d.error), repro });
        else { const want = attempt(() => decode(bytes, { top: 'any', ...inp.vopts })); if (want.ok && !isDeepStrictEqual(d.value, want.value)) F.push({ cls: 'decode-value', detail: 'schema.decode value differs from decode()', repro }); }
      } else if (d.ok) F.push({ cls: 'decode-mismatch', detail: 'validate refused but schema.decode returned', expected: res, repro });
      else if (!(d.error instanceof SnugFault) || d.error.reason !== res.reason || !isDeepStrictEqual(d.error.path, res.path) || d.error.offset !== res.offset)
        F.push({ cls: 'decode-witness', detail: 'schema.decode fault differs from the validate witness', expected: res, actual: { ...errInfo(d.error), path: d.error.path, offset: d.error.offset }, repro });
      // the resumable session through a handle and a push source
      if (r.chance(0.4)) {
        st.sessions = (st.sessions ?? 0) + 1;
        const hs = hostOf(schema), src = randomSource(r);
        const m = sessionCheck(hs, bytes, rule, inp.vopts, src);
        if (m) F.push({ cls: 'session-verdict', detail: 'resumable session (handle / push) differs from Schema.validate', actual: m, repro: { ...repro, source: src },
          shrink: { kind: 'bytes', input: bytes, pred: x => !!sessionCheck(hs, x, rule, inp.vopts, src) } });
      }
      // budget truncation
      if (r.chance(0.3) && !Object.keys(inp.vopts).length) {
        st.budget++;
        const full = schema.validate(bytes, rule);
        const b = r.pick([0, 1, 2, 5, 17, 100, 1000, 20000]);
        const m = budgetCheck(schema, rule, bytes, b, full);
        if (m) F.push({ cls: 'budget', detail: m, repro: { ...repro, budget: b } });
      }
      // validateAt over subtree spans == standalone validation of the span
      if (bcode === undefined && !Object.keys(inp.vopts).length) {
        let tree; try { tree = G.items(bytes); } catch { tree = null; }
        if (tree) {
          const spans = [tree.list[0], ...Array.from({ length: Math.min(3, tree.list.length - 1) }, () => tree.list[1 + r.int(tree.list.length - 1)])];
          for (const it of spans) {
            const rl = r.chance(0.5) ? rule : r.pick(rules);
            const slice = bytes.slice(it.at, it.end);
            st.spans++;
            let a, b;
            try { a = schema.validateAt(bytes, it.at, it.end, rl); b = schema.validate(slice, rl); }
            catch (x) { F.push({ cls: 'validateAt-throw', actual: errInfo(x), repro: { ...repro, span: [it.at, it.end], spanRule: rl } }); continue; }
            if (!sameResult(a, b, it.at)) F.push({ cls: 'validateAt-mismatch', detail: 'validateAt(span) differs from validate(slice) (offsets shifted)', expected: b, actual: a, repro: { ...repro, span: [it.at, it.end], spanRule: rl } });
            const bs = attempt(() => baseline.decode(slice, { top: 'any' }));
            if (!osch.error && plainOpts && a.reason !== 'budget' && bs.ok) {
              const o = oracleCheck(osch, rl, slice);
              const aD = schema.validateAt(bytes, it.at, it.end, rl, { wire: 'deterministic' });
              if (typeof o === 'boolean' && aD.reason !== 'budget') { st.oracle++; if (o !== aD.ok) F.push(p1Mismatch(inp, rl, slice, o, aD, copts, { ...repro, rule: rl, bytes: hex(slice), viaSpan: [it.at, it.end] })); }
            }
          }
        }
      }
    }
    return { failures: F, stats: st };
  },
};

function p1Mismatch(inp, rule, bytes, oracleVerdict, res, copts, repro) {
  const dir = `${oracleVerdict ? 'oracle-accepts' : 'oracle-refuses'}/${res.ok ? 'ok' : res.reason}`;
  const fails = (text, b) => {
    let s; try { s = compileSync(text, copts); } catch { return false; }
    if (!s.program.rules.includes(rule)) return false;
    const o = oracleCompile(text); if (o.error) return false;
    let v; try { v = baseline.decode(b, { top: 'any' }); } catch { return false; }
    const ov = oracleCheck(o, rule, b), sv = s.validate(b, rule, { wire: 'deterministic' });
    return typeof ov === 'boolean' && ov === oracleVerdict && sv.ok === res.ok && (sv.ok || sv.reason === res.reason);
  };
  return {
    cls: 'oracle-mismatch', sub: dir, detail: 'snug verdict differs from corpus/tools/peg-oracle.mjs', expected: { oracle: oracleVerdict }, actual: res,
    repro: { ...repro, value: describe(decode(bytes, { top: 'any' })) },
    shrink: {
      kind: 'text+value', text: inp.text, bytes,
      run() {
        const t = minimize(inp.text, textCandidates, x => fails(x, bytes), { ms: 6000 }).value;
        const v0 = decode(bytes, { top: 'any' });
        const v = minimize(v0, valueCandidates, x => { let b; try { b = encode(x, { top: 'any' }); } catch { return false; } return fails(t, b); }, { ms: 4000 }).value;
        const b = encode(v, { top: 'any' });
        return { text: t, rule, bytes: hex(b), value: describe(v), stillFails: fails(t, b) };
      },
    },
  };
}

// ======================================================================== P2 codec
const P2 = {
  id: 2, name: 'codec',
  gen(r) {
    const cose = r.chance(0.1);
    let v = r.chance(0.5) ? G.randomMap(r, { maxDepth: 1 + r.int(5) }) : G.randomValue(r, { maxDepth: 1 + r.int(5) });
    if (cose) v = new Map([[1, v], [-1, r.int(100)], [r.int(30) - 15, G.randomValue(r, { maxDepth: 2 })], ['text', 'x']]);
    const eopts = cose ? { cose: true } : {};
    const dopts = { ...G.randomOptions(r), ...(cose ? { cose: true } : {}) };
    return { v, eopts, dopts, order: r.pick(['given', 'sorted', 'shuffled']), seed2: r.int(0x7fffffff) + 1, mutations: 10 };
  },
  check(inp) {
    const F = [], st = { cases: 1, encodes: 0, roundtrips: 0, mutations: 0, mutAccepted: 0, mutRefused: 0, structural: 0 };
    const r = G.createRandom(inp.seed2);
    const { v, eopts } = inp;
    const repro = { value: describe(v), eopts, order: inp.order };
    const e1 = attempt(() => encode(v, eopts));
    const e3 = attempt(() => baseline.encode(translate(v, baseline), eopts));
    const ew = attempt(() => { const w = new Writer({ ...eopts, keysSorted: inp.order === 'sorted' }); drive(w, v, inp.order, r); return w.finish(); });
    const evv = attempt(() => new Writer(eopts).value(v).finish());
    st.encodes++;
    const c1 = e1.ok ? hex(e1.value) : codeOf(e1), c3 = e3.ok ? hex(e3.value) : codeOf(e3), cw = ew.ok ? hex(ew.value) : codeOf(ew), cv = evv.ok ? hex(evv.value) : codeOf(evv);
    if (c1 !== c3 || c1 !== cw || c1 !== cv) F.push({ cls: 'encode-mismatch', detail: 'encode / cbor.mjs / Writer typed calls / Writer.value disagree', actual: { encode: c1, baseline: c3, writerTyped: cw, writerValue: cv }, repro,
      shrink: { kind: 'value', input: v, pred: x => { const a = attempt(() => encode(x, eopts)), b = attempt(() => baseline.encode(translate(x, baseline), eopts)); return (a.ok ? hex(a.value) : codeOf(a)) !== (b.ok ? hex(b.value) : codeOf(b)); } } });
    if (!e1.ok) return { failures: F, stats: st };
    const bytes = e1.value;
    // decode(encode(v)) == v modulo documented normalisation; == cbor.mjs's decode; re-encodes identically
    st.roundtrips++;
    const dd = { top: 'any', ...(eopts.cose ? { cose: true } : {}) };
    const d = attempt(() => decode(bytes, dd));
    if (!d.ok) F.push({ cls: 'roundtrip-refused', detail: 'decode refused encode output', actual: errInfo(d.error), repro: { ...repro, bytes: hex(bytes) } });
    else {
      const b = attempt(() => translate(baseline.decode(bytes, dd)));
      if (!b.ok || !isDeepStrictEqual(d.value, b.value)) F.push({ cls: 'roundtrip-baseline', detail: 'decode differs from cbor.mjs decode', repro: { ...repro, bytes: hex(bytes) } });
      if (!isDeepStrictEqual(d.value, normalise(v))) F.push({ cls: 'roundtrip-value', detail: 'decode(encode(v)) differs from normalise(v)', actual: describe(d.value), repro: { ...repro, bytes: hex(bytes) } });
      const re = attempt(() => encode(d.value, eopts));
      if (!re.ok || hex(re.value) !== hex(bytes)) F.push({ cls: 'roundtrip-reencode', detail: 'encode(decode(b)) != b', actual: re.ok ? hex(re.value) : codeOf(re), repro: { ...repro, bytes: hex(bytes) } });
      const plain = attempt(() => decode(bytes, { ...dd, objects: 'plain' }));
      if (!plain.ok || hex(encode(plain.value, eopts)) !== hex(bytes)) F.push({ cls: 'roundtrip-plain', detail: "objects: 'plain' decode does not re-encode identically", repro: { ...repro, bytes: hex(bytes) } });
    }
    // mutations: refuse with cbor.mjs's code, or accept and re-encode identically
    for (let j = 0; j < inp.mutations; j++) {
      let m, kind = 'byte';
      if (r.chance(0.5)) { const s = G.structuralMutation(r, bytes); if (s) { m = s.bytes; kind = s.kind; st.structural++; } }
      if (!m) m = G.mutateOnce(r, bytes);
      const dopts = r.chance(0.5) ? inp.dopts : dd;
      st.mutations++;
      F.push(...mutationCheck(m, dopts, kind, repro, st));
    }
    return { failures: F, stats: st };
  },
};

// cbor.mjs is the Bindle profile's arbiter: snug under `wire: 'bindle'` and the same root and limits answers as it
// does. The default (`valid`, P8.4) is held to properties instead: it accepts what the Bindle profile accepts with the
// same value, its values re-encode deterministically and decode again to themselves, and the entry points agree.
const bindleOf = dopts => ({ ...dopts, wire: 'bindle' });
export function mutationVerdicts(m, dopts) {
  const sn = attempt(() => decode(m, bindleOf(dopts)));
  const bs = attempt(() => baseline.decode(m, dopts));
  return { sn, bs, csn: codeOf(sn), cbs: codeOf(bs) };
}
function mutationCheck(m, dopts, kind, repro, st) {
  const F = [];
  const { sn, csn, cbs } = mutationVerdicts(m, dopts);
  const rp = { ...repro, mutated: hex(m), mutation: kind, dopts };
  const sig = (x) => { const v = mutationVerdicts(x, dopts); return `${v.csn}|${v.cbs}`; };
  if (!sn.ok && !(sn.error instanceof SnugFault)) F.push({ cls: 'decode-throw-type', detail: 'decode threw a non-SnugFault', actual: errInfo(sn.error), repro: rp,
    shrink: { kind: 'bytes', input: m, pred: x => { const a = attempt(() => decode(x, dopts)); return !a.ok && !(a.error instanceof SnugFault); } } });
  if (csn !== cbs) {
    const want = `${csn}|${cbs}`;
    F.push({ cls: 'mutation-verdict', sub: `${csn === 'ok' ? 'ok' : 'code'}-vs-${cbs === 'ok' ? 'ok' : 'code'}`, detail: "wire: 'bindle' decode verdict differs from cbor.mjs", expected: cbs, actual: csn, repro: rp,
      shrink: { kind: 'bytes', input: m, pred: x => sig(x) === want } });
  }
  if (sn.ok) {
    st.mutAccepted++;
    const re = attempt(() => encode(sn.value, { wire: 'bindle', cose: dopts.cose === true, strictArrays: false }));
    if (!re.ok || hex(re.value) !== hex(m)) F.push({ cls: 'mutation-reencode', detail: 'a mutation the Bindle profile accepts does not re-encode to the same bytes', actual: re.ok ? hex(re.value) : codeOf(re), repro: rp });
  } else st.mutRefused++;
  // the default (valid) preset: a superset of the Bindle profile's acceptance (any root where Bindle wants a map)
  // with the same values; its values re-encode deterministically and decode to themselves (bytes may differ: an
  // integral float reads as a JS number, D123)
  const dv = attempt(() => decode(m, dopts));
  if (sn.ok && (!dv.ok || !isDeepStrictEqual(dv.value, sn.value)))
    F.push({ cls: 'valid-superset', detail: 'the default refuses, or reads differently, what the Bindle profile accepts', actual: dv.ok ? describe(dv.value) : codeOf(dv), repro: rp });
  if (dv.ok) {
    const re2 = attempt(() => encode(dv.value, { cose: dopts.cose === true }));
    const back = re2.ok ? attempt(() => decode(re2.value, dopts)) : re2;
    if (!back.ok || !isDeepStrictEqual(back.value, dv.value))
      F.push({ cls: 'valid-roundtrip', detail: 'a default-accepted value does not re-encode and decode to itself', actual: back.ok ? describe(back.value) : codeOf(back), repro: rp });
  }
  // the other entry points agree with decode under the default (decode alone refuses two keys one JS key: unsupported)
  const csnD = codeOf(dv) === 'unsupported' ? 'ok' : codeOf(dv);
  const sc = attempt(() => scanBuffer(m, dopts)), cs = codeOf(sc) === 'ok' ? 'ok' : codeOf(sc);
  const vw = attempt(() => view(m, dopts)), cv = vw.ok ? 'ok' : codeOf(vw);
  const an = attempt(() => ANY.validate(m, 'r', { ...dopts, top: dopts.top ?? codecTop(dopts) }));
  const ca = !an.ok ? codeOf(an) : an.value.ok ? 'ok' : an.value.reason.startsWith('cbor/') ? an.value.reason.slice(5) : 'schema/' + an.value.reason;
  if (cs !== csnD || cv !== csnD || ca !== csnD) F.push({ cls: 'entrypoint-verdict', detail: 'scanBuffer / view / any-schema validate disagree with decode', actual: { decode: csnD, scanBuffer: cs, view: cv, anySchema: ca }, repro: rp,
    shrink: { kind: 'bytes', input: m, pred: x => {
      const d0 = codeOf(attempt(() => decode(x, dopts))), d = d0 === 'unsupported' ? 'ok' : d0, s = codeOf(attempt(() => scanBuffer(x, dopts))), w = attempt(() => view(x, dopts));
      const a = attempt(() => ANY.validate(x, 'r', { ...dopts, top: dopts.top ?? codecTop(dopts) }));
      const aa = !a.ok ? codeOf(a) : a.value.ok ? 'ok' : a.value.reason.replace(/^cbor\//, '');
      return s !== d || (w.ok ? 'ok' : codeOf(w)) !== d || aa !== d;
    } } });
  return F;
}

// ======================================================================== P3 views
const MODES = [{}, { directories: true }, { borrow: true }, { borrow: true, directories: true }];
function walkView(v, cose, errs, offs, path = '') {
  offs.push(`${path}@${v.offset}:${v.kind}:${v.length}`);
  switch (v.kind) {
    case 'int': { const i = v.int(); if (BigInt(i) !== v.bigint()) errs.push(`${path}: int/bigint`); if (typeof i === 'number' && v.number() !== i) errs.push(`${path}: number`); return i; }
    case 'float': return v.number();
    case 'text': { const t = v.text(); if (v.length !== new TextEncoder().encode(t).length) errs.push(`${path}: text length`); return t; }
    case 'bytes': { const a = v.bytes(), c = v.copyBytes(); if (!isDeepStrictEqual(c, Uint8Array.from(a)) || v.length !== c.length) errs.push(`${path}: bytes`); return c; }
    case 'bool': return v.bool();
    case 'null': if (!v.isNull()) errs.push(`${path}: isNull`); return null;
    case 'array': {
      const out = [];
      for (const [i, e] of v.entries()) { const a = v.at(i); if (!a || a.offset !== e.offset) errs.push(`${path}[${i}]: at() vs entries()`); out.push(walkView(e, false, errs, offs, `${path}[${i}]`)); }
      if (out.length !== v.length) errs.push(`${path}: array length`);
      if (v.at(v.length) !== undefined || v.at(-1) !== undefined) errs.push(`${path}: at() out of range`);
      return out;
    }
    case 'map': {
      const out = cose ? new Map() : Object.create(null);
      let n = 0;
      for (const [k, e] of v.entries()) {
        const g = v.get(k);
        if (!g || g.offset !== e.offset) errs.push(`${path}.${String(k)}: get() vs entries()`);
        const x = walkView(e, false, errs, offs, `${path}.${typeof k === 'string' ? JSON.stringify(k) : String(k)}`);
        if (cose) out.set(k, x); else Object.defineProperty(out, k, { value: x, enumerable: true, writable: true, configurable: true });
        n++;
      }
      if (n !== v.length) errs.push(`${path}: map length`);
      if (v.get('\u0000absent￯') !== undefined) errs.push(`${path}: absent key found`);
      return out;
    }
    case 'typed': { const t = v.typed(), tv = v.typedView(); if (tv.length !== t.length || v.length !== t.length) errs.push(`${path}: typed length`);
      if (!(t instanceof Float16Bytes)) for (let i = 0; i < t.length; i++) if (!Object.is(tv.get(i), t[i])) { errs.push(`${path}: typedView(${i})`); break; }
      return t; }
    case 'decimal': return v.decimal();
    case 'ndarray': return v.ndarray();
    default: errs.push(`${path}: kind ${v.kind}`); return undefined;
  }
}
function cursorWalk(v, errs) {
  const c = v.cursor(), offs = [];
  const rec = (path) => {
    offs.push(`${c.offset}:${c.kind}`);
    if ((c.kind === 'array' || c.kind === 'map') && c.enter()) {
      const keys = [];
      do {
        keys.push(c.key);
        if (c.kind === undefined) errs.push(`${path}: cursor kind undefined`);
        rec(`${path}/${String(c.key)}`);
      } while (c.next());
      if (!c.up()) errs.push(`${path}: up() failed`);
      const want = [...c.view().keys()];
      if (!isDeepStrictEqual(keys, want)) errs.push(`${path}: cursor keys differ from keys()`);
      if (c.kind === 'map') for (const k of want) {
        const cc = c.view().cursor();
        if (typeof k === 'string') {
          if (!cc.find(k) || cc.offset !== c.view().get(k).offset) errs.push(`${path}: find(${JSON.stringify(k)})`);
        }
      }
    }
  };
  rec('');
  return offs;
}
let typedCache = null;
const P3 = {
  id: 3, name: 'views',
  gen(r) {
    const p = r.next();
    let v, schemaText = null, cose = false, unicode = false;
    if (p < 0.35) v = G.randomMap(r, { maxDepth: 2 + r.int(5) });
    else if (p < 0.6) v = G.randomValue(r, { maxDepth: 2 + r.int(5) });
    else if (p < 0.75) { v = Object.create(null); for (let i = 8 + r.int(60); i > 0; i--) v['k' + r.int(1000)] = r.chance(0.5) ? r.int(100) : Array.from({ length: r.int(20) }, () => G.randomValue(r, { maxDepth: 1 })); }
    else if (p < 0.82) { cose = true; v = new Map([[1, G.randomValue(r, { maxDepth: 2 })], [-7, 'x'], [r.int(100), G.randomValue(r, { maxDepth: 2 })], ['t', 1]]); }
    else { const s = G.typedSchema(r, { depth: 2 + r.int(3) }); schemaText = s.text; unicode = s.unicode; try { v = r.chance(0.6) ? s.sample() : G.nearMiss(r, s.sample()); } catch { v = {}; } }
    let bytes; try { bytes = encode(v, cose ? { cose: true } : {}); } catch { bytes = encode({ fallback: 1 }); }
    return { bytes, cose, schemaText, unicode, seed2: r.int(0x7fffffff) + 1 };
  },
  check(inp) {
    const F = [], st = { cases: 1, modes: 0, nodes: 0, subtrees: 0, schemaViews: 0, spans: 0 };
    const r = G.createRandom(inp.seed2);
    const { bytes, cose } = inp;
    const repro = { bytes: hex(bytes), cose, schema: inp.schemaText };
    const opts = { top: 'any', ...(cose ? { cose: true } : {}) };
    let want;
    try { want = decode(bytes, opts); } catch (e) { F.push({ cls: 'decode-refused', actual: errInfo(e), repro }); return { failures: F, stats: st }; }
    let offs0 = null, cur0 = null;
    for (const mode of MODES) {
      st.modes++;
      const errs = [], offs = [];
      let v;
      try {
        v = view(bytes, { ...opts, ...mode });
        const got = walkView(v, cose && v.kind === 'map', errs, offs);
        if (!isDeepStrictEqual(got, want)) errs.push('walk differs from decode()');
        if (!isDeepStrictEqual(v.value(), want)) errs.push('value() differs from decode()');
        if (hex(v.raw()) !== hex(bytes)) errs.push('raw() differs from the bytes');
        const cur = cursorWalk(v, errs);
        st.nodes += offs.length;
        if (offs0 === null) { offs0 = offs; cur0 = cur; }
        else {
          if (!isDeepStrictEqual(offs, offs0)) errs.push(`navigation differs from the default mode (${JSON.stringify(mode)})`);
          if (!isDeepStrictEqual(cur, cur0)) errs.push(`cursor walk differs from the default mode (${JSON.stringify(mode)})`);
        }
      } catch (e) { errs.push(`threw ${e.name}: ${String(e.message).slice(0, 120)}`); }
      if (errs.length) F.push({ cls: mode.directories ? 'view-directories' : 'view-walk', detail: errs.slice(0, 8).join('; '), repro: { ...repro, mode } });
    }
    // every subtree's raw span materialises like build()
    try {
      const v = view(bytes, opts), stack = [v];
      while (stack.length) {
        const x = stack.pop(); st.subtrees++;
        const b = attempt(() => build(Uint8Array.from(x.raw()), x === v ? opts : { top: 'any' }));
        if (!b.ok || !isDeepStrictEqual(b.value, x.value())) { F.push({ cls: 'view-subtree', detail: `subtree at ${x.offset} differs from build(raw)`, repro }); break; }
        if (x.kind === 'array' || x.kind === 'map') for (const e of x.values()) if (r.chance(0.5)) stack.push(e);
      }
    } catch (e) { F.push({ cls: 'view-subtree', detail: `threw ${e.name}: ${e.message}`, repro }); }
    // schema-checked opening and detached validation
    if (inp.schemaText) {
      let schema;
      try { schema = compileSync(inp.schemaText, inp.unicode ? { unicode: unicodeTables } : {}); } catch { schema = null; }
      if (schema) {
        st.schemaViews++;
        const whole = schema.validate(bytes, 'r');
        const opened = attempt(() => view(bytes, { schema, rule: 'r', top: 'any' }));
        if (whole.ok !== opened.ok || (!whole.ok && opened.error?.reason !== whole.reason))
          F.push({ cls: 'view-schema-open', detail: 'schema-checked view disagrees with validate', expected: whole, actual: opened.ok ? 'opened' : errInfo(opened.error), repro });
        const v = view(bytes, { top: 'any' }), nodes = [v];
        for (let i = 0; i < nodes.length && i < 40; i++) if (nodes[i].kind === 'array' || nodes[i].kind === 'map') nodes.push(...nodes[i].values());
        for (let k = 0; k < 4; k++) {
          const x = r.pick(nodes), rule = r.pick(schema.program.rules);
          st.spans++;
          const a = attempt(() => x.validateAt(rule, { schema })), b = attempt(() => schema.validate(Uint8Array.from(x.raw()), rule, { top: 'any' }));
          if (!a.ok || !b.ok || !sameResult(a.value, b.value, x.offset))
            F.push({ cls: 'view-validateAt', detail: 'View.validateAt differs from validating the raw span', expected: b.ok ? b.value : errInfo(b.error), actual: a.ok ? a.value : errInfo(a.error), repro: { ...repro, offset: x.offset, rule } });
        }
      }
    }
    return { failures: F, stats: st };
  },
};

// ======================================================================== P4 serialisation
const P4 = {
  id: 4, name: 'serialisation',
  gen(r) {
    const p = r.next();
    let text, unicode = false, values = [];
    if (p < 0.5) { const s = G.typedSchema(r, { unicode: r.chance(0.2), depth: 1 + r.int(4) }); text = s.text; unicode = s.unicode; values = G.valuesFor(r, s.sample, 6).map(x => x.v); }
    else if (p < 0.75) { const s = G.oracleGenSchema(r, 6); text = s.text; values = s.values; }
    else { const s = r.pick(G.corpusSuites); text = s.cddl; values = s.cases.filter(c => c.hex).map(c => attempt(() => decode(unhex(c.hex), { top: 'any' }))).filter(x => x.ok).map(x => x.value); }
    const bytes = [];
    for (const v of values) try { bytes.push(encode(v, { top: 'any' })); } catch { /* skip */ }
    for (let i = 0; i < 2; i++) bytes.push(G.randomBytesCbor(r));
    return { text, unicode, bytes, seed2: r.int(0x7fffffff) + 1, corruptions: 14 };
  },
  async check(inp) {
    const F = [], st = { cases: 1, compiled: 0, roundtrips: 0, validations: 0, corruptions: 0, rehashed: 0, rehashedAccepted: 0, randomFiles: 0 };
    const r = G.createRandom(inp.seed2);
    let schema;
    try { schema = compileSync(inp.text, inp.unicode ? { unicode: unicodeTables } : {}); } catch { return { failures: F, stats: st }; }
    st.compiled = 1;
    const repro = { text: short(inp.text), unicode: inp.unicode };
    const P = schema.program.P, B = schema.program.B, rules = schema.program.rules;
    const ser = schema.program.serialize();
    let s2;
    try { s2 = await fromSerialized(ser); } catch (e) { F.push({ cls: 'roundtrip-refused', actual: errInfo(e), repro }); return { failures: F, stats: st }; }
    st.roundtrips++;
    const p2 = s2.program;
    if (hex(new Uint8Array(p2.P.buffer)) !== hex(new Uint8Array(P.buffer)) || hex(p2.B) !== hex(B) || p2.sourceKey !== schema.program.sourceKey || !isDeepStrictEqual([...p2.rules], [...rules]))
      F.push({ cls: 'roundtrip-program', detail: 'fromSerialized Program differs', repro });
    if (hex(p2.serialize()) !== hex(ser)) F.push({ cls: 'roundtrip-bytes', detail: 'reserialisation differs', repro });
    const s3 = await fromProgram(P, B);
    for (const b of inp.bytes) for (const rule of rules.slice(0, 3)) {
      st.validations++;
      const a = schema.validate(b, rule), c = s2.validate(b, rule), d = s3.validate(b, rule);
      if (!sameResult(a, c) || !sameResult(a, d)) F.push({ cls: 'roundtrip-verdict', detail: 'validation differs after fromSerialized/fromProgram', expected: a, actual: { fromSerialized: c, fromProgram: d }, repro: { ...repro, bytes: hex(b), rule } });
      const da = attempt(() => schema.decode(b, rule)), dc = attempt(() => s2.decode(b, rule));
      if (da.ok !== dc.ok || (da.ok && !isDeepStrictEqual(da.value, dc.value))) F.push({ cls: 'roundtrip-decode', repro: { ...repro, bytes: hex(b), rule } });
    }
    // corruptions of the container: always refused with ProgramError
    for (let k = 0; k < inp.corruptions; k++) {
      const c = Uint8Array.from(ser), how = r.int(5);
      let m = c;
      if (how === 0) { const i = r.int(c.length); c[i] ^= 1 << r.int(8); }
      else if (how === 1) { const i = r.int(c.length); c[i] = (c[i] + 1 + r.int(255)) & 255; }
      else if (how === 2) m = c.subarray(0, r.int(c.length));
      else if (how === 3) m = G.cat(c, Uint8Array.from({ length: 1 + r.int(8) }, () => r.int(256)));
      else { const i = 96 + r.int(Math.max(1, c.length - 96)); c[i] ^= 0x80; }
      st.corruptions++;
      const got = await attemptAsync(() => fromSerialized(m));
      if (got.ok) F.push({ cls: 'corruption-accepted', detail: 'a corrupted container was accepted', repro: { ...repro, how, corrupted: hex(m) } });
      else if (!(got.error instanceof ProgramError)) F.push({ cls: 'corruption-throw-type', actual: errInfo(got.error), repro: { ...repro, how, corrupted: hex(m) } });
    }
    // rehashed corruptions: only vm-verify stands between them and the VM; any it accepts must validate without crashing
    for (let k = 0; k < inp.corruptions; k++) {
      const P2w = Int32Array.from(P), B2 = Uint8Array.from(B);
      const how = r.int(6);
      let words = P2w, pool = B2;
      if (how <= 1) { const i = 16 + r.int(P2w.length - 16); P2w[i] = how === 0 ? P2w[i] + r.pick([-1, 1, 2, -2, 64]) : r.pick([0, -1, 1, 0x7fffffff, -0x80000000, r.int(1 << 16)]); }
      else if (how === 2 && B2.length) { B2[r.int(B2.length)] ^= 1 << r.int(8); }
      else if (how === 3) words = P2w.subarray(0, Math.max(64, P2w.length - 1 - r.int(8)));
      else if (how === 4) words = Int32Array.from([...P2w, ...Array.from({ length: 1 + r.int(4) }, () => r.int(100))]);
      else { const i = r.int(P2w.length), j = r.int(P2w.length); [P2w[i], P2w[j]] = [P2w[j], P2w[i]]; }
      st.rehashed++;
      const file = serializeProgram(words, pool);
      const got = await attemptAsync(() => fromSerialized(file));
      const rp = { ...repro, how, words: hex(new Uint8Array(words.buffer, words.byteOffset, words.byteLength)), pool: hex(pool) };
      if (!got.ok) { if (!(got.error instanceof ProgramError)) F.push({ cls: 'rehashed-throw-type', actual: errInfo(got.error), repro: rp }); continue; }
      st.rehashedAccepted++;
      const s4 = got.value, rules4 = s4.program.rules;
      for (const b of inp.bytes) for (const rule of rules4.slice(0, 2)) {
        const v = attempt(() => s4.validate(b, rule));
        if (!v.ok) { F.push({ cls: 'verified-program-crash', detail: 'a Program vm-verify accepted made validate throw', actual: errInfo(v.error), repro: { ...rp, bytes: hex(b), rule } }); break; }
        if (!validShape(v.value)) F.push({ cls: 'verified-program-shape', actual: v.value, repro: { ...rp, bytes: hex(b), rule } });
        const bud = attempt(() => budgetCheck(s4, rule, b, 500, v.value));
        if (!bud.ok) F.push({ cls: 'verified-program-crash', detail: 'budgeted run threw', actual: errInfo(bud.error), repro: { ...rp, bytes: hex(b), rule } });
        else if (bud.value && /units used/.test(bud.value)) F.push({ cls: 'verified-program-budget', detail: bud.value, repro: { ...rp, bytes: hex(b), rule } });
        const vat = attempt(() => b.length ? s4.validateAt(b, 0, b.length, rule) : null);
        if (!vat.ok) F.push({ cls: 'verified-program-crash', detail: 'validateAt threw', actual: errInfo(vat.error), repro: { ...rp, bytes: hex(b), rule } });
      }
    }
    // random files with a valid header
    for (let k = 0; k < 3; k++) {
      const body = Uint8Array.from({ length: r.int(300) }, () => r.int(256));
      const f = G.cat(ser.subarray(0, r.int(96)), body);
      st.randomFiles++;
      const got = await attemptAsync(() => fromSerialized(f));
      if (got.ok || !(got.error instanceof ProgramError)) F.push({ cls: got.ok ? 'random-file-accepted' : 'random-file-throw-type', actual: got.ok ? 'accepted' : errInfo(got.error), repro: { file: hex(f) } });
    }
    return { failures: F, stats: st };
  },
};
async function attemptAsync(f) { try { return { ok: true, value: await f() }; } catch (e) { return { ok: false, error: e }; } }

// ======================================================================== P5 robustness
const ROBUST_TEXTS = ['r = any', 'r = { * tstr => any }', 'r = [* (uint / tstr / { * tstr => any })]',
  'r = { ? a: tstr .regexp "[a-z]{1,5}", ? b: [* r], * tstr => int }', 'r = #6.40([[+ uint], [* any]]) / #6.<69..86>(bstr) / decfrac / biguint'];
const ROBUST_SCHEMAS = ROBUST_TEXTS.map(t => compileSync(t));
const ROBUST_HOST = new Map(ROBUST_SCHEMAS.map(s => [s, new HostSchema(new HostProgram(s.program.P, s.program.B))]));
const ROBUST_TEXT = new Map(ROBUST_SCHEMAS.map((s, i) => [s, ROBUST_TEXTS[i]]));
const P5 = {
  id: 5, name: 'robustness',
  gen(r) {
    const blobs = [];
    for (let i = 0; i < 6; i++) {
      const p = r.next();
      if (p < 0.4) blobs.push(G.randomBytesCbor(r));
      else { let b; try { b = encode(G.randomValue(r, { maxDepth: 4 }), { top: 'any' }); } catch { b = new Uint8Array(1); } for (let k = 1 + r.int(3); k > 0; k--) { const s = G.structuralMutation(r, b); b = s && r.chance(0.5) ? s.bytes : G.mutateOnce(r, b); } blobs.push(b); }
    }
    const texts = [G.fuzzText(r), G.fuzzText(r)];
    const climits = texts.map(() => r.chance(0.25) ? { [r.pick(['schemaBytes', 'nesting', 'astNodes', 'instantiations', 'alternatives', 'arrayPositions', 'regexpPositions', 'width', 'poolBytes', 'totalBytes', 'compileBudget', 'leaves'])]: r.pick(G.COMPILE_LIMIT_SAMPLE) } : {});
    return { blobs, opts: blobs.map(() => G.randomOptions(r)), texts, climits, profiles: texts.map(() => r.pick(['full', 'full', 'bindle', 'bus'])), unicode: texts.map(() => r.chance(0.4)), seed2: r.int(0x7fffffff) + 1, publicCompile: r.chance(0.1) };
  },
  async check(inp) {
    const F = [], st = { cases: 1, blobs: 0, texts: 0, compiled: 0, refused: 0, pushes: 0, misuse: 0, slowCompile: 0, slowValidate: 0 };
    const r = G.createRandom(inp.seed2);
    for (let i = 0; i < inp.blobs.length; i++) {
      const b = inp.blobs[i], o = inp.opts[i];
      st.blobs++;
      const rp = { bytes: hex(b), opts: o };
      const bad = (api, res, allowed) => { if (!res.ok && !allowed.some(C => res.error instanceof C)) F.push({ cls: 'bad-error-type', sub: api, detail: `${api} threw ${res.error?.name}`, actual: errInfo(res.error), repro: rp }); };
      const d = attempt(() => decode(b, o)); bad('decode', d, [SnugFault]);
      const v = attempt(() => { const x = view(b, o); for (const e of (x.kind === 'map' || x.kind === 'array') ? x.values() : []) e.kind; return x; }); bad('view', v, [SnugFault]);
      const s = attempt(() => scanBuffer(b, o)); bad('scanBuffer', s, [SnugFault]);
      const { chunk, quantum, sizes } = randomSource(r);
      const h = attempt(() => scanHandleSync(bufferHandle(b), o, { chunk, quantum })); bad('scanHandleSync', h, [SnugFault, SourceError]);
      const p = attempt(() => pushRun(b, o, quantum, sizes)); bad('pushScanner', p, [SnugFault, SourceError]);
      st.pushes++;
      const cd = codeOf(d), cs = codeOf(s), ch = h.ok ? 'ok' : codeOf(h), cp = p.ok ? 'ok' : codeOf(p);
      const cv = v.ok ? 'ok' : codeOf(v);
      if (cs !== cd || ch !== cd || cp !== cd || cv !== cd) F.push({ cls: 'source-verdict', detail: 'decode / scanBuffer / scanHandleSync / pushScanner / view disagree', actual: { decode: cd, scanBuffer: cs, handle: ch, push: cp, view: cv }, repro: { ...rp, chunk, quantum, pushSizes: sizes },
        shrink: { kind: 'bytes', input: b, pred: x => { const a = codeOf(attempt(() => decode(x, o))); const hh = attempt(() => scanHandleSync(bufferHandle(x), o, { chunk, quantum })), pp = attempt(() => pushRun(x, o, quantum, sizes));
          return (hh.ok ? 'ok' : codeOf(hh)) !== a || (pp.ok ? 'ok' : codeOf(pp)) !== a || codeOf(attempt(() => scanBuffer(x, o))) !== a; } } });
      for (const sch of ROBUST_SCHEMAS) {
        const t0 = performance.now();
        const val = attempt(() => sch.validate(b, 'r', o));
        const ms = performance.now() - t0;
        if (!val.ok) F.push({ cls: 'bad-error-type', sub: 'validate', actual: errInfo(val.error), repro: rp });
        else if (!validShape(val.value)) F.push({ cls: 'validate-shape', actual: val.value, repro: rp });
        if (ms > 2000) { st.slowValidate++; F.push({ cls: 'slow-validate', detail: `${ms.toFixed(0)} ms`, repro: rp }); }
        const dec = attempt(() => sch.decode(b, 'r', o)); bad('schema.decode', dec, [SnugFault]);
        if (r.chance(0.3)) {
          st.sessions = (st.sessions ?? 0) + 1;
          const hs = ROBUST_HOST.get(sch), src = randomSource(r), so = { ...o, top: o.top ?? 'any' };
          const m = sessionCheck(hs, b, 'r', so, src);
          if (m) F.push({ cls: 'session-verdict', detail: 'resumable session (handle / push) differs from Schema.validate', actual: m, repro: { ...rp, opts: so, schema: ROBUST_TEXT.get(sch), source: src },
            shrink: { kind: 'bytes', input: b, pred: x => !!sessionCheck(hs, x, 'r', so, src) } });
        }
        if (val.ok && dec.ok !== val.value.ok) F.push({ cls: 'decode-mismatch', detail: 'schema.decode success differs from validate', repro: rp });
      }
    }
    for (let i = 0; i < inp.texts.length; i++) {
      const text = inp.texts[i], limits = inp.climits[i], profile = inp.profiles[i];
      const opts = { profile, limits, ...(inp.unicode[i] ? { unicode: unicodeTables } : {}) };
      const rp = { text: short(text), limits, profile, unicode: inp.unicode[i] };
      st.texts++;
      const t0 = performance.now();
      let res;
      try { res = { ok: true, value: hostCompile(text, opts) }; } catch (e) { res = { ok: false, error: e }; }
      const ms = performance.now() - t0;
      if (ms > 2000) { st.slowCompile++; F.push({ cls: 'slow-compile', detail: `${ms.toFixed(0)} ms`, repro: rp }); }
      if (!res.ok) {
        if (!(res.error instanceof HostSchemaError)) F.push({ cls: 'bad-error-type', sub: 'compile', actual: errInfo(res.error), repro: rp,
          shrink: { kind: 'text', input: text, pred: t => { try { hostCompile(t, opts); return false; } catch (e) { return !(e instanceof HostSchemaError); } } } });
        else { st.refused++; if (res.error.code === 'internal') F.push({ cls: 'compile-internal', actual: errInfo(res.error), repro: rp }); }
        if (inp.publicCompile) {
          const pc = await attemptAsync(() => publicCompile(text, opts));
          if (pc.ok || !(pc.error instanceof PublicSchemaError) || (res.error instanceof HostSchemaError && pc.error.code !== res.error.code))
            F.push({ cls: 'public-compile-error', detail: 'public compile error differs from the host SchemaError', actual: pc.ok ? 'compiled' : errInfo(pc.error), repro: rp });
        }
        continue;
      }
      st.compiled++;
      let sch;
      try { sch = new Schema(new Program(res.value.program, res.value.pool)); }
      catch (e) { F.push({ cls: 'compiled-program-refused', detail: 'a compiled Program failed Program/vm-verify', actual: errInfo(e), repro: rp }); continue; }
      for (const b of inp.blobs.slice(0, 3)) for (const rule of sch.program.rules.slice(0, 2)) {
        const t1 = performance.now();
        const v = attempt(() => sch.validate(b, rule));
        const vms = performance.now() - t1;
        if (!v.ok) F.push({ cls: 'bad-error-type', sub: 'validate', actual: errInfo(v.error), repro: { ...rp, bytes: hex(b), rule } });
        if (vms > 2000) { st.slowValidate++; F.push({ cls: 'slow-validate', detail: `${vms.toFixed(0)} ms`, repro: { ...rp, bytes: hex(b), rule } }); }
        if (v.ok) { const bud = attempt(() => budgetCheck(sch, rule, b, r.pick([3, 50, 5000]), v.value)); if (!bud.ok || bud.value) F.push({ cls: 'budget', detail: bud.ok ? bud.value : errInfo(bud.error), repro: { ...rp, bytes: hex(b), rule } }); }
      }
    }
    // API misuse: TypeError (or the documented SnugFault/RangeError), nothing else
    const MISUSE = [
      () => decode([0xa0]), () => decode('a0'), () => decode(new Uint8Array([0xa0]), { top: 'list' }), () => decode(new Uint8Array([0xa0]), { maxDepth: -1 }),
      () => encode(Symbol('x')), () => encode(() => 1), () => encode({ a: undefined }), () => encode(new Date()), () => encode(NaN), () => encode(1n << 2000n),
      () => ANY.validate([1], 'r'), () => ANY.validate(new Uint8Array(1), 7), () => ANY.validate(new Uint8Array(1), 'nope'),
      () => ANY.validateAt(new Uint8Array([1, 2]), 1, 1, 'r'), () => ANY.validateAt(new Uint8Array([1]), -1, 1, 'r'), () => ANY.validateAt(new Uint8Array([1]), 0, 2, 'r'),
      () => view(new Uint8Array([0xa0]), { schema: ANY }), () => view(new Uint8Array([0x01]), { top: 'any' }).get('a'), () => view(new Uint8Array([0x01]), { top: 'any' }).text(),
      () => new Writer().key('a'), () => new Writer().end(), () => new Writer().beginArray(-1), () => new Writer().uint(-1), () => new Writer().text(5), () => { const w = new Writer(); w.beginArray(1); return w.finish(); },
      () => new Program(new Int32Array(10), new Uint8Array(0)), () => new Schema({}), () => fromSerialized('x'), () => hostCompile(5), () => hostCompile('r = int', { profile: 'nope' }),
      () => hostCompile('r = int', { limits: { budget: -1 } }), () => pushScanner(-1), () => pushScanner(2).feed('ab'),
    ];
    for (const f of MISUSE) {
      st.misuse++;
      const got = await attemptAsync(f);
      if (!got.ok && ![TypeError, SnugFault, RangeError, ProgramError, HostSchemaError, SourceError].some(C => got.error instanceof C))
        F.push({ cls: 'misuse-error-type', detail: f.toString().slice(0, 120), actual: errInfo(got.error) });
    }
    return { failures: F, stats: st };
  },
};
function feedAll(p, bytes, sizes) {
  let at = 0, i = 0;
  while (at < bytes.length) {
    const n = Math.min(bytes.length - at, sizes[i++ % sizes.length]);
    let s = p.feed(bytes.subarray(at, at + n)); at += n;
    let guard = 0;
    while (s.state === 'yield') { s = p.resume(); if (++guard > 1e7) throw new Error('push source: resume never settles'); }
  }
  return p.finalize();
}
const pushRun = (bytes, opts, quantum, sizes) => feedAll(pushScanner(bytes.length, opts, { quantum }), bytes, sizes);
const randomSource = r => ({ chunk: r.pick([1, 2, 7, 64, 65536]), quantum: r.pick([0, 0, 1, 2, 3, 17, 50]), sizes: Array.from({ length: 1 + r.int(3) }, () => 1 + r.int(r.pick([1, 4, 64, 4096]))) });

/** The resumable session (P6.2) through a handle and a push source == Schema.validate. */
function sessionCheck(hs, bytes, rule, opts, src) {
  const full = attempt(() => hs.validate(bytes, rule, opts));
  const h = attempt(() => validateHandleSync(hs, bufferHandle(bytes), rule, opts, { chunk: src.chunk, quantum: src.quantum }));
  const p = attempt(() => feedAll(pushValidator(hs, bytes.length, rule, opts, { quantum: src.quantum }), bytes, src.sizes));
  const show = x => x.ok ? x.value : errInfo(x.error);
  if (!full.ok || !h.ok || !p.ok || !sameResult(h.value, full.value) || !sameResult(p.value, full.value)) return { full: show(full), handle: show(h), push: show(p) };
  return null;
}

export const PROPERTIES = { 1: P1, 2: P2, 3: P3, 4: P4, 5: P5 };
export function doShrink(f) {
  if (!f.shrink) return undefined;
  const s = f.shrink;
  try {
    if (s.run) return s.run();
    if (s.kind === 'bytes') { const m = minimize(s.input, byteCandidates, s.pred); return { bytes: hex(m.value), tries: m.tries }; }
    if (s.kind === 'text') { const m = minimize(s.input, textCandidates, s.pred); return { text: typeof m.value === 'string' ? m.value : hex(m.value), tries: m.tries }; }
    if (s.kind === 'value') { const m = minimize(s.input, valueCandidates, s.pred); return { value: describe(m.value), tries: m.tries }; }
  } catch (e) { return { error: errInfo(e) }; }
  return undefined;
}
