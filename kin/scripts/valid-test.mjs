// bb valid-test: valid CBOR (P8.4, D260-D269, D277, D280; architecture §19.9). Generated JS, with the sessions'
// out arrays held to the buffer driver's:
//   1. the RFC 8949 Appendix A / F, additional and RFC 8742 vectors under the valid, deterministic and Bindle
//      presets (corpus/conformance/rfc, corpus/cbor-vectors: expect.valid/deterministic/bindle), the VM against
//      `any` giving the scanner's code on each;
//   2. canonical equivalence: seeded values in their deterministic encoding and in random valid re-encodings
//      (wider heads, indefinite lengths and chunks, wider floats, shuffled map pairs) -- the re-encoding is
//      accepted, decodes to the same value (re-encoded deterministically: the same bytes), validates with the
//      same verdict against a schema that keeps everything live (and the same budget when no pair moved); a
//      duplicate key equal by value in another encoding is duplicate_key;
//   3. refusal replay (D280, the PEG final check's F2): refused deterministic inputs and a head-widened copy of each
//      (the copy takes the canonical path, the original the deterministic walk) give the same out array, offsets
//      shifted, at EVERY budget from 0 to the run's total, through the buffer driver and the session (whole, byte
//      windows, random windows), against `any`, the live schema and an EMBED (.cbor) schema; plus F2's own
//      examples with their expected verdicts;
//   4. against cbor2's default decoding (bench/compare/node_modules, read-only; SKIP when absent): every
//      difference in acceptance in a documented class;
//   5. RFC 8742 sequences of indefinite-length items through the public sequenceReader (liveness, verdicts).
//     kin/scripts/valid-test.mjs [mutations] [seed]
import { readFileSync, existsSync } from 'node:fs';
import { compile } from '../../host/js/src/compile.mjs';
import { decode, encode } from '../../host/js/src/index.mjs';
import { vmScratchWords, vmScratchInit, vmValidateV } from '../../gen/js/snug/vm/api.mjs';
import { vmsWords, vmsArena, vmsInit } from '../../gen/js/snug/vm/session.mjs';
import { scanCb, scanOptions, scanProfile, errorOffset, itemsScanned, codeName } from '../../gen/js/snug/cbor/scan.mjs';
import { buildDetCases, optWords } from './det-cases.mjs';
import { stepV, runUnknown } from './vmsession-run.mjs';

const [mutArg, seedArg] = process.argv.slice(2);
const MUTATIONS = Number(mutArg ?? 300), SEED = Number(seedArg ?? 1), MAXCASES = 60;
const PF_VALID = 378, PF_DET = 122;
let fails = 0;
const fail = m => { if (fails++ < 40) console.log('  FAIL ' + m); };
const line = (ok, m) => console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${m}`);
const hex = b => Buffer.from(b).toString('hex');
const unhex = h => Uint8Array.from(Buffer.from(h, 'hex'));
let s32 = (SEED * 2654435761) >>> 0 || 1;
const rnd = () => { s32 ^= s32 << 13; s32 >>>= 0; s32 ^= s32 >>> 17; s32 ^= s32 << 5; s32 >>>= 0; return s32 / 4294967296; };
const ri = k => Math.floor(rnd() * k);

// ---------------------------------------------------------------- drivers
const BIG = { depth: 64, inputBytes: 0x7fffffff, entries: 1 << 24, items: 1 << 24, budget: 0x7fffffff };
const anyC = compile('r = any', { limits: BIG });
const LIVE = compile(`r = v
v = [* v] / { * any => v } / int / integer / float / tstr / bstr / bool / null / undefined /
    #6.24(bytes .cbor v) / #6.4([int, integer]) / tdate / time / uri / #6.1000(v) / #6.65(bstr) / #6`, { limits: BIG });
