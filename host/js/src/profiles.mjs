// Wire profiles (D081, D120): every option only removes acceptance relative to
// RFC 8949 §4.2.1 core deterministic encoding. A preset names a full set of
// options; any option given explicitly overrides the preset's value. kin
// decides every byte (snug.cbor.codes PF_* flags); this module only resolves
// option objects to those flags.
import { PF_DETERMINISTIC, PF_VALID, PF_VALID_PRESET } from '../../../gen/js/snug/cbor/codes.mjs';

const KEYS = { text: 0, integer: 1, any: 2 };
const TAGS = { bindle: 0, standard: 4, any: 8 };
const FLOATS = { bindle: 0, deterministic: 16 };
const UNDEFINED = 32, NONCHAR = 64;

export const profiles = Object.freeze({
  // P8.4 (D260): any valid CBOR (RFC 8949 §5.3) -- the deterministic preset's options plus
  // non-deterministic encodings (indefinite lengths, longer heads and floats, keys in any order).
  valid: Object.freeze({ wire: 'valid', top: 'any', cose: false, keys: 'any', tags: 'any',
    floats: 'deterministic', undefinedValue: true, noncharacters: true, strictArrays: false }),
  deterministic: Object.freeze({ wire: 'deterministic', top: 'any', cose: false, keys: 'any', tags: 'any',
    floats: 'deterministic', undefinedValue: true, noncharacters: true, strictArrays: false }),
  bindle: Object.freeze({ wire: 'bindle', top: 'map', cose: false, keys: 'text', tags: 'bindle', floats: 'bindle',
    undefinedValue: false, noncharacters: false, strictArrays: true }),
});

const BINDLE_FLAGS = 0;
if (PF_DETERMINISTIC !== 122 || PF_VALID !== 256 || PF_VALID_PRESET !== 378) throw new Error('snug: profile flags out of step with kin');

// The preset when `wire` is not given (D267).
export const DEFAULT_WIRE = 'valid';
function presetOf(options) {
  const p = options.wire ?? DEFAULT_WIRE;
  if (p === 'valid') return profiles.valid;
  if (p === 'deterministic') return profiles.deterministic;
  if (p === 'bindle') return profiles.bindle;
  throw new TypeError("wire must be 'valid', 'deterministic' or 'bindle'.");
}

function pick(table, value, name) {
  const v = table[value];
  if (v === undefined || !Object.hasOwn(table, value)) throw new TypeError(`${name} must be one of ${Object.keys(table).map(k => `'${k}'`).join(', ')}.`);
  return v;
}
function bool(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean.`);
  return value;
}

/** The kin profile flags (snug.cbor.codes PF_*) for these options. */
export function profileFlags(options) {
  const preset = presetOf(options);
  const { keys, tags, floats, undefinedValue, noncharacters } = options;
  if (keys === undefined && tags === undefined && floats === undefined && undefinedValue === undefined && noncharacters === undefined)
    return preset === profiles.bindle ? BINDLE_FLAGS : preset === profiles.valid ? PF_VALID_PRESET : PF_DETERMINISTIC;
  return pick(KEYS, keys ?? preset.keys, 'keys') | pick(TAGS, tags ?? preset.tags, 'tags')
    | pick(FLOATS, floats ?? preset.floats, 'floats')
    | (bool(undefinedValue ?? preset.undefinedValue, 'undefinedValue') ? UNDEFINED : 0)
    | (bool(noncharacters ?? preset.noncharacters, 'noncharacters') ? NONCHAR : 0)
    | (preset === profiles.valid ? PF_VALID : 0);
}

/** The root policy of the codec, views and profile sources: options.top, else the preset's. */
export function codecTop(options) {
  const top = options.top ?? presetOf(options).top;
  if (top !== 'map' && top !== 'any') throw new TypeError("top must be 'map' or 'any'.");
  return top;
}

/** strictArrays: options.strictArrays, else the preset's. */
export function strictArraysOf(options) {
  return options.strictArrays ?? presetOf(options).strictArrays;
}

// Flag tests for host code (the same bits kin reads).
export const keysOf = flags => flags & 3;          // 0 text, 1 text + integer, 2/3 any
export const standardTags = flags => (flags & 12) !== 0;
export const anyTags = flags => (flags & 12) >= 8;
export const rfcFloats = flags => (flags & 16) !== 0;
export const undefinedOk = flags => (flags & 32) !== 0;
export const noncharactersOk = flags => (flags & 64) !== 0;
export const validOk = flags => (flags & PF_VALID) !== 0;
