import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'burrow-test-'));
process.env.BURROW_STATE_DIR = dir;
process.env.BURROW_CONFIG = join(dir, 'none.env');
const { localProjects, runningPid } = await import('../src/process.js');
const { isYes, down, destroy } = await import('../src/commands.js');

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('localProjects lists every pid file in the state dir', () => {
  writeFileSync(join(dir, 'inktion.pid'), '999999999');
  writeFileSync(join(dir, 'blog.pid'), '999999998');
  writeFileSync(join(dir, 'blog.log'), '');
  assert.deepEqual(localProjects(), ['blog', 'inktion']);
});

test('stale pids are not reported as running', () => {
  assert.equal(runningPid('inktion'), null);
});

test('down with no project stops every local connector and clears stale pid files', async () => {
  await down(undefined, {});
  assert.deepEqual(localProjects(), []);
});

test('isYes only accepts y/yes', () => {
  for (const a of ['y', 'Y', 'yes', ' YES ']) assert.ok(isYes(a));
  for (const a of ['', 'n', 'no', 'yep', undefined]) assert.ok(!isYes(a));
});

test('destroy without a project requires --all', async () => {
  await assert.rejects(() => destroy(undefined, {}), /--all/);
});
