// CBOR sequences (RFC 8742; P7.13, architecture §18, D210-D219) on the native host:
// the generated JS session VM as the backend of the shared driver (sequence-core.mjs).
// One session's arrays (scratch, session array, key arena sized for maxMessageBytes)
// serve every message of a reader: vms-init-seq re-initialises them per message.
import { vmScratchWords, vmScratchInit } from '../../../gen/js/snug/vm/api.mjs';
import { vmsWords, vmsArena, vmsStep, vmsStepX, vmsNeedOffset, vmsNeedLength, vmsPosition,
  vmsUnknownTotal, vmsEof, vmsHeldCode, vmsInitSeq, vmsMessageLength } from '../../../gen/js/snug/vm/session.mjs';
import { Program as HostProgram, limitWords } from './schema-core.mjs';
import { schemaPrograms } from './schema-state.mjs';
import { selectOptions } from './options.mjs';
import { resolveLimits } from './limits.mjs';
import { codecTop } from './profiles.mjs';
import { rethrow } from './ext.mjs';
import { mintView } from './view.mjs';
import { ANY_P, ANY_B } from './any-program.mjs';
import { SourceError, pickYield } from './sources.mjs';
import { sequenceApi } from './sequence-core.mjs';

let anyProgram = null;

/** The Program, rule and validation options a sequence's options select (D213): a schema's
 *  rule, or (profile only) the built-in `any` under the decode defaults (D146, D210). */
export function sequenceTarget(options, programOf, anyOf) {
  const { schema, rule, maxMessageBytes } = options;
  if (schema !== undefined) {
    const program = programOf(schema);
    if (!program) throw new TypeError('snug: a sequence schema must be a verified Schema');
    if (typeof rule !== 'string') throw new TypeError('snug: a sequence schema needs a rule');
    const index = program.ruleIndex(rule);
    if (index < 0) throw new TypeError('snug: unknown rule');
    return { program, rule: index, opts: { ...selectOptions(options, 'validation'), maxBytes: maxMessageBytes } };
  }
  if (rule !== undefined) throw new TypeError('snug: a rule needs a schema');
  const limits = resolveLimits({ ...selectOptions(options, 'limits'), maxBytes: maxMessageBytes });
  return { program: anyOf(), rule: 0, opts: { ...selectOptions(options, 'validation'), top: codecTop(options), maxBytes: limits.maxBytes,
    maxDepth: limits.maxDepth, maxEntries: limits.maxEntries, maxItems: limits.maxItems } };
}

function openBackend(options, quantum) {
  const { program, rule, opts } = sequenceTarget(options, s => schemaPrograms.get(s), () => (anyProgram ??= new HostProgram(ANY_P, ANY_B)));
  const words = limitWords(opts), { P, B } = program, ext = program.ext, cap = Math.max(P[16], 1);
  const total = vmsUnknownTotal(P, words);
  const s = new Int32Array(vmScratchWords(P, rule, cap)); vmScratchInit(s, cap);
  const ss = new Int32Array(vmsWords(P)), ka = new Uint8Array(vmsArena(P, words, total)), out = new Int32Array(8 + 2 * 257);
  const backend = {
    total, quantum,
    begin() { const c = vmsInitSeq(P, B, rule, words, s, ss, ka, quantum); if (c < 0) throw new Error(`snug: vms-init-seq answered ${c}`); },
    step(w, base) {
      const r = ext ? vmsStepX(P, B, w, s, ss, ka, out, base, ext.call) : vmsStep(P, B, w, s, ss, ka, out, base);
      if (ext) rethrow(ext);
      return r;
    },
    eof: n => vmsEof(ss, out, n),
    needOffset: () => vmsNeedOffset(ss), needLength: () => vmsNeedLength(ss), position: () => vmsPosition(ss),
    heldCode: () => vmsHeldCode(ss), messageLength: () => vmsMessageLength(ss),
    code: () => out[0],
    result: () => program.result(out.slice(0, 8 + 2 * out[6])),
  };
  return { backend, viewOpts: { ...selectOptions(options, 'validation'), maxBytes: options.maxMessageBytes, schema: options.schema } };
}

export const { readSequence, sequenceReader } = sequenceApi({ openBackend, mint: mintView, SourceError, nextTurn: pickYield().turn });
