# P7.6 entry and module sizes — 2026-11-03

Generated from before.json and after.json; method and graph definitions: [README.md](README.md).

All figures are bytes. Static entries retain every public export; runtime = codec + schema; all-runtime adds views, Writer and sources. Unicode is separate.

| Entry | Before min | After min | Before gzip-9 | After gzip-9 | Before brotli-11 | After brotli-11 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| snug | 41238 | 41238 | 14174 | 14174 | 12689 | 12689 |
| snug/schema | 124376 | 124376 | 46042 | 46042 | 39293 | 39293 |
| snug/compile | 123471 | 2378 | 45754 | 1243 | 39065 | 1101 |
| snug/view | 53988 | 53988 | 18328 | 18328 | 16334 | 16334 |
| snug/writer | 37750 | 37750 | 12996 | 12996 | 11640 | 11640 |
| snug/unicode | 19377 | 19377 | 9287 | 9287 | 8817 | 8817 |
| snug/sources | 30415 | 30415 | 11300 | 11300 | 10029 | 10029 |
| runtime | 147858 | 147858 | 53452 | 53452 | 45485 | 45485 |
| all-runtime | 175485 | 175485 | 63284 | 63284 | 53707 | 53707 |

## Full closure and real split outputs

Full bundles inline all reachable lazy code. Split bytes sum separately compressed chunks; unreachable emitted chunks are excluded from reachable totals.

| Entry | Full gzip before → after | Split initial gzip before → after | Split reachable gzip before → after | All emitted gzip after |
| --- | ---: | ---: | ---: | ---: |
| snug | 14174 → 14174 | 14174 → 14174 | 14174 → 14174 | 14174 |
| snug/schema | 46109 → 46109 | 47010 → 47010 | 47010 → 47010 | 85829 |
| snug/compile | 84074 → 85118 | 46746 → 1371 | 84612 → 84779 | 85913 |
| snug/view | 18328 → 18328 | 18328 → 18328 | 18328 → 18328 | 18328 |
| snug/writer | 12996 → 12996 | 12996 → 12996 | 12996 → 12996 | 12996 |
| snug/unicode | 9287 → 9287 | 9287 → 9287 | 9287 → 9287 | 9287 |
| snug/sources | 11300 → 11300 | 11300 → 11300 | 11300 → 11300 | 11300 |
| runtime | 53626 → 53626 | 54799 → 54799 | 54799 → 54799 | 93648 |
| all-runtime | 63328 → 63328 | 64483 → 64483 | 64483 → 64483 | 103332 |

## Static graph: ranked minified attribution

Each block is 2,000 minified bytes (rounded up). Paths occur once per bundle. Full import edges and zero-byte candidates are in each report metafile. Gzip attribution cannot be added across modules.

### snug

```text
 14192 ████████     host/js/src/writer.mjs
  4490 ███          gen/js/snug/cbor/scan.mjs
  3772 ██           host/js/src/values.mjs
  2866 ██           host/js/src/build.mjs
  2008 ██           host/js/src/options.mjs
  1979 █            gen/js/snug/write/map.mjs
  1841 █            gen/js/snug/cbor/stdtags.mjs
  1561 █            host/js/src/profiles.mjs
  1489 █            gen/js/snug/write/float.mjs
  1181 █            gen/js/snug/cbor/head.mjs
  1126 █            gen/js/snug/cbor/float.mjs
  1098 █            gen/js/snug/cbor/text.mjs
   987 █            gen/js/snug/cbor/tags.mjs
   685 █            gen/js/snug/write/out.mjs
   515 █            host/js/src/scan.mjs
   411 █            gen/js/snug/write/int.mjs
   359 █            host/js/src/limits.mjs
   185 █            host/js/src/fault.mjs
   126 █            gen/js/snug/cbor/keys.mjs
   122 █            host/js/src/typed-bytes.mjs
    69 █            host/js/src/encode.mjs
    43 █            host/js/src/index.mjs
```

### snug/schema

