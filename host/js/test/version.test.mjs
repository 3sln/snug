// P9.15 (D338 §1.1): every version site agrees with kin's snug-version, the one
// source of truth. A release sets the literal in kin/compile/main.kin, re-emits
// gen/, and sets the manifests below; this test fails until all of them agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SNUG_VERSION as runtimeVersion } from '../src/version.mjs';
import { snugVersion, snugVersionLen, versionByte } from '../../../gen/js/snug/compile/main.mjs';

const root = new URL('../../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

// Semantic Versioning 2.0.0's grammar (semver.org's suggested expression). It is
// ASCII only, which kin's str-len / str-u8 rely on.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** The version literal `snug-version` returns in kin/compile/main.kin. */
export function kinVersion(source) {
  const m = /\(defn \^:pub \^Str snug-version \[\][\s\S]*?\(return "([^"]*)"\)\)/.exec(source);
  return m ? m[1] : null;
}

/** The `version` of a Cargo.toml's [package] table. */
export function cargoVersion(toml) {
  const pkg = /^\[package\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml);
  const m = pkg && /^version\s*=\s*"([^"]*)"\s*$/m.exec(pkg[1]);
  return m ? m[1] : null;
}

/** Every site, as [name, version] (version null when the site cannot be read). */
export function versionSites(readFile) {
  return [
    ['kin/compile/main.kin snug-version', kinVersion(readFile('kin/compile/main.kin'))],
    ['host/js/package.json', JSON.parse(readFile('host/js/package.json')).version ?? null],
    ['host/wasm-sdk/package.json', JSON.parse(readFile('host/wasm-sdk/package.json')).version ?? null],
    ['host/rust/Cargo.toml', cargoVersion(readFile('host/rust/Cargo.toml'))],
    ['host/wasm/Cargo.toml', cargoVersion(readFile('host/wasm/Cargo.toml'))],
    ['host/js/src/version.mjs', /SNUG_VERSION = '([^']*)'/.exec(readFile('host/js/src/version.mjs'))?.[1] ?? null],
  ];
}

/** The disagreements: each site that is unreadable, not semver, or not kin's. */
export function versionMismatches(sites) {
  const [[, want]] = sites, out = [];
  if (want === null || !SEMVER.test(want)) out.push(`kin's snug-version ${JSON.stringify(want)} is not a semver string`);
  for (const [name, v] of sites.slice(1))
    if (v !== want) out.push(`${name} says ${JSON.stringify(v)}, kin says ${JSON.stringify(want)}`);
  return out;
}

test('every version site equals kin\'s snug-version', () => {
  const sites = versionSites(read);
  assert.deepEqual(versionMismatches(sites), []);
  const v = sites[0][1];
  // gen/ was emitted from that source (bb drift proves it is current), the runtime mirror agrees
  assert.equal(snugVersion(), v);
  assert.equal(runtimeVersion, v);
  // the source-key preimage spells the literal: its length and bytes are read from it
  assert.equal(snugVersionLen(), Buffer.byteLength(v));
  assert.deepEqual(Array.from({ length: snugVersionLen() }, (_, i) => versionByte(i)), [...Buffer.from(v, 'ascii')]);
});

test('a mismatched or malformed version site fails the check', () => {
  const real = read;
  const edit = (path, from, to) => p => {
    const text = real(p);
    if (p !== path) return text;
    assert.ok(text.includes(from), `${path} has ${from}`);
    return text.replace(from, to);
  };
  const v = kinVersion(real('kin/compile/main.kin'));
  const bump = v === '9.9.9' ? '9.9.8' : '9.9.9';
  for (const [path, from, to] of [
    ['host/js/package.json', `"version": "${v}"`, `"version": "${bump}"`],
    ['host/wasm-sdk/package.json', `"version": "${v}"`, `"version": "${bump}"`],
    ['host/rust/Cargo.toml', `version = "${v}"`, `version = "${bump}"`],
    ['host/wasm/Cargo.toml', `version = "${v}"`, `version = "${bump}"`],
    ['host/js/src/version.mjs', `'${v}'`, `'${bump}'`],
    ['kin/compile/main.kin', `(return "${v}"))`, `(return "${bump}"))`],
  ]) {
    const out = versionMismatches(versionSites(edit(path, from, to)));
    assert.ok(out.length > 0, `a bumped ${path} is caught`);
  }
  // not semver: caught even when every site agrees
  for (const bad of ['1.0', '01.0.0', '1.0.0-é', ''])
    assert.ok(versionMismatches([['kin', bad], ['x', bad]]).length > 0, bad);
  // a semver with pre-release and build metadata is accepted
  assert.deepEqual(versionMismatches([['kin', '1.2.3-rc.1+b.7'], ['x', '1.2.3-rc.1+b.7']]), []);
  // an unreadable site is a mismatch
  assert.ok(versionMismatches([['kin', '1.2.3'], ['x', null]]).length > 0);
});
