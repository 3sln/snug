import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode, decode } from '../../bench/baseline/cbor-3sln.mjs';
import { compile, check, PRELUDE } from './oracle.mjs';

const read = name => JSON.parse(readFileSync(new URL('../conformance/'+name+'.json', import.meta.url)));
const study = read('study'), adversarial = read('adversarial');
// The read-only baseline's Buffer.slice is not a fresh aligned byte array;
// normalize fixtures before decoding (its typed-array builder assumes offset 0).
const unhex = hex => Uint8Array.from(Buffer.from(hex,'hex'));
const report = { eligible: 0, agreed: 0, disagreements: [], excludedSuites: 0, excludedCases: 0 };
for (const suite of study.suites) {
  if (suite.schemaError || suite.phase === 'later') {
    report.excludedSuites++; report.excludedCases += suite.cases.length;
    continue;
  }
  const schema = compile(suite.cddl ?? readFileSync(new URL('../'+suite.cddlFile, import.meta.url), 'utf8'));
  test('study: '+suite.name, () => {
    assert.equal(schema.error, undefined, 'oracle compilation');
    for (const [i, c] of suite.cases.entries()) {
      report.eligible++;
      const value = decode(unhex(c.hex), {top:'any', ...suite.options});
      const actual = check(schema,c.rule,value);
      if (actual === c.expect) report.agreed++;
      else report.disagreements.push({ suite: suite.name, case: i, expected:c.expect, oracle:actual });
      assert.equal(actual,c.expect,`case ${i}; oracle=${actual}, study=${c.expect}`);
    }
  });
}
test('study explicit agreement report', () => {
  console.log('ORACLE vs STUDY '+JSON.stringify(report));
  assert.equal(report.eligible,197);
  assert.equal(report.agreed,report.eligible);
  assert.deepEqual(report.disagreements,[]);
});
for (const suite of adversarial.suites) {
  test('adversarial: '+suite.name, () => {
    const schema=compile(suite.cddl);
    assert.equal(schema.error,undefined,'oracle must accept even when snugSchemaError is set');
    for (const [i,c] of suite.cases.entries()) {
      assert.equal(typeof c.expect,'boolean');
      const bytes=unhex(c.hex);
      const value=decode(bytes,{top:'any',...suite.options});
      assert.deepEqual(encode(value,suite.options),bytes,'profile round trip');
      assert.equal(check(schema,c.rule,value),c.expect,`case ${i}`);
    }
  });
}

