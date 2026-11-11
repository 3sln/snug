/** P4.1: offline differential against native cddl 0.10.7.
 * bb crate-diff [--cases=6000] [--seed=0x5eed8610] [--timeout=2000]
 * Oracle: --oracle=/absolute/path, else $CDDL_NATIVE, else .cache/oracles/cddl-rs/bin/cddl
 * (rebuild per corpus/tools/ORACLES.md; this script never builds or installs).
 * All transient inputs and machine-readable evidence live in .cache/p41/.
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compile } from '../../host/js/src/schema.mjs';
import { encode } from '../../host/js/src/encode.mjs';
import { Decimal, NDArray } from '../../host/js/src/values.mjs';
import { decode as baselineDecode, encode as baselineEncode } from '../../bench/baseline/cbor-3sln.mjs';
import { compile as oracleCompile, check as oracleCheck } from './oracle.mjs';
import { selfWatch } from '../../kin/scripts/watchdog.mjs';
selfWatch('crate-diff', import.meta.url);   // P9.1 caps

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(x => {
  if (!/^--(?:cases|seed|timeout|oracle)=.+$/.test(x)) throw Error('Use --cases=, --seed=, --timeout=, --oracle=');
  const i = x.indexOf('='); return [x.slice(2, i), x.slice(i + 1)];
}));
const binary = args.oracle ?? process.env.CDDL_NATIVE ?? root + '.cache/oracles/cddl-rs/bin/cddl';
const count = Number(args.cases ?? 6000), seed = Number(args.seed ?? 0x5eed8610), timeout = Number(args.timeout ?? 2000);
if (![count, seed, timeout].every(Number.isSafeInteger) || count < 0 || seed <= 0 || seed > 0xffffffff || timeout < 1) throw Error('Invalid numeric argument');
const cache = root + '.cache/p41/'; mkdirSync(cache, { recursive: true });
const unhex = h => Uint8Array.from(Buffer.from(h, 'hex'));
const hex = b => Buffer.from(b).toString('hex');
const hash = x => createHash('sha256').update(x).digest('hex');
const sourceFiles = ['gen/js', 'host/js/src', 'corpus/cddl-study/contracts'].flatMap(dir => readdirSync(root+dir,{recursive:true}).filter(p=>/\.(mjs|cddl)$/.test(p)).map(p=>dir+'/'+p)).concat(['corpus/tools/oracle.mjs','corpus/conformance/study.json','corpus/conformance/adversarial.json','bench/baseline/cbor-3sln.mjs']).sort();
const fingerprint = () => hash(sourceFiles.map(p=>p+':'+hash(readFileSync(root+p))).join('\n'));
const sourceFingerprint = fingerprint();

// Mask comments and literals without changing offsets. Declarations can share
// a line; newlines alone are not rule boundaries. Move the actual definition,
// retaining its extensions in their original order and all forward references.
export function targetFirst(text, target) {
  const masked = text.replace(/;[^\r\n]*|"(?:[^"\\]|\\[\s\S])*"|(?:h|b64)?'(?:[^'\\]|\\[\s\S])*'/g, m => m.replace(/[^\r\n]/g, ' '));
  const re = /(?<![\w@$.-])([A-Za-z_@$][\w@$.-]*)(\s*<[^<>]*>)?\s*(\/\/=|\/=|=(?!>))/g;
  const rules = [...masked.matchAll(re)];
  const i = rules.findIndex(m => m[1] === target && m[3] === '=');
  if (i < 0) throw Error('Target has no definition');
  const start = rules[i].index, end = rules[i + 1]?.index ?? text.length;
  return text.slice(start, end) + '\n' + text.slice(0, start) + text.slice(end);
}

// CLI returns status ZERO even for validation failure. Require explicit success
// or failure and the requested root; never infer acceptance from exit status.
function native(text, rule, bytes) {
  writeFileSync(cache + 'input.cddl', targetFirst(text, rule));
  writeFileSync(cache + 'input.cbor', bytes);
  const p = spawnSync(binary, ['validate', '--cddl', cache + 'input.cddl', '--cbor', cache + 'input.cbor'],
    { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: { ...process.env, RUST_BACKTRACE: '0' } });
  // The rebuilt CLI (ORACLES.md) colours its log lines even into a pipe; strip SGR codes.
  const output = ((p.stdout ?? '') + (p.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, '');
  if (p.error?.code === 'ETIMEDOUT') return { kind: 'timeout' };
  if (/panicked at|stack overflow|memory allocation.*failed/.test(output) || p.status === 101 || p.signal) return { kind: 'panic', site: output.match(/(?:src\/[^\s:]+:\d+:\d+|stack overflow)/)?.[0] ?? p.signal ?? 'panic' };
  if (p.error) throw Error('Native invocation failed: ' + p.error.code);
  if (/parsing error|parser errors|error parsing|ParserError/i.test(output)) return { kind: 'schema-error' };
  if (p.status !== 0) return { kind: 'schema-error' };
  if (!output.includes('Root type for validation: ' + rule + '\n')) throw Error('Native CLI selected a different root');
  if (/\[INFO\] Validation of .* is successful/.test(output)) return { kind: 'verdict', ok: true };
  if (/\[ERROR\] Validation of .* failed:/.test(output)) return { kind: 'verdict', ok: false };
  throw Error('Unrecognised native CLI response');
}

// xorshift32 matches export-adversarial.mjs; extend its schema/value sampler
// with constructive matches and deliberate near misses, all strict-profile CBOR.
let state = seed;
const rand = n => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % n; };
const choose = xs => xs[rand(xs.length)];
const bytes = n => Uint8Array.from({ length: n }, () => rand(256));
const atom = () => choose([rand(20), -1-rand(20), 'x', 'é', false, true, null, bytes(rand(5)), 1.5]);
const scalar = () => choose([
  { t: 'uint', good: () => rand(100), bad: () => -1 },
  { t: 'int', good: () => rand(100)-50, bad: () => 'x' },
  { t: 'tstr', good: () => choose(['', 'x', 'é', '😀']), bad: () => false },
  { t: 'bool', good: () => !!rand(2), bad: () => 0 },
  { t: '(uint / tstr)', good: () => choose([rand(20), 'é']), bad: () => null },
  { t: 'bstr', good: () => bytes(rand(5)), bad: () => 'x' },
]);
function generated(i) {
  const a = scalar(), b = scalar(), lo = rand(3), hi = lo + 1 + rand(4), n = lo + rand(hi-lo+1);
  let cddl, good, bad, family;
  switch (i % 16) {
    case 0: family='struct'; cddl=`r = {alpha: ${a.t}, ? beta: ${b.t}}`; good={alpha:a.good(), ...(rand(2)?{beta:b.good()}:{})}; bad=choose([{alpha:a.bad()},{beta:b.good()},{alpha:a.good(),extra:0}]); break;
    case 1: family='open-map'; cddl=`r = {alpha: ${a.t}, * tstr => any}`; good={alpha:a.good(),extra:atom(),nested:[atom()]}; bad={alpha:a.bad(),extra:atom()}; break;
    case 2: family='table'; cddl=`r = {${lo}*${hi} tstr => ${a.t}}`; good=Object.fromEntries(Array.from({length:n},(_,j)=>['k'+j,a.good()])); bad=Object.fromEntries(Array.from({length:hi+1},(_,j)=>['k'+j,a.good()])); break;
    case 3: family='array-occurrence'; cddl=`r = [${lo}*${hi} ${a.t}]`; good=Array.from({length:n},a.good); bad=choose([Array.from({length:hi+1},a.good),[a.bad()]]); break;
    case 4: family='nested-generics'; cddl=`list<T> = [${lo}*${hi} T]\nbox<T> = {payload: T}\nr = box<list<box<${a.t}>>>`; good={payload:Array.from({length:n},()=>({payload:a.good()}))}; bad={payload:[{payload:a.bad()}]}; break;
    case 5: { family='type-choice'; const k=rand(8); cddl=`r = {kind: "a", datum: ${a.t}} / {kind: "b", datum: [${k}, ${b.t}]}`; good=rand(2)?{kind:'a',datum:a.good()}:{kind:'b',datum:[k,b.good()]}; bad={kind:'c',datum:a.good()}; break; }
    case 6: { family='range'; const l=choose([-9223372036854775808n,-9007199254740991n,-4294967296n,0n,4294967296n,9007199254740991n,9223372036854775700n])+BigInt(rand(50)); const h=l+BigInt(hi); cddl=`r = ${l}..${h}`; good=l+BigInt(rand(hi+1)); bad=rand(2)?l-1n:h+1n; break; }
    case 7: family='text-size'; cddl=`r = tstr .size (${lo}..${hi})`; good='x'.repeat(n); if(n>=2&&rand(2)) good='é'+'x'.repeat(n-2); bad=choose(['x'.repeat(hi+1),bytes(n)]); break;
    case 8: family='byte-size'; cddl=`r = bstr .size (${lo}..${hi})`; good=bytes(n); bad=choose([bytes(hi+1),'x'.repeat(n)]); break;
    case 9: { family='bits'; const bit=rand(30); cddl=`r = uint .bits (0 / ${bit})`; good=choose([0n,1n,1n<<BigInt(bit)]); bad=1n<<BigInt(bit+1); break; }
    case 10: { family='typed-array'; const info=choose([[69,Uint16Array,2],[70,Uint32Array,4],[72,Int8Array,1],[77,Int16Array,2],[78,Int32Array,4],[85,Float32Array,4],[86,Float64Array,8]]); const [tag,C,w]=info; cddl=`r = #6.${tag}(bstr .size ${n*w})`; good=new C(Array.from({length:n},()=>rand(16))); bad=choose([new C(n+1),bytes(n*w)]); break; }
    case 11: { family='tag40'; const width=1+rand(3), height=1+rand(3); cddl=`r = #6.40([[${height}, ${width}], [* uint]])`; good=new NDArray([height,width],Array.from({length:height*width},()=>rand(20))); bad=choose([new NDArray([width*height],[...good.data]),new NDArray([height,width],Array(height*width).fill('x'))]); break; }
    case 12: { family='bignum'; const big=(1n<<BigInt(65+rand(100)))+BigInt(rand(1024)); const positive=!!rand(2); cddl=positive?'r = biguint':'r = integer'; good=positive?big:choose([big,-big,BigInt(rand(100))]); bad=positive?-big:choose(['x',1.5,false]); break; }
    case 13: family='decfrac'; cddl='r = decfrac'; good=new Decimal(BigInt(11+10*rand(50)),-1-rand(6)); bad=choose([1.5,rand(30),[1,2]]); break;
    case 14: { family='literals'; const k=rand(100), s=choose(['x','é','😀','abc']); cddl=`r = [${k}, ${JSON.stringify(s)}, true, null]`; good=[k,s,true,null]; bad=choose([[k+1,s,true,null],[k,s,false,null],[k,s,true]]); break; }
    case 15: { family='recursion'; cddl=`node = {value: ${a.t}, ? kids: [* node]}\nr = node`; const tree=d=>({value:a.good(),...(d?{kids:Array.from({length:rand(3)},()=>tree(d-1))}:{})}); good=tree(1+rand(3)); bad={value:a.good(),kids:[{value:a.bad()}]}; break; }
  }
  // Three values per independently varied schema: match, near miss, arbitrary.
  return { name:`generated-${i}`, family, cddl, cases:[good,bad,atom()].map(value=>({rule:'r',hex:hex(encode(value,{top:'any'}))})) };
}

// Cause routing is deliberately closed: a new unexplained mismatch fails the
// run instead of being hidden in an "other" bucket. See the findings for the
// reduced witnesses and RFC arguments that establish these causes.
function classify(r) {
  if(r.snugBug) return 'BUG-snug';
  if(r.crate.kind==='timeout') return 'crate-timeout';
  if(r.crate.kind==='panic') return 'byte-literal-panic';
  const n=r.name;
  if(r.crate.kind==='schema-error') {
    if(r.cddl.includes('.cborseq')) return 'unsupported-cborseq';
    if(n==='three byte literal spellings') return 'base64-literal-parse';
    if(n==='unqualified bytes with escaped quote and newline') return 'byte-escape-parse';
    if(n==='hex float literals round once to binary64') return 'hex-subnormal-parse';
    if(/bignum|huge integer|(?:lt|le|gt|ge) at /.test(n)) return 'native-integer-literal-limit';
    return 'UNCLASSIFIED';
  }
  if(r.crate.ok===r.snug) return null;
  if(r.source==='generated') return r.family==='nested-generics'?'nested-generic-scope':r.family==='bits'?'bits-zero':'UNCLASSIFIED';
  if(n!=='Appendix D: regexp'&&(/regexp|\.regexp/.test(n)||/^contract: (object-storage|item-classification)/.test(n))) return 'regexp-unanchored';
  if(/optional group|optional factor|named optional|preferences-v2/.test(n)||/^seeded-\d+$/.test(n)&&Number(n.slice(7))%4===0) return 'optional-map-group';
  if(/group choice \/\/|choices correlate|top-level group choices/.test(n)) return 'map-choice-coverage';
  if(n==='A2: distinct alternatives in repeated group') return 'repeated-map-choice';
  if(n==='C3: non-cut literal fall-through') return 'noncut-map-fallthrough';
  if(/incoming optional prefix|paired prefix|^seeded-/.test(n)) return 'array-occurrence';
  if(n.startsWith('C8:')) return 'composite-ne-target';
  if(n.startsWith('A11:')) return 'socket-group-extension';
  if(n==='type and group extensions') return 'named-group-extension';
  if(n==='undefined sockets') return 'undefined-group-socket';
  if(/unwrap/.test(n)) return 'map-unwrap';
  if(/member name equals|signaling-message/.test(n)) return 'member-rule-collision';
  if(n==='bytes literal used as method value') return 'byte-literal-text-confusion';
  if(n==='RFC 9682 variable tag number') return 'variable-tag-unchecked';
  if(n==='bare major types') return 'bare-major6';
  if(/float16|float32|float64/.test(n)) return 'float-width-erased';
  if(n==='uint size interval uses minimal byte capacity') return 'uint-size-range';
  if(n==='uint bits zero and high bits') return r.hex==='00'?'bits-zero':'bits-high';
  if(n==='bits byte boundaries LSB first') return 'bits-zero';
  if(/^(gt|ge) at /.test(n)) return 'bignum-comparison';
  if(n==='feature and default are annotations') return 'nested-control-target';
  if(n==='embedded full consumption') return 'embedded-trailing';
  if(r.hex.startsWith('c482')||n==='RFC 8610 Appendix D prelude composition') return 'prelude-tag-dispatch';
  if(/bignum via uint|^Appendix D: (uint|nint|int|number)$/.test(n)&&/^c[23]/.test(r.hex)) return 'prelude-bignum';
  if(/^Appendix D: (nint|unsigned)$/.test(n)) return 'prelude-signedness';
  return 'UNCLASSIFIED';
}

const summary = { seed, generatedRequested:count, timeoutMs:timeout, sourceFingerprint, binarySha256:hash(readFileSync(binary)), sources:{}, bySource:{}, compiledSuites:0, skipped:[], cases:0, compared:0, agreement:0, disagreements:0, panics:0, timeouts:0, schemaErrors:0, snugBugs:0, corpusErrors:0, oracleUnknown:0, foldedControlChecks:0, classes:{}, families:{} };
writeFileSync(cache+'results.jsonl','');
let digest = createHash('sha256');
function record(row) { const s=JSON.stringify(row)+'\n'; appendFileSync(cache+'results.jsonl',s); digest.update(s); }
async function suite(su, source, limit=Infinity) {
  let schema;
  try { schema=await compile(su.cddl); }
  catch(e) { summary.skipped.push({source,name:su.name,cases:su.cases.length,code:e.code??e.name,expected:!!(su.schemaError||su.snugSchemaError)}); if(source==='generated') throw e; return; }
  summary.compiledSuites++;
  // The reference interpreter predates RFC 9165 .cat/.plus. These two corpus
  // expressions fold to literals; record their independent checks separately,
  // never silently turn an unknown into a verdict.
  const folded=({'r = "a" .cat "b"':'r = "ab"','r = 1 .plus 2':'r = 3'})[su.cddl];
  const independent=oracleCompile(folded??su.cddl);
  for(const [i,k] of su.cases.slice(0,limit).entries()) {
    const input=unhex(k.hex), value=baselineDecode(input,{top:'any',...su.options});
    if(hex(baselineEncode(value,{top:'any',...su.options}))!==k.hex) throw Error('Profile round-trip differs');
    const snug=schema.validate(input,k.rule,{top:'any',...su.options});
    const expected=independent.error?'unknown':oracleCheck(independent,k.rule,value);
    if(expected==='unknown') summary.oracleUnknown++;
    if(folded) summary.foldedControlChecks++;
    const crate=native(su.cddl,k.rule,input);
    summary.cases++; summary.sources[source]=(summary.sources[source]??0)+1;
    if(su.family) summary.families[su.family]=(summary.families[su.family]??0)+1;
    const row={source,name:su.name,family:su.family,index:i,cddl:su.cddl,rule:k.rule,hex:k.hex,snug:snug.ok,reason:snug.reason,oracle:expected,...(folded?{oracleFolded:folded}:{}),expect:k.expect,crate};
    if(crate.kind==='panic') summary.panics++;
    else if(crate.kind==='timeout') summary.timeouts++;
    else if(crate.kind==='schema-error') summary.schemaErrors++;
    else { summary.compared++; if(crate.ok===snug.ok) summary.agreement++; else summary.disagreements++; }
    if(typeof expected==='boolean'&&snug.ok!==expected) { summary.snugBugs++; row.snugBug=true; }
    if(typeof expected==='boolean'&&k.expect!==undefined&&expected!==k.expect) { summary.corpusErrors++; row.corpusError=true; }
    row.class=classify(row);
    if(row.class) {
      const c=summary.classes[row.class]??={count:0,verdicts:0,schemaErrors:0,panics:0,timeouts:0,wrong:row.snugBug?'snug':'crate',sources:{}};
      c.count++; c.sources[source]=(c.sources[source]??0)+1;
      c[crate.kind==='verdict'?'verdicts':crate.kind==='schema-error'?'schemaErrors':crate.kind==='panic'?'panics':'timeouts']++;
    }
    const src=summary.bySource[source]??={cases:0,compared:0,agreement:0,disagreements:0,panics:0,timeouts:0,schemaErrors:0}; src.cases++;
    if(crate.kind==='verdict'){src.compared++;src[crate.ok===snug.ok?'agreement':'disagreements']++;}
    else src[crate.kind==='schema-error'?'schemaErrors':crate.kind==='panic'?'panics':'timeouts']++;
    record(row);
    if(summary.cases%500===0) console.log(`Progress: ${summary.cases} cases; ${summary.disagreements} verdict disagreements; ${summary.panics} panics; ${summary.timeouts} timeouts`);
  }
}

for(const file of ['study','adversarial']) {
  const j=JSON.parse(readFileSync(root+`corpus/conformance/${file}.json`));
  for(const su of j.suites) await suite({...su,cddl:su.cddl??readFileSync(root+'corpus/'+su.cddlFile,'utf8')},file);
}
for(let i=0, left=count;left>0;i++,left-=3) await suite(generated(i),'generated',Math.min(3,left));
summary.evidenceSha256=digest.digest('hex');
summary.sourcesUnchanged=fingerprint()===sourceFingerprint;
writeFileSync(cache+'summary.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
console.log(`Cases compared: ${summary.compared}; agreement: ${summary.agreement}; verdict disagreements: ${summary.disagreements}; crate panics: ${summary.panics}; timeouts: ${summary.timeouts}; crate schema errors: ${summary.schemaErrors}; snug bugs: ${summary.snugBugs}`);
for(const [name,c] of Object.entries(summary.classes)) console.log(`${name}: ${c.count}; ${c.wrong} wrong`);
if(summary.snugBugs||summary.corpusErrors||summary.oracleUnknown||summary.classes.UNCLASSIFIED||!summary.sourcesUnchanged) process.exitCode=1;