const EMB = compile('r = [* (bstr .cbor any / any)]', { limits: BIG });
const programs = [['any', anyC], ['live', LIVE], ['embed', EMB]];
const scanOpt = (bytes, flags, extra = {}) => {
  let o = new Int32Array(16 + 512), cb = new Uint8Array(1024), c;
  for (;;) {
    scanOptions(o, 1, 0, extra.maxBytes ?? 1500000, extra.maxDepth ?? 32, extra.maxEntries ?? 65536, extra.maxItems ?? 131072);
    scanProfile(o, flags);
    c = scanCb(bytes, o, cb);
    if (c !== 22) break;
    if (o[13] > o.length) { const g = new Int32Array(o[13]); o = g; }
    if (o[14] > cb.length) cb = new Uint8Array(o[14]);
  }
  return { code: c, offset: errorOffset(o), items: itemsScanned(o) };
};
let BV = new Int32Array(512), BC = new Uint8Array(1024), BS = null, BSR = -1, BSP = null;
function buffer(c, bytes, lim) {
  const P = c.program, B = c.pool, rule = c.rules.indexOf('r'), mc = P[16] + 5;
  if (BSP !== P || BSR !== rule) { BS = new Int32Array(vmScratchWords(P, rule, mc)); vmScratchInit(BS, mc); BSP = P; BSR = rule; }
  const out = new Int32Array(8 + 2 * 257);
  for (;;) {
    const r = vmValidateV(P, B, rule, bytes, lim, BS, out, () => -2, BV, BC);
    if (r !== -5) { if (r < 0) return `ERR ${r}`; break; }
    if (out[5] > BV.length) BV = new Int32Array(Math.max(out[5], 2 * BV.length));
    if (out[6] > BC.length) BC = new Uint8Array(Math.max(out[6], 2 * BC.length));
    if (out[7] > BS.length) { const g = new Int32Array(out[7]); g.set(BS); BS = g; }
  }
  return Array.from(out.slice(0, 8 + 2 * out[6])).join(' ');
}
function session(c, bytes, lim, policy) {
  const P = c.program, B = c.pool, rule = c.rules.indexOf('r'), cap = Math.max(P[16], 1), n = bytes.length;
  const st = { s: new Int32Array(vmScratchWords(P, rule, cap)), ss: new Int32Array(vmsWords(P)), ka: new Uint8Array(vmsArena(P, lim, n)),
    vs: new Int32Array(512), cb: new Uint8Array(1024) };
  vmScratchInit(st.s, cap);
  const out = new Int32Array(8 + 2 * 257);
  if (vmsInit(P, B, rule, lim, st.s, st.ss, st.ka, n, policy.q ?? 0) < 0) return 'ERR init';
  let off = 0, len = 1, seed = policy.seed ?? 7;
  const r7 = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
  for (let steps = 0; steps < 200000 + 64 * n; steps++) {
    const L = policy.w === 0 ? n - off : Math.max(len, policy.w > 0 ? policy.w : 1 + (r7() % -policy.w));
    const r = stepV(st, P, B, bytes.slice(off, Math.min(n, off + L)), out, off, null);
    if (r >= 0) return Array.from(out.slice(0, 8 + 2 * out[6])).join(' ');
    if (r === -64) { off = st.ss[3]; len = st.ss[4]; continue; }
    if (r === -65) { off = st.ss[2]; len = 1; continue; }
    return `ERR step ${r}`;
  }
  return 'ERR steps';
}
const LIM = (flags, budget = -1, extra = {}) => [1, 0, extra.maxBytes ?? -1, extra.maxDepth ?? -1, extra.maxEntries ?? -1, extra.maxItems ?? -1, -1, budget, 0, flags];

