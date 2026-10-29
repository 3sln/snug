// Differential: CDDL (wasm) vs in-house JSON-Schema-subset validator on seeded random object-storage requests.
import {instantiate} from './load.mjs';
import {readFileSync} from 'node:fs';
import {encode,decode} from '/Users/raystubbs/Projects/@3sln/3sln.me/packages/core/cbor.mjs';
import {compileContractVersion} from '/Users/raystubbs/Projects/@3sln/3sln.me/packages/federation/integrations.mjs';
const w=instantiate();
const body=JSON.parse(readFileSync('/Users/raystubbs/Projects/@3sln/3sln.me/docs/artefacts/object-storage-v1.json','utf8'));
const oracle=compileContractVersion(body.body??body);
const SEED=Number(process.env.SEED??20261029),N=Number(process.env.N??20000);
let s=SEED>>>0;const rnd=()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/2**32;};
const pick=a=>a[Math.floor(rnd()*a.length)];
const variants={
 'as-written':readFileSync('contracts/object-storage-v1.cddl','utf8').replace('safe-uint = 0..9007199254740991','safe-uint = uint'),
 'patched-regexp-free':null};
const RENAME=process.env.RENAME==='1';
const text=RENAME?variants['as-written'].replace(/^key = /m,'key-t = ').replace(/^version = /m,'version-t = ').replace(/: key\b/g,': key-t').replace(/: version\b/g,': version-t').replace(/version: tstr,/,'version: tstr,'):variants['as-written'];
const h=w.compile(text);if(!h)throw new Error(w.last_error());
const ascii=n=>Array.from({length:n},()=>String.fromCharCode(97+Math.floor(rnd()*26))).join('');
const str=()=>pick([()=>'',()=>ascii(1),()=>ascii(8),()=>ascii(1024),()=>ascii(1025),()=>'é'.repeat(600),()=>'𝄞'.repeat(300)])();
const int=()=>pick([0,1,-1,300,301,2**31,2**32,2**40,2**53-1,2n**53n,2n**64n,1.5,'1'])
const bytes=()=>pick([new Uint8Array(0),new Uint8Array(16),new Uint8Array(1048576),new Uint8Array(1048577),'x'])
const any=()=>pick([null,true,1,'s',[],{},new Uint8Array(1)]);
const cond=()=>pick([{absent:true},{absent:false},{version:str()},{},{absent:true,version:'v'},any()]);
const range=()=>pick([{start:int(),end:int()},{start:0},{start:0,end:1,x:1},any()]);
const gen=()=>{
 const method=pick(['capabilities','get','put','delete','presign','nope']);
 const a={};
 const maybe=(k,f,p=0.5)=>{if(rnd()<p)a[k]=f();};
 maybe('key',str,0.9);
 if(method==='get'){maybe('ifVersion',str,0.3);maybe('range',range,0.3);}
 if(method==='put'){maybe('data',bytes,0.9);maybe('condition',cond,0.9);maybe('contentType',str,0.3);}
 if(method==='delete'){maybe('version',str,0.9);}
 if(rnd()<0.08)a[pick(['extra','data','version','range'])]=any();
 const args=method==='capabilities'?(rnd()<0.8?{}:{x:1}):a;
 const req={method,args};if(rnd()<0.03)req.extra=1;if(rnd()<0.02)delete req.args;
 return req;
};
const cp=v=>[...v].length;
const stats={total:0,agree:0,oracleThrows:0,disagree:{}};
const samples={};
for(let i=0;i<N;i++){
 const req=gen();let expect;
 try{expect=oracle.validate(structuredClone(req));}catch(e){stats.oracleThrows++;continue;}
 const bytesIn=encode(req);
 const got=JSON.parse(w.validate_cbor(h,'request',bytesIn)).ok;
 stats.total++;
 if(got===expect){stats.agree++;continue;}
 // classify the cause
 const flat=JSON.stringify(req,(k,v)=>typeof v==='bigint'?'BIG':v instanceof Uint8Array?'BYTES'+v.length:v);
 let cause='unclassified';if(/"key"/.test(flat)===false||/"version"/.test(flat)===false)cause='missing member accepted (member name == rule name)';
 const strings=[];JSON.stringify(req,(k,v)=>{if(typeof v==='string')strings.push(v);return typeof v==='bigint'?0:v instanceof Uint8Array?0:v;});
 if(strings.some(x=>/[^\x00-\x7f]/.test(x)))cause='tstr .size counts bytes vs maxLength code points';
 else if(/BIG|9007199254740992/.test(flat))cause='safe-uint workaround (wasm32 range bug)';
 stats.disagree[cause]=(stats.disagree[cause]??0)+1;samples[cause]??=flat.slice(0,300)+` expect=${expect} got=${got}`;
}
console.log(JSON.stringify({seed:SEED,...stats},null,1));
for(const [k,v] of Object.entries(samples))console.log('sample',k,'::',v);
