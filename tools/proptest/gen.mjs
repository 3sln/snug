// P4.2 generators: seeded schemas, values, near misses, byte mutations.
//
// Everything here is a pure function of a PRNG (host/js/test/random.mjs,
// mulberry32), so a case is reproduced by (property, seed, index) alone.
// Reused: vm-oracle-gen.mjs's oracleSchemas (D022 shapes), corpus.mjs's
// random profile values and byte mutations, the conformance corpus, and a copy
// of compile-fuzz.mjs's random/well-formed/mutating/hostile CDDL grammar
// (that script runs on import, so it cannot be imported). Extended with a
// typed schema generator biased to maps with optional groups, choices and
// wildcards, arrays with occurrences/counters, controls, tags, embedded CBOR,
// generics, recursion and regexps (with \p{..} through snug/unicode).
import { readFileSync, readdirSync } from 'node:fs';
import { createRandom } from '../../host/js/test/random.mjs';
import { randomValue, randomMap, randomInteger, randomFloat, randomString, randomBytes, randomTyped, randomDecimal, mutate as mutateOnce }
  from '../../host/js/test/corpus.mjs';
import { oracleSchemas } from '../../kin/scripts/vm-oracle-gen.mjs';
import { Decimal, NDArray, Float16Bytes } from '../../host/js/src/values.mjs';
import { encode } from '../../host/js/src/encode.mjs';

export { createRandom, randomValue, randomMap, mutateOnce };
const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');

/** A 32-bit case seed from (campaign seed, property, index). */
export function caseSeed(seed, prop, index) {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (const x of [prop * 0x9e3779b1, index >>> 0, (index / 4294967296) >>> 0]) {
    h = Math.imul(h ^ (x >>> 0), 0x01000193) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
  }
  return h >>> 0 || 1;
}

// ---------------------------------------------------------------- the conformance corpus
export const corpusSuites = [];
for (const f of ['study', 'adversarial']) for (const x of JSON.parse(read(`corpus/conformance/${f}.json`)).suites) {
  if (x.cddl && Array.isArray(x.cases) && x.cases.length) corpusSuites.push({ cddl: x.cddl, cases: x.cases, name: x.name });
}
export const corpusTexts = corpusSuites.map(s => s.cddl);
for (const f of readdirSync(new URL('corpus/cddl-study/contracts/', root))) corpusTexts.push(read('corpus/cddl-study/contracts/' + f));

// ---------------------------------------------------------------- the typed schema generator
// A node is { t: CDDL text, s: () => a value that usually matches, u?: true when
// it needs the Unicode tables }. Samplers close over the case PRNG `r`.
const te = new TextEncoder();
const enc = v => encode(v, { top: 'any' });

/** Regexps with samplers: [pattern, matching samples, near misses, needs Unicode tables]. */
const REGEXPS = [
  ['[a-z]+', ['a', 'abc', 'zz'], ['', 'A', 'a1']],
  ['(ab|c){1,3}', ['ab', 'c', 'abcab', 'ccc'], ['', 'abab cab', 'abcabc c', 'b']],
  ['[^x]?', ['', 'a', 'é'], ['x', 'ab']],
  ['a.b', ['a-b', 'aéb', 'a😀b'], ['a\nb', 'ab', 'a\rb']],
  ['[0-9]{2,4}-x', ['12-x', '1234-x'], ['1-x', '12345-x', '12x']],
  ['\\.', ['.'], ['a', '\\.']],
  ['(a|)', ['', 'a'], ['aa', 'b']],
  ['x{0}', [''], ['x']],
  ['[a-z][a-z0-9-]{0,20}', ['a', 'a-b-9'], ['-a', '9', 'A']],
  ['[😀-🙏]', ['😀', '🙏'], ['😀😀', 'a', '🙐']],
  ['(a|b)*c', ['c', 'abac'], ['ab', 'ca']],
  ['[a-cx-z]{2}', ['ax', 'zz'], ['ad', 'a']],
  ['\\n|\\t', ['\n', '\t'], ['n', '\r']],
  ['[\\-\\]]+', ['-', ']-'], ['', '\\']],
  ['\\p{Lu}[\\p{Ll}\\p{Nd}]*', ['A', 'Éa1', 'Zß٣'], ['a', 'A_', ''], true],
  ['\\P{L}+', ['1', '-!', '٣'], ['a1', ''], true],
  ['[\\p{L}\\p{Nd}_-]{1,4}', ['a', '水_1', 'é-'], ['', 'a b', 'abcde'], true],
  ['\\p{Nd}{2}', ['12', '٣٤'], ['1', 'a1', '123'], true],
  ['[^\\p{L}]', ['1', ' '], ['a', '水', ''], true],
  ['\\p{Sc}|\\p{Zs}', ['$', '€', ' '], ['a', '$$'], true],
  ['.\\P{Cs}', ['ab', '😀😀'], ['a', 'abc'], true],
  ['\\p{Lo}+', ['水', 'あい'], ['a', 'é'], true],
];
const regexNode = (r, unicode) => {
  const pool = unicode ? REGEXPS : REGEXPS.filter(x => !x[3]);
  const [pat, yes, no, u] = r.pick(pool);
  return { t: `tstr .regexp ${JSON.stringify(pat)}`, s: () => r.chance(0.75) ? r.pick(yes) : r.pick(no), u: !!u };
};
export const UNICODE_REGEXPS = REGEXPS;

