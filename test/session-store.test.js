import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sandbox } from './helpers/cli.js';

const sb = sandbox({ api: 'http://127.0.0.1:1' });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
const { createDashboard } = await import('../src/dashboard/server.js');
const { sessionsFile, openSessionStore } = await import('../src/dashboard/session-store.js');
const { startDashboard, PASSWORD } = await import('./helpers/dash.js');
test.after(() => sb.cleanup());

// A second server on the same state dir, as after a restart; returns the status of GET /.
async function statusAfterRestart(cookie, opts = {}) {
  const server = createDashboard({ password: PASSWORD, log: () => {}, persistSessions: true, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { cookie }, redirect: 'manual' });
    return r.status;
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}

test('sessions survive a restart; the file is private and holds no password', async () => {
  const d = await startDashboard({ persistSessions: true });
  await d.close();
  assert.equal(await statusAfterRestart(d.cookie), 200, 'still signed in after a restart');
  const file = sessionsFile();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes(PASSWORD), 'no password on disk');
  assert.equal(Object.keys(JSON.parse(raw).sessions).length >= 1, true);
});

test('a changed password, sign-out and sign-out-everywhere still end persisted sessions', async () => {
  const a = await startDashboard({ persistSessions: true });
  assert.equal(await statusAfterRestart(a.cookie, { password: 'another long password' }), 303, 'password changed');
  const b = await startDashboard({ persistSessions: true });
  assert.equal((await b.post('/logout')).status, 200);
  assert.equal(await statusAfterRestart(b.cookie), 303, 'signed out');
  const c = await startDashboard({ persistSessions: true });
  const r = await c.post('/api/sessions/revoke-all', { confirm: true });
  assert.equal(r.status, 200, await r.text());
  assert.equal(await statusAfterRestart(a.cookie), 303, 'everywhere: other sessions too');
  assert.equal(await statusAfterRestart(c.cookie), 303, 'everywhere: this one too');
  await Promise.all([a.close(), b.close(), c.close()]);
});

test('expired sessions are dropped when the store is loaded', async () => {
  const d = await startDashboard({ persistSessions: true });
  await d.close();
  const file = sessionsFile();
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const s of Object.values(data.sessions)) s.exp = Date.now() - 1000;
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  assert.equal(openSessionStore().sessions.size, 0);
  assert.equal(await statusAfterRestart(d.cookie), 303);
});

test('without persistSessions a restart still ends every session, and nothing is written', async () => {
  const before = existsSync(sessionsFile()) ? readFileSync(sessionsFile(), 'utf8') : null;
  const d = await startDashboard();
  await d.close();
  const server = createDashboard({ password: PASSWORD, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const r = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { cookie: d.cookie }, redirect: 'manual' });
  server.closeAllConnections?.(); await new Promise((res) => server.close(res));
  assert.equal(r.status, 303);
  assert.equal(existsSync(sessionsFile()) ? readFileSync(sessionsFile(), 'utf8') : null, before);
});
