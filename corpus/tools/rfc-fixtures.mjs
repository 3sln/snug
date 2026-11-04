// Test data construction only. This module never imports the snug encoder.
export const bytes = hex => ({ bytes: hex });
export const tag = (tag, value) => ({ tag, value });
export const raw = hex => ({ raw: hex });
export const map = (...pairs) => new Map(pairs);
export function head(major, value) {
  const n = BigInt(value);
  if (n < 24n) return (major * 32 + Number(n)).toString(16).padStart(2, '0');
  const width = n <= 255n ? 1 : n <= 65535n ? 2 : n <= 0xffffffffn ? 4 : 8;
  return (major * 32 + ({ 1: 24, 2: 25, 4: 26, 8: 27 })[width]).toString(16)
    + n.toString(16).padStart(width * 2, '0');
}
export function cbor(v) {
  if (v?.raw !== undefined) return v.raw;
  if (v?.bytes !== undefined) return head(2, v.bytes.length / 2) + v.bytes;
  if (v?.tag !== undefined) return head(6, v.tag) + cbor(v.value);
  if (v === null) return 'f6';
  if (v === true) return 'f5';
  if (v === false) return 'f4';
  if (v === undefined) return 'f7';
  if (typeof v === 'bigint' || typeof v === 'number' && Number.isSafeInteger(v))
    return BigInt(v) >= 0 ? head(0, v) : head(1, -1n - BigInt(v));
  if (typeof v === 'number') { const b=Buffer.alloc(8); b.writeDoubleBE(v); return 'fb'+b.toString('hex'); }
  if (typeof v === 'string') {
    const b = Buffer.from(v); return head(3, b.length) + b.toString('hex');
  }
  if (Array.isArray(v)) return head(4, v.length) + v.map(cbor).join('');
  if (v instanceof Map || v && typeof v === 'object') {
    const entries = (v instanceof Map ? [...v] : Object.entries(v))
      .map(([k, value]) => [cbor(k), cbor(value)]).sort(([a], [b]) => a.localeCompare(b));
    return head(5, entries.length) + entries.map(p => p.join('')).join('');
  }
  throw Error('Unsupported fixture value; use raw hex for floats');
}
export function example(rule, value, expect, note, dependsOn = []) {
  return { rule, hex: cbor(value), expect, note, ...(dependsOn.length ? { dependsOn } : {}) };
}

// Source selections use logical lines split at LF and form-feed, matching the
// RFC's printed pagination. export-rfc converts them to physical LF line spans.
export const selections = {
  8610: [
    ['figure-1',380,384], ['figure-2',409,413], ['figure-3',420,422],
    ['figure-4',435,439], ['figure-5',469,479], ['figure-6',483,496],
    ['choices',605,606], ['delivery',614,623], ['choice-extensions',641,645],
    ['ranges',662,666], ['mixed-ranges-undefined',673,677],
    ['name-with-dots',693,693], ['named-range',698,698],
    ['group-enumeration',710,718], ['breakfast',762,769], ['conventions',885,891],
    ['occurrence',930,934], ['bedroom-fragment',941,941], ['people',1000,1006],
    ['geography',1065,1073], ['samples-colon',1094,1097],
    ['samples-arrow',1123,1126], ['samples-equipment',1152,1158],
    ['personal-data',1164,1173], ['figure-7',1207,1217],
    ['square-roots',1236,1238], ['tostring',1264,1265],
    ['labeled-values',1277,1282], ['indeterminate-map',1292,1295],
    ['cut-free',1332,1335], ['explicit-cut',1353,1356],
    ['quoted-cut',1384,1387], ['bareword-cut',1391,1394],
    ['biguint',1406,1406], ['buuid',1414,1414], ['my-uri',1418,1418],
    ['basic-header-group',1450,1462], ['unwrap-header',1465,1475],
    ['figure-8',1518,1521], ['figure-9',1531,1531], ['figure-10',1563,1577],
    ['figure-11',1610,1610], ['within-message',1728,1734], ['speed',1750,1750],
    ['cbor-expression',1682,1682], ['cborseq-expression',1689,1689],
    ['and-expression',1703,1703], ['within-expression',1721,1721],
    ['default-timer',1787,1790], ['socket-tcp',1805,1817],
    ['figure-12',1842,1865], ['generics',1874,1875],
    ['precedence-1',1913,1915], ['precedence-2',1921,1923],
    ['precedence-3',1947,1949], ['precedence-4',1955,1957],
    ['precedence-4a',1967,1969], ['prelude',2927,2983],
    ['json-prelude',3028,3050], ['ijson-integers',3104,3106],
    ['json-bignums',3117,3121], ['reputon-verbose',3389,3436],
    ['reputon-compact',3440,3456],
  ],
  9165: [
    ['figure-1',148,159], ['figure-2',184,189], ['figure-3',207,215],
    ['figure-4',225,230], ['figure-5',312,346], ['figure-6-ellipsis',379,383],
    ['figure-7',404,411], ['figure-8',418,420], ['figure-9',433,439],
  ],
  9682: [['figure-5',226,237], ['tag-range',338,340],
    ['hex-comments-unescaped',641,644], ['hex-comments-escaped',649,652]],
  9052: [
    ['start',350,350], ['internal-types',353,353], ['labels',380,381],
    ['messages',535,543], ['headers',627,637], ['generic-headers',781,788],
    ['sign-tag',837,837], ['sign',876,880], ['signature',896,899],
    ['sign1-tag',913,913], ['sign1',935,939], ['sig-structure',1024,1031],
    ['encrypt-tag',1103,1103], ['encrypt',1123,1127], ['recipient',1150,1154],
    ['encrypt0-tag',1200,1200], ['encrypt0',1214,1217],
    ['enc-structure',1256,1261], ['mac-tag',1426,1426], ['mac',1451,1456],
    ['mac0-tag',1473,1473], ['mac0',1488,1492],
    ['mac-structure',1519,1524], ['keys',1585,1594],
  ],
};