function scalars(r, unicode) {
  const big = () => r.pick([1n << 64n, (1n << 64n) + 5n, 1n << 70n, (1n << 100n) - 1n]);
  return [
    { t: 'uint', s: () => r.pick([0, 1, 23, 24, 255, 256, 65535, 2 ** 32, Number.MAX_SAFE_INTEGER, -1]) },
    { t: 'int', s: () => r.int(9) - 4 },
    { t: 'nint', s: () => r.pick([-1, -24, -25, -256, 0]) },
    { t: 'tstr', s: () => r.pick(['', 'a', 'xy', 'é水']) },
    { t: 'text', s: () => r.pick(['', 'k']) },
    { t: 'bstr', s: () => Uint8Array.from({ length: r.int(4) }, () => r.int(256)) },
    { t: 'bool', s: () => r.chance(0.5) },
    { t: 'null', s: () => r.chance(0.9) ? null : false },
    { t: 'true', s: () => r.chance(0.8) },
    { t: 'float', s: () => r.pick([1.5, -0.5, 3.25, 1.1, 1e300]) },
    { t: 'float16', s: () => r.pick([1.5, -0.5, 1.1, 65504.5]) },
    { t: 'float32', s: () => r.pick([Math.fround(1.1), 1.5, 1.1]) },
    { t: 'float64', s: () => r.pick([1.1, 1.5, 1e300]) },
    { t: 'number', s: () => r.pick([1, -2, 1.5, 'x']) },
    { t: 'any', s: () => randomValue(r, { maxDepth: 2 }) },
    { t: 'integer', s: () => r.pick([0, -5, big(), -big(), 1.5]) },
    { t: 'biguint', s: () => r.pick([big(), 5, -big()]) },
    { t: 'bignint', s: () => r.pick([-big(), -5, big()]) },
    { t: 'unsigned', s: () => r.pick([0, 7, big(), -1]) },
    { t: 'decfrac', s: () => r.pick([Decimal.from('1.25'), Decimal.from('-0.001'), randomDecimal(r), 1.5]) },
    { t: '0..3', s: () => r.int(5) },
    { t: '-2..2', s: () => r.int(6) - 3 },
    { t: '0...10', s: () => r.pick([0, 9, 10]) },
    { t: '1..1000', s: () => r.pick([1, 1000, 1001, 0, 500]) },
    { t: '0.5..2.5', s: () => r.pick([0.5, 2.5, 1.5, 2.75, 0.25]) },
    { t: '"x"', s: () => r.pick(['x', 'y']) },
    { t: '1', s: () => r.int(3) },
    { t: '-1', s: () => r.pick([-1, 1]) },
    { t: "h'01ff'", s: () => r.pick([Uint8Array.of(1, 255), Uint8Array.of(1)]) },
    { t: "'ab'", s: () => r.pick([te.encode('ab'), 'ab']) },
    { t: '1.5', s: () => r.pick([1.5, 2.5]) },
    { t: '(1 / "a" / true)', s: () => r.pick([1, 'a', true, 2]) },
    { t: 'tstr .size (0..2)', s: () => r.pick(['', 'ab', 'abc', 'é']) },
    { t: 'tstr .size 3', s: () => r.pick(['abc', 'é1', 'ab']) },
    { t: 'bstr .size 1', s: () => Uint8Array.from({ length: r.int(3) }, () => 7) },
    { t: 'bstr .size (1..3)', s: () => Uint8Array.from({ length: r.int(5) }, () => 9) },
    { t: 'uint .size 1', s: () => r.pick([0, 255, 256]) },
    { t: 'uint .size (2..4)', s: () => r.pick([255, 256, 2 ** 32 - 1, 2 ** 32]) },
    { t: 'uint .lt 3', s: () => r.int(5) },
    { t: 'int .ge -2', s: () => r.int(5) - 3 },
    { t: 'int .le 10', s: () => r.pick([10, 11, -100]) },
    { t: 'int .gt 0', s: () => r.int(3) - 1 },
    { t: 'int .ne 0', s: () => r.int(3) - 1 },
    { t: 'uint .eq 2', s: () => r.int(4) },
    { t: 'tstr .eq "k"', s: () => r.pick(['k', 'kk']) },
    { t: 'tstr .ne ""', s: () => r.pick(['', 'a']) },
    { t: 'uint .bits (0 / 2)', s: () => r.int(8) },
    { t: 'bstr .bits (1 / 9)', s: () => r.pick([Uint8Array.of(2), Uint8Array.of(2, 2), Uint8Array.of(1), new Uint8Array(0)]) },
    { t: 'int .within (-5..5)', s: () => r.int(13) - 6 },
    { t: 'uint .within uint .lt 4', s: () => r.int(6) },
    { t: '(tstr .size 1) .and "a"', s: () => r.pick(['a', 'b', 'ab']) },
    { t: '(uint / tstr)', s: () => r.pick([1, 'a', null]) },
    { t: 'bstr .cbor uint', s: () => r.pick([Uint8Array.of(1), Uint8Array.of(0x61, 0x61), Uint8Array.of(0xff), Uint8Array.of(0x18, 0x01)]) },
    { t: 'bstr .cbor [* tstr]', s: () => enc(r.pick([['a'], [], ['a', 1]])) },
    { t: 'bstr .cborseq uint', s: () => r.pick([Uint8Array.of(1, 2), new Uint8Array(0), Uint8Array.of(1, 0x61)]) },
    { t: 'bstr .cbor { a: int }', s: () => enc(r.pick([{ a: 1 }, { a: 'x' }, { b: 1 }])) },
    { t: '#6.2(bstr)', s: () => r.pick([big(), 5]) },
    { t: '#6.3(bstr .size (9..10))', s: () => r.pick([-big(), -(1n << 72n), -(1n << 80n)]) },
    { t: '#6.4([int, int])', s: () => r.pick([Decimal.from('1.5'), Decimal.from('-12.34'), 1]) },
    { t: '#6.69(bstr)', s: () => r.pick([new Uint16Array([1, 2]), new Uint32Array([1]), Uint8Array.of(1)]) },
    { t: '#6.72(bstr .size (0..3))', s: () => r.pick([new Int8Array([1, -1]), new Int8Array(4), new Int16Array(1)]) },
    { t: '#6.85(bstr)', s: () => r.pick([new Float32Array([1.5]), new Float64Array([1.5])]) },
    { t: '#6.86(bstr .size 8)', s: () => r.pick([new Float64Array([0.1]), new Float64Array([1, 2])]) },
    { t: '#6.84(bstr)', s: () => r.pick([new Float16Bytes(Uint8Array.of(0, 0x3c)), new Float16Array([1.5]), new Uint16Array(1)]) },
    { t: '#6.40([[+ uint], [* any]])', s: () => r.pick([new NDArray([2], [1, 'a']), new NDArray([1, 2], [1, 2]), [1]]) },
    { t: '#6.40([[2, 2], #6.78(bstr)])', s: () => r.pick([new NDArray([2, 2], new Int32Array(4)), new NDArray([4], new Int32Array(4))]) },
    { t: '#6.<2..3>(bstr)', s: () => r.pick([big(), -big(), 1]) },
    { t: '#6.1(tstr)', s: () => r.pick(['x', 1]) },
    { t: '#0', s: () => r.pick([0, 7, -1]) },
    { t: '#1', s: () => r.pick([-1, 0]) },
    { t: '#2', s: () => r.pick([Uint8Array.of(1), 'a']) },
    { t: '#3', s: () => r.pick(['a', Uint8Array.of(1)]) },
    { t: '#7.25', s: () => r.pick([1.5, 1.1]) },
    { t: '#7.27', s: () => r.pick([1.1, 1.5]) },
    { t: '#7.20', s: () => r.pick([false, true]) },
    { t: '#7', s: () => r.pick([null, true, 1.5, 1]) },
    { t: '#', s: () => randomValue(r, { maxDepth: 1 }) },
    regexNode(r, unicode), regexNode(r, unicode),
  ];
}

