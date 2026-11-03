// Build the JSON fixtures the runtime suite reads, in Node, from a source
// checkout's corpus and a staged package (tools/runtime/run.mjs calls this).
//   profile   corpus/cbor-vectors/cbor-profile.json accept/refuse vectors
//   oracle    cborg-accepted oracle inputs: the 12 the oracle file labels
//             `profile:<code>` must be refused with that code, the rest must
//             decode and re-encode to the same bytes. (The baseline codec,
//             bench/baseline/cbor-3sln.mjs, agrees on all but one label: it
//             accepts the float32 typed array holding a NaN, labelled
//             profile:typed_array, and decodes it to 1.6e19.)
//   contracts the six study contracts (corpus/conformance/study.json suites with
//             cddlFile), CDDL text inlined
//   probes    every other study suite except phase "later"
//   programs  each compilable suite's serialised Program (hex), compiled here
//             by the staged package, for the compiler-free (fromSerialized)
//             variant and the cross-runtime container comparison
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const hex = b => Buffer.from(b).toString('hex');

export async function buildFixtures(checkout, pkg) {
  const json = p => JSON.parse(readFileSync(join(checkout, p), 'utf8'));
  const profile = json('corpus/cbor-vectors/cbor-profile.json');
  const oracleFile = json('corpus/cbor-vectors/cbor-cborg-oracle.json');
  const oracle = oracleFile.cases.filter(c => c.accept).map(c =>
    c.origin.startsWith('profile:') ? { hex: c.hex, refuse: c.origin.slice('profile:'.length) } : { hex: c.hex });
  const study = json('corpus/conformance/study.json');
  const contracts = [], probes = [];
  for (const s of study.suites) {
    if (s.phase === 'later') continue;
    const suite = { name: s.name, cddl: s.cddl ?? readFileSync(join(checkout, 'corpus', s.cddlFile), 'utf8'),
      profile: s.profile, options: s.options, schemaError: s.schemaError ?? s.snugSchemaError, cases: s.cases.map(({ rule, hex, expect }) => ({ rule, hex, expect })) };
    (s.cddlFile ? contracts : probes).push(suite);
  }
  const viewSchema = { name: 'examples/view.mjs', cddl: 'doc = { items: [* item] }\nitem = { id: uint }' };
  const { compile } = await import(pathToFileURL(join(pkg, 'src/public-compile.mjs')));
  const programs = {};
  for (const s of [...contracts, ...probes, viewSchema]) {
    if (s.schemaError) continue;
    programs[s.name] = hex((await compile(s.cddl, { profile: s.profile ?? 'full' })).program.serialize());
  }
  return { profile: { accept: profile.accept, refuse: profile.refuse }, oracle, contracts, probes, viewSchema, programs };
}
