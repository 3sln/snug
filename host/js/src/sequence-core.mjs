// CBOR sequences (RFC 8742; P7.13, architecture §18, D210-D219): the driver shared by
// the native package (sequence.mjs, the gen JS session) and the wasm SDK (its session in
// linear memory): a series of
// messages, each one root, read from chunks as they arrive. Every message is
// checked in ONE pass -- the profile, and the schema rule when one is given --
// by the session VM's sequence mode (vms-init-seq), which also finds where the
// message ends; its View is then minted from that verdict without a re-scan.
//
//   readSequence(source, options)  -> AsyncIterable of messages (ReadableStream /
//                                     AsyncIterable / Iterable of Uint8Array)
//   sequenceReader(options)        -> { feed(chunk), end() } answering
//                                     { messages, skipped, error }
//
// A message: { index, offset, length, bytes, borrowed, view }. `bytes` is a
// subarray of the chunk it lay in (borrowed: true) or a fresh buffer it was
// assembled into across chunks (borrowed: false); `copy: 'always'` copies every
// message. Refusals are SnugFault with index, messageOffset and an absolute
// offset (D216); `onInvalid: 'skip'` drops only schema refusals of complete
// messages (D214). Per-message verdicts are the buffer driver's over the
// message's window (D211): bb sequence-test holds both hosts to it.
import { validateSequenceOptions, selectOptions } from './options.mjs';
import { validationFault } from './public-errors.mjs';
import { resolveLimits } from './limits.mjs';
import { codecTop } from './profiles.mjs';

const VMS_NEED = -64, VMS_YIELD = -65, VMS_HELD = -67, VMS_RESUME = -68;
const STEP = -1000;   // host: step again (after a scheduling yield)
const EMPTY = new Uint8Array(0);
const isShared = b => typeof SharedArrayBuffer === 'function' && b.buffer instanceof SharedArrayBuffer;
/** D214: schema reasons of a complete message are skippable; cbor/* and budget never. */
const skippableCode = code => code >= 32 && code <= 43;

/** One message of a sequence (D215). Its fields are read-only and `view` is minted on first
 *  use from the bytes the check ran over (a private reference, not the public `bytes` getter
 *  a caller could shadow; review 2026-11-04 #3). */
