# Independent review: CBOR sequences, 2026-11-04

**Verdict: changes required before treating P7.13 as ready for the long-lived HTTP use case.** Framing, refusal precedence and stop/skip look sound within the current deterministic profile. Complete messages can nevertheless stall indefinitely, ownership promises fail for Node Buffers, and buffering can amplify a small input quadratically. The example passes but does not exercise these cases.

Reviewed the requested design, D210–D219, P7.13/P7.13w, guides/API, example, benchmark record, kin session, JS and Rust hosts, gate/oracle, and the local RFC 8742 and RFC 8949 texts. Snapshot: `53c7c1002d0eb2e956f6939d3771e55dc6ecb678`, initially clean tracked working tree. Rust observations below are static review; execution was Node only. No production files, DEVLOG, generated output or git state were changed by this review. Probe files are under `.cache/seqrev/`.

1. **Blocker — complete messages can wait forever for unrelated future input.**

   `kin/vm-session.kin:475` requests an extension leaf's maximum span before evaluating it, even when the complete item is already available. Tag-40 notes similarly request fixed spans (`kin/vm-session-base.kin:875`). This preserves eventual verdict parity but breaks the owner's delivery requirement and RFC 8742 §2's incremental delivery model.

   Run `node .cache/seqrev/latency.mjs`. Minimal extension witness:

   ```js
   const schema = await compile('r = uint .ok 0', {
     controls: { ok: { maxBytes: 4, check: () => true } }
   });
   const r = sequenceReader({ schema, rule: 'r' });
   r.feed(Uint8Array.of(1)).messages.length; // 0; standalone validation accepts
   r.end().messages.length;                // 1
   ```

   On a live connection that sends `01` and waits for the client, the message never arrives. This also affects ordinary text-keyed events: `r = {text: tstr .chars 1}` with `snug/controls`, encoding `{text:'a'}`, releases immediately in one chunk but releases **nothing** after all eight bytes have been fed individually; EOF releases the event. `d8 28 82 81 01 81 01` (tag 40, shape `[1]`, data `[1]`) shows the same whole-versus-byte delivery difference. `failFast` does not fix accepted-message latency.

   **Fix:** make whole-item requests stop at the actual item's end, capped by the declared maximum; make metadata reads request only bytes needed for the actual head/shape. Keep these walk decisions in kin. Gate release at the last byte, without supplying EOF or a subsequent message, for every supported leaf/tag and chunk split. D211 parity and release latency are separate properties. The P7.13 statement “zero for text-keyed events” needs qualification or correction.

2. **Major — `copy: 'always'` does not copy Node Buffer messages.**

   `host/js/src/sequence-core.mjs:218` uses `bytes.slice()`. A Buffer is an accepted Uint8Array, but Buffer's `slice()` aliases its storage. The message claims `borrowed: false` while still depending on source reuse.

   ```js
   const b = Buffer.from([1]);
   const m = sequenceReader({ copy: 'always' }).feed(b).messages[0];
   b[0] = 2;
   m.borrowed;      // false
   m.view.number(); // 2; only 1 was checked
   ```

   `node .cache/seqrev/probes.mjs` confirms this; the equivalent plain Uint8Array probe preserves 1. This affects Node stream chunks and both reader APIs.

   **Fix:** copy using a guaranteed plain Uint8Array allocation and `set`, or `new Uint8Array(bytes)`. Test Buffer input, recycled slabs, mutation after `feed`, and mutation after a yielded message, through both APIs. The currently passing ownership test only supplies plain Uint8Arrays.

3. **Major — the checked-View capability is reachable through mutable public state.**

   `SequenceMessage.view` mints from `this.bytes` (`sequence-core.mjs:35–39`), a writable property. No byte mutation or internal-module import is necessary:

   ```js
   const m = sequenceReader({ copy: 'always' }).feed(Uint8Array.of(1)).messages[0];
   m.bytes = Uint8Array.of(0x62, 0xc0, 0xae); // invalid UTF-8
   view(m.bytes); // throws SnugFault code 'text'
   m.view.text(); // returns two replacement characters, without checking
   ```

   There is also a pre-existing public View escape: `View` is exported by `snug/view`, its constructor accepts arbitrary state, and `_m` exposes the Message constructor. From `known = view(Uint8Array.of(1))`, `new View(new known._m.constructor(badBytes, {}), 0, 0).text()` accepts the same invalid text. Merely hiding `mintView` from package exports does not establish D215's claimed capability boundary. TypeScript's private constructor/readonly declarations do not enforce it at runtime.

   **Fix:** mint from a private reference captured at validation; make message metadata immutable. Hide View/Cursor message state in private fields or WeakMaps, and require a module-private constructor token/brand for checked instances. Preserve the separately documented read-only contract for byte aliases: this is not a claim that mutable JS typed arrays can be made tamper-proof. These witnesses require caller code; I found no way for CBOR bytes alone to invoke the mint function. See `probes.mjs`.

