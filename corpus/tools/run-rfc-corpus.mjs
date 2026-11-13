#!/usr/bin/env node
// Run expectations without rewriting them. Report mode exits 0 with findings;
// --gate exits 1 for any unexplained failure (one without a classification, P9.2)
// or a stale classification. --depends=P8.4 selects that exact group;
// --depends=baseline excludes all staged dependencies. Default includes all.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compile } from '../../host/js/src/public-compile.mjs';
import { abnf } from '../../host/js/src/abnf.mjs';
import { decode } from '../../host/js/src/index.mjs';
import { readSequence } from '../../host/js/src/public-sequence.mjs';
import { selfWatch } from '../../kin/scripts/watchdog.mjs';
selfWatch('rfc-corpus', import.meta.url);   // P9.1 caps
// RFC 9165 §3's .abnf/.abnfb need the optional ABNF module (P9.14, D334); it binds nothing else
const withAbnf={controls:{...abnf}};

const location = new URL('../conformance/rfc/', import.meta.url);
function fingerprint() {
  const result={};
  for(const path of ['../../host/js/src/','../../gen/js/']) {
    const dir=new URL(path,import.meta.url);
    for(const file of readdirSync(dir,{recursive:true}).filter(f=>f.endsWith('.mjs')).sort())
      result[path+file]=createHash('sha256').update(readFileSync(new URL(file,dir))).digest('hex');
  }
  return result;
}
const runtimeStart=fingerprint();
const read = url => JSON.parse(readFileSync(url,'utf8'));
const groupOf = c => c.dependsOn?.length ? [...c.dependsOn].sort().join('+') : 'baseline';
const selected = process.argv.find(x=>x.startsWith('--depends='))?.slice(10);
const rows=[]; const compilation=[]; const groups={};
// P9.2: a failing check may carry a classification ({kind, decision, reason}: a documented
// deviation, a contested reading, or work pending a checklist item); it is then explained.
// A classified check that passes is stale (its classification must be removed).
function record(suite, kind, id, expectation, observed, dependsOn=[], detail={}, classification) {
  const group=groupOf({dependsOn});
  if(selected && selected!==group)return;
  const pass=expectation===observed;
  (groups[group]??={pass:0,fail:0})[pass?'pass':'fail']++;
  rows.push({suite,kind,id,group,expect:expectation,observed,pass,...detail,
    ...(classification?{classification,status:pass?'stale':'classified'}:{status:pass?'pass':'unexplained'})});
}
function fault(error) {return error.code||error.reason||error.name;}
function observedClass(code) {
  if(['truncated','malformed','trailing'].includes(code))return 'not-well-formed';
  if(['text','duplicate_key','tag','bignum'].includes(code))return 'invalid';
  return code?'profile-or-resource-refusal':undefined;
}
const validSupported = (()=>{try{decode(Uint8Array.of(0),{wire:'valid',top:'any'});return true;}catch{return false;}})();
async function wireCase(name,vector,index,sequence=false) {
  const buffer=Buffer.from(vector.hex,'hex');
  for(const policy of ['valid','deterministic','bindle']) {
    const options={wire:policy,top:'any'};
    // P9.13 WP3 (S8): wire 'valid' is always asked for; a build without it fails (no fallback)
    let observed=true,code,count=0;
    try {
      if(sequence)for await(const message of readSequence([buffer],options))count++;
      else decode(buffer,options);
    } catch(error) {observed=false;code=fault(error);}
    const dependsOn=policy==='valid'?['P8.4']:[];
    record(name,sequence?'sequence':'wire',`${index}:${policy}`,vector.expect[policy],observed,dependsOn,{code,
      ...(sequence?{itemCount:count}:{}),expectedClass:vector.expectedClass,observedClass:observedClass(code)},vector.classification?.[policy]);
    if(sequence && (vector.expect[policy] || vector.expectedClass))record(name,'item-count',`${index}:${policy}`,vector.itemCount,count,dependsOn);
  }
}
const a=read(new URL('../cbor-vectors/rfc8949-appendix-a.json',import.meta.url));
for(let i=0;i<a.vectors.length;i++)await wireCase('RFC 8949 Appendix A',a.vectors[i],i);
for(const file of readdirSync(location).filter(x=>/^rfc\d+.*\.json$/.test(x)).sort()) {
  const doc=read(new URL(file,location));
  if(doc.vectors)for(let i=0;i<doc.vectors.length;i++)await wireCase(file,doc.vectors[i],i,file==='rfc8742.json');
  for(const suite of doc.suites||[]) {
    let schema;
    const cddl=typeof suite.context==='string'?suite.context+'\n'+suite.cddl:suite.context?.cddl||suite.cddl;
    try {await compile(suite.cddl,withAbnf);compilation.push({suite:suite.name,kind:'extracted',ok:true});}
    catch(error){compilation.push({suite:suite.name,kind:'extracted',ok:false,code:fault(error),line:error.line,column:error.column});}
    try{schema=await compile(cddl,withAbnf);}
    catch(error){compilation.push({suite:suite.name,kind:'effective',ok:false,code:fault(error),line:error.line,column:error.column});}
    if(schema)compilation.push({suite:suite.name,kind:'effective',ok:true});
    const extracted=compilation.findLast(c=>c.suite===suite.name&&c.kind==='extracted');
    if(!extracted.ok)console.log(`COMPILE FINDING ${suite.name}: ${extracted.code}${suite.noCasesReason?' (illustrative/incomplete excerpt)':''}`);
    // Compile failures remain failures, including cases expecting invalid data:
    // no data verdict exists when the schema could not be compiled.
    for(let i=0;i<suite.cases.length;i++) {
      const test=suite.cases[i];let observed=null,code;
      if(schema)try {
        const result=schema.validate(Buffer.from(test.hex,'hex'),test.rule,{wire:'valid'});
        observed=result.ok;code=result.reason;
      }catch(error){code=fault(error);}
      record(suite.name,'cddl',i,test.expect,observed,test.dependsOn,{rule:test.rule,code:code||(!schema?'compile-failure':undefined),ruby:test.ruby},test.classification);
    }
  }
}
for(const name of new Set(rows.map(r=>r.suite))) {
  const cases=rows.filter(r=>r.suite===name);
  const counts={};for(const test of cases){const g=counts[test.group]??={pass:0,fail:0};g[test.pass?'pass':'fail']++;}
  const failed=cases.filter(c=>!c.pass), unexplained=cases.filter(c=>c.status==='unexplained'||c.status==='stale');
  const label=unexplained.length?'FAIL':failed.length?'CLASSIFIED':'PASS';
  console.log(`${label} ${name}: ${JSON.stringify(counts)}${failed.length&&!unexplained.length?` -- ${failed.length} classified (${[...new Set(failed.map(c=>c.classification.decision))].join(', ')})`:''}`);
  for(const row of cases.filter(c=>c.status==='stale'))console.log(`  STALE ${row.kind} ${row.id}: passes, but is classified ${row.classification.decision}; remove the classification`);
  if(process.argv.includes('--verbose'))for(const row of failed)console.log(`  ${row.kind} ${row.id} [${row.group}] expected ${row.expect}, observed ${row.observed} (${row.code||'verdict'})${row.classification?` -- ${row.classification.kind} ${row.classification.decision}`:' -- UNEXPLAINED'}`);
}
const ruby=rows.filter(r=>r.kind==='cddl').map(r=>r.ruby);
const runtimeEnd=fingerprint();
const summary={validSupported,runtimeStable:JSON.stringify(runtimeStart)===JSON.stringify(runtimeEnd),groups,checks:rows.length,pass:rows.filter(r=>r.pass).length,fail:rows.filter(r=>!r.pass).length,
  classified:rows.filter(r=>r.status==='classified').length,unexplained:rows.filter(r=>r.status==='unexplained').length,stale:rows.filter(r=>r.status==='stale').length,
  compilation:{extracted:compilation.filter(c=>c.kind==='extracted').length,rawFailures:compilation.filter(c=>c.kind==='extracted'&&!c.ok).length,effectiveFailures:compilation.filter(c=>c.kind==='effective'&&!c.ok).length},
  ruby:{checked:ruby.filter(r=>r?.status==='checked').length,disagreements:ruby.filter(r=>r?.agrees===false).length,unavailable:ruby.filter(r=>r?.status==='unavailable').length}};
console.log('SUMMARY '+JSON.stringify(summary));
const output=process.argv.find(x=>x.startsWith('--json='))?.slice(7);
if(output)writeFileSync(output,JSON.stringify({summary,runtimeStart,runtimeEnd,compilation,results:rows},null,2)+'\n');
// --gate: every failure must be classified (P9.2), and no classification may be stale; wire 'valid' must be
// supported and the runtime unchanged from start to end (P9.13 WP3, S8)
if(process.argv.includes('--gate')){
  const why=[...(summary.unexplained||summary.stale?[`${summary.unexplained} unexplained, ${summary.stale} stale`]:[]),
    ...(!validSupported?["wire 'valid' is not supported by this build"]:[]),...(!summary.runtimeStable?['the runtime fingerprint changed during the run']:[])];
  console.log(why.length?`FAIL rfc-corpus: ${why.join('; ')}`:'ok rfc-corpus');
  if(why.length)process.exitCode=1;
}
