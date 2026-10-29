// Exports the 3sln.me CDDL study's probes and contract cases (corpus/cddl-study/) as a host-neutral JSON corpus
// (corpus/conformance/study.json): CDDL text, rule, CBOR hex, expected verdict under snug's semantics.
// Values are encoded with the baseline 3sln.me codec (bench/baseline/cbor-3sln.mjs). Run: node corpus/tools/export-study.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import * as cbor from '../../bench/baseline/cbor-3sln.mjs';
const { encode, BindleDecimal, NDArray } = cbor;
const here = new URL('../cddl-study/', import.meta.url);
const hexOf = b => Buffer.from(b).toString('hex');
const unhex = s => Uint8Array.from(s.replace(/\s/g, '').match(/../g), b => parseInt(b, 16));

// --- probes: evaluate the probe table of probes.mjs with its imports and runner stripped
const src = readFileSync(new URL('probes.mjs', here), 'utf8');
const table = src.split('\n').filter(l => /^(const (hex|B|raw|P)=|probe\()/.test(l) || l.startsWith("const probe=")).join('\n');
const P = new Function('encode', 'BindleDecimal', 'NDArray', table.replace('const P=[];', 'const P=[];') + '\nreturn P;')(encode, BindleDecimal, NDArray);

// snug-specific expectations that differ from the study's (each with a reason). Key: feature name.
const SNUG = {
  '.abnf rejects non-match': { schemaError: 'unsupported_control', why: 'D013: .abnf refused' },
  '.abnf (RFC 9165)': { schemaError: 'unsupported_control', why: 'D013: .abnf refused' },
  '.pcre': { schemaError: 'unsupported_control', why: 'D013: .pcre refused' },
  '.regexp \\w \\s escapes': { schemaError: 'regexp', why: 'D014: \\w is not I-Regexp (RFC 9485)' },
  '.regexp counted unicode class': { schemaError: 'regexp', why: 'D014: \\x00 is not I-Regexp; use CDDL \\u escapes in the string literal (see study-extra)' },
  '.cat / .det (RFC 9165)': { phase: 'later', why: 'RFC 9165 constant folding is a later phase' },
  '.plus (RFC 9165)': { phase: 'later', why: 'RFC 9165 constant folding is a later phase' },
  'non-text map keys (CBOR int keys)': { options: { cose: true }, why: 'default profile refuses int keys (key_type); cose allows them at top level' },
};

const out = { format: 'snug conformance corpus v1. Each suite: cddl text, profile (full unless stated), cases [{rule, hex, expect: true|false, reason?, note?}]. A suite with schemaError expects compile to fail with that code. phase:"later" suites are not yet gated.', source: 'corpus/cddl-study (3sln.me CDDL study, 2026-10-29)', suites: [] };
for (const p of P) {
  const s = SNUG[p.feature] ?? {};
  const cases = p.cases.map(([v, expect]) => ({ rule: p.rule, hex: hexOf(v instanceof Uint8Array && v.__raw ? v : encode(v)), expect }));
  out.suites.push({ name: 'probe: ' + p.feature, cddl: p.cddl, ...(s.schemaError ? { schemaError: s.schemaError } : {}), ...(s.phase ? { phase: s.phase } : {}), ...(s.options ? { options: s.options } : {}), cases, ...(p.note || s.why ? { note: [p.note, s.why].filter(Boolean).join(' | ') } : {}) });
}
// raw-hex probes: keep the raw bytes (probes.mjs marks them with __raw)
// --- contracts: reuse contracts.mjs case table
const csrc = readFileSync(new URL('contracts.mjs', here), 'utf8');
const start = csrc.indexOf('const sets='), end = csrc.indexOf('};', start) + 2;
const jkt = 'a'.repeat(43), sid = 'b'.repeat(22);
const sets = new Function('encode', 'BindleDecimal', 'NDArray', 'jkt', 'sid', csrc.slice(start, end) + '\nreturn sets;')(encode, BindleDecimal, NDArray, jkt, sid);
for (const [file, cases] of Object.entries(sets)) {
  out.suites.push({ name: 'contract: ' + file, cddlFile: 'cddl-study/contracts/' + file, cases: cases.map(([rule, v, expect, note]) => ({ rule, hex: hexOf(encode(v)), expect, ...(note ? { note } : {}) })) });
}
// signaling (the study validated it as JSON; the values are JSON-compatible, so CBOR-encode them)
const base = { bindle: 'signaling-message', v: 1, iss: 'https://p.example', sub: 'https://p.example/u', aud: 'https://q.example/v', sid, leg: jkt, seq: 0, iat: 1 };
const sig = [[{ ...base, to: null, type: 'cancel', body: {} }, true], [{ ...base, to: jkt, type: 'end', body: { reason: 'closed' } }, true], [{ ...base, to: jkt, type: 'end', body: { reason: 'nope' } }, false], [{ ...base, to: null, type: 'end', body: { reason: 'closed' } }, false], [{ ...base, seq: 4096, to: null, type: 'cancel', body: {} }, false], [{ ...base, to: null, type: 'cancel', body: {}, extra: 1 }, false],
  [{ ...base, to: null, type: 'invite', body: { kind: { artefact: 'a', version: '1', digest: 'd' }, profile: 'webrtc', answer_by: 5, basis: null, context: { a: 1 }, params: {} } }, true],
  [{ ...base, to: null, type: 'invite', body: { kind: { artefact: 'a', version: '1', digest: 'd' }, profile: 'webrtc', answer_by: 5, basis: { relation: 'friend' }, context: null, params: {} } }, false]];
out.suites.push({ name: 'contract: signaling-message-v1.cddl', cddlFile: 'cddl-study/contracts/signaling-message-v1.cddl', note: 'study validated these as JSON; here CBOR-encoded', cases: sig.map(([v, expect]) => ({ rule: 'message', hex: hexOf(encode(v)), expect })) });
writeFileSync(new URL('../conformance/study.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log('suites', out.suites.length, 'cases', out.suites.reduce((n, s) => n + s.cases.length, 0));
