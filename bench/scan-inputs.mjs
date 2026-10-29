// The P1.4 / P6.1 benchmark inputs, shared by scan-bench.mjs and rscan-bench.mjs.
import { readFileSync } from 'node:fs';
import { encode } from './baseline/cbor-3sln.mjs';

// ---------------------------------------------------------------- inputs
const te = new TextEncoder();
function rpcPut(dataLen) {
  return {
    resource: 'https://resource.example/r/1', addressedResource: 'https://resource.example/r/1',
    contract: 'https://contracts.example/object-storage/v1', method: 'put',
    args: { key: 'app/directory.json', data: new Uint8Array(dataLen).map((_, i) => (i * 31) & 255), size: dataLen, type: 'application/json' },
    scope: {}, epoch: null, resourceGeneration: null, connectionGeneration: null,
  };
}
let small = encode(rpcPut(1));
small = encode(rpcPut(1 + 287 - small.length));
const putMiB = encode(rpcPut(1 << 20));
const ints = []; for (let i = 0; i < 120_000; i++) ints.push(((i * 2654435761) % 2_000_003) - 1_000_000);
const intArray = encode({ v: ints }, { maxEntries: 1 << 20 });
const f64 = new Float64Array(65_536).map((_, i) => Math.sin(i) * 1e3);
const f32 = new Float32Array(65_536).map((_, i) => Math.cos(i));
const i16 = new Int16Array(131_072).map((_, i) => (i * 7) & 0x7fff);
const typed = encode({ f32, f64, i16 });            // 1 MiB of typed-array payload
const docs = [];
for (let d = 0; docs.length < 9_000; d++) {
  const m = {};
  for (let k = 0; k < 12; k++) m[`k${k}${String.fromCharCode(97 + ((d + k) % 26))}`] = k % 3 === 0 ? `v${d}` : k % 3 === 1 ? d * k : { a: k, é: 'x' };
  docs.push(m);
}
const nested = encode({ docs }, { maxItems: 1 << 24 });
const vectors = JSON.parse(readFileSync(new URL('../corpus/cbor-vectors/cbor-profile.json', import.meta.url)));
const vectorBytes = [...vectors.accept, ...vectors.refuse].map(v => new Uint8Array(Buffer.from(v.hex, 'hex')));

export const BIG = { top: 'map', cose: false, maxBytes: 1_500_000, maxDepth: 32, maxEntries: 65_536, maxItems: 1 << 24 };
export const DEF = { ...BIG, maxItems: 131_072 };
export const ANY = { ...DEF, top: 'any' };
export const inputs = [
  { name: 'vectors (216 profile vectors, all)', many: vectorBytes, opt: ANY },
  { name: `RPC put, ${small.length} B`, bytes: small, opt: DEF },
  { name: `RPC put with 1 MiB bstr, ${putMiB.length} B`, bytes: putMiB, opt: DEF },
  { name: `120,000-int array, ${intArray.length} B`, bytes: intArray, opt: { ...DEF, maxEntries: 1 << 20 } },
  { name: `1 MiB typed arrays (f32, f64, i16), ${typed.length} B`, bytes: typed, opt: DEF },
  { name: `nested maps, short text keys, ${nested.length} B`, bytes: nested, opt: BIG },
];

