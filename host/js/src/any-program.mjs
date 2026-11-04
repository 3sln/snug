// `r = any` compiled with the largest limits (depth 256, input 2^31-1, 2^24 entries
// and items, budget 2^31-1): the VM against it gives the scanner's code, offset and
// items on every input (bb vm-test's profile identity), so an unknown-length
// pushScanner/scanStream (D085) runs it as a drain-mode session. Checked against the
// compiler by host/js/test/stream.test.mjs.
export const ANY_P = Int32Array.of(1735749235, 1, 64, 90, 1, 0, 0, 832251728, 609962750, -1498051372, -824001585, 127061928, -80203144, -2116408444, 1320022552, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, -1, 0, 0, 256, 2147483647,
  16777216, 16777216, 128, 2147483647, 8388608, 0, 1078, 0, 64, 69, 77, 78, 81, 81, 81, 81, 81, 81, 81, 81, 81, 81, 81,
  81, 81, 82, 86, 87, 90, 0, 0, 1, 0, 0, 1078, 1, 4095, 0, 0, 0, 0, 0, 0, 78, 1, 0, 0, 82, 1, 2, 0, 0, 87, 1, 0, 0);
export const ANY_B = Uint8Array.of(114);
export const ANY_LIMITS = { depth: 256, inputBytes: 0x7fffffff, entries: 1 << 24, items: 1 << 24, budget: 0x7fffffff };