class SequenceMessage {
  #index; #offset; #bytes; #borrowed; #opts; #mint; #view = null;
  constructor(index, offset, bytes, borrowed, opts, mint) {
    this.#index = index; this.#offset = offset; this.#bytes = bytes; this.#borrowed = borrowed;
    this.#opts = opts; this.#mint = mint;
  }
  get index() { return this.#index; }
  get offset() { return this.#offset; }
  get length() { return this.#bytes.length; }
  get bytes() { return this.#bytes; }
  get borrowed() { return this.#borrowed; }
  get view() { return this.#view ??= this.#mint(this.#bytes, this.#opts, this.#borrowed); }
  toJSON() { return { index: this.#index, offset: this.#offset, length: this.#bytes.length, borrowed: this.#borrowed }; }
}

/** The Program, rule and validation options a sequence's options select (D213): a schema's
 *  rule, or (profile only) the built-in `any` under the decode defaults (D146, D210).
 *  programOf(schema) -> the host's program state for a Schema of that host (or undefined);
 *  anyOf() -> the host's `any` program. Shared by both hosts (P7.13w). */
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

/** The reader's engine: one session's arrays, re-initialised per message. */
class SequenceCore {
  /** backend: the session of one host (begin, step, eof, needOffset, needLength, position,
   *  heldCode, messageLength, code, result; total = the provisional end P; optional: chunk()
   *  -- a new chunk arrived, so any copy of an earlier one is stale (the wasm SDK keeps one
   *  in linear memory); close() -- the sequence ended, free the session); mint(bytes, opts,
   *  borrowed) -> View; viewOpts: what a minted View needs to know. */
  constructor(backend, options, mint, viewOpts, batch = Infinity) {
    const { onInvalid = 'stop', copy = 'spanning', failFast = false } = options;
    this.b = backend; this.mint = mint; this.viewOpts = viewOpts;
    this.skip = onInvalid === 'skip'; this.always = copy === 'always'; this.failFast = failFast === true;
    this.quantum = backend.quantum;
    this.batch = batch;                          // messages (and skips) per run before pausing
    this.total = backend.total;
    // the stream
    this.delivered = 0; this.next = 0; this.index = 0; this.done = false; this.busy = false;
    this.chunk = null; this.cb = 0;              // the chunk being read and its absolute offset
    this.left = null;                            // bytes after a message that ended inside its assembly
    // the message in progress (msg: its absolute offset, or -1)
    this.msg = -1; this.mb = null; this.mbLen = 0; this.at = 0; this.end = 0; this.eofed = false;
    this.dropping = false; this.r = 0; this.final = false;
  }

  // ------------------------------------------------------------ feeding
  feed(chunk) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('snug: a sequence chunk is a Uint8Array');
    if (isShared(chunk)) throw new TypeError('snug: SharedArrayBuffer chunks are refused; copy them first');
    this.enter();
    const res = { state: 'need', messages: [], skipped: [], error: undefined };
    try {
      if (chunk.length === 0) return res;      // never EOF
      this.chunk = chunk; this.cb = this.delivered; this.delivered += chunk.length;
      this.b.chunk?.();
      return this.run(res);
    } catch (e) { return this.thrown(res, e); } finally { this.busy = false; }
  }
  resume() {
    this.enter();
    const res = { state: 'need', messages: [], skipped: [], error: undefined };
    try { return this.run(res); } catch (e) { return this.thrown(res, e); } finally { this.busy = false; }
  }
  /** The end of the input: settles the message in progress (EOF inside it is truncated). */
  finish() {
    this.enter();
    const res = { state: 'need', messages: [], skipped: [], error: undefined };
    try { this.final = true; return this.run(res); } catch (e) { return this.thrown(res, e); } finally { this.busy = false; }
  }
  /** An exception (an extension predicate that threw, or an internal invariant) ends the
   *  sequence; the messages and skips found before it are kept and it is reported as the
   *  result's error (review 2026-11-04 #6). */
  thrown(res, e) {
    this.close(); this.msg = -1; this.mb = null; this.chunk = null;
    res.error = e; res.state = 'done';
    return res;
  }
  /** The sequence ended: the backend's session (if it holds one) is freed. */
  close() { this.done = true; this.b.close?.(); }
  enter() {
    if (this.done) throw new TypeError('snug: the sequence has ended');
    if (this.busy) throw new Error('snug: a sequence reader cannot be re-entered');
    this.busy = true;
  }

  // ------------------------------------------------------------ the loop
  run(res) {
    for (;;) {
      if (this.msg < 0) {
        if (!this.begin()) return this.drained(res);
        this.r = this.step();
      }
      if (this.r === STEP) this.r = this.step();
      const r = this.r;
      if (r === VMS_HELD) {
        const ml = this.b.messageLength(), hc = this.b.heldCode();
        const keeps = hc === 0 || (this.skip && ml >= 0 && skippableCode(hc));
        if (!keeps) {
          if (this.failFast) return this.stop(res);
          this.dropping = true; this.mb = null; this.mbLen = 0;   // count the bytes, keep none
        }
        this.held = true;   // from now on a step only asserts the frontier (an empty window there)
        // bytes beyond what the last step asserted first release the claims they cover
        if (this.asserted < Math.min(this.end, this.delivered - this.msg)) { this.r = this.step(); continue; }
        if (this.delivered - this.msg > this.total || this.final) { this.r = this.eof(); continue; }
        return this.drained(res);
      }
      if (r >= 0) {
        if (!this.verdict(res)) return res;
        // per-message backpressure (readSequence): pause, keeping the chunk, until resumed
        if (res.messages.length + res.skipped.length >= this.batch) { res.state = 'more'; return res; }
        continue;
      }
      if (r === VMS_NEED || r === VMS_YIELD) {
        const need = r === VMS_NEED;
        const no = need ? this.b.needOffset() : this.b.position();
        const want = no + (need ? this.b.needLength() : 0);
        this.at = no;
        if (this.msg + want <= this.delivered && want <= this.end) {
          if (!need && this.quantum > 0) { this.r = STEP; res.state = 'yield'; return res; }
          this.r = this.step();
          continue;
        }
        if (this.delivered - this.msg > this.total || this.final) {
          if (this.eofed) throw new Error('snug: the sequence session asked past the end');
          this.r = this.eof();
          if (this.r === VMS_RESUME) { this.at = this.b.position(); this.r = this.step(); }
          continue;
        }
        return this.drained(res);
      }
      throw new Error(`snug: vms-step answered ${r}`);
    }
  }

  /** Start the next message if a byte of it has arrived; false when there is none. */
  begin() {
    const o = this.next;
    if (o >= this.delivered) return false;
    this.b.begin();
    this.msg = o; this.at = 0; this.end = this.total; this.eofed = false; this.dropping = false; this.held = false; this.asserted = 0;
    // bytes after the previous message that it had already assembled start this one
    // (unless the chunk being read holds them too: then the message may borrow it)
    if (this.left !== null && !(this.chunk !== null && o >= this.cb)) { this.mb = this.left; this.mbLen = this.left.length; }
    else { this.mb = null; this.mbLen = 0; }
    this.left = null;
    return true;
  }

  /** The window from `at` on: a subarray of the chunk when it holds that position, else the
   *  assembly (extended from the chunk as far as a need reaches). Never past the end. */
  window() {
    const o = this.msg, at = this.at, c = this.chunk, end = Math.min(this.end, this.delivered - o);
    if (this.dropping || this.held) return EMPTY;
    if (c !== null && o + at >= this.cb) {
      const from = o + at - this.cb;
      return c.subarray(from, Math.max(from, Math.min(c.length, o + end - this.cb)));
    }
    if (c !== null && this.mbLen < end) {
      // a piece that starts in the assembly and continues in the chunk: extend it just that far
      const want = Math.min(end, Math.max(at + this.b.needLength(), this.mbLen + 1));
      this.absorb(o + want);
    }
    return this.mb.subarray(at, Math.min(this.mbLen, end));
  }

  step() {
    const w = this.window();
    const base = this.dropping || this.held ? Math.min(this.end, this.delivered - this.msg) : this.at;
    this.asserted = base + w.length;   // a window asserts its bytes exist (D147)
    return this.b.step(w, base);
  }

  eof() {
    this.eofed = true;
    const n = this.delivered - this.msg;
    if (n <= this.total) this.end = n;
    return this.b.eof(n);
  }

  /** Copy the message's bytes from the chunk into its assembly up to absolute `upto`. */
  absorb(upto) {
    const c = this.chunk, o = this.msg;
    const from = o + this.mbLen;
    if (c === null || upto <= from) return;
    const to = Math.min(upto, this.cb + c.length);
    const n = to - from;
    if (n <= 0) return;
    if (this.mb === null || this.mbLen + n > this.mb.length) {
      // doubling (amortised copies), never past the message limit P
      const need = this.mbLen + n;
      const grown = new Uint8Array(Math.min(Math.max(need, this.mb === null ? 0 : 2 * this.mb.length, 256), Math.max(need, this.total)));
      if (this.mb !== null) grown.set(this.mb.subarray(0, this.mbLen));
      this.mb = grown;
    }
    this.mb.set(c.subarray(from - this.cb, to - this.cb), this.mbLen);
    this.mbLen += n;
  }

  /** Waiting for bytes: keep what the message in progress has of this chunk. */
  drained(res) {
    if (this.msg >= 0 && !this.dropping && this.chunk !== null) this.absorb(Math.min(this.delivered, this.msg + this.end));
    this.chunk = null;
    if (this.final && this.msg < 0) { this.close(); res.state = 'done'; }
    return res;
  }

  /** A verdict for the message at this.msg: deliver, skip or stop. Answers false on stop. */
  verdict(res) {
    const o = this.msg, code = this.b.code(), ml = this.b.messageLength();
    if (code === 0 || (this.skip && ml >= 0 && skippableCode(code))) {
      const c = this.chunk;
      if (this.mbLen === 0 && c !== null && o >= this.cb && o + ml <= this.cb + c.length) {
        // wholly inside the chunk: a subarray of it (D215)
        if (code === 0) {
          const bytes = c.subarray(o - this.cb, o - this.cb + ml);
          // copy 'always': a plain Uint8Array copy (Buffer#slice would alias; review 2026-11-04 #2)
          res.messages.push(new SequenceMessage(this.index, o, this.always ? new Uint8Array(bytes) : bytes, !this.always, this.viewOpts, this.mint));
        } else res.skipped.push(this.fault(o));
      } else {
        // assembled across chunks: each byte copied once; bytes past it start the next message
        // the bytes after it stay a view of the assembly (no copy); the message gets exactly its
        // own bytes (the assembly itself when it is exactly that), so splitting many messages
        // out of one assembly copies each byte once (review 2026-11-04 #5)
        this.absorb(o + ml);
        const mb = this.mb, exact = this.mbLen === ml && mb.byteOffset === 0 && mb.buffer.byteLength === ml;
        if (this.mbLen > ml) this.left = mb.subarray(ml, this.mbLen);
        if (code === 0) res.messages.push(new SequenceMessage(this.index, o, exact ? mb : mb.slice(0, ml), false, this.viewOpts, this.mint));
        else res.skipped.push(this.fault(o));
      }
      this.index++; this.next = o + ml; this.msg = -1; this.mb = null; this.mbLen = 0;
      return true;
    }
    this.stop(res);
    return false;
  }

  stop(res) {
    res.error = this.fault(this.msg);
    res.state = 'done'; this.close(); this.msg = -1; this.mb = null; this.chunk = null;
    return res;
  }

  /** The SnugFault of the verdict in `out` for the message at o (D216). */
  fault(o) {
    const ml = this.b.messageLength(), code = this.b.code();
    const r = this.b.result();
    const e = validationFault(r);
    e.offset = o + r.offset;
    e.index = this.index;
    e.messageOffset = o;
    e.skippable = ml >= 0 && skippableCode(code);
    return e;
  }
}

function chunksOf(source) {
  if (source && typeof source.getReader === 'function') {
    return { async *[Symbol.asyncIterator]() {
      const reader = source.getReader();
      try { for (;;) { const { value, done } = await reader.read(); if (done) return; yield value; } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock?.(); }
    } };
  }
  if (source && (typeof source[Symbol.asyncIterator] === 'function' || typeof source[Symbol.iterator] === 'function')) return source;
  throw new TypeError('snug: a sequence source is a ReadableStream, an AsyncIterable or an Iterable of Uint8Array');
}

/** The public pair for one host: openBackend(options, quantum) -> { backend, viewOpts }, mint
 *  (the host's internal view capability), SourceError and nextTurn (its scheduling yield). */
export function sequenceApi({ openBackend, mint, SourceError, nextTurn }) {
  const open = (options, quantum, batch) => { const { backend, viewOpts } = openBackend(options, quantum); return new SequenceCore(backend, options, mint, viewOpts, batch); };
  /** A push reader of a CBOR sequence (D210): feed(chunk) and end() answer
   *  { messages, skipped, error }; after an error (onInvalid 'stop', or a refusal that
   *  cannot be skipped) the reader is done. */
  function sequenceReader(options = {}) {
    validateSequenceOptions(options, false);
    const core = open(options, 0);
    const shape = r => ({ messages: r.messages, skipped: r.skipped, error: r.error });
    return Object.freeze({
      feed(chunk) { return shape(core.feed(chunk)); },
      end() { return shape(core.finish()); },
      get done() { return core.done; },
      /** P9.7: abandon the sequence, releasing its session now (feed and end then throw). */
      close() { if (!core.done) core.close(); },
      /** Bytes held for the message in progress (its assembly so far). */
      get bytesHeld() { return core.mbLen + (core.left ? core.left.length : 0); },
    });
  }

  /** Read a CBOR sequence from a stream (D210): an async iterator of messages
   *  ({ index, offset, length, bytes, borrowed, view }). A refusal that stops the
   *  sequence is thrown after every earlier message was yielded; leaving the loop
   *  cancels the source. `stats`: { messages, skipped, bytes, lastSkipped }. */
  function readSequence(source, options = {}) {
    validateSequenceOptions(options, true);
    const { quantum, ...rest } = options;
    const core = open(rest, quantum ?? 0, 1);   // one message per run: the consumer paces the reader
    const src = chunksOf(source);
    const stats = { messages: 0, skipped: 0, bytes: 0, lastSkipped: undefined };
    async function* messages() {
      const it = src[Symbol.asyncIterator] ? src[Symbol.asyncIterator]() : src[Symbol.iterator]();
      let finished = false;
      try {
        for (;;) {
          const step = await it.next();
          let res;
          if (step.done) { finished = true; res = core.finish(); }
          else {
            const chunk = step.value;
            if (!(chunk instanceof Uint8Array)) throw new SourceError('bad_chunk', 'A sequence chunk must be a Uint8Array.');
            stats.bytes += chunk.length;
            res = core.feed(chunk);
          }
          for (;;) {
            stats.skipped += res.skipped.length;
            if (res.skipped.length) stats.lastSkipped = res.skipped[res.skipped.length - 1];
            for (const m of res.messages) { stats.messages++; yield m; }
            if (res.error) throw res.error;
            if (res.state === 'more') { res = core.resume(); continue; }
            if (res.state !== 'yield') break;
            await nextTurn();
            res = core.resume();
          }
          if (finished) return;
        }
      } finally {
        if (!core.done) core.close();   // the loop was left: free the backend's session now
        if (!finished && typeof it.return === 'function') await it.return();
      }
    }
    const gen = messages();
    Object.defineProperty(gen, 'stats', { get: () => ({ ...stats }) });
    return gen;
  }
  return { readSequence, sequenceReader };
}
