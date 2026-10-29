// Robustness: (1) strict-codec outputs, (2) raw mutated bytes straight into the wasm decoder, (3) crafted hostile bytes.
import {instantiate,reinstantiate} from './load.mjs';
import {readFileSync} from 'node:fs';
import {encode,decode,BindleDecimal,NDArray} from '/Users/raystubbs/Projects/@3sln/3sln.me/packages/core/cbor.mjs';
let w=instantiate();
const SEED=Number(process.env.SEED??7),N=Number(process.env.N??20000);
let s=SEED>>>0;const rnd=()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/2**32;};
const pick=a=>a[Math.floor(rnd()*a.length)];
const schemaTexts={
 os:readFileSync('contracts/object-storage-v1.cddl','utf8').replace('safe-uint = 0..9007199254740991','safe-uint = uint'),
 led:readFileSync('contracts/ledger-numeric.cddl','utf8'),
 anyr:'r = any\nn = node\nnode = [* node] / { * tstr => node } / int / tstr / bstr / float / bool / null / #6.2(bstr) / #6.3(bstr) / decfrac / #6.40(any) / #6.85(bstr)',
};
let H;const compileAll=()=>{H={os:w.compile(schemaTexts.os),led:w.compile(schemaTexts.led),anyr:w.compile(schemaTexts.anyr)};};compileAll();
const targets=[['os','request'],['led','entry'],['anyr','r'],['anyr','node']];
const val=(d=0)=>{const k=Math.floor(rnd()*(d>4?7:12));switch(k){
 case 0:return pick([0,1,-1,23,24,255,256,65535,2**32,2**53-1,-(2**53-1)]);case 1:return pick([2n**64n,-(2n**64n)-1n,2n**100n,2n**53n]);
 case 2:return pick([1.5,-0.25,1e300,5e-324,65504]);case 3:return pick(['','a','é','𝄞'.repeat(3),'key','method']);
 case 4:return new Uint8Array(Math.floor(rnd()*40));case 5:return pick([true,false,null]);case 6:return BindleDecimal.from(pick(['1.5','-0.001','123456789012345678901234567890.1']));
 case 7:{const n=Math.floor(rnd()*5);return Array.from({length:n},()=>val(d+1));}
 case 8:{const o={};const n=Math.floor(rnd()*5);for(let i=0;i<n;i++)o[pick(['method','args','key','data','condition','amount','series','ts','value','x','y'])]=val(d+1);return o;}
 case 9:return pick([new Float32Array(3),new Int16Array(2),new BigUint64Array(1),new Float64Array(0)]);
 case 10:return new NDArray([2,2],pick([new Float64Array(4),[1,2,3,4]]));
 default:return {method:pick(['put','get','delete']),args:val(d+1)};}};
const stats={strictCases:0,strictTraps:0,rawCases:0,rawTraps:0,rawDecodeRefused:0,trapKinds:{},crafted:{}};
const call=(name,rule,bytes,bucket)=>{try{return JSON.parse(w.validate_cbor(H[name],rule,bytes));}catch(e){stats[bucket]++;const k=(e.message||String(e)).slice(0,60);stats.trapKinds[k]=(stats.trapKinds[k]??0)+1;w=reinstantiate();compileAll();return 'trap';}};
const corpus=[];
for(let i=0;i<N;i++){const v=val();let b;try{b=encode(v);}catch{continue;}corpus.push(b);for(const [n,r] of targets){stats.strictCases++;call(n,r,b,'strictTraps');}}
for(let i=0;i<N;i++){
 const b=new Uint8Array(pick(corpus));const m=1+Math.floor(rnd()*4);
 for(let j=0;j<m;j++){const op=Math.floor(rnd()*4),p=Math.floor(rnd()*Math.max(1,b.length));if(op===0)b[p]=Math.floor(rnd()*256);else if(op===1)b[p]^=1<<Math.floor(rnd()*8);else if(op===2)b[p]=pick([0x1b,0x5b,0x7b,0x9b,0xbb,0x5f,0x9f,0xff,0xc0,0xd8,0xf7]);}
 const cut=rnd()<0.2?b.slice(0,Math.floor(rnd()*b.length)):b;
 let strictOk=true;try{decode(cut);}catch{strictOk=false;stats.rawDecodeRefused++;}
 for(const [n,r] of targets){stats.rawCases++;call(n,r,cut,'rawTraps');}
}
// crafted hostile inputs (bypassing the strict codec)
const crafted={
 'bstr length 2^32-1 (header only)':Uint8Array.from([0x5a,0xff,0xff,0xff,0xff]),
 'bstr length 2^64-1 (header only)':Uint8Array.from([0x5b,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff]),
 'array length 2^32-1 (header only)':Uint8Array.from([0x9a,0xff,0xff,0xff,0xff]),
 'map length 2^28 (header only)':Uint8Array.from([0xba,0x10,0x00,0x00,0x00]),
 'nesting 100k arrays':new Uint8Array(100000).fill(0x81),
 'nesting 100k tags':(()=>{const a=new Uint8Array(100001).fill(0xc6);a[100000]=0;return a;})(),
 'nesting 1M arrays':new Uint8Array(1000000).fill(0x81),
 'indefinite text never closed':Uint8Array.from([0x7f,0x61,0x61]),
 'undefined (f7)':Uint8Array.from([0xf7]),
 'non-shortest int':Uint8Array.from([0x18,0x01]),
 'duplicate map keys':Uint8Array.from([0xa2,0x61,0x61,0x01,0x61,0x61,0x02]),
 'tag 2 with leading zeros':Uint8Array.from([0xc2,0x43,0x00,0x00,0x01]),
};
for(const [k,b] of Object.entries(crafted)){
 let strict;try{decode(b);strict='accepted';}catch(e){strict='refused';}
 const r={};for(const [n,rule] of [['anyr','r'],['anyr','node']]){const t0=performance.now();const got=call(n,rule,b,'rawTraps');r[rule]=(got==='trap'?'TRAP':got.ok?'ok':'invalid:'+got.errors[0].reason)+` ${(performance.now()-t0).toFixed(1)}ms`;}
 stats.crafted[k]={strict,...r};
}
// sanity after all traps: known vector still validates correctly
stats.afterTrapSanity=[call('os','request',encode({method:'capabilities',args:{}}),'rawTraps').ok,call('os','request',encode({method:'capabilities',args:{x:1}}),'rawTraps').ok];
console.log(JSON.stringify(stats,null,1));
