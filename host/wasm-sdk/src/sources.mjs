// P7.9: `snug/sources` over wasm: the native module's surface (D108, D146,
// D160) with every session's state in linear memory. Each session (rscan
// scratch, or the vms scratch/session/key arena) has a window buffer of its own:
//
//   handles  each read is copied once into the session's window; re-asked
//            bytes inside it are not copied again
//   push     chunks are appended to the session's window in linear memory and
//            the kept tail compacted there (no JS-side buffer at all), for a
//            declared length and (D085, D173) for an unknown one: drain mode,
//            held verdicts settled at end(n), failFast
//
// Unknown-length profile scanning runs the VM's drain session against the
// built-in `r = any` Program (D146), loaded into wasm like any other. Sessions
// are freed at their verdict, or by a FinalizationRegistry when abandoned. The
// drivers are the native ones (same yield primitive choice, same contracts and
// option validation); `openSession` is the advanced window protocol (D160).
import * as rt from './runtime.mjs';
import { SnugFault } from '../../js/src/fault.mjs';
import { resolveLimits } from '../../js/src/limits.mjs';
import { validateOptions } from '../../js/src/options.mjs';
import { profileFlags, codecTop } from '../../js/src/profiles.mjs';
import { rethrow } from '../../js/src/ext.mjs';
import { ANY_P, ANY_B } from '../../js/src/any-program.mjs';
import { innerOf, limitArgs, Program } from './schema.mjs';
import { scan } from './index.mjs';

export class SourceError extends Error {
  constructor(code, message) { super(message); this.name = 'SourceError'; this.code = code; }
}
const I32_MAX = 0x7fffffff;
const clamp = n => (n > I32_MAX ? I32_MAX : n);
const RS_NEED = -1, RS_YIELD = -2, VMS_NEED = -64, VMS_YIELD = -65, VMS_HELD = -67, VMS_RESUME = -68;

export function pickYield(env = globalThis) {
  if (env.scheduler && typeof env.scheduler.yield === 'function') { const sch = env.scheduler; return { kind: 'scheduler.yield', turn: () => sch.yield(), dispose() {} }; }
  if (typeof env.setImmediate === 'function') { const si = env.setImmediate; return { kind: 'setImmediate', turn: () => new Promise(r => si(r)), dispose() {} }; }
  if (typeof env.MessageChannel === 'function') {
    let channel = null; const waiting = [];
    const turn = () => new Promise(r => {
      if (!channel) { channel = new env.MessageChannel(); channel.port1.onmessage = () => { const w = waiting.shift(); if (w) w(); }; }
      waiting.push(r); channel.port2.postMessage(0);
    });
    return { kind: 'MessageChannel', turn, dispose() { if (channel) { channel.port1.close(); channel.port2.close(); channel = null; } } };
  }
  const st = env.setTimeout;
  return { kind: 'setTimeout', turn: () => new Promise(r => st(r, 0)), dispose() {} };
}
const nextTurn = pickYield().turn;

const sessions = new FinalizationRegistry(({ h, gen }) => { if (gen === rt.generation && rt.x) rt.x.sdk_ses_free(h); });

/** Common to both kinds: the handle, its window in linear memory, and the step. */
class WasmSession {
  constructor(h) {
    if (h < 0) throw new Error(`snug wasm: session refused (${h})`);
    this.h = h; this.gen = rt.generation; this.wp = 0; this.wcap = 0; this.done = false;
    this.token = {}; sessions.register(this, { h, gen: this.gen }, this.token);
    this.lastWindow = null; this.lastLen = -1; this.lastBase = -1;
  }
  free() { if (this.h >= 0) { if (this.gen === rt.generation) rt.x.sdk_ses_free(this.h); sessions.unregister(this.token); this.h = -1; } }
  live() { if (this.h < 0 || this.gen !== rt.generation) throw new Error('snug wasm: the session is finished or its instance was reset'); }
  /** The window buffer, at least n bytes (contents kept): its pointer. */
  window(n) {
    this.live();
    if (n > this.wcap) { this.wcap = Math.max(n, 2 * this.wcap); this.wp = rt.x.sdk_ses_window(this.h, this.wcap) >>> 0; rt.refresh(); this.lastWindow = null; }
    return this.wp;
  }
  /** Copy a JS window in unless it is the one already there. */
  load(window) {
    if (window === this.lastWindow && window.length === this.lastLen) return;
    const p = this.window(window.length);
    rt.u8.set(window, p);
    this.lastWindow = window; this.lastLen = window.length;
  }
  raw(n, base) {
    this.live();
    let r;
    try { r = rt.withExt(this.ext ?? null, () => rt.x.sdk_ses_step(this.h, n, base)); }
    catch (e) { this.h = -1; rt.lost(e); }
    rt.refresh();   // a step may grow memory (key arena copies, the EXT window): re-derive the views first
    return r;
  }
  info(i) { return rt.i32[rt.INFO + i]; }
}

