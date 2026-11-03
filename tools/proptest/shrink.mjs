// P4.2 minimisers: greedy, deterministic, time-boxed. A candidate is kept
// when the failure predicate still holds (same failure signature).
import { Decimal, NDArray, Float16Bytes } from '../../host/js/src/values.mjs';

/** Greedy fixpoint: repeatedly take the first candidate that still fails. */
export function minimize(input, candidates, fails, { ms = 4000, maxTries = 20000 } = {}) {
  const t0 = performance.now();
  let best = input, tries = 0, progress = true;
  while (progress && performance.now() - t0 < ms && tries < maxTries) {
    progress = false;
    for (const c of candidates(best)) {
      if (++tries > maxTries || performance.now() - t0 > ms) break;
      let f = false;
      try { f = fails(c); } catch { f = false; }
      if (f) { best = c; progress = true; break; }
    }
  }
  return { value: best, tries, ms: Math.round(performance.now() - t0) };
}

/** Byte arrays: drop halves, chunks, single bytes; zero bytes. */
export function* byteCandidates(b) {
  const n = b.length;
  for (let size = n >> 1; size >= 1; size >>= 1)
    for (let at = 0; at + size <= n; at += size) yield Uint8Array.from([...b.subarray(0, at), ...b.subarray(at + size)]);
  for (let i = 0; i < n; i++) if (b[i] !== 0) { const c = Uint8Array.from(b); c[i] = 0; yield c; }
  for (let i = 0; i < n; i++) if (b[i] > 1) { const c = Uint8Array.from(b); c[i] = b[i] >> 1; yield c; }
}

/** CDDL text: drop lines, then balanced token runs, then single tokens; collapse whitespace. */
export function* textCandidates(t) {
  if (typeof t !== 'string') { yield* byteCandidates(t); return; }
  const lines = t.split('\n');
  if (lines.length > 1) for (let i = lines.length - 1; i >= 0; i--) yield [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n');
  const toks = t.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$@][A-Za-z0-9_$@.\-]*|-?\d[\d.xXa-fA-FpPeE+]*|\.\.\.?|=>|\/\/|\/=|\/\/=|\s+|./gsu) ?? [];
  for (let size = Math.max(1, toks.length >> 1); size >= 1; size >>= 1)
    for (let at = 0; at + size <= toks.length; at++) {
      const c = [...toks.slice(0, at), ...toks.slice(at + size)].join('');
      if (c !== t) yield c;
    }
  const squeezed = t.replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();
  if (squeezed !== t) yield squeezed;
}

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) &&
  !(v instanceof Decimal) && !(v instanceof NDArray) && !(v instanceof Float16Bytes) && !(v instanceof Map);

/** Host values: drop entries/elements, replace a child with a simple scalar, recurse. */
export function* valueCandidates(v) {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) yield [...v.slice(0, i), ...v.slice(i + 1)];
    for (let i = 0; i < v.length; i++) for (const c of valueCandidates(v[i])) { const a = [...v]; a[i] = c; yield a; }
    return;
  }
  if (isPlain(v)) {
    const keys = Object.keys(v);
    for (const k of keys) { const o = Object.assign(Object.create(Object.getPrototypeOf(v)), v); delete o[k]; yield o; }
    for (const k of keys) for (const c of valueCandidates(v[k])) { const o = Object.assign(Object.create(Object.getPrototypeOf(v)), v); o[k] = c; yield o; }
    return;
  }
  if (v instanceof Map) {
    for (const k of v.keys()) { const m = new Map(v); m.delete(k); yield m; }
    return;
  }
  for (const s of [0, '', null, false]) if (!Object.is(s, v) && typeof s !== typeof v) yield s;
  if (typeof v === 'string' && v.length > 0) { yield v.slice(0, v.length >> 1); yield v.slice(1); }
  if (typeof v === 'number' && v !== 0) { if (Number.isInteger(v)) yield Math.trunc(v / 2); else yield Math.round(v * 2) / 2 || 0.5; }
  if (typeof v === 'bigint' && v !== 0n) { yield v / 2n; yield Number(BigInt.asIntN(32, v)); }
  if (v instanceof Uint8Array && v.constructor === Uint8Array && v.length) { yield v.subarray(0, v.length >> 1); yield new Uint8Array(0); }
}