const KEYS = ['a', 'b', 'c', 'k', 'id', 'kind', 'x', 'é'];
const OTHER_KEYS = ['m', 'n', 'zz', 'q', 'longer-key', '水'];
const obj = () => Object.create(null);
const counts = (r, lo, hi) => Math.max(0, lo + r.int(hi - lo + 2) - (r.chance(0.1) ? 1 : 0));

/**
 * One random schema: { text, rules: [validatable rule names], sample(), unicode }.
 * `unicode` true lets \p regexps in (the caller passes the tables to compile).
 */
export function typedSchema(r, { unicode = false, depth = 3 } = {}) {
  const rules = [];   // [name, node] hoisted named rules
  let ruleNo = 0, usesUnicode = false;
  const SC = scalars(r, unicode);
  const hoist = node => {
    if (!r.chance(0.15)) return node;
    const name = `t${ruleNo++}`;
    rules.push([name, node]);
    return { t: name, s: node.s, u: node.u };
  };
  const pickKey = () => r.pick(KEYS);
  function gen(d) {
    if (d <= 0 || r.chance(0.3)) { const x = r.pick(SC); if (x.u) usesUnicode = true; return x; }
    const T = () => gen(d - 1);
    let node;
    switch (r.int(26)) {
      // ---- maps
      case 0: { const x = T(), y = T(), z = T();
        node = { t: `{ a: ${x.t}, ? b: ${y.t}, * tstr => ${z.t} }`, s: () => { const o = obj(); o.a = x.s(); if (r.chance(0.5)) o.b = y.s(); for (let i = r.int(3); i > 0; i--) o[r.pick(OTHER_KEYS)] = z.s(); return o; } }; break; }
      case 1: { const x = T(), y = T();
        node = { t: `{ ? (a: ${x.t}, b: ${y.t}), * tstr => ${r.pick(['any', 'int', 'tstr'])} }`,
          s: () => { const o = obj(); if (r.chance(0.6)) { o.a = x.s(); if (r.chance(0.8)) o.b = y.s(); } if (r.chance(0.5)) o[r.pick(OTHER_KEYS)] = r.pick([1, 'z']); return o; } }; break; }
      case 2: { const x = T(), y = T(), z = T();
        node = { t: `{ (a: ${x.t} // b: ${y.t}), ? c: ${z.t} }`, s: () => { const o = obj(); if (r.chance(0.5)) o.a = x.s(); else o.b = y.s(); if (r.chance(0.1)) { o.a = x.s(); o.b = y.s(); } if (r.chance(0.5)) o.c = z.s(); return o; } }; break; }
      case 3: { const x = T();
        node = { t: `{ + (a: ${x.t} // b: ${x.t}) }`, s: () => { const o = obj(); if (r.chance(0.7)) o.a = x.s(); if (r.chance(0.5)) o.b = x.s(); return o; } }; break; }
      case 4: { const x = T();
        node = { t: `{ ? "a" ^ => ${x.t}, * tstr => any }`, s: () => { const o = obj(); if (r.chance(0.5)) o.a = r.chance(0.7) ? x.s() : randomValue(r, { maxDepth: 1 }); if (r.chance(0.5)) o.b = 1; return o; } }; break; }
      case 5: { const x = T(), lo = r.int(2), hi = lo + r.int(3);
        node = { t: `{ ${lo}*${hi} (tstr .size 1) => ${x.t} }`, s: () => { const o = obj(); for (let i = counts(r, lo, hi); i > 0; i--) o[r.pick(['a', 'b', 'c', 'd', 'ab'])] = x.s(); return o; } }; break; }
      case 6: { const x = T(), y = T();
        node = { t: `{ * (tstr .regexp "[a-c]") => ${x.t}, ? zz: ${y.t} }`, s: () => { const o = obj(); for (let i = r.int(4); i > 0; i--) o[r.pick(['a', 'b', 'c', 'd'])] = x.s(); if (r.chance(0.5)) o.zz = y.s(); return o; } }; break; }
      case 7: { const x = T();
        node = { t: `{ kind: "a", v: ${x.t} // kind: "b", ? w: ${x.t} }`, s: () => r.chance(0.45) ? Object.assign(obj(), { kind: 'a', v: x.s() }) : r.chance(0.8) ? Object.assign(obj(), { kind: 'b' }, r.chance(0.5) ? { w: x.s() } : {}) : Object.assign(obj(), { kind: r.pick(['a', 'b', 'c']), v: x.s(), w: x.s() }) }; break; }
      case 8: { const xs = [T(), T(), T(), T()], ks = ['a', 'b', 'c', 'kind'];
        node = { t: `{ ${xs.map((x, i) => `? ${ks[i]}: ${x.t}`).join(', ')} }`, s: () => { const o = obj(); xs.forEach((x, i) => { if (r.chance(0.5)) o[ks[i]] = x.s(); }); if (r.chance(0.05)) o.zz = 1; return o; } }; break; }
      case 9: { const x = T(), y = T(), z = T();
        node = { t: `{ a: ${x.t}, ? (b: ${y.t} // c: ${z.t}) }`, s: () => { const o = obj(); o.a = x.s(); const k = r.int(4); if (k === 1) o.b = y.s(); else if (k === 2) o.c = z.s(); else if (k === 3 && r.chance(0.3)) { o.b = y.s(); o.c = z.s(); } return o; } }; break; }
      case 10: { // a named group spliced into a map
        const x = T(), y = T(), g = `g${ruleNo++}`;
        rules.push([g, { t: `(a: ${x.t}, ? b: ${y.t})`, group: true }]);
        const z = T();
        node = { t: `{ ${g}, ? c: ${z.t} }`, s: () => { const o = obj(); o.a = x.s(); if (r.chance(0.5)) o.b = y.s(); if (r.chance(0.5)) o.c = z.s(); return o; } }; break; }
      case 11: { // unwrap of a map rule
        const x = T(), m = `m${ruleNo++}`;
        rules.push([m, { t: `{ a: ${x.t} }`, s: () => ({ a: x.s() }) }]);
        const y = T();
        node = { t: `{ ~${m}, ? b: ${y.t} }`, s: () => { const o = obj(); o.a = x.s(); if (r.chance(0.5)) o.b = y.s(); return o; } }; break; }
      case 12: { const x = T();
        node = { t: `{ * tstr => ${x.t} }`, s: () => { const o = obj(); for (let i = r.int(4); i > 0; i--) o[r.pick([...KEYS, ...OTHER_KEYS])] = x.s(); return o; } }; break; }
      // ---- arrays
      case 13: { const x = T(); node = { t: `[* ${x.t}]`, s: () => Array.from({ length: r.int(5) }, x.s) }; break; }
      case 14: { const x = T(); node = { t: `[+ ${x.t}]`, s: () => Array.from({ length: r.int(4) }, x.s) }; break; }
      case 15: { const x = T(), y = T(); node = { t: `[${x.t}, ${y.t}]`, s: () => r.chance(0.85) ? [x.s(), y.s()] : r.pick([[x.s()], [x.s(), y.s(), y.s()]]) }; break; }
      case 16: { const x = T(), y = T(), lo = r.int(3), hi = lo + r.int(3);
        node = { t: `[? ${x.t}, ${lo}*${hi} ${y.t}]`, s: () => [...(r.chance(0.5) ? [x.s()] : []), ...Array.from({ length: counts(r, lo, hi) }, y.s)] }; break; }
      case 17: { const x = T(), lo = r.int(4), hi = lo + r.int(5);
        node = { t: `[${lo}*${hi} ${x.t}]`, s: () => Array.from({ length: counts(r, lo, hi) }, x.s) }; break; }
      case 18: { const x = T(), y = T(); node = { t: `[* (${x.t}, ${y.t})]`, s: () => Array.from({ length: 2 * r.int(3) + (r.chance(0.2) ? 1 : 0) }, (_, i) => i % 2 ? y.s() : x.s()) }; break; }
      case 19: { const x = T(), y = T(); node = { t: `[${x.t}, * ${y.t}]`, s: () => [x.s(), ...Array.from({ length: r.int(4) }, y.s)] }; break; }
      case 20: { const x = T(), y = T(), z = T(); node = { t: `[${x.t}, ? ${y.t}, ? ${z.t}]`, s: () => [x.s(), ...(r.chance(0.6) ? [y.s(), ...(r.chance(0.5) ? [z.s()] : [])] : [])] }; break; }
      case 21: { const x = T(), y = T(), n = 2 + r.int(6);
        node = { t: `[${n}*${n} ${x.t}, ${y.t}]`, s: () => [...Array.from({ length: n + (r.chance(0.15) ? r.pick([-1, 1]) : 0) }, x.s), y.s()] }; break; }
      case 22: { const x = T(), y = T(); node = { t: `[* (a: ${x.t} // b: ${y.t})]`, s: () => Array.from({ length: r.int(4) }, () => r.chance(0.5) ? x.s() : y.s()) }; break; }
      // ---- choices, generics, recursion, embedded
      case 23: { const x = T(), y = T(); node = { t: `${x.t} / ${y.t}`, s: () => r.chance(0.5) ? x.s() : y.s() }; break; }
      case 24: { const x = T(), y = T(), g = `pair${ruleNo++}`;
        rules.push([g, { t: '[A, B]', params: '<A, B>' }]);
        node = { t: `${g}<${x.t}, ${y.t}>`, s: () => r.chance(0.9) ? [x.s(), y.s()] : [y.s()] }; break; }
      default: { const name = `rec${ruleNo++}`;
        if (r.chance(0.5)) {
          rules.push([name, { t: `uint / [* ${name}]` }]);
          const s = (k = 3) => (k <= 0 || r.chance(0.4)) ? r.pick([0, 1, 'x']) : Array.from({ length: r.int(3) }, () => s(k - 1));
          node = { t: name, s: () => s() };
        } else {
          rules.push([name, { t: `{ v: uint, ? kids: [* ${name}] }` }]);
          const s = (k = 3) => { const o = obj(); o.v = r.chance(0.95) ? r.int(3) : 'x'; if (k > 0 && r.chance(0.5)) o.kids = Array.from({ length: r.int(3) }, () => s(k - 1)); return o; };
          node = { t: name, s: () => s() };
        }
      }
    }
    return hoist(node);
  }
  const top = gen(depth);
  const lines = [`r = ${top.t}`];
  for (const [name, node] of rules) lines.push(`${name}${node.params ?? ''} = ${node.t}`);
  if (top.u) usesUnicode = true;
  const text = lines.join(r.chance(0.3) ? '\n\n' : '\n');
  const ruleNames = ['r', ...rules.filter(([, n]) => !n.group && !n.params).map(([n]) => n)];
  const samplers = { r: top.s };
  for (const [name, node] of rules) if (!node.group && !node.params && node.s) samplers[name] = node.s;
  return { text, rules: ruleNames, sample: top.s, samplers, unicode: usesUnicode || /\\[pP]\{/.test(text) };
}

/** The D022 oracle generator (vm-oracle-gen.mjs), one schema with k values. */
export function oracleGenSchema(r, k = 8) {
  const [one] = oracleSchemas(1, k, r.int(0x7fffffff) + 1);
  return { text: one.cddl, rules: ['r'], values: one.values };
}

/** A simple \p schema with an exact, independent evaluator (JS /u RegExp over Node's ICU). */
export function unicodeSchema(r) {
  const [pat, yes, no] = r.pick(REGEXPS);
  const str = () => r.chance(0.6) ? r.pick(yes) : r.chance(0.5) ? r.pick(no) : randomString(r, 4);
  const shape = r.int(4), lit = JSON.stringify(pat);
  const text = [`r = tstr .regexp ${lit}`, `r = [* tstr .regexp ${lit}]`, `r = { * (tstr .regexp ${lit}) => uint }`, `r = { ? a: tstr .regexp ${lit}, b: uint }`][shape];
  const sample = [str, () => Array.from({ length: r.int(3) }, str),
    () => { const o = obj(); for (let i = r.int(3); i > 0; i--) o[str()] = r.chance(0.9) ? 1 : 'x'; return o; },
    () => { const o = obj(); if (r.chance(0.7)) o.a = str(); if (r.chance(0.9)) o.b = 3; return o; }][shape];
  return { text, sample, shape, pat };
}
/** The evaluator for unicodeSchema's shapes. I-Regexp '.' excludes only CR and LF. */
export function unicodeEvaluator(shape, pat) {
  const js = new RegExp('^(?:' + pat.replace(/(^|[^\\])\./g, '$1[^\\n\\r]') + ')$', 'u');
  const matches = v => typeof v === 'string' && js.test(v);
  const isMap = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === null;
  const isUint = x => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  return [matches, v => Array.isArray(v) && v.every(matches),
    v => isMap(v) && Object.entries(v).every(([k, x]) => matches(k) && isUint(x)),
    v => isMap(v) && Object.keys(v).every(k => k === 'a' || k === 'b') && 'b' in v && isUint(v.b) && (!('a' in v) || matches(v.a))][shape];
}

// ---------------------------------------------------------------- near misses
/** A copy of v with one or two small changes somewhere inside. */
export function nearMiss(r, v, n = 1 + r.int(2)) {
  let out = v;
  for (let i = 0; i < n; i++) out = nearOnce(r, out, 0);
  return out;
}
function nearOnce(r, v, d) {
  const isObj = v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) && !(v instanceof Decimal) && !(v instanceof NDArray) && !(v instanceof Float16Bytes) && !(v instanceof Map);
  if (Array.isArray(v)) {
    const a = [...v];
    const k = r.int(a.length ? 5 : 2);
    if (k === 0) a.push(leaf(r)); else if (k === 1) a.unshift(leaf(r));
    else if (k === 2) a.splice(r.int(a.length), 1);
    else if (k === 3) a.splice(r.int(a.length), 0, a[r.int(a.length)]);
    else { const j = r.int(a.length); a[j] = nearOnce(r, a[j], d + 1); }
    return a;
  }
  if (isObj) {
    const o = Object.assign(Object.create(null), v), keys = Object.keys(o);
    const k = r.int(keys.length ? 4 : 1);
    if (k === 0) o[r.pick([...KEYS, ...OTHER_KEYS])] = leaf(r);
    else if (k === 1) delete o[r.pick(keys)];
    else { const j = r.pick(keys); o[j] = nearOnce(r, o[j], d + 1); }
    return o;
  }
  switch (typeof v) {
    case 'number':
      if (Number.isInteger(v)) return r.pick([v + 1, v - 1, -v - 1, v + 0.5, 2 ** 64, String(v)]);
      return r.pick([v * 2, -v, Math.fround(v + 0.1), Math.trunc(v), v + 1]);
    case 'bigint': return r.pick([v + 1n, -v, v >> 8n, Number(v & 0xffn)]);
    case 'string': return r.pick([v + 'a', v.slice(0, -1), v.toUpperCase(), '', v.length, te.encode(v)]);
    case 'boolean': return r.pick([!v, null, Number(v)]);
  }
  if (v === null) return r.pick([false, 0, 'null', []]);
  if (v instanceof Uint8Array && v.constructor === Uint8Array) return r.pick([Uint8Array.from([...v, 0]), v.subarray(0, Math.max(0, v.length - 1)), new TextDecoder().decode(v)]);
  return leaf(r);
}
const leaf = r => r.pick([0, 1, -1, 'a', '', true, null, 1.5, new Uint8Array(1), [], obj()]);

