import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const directory = new URL('../../../examples/', import.meta.url);
for (const name of readdirSync(directory).filter(n => n.endsWith('.mjs')).sort()) {
  test(`example runs with node: ${name}`, () => {
    const r = spawnSync(process.execPath, [new URL(name, directory).pathname], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    assert.ok(r.stdout.trim());
  });
}
