// A Program ASSEMBLER for VM tests (docs/program.md format 1). It is not a
// compiler: the caller states leaves, typesets, groups, maps, arrays and
// regexps explicitly (leaf ids = creation order); the assembler lays them out
// and computes every derived field ([D]: masks, FLAGS, W, n_constrained,
// req_count, state_off, state_words, cand_max, closure sets and chains, frame
// and regex words, scratch words, SCRATCH_MAX) the way program.md defines
// them. Used by bb vm-test until kin/compile lowers schemas, and afterwards
// for hand-shaped and hostile Programs the compiler would never emit.
const INF = 0x7fffffff;
const K = { ANY: 1, MAJOR: 2, INT: 3, FLOAT: 4, SIMPLE: 5, LIT: 6, LITSET: 7, TEXT: 8, BYTES: 9, UINTX: 10,
  TAG: 11, TAGSET: 12, EMBED: 13, ARRAY: 14, MAP: 15, AND: 16, NOT: 17 };
export { K, INF };
const U64 = 1n << 64n;
const te = new TextEncoder();

// ---------------------------------------------------------------- CBOR bits
function head(major, n) {
  n = BigInt(n);
  if (n < 24n) return [(major << 5) | Number(n)];
  if (n < 256n) return [(major << 5) | 24, Number(n)];
  if (n < 65536n) return [(major << 5) | 25, Number(n >> 8n), Number(n & 255n)];
  if (n < 1n << 32n) return [(major << 5) | 26, ...[24n, 16n, 8n, 0n].map(s => Number((n >> s) & 255n))];
  return [(major << 5) | 27, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map(s => Number((n >> s) & 255n))];
}
export const cbor = {
  text: s => { const b = te.encode(s); return Uint8Array.from([...head(3, b.length), ...b]); },
  bytes: b => Uint8Array.from([...head(2, b.length), ...b]),
  int: v => { v = BigInt(v); return Uint8Array.from(v >= 0n ? head(0, v) : head(1, -1n - v)); },
  simple: v => Uint8Array.of(0xe0 | v),
  hex: h => Uint8Array.from(Buffer.from(h, 'hex')),
};
export function keyBytes(k) { return typeof k === 'string' ? cbor.text(k) : (k instanceof Uint8Array ? k : cbor.int(k)); }
function cmpBytes(a, b) { const m = Math.min(a.length, b.length); for (let i = 0; i < m; i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; }
function classOf(enc) {
  const ib = enc[0], major = ib >> 5, ai = ib & 31;
  if (major < 6) return 1 << major;
  if (major === 6) return (ai === 2 || ai === 3) ? 0x800 : 0x040;
  if (ai === 25) return 0x100; if (ai === 26) return 0x200; if (ai === 27) return 0x400; return 0x080;
}
function mag(n) { const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; } return Uint8Array.from(out); }

