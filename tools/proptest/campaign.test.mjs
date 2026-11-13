// P9.9: the campaign's failure path end to end. A seeded known-bad result (--inject) must reach the findings and
// make the campaign exit 1, so the `proptest` gate (and `bb gates release`) fails on findings. Before P9.9 the
// campaign always exited 0 and only summary.json carried the signatures.
//
//     node --test tools/proptest/campaign.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const campaign = join(repo, 'tools/proptest/campaign.mjs');

function run(args) {
  mkdirSync(join(repo, '.cache'), { recursive: true });
  const out = mkdtempSync(join(repo, '.cache', 'proptest-selftest-'));
  try {
    const r = spawnSync(process.execPath, [campaign, '--tree=working', `--out=${out}`, `--log-dir=${join(out, 'log')}`, ...args], { encoding: 'utf8', env: { ...process.env, SNUG_WATCHDOG: '1' } });
    return { status: r.status, stdout: r.stdout + r.stderr, summary: JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) };
  } finally { rmSync(out, { recursive: true, force: true }); }
}

test('a seeded known-bad property result fails the campaign (exit 1) and is named in the findings', () => {
  const r = run(['--minutes=0.05', '--props=4', '--inject=4', '--workers=4:1']);
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.summary.findings.some(f => f.sig === 'P4/injected'), JSON.stringify(r.summary.findings));
  assert.match(r.stdout, /FAIL proptest: .*P4\/injected/);
});

test('--inject names a property by number; another property is not touched by it', () => {
  const r = run(['--minutes=0.05', '--props=4', '--inject=3', '--workers=4:1']);
  assert.ok(!r.summary.findings.some(f => f.sig.endsWith('/injected')), JSON.stringify(r.summary.findings));
  // exit 0 unless the short P4 run itself found something (then it names it)
  if (r.status !== 0) assert.match(r.stdout, /FAIL proptest: /);
});

// P9.9 (coordinator): a slow compile or validate fails on the worker thread's CPU time; wall time alone is a warning.
const cpuClock = typeof process.threadCpuUsage === 'function';
for (const what of ['compile', 'validate']) {
  const flag = what === 'compile' ? '' : 'validate-';
  test(`a ${what} that is slow on the wall clock only (asleep) is a warning, not a failure`, () => {
    const r = run(['--minutes=0.05', '--props=5', `--inject-slow=${flag}wall`, '--workers=5:1']);
    assert.ok(!r.summary.findings.some(f => f.sig === `P5/slow-${what}`), JSON.stringify(r.summary.findings));
    assert.ok(r.summary.warnings.some(w => w.sig === `P5/slow-${what}-wall` && w.examples[0].loadavg.length === 3), JSON.stringify(r.summary.warnings));
    assert.match(r.stdout, new RegExp(`warning \\(does not fail\\): P5/slow-${what}-wall`));
    // exit 0 unless the short P5 run itself found something else (then it names it)
    if (r.status !== 0) assert.match(r.stdout, /FAIL proptest: /);
  });

  test(`a ${what} that is slow in CPU time (busy) fails the campaign as P5/slow-${what}`, { skip: cpuClock ? false : 'no process.threadCpuUsage (Node 23.9+)' }, () => {
    const r = run(['--minutes=0.05', '--props=5', `--inject-slow=${flag}cpu`, '--workers=5:1']);
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.summary.findings.some(f => f.sig === `P5/slow-${what}`), JSON.stringify(r.summary.findings));
    assert.match(r.stdout, new RegExp(`FAIL proptest: .*P5/slow-${what}`));
  });
}

test('--inject-slow refuses an unknown kind', () => {
  const r = spawnSync(process.execPath, [campaign, '--tree=working', '--minutes=0.05', '--props=5', '--inject-slow=nap', '--workers=5:1', `--out=${join(repo, '.cache', 'proptest-selftest-refused')}`], { encoding: 'utf8', env: { ...process.env, SNUG_WATCHDOG: '1' } });
  rmSync(join(repo, '.cache', 'proptest-selftest-refused'), { recursive: true, force: true });
  assert.match(r.stdout + r.stderr, /--inject-slow is wall, cpu, validate-wall or validate-cpu/);
});
