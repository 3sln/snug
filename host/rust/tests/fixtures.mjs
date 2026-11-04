// Offline JS oracle for the Rust API integration tests. No generated files change.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(process.argv[2]);
const load = name => import(pathToFileURL(path.join(root, 'host/js/src', name)));
const { decode, encode, profiles } = await load('index.mjs');
// P7.11's Rust facade deliberately exposes the existing restricted wire policy.
// Select it explicitly: P7.1 can change the JS default concurrently.
const codecOptions = {...profiles.bindle, top:'any'};
const encodeOptions = profiles.bindle;
const { compile } = await load('public-compile.mjs');
const { fromSerialized } = await load('public-schema.mjs');
const hex = b => Buffer.from(b).toString('hex');
const unhex = h => Uint8Array.from(Buffer.from(h, 'hex'));
const utf8 = s => hex(new TextEncoder().encode(s));
if (process.argv[3] === 'load') {
  // Rust-produced containers must load and reserialize in the JS public API.
  for (const line of fs.readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)) {
    const schema = await fromSerialized(unhex(line));
    assert.equal(hex(schema.program.serialize()), line);
  }
  process.stdout.write('ok\n');
  process.exit(0);
}
const rows = [];
const emit = (...fields) => rows.push(fields.join('\t'));
const vectors = JSON.parse(fs.readFileSync(path.join(root,'corpus/cbor-vectors/cbor-profile.json')));
for (const v of [...vectors.accept, ...vectors.refuse]) {
  let code = 'ok';
  let value;
  try { value = decode(unhex(v.hex), codecOptions); }
  catch (e) { if (!e.code) throw e; code = e.code; }
  assert.equal(code, v.code ?? 'ok', v.name);
  if (code === 'ok') assert.equal(hex(encode(value, encodeOptions)), v.hex);
  emit('c',0,v.hex,code);
}
// Independent seeded value generation, then a shared Rust generator checks bytes.
let seed = 0x5a17c0de;
const rand = () => (seed = (Math.imul(seed,1664525)+1013904223) >>> 0);
function value(depth=0) {
  const kind = rand() % (depth < 3 ? 10 : 7);
  switch(kind) {
    case 0: return rand();
    case 1: return -1-rand();
    case 2: return `s${rand()}`;
    case 3: return (rand() & 1) !== 0;
    case 4: return null;
    case 5: return Uint8Array.of(rand() & 255,rand() & 255,rand() & 255);
    case 6: return (rand() % 1000) + 0.5;
    case 7: return Array.from({length:rand()%5},()=>value(depth+1));
    case 8: return { z:value(depth+1), a:value(depth+1) };
    default: return { long:value(depth+1), b:value(depth+1) };
  }
}
for(let i=0;i<512;i++) emit('g',hex(encode(value(), encodeOptions)));
// Mutated inputs also compare exact scanner codes; accepted mutations round-trip.
for(let i=0;i<1024;i++) {
  const source = unhex(vectors.accept[rand()%vectors.accept.length].hex);
  if(source.length) source[rand()%source.length] ^= 1 << (rand()%8);
  let code='ok'; try {decode(source,codecOptions);} catch(e) {if(!e.code) throw e;code=e.code;}
  emit('c',0,hex(source),code);
}
// COSE integer label support is root-only in the current profile.
for (const h of ['a20101616102','a10101','a16161a10101']) {
  let code='ok'; try {decode(unhex(h),{...codecOptions,cose:true});} catch(e) {code=e.code;}
  emit('c',1,h,code);
}
const suites=JSON.parse(fs.readFileSync(path.join(root,'corpus/conformance/study.json'))).suites;
const bounded = await compile('r = [* uint]', {profile:'bindle', limits:{inputBytes:100,depth:4,entries:8,items:16,budget:1000}});
emit('q', hex(bounded.program.serialize()));
for (const suite of suites.filter(s=>s.name.startsWith('contract:'))) {
  const cddl = fs.readFileSync(path.join(root,'corpus',suite.cddlFile),'utf8');
  const schema = await compile(cddl);
  emit('p',utf8(cddl),hex(schema.program.serialize()));
  for (const test of suite.cases) {
    const result=schema.validate(unhex(test.hex),test.rule,codecOptions);
    assert.equal(result.ok,test.expect,suite.name);
    emit('s',utf8(cddl),test.rule,test.hex,result.ok?'ok':result.reason,result.offset??0,
      utf8(JSON.stringify(result.path??[])),result.subcode??'');
  }
}
process.stdout.write(rows.join('\n')+'\n');