// ---------------------------------------------------------------- 1. RFC vectors
{
  const files = ['corpus/cbor-vectors/rfc8949-appendix-a.json', 'corpus/conformance/rfc/rfc8949-well-formedness.json',
    'corpus/conformance/rfc/rfc8949-additional.json'];
  let n = 0, agree = 0, wf = 0;
  const wfCodes = {}, kept = {};
  // documented differences from the corpus's expectations (docs/profiles.md): the deterministic preset keeps RFC
  // 8949 §4.2.2's canonical NaN, so a NaN with a payload is refused there (the corpus asks only §4.2.1)
  const KNOWN = new Map([['f97e01 deterministic', { code: 9, why: 'deterministic preset: canonical NaN (§4.2.2)' }],
    ['faffc00001 deterministic', { code: 9, why: 'deterministic preset: canonical NaN (§4.2.2)' }],
    // unassigned simple values are well-formed and valid, but snug's value model has none: refused (simple) in
    // every preset (docs/profiles.md; an owner question in DEVLOG P8.4)
    ...['f0', 'f8ff'].flatMap(h => ['valid', 'deterministic'].map(p => [`${h} ${p}`, { code: 10, why: 'unassigned simple values (no value)' }]))]);
  for (const f of files) {
    const j = JSON.parse(readFileSync(new URL('../../' + f, import.meta.url)));
    for (const v of j.vectors) {
      if (!v.expect) continue;
      const bytes = unhex(v.hex);
      for (const [name, flags] of [['valid', PF_VALID], ['deterministic', PF_DET], ['bindle', 0]]) {
        if (v.expect[name] === undefined) continue;
        n++;
        const s = scanOpt(bytes, flags);
        const vm = buffer(anyC, bytes, LIM(flags)).split(' ').map(Number);
        const known = KNOWN.get(`${v.hex} ${name}`);
        if (known && s.code === known.code) { kept[known.why] = (kept[known.why] ?? 0) + 1; agree++; continue; }
        if ((s.code === 0) !== v.expect[name]) fail(`${f.split('/').pop()} ${v.hex} (${v.note ?? v.diagnostic ?? ''}) ${name}: ${codeName(s.code)}@${s.offset}, expected ${v.expect[name] ? 'accept' : 'refuse'}`);
        else if (vm[0] !== s.code || (s.code !== 0 && vm[2] !== s.offset)) fail(`${v.hex} ${name}: VM ${vm[0]}@${vm[2]}, scanner ${s.code}@${s.offset}`);
        else agree++;
        if (v.expectedClass === 'not-well-formed' && name === 'valid') {
          // refused; the code is the first refusal in walk order (a duplicate key or trailing bytes may come first)
          wf++; wfCodes[codeName(s.code)] = (wfCodes[codeName(s.code)] ?? 0) + 1;
        }
      }
    }
  }
  // RFC 8742: each sequence's items, one at a time through the session's sequence-free walk (items end to end)
  const seq = JSON.parse(readFileSync(new URL('../../corpus/conformance/rfc/rfc8742.json', import.meta.url)));
  let seqOk = 0;
  for (const v of seq.vectors) {
    const bytes = unhex(v.hex);
    let off = 0, items = 0, ok = true;
    while (off < bytes.length && ok) {
      // the shortest prefix the scanner accepts as one item
      let e = off + 1;
      for (; e <= bytes.length; e++) if (scanOpt(bytes.subarray(off, e), PF_VALID).code === 0) break;
      if (e > bytes.length) ok = false; else { items++; off = e; }
    }
    if (ok === v.expect.valid && (!ok || v.itemCount === undefined || items === v.itemCount)) seqOk++;
    else fail(`rfc8742 ${v.hex}: ${ok ? items + ' items' : 'refused'}, expected ${v.expect.valid ? (v.itemCount ?? '?') + ' items' : 'refusal'}`);
  }
  line(agree === n && seqOk === seq.vectors.length, `RFC vectors: ${agree}/${n} preset verdicts as expected (Appendix A, Appendix F, additional), VM == scanner on each; ${wf} not-well-formed inputs refused under valid (${Object.entries(wfCodes).map(([k, v]) => `${k} ${v}`).join(', ')}); kept differences: ${Object.entries(kept).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; RFC 8742 ${seqOk}/${seq.vectors.length} sequences`);
}

