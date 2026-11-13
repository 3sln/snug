// Host byte order only; CBOR tag/head decisions remain in the generated writer.
// Copy directly into the output, including on big-endian hosts. The explicit
// byte-order argument lets tests exercise that branch with big-endian fixtures.
export function copyTypedBytes(out, at, raw, size, littleEndian) {
  if (littleEndian || size === 1) { out.set(raw, at); return; }
  for (let i = 0; i < raw.length; i += size) {
    for (let j = 0; j < size; j++) out[at + i + j] = raw[i + size - 1 - j];
  }
}
