// Hand-reasoned VM cases for what the conformance corpus cannot pin: profile
// errors winning over schema failures (D023), witness reasons, paths and
// offsets (§9.2, §9.3, A10), budget exhaustion, limits, hostile inputs, and
// the `validateAt` span entry (arch §16.3). Programs come from the compiler
// (kin/compile) or the assembler (kin/scripts/vm-asm.mjs). Each entry:
// {label, P, B, cases: [{bytes, lim?, rule?, span?, label?, check(out)}]}
// where out is the space-separated out array (program.md §13.2).
import { compile } from '../../host/js/src/compile.mjs';
import { encode } from '../../bench/baseline/cbor-3sln.mjs';
import { Asm, cbor } from './vm-asm.mjs';

const unhex = h => Uint8Array.from(Buffer.from(h.replace(/\s/g, ''), 'hex'));
const enc = v => encode(v);
// out words -> {code, sub, offset, used, items, path:[[kind, value]...]}
const parse = o => { const w = o.split(' ').map(Number); const path = []; for (let i = 0; i < w[6]; i++) path.push([w[8 + 2 * i], w[9 + 2 * i]]); return { code: w[0], sub: w[1], offset: w[2], used: w[3], items: w[4], n: w[5], path }; };
const KEY = (P, B, name) => { // key id of a text key in the Program's KEYS
  const t = new TextEncoder().encode(name);
  for (let i = 0; i < P[18]; i++) { const off = P[P[46] + 2 * i], len = P[P[46] + 2 * i + 1]; const k = B.subarray(off, off + len); if (k.length === t.length + 1 && k.subarray(1).every((x, j) => x === t[j])) return i; }
  return -1;
};
function expect(want) {
  return o => {
    const g = parse(o);
    for (const [k, v] of Object.entries(want)) {
      if (JSON.stringify(g[k]) !== JSON.stringify(v)) return `${k} ${JSON.stringify(g[k])}, expected ${JSON.stringify(v)} (out ${o})`;
    }
    return null;
  };
}
const lim = (o = {}) => [o.top ?? 1, o.cose ?? 0, o.bytes ?? -1, o.depth ?? -1, o.entries ?? -1, o.items ?? -1, o.bignum ?? -1, o.budget ?? -1];
function C(text, opts) { const c = compile(text, opts); return { P: c.program, B: c.pool, rules: c.rules }; }

