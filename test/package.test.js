import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package.json is set up for a global install, never for publishing', () => {
  assert.deepEqual(pkg.bin, { burrow: 'bin/burrow.js' });
  assert.equal(pkg.private, true, 'private: true keeps it off the npm registry');
  assert.equal(pkg.type, 'module');
  assert.match(pkg.engines.node, />=18/);
  for (const f of ['bin', 'src', 'examples', 'README.md']) assert.ok(pkg.files.includes(f), f);
});

test('bin has a node shebang and is executable', () => {
  const bin = new URL('../bin/burrow.js', import.meta.url);
  assert.ok(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n'));
  assert.ok(statSync(bin).mode & 0o111, 'bin/burrow.js must be executable');
});

const npm = spawnSync('npm', ['--version'], { timeout: 15000 });
test('npm pack ships the CLI, the dashboard and examples, but not tests or docs', { skip: !!npm.error }, () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  for (const f of ['bin/burrow.js', 'src/commands.js', 'src/dashboard/server.js', 'src/dashboard/ui.js', 'examples/acme-shop.tunnel.yml', 'README.md', 'package.json']) {
    assert.ok(files.includes(f), `${f} missing from the package`);
  }
  assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('docs/')), files.join(', '));
});

// The guard is evaluated in-process with a fake `process`, so no child is spawned.
function runGuard(version) {
  const src = readFileSync(new URL('../bin/burrow.js', import.meta.url), 'utf8');
  const m = src.match(/\/\/ node-guard:start\n([\s\S]*?)\/\/ node-guard:end/);
  assert.ok(m, 'node guard block not found in bin/burrow.js');
  const errors = [];
  let code = null;
  const fake = { versions: { node: version }, exit: (c) => { code = c; throw new Error('exit'); } };
  const con = { error: (msg) => errors.push(msg) };
  try { new Function('process', 'console', m[1])(fake, con); } catch (e) { if (e.message !== 'exit') throw e; }
  return { code, errors };
}

test('the CLI refuses to run on Node < 18', () => {
  const r = runGuard('16.20.0');
  assert.equal(r.code, 1);
  assert.match(r.errors.join('\n'), /needs Node\.js 18 or newer \(found 16\.20\.0\)/);
});

test('the Node guard lets Node 18+ through', () => {
  for (const v of ['18.0.0', '20.11.1', process.versions.node]) assert.deepEqual(runGuard(v), { code: null, errors: [] });
});

test('the guard is the first thing after the shebang', () => {
  const src = readFileSync(new URL('../bin/burrow.js', import.meta.url), 'utf8');
  assert.ok(src.startsWith('#!/usr/bin/env node\n// node-guard:start\n'));
});