```text
 19391 ██████████   gen/js/snug/vm/eval.mjs
 18903 ██████████   gen/js/snug/program/verify.mjs
 14664 ████████     gen/js/snug/vm/scont.mjs
  7730 ████         gen/js/snug/vm/sbase.mjs
  6700 ████         gen/js/snug/vm/map.mjs
  6647 ████         gen/js/snug/vm/sstr.mjs
  4876 ███          gen/js/snug/vm/session.mjs
  4732 ███          gen/js/snug/vm/leaf.mjs
  4703 ███          host/js/src/schema.mjs
  3801 ██           host/js/src/values.mjs
  3655 ██           gen/js/snug/vm/dead.mjs
  3085 ██           gen/js/snug/vm/api.mjs
  2867 ██           host/js/src/build.mjs
  2551 ██           gen/js/snug/vm/base.mjs
  2526 ██           host/js/src/public-schema.mjs
  1929 █            host/js/src/options.mjs
  1856 █            gen/js/snug/cbor/stdtags.mjs
  1721 █            host/js/src/sha256.mjs
  1717 █            host/js/src/serialized.mjs
  1538 █            gen/js/snug/vm/array.mjs
  1480 █            gen/js/snug/cbor/scan.mjs
  1354 █            gen/js/snug/cbor/text.mjs
  1300 █            host/js/src/profiles.mjs
  1184 █            gen/js/snug/cbor/head.mjs
  1141 █            gen/js/snug/cbor/float.mjs
   991 █            gen/js/snug/cbor/tags.mjs
   636 █            gen/js/snug/cbor/keys.mjs
   213 █            host/js/src/public-errors.mjs
   188 █            host/js/src/fault.mjs
   143 █            host/js/src/limits.mjs
    15 █            host/js/src/version.mjs
```

### snug/compile

```text
  1865 █            host/js/src/options.mjs
   474 █            host/js/src/public-compile.mjs
```

### snug/view

```text
 14216 ████████     host/js/src/writer.mjs
 10756 ██████       host/js/src/view.mjs
  4491 ███          gen/js/snug/cbor/scan.mjs
  3783 ██           host/js/src/values.mjs
  2865 ██           host/js/src/build.mjs
  2008 ██           host/js/src/options.mjs
  1979 █            gen/js/snug/write/map.mjs
  1868 █            gen/js/snug/nav/walk.mjs
  1844 █            gen/js/snug/cbor/stdtags.mjs
  1561 █            host/js/src/profiles.mjs
  1489 █            gen/js/snug/write/float.mjs
  1181 █            gen/js/snug/cbor/head.mjs
  1126 █            gen/js/snug/cbor/float.mjs
  1098 █            gen/js/snug/cbor/text.mjs
   987 █            gen/js/snug/cbor/tags.mjs
   687 █            gen/js/snug/write/out.mjs
   515 █            host/js/src/scan.mjs
   412 █            gen/js/snug/write/int.mjs
   361 █            host/js/src/limits.mjs
   212 █            host/js/src/public-errors.mjs
   185 █            host/js/src/fault.mjs
   126 █            gen/js/snug/cbor/keys.mjs
   122 █            host/js/src/typed-bytes.mjs
    72 █            host/js/src/public-view.mjs
```

### snug/writer

```text
 14193 ████████     host/js/src/writer.mjs
  4490 ███          gen/js/snug/cbor/scan.mjs
  3370 ██           host/js/src/values.mjs
  2009 ██           host/js/src/options.mjs
  1979 █            gen/js/snug/write/map.mjs
  1841 █            gen/js/snug/cbor/stdtags.mjs
  1561 █            host/js/src/profiles.mjs
  1489 █            gen/js/snug/write/float.mjs
  1181 █            gen/js/snug/cbor/head.mjs
  1126 █            gen/js/snug/cbor/float.mjs
  1098 █            gen/js/snug/cbor/text.mjs
   987 █            gen/js/snug/cbor/tags.mjs
   685 █            gen/js/snug/write/out.mjs
   516 █            host/js/src/scan.mjs
   411 █            gen/js/snug/write/int.mjs
   359 █            host/js/src/limits.mjs
   185 █            host/js/src/fault.mjs
   126 █            gen/js/snug/cbor/keys.mjs
   122 █            host/js/src/typed-bytes.mjs
```

