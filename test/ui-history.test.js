import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { sandbox, EXAMPLE } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { recordEvent, readEvents, historyFile, MAX_BYTES, KEEP_LINES } = await import('../src/history.js');
const { startDashboard } = await import('./helpers/dash.js');
const { events } = await import('../src/dashboard/panels.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

test('CLI: state-changing commands are recorded with source and result; read-only and dry runs are not', async () => {
  let r = await sb.run(['up', '-f', EXAMPLE]);
  assert.equal(r.code, 0, r.stderr);
  r = await sb.run(['up', '--dry-run', '-f', EXAMPLE]);
  r = await sb.run(['status', 'acme-shop']);
  r = await sb.run(['down', 'acme-shop'], { env: { BURROW_SOURCE: 'dashboard' } });
  assert.equal(r.code, 0, r.stderr);
  r = await sb.run(['destroy']);
  assert.equal(r.code, 1);
  r = await sb.run(['autostart']);
  const list = readEvents();
  assert.deepEqual(list.map((e) => [e.action, e.project, e.source, e.ok]), [
    ['autostart', null, 'boot', true],
    ['destroy', null, 'cli', false],
    ['down', 'acme-shop', 'dashboard', true],
    ['up', 'acme-shop', 'cli', true],
  ]);
  assert.ok(list.every((e) => !Number.isNaN(Date.parse(e.at)) && e.durationMs >= 0));
  assert.equal((statSync(historyFile()).mode & 0o777).toString(8), '600');
  assert.ok(!readFileSync(historyFile(), 'utf8').includes('test-token'), 'never records secrets');
});

test('readEvents filters, newest first; the file rotates', () => {
  recordEvent({ action: 'restart', project: 'blog', source: 'dashboard', detail: 'x'.repeat(500) });
  assert.equal(readEvents({ project: 'blog' })[0].detail.length, 300);
  assert.equal(readEvents({ source: 'boot' }).length, 1);
  assert.equal(readEvents({ limit: 2 }).length, 2);
  writeFileSync(historyFile(), `${JSON.stringify({ at: new Date().toISOString(), action: 'up', project: 'blog', source: 'cli', ok: true, detail: 'p'.repeat(250) })}\n`.repeat(Math.ceil(MAX_BYTES / 300) + 10));
  recordEvent({ action: 'down', project: 'todo-api' });
  assert.ok(statSync(historyFile()).size < MAX_BYTES);
  const all = readEvents({ limit: 100000 });
  assert.equal(all.length, KEEP_LINES);
  assert.equal(all[0].project, 'todo-api');
});

test('HTTP: /api/history needs a session; dashboard-only actions are recorded too', async () => {
  writeFileSync(historyFile(), '');
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/history`)).status, 401);
    // Loading the real panels registers the listener for in-process events.
    assert.match(await (await d.get('/')).text(), /Event history/);
    events.emit('event', { action: 'edit', project: 'acme-shop', ok: true, detail: '/tmp/acme-shop.tunnel.yml' });
    let j = await (await d.get('/api/history')).json();
    assert.deepEqual(j.events.map((e) => [e.action, e.project, e.source]), [['edit', 'acme-shop', 'dashboard']]);
    assert.equal((await d.get('/api/history?project=BAD..x')).status, 400);
    assert.equal((await d.get('/api/history?source=evil')).status, 400);
    j = await (await d.get('/api/history?project=blog')).json();
    assert.deepEqual(j.events, []);
    assert.ok(existsSync(historyFile()));
  } finally { await d.close(); }
});