// ---------------------------------------------------------------- the assembler
export class Asm {
  constructor(opt = {}) {
    this.opt = { depth: 32, input: 1500000, entries: 65536, items: 131072, bignum: 128, budget: 4000000, total: 8388608, profile: 0, ...opt };
    this.leaves = []; this.typesets = []; this.tsKey = new Map(); this.groups = []; this.groupKey = new Map();
    this.maps = []; this.arrays = []; this.regexps = []; this.rules = [];
  }
  leaf(kind, a = {}) { const id = this.leaves.length; this.leaves.push({ kind: K[kind] ?? kind, ...a }); return id; }
  any() { return this.leaf('ANY'); }
  major(m) { return this.leaf('MAJOR', { major: m }); }
  int(intervals, bigok = false) { return this.leaf('INT', { intervals, bigok }); }
  float(widths = 7, intervals = []) { return this.leaf('FLOAT', { widths, fintervals: intervals }); }
  simple(v) { return this.leaf('SIMPLE', { v }); }
  lit(bytes) { return this.leaf('LIT', { bytes }); }
  litset(list) { return this.leaf('LITSET', { list: [...list].sort(cmpBytes) }); }
  text(lo = 0, hi = INF, rx = -1) { return this.leaf('TEXT', { lo, hi, rx }); }
  bytes(lo = 0, hi = INF, bits = null) { return this.leaf('BYTES', { lo, hi, bits }); }
  uintx(allowed, intervals = []) { return this.leaf('UINTX', { allowed: BigInt(allowed), intervals }); }
  tag(n, ts) { return this.leaf('TAG', { n: BigInt(n), ts }); }
  tagset(lo, hi, ts) { return this.leaf('TAGSET', { lo: BigInt(lo), hi: BigInt(hi), ts }); }
  embed(ts, seq = false) { return this.leaf('EMBED', { ts, seq }); }
  array(def) { const id = this.arrays.length; this.arrays.push(def); return this.leaf('ARRAY', { array: id }); }
  map(def) { const id = this.maps.length; this.maps.push(def); return this.leaf('MAP', { map: id }); }
  and(a, b) { return this.leaf('AND', { a, b }); }
  not(t, l) { return this.leaf('NOT', { a: t, b: l }); }
  regex(def) { this.regexps.push(def); return this.regexps.length - 1; }
  ts(answers) {
    const ans = [...new Set(answers)].sort((x, y) => x - y);
    const key = ans.join(',');
    if (this.tsKey.has(key)) return this.tsKey.get(key);
    const id = this.typesets.length; this.typesets.push({ ans }); this.tsKey.set(key, id); return id;
  }
  group(entries) {
    const key = JSON.stringify(entries);
    if (this.groupKey.has(key)) return this.groupKey.get(key);
    const id = this.groups.length; this.groups.push(entries); this.groupKey.set(key, id); return id;
  }
  rule(name, ts) { this.rules.push({ name, ts }); }

  // the evaluation list of a typeset: every answer and operand closure, operands first
  evalList(ts) {
    const { ans } = this.typesets[ts];
    if (!ans.some(l => this.leaves[l].kind === K.AND || this.leaves[l].kind === K.NOT)) return null;
    const out = [], seen = new Set();
    const visit = l => {
      if (seen.has(l)) return; seen.add(l);
      const lf = this.leaves[l];
      if (lf.kind === K.AND || lf.kind === K.NOT) { visit(lf.a); visit(lf.b); }
      out.push(l);
    };
    for (const a of ans) visit(a);
    const A = new Set(ans);
    return out.map(l => A.has(l) ? l : ~l);
  }
  closureOf(ts) { const ev = this.evalList(ts); return ev ? ev.map(x => x < 0 ? ~x : x) : this.typesets[ts].ans; }