// ---------------------------------------------------------------- values for a schema
/** Values for a schema: constructive, near misses, arbitrary profile values. */
export function valuesFor(r, sample, k) {
  const out = [];
  for (let i = 0; i < k; i++) {
    const p = r.next();
    let v, kind;
    try {
      if (p < 0.5) { v = sample(); kind = 'constructive'; }
      else if (p < 0.85) { v = nearMiss(r, sample()); kind = 'near'; }
      else { v = r.chance(0.5) ? randomValue(r, { maxDepth: 3 }) : randomMap(r, { maxDepth: 2 }); kind = 'random'; }
    } catch { continue; }
    out.push({ v, kind });
  }
  return out;
}

// ---------------------------------------------------------------- CBOR structure over valid bytes
/** Item tree of well-formed definite-length CBOR (the profile's output). */
export function items(bytes, start = 0) {
  let p = start;
  const list = [];
  function head() {
    if (p >= bytes.length) throw new Error('short');
    const at = p, ib = bytes[p++], major = ib >> 5, ai = ib & 31;
    let arg = ai;
    if (ai >= 24 && ai <= 27) { const n = 1 << (ai - 24); if (p + n > bytes.length) throw new Error('short'); arg = 0; for (let i = 0; i < n; i++) arg = arg * 256 + bytes[p++]; }
    else if (ai > 27) throw new Error('not definite');
    return { at, major, ai, arg, headLen: p - at };
  }
  function item(depth, parent) {
    const h = head(); h.depth = depth; h.parent = parent; h.children = [];
    list.push(h);
    if (h.major === 2 || h.major === 3) { p += h.arg; if (p > bytes.length) throw new Error('short'); }
    else if ((h.major === 4 || h.major === 5) && h.arg > bytes.length) throw new Error('short');
    else if (h.major === 4) for (let i = 0; i < h.arg; i++) h.children.push(item(depth + 1, h));
    else if (h.major === 5) for (let i = 0; i < 2 * h.arg; i++) h.children.push(item(depth + 1, h));
    else if (h.major === 6) h.children.push(item(depth + 1, h));
    h.end = p;
    if (p > bytes.length) throw new Error('short');
    return h;
  }
  item(0, null);
  return { list, end: p };
}

