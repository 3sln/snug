// `bb check`'s JS arm: run snug.hello's probe on the fixed input and print the
// answers on one line, as host/rust/src/bin/check.rs does.
import { selftest } from '../../gen/js/snug/hello.mjs';
const input = Uint8Array.of(0x80, 0xff, 0x12, 0x34, 0x20, 0x41, 0x00, 0x42);
const out = new Int32Array(64);
const n = selftest(out, input);
console.log(Array.from(out.subarray(0, n)).join(' '));
