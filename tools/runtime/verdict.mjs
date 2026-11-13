// P9.13 WP3 (B1): the runtime gate's verdict. run.mjs exits 1 unless verdict(results) is empty.
//
// A problem is any of:
//   - an arm that ran (or should have: not --skip'd and its runtime present) with no totals,
//     a fatal, or a failing case;
//   - a dynamic-code pattern in a bundle or in the package source, outside ALLOW;
//   - in Chrome: eval or new Function not blocked by the CSP, a CSP report that is not one of
//     the two deliberate probes in control.js, in-page violations beyond those, or any page
//     error, unhandled rejection or console.error.
// selfTest() runs first in every gate run: it injects each kind of failure into a passing
// result and requires verdict() to report it.

/** Patterns allowed in bundles or package source (label -> exact hit strings). None today. */
export const ALLOW = {};
/** The deliberate negative-control probes: control.js evaluates two strings under the CSP. */
export const CONTROL_PROBES = 2;

const armProblems = (label, r) => {
  if (!r) return [`${label}: no result`];
  if (r.fatal) return [`${label}: fatal ${r.fatal}`];
  if (!r.totals || !Number.isInteger(r.totals.pass) || !Number.isInteger(r.totals.fail)) return [`${label}: no totals`];
  if (r.totals.pass === 0) return [`${label}: 0 cases passed`];
  if (r.totals.fail) {
    const first = Object.entries(r.groups ?? {}).flatMap(([g, x]) => (x.failures ?? []).map(f => `${g}: ${f}`)).slice(0, 3);
    return [`${label}: ${r.totals.fail} failing case(s)${first.length ? ' -- ' + first.join('; ') : ''}`];
  }
  return [];
};

/** results: run.mjs's results object. ran: which arms were expected ({ browser, workerd }). */
export function verdict(results, ran) {
  const p = [];
  p.push(...armProblems('Node compile arm', results.node?.compiled), ...armProblems('Node precompiled arm', results.node?.precompiled));
  if (ran.browser) {
    const b = results.browser;
    p.push(...armProblems('Chrome compile arm', b?.compiled), ...armProblems('Chrome precompiled arm', b?.precompiled));
    if (b && !b.fatal) {
      if (b.evalBlocked !== true || b.functionBlocked !== true) p.push('Chrome: the CSP did not block eval and new Function (the negative control failed)');
      const reports = (b.cspReports ?? []).map(r => { try { return JSON.parse(r)['csp-report'] ?? {}; } catch { return {}; } });
      const stray = reports.filter(r => !String(r['source-file'] ?? '').endsWith('/control.js'));
      if (stray.length) p.push(`Chrome: ${stray.length} CSP report(s) outside the control probes: ${JSON.stringify(stray.slice(0, 2))}`);
      if (reports.length > CONTROL_PROBES || (b.violations ?? []).length > CONTROL_PROBES)
        p.push(`Chrome: ${(b.violations ?? []).length} CSP violation(s), ${reports.length} report(s); only the ${CONTROL_PROBES} control probes are expected`);
      if ((b.errors ?? []).length) p.push(`Chrome: ${b.errors.length} page error(s): ${b.errors.slice(0, 2).join(' | ')}`);
      if ((b.consoleErrors ?? []).length) p.push(`Chrome: ${b.consoleErrors.length} console.error call(s): ${b.consoleErrors.slice(0, 2).join(' | ')}`);
    }
  }
  if (ran.workerd) for (const [name, arms] of [['worker-split', ['compiled', 'precompiled']], ['worker-eager', ['compiled', 'precompiled']], ['worker-precompiled', ['precompiled']]])
    for (const arm of arms) p.push(...armProblems(`workerd ${name} ${arm} arm`, results.workerd?.[name]?.[arm]));
  for (const [where, hits] of [['bundles', results.codeScan?.hits], ['package source', results.codeScan?.packageSourceHits]]) {
    if (!hits) { p.push(`code scan of ${where}: missing`); continue; }
    for (const [label, list] of Object.entries(hits)) {
      const extra = list.filter(h => !(ALLOW[label] ?? []).includes(h));
      if (extra.length) p.push(`code scan of ${where}: ${label} at ${extra.slice(0, 3).join(', ')}`);
    }
  }
  return p;
}

/** Each injected failure must be reported; a clean result must not be. Throws otherwise. */
export function selfTest() {
  const arm = () => ({ totals: { pass: 3, fail: 0 }, groups: { g: { pass: 3, fail: 0, failures: [] } } });
  const report = line => JSON.stringify({ 'csp-report': { 'source-file': 'http://127.0.0.1:1/control.js', 'line-number': line } });
  const clean = () => ({
    node: { compiled: arm(), precompiled: arm() },
    browser: { compiled: arm(), precompiled: arm(), evalBlocked: true, functionBlocked: true, errors: [], consoleErrors: [],
      violations: [{}, {}], cspReports: [report(7), report(8)] },
    workerd: { 'worker-split': { compiled: arm(), precompiled: arm() }, 'worker-eager': { compiled: arm(), precompiled: arm() }, 'worker-precompiled': { precompiled: arm() } },
    codeScan: { hits: { 'eval(': [] }, packageSourceHits: { 'eval(': [] } },
  });
  const ran = { browser: true, workerd: true };
  if (verdict(clean(), ran).length) throw new Error(`runtime verdict self-test: a clean result fails: ${verdict(clean(), ran)}`);
  const cases = {
    'a failing case': r => { r.node.compiled.totals.fail = 1; },
    'a fatal arm': r => { r.workerd['worker-eager'].compiled = { fatal: '500' }; },
    'a missing arm': r => { delete r.browser; },
    'missing totals': r => { delete r.workerd['worker-precompiled'].precompiled.totals; },
    'zero cases': r => { r.node.precompiled.totals.pass = 0; },
    'a bundle scan hit': r => { r.codeScan.hits['eval('] = ['bundles/x.js@1']; },
    'a package source hit': r => { r.codeScan.packageSourceHits['eval('] = ['src/x.mjs@1']; },
    'a stray CSP report': r => { r.browser.cspReports.push(JSON.stringify({ 'csp-report': { 'source-file': 'http://127.0.0.1:1/entry.js' } })); },
    'an extra violation': r => { r.browser.violations.push({}); },
    'eval not blocked': r => { r.browser.evalBlocked = false; },
    'a page error': r => { r.browser.errors.push('TypeError: x'); },
    'a console error': r => { r.browser.consoleErrors.push('boom'); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const r = clean(); mutate(r);
    if (!verdict(r, ran).length) throw new Error(`runtime verdict self-test: ${name} passes`);
  }
  return Object.keys(cases).length;
}
