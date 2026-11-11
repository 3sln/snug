// Seeded random small CDDL schemas with value samplers for the PEG oracle
// differential in bb vm-test (P8.5, D279, architecture §20.12): every schema the
// compiler accepts must give the VM's verdict == corpus/tools/peg-oracle.mjs's
// on every value, in both cut modes. The shapes are the group constructs PEG
// semantics decide (§20.2-§20.3): group choices that lock in, nested and
// saturated occurrences, zero-length bodies, unplugged sockets, cuts on literal
// and typeset keys (with named diagnostic keys), duplicate literal members,
// order-sensitive members, guarded (centre) recursion in arrays and maps, and
// `.cborseq` virtual arrays. Values follow the type (so many match) plus noise;
// maps may be written with their pairs in any order (`shuffle`), for the valid
// preset's unsorted maps.
let state = 1;
const rand = n => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % n; };
const choose = xs => xs[rand(xs.length)];

// ---------------------------------------------------------------- values and their encoding
// A value is {k: 'i', v} | {k: 't', v} | {k: 'b', v: number[]} | {k: 's', v} (simple) |
// {k: 'a', v: [...]} | {k: 'm', v: [[key, value]...]} (wire order).
const I = v => ({ k: 'i', v }), T = v => ({ k: 't', v }), A = v => ({ k: 'a', v }), M = v => ({ k: 'm', v });
const B = v => ({ k: 'b', v }), S = v => ({ k: 's', v });
function head(m, n) {
  if (n < 24) return [m * 32 + n];
  if (n < 256) return [m * 32 + 24, n];
  if (n < 65536) return [m * 32 + 25, n >> 8, n & 255];
  return [m * 32 + 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const cmpBytes = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };
/** The value's CBOR bytes: deterministic, unless `shuffle` writes map pairs in a random order. */
export function encodeValue(x, shuffle = false) {
  switch (x.k) {
    case 'i': return x.v < 0 ? head(1, -1 - x.v) : head(0, x.v);
    case 't': { const b = [...new TextEncoder().encode(x.v)]; return head(3, b.length).concat(b); }
    case 'b': return head(2, x.v.length).concat(x.v);
    case 's': return [0xe0 + x.v];
    case 'a': return head(4, x.v.length).concat(...x.v.map(e => encodeValue(e, shuffle)));
    case 'm': {
      const pairs = x.v.map(([k, v]) => [encodeValue(k, shuffle), encodeValue(v, shuffle)]);
      const seen = new Set();
      const uniq = pairs.filter(([k]) => { const h = k.join(','); if (seen.has(h)) return false; seen.add(h); return true; });
      if (shuffle) { for (let i = uniq.length - 1; i > 0; i--) { const j = rand(i + 1); [uniq[i], uniq[j]] = [uniq[j], uniq[i]]; } }
      else uniq.sort((p, q) => cmpBytes(p[0], q[0]));
      return head(5, uniq.length).concat(...uniq.map(([k, v]) => k.concat(v)));
    }
  }
  throw new Error('value kind ' + x.k);
}

const noise = d => {
  switch (rand(d > 0 ? 9 : 7)) {
    case 0: return I(rand(4));
    case 1: return I(-1 - rand(3));
    case 2: return T(choose(['', 'a', 'b', 'x', 'kind', 'z']));
    case 3: return S(choose([20, 21, 22]));
    case 4: return B(Array.from({ length: rand(3) }, () => rand(256)));
    case 5: return I(choose([255, 256, 70000]));
    case 6: return T(choose(['ab', 'é']));
    case 7: return A(Array.from({ length: rand(4) }, () => noise(d - 1)));
    default: return M(Array.from({ length: rand(3) }, () => [T(choose(['a', 'b', 'c', 'k'])), noise(d - 1)]));
  }
};

// a type: {t: cddl text, s: () => a value that often matches}
const SCALARS = [
  { t: 'uint', s: () => I(rand(5)) },
  { t: 'int', s: () => I(rand(5) - 2) },
  { t: 'tstr', s: () => T(choose(['', 'a', 'xy'])) },
  { t: 'bool', s: () => S(choose([20, 21])) },
  { t: '0..3', s: () => I(rand(5)) },
  { t: '"x"', s: () => T(choose(['x', 'y'])) },
  { t: '1', s: () => I(rand(3)) },
  { t: '(uint / tstr)', s: () => choose([I(1), T('a'), S(22)]) },
  { t: 'any', s: () => noise(1) },
  { t: 'bstr', s: () => B([rand(256)]) },
];
const KEYS = ['a', 'b', 'c', 'k'];
const kv = (k, x) => [T(k), x];
const maybe = (p, f) => (rand(p) ? f() : []);
let gid = 0;

function genType(d, defs) {
  if (d <= 0 || rand(3) === 0) return choose(SCALARS);
  const Ty = () => genType(d - 1, defs);
  switch (rand(26)) {
    // ---- arrays
    case 0: { const x = Ty(); return { t: `[* ${x.t}]`, s: () => A(Array.from({ length: rand(4) }, x.s)) }; }
    case 1: { const x = Ty(), y = Ty(); return { t: `[* ${x.t}, ${y.t}]`, s: () => A([...Array.from({ length: rand(3) }, x.s), ...maybe(3, () => [y.s()])]) }; }
    case 2: { const x = Ty(), y = Ty(), lo = rand(3), hi = lo + 1 + rand(2);
      return { t: `[? ${x.t}, ${lo}*${hi} ${y.t}${rand(2) ? ', tstr' : ''}]`, s: () => A([...maybe(2, () => [x.s()]), ...Array.from({ length: lo + rand(hi - lo + 2) }, y.s), ...maybe(2, () => [T('t')])]) }; }
    case 3: { const x = Ty(), y = Ty(); return { t: `[(${x.t}, ${y.t}) // ${x.t}]`, s: () => A(rand(2) ? [x.s(), y.s()] : rand(2) ? [x.s()] : [x.s(), y.s(), x.s()]) }; }
    case 4: { const x = Ty(), y = Ty(); return { t: `[* (${x.t}, ${y.t})]`, s: () => A(Array.from({ length: 2 * rand(3) + (rand(4) ? 0 : 1) }, (_, i) => i % 2 ? y.s() : x.s())) }; }
    case 5: { const x = Ty(), y = Ty(); return { t: `[(* ${x.t}, ${y.t}) // (* ${x.t})]`, s: () => A([...Array.from({ length: rand(3) }, x.s), ...maybe(2, () => [y.s()])]) }; }
    case 6: { const x = Ty(); return { t: `[2*2 (? ${x.t})]`, s: () => A(Array.from({ length: rand(3) }, x.s)) }; }
    case 7: { const x = Ty(); return { t: `[16777216*16777216 (? ${x.t})]`, s: () => A(Array.from({ length: rand(2) }, x.s)) }; }
    case 8: { const x = Ty(); return { t: `[* ((${x.t}, ${x.t}) // ${x.t})]`, s: () => A(Array.from({ length: rand(5) }, x.s)) }; }
    case 9: { const x = Ty(), g = `g${gid++}`; defs.push(`${g} = (${x.t}, ? ${g})`);
      return { t: `[${g}]`, s: () => A(Array.from({ length: 1 + rand(4) }, x.s)) }; }
    case 10: { const x = Ty(), y = Ty(), g = `g${gid++}`; defs.push(`${g} = (${x.t}, ? ${g}, ${y.t})`);
      return { t: `[${g}]`, s: () => { const n = 1 + rand(3); return A([...Array.from({ length: n }, x.s), ...Array.from({ length: n - rand(2) + rand(2) }, y.s)]); } }; }
    case 11: { const x = Ty(), so = `$$s${gid++}`; return { t: rand(2) ? `[${so}]` : `[* ${so}, ? ${x.t}]`, s: () => A(Array.from({ length: rand(2) }, x.s)) }; }
    case 12: { const x = Ty(); return { t: `bstr .cborseq [* ${x.t}]`, s: () => B(Array.from({ length: rand(3) }, () => encodeValue(x.s())).flat()) }; }
    // ---- maps
    case 13: { const x = Ty(), y = Ty(); return { t: `{ a: ${x.t}, ? b: ${y.t} }`, s: () => M([kv('a', x.s()), ...maybe(2, () => [kv('b', y.s())]), ...maybe(5, () => [kv('c', I(1))]).slice(0, 0)]) }; }
    case 14: { const x = Ty(); return { t: `{ * tstr => ${x.t} }`, s: () => M(Array.from({ length: rand(3) }, () => kv(choose(KEYS), x.s()))) }; }
    case 15: { const x = Ty(), y = Ty(); return { t: `{ a: ${x.t} // b: ${y.t} }`, s: () => M(rand(2) ? [kv('a', x.s())] : rand(3) ? [kv('b', y.s())] : [kv('a', x.s()), kv('b', y.s())]) }; }
    case 16: { const x = Ty(), y = Ty(); return { t: `{ ? (a: ${x.t}, b: ${y.t}), * tstr => ${choose(['any', 'int', 'tstr'])} }`,
      s: () => M([...maybe(2, () => [kv('a', rand(3) ? x.s() : noise(1))]), ...maybe(2, () => [kv('b', y.s())]), ...maybe(2, () => [kv('k', choose([I(1), T('z')]))])]) }; }
    case 17: { const x = Ty(); return { t: `{ + (a: ${x.t} // b: ${x.t}) }`, s: () => M([...maybe(3, () => [kv('a', x.s())]), ...maybe(2, () => [kv('b', x.s())])]) }; }
    case 18: { const x = Ty(); return { t: `{ ? "a" ^=> ${x.t}, * tstr => any }`, s: () => M([...maybe(2, () => [kv('a', rand(2) ? x.s() : noise(1))]), ...maybe(2, () => [kv('b', I(1))])]) }; }
    case 19: { const x = Ty(); return { t: `{ kind: "a", v: ${x.t} // kind: "b", ? w: ${x.t} }`, s: () => M(rand(2) ? [kv('kind', T('a')), kv('v', x.s())] : rand(2) ? [kv('kind', T('b')), kv('w', x.s())] : [kv('kind', T(choose(['a', 'b', 'c']))), kv('v', x.s())]) }; }
    case 20: { const x = Ty(); return { t: `{ * tstr ^=> ${x.t}, ? "a" => any, ? "b" => any }`, s: () => M(Array.from({ length: rand(3) }, () => kv(choose(['a', 'b', 'c']), rand(2) ? x.s() : noise(0)))) }; }
    case 21: return { t: `{ int => int, int => 6 }`, s: () => M([[I(rand(5)), I(choose([5, 6]))], [I(rand(5)), I(choose([5, 6]))]]) };
    case 22: { const x = Ty(), y = Ty(); return { t: `{ 1*2 tstr => ${x.t}, * tstr => ${y.t} }`, s: () => M(Array.from({ length: rand(4) }, () => kv(choose(KEYS), rand(2) ? x.s() : y.s()))) }; }
    case 23: { const x = Ty(); return { t: `{ ? a: ${x.t}, ? a: tstr, * tstr => any }`, s: () => M([...maybe(2, () => [kv('a', rand(2) ? x.s() : T('s'))]), ...maybe(3, () => [kv('k', I(0))])]) }; }
    case 24: { const x = Ty(); return { t: choose([`{ 2*2 (+ tstr => ${x.t}) }`, `{ (a: ${x.t}) // (), * tstr => any }`, `{ * tstr => any, (a: ${x.t} // b: ${x.t}) }`, `{ * (int => ${x.t} // tstr => tstr) }`]),
      s: () => M(Array.from({ length: rand(4) }, () => (rand(3) ? kv(choose(KEYS), rand(2) ? x.s() : T('t')) : [I(rand(3)), x.s()]))) }; }
    default: { const x = Ty(), g = `m${gid++}`; defs.push(`${g} = (tstr => ${x.t}, ? ${g})`);
      return { t: `{ ${g} }`, s: () => M(Array.from({ length: 1 + rand(3) }, () => kv(choose(KEYS), x.s()))) }; }
  }
}

/** [{cddl, values: [{bytes, shuffled}]}] -- n schemas, k values each, from xorshift32 seed. */
export function pegSchemas(n, k, seed) {
  state = (seed | 0) || 1;
  gid = 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const defs = [];
    const ty = genType(1 + rand(3), defs);
    const values = [];
    for (let j = 0; j < k; j++) {
      const v = rand(5) ? ty.s() : noise(2);
      const shuffled = rand(3) === 0;
      values.push({ bytes: Uint8Array.from(encodeValue(v, shuffled)), shuffled });
    }
    out.push({ cddl: [`r = ${ty.t}`, ...defs].join('\n'), values });
  }
  return out;
}