### snug/unicode

```text
 19303 ██████████   host/js/src/unicode-tables.mjs
```

### snug/sources

```text
  8651 █████        gen/js/snug/cbor/rscan.mjs
  5510 ███          host/js/src/sources.mjs
  4531 ███          gen/js/snug/cbor/scan.mjs
  1915 █            host/js/src/options.mjs
  1844 █            gen/js/snug/cbor/stdtags.mjs
  1422 █            host/js/src/profiles.mjs
  1354 █            gen/js/snug/cbor/text.mjs
  1181 █            gen/js/snug/cbor/head.mjs
  1130 █            gen/js/snug/cbor/float.mjs
   987 █            gen/js/snug/cbor/tags.mjs
   634 █            gen/js/snug/cbor/keys.mjs
   516 █            host/js/src/scan.mjs
   361 █            host/js/src/limits.mjs
   158 █            host/js/src/fault.mjs
```

### runtime

```text
 19391 ██████████   gen/js/snug/vm/eval.mjs
 18903 ██████████   gen/js/snug/program/verify.mjs
 14664 ████████     gen/js/snug/vm/scont.mjs
 14220 ████████     host/js/src/writer.mjs
  7730 ████         gen/js/snug/vm/sbase.mjs
  6700 ████         gen/js/snug/vm/map.mjs
  6647 ████         gen/js/snug/vm/sstr.mjs
  4876 ███          gen/js/snug/vm/session.mjs
  4732 ███          gen/js/snug/vm/leaf.mjs
  4703 ███          host/js/src/schema.mjs
  4499 ███          gen/js/snug/cbor/scan.mjs
  3801 ██           host/js/src/values.mjs
  3655 ██           gen/js/snug/vm/dead.mjs
  3085 ██           gen/js/snug/vm/api.mjs
  2867 ██           host/js/src/build.mjs
  2683 ██           host/js/src/public-schema.mjs
  2551 ██           gen/js/snug/vm/base.mjs
  2039 ██           host/js/src/options.mjs
  1983 █            gen/js/snug/write/map.mjs
  1856 █            gen/js/snug/cbor/stdtags.mjs
  1721 █            host/js/src/sha256.mjs
  1717 █            host/js/src/serialized.mjs
  1561 █            host/js/src/profiles.mjs
  1538 █            gen/js/snug/vm/array.mjs
  1506 █            gen/js/snug/write/float.mjs
  1354 █            gen/js/snug/cbor/text.mjs
  1184 █            gen/js/snug/cbor/head.mjs
  1141 █            gen/js/snug/cbor/float.mjs
   991 █            gen/js/snug/cbor/tags.mjs
   694 █            gen/js/snug/write/out.mjs
   636 █            gen/js/snug/cbor/keys.mjs
   517 █            host/js/src/scan.mjs
   415 █            gen/js/snug/write/int.mjs
   361 █            host/js/src/limits.mjs
   213 █            host/js/src/public-errors.mjs
   201 █            host/js/src/index.mjs
   188 █            host/js/src/fault.mjs
   122 █            host/js/src/typed-bytes.mjs
    70 █            host/js/src/encode.mjs
    15 █            host/js/src/version.mjs
```

### all-runtime

