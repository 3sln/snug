// CBOR sequences (RFC 8742; P7.13, architecture §18, D210-D219) on the native host:
// the generated JS session VM as the backend of the shared driver (sequence-core.mjs).
// One session's arrays (scratch, session array, key arena sized for maxMessageBytes)
// serve every message of a reader: vms-init-seq re-initialises them per message.
import { vmScratchWords, vmScratchInit } from '../../../gen/js/snug/vm/api.mjs';
import { vmsWords, vmsArena, vmsStepV, vmsGrowWords, vmsGrowBytes, vmsGrowScratch, vmsGrowArena, vmsNeedOffset, vmsNeedLength, vmsPosition,
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
  let s = new Int32Array(vmScratchWords(P, rule, cap)); vmScratchInit(s, cap);
  let ka = new Uint8Array(vmsArena(P, words, total));
  const ss = new Int32Array(vmsWords(P)), out = new Int32Array(8 + 2 * 257);
  // P8.4 (D266): the valid machinery's buffers, grown on VMS_GROW (S and the arena keep their contents)
  let vs = new Int32Array(512), cb = new Uint8Array(1024);
  const noExt = () => -2;
  const backend = {
    total, quantum,
    begin() { const c = vmsInitSeq(P, B, rule, words, s, ss, ka, quantum); if (c < 0) throw new Error(`snug: vms-init-seq answered ${c}`); },
    step(w, base) {
      let r;
      for (;;) {
        r = vmsStepV(P, B, w, s, ss, ka, out, base, ext ? ext.call : noExt, vs, cb);
        if (r !== -69) break;
        const gw = vmsGrowWords(ss), gb = vmsGrowBytes(ss), gs = vmsGrowScratch(ss), ga = vmsGrowArena(ss);
        if (gw > vs.length) vs = new Int32Array(Math.max(gw, 2 * vs.length));
        if (gb > cb.length) cb = new Uint8Array(Math.max(gb, 2 * cb.length));
        if (gs > s.length) { const g = new Int32Array(gs); g.set(s); s = g; }
        if (ga > ka.length) { const g = new Uint8Array(ga); g.set(ka); ka = g; }
      }
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
