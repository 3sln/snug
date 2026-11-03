// Sources for profile validation (P6.1 spike, D027, architecture §17; scope per
// the s17 review: KNOWN-LENGTH sessions only).
//
//   scanBuffer(bytes, options)            a Uint8Array: the monomorphic fast path,
//                                         the recursive generated scanner directly
//   scanHandle(handle, options, opts)     a random-access handle {size, read(off, len)}
//                                         whose read returns a Uint8Array or a Promise of one
//   scanHandleSync(handle, options, opts) the same for a handle that never returns a Promise
//   pushScanner(length, options, opts)    bytes pushed in order: feed(chunk) ... finalize();
//                                         a verdict may arrive before the last byte (content
//                                         that decides nothing is not read), the remaining
//                                         bytes are still owed to finalize()
//   bufferHandle(bytes), asyncHandle(bytes, {delay})   an immutable in-memory handle, sync
//                                         or genuinely async (each read resolves later)
//
// Schema validation over the same sources (P6.2): the resumable kin VM session
// (Schema.session, host/js/src/schema.mjs VmSession) driven by the same loops:
//
//   validateHandle(schema, handle, rule, options, opts)      handle reads may be Promises
//   validateHandleSync(schema, handle, rule, options, opts)  handle reads are synchronous
//   pushValidator(schema, length, rule, options, opts)       feed(chunk) ... finalize()
//
// each answering Schema.validate's result ({ok: true} or {ok: false, reason, path,
// offset[, subcode]}), identical to the buffer's for every window and quantum (bb
// vmsession-test). A session may ask again for bytes it was given (a byte string read
// twice, a typed array's content tail) but never before its `keep` offset; the push
// source keeps the bytes from there on.
//
// All but scanBuffer drive the RESUMABLE generated scanner (gen/js/snug/cbor/rscan.mjs):
// it consumes a window [base, base + len) of the message and, when it needs other
// bytes, answers NEED(offset, minLength); the driver fetches them and resumes. The
// driver reads only when the scanner asks (backpressure), one read at a time, and
// keeps one window. With a `quantum` the scanner also YIELDs after that much work;
// the async drivers then give the event loop back before resuming. A verdict never
// depends on the source, the window sizes or the quantum (bb rscan-test).
//
// Every session owns its scratch (Int32Arrays allocated here), so interleaved async
// sessions never share state. Refusals throw SnugFault(code) exactly as scan() does;
// a source that breaks its contract (delivers more or fewer bytes than declared, or a
// short read) throws SourceError, which is not a CBOR verdict.
import { SnugFault } from './fault.mjs';
import { resolveLimits } from './limits.mjs';
import { scan } from './scan.mjs';
import { scanOptions, codeName } from '../../../gen/js/snug/cbor/scan.mjs';
import { rscanInit, rscanStep, rscanNeedOffset, rscanNeedLength, rscanPosition, rscanScratchLen,
  RS_NEED, RS_YIELD } from '../../../gen/js/snug/cbor/rscan.mjs';

export class SourceError extends Error {
  constructor(code, message) { super(message); this.name = 'SourceError'; this.code = code; }
}

const I32_MAX = 0x7fffffff;
const clamp = n => (n > I32_MAX ? I32_MAX : n);
const nextTurn = typeof setImmediate === 'function' ? () => new Promise(r => setImmediate(r)) : () => new Promise(r => setTimeout(r, 0));

/** The buffer fast path: a Uint8Array never goes through a handle. */
export const scanBuffer = scan;

