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
import { rethrow } from './ext.mjs';
import { mintView } from './view.mjs';
import { ANY_P, ANY_B } from './any-program.mjs';
import { SourceError, pickYield } from './sources.mjs';
import { sequenceApi, sequenceTarget } from './sequence-core.mjs';

let anyProgram = null;

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
