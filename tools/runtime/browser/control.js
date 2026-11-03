// Negative control, deliberately NOT part of the snug bundle: under the page's
// CSP, string evaluation must be refused. If it is, the suite's success shows
// snug needs no eval/new Function at runtime.
window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', e =>
  window.__cspViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample }));
window.__evalBlocked = (() => { try { (0, window.eval)('1'); return false; } catch (e) { return e instanceof EvalError; } })();
window.__functionBlocked = (() => { try { new Function('return 1'); return false; } catch (e) { return e instanceof EvalError; } })();