// ---------------------------------------------------------------- 2. canonical equivalence
// a re-encoder over CHECKED deterministic bytes: the same value in a random valid encoding
function head(major, v, wide) {
  // v: a non-negative number or bigint argument; wide: 0 shortest, 1..3 one width wider (when it fits)
  const n = BigInt(v);
  const ws = n < 24n ? -1 : n < 256n ? 0 : n < 65536n ? 1 : n < 4294967296n ? 2 : 3;
  let w = Math.min(3, ws + wide);
  if (w < 0) return [major << 5 | Number(n)];
  const out = [major << 5 | (24 + w)];
  const bytes = 1 << w;
  for (let i = bytes - 1; i >= 0; i--) out.push(Number((n >> BigInt(8 * i)) & 255n));
  return out;
}
function reenc(b, x, ctx) {
  // returns [bytes (array), end]
  const ib = b[x], major = ib >> 5, ai = ib & 31;
  let arg = 0n, p = x + 1;
  if (ai < 24) arg = BigInt(ai);
  else if (ai < 28) { const w = 1 << (ai - 24); for (let i = 0; i < w; i++) arg = arg << 8n | BigInt(b[p + i]); p += w; }
  const wide = rnd() < ctx.pw ? 1 + ri(2) : 0;
  if (major === 7) {
    if (ai === 25 && rnd() < ctx.pw) {   // f16 -> f32, exactly (any half, NaN payloads kept)
      const h = Number(arg), sgn = h >> 15, e = (h >> 10) & 31, m = h & 1023;
      let f;
      if (e === 31) f = (sgn << 31) | (255 << 23) | (m << 13);
      else if (e === 0) {
        if (m === 0) f = sgn << 31;
        else { let mm = m, ee = -14; while (!(mm & 1024)) { mm <<= 1; ee--; } f = (sgn << 31) | ((ee + 127) << 23) | ((mm & 1023) << 13); }
      } else f = (sgn << 31) | ((e - 15 + 127) << 23) | (m << 13);
      return [[0xfa, (f >>> 24) & 255, (f >>> 16) & 255, (f >>> 8) & 255, f & 255], p];
    }
    return [Array.from(b.subarray(x, p)), p];
  }
  if (major <= 1) return [head(major, arg, wide), p];
  if (major <= 3) {
    const len = Number(arg), content = Array.from(b.subarray(p, p + len));
    if (rnd() < ctx.pi && (major === 2 || content.every(c => c < 0x80))) {
      // indefinite, chunks at random points (text: only between code points; ASCII-only here)
      const out = [major << 5 | 31];
      let i = 0;
      while (i < len || rnd() < 0.3) { const k = Math.min(len - i, ri(4)); out.push(...head(major, k, 0), ...content.slice(i, i + k)); i += k; if (i >= len && rnd() < 0.7) break; }
      out.push(0xff);
      return [out, p + len];
    }
    return [[...head(major, len, wide), ...content], p + len];
  }
  if (major === 6) { const [c, e] = reenc(b, p, ctx); return [[...head(6, arg, wide), ...c], e]; }
  const n = Number(arg), items = [];
  let q = p;
  for (let i = 0; i < (major === 5 ? 2 * n : n); i++) {
    const [c, e] = reenc(b, q, ctx);
    // a map key in another encoding than its deterministic one marks its map for the deferred duplicate check,
    // whose units (D263, D277) the deterministic encoding does not pay
    if (major === 5 && i % 2 === 0 && hex(c) !== hex(b.subarray(q, e))) ctx.marked = true;
    items.push(c); q = e;
  }
  let parts = items;
  if (major === 5) {
    const pairs = [];
    for (let i = 0; i < n; i++) pairs.push([items[2 * i], items[2 * i + 1]]);
    if (rnd() < ctx.ps && n > 1) { for (let i = n - 1; i > 0; i--) { const j = ri(i + 1); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; } ctx.moved = true; }
    parts = pairs.flat();
  }
  const ind = rnd() < ctx.pi;
  const out = ind ? [major << 5 | 31] : head(major, n, wide);
  for (const c of parts) out.push(...c);
  if (ind) out.push(0xff);
  return [out, q];
}
{
  const BIGV = [0, 1, -1, 23, 24, 255, 256, 65535, 65536, 2 ** 32, -(2 ** 32) - 1, 1.5, -0.25, 1e300, 65504, NaN, Infinity, -0, 2n ** 64n - 1n];
  const TXT = ['', 'a', 'key', 'é', 'xyz'.repeat(9)];
  function value(d) {
    switch (ri(d > 2 ? 5 : 8)) {
      case 0: case 1: return BIGV[ri(BIGV.length)];
      case 2: return TXT[ri(TXT.length)];
      case 3: return [null, true, false][ri(3)];
      case 4: return new Uint8Array(ri(6)).map(() => ri(256));
      case 5: return Array.from({ length: ri(4) }, () => value(d + 1));
      default: { const m = new Map(); for (let i = ri(5); i > 0; i--) m.set([ri(30) - 10, TXT[ri(4)] + ri(9), [ri(3)], 2.5][ri(4)], value(d + 1)); return m; }
    }
  }
  let n = 0, same = 0, budgets = 0, dupOk = 0, dupN = 0, nondet = 0;
  for (let i = 0; i < 600; i++) {
    let D;
    try { D = encode(value(0)); } catch { continue; }
    const ctx = { pw: 0.4, pi: 0.3, ps: 0.3, moved: false };
    const N = Uint8Array.from(reenc(D, 0, ctx)[0]);
    n++;
    if (hex(N) !== hex(D)) nondet++;
    const s = scanOpt(N, PF_VALID);
    if (s.code !== 0) { fail(`equivalence: ${hex(N)} (of ${hex(D)}) refused ${codeName(s.code)}@${s.offset}`); continue; }
    let back;
    try { back = hex(encode(decode(N, { wire: 'valid' }))); } catch (e) { fail(`equivalence: decode ${hex(N)}: ${e.code ?? e.message}`); continue; }
    if (back !== hex(D)) { fail(`equivalence: ${hex(N)} decodes to ${back}, not ${hex(D)}`); continue; }
    const a = buffer(LIVE, D, LIM(PF_VALID)).split(' '), b = buffer(LIVE, N, LIM(PF_VALID)).split(' ');
    if (a[0] !== b[0] || a[1] !== b[1]) { fail(`equivalence: live verdict ${a.slice(0, 5)} for ${hex(D)}, ${b.slice(0, 5)} for ${hex(N)}`); continue; }
    if (!ctx.moved && !ctx.marked) { if (a[3] === b[3]) budgets++; else fail(`equivalence: budget ${a[3]} for ${hex(D)}, ${b[3]} for ${hex(N)} (no pair moved, no key re-encoded)`); }
    else if (Number(b[3]) >= Number(a[3]) || ctx.moved) budgets++;
    else fail(`equivalence: budget ${b[3]} for ${hex(N)} below ${a[3]} for ${hex(D)} though only keys were re-encoded`);
    same++;
    // a duplicate key equal by value: the first key again, in a wider encoding
    if (D[0] >> 5 === 5 && (D[0] & 31) > 0 && (D[0] & 31) < 23) {
      const [k] = reenc(D, 1, { pw: 1, pi: 0.5, ps: 0 });
      const ke = reenc(D, 1, { pw: 0, pi: 0, ps: 0 })[1];
      const ve = reenc(D, ke, { pw: 0, pi: 0, ps: 0 })[1];
      const Dd = Uint8Array.from([D[0] + 1, ...D.subarray(1), ...k, ...D.subarray(ke, ve)]);
      dupN++;
      const sd = scanOpt(Dd, PF_VALID);
      if (sd.code === 7) dupOk++; else fail(`duplicate by value: ${hex(Dd)} gives ${codeName(sd.code)}`);
    }
  }
  line(same === n && budgets === n && dupOk === dupN, `canonical equivalence: ${same}/${n} valid re-encodings (${nondet} not their own deterministic form) accepted, decoding to the deterministic encoding's value, same live verdict; ${budgets}/${n} same budget (no pair moved, no key re-encoded; else no less: the deferred check's units, D277); ${dupOk}/${dupN} duplicates equal by value refused duplicate_key`);
}

