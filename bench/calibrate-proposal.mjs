// Untimed valid-message unit projection for the proposal in VM.md.
// Copy alongside calibrate.mjs in a clean worktree; node bench/calibrate-proposal.mjs
// --out PATH. Load hooks transform source in memory only; no on-disk runtime edits.
import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const base = new URL('../', import.meta.url);
const git = (...args) => execFileSync('git', args, { cwd: base, encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Use a clean tracked HEAD worktree');
const revision = git('rev-parse', 'HEAD');
const replacements = {};
registerHooks({ load(url, ctx, next) {
  const result = next(url, ctx);
  if (!url.includes('/gen/js/snug/vm/')) return result;
  let source = String(result.source);
  const replace = (from, to) => { const n=source.split(from).length-1; assert(n>0,url+': '+from); source=source.replaceAll(from,to);replacements[url.split('/').at(-1)+':'+from]=n; };
  if (url.endsWith('/base.mjs')) {
    // c64 unchanged for typed float scans. Comparisons get their own divisor.
    replace('if (m <= 64)', 'if (m <= 8)'); replace('return c64(m);', 'return Math.ceil(m / 8);');
  }
  // UTF-8 charges in live, fast, dead and session string code. .bits is
  // distinguished by its leaf function; other c64 uses keep their prices.
  if (url.endsWith('/dead.mjs')) { replace('c64(stop - q)', 'Math.ceil((stop - q) / 8)'); replace('c64(stop - p)', 'Math.ceil((stop - p) / 8)'); }
  if (url.endsWith('/eval.mjs')) {
    replace('c64(lo)', 'Math.ceil(lo / 8)');
    replace('c64(kl)', 'Math.ceil(kl / 8)');
    replace('c64(stop - q)', 'Math.ceil((stop - q) / 8)');
    replace('export const EXT_CALL = 16;', 'export const EXT_CALL = 0;');
  }
  if (url.endsWith('/leaf.mjs')) replace('charge(s, c64(len), pos)', 'charge(s, Math.ceil(len / 12), pos)');
  if (url.endsWith('/controls.mjs')) {
    replace('export const T_ELEM = 5;', 'export const T_ELEM = 10;');
    replace('export const T_CMP = 8;', 'export const T_CMP = 6;');
    replace('export const T_PROBE = 4;', 'export const T_PROBE = 3;');
    assert.equal(source.split('if (!spend(m, C_TICKS))').length,3);
    source=source.replace('if (!spend(m, C_TICKS))','if (!spend(m, 2))');
  }
  return {...result,source};
}});
const { compile } = await import(new URL('host/js/src/compile.mjs', base));
const { encode } = await import(new URL('bench/baseline/cbor-3sln.mjs', base));
const { inputs } = await import(new URL('bench/scan-inputs.mjs', base));
const { vmValidate, vmScratchWords, vmScratchInit } = await import(new URL('gen/js/snug/vm/api.mjs', base));

const units = (schema,b,flags=0) => {
 const {program:p,pool:a,rules}=compile(schema,{limits:{budget:2147483647,entries:16777216,items:16777216,inputBytes:2147483647}});
 const r=rules.indexOf('r'),s=new Int32Array(vmScratchWords(p,r,p[16])),o=new Int32Array(600);vmScratchInit(s,p[16]);
 vmValidate(p,a,r,b,Int32Array.of(1,0,-1,-1,-1,-1,-1,2147483647,flags,122),s,o);return[o[0],o[3]];
};
const enc=v=>encode(v,{maxEntries:1<<24,maxItems:1<<24});
const records=Array.from({length:10000},(_,i)=>({id:i,kind:'note',title:'A small benchmark document',meta:{owner:'person',size:128,active:true},body:'x'.repeat(35)}));
const cases=[
 ['RPC', 'r = {* tstr => any}',inputs.find(i=>i.name.startsWith('RPC put,')).bytes],
 ['120k ints','r = {v: [* int]}',inputs.find(i=>i.name.startsWith('120,000')).bytes],
 ['nested maps','r = {docs: [* {* tstr => any}]}',inputs.find(i=>i.name.startsWith('nested')).bytes],
 ['typed arrays','r = {f32: #6.85(bstr),f64: #6.86(bstr),i16: #6.77(bstr)}',inputs.find(i=>i.name.startsWith('1 MiB typed')).bytes],
 ['10k records','r = [* {id:uint,kind:tstr,title:tstr,meta:{owner:tstr,size:uint,active:bool},body:tstr}]',enc(records)],
 ['300k ints','r = [* int]',enc(Array.from({length:300000},(_,i)=>i*3))],
 ['50k small maps','r = [* {* tstr => int}]',enc(Array.from({length:50000},(_,i)=>({a:i,b:i,c:i,d:1})))],
];
const valid = cases.map(([id,schema,b])=>{ const fast=units(schema,b),generic=units(schema,b,1);assert.deepEqual(fast,generic,id+': price model fast == generic');assert.equal(fast[0],0);return{id,bytes:b.length,units:fast[1]}; });
const result={revision,method:'Untimed in-memory load-hook unit projection; original Programs; fast/generic identity; not a timed implementation or source change',valid,replacements};
const outAt = process.argv.indexOf('--out');
if (outAt >= 0) writeFileSync(process.argv[outAt + 1], JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
