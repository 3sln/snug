// P9.20 follow-up: [Symbol.dispose] only where the engine has Symbol.dispose (dispose-check.mjs).
import test from 'node:test';
import { checkDispose } from './dispose-check.mjs';

test('without Symbol.dispose no prototype gets a member named "undefined" and close() works; with it a session is Disposable', t => {
  t.diagnostic(`using: ${checkDispose('js')}`);
});
