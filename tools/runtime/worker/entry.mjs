// workerd arm (module syntax). fixtures.json is a separate JSON module in the
// workerd config, not part of the bundle. Loopback only; never deployed.
//   GET /suite?compiler=1|0   run the conformance subset, answer its JSON
//   GET /op?name=&n=          run one micro-operation n times (CPU sampling)
//   GET /noop                 empty answer (CPU baseline)
import fx from './fixtures.json';
import { runSuite } from '../suite.mjs';
import { prepareOps } from '../ops.mjs';

let prepared;
export default {
  async fetch(request) {
    const url = new URL(request.url), q = url.searchParams;
    if (url.pathname === '/noop') return new Response('0');
    if (url.pathname === '/suite') {
      const result = await runSuite(fx, { now: () => Date.now(), compiler: q.get('compiler') !== '0' });
      return Response.json({ runtime: 'workerd', userAgent: globalThis.navigator?.userAgent ?? null,
        float16: typeof Float16Array === 'function', ...result });
    }
    if (url.pathname === '/op') {
      prepared ??= await prepareOps(fx, { compiler: q.get('compiler') !== '0' });
      const f = prepared.ops[q.get('name')], n = Number(q.get('n') ?? 1);
      if (!f) return new Response('no such op', { status: 404 });
      for (let i = 0; i < n; i++) await f();
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },
};
