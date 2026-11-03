// Node arm: copied by run.mjs into a fresh temporary directory next to
// suite.mjs, fixtures.json and node_modules/snug (a copy of the staged
// package), so every snug import resolves through the package exports and
// nothing reaches back into the repository.
import { readFileSync } from 'node:fs';
import { runSuite } from './suite.mjs';

const fx = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const now = () => performance.now();
const t0 = now();
const compiled = await runSuite(fx, { now, compiler: true });
const t1 = now();
const precompiled = await runSuite(fx, { now, compiler: false });
console.log(JSON.stringify({ runtime: `node ${process.version}`, compiled, precompiled,
  wallMs: { compiled: +(t1 - t0).toFixed(1), precompiled: +(now() - t1).toFixed(1) } }));
