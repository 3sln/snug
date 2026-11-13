// The whole suite: `npm test` runs `node --test test/index.js`, so every Node
// line runs exactly this list once (Node 24 resolves a bare test/ directory to
// index.js; Node 20 and 22 would run each file AND index.js). Every
// test/*.test.mjs must be imported here; the last test enforces that (P9.18).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import './codec.test.mjs';
import './encode.test.mjs';
import './encoder-fast-paths.test.mjs';
import './sources.test.mjs';
import './public-sources.test.mjs';
import './view.test.mjs';
import './writer.test.mjs';
import './serialized.test.mjs';
import './package.test.mjs';
import './examples.test.mjs';
import './unicode.test.mjs';
import './profiles.test.mjs';
import './options.test.mjs';
import './controls.test.mjs';
import './abnf.test.mjs';
import './stream.test.mjs';
import './xsd-regexp.test.mjs';
import './sessions.test.mjs';
import './dispose.test.mjs';
import './sequence.test.mjs';
import './version.test.mjs';
import './schema-api.test.mjs';

test('test/index.js imports every test/*.test.mjs', () => {
  const dir = new URL('./', import.meta.url), self = readFileSync(new URL('index.js', dir), 'utf8');
  const imported = new Set([...self.matchAll(/^import '\.\/([^']+\.test\.mjs)';$/gm)].map(m => m[1]));
  const files = readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort();
  assert.deepEqual(files.filter(f => !imported.has(f)), [], 'add these to test/index.js');
  assert.deepEqual([...imported].filter(f => !files.includes(f)), [], 'test/index.js imports missing files');
});

// P9.13 WP3 (S3): a run that stops early (a process.exit(0) mid-suite, a crash the runner
// counts as a pass) must not pass. Tests run in registration order, so this one runs last;
// if the process exits before it ran, the exit status becomes 1.
let finished = false;
process.on('exit', () => {
  if (!finished) { console.log('FAIL test/index.js: the suite stopped before its last test'); process.exit(1); }
});
test('the suite ran to its last test', () => { finished = true; });
