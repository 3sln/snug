// Render README tables from results/codec.json and results/cddl.json.
//     node bench/compare/report.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fmt } from './lib.mjs';

const R = new URL('./results/', import.meta.url);
const STRICT = ['cbor.mjs', 'cborg-strict', 'cbor2-strict', 'node-cbor-dup'];
const PERMISSIVE = ['cbor-x', 'cbor-x-js', 'cborg', 'cbor2', 'node-cbor', 'tiny-cbor'];
const ratio = (a, b) => (b / a >= 1 ? `${(b / a).toFixed(2)}× faster` : `${(a / b).toFixed(2)}× slower`);

if (existsSync(new URL('codec.json', R))) {
  const { workloads } = JSON.parse(readFileSync(new URL('codec.json', R)));
  const get = (w, n) => w.ops.find(o => o.name === n);
  const cell = (w, n) => { const o = get(w, n); return !o ? '—' : o.med !== undefined ? fmt(o.med) : o.status; };
  const best = (w, ids, kind) => ids.map(id => get(w, `${kind}:${id}`)).filter(o => o?.med !== undefined).sort((a, b) => a.med - b.med)[0];

  console.log('### Decode, summary (snug = scan + build, strict)\n');
  console.log('| workload | bytes | snug | fastest permissive (no deterministic checks) | snug vs it | cborg strict (partial checks) | snug vs it | cbor2 CDE strict (closest checks) | snug vs it | cbor.mjs (same profile) | snug vs it |');
  console.log('| --- | ---: | ---: | --- | --- | ---: | --- | ---: | --- | ---: | --- |');
  for (const w of workloads) {
    const s = get(w, 'decode:snug'), p = best(w, PERMISSIVE, 'decode');
    const c = id => { const o = get(w, 'decode:' + id); return o?.med !== undefined ? `${fmt(o.med)} | ${ratio(s.med, o.med)}` : `${o?.status ?? '—'} | `; };
    console.log(`| ${w.name} | ${w.size} | ${fmt(s.med)} | ${p.name.slice(7)} ${fmt(p.med)} | ${ratio(s.med, p.med)} | ${c('cborg-strict')} | ${c('cbor2-strict')} | ${c('cbor.mjs')} |`);
  }
  const dcols = ['snug', 'snug-scan', 'cbor.mjs', 'cborg-strict', 'cbor2-strict', 'node-cbor-dup', 'cbor-x', 'cbor-x-js', 'cborg', 'cbor2', 'node-cbor', 'tiny-cbor'];
  console.log('\n### Decode, every configuration (median per call)\n');
  console.log(`| workload | ${dcols.join(' | ')} |`); console.log(`| --- |${dcols.map(() => ' ---: |').join('')}`);
  for (const w of workloads) console.log(`| ${w.name} | ${dcols.map(c => cell(w, 'decode:' + c)).join(' | ')} |`);
  const ecols = ['snug', 'snug-writer', 'cbor.mjs', 'cborg', 'cborg-8949', 'cbor2-cde', 'node-cbor-canon', 'cbor-x', 'cbor2', 'node-cbor', 'tiny-cbor'];
  console.log('\n### Encode, every configuration (median per call; † = output not byte-equal to snug\'s, see the encode notes)\n');
  console.log(`| workload | ${ecols.join(' | ')} |`); console.log(`| --- |${ecols.map(() => ' ---: |').join('')}`);
  for (const w of workloads) console.log(`| ${w.name} | ${ecols.map(c => { const o = get(w, 'encode:' + c); return !o ? '—' : o.med === undefined ? o.status : fmt(o.med) + (o.equal ? '' : ' †'); }).join(' | ')} |`);
  console.log('\n### Encode, deterministic encoders summary\n');
  console.log('| workload | snug encode | snug Writer | fastest other deterministic encoder (byte-equal to snug) | snug encode vs it |');
  console.log('| --- | ---: | ---: | --- | --- |');
  for (const w of workloads) {
    const s = get(w, 'encode:snug'), wr = get(w, 'encode:snug-writer');
    const d = ['cbor.mjs', 'cborg', 'cborg-8949', 'cbor2-cde', 'node-cbor-canon'].map(id => get(w, 'encode:' + id)).filter(o => o?.med !== undefined && o.equal).sort((a, b) => a.med - b.med)[0];
    console.log(`| ${w.name} | ${fmt(s.med)} | ${wr?.med ? fmt(wr.med) : '—'} | ${d ? `${d.name.slice(7)} ${fmt(d.med)}` : 'none byte-equal'} | ${d ? ratio(s.med, d.med) : ''} |`);
  }
  console.log('\n### Encode notes (byte-equal to snug / same value after a permissive decode / accepted by snug strict decode)\n');
  for (const w of workloads) {
    const bad = w.ops.filter(o => o.name.startsWith('encode:') && (o.equal === false || o.status !== 'ok'));
    if (bad.length) console.log(`- ${w.name}: ${bad.map(o => o.status !== 'ok' ? `${o.name.slice(7)} ${o.status} (${o.note})` : `${o.name.slice(7)} ${o.bytes} B${o.sameValue ? '' : ', value differs'}${o.snugAccepts ? '' : `, snug refuses (${o.snugRefusal})`}`).join('; ')}`);
  }
}

if (existsSync(new URL('cddl.json', R))) {
  const { groups, rows } = JSON.parse(readFileSync(new URL('cddl.json', R)));
  console.log('\n### CDDL validation in a JS host (median per call; ! = verdict disagrees with the expected one)\n');
  console.log(`| case | bytes | expected | ${groups.join(' | ')} | snug units |`); console.log(`| --- | ---: | --- |${groups.map(() => ' ---: |').join('')} ---: |`);
  for (const r of rows) console.log(`| ${r.id} | ${r.bytes} | ${r.valid ? 'valid' : 'invalid'} | ${groups.map(g => { const c = r.cells[g]; return c.med !== undefined ? fmt(c.med) + (c.agrees ? '' : ' !') : c.status; }).join(' | ')} | ${r.cells['snug-js'].extra?.units ?? ''} |`);
}
