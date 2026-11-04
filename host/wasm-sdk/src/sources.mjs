// P7.9: `snug/sources` over wasm, plus the schema drivers (validateHandle,
// validateHandleSync, pushValidator) the native host has internally. Each
// session's state (rscan scratch, or the vms scratch/session/key arena) lives
// in linear memory with a window buffer of its own:
//
//   handles  each read is copied once into the session's window; re-asked
//            bytes inside it are not copied again
//   push     chunks are appended to the session's window in linear memory and
//            the kept tail compacted there (no JS-side buffer at all)
//
// Sessions are freed at their verdict, or by a FinalizationRegistry when
// abandoned. The drivers are the native ones (same yield primitive choice).
import * as rt from './runtime.mjs';
import { SnugFault } from '../../js/src/fault.mjs';
import { resolveLimits } from '../../js/src/limits.mjs';
import { innerOf } from './schema.mjs';
import { scan } from './index.mjs';

export class SourceError extends Error {
  constructor(code, message) { super(message); this.name = 'SourceError'; this.code = code; }
}
const I32_MAX = 0x7fffffff;
const clamp = n => (n > I32_MAX ? I32_MAX : n);
const lim = v => (v === undefined || v === null ? -1 : Math.max(0, Math.min(Number(v), 0x7fffffff)) | 0);
const RS_NEED = -1, RS_YIELD = -2, VMS_NEED = -64, VMS_YIELD = -65;

export function pickYield(env = globalThis) {
  if (env.scheduler && typeof env.scheduler.yield === 'function') { const sch = env.scheduler; return { kind: 'scheduler.yield', turn: () => sch.yield() }; }
  if (typeof env.setImmediate === 'function') { const si = env.setImmediate; return { kind: 'setImmediate', turn: () => new Promise(r => si(r)) }; }
  if (typeof env.MessageChannel === 'function') {
    let channel = null; const waiting = [];
    return { kind: 'MessageChannel', turn: () => new Promise(r => {
      if (!channel) { channel = new env.MessageChannel(); channel.port1.onmessage = () => { const w = waiting.shift(); if (w) w(); }; }
      waiting.push(r); channel.port2.postMessage(0);
    }) };
  }
  const st = env.setTimeout;
  return { kind: 'setTimeout', turn: () => new Promise(r => st(r, 0)) };
}
const nextTurn = pickYield().turn;

const sessions = new FinalizationRegistry(({ h, gen }) => { if (gen === rt.generation && rt.x) rt.x.sdk_ses_free(h); });

/** Common to both kinds: the handle, its window in linear memory, and the step. */
class WasmSession {
  constructor(h) {
    if (h < 0) throw new Error(`snug wasm: session refused (${h})`);
    this.h = h; this.gen = rt.generation; this.wp = 0; this.wcap = 0; this.done = false;
    this.token = {}; sessions.register(this, { h, gen: this.gen }, this.token);
    this.lastWindow = null; this.lastLen = -1;
  }
  free() { if (this.h >= 0) { if (this.gen === rt.generation) rt.x.sdk_ses_free(this.h); sessions.unregister(this.token); this.h = -1; } }
  live() { if (this.h < 0 || this.gen !== rt.generation) throw new Error('snug wasm: the session is finished or its instance was reset'); }
  /** The window buffer, at least n bytes: its pointer. */
  window(n) {
    this.live();
    if (n > this.wcap) { this.wcap = Math.max(n, 2 * this.wcap); this.wp = rt.x.sdk_ses_window(this.h, this.wcap); rt.refresh(); }
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
    try { return rt.x.sdk_ses_step(this.h, n, base); }
    catch (e) { this.h = -1; rt.lost(e); }
  }
  info(i) { return rt.i32[rt.INFO + i]; }
}