export class ScanSession extends WasmSession {
  constructor(length, options = {}, scheduling = {}) {
    validateOptions(options, 'decode');
    validateOptions(scheduling, 'scheduling');
    const { quantum = 0 } = scheduling;
    if (!Number.isSafeInteger(length) || length < 0 || length > I32_MAX) throw new TypeError('length must be an integer in 0..2^31-1.');
    if (!Number.isSafeInteger(quantum) || quantum < 0) throw new TypeError('quantum must be a non-negative integer.');
    const top = codecTop(options), flags = profileFlags(options);
    const limits = resolveLimits(options);
    rt.ready();
    super(rt.x.sdk_rs_new(length, clamp(quantum), top === 'any' ? 1 : 0, options.cose === true ? 1 : 0, clamp(limits.maxBytes),
      clamp(limits.maxDepth), clamp(limits.maxEntries), clamp(limits.maxItems), flags));
    rt.refresh();
    this.length = length;
  }
  step(window, base) { this.load(window); return this.stepIn(window.length, base); }
  /** Step over the first n bytes already in the session window. */
  stepIn(n, base) {
    const r = this.raw(n, base);
    if (r === RS_NEED) return { state: 'need', offset: this.info(0), length: this.info(1) };
    if (r === RS_YIELD) return { state: 'yield', position: this.info(2) };
    this.done = true; this.free();
    if (r !== 0) throw new SnugFault(rt.codeName(r));
    return { state: 'done' };
  }
  position() { return this.info(2); }
}

/** The host session over a Program's inner state (native vm-session.mjs's contract): a declared length, or
 *  (length undefined, D085) an unknown one in drain mode. */