// ---------------------------------------------------------------- 3. refusal replay (D280, F2)
// widen the head of the item at x (one width wider), answering the new bytes and the shift
function widen(b, x) {
  const ai = b[x] & 31, major = b[x] >> 5;
  if (major === 7 || ai > 26) return null;
  let arg = 0, p = x + 1;
  if (ai < 24) arg = ai; else { const w = 1 << (ai - 24); for (let i = 0; i < w; i++) arg = arg * 256 + b[p + i]; p += w; }
  const nh = head(major, arg, 1);
  if (nh.length <= p - x) return null;
  return { bytes: Uint8Array.from([...b.subarray(0, x), ...nh, ...b.subarray(p)]), at: x, k: nh.length - (p - x) };
}
const shift = (o, at, k) => (o > at ? o + k : o);
function shifted(outStr, at, k) {
  const w = outStr.split(' ');
  if (w[0] !== '0' && !outStr.startsWith('ERR')) w[2] = String(shift(Number(w[2]), at, k));
  return w.join(' ');
}
{
  const dc = buildDetCases(MUTATIONS, SEED, { valid: true });
  let cases = 0, runs = 0, agree = 0, sessRuns = 0, sessAgree = 0, natives = 0;
  const POL = [{ w: 0 }, { w: 1 }, { w: -7, seed: 11 }];
  for (const c of dc.cases) {
    if (c.bytes.length === 0 || c.bytes.length > 160) continue;
    const flags = c.opt.flags | 256;
    const X0 = c.bytes;
    if (scanOpt(X0, flags).code === 0) continue;               // refused inputs only
    const wd = widen(X0, 0);
    if (!wd) continue;
    const extra = { maxDepth: c.opt.maxDepth, maxEntries: c.opt.maxEntries, maxItems: c.opt.maxItems };
    // the widened copy must keep the refusal (an outer count claim may now pass)
    const s0 = scanOpt(X0, flags, extra), s1 = scanOpt(wd.bytes, flags, extra);
    if (s1.code !== s0.code || s1.offset !== shift(s0.offset, wd.at, wd.k)) continue;
    cases++;
    if (cases > MAXCASES) break;
    for (const [pname, prog] of programs) {
      const full = buffer(prog, X0, LIM(flags, -1, extra)).split(' ');
      const used = full[0].startsWith('ERR') ? 0 : Number(full[3]);
      const step = used > 40 ? Math.ceil(used / 40) : 1;
      for (let bu = 0; bu <= used + 1; bu += step) {
        const want = shifted(buffer(prog, X0, LIM(flags, bu, extra)), wd.at, wd.k);
        const got = buffer(prog, wd.bytes, LIM(flags, bu, extra));
        runs++;
        if (got === want) agree++; else fail(`replay ${c.label} [${hex(X0)}] ${pname} budget ${bu}: deterministic walk ${want} | canonical path ${got}`);
        if (bu % (step * 8) === 0 || bu >= used) {
          for (const pol of POL) {
            sessRuns++;
            const g = session(prog, wd.bytes, LIM(flags, bu, extra), pol);
            if (g === got) sessAgree++; else fail(`replay ${c.label} [${hex(wd.bytes)}] ${pname} budget ${bu} windows ${pol.w}: buffer ${got} | session ${g}`);
          }
        }
      }
    }
  }
  // F2's examples (docs/reviews/2026-11-04-peg-final-check.md): invalid text after a profile-only switch; a
  // malformed entry of a non-shortest 32-entry array; the duplicate a session met at its map's end (N6)
  const F2 = [
    ['r = [tstr, any]', '98020078' + '10' + '61'.repeat(15) + 'ff', '8 0 20'],
    ['r = [tstr]', '99002000fc' + '00'.repeat(30), '4 0 4'],
    ['r = [uint, {* int => int}]', '9f00a3020001000200ff', '7 0 7'],
  ];
  let f2 = 0, f2runs = 0;
  for (const [cddl, h, want] of F2) {
    const c = compile(cddl, { limits: BIG }), bytes = unhex(h);
    const full = buffer(c, bytes, LIM(PF_VALID));
    if (!full.startsWith(want + ' ')) { fail(`F2 ${h}: ${full}, expected ${want}`); continue; }
    const used = Number(full.split(' ')[3]);
    let ok = true;
    for (let bu = 0; bu <= used + 1; bu++) {
      const b = buffer(c, bytes, LIM(PF_VALID, bu));
      // below the total the run stops on budget, at the total and above it gives the verdict
      if (bu < used ? !b.startsWith('48 ') : !b.startsWith(want + ' ')) { ok = false; fail(`F2 ${h} budget ${bu}: ${b}`); }
      for (const pol of POL) { f2runs++; const g = session(c, bytes, LIM(PF_VALID, bu), pol); if (g !== b) { ok = false; fail(`F2 ${h} budget ${bu} windows ${pol.w}: buffer ${b} | session ${g}`); } }
    }
    if (ok) f2++;
  }
  line(agree === runs && sessAgree === sessRuns && f2 === F2.length,
    `refusal replay (D280): ${cases} refused inputs with a head-widened copy; ${agree}/${runs} buffer runs of the copy (canonical path) equal the original's (deterministic walk), offsets shifted, at budgets 0..total over any, live and embed schemas; ${sessAgree}/${sessRuns} session runs (whole, byte and random windows) equal the buffer; F2 examples ${f2}/${F2.length} at every budget (${f2runs} session runs)`);
}

