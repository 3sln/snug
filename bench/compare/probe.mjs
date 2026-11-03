// P7.8: what each decoder configuration actually checks, measured by feeding it one input per rule (accept = the
// library returned a value; refuse = it threw). Also: which encoders' output snug's strict decoder refuses.
//
//     node bench/compare/probe.mjs            (prints markdown tables)
import { DECODERS, ENCODERS, snug, toMaps } from './lib.mjs';

const h = s => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'hex'));
// Every input is invalid under RFC 8949 §4.2.1 core deterministic encoding or under §3 well-formedness/validity
// unless marked "valid"; `rule` names what a decoder must check to refuse it.
export const PROBES = [
  ['valid control: {"a":1,"b":[1.5,-2]}', 'a2 6161 01 6162 82 f93e00 21', 'valid'],
  ['non-shortest integer (1 as 0x18 0x01)', '18 01', 'shortest form (int)'],
  ['non-shortest length (text len 1 as 0x78 0x01)', '78 01 61', 'shortest form (length)'],
  ['non-shortest map head (cbor-x style 0xb9 0x0001)', 'b9 0001 6161 01', 'shortest form (length)'],
  ['non-shortest float (1.5 as float64)', 'fb 3ff8000000000000', 'shortest form (float)'],
  ['non-shortest float (1.5 as float32)', 'fa 3fc00000', 'shortest form (float)'],
  ['indefinite-length array', '9f 01 ff', 'definite lengths'],
  ['indefinite-length text', '7f 6161 ff', 'definite lengths'],
  ['map keys out of order {"b":1,"a":2}', 'a2 6162 01 6161 02', 'key order'],
  ['map keys out of order, int keys {2:0,1:0}', 'a2 02 00 01 00', 'key order'],
  ['duplicate map key {"a":1,"a":2}', 'a2 6161 01 6161 02', 'duplicate keys'],
  ['invalid UTF-8 (c3 28)', '62 c3 28', 'UTF-8 validity'],
  ['UTF-8-encoded surrogate (ed a0 80)', '63 eda080', 'UTF-8 validity'],
  ['overlong UTF-8 (c0 af)', '62 c0af', 'UTF-8 validity'],
  ['invalid UTF-8 in a map key', 'a1 62 c328 01', 'UTF-8 validity'],
  ['trailing bytes after the item', '01 02', 'no trailing data'],
  ['truncated text', '62 61', 'well-formed'],
  ['declared length 2^64-1', '5b ffffffffffffffff', 'well-formed'],
  ['reserved additional info 28', '1c', 'well-formed'],
  ['bignum that fits in 64 bits (tag 2, 0x01)', 'c2 41 01', 'preferred bignum'],
  ['bignum with leading zero byte (tag 2)', 'c2 49 00 010000000000000000', 'preferred bignum'],
  ['undefined (0xf7)', 'f7', 'profile: simple values'],
  ['unassigned simple value 16', 'f0', 'profile: simple values'],
  ['scalar NaN (f9 7e00)', 'f9 7e00', 'profile: NaN'],
  ['scalar +Infinity (f9 7c00)', 'f9 7c00', 'profile: infinities'],
  ['negative zero (f9 8000)', 'f9 8000', 'profile: -0'],
  ['integral float 1.0 (f9 3c00)', 'f9 3c00', 'profile: integral floats'],
  ['unknown tag 100', 'd8 64 01', 'profile: tag allow-list'],
  ['integer map key {1:0} (top level)', 'a1 01 00', 'profile: text keys (cose allows top level)'],
  ['nested integer-key map {"k":{1:0}} (COSE_Key in a CWT cnf)', 'a1 616b a1 01 00', 'profile: text keys'],
  ['COSE_Sign1 (tag 18 array)', 'd2 84 40 a0 40 40', 'profile: tag allow-list'],
  ['epoch date (tag 1)', 'c1 1a 6955b900', 'profile: tag allow-list'],
  ['deep nesting: 33 nested arrays', '81'.repeat(33) + '00', 'depth limit (snug default 32)'],
];

const outcome = (d, b, opts) => { try { d.fn(b, { opts: { top: 'any', ...opts }, maps: true }); return 'accept'; } catch (e) { return 'refuse'; } };

export function probe() {
  const cols = DECODERS.filter(d => d.id !== 'snug-scan' && d.id !== 'cbor-x-js'); // cbor-x-js: same checks as cbor-x
  const rows = PROBES.map(([name, hx, rule]) => {
    const b = h(hx);
    return { name, rule, hex: hx.replace(/\s+/g, ''), res: cols.map(d => outcome(d, b, {})),
      snugCose: outcome(DECODERS[0], b, { cose: true }) };
  });
  return { cols, rows };
}

export function encoderOutputs() {
  // A small mixed value every encoder can represent; is each encoder's output accepted by snug's strict decoder?
  const v = { name: 'x', n: 1.5, big: 100000, list: [1, 2, 3], zz: true, a: { b: null } };
  return ENCODERS.map(e => {
    let bytes, verdict;
    try { bytes = e.fn(e.mapsOnly ? toMaps(v) : v, { opts: { top: 'any' } }); } catch (err) { return { id: e.id, verdict: `encode threw: ${err.message}` }; }
    try { snug.decode(bytes, { top: 'any' }); verdict = 'accepted'; } catch (err) { verdict = `refused: ${err.code ?? err.message}`; }
    return { id: e.id, verdict, hex: Buffer.from(bytes).toString('hex') };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { cols, rows } = probe();
  console.log('| input | rule | ' + cols.map(c => c.id).join(' | ') + ' | snug cose |');
  console.log('| --- | --- |' + cols.map(() => ' :-: |').join('') + ' :-: |');
  const mark = r => r === 'accept' ? 'A' : '**R**';
  for (const r of rows) console.log(`| ${r.name} | ${r.rule} | ${r.res.map(mark).join(' | ')} | ${mark(r.snugCose)} |`);
  console.log('\nEncoder output (value {name,n:1.5,big:100000,list,zz,a:{b:null}}) under snug strict decode:\n');
  for (const e of encoderOutputs()) console.log(`- ${e.id}: ${e.verdict}${e.hex ? ` (${e.hex})` : ''}`);
}
