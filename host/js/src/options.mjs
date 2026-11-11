// Host configuration admission only; kin still decides every byte/schema verdict.
const integer = value => Number.isSafeInteger(value) && value >= 0;
const boolean = value => typeof value === 'boolean';
const enumeration = (...values) => value => typeof value === 'string' && values.includes(value);
const limits = { maxBytes: integer, maxDepth: integer, maxEntries: integer, maxItems: integer };
const preset = {
  wire: enumeration('valid', 'deterministic', 'bindle'), keys: enumeration('text', 'integer', 'any'),
  tags: enumeration('bindle', 'standard', 'any'), floats: enumeration('bindle', 'deterministic'),
  undefinedValue: boolean, noncharacters: boolean, top: enumeration('map', 'any'), cose: boolean,
  // Presets can be spread across all runtime operations; strictArrays only affects writing.
  strictArrays: boolean,
};
const decode = { ...preset, ...limits, objects: enumeration('null', 'plain') };
const validation = { ...decode, maxBignumBytes: integer, budget: integer };
const encode = { ...preset, ...limits, objects: decode.objects, omitUndefined: boolean };
// failFast (D085): answer an unknown-length message's certain refusal at once
const scheduling = { quantum: value => integer(value) && value <= 0x7fffffff, failFast: boolean };
const controlsShape = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const schema = value => value !== null && typeof value === 'object' &&
  typeof value.validate === 'function' && typeof value.validateAt === 'function';
const shapes = {
  limits, decode, encode, validation, scheduling,
  span: { ...validation, depth: integer, items: integer },
  writer: { ...encode, keysSorted: boolean, limits: value => checked(value, limits, 'limits') },
  view: { ...validation, schema, rule: value => typeof value === 'string', borrow: boolean, directories: boolean },
  viewSpan: { schema },
  source: { ...scheduling, chunk: value => integer(value) && value > 0 },
  snapshot: { delay: integer },
  // loading a Program: the registry its extension controls need (D141)
  program: { controls: controlsShape },
};

function checked(options, shape, context) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null))
    throw new TypeError(`${context} must be an options object.`);
  for (const key of Reflect.ownKeys(options)) {
    // Do not echo arbitrary unknown names: even an accidental payload-as-options stays private.
    if (typeof key !== 'string' || !Object.hasOwn(shape, key))
      throw new TypeError(`Unknown ${context} key; allowed options: ${Object.keys(shape).join(', ')}.`);
    if (options[key] !== undefined && !shape[key](options[key]))
      throw new TypeError(`Invalid ${context === 'options' ? '' : context + '.'}${key} option.`);
  }
  return true;
}

/** All public option bags use the same strict names/types check; undefined means omitted. */
export function validateOptions(options, kind) {
  checked(options, shapes[kind], 'options');
  return options;
}

/** Forward only the receiving operation's options after validating the outer bag. */
export function selectOptions(options, kind) {
  return Object.fromEntries(Object.keys(shapes[kind]).filter(key => Object.hasOwn(options, key))
    .map(key => [key, options[key]]));
}

/** D213: a CBOR sequence's options (snug/sequence). Its limits are per message, so maxBytes
 *  (ambiguous there) is refused in favour of maxMessageBytes. Built here, lazily, so the
 *  other entries' option tables do not carry it. */
export function validateSequenceOptions(options, stream) {
  const { maxBytes: _perDocument, ...perMessage } = validation;
  const shape = { ...perMessage, maxMessageBytes: integer, schema, rule: value => typeof value === 'string',
    onInvalid: enumeration('stop', 'skip'), copy: enumeration('spanning', 'always'), failFast: boolean };
  if (stream) shape.quantum = scheduling.quantum;
  checked(options, shape, 'options');
  return options;
}

/** Compile admission is separate so runtime entries carry no compiler options. */
export function validateCompileOptions(options) {
  const compileLimits = Object.fromEntries(['schemaBytes', 'nesting', 'astNodes', 'instantiations',
    'alternatives', 'arrayPositions', 'regexpPositions', 'width', 'poolBytes', 'totalBytes',
    'compileBudget', 'leaves', 'depth', 'inputBytes', 'entries', 'items', 'bignumBytes', 'budget']
    .map(name => [name, integer]));
  const shape = { profile: enumeration('full', 'bindle', 'bus'), regexp: enumeration('xsd', 'iregexp'),
    limits: value => checked(value, compileLimits, 'limits'),
    unicode: value => value instanceof Int32Array && !(typeof SharedArrayBuffer === 'function' && value.buffer instanceof SharedArrayBuffer),
    // D141: registered extension controls (checked in full by ext.mjs) and their admission under `bus`
    controls: controlsShape, controlsInBus: boolean };
  checked(options, shape, 'options');
  return options;
}
