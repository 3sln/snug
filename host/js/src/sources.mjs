// Sources for profile validation (P6.1 spike, D027, architecture §17): known-length
// sessions, and (D085, at the end of this file) messages of unknown length in drain
// mode -- pushScanner/pushValidator with no length, streamSource, validateStream,
// scanStream.
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
// (openSession, host/js/src/vm-session.mjs VmSession) driven by the same loops:
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
import { validateOptions } from './options.mjs';
import { scan } from './scan.mjs';
import { profileFlags, codecTop } from './profiles.mjs';
import { scanOptions, scanProfile, codeName } from '../../../gen/js/snug/cbor/scan.mjs';
import { rscanInit, rscanStep, rscanNeedOffset, rscanNeedLength, rscanPosition, rscanScratchLen,
  RS_NEED, RS_YIELD } from '../../../gen/js/snug/cbor/rscan.mjs';
import { Program as HostProgram } from './schema-core.mjs';
import { VmSession } from './vm-session.mjs';
import { openSession } from './open-session.mjs';
export { openSession } from './open-session.mjs';
import { ANY_P, ANY_B } from './any-program.mjs';

export class SourceError extends Error {
  constructor(code, message) { super(message); this.name = 'SourceError'; this.code = code; }
}

const I32_MAX = 0x7fffffff;
const clamp = n => (n > I32_MAX ? I32_MAX : n);
/** How an async driver gives the event loop back after a YIELD: scheduler.yield()
 *  where it exists (browsers), then setImmediate (Node), then a shared MessageChannel
 *  (workers, workerd), setTimeout(0) last -- browsers clamp chained timeouts to >= 4 ms
 *  (P7.7 runtime evidence: Chrome 4.77 ms a yield by setTimeout, 0.010 ms by
 *  MessageChannel). Answers {kind, turn, dispose}. */
export function pickYield(env = globalThis) {
  if (env.scheduler && typeof env.scheduler.yield === 'function') {
    const sch = env.scheduler;
    return { kind: 'scheduler.yield', turn: () => sch.yield(), dispose() {} };
  }
  if (typeof env.setImmediate === 'function') {
    const si = env.setImmediate;
    return { kind: 'setImmediate', turn: () => new Promise(r => si(r)), dispose() {} };
  }
  if (typeof env.MessageChannel === 'function') {
    let channel = null;
    const waiting = [];
    const turn = () => new Promise(r => {
      if (!channel) { channel = new env.MessageChannel(); channel.port1.onmessage = () => { const w = waiting.shift(); if (w) w(); }; }
      waiting.push(r);
      channel.port2.postMessage(0);
    });
    return { kind: 'MessageChannel', turn, dispose() { if (channel) { channel.port1.close(); channel.port2.close(); channel = null; } } };
  }
  const st = env.setTimeout;
  return { kind: 'setTimeout', turn: () => new Promise(r => st(r, 0)), dispose() {} };
}
const nextTurn = pickYield().turn;

/** The buffer fast path: a Uint8Array never goes through a handle. */
export const scanBuffer = scan;

