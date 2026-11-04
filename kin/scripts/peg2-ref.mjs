// A test-only reference interpreter of format 2.0 Programs (docs/program-2.md):
// architecture §20.2's `run` read off the compiled PEG programs and tables, with
// scalar leaves decided by a small direct matcher. It is NOT the VM (no tiers,
// records, charges, witnesses or profile checks) and decides nothing in
// production; `bb compile2-test` uses it to check, before the phase 2 VM
// exists, that the compiler's Programs mean what §20.2 says: their verdicts must
// equal the independent oracle's (corpus/tools/peg-oracle.mjs) and §20.15's.
//
//   check(P, B, rule, item, { cuts }) -> true | false | 'unknown'
//
// `item` is the oracle's decoded representation (peg-oracle.mjs `decode`).
// Unsupported leaves (regexps, EXT) and step exhaustion answer 'unknown'; EMBED
// content is decoded with the oracle's decoder (no inner profile or limits).
import { ecBytes, decode, decodeSequence } from '../../corpus/tools/peg-oracle.mjs';

class Unknown extends Error {}
const INF = 0x7fffffff;
const FAIL = { f: 'fail' }, CUT = { f: 'cut' }, FAILX = { f: 'fail!' };
const isFail = r => r === FAIL || r === CUT || r === FAILX;

function head(m, n) {
  n = BigInt(n);
  if (n < 24n) return [m * 32 + Number(n)];
  const size = n < 256n ? 1 : n < 65536n ? 2 : n < 4294967296n ? 4 : 8;
  const a = [m * 32 + 24 + Math.log2(size)];
  const b = []; for (let i = 0; i < size; i++, n >>= 8n) b.unshift(Number(n & 255n));
  return a.concat(b);
}
function enc(it) {
  switch (it.kind) {
    case 'int': return it.value < 0n ? head(1, -1n - it.value) : head(0, it.value);
    case 'text': { const b = [...new TextEncoder().encode(it.value)]; return head(3, b.length).concat(b); }
    case 'bytes': return head(2, it.value.length).concat([...it.value]);
    case 'simple': return it.value < 24 ? [0xe0 | it.value] : [0xf8, it.value];
    case 'float': {
      const w = it.width, dv = new DataView(new ArrayBuffer(8)), out = [];
      if (w === 16) { out.push(0xf9); const b = Number(it.bits); out.push(b >> 8, b & 255); }
      else if (w === 32) { out.push(0xfa); dv.setUint32(0, Number(it.bits)); for (let i = 0; i < 4; i++) out.push(dv.getUint8(i)); }
      else { out.push(0xfb); dv.setBigUint64(0, BigInt(it.bits)); for (let i = 0; i < 8; i++) out.push(dv.getUint8(i)); }
      return out;
    }
    case 'tag': return head(6, it.tag).concat(enc(it.item));
    case 'array': return head(4, it.items.length).concat(...it.items.map(enc));
    case 'map': return head(5, it.pairs.length).concat(...it.pairs.flatMap(([k, v]) => [enc(k), enc(v)]));
  }
  throw new Unknown('item');
}
const u64 = (hi, lo) => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
const mag = (B, off, len) => { let v = 0n; for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(B[off + i]); return v; };