  build() {
    const L = this.leaves, o = this.opt;
    // TS_ANY when some leaf needs it (ANY, MAJOR 4/5/6)
    let tsAny = -1;
    const anyLeaf = L.findIndex(l => l.kind === K.ANY);
    if (L.some(l => l.kind === K.ANY || (l.kind === K.MAJOR && l.major >= 4 && l.major <= 6)))
      tsAny = this.ts([anyLeaf >= 0 ? anyLeaf : this.leaf('ANY')]);
    const pool = []; const poolAt = bytes => { const off = pool.length; pool.push(...bytes); return off; };
    // rules sorted by name; names first in the pool
    const rules = [...this.rules].map(r => ({ ...r, nb: te.encode(r.name) })).sort((a, b) => cmpBytes(a.nb, b.nb));
    for (const r of rules) r.off = poolAt(r.nb);
    // keys: every literal key named by any map
    const keySet = new Map();
    for (const m of this.maps) for (const p of m.pools) for (const alt of p.alts) for (const e of alt) {
      const kb = keyBytes(e.key); keySet.set(Buffer.from(kb).toString('hex'), kb);
    }
    const keys = [...keySet.values()].sort(cmpBytes);
    const keyId = new Map(keys.map((k, i) => [Buffer.from(k).toString('hex'), i]));
    const kid = k => keyId.get(Buffer.from(keyBytes(k)).toString('hex'));
    const keyOff = keys.map(k => poolAt(k));
    // intervals and literals
    const intervals = [], fintervals = [], litrefs = [];
    const bound = v => {
      if (v === -Infinity) return [0, 0, 0];
      if (v === Infinity) return [5, 0, 0];
      v = BigInt(v);
      if (v >= U64) { const m = mag(v); return [4, poolAt(m), m.length]; }
      if (v >= 0n) return [3, Number((v >> 32n) & 0xffffffffn) | 0, Number(v & 0xffffffffn) | 0];
      const n = -1n - v;
      if (n >= U64) { const m = mag(n); return [1, poolAt(m), m.length]; }
      return [2, Number((n >> 32n) & 0xffffffffn) | 0, Number(n & 0xffffffffn) | 0];
    };
    const leafRec = [];
    for (const lf of L) {
      let flags = 0, mask = 0, d = [0, 0, 0, 0, 0, 0];
      switch (lf.kind) {
        case K.ANY: mask = 0xfff; break;
        case K.MAJOR: d[0] = lf.major; mask = [1, 2, 4, 8, 0x10, 0x20, 0x840, 0x780][lf.major]; break;
        case K.INT: {
          flags = lf.bigok ? 1 : 0; d[0] = intervals.length / 6; d[1] = lf.intervals.length;
          for (const [lo, hi] of lf.intervals) {
            const a = bound(lo), b = bound(hi); intervals.push(...a, ...b);
            const meets = r => a[0] <= r && r <= b[0];
            if (meets(3)) mask |= 1; if (meets(2)) mask |= 2; if (lf.bigok && (meets(1) || meets(4))) mask |= 0x800;
          }
          break;
        }
        case K.FLOAT: flags = lf.widths; mask = lf.widths << 8; d[0] = fintervals.length / 4; d[1] = lf.fintervals.length;
          for (const [lo, hi] of lf.fintervals) fintervals.push(...fkey(lo), ...fkey(hi)); break;
        case K.SIMPLE: d[0] = lf.v; mask = 0x080; break;
        case K.LIT: d[0] = poolAt(lf.bytes); d[1] = lf.bytes.length; mask = classOf(lf.bytes); break;
        case K.LITSET: d[0] = litrefs.length / 2; d[1] = lf.list.length; mask = classOf(lf.list[0]);
          for (const b of lf.list) litrefs.push(poolAt(b), b.length); break;
        case K.TEXT: d[0] = lf.lo; d[1] = lf.hi; d[2] = lf.rx; mask = 0x008; break;
        case K.BYTES: d[0] = lf.lo; d[1] = lf.hi; if (lf.bits) { d[2] = poolAt(lf.bits); d[3] = lf.bits.length; } mask = 0x004; break;
        case K.UINTX: d[0] = Number((lf.allowed >> 32n) & 0xffffffffn) | 0; d[1] = Number(lf.allowed & 0xffffffffn) | 0;
          d[2] = intervals.length / 6; d[3] = lf.intervals.length;
          for (const [lo, hi] of lf.intervals) intervals.push(...bound(lo), ...bound(hi)); mask = 0x001; break;
        case K.TAG: d[0] = Number(lf.n >> 32n) | 0; d[1] = Number(lf.n & 0xffffffffn) | 0; d[2] = lf.ts;
          mask = (lf.n === 2n || lf.n === 3n) ? 0x800 : 0x040; break;
        case K.TAGSET: d[0] = Number(lf.lo >> 32n) | 0; d[1] = Number(lf.lo & 0xffffffffn) | 0;
          d[2] = Number(lf.hi >> 32n) | 0; d[3] = Number(lf.hi & 0xffffffffn) | 0; d[4] = lf.ts;
          if (lf.hi - lf.lo + 1n > 2n || !(lf.lo >= 2n && lf.hi <= 3n)) mask |= 0x040;
          if (lf.lo <= 3n && lf.hi >= 2n) mask |= 0x800; break;
        case K.EMBED: flags = lf.seq ? 1 : 0; d[0] = lf.ts; mask = 0x004; break;
        case K.ARRAY: d[0] = lf.array; mask = 0x010; break;
        case K.MAP: d[0] = lf.map; mask = 0x020; break;
        case K.AND: d[0] = lf.a; d[1] = lf.b; break;
        case K.NOT: d[0] = lf.a; d[1] = lf.b; break;
        default: throw Error('kind ' + lf.kind);
      }
      leafRec.push({ kind: lf.kind, flags, mask, d });
    }
    // AND/NOT masks need operands' masks (operands may come later in id order)
    const maskOf = l => { const r = leafRec[l]; if (r.kind === K.AND) return maskOf(r.d[0]) & maskOf(r.d[1]); if (r.kind === K.NOT) return maskOf(r.d[0]); return r.mask; };
    for (let l = 0; l < L.length; l++) leafRec[l].mask = maskOf(l);
    // bits masks after literals
    // groups
    const W = n => (n + 31) >> 5;
    // maps: derive layout
    const mapRecs = this.maps.map(m => {
      const factors = m.factors ?? [{ mode: 0, pPool: -1 }];
      const pools = m.pools; // [{factor, group, alts:[[{key, ts, min, cut}]]}]
      const alts = [], lits = [];
      pools.forEach((p, pi) => { p.altFirst = alts.length; for (const a of p.alts) { const lf = lits.length; for (const e of a) lits.push({ ...e, kid: kid(e.key) }); alts.push({ pool: pi, litFirst: lf, litCount: a.length, req: a.filter(e => e.min === 1).length }); } p.altCount = p.alts.length; });
      // factors' pool runs
      const fr = factors.map((f, fi) => { const ps = pools.map((p, i) => [p, i]).filter(([p]) => p.factor === fi); return { ...f, first: ps.length ? ps[0][1] : 0, count: ps.length }; });
      // key index
      const names = []; const keyRecs = [];
      const byKey = new Map();
      alts.forEach((a, ai) => { for (let j = 0; j < a.litCount; j++) { const li = a.litFirst + j; const k = lits[li].kid; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push([ai, li]); } });
      for (const k of [...byKey.keys()].sort((x, y) => x - y)) {
        const recs = byKey.get(k).sort((x, y) => x[0] - y[0]);
        const owner = pools[alts[recs[0][0]].pool].factor;
        keyRecs.push([k, owner, names.length, recs.length]); names.push(...recs);
      }
      // state layout
      let off = 4 + factors.length;
      const poolOff = pools.map(p => { const o2 = off; const ne = p.group >= 0 ? this.groups[p.group].length : 0; off += 4 + ne; return o2; });
      const altOff = alts.map(a => { const o2 = off; off += 3 + ((a.litCount + 31) >> 5); return o2; });
      let candMax = 0;
      pools.forEach(p => { if (p.factor === 0 && p.group >= 0) candMax += this.groups[p.group].length; });
      candMax += keyRecs.reduce((m, r) => Math.max(m, r[3]), 0);
      return { factors: fr, pools, alts, lits, keyRecs, names, poolOff, altOff, stateWords: off, candMax };
    });
    // arrays
    const arrRecs = this.arrays.map(a => {
      const npos = a.positions.length, w = W(npos);
      const bits = list => { const v = new Array(w).fill(0); for (const p of list) v[p >> 5] |= 1 << (p & 31); return v; };
      const counters = []; const pos = a.positions.map(p => { let c = -1; if (p.counter) { c = counters.length; counters.push(p.counter); } return [p.ts, c]; });
      const follow = []; for (let p = 0; p < npos; p++) follow.push(...bits(a.follow[p] ?? []));
      return { npos, w, nc: counters.length, nullable: a.nullable ? 1 : 0, first: bits(a.first), accept: bits(a.accept), pos, counters, follow };
    });
    const rxRecs = this.regexps.map(r => {
      const npos = r.npos, w = W(npos);
      const bits = list => { const v = new Array(w).fill(0); for (const p of list) v[p >> 5] |= 1 << (p & 31); return v; };
      const follow = []; for (let p = 0; p < npos; p++) follow.push(...bits(r.follow[p] ?? []));
      return { npos, w, natoms: r.atoms.length, nullable: r.nullable ? 1 : 0, first: bits(r.first), accept: bits(r.accept), follow,
        astart: r.atoms.map(a => a.start), amask: r.atoms.flatMap(a => bits(a.mask)) };
    });
    // closure: children of a leaf
    const children = l => {
      const lf = L[l];
      switch (lf.kind) {
        case K.ANY: return tsAny >= 0 ? [tsAny] : [];
        case K.MAJOR: return (lf.major >= 4 && lf.major <= 6 && tsAny >= 0) ? [tsAny] : [];
        case K.TAG: case K.TAGSET: case K.EMBED: return [lf.ts];
        case K.ARRAY: return this.arrays[lf.array].positions.map(p => p.ts);
        case K.MAP: { const m = this.maps[lf.map]; const out = []; for (const p of m.pools) { for (const a of p.alts) for (const e of a) out.push(e.ts); if (p.group >= 0) for (const g of this.groups[p.group]) out.push(g.key, g.value); } return out; }
        default: return [];
      }
    };
    const csets = [], csetKey = new Map(), chains = [], chainKey = new Map();
    const internCset = leaves => { const k = leaves.join(','); if (csetKey.has(k)) return csetKey.get(k); csets.push(leaves); csetKey.set(k, csets.length - 1); return csets.length - 1; };
    for (const r of rules) {
      let R = [...new Set(this.closureOf(r.ts))].sort((a, b) => a - b);
      const seq = []; let rep = -1;
      for (let k = 0; k <= o.depth; k++) {
        if (R.length === 0) break;
        const key = R.join(','); const j = seq.findIndex(x => x.join(',') === key);
        if (j >= 0) { rep = j; break; }
        seq.push(R);
        const next = new Set(); for (const l of R) for (const ts of children(l)) for (const x of this.closureOf(ts)) next.add(x);
        R = [...next].sort((a, b) => a - b);
      }
      const ids = seq.map(internCset);
      const ck = JSON.stringify([ids, rep]);
      if (!chainKey.has(ck)) { chains.push({ ids, rep }); chainKey.set(ck, chains.length - 1); }
      r.chain = chainKey.get(ck);
    }
    const frameWords = R => {
      let ma = 0, aa = 0, rx = 0;
      for (const l of R) { const lf = L[l];
        if (lf.kind === K.MAP) { const m = mapRecs[lf.map]; ma += m.stateWords + 4 * m.candMax; }
        if (lf.kind === K.ARRAY) { const a = arrRecs[lf.array]; aa += 3 + 2 * a.w + a.nc; }
        if (lf.kind === K.TEXT && lf.rx >= 0) rx += 2 * rxRecs[lf.rx].w; }
      return { frame: 2 * R.length + Math.max(ma, aa), rx };
    };
    const csetInfo = csets.map(frameWords);
    const M = L.length;
    const chainAt = (ch, k) => { const c = chains[ch]; const n = c.ids.length; if (k < n) return c.ids[k]; if (c.rep < 0) return -1; return c.ids[c.rep + (k - c.rep) % (n - c.rep)]; };
    for (const r of rules) {
      let fr = 0, rxw = 0;
      for (let k = 0; k <= o.depth; k++) { const c = chainAt(r.chain, k); if (c >= 0) { fr += csetInfo[c].frame; rxw = Math.max(rxw, csetInfo[c].rx); } }
      r.scratch = 48 + 2 * M + 2 * (o.depth + 1) + rxw + fr;
    }
    // bits masks into the pool
    for (let l = 0; l < L.length; l++) if (L[l].kind === K.BYTES && L[l].bits) { /* already placed */ }
    // ---------------------------------------------------------------- lay out P
    const P = new Array(64).fill(0);
    const sec = [];
    const S = () => sec.push(P.length);
    S(); for (const r of rules) P.push(r.off, r.nb.length, r.ts, r.chain, r.scratch);
    S(); for (const lr of leafRec) P.push(lr.kind | (lr.flags << 8), lr.mask, ...lr.d);
    S(); const tsIndexAt = P.length; for (let i = 0; i < this.typesets.length; i++) P.push(0);
    S(); this.typesets.forEach((t, i) => { P[tsIndexAt + i] = P.length; const ev = this.evalList(i); P.push(t.ans.length, ev ? ev.length : 0, ...t.ans, ...(ev ?? [])); });
    S(); keys.forEach((k, i) => P.push(keyOff[i], k.length));
    S(); const gIndexAt = P.length; for (let i = 0; i < this.groups.length; i++) P.push(0);
    S(); this.groups.forEach((g, i) => { P[gIndexAt + i] = P.length; P.push(g.length, g.filter(e => !(e.min === 0 && e.max === INF)).length); for (const e of g) P.push(e.key, e.value, e.min, e.max); });
    S(); const mIndexAt = P.length; for (let i = 0; i < mapRecs.length; i++) P.push(0);
    S(); mapRecs.forEach((m, i) => {
      P[mIndexAt + i] = P.length;
      P.push(m.factors.length, m.pools.length, m.alts.length, m.lits.length, m.keyRecs.length, m.names.length, m.stateWords, m.candMax);
      for (const f of m.factors) P.push(f.mode ?? 0, f.pPool ?? -1, f.first, f.count);
      m.pools.forEach((p, pi) => P.push(p.factor, p.group, p.altFirst, p.altCount, m.poolOff[pi]));
      m.alts.forEach((a, ai) => P.push(a.pool, a.litFirst, a.litCount, a.req, m.altOff[ai]));
      for (const e of m.lits) P.push(e.kid, e.ts, e.min, e.cut ?? 1);
      for (const r of m.keyRecs) P.push(...r);
      for (const [a, l] of m.names) P.push(a, l);
    });
    S(); const aIndexAt = P.length; for (let i = 0; i < arrRecs.length; i++) P.push(0);
    S(); arrRecs.forEach((a, i) => { P[aIndexAt + i] = P.length; P.push(a.npos, a.w, a.nc, a.nullable, ...a.first, ...a.accept); for (const p of a.pos) P.push(...p); for (const c of a.counters) P.push(...c); P.push(...a.follow); });
    S(); const rIndexAt = P.length; for (let i = 0; i < rxRecs.length; i++) P.push(0);
    S(); rxRecs.forEach((r, i) => { P[rIndexAt + i] = P.length; P.push(r.npos, r.w, r.natoms, r.nullable, ...r.first, ...r.accept, ...r.follow, ...r.astart, ...r.amask); });
    S(); P.push(...intervals);
    S(); P.push(...fintervals);
    S(); P.push(...litrefs);
    S(); const cIndexAt = P.length; for (let i = 0; i < csets.length; i++) P.push(0);
    S(); csets.forEach((c, i) => { P[cIndexAt + i] = P.length; P.push(c.length, csetInfo[i].frame, csetInfo[i].rx, ...c); });
    S(); const chIndexAt = P.length; for (let i = 0; i < chains.length; i++) P.push(0);
    S(); chains.forEach((c, i) => { P[chIndexAt + i] = P.length; P.push(c.ids.length, c.rep, ...c.ids); });
    const end = P.length;
    let flags = 0;
    if (keys.some(k => (k[0] >> 5) <= 1)) flags |= 1;
    if (L.some(l => l.kind === K.TEXT && l.rx >= 0)) flags |= 2;
    if (L.some(l => l.kind === K.EMBED)) flags |= 4;
    if (L.some(l => l.kind === K.AND || l.kind === K.NOT)) flags |= 8;
    const hdr = [0x67756e73, 1, 64, end, pool.length, o.profile, flags, 0, 0, 0, 0, 0, 0, 0, 0,
      rules.length, L.length, this.typesets.length, keys.length, this.groups.length, mapRecs.length, arrRecs.length, rxRecs.length,
      intervals.length / 6, fintervals.length / 4, litrefs.length / 2, csets.length, chains.length, tsAny, this.groups.findIndex(g => g.length === 0), 0, 0,
      o.depth, o.input, o.entries, o.items, o.bignum, o.budget, o.total, 0, Math.max(0, ...rules.map(r => r.scratch)), 0,
      ...sec, end, 0];
    for (let i = 0; i < 64; i++) P[i] = hdr[i];
    return { P: Int32Array.from(P), B: Uint8Array.from(pool), ruleIndex: Object.fromEntries(rules.map((r, i) => [r.name, i])) };
  }
}

// float interval bound: a JS number (or {key:[hi,lo]}) to its ordered key
export function fkey(x) {
  if (Array.isArray(x)) return x;
  const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, x);
  let hi = dv.getUint32(0), lo = dv.getUint32(4);
  if (hi >>> 31) { hi = ~hi; lo = ~lo; } else hi = (hi | 0x80000000) >>> 0;
  return [hi | 0, lo | 0];
}

// one-leaf convenience: a Program with rule r = typeset of the given answers
export function program(build, opt) { const a = new Asm(opt); const r = build(a); a.rule(r.name ?? 'r', r.ts ?? r); return a.build(); }