/** One validation session over a message of exactly `length` bytes. */
export class ScanSession {
  constructor(length, options = {}, scheduling = {}) {
    validateOptions(options, 'decode');
    validateOptions(scheduling, 'scheduling');
    const { quantum = 0 } = scheduling;
    if (!Number.isSafeInteger(length) || length < 0 || length > I32_MAX) throw new TypeError('length must be an integer in 0..2^31-1.');
    if (!Number.isSafeInteger(quantum) || quantum < 0) throw new TypeError('quantum must be a non-negative integer.');
    const top = codecTop(options), flags = profileFlags(options);
    const limits = resolveLimits(options);
    this.length = length;
    // P8.4 (D266): valid CBOR, and keys of any kind (EC-sensitive keys' duplicates are not bytewise), are the
    // VM session's against `any` (it gives the scanner's code on every input); the resumable scanner walks the rest
    if ((flags & 256) !== 0 || (flags & 3) >= 2) { this.vm = scanVm(length, options, quantum); this.done = false; return; }
    this.o = new Int32Array(16);
    scanOptions(this.o, top === 'any' ? 1 : 0, options.cose === true ? 1 : 0, clamp(limits.maxBytes), clamp(limits.maxDepth), clamp(limits.maxEntries), clamp(limits.maxItems));
    scanProfile(this.o, flags);
    // Keys are disjoint spans of the message: the arena never needs more than min(length, maxBytes) bytes.
    this.s = new Int32Array(rscanScratchLen(clamp(limits.maxDepth), Math.min(length, clamp(limits.maxBytes))));
    rscanInit(this.o, this.s, length, quantum);
    this.done = false;
  }
  /** Run over `window` (message bytes from `base`). Answers {state:'need', offset, length},
   *  {state:'yield', position} or {state:'done'}; throws SnugFault on a refusal. */
  step(window, base) {
    if (this.vm) {
      const w = this.vm.step(window, base);
      if (w.state !== 'done') return w;
      this.done = true;
      scanResult(w.result);
      return { state: 'done' };
    }
    const r = rscanStep(window, this.o, this.s, 0, base);
    if (r === RS_NEED) return { state: 'need', offset: rscanNeedOffset(this.s), length: rscanNeedLength(this.s) };
    if (r === RS_YIELD) return { state: 'yield', position: rscanPosition(this.s) };
    this.done = true;
    if (r !== 0) throw new SnugFault(codeName(r));
    return { state: 'done' };
  }
  /** Release a VM-backed session's arrays now (P9.7); the resumable scanner's need no release. */
  close() { this.vm?.close(); }
}

/** An immutable in-memory handle (a private snapshot, with independent copied reads). */
export function bufferHandle(bytes) {
  const copy = snapshot(bytes);
  return Object.freeze({ size: copy.length, read: (offset, length) => copy.slice(offset, offset + length) });
}

/** A genuinely asynchronous in-memory handle: every read is a Promise (a microtask, or a
 *  timer of `delay` ms). */
export function asyncHandle(bytes, options = {}) {
  validateOptions(options, 'snapshot');
  const { delay = 0 } = options;
  const copy = snapshot(bytes);
  return Object.freeze({
    size: copy.length,
    // delay 0: resolved on a microtask (a genuine Promise, no timer clamp); delay > 0: a timer
    read: (offset, length) => delay > 0
      ? new Promise(resolve => setTimeout(() => resolve(copy.slice(offset, offset + length)), delay))
      : Promise.resolve().then(() => copy.slice(offset, offset + length)),
  });
}

function snapshot(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array.');
  if (typeof SharedArrayBuffer === 'function' && bytes.buffer instanceof SharedArrayBuffer)
    throw new TypeError('bytes must not use SharedArrayBuffer; copy stable input first.');
  return new Uint8Array(bytes);
}

function checkRead(chunk, offset, length) {
  if (!(chunk instanceof Uint8Array)) throw new SourceError('bad_chunk', 'A handle read must give a Uint8Array.');
  if (chunk.length !== length) throw new SourceError('short_read', `A handle read at ${offset} gave ${chunk.length} of ${length} bytes.`);
  return chunk;
}

function checkHandle(handle) {
  if (!handle || !Number.isSafeInteger(handle.size) || handle.size < 0 || typeof handle.read !== 'function') throw new TypeError('a handle is {size, read(offset, length)}.');
}

function* drive(handle, options, opts = {}) {
  validateOptions(options, 'decode');
  validateOptions(opts, 'source');
  const { chunk = 65536, quantum = 0 } = opts;
  checkHandle(handle);
  return yield* driveSession(new ScanSession(handle.size, options, { quantum }), handle, chunk);
}

function* driveSession(session, handle, chunk) {
  let base = 0, window = new Uint8Array(0);
  let want = { state: 'need', offset: 0, length: Math.min(chunk, handle.size) };
  // a read that fails ends the drive: the session's arrays are released (P9.7)
  try { for (;;) {
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
  } } finally { session.close?.(); }
}