export function check(P, B, rule, item, { cuts = 'reference', steps = 2000000 } = {}) {
  const rfc = cuts === 'rfc';
  const sec = k => P[42 + k];
  const leafAt = l => sec(1) + 8 * l;
  const tsAt = t => P[sec(2) + t];
  const pegAt = g => P[sec(5) + g];
  let budget = steps;
  const tick = () => { if (--budget < 0) throw new Unknown('steps'); };
  const bytesEq = (a, off, len) => a.length === len && a.every((x, i) => x === B[off + i]);

  function bound(o) {
    const r = P[o], a = P[o + 1], b = P[o + 2];
    switch (r) {
      case 0: return -Infinity;
      case 1: return -1n - mag(B, a, b);
      case 2: return -1n - u64(a, b);
      case 3: return u64(a, b);
      case 4: return mag(B, a, b);
      default: return Infinity;
    }
  }
  const le = (x, y) => (x === -Infinity || y === Infinity) ? true : (x === Infinity || y === -Infinity) ? false : x <= y;
  function inIntervals(first, n, v) {
    for (let i = 0; i < n; i++) {
      const o = sec(13) + 6 * (first + i);
      if (le(bound(o), v) && le(v, bound(o + 3))) return true;
    }
    return false;
  }
  function intValue(it, bigok) {
    if (it.kind === 'int') return it.value;
    if (bigok && it.kind === 'tag' && (it.tag === 2n || it.tag === 3n) && it.item.kind === 'bytes') {
      const m = mag(it.item.value, 0, it.item.value.length);
      return it.tag === 2n ? m : -1n - m;
    }
    return null;
  }
  function fkey(it) {
    const dv = new DataView(new ArrayBuffer(8));
    if (Number.isNaN(it.value)) return 0xfff8000000000000n;
    dv.setFloat64(0, it.value);
    const x = dv.getBigUint64(0);
    return x & (1n << 63n) ? (~x) & 0xffffffffffffffffn : x | (1n << 63n);
  }
  function leaf(l, it) {
    tick();
    const o = leafAt(l), k = P[o] & 255, fl = (P[o] >> 8) & 255, d = i => P[o + 2 + i];
    switch (k) {
      case 1: return true;
      case 2: {
        const m = it.kind === 'int' ? (it.value < 0n ? 1 : 0) : { bytes: 2, text: 3, array: 4, map: 5, tag: 6, simple: 7, float: 7 }[it.kind];
        return m === d(0);
      }
      case 3: { const v = intValue(it, fl & 1); return v !== null && inIntervals(d(0), d(1), v); }
      case 4: {
        if (it.kind !== 'float') return false;
        if (!(fl & ({ 16: 1, 32: 2, 64: 4 }[it.width]))) return false;
        if (d(1) === 0) return true;
        const key = fkey(it);
        for (let i = 0; i < d(1); i++) { const q = sec(14) + 4 * (d(0) + i); if (u64(P[q], P[q + 1]) <= key && key <= u64(P[q + 2], P[q + 3])) return true; }
        return false;
      }
      case 5: return it.kind === 'simple' && it.value === d(0);
      case 6: return bytesEq(enc(it), d(0), d(1));
      case 7: { const e = enc(it); for (let i = 0; i < d(1); i++) { const q = sec(15) + 2 * (d(0) + i); if (bytesEq(e, P[q], P[q + 1])) return true; } return false; }
      case 8: {
        if (it.kind !== 'text') return false;
        if (d(2) >= 0) throw new Unknown('regexp');
        const n = new TextEncoder().encode(it.value).length; return n >= d(0) && n <= d(1);
      }
      case 9: {
        if (it.kind !== 'bytes') return false;
        const n = it.value.length; if (n < d(0) || n > d(1)) return false;
        for (let i = 0; i < n && d(3) > 0; i++) if (it.value[i] & ~(i < d(3) ? B[d(2) + i] : 0)) return false;
        return true;
      }
      case 10: {
        if (it.kind !== 'int' || it.value < 0n) return false;
        if (it.value & ~u64(d(0), d(1))) return false;
        return d(3) === 0 || inIntervals(d(2), d(3), it.value);
      }
      case 11: return it.kind === 'tag' && it.tag === u64(d(0), d(1)) && ts(d(2), it.item);
      case 12: return it.kind === 'tag' && it.tag >= u64(d(0), d(1)) && it.tag <= u64(d(2), d(3)) && ts(d(4), it.item);
      case 13: {
        // EMBED: `.cbor` one item, `.cborseq` a virtual array of the sequence (D040)
        if (it.kind !== 'bytes') return false;
        let inner; try { inner = fl & 1 ? decodeSequence(it.value) : decode(it.value); } catch { return false; }
        return ts(d(0), inner);
      }
      case 14: return it.kind === 'array' && array(d(0), it.items);
      case 15: return it.kind === 'map' && map(d(0), it.pairs);
      case 16: return leaf(d(0), it) && leaf(d(1), it);
      case 17: return leaf(d(0), it) && !leaf(d(1), it);
      default: throw new Unknown('leaf kind ' + k);
    }
  }
  function ts(t, it) {
    const o = tsAt(t);
    for (let i = 0; i < P[o]; i++) if (leaf(P[o + 2 + i], it)) return true;
    return false;
  }
  const node = (po, i, w) => P[po + 9 + 5 * i + w];
  const kid = (po, i, j) => P[po + 9 + 5 * P[po + 1] + node(po, i, 1) + j];

  function array(a, items) {
    const ao = P[sec(9) + a], npos = P[ao], w = P[ao + 1], po = pegAt(P[ao + 2]);
    const posTs = p => P[ao + 4 + w + p];
    const n = items.length;
    function run(i, at) {
      tick();
      const op = node(po, i, 0);
      switch (op) {
        case 0: return at;
        case 1: return FAIL;
        case 2: return at < n && ts(posTs(node(po, i, 1)), items[at]) ? at + 1 : FAIL;
        case 4: { let x = at; for (let j = 0; j < node(po, i, 2); j++) { x = run(kid(po, i, j), x); if (x === FAIL) return FAIL; } return x; }
        case 5: { for (let j = 0; j < node(po, i, 2); j++) { const x = run(kid(po, i, j), at); if (x !== FAIL) return x; } return FAIL; }
        case 6: {
          const lo = node(po, i, 2), hi = node(po, i, 3); let c = 0, p = at;
          while (c < hi) { const q = run(node(po, i, 1), p); if (q === FAIL) break; if (q === p) { c = hi; break; } p = q; c++; }
          return c >= lo ? p : FAIL;
        }
        case 7: return run(node(po, i, 1), at);
      }
      throw new Unknown('op');
    }
    void npos;
    return run(0, 0) === n;
  }

  function map(m, pairs) {
    const mo = P[sec(7) + m], nm = P[mo + 1], po = pegAt(P[mo]);
    const member = i => mo + 8 + 5 * i;
    // pick order: ascending EC key bytes (architecture §20.2, R8)
    const cmp = (x, y) => { for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
    const order = pairs.map((p, i) => [i, ecBytes(p[0])]).sort((a, b) => cmp(a[1], b[1])).map(x => x[0]);
    const keyEnc = pairs.map(p => enc(p[0]));
    const keyMatch = (mi, p) => {
      const e = member(mi);
      if (P[e] >= 0) { const ko = sec(4) + 2 * P[e]; return bytesEq(keyEnc[p], P[ko], P[ko + 1]); }
      return ts(P[e + 1], pairs[p][0]);
    };
    let commits = 0;
    function run(i, R) {
      tick();
      const op = node(po, i, 0);
      switch (op) {
        case 0: return R;
        case 1: return FAIL;
        case 3: {
          const mi = node(po, i, 1), lo = node(po, i, 2), hi = node(po, i, 3), cut = P[member(mi) + 4] === 1;
          let c = 0; const R2 = R.slice();
          for (const p of order) {
            if (!R[p]) continue;
            if (c === hi) break;
            if (!keyMatch(mi, p)) continue;
            if (rfc && cut) commits++;
            if (ts(P[member(mi) + 2], pairs[p][1])) { R2[p] = false; c++; }
            else if (cut) return rfc ? FAILX : CUT;
          }
          return c >= lo ? R2 : FAIL;
        }
        case 4: { let x = R; for (let j = 0; j < node(po, i, 2); j++) { x = run(kid(po, i, j), x); if (isFail(x)) return x; } return x; }
        case 5: {
          let saw = false;
          for (let j = 0; j < node(po, i, 2); j++) {
            const c0 = commits, r = run(kid(po, i, j), R);
            if (!isFail(r)) return r;
            if (rfc && (r === FAILX || commits > c0)) return FAILX;
            if (!rfc && r === CUT) saw = true;
          }
          return saw ? CUT : FAIL;
        }
        case 6: {
          const lo = node(po, i, 2), hi = node(po, i, 3); let c = 0, p = R;
          while (c < hi) {
            const c0 = commits, q = run(node(po, i, 1), p);
            if (isFail(q)) {
              if (!rfc && q === CUT) return CUT;
              if (rfc && (q === FAILX || commits > c0)) return FAILX;
              break;
            }
            if (q.every((x, k) => x === p[k])) { c = hi; break; }
            p = q; c++;
          }
          return c >= lo ? p : FAIL;
        }
        case 7: return run(node(po, i, 1), R);
      }
      throw new Unknown('op');
    }
    void nm;
    const r = run(0, pairs.map(() => true));
    return !isFail(r) && r.every(x => !x);
  }

  try {
    const names = [];
    for (let i = 0; i < P[15]; i++) { const o = sec(0) + 5 * i; names.push(new TextDecoder().decode(B.subarray(P[o], P[o] + P[o + 1]))); }
    const ri = names.indexOf(rule);
    if (ri < 0) return 'unknown';
    return ts(P[sec(0) + 5 * ri + 2], item);
  } catch (e) {
    if (e instanceof Unknown) return 'unknown';
    throw e;
  }
}
