// Adapted from 3sln.me tests/helpers/cbor-corpus.mjs (MIT, Copyright (c) 2026 3sln).
// Seeded generators for Bindle CBOR profile values and byte mutations (tests/cbor*.test.mjs and the cborg oracle
// fixture generator tests/vectors/generate-cborg-oracle.mjs). Uses the shared mulberry32 PRNG; never Math.random.
import {createRandom} from './random.mjs';
import {Decimal as BindleDecimal,NDArray} from '../src/values.mjs';
export {createRandom};

const INTS=[0,1,23,24,255,256,65535,65536,2**32-1,2**32,Number.MAX_SAFE_INTEGER,-1,-24,-25,-256,-257,-65536,-65537,-(2**32),-(2**32)-1,-Number.MAX_SAFE_INTEGER];
const BIGS=[2n**53n,-(2n**53n),2n**53n+1n,2n**63n,-(2n**63n),2n**64n-1n,-(2n**64n),2n**64n,-(2n**64n)-1n,2n**1024n-1n,-(2n**1024n)];
const FLOATS=[0.5,1.5,-2.25,1.1,-4.1,1e-7,5.960464477539063e-8,0.00006103515625,65503.5,1e20,-1e20,2**53,-(2**60),3.4028234663852886e+38,1e300,Number.MIN_VALUE,-Number.MAX_VALUE,100000.5];
const CHARS=['a','b','z','A','0',' ','"','\\','é','ü','中','水','😀','𐅑','\u0000','\u007f','\u0080','\u07ff','\u0800','\uffef'];
const TYPED=[Int8Array,Uint16Array,Uint32Array,BigUint64Array,Int16Array,Int32Array,BigInt64Array,Float32Array,Float64Array];

const randomBig=(r,minBytes,maxBytes)=>{const n=minBytes+r.int(maxBytes-minBytes+1);let hex=(1+r.int(255)).toString(16).padStart(2,'0');for(let i=1;i<n;i++)hex+=r.int(256).toString(16).padStart(2,'0');return BigInt('0x'+hex);};
export function randomInteger(r){
 switch(r.int(5)){
  case 0:return r.pick(INTS);
  case 1:return r.pick(BIGS);
  case 2:return (r.chance(0.5)?-1:1)*r.int(2**31);
  case 3:{const v=randomBig(r,7,8);return r.chance(0.5)?v:-v;}
  default:{const v=randomBig(r,9,40);return r.chance(0.5)?v:-1n-v;}
 }
}
export function randomFloat(r){
 switch(r.int(4)){
  case 0:return r.pick(FLOATS);
  case 1:return (r.int(2000)-1000)+(1+r.int(1023))/1024; // float16-exact non-integral values
  case 2:{let v;do v=Math.fround((r.next()-0.5)*1e6);while(Number.isInteger(v));return v;}
  default:{let v;do v=(r.next()-0.5)*10**(r.int(40)-20);while(Number.isInteger(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER||v===0);return v;}
 }
}
export function randomString(r,max=30){
 const n=r.chance(0.05)?24+r.int(300):r.int(max);let s='';for(let i=0;i<n;i++)s+=r.pick(CHARS);return s;
}
export function randomBytes(r,max=40){const n=r.chance(0.05)?256+r.int(100):r.int(max),b=new Uint8Array(n);for(let i=0;i<n;i++)b[i]=r.int(256);return b;}
export function randomTyped(r,{float16=false}={}){
 const types=float16&&typeof Float16Array==='function'?[...TYPED,Float16Array]:TYPED,C=r.pick(types),n=r.int(7),a=new C(n);
 for(let i=0;i<n;i++){
  if(C===BigUint64Array)a[i]=BigInt.asUintN(64,randomBig(r,1,8));else if(C===BigInt64Array)a[i]=BigInt.asIntN(64,randomBig(r,1,8));
  else if(/Float/.test(C.name))a[i]=r.chance(0.1)?r.pick([-0,Infinity,-Infinity,0]):randomFloat(r);
  else a[i]=Math.floor(r.next()*2**32)-2**31;
 }
 return a;
}
export function randomDecimal(r){const exponent=-1-r.int(r.chance(0.1)?1000:30);return BindleDecimal.normalize(r.chance(0.2)?randomInteger(r)===0?1n:BigInt(randomInteger(r)):BigInt((r.chance(0.5)?-1:1)*(1+r.int(1e9))),exponent);}

/** A random profile value. oracle:true restricts to the cborg-overlapping subset (no decimals, ndarrays, float16). */
export function randomValue(r,{depth=0,oracle=false,maxDepth=4}={}){
 const leafOnly=depth>=maxDepth,kind=r.int(leafOnly?8:11);
 switch(kind){
  case 0:return randomInteger(r);
  case 1:return randomFloat(r);
  case 2:return randomString(r);
  case 3:return randomBytes(r);
  case 4:return r.pick([true,false,null]);
  case 5:return randomTyped(r,{float16:!oracle});
  case 6:return oracle?randomInteger(r):randomDecimal(r);
  case 7:if(oracle)return randomString(r);{const t=randomTyped(r,{float16:true});return t.length?new NDArray([t.length],t):new NDArray([2,1],[randomInteger(r),randomString(r)]);}
  case 8:case 9:{const n=r.int(6),a=[];for(let i=0;i<n;i++)a.push(randomValue(r,{depth:depth+1,oracle,maxDepth}));return a;}
  default:return randomMap(r,{depth:depth+1,oracle,maxDepth});
 }
}
export function randomMap(r,options={}){
 const o=Object.create(null),n=r.int(6);for(let i=0;i<n;i++)o[r.chance(0.1)?'__proto__':randomString(r,8)]=randomValue(r,options);return o;
}
/** One mutation of an encoding: flip, replace, insert, delete or truncate. */
export function mutate(r,bytes){
 const b=[...bytes],i=r.int(Math.max(1,b.length));
 switch(r.int(5)){
  case 0:b[i]^=1<<r.int(8);break;
  case 1:b[i]=r.int(256);break;
  case 2:b.splice(i,0,r.int(256));break;
  case 3:b.splice(i,1);break;
  default:b.length=i;
 }
 return Uint8Array.from(b.map(x=>x??0));
}
export const toHex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
export const fromHex=h=>Uint8Array.from(h.match(/../g)??[],x=>parseInt(x,16));
