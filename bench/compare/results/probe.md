| input | rule | snug | cbor.mjs | cbor-x | cborg | cborg-strict | cbor2 | cbor2-strict | node-cbor | node-cbor-dup | tiny-cbor | snug cose |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| valid control: {"a":1,"b":[1.5,-2]} | valid | A | A | A | A | A | A | A | A | A | **R** | A |
| non-shortest integer (1 as 0x18 0x01) | shortest form (int) | **R** | **R** | A | A | **R** | A | **R** | A | A | **R** | **R** |
| non-shortest length (text len 1 as 0x78 0x01) | shortest form (length) | **R** | **R** | A | A | **R** | A | **R** | A | A | **R** | **R** |
| non-shortest map head (cbor-x style 0xb9 0x0001) | shortest form (length) | **R** | **R** | A | A | **R** | A | **R** | A | A | **R** | **R** |
| non-shortest float (1.5 as float64) | shortest form (float) | **R** | **R** | A | A | A | A | **R** | A | A | A | **R** |
| non-shortest float (1.5 as float32) | shortest form (float) | **R** | **R** | A | A | A | A | **R** | A | A | A | **R** |
| indefinite-length array | definite lengths | **R** | **R** | A | A | **R** | A | **R** | A | A | **R** | **R** |
| indefinite-length text | definite lengths | **R** | **R** | **R** | **R** | **R** | A | **R** | A | A | **R** | **R** |
| map keys out of order {"b":1,"a":2} | key order | **R** | **R** | A | A | A | A | **R** | A | A | A | **R** |
| map keys out of order, int keys {2:0,1:0} | key order | **R** | **R** | A | A | A | A | **R** | A | A | A | **R** |
| duplicate map key {"a":1,"a":2} | duplicate keys | **R** | **R** | A | A | **R** | A | **R** | A | **R** | **R** | **R** |
| invalid UTF-8 (c3 28) | UTF-8 validity | **R** | **R** | A | A | **R** | **R** | **R** | **R** | **R** | A | **R** |
| UTF-8-encoded surrogate (ed a0 80) | UTF-8 validity | **R** | **R** | A | A | **R** | **R** | **R** | **R** | **R** | A | **R** |
| overlong UTF-8 (c0 af) | UTF-8 validity | **R** | **R** | A | A | **R** | **R** | **R** | **R** | **R** | A | **R** |
| invalid UTF-8 in a map key | UTF-8 validity | **R** | **R** | A | A | **R** | **R** | **R** | **R** | **R** | A | **R** |
| trailing bytes after the item | no trailing data | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** |
| truncated text | well-formed | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** |
| declared length 2^64-1 | well-formed | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** |
| reserved additional info 28 | well-formed | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** |
| bignum that fits in 64 bits (tag 2, 0x01) | preferred bignum | **R** | **R** | A | **R** | **R** | A | **R** | A | A | A | **R** |
| bignum with leading zero byte (tag 2) | preferred bignum | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** | **R** |
| undefined (0xf7) | profile: simple values | **R** | **R** | A | A | **R** | A | A | A | A | A | **R** |
| unassigned simple value 16 | profile: simple values | **R** | **R** | **R** | **R** | **R** | A | A | A | A | **R** | **R** |
| scalar NaN (f9 7e00) | profile: NaN | **R** | **R** | A | A | **R** | A | A | A | A | A | **R** |
| scalar +Infinity (f9 7c00) | profile: infinities | **R** | **R** | A | A | **R** | A | A | A | A | A | **R** |
| negative zero (f9 8000) | profile: -0 | **R** | **R** | A | A | A | A | A | A | A | **R** | **R** |
| integral float 1.0 (f9 3c00) | profile: integral floats | **R** | **R** | A | A | A | A | **R** | A | A | **R** | **R** |
| unknown tag 100 | profile: tag allow-list | **R** | **R** | A | **R** | **R** | A | A | A | A | A | **R** |
| integer map key {1:0} (top level) | profile: text keys (cose allows top level) | **R** | **R** | A | A | A | A | A | A | A | A | A |
| nested integer-key map {"k":{1:0}} (COSE_Key in a CWT cnf) | profile: text keys | **R** | **R** | A | A | A | A | A | A | A | A | **R** |
| COSE_Sign1 (tag 18 array) | profile: tag allow-list | **R** | **R** | A | **R** | **R** | A | A | A | A | A | **R** |
| epoch date (tag 1) | profile: tag allow-list | **R** | **R** | A | **R** | **R** | A | A | A | A | A | **R** |
| deep nesting: 33 nested arrays | depth limit (snug default 32) | **R** | **R** | A | A | A | A | A | A | A | A | **R** |

Encoder output (value {name,n:1.5,big:100000,list,zz,a:{b:null}}) under snug strict decode:

- snug: accepted (a66161a16162f6616ef93e00627a7af5636269671a000186a0646c69737483010203646e616d656178)
- cbor.mjs: accepted (a66161a16162f6616ef93e00627a7af5636269671a000186a0646c69737483010203646e616d656178)
- cbor-x: refused: non_shortest (b90006646e616d656178616efb3ff8000000000000636269671a000186a0646c69737483010203627a7af56161b900016162f6)
- cborg: accepted (a66161a16162f6616ef93e00627a7af5636269671a000186a0646c69737483010203646e616d656178)
- cborg-8949: accepted (a66161a16162f6616ef93e00627a7af5636269671a000186a0646c69737483010203646e616d656178)
- cbor2: refused: key_order (a6646e616d656178616ef93e00636269671a000186a0646c69737483010203627a7af56161a16162f6)
- cbor2-cde: accepted (a66161a16162f6616ef93e00627a7af5636269671a000186a0646c69737483010203646e616d656178)
- node-cbor: refused: key_order (a6646e616d656178616efa3fc00000636269671a000186a0646c69737483010203627a7af56161a16162f6)
- node-cbor-canon: accepted (a66161a16162f6616ef93e00627a7af5636269671a000186a0646c69737483010203646e616d656178)
- tiny-cbor: refused: key_order (a6646e616d656178616efa3fc00000636269671a000186a0646c69737483010203627a7af56161a16162f6)
