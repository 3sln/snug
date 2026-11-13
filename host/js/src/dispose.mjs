// `[Symbol.dispose]` (= close()) only where the engine has Symbol.dispose.
// A class body's `[Symbol.dispose]() {}` on an engine without it defines a method named
// "undefined"; this defines nothing there. close() stays the primary API.
// Use it as `const C = /* @__PURE__ */ disposable(class C { ... });` so a bundle that never
// uses C still drops the class (a bare top-level call would keep it).
export function disposable(Class) {
  if (typeof Symbol.dispose === 'symbol')
    Object.defineProperty(Class.prototype, Symbol.dispose, { value: Class.prototype.close, writable: true, configurable: true });
  return Class;
}