4. **Major — async backpressure and scheduling stop at chunk boundaries, not messages.**

   `SequenceCore.run` accumulates every message in the current chunk before returning (`sequence-core.mjs:92–136`); only then does `readSequence` yield (`:307–312`). A chunk containing N scalar messages creates N message objects and subarrays before the consumer can break. `quantum` resets per message and does not bound this work across small messages.

   In `probes.mjs`, a diagnostic predicate with `maxBytes: 1` counts validation calls on 10,000 one-byte integers in one chunk. At the **first** `await it.next()`, all 10,000 have been checked, both with `quantum: 0` and `quantum: 100`. Breaking then cancels the source, but cannot undo this work or allocation. The counter is instrumentation, not a proposed stateful production predicate.

   There is no cumulative memory leak merely from infinitely many small, bounded chunks if the consumer drops messages. However, an arbitrarily large source chunk defeats a bound based only on `maxMessageBytes`; the transport chunk and pending message batch are unbounded by P. One retained borrowed one-byte message also pins its entire chunk's backing store (`lifetimes.mjs`: 10,000-byte backing, P = 1, `bytesHeld = 0`). Rust's `Sequence::feed` likewise batches a chunk; its Read iterator limits a read to the configured chunk but queues all its messages.

   **Fix:** let the async driver pause after a completed message or a bounded batch, preserve the unconsumed chunk, and maintain scheduling work across message resets. Keep the push API's bulk result if desired, but document its O(chunk/message-count) result storage. Document backing-store retention and distinguish consumer-held bytes, source chunks, assembly capacity and key/scratch arenas. Add an early-break test where a single chunk contains many messages.

5. **Major — splitting an assembled tail repeatedly creates quadratic copying and retained storage.**

   `sequence-core.mjs:223–224` copies the entire suffix into `left` and gives the message a prefix view of the old assembly. Repeating this at EOF retains all the progressively smaller backing stores in one result batch. Rust has the analogous suffix operation in `Sequence::verdict` (`Vec::split_off`); that host was not executed.

   Run `node .cache/seqrev/assembly.mjs`. Set P = 512, schema `r = uint .ok 0`, pure accepting control with `maxBytes: 512`. Feed `[0]`, then 511 zero bytes, then EOF. All 512 integer messages are accepted. The feeds return 0 and 1 messages; `end()` returns 511. The messages collectively retain **512 distinct backing stores totalling 131,328 bytes** for 512 bytes of input: 512 + 511 + … + 1. This is deterministic allocation accounting, not a sampled RSS measurement. The same shape at larger allowed extension maxima has quadratic amplification. VM message budgets do not charge these host copies.

   Normal assembly also copies old prefixes during growth (`:193–194`), so the literal “each byte copied once” claim is false independently. `probes.mjs` assembles a 600-byte message whose returned backing buffer is 1,198 bytes. `bytesHeld` measures logical content, not allocation capacity/high water.

   **Fix:** retain a backing buffer plus start/end indexes for the pending suffix; copy only the completed message when separate ownership requires it. For Rust, avoid repeatedly copying the long tail to own a short prefix. Cap growth by the effective message window, account for transient growth copies, and test total allocated/retained bytes as well as logical `bytesHeld`. The critical regression is EOF with many messages already in an assembly, not just a huge byte string.

6. **Major — a later extension exception loses earlier complete messages, depending on chunking.**

   The backend rethrows immediately (`host/js/src/sequence.mjs:50`), and `SequenceCore.feed` discards its local accumulated result when it throws (`sequence-core.mjs:72`). The promised earlier-message delivery therefore fails for exceptions even though it works for ordinary returned verdicts.

   `probes.mjs` compiles `r = uint .check 0` with a pure predicate of `maxBytes: 1` that accepts 1 and throws for 2. Feeding `01 02` as one chunk yields **no messages**, then throws. Feeding `01`, `02` as separate chunks yields 1, then throws. The exception is correctly never skipped, but transport chunking changes the observable accepted prefix. The push reader loses its earlier result too.

   **Fix:** preserve an accumulated accepted/skipped prefix with a deferred terminal exception, and deliver that prefix before throwing in the iterator. Define a push result representation for exceptional termination, or explicitly change its contract. A per-message async pause also prevents reading a later predicate before yielding earlier messages. Test throwing predicates, not only boolean refusals.

