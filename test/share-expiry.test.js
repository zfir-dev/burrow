import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { parseExpires, stopReason } = await import('../src/share.js');
const { readMeta, saveMeta } = await import('../src/process.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

const meta = (label) => { try { return JSON.parse(readFileSync(join(sb.state, `share-${label}.json`), 'utf8')); } catch { return null; } };
const FAST = { env: { BURROW_SHARE_POLL_MS: '150' } };

// Start a foreground share and wait for its Ctrl+C prompt.
async function foreground(args) {
  const child = sb.start(['share', ...args], FAST);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no prompt: ${out}`)), 15000);
    child.stdout.on('data', () => { if (out.includes('Ctrl+C')) { clearTimeout(t); resolve(); } });
  });
  const closed = new Promise((r) => child.on('close', r));
  return { child, out: () => out, closed };
}

test('parseExpires and stopReason', () => {
  assert.equal(parseExpires('30m'), 30 * 60e3);
  assert.equal(parseExpires('2h'), 2 * 3600e3);
  assert.equal(parseExpires('7d'), 7 * 24 * 3600e3);
  for (const bad of ['10s', '0m', '31d', 'soon', '', '5']) assert.throws(() => parseExpires(bad), /Invalid --expires/);
  const now = Date.parse('2026-11-22T12:00:00Z');
  assert.equal(stopReason({ expiresAt: '2026-11-22T13:00:00Z' }, now), null);
  assert.match(stopReason({ expiresAt: '2026-11-22T11:00:00Z' }, now), /expired/);
  assert.match(stopReason({ stopRequestedAt: '2026-11-22T11:59:00Z' }, now), /dashboard/);
  assert.match(stopReason(null, now), /removed/);
});

test('share --expires: saved for detached shares, shown in --dry-run, bad values refused', async () => {
  let r = await sb.run(['share', '8080', '--name', 'acme-demo', '--expires', '2h', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /until 20\d\d-/);
  r = await sb.run(['share', '8080', '--name', 'acme-demo', '--expires', '10s', '--detach']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Invalid --expires "10s"/);
  assert.equal(cf.live().length, 0, 'nothing created');
  const before = Date.now();
  r = await sb.run(['share', '8080', '--name', 'acme-demo', '--expires', '2h', '--detach']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Expires at .*a background watcher removes it then/);
  const left = Date.parse(meta('acme-demo').expiresAt) - before;
  assert.ok(left > 2 * 3600e3 - 60e3 && left <= 2 * 3600e3 + 60e3, String(left));
  r = await sb.run(['down', 'share-acme-demo']);
  assert.equal(r.code, 0, r.stderr);
});

test('a terminal share stops itself when it expires (the dashboard can move the expiry)', async () => {
  const s = await foreground(['3000', '--name', 'pixel-preview', '--expires', '1h']);
  assert.match(s.out(), /Expires at /);
  assert.ok(meta('pixel-preview').ownerPid > 0);
  // Moving expiresAt into the past (what an "expire now" would do) ends it within a poll.
  const m = readMeta('share-pixel-preview');
  saveMeta('share-pixel-preview', { ...m, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await s.closed, 0);
  assert.match(s.out(), /Stopping: it expired at/);
  assert.match(s.out(), /Removed https:\/\/pixel-preview\.example\.dev/);
  assert.equal(meta('pixel-preview'), null);
  assert.equal(cf.live().length, 0);
  assert.equal(cf.state.records.length, 0);
});

test('HTTP: the dashboard extends and stops a share started in a terminal', async () => {
  const s = await foreground(['3000', '--name', 'todo-preview']);
  const d = await startDashboard();
  try {
    let j = await (await d.get('/api/shares')).json();
    const row = j.shares.find((x) => x.project === 'share-todo-preview');
    assert.equal(row.foreground, true);
    assert.equal(row.expiresAt, null);
    let r = await d.post('/api/shares/share-todo-preview/extend', { expiresIn: 60 });
    assert.equal(r.status, 200);
    assert.ok(Date.parse(meta('todo-preview').expiresAt) > Date.now() + 50 * 60e3, 'the terminal process reads this expiry');
    assert.equal((await d.post('/api/shares/share-todo-preview/stop', {})).status, 400, 'needs confirm');
    r = await d.post('/api/shares/share-todo-preview/stop', { confirm: true });
    j = await r.json();
    assert.equal(r.status, 200, j.output);
    assert.match(j.output, /Asked the terminal "burrow share" \(pid \d+\) to stop/);
    assert.equal(await s.closed, 0);
    assert.match(s.out(), /Stopping: stop requested from the dashboard/);
    assert.equal(meta('todo-preview'), null);
    assert.equal(cf.live().length, 0);
  } finally { await d.close(); if (s.child.exitCode === null) s.child.kill('SIGINT'); }
});
