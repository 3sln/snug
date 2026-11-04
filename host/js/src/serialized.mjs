// Host-only framing/integrity. Program accept/refuse remains vmVerify's job.
import { sha256 } from './sha256.mjs';
import { SNUG_VERSION } from './version.mjs';

const MAGIC = new TextEncoder().encode('snugprog');
const HEADER = 96, MAX_BODY = 64 * 1024 * 1024;
// Format 1.0 retains the frozen P[1] = 1 spelling. Low 16 bits: major;
// high 16 bits: minor. D084 supersedes §13.3's exact snug-version equality.
// 1.1 (D141) adds extension controls; the compiler writes 1.1 only for a Program using one.
export const FORMAT_MAJOR = 1, FORMAT_MINOR = 1;

export class ProgramError extends Error {
  constructor(code) { super(`snug: Program refused (${code})`); this.name = 'ProgramError'; this.code = code; }
}
const refuse = code => { throw new ProgramError(code); };

function digest(bytes) {
  const preimage = new Uint8Array(bytes.length - 32);
  preimage.set(bytes.subarray(0, 56));
  preimage.set(bytes.subarray(88), 56);
  return sha256(preimage);
}

export function serializeProgram(P, B, version = SNUG_VERSION) {
  if (P.byteLength + B.length > MAX_BODY) refuse('too_large');
  const bytes = new Uint8Array(HEADER + P.byteLength + B.length);
  const d = new DataView(bytes.buffer);
  bytes.set(MAGIC);
  d.setUint32(8, 1, true); d.setUint32(12, P[1], true);
  d.setUint32(16, P.length, true); d.setUint32(20, B.length, true);
  bytes.set(new TextEncoder().encode(version), 24);
  for (let i = 0; i < P.length; i++) d.setInt32(HEADER + i * 4, P[i], true);
  bytes.set(B, HEADER + P.byteLength);
  bytes.set(digest(bytes), 56);
  return bytes;
}

export function parseSerialized(input) {
  if (!(input instanceof Uint8Array)) throw new TypeError('snug: Program bytes must be a Uint8Array');
  if (typeof SharedArrayBuffer === 'function' && input.buffer instanceof SharedArrayBuffer)
    throw new TypeError('snug: copy SharedArrayBuffer input first');
  if (input.length < HEADER) refuse('length');
  if (input.length > HEADER + MAX_BODY) refuse('too_large');
  // Snapshot before verification; Buffer#slice would leave an alias.
  const bytes = new Uint8Array(input), d = new DataView(bytes.buffer);
  if (!MAGIC.every((b, i) => bytes[i] === b)) refuse('magic');
  if (d.getUint32(8, true) !== 1) refuse('container_version');
  const format = d.getUint32(12, true), major = format & 0xffff, minor = format >>> 16;
  if (major !== FORMAT_MAJOR || minor > FORMAT_MINOR) refuse('format_version');
  const words = d.getUint32(16, true), pool = d.getUint32(20, true);
  if (words < 64 || HEADER + 4 * words + pool !== bytes.length) refuse('length');
  // A printable, nonempty ASCII version with canonical NUL padding. It is
  // provenance, not a compatibility gate (D084).
  let end = 24;
  while (end < 56 && bytes[end] >= 0x21 && bytes[end] <= 0x7e) end++;
  if (end === 24 || bytes.subarray(end, 56).some(b => b !== 0)) refuse('version');
  const version = new TextDecoder().decode(bytes.subarray(24, end));
  if (bytes.subarray(88, HEADER).some(b => b !== 0)) refuse('reserved');
  const hash = digest(bytes);
  if (!hash.every((b, i) => b === bytes[56 + i])) refuse('digest');
  const P = new Int32Array(words);
  for (let i = 0; i < words; i++) P[i] = d.getInt32(HEADER + 4 * i, true);
  if (P[1] !== format) refuse('format_version');
  return { P, B: bytes.slice(HEADER + 4 * words), version };
}