```text
 19424 ██████████   gen/js/snug/vm/eval.mjs
 18903 ██████████   gen/js/snug/program/verify.mjs
 14670 ████████     gen/js/snug/vm/scont.mjs
 14220 ████████     host/js/src/writer.mjs
 10879 ██████       host/js/src/view.mjs
  8774 █████        gen/js/snug/cbor/rscan.mjs
  7730 ████         gen/js/snug/vm/sbase.mjs
  6700 ████         gen/js/snug/vm/map.mjs
  6647 ████         gen/js/snug/vm/sstr.mjs
  5521 ███          host/js/src/sources.mjs
  4876 ███          gen/js/snug/vm/session.mjs
  4732 ███          gen/js/snug/vm/leaf.mjs
  4703 ███          host/js/src/schema.mjs
  4543 ███          gen/js/snug/cbor/scan.mjs
  3801 ██           host/js/src/values.mjs
  3655 ██           gen/js/snug/vm/dead.mjs
  3085 ██           gen/js/snug/vm/api.mjs
  2867 ██           host/js/src/build.mjs
  2683 ██           host/js/src/public-schema.mjs
  2551 ██           gen/js/snug/vm/base.mjs
  2039 ██           host/js/src/options.mjs
  1983 █            gen/js/snug/write/map.mjs
  1927 █            gen/js/snug/nav/walk.mjs
  1856 █            gen/js/snug/cbor/stdtags.mjs
  1721 █            host/js/src/sha256.mjs
  1717 █            host/js/src/serialized.mjs
  1561 █            host/js/src/profiles.mjs
  1538 █            gen/js/snug/vm/array.mjs
  1506 █            gen/js/snug/write/float.mjs
  1354 █            gen/js/snug/cbor/text.mjs
  1184 █            gen/js/snug/cbor/head.mjs
  1141 █            gen/js/snug/cbor/float.mjs
   991 █            gen/js/snug/cbor/tags.mjs
   694 █            gen/js/snug/write/out.mjs
   636 █            gen/js/snug/cbor/keys.mjs
   517 █            host/js/src/scan.mjs
   415 █            gen/js/snug/write/int.mjs
   361 █            host/js/src/limits.mjs
   242 █            host/js/src/public-sources.mjs
   213 █            host/js/src/public-errors.mjs
   201 █            host/js/src/index.mjs
   188 █            host/js/src/fault.mjs
   129 █            host/js/src/public-view.mjs
   122 █            host/js/src/typed-bytes.mjs
    70 █            host/js/src/encode.mjs
    33 █            host/js/src/public-writer.mjs
    15 █            host/js/src/version.mjs
```

## Isolated modules

Imports are retained, not recursively bundled. These per-module compression sizes are not marginal bundle savings.