/** One validation session over a message of exactly `length` bytes. */
export class ScanSession {
  constructor(length, options = {}, { quantum = 0 } = {}) {
    if (!Number.isSafeInteger(length) || length < 0 || length > I32_MAX) throw new TypeError('length must be an integer in 0..2^31-1.');
    if (!Number.isSafeInteger(quantum) || quantum < 0) throw new TypeError('quantum must be a non-negative integer.');
    const top = options.top ?? 'map'; if (top !== 'map' && top !== 'any') throw new TypeError("top must be 'map' or 'any'.");
    const limits = resolveLimits(options);
    this.length = length;
    this.o = new Int32Array(16);
    scanOptions(this.o, top === 'any' ? 1 : 0, options.cose === true ? 1 : 0, clamp(limits.maxBytes), clamp(limits.maxDepth), clamp(limits.maxEntries), clamp(limits.maxItems));
    // Keys are disjoint spans of the message: the arena never needs more than min(length, maxBytes) bytes.
    this.s = new Int32Array(rscanScratchLen(clamp(limits.maxDepth), Math.min(length, clamp(limits.maxBytes))));
    rscanInit(this.o, this.s, length, quantum);
    this.done = false;
  }
  /** Run over `window` (message bytes from `base`). Answers {state:'need', offset, length},
   *  {state:'yield', position} or {state:'done'}; throws SnugFault on a refusal. */
  step(window, base) {
    const r = rscanStep(window, this.o, this.s, 0, base);
    if (r === RS_NEED) return { state: 'need', offset: rscanNeedOffset(this.s), length: rscanNeedLength(this.s) };
    if (r === RS_YIELD) return { state: 'yield', position: rscanPosition(this.s) };
    this.done = true;
    if (r !== 0) throw new SnugFault(codeName(r));
    return { state: 'done' };
  }
}

/** An immutable in-memory handle (the bytes are copied once). */
export function bufferHandle(bytes) {
  const copy = bytes.slice();
  return { size: copy.length, read: (offset, length) => copy.subarray(offset, offset + length) };
}

/** A genuinely asynchronous in-memory handle: every read resolves on a later turn. */
export function asyncHandle(bytes, { delay = 0 } = {}) {
  const copy = bytes.slice();
  return {
    size: copy.length,
    read: (offset, length) => new Promise(resolve => setTimeout(() => resolve(copy.slice(offset, offset + length)), delay)),
  };
}

function checkRead(chunk, offset, length) {
  if (!(chunk instanceof Uint8Array)) throw new SourceError('bad_chunk', 'A handle read must give a Uint8Array.');
  if (chunk.length !== length) throw new SourceError('short_read', `A handle read at ${offset} gave ${chunk.length} of ${length} bytes.`);
  return chunk;
}

function checkHandle(handle) {
  if (!handle || !Number.isSafeInteger(handle.size) || handle.size < 0 || typeof handle.read !== 'function') throw new TypeError('a handle is {size, read(offset, length)}.');
}

function* drive(handle, options, { chunk = 65536, quantum = 0 } = {}) {
  checkHandle(handle);
  return yield* driveSession(new ScanSession(handle.size, options, { quantum }), handle, chunk);
}

function* driveSession(session, handle, chunk) {
  let base = 0, window = new Uint8Array(0);
  let want = { state: 'need', offset: 0, length: Math.min(chunk, handle.size) };
  for (;;) {
    if (want.state !== 'done') {
      // The window to run over: the cached one if it holds what is asked, else one read.
      const at = want.state === 'need' ? want.offset : want.position;
      const need = want.state === 'need' ? want.length : 1;
      const end = base + window.length;
      if (!(at >= base && at + Math.min(need, handle.size - at) <= end && (at < end || at === handle.size))) {
        const length = Math.min(Math.max(need, chunk), handle.size - at);
        const got = yield { offset: at, length, read: () => handle.read(at, length) };
        base = at; window = checkRead(got, at, length);
      } else if (want.state === 'yield') yield { pause: true };
    }
    want = session.step(window, base);
    if (want.state === 'done') return want.result ?? true;
  }
}

function runAsync(it) {
  return (async () => {
    let next = it.next();
    while (!next.done) {
      const req = next.value;
      if (req.pause) { await nextTurn(); next = it.next(); continue; }
      let got = req.read();
      if (got && typeof got.then === 'function') got = await got;
      next = it.next(got);
    }
    return next.value;
  })();
}

function runSync(it, what) {
  let next = it.next();
  while (!next.done) {
    const req = next.value;
    if (req.pause) { next = it.next(); continue; }
    const got = req.read();
    if (got && typeof got.then === 'function') throw new SourceError('bad_chunk', `${what} got a Promise; use its async form.`);
    next = it.next(got);
  }
  return next.value;
}

/** Validate through a handle whose read may return a Promise. Resolves true or rejects with SnugFault/SourceError. */
export async function scanHandle(handle, options = {}, opts = {}) {
  return runAsync(drive(handle, options, opts));
}

/** Validate through a handle whose read returns bytes synchronously. Returns true or throws. */
export function scanHandleSync(handle, options = {}, opts = {}) {
  return runSync(drive(handle, options, opts), 'scanHandleSync');
}