const cat = (...parts) => { const n = parts.reduce((a, b) => a + b.length, 0), o = new Uint8Array(n); let k = 0; for (const x of parts) { o.set(x, k); k += x.length; } return o; };
function headBytes(major, arg, width) {
  // width: 0 inline, 1/2/4/8 bytes of argument
  if (width === 0) return Uint8Array.of((major << 5) | Number(arg));
  const ai = { 1: 24, 2: 25, 4: 26, 8: 27 }[width], o = new Uint8Array(1 + width);
  o[0] = (major << 5) | ai; let v = BigInt(arg);
  for (let i = width; i >= 1; i--) { o[i] = Number(v & 255n); v >>= 8n; }
  return o;
}

/** One structural mutation of a valid encoding; null when it does not apply. Returns {bytes, kind}. */
export function structuralMutation(r, bytes) {
  let tree;
  try { tree = items(bytes); } catch { return null; }
  const L = tree.list, x = r.pick(L);
  const before = bytes.subarray(0, x.at), after = bytes.subarray(x.end);
  const body = bytes.subarray(x.at + x.headLen, x.end);
  switch (r.int(12)) {
    case 0: { // non-shortest head
      if (x.major === 7) return null;
      const need = x.arg < 24 ? 0 : x.arg < 256 ? 1 : x.arg < 65536 ? 2 : x.arg < 2 ** 32 ? 4 : 8;
      const widths = [1, 2, 4, 8].filter(w => w > need);
      if (!widths.length) return null;
      return { kind: 'non_shortest', bytes: cat(before, headBytes(x.major, x.arg, r.pick(widths)), body, after) };
    }
    case 1: { // swap two adjacent map entries
      const maps = L.filter(m => m.major === 5 && m.arg >= 2);
      if (!maps.length) return null;
      const m = r.pick(maps), i = r.int(m.arg - 1);
      const k1 = m.children[2 * i], v1 = m.children[2 * i + 1], k2 = m.children[2 * i + 2], v2 = m.children[2 * i + 3];
      return { kind: 'swap_entries', bytes: cat(bytes.subarray(0, k1.at), bytes.subarray(k2.at, v2.end), bytes.subarray(k1.at, v1.end), bytes.subarray(v2.end)) };
    }
    case 2: { // duplicate a map entry (count + 1)
      const maps = L.filter(m => m.major === 5 && m.arg >= 1 && m.arg < 23);
      if (!maps.length) return null;
      const m = r.pick(maps), i = r.int(m.arg), k = m.children[2 * i], v = m.children[2 * i + 1];
      return { kind: 'duplicate_key', bytes: cat(bytes.subarray(0, m.at), headBytes(5, m.arg + 1, 0), bytes.subarray(m.at + m.headLen, v.end), bytes.subarray(k.at, v.end), bytes.subarray(v.end)) };
    }
    case 3: { // indefinite length
      if (![2, 3, 4, 5].includes(x.major)) return null;
      if (x.major === 2 || x.major === 3) return { kind: 'indefinite', bytes: cat(before, Uint8Array.of((x.major << 5) | 31), bytes.subarray(x.at, x.end), Uint8Array.of(0xff), after) };
      return { kind: 'indefinite', bytes: cat(before, Uint8Array.of((x.major << 5) | 31), body, Uint8Array.of(0xff), after) };
    }
    case 4: { // wrap in a tag
      const tag = r.pick([0, 1, 2, 3, 4, 24, 32, 40, 55799, 64, 69, 72, 84, 86, 87, 100]);
      return { kind: 'tag_wrap', bytes: cat(before, headBytes(6, tag, tag < 24 ? 0 : tag < 256 ? 1 : 2), bytes.subarray(x.at, x.end), after) };
    }
    case 5: { // change a container count by ±1
      if (x.major !== 4 && x.major !== 5) return null;
      const n = Math.max(0, x.arg + r.pick([-1, 1]));
      if (n === x.arg) return null;
      return { kind: 'count', bytes: cat(before, headBytes(x.major, n, n < 24 ? 0 : 1), body, after) };
    }
    case 6: { // widen a float
      if (x.major !== 7 || x.ai < 25) return null;
      const dv = new DataView(new ArrayBuffer(8));
      let value;
      if (x.ai === 25) { value = f16(bytes[x.at + 1] << 8 | bytes[x.at + 2]); }
      else if (x.ai === 26) value = new DataView(bytes.buffer, bytes.byteOffset + x.at + 1, 4).getFloat32(0);
      else return null;
      if (x.ai === 25 && r.chance(0.5)) { dv.setFloat32(0, value); return { kind: 'float_width', bytes: cat(before, Uint8Array.of(0xfa), new Uint8Array(dv.buffer, 0, 4), after) }; }
      dv.setFloat64(0, value); return { kind: 'float_width', bytes: cat(before, Uint8Array.of(0xfb), new Uint8Array(dv.buffer, 0, 8), after) };
    }
    case 7: { // invalid / noncharacter UTF-8 in a text string
      const texts = L.filter(t => t.major === 3 && t.arg >= 1);
      if (!texts.length) return null;
      const t = r.pick(texts), o = Uint8Array.from(bytes), at = t.at + t.headLen + r.int(t.arg);
      const bad = r.pick([[0xff], [0xc0], [0xed], [0x80], [0xef]]);
      o[at] = bad[0];
      return { kind: 'utf8', bytes: o };
    }
    case 8: // trailing byte or a second item
      return { kind: 'trailing', bytes: cat(bytes, r.chance(0.5) ? Uint8Array.of(r.int(256)) : bytes) };
    case 9: { // replace a scalar with a simple value / undefined / special
      const repl = r.pick([[0xf7], [0xf0], [0xf8, 0x20], [0xf8, 0x10], [0xf9, 0x7e, 0x00], [0xf9, 0x80, 0x00], [0xf9, 0x7c, 0x00], [0xfa, 0x3f, 0xc0, 0x00, 0x00], [0xf9, 0x3c, 0x00], [0xc2, 0x40], [0xc2, 0x41, 0x00], [0xc4, 0x82, 0x00, 0x01], [0x1c], [0xff]]);
      return { kind: 'special', bytes: cat(before, Uint8Array.from(repl), after) };
    }
    case 10: { // move a key out of order by renaming it
      const texts = L.filter(t => t.major === 3 && t.parent && t.parent.major === 5 && t.parent.children.indexOf(t) % 2 === 0 && t.arg >= 1);
      if (!texts.length) return null;
      const t = r.pick(texts), o = Uint8Array.from(bytes);
      o[t.at + t.headLen] = r.pick([0x00, 0x7a, 0x41, o[t.at + t.headLen] ^ 1]);
      return { kind: 'key_rename', bytes: o };
    }
    default: { // deep nesting wrapper
      const k = 1 + r.int(40);
      return { kind: 'nest', bytes: cat(new Uint8Array(k).fill(0x81), bytes) };
    }
  }
}
function f16(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Random bytes with some CBOR-ish structure. */
export function randomBytesCbor(r) {
  const n = r.int(r.chance(0.1) ? 300 : 24);
  if (r.chance(0.5)) return Uint8Array.from({ length: n }, () => r.int(256));
  const HEADS = [0x00, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x20, 0x38, 0x40, 0x41, 0x5f, 0x60, 0x61, 0x7f, 0x80, 0x81, 0x9f, 0xa0, 0xa1, 0xbf, 0xc2, 0xc3, 0xc4, 0xd8, 0xf4, 0xf5, 0xf6, 0xf7, 0xf9, 0xfa, 0xfb, 0xff];
  return Uint8Array.from({ length: n }, () => r.chance(0.6) ? r.pick(HEADS) : r.int(256));
}

/** Random decode options, mostly defaults. */
export function randomOptions(r) {
  const o = {};
  if (r.chance(0.5)) o.top = 'any';
  if (r.chance(0.1)) o.cose = true;
  if (r.chance(0.15)) o.maxDepth = r.int(6);
  if (r.chance(0.1)) o.maxEntries = r.int(5);
  if (r.chance(0.1)) o.maxItems = r.int(12);
  if (r.chance(0.1)) o.maxBytes = r.int(40);
  return o;
}

// ---------------------------------------------------------------- compile-fuzz's CDDL grammar (copied)
const NAMES = ['a', 'b', 'c', 'r', 'g', 't', 'item', 'key', 'kind', 'x1', 'my-type', 'v.2'];
const PRE = ['int', 'uint', 'nint', 'tstr', 'bstr', 'text', 'bytes', 'bool', 'null', 'any', 'float', 'float16',
  'float32', 'float64', 'number', 'integer', 'unsigned', 'biguint', 'bignint', 'decfrac', 'tdate', 'uri', 'true', 'false'];
const CTLS = ['.size', '.bits', '.lt', '.le', '.gt', '.ge', '.eq', '.ne', '.and', '.within', '.regexp', '.cbor', '.cborseq',
  '.default', '.feature', '.cat', '.pcre', '.abnf', '.bogus'];
const FREGEX = ['[a-z]+', '(ab|c){1,3}', '[^x]?', 'a.b', '[0-9]{2,4}-x', '\\\\.', '(a|)', 'x{0}', '[a-z][a-z0-9-]{0,20}', '\\\\w', '[😀-🙏]',
  '\\p{L}', '[\\p{Lu}\\P{N}]+', '\\p{Bogus}', '\\p{L', '\\pL'];
/** Texts from compile-fuzz.mjs's four sources, plus raw-byte tails. */
export function fuzzText(r) {
  const ri = n => r.int(n), pick = a => r.pick(a), chance = p => r.chance(p);
  function lit() {
    switch (ri(9)) {
      case 0: return String(ri(300));
      case 1: return '-' + ri(100);
      case 2: return pick(['0x1f', '0b101', '18446744073709551616', '-18446744073709551617', '340282366920938463463374607431768211455']);
      case 3: return pick(['1.5', '-0.25', '1e-3', '0.0', '65504.0', '1e400', '0x1.8p0', '1.234567890123456789']);
      case 4: return JSON.stringify(pick(['a', 'kind', '', 'é', '水', 'x y']));
      case 5: return pick(["h'00ff'", "b64'AQI='", "'ab'", "h'0 1'"]);
      case 6: return '"\\u00e9\\u{1F600}"';
      default: return String(ri(10));
    }
  }
  function type(d, gen) { if (d > 4) return pick(PRE); const n = chance(0.25) ? 2 + ri(3) : 1; return Array.from({ length: n }, () => type1(d + 1, gen)).join(' / '); }
  function type1(d, gen) {
    const base = type2(d, gen);
    if (chance(0.15)) return `${base} ${pick(['..', '...'])} ${pick([lit(), String(ri(50))])}`;
    if (chance(0.2)) {
      const c = pick(CTLS);
      const arg = c === '.regexp' ? JSON.stringify(pick(FREGEX)) : c === '.cbor' || c === '.cborseq' ? type2(d + 1, gen) : pick([lit(), `(${ri(5)}..${ri(40)})`, type2(d + 1, gen)]);
      return `${base} ${c} ${arg}`;
    }
    return base;
  }
  function type2(d, gen) {
    switch (ri(d > 3 ? 4 : 13)) {
      case 0: return pick(PRE);
      case 1: return lit();
      case 2: return pick(NAMES) + (gen && chance(0.3) ? `<${type1(d + 1, gen)}>` : '');
      case 3: return pick(['#', '#0', '#1', '#2', '#3', '#4', '#5', '#6', '#7', '#7.25', '#7.20', '#6.1(tstr)', '#6.<69..70>(bstr)', '#6.2(bstr)', '#8']);
      case 4: case 5: return `{ ${group(d + 1, gen, true)} }`;
      case 6: case 7: return `[ ${group(d + 1, gen, false)} ]`;
      case 8: return `(${type(d + 1, gen)})`;
      case 9: return `~${pick(NAMES)}`;
      case 10: return `&(${group(d + 1, gen, true)})`;
      case 11: return '$' + pick(NAMES);
      default: return `&${pick(NAMES)}`;
    }
  }
  function occur() { return pick(['', '', '', '?', '*', '+', '1*3', '2*2', '0*0', '*5', '3*', '0*1048576', '2*1']); }
  function entry(d, gen, map) {
    const o = occur(), sp = o ? ' ' : '';
    if (d > 4) return `${o}${sp}${pick(NAMES)}: ${pick(PRE)}`;
    switch (ri(map ? 7 : 6)) {
      case 0: return `${o}${sp}${pick(NAMES)}: ${type(d + 1, gen)}`;
      case 1: return `${o}${sp}${lit()}: ${type(d + 1, gen)}`;
      case 2: return `${o}${sp}${type1(d + 1, gen)} ${chance(0.2) ? '^ ' : ''}=> ${type(d + 1, gen)}`;
      case 3: return `${o}${sp}(${group(d + 1, gen, map)})`;
      case 4: return `${o}${sp}${pick(NAMES)}`;
      case 5: return `${o}${sp}$$${pick(NAMES)}`;
      default: return `${o}${sp}${type(d + 1, gen)}`;
    }
  }
  function group(d, gen, map) {
    const nch = chance(0.2) ? 2 + ri(2) : 1, choices = [];
    for (let c = 0; c < nch; c++) { const n = ri(d > 3 ? 2 : 5); choices.push(Array.from({ length: n }, () => entry(d, gen, map)).join(pick([', ', ' ', ',\n  ']))); }
    return choices.join(' // ');
  }
  function schema() {
    const n = 1 + ri(6), out = [];
    for (let i = 0; i < n; i++) {
      const nm = i === 0 ? 'r' : pick(NAMES), gen = chance(0.15), params = gen ? `<${pick(['T', 'T, U'])}>` : '';
      const assign = pick(['=', '=', '=', '/=', '//=']);
      const body = assign === '//=' || chance(0.15) ? `(${group(1, gen, true)})` : type(0, gen);
      out.push(`${chance(0.1) ? '$' : ''}${nm}${params} ${assign} ${body}`);
    }
    return out.join(chance(0.5) ? '\n' : ' ;c\n');
  }
  const TN = ['t0', 't1', 't2', 't3'], GN = ['g0', 'g1', 'g2'];
  function wtype(d) { const n = chance(0.3) ? 2 : 1; return Array.from({ length: n }, () => wtype1(d)).join(' / '); }
  function wtype1(d) {
    if (d > 3) return pick([...PRE, ...TN]);
    switch (ri(11)) {
      case 0: case 1: return pick(PRE);
      case 2: return pick(TN);
      case 3: return `{ ${wgroup(d + 1, true)} }`;
      case 4: return `[ ${wgroup(d + 1, false)} ]`;
      case 5: return `${pick(['uint', 'int', '0..100', 'integer'])} ${pick(['.lt', '.le', '.gt', '.ge', '.ne', '.eq'])} ${ri(50)}`;
      case 6: return `${pick(['tstr', 'bstr'])} .size ${pick([String(ri(9)), `(${ri(4)}..${4 + ri(20)})`])}`;
      case 7: return `tstr .regexp ${JSON.stringify(pick(FREGEX.slice(0, 9)))}`;
      case 8: return `bstr .cbor ${wtype1(d + 1)}`;
      case 9: return `#6.${pick([1, 24, 32, 55799])}(${wtype1(d + 1)})`;
      default: return `${ri(5)}..${5 + ri(9)}`;
    }
  }
  function wentry(d, map) {
    const o = occur(), sp = o ? ' ' : '';
    if (map) {
      switch (ri(5)) {
        case 0: case 1: return `${o}${sp}${pick(['a', 'b', 'c', 'kind', 'id'])}: ${wtype(d + 1)}`;
        case 2: return `${o}${sp}${pick(['tstr', 'uint', '"k"', 'tstr .size 1'])} ${chance(0.1) ? '^ ' : ''}=> ${wtype(d + 1)}`;
        case 3: return `${o}${sp}${pick(GN)}`;
        default: return `${o}${sp}(${wgroup(d + 1, true)})`;
      }
    }
    switch (ri(4)) {
      case 0: case 1: return `${o}${sp}${wtype(d + 1)}`;
      case 2: return `${o}${sp}${pick(GN)}`;
      default: return `${o}${sp}(${wgroup(d + 1, false)})`;
    }
  }
  function wgroup(d, map) { const nch = chance(0.2) ? 2 : 1, out = []; for (let c = 0; c < nch; c++) out.push(Array.from({ length: ri(d > 2 ? 2 : 4) }, () => wentry(d, map)).join(', ')); return out.join(' // '); }
  function wschema() {
    const out = [`r = ${wtype(0)}`];
    for (const t of TN) out.push(`${t} = ${wtype(1)}`);
    for (const g of GN) out.push(`${g} = (${wgroup(1, chance(0.5))})`);
    return out.join('\n');
  }
  const ALPHA = Array.from(' \n\t;:,=/(){}[]<>*+?~&#.^"\'-0123456789abcxyz$@_\\é😀');
  function mutate(t) {
    let b = Array.from(t);
    const n = 1 + ri(4);
    for (let k = 0; k < n; k++) {
      const at = ri(b.length + 1);
      switch (ri(6)) {
        case 0: b.splice(at, 0, pick(ALPHA)); break;
        case 1: b.splice(at, 1 + ri(3)); break;
        case 2: { const l = 1 + ri(12); b.splice(at, 0, ...b.slice(ri(b.length), ri(b.length) + l)); break; }
        case 3: b[at] = pick(ALPHA); break;
        case 4: b.splice(at, 0, ...Array.from(pick([' // ', ' / ', '? ', '* ', '2*3 ', ' .size 3', '<T>', ' ~', '#6.', '0x', '1e9', '\\p{L}']))); break;
        default: b = b.slice(0, ri(b.length + 1));
      }
    }
    return b.join('');
  }
  function hostile() {
    const k = 1 + ri(400);
    switch (ri(14)) {
      case 0: return 'r = ' + '['.repeat(k) + 'int' + ']'.repeat(k);
      case 1: return 'r = ' + '('.repeat(k) + 'int' + ')'.repeat(k);
      case 2: return Array.from({ length: k }, (_, i) => `a${i} = a${i + 1}`).join('\n') + `\na${k} = int\nr = a0`;
      case 3: return Array.from({ length: k }, (_, i) => `a${i} = [a${i + 1}, a${i + 1}]`).join('\n') + `\na${k} = int\nr = a0`;
      case 4: return 'g<T> = [g<[T, T]>]\nr = g<int>';
      case 5: return 'r = { ' + Array.from({ length: k }, (_, i) => `? (k${i}: int // j${i}: int)`).join(', ') + ' }';
      case 6: return 'r = [' + `${ri(100000)}*${ri(1 << 30)} uint` + ', ? uint, tstr]';
      case 7: return 'r = ' + Array.from({ length: k }, (_, i) => `"v${i}"`).join(' / ');
      case 8: return 'r = tstr .regexp "' + '(a|b)'.repeat(Math.min(k, 60)) + '{2,200}"';
      case 9: return 'r = [' + Array.from({ length: Math.min(k, 60) }, () => '? uint').join(', ') + ', 3*7 uint]';
      case 10: return 'a = [* b]\nb = {x: a, ? y: c}\nc = #6.1(a) / bstr .cbor b\nr = a';
      case 11: return 'r = tstr .regexp "' + '[\\\\p{L}\\\\p{N}]'.repeat(Math.min(k, 80)) + '"';
      case 12: return 'r = { ' + Array.from({ length: Math.min(k, 120) }, (_, i) => `? k${i}: [* (int // tstr .regexp "[a-z]{0,${i}}")]`).join(', ') + ', * tstr => any }';
      default: return 'r = ' + 'int .and '.repeat(Math.min(k, 200)) + 'uint';
    }
  }
  const p = r.next();
  let text = p < 0.3 ? mutate(pick(corpusTexts)) : p < 0.55 ? schema() : p < 0.9 ? wschema() : hostile();
  if (chance(0.05)) {
    const pre = new TextEncoder().encode(text.slice(0, ri(text.length + 1)));
    text = cat(pre, Uint8Array.from({ length: ri(40) }, () => ri(256)));
  }
  return text;
}
export const COMPILE_LIMIT_SAMPLE = [0, 1, 2, 3, 8, 64, 1000];
export { randomInteger, randomFloat, randomString, randomBytes, randomTyped, randomDecimal, cat };