export function assembledCases() {
  const out = [];
  const add = (label, prog, cases) => {
    const r = prog.rules ? prog.rules.indexOf('r') : 0;
    out.push({ label, P: prog.P, B: prog.B, cases: cases.map(c => ({ rule: r, ...c })) });
  };

  // ---------------------------------------------------------------- witnesses
  {
    const p = C('r = { a: int }\ns = { b: int }');
    const a = KEY(p.P, p.B, 'a');
    add('witness map', p, [
      { label: '{a: "x"}: type at ["a"]', bytes: enc({ a: 'x' }), check: expect({ code: 32, path: [[1, a]], offset: 3 }) },
      { label: '{}: missing ["a"]', bytes: enc({}), check: expect({ code: 33, path: [[1, a]], offset: 0 }) },
      { label: '{a: 1, c: 2}: unexpected ["*"]', bytes: enc({ a: 1, c: 2 }), check: expect({ code: 34, path: [[2, 0]], offset: 4 }) },
      { label: 'A10: {b: 1} names a key only rule s names: ["*"], never "b"', bytes: enc({ b: 1 }), check: expect({ code: 34, path: [[2, 0]], offset: 1 }) },
      { label: '[]: type at the root', bytes: enc([]), check: expect({ code: 32, path: [], offset: 0 }) },
    ]);
  }
  {
    const p = C('r = [int, tstr]');
    add('witness array', p, [
      { label: '[1]: missing [1]', bytes: enc([1]), check: expect({ code: 33, path: [[0, 1]], offset: 0 }) },
      { label: '[1, "x", 2]: unexpected [2]', bytes: enc([1, 'x', 2]), check: expect({ code: 34, path: [[0, 2]], offset: 4 }) },
      { label: '["x"]: type [0]', bytes: enc(['x']), check: expect({ code: 32, path: [[0, 0]], offset: 1 }) },
      { label: '[1, "x"] ok', bytes: enc([1, 'x']), check: expect({ code: 0 }) },
    ]);
  }
  {
    const p = C('r = (uint .lt 3) / 9');
    add('witness C14 lowest leaf id', p, [
      { label: '5: range (uint has the lower id)', bytes: enc(5), check: expect({ code: 37, path: [] }) },
      { label: '"x": type', bytes: enc('x'), check: expect({ code: 32, path: [] }) },
    ]);
  }
  {
    const p = C('r = { kind: "a", x: int // kind: "b", y: tstr }');
    const kind = KEY(p.P, p.B, 'kind'), y = KEY(p.P, p.B, 'y');
    add('witness group choice', p, [
      { label: '{kind: "c"}: value ["kind"]', bytes: enc({ kind: 'c' }), check: expect({ code: 35, path: [[1, kind]] }) },
      { label: '{kind: "b", y: 1}: type ["y"]', bytes: enc({ kind: 'b', y: 1 }), check: expect({ code: 32, path: [[1, y]] }) },
      { label: '{kind: "b"}: missing ["y"]', bytes: enc({ kind: 'b' }), check: expect({ code: 33, path: [[1, y]] }) },
    ]);
  }
  {
    const p = C('m = { a: int }\nr = bstr .cbor m');
    add('witness embedded', p, [
      { label: 'embedded type at [cbor, "a"]', bytes: enc(enc({ a: 'x' })), check: expect({ code: 41, sub: 32, path: [[4, 0], [1, KEY(p.P, p.B, 'a')]] }) },
      { label: 'embedded profile failure: subcode cbor/indefinite at [cbor]', bytes: unhex('41ff'), check: expect({ code: 41, sub: 3, path: [[4, 0]], offset: 1 }) },
      { label: 'embedded trailing', bytes: enc(Uint8Array.from([...enc({ a: 1 }), 0])), check: expect({ code: 41, sub: 16, path: [[4, 0]] }) },
      { label: 'embedded ok (inner items not counted outside)', bytes: enc(enc({ a: 1 })), check: expect({ code: 0, items: 1 }) },
    ]);
  }
  {
    const p = C('r = #6.2(bstr .size 9) / integer');
    add('witness A4 tag content local', p, [
      { label: '2^64 ok', bytes: enc(1n << 64n), check: expect({ code: 0 }) },
      { label: '2^80 ok via integer (content failure cleared)', bytes: enc(1n << 80n), check: expect({ code: 0 }) },
    ]);
  }

  // ---------------------------------------------------------------- profile errors win (D023)
  {
    const p = C('r = { a: int }');
    add('profile wins', p, [
      { label: 'schema failure then trailing byte -> cbor/trailing', bytes: unhex('a1616161780a'), check: expect({ code: 16, path: [], offset: 5 }) },
      { label: 'schema failure at pair 0, key order fault at pair 1 -> cbor/key_order', bytes: unhex('a2 6162 01 6161 01'), check: expect({ code: 6, offset: 4 }) },
      { label: 'schema failure then invalid UTF-8 later -> cbor/text', bytes: unhex('a2 6161 6178 6162 61ff'), check: expect({ code: 8, offset: 8 }) },
      { label: 'schema failure then truncated -> cbor/truncated', bytes: unhex('a2 6161 6178 6162'), check: expect({ code: 1 }) },
    ]);
    const q = C('r = [* int]');
    add('profile wins (array)', q, [
      { label: 'type at [0], then a stray break -> cbor/indefinite', bytes: unhex('83 6178 01 ff'), check: expect({ code: 3, offset: 4 }) },
      { label: 'type at [0], then a non-shortest head -> cbor/non_shortest', bytes: unhex('82 6178 1801'), check: expect({ code: 2, offset: 3 }) },
    ]);
  }

  // ---------------------------------------------------------------- budget
  {
    const p = C('r = [* int]');
    const big = enc(Array.from({ length: 1000 }, (_, i) => i));
    add('budget', p, [
      { label: 'enough budget', bytes: big, check: expect({ code: 0 }) },
      ...[1, 2, 3, 10, 100, 1001, 5000].map(n => ({ label: `budget ${n}: exhausted, whole budget reported used`, bytes: big, lim: lim({ budget: n }),
        check: o => { const g = parse(o); return g.code === 48 && g.used === n ? null : `out ${o}`; } })),
      { label: 'budget 0 on an empty array', bytes: enc([]), lim: lim({ budget: 0 }), check: expect({ code: 48, used: 0, offset: 0 }) },
      { label: 'budget wins over a later profile error', bytes: Uint8Array.from([0x98, 50, ...Array(49).fill(1), 0xff]), lim: lim({ budget: 20 }), check: expect({ code: 48 }) },
      { label: 'with budget, that profile error is reported', bytes: Uint8Array.from([0x98, 50, ...Array(49).fill(1), 0xff]), check: expect({ code: 3, offset: 51 }) },
    ]);
  }

  // ---------------------------------------------------------------- limits (per call, only lower)
  {
    const p = C('r = [* r] / int');
    const nest = n => unhex('81'.repeat(n) + '01');
    add('depth', p, [
      { label: '32 levels ok', bytes: nest(32), check: expect({ code: 0 }) },
      { label: '33 levels: cbor/depth', bytes: nest(33), check: expect({ code: 17 }) },
      { label: 'per-call depth 4: 4 ok', bytes: nest(4), lim: lim({ depth: 4 }), check: expect({ code: 0 }) },
      { label: 'per-call depth 4: 5 refused', bytes: nest(5), lim: lim({ depth: 4 }), check: expect({ code: 17 }) },
      { label: 'per-call depth 999 cannot raise the compiled 32', bytes: nest(33), lim: lim({ depth: 999 }), check: expect({ code: 17 }) },
      { label: 'items limit', bytes: nest(5), lim: lim({ items: 5 }), check: expect({ code: 19 }) },
      { label: 'input bytes limit', bytes: nest(5), lim: lim({ bytes: 5 }), check: expect({ code: 20, offset: 0 }) },
    ]);
    const m = C('r = { * tstr => int }');
    add('top map and entries', m, [
      { label: 'top map required: an array is cbor/not_map', bytes: enc([]), lim: lim({ top: 0 }), check: expect({ code: 21 }) },
      { label: 'entries limit', bytes: enc({ a: 1, b: 2, c: 3 }), lim: lim({ entries: 2 }), check: expect({ code: 18 }) },
    ]);
  }

  // ---------------------------------------------------------------- hostile
  {
    const six = C(['r = [* msg]', 'msg = a / b / c / d / e / f',
      ...'abcdef'.split('').map(k => `${k} = { kind: "${k}", v: ${({ a: 'uint', b: 'tstr', c: 'bool', d: '[* int]', e: '{ * tstr => int }', f: 'bstr' })[k]} }`)].join('\n'));
    const msgs = Array.from({ length: 24000 }, (_, i) => ({ kind: 'a', v: i }));
    const good = enc(msgs);
    const bad = enc([...msgs.slice(0, -1), { kind: 'a', v: 'late' }]);
    add('hostile six-way choice', six, [
      { label: `valid ${good.length} B`, bytes: good, check: expect({ code: 0 }) },
      { label: `invalid at the last element, ${bad.length} B: "v" sorts first, only {kind:"b", v: tstr} survives it and dies at the value of "kind" (rule 1 at the value, kept by rule 3) -> value at [23999, "kind"]`,
        bytes: bad, check: expect({ code: 35, path: [[0, 23999], [1, KEY(six.P, six.B, 'kind')]], offset: bad.length - 2 }) },
      { label: 'the valid input under a 1 M budget: budget, at the same point on both hosts', bytes: good, lim: lim({ budget: 1000000 }), check: expect({ code: 48, used: 1000000 }) },
    ]);
    const s = C('r = bstr / tstr / [* any] / { * tstr => any }');
    add('hostile declared lengths', s, ['5bffffffffffffffff', '9bffffffffffffffff', 'bbffffffffffffffff', '7bffffffffffffffff', '5a7fffffff', '9a7fffffff', 'ba7fffffff', 'b9ffff', '9a00010000' + '00'.repeat(10)]
      .map(h => ({ label: h.slice(0, 18), bytes: unhex(h), check: expect({ code: 1 }) })));
    const rx = C('r = tstr .regexp "(a|b|ab|ba)*c"');
    add('hostile regexp', rx, [
      { label: 'ok', bytes: enc('abbaabc'), check: expect({ code: 0 }) },
      { label: '20 000 code points, no match', bytes: enc('ab'.repeat(10000)), check: o => { const g = parse(o); return g.code === 38 || g.code === 48 ? null : `out ${o}`; } },
    ]);
  }

  // ---------------------------------------------------------------- span entry (validateAt)
  {
    const p = C('r = [int, tstr]');
    const doc = enc([1, [2, 'x']]); // 82 01 82 02 61 78
    add('validateAt span', p, [
      { label: 'inner array span ok', bytes: doc, span: [2, 6, 1, 2], check: expect({ code: 0, items: 5 }) },
      { label: 'span that is not one whole item', bytes: doc, span: [2, 5, 1, 2], check: o => (parse(o).code === 1 ? null : `out ${o}`) },
      { label: 'depth limit continues from the enclosing depth', bytes: doc, span: [2, 6, 1, 2], lim: lim({ depth: 1 }), check: expect({ code: 17 }) },
      { label: 'whole document fails the rule (type at [1])', bytes: doc, check: expect({ code: 32, path: [[0, 1]] }) },
    ]);
  }

  // ---------------------------------------------------------------- assembler: NOT
  {
    const a = new Asm();
    const L1 = a.text(1, 1), L2 = a.lit(cbor.text('x')), L3 = a.not(L1, L2);
    a.rule('r', a.ts([L3]));
    const p = a.build();
    add('assembled NOT', p, [
      { label: '"y" ok', bytes: enc('y'), check: expect({ code: 0 }) },
      { label: '"x": value', bytes: enc('x'), check: expect({ code: 35 }) },
      { label: '"xy": size', bytes: enc('xy'), check: expect({ code: 36 }) },
      { label: '1: type', bytes: enc(1), check: expect({ code: 32 }) },
    ]);
  }
  return out;
}
