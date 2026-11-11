// `r = any` compiled with the largest limits (depth 256, input 2^31-1, 2^24 entries
// and items, budget 2^31-1): the VM against it gives the scanner's code, offset and
// items on every input (bb vm-test's profile identity), so an unknown-length
// pushScanner/scanStream (D085) runs it as a drain-mode session. Checked against the
// compiler by host/js/test/stream.test.mjs.
export const ANY_P = Int32Array.of(1735749235, 2, 64, 90, 1, 0, 0, -1153793131, -1965254075, -798592316, 844469009, -714685243, 702268175, 1552891410,
  1286639795, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1,
  0, 0, 0, 0, 256, 2147483647, 16777216, 16777216, 128, 2147483647, 8388608, 0, 1078, 4194304,
  64, 69, 77, 78, 81, 81, 81, 81, 81, 81, 81, 81, 81, 81,
  81, 81, 81, 82, 86, 87, 0, 0, 0, 1, 0, 0, 1078, 1,
  4095, 0, 0, 0, 0, 0, 0, 78, 1, 0, 0, 82, 1, 2,
  0, 0, 87, 1, 0, 0);
export const ANY_B = Uint8Array.of(114);
export const ANY_LIMITS = { depth: 256, inputBytes: 0x7fffffff, entries: 1 << 24, items: 1 << 24, budget: 0x7fffffff };
