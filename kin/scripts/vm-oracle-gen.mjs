// Seeded random small CDDL schemas with value samplers, for the D022 oracle
// differential in bb vm-test: every schema the compiler accepts must give the
// VM's verdict == corpus/tools/oracle.mjs's on every value. Extends the shapes
// of corpus/tools/export-adversarial.mjs's generator (optional factors with
// wildcards, top-level group choices, bounded occurrences, array prefixes)
// with nesting, cuts, repeated literal groups, controls, literals, choices of
// containers, .and/.ne, regexps, tags and embedded CBOR. Values come from a
// sampler that follows the type (so many match) plus random noise.
let state = 1;
const rand = n => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % n; };
const choose = xs => xs[rand(xs.length)];
const te = new TextEncoder();

const noise = d => {
  const r = rand(d > 0 ? 14 : 11);
  switch (r) {
    case 0: return rand(4);
    case 1: return -1 - rand(3);
    case 2: return choose([255, 256, 65536, 2 ** 32, 1n << 64n, -(1n << 64n) - 1n]);
    case 3: return choose(['', 'a', 'b', 'x', 'ab', 'kind', 'é']);
    case 4: return choose([true, false, null]);
    case 5: return choose([1.5, -2.25, 0.1, 1e300]);
    case 6: return Uint8Array.from({ length: rand(3) }, () => rand(256));
    case 7: return choose([0, 1, 2, 3]);
    case 8: return choose(['x', 'y']);
    case 9: return rand(2) === 0;
    case 10: return choose([-1, 7, 300]);
    case 11: return Array.from({ length: rand(4) }, () => noise(d - 1));
    case 12: { const o = {}; for (let i = rand(4); i > 0; i--) o[choose(['a', 'b', 'c', 'k', 'x', 'kind'])] = noise(d - 1); return o; }
    default: return [noise(d - 1)];
  }
};

// a type: {t: cddl text, s: () => a value that often matches}
const SCALARS = [
  { t: 'uint', s: () => rand(5) },
  { t: 'int', s: () => rand(5) - 2 },
  { t: 'nint', s: () => -1 - rand(3) },
  { t: 'tstr', s: () => choose(['', 'a', 'xy']) },
  { t: 'bstr', s: () => Uint8Array.from({ length: rand(3) }, () => rand(256)) },
  { t: 'bool', s: () => rand(2) === 0 },
  { t: 'null', s: () => null },
  { t: 'float', s: () => choose([1.5, -0.5, 3.25]) },
  { t: '0..3', s: () => rand(5) },
  { t: '-2..2', s: () => rand(6) - 3 },
  { t: '"x"', s: () => choose(['x', 'y']) },
  { t: '1', s: () => rand(3) },
  { t: '(1 / "a" / true)', s: () => choose([1, 'a', true, 2]) },
  { t: 'tstr .size (0..2)', s: () => choose(['', 'ab', 'abc']) },
  { t: 'bstr .size 1', s: () => Uint8Array.from({ length: rand(3) }, () => 7) },
  { t: 'uint .lt 3', s: () => rand(5) },
  { t: 'int .ne 0', s: () => rand(3) - 1 },
  { t: '(uint / tstr)', s: () => choose([1, 'a', null]) },
  { t: 'tstr .regexp "[ab]+c?"', s: () => choose(['a', 'abc', 'c', 'ba', '']) },
  { t: 'uint .bits (0 / 2)', s: () => rand(8) },
  { t: 'integer', s: () => choose([0, -5, 1n << 70n, -(1n << 70n)]) },
  { t: '1.5 / 2.5', s: () => choose([1.5, 2.5, 3.5]) },
  { t: 'bstr .cbor uint', s: () => choose([Uint8Array.of(1), Uint8Array.of(0x61, 0x61), Uint8Array.of(0xff)]) },
  { t: '(tstr .size 1) .and "a"', s: () => choose(['a', 'b', 'ab']) },
  { t: '#6.2(bstr)', s: () => choose([1n << 64n, 5]) },
];
const KEYS = ['a', 'b', 'c', 'k'];
function genType(d) {
  if (d <= 0 || rand(3) === 0) return choose(SCALARS);
  const T = () => genType(d - 1);
  switch (rand(12)) {
    case 0: { const x = T(); return { t: `[* ${x.t}]`, s: () => Array.from({ length: rand(4) }, x.s) }; }
    case 1: { const x = T(), y = T(); return { t: `[${x.t}, ${y.t}]`, s: () => rand(5) ? [x.s(), y.s()] : [x.s()] }; }
    case 2: { const x = T(), y = T(), lo = rand(3), hi = lo + rand(3);
      return { t: `[? ${x.t}, ${lo}*${hi} ${y.t}]`, s: () => [...(rand(2) ? [x.s()] : []), ...Array.from({ length: lo + rand(hi - lo + 2) }, y.s)] }; }
    case 3: { const x = T(), y = T(); return { t: `{ a: ${x.t}, ? b: ${y.t} }`, s: () => { const o = { a: x.s() }; if (rand(2)) o.b = y.s(); if (!rand(5)) o.c = 1; return o; } }; }
    case 4: { const x = T(); return { t: `{ * tstr => ${x.t} }`, s: () => { const o = {}; for (let i = rand(3); i > 0; i--) o[choose(KEYS)] = x.s(); return o; } }; }
    case 5: { const x = T(), y = T(); return { t: `{ a: ${x.t} // b: ${y.t} }`, s: () => rand(2) ? { a: x.s() } : rand(3) ? { b: y.s() } : { a: x.s(), b: y.s() } }; }
    case 6: { const x = T(), y = T(); return { t: `{ ? (a: ${x.t}, b: ${y.t}), * tstr => ${choose(['any', 'int', 'tstr'])} }`,
      s: () => { const o = {}; if (rand(2)) { o.a = x.s(); if (rand(3)) o.b = y.s(); } if (rand(2)) o.k = choose([1, 'z']); return o; } }; }
    case 7: { const x = T(); return { t: `{ + (a: ${x.t} // b: ${x.t}) }`, s: () => { const o = {}; if (rand(3)) o.a = x.s(); if (rand(2)) o.b = x.s(); return o; } }; }
    case 8: { const x = T(), y = T(); return { t: `${x.t} / ${y.t}`, s: () => rand(2) ? x.s() : y.s() }; }
    case 9: { const x = T(); return { t: `{ ? "a" ^ => ${x.t}, * tstr => any }`, s: () => { const o = {}; if (rand(2)) o.a = rand(2) ? x.s() : noise(1); if (rand(2)) o.b = 1; return o; } }; }
    case 10: { const x = T(), y = T(); return { t: `[* (${x.t}, ${y.t})]`, s: () => Array.from({ length: 2 * rand(3) + (rand(4) ? 0 : 1) }, (_, i) => i % 2 ? y.s() : x.s()) }; }
    default: { const x = T(); return { t: `{ kind: "a", v: ${x.t} // kind: "b", ? w: ${x.t} }`, s: () => rand(2) ? { kind: 'a', v: x.s() } : rand(2) ? { kind: 'b', w: x.s() } : { kind: choose(['a', 'b', 'c']), v: x.s() } }; }
  }
}

/** [{cddl, values}] -- n schemas, k values each, from xorshift32 seed. */
export function oracleSchemas(n, k, seed) {
  state = (seed | 0) || 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const ty = genType(1 + rand(3));
    const values = [];
    for (let j = 0; j < k; j++) values.push(rand(4) ? ty.s() : noise(2));
    out.push({ cddl: `r = ${ty.t}`, values });
  }
  return out;
}
