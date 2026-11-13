import type { SnugFault } from './index.js';
import type { Schema, ValidationOptions } from './schema.js';
import type { StreamInput, SessionLimits } from './sources.js';
import type { View } from './view.js';
/** CBOR sequences (RFC 8742). Every limit applies to each message from zero;
 *  maxBytes is refused (use maxMessageBytes). schema + rule validate each message in the
 *  same pass that finds its end; without them each message is profile-checked. */
export interface SequenceOptions extends Omit<ValidationOptions, 'maxBytes'> {
  schema?: Schema;
  rule?: string;
  /** The largest message: one that does not end within it is cbor/too_large
   *  (default: the input limit -- 1,500,000 profile-only, the schema's compiled one). */
  maxMessageBytes?: number;
  /** 'stop' (default): end at the first refused message. 'skip': drop schema refusals of
   *  complete messages (skippable); every other refusal still stops. */
  onInvalid?: 'stop' | 'skip';
  /** 'spanning' (default): a message inside one chunk is a subarray of it (borrowed);
   *  'always': every message gets a fresh buffer (BYOB readers, recycled chunks). */
  copy?: 'spanning' | 'always';
  /** Report a refusal as soon as it is certain (its code may differ). */
  failFast?: boolean;
}
export interface SequenceStreamOptions extends SequenceOptions {
  /** Scheduling yields within long messages (0..2^31-1, default 0). */
  quantum?: number;
}
/** One message of a sequence. `bytes` aliases the chunk it lay in when `borrowed`;
 *  do not change that chunk while the message or its view is used. */
export interface SequenceMessage {
  /** 0-based position in the sequence (skipped messages count). */
  readonly index: number;
  /** Absolute offset of its first byte. */
  readonly offset: number;
  readonly length: number;
  readonly bytes: Uint8Array;
  readonly borrowed: boolean;
  /** A checked View of the message, minted from the reader's verdict (no re-scan). */
  readonly view: View;
}
/** A refused message: a SnugFault with these fields. */
export interface SequenceFault extends SnugFault {
  index: number;
  /** Absolute offset of the refused message; `offset` is the failure's absolute offset. */
  messageOffset: number;
  /** A schema refusal of a complete message: onInvalid 'skip' skips it. */
  skippable: boolean;
}
export interface SequenceStats {
  messages: number; skipped: number; bytes: number; lastSkipped: SequenceFault | undefined;
}
/** Messages as they complete; a stopping refusal is thrown (a SequenceFault) after every
 *  earlier message; leaving the loop cancels the source. */
export interface SequenceIterator extends AsyncGenerator<SequenceMessage, void, undefined> {
  readonly stats: SequenceStats;
}
export declare function readSequence(source: StreamInput, options?: SequenceStreamOptions): SequenceIterator;
export interface SequenceResult {
  messages: SequenceMessage[];
  /** Skipped refusals (onInvalid 'skip'). */
  skipped: SequenceFault[];
  /** The refusal that ended the sequence, if any. */
  error: SequenceFault | undefined;
}
export interface SequenceReader {
  /** The messages this chunk completes; an empty chunk is not the end. */
  feed(chunk: Uint8Array): SequenceResult;
  /** The end of the input (EOF inside a message is cbor/truncated). */
  end(): SequenceResult;
  readonly done: boolean;
  readonly bytesHeld: number;
  /** Abandon the sequence, releasing its session now (feed and end then throw). */
  close(): void;
}
export declare function sequenceReader(options?: SequenceOptions): SequenceReader;
/** The isolate's session policy (see @3sln/snug/sources); a reader counts as one live session. */
export declare function sessionLimits(set?: Partial<SessionLimits>): SessionLimits & { live: number; pooledBytes: number };
/** Drop every idle pooled array now (see @3sln/snug/sources). */
export declare function releasePool(): void;
