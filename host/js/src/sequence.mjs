// CBOR sequences (RFC 8742; P7.13, architecture §18, D210-D219) on the native host:
// the generated JS session VM as the backend of the shared driver (sequence-core.mjs).
// One session's arrays (scratch, session array, key arena sized for maxMessageBytes)
// serve every message of a reader: vms-init-seq re-initialises them per message.
import { vmScratchWords, vmScratchInit } from '../../../gen/js/snug/vm/api.mjs';
import { vmsWords, vmsArena, vmsStepV, vmsGrowScratch, vmsGrowArena, vmsNeedOffset, vmsNeedLength, vmsPosition,
  vmsUnknownTotal, vmsEof, vmsHeldCode, vmsInitSeq, vmsMessageLength } from '../../../gen/js/snug/vm/session.mjs';
import { Program as HostProgram, limitWords } from './schema-core.mjs';
import { schemaPrograms } from './schema-state.mjs';
import { selectOptions } from './options.mjs';
import { rethrow } from './ext.mjs';
import { mintView } from './view.mjs';
import { ANY_P, ANY_B } from './any-program.mjs';
import { SourceError, pickYield } from './sources.mjs';
import { withValidBuffers, growValid } from './vm-session.mjs';
import { acquire, release, own } from './session-pool.mjs';
import { sequenceApi, sequenceTarget } from './sequence-core.mjs';

let anyProgram = null;

function openBackend(options, quantum) {
  const { program, rule, opts } = sequenceTarget(options, s => schemaPrograms.get(s), () => (anyProgram ??= new HostProgram(ANY_P, ANY_B)));
  const words = limitWords(opts), { P, B } = program, ext = program.ext, cap = Math.max(P[16], 1);
  const total = vmsUnknownTotal(P, words);
  // P9.7 (D327): one session for the whole reader, its arrays from the Program's pool under the live bound,
  // released when the sequence ends (close) or the reader is collected
  const lease = acquire(program, vmScratchWords(P, rule, cap), vmsWords(P), vmsArena(P, words, total));
  let { s, ka } = lease.e, stepping = false, closing = false;
  const { ss } = lease.e, out = new Int32Array(8 + 2 * 257);
  // D347: once released the arrays are the pool's (another session may hold them): nothing writes them again
  const live = () => { if (lease.e === null) throw new TypeError('snug: the sequence has ended'); };
  vmScratchInit(s, cap);
  const noExt = () => -2;
  // P8.4 (D266): the valid machinery's buffers are the isolate's (D286); S and the arena grow and keep their contents
  const stepIn = (w, base) => {
    const r = withValidBuffers(v => {
      for (;;) {
        const c = vmsStepV(P, B, w, s, ss, ka, out, base, ext ? ext.call : noExt, v.vs, v.cb);
        if (c !== -69) return c;
        growValid(v, ss);
        const gs = vmsGrowScratch(ss), ga = vmsGrowArena(ss);
        if (gs > s.length) { const g = new Int32Array(gs); g.set(s); lease.e.s = s = g; }
        if (ga > ka.length) { const g = new Uint8Array(ga); g.set(ka); lease.e.ka = ka = g; }
      }
    });
    if (ext) rethrow(ext);
    return r;
  };
  const backend = {
    total, quantum,
    // D347: closed from inside its own step (an extension predicate), the reader keeps its arrays until the
    // step has left them
    close() { if (stepping) closing = true; else release(lease); },
    begin() { live(); const c = vmsInitSeq(P, B, rule, words, s, ss, ka, quantum); if (c < 0) throw new Error(`snug: vms-init-seq answered ${c}`); },
    step(w, base) {
      live();
      stepping = true;
      try { return stepIn(w, base); } finally {
        stepping = false;
        if (closing) { release(lease); throw new TypeError('snug: the sequence was closed during its step'); }
      }
    },
    eof: n => { live(); return vmsEof(ss, out, n); },
    needOffset: () => vmsNeedOffset(ss), needLength: () => vmsNeedLength(ss), position: () => vmsPosition(ss),
    heldCode: () => vmsHeldCode(ss), messageLength: () => vmsMessageLength(ss),
    code: () => out[0],
    result: () => program.result(out.slice(0, 8 + 2 * out[6])),
  };
  own(lease, backend);
  return { backend, viewOpts: { ...selectOptions(options, 'validation'), maxBytes: options.maxMessageBytes, schema: options.schema } };
}

export const { readSequence, sequenceReader } = sequenceApi({ openBackend, mint: mintView, SourceError, nextTurn: pickYield().turn });