// ---------------------------------------------------------------- 3b. fixed regressions (P8.4)
// (Also: a map's deferred duplicate check reports the items walked to the map's end, not the walk's total; tags 4
// and 40 take the any-width content path in a valid run under the Bindle tag set on the VM as in the scanner.)
// Tag-24 payloads whose items pass the depth bound: the payload's walk is bounded two levels below the tag while a
// `.cbor` walk of the same bytes is a nested document, so the copy's region may stop (a declared length past the end)
// where a tag-24 walk must refuse depth first (vcopy pw-bad-df, vm-dead head-fail). Each: the scanner's code and
// offset from the buffer driver and from sessions under every program, deterministic and valid flags, a DC and a
// head-widened (canonical path) form.
{
  const REG = [['d818428201', 2], ['d81858028201', 2], ['d81844d8184101', 2], ['8242a83bd8184e83f760c249010000000000d50000', 4],
    ['d8184483d8180100', 3], ['d8185f428201ff', 2],
    // a map's deferred duplicate check (EC-sensitive NaN keys) refuses with the items walked to the map's end
    ['8282a43b0000000ab5d04c003744694ce557f90000f97e00fa4b800000f9fe00d8206b75726e3a783a793f7a236601', 32],
    // tag 4 under valid with the Bindle tag set: the any-width content path on both sides
    ['c483217f196ab3', 32], ['c49221196ab3', 3],
    // an indefinite array past the entry bound in a session's frame (an integer streak stops at the bound)
    ['a161619f00200000000000ff', 4, 2], ['9f0102030405ff', 4, 3]];
  let n = 0, ok = 0;
  for (const [h, md, me = 3] of REG) for (const flags of [PF_DET, PF_VALID, 256]) {
    const bytes = unhex(h), extra = { maxDepth: md, maxEntries: me, maxItems: 64 }, sc = scanOpt(bytes, flags, extra);
    for (const [pname, prog] of programs) {
      const lim = LIM(flags, -1, extra), want = buffer(prog, bytes, lim), w = want.split(' ');
      n++;
      const scanOk = prog !== anyC || (Number(w[0]) === sc.code && (sc.code === 0 || Number(w[2]) === sc.offset) && Number(w[4]) === sc.items);
      const sess = [{ w: 0 }, { w: 1 }, { w: -5, seed: 3 }].map(pol => session(prog, bytes, lim, pol));
      // and as a stream of untold length (D085 drain), whole and a byte at a time
      for (const pol of [{ kind: 0, w: 0, q: 0, seed: 1, k: 0 }, { kind: 1, w: 1, q: 0, seed: 1, k: 0 }]) {
        const x = runUnknown(prog.program, prog.pool, prog.rules.indexOf('r'), Int32Array.from(lim), bytes, pol);
        sess.push(x.error ? 'E ' + x.error : x.out);
      }
      if (scanOk && sess.every(x => x === want)) ok++;
      else fail(`regression ${h} flags ${flags} ${pname}: scanner ${sc.code}@${sc.offset} (${sc.items} items), buffer ${want}, sessions ${sess.join(' | ')}`);
    }
  }
  line(ok === n, `fixed regressions (tag-24 payloads past the depth bound, deferred-check items, tag 4/40 under valid with the Bindle tags): ${ok}/${n} buffer == scanner (any: code, offset, items) and sessions (declared and untold length) == buffer`);
}