| Module | Source | Min | Gzip-9 | Brotli-11 |
| --- | ---: | ---: | ---: | ---: |
| gen/js/snug/compile/emit.mjs | 68475 | 24875 | 9039 | 7950 |
| gen/js/snug/vm/eval.mjs | 78501 | 23619 | 9358 | 8256 |
| gen/js/snug/program/verify.mjs | 61862 | 20964 | 7586 | 6577 |
| host/js/src/unicode-tables.mjs | 19875 | 19395 | 9299 | 8805 |
| gen/js/snug/vm/scont.mjs | 49517 | 19083 | 7862 | 6860 |
| gen/js/snug/compile/lower.mjs | 48959 | 18974 | 7036 | 6264 |
| gen/js/snug/compile/leaf.mjs | 43419 | 16204 | 5554 | 4911 |
| host/js/src/writer.mjs | 29750 | 15253 | 5241 | 4723 |
| gen/js/snug/compile/ctl.mjs | 36882 | 12168 | 4485 | 4020 |
| host/js/src/view.mjs | 24230 | 11439 | 4326 | 3935 |
| gen/js/snug/compile/maps.mjs | 32636 | 11043 | 3823 | 3452 |
| gen/js/snug/vm/sbase.mjs | 32736 | 10899 | 4873 | 4229 |
| gen/js/snug/cbor/rscan.mjs | 39813 | 10842 | 4568 | 4150 |
| gen/js/snug/compile/lex.mjs | 26095 | 9404 | 3676 | 3335 |
| gen/js/snug/compile/regexp.mjs | 24382 | 9296 | 3460 | 3107 |
| gen/js/snug/vm/sstr.mjs | 24183 | 9052 | 4050 | 3639 |
| gen/js/snug/compile/arena.mjs | 17203 | 8306 | 3630 | 3062 |
| gen/js/snug/compile/parse.mjs | 20752 | 7903 | 2958 | 2698 |
| gen/js/snug/vm/map.mjs | 24493 | 7694 | 3173 | 2810 |
| gen/js/snug/vm/session.mjs | 18938 | 7547 | 3276 | 2974 |
| gen/js/snug/compile/main.mjs | 14523 | 6496 | 2654 | 2374 |
| gen/js/snug/cbor/scan.mjs | 18591 | 6301 | 2578 | 2343 |
| host/js/src/sources.mjs | 16030 | 6242 | 2417 | 2193 |
| gen/js/snug/vm/leaf.mjs | 18168 | 5785 | 2625 | 2377 |
| host/js/src/schema.mjs | 11613 | 5676 | 2470 | 2236 |
| gen/js/snug/vm/api.mjs | 14196 | 5169 | 2313 | 2110 |
| gen/js/snug/vm/dead.mjs | 14035 | 5074 | 2108 | 1926 |
| gen/js/snug/compile/glush.mjs | 12858 | 5067 | 1955 | 1786 |
| host/js/src/values.mjs | 7697 | 3985 | 1676 | 1496 |
| gen/js/snug/compile/bytes.mjs | 10910 | 3921 | 1535 | 1421 |
| gen/js/snug/vm/base.mjs | 9456 | 3447 | 1597 | 1458 |
| gen/js/snug/compile/rules.mjs | 8932 | 3334 | 1505 | 1396 |
| host/js/src/build.mjs | 5929 | 3066 | 1426 | 1293 |
| host/js/src/compile.mjs | 6267 | 3013 | 1540 | 1373 |
| host/js/src/public-schema.mjs | 4729 | 2933 | 1157 | 1036 |
| gen/js/snug/compile/prelude.mjs | 3925 | 2873 | 626 | 570 |
| gen/js/snug/vm/layout.mjs | 3535 | 2454 | 1183 | 981 |
| gen/js/snug/write/map.mjs | 7878 | 2327 | 1041 | 941 |
| gen/js/snug/nav/walk.mjs | 7811 | 2279 | 1054 | 985 |
| gen/js/snug/cbor/stdtags.mjs | 7599 | 2108 | 1055 | 988 |
| host/js/src/options.mjs | 3631 | 2026 | 1037 | 922 |
| host/js/src/serialized.mjs | 3219 | 1886 | 935 | 837 |
| gen/js/snug/vm/array.mjs | 5897 | 1852 | 959 | 865 |
| gen/js/snug/write/float.mjs | 5849 | 1790 | 706 | 665 |
| host/js/src/profiles.mjs | 3342 | 1770 | 824 | 750 |
| host/js/src/sha256.mjs | 2879 | 1753 | 1020 | 893 |
| gen/js/snug/cbor/head.mjs | 5270 | 1623 | 820 | 763 |
| gen/js/snug/compile/arrays.mjs | 3521 | 1521 | 724 | 660 |
| gen/js/snug/cbor/text.mjs | 5990 | 1458 | 509 | 462 |
| gen/js/snug/cbor/float.mjs | 4981 | 1319 | 538 | 500 |
| gen/js/snug/cbor/tags.mjs | 3887 | 1202 | 642 | 591 |
| gen/js/snug/write/out.mjs | 3447 | 990 | 548 | 494 |
| gen/js/snug/cbor/codes.mjs | 1466 | 980 | 519 | 466 |
| host/js/src/scan.mjs | 1692 | 819 | 465 | 408 |
| gen/js/snug/cbor/keys.mjs | 2699 | 748 | 419 | 394 |
| gen/js/snug/write/int.mjs | 2328 | 728 | 489 | 448 |
| host/js/src/public-compile.mjs | 1028 | 564 | 372 | 329 |
| host/js/src/index.mjs | 411 | 480 | 260 | 242 |
| host/js/src/public-sources.mjs | 267 | 438 | 208 | 179 |
| host/js/src/limits.mjs | 638 | 404 | 310 | 263 |
| host/js/src/public-errors.mjs | 492 | 283 | 210 | 185 |
| host/js/src/public-view.mjs | 291 | 244 | 177 | 137 |
| host/js/src/fault.mjs | 344 | 220 | 188 | 173 |
| host/js/src/compile-runtime.mjs | 266 | 179 | 127 | 104 |
| host/js/src/encode.mjs | 2096 | 174 | 146 | 111 |
| host/js/src/typed-bytes.mjs | 494 | 150 | 146 | 126 |
| host/js/src/public-writer.mjs | 39 | 59 | 67 | 63 |
| host/js/src/version.mjs | 186 | 43 | 63 | 47 |