const f = raw('f93e00');
const person = { age: 1, name: 'A', employer: 'B' };
const personal = { firstName: 'A', age: 2 };
const empty = bytes('');
const sample = { 'sample-point': 1, samples: [f] };
const e = example;

// Expectations are hand-derived from the indicated RFC text, never from snug
// or Ruby. Even when a tool refuses the schema these cases remain expectations.
export function dataFor8610(id) {
  if (['figure-1','figure-3','figure-4','figure-5','figure-6'].includes(id))
    return [e('person',person,true,'§2.1: all three required named members'),e('person',{age:1},false,'§2.1: required text members missing')];
  if (id === 'figure-2') return [e('probe',[1,'A','B'],true,'§2.1: group in array context'),e('probe',[],false,'three entries required')];
  if (id === 'choices') return [e('attire','bow tie',true,'§2.2.2 literal alternative'),e('attire','boots',false,'not an alternative'),e('protocol',17,true,'literal protocol'),e('protocol',7,false,'not an alternative')];
  if (id === 'choice-extensions') return [e('attire','swimwear',true,'§2.2.2 extension alone creates choice'),e('attire','boots',false,'not in extension'),e('probe',{lat:f,long:f,'drone-type':'x'},true,'§2.2.2 extended delivery group'),e('probe',{},false,'delivery extension requires all three members')];
  if (id === 'delivery') return [e('address',{'per-pickup':true},true,'§2.2.2 third delivery choice; no earlier cut key present'),e('address',{},false,'no delivery alternative matches')];
  if (id === 'ranges') return [e('device-address',255,true,'inclusive endpoint'),e('device-address',256,false,'outside byte range'),e('byte1',255,true,'exclusive upper bound'),e('byte1',256,false,'excluded upper bound')];
  if (id === 'mixed-ranges-undefined') return [];
  if (id === 'group-enumeration') return [e('terminal-color',7,true,'§2.2.2.2 group values'),e('terminal-color',8,false,'outside base colors'),e('extended-color',11,true,'extended value'),e('extended-color',12,false,'outside extended values')];
  if (id === 'breakfast') return [e('my_breakfast',tag(55799,tag(998,'oats')),true,'§2.2.3 tagged cereal'),e('my_breakfast',tag(55799,0),false,'breakfast requires tag 998 or 999')];
  if (id === 'conventions') return [e('person',{name:'A',age:1},true,'§3.1 bareword key'),e('person',{name:1,age:1},false,'name must be text')];
  if (id === 'occurrence') return [e('apartment',{kitchen:f},true,'§3.2 zero bedrooms'),e('apartment',{kitchen:f,bedroom:f},true,'one bedroom'),e('apartment',{},false,'kitchen mandatory')];
  if (id === 'bedroom-fragment') return [e('probe',{},true,'§3.2 optional member'),e('probe',{bedroom:1},false,'bedroom must be float')];
  if (id === 'people') return [e('unlimited-people',[],true,'§3.4 printed empty instance'),e('unlimited-people',['roundlet',1047,'psychurgy',2204,'extrarhythmical',2231],true,'§3.4 first printed instance'),e('unlimited-people',['aluminize',212,'climograph',4124],true,'§3.4 third printed instance'),e('unlimited-people',['penintime',1513,'endocarditis',4084,'impermeator',1669,'coextension',865],true,'§3.4 fourth printed instance'),e('one-or-two-people',[],false,'minimum one pair'),e('at-least-two-people',['A',1],false,'minimum two pairs')];
  if (id === 'geography') return [e('Geography',['X',{longitude:1,latitude:2}],true,'§3.5.1 record with embedded struct'),e('Geography',['X',{}],false,'coordinates required')];
  if (id.startsWith('samples-')) return [e('located-samples',sample,true,'§3.5.1 nonempty float sample vector'),e('located-samples',{'sample-point':1,samples:[]},false,'+ requires at least one sample')];
  if (['personal-data','figure-7','figure-12'].includes(id)) {
    const result=[e('PersonalData',personal,true,'§3.5.1 optional fields'),e('PersonalData',{age:'old'},false,'age uint even in extensible map (cut)')];
    if(id==='figure-7')result.push(e('PersonalData',{familyName:'agust',antiforeignism:'pretzel',springbuck:'illuminatingly',exuviae:'ephemeris',kilometrage:'frogfish'},true,'§3.5.1 printed generated instance'));
    return result;
  }
  if (id === 'square-roots') return [e('square-roots',map([1,f]),true,'§3.5.2 integer to float table'),e('square-roots',map(['x',f]),false,'key must be integer')];
  if (id === 'tostring') return [e('tostring',map([1,'one']),true,'§3.5.2 number to text'),e('tostring',map([1,1]),false,'value must be text')];
  if (id === 'labeled-values') return [e('labeled-values',{fritz:1,x:2},true,'§3.5.3 named member followed by absorber'),e('labeled-values',{fritz:'x'},false,'number required')];
  if (id === 'indeterminate-map') return [e('do-not-do-this',{},false,'§3.5.3 both required entries absent; ambiguous positive example deliberately not assigned a Boolean',['D270']),e('do-not-do-this',map([1,6]),false,'two distinct pairs required',['D270'])];
  if (['cut-free','explicit-cut','quoted-cut','bareword-cut'].includes(id)) return [e('extensible-map-example',{'optional-key':'nonsense'},id==='cut-free','§3.5.4 printed instance: cut-free wildcard accepts, cut commits to int'),e('extensible-map-example',{'optional-key':1},true,'§3.5.4 optional int present'),e('extensible-map-example',{},true,'optional member absent')];
  if (id==='biguint') return [e('biguint',tag(2,bytes('010000000000000000')),true,'§3.6 unsigned bignum'),e('biguint',0,false,'requires tag 2')];
  if (id==='buuid') return [e('buuid',tag(37,bytes('00'.repeat(16))),true,'§3.6 tagged UUID bytes'),e('buuid',tag(37,'x'),false,'content must be bytes')];
  if (id==='my-uri') return [e('my_uri','relative',true,'§3.6 untagged text alternative'),e('my_uri',tag(32,'https://example.com'),true,'tagged URI'),e('my_uri',0,false,'neither text alternative')];
  if (['basic-header-group','unwrap-header'].includes(id)) return [e('advanced-header',[1,'X',empty,2],true,'§3.7 flattened header; ~time exposes number'),e('advanced-header',[[1,'X'],empty,2],false,'unwrap does not nest basic header')];
  if(id==='figure-8') return [e('full-address',[[bytes('01')],bytes('00'.repeat(4)),bytes('00'.repeat(16))],true,'§3.8.1 sizes and nonempty labels'),e('ip4',bytes('00'.repeat(3)),false,'four bytes required')];
  if(id==='figure-9') return [e('audio_sample',16777215,true,'§3.8.1 maximal 24-bit magnitude'),e('audio_sample',16777216,false,'outside 24-bit magnitude')];
  if(id==='figure-10') return [...['906d','01fc','8145','01b7','013d','409f','018e','c05f','01fa','01fe'].map(h=>e('tcpflagbytes',bytes(h),true,'§3.8.2 printed example')),e('tcpflagbytes',empty,true,'all-clear empty string explicitly permitted'),e('tcpflagbytes',bytes('02'),false,'bit 1 not allowed'),e('rwxbits',7,true,'rwx bits 0..2'),e('rwxbits',8,false,'bit 3 not allowed')];
  if(id==='figure-11') return [e('nai','N1@CH57HF.4Znqe0.dYJRN.igjf',true,'§3.8.3 printed example'),e('nai','no-at-sign',false,'required @ and domain')];
  if(id==='within-message') return [e('message',[3,'bread',[]],true,'§3.8.5 socket plug inside message structure'),e('message',[4,'pasta','red',true],true,'second plug'),e('message',[5],false,'no socket plug')];
  if(id==='speed') return [e('speed',0,true,'§3.8.6 >=0'),e('speed',-1,false,'negative speed')];
  if(id==='default-timer') return [e('timer',{time:0},true,'§3.8.6 optional default omitted'),e('timer',{time:0,'displayed-step':1},false,'published §3.8.6 implied .ne; erratum 9229 contested'),e('timer',{time:0,'displayed-step':2},true,'positive nondefault step')];
  if(id==='socket-tcp') return [e('tcp-header',{seq:1,ack:2},true,'§3.9 zero options'),e('tcp-header',{seq:1,ack:2,'sack-permitted':true},true,'plugged option'),e('tcp-header',{seq:1},false,'ack required')];
  if(id==='generics') return [e('messages',{type:'reboot',value:'now'},true,'§3.10 parameter substitution'),e('messages',{type:'sleep',value:100},true,'inclusive bound'),e('messages',{type:'sleep',value:101},false,'outside argument type')];
  if(id==='precedence-1') return [e('t',[1],true,'§3.11 group choice of types'),e('t',[1,2],false,'one element required')];
  if(id==='precedence-2') return [e('t',{},true,'§3.11 optional first branch'),e('t',{cd:3},false,'PEG locks empty first branch; remaining map member causes failure',['D270'])];
  if(['precedence-3','precedence-4','precedence-4a'].includes(id)) return [e('t',[1,1],true,'§3.11 repeated a'),e('t',[2,2],id==='precedence-3','§3.11 + applies to entire type choice only in group3'),e('t',[],false,'no empty alternative')];
  if(id==='ijson-integers') return [e('ij-uint',9007199254740991n,true,'Appendix E I-JSON exact integer limit'),e('ij-uint',9007199254740992n,false,'above exact limit')];
  if(id==='json-bignums')return [e('integer',tag(2,bytes('010000000000000000')),true,'Appendix E bignum alternative'),e('integer','1',false,'text is not an integer')];
  if(id.startsWith('reputon-'))return [e('reputation-object',{application:'x',reputons:[]},true,'Appendix H empty reputon vector'),e('reputation-object',{application:'x',reputons:[{rater:'a',assertion:'b',rated:'c',rating:f}]},true,'Appendix H required reputon fields'),e('reputation-object',{application:'x',reputons:[{}]},false,'required reputon fields absent')];
  return [];
}

