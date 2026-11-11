// Trusted second pass over scanner-approved CBOR (any profile, D123). Invalid
// input is outside this module's contract; all profile decisions belong to the
// scanner. Maps with only text keys become objects, maps with any other key a Map
// (a cose top-level map always); every tag outside the Bindle set becomes Tagged (D180); f7 undefined.
import { TYPED_BY_TAG, decimalValue, ndarrayValue, float16Value, taggedValue, typedInfo } from './values.mjs';
import { LIMITS } from './limits.mjs';
import { fail } from './fault.mjs';

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

class Builder {
  constructor(bytes, options) {
    this.b = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
    this.cose = options.cose === true;
    this.plain = options.objects === 'plain';
  }
  argument(ai) {
    const b = this.b, p = this.pos;
    if (ai < 24) return ai;
    if (ai === 24) { this.pos = p + 1; return b[p]; }
    if (ai === 25) { this.pos = p + 2; return b[p] * 256 + b[p + 1]; }
    if (ai === 26) {
      this.pos = p + 4;
      return b[p] * 16777216 + b[p + 1] * 65536 + b[p + 2] * 256 + b[p + 3];
    }
    this.pos = p + 8;
    const hi = b[p] * 16777216 + b[p + 1] * 65536 + b[p + 2] * 256 + b[p + 3];
    const lo = b[p + 4] * 16777216 + b[p + 5] * 65536 + b[p + 6] * 256 + b[p + 7];
    return hi <= 0x1fffff ? hi * 4294967296 + lo : BigInt(hi) * 4294967296n + BigInt(lo);
  }
  text(n) {
    const start = this.pos, end = start + n;
    this.pos = end;
    // Measured short-ASCII path; Unicode and longer strings use the native decoder.
    if (n <= 8) {
      let s = '';
      for (let i = start; i < end; i++) {
        const c = this.b[i];
        if (c >= 128) return decoder.decode(this.b.subarray(start, end));
        s += String.fromCharCode(c);
      }
      return s;
    }
    return decoder.decode(this.b.subarray(start, end));
  }
  bytes(n) {
    // Uint8Array#slice on a Buffer would retain Buffer's view semantics.
    const out = new Uint8Array(n);
    out.set(this.b.subarray(this.pos, this.pos + n));
    this.pos += n;
    return out;
  }
  item(top = false) {
    const head = this.b[this.pos++], major = head >> 5, ai = head & 31;
    if (major === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      if (ai === 23) return undefined;
      const p = this.pos;
      if (ai === 25) {
        this.pos = p + 2;
        const h = this.b[p] * 256 + this.b[p + 1], exp = (h >>> 10) & 31, frac = h & 1023;
        if (exp === 31) return frac ? NaN : h & 32768 ? -Infinity : Infinity;
        return (h & 32768 ? -1 : 1) * (exp === 0 ? frac * 2 ** -24 : (1 + frac / 1024) * 2 ** (exp - 15));
      }
      if (ai === 26) { this.pos = p + 4; return this.view.getFloat32(p); }
      this.pos = p + 8; return this.view.getFloat64(p);
    }
    const n = this.argument(ai);
    switch (major) {
      case 0: return n;
      case 1: return typeof n === 'number' && n < MAX_SAFE ? -1 - n : -1n - BigInt(n);
      case 2: return this.bytes(n);
      case 3: return this.text(n);
      case 4: {
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = this.item();
        return out;
      }
      case 5: {
        if (top && this.cose) return this.map(n);
        const start = this.pos, b = this.b;
        const out = this.plain ? {} : Object.create(null);
        for (let i = 0; i < n; i++) {
          // A non-text key makes the whole map a Map; text keys sort first only before
          // major 4..7 keys, so the rare restart rebuilds the map in its encoded order.
          if (b[this.pos] >> 5 !== 3) { this.pos = start; return this.map(n); }
          const key = this.item(), value = this.item();
          if (this.plain && key === '__proto__') {
            Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
          } else out[key] = value;
        }
        return out;
      }
      case 6: return this.tag(n);
    }
  }
  map(n) {
    const out = new Map();
    for (let i = 0; i < n; i++) { const key = this.item(); out.set(key, this.item()); }
    // Distinct CBOR keys that are one JS Map key (1 and 1.0, 0 and -0.0): no JS value holds the map (D123).
    if (out.size !== n) fail('unsupported', 'Two map keys decode to the same JavaScript value (such as 1 and 1.0); read this map through a view.');
    return out;
  }
  tag(tag) {
    // Every tag but the Bindle set's own (2, 3, 4, 40, the little-endian typed arrays) is a Tagged (D121, D180).
    if (tag !== 2 && tag !== 3 && tag !== 4 && tag !== 40 && !TYPED_BY_TAG.has(tag)) return taggedValue(tag, this.item());
    if (tag === 4) {
      this.pos++; // scanner proved the two-element array head (canonical: 0x82)
      const exponent = this.item(), mantissa = this.item();
      // D265/D267: a Decimal only for content inside its invariants (the Bindle rule); other valid tag-4 content
      // (RFC 8949 §3.4.4: any integer exponent, any integer or bignum mantissa) stays a Tagged, losslessly.
      if (decimalOk(exponent, mantissa)) return decimalValue(BigInt(mantissa), exponent);
      return taggedValue(4, [exponent, mantissa]);
    }
    if (tag === 40) {
      this.pos++;
      const shape = this.item(), data = this.item();
      if (ndarrayOk(shape, data)) return ndarrayValue(shape, data);
      return taggedValue(40, [shape, data]);
    }
    const n = this.argument(this.b[this.pos++] & 31);
    if (tag === 2 || tag === 3) {
      let value = 0n;
      const end = this.pos + n;
      while (this.pos < end) value = (value << 8n) | BigInt(this.b[this.pos++]);
      return tag === 2 ? value : -1n - value;
    }
    const info = TYPED_BY_TAG.get(tag), bytes = this.bytes(n);
    if (tag === 84 && !info.ctor) return float16Value(bytes);
    if (!littleEndian && info.size > 1) {
      for (let i = 0; i < n; i += info.size) {
        for (let j = 0; j < info.size / 2; j++) {
          const k = i + info.size - 1 - j, tmp = bytes[i + j];
          bytes[i + j] = bytes[k]; bytes[k] = tmp;
        }
      }
    }
    return new info.ctor(bytes.buffer, 0, n / info.size);
  }
}

const decimalOk = (e, m) => typeof e === 'number' && Number.isSafeInteger(e) && e < 0 && e >= LIMITS.minDecimalExponent &&
  (typeof m === 'number' || typeof m === 'bigint') && BigInt(m) !== 0n && BigInt(m) % 10n !== 0n;
const ndarrayOk = (shape, data) => Array.isArray(shape) && shape.length >= 1 && shape.length <= LIMITS.maxDimensions &&
  shape.every(d => Number.isSafeInteger(d) && d > 0) && (Array.isArray(data) || typedInfo(data) !== undefined);

/** Build only after a successful profile scan of these exact bytes and options. */
export function build(bytes, options = {}) {
  return new Builder(bytes, options).item(true);
}
