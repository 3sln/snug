// P9.20 follow-up: run in a FRESH process by dispose.test.mjs (host/js) and parity.test.mjs
// (host/wasm-sdk). `[Symbol.dispose]` must exist only where the engine has Symbol.dispose.
//
//   node dispose-child.mjs <absent|present> <js|wasm>
//
// absent: before any snug module loads, the global Symbol is replaced by a copy without
// `dispose` and `asyncDispose`, which is what snug's code sees on an engine without them.
// (Node defines both as non-configurable, so they cannot be deleted from Symbol itself.)
// present: the engine's own Symbol.
// Either way every public entry of the package is imported, and the child prints, as a
// `keys` JSON line, the own string-keyed members of every exported class's prototype chain
// and of a session's. The parent requires the two modes to agree: a `[Symbol.dispose]`
// evaluated without the symbol would add a member named "undefined" (Writer has a real
// `undefined()`, the CBOR value, in both). close() closes a session in both modes; with
// the symbol, [Symbol.dispose]() and `using` (where the syntax exists) close it too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const [mode, which] = process.argv.slice(2);
assert.ok(['absent', 'present'].includes(mode) && ['js', 'wasm'].includes(which), 'usage: dispose-child.mjs <absent|present> <js|wasm>');
if (mode === 'absent') {
  const Real = globalThis.Symbol;
  const Copy = function Symbol(description) { return Real(description); };
  for (const k of Reflect.ownKeys(Real))
    if (!['dispose', 'asyncDispose', 'length', 'name'].includes(k)) Object.defineProperty(Copy, k, Object.getOwnPropertyDescriptor(Real, k));
  globalThis.Symbol = Copy;
  assert.equal(typeof Symbol.dispose, 'undefined');
  assert.equal(typeof Symbol.asyncDispose, 'undefined');
  assert.equal(typeof Symbol.iterator, 'symbol');
}

const dir = new URL(which === 'js' ? '../' : '../../wasm-sdk/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));
const modules = {};
for (const [key, entry] of Object.entries(pkg.exports)) {
  const file = typeof entry === 'object' ? entry.default : entry;
  if (!/\.mjs$/.test(file) || key === './inline') continue;   // ./inline: inline-wasm.mjs is written by the package build
  modules[key] = await import(new URL(file, dir));
}
const members = o => {
  const names = [];
  for (let p = o; p && p !== Object.prototype && p !== Function.prototype; p = Object.getPrototypeOf(p))
    names.push(Object.getOwnPropertyNames(p).sort());
  return names;
};
const keys = {};
for (const [key, m] of Object.entries(modules))
  for (const [name, v] of Object.entries(m))
    if (typeof v === 'function' && v.prototype && typeof v.prototype === 'object') keys[`${key} ${name}`] = members(v.prototype);
const classes = Object.keys(keys).length;

if (which === 'wasm') await modules['.'].init();
const { compile } = modules['./compile'], { openSession } = modules['./sources'];
const schema = await compile('r = uint');
const bytes = new Uint8Array([0x01]);
const fresh = () => openSession(schema, 'r', bytes.length);
const closed = s => { try { s.step(bytes, 0); return false; } catch (e) { return e instanceof TypeError; } };

const s = fresh();
keys.session = members(Object.getPrototypeOf(s));
assert.ok(!keys.session.flat().includes('undefined'), `${which}: a session has a member named "undefined"`);
console.log('keys ' + JSON.stringify(keys));
if (mode === 'absent') {
  s.close();
  assert.ok(closed(s), `${which}: close() leaves the session closed`);
} else {
  assert.equal(typeof s[Symbol.dispose], 'function', `${which}: session[Symbol.dispose]`);
  s[Symbol.dispose]();
  assert.ok(closed(s), `${which}: [Symbol.dispose]() closes the session`);
  let usingSyntax = false;
  try { new Function('{ using x = null; }'); usingSyntax = true; } catch { /* this Node has no `using` */ }
  if (usingSyntax) {
    const u = new Function('fresh', '{ using t = fresh(); var kept = t; } return kept;')(fresh);
    assert.ok(closed(u), `${which}: \`using\` closes the session at the end of its block`);
  }
  console.log(`using: ${usingSyntax ? 'checked' : 'not in this Node'}`);
}
console.log(`ok ${which} ${mode}: ${Object.keys(modules).length} entries, ${classes} exported classes`);