export function dataFor9165(id) {
  if(id==='figure-1')return [e('rect',map([0,1],[1,2],[3,3],[4,4]),true,'§2.1 expanded X/Y interval labels'),e('rect',map([0,1],[1,2]),false,'Y interval mandatory')];
  if(id==='figure-2')return [e('c','foo\n  bar\n  baz\n',true,'§2.2 exact bytes of multiline literal'),e('c','foobarbaz',false,'newlines and spaces significant')];
  if(['figure-3','figure-4'].includes(id))return [e('oid',bytes('00'),true,'§2.3 one terminating arc'),e('oid',empty,false,'oid requires 1*arc'),e('oid',bytes('81'),false,'unterminated arc')];
  if(id==='figure-5')return [e('Tag1004',tag(1004,'2024-01-01'),true,'§3 full-date ABNF'),e('Tag1004',tag(1004,'not-a-date'),false,'ABNF shape fails'),e('Tag0',tag(0,'2013-03-21T20:04:00Z'),true,'§3 date-time ABNF')];
  if(id==='figure-6-ellipsis')return [];
  if(id==='figure-7')return [e('person',{name:'A',bloodgroup:'O',future:1},true,'§4 feature annotations do not restrict wildcard'),e('person',{name:0},false,'known member retains text type')];
  if(id==='figure-8')return [e('allowed-types',{},true,'§4 any extension alternative'),e('allowed-types',tag(1000,0),true,'§4 any includes tagged item; no invalid CBOR')];
  if(id==='figure-9')return [e('SenML-Record',{'v':1},true,'§4 JSON feature enabled (annotation-only)'),e('SenML-Record',map([2,1]),true,'CBOR feature annotation'),e('SenML-Record',map([2,'x']),false,'measurement value number')];
  return [];
}