// ---------------------------------------------------------------- 4. cbor2's default decoding
{
  const CBOR2 = new URL('../../bench/compare/node_modules/cbor2/lib/index.js', import.meta.url);
  if (!existsSync(CBOR2)) console.log('  SKIP cbor2 differential (bench/compare/node_modules/cbor2 not installed)');
  else {
    const cbor2 = await import(CBOR2.href);
    const verdict = (bytes, opts) => { try { cbor2.decode(bytes, opts); return null; } catch (e) { return String(e.message); } };
    const dc = buildDetCases(MUTATIONS, SEED + 1);
    const inputs = dc.cases.map(c => c.bytes);
    for (const f of ['corpus/cbor-vectors/rfc8949-appendix-a.json', 'corpus/conformance/rfc/rfc8949-well-formedness.json', 'corpus/conformance/rfc/rfc8949-additional.json'])
      for (const v of JSON.parse(readFileSync(new URL('../../' + f, import.meta.url))).vectors) inputs.push(unhex(v.hex));
    const classes = {}, note = k => { classes[k] = (classes[k] ?? 0) + 1; };
    let compared = 0, agreeN = 0, unexplained = 0;
    for (const bytes of inputs) {
      const s = scanOpt(bytes, PF_VALID);
      const a = verdict(bytes, { rejectDuplicateKeys: true });
      compared++;
      if ((s.code === 0) === (a === null)) { agreeN++; continue; }
      const sc = codeName(s.code);
      if (s.code !== 0) {
        if (['tag', 'bignum', 'decimal', 'typed_array', 'ndarray'].includes(sc)) { note('tag rules (snug checks known tags\' contents, D121/D180/D265)'); continue; }
        if (['depth', 'too_many_items', 'too_many_entries', 'too_large'].includes(sc)) { note('limits'); continue; }
        if (sc === 'simple') { note('simple values (snug admits false/true/null/undefined only)'); continue; }
        if (sc === 'text') { note('text (noncharacters, or UTF-8 cbor2 does not check)'); continue; }
        if (sc === 'float') { note('floats (deterministic float rules kept by the valid preset)'); continue; }
        if (sc === 'duplicate_key') { note('duplicates by value (RFC 8949 §5.6.1; cbor2 compares decoded JS keys)'); continue; }
        if (sc === 'malformed' || sc === 'truncated' || sc === 'trailing') {
          if (/tag|Tag/.test(String(a)) || verdict(bytes, { rejectDuplicateKeys: true, ignoreGlobalTags: true }) === null) { note('cbor2 tag decoders'); continue; }
        }
        if (sc === 'key_type') { note('key types (the preset\'s key policy)'); continue; }
      } else {
        if (verdict(bytes, { ignoreGlobalTags: true, rejectDuplicateKeys: true }) === null) { note('cbor2 tag decoders (content snug does not check)'); continue; }
        if (/[Dd]uplicate/.test(a)) { note('duplicates cbor2 sees in decoded JS keys (distinct CBOR keys)'); continue; }
        if (/Expected number|integer|BigInt/.test(a)) { note('cbor2 number conversions'); continue; }
      }
      unexplained++;
      fail(`cbor2: ${hex(bytes).slice(0, 80)}: snug valid ${sc}@${s.offset}, cbor2 ${a ?? 'accepts'}`);
    }
    line(unexplained === 0, `valid preset vs cbor2 2.4.1 default decode (+ rejectDuplicateKeys): ${agreeN}/${compared} same verdict; the rest by class: ${Object.entries(classes).map(([k, v]) => `${k} ${v}`).join('; ')}; ${unexplained} unexplained`);
  }
}

