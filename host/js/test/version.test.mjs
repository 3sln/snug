// P9.15 rework (O2, D343): version.edn is the single source of the version.
// Every version site in the tracked tree holds its :placeholder; a release
// build stamps :version (`bb stamp`), and stamped versions are never checked
// in. kin/scripts/stamp-test.mjs stamps scratch copies and runs this file
// there with SNUG_STAMPED_VERSION set, so the same checks prove a stamped
// tree coherent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SNUG_VERSION as runtimeVersion } from '../src/version.mjs';
import { snugVersion, snugVersionLen, versionByte } from '../../../gen/js/snug/compile/main.mjs';
import { ROOT, SITES, GENERATED, MAX_VERSION_BYTES, parseVersionEdn, readSites, readVersionEdn,
  siteMismatches, versionProblem, writeSites } from '../../../kin/scripts/version-sites.mjs';
import { stampRefusal } from '../../../kin/scripts/stamp.mjs';

const edn = readVersionEdn();
const stamped = process.env.SNUG_STAMPED_VERSION;
const want = stamped ?? edn.placeholder;

test(stamped ? `every version site holds the stamped ${stamped}` : 'every version site holds version.edn\'s placeholder', () => {
  const sites = readSites();
  assert.equal(sites.length, SITES.length + GENERATED.length);
  assert.deepEqual(siteMismatches(sites, want), []);
  // gen/ was emitted from kin's literal (bb drift proves it is current), and the runtime mirror agrees
  assert.equal(snugVersion(), want);
  assert.equal(runtimeVersion, want);
  // the source-key preimage spells the literal: its length and bytes are read from it
  assert.equal(snugVersionLen(), Buffer.byteLength(want));
  assert.deepEqual(Array.from({ length: snugVersionLen() }, (_, i) => versionByte(i)), [...Buffer.from(want, 'ascii')]);
  if (stamped) assert.notEqual(stamped, edn.placeholder);
});

test('version.edn: both keys semver, at most 32 bytes, distinct', () => {
  assert.equal(versionProblem(edn.version), null);
  assert.equal(versionProblem(edn.placeholder), null);
  assert.throws(() => parseVersionEdn('{:version "0.1.0"}'), /:placeholder/);
  assert.throws(() => parseVersionEdn('{:version "1.0" :placeholder "0.0.0-unreleased"}'), /:version/);
  assert.throws(() => parseVersionEdn('{:version "0.1.0" :placeholder "0.1.0"}'), /differ/);
  // a comment naming a key does not count
  assert.throws(() => parseVersionEdn(';; :placeholder "9.9.9"\n{:version "0.1.0"}'), /:placeholder/);
  assert.deepEqual(parseVersionEdn('{:version "0.1.0" ; next\n :placeholder "0.0.0-x"}'), { version: '0.1.0', placeholder: '0.0.0-x' });
  for (const bad of ['1.0', '01.0.0', '1.0.0-é', '', 'v1.0.0', '1.0.0-rc.01'])
    assert.ok(versionProblem(bad), bad);
  for (const good of ['0.1.0', '1.2.3-rc.1+b.7', '0.0.0-unreleased'])
    assert.equal(versionProblem(good), null, good);
  // the Program container's producer field is 32 bytes
  const long = '0.1.0-' + 'a'.repeat(MAX_VERSION_BYTES - 6);
  assert.equal(long.length, 32); assert.equal(versionProblem(long), null);
  assert.match(versionProblem(long + 'a'), /32/);
});

test('a site that disagrees is named; writeSites stamps exactly the version text, idempotently', () => {
  const real = p => readFileSync(join(ROOT, p), 'utf8');
  for (const { file } of [...SITES, ...GENERATED]) {
    const edited = readSites(ROOT, p => p === file ? real(p).replace(want, want + '.1') : real(p));
    assert.equal(siteMismatches(edited, want).length, 1, file);
    const gone = readSites(ROOT, p => p === file ? '' : real(p));
    assert.match(siteMismatches(gone, want)[0], /matched 0 times/, file);
  }
  // a scratch tree with copies of the hand-written sites
  mkdirSync(join(ROOT, '.cache'), { recursive: true });
  const scratch = mkdtempSync(join(ROOT, '.cache', 'version-test-'));
  try {
    for (const { file } of SITES) {
      mkdirSync(join(scratch, file, '..'), { recursive: true });
      writeFileSync(join(scratch, file), real(file));
    }
    const before = SITES.map(({ file }) => real(file));
    const v = '0.1.0-rc.1+build.7';
    assert.deepEqual(writeSites(scratch, v), SITES.map(s => s.file));
    const after = SITES.map(({ file }) => readFileSync(join(scratch, file), 'utf8'));
    // only the version text changed
    after.forEach((text, i) => assert.equal(text.replace(v, want), before[i]));
    assert.deepEqual(writeSites(scratch, v), []);   // idempotent
    assert.throws(() => writeSites(scratch, '1.0'), /semver/);
    // an exported copy (not a checkout of its own) may be stamped
    assert.equal(stampRefusal(scratch), null);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
