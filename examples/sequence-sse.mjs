// An SSE-like HTTP response whose body is a CBOR sequence (RFC 8742): each event
// is checked against the schema as soon as its last byte arrives and read through
// a lazy View -- nothing is decoded that the loop does not ask for. The response
// is simulated locally (a ReadableStream in a Response); no network.
import assert from 'node:assert/strict';
import { encode } from '../host/js/src/index.mjs';
import { compile } from '../host/js/src/public-compile.mjs';
import { readSequence } from '../host/js/src/public-sequence.mjs';

const schema = await compile(`
  event = { type: "tick" / "note", seq: uint, ? text: tstr .size (0..256) }
`);

// The server side: events written back to back, delivered in chunks that ignore
// event boundaries, with a pause between some of them (an idle, long-lived stream).
const events = [
  { type: 'tick', seq: 1 },
  { type: 'note', seq: 2, text: 'hello' },
  { type: 'tick', seq: 3 },
  { type: 'note', seq: 4, text: 'a note long enough to cross a chunk boundary' },
];
const body = Buffer.concat(events.map(e => encode(e)));
const cuts = [5, 9, 30, 31, 47, body.length];
const stream = new ReadableStream({
  async start(controller) {
    let from = 0;
    for (const to of cuts) {
      controller.enqueue(new Uint8Array(body.subarray(from, to)));   // fresh chunks, as fetch gives
      from = to;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    controller.close();
  },
});
const fetchLike = async () => new Response(stream, { headers: { 'content-type': 'application/cbor-seq' } });

// The client side.
const abort = new AbortController();   // abort() would cancel even a read that is waiting for bytes
const res = await fetchLike('https://example.invalid/events', { headers: { accept: 'application/cbor-seq' }, signal: abort.signal });
assert.ok(res.ok && res.headers.get('content-type').startsWith('application/cbor-seq') && res.body !== null);
const seen = [];
for await (const m of readSequence(res.body, { schema, rule: 'event', maxMessageBytes: 4096 })) {
  const type = m.view.get('type').text();
  const seq = m.view.get('seq').number();
  seen.push(`${seq}:${type}${type === 'note' ? ` (${m.view.get('text').text().length} chars)` : ''}`);
  // m.bytes is exactly the event's encoding: a subarray of the chunk it lay in
  // (m.borrowed), or one buffer it was assembled into across chunks.
  assert.deepEqual(m.bytes, new Uint8Array(encode(events[m.index])));
}
assert.deepEqual(seen, ['1:tick', '2:note (5 chars)', '3:tick', '4:note (44 chars)']);

// A malformed event stops the sequence with its index and absolute offset; a schema
// refusal of a complete event can be skipped instead.
const bad = Buffer.concat([encode({ type: 'tick', seq: 1 }), encode({ type: 'boom', seq: 2 }), encode({ type: 'tick', seq: 3 })]);
const skipped = readSequence([new Uint8Array(bad)], { schema, rule: 'event', onInvalid: 'skip' });
const kept = [];
for await (const m of skipped) kept.push(m.view.get('seq').number());
assert.deepEqual(kept, [1, 3]);
assert.equal(skipped.stats.skipped, 1);
await assert.rejects(async () => { for await (const _ of readSequence([new Uint8Array(bad)], { schema, rule: 'event' })); },
  e => e.code === 'schema/value' && e.index === 1 && e.messageOffset === encode({ type: 'tick', seq: 1 }).length &&
    e.skippable === true && e.path[0] === 'type');

console.log(`read ${seen.length} events from a simulated CBOR-sequence response: ${seen.join(', ')}`);
