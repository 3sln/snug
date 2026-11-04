// Extension-control cases (P7.2, D140-D142) for bb vm-test and bb vmsession-test.
//
// The registry is the generic controls (kin's snug.vm.controls, so JS and Rust
// agree by construction) plus two host-defined ones the Rust bins restate:
//   .even   the item's encoding has an even number of bytes (maxBytes 300)
//   .tiny   `.chars` with maxBytes 8 (so control_size is reachable cheaply)
// `extFor(P, B)` answers the predicate the VM calls for a Program (null when it
// uses no control); `addExtCases` adds schemas and seeded values -- EXT under
// choices (exactness), in arrays, maps (values and keys), embedded documents,
// nested, past their maximum item size, under part-way budgets -- to a case list.
import { controls as generic } from '../../host/js/src/controls.mjs';
import { controlEntries, bindControls } from '../../host/js/src/ext.mjs';

export const testControls = {
  ...generic,
  even: { check: (a, item) => item.length % 2 === 0, maxBytes: 300 },
  tiny: { ...generic.chars, maxBytes: 8 },
};
const entries = controlEntries(testControls);
const bound = new WeakMap();
export function extFor(P, B) {
  if (P.length < 64 || P[30] <= 0) return null;
  let x = bound.get(P);
  if (x === undefined) { try { x = bindControls(P, B, entries)?.call ?? null; } catch { x = null; } bound.set(P, x); }
  return x;
}

export const EXT_SCHEMAS = [
  ['r = (tstr .chars (1..3)) / (tstr .size 10)', 'choice'],
  ['r = [* int] .unique true', 'unique'],
  ['r = [* (tstr .chars 2)]', 'chars-array'],
  ['r = { a: [* int], b: [* int], ? c: [* int] } .samelen ["a", "b", "c"]', 'samelen'],
  ['r = { * (tstr .chars (1..2)) => int }', 'keys'],
  ['r = bstr .cbor ([* uint] .unique 0)', 'embedded'],
  ['r = [* (tstr .tiny (0..100))]', 'tiny'],
  ['r = { x: (tstr .chars (2..3)) / int, y: [* (bstr .even 0)] }', 'even'],
  ['r = [* ([* int] .unique 1) / tstr]', 'nested'],
  ['r = (tstr .chars 3) .ne "abc"', 'ne'],
  ['r = [* (tstr .even 0) / (tstr .chars (5..400))]', 'long'],
  ['r = { m: { * tstr => [* (int / tstr)] .unique 2 } .samelen "xs" }', 'deep'],
];

// Verdicts the semantics fix (out[0], and the embedded subcode): exactness under
// choices, keys, `.ne`, the size bound, embedded documents.
const FIXED = {
  choice: [['ab', 0], ['abcd', 42], ['0123456789', 0], ['€€€', 0], ['€€€€', 42], ['', 42], [7, 32]],
  unique: [[[1, 2, 3], 0], [[1, 2, 1], 42], [[], 0], [[[1], [1, 0]], 32]],
  samelen: [[{ a: [1], b: [2] }, 0], [{ a: [1], b: [] }, 42], [{ a: [], b: [], c: [1] }, 42], [{ a: [5], b: [6], c: [7] }, 0]],
  keys: [[{ ab: 1 }, 0], [{ abc: 1 }, 34], [{ a: 1, 'é': 2 }, 0]],
  tiny: [[['abcdefghi'], 43], [['abc'], 0], [['abcdefg'], 0]],
  ne: [['abc', 35], ['abd', 0], ['ab', 42]],
  embedded: [[[1, 2], 0], [[1, 1], 41, 42]],
};

