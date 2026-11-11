#!/usr/bin/env node
// Offline RFC corpus extraction. Run from any directory; no installed packages.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { compile } from '../../host/js/src/public-compile.mjs';
import { decode } from '../../host/js/src/index.mjs';
import { selections, dataFor8610, dataFor9165, example as e, bytes, tag, raw, map, head, cbor } from './rfc-fixtures.mjs';

const root = new URL('../', import.meta.url);
const destination = new URL('conformance/rfc/', root);
mkdirSync(destination, { recursive: true });
const hash = x => createHash('sha256').update(x).digest('hex');
const write = (url, value) => writeFileSync(url, JSON.stringify({license:'RFC extracts: corpus/conformance/rfc/README.md and accompanying BSD license texts',...value}, null, 2) + '\n');
const source = new Map();
const provenance=readFileSync(new URL('rfc/README.md',root),'utf8');
for (const n of [8949,8610,9165,9682,8392,9052,8746,8742]) {
  const buffer = readFileSync(new URL(`rfc/rfc${n}.txt`, root));
  const expected=provenance.match(new RegExp('`rfc'+n+'\\.txt`[^\\n]*`([0-9a-f]{64})`'))?.[1];
  if(!expected||hash(buffer)!==expected)throw Error(`RFC ${n} source does not match corpus/rfc/README.md SHA-256`);
  const text = buffer.toString('utf8');
  source.set(n, { text, lines: text.split(/\r\n|[\n\f]/), sha256: hash(buffer) });
}
function extract(n, from, to) {
  const src = source.get(n);
  const selected = src.lines.slice(from - 1, to);
  const fixes = [];
  const lines = selected.filter((line, i) => {
    if (/\[Page \d+\]$/.test(line) || new RegExp(`^RFC ${n}\\s`).test(line)) {
      fixes.push({ logicalLine: from + i, removed: line }); return false;
    }
    return true;
  });
  // Remove blank page furniture (never blank lines inside quoted literals).
  if (fixes.length) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim() && (!lines[i - 1]?.trim() || !lines[i + 1]?.trim())) lines.splice(i, 1);
    }
  }
  const indent = Math.min(...lines.filter(x => x.trim()).map(x => x.match(/^ */)[0].length));
  const cddl = lines.map(x => x.slice(Math.min(indent, x.match(/^ */)[0].length))).join('\n').trimEnd() + '\n';
  const prefix = src.lines.slice(0,from - 1).join('\n');
  const section = [...prefix.matchAll(/^(?:Appendix [A-Z]\.|(?:[A-Z]|\d+)(?:\.\d+)*\.  ).+$/gm)].at(-1)?.[0];
  return { cddl, source: { rfc:n, section, logicalLines:[from,to], sha256:src.sha256 },
    extraction: { indentRemoved:indent, pageArtifactFixes:fixes } };
}
// Ruby reference oracle: see corpus/tools/ORACLES.md.
const oracles = decodeURIComponent(new URL('../../.cache/oracles/', import.meta.url).pathname);
const wrapper = process.env.RFC_RUBY || process.env.RUBY_CDDL || join(oracles, 'ruby-cddl.sh');
const gemHome = process.env.RFC_GEM_HOME || process.env.RUBY_CDDL_GEM_HOME || join(oracles, 'ruby-gems');
const rubyEnv = { ...process.env, GEM_HOME:gemHome, GEM_PATH:gemHome };
function diagnosticHex(text) {
  const result = spawnSync(join(gemHome,'bin/diag2cbor.rb'), [], { input:text, env:rubyEnv, timeout:30000 });
  if (result.status !== 0) throw Error(`Diagnostic conversion failed: ${result.error?.code || result.status}: ${result.stderr?.toString().slice(0,300)}`);
  return result.stdout.toString('hex');
}
const scratch = mkdtempSync(join(tmpdir(),'snug-rfc-'));
process.once('exit',()=>rmSync(scratch,{recursive:true,force:true}));
let nextRuby=0;
async function checkRuby(cddl, test) {
  const dir=join(scratch,String(nextRuby++));mkdirSync(dir);
  writeFileSync(join(dir,'schema.cddl'), `probe-root = ${test.rule}\n${cddl}`);
  writeFileSync(join(dir,'case.cbor'), Buffer.from(test.hex,'hex'));
  const result=await new Promise(resolve=>{
    const proc=spawn(wrapper,[join(dir,'schema.cddl'),'validate',join(dir,'case.cbor')]);
    let stdout='',stderr='',error;
    const timer=setTimeout(()=>{error={code:'ETIMEDOUT'};proc.kill('SIGKILL');},15000);
    proc.stdout.on('data',b=>{if(stdout.length<1024*1024)stdout+=b.toString();});
    proc.stderr.on('data',b=>{if(stderr.length<1024*1024)stderr+=b.toString();});
    proc.on('error',e=>{error=e;});
    proc.on('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr,error});});
  });
  // A schema/runtime/tool failure is never counted as an invalid-data verdict.
  const stderr = result.stderr?.toString() || '';
  const stdout = result.stdout?.toString() || '';
  const runtimeError = /(?:Traceback|SyntaxError|NoMethodError|RuntimeError|ParserError|ParseError|ArgumentError|TypeError|RangeError|EncodingError|SystemStackError|LoadError|uninitialized constant|undefined method|cannot load|can't find gem|Couldn't find|Parse error|parse error|CDDL::.*Error)/.test(stderr + stdout);
  const duplicate=(stderr+stdout).match(/Duplicate rule definition ([\w-]+)/);
  const verdict = !runtimeError && [0,1].includes(result.status) ? result.status === 0 : null;
  return { status: verdict === null ? 'unavailable' : 'checked', exitCode:result.status,
    ...(result.error ? { error:result.error.code } : {}),
    ...(verdict === null ? { finding: runtimeError ? 'reference schema/runtime error' : 'reference process did not return a data verdict',
      ...(duplicate?{category:'duplicate-prelude-rule',schemaRule:duplicate[1]}:{}) }
      : { verdict, agrees:verdict === test.expect,
        ...(! (verdict === test.expect) ? { explanation:disagreement(cddl,test) } : {}) }) };
}
function disagreement(cddl,test) {
  if(test.dependsOn?.includes('D301'))return 'RFC 8610 §3.5.4 / Appendix A cut disables enclosing choice; Ruby follows D021 branch-local cuts. D301 makes the literal RFC cut snug\'s default (rule A is cuts:\'branch\').';
  if(/\.default/.test(cddl))return 'Published RFC 8610 §3.8.6 implies .ne. Ruby implements annotation-only .default, as proposed by unverified erratum 9229.';
  if(/optional-key/.test(cddl) && test.expect)return 'RFC 8610 §3.5.4 explicitly accepts optional-key:nonsense without a cut. Ruby commits to the matching key before trying the wildcard.';
  if(/Sig_structure/.test(test.rule))return 'RFC 9052 §4.4 literal CDDL has greedy optional bstr before two required bstrs. A four-element Signature1 structure is described by prose but does not match the printed CDDL under D270.';
  if(test.note.includes('not binary16'))return 'RFC 8610 Appendix H generated example uses decimal numbers not representable in binary16 although rating/confidence are float16. Ruby does not enforce the representable value set.';
  if(test.note.includes('definition of float'))return 'RFC 8610 §2.2.3 defines representable value sets. Ruby cddl.rb validates #7.25/26/27 by re-encoding the float and comparing its shortest encoded width exactly; 1.5 therefore fails float32/float64 although representable in both.';
  if(test.rule==='biguint')return 'RFC 8610 §3.6 / Appendix D biguint explicitly uses tag 2. Ruby cddl.rb synthesizes a tag-2 bstr when validating any nonnegative decoded Integer, so it also accepts untagged integer 0. The RFC-derived tag expectation is retained.';
  if(/\.feature/.test(cddl))return 'RFC 9165 §4 feature annotation leaves target membership intact; reference feature enablement/handling differs. No expectation was changed to follow Ruby.';
  if(test.dependsOn?.includes('P8.4'))return 'RFC-valid wire representation must be accepted under D230/P8.4; Ruby decoding or representation-level comparison differs.';
  return `RFC-derived expectation retained: ${test.note}. Inspect this schema/case; Ruby is evidence, not the authority.`;
}
async function compilation(cddl) {
  try { await compile(cddl); return { ok:true }; }
  catch(error) { return { ok:false, code:error.code || error.name, line:error.line, column:error.column }; }
}
function wire(hex, policy) {
  try { decode(Buffer.from(hex,'hex'),{wire:policy,top:'any'}); return {ok:true}; }
  catch(error) { return {ok:false,code:error.code || error.name}; }
}
function vector(n, section, hex, diagnostic, deterministic, extra={}) {
  const bindle = wire(hex,'bindle');
  return { hex, diagnostic, source:{rfc:n,section,sha256:source.get(n).sha256},
    expect:{valid:true,deterministic,bindle:bindle.ok}, bindleObservation:bindle, ...extra };
}
const aText = source.get(8949).text.split('\nAppendix A.')[1].split('\nAppendix B.')[0];
const appendixA = [];
let row;
for(const line of aText.split('\n')) {
  const match = line.match(/^\s*\|([^|]*)\|([^|]*)\|/);
  if(!match)continue;
  const d=match[1].trim(), h=match[2].trim();
  if(h.startsWith('0x')) { row={diagnostic:d,hex:h.slice(2)}; appendixA.push(row); }
  else if(row && /^[0-9a-f]*$/i.test(h)) { row.diagnostic += d ? (row.diagnostic.endsWith(',') ? ' ' : '') + d : ''; row.hex += h; }
}
if(appendixA.length!==81)throw Error(`Appendix A extraction changed: ${appendixA.length} rows, expected 81`);
const nonPreferredFloats = new Set(['fa7f800000','fa7fc00000','faff800000','fb7ff0000000000000','fb7ff8000000000000','fbfff0000000000000']);
const aVectors = appendixA.map(r=>vector(8949,'Appendix A / Table 6',r.hex,r.diagnostic,
  !r.diagnostic.includes('_')&&!nonPreferredFloats.has(r.hex),
  { ...(r.diagnostic.includes('_')||nonPreferredFloats.has(r.hex)?{dependsOn:['P8.4']}:{}),origin:'printed hex and diagnostic table cells, wrapped cells joined' }));
write(new URL('cbor-vectors/rfc8949-appendix-a.json',root),{format:'snug RFC CBOR vectors v1; expect policy booleans; bindle observed with top:any',generator:'corpus/tools/export-rfc.mjs',vectors:aVectors});

const fText=source.get(8949).text.split('\nF.1.')[1].split('\nAppendix G.')[0];
const fVectors=[];
for(const paragraph of fText.split(/\n\s*\n/)) {
  // Only colon-introduced example lists, never numbers from descriptive prose.
  const m=paragraph.replace(/^\s*Subkind \d+:\s*/, '').match(/^\s*([^:]+):\s+((?:[0-9a-f]{2}[\s,]*)+)$/i);
  if(!m)continue;
  for(const value of m[2].split(',')) {
    const hex=value.replace(/\s/g,''); if(!hex)continue;
    if(!/^(?:[0-9a-f]{2})+$/.test(hex))throw Error('Bad Appendix F hex');
    fVectors.push({hex,diagnostic:null,source:{rfc:8949,section:'Appendix F.1',sha256:source.get(8949).sha256},
      note:m[1].replace(/\s+/g,' ').trim(),expectedClass:'not-well-formed',expect:{valid:false,deterministic:false,bindle:false}});
  }
}
if(fVectors.length!==94)throw Error(`Appendix F extraction changed: ${fVectors.length} examples, expected 94`);
write(new URL('rfc8949-well-formedness.json',destination),{format:'snug RFC CBOR vectors v1',vectors:fVectors});
// Appendix F contains only well-formedness errors. Validity errors come from §5.3.
const invalid = [
  ['a201000101','duplicate map key', '§5.3.1'], ['62c0af','invalid UTF-8','§5.3.1'],
  ['c000','tag 0 integer content','§3.4.1'], ['c26131','tag 2 text content','§3.4.3'],
  ['d8184100ff','trailing byte after tag 24 item','Appendix F kind 1'],
];
const extraVectors = invalid.map(([hex,note,section])=>({hex,diagnostic:null,note,source:{rfc:8949,section},origin:'hand-made from RFC rule',expectedClass:hex.endsWith('ff')?'not-well-formed':'invalid',expect:{valid:false,deterministic:false,bindle:false}}));
for(const [hex,d,det,note] of [
  ['1817','23',false,'§4.1 nonpreferred integer head'],['580100',"h'00'",false,'§4.1 nonpreferred string head'],
  ['a202000100','{2:0,1:0}',false,'§4.2.1 unsorted keys'],
  ['f97e01','NaN',true,'§4.1 shortest payload-preserving NaN; canonical-NaN-only is additional §4.2.2 policy'],
  ['faffc00001','NaN',true,'§4.1 NaN payload cannot narrow by zero-padding'],
  ['c24101',"2(h'01')",false,'§3.4.3 preferred serialization uses basic integer'],
  ['c482001864','4([0,100])',true,'§4.2.2 decimal normalization requires an additional protocol rule'],
])extraVectors.push(vector(8949,note.split(' ')[0],hex,d,det,{note,origin:'hand-made from RFC rule',dependsOn:['P8.4']}));
// P9.2: a NaN with a payload is core-deterministic (§4.1, §4.2.1); snug's `deterministic`
// preset adds §4.2.2's single NaN representation on purpose (D122). The default `valid`
// preset accepts both vectors.
for(const v of extraVectors)if(v.hex==='f97e01'||v.hex==='faffc00001')v.classification={deterministic:{kind:'deviation',decision:'D122',
  reason:'snug\'s deterministic preset is RFC 8949 §4.2.1 plus §4.2.2\'s choice of one NaN: "If NaN is an allowed value, and there is no intent to support NaN payloads or signaling NaNs, the protocol needs to pick a single representation, typically 0xf97e00." §4.2.1 alone is not offered as a preset; the default valid preset accepts this NaN.'}};
write(new URL('rfc8949-additional.json',destination),{format:'snug RFC CBOR vectors v1; §4.2.2 restrictions are not core deterministic',vectors:extraVectors});

const typed=[];
const tLines=source.get(8746).text.split('\n');
for(let i=0;i<tLines.length;i++) {
  if(!/^   <Tag (40|1040|41)>/.test(tLines[i]))continue;
  const start=i; let hex='';
  while(i<tLines.length && tLines[i].trim()) {
    const code=tLines[i].split('#')[0].trim();
    const t=code.match(/^<Tag (\d+)>$/);
    if(t)hex+=head(6,t[1]); else {const h=code.replace(/\s/g,'');if(!/^(?:[0-9a-f]{2})*$/i.test(h))throw Error('bad typed array example');hex+=h;}
    i++;
  }
  typed.push(vector(8746,`§3 Figure ${typed.length+1}`,hex.toLowerCase(),null,true,{origin:'printed annotated hex; <Tag N> expanded to preferred tag head',sourceLines:[start+1,i]}));
}
if(typed.length!==5)throw Error(`Expected all RFC 8746 figures: ${typed.length}`);
write(new URL('rfc8746.json',destination),{format:'snug RFC CBOR vectors v1',vectors:typed});
write(new URL('rfc8742.json',destination),{format:'snug RFC sequence vectors v1; concatenated items without enclosing array',vectors:[
  {hex:'010203',diagnostic:'1, 2, 3',itemCount:3,expect:{valid:true,deterministic:true,bindle:true},source:{rfc:8742,section:'§4.2 both printed notations'},origin:'encoded from printed diagnostic sequence'},
  {hex:'',itemCount:0,expect:{valid:true,deterministic:true,bindle:true},source:{rfc:8742,section:'§2 empty sequence'},origin:'hand-made from rule'},
  {hex:'019fff1817',itemCount:3,expect:{valid:true,deterministic:false,bindle:false},dependsOn:['P8.4'],source:{rfc:8742,section:'§2'},origin:'hand-made: concatenated RFC-valid items'},
  {hex:'010218',itemCount:2,expectedClass:'not-well-formed',expect:{valid:false,deterministic:false,bindle:false},source:{rfc:8742,section:'§2 truncation'},origin:'hand-made: two complete items and truncated third'},
]});

const allSuites = new Map();
for(const [number,entries] of Object.entries(selections)) {
  const n=Number(number), suites=[];
  for(const [id,from,to] of entries) {
    const suite={name:`RFC ${n} ${id}`,...extract(n,from,to),cases:[]};
    suite.id=id;
    if(n===8610)suite.cases=dataFor8610(id);
    if(n===9165)suite.cases=dataFor9165(id);
    suites.push(suite);
  }
  allSuites.set(n,suites);
}
const byId=(n,id)=>allSuites.get(n).find(s=>s.id===id);
// Context is separately labelled; cddl is always the exact extracted text.
byId(8610,'figure-2').context='probe = [pii]\n';
byId(8610,'figure-3').context=byId(8610,'figure-2').cddl;
byId(8610,'choice-extensions').context='probe = {delivery}\n';
byId(8610,'bedroom-fragment').context={kind:'wrap-fragment',cddl:'probe = {\n'+byId(8610,'bedroom-fragment').cddl+'}\nsize = float\n'};
for(const [id,context,cases] of [
  ['name-with-dots','probe = min..max\nmin..max = 7\n',[e('probe',7,true,'§2.2.2.1 dots form one identifier'),e('probe',8,false,'identifier definition is literal7')]],
  ['named-range','probe = min .. max\nmin = 1\nmax = 3\n',[e('probe',2,true,'§2.2.2.1 spaces delimit range'),e('probe',4,false,'outside bounds')]],
  ['cbor-expression','probe = bytes .cbor type1\ntype1 = uint\n',[e('probe',bytes('01'),true,'§3.8.4 one encoded uint'),e('probe',bytes('0102'),false,'two items not one')]],
  ['cborseq-expression','probe = bytes .cborseq type2\ntype2 = [* uint]\n',[e('probe',bytes('0102'),true,'§3.8.4 items form virtual uint array'),e('probe',bytes('6161'),false,'text not uint')]],
  ['and-expression','probe = type1 .and type2\ntype1 = uint\ntype2 = 1..3\n',[e('probe',2,true,'§3.8.5 intersection'),e('probe',4,false,'outside intersection')]],
  ['within-expression','probe = type1 .within type2\ntype1 = 1..3\ntype2 = uint\n',[e('probe',2,true,'§3.8.5 intersection'),e('probe',4,false,'outside left type')]],
]) { const suite=byId(8610,id);suite.context={kind:'instantiate-printed-expression',cddl:context};suite.cases=cases; }
const domino="Domino's 🁳 + ⌘";
byId(9682,'figure-5').cases=[e('start',[domino,domino,domino,bytes(Buffer.from(domino).toString('hex')),bytes(Buffer.from(domino).toString('hex')),bytes(Buffer.from(domino).toString('hex'))],true,'§2.2 Figure 6; generated hex checked against printed hex below'),e('start',[domino],false,'six elements required')];
byId(9682,'tag-range').context='probe = ct-tag<uint>\n';
byId(9682,'tag-range').cases=[e('probe',tag(1668546817,0),true,'§3.2 inclusive lower bound'),e('probe',tag(1668612095,0),true,'inclusive upper bound'),e('probe',tag(1668546816,0),false,'below tag range'),e('probe',tag(1668612096,0),false,'above tag range')];
byId(9682,'hex-comments-unescaped').noCasesReason='Appendix B.1 deliberately demonstrates ambiguous old/proposed syntax. B.2 explicitly requires escaping apostrophes before the semantic comment-processing step; not a valid updated CDDL data model.';
byId(9682,'hex-comments-escaped').cases=[e('foo',bytes('43424f520a'),true,'Appendix B.1 escaped CBOR LF byte literal; comments ignored after string processing'),e('foo',bytes('43424f52'),false,'LF byte required')];

const cose=allSuites.get(9052).map(s=>s.cddl).join('\n');
for(const suite of allSuites.get(9052))suite.context={kind:'assembled-rfc-definitions',cddl:cose};
function coseExamples() {
  const src=source.get(9052);const lines=src.text.split('\n');let section='';const examples=[];
  for(let i=0;i<lines.length;i++) {
    if(/^(?:Appendix [BCD]\.|[CD]\.\d+(?:\.\d+)*\.)/.test(lines[i]))section=lines[i].trim();
    if(i<lines.findIndex(x=>x.startsWith('Appendix B.')) || !/^   (?:\d+\(|\[\s*$)/.test(lines[i]))continue;
    const start=i;const block=[];
    while(i<lines.length && lines[i].trim())block.push(lines[i++]);
    const diagnostic=block.map(x=>x.slice(3)).join('\n');
    const hex=diagnosticHex(diagnostic);
    examples.push({hex,diagnostic,source:{rfc:9052,section,lines:[start+1,i]},origin:'printed EDN converted by installed cbor-diag (preserves printed map order)'});
  }
  return examples;
}
const coseData=coseExamples();
for(const suite of allSuites.get(9052)) {
  const rule=suite.cddl.match(/^([\w_-]+)\s*=/m)?.[1];
  const value = {
    start:tag(18,[bytes(''),{},null,bytes('')]), Internal_Types:['Encrypt0',bytes(''),bytes('')],
    label:1, COSE_Messages:tag(18,[bytes(''),{},null,bytes('')]),
    Headers:[bytes(''),{}], Generic_Headers:[],
    COSE_Sign_Tagged:tag(98,[bytes(''),{},null,[[bytes(''),{},bytes('')]]]),
    COSE_Sign:[bytes(''),{},null,[[bytes(''),{},bytes('')]]], COSE_Signature:[bytes(''),{},bytes('')],
    COSE_Sign1_Tagged:tag(18,[bytes(''),{},null,bytes('')]),COSE_Sign1:[bytes(''),{},null,bytes('')],
    Sig_structure:['Signature',bytes(''),bytes(''),bytes(''),bytes('')],
    COSE_Encrypt_Tagged:tag(96,[bytes(''),{},null,[[bytes(''),{},null]]]),COSE_Encrypt:[bytes(''),{},null,[[bytes(''),{},null]]],
    COSE_recipient:[bytes(''),{},null],COSE_Encrypt0_Tagged:tag(16,[bytes(''),{},null]),COSE_Encrypt0:[bytes(''),{},null],
    Enc_structure:['Encrypt0',bytes(''),bytes('')],
    COSE_Mac_Tagged:tag(97,[bytes(''),{},null,bytes(''),[[bytes(''),{},null]]]),COSE_Mac:[bytes(''),{},null,bytes(''),[[bytes(''),{},null]]],
    COSE_Mac0_Tagged:tag(17,[bytes(''),{},null,bytes('')]),COSE_Mac0:[bytes(''),{},null,bytes('')],
    MAC_structure:['MAC0',bytes(''),bytes(''),bytes('')],COSE_Key:map([1,4]),
  }[rule];
  if(value===undefined)throw Error(`missing COSE handmade instance ${rule}`);
  const group=['Headers','Generic_Headers'].includes(rule);
  if(group)suite.context.cddl=`probe = [${rule}]\n${cose}`;
  suite.cases=[e(group?'probe':rule,value,true,'RFC 9052 printed CDDL shape; structural validation only'),e(group?'probe':rule,true,false,'Boolean does not match this structure or label')];
  if(rule==='Sig_structure')suite.cases.push(e(rule,['Signature1',bytes(''),bytes(''),bytes('')],false,'§4.4 printed CDDL greedy optional sign_protected consumes a required bstr; prose describes four fields',['D270']));
  if(rule==='COSE_Key')suite.cases.push(e('COSE_KeySet',[map([1,4])],true,'§7 nonempty key set'),e('COSE_KeySet',[],false,'+ requires at least one key'));
}
allSuites.get(9052).push({name:'RFC 9052 assembled definitions and Appendix B/C/D examples',id:'assembled',cddl:cose,source:{rfc:9052,sections:allSuites.get(9052).map(s=>s.source)},cases:coseData.map(x=>({rule:x.diagnostic.trimStart().startsWith('[')?'COSE_KeySet':'COSE_Messages',hex:x.hex,expect:true,note:x.source.section,source:x.source,dependsOn:['P8.4']}))});
write(new URL('rfc9052-diagnostic-examples.json',destination),{format:'RFC diagnostic examples; structural, not cryptographic validation',examples:coseData});

const cwt='claims = {\n ? 1 ^ => tstr, ? 2 ^ => tstr, ? 3 ^ => tstr / [* tstr],\n ? 4 ^ => number, ? 5 ^ => number, ? 6 ^ => number, ? 7 ^ => bstr,\n * (int / tstr) => any\n}\n';
const cwtExamples=[];let section='';
const cwtLines=source.get(8392).text.split('\n');
for(let i=0;i<cwtLines.length;i++) {
  if(/^A\.\d+(?:\.\d+)*\./.test(cwtLines[i]))section=cwtLines[i].trim();
  if(!/^   [a-f0-9]{20,}$/.test(cwtLines[i]))continue;
  const start=i;let hex='';while(/^   [a-f0-9]+$/.test(cwtLines[i]||''))hex+=cwtLines[i++].trim();
  cwtExamples.push({hex,source:{rfc:8392,section,lines:[start+1,i]},origin:'printed Appendix A hex; wrapped lines joined'});
}
const cwtCases=[e('claims',{},true,'§3 claims optional'),e('claims',map([4,1],[7,bytes('01')]),true,'§3.1 NumericDate and cti'),e('claims',map([4,'tomorrow']),false,'NumericDate must be integer/float'),e('claims',map([6,tag(1,0)]),false,'§5 registered claims MUST NOT be tagged'),e('claims',map([3,['a','b']]),true,'§3.1.3 audience array allowed despite §4 table summary'),e('claims',map([7,'id']),false,'cti bytes'),e('claims',map([1,1]),false,'issuer text')];
for(const x of cwtExamples) {
  const isClaims=x.source.section.startsWith('A.1.');
  const isKey=x.source.section.startsWith('A.2.');
  cwtCases.push({rule:isClaims?'claims':isKey?'COSE_Key':'cwt-envelope',hex:x.hex,expect:true,note:x.source.section,source:x.source,...(isKey?{dependsOn:['P8.4']}: {})});
}
allSuites.set(8392,[{name:'RFC 8392 derived claims and Appendix A',id:'claims',cddl:cwt+'\ncwt-envelope = COSE_Messages / #6.61(COSE_Messages)\n'+cose,
  source:{rfc:8392,section:'§§3–5; Appendix A',sha256:source.get(8392).sha256},origin:'DERIVED: RFC 8392 contains no CDDL. Claims typing follows prose §3.1; assembled RFC 9052 envelope definitions added.',cases:cwtCases}]);
write(new URL('rfc8392-hex-examples.json',destination),{format:'printed RFC 8392 Appendix A hex (synthetic published test keys; not credentials)',examples:cwtExamples});

// Normative prelude: exercise every name, including tag types and float value
// semantics; widths are representable value sets, not input serialization widths.
const preludeValues={any:0,uint:0,nint:-1,int:0,bstr:bytes(''),bytes:bytes(''),tstr:'',text:'',
  tdate:tag(0,'2013-03-21T20:04:00Z'),time:tag(1,0),number:0,biguint:tag(2,bytes('010000000000000000')),
  bignint:tag(3,bytes('010000000000000000')),bigint:tag(2,bytes('010000000000000000')),integer:0,unsigned:0,
  decfrac:tag(4,[-2,27315]),bigfloat:tag(5,[-1,3]),eb64url:tag(21,0),eb64legacy:tag(22,0),eb16:tag(23,0),
  'encoded-cbor':tag(24,bytes('00')),uri:tag(32,'https://example.com'),b64url:tag(33,''),b64legacy:tag(34,''),regexp:tag(35,''),
  'mime-message':tag(36,''),'cbor-any':tag(55799,0),float16:raw('f93e00'),float32:raw('f93e00'),float64:raw('f93e00'),
  'float16-32':raw('f93e00'),'float32-64':raw('f93e00'),float:raw('f93e00'),false:false,true:true,bool:true,nil:null,null:null,undefined:undefined};
for(const id of ['prelude','json-prelude']) {
  const suite=byId(8610,id);
  for(const name of suite.cddl.matchAll(/^([\w-]+)\s*=/gm)) {
    const rule=name[1],value=preludeValues[rule];
    suite.cases.push(e(rule,value,true,`Appendix ${id==='prelude'?'D':'E'} definition of ${rule}`));
    if(rule!=='any')suite.cases.push(e(rule,[],false,'array is outside this scalar/tag prelude type'));
  }
}
const hBlock=source.get(8610).text.split('   The CDDL tool described in Appendix F generates as one example:')[1].split('\nAcknowledgements')[0];
const hJson=hBlock.slice(hBlock.indexOf('{'),hBlock.lastIndexOf('}')+1);
const hValue=JSON.parse(hJson);
for(const id of ['reputon-verbose','reputon-compact'])byId(8610,id).cases.push(e('reputation-object',hValue,false,'Appendix H printed generated JSON example: ratings are not binary16 representable; preserve decimal values without rounding'));
for(const test of byId(8610,'reputon-verbose').cases)test.dependsOn=['D270'];
// Additional semantic witnesses from normative prose/grammar, labelled derived.
allSuites.get(8610).push(
  {name:'RFC 8610 Appendix A greedy star',id:'peg-star',cddl:'r = [* uint, uint]\n',source:{rfc:8610,section:'Appendix A'},origin:'derived instantiation of *a a',cases:[e('r',[1],false,'greedy star consumes final uint',['D270']),e('r',[],false,'required final uint absent',['D270'])]},
  {name:'RFC 8610 Appendix A optional and bounded occurrence',id:'peg-optional',cddl:'r = [? uint, 2*3 uint, tstr]\n',source:{rfc:8610,section:'Appendix A / §3.2'},origin:'derived',cases:[e('r',[1,2,'x'],false,'optional consumes first uint; minimum two remain',['D270']),e('r',[1,2,3,'x'],true,'greedy optional plus two uints',['D270'])]},
  {name:'RFC 8610 Appendix A prioritised group choice',id:'peg-choice',cddl:'r = [(uint // uint, uint), tstr]\n',source:{rfc:8610,section:'Appendix A'},origin:'derived',cases:[e('r',[1,'x'],true,'first choice then text',['D270']),e('r',[1,2,'x'],false,'first successful choice locks one uint',['D270'])]},
  {name:'RFC 8610 literal cut scope (D301 default)',id:'cut-scope',cddl:'r = {kind: "a", x: uint // kind: "b", y: tstr}\n',source:{rfc:8610,section:'§3.5.4 / Appendix A'},origin:'derived; literal RFC expectation, the default cut semantics under D301',cases:[e('r',{kind:'a',x:1},true,'first branch matches'),e('r',{kind:'b',y:'z'},false,'failed cut disables enclosing choice in literal RFC reading',['D301'])]},
  {name:'RFC 8610 byte representation invariance',id:'wire-invariance',cddl:'r = {a: 1}\ns = float16\n',source:{rfc:8610,section:'§§2.2.3, 3.2, 3.8.1'},origin:'derived',cases:[{rule:'r',hex:'bf61611801ff',expect:true,note:'indefinite map and nonpreferred integer still same value',dependsOn:['P8.4']},{rule:'s',hex:'fa3fc00000',expect:true,note:'1.5 representable as half even when serialized single',dependsOn:['P8.4']}]},
);
allSuites.get(9682).push({name:'RFC 9682 simple head numbers',id:'simple-heads',cddl:'r = #7.<32..255>\ns = #7.24\n',source:{rfc:9682,section:'§3.2'},origin:'derived from updated grammar',cases:[{rule:'r',hex:'f820',expect:true,note:'simple value32',dependsOn:['P8.4']},{rule:'r',hex:'f4',expect:false,note:'false is value20'},{rule:'s',hex:'f8ff',expect:true,note:'AI24 admits simple values32..255',dependsOn:['P8.4']}]});

// P9.2: every expectation snug does not meet carries its classification (the runner counts
// a failing classified check as explained, an unclassified one as unexplained).
for(const test of byId(8610,'default-timer').cases)if(test.expect===false)test.classification={kind:'contested',decision:'S46',
  reason:'RFC 8610 §3.8.6 gives .default an "implied .ne control"; snug treats .default as an annotation only, as Erratum 9229 (status Reported) proposes and the Ruby reference does (docs/conformance.md S46).'};
for(const id of ['figure-3','figure-4','figure-5'])for(const test of byId(9165,id).cases)test.classification={kind:'pending',decision:'P9.14',
  reason:'.abnf/.abnfb (RFC 9165 §3) come with the optional, metered ABNF module, checklist item P9.14; until then the schema is refused with unsupported_control.'};
for(const test of byId(9682,'simple-heads').cases)test.classification={kind:'pending',decision:'P9.3',
  reason:'RFC 9682 §3.2 head numbers (#7.<type>, #7.24) are checklist item P9.3; until then the schema is refused with a syntax error.'};

// An auditable census of every displayed rule-like line, including all ABNF
// figures that must not be misrepresented as CDDL schemas.
const inventory=[];
for(const n of [8610,9165,9682,8392,9052]) {
  let section='';
  source.get(n).lines.forEach((line,i)=>{
    if(/^(?:Appendix [A-Z]\.|(?:[A-Z]|\d+)(?:\.\d+)*\.  )/.test(line))section=line;
    if(!/^\s+[A-Za-z_$@][\w.$@-]*(?:<[^>]*>)?\s*(?:\/\/=|\/=|=)(?![=>])/.test(line))return;
    const covered=(selections[n]||[]).filter(([,from,to])=>i+1>=from&&i+1<=to).map(([id])=>id);
    let exclusion;
    if(!covered.length) {
      if(n===8610&&section.startsWith('Appendix A.'))exclusion='ABNF/PEG explanatory production, not CDDL';
      else if(n===8610&&/Appendix [BC]\./.test(section))exclusion='ABNF defining CDDL syntax, not CDDL schema';
      else if(n===9682||n===9165&&line.trim().startsWith('CRLF'))exclusion='ABNF grammar (including old/proposed forms), not CDDL schema';
      else if(n===9052)exclusion='cryptographic algorithm pseudocode, not CDDL schema';
      else if(n===8610&&line.includes('parameter = argument'))exclusion='inline prose explaining generic substitution';
      else throw Error(`Unaccounted rule-like line RFC${n}:${i+1}: ${line}`);
    }
    inventory.push({rfc:n,logicalLine:i+1,section,text:line.trim(),...(covered.length?{selections:covered}:{excluded:exclusion})});
  });
}
write(new URL('extraction-inventory.json',destination),{format:'every displayed assignment-like line; CDDL selections versus explicit non-CDDL exclusions',entries:inventory});

// Figure 6 is printed hex, independent of our fixture encoder.
const printedDomino=source.get(9682).text.split('   86 ')[1].split('Figure 6:')[0].split('\n').map(l=>l.split('#')[0].replace(/\s/g,'')).filter(h=>/^[a-f0-9]+$/i.test(h)).join('');
// The split consumed the first byte; restore it.
if('86'+printedDomino!==byId(9682,'figure-5').cases[0].hex)throw Error('RFC 9682 Figure 6 hex mismatch');

try {
  const summary=[];
  for(const [n,suites] of allSuites) {
    let previous;
    if(process.argv.includes('--reuse-ruby'))try{previous=JSON.parse(readFileSync(new URL(`rfc${n}.json`,destination),'utf8'));}catch{}
    for(const suite of suites) {
      suite.compileObservation=await compilation(suite.cddl);
      let effective=suite.cddl;
      if(typeof suite.context==='string') effective=suite.context+'\n'+suite.cddl;
      else if(suite.context)effective=suite.context.cddl;
      if(suite.context)suite.contextCompileObservation=await compilation(effective);
      if(!suite.cases.length&&!suite.noCasesReason)suite.noCasesReason=suite.id==='mixed-ranges-undefined'?'RFC explicitly labels two ranges NOT DEFINED; not a valid standalone data model':suite.id==='figure-6-ellipsis'?'RFC leaves bar/baz as ellipses; no data membership defined':'no self-contained root; see context/compilation finding';
      const old=previous?.suites.find(s=>s.name===suite.name&&s.cddl===suite.cddl&&JSON.stringify(s.context)===JSON.stringify(suite.context));
      for(let i=0;i<suite.cases.length;i+=4)await Promise.all(suite.cases.slice(i,i+4).map(async test=>{
        const saved=old?.cases.find(c=>c.rule===test.rule&&c.hex===test.hex&&c.expect===test.expect&&c.note===test.note);
        const reusable=saved?.ruby?.status==='checked'||saved?.ruby?.status==='unavailable'&&saved.ruby.finding==='reference schema/runtime error'&&!saved.ruby.error;
        test.ruby=process.argv.includes('--skip-ruby') ? {status:'not-run'} : reusable?{...saved.ruby,...(saved.ruby.agrees===false?{explanation:disagreement(effective,test)}:{})}:await checkRuby(effective,test);
      }));
      console.log(`${suite.name}: raw compile ${suite.compileObservation.ok ? 'ok' : suite.compileObservation.code}, ${suite.cases.length} cases`);
    }
    write(new URL(`rfc${n}.json`,destination),{format:'snug conformance corpus v1; compileObservation is evidence, never schemaError expectation; context is labelled harness text; ruby is differential evidence',generator:'corpus/tools/export-rfc.mjs',rfc:n,suites});
    summary.push({rfc:n,suites:suites.length,cases:suites.reduce((a,s)=>a+s.cases.length,0),rawCompileFailures:suites.filter(s=>!s.compileObservation.ok).length,
      effectiveCompileFailures:suites.filter(s=>!(s.contextCompileObservation||s.compileObservation).ok).length,
      rubyDisagreements:suites.flatMap(s=>s.cases).filter(c=>c.ruby.agrees===false).length,
      rubyUnavailable:suites.flatMap(s=>s.cases).filter(c=>c.ruby.status==='unavailable').length,
      rubyNotRun:suites.flatMap(s=>s.cases).filter(c=>c.ruby.status==='not-run').length});
  }
  write(new URL('extraction-summary.json',destination),{sources:[...source].map(([rfc,s])=>({rfc,sha256:s.sha256})),summary});
  console.table(summary);
  console.log(`Wire vectors: RFC8949 Appendix A ${aVectors.length}, Appendix F ${fVectors.length}, additional ${extraVectors.length}; RFC8746 ${typed.length}; RFC8742 4 sequences. COSE EDN ${coseData.length}, CWT hex ${cwtExamples.length}.`);
} finally { rmSync(scratch,{recursive:true,force:true}); }
