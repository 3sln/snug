// Adapted from 3sln.me packages/core/cbor.mjs (MIT, Copyright (c) 2026 3sln).
export const LIMITS = Object.freeze({
  maxBytes: 1_500_000,
  maxDepth: 32,
  maxEntries: 65_536,
  maxItems: 131_072,
  maxBignumBytes: 128,
  minDecimalExponent: -1024,
  maxDimensions: 8,
});

export const resolveLimits = options => {
  const limits = { ...LIMITS };
  for (const name of ['maxBytes', 'maxDepth', 'maxEntries', 'maxItems']) if (options[name] !== undefined) { if (!Number.isSafeInteger(options[name]) || options[name] < 0) throw new TypeError(`${name} must be a non-negative integer.`); if (name === 'maxDepth' && options[name] > 256) throw new TypeError('maxDepth must be at most 256.'); limits[name] = options[name]; }
  return limits;
};

