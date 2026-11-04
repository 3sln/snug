// Wire profiles (D081, D120): every option only removes acceptance relative to
// RFC 8949 §4.2.1 core deterministic encoding. A preset names a full set of
// options; any option given explicitly overrides the preset's value. kin
// decides every byte (snug.cbor.codes PF_* flags); this module only resolves
// option objects to those flags.
import { PF_DETERMINISTIC } from '../../../gen/js/snug/cbor/codes.mjs';

const KEYS = { text: 0, integer: 1, any: 2 };
const TAGS = { bindle: 0, standard: 4 };
const FLOATS = { bindle: 0, deterministic: 16 };
const UNDEFINED = 32, NONCHAR = 64;

export const profiles = Object.freeze({
  deterministic: Object.freeze({ wire: 'deterministic', top: 'any', cose: false, keys: 'any', tags: 'standard',
    floats: 'deterministic', undefinedValue: true, noncharacters: true, strictArrays: false }),
  bindle: Object.freeze({ wire: 'bindle', top: 'map', cose: false, keys: 'text', tags: 'bindle', floats: 'bindle',
    undefinedValue: false, noncharacters: false, strictArrays: true }),
});

const BINDLE_FLAGS = 0;
if (PF_DETERMINISTIC !== 118) throw new Error('snug: profile flags out of step with kin');

function presetOf(options) {
  const p = options.wire;
  if (p === undefined || p === 'deterministic') return profiles.deterministic;
  if (p === 'bindle') return profiles.bindle;
  throw new TypeError("wire must be 'deterministic' or 'bindle'.");
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
    return preset === profiles.bindle ? BINDLE_FLAGS : PF_DETERMINISTIC;
  return pick(KEYS, keys ?? preset.keys, 'keys') | pick(TAGS, tags ?? preset.tags, 'tags')
    | pick(FLOATS, floats ?? preset.floats, 'floats')
    | (bool(undefinedValue ?? preset.undefinedValue, 'undefinedValue') ? UNDEFINED : 0)
    | (bool(noncharacters ?? preset.noncharacters, 'noncharacters') ? NONCHAR : 0);
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
export const rfcFloats = flags => (flags & 16) !== 0;
export const undefinedOk = flags => (flags & 32) !== 0;
export const noncharactersOk = flags => (flags & 64) !== 0;