class VmSession extends WasmSession {
  constructor(inner, rule, length, opts = {}, quantum = 0) {
    const unknown = length === undefined;
    if (!unknown && (!Number.isSafeInteger(length) || length < 0 || length > I32_MAX)) throw new TypeError('snug: length must be an integer in 0..2^31-1');
    if (!Number.isSafeInteger(quantum) || quantum < 0 || quantum > I32_MAX) throw new TypeError('snug: quantum must be a non-negative integer');
    if (!Number.isInteger(rule) || rule < 0 || rule >= inner.P[15]) throw new TypeError('snug: rule index out of range');
    let h;
    try { h = rt.x.sdk_vs_new(inner.handle(), rule, unknown ? -1 : length, quantum, ...limitArgs(opts)); }
    catch (e) { rt.lost(e); }
    rt.refresh();
    super(h);
    this.limit = unknown ? this.info(0) : undefined;
    this.inner = inner; this.ext = inner.ext; this.length = length; this.verdict = null; this.dead = null;
  }
  /** Linear-memory bytes this session holds (its window; the kin arrays are not observable from JS). */
  get bytesHeld() { return this.wcap; }
  step(window, base) {
    if (this.verdict) return this.verdict;
    if (!(window instanceof Uint8Array)) throw new TypeError('snug: a window is a Uint8Array');
    this.load(window);
    return this.stepIn(window.length, base);
  }
  stepIn(n, base) {
    if (this.verdict) return this.verdict;
    if (this.dead) throw this.dead;
    const r = this.raw(n, base);
    // a predicate that threw voids the session (its walk went on with a false verdict)
    try { rethrow(this.ext); } catch (e) { this.dead = e; this.free(); throw e; }
    if (r === VMS_NEED) return { state: 'need', offset: this.info(0), length: this.info(1), keep: this.info(3) };
    if (r === VMS_YIELD) return { state: 'yield', position: this.info(2), keep: this.info(3) };
    if (r === VMS_HELD) return { state: 'held', result: this.inner.result() };
    if (r < 0) throw new Error(`snug wasm: vms-step answered ${r}`);
    this.verdict = { state: 'done', result: this.inner.result() };
    this.free();
    return this.verdict;
  }
  /** D085: the end of an unknown-length message after n bytes. */
  end(n) {
    if (this.verdict) return this.verdict;
    if (this.length !== undefined) throw new TypeError('snug: end() is for a session of unknown length');
    if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('snug: end(n) takes the byte count');
    this.live();
    let r;
    try { r = rt.x.sdk_ses_eof(this.h, Math.min(n, I32_MAX)); } catch (e) { this.h = -1; rt.lost(e); }
    rt.refresh();
    if (r === VMS_RESUME) return { state: 'yield', position: this.info(2), keep: this.info(3) };
    if (r < 0) throw new Error(`snug wasm: vms-eof answered ${r}`);
    this.verdict = { state: 'done', result: this.inner.result() };
    this.free();
    return this.verdict;
  }
}