export class ScanSession extends WasmSession {
  constructor(length, options = {}, { quantum = 0 } = {}) {
    if (!Number.isSafeInteger(length) || length < 0 || length > I32_MAX) throw new TypeError('length must be an integer in 0..2^31-1.');
    if (!Number.isSafeInteger(quantum) || quantum < 0) throw new TypeError('quantum must be a non-negative integer.');
    const top = options.top ?? 'map'; if (top !== 'map' && top !== 'any') throw new TypeError("top must be 'map' or 'any'.");
    const limits = resolveLimits(options);
    rt.ready();
    super(rt.x.sdk_rs_new(length, clamp(quantum), top === 'any' ? 1 : 0, options.cose === true ? 1 : 0, clamp(limits.maxBytes), clamp(limits.maxDepth), clamp(limits.maxEntries), clamp(limits.maxItems)));
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

export class VmSession extends WasmSession {
  constructor(schema, rule, length, opts = {}, { quantum = 0 } = {}) {
    if (!Number.isSafeInteger(length) || length < 0 || length > I32_MAX) throw new TypeError('snug: length must be an integer in 0..2^31-1');
    if (!Number.isSafeInteger(quantum) || quantum < 0 || quantum > I32_MAX) throw new TypeError('snug: quantum must be a non-negative integer');
    const inner = innerOf(schema.program), ri = schema.ruleIndex(rule);
    super(rt.x.sdk_vs_new(inner.handle(), ri, length, quantum, opts.top === 'map' ? 0 : 1, opts.cose ? 1 : 0,
      lim(opts.maxBytes), lim(opts.maxDepth), lim(opts.maxEntries), lim(opts.maxItems), lim(opts.maxBignumBytes), lim(opts.budget)));
    rt.refresh();
    this.inner = inner; this.length = length; this.verdict = null;
  }
  step(window, base) { if (this.verdict) return this.verdict; this.load(window); return this.stepIn(window.length, base); }
  stepIn(n, base) {
    if (this.verdict) return this.verdict;
    const r = this.raw(n, base);
    if (r === VMS_NEED) return { state: 'need', offset: this.info(0), length: this.info(1), keep: this.info(3) };
    if (r === VMS_YIELD) return { state: 'yield', position: this.info(2), keep: this.info(3) };
    if (r < 0) throw new Error(`snug wasm: vms-step answered ${r}`);
    this.verdict = { state: 'done', result: this.inner.result() };
    this.free();
    return this.verdict;
  }
}

export const scanBuffer = scan;
export function bufferHandle(bytes) {
  const copy = bytes.slice();
  return { size: copy.length, read: (offset, length) => copy.subarray(offset, offset + length) };
}
export function asyncHandle(bytes, { delay = 0 } = {}) {
  const copy = bytes.slice();
  return { size: copy.length, read: (offset, length) => delay > 0
    ? new Promise(resolve => setTimeout(() => resolve(copy.slice(offset, offset + length)), delay))
    : Promise.resolve().then(() => copy.slice(offset, offset + length)) };
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
    const got = req.read();
    if (got && typeof got.then === 'function') { it.return(); throw new SourceError('bad_chunk', `${what} got a Promise; use its async form.`); }
    next = it.next(got);
  }
  return next.value;
}

export async function scanHandle(handle, options = {}, { chunk = 65536, quantum = 0 } = {}) {
  checkHandle(handle);
  return runAsync(driveSession(new ScanSession(handle.size, options, { quantum }), handle, chunk));
}
export function scanHandleSync(handle, options = {}, { chunk = 65536, quantum = 0 } = {}) {
  checkHandle(handle);
  return runSync(driveSession(new ScanSession(handle.size, options, { quantum }), handle, chunk), 'scanHandleSync');
}
export async function validateHandle(schema, handle, rule, options = {}, { chunk = 65536, quantum = 0 } = {}) {
  checkHandle(handle);
  return runAsync(driveSession(new VmSession(schema, rule, handle.size, options, { quantum }), handle, chunk));
}
export function validateHandleSync(schema, handle, rule, options = {}, { chunk = 65536, quantum = 0 } = {}) {
  checkHandle(handle);
  return runSync(driveSession(new VmSession(schema, rule, handle.size, options, { quantum }), handle, chunk), 'validateHandleSync');
}

export function pushScanner(length, options = {}, { quantum = 0 } = {}) {
  const session = new ScanSession(length, options, { quantum });
  return pushSession(session, length, want => Math.min(want.state === 'need' ? want.offset : want.position, session.position()));
}
export function pushValidator(schema, length, rule, options = {}, { quantum = 0 } = {}) {
  return pushSession(new VmSession(schema, rule, length, options, { quantum }), length, want => want.keep);
}

/** The native push protocol, with its buffer being the session's window in linear memory. */
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