// These tests exercise interpreter mechanisms independently of frozen oracle-
// generated verdicts. They are deliberately small, hand-reasoned witnesses.
function verdict(cddl,value,expected) {
  const schema=compile(cddl); assert.equal(schema.error,undefined,cddl);
  const decoded=decode(encode(value),{top:'any'});
  assert.equal(check(schema,'r',decoded),expected,cddl);
}
test('nullable array repetition reaches fixed point without losing minimum',()=>{
  verdict('r = [100*100 (? uint)]',[],true);
  verdict('r = [2*2 (? uint)]',[1,2],true);
  verdict('r = [2*2 (? uint)]',[1,2,3],false);
});
test('literal integer after spaced star is not an occurrence bound',()=>{
  verdict('r = [* 3]',[],true);
  verdict('r = [* 3]',[3,3],true);
  verdict('r = [* 3]',[2],false);
  verdict('r = [1* 3]',[],false);
  verdict('r = [*2 3]',[3,3,3],false);
});
test('literal numeric colon implies a cut for an arbitrarily complex value',()=>{
  // Uses a text literal key to keep these values inside the default profile.
  verdict('r = { ? "a": (int / tstr), * tstr => any }',{a:false},false);
  verdict('r = { ? "a" => (int / tstr), * tstr => any }',{a:false},true);
});
test('encoded width, tag digits, and ranges do not round to host precision',()=>{
  verdict('r = #6.2(bstr)',1n<<64n,true);
  verdict('r = #6.20(any)',1n<<64n,false);
  verdict('r = #6.0(any)',1n<<64n,false);
  verdict('r = #6.20000000000000000000(any)',1n<<64n,false);
  verdict('r = 9007199254740993',9007199254740992n,false);
  verdict('r = 9007199254740993',9007199254740993n,true);
  verdict('r = 18446744073709551615...18446744073709551617',1n<<64n,true);
});
test('cut scopes: a later alternative and earlier wildcard can still succeed',()=>{
  verdict('r = {kind: "a", x: int // kind: "b", y: tstr}',{kind:'b',y:'s'},true);
  verdict('r = { * tstr => any, ? a: int }',{a:'bad'},true);
  verdict('r = { ? a: int, * tstr => any }',{a:'bad'},false);
});
test('map assignment exhaustively revisits early wildcard choices',()=>{
  verdict('r = { tstr => int, "a" => int }',{a:1,b:2},true);
  verdict('r = { "a" => int, tstr => int }',{a:1,b:2},true);
  verdict('r = { 2*2 tstr => int, "a" => int }',{a:1,b:2},false);
});
test('regexp metacharacters, code points, and quantified nullable alternatives',()=>{
  verdict('r = tstr .regexp "^a$"','^a$',true);
  verdict('r = tstr .regexp "^a$"','a',false);
  verdict('r = tstr .regexp "(a|){2,3}"','',true);
  verdict('r = tstr .regexp "(a|){2,3}"','aaa',true);
  verdict('r = tstr .regexp "(a|){2,3}"','aaaa',false);
  verdict('r = tstr .regexp "."','😀',true);
  verdict('r = tstr .regexp "."','\n',false);
  verdict('r = tstr .regexp "[a-c-]+"','a-c',true);
});
test('regexps refuse non-I-Regexp syntax and malformed counts at compile time',()=>{
  for (const pattern of ['\\d+','\\w+','\\s+','\\x41','\\p{L}','a{3,2}','a*?','(?=x)','(?:x)','(a)\\1','[z-a]','[]','[a-z-[b]]']) {
    const schema=compile('r = tstr .regexp '+JSON.stringify(pattern));
    assert.equal(typeof schema.error,'string','must refuse '+pattern);
  }
  assert.equal(typeof compile('p = "\\\\d+"\nr = tstr .regexp p').error,'string');
  assert.equal(typeof compile('rx<P> = tstr .regexp P\nr = rx<"\\\\d+">').error,'string');
  verdict('rx<P> = tstr .regexp P\nr = rx<"[a-z]+">','abc',true);
});
test('malformed CDDL is a compile error with no crash',()=>{
  for(const text of ['r = {','r = missing','r = h\'0\'','r = [3*2 uint]','r = #8','r = tstr .pcre "x"','r = g<int>\ng<X,Y> = [X,Y]']) assert.equal(typeof compile(text).error,'string',text);
});
test('hard step budget gives unknown for both success and failure searches',()=>{
  const schema=compile('r = [* (uint / tstr), uint]');
  assert.equal(check(schema,'r',[1,2,3],{steps:0}),'unknown');
  assert.equal(check(schema,'r',[1,2,3],{steps:10000}),true);
  assert.equal(check(schema,'r',[1,2,'x'],{steps:10000}),false);
  const recursive=compile('r = r');
  assert.equal(check(recursive,'r',0,{steps:20}),'unknown');
  const regex=compile('r = tstr .regexp "(a|aa)*b"');
  assert.equal(check(regex,'r','a'.repeat(200),{steps:200}),'unknown');
  const maps=compile('r = {0*4 (tstr => uint // tstr => int)}');
  assert.equal(check(maps,'r',{a:1,b:2,c:3},{steps:100}),'unknown');
});
test('compile and check cannot silently use a missing or generic root rule',()=>{
  const schema=compile('g<T> = [T]\nr = g<uint>');
  assert.equal(check(schema,'missing',[]),'unknown');
  assert.equal(check(schema,'g',[]),'unknown');
  assert.equal(check({error:'bad'},'r',0),'unknown');
});
test('every Appendix D name has an adversarial suite',()=>{
  for(const match of PRELUDE.matchAll(/^([\w-]+) =/gm)) assert.ok(adversarial.suites.some(s=>s.name==='Appendix D: '+match[1]),match[1]);
  const generated=adversarial.suites.filter(s=>s.category==='generated');
  assert.equal(generated.reduce((n,s)=>n+s.cases.length,0),400);
  assert.ok(new Set(generated.map(s=>s.cddl)).size>60);
});