/** Validate against schema's rule through a handle whose read may return a Promise
 *  (P6.2). Resolves Schema.validate's result, or rejects with SourceError. */
export async function validateHandle(schema, handle, rule, options = {}, { chunk = 65536, quantum = 0 } = {}) {
  checkHandle(handle);
  return runAsync(driveSession(schema.session(rule, handle.size, options, { quantum }), handle, chunk));
}

/** The same through a handle whose read returns bytes synchronously. */
export function validateHandleSync(schema, handle, rule, options = {}, { chunk = 65536, quantum = 0 } = {}) {
  checkHandle(handle);
  return runSync(driveSession(schema.session(rule, handle.size, options, { quantum }), handle, chunk), 'validateHandleSync');
}

/** Bytes pushed in order, for a message of a DECLARED length. feed(chunk) answers
 *  {state:'need'} (feed more), {state:'yield'} (call resume() on a later turn) or
 *  {state:'done'}; finalize() checks the declared length was delivered. It holds only
 *  the bytes from the scanner's current position on (bounded by what it asks for). */
export function pushScanner(length, options = {}, { quantum = 0 } = {}) {
  const session = new ScanSession(length, options, { quantum });
  return pushSession(session, length, want => Math.min(want.state === 'need' ? want.offset : want.position, rscanPosition(session.s)));
}

/** Bytes pushed in order for schema validation of a message of a DECLARED length (P6.2):
 *  feed / resume as pushScanner's; finalize() answers Schema.validate's result. It holds
 *  only the bytes from the session's `keep` on. */
export function pushValidator(schema, length, rule, options = {}, { quantum = 0 } = {}) {
  return pushSession(schema.session(rule, length, options, { quantum }), length, want => want.keep);
}

function pushSession(session, length, keepOf) {
  let buf = new Uint8Array(Math.min(length, 65536)), bufBase = 0, bufLen = 0, delivered = 0;
  let want = null, finished = false;
  const holds = () => {
    const at = want.state === 'need' ? want.offset : want.position;
    const need = want.state === 'need' ? want.length : 1;
    return at >= bufBase && at + need <= bufBase + bufLen;
  };
  const run = () => {
    for (;;) {
      if (want && want.state !== 'done' && !holds()) return { state: 'need' };
      want = session.step(buf.subarray(0, bufLen), bufBase);
      if (want.state === 'done') { finished = true; return want; }
      // Drop what precedes the earliest byte the session may still ask for.
      // (A skipped byte string can put that beyond what has arrived: then the
      // buffer empties and the bytes up to it are dropped as they arrive.)
      const keep = keepOf(want);
      if (keep > bufBase) {
        if (keep >= bufBase + bufLen) bufLen = 0;
        else { buf.copyWithin(0, keep - bufBase, bufLen); bufLen -= keep - bufBase; }
        bufBase = keep;
      }
      if (want.state === 'yield') return { state: 'yield' };
    }
  };
  return {
    feed(chunk) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError('feed expects a Uint8Array.');
      if (delivered + chunk.length > length) throw new SourceError('length_mismatch', 'More bytes were pushed than the declared length.');
      const start = delivered;
      delivered += chunk.length;
      // A verdict can come before the last byte arrives (a byte string's content is
      // never read); the rest is still owed, and counted, for finalize().
      if (finished) return want;
      if (chunk.length === 0) return want && want.state === 'yield' ? { state: 'yield' } : { state: 'need' };  // never EOF
      if (bufBase >= delivered) return { state: 'need' };  // all of it is skipped content
      if (bufBase > start) chunk = chunk.subarray(bufBase - start);
      if (bufLen + chunk.length > buf.length) {
        const grown = new Uint8Array(Math.max(buf.length * 2, bufLen + chunk.length));
        grown.set(buf.subarray(0, bufLen)); buf = grown;
      }
      buf.set(chunk, bufLen); bufLen += chunk.length;
      if (want && want.state === 'yield') return { state: 'yield' };
      return run();
    },
    resume() { return finished ? want : run(); },
    finalize() {
      if (delivered !== length) throw new SourceError('length_mismatch', `The source delivered ${delivered} of ${length} declared bytes.`);
      while (!finished) {
        const r = run();
        if (r.state === 'need') throw new SourceError('length_mismatch', 'The session needs bytes beyond what was delivered.');
      }
      return want.result ?? true;
    },
  };
}