/** The advanced window protocol (D160): a frozen facade, as the native openSession's. */
class PublicSession {
  #host;
  constructor(host) { this.#host = host; Object.freeze(this); }
  get length() { return this.#host.length; }
  /** An unknown-length session's input limit (more bytes is too_large); undefined otherwise. */
  get limit() { return this.#host.limit; }
  get bytesHeld() { return this.#host.bytesHeld; }
  step(window, base) {
    bytesInput(window);
    const bound = this.length ?? this.limit;
    if (!Number.isSafeInteger(base) || base < 0 || base + window.length > bound) throw new TypeError('snug: invalid window span');
    return this.#host.step(window, base);
  }
  /** D085: the end of an unknown-length message (n bytes). */
  end(n) { return this.#host.end(n); }
  /** Internal (the push drivers): the host session, stepping over its own window. */
  static host(s) { return s.#host; }
}
function bytesInput(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('snug: bytes must be a Uint8Array');
  if (typeof SharedArrayBuffer === 'function' && bytes.buffer instanceof SharedArrayBuffer) throw new TypeError('snug: copy SharedArrayBuffer input first');
}

/** Advanced synchronous session over a verified schema (D160). */
export function openSession(schema, rule, length, options = {}, scheduling = {}) {
  const inner = schema && schema.program ? innerOf(schema.program) : undefined;
  if (!inner) throw new TypeError('snug: openSession needs a verified Schema');
  if (typeof rule !== 'string') throw new TypeError('snug: rule must be a string');
  const index = inner.ruleIndex(rule);
  if (index < 0) throw new TypeError('snug: unknown rule');
  validateOptions(options, 'validation');
  validateOptions(scheduling, 'scheduling');
  rt.ready();
  return new PublicSession(new VmSession(inner, index, length, options, scheduling.quantum ?? 0));
}

export const scanBuffer = scan;
/** An immutable in-memory handle (a private snapshot, with independent copied reads; D151). */
export function bufferHandle(bytes) {
  const copy = snapshot(bytes);
  return Object.freeze({ size: copy.length, read: (offset, length) => copy.slice(offset, offset + length) });
}
export function asyncHandle(bytes, options = {}) {
  validateOptions(options, 'snapshot');
  const { delay = 0 } = options;
  const copy = snapshot(bytes);
  return Object.freeze({ size: copy.length, read: (offset, length) => delay > 0
    ? new Promise(resolve => setTimeout(() => resolve(copy.slice(offset, offset + length)), delay))
    : Promise.resolve().then(() => copy.slice(offset, offset + length)) });
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

function* driveSession(session, handle, chunk) {
  let base = 0, window = new Uint8Array(0);
  let want = { state: 'need', offset: 0, length: Math.min(chunk, handle.size) };
  try {
    for (;;) {
      if (want.state !== 'done') {
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
  } finally { session.free(); }
}
function runAsync(it) {
  return (async () => {
    let next = it.next();
    while (!next.done) {
      const req = next.value;
      if (req.pause) { await nextTurn(); next = it.next(); continue; }
      let got;
      try { got = req.read(); if (got && typeof got.then === 'function') got = await got; }
      catch (e) { next = it.throw(e); continue; }
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
    let got;
    try { got = req.read(); } catch (e) { it.return(); throw e; }
    if (got && typeof got.then === 'function') { it.return(); throw new SourceError('bad_chunk', `${what} got a Promise; use its async form.`); }
    next = it.next(got);
  }
  return next.value;
}
/** P8.4 (D266): valid CBOR, and keys of any kind (EC-sensitive keys' duplicates are not bytewise), are the VM
 *  session's against `any` (it gives the scanner's code on every input), as in the native package; the resumable
 *  scanner walks the rest. */
function scanSession(length, options, scheduling) {
  validateOptions(options, 'decode');
  validateOptions(scheduling, 'scheduling');
  const flags = profileFlags(options);
  if ((flags & 256) !== 0 || (flags & 3) >= 2) return new ScanVm(length, options, scheduling);
  return new ScanSession(length, options, scheduling);
}
class ScanVm extends VmSession {
  constructor(length, options = {}, scheduling = {}) {
    validateOptions(options, 'decode');
    validateOptions(scheduling, 'scheduling');
    const { quantum = 0 } = scheduling;
    if (!Number.isSafeInteger(length) || length < 0 || length > I32_MAX) throw new TypeError('length must be an integer in 0..2^31-1.');
    if (!Number.isSafeInteger(quantum) || quantum < 0) throw new TypeError('quantum must be a non-negative integer.');
    rt.ready();
    anyProgram ??= innerOf(new Program(ANY_P, ANY_B));
    super(anyProgram, 0, length, scanOpts(options), quantum);
    this.scanning = true;
  }
  stepIn(n, base) {
    const w = super.stepIn(n, base);
    if (w.state !== 'done') return w;
    this.done = true;
    scanResult(w.result);
    return { state: 'done' };
  }
  step(window, base) {
    if (!(window instanceof Uint8Array)) throw new TypeError('snug: a window is a Uint8Array');
    this.load(window);
    return this.stepIn(window.length, base);
  }
}
function scanOpts(options) {
  const limits = resolveLimits(options);
  return { ...pick(options, ['wire', 'keys', 'tags', 'floats', 'undefinedValue', 'noncharacters', 'cose']),
    top: codecTop(options), maxBytes: limits.maxBytes, maxDepth: limits.maxDepth,
    maxEntries: limits.maxEntries, maxItems: limits.maxItems };
}

function scanDrive(handle, options, opts) {
  validateOptions(options, 'decode');
  validateOptions(opts, 'source');
  const { chunk = 65536, quantum = 0 } = opts;
  checkHandle(handle);
  return driveSession(scanSession(handle.size, options, { quantum }), handle, chunk);
}
function vmDrive(schema, handle, rule, options, opts) {
  validateOptions(options, 'validation');
  validateOptions(opts, 'source');
  const { chunk = 65536, quantum = 0 } = opts;
  checkHandle(handle);
  return driveSession(PublicSession.host(openSession(schema, rule, handle.size, options, { quantum })), handle, chunk);
}

export async function scanHandle(handle, options = {}, opts = {}) { return runAsync(scanDrive(handle, options, opts)); }
export function scanHandleSync(handle, options = {}, opts = {}) { return runSync(scanDrive(handle, options, opts), 'scanHandleSync'); }
export async function validateHandle(schema, handle, rule, options = {}, opts = {}) { return runAsync(vmDrive(schema, handle, rule, options, opts)); }
export function validateHandleSync(schema, handle, rule, options = {}, opts = {}) { return runSync(vmDrive(schema, handle, rule, options, opts), 'validateHandleSync'); }

export function pushScanner(length, options = {}, scheduling = {}) {
  if (length === undefined) return pushUnknown(scanUnknown(options, scheduling), scheduling, scanResult);
  const session = scanSession(length, options, scheduling);
  return pushSession(session, length, want => session.scanning ? want.keep : Math.min(want.state === 'need' ? want.offset : want.position, session.position()));
}
export function pushValidator(schema, length, rule, options = {}, scheduling = {}) {
  validateOptions(options, 'validation');
  validateOptions(scheduling, 'scheduling');
  const { failFast, ...sessionScheduling } = scheduling;
  if (length === undefined) return pushUnknown(PublicSession.host(openSession(schema, rule, undefined, options, sessionScheduling)), scheduling, r => r);
  if (failFast !== undefined) throw new TypeError('failFast is for a message of unknown length.');
  return pushSession(PublicSession.host(openSession(schema, rule, length, options, sessionScheduling)), length, want => want.keep);
}

// ---------------------------------------------------------------- unknown length (D085, D173)

let anyProgram = null;
/** The VM against `any` (largest limits), standing in for the scanner on an unknown-length message (D146). */
function scanUnknown(options, scheduling) {
  validateOptions(options, 'decode');
  validateOptions(scheduling, 'scheduling');
  rt.ready();
  anyProgram ??= innerOf(new Program(ANY_P, ANY_B));
  const limits = resolveLimits(options);
  const opts = { ...pick(options, ['wire', 'keys', 'tags', 'floats', 'undefinedValue', 'noncharacters', 'cose']),
    top: codecTop(options), maxBytes: limits.maxBytes, maxDepth: limits.maxDepth,
    maxEntries: limits.maxEntries, maxItems: limits.maxItems };
  return new VmSession(anyProgram, 0, undefined, opts, scheduling.quantum ?? 0);
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
function scanResult(r) {
  if (r.ok) return true;
  throw new SnugFault(r.reason.startsWith('cbor/') ? r.reason.slice(5) : r.reason);
}

/** The native unknown-length push protocol, its buffer being the session's window in linear memory. */
function pushUnknown(session, scheduling, settle) {
  const failFast = scheduling.failFast === true, limit = session.limit;
  let cap = 4096, bufBase = 0, bufLen = 0, delivered = 0;
  session.window(cap);
  let want = null, result = null, held = false;
  // free the session BEFORE settling: a scan's settle throws its refusal (linear memory is not the GC's)
  const done = r => { result = r; return { state: 'done', result: r }; };
  const final = s => { session.free(); return done(settle(s.result)); };
  const holds = () => {
    const at = want.state === 'need' ? want.offset : want.position;
    const need = want.state === 'need' ? want.length : 1;
    return at >= bufBase && at + need <= bufBase + bufLen;
  };
  const run = () => {
    for (;;) {
      if (want && !holds()) return { state: 'need' };
      want = session.stepIn(bufLen, bufBase);
      if (want.state === 'done') return final(want);
      if (want.state === 'held') {
        if (failFast && !want.result.ok) return final(want);
        held = true; bufLen = 0; bufBase = delivered;
        return { state: 'need' };
      }
      const keep = want.keep;
      if (keep > bufBase) {
        if (keep >= bufBase + bufLen) bufLen = 0;
        else { const p = session.wp; rt.u8.copyWithin(p, p + keep - bufBase, p + bufLen); bufLen -= keep - bufBase; }
        bufBase = keep;
      }
      if (want.state === 'yield') return { state: 'yield' };
    }
  };
  const settleEnd = () => {
    let r = session.end(delivered);
    while (r.state === 'yield') r = session.stepIn(bufLen, bufBase);
    if (r.state !== 'done') { session.free(); throw new SourceError('length_mismatch', 'The session asked for bytes past the end.'); }
    return final(r);
  };
  return {
    feed(chunk) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError('feed expects a Uint8Array.');
      if (result) return { state: 'done', result };
      session.live();   // never write a stale pointer into a new instance's memory
      const start = delivered;
      delivered += chunk.length;
      if (delivered > limit) return settleEnd();
      if (chunk.length === 0) return want && want.state === 'yield' ? { state: 'yield' } : { state: 'need' };
      if (held || bufBase >= delivered) { if (held) bufBase = delivered; return { state: 'need' }; }
      if (bufBase > start) chunk = chunk.subarray(bufBase - start);
      if (bufLen + chunk.length > cap) { cap = Math.max(cap * 2, bufLen + chunk.length); session.window(cap); }
      rt.u8.set(chunk, session.wp + bufLen); bufLen += chunk.length;
      if (want && want.state === 'yield') return { state: 'yield' };
      return run();
    },
    resume() { return result ? { state: 'done', result } : run(); },
    finalize() {
      if (result) return result;
      if (!held) { const r = run(); if (r.state === 'done') return result; }
      return settleEnd().result;
    },
    end() { return this.finalize(); },
    get bytesHeld() { return bufLen; },
  };
}

/** An unknown-length source: a ReadableStream, an AsyncIterable or an Iterable of Uint8Array chunks. */
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
    if (r.state === 'done') return r.result;
  }
  return push.finalize();
}
/** Validate a message of unknown length from a stream against schema's rule (D085). opts: { quantum, failFast }. */
export async function validateStream(schema, source, rule, options = {}, opts = {}) {
  validateOptions(options, 'validation');
  validateOptions(opts, 'scheduling');
  return drainSource(pushValidator(schema, undefined, rule, options, opts), source);
}
/** Profile-check a message of unknown length from a stream (D085). */
export async function scanStream(source, options = {}, opts = {}) {
  validateOptions(options, 'decode');
  validateOptions(opts, 'scheduling');
  return drainSource(pushScanner(undefined, options, opts), source);
}

/** The native push protocol for a declared length, with its buffer being the session's window in linear memory. */
function pushSession(session, length, keepOf) {
  let cap = Math.min(length, 65536), bufBase = 0, bufLen = 0, delivered = 0;
  session.window(cap);
  let want = null, finished = false;
  const holds = () => {
    const at = want.state === 'need' ? want.offset : want.position;
    const need = want.state === 'need' ? want.length : (at < length ? 1 : 0);
    return at >= bufBase && at + need <= bufBase + bufLen;
  };
  const run = () => {
    for (;;) {
      if (want && want.state !== 'done' && !holds()) return { state: 'need' };
      want = session.stepIn(bufLen, bufBase);
      if (want.state === 'done') { finished = true; return want; }
      const keep = keepOf(want);
      if (keep > bufBase) {
        if (keep >= bufBase + bufLen) bufLen = 0;
        else { const p = session.wp; rt.u8.copyWithin(p, p + keep - bufBase, p + bufLen); bufLen -= keep - bufBase; }
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
      if (finished) return want;
      session.live();   // never write a stale pointer into a new instance's memory
      if (chunk.length === 0) return want && want.state === 'yield' ? { state: 'yield' } : { state: 'need' };
      if (bufBase >= delivered) return { state: 'need' };
      if (bufBase > start) chunk = chunk.subarray(bufBase - start);
      if (bufLen + chunk.length > cap) { cap = Math.max(cap * 2, bufLen + chunk.length); session.window(cap); }
      rt.u8.set(chunk, session.wp + bufLen); bufLen += chunk.length;
      if (want && want.state === 'yield') return { state: 'yield' };
      return run();
    },
    resume() { return finished ? want : run(); },
    finalize() {
      if (delivered !== length) { session.free(); throw new SourceError('length_mismatch', `The source delivered ${delivered} of ${length} declared bytes.`); }
      while (!finished) {
        const r = run();
        if (r.state === 'need') { session.free(); throw new SourceError('length_mismatch', 'The session needs bytes beyond what was delivered.'); }
      }
      return want.result ?? true;
    },
  };
}