function runAsync(it) {
  return (async () => {
    try {
      let next = it.next();
      while (!next.done) {
        const req = next.value;
        if (req.pause) { await nextTurn(); next = it.next(); continue; }
        let got = req.read();
        if (got && typeof got.then === 'function') got = await got;
        next = it.next(got);
      }
      return next.value;
    } finally { it.return(); }
  })();
}

function runSync(it, what) {
  try {
    let next = it.next();
    while (!next.done) {
      const req = next.value;
      if (req.pause) { next = it.next(); continue; }
      const got = req.read();
      if (got && typeof got.then === 'function') throw new SourceError('bad_chunk', `${what} got a Promise; use its async form.`);
      next = it.next(got);
    }
    return next.value;
  } finally { it.return(); }
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
export async function validateHandle(schema, handle, rule, options = {}, opts = {}) {
  validateOptions(options, 'validation');
  validateOptions(opts, 'source');
  const { chunk = 65536, quantum = 0 } = opts;
  checkHandle(handle);
  return runAsync(driveSession(openSession(schema, rule, handle.size, options, { quantum }), handle, chunk));
}

/** The same through a handle whose read returns bytes synchronously. */
export function validateHandleSync(schema, handle, rule, options = {}, opts = {}) {
  validateOptions(options, 'validation');
  validateOptions(opts, 'source');
  const { chunk = 65536, quantum = 0 } = opts;
  checkHandle(handle);
  return runSync(driveSession(openSession(schema, rule, handle.size, options, { quantum }), handle, chunk), 'validateHandleSync');
}

/** Bytes pushed in order, for a message of a DECLARED length. feed(chunk) answers
 *  {state:'need'} (feed more), {state:'yield'} (call resume() on a later turn) or
 *  {state:'done'}; finalize() checks the declared length was delivered. It holds only
 *  the bytes from the scanner's current position on (bounded by what it asks for). */
export function pushScanner(length, options = {}, scheduling = {}) {
  if (length === undefined) return pushUnknown(scanUnknown(options, scheduling), scheduling, scanResult);
  const session = new ScanSession(length, options, scheduling);
  return pushSession(session, length, want => session.vm ? want.keep : Math.min(want.state === 'need' ? want.offset : want.position, rscanPosition(session.s)));
}

/** Bytes pushed in order for schema validation of a message of a DECLARED length (P6.2):
 *  feed / resume as pushScanner's; finalize() answers Schema.validate's result. It holds
 *  only the bytes from the session's `keep` on. */
export function pushValidator(schema, length, rule, options = {}, scheduling = {}) {
  validateOptions(options, 'validation');
  validateOptions(scheduling, 'scheduling');
  const { failFast, ...sessionScheduling } = scheduling;
  if (length === undefined) return pushUnknown(openSession(schema, rule, undefined, options, sessionScheduling), scheduling, r => r);
  if (failFast !== undefined) throw new TypeError('failFast is for a message of unknown length.');
  return pushSession(openSession(schema, rule, length, options, sessionScheduling), length, want => want.keep);
}

// ---------------------------------------------------------------- unknown length (D085)
//
// A message whose length is not declared: the session runs as a known-length one
// ending at the input limit, holds every check that depends on the end, and settles
// them at EOF (finalize/end) -- or as soon as more bytes than the limit arrive
// (too_large) -- so verdicts are a buffer's of the same bytes. Bytes after a held
// verdict are counted and dropped (drain). failFast answers a certain refusal at once:
// it never accepts what the buffer refuses nor refuses what it accepts, but its code
// may differ (the buffer would say cbor/truncated or cbor/too_large instead).

/** The VM against `any` (largest limits), standing in for the scanner on an
 *  unknown-length message: it gives the scanner's code on every input. */
let anyProgram = null;
function scanUnknown(options, scheduling) {
  validateOptions(options, 'decode');
  validateOptions(scheduling, 'scheduling');
  anyProgram ??= new HostProgram(ANY_P, ANY_B);
  const limits = resolveLimits(options);
  const opts = { ...pick(options, ['wire', 'keys', 'tags', 'floats', 'undefinedValue', 'noncharacters', 'cose']),
    top: codecTop(options), maxBytes: limits.maxBytes, maxDepth: limits.maxDepth,
    maxEntries: limits.maxEntries, maxItems: limits.maxItems };
  return new VmSession(anyProgram, 0, undefined, opts, scheduling.quantum ?? 0);
}
function scanVm(length, options, quantum) {
  anyProgram ??= new HostProgram(ANY_P, ANY_B);
  const limits = resolveLimits(options);
  const opts = { ...pick(options, ['wire', 'keys', 'tags', 'floats', 'undefinedValue', 'noncharacters', 'cose']),
    top: codecTop(options), maxBytes: limits.maxBytes, maxDepth: limits.maxDepth,
    maxEntries: limits.maxEntries, maxItems: limits.maxItems };
  return new VmSession(anyProgram, 0, length, opts, quantum);
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
function scanResult(r) {
  if (r.ok) return true;
  throw new SnugFault(r.reason.startsWith('cbor/') ? r.reason.slice(5) : r.reason);
}

function pushUnknown(session, scheduling, settle) {
  const failFast = scheduling.failFast === true, limit = session.limit;
  let buf = new Uint8Array(4096), bufBase = 0, bufLen = 0, delivered = 0;
  let want = null, result = null, held = false;
  // a settled result releases the session's arrays (P9.7), a fail-fast one before its end too
  const done = r => { result = r; session.close?.(); return { state: 'done', result: r }; };
  const final = s => done(settle(s.result));
  const holds = () => {
    const at = want.state === 'need' ? want.offset : want.position;
    const need = want.state === 'need' ? want.length : 1;
    return at >= bufBase && at + need <= bufBase + bufLen;
  };
  const run = () => {
    for (;;) {
      if (want && !holds()) return { state: 'need' };
      want = session.step(buf.subarray(0, bufLen), bufBase);
      if (want.state === 'done') return final(want);
      if (want.state === 'held') {
        if (failFast && !want.result.ok) return done(settle(want.result));
        held = true; bufLen = 0; bufBase = delivered;
        return { state: 'need' };
      }
      const keep = want.keep;
      if (keep > bufBase) {
        if (keep >= bufBase + bufLen) bufLen = 0;
        else { buf.copyWithin(0, keep - bufBase, bufLen); bufLen -= keep - bufBase; }
        bufBase = keep;
      }
      if (want.state === 'yield') return { state: 'yield' };
    }
  };
  const settleEnd = () => {
    let r = session.end(delivered);
    // the walk was waiting for bytes: it goes on over what it holds, never past the end
    while (r.state === 'yield') r = session.step(buf.subarray(0, bufLen), bufBase);
    if (r.state !== 'done') throw new SourceError('length_mismatch', 'The session asked for bytes past the end.');
    return final(r);
  };
  return guarded(session, {
    feed(chunk) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError('feed expects a Uint8Array.');
      if (result) return { state: 'done', result };
      const start = delivered;
      delivered += chunk.length;
      // more than the input limit: too_large, whatever comes before it
      if (delivered > limit) return settleEnd();
      if (chunk.length === 0) return want && want.state === 'yield' ? { state: 'yield' } : { state: 'need' };  // never EOF
      if (held || bufBase >= delivered) { if (held) bufBase = delivered; return { state: 'need' }; }
      if (bufBase > start) chunk = chunk.subarray(bufBase - start);
      if (bufLen + chunk.length > buf.length) {
        const grown = new Uint8Array(Math.max(buf.length * 2, bufLen + chunk.length));
        grown.set(buf.subarray(0, bufLen)); buf = grown;
      }
      buf.set(chunk, bufLen); bufLen += chunk.length;
      if (want && want.state === 'yield') return { state: 'yield' };
      return run();
    },
    resume() { return result ? { state: 'done', result } : run(); },
    /** Abandon the message: release its session now (P9.7); feeding it afterwards throws. */
    close() { session.close?.(); },
    /** The end of the message (EOF): settles every pending check; answers the result. */
    finalize() {
      if (result) return result;
      if (!held) { const r = run(); if (r.state === 'done') return result; }
      return settleEnd().result;
    },
    end() { return this.finalize(); },
    /** Bytes held now (the window from the session's keep on), for the bounded-memory contract. */
    get bytesHeld() { return bufLen; },
  });
}

/** P9.7: an exception out of a push source ends it: its session is released (else it would hold its
 *  live slot until collected). */
function guarded(session, api) {
  for (const k of ['feed', 'resume', 'finalize']) {
    const f = api[k];
    api[k] = function (...a) { try { return f.apply(this, a); } catch (e) { session.close?.(); throw e; } };
  }
  return api;
}

/** An unknown-length source: a ReadableStream, an AsyncIterable or an Iterable of
 *  Uint8Array chunks, read once, in order, until it ends (its end is the message's). */
export function streamSource(input) {
  if (input && typeof input.getReader === 'function') {
    return Object.freeze({ async *[Symbol.asyncIterator]() {
      const reader = input.getReader();
      try { for (;;) { const { value, done } = await reader.read(); if (done) return; yield value; } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock?.(); }
    } });
  }
  if (input && (typeof input[Symbol.asyncIterator] === 'function' || typeof input[Symbol.iterator] === 'function'))
    return Object.freeze({ async *[Symbol.asyncIterator]() { for await (const value of input) yield value; } });
  throw new TypeError('streamSource takes a ReadableStream, an AsyncIterable or an Iterable of Uint8Array.');
}

async function drainSource(push, source) {
  const src = source && typeof source.getReader === 'function' ? streamSource(source) : source;
  if (!src || typeof src[Symbol.asyncIterator] !== 'function' && typeof src[Symbol.iterator] !== 'function')
    throw new TypeError('a source is a streamSource(), a ReadableStream or an (Async)Iterable of Uint8Array.');
  for await (const chunk of src) {
    if (!(chunk instanceof Uint8Array)) throw new SourceError('bad_chunk', 'A stream chunk must be a Uint8Array.');
    let r = push.feed(chunk);
    while (r.state === 'yield') { await nextTurn(); r = push.resume(); }
    if (r.state === 'done') return r.result;   // early: the rest is not read (the stream is cancelled)
  }
  return push.finalize();
}

/** Validate a message of unknown length from a stream against schema's rule (D085).
 *  opts: { quantum, failFast }. Resolves Schema.validate's result. */
export async function validateStream(schema, source, rule, options = {}, opts = {}) {
  validateOptions(options, 'validation');
  validateOptions(opts, 'scheduling');
  return drainSource(pushValidator(schema, undefined, rule, options, opts), source);
}

/** Profile-check a message of unknown length from a stream (D085). Resolves true or
 *  rejects with SnugFault (the scanner's code) / SourceError. */
export async function scanStream(source, options = {}, opts = {}) {
  validateOptions(options, 'decode');
  validateOptions(opts, 'scheduling');
  return drainSource(pushScanner(undefined, options, opts), source);
}

function pushSession(session, length, keepOf) {
  let buf = new Uint8Array(Math.min(length, 65536)), bufBase = 0, bufLen = 0, delivered = 0;
  let want = null, finished = false;
  const holds = () => {
    const at = want.state === 'need' ? want.offset : want.position;
    // a yield at the message's end (an item expected there: truncated) needs no byte
    const need = want.state === 'need' ? want.length : (at < length ? 1 : 0);
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
  return guarded(session, {
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
    /** Abandon the message: release its session now (P9.7); feeding it afterwards throws. */
    close() { session.close?.(); },
    finalize() {
      if (delivered !== length) throw new SourceError('length_mismatch', `The source delivered ${delivered} of ${length} declared bytes.`);
      while (!finished) {
        const r = run();
        if (r.state === 'need') throw new SourceError('length_mismatch', 'The session needs bytes beyond what was delivered.');
      }
      return want.result ?? true;
    },
  });
}