// ---------------------------------------------------------------- 5. sequences with indefinite-length items
// RFC 8742 sequences of valid, non-deterministic messages (indefinite arrays, maps, chunked strings, unsorted and
// wider-head keys) through the public sequenceReader under wire 'valid', profile-only and with a schema, fed whole, a
// byte at a time and in random chunks: every message is released by the feed that completes it (liveness), with its
// offset, length and a view that reads the same value as decode(); a duplicate key equal by value in an indefinite map
// (and a truncated last message) is refused with the buffer validation's code and absolute offset.
{
  const { sequenceReader } = await import('../../host/js/src/public-sequence.mjs');
  const msgs = [
    '9f0102ff',                                      // [_ 1, 2]
    'bf616202616101ff',                              // {_ "b": 2, "a": 1} (unsorted)
    '7f62616263636465ff',                            // (_ "ab", "cde")
    '9fbf18016178ff5f4101420203ffff',                // [_ {_ 1 (wide head): "x"}, (_ h'01', h'0203')]
  ];
  const good = msgs.slice(0, 4).map(unhex);
  const dup = unhex('bf61610178016102ff');           // {_ "a": 1, "a" (1-byte head): 2}: duplicate by value
  const cat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0), o = new Uint8Array(n); let k = 0; for (const y of a) { o.set(y, k); k += y.length; } return o; };
  const { compile: compileSchema } = await import('../../host/js/src/public-compile.mjs');
  const schema = await compileSchema('r = any');
  const chunkings = bytes => {
    const out = [[bytes], Array.from(bytes, (_, i) => bytes.subarray(i, i + 1))];
    for (let t = 0; t < 4; t++) { const parts = []; let i = 0; while (i < bytes.length) { const k = 1 + ri(6); parts.push(bytes.subarray(i, i + k)); i += k; } out.push(parts); }
    return out;
  };
  let runs = 0, okRuns = 0;
  const check = (bytes, wantMsgs, wantErr, opts, tag) => {
    for (const parts of chunkings(bytes)) {
      runs++;
      const r = sequenceReader(opts), got = [];
      let fed = 0, err = null, live = true;
      for (const part of parts) {
        const x = r.feed(part); fed += part.length;
        for (const m of x.messages) got.push(m);
        // liveness: every message that ends within the bytes fed so far has been released
        if (!x.error && got.length < wantMsgs.filter(w => w.offset + w.length <= fed).length) live = false;
        if (x.error) { err = x.error; break; }
      }
      if (!err) { const e = r.end(); for (const m of e.messages) got.push(m); err = e.error; }
      const same = got.length === wantMsgs.length && got.every((m, i) => m.offset === wantMsgs[i].offset && m.length === wantMsgs[i].length
        && JSON.stringify(m.view.value(), (k, v) => typeof v === 'bigint' ? `${v}n` : v) === JSON.stringify(decode(wantMsgs[i].bytes, { wire: 'valid', top: 'any' }), (k, v) => typeof v === 'bigint' ? `${v}n` : v));
      const errOk = wantErr ? (err && err.reason === wantErr.reason && err.offset === wantErr.offset) : !err;
      if (same && errOk && live) okRuns++;
      else fail(`sequence ${tag} [${parts.map(p => p.length).join(',')}]: ${got.length}/${wantMsgs.length} messages${live ? '' : ' (late)'}, error ${err ? `${err.reason}@${err.offset}` : 'none'}${wantErr ? `, expected ${wantErr.reason}@${wantErr.offset}` : ''}`);
    }
  };
  const want = [];
  { let off = 0; for (const g of good) { want.push({ offset: off, length: g.length, bytes: g }); off += g.length; } }
  const goodSeq = cat(...good);
  for (const [opts, tag] of [[{ wire: 'valid', top: 'any' }, 'profile-only'], [{ wire: 'valid', schema, rule: 'r' }, 'schema']]) {
    check(goodSeq, want, null, opts, tag);
    // a duplicate by value in an indefinite map after the good messages: refused at the second key, as the buffer scan
    const dupAt = scanOpt(dup, PF_VALID).offset;   // the buffer verdict's offset (the second key)
    check(cat(goodSeq, dup), want, { reason: 'cbor/duplicate_key', offset: goodSeq.length + dupAt }, opts, `${tag} duplicate`);
    // a last message cut inside an indefinite array: truncated at the end of input
    check(cat(goodSeq, unhex('9f0102')), want, { reason: 'cbor/truncated', offset: goodSeq.length + 3 }, opts, `${tag} truncated`);
  }
  line(okRuns === runs, `sequences of indefinite-length items (sequenceReader, wire 'valid', profile-only and schema): ${okRuns}/${runs} runs (whole, byte-wise, random chunks) give each message on the feed that completes it, with the buffer's verdicts`);
}

if (fails) { console.log(`  FAIL ${fails} failure(s)`); process.exit(1); }
console.log('  ok   valid CBOR: vectors, equivalence, replay and the differential');
