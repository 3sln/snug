// What the outside world holds for a release (D368): read-only queries of the git remote, the
// GitHub release, npm and crates.io, used by release-guard.mjs, by the release build's check of
// already-published bytes, and by the publish jobs' checks after publishing.
//
//     node kin/scripts/release-registry.mjs state <version> [--remote <git url>] [--repo <owner/name>]
//     node kin/scripts/release-registry.mjs verify <build dir> [--wait <seconds>]
//         every artefact in <build dir>/artefacts that a registry already holds at this version
//         has the registry's bytes (npm dist.integrity, the crates.io index cksum); exit 1 otherwise.
//         --wait polls until each named artefact is visible (after a publish).
//     node kin/scripts/release-registry.mjs verify <build dir> --only <artefact file> [--wait <s>]
//
// Every HTTP request sends `User-Agent: snug-release-check` and nothing else that names a
// person. npm and crates.io requests are unauthenticated. The api.github.com request alone
// carries `Authorization: Bearer $GH_TOKEN` when GH_TOKEN is set (release.yml passes the run's
// own short-lived token, for the API's rate limit); without it, it is unauthenticated too.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGES = Object.freeze({
  npm: [{ name: '@3sln/snug', file: v => `3sln-snug-${v}.tgz` }, { name: '@3sln/snug-wasm', file: v => `3sln-snug-wasm-${v}.tgz` }],
  crate: { name: 'snug-cbor', file: v => `snug-cbor-${v}.crate` },
});
const UA = { 'User-Agent': 'snug-release-check' };

async function get(url, { json = true, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try { r = await fetch(url, { headers: { ...UA, ...headers }, redirect: 'follow' }); }
    catch (e) { if (attempt < 3) { await new Promise(s => setTimeout(s, 2000 * (attempt + 1))); continue; } throw new Error(`${url}: ${e.message}`); }
    if (r.status === 404) return null;
    if (r.ok) return json ? r.json() : r.text();
    if (attempt < 3 && r.status >= 500) { await new Promise(s => setTimeout(s, 2000 * (attempt + 1))); continue; }
    throw new Error(`${url}: HTTP ${r.status}`);
  }
}

/** npm's record of one version: { integrity, shasum } or null. */
export async function npmVersion(name, version) {
  const doc = await get(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`);
  return doc ? { integrity: doc.dist?.integrity, shasum: doc.dist?.shasum } : null;
}
/** The crates.io sparse index's line for one version: { cksum, yanked } or null. */
export async function crateVersion(name, version) {
  const text = await get(`https://index.crates.io/${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`, { json: false });
  if (!text) return null;
  for (const line of text.split('\n').filter(Boolean)) { const e = JSON.parse(line); if (e.vers === version) return { cksum: e.cksum, yanked: e.yanked }; }
  return null;
}
/** The GitHub release for tag v<version>: true or false (GH_TOKEN, when set, for the rate limit). */
export async function githubRelease(repo, version) {
  // a 404 is "no release"; a 403 (rate limit) or any other error throws
  const auth = process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {};
  return (await get(`https://api.github.com/repos/${repo}/releases/tags/v${encodeURIComponent(version)}`, { headers: auth })) !== null;
}
/** A remote's tag or branch: { object, commit } (commit: the peeled target) or null. */
export function remoteRef(remote, ref) {
  const r = spawnSync('git', ['ls-remote', remote, ref, `${ref}^{}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-remote ${remote} ${ref}: ${r.stderr.trim()}`);
  const lines = r.stdout.trim().split('\n').filter(Boolean).map(l => l.split('\t'));
  if (!lines.length) return null;
  const peeled = lines.find(([, n]) => n.endsWith('^{}'));
  return { object: lines.find(([, n]) => !n.endsWith('^{}'))[0], commit: (peeled ?? lines[0])[0] };
}

/** Everything a release of `version` needs, and what of it already exists. */
export async function releaseState(version, { remote, repo }) {
  const [srcTag, distTag] = [remoteRef(remote, `refs/tags/src/v${version}`), remoteRef(remote, `refs/tags/v${version}`)];
  const npm = {};
  for (const p of PACKAGES.npm) npm[p.name] = await npmVersion(p.name, version);
  return { version, srcTag, distTag, release: await githubRelease(repo, version), npm, crate: await crateVersion(PACKAGES.crate.name, version) };
}

const sha256 = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const sri512 = p => 'sha512-' + createHash('sha512').update(readFileSync(p)).digest('base64');

/** Each built artefact a registry already holds must be byte-identical to it. Returns problems. */
export async function verifyBuilt(dir, { only, waitS = 0 } = {}) {
  const build = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')), v = build.version, problems = [], lines = [];
  const files = readdirSync(join(dir, 'artefacts'));
  const deadline = Date.now() + waitS * 1000;
  const poll = async f => { for (;;) { const x = await f(); if (x || Date.now() >= deadline) return x; await new Promise(s => setTimeout(s, 10000)); } };
  for (const p of PACKAGES.npm) {
    const file = p.file(v);
    if (only && only !== file) continue;
    if (!files.includes(file)) { problems.push(`${file}: not built`); continue; }
    const got = await poll(() => npmVersion(p.name, v));
    if (!got) { if (waitS) problems.push(`${p.name}@${v}: not on npm after ${waitS} s`); else lines.push(`${p.name}@${v}: not on npm yet`); continue; }
    if (got.integrity !== sri512(join(dir, 'artefacts', file))) problems.push(`${p.name}@${v}: npm's dist.integrity ${got.integrity} is not the built ${file}'s`);
    else lines.push(`${p.name}@${v}: npm's dist.integrity is the built ${file}'s`);
  }
  const c = PACKAGES.crate, file = c.file(v);
  if (!only || only === file) {
    const got = await poll(() => crateVersion(c.name, v));
    if (!got) { if (waitS) problems.push(`${c.name} ${v}: not in the crates.io index after ${waitS} s`); else lines.push(`${c.name} ${v}: not on crates.io yet`); }
    else if (got.cksum !== sha256(join(dir, 'artefacts', file))) problems.push(`${c.name} ${v}: the index cksum ${got.cksum} is not the built ${file}'s`);
    else lines.push(`${c.name} ${v}: the crates.io index cksum is the built ${file}'s${got.yanked ? ' (yanked)' : ''}`);
  }
  return { problems, lines };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const opt = (n, f) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : f; };
  if (cmd === 'state' && arg) {
    console.log(JSON.stringify(await releaseState(arg, { remote: opt('remote', 'https://github.com/3sln/snug.git'), repo: opt('repo', '3sln/snug') }), null, 2));
  } else if (cmd === 'verify' && arg) {
    const { problems, lines } = await verifyBuilt(resolve(arg), { only: opt('only'), waitS: Number(opt('wait', 0)) });
    for (const l of lines) console.log(`  ok   ${l}`);
    for (const p of problems) console.log(`  FAIL ${p}`);
    process.exit(problems.length ? 1 : 0);
  } else { console.error('usage: release-registry.mjs state <version> | verify <build dir> [--only <file>] [--wait <s>]'); process.exit(2); }
}
