// P9.20 follow-up: the dispose checks (dispose-child.mjs, each case in a fresh process so no
// snug module is loaded before the global Symbol is set). Used by dispose.test.mjs (host/js)
// and host/wasm-sdk/test/parity.test.mjs. Not a test file itself.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = fileURLToPath(new URL('dispose-child.mjs', import.meta.url));
/** One case in a fresh process: its `keys` (prototype members) and its output. */
function disposeCase(mode, which) {
  const out = execFileSync(process.execPath, [child, mode, which], { encoding: 'utf8' });
  return { keys: JSON.parse(out.match(/^keys (.*)$/m)[1]), out };
}
/** Both modes for one package (js or wasm): each passed, and every prototype has the same members. */
export function checkDispose(which) {
  const absent = disposeCase('absent', which), present = disposeCase('present', which);
  assert.match(absent.out, new RegExp(`^ok ${which} absent: \\d+ entries, [1-9]\\d* exported classes$`, 'm'));
  assert.match(present.out, new RegExp(`^ok ${which} present`, 'm'));
  assert.deepEqual(absent.keys, present.keys, 'without Symbol.dispose a prototype gained or lost a member');
  return present.out.match(/^using: (.*)$/m)[1];
}
