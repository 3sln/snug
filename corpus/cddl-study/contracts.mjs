import {instantiate} from './load.mjs';
import {readFileSync} from 'node:fs';
import {encode,BindleDecimal,NDArray} from '/Users/raystubbs/Projects/@3sln/3sln.me/packages/core/cbor.mjs';
const w=instantiate();
const src=n=>readFileSync(new URL('./contracts/'+n,import.meta.url),'utf8');
const WORKAROUND=s=>s.replace('safe-uint = 0..9007199254740991','safe-uint = uint ; WORKAROUND: wasm32 cannot parse > 2^32-1');
const jkt='a'.repeat(43),sid='b'.repeat(22);
const sets={
 'object-storage-v1.cddl':[
  ['request',{method:'put',args:{key:'k',data:new Uint8Array(10),condition:{absent:true}}},true],
  ['request',{method:'put',args:{key:'k',data:new Uint8Array(10),condition:{absent:true},extra:1}},false],
  ['request',{method:'put',args:{key:'',data:new Uint8Array(1),condition:{absent:true}}},false],
  ['request',{method:'put',args:{key:'k',data:'not-bytes',condition:{absent:true}}},false],
  ['request',{method:'get',args:{key:'k',range:{start:0,end:2**40}}},true],
  ['request',{method:'get',args:{key:'k',range:{start:0,end:2n**60n}}},false],
  ['request',{method:'presign',args:{key:'k',operation:'write',size:10,condition:{version:'v'}}},true],
  ['request',{method:'presign',args:{key:'k',operation:'write',size:10,condition:{version:'v'},range:{start:0,end:1}}},false],
  ['request',{method:'presign',args:{key:'k',operation:'read',size:10}},false],
  ['request',{method:'capabilities',args:{}},true],
  ['request',{method:'capabilities',args:{x:1}},false],
  ['presign-result',{url:'https://x.example/a',method:'PUT',expiresAt:1,revocation:'live',requiredHeaders:{a:'b'},mode:'proxy'},true],
  ['presign-result',{url:'http://x.example/a',method:'PUT',expiresAt:1,revocation:'live',requiredHeaders:{},mode:'proxy'},false],
  ['presign-result',{url:'javascript:https://x',method:'PUT',expiresAt:1,revocation:'live',requiredHeaders:{},mode:'proxy'},false],
 ],
 'item-classification-v1.cddl':[
  ['classify-args',{detail:'minimal',item:{kind:'text',mediaType:'text/plain',size:3,data:new Uint8Array(3)},labels:[{id:'spam',description:'Spam'}]},true],
  ['classify-args',{detail:'minimal',item:{kind:'text',mediaType:'text/plain',size:3,data:new Uint8Array(3)},tags:{language:'en'},labels:[{id:'spam',description:'Spam'}]},false],
  ['classify-args',{detail:'standard',item:{kind:'text',mediaType:'text/plain',size:3,data:new Uint8Array(3)},tags:{language:'en'},labels:[{id:'spam',description:'Spam'}]},true],
  ['classify-args',{detail:'standard',item:{kind:'text',mediaType:'text/plain',size:3,data:new Uint8Array(3)},tags:{source:'email'},labels:[{id:'spam',description:'Spam'}]},false],
  ['classify-args',{detail:'full',item:{kind:'image',mediaType:'image/png',size:5,url:{href:'https://x.example/i',expiresAt:9}},tags:{source:'email',context:['a.b']},labels:[{id:'spam',description:'Spam'}]},true],
  ['classify-args',{detail:'full',item:{kind:'image',mediaType:'image/png',size:5,url:{href:'https://x.example/i',expiresAt:9},data:new Uint8Array(5)},labels:[{id:'spam',description:'Spam'}]},false],
  ['classify-args',{detail:'full',item:{kind:'image',mediaType:'image/png',size:5,url:{href:'https://x.example/i',expiresAt:9}},labels:[]},false],
  ['classify-args',{detail:'full',item:{kind:'image',mediaType:'Image/PNG',size:5,url:{href:'https://x.example/i',expiresAt:9}},labels:[{id:'spam',description:'S'}]},false],
  ['classify-args',{detail:'full',item:{kind:'image',mediaType:'image/png',size:5,url:{href:'https://x.example/i',expiresAt:9}},labels:[{id:'Spam!',description:'S'}]},false],
 ],
 'event-bus-tasks.cddl':[
  ['payload',{task:'t1',title:'Hello'},true],
  ['payload',{task:'t1',owner:'x'},false],
  ['record',{type:'created',data:encode({task:'t1'})},true],
  ['record',{type:'created',data:encode({task:1})},false],
 ],
 'preferences-v2.cddl':[
  ['result',{fragment:'https://f.example/x',revision:'1',values:{a:1,b:[{id:'https://r.example/1',status:'available',contracts:[]}]}},true],
  ['result',{fragment:'https://f.example/x',revision:'1',values:{b:[{id:'https://r.example/1',status:'available',contracts:[],token:'t',token_type:'DPoP',expires_at:5}]}},true],
  ['result',{fragment:'https://f.example/x',revision:'1',values:{b:[{id:'https://r.example/1',status:'available',contracts:[],token:'t'}]}},false],
  ['result',{fragment:'https://f.example/x',revision:'1',values:{a:BindleDecimal.from('2.5')}},true],
  ['result',{fragment:'https://f.example/x',revision:'1',values:{b:[{id:'https://r.example/1',status:'gone',contracts:[]}]}},false],
 ],
 'ledger-numeric.cddl':[
  ['entry',{amount:2n**70n,price:BindleDecimal.from('9.99'),weights:new Float32Array(3),matrix:new NDArray([2,2],new Float64Array(4)),flags:5,series:{ts:new BigInt64Array(2),value:new Float64Array(2)}},true],
  ['entry',{amount:1.5,series:{ts:[1],value:[1.5]}},false],
  ['entry',{amount:1,matrix:new NDArray([4],new Float64Array(4)),series:{ts:[1],value:[1.5]}},false],
  ['entry',{amount:1,flags:8,series:{ts:[1],value:[1.5]}},false],
  ['entry',{amount:1,series:{ts:[1,2,3],value:[1.5]}},true,'unequal columns pass: not expressible'],
 ],
};
for(const [file,cases] of Object.entries(sets)){
 for(const variant of ['as-written','workaround']){
  const text=variant==='as-written'?src(file):WORKAROUND(src(file));if(variant==='workaround'&&text===src(file))continue;
  const h=w.compile(text);
  if(!h){console.log(`${file} [${variant}] COMPILE FAIL: ${w.last_error().slice(0,140)}`);continue;}
  let ok=0;const bad=[];
  for(const [i,[rule,v,exp,note]] of cases.entries()){const got=JSON.parse(w.validate_cbor(h,rule,encode(v))).ok;if(got===exp)ok++;else bad.push(`#${i} ${rule} expected ${exp} got ${got} :: ${w.debug_validate_cbor_raw(h,rule,encode(v)).slice(0,160).replace(/\n/g,' ')}`);}
  console.log(`${file} [${variant}] ${ok}/${cases.length}`);for(const b of bad)console.log('   '+b);
 }
}
// signaling (JSON)
const sh=w.compile(src('signaling-message-v1.cddl'));
if(!sh)console.log('signaling COMPILE FAIL',w.last_error());else{
 const base={bindle:'signaling-message',v:1,iss:'https://p.example',sub:'https://p.example/u',aud:'https://q.example/v',sid,leg:jkt,seq:0,iat:1};
 const cases=[[{...base,to:null,type:'cancel',body:{}},true],[{...base,to:jkt,type:'end',body:{reason:'closed'}},true],[{...base,to:jkt,type:'end',body:{reason:'nope'}},false],[{...base,to:null,type:'end',body:{reason:'closed'}},false],[{...base,seq:4096,to:null,type:'cancel',body:{}},false],[{...base,to:null,type:'cancel',body:{},extra:1},false],
  [{...base,to:null,type:'invite',body:{kind:{artefact:'a',version:'1',digest:'d'},profile:'webrtc',answer_by:5,basis:null,context:{a:1},params:{}}},true],
  [{...base,to:null,type:'invite',body:{kind:{artefact:'a',version:'1',digest:'d'},profile:'webrtc',answer_by:5,basis:{relation:'friend'},context:null,params:{}}},false]];
 let ok=0;for(const [i,[v,exp]] of cases.entries()){const r=JSON.parse(w.validate_json(sh,'message',JSON.stringify(v)));if(r.ok===exp)ok++;else console.log('   signaling #'+i,'expected',exp,'got',JSON.stringify(r));}
 console.log(`signaling-message-v1.cddl [json] ${ok}/${cases.length}`);
}
