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
process.env.BURROW_SHARE_EXPIRY_POLL_MS = '100';
const { readMeta, saveMeta } = await import('../src/process.js');
const { watcherAlive, watchExpiry } = await import('../src/share-expiry.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => {
  for (const p of ['share-acme-temp', 'share-blog-temp', 'share-dash-temp', 'share-todo-temp']) {
    const m = readMeta(p);
    if (m?.expiryPid) try { process.kill(m.expiryPid); } catch {}
  }
  await sb.cleanup(); await cf.close();
});

const FAST = { env: { BURROW_SHARE_EXPIRY_POLL_MS: '100' } };
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
};
const expireNow = (p) => saveMeta(p, { ...readMeta(p), expiresAt: new Date(Date.now() - 1000).toISOString() });
const history = () => { try { return readFileSync(join(sb.state, 'history', 'events.jsonl'), 'utf8'); } catch { return ''; } };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a detached share with --expires is removed by its own watcher, no dashboard needed', async () => {
  const r = await sb.run(['share', '3000', '--name', 'acme-temp', '--detach', '--expires', '1h'], FAST);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /a background watcher removes it then/);
  const meta = readMeta('share-acme-temp');
  assert.ok(watcherAlive(meta), 'watcher running');
  assert.match(readFileSync(`/proc/${meta.expiryPid}/cmdline`, 'utf8'), /_share-expire\0share-acme-temp/);
  expireNow('share-acme-temp');
  assert.ok(await until(() => !readMeta('share-acme-temp')), 'share removed');
  assert.ok(!cf.live().some((t) => t.name === 'burrow-share-acme-temp'));
  assert.ok(!cf.state.records.some((x) => x.name === 'acme-temp.example.dev'));
  assert.ok(await until(() => !pidAlive(meta.expiryPid)), 'watcher exited');
  assert.match(history(), /"action":"share expired","project":"share-acme-temp"/);
});

test('extending to "never" stops the watcher; a share without --expires gets none', async () => {
  let r = await sb.run(['share', '3000', '--name', 'blog-temp', '--detach', '--expires', '1h'], FAST);
  assert.equal(r.code, 0, r.stderr);
  const pid = readMeta('share-blog-temp').expiryPid;
  saveMeta('share-blog-temp', { ...readMeta('share-blog-temp'), expiresAt: null });
  assert.ok(await until(() => !pidAlive(pid)), 'watcher exited');
  assert.equal(readMeta('share-blog-temp').expiryPid, undefined);
  assert.ok(readMeta('share-blog-temp'), 'share kept');
  r = await sb.run(['down', 'share-blog-temp']);
  assert.equal(r.code, 0, r.stderr);
  r = await sb.run(['share', '3000', '--name', 'blog-temp', '--detach'], FAST);
  assert.equal(readMeta('share-blog-temp').expiryPid, undefined);
  await sb.run(['down', 'share-blog-temp']);
});

test('HTTP: a share started from the dashboard expires after the dashboard is closed', async () => {
  const d = await startDashboard();
  try {
    const r = await d.post('/api/shares', { target: '3000', name: 'dash-temp', expiresIn: 15 });
    assert.equal(r.status, 200, (await r.json()).output);
    const meta = readMeta('share-dash-temp');
    assert.ok(Date.parse(meta.expiresAt) > Date.now() + 14 * 60e3);
    assert.ok(watcherAlive(meta));
    // extend keeps the same watcher, which re-reads the expiry
    assert.equal((await d.post('/api/shares/share-dash-temp/extend', { expiresIn: 60 })).status, 200);
    assert.equal(readMeta('share-dash-temp').expiryPid, meta.expiryPid);
  } finally { await d.close(); }
  expireNow('share-dash-temp');
  assert.ok(await until(() => !readMeta('share-dash-temp')), 'removed without the dashboard');
});

test('burrow restart starts the watcher again (e.g. after a reboot)', async () => {
  let r = await sb.run(['share', '3000', '--name', 'todo-temp', '--detach', '--expires', '1h'], FAST);
  assert.equal(r.code, 0, r.stderr);
  const old = readMeta('share-todo-temp').expiryPid;
  process.kill(old);
  assert.ok(await until(() => !pidAlive(old)));
  r = await sb.run(['restart', 'share-todo-temp'], FAST);
  assert.equal(r.code, 0, r.stderr);
  const meta = readMeta('share-todo-temp');
  assert.notEqual(meta.expiryPid, old);
  assert.ok(watcherAlive(meta));
  r = await sb.run(['down', 'share-todo-temp']);
  assert.ok(await until(() => !pidAlive(meta.expiryPid)), 'watcher exits once the share is gone');
});

test('watchExpiry: a newer watcher or a removed share ends the loop', async () => {
  saveMeta('share-unit', { share: true, hostname: 'unit.example.dev', expiresAt: new Date(Date.now() + 60e3).toISOString(), expiryPid: 1 });
  assert.equal(await watchExpiry('share-unit', { remove: async () => assert.fail('no removal'), poll: 10 }), 'superseded');
  const { removeMeta } = await import('../src/process.js');
  removeMeta('share-unit');
  assert.equal(await watchExpiry('share-unit', { remove: async () => assert.fail('no removal'), poll: 10 }), 'gone');
});