/** Seeded values for one schema kind (plain JS values for the baseline encoder). */
function value(kind, rnd) {
  const pick = xs => xs[rnd(xs.length)];
  const str = (n, multi) => Array.from({ length: n }, () => (multi && !rnd(3) ? pick(['é', '€', '😀']) : pick(['a', 'b', 'c']))).join('');
  const ints = n => Array.from({ length: n }, () => rnd(6) - 2);
  switch (kind) {
    case 'choice': return rnd(9) ? str(rnd(12), true) : rnd(5);
    case 'unique': return rnd(9) ? ints(rnd(8)) : [1, 'a'];
    case 'chars-array': return Array.from({ length: rnd(6) }, () => str(rnd(4), true));
    case 'samelen': { const o = { a: ints(rnd(3)), b: ints(rnd(3)) }; if (rnd(2)) o.c = ints(rnd(3)); if (!rnd(8)) o.a = new Float32Array(rnd(3)); return o; }
    case 'keys': return Object.fromEntries(Array.from({ length: rnd(5) }, () => [str(1 + rnd(3), true), rnd(9)]));
    case 'embedded': return { embed: Array.from({ length: rnd(6) }, () => rnd(4)) };
    case 'tiny': return Array.from({ length: rnd(4) }, () => str(rnd(12), rnd(2)));
    case 'even': return { x: rnd(3) ? str(rnd(5), true) : rnd(9), y: Array.from({ length: rnd(4) }, () => new Uint8Array(rnd(5))) };
    case 'nested': return Array.from({ length: rnd(4) }, () => (rnd(3) ? ints(rnd(5)) : str(2)));
    case 'ne': return rnd(3) ? pick(['abc', 'abd', 'ab', 'abcd', '€€€']) : 3;
    case 'long': return Array.from({ length: rnd(3) }, () => str(rnd(4) ? rnd(40) : rnd(600), rnd(3) === 0));
    case 'deep': return { m: Object.fromEntries(Array.from({ length: rnd(3) }, (_, i) => ['k' + i, ints(rnd(4))])) };
  }
}

/** Add the extension cases. `compile(text, opts)` is the host compiler, `encode` the
 *  baseline encoder, `addProgram(P, B, label)` and `LIM` as in vm-allcases.mjs. */
export function addExtCases({ compile, encode, addProgram, LIM, cases, seed, count = 120 }) {
  let st = (seed * 2654435761 + 7) >>> 0;
  const rnd = n => { st = (Math.imul(st ^ (st >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return st % n; };
  let n = 0;
  for (const [text, kind] of EXT_SCHEMAS) {
    const c = compile(text, { controls: testControls, limits: { items: 1 << 20, entries: 1 << 20 } });
    const pi = addProgram(c.program, c.pool, `ext: ${text}`);
    const rule = c.rules.indexOf('r');
    for (const [v, want, sub] of FIXED[kind] ?? []) {
      const bytes = kind === 'embedded' ? encode(encode(v)) : encode(v);
      cases.push({ prog: pi, rule, lim: LIM(1, 0), bytes, label: `ext ${kind} fixed ${JSON.stringify(v)}`, ext: true,
        check: o => { const w = o.split(' ').map(Number); return w[0] === want && (sub === undefined || w[1] === sub) ? null : `want ${want}${sub ? '/' + sub : ''}, got ${o}`; } });
      n++;
    }
    for (let k = 0; k < count; k++) {
      let v = value(kind, rnd);
      let bytes;
      try {
        if (kind === 'embedded') { const inner = encode(v.embed); bytes = rnd(8) ? encode(inner) : encode(inner.subarray(0, rnd(inner.length + 1))); }
        else bytes = encode(v, { maxItems: 1 << 20, maxEntries: 1 << 20 });
      } catch { continue; }
      if (rnd(6) === 0 && bytes.length > 2) { bytes = Uint8Array.from(bytes); const at = 1 + rnd(bytes.length - 1); bytes[at] ^= 1 << rnd(8); }
      if (rnd(10) === 0) bytes = bytes.subarray(0, rnd(bytes.length + 1));
      const lim = LIM(1, 0, -1, -1, -1, -1, -1, rnd(5) ? -1 : rnd(400));
      cases.push({ prog: pi, rule, lim, bytes, label: `ext ${kind} #${k}`, check: () => null, ext: true });
      n++;
    }
  }
  return n;
}