7. **Minor — default ReadableStream readers do not guarantee fresh immutable chunks.**

   Architecture §18.5 and the guide say borrowing is safe for “a ReadableStream default reader”. A generic default controller enqueues object references; choosing a default reader does not copy or transfer them. In `probes.mjs`, enqueue a Uint8Array `[1]`, obtain a message, then set the original byte to 2: its borrowed View reads 2. This is expected aliasing, but contradicts the stated source-category guarantee.

   Actual BYOB reuse was also tested in `lifetimes.mjs`: an async iterable adapter passes the previous returned view into the next BYOB read. The previous borrowed message's byte length becomes **0** when the buffer transfers. Plain-Uint8Array `copy: 'always'` correctly preserves it. `readSequence` itself requests a default reader; BYOB use requires such an adapter.

   **Fix:** state the ownership requirement directly: default borrowing requires that the producer never mutate, recycle or transfer an emitted backing buffer. Fetch byte-stream bodies can meet that requirement; arbitrary ReadableStreams and custom Node streams need their own guarantee. Show a copying BYOB adapter or require `copy: 'always'` (after finding 2 is fixed).

8. **Minor — transport exceptions do not have the documented SourceError family.**

   Architecture §18.6 says source failures stay SourceError. `readSequence` propagates a thrown/rejected `it.next()` or `reader.read()` unchanged (`sequence-core.mjs:300`, `:257`). The source-error probe produces an ordinary `Error('transport failure')`, with no source code. A non-Uint8Array chunk does produce SourceError `bad_chunk`; SharedArrayBuffer intentionally produces TypeError.

   **Fix:** either wrap transport failures in a fixed safe SourceError code with the original error as cause, or document explicitly that transport exceptions pass through and must be handled separately. Keep generated validation errors payload-free; do not describe arbitrary transport exception text as sanitized.

9. **Minor — the gate checks verdicts well but does not gate the most important streaming properties.**

   The oracle is **not simply sequence mode restated**: `kin/scripts/sequence-run.mjs:174–205` uses buffer `vmValidate[X]` over D211 windows, whereas the implementation uses resumable sessions and held claims. This is useful driver differential evidence. It shares leaf/profile predicates, limit resolution (`vmsUnknownTotal`) and snug's navigation framer (`navSkip`), so it is not an independent RFC/semantic oracle. JS/Rust agreement over generated implementations cannot remove those shared blind spots.

   Release latency is only printed as `info` in `sequence-test.mjs`, not failed. Borrow expectations are explicitly weakened to “inside one chunk AND released during that feed”. The gate supplies EOF or more bytes eventually, uses fresh plain Uint8Array chunks, and does not check mutation, detachment, retained backing storage, exception-prefix preservation, or work before the first yield. Findings 1–6 can coexist with all its reported successes.

   **Fix:** retain the buffer differential, add a small independent RFC framer/vector layer, and make deadline-free last-byte release, ownership and resource invariants actual assertions. Fail on latency regressions for supported messages rather than normalizing expected borrowing around delayed release. Include default-stream reuse, Buffer, BYOB transfer, idle streams, exceptional controls and assembled-tail EOF cases.

10. **Note — D211 parity survived the probes; invalid-root context dependence is deliberate and needs precise user documentation.**

    `node .cache/seqrev/parity.mjs` ran **40,400 comparisons, zero failures**. It uses a separately written definite-item RFC head/length framer, public standalone buffer validation, four schemas (`any`, `uint`, a map, embedded CBOR), P = 0/1/4/8/64, stop/skip, small budgets, seeded mutations/truncated tails, and whole/byte/midpoint schedules. It imports neither snug navigation nor the sequence gate's oracle. It compares message boundaries and public refusal fields; it does not independently prove CBOR/CDDL predicates or compare internal budget/item words.

    A concrete context-dependent *invalid* root is `d8 18 41 18`: tag 24 around a lone, truncated integer head. Alone, buffer validation returns `cbor/truncated` at 3. With P = 8 and five following zero bytes, sequence mode returns `too_large` at 0. `latency.mjs` reproduces both. This follows D211's explicit embedded-truncation rule, rather than disproving it. The guide's blanket statement that each verdict equals validation of “that message's bytes” should be limited to accepted/complete roots and explain the window rule for refusals. Also, distinguishing R = P from R > P requires observing the existence of the P+1st byte, even though its value need not be inspected or buffered; “never needs input past o + P” is imprecise.

    Oversize-head probes confirmed no assembly retention once the held refusal is known: `59 ff ff` with P = 600 holds zero content bytes while further chunks arrive. A still-possible 600-byte byte string accumulates 3/103/203/303 bytes as expected. Claims are not used as allocation sizes. Ordinary `maxMessageBytes` enforcement works in these probes; findings 4–5 concern additional storage outside that logical single-message bound.