## Largest generated functions

Isolated functions retain external reference names; this ranks candidates, not additive bundle attribution. Compiler rows establish why the compiler must remain separate.

| Function | Source | Min | Gzip-9 | Brotli-11 |
| --- | ---: | ---: | ---: | ---: |
| gen/js/snug/cbor/rscan.mjs:rscanStep | 26258 | 7603 | 2585 | 2414 |
| gen/js/snug/compile/emit.mjs:emitProgram | 10740 | 5025 | 1695 | 1521 |
| gen/js/snug/vm/eval.mjs:evalMap | 15244 | 4364 | 1928 | 1777 |
| gen/js/snug/compile/maps.mjs:mapFinish | 8890 | 3414 | 1107 | 1028 |
| gen/js/snug/vm/scont.mjs:mapPair | 7372 | 2946 | 1245 | 1136 |
| gen/js/snug/vm/scont.mjs:tagRun | 6800 | 2804 | 1219 | 1125 |
| gen/js/snug/vm/eval.mjs:evalArray | 8119 | 2725 | 1296 | 1177 |
| gen/js/snug/program/verify.mjs:checkMap | 7362 | 2359 | 892 | 809 |
| gen/js/snug/compile/ctl.mjs:ctlBits | 5284 | 2125 | 877 | 816 |
| gen/js/snug/vm/session.mjs:itemBegin | 5865 | 2067 | 899 | 842 |
| gen/js/snug/program/verify.mjs:checkLeaf | 4212 | 2045 | 714 | 655 |
| gen/js/snug/compile/emit.mjs:assignSections | 4451 | 2012 | 747 | 693 |
| gen/js/snug/vm/eval.mjs:fastChild | 5733 | 1988 | 922 | 853 |
| gen/js/snug/vm/eval.mjs:evalTag | 5005 | 1934 | 956 | 895 |
| gen/js/snug/program/verify.mjs:checkHeader | 3936 | 1930 | 642 | 538 |
| gen/js/snug/compile/ctl.mjs:meet | 3929 | 1914 | 679 | 628 |
| gen/js/snug/compile/lex.mjs:lexNumber | 4920 | 1901 | 745 | 714 |
| gen/js/snug/vm/eval.mjs:mapPairFast | 4895 | 1870 | 827 | 751 |
| gen/js/snug/compile/ctl.mjs:ctlCompare | 4902 | 1796 | 777 | 716 |
| gen/js/snug/compile/ctl.mjs:ctlEq | 4152 | 1748 | 695 | 649 |
| gen/js/snug/vm/eval.mjs:mapStreak | 6353 | 1711 | 995 | 921 |
| gen/js/snug/vm/map.mjs:mapUpdate | 5782 | 1628 | 856 | 795 |
| gen/js/snug/vm/scont.mjs:arrRun | 3957 | 1595 | 785 | 716 |
| gen/js/snug/compile/emit.mjs:checkBus | 3945 | 1581 | 647 | 600 |
| gen/js/snug/vm/eval.mjs:evalItem | 3662 | 1469 | 654 | 593 |
| gen/js/snug/compile/emit.mjs:writeMap | 3074 | 1448 | 530 | 509 |
| gen/js/snug/vm/eval.mjs:embedRun | 3748 | 1394 | 676 | 646 |
| gen/js/snug/compile/lower.mjs:lowerTag | 3020 | 1373 | 584 | 537 |
| gen/js/snug/vm/scont.mjs:openTag | 3399 | 1350 | 748 | 717 |
| gen/js/snug/vm/api.mjs:vmRun | 2709 | 1341 | 634 | 596 |
| gen/js/snug/compile/emit.mjs:shapeSig | 2822 | 1304 | 429 | 397 |
| gen/js/snug/compile/regexp.mjs:rxStore | 2819 | 1280 | 516 | 487 |
| gen/js/snug/compile/emit.mjs:ruleChain | 3005 | 1279 | 610 | 581 |
| gen/js/snug/compile/arrays.mjs:arrFinish | 2596 | 1269 | 471 | 434 |
| gen/js/snug/compile/leaf.mjs:tsMake | 2801 | 1248 | 504 | 473 |

