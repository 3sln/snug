// P9.6: cases for tests/async_sources.rs -- a seeded slice of `bb vmsession-test`'s
// case set (vm-test's cases: worked examples, profile identity against `any`, the
// deterministic and valid presets, the corpus through the compiler, PEG schemas,
// assembled Programs, extension controls; plus the session stress set: long keys,
// LITSET/regexp key typesets, long texts, .cbor/.cborseq, typed arrays, bignums).
//
//     node async-cases.mjs ROOT [mutations] [seed] [schemas] [stress]
//
// prints `prog <words csv> <pool hex or ->` and
// `case <prog> <rule> <l0>,..,<l9> <input hex or ->` lines (limits words as
// schema::Options::words makes them; cases it cannot express are left out).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [rootArg, mutArg, seedArg, schemaArg, stressArg] = process.argv.slice(2);
const root = path.resolve(rootArg);
const load = name => import(pathToFileURL(path.join(root, name)));
const { buildVmCases } = await load('kin/scripts/vm-allcases.mjs');
const { sessionCases } = await load('kin/scripts/vmsession-cases.mjs');
const { compile } = await load('host/js/src/compile.mjs');

const MUTATIONS = Number(mutArg ?? 1500), SEED = Number(seedArg ?? 1), SCHEMAS = Number(schemaArg ?? 40), STRESS = Number(stressArg ?? 30);
let fails = 0;
const fail = msg => { fails++; process.stderr.write(`FAIL ${msg}\n`); };
const { programs, cases } = buildVmCases({ MUTATIONS, SEED, SCHEMAS, fail, valid: true });
const all = cases.filter(c => !c.span);
const stressProg = new Map();
for (const c of sessionCases(STRESS, SEED)) {
  if (!stressProg.has(c.cddl)) {
    const k = compile(c.cddl, { limits: { items: 1 << 20, entries: 1 << 20 } });
    programs.push({ P: k.program, B: k.pool, label: c.cddl });
    stressProg.set(c.cddl, { prog: programs.length - 1, rule: k.rules.indexOf('r') });
  }
  const { prog, rule } = stressProg.get(c.cddl);
  all.push({ prog, rule, lim: c.lim, bytes: c.bytes });
}
if (fails) process.exit(1);
const hex = b => b.length ? Buffer.from(b).toString('hex') : '-';
// schema::Options::words: [top 0|1, cose 0|1, six limits (-1 = compiled, else >= 0), 0, profile flags]
const expressible = l => (l.length === 10 || (l.length === 11 && l[10] === -1)) && (l[0] === 0 || l[0] === 1)
  && (l[1] === 0 || l[1] === 1) && l.slice(2, 8).every(v => v >= -1) && l[8] === 0;
const out = [];
for (const p of programs) out.push(`prog ${Array.from(p.P).join(',')} ${hex(p.B)}`);
for (const c of all) {
  if (!expressible(c.lim)) continue;
  out.push(`case ${c.prog} ${c.rule} ${c.lim.slice(0, 10).join(',')} ${hex(c.bytes)}`);
}
process.stdout.write(out.join('\n') + '\n');