11. **Note — the stop/skip policy follows RFC 8742's recovery guidance, within an explicitly narrower wire profile.**

    RFC 8742 §2 defines zero or more concatenated items, no separator/end marker, permits pausing on a partial final item, and says malformed items prevent reliable decoding of the rest. §3 defines the media suffix; §4.2 discusses recoverability using a well-formed outer byte string. There is no requirement to attempt general resynchronisation. RFC 8949 §5.3 permits stopping on validity errors. Refusing all profile errors and budget failures is conservative; some are structurally recoverable, so “no safe point” should be read as the implementation's general policy rather than a theorem about every such error.

    Empty input and empty chunks pass. `00 61 78 01` against `uint` under skip yields indexes 0 and 2, with skipped index 1 at message/failure offset 1. `00 ff 01` stops at index/offset 1 and never treats the final 1 as recovered data. Truncated EOF, oversize, fail-fast's alternate code, and boundary EOF behaved as documented. Cancellation on loop exit and on an ordinary validation fault was observed; the stream lock was released, and no further source pull was needed in those probes. Backpressure still has finding 4's granularity limit.

    Current default rejection of `9f 01 ff 02` as `indefinite` is a known deterministic-profile restriction, not malformed RFC 8742 framing. Do not advertise the current reader as a generic decoder for all RFC 8742 sequences. P7.13w remains a documented wasm SDK gap; no wasm sequence parity was established here.

12. **Note — valid-CBOR and PEG adoption require explicit sequence-host integration.**

    The conceptual boundary rule is suitable for indefinite roots: their terminal break belongs to the message; an array containing two events is still one message. But D212's “no change here” is too strong for the planned implementations. Architecture §19.7 introduces `VMS_GROW`, while `SequenceCore.run` accepts only NEED/YIELD/HELD/nonnegative verdicts and otherwise throws. The JS backend closes over fixed arrays; the Rust reader has the same fixed-allocation/status model. Both need growth/resume plumbing. Current option admission rejects `wire: 'valid'`.

    PEG's new arena, statuses/refusals, format 2 and charging need fresh per-message resets, growth preservation, held-verdict precedence and cross-host tests. The embedded ANY Programs must be regenerated/verified for the format transition in both hosts. View minting must retain the received wire bytes and profile metadata while navigation/builders learn indefinite strings/containers and value-based map lookup. Canonical temporary bytes must not silently replace the message's raw span.

    **Before flipping defaults:** add split-at-every-byte tests around nested breaks, break in map value position, missing breaks, indefinite strings, unsorted/duplicate keys, non-shortest heads, and many indefinite roots. Exercise growth while a PEG machine or pending claim is suspended, reset after skipped schemas, budget/group-limit stopping, and updated public View navigation. Keep deterministic-profile expectations explicit. The present differential alone cannot certify those future semantics.

Checks actually run:

- `node examples/sequence-sse.mjs`: four expected events, skip/error assertions pass.
- `node --test host/js/test/sequence.test.mjs`: 10 passed, 0 failed.
- `node .cache/seqrev/probes.mjs`, `latency.mjs`, `lifetimes.mjs`, `assembly.mjs`: executed separately; observations above.
- `node .cache/seqrev/parity.mjs`: 40,400 comparisons, 0 mismatches.

Environment: Node v24.6.0, Apple M1 Pro, arm64, Darwin 23.6.0. The allocation observations count distinct returned ArrayBuffers and their byte lengths; no throughput benchmark, peak-RSS measurement, full `bb sequence-test`, Rust execution, wasm build, network access, emission or commit was performed. The existing `bench/SEQUENCE.md` throughput figures do not cover memory high water or quanta and therefore do not resolve these findings.

The SSE-over-fetch API shape is otherwise practical: schema selection, per-message limits, lazy field access and cancellation on `break` match the use case. Document checking HTTP status, expected media type and a non-null body before parsing; use the fetch AbortController for cancellation while awaiting more input, since an async generator's queued `return()` cannot interrupt an outstanding source `next()`. Sequence framing cannot detect a whole missing final event, so applications needing completeness/replay need their own sequence numbers/end marker and reconnect rules. No HTTP/SSE retry semantics are supplied by RFC 8742 itself.
