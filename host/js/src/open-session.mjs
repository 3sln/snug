import { VmSession as HostSession } from './vm-session.mjs';
import { schemaPrograms } from './schema-state.mjs';
import { validateOptions } from './options.mjs';

function bytesInput(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('snug: bytes must be a Uint8Array');
  if (typeof SharedArrayBuffer === 'function' && bytes.buffer instanceof SharedArrayBuffer)
    throw new TypeError('snug: copy SharedArrayBuffer input first');
}

// Advanced window protocol without exposing the host session's Program/scratch.
// Obtain sessions through openSession(); there is no public constructor.
class VmSession {
  #host;
  constructor(host) { this.#host = host; Object.freeze(this); }
  get length() { return this.#host.length; }
  /** An unknown-length session's input limit (more bytes is too_large); undefined otherwise. */
  get limit() { return this.#host.limit; }
  get bytesHeld() { return this.#host.bytesHeld; }
  step(window, base) {
    bytesInput(window);
    const bound = this.length ?? this.limit;
    if (!Number.isSafeInteger(base) || base < 0 || base + window.length > bound)
      throw new TypeError('snug: invalid window span');
    return this.#host.step(window, base);
  }
  /** D085: the end of an unknown-length message (n bytes). */
  end(n) { return this.#host.end(n); }
}

/** Advanced synchronous session over a verified schema (D160). */
export function openSession(schema, rule, length, options = {}, scheduling = {}) {
  const program = schemaPrograms.get(schema);
  if (!program) throw new TypeError('snug: openSession needs a verified Schema');
  if (typeof rule !== 'string') throw new TypeError('snug: rule must be a string');
  const index = program.ruleIndex(rule);
  if (index < 0) throw new TypeError('snug: unknown rule');
  validateOptions(options, 'validation');
  validateOptions(scheduling, 'scheduling');
  return new VmSession(new HostSession(program, index, length, options, scheduling.quantum ?? 0));
}
