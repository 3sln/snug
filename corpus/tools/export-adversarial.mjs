/** Rebuild deterministic adversarial vectors. Expectations are computed by the
 * independent oracle, then checked against a separate hand-reasoned assertion
 * for every non-random case. No implementation under test is imported.
 * Run: node corpus/tools/export-adversarial.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { encode, decode, BindleDecimal, NDArray } from '../../bench/baseline/cbor-3sln.mjs';
import { compile, check, PRELUDE } from './oracle.mjs';
const format = JSON.parse(readFileSync(new URL('../conformance/study.json', import.meta.url))).format;
const out = { format, source: 'Independent RFC 8610 / RFC 9682 oracle; reviews C1-C22 and A1-A14; deterministic seed 0x5eed8610', notes: [
  'snugSchemaError marks an architecture revision 2 refusal, not an RFC parse error. Such suites still have oracle verdicts.',
  'All hex values decode under the strict baseline profile. Scalar -0, infinities and NaN have no profile value; -0 is exercised inside typed arrays.',
  'Prelude types whose only inhabitants use forbidden tags/simple values cannot have profile-valid accept cases; their suites explicitly document this.',
  'Non-random cases are checked against hand-reasoned verdicts in export-adversarial.mjs. Random expectations come only from the oracle; no snug output is used.'
], suites: [] };
const B = (...xs) => Uint8Array.from(xs);
const U64 = 1n << 64n;
const dec = new BindleDecimal(15n, -1);
const V = (value, expect, note) => ({ value, expect, note });
function suite(category, name, cddl, vectors, extra = {}) {
  const schema = compile(cddl); if (schema.error) throw Error(name + ': ' + schema.error);
  const cases = vectors.map(({ value, expect, note, rule = 'r' }) => {
    const bytes = encode(value, extra.options), decoded = decode(bytes, { top: 'any', ...extra.options });
    const actual = check(schema, rule, decoded);
    if (actual === 'unknown') throw Error(name + ': oracle budget');
    if (expect !== undefined && actual !== expect) throw Error(name + ': reasoned ' + expect + ', oracle ' + actual + (note ? ' (' + note + ')' : ''));
    return { rule, hex: Buffer.from(bytes).toString('hex'), expect: actual, ...(note ? { note } : {}) };
  });
  out.suites.push({ category, name, cddl, ...extra, cases });
}
const review = (name, cddl, vs, extra) => suite('reviews', name, cddl, vs, extra);
review('C1: attainable group counts are {2,4}', 'r = { 1*2 (2*2 tstr => uint) }', [V({},false),V({a:0},false),V({a:0,b:0},true),V({a:0,b:0,c:0},false),V({a:0,b:0,c:0,d:0},true)], { snugSchemaError: 'map_group_occurrence: variable repetition of non-absorbing key typesets' });
review('C1/A2: coupled text/integer counts', 'r = { 1*2 (tstr => uint, uint => uint) }', [V(new Map([['a',0],[1,0]]),true),V(new Map([['a',0],['b',0],[1,0]]),false),V(new Map([['a',0],['b',0],[1,0],[2,0]]),true)], { options: { cose: true }, snugSchemaError: 'map_group_occurrence: coupled variable repetition' });
review('C2: nullable literal copies', 'r = { 2*2 (? a: uint, ? b: uint) }', [V({},true),V({a:1},true),V({a:1,b:2},true),V({a:1,c:2},false)]);
review('A2: nullable single literal copies', 'r = { 2*2 (? a: int) }', [V({},true),V({a:1},true),V({a:'x'},false)]);
review('A2: distinct alternatives in repeated group', 'r = { + (email: tstr // phone: tstr) }', [V({},false),V({email:'e'},true),V({phone:'p'},true),V({email:'e',phone:'p'},true),V({email:0,phone:'p'},false)]);
review('A2: attainable group counts are {0,2,4}', 'r = { 0*2 (2*2 tstr => int) }', Array.from({length:6},(_,n)=>V(Object.fromEntries(Array.from({length:n},(_,i)=>['k'+i,i])),[0,2,4].includes(n))), { snugSchemaError: 'map_group_occurrence: count set {0,2,4} is not an interval' });
review('C3: non-cut literal fall-through', 'r = { ? "a" => uint, * tstr => tstr }', [V({a:'x'},true),V({a:1},true),V({a:false},false),V({b:'x'},true)]);
review('C3/A1: absent optional factor forwards to residual', 'r = { ? (a: int, b: int), * tstr => any }', [V({a:1},true),V({b:2},true),V({a:1,b:2},true),V({a:1,c:'x'},true),V({},true)]);
review('A1: choices correlate optional factor with residual', 'r = { ? (a: int, b: int), ((* tstr => int) // (* tstr => tstr)) }', [V({a:1,c:'x'},false),V({a:1,b:2,c:'x'},true),V({a:1,c:2},true),V({a:'x',c:'x'},true),V({a:'x',c:1},false)]);
review('A1c: top-level group choices stay closed', 'r = { a: int, * tstr => int // b: tstr, * tstr => tstr }', [V({a:1},true),V({b:'x'},true),V({a:1,b:'x'},false),V({a:'x',b:'x'},true),V({},false)]);
review('C4: typeset cuts commit a matched key', 'r = { * tstr ^ => uint, * tstr => any }', [V({a:'x'},false),V({a:1},true),V({},true)], { snugSchemaError: 'map_cut: cuts on key typesets refused' });
review('C5: value-disjoint existential assignment', 'r = { tstr => 0, tstr => 1 }', [V({a:0,b:1},true),V({a:1,b:0},true),V({a:0,b:0},false),V({a:1},false)], { snugSchemaError: 'map_overlap: overlapping constrained key domains' });
review('A6b: wildcard before cut may consume pair', 'r = { * tstr => any, ? "a": int }', [V({a:'x'},true),V({a:1},true),V({},true)], { snugSchemaError: 'map_cut: literal cut after overlapping wildcard' });
review('D021: cut is alternative local', 'r = { kind: "a", x: int // kind: "b", y: tstr }', [V({kind:'b',y:'s'},true),V({kind:'a',x:1},true),V({kind:'b',x:1},false),V({kind:'c',x:1},false)]);
review('D021: explicit and implied cuts block fall-through', 'r = { ? "a" ^ => int, * tstr => any }', [V({a:'x'},false),V({a:1},true),V({b:'x'},true)]);
review('D021: colon optional cut blocks fall-through', 'r = { ? a: int, * tstr => any }', [V({a:'x'},false),V({a:1},true),V({b:'x'},true)]);
review('C6: incoming optional prefix gives multiple counts', 'r = [? uint, 2*3 uint, tstr]', Array.from({length:6},(_,n)=>V([...Array(n).fill(1),'x'],n>=2&&n<=4)));
review('A3: paired prefix gives multiple counts', 'r = [* (int, int), 3*3 uint]', Array.from({length:9},(_,n)=>V(Array(n).fill(1),n>=3&&n%2===1)));
review('C7: AND operands are not root alternatives', 'r = ([uint] .and [tstr]) / [bool]', [V([1],false),V(['x'],false),V([true],true),V([],false)]);
review('C7: empty intersection of child predicates', 'r = [* uint] .within [* tstr]', [V([],true),V([1],false),V(['x'],false)]);
review('C7/A4: embedded failure stays local', 'r = bstr .cbor {a: int} / bstr .size (0..16)', [V(B(255),true),V(encode({a:1}),true),V(encode({a:'x'}),true),V(B(...Array(17).fill(255)),false)]);
review('C7: plain bytes survive failed embedded branch', 'r = bstr / (bstr .cbor uint)', [V(B(255),true),V(B(1),true),V('x',false)]);
review('A4: tag content failure stays local', 'r = #6.2(bstr .size 9) / integer', [V(U64,true),V(1n<<80n,true),V(-U64-1n,true),V(dec,false)]);
review('C8: equality preserves target constraints', 'r = (tstr .size 1) .eq "aa"', [V('aa',false),V('a',false),V(0,false)]);
review('C8: inequality preserves target constraints', 'r = (tstr .size 1) .ne "x"', [V('aa',false),V(0,false),V('x',false),V('y',true)]);
review('C8: numeric exclusion splits a range', 'r = (0..10) .ne 5', [-1,0,4,5,6,10,11].map(n=>V(n,n>=0&&n<=10&&n!==5)));
review('C14: same-point failures do not create success', 'r = (uint .lt 3) / 9', [V(2,true),V(3,false),V(5,false),V(9,true)]);
review('C14: missing member alternatives', 'r = {a:uint,b:uint}', [V({},false),V({a:1},false),V({b:1},false),V({a:1,b:1},true)]);
review('A11: socket alternatives with duplicate literals', '$$ext //= (a: int)\n$$ext //= (b: int)\nr = {a: int, $$ext}', [V({a:1},false),V({a:1,b:2},true),V({b:2},false)]);
// Remaining review counterexamples concern profile refusal precedence, scanner
// counters, memory, witness ordering and code generation. They are not decoded-
// value CDDL verdicts; the profile corpus already owns wire refusal vectors.
review('C15: empty typed content is still a tag predicate', 'r = #6.69(bstr .size 0)', [V(new Uint16Array(),true),V(new Uint16Array([1]),false),V(B(),false)], { options: {maxItems:1} });

suite('crate-defects','member name equals type rule', 'key = tstr .size (1..3)\nr = {key: key}', [V({key:'abc'},true),V({key:'abcd'},false),V({abc:'abc'},false)]);
suite('crate-defects','closed map under group choices', 'r = {a: int // b: tstr}', [V({a:1},true),V({b:'s'},true),V({a:1,b:'s'},false),V({a:1,extra:0},false)]);
suite('crate-defects','optional group is all or none', 'r = {id:tstr, ? (token:tstr, token_type:"DPoP", expires_at:uint)}', [V({id:'x'},true),V({id:'x',token:'t'},false),V({id:'x',token_type:'DPoP',expires_at:1},false),V({id:'x',token:'t',token_type:'DPoP',expires_at:1},true)]);
suite('crate-defects','regexp whole-string anchoring', 'r = tstr .regexp "[a-z]+"', [V('abc',true),V('!abc',false),V('abc!',false),V('abc\n',false)]);
suite('crate-defects','CDDL escapes become regexp code points', 'r = tstr .regexp "[^\\u0000-\\u001f]{1,4}"', [V('é',true),V('abcd',true),V('abcde',false),V('\u0000',false)]);
suite('crate-defects','wasm32 integer boundaries', 'r = 4294967296..18446744073709551615', [0n,(1n<<32n)-1n,1n<<32n,1n<<53n,U64-1n,U64].map(n=>V(n,n>=1n<<32n&&n<U64)));
suite('crate-defects','bignum ranges stay exact', 'r = 18446744073709551616..340282366920938463463374607431768211455', [U64-1n,U64,U64+1n,(1n<<128n)-1n,1n<<128n,-U64].map(n=>V(n,n>=U64&&n<1n<<128n)));
suite('crate-defects','bytes literal used as method value', 'r = {method: h\'00\'}', [V({method:B(0)},true),V({method:'\u0000'},false),V({method:0},false),V({method:B(1)},false)]);

suite('rfc-examples','RFC 8610 introduction person', 'person = {name: tstr, age: uint, ? employer: tstr}\nr = person', [V({name:'Jane',age:42},true),V({name:'Jane',age:42,employer:'Acme'},true),V({name:'Jane',age:-1},false),V({name:'Jane',age:42,extra:true},false)], { note:'RFC 8610 §1 person structure; profile-valid text keys.' });
suite('rfc-examples','RFC 8610 §3 group and array labels', 'identity = (name: tstr, age: uint)\nr = [identity, ? bool]', [V(['Jane',42],true),V(['Jane',42,true],true),V(['Jane'],false),V([42,'Jane'],false)]);
suite('rfc-examples','RFC 8610 §3.10 generic list', 'list<t> = [* t]\nr = list<uint>', [V([],true),V([0,1,2],true),V([0,'x'],false)]);
suite('rfc-examples','RFC 8610 §3.4 group enumeration', 'color = (red: 1, green: 2, blue: 3)\nr = &color', [V(1,true),V(2,true),V(3,true),V('red',false),V(0,false)]);
suite('rfc-examples','RFC 8610 §3.7 unwrap', 'header = [a: uint, b: tstr]\nr = [~header, * bstr]', [V([1,'x'],true),V([1,'x',B(0)],true),V([1],false)]);
suite('rfc-examples','RFC 8610 §3.8.4 embedded CBOR', 'r = bstr .cbor [uint, tstr]', [V(encode([1,'x']),true),V(encode([1,2]),false),V(B(1,2),false),V(B(),false)]);
suite('rfc-examples','RFC 8610 §3.8.4 CBOR sequence', 'r = bstr .cborseq [* uint]', [V(B(),true),V(B(0,1,2),true),V(B(0,97,120),false),V(B(255),false)]);
suite('rfc-examples','RFC 8610 Appendix D prelude composition', 'r = {who: text, payload: bytes, amount: integer, factor: number}', [V({who:'a',payload:B(0),amount:U64,factor:1.5},true),V({who:'a',payload:'x',amount:1,factor:1.5},false),V({who:'a',payload:B(),amount:1,factor:dec},false)]);
suite('grammar','RFC 9682 variable tag number', 'tagnum = 69..70\nr = #6.<tagnum>(bstr)', [V(new Uint16Array([1]),true),V(new Uint32Array([1]),true),V(new Int32Array([1]),false),V(69,false)]);
suite('grammar','RFC 9682 variable tag number choice', 'r = #6.<2 / 3>(bstr .size 9)', [V(U64,true),V(-U64-1n,true),V(1n<<80n,false),V(1,false)]);
suite('grammar','bare major types', 'r = [#0,#1,#2,#3,#4,#5,#6,#7]', [V([1,-1,B(),'x',[],{},dec,true],true),V([1,1,B(),'x',[],{},dec,true],false)]);
suite('grammar','hex binary and huge integer literals', 'r = 0xff / 0b1010 / -0x10 / 1844674407370955161600000000001', [V(255,true),V(10,true),V(-16,true),V(1844674407370955161600000000001n,true),V(16,false)]);
suite('grammar','three byte literal spellings', 'r = h\'6162\' / b64\'Y2Q=\' / \'ef\'', [V(B(97,98),true),V(B(99,100),true),V(B(101,102),true),V('ab',false),V(B(97),false)]);
suite('grammar','float literal scientific notation', 'r = 1.5 / 1e-3', [V(1.5,true),V(0.001,true),V(1,false),V(0.002,false)]);
suite('grammar','hex float literals round once to binary64', 'r = 0x1.8p0 / 0x1p-1074 / 0x3p-1075', [V(1.5,true),V(Number.MIN_VALUE,true),V(2*Number.MIN_VALUE,true),V(3*Number.MIN_VALUE,false),V(1,false)]);
suite('grammar','unqualified bytes with escaped quote and newline', 'r = \'it\\\'s\\n\'', [V(utf8Bytes("it's\n"),true),V(utf8Bytes("it's"),false),V("it's\n",false)]);
function utf8Bytes(text) { return new TextEncoder().encode(text); }
suite('grammar','star followed by a spaced numeric literal', 'r = [* 3]', [V([],true),V([3,3],true),V([2],false),V([3,2],false)]);
suite('grammar','type socket and forward references', '$x /= small\n$x /= tstr\nsmall = 0..2\nr = [* $x]', [V([0,2,'x'],true),V([3],false),V([],true)]);
suite('grammar','undefined sockets', 'r = {a:int, $$nothing}\ns = $nothing', [{...V({a:1},false,'RFC 8610 §3.9: an unplugged $$ socket is an empty group choice, so the map has no derivation (D251; was wrongly true)'),rule:'r'},{...V({a:1,b:2},false),rule:'r'},{...V(1,false),rule:'s'}]);
suite('grammar','generic group and nested arguments', 'pair<A,B> = (A,B)\nlist<T> = [* T]\nr = [pair<uint,list<tstr>>]', [V([1,['x','y']],true),V([1,[2]],false),V([1],false)]);
suite('grammar','regular recursive array group', 'g = (int, ? g)\nr = [g]', [V([],false),V([1],true),V([1,2,3],true),V([1,'x'],false)]);
suite('grammar','recursive map', 'node = {v: int, ? children: [* node]}\nr = node', [V({v:1,children:[{v:2}]},true),V({v:1,children:[{v:'x'}]},false)]);
suite('grammar','enum nested groups', 'g = (first: 1, (second: 2 // third: 3))\nr = &g', [V(1,true),V(2,true),V(3,true),V(4,false)]);
suite('grammar','map unwrap', 'base = {a: int}\nr = {~base,b:bool}', [V({a:1,b:true},true),V({a:1},false),V({a:1,b:1},false)]);
suite('grammar','unwrap distributes a type choice', 'base = [uint] / [tstr,bool]\nr = [~base, null]', [V([1,null],true),V(['x',true,null],true),V(['x',null],false)]);
suite('grammar','type and group extensions', 't = int\nt /= tstr\ng = (a:int)\ng //= (b:tstr)\nr = {g, ? x:t}', [V({a:1,x:'x'},true),V({b:'s',x:2},true),V({a:1,b:'s'},false)]);

// Exactly the names in the embedded Appendix D, with profile inhabitance noted.
const f16 = 1.5, f32 = Math.fround(1.1), f64 = 1.1;
const D328_32 = 'D328: 1.5 is a binary32 value whatever width encodes it', D328_64 = 'D328: every float is a binary64 value';
const preludeVectors = {
 any:[V(null,true),V([dec],true)], uint:[V(U64-1n,true),V(U64,false),V(-1,false)], nint:[V(-U64,true),V(-U64-1n,false),V(0,false)],
 int:[V(-U64,true),V(U64,false)], bstr:[V(B(1),true),V('x',false)], bytes:[V(B(),true),V('',false)], tstr:[V('x',true),V(B(1),false)], text:[V('',true),V(B(),false)],
 number:[V(1,true),V(f16,true),V(U64,false),V(dec,false)], biguint:[V(U64,true),V(U64-1n,false),V(-U64-1n,false)],
 bignint:[V(-U64-1n,true),V(-U64,false),V(U64,false)], bigint:[V(U64,true),V(-U64-1n,true),V(1,false)],
 integer:[V(U64,true),V(-U64-1n,true),V(1,true),V(f16,false)], unsigned:[V(U64,true),V(U64-1n,true),V(-1,false)], decfrac:[V(dec,true),V(new BindleDecimal(U64+1n,-3),true),V(f16,false)],
 float16:[V(f16,true),V(f32,false),V(f64,false),V(1,false)], float32:[V(f32,true),V(f16,true,D328_32),V(f64,false)], float64:[V(f64,true),V(f16,true,D328_64),V(f32,true,D328_64)],
 'float16-32':[V(f16,true),V(f32,true),V(f64,false)], 'float32-64':[V(f32,true),V(f64,true),V(f16,true,D328_32)], float:[V(f16,true),V(f32,true),V(f64,true),V(1,false)],
 false:[V(false,true),V(true,false)], true:[V(true,true),V(false,false)], bool:[V(true,true),V(false,true),V(0,false)], nil:[V(null,true),V(false,false)], null:[V(null,true),V(false,false)]
};
const impossible = new Set(['tdate','time','bigfloat','eb64url','eb64legacy','eb16','encoded-cbor','uri','b64url','b64legacy','regexp','mime-message','cbor-any','undefined']);
for (const name of PRELUDE.matchAll(/^([\w-]+) =/gm)) {
  const n=name[1];
  suite('prelude','Appendix D: '+n,'r = '+n,preludeVectors[n] ?? [V(null,false),V('x',false),V(dec,false)], impossible.has(n) ? {note:'No profile-valid accepting value: the Appendix D tag/simple value is forbidden by the strict CBOR profile.'} : n==='any' ? {note:'No profile-valid refusing value exists: any accepts every profile value.'} : {});
}

for (const [size, values] of [[0,[0n,1n,255n]],[1,[0n,255n,256n]],[8,[0n,U64-1n,U64]]]) {
  suite('controls',`uint .size ${size}`,`r = uint .size ${size}`, values.map(n=>V(n,n<U64&&n<256n**BigInt(size))));
}
suite('controls','uint size interval uses minimal byte capacity', 'r = uint .size (1..2)', [0n,1n,23n,24n,255n,256n,65535n,65536n].map(n=>V(n,n>0n&&n<65536n)));
suite('controls','uint size zero interval', 'r = uint .size (0..0)', [V(0,true),V(1,false),V(-1,false)]);
suite('controls','UTF-8 text size', 'r = tstr .size 4', [V('éé',true),V('😀',true),V('é',false),V('abcd',true),V('abc',false)]);
suite('controls','byte size exact', 'r = bstr .size 2', [V(B(0,1),true),V(B(0),false),V('ab',false)]);
suite('controls','bits byte boundaries LSB first', 'flags = &(lo:0,hi:7,next:8,last:16)\nr = bstr .bits flags', [V(B(129,1,1),true),V(B(0,128),false),V(B(0,0,2),false),V(B(0,1),true),V(B(1,0),true),V(B(),true)]);
suite('controls','uint bits zero and high bits', 'r = uint .bits (0 / 8 / 63)', [V(0,true),V(257,true),V(1n<<63n,true),V(1n<<62n,false),V(U64,false)]);
for (const bound of [U64-1n,U64,-U64,-U64-1n]) for (const op of ['lt','le','gt','ge']) {
  const pred = n => op==='lt'?n<bound:op==='le'?n<=bound:op==='gt'?n>bound:n>=bound;
  suite('controls',`${op} at ${bound}`,`r = integer .${op} ${bound}`, [bound-1n,bound,bound+1n].map(n=>V(n,pred(n))));
}
suite('controls','float half subnormal inclusive range', 'r = 0.0..0.00006103515625', [V(2**-24,true),V(2**-14,true),V(2**-25,true),V(-(2**-24),false),V(0,false),V(0.5,false)]);
suite('controls','float64 minimum subnormal and exclusive bound', 'r = 0.0...1e-300', [V(Number.MIN_VALUE,true),V(1e-301,true),V(1e-300,false),V(-Number.MIN_VALUE,false)]);
suite('controls','typed arrays retain negative zero', 'r = #6.85(bstr .size 8)', [V(new Float32Array([-0,0]),true),V(new Float32Array([0]),false)], {note:'Scalar -0 is refused by the profile; only typed-array payloads carry it here.'});
suite('controls','equality on composite target', 'r = [uint] .eq [1]', [V([1],true),V([2],false),V(['1'],false)]);
suite('controls','feature and default are annotations', 'r = (uint .default 3) .feature "test-feature"', [V(0,true),V(3,true),V('3',false)]);
suite('controls','regexp hyphen first', 'r = tstr .regexp "[-a-z]{2,3}"', [V('-a',true),V('a-z',true),V('-',false),V('abcz',false),V('1a',false)]);
suite('controls','regexp hyphen last', 'r = tstr .regexp "[a-z-]{2,3}"', [V('-a',true),V('a-z',true),V('a',false),V('1a',false)]);
suite('controls','regexp code points and counted bounds', 'r = tstr .regexp "[😀-🙏]{1,2}"', [V('😀',true),V('😀🙏',true),V('😀😀😀',false),V('A',false)]);
suite('controls','regexp grouping alternation and empty branches', 'r = tstr .regexp "(ab|c){1,2}"', [V('ab',true),V('abc',true),V('cc',true),V('',false),V('ababab',false)]);
suite('controls','regexp metacharacter escapes', 'r = tstr .regexp "a\\\\.b"', [V('a.b',true),V('acb',false),V('!a.b',false)]);
suite('controls','regexp negated class and newline', 'r = tstr .regexp "[^a-c]{1,2}"', [V('é',true),V('a',false),V('z\n',true),V('zzz',false)]);
suite('controls','embedded full consumption', 'r = bstr .cbor uint', [V(B(1),true),V(B(1,2),false),V(B(),false),V(B(255),false)]);
suite('controls','embedded sequence with backtracking', 'r = bstr .cborseq [? uint,2*3 uint,tstr]', [V(B(1,2,97,120),true),V(B(1,2,3,4,97,120),true),V(B(1,97,120),false)]);
suite('controls','tag array content obligation', 'r = #6.40([[2], [uint,uint]]) / #6.40([[1], [tstr]])', [V(new NDArray([2],[1,2]),true),V(new NDArray([1],['x']),true),V(new NDArray([2],['x','y']),false),V(new NDArray([1],[1]),false)]);

// 80 seeded schemas x 5 values = 400 cases. This varies structure, occurrence
// bounds, choices and member predicates, not just a fixed schema's scalars.
let state = 0x5eed8610;
const rand = n => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % n; };
const choose = xs => xs[rand(xs.length)];
const types = ['uint','int','tstr','bool','0..2','(uint / tstr)'];
const atom = () => choose([0,1,-1,3,'x','y',false,true,null]);
for (let i = 0; i < 80; i++) {
  const a=choose(types), z=choose(types), low=rand(3), high=low+rand(3), mode=i%4;
  let cddl, values;
  if (mode===0) {
    cddl=`r = { ? (a: ${a}, b: ${z}), * tstr => ${choose(['any','int','tstr'])} }`;
    values=[{}, {a:atom()}, {a:atom(),b:atom()}, {a:atom(),c:atom()}, {b:atom(),c:atom()}];
  } else if (mode===1) {
    cddl=`r = { a: ${a}, ? b: ${z} // c: ${z}, ${low}*${high} tstr => ${choose(['uint','tstr','any'])} }`;
    values=[{a:atom()},{c:atom()},{a:atom(),b:atom()},{c:atom(),x:atom(),y:atom()},{a:atom(),c:atom()}];
  } else if (mode===2) {
    cddl=`r = [? ${a}, ${low}*${high} ${z}, ${choose(types)}]`;
    values=Array.from({length:5},()=>Array.from({length:rand(7)},atom));
  } else {
    cddl=`r = [* (${a}, ${z}), ${low}*${high} ${choose(types)}]`;
    values=Array.from({length:5},()=>Array.from({length:rand(8)},atom));
  }
  suite('generated',`seeded-${String(i).padStart(3,'0')}`,cddl,values.map(value=>({value})),{note:`xorshift32 seed 0x5eed8610, schema ${i}; expected verdicts computed only by oracle`, ...(mode===1 ? { snugSchemaError:'map_overlap: bounded wildcard overlaps literal c in the second alternative' } : {})});
}
const path = new URL('../conformance/adversarial.json', import.meta.url);
writeFileSync(path, JSON.stringify(out,null,1)+'\n');
const categories={};for(const s of out.suites)categories[s.category]=(categories[s.category]??0)+s.cases.length;
console.log(JSON.stringify({suites:out.suites.length,cases:out.suites.reduce((n,s)=>n+s.cases.length,0),categories},null,2));
