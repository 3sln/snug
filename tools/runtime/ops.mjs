// Micro-operations timed as CPU per call in Node and inside workerd (where
// timers are frozen, so run.mjs reads the workerd process's CPU time around
// batches of requests instead). One object-storage `put` request from the
// study contract's accepted case, its Program, and the contract's CDDL text.
import { decode, encode } from '@3sln/snug';
import { fromSerialized } from '@3sln/snug/schema';
import { view } from '@3sln/snug/view';
import { bufferHandle, pushScanner, scanHandle } from '@3sln/snug/sources';
import { fromHex } from './suite.mjs';

export async function prepareOps(fx, { compiler = true } = {}) {
  const suite = fx.contracts.find(s => s.name.includes('object-storage'));
  const c = suite.cases.find(k => k.expect && k.rule === 'request');
  const bytes = fromHex(c.hex), programBytes = fromHex(fx.programs[suite.name]);
  const schema = await fromSerialized(programBytes), value = decode(bytes);
  const opts = { top: 'any' };
  const ops = {
    noop: () => 0,
    decode: () => decode(bytes),
    encode: () => encode(value),
    validate: () => schema.validate(bytes, c.rule, opts),
    schemaDecode: () => schema.decode(bytes, c.rule, opts),
    view: () => view(bytes, { ...opts, schema, rule: c.rule }).get('method').text(),
    fromSerialized: () => fromSerialized(programBytes),
  };
  // Cooperative yields: the same ~200 KB document through the async handle driver
  // with no quantum, and with a quantum that yields `yields` times (counted with
  // the synchronous push scanner). The difference is the cost of the yields.
  const doc = encode({ id: 7, rows: Array.from({ length: 2000 }, (_, i) => ({ i, text: 'x'.repeat(i % 100), body: new Uint8Array(32) })) });
  const QUANTUM = 1000, push = pushScanner(doc.length, {}, { quantum: QUANTUM });
  let state = push.feed(doc), yields = 0;
  while (state.state === 'yield') { yields++; state = push.resume(); }
  push.finalize();
  ops.scanNoYield = () => scanHandle(bufferHandle(doc), {}, { chunk: doc.length });
  ops.scanYield = () => scanHandle(bufferHandle(doc), {}, { chunk: doc.length, quantum: QUANTUM });
  if (compiler) {
    const { compile } = await import('@3sln/snug/compile');
    ops.compile = () => compile(suite.cddl);
  }
  // Calls per timed batch.
  const counts = Object.fromEntries(Object.keys(ops).map(k => [k,
    k === 'compile' ? 20 : k === 'fromSerialized' ? 500 : k.startsWith('scan') ? 3 : 5000]));
  return { ops, counts, yields, quantum: QUANTUM, docBytes: doc.length, inputBytes: bytes.length, programBytes: programBytes.length };
}