## Hypothetical ablations

Never executed: stubs and constant specialisations estimate size, not validated replacements. Compare each row only with its own entry baseline; see DEVLOG P7.6 for proposed work and constraints.

| Entry | Probe | Min | Gzip-9 | Brotli-11 |
| --- | --- | ---: | ---: | ---: |
| schema | baseline | 124376 | 46042 | 39293 |
| schema | no-sessions | 89834 | 32893 | 28269 |
| schema | no-verifier | 105462 | 39583 | 34088 |
| schema | no-sessions-or-verifier | 70935 | 26496 | 23109 |
| schema | schedule2-only | 124200 | 45972 | 39236 |
| schema | no-force-generic-flag | 124270 | 46006 | 39221 |
| schema | buffer-generic-only | 81889 | 29765 | 25765 |
| schema | buffer-generic-no-verifier | 63079 | 23436 | 20533 |
| schema | no-rare-leaf-helpers | 124085 | 45936 | 39138 |
| schema | long-identifiers | 167084 | 50181 | 42053 |
| runtime | baseline | 147857 | 53452 | 45473 |
| runtime | no-sessions | 113315 | 40458 | 34553 |
| runtime | no-verifier | 128977 | 47207 | 40363 |
| runtime | no-sessions-or-verifier | 94416 | 34126 | 29348 |
| runtime | schedule2-only | 147681 | 53373 | 45435 |
| runtime | no-force-generic-flag | 147751 | 53437 | 45492 |
| runtime | buffer-generic-only | 105411 | 37334 | 32021 |
| runtime | buffer-generic-no-verifier | 86560 | 31061 | 26777 |
| runtime | no-rare-leaf-helpers | 147566 | 53378 | 45468 |
| runtime | long-identifiers | 198070 | 58948 | 49308 |

## Current shared tree after concurrent regeneration

The before/after pair above isolates this task's host import change. Another
engineer subsequently regenerated compiler, verifier and session modules.
Current.json records that later snapshot; budget.json caps these sizes +2%.
No generated files were edited by the size task.

| Entry | Static min | Static gzip | Static brotli | Full min | Full gzip | Full brotli |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| snug | 41238 | 14174 | 12689 | 41238 | 14174 | 12689 |
| snug/schema | 125518 | 46456 | 39604 | 125705 | 46509 | 39790 |
| snug/compile | 2378 | 1243 | 1101 | 251817 | 86871 | 73431 |
| snug/view | 53988 | 18328 | 16334 | 53988 | 18328 | 16334 |
| snug/writer | 37750 | 12996 | 11640 | 37750 | 12996 | 11640 |
| snug/unicode | 19377 | 9287 | 8817 | 19377 | 9287 | 8817 |
| snug/sources | 30415 | 11300 | 10029 | 30415 | 11300 | 10029 |
| runtime | 149000 | 53870 | 45815 | 149202 | 54051 | 46013 |
| all-runtime | 176627 | 63720 | 54145 | 176839 | 63755 | 54203 |

Changed/new isolated modules since the paired after snapshot (imports retained):

| Module | Source | Min | Gzip-9 | Brotli-11 |
| --- | ---: | ---: | ---: | ---: |
| gen/js/snug/compile/arena.mjs | 17421 | 8468 | 3694 | 3035 |
| gen/js/snug/compile/ctl.mjs | 37507 | 12347 | 4530 | 4080 |
| gen/js/snug/compile/emit.mjs | 71216 | 25865 | 9374 | 8231 |
| gen/js/snug/compile/ext.mjs | 6568 | 2340 | 1156 | 1051 |
| gen/js/snug/compile/leaf.mjs | 44146 | 16363 | 5592 | 4987 |
| gen/js/snug/compile/lower.mjs | 52386 | 20180 | 7364 | 6594 |
| gen/js/snug/compile/main.mjs | 15864 | 6906 | 2804 | 2488 |
| gen/js/snug/program/verify.mjs | 65457 | 21992 | 8012 | 6940 |
| gen/js/snug/vm/session.mjs | 20161 | 7907 | 3433 | 3134 |
