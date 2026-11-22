import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, EXAMPLE } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const T = (id, name, connections = []) => ({ id, name, status: connections.length ? 'healthy' : 'inactive', connections });
const R = (id, name, tunnelId, project) => ({ id, type: 'CNAME', name, content: `${tunnelId}.cfargotunnel.com`, comment: `burrow:${project}` });

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

test('HTTP: cleanup lists orphans like prune and deletes only confirmed, still-orphaned picks', async () => {
  const up = await sb.run(['up', '-f', EXAMPLE]);
  assert.equal(up.code, 0, up.stderr);
  const acme = cf.live()[0];
  cf.state.tunnels.push(T('t-old', 'burrow-old-demo'), T('t-gone', 'burrow-gone-demo'), T('t-active', 'burrow-todo-api', [{ colo_name: 'MRU' }]));
  cf.state.records.push(
    R('r-ghost', 'ghost.example.dev', 'missing', 'ghost'),
    R('r-old', 'old-demo.example.dev', 't-old', 'old-demo'),
    R('r-active', 'todo-api.example.dev', 't-active', 'todo-api'),
  );
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/cleanup`)).status, 401);
    assert.equal((await fetch(`${d.base}/api/cleanup`, { method: 'POST', headers: { cookie: d.cookie }, body: '{}' })).status, 403);

    let j = await (await d.get('/api/cleanup')).json();
    assert.deepEqual(j.tunnels.map((t) => t.name).sort(), ['burrow-gone-demo', 'burrow-old-demo']);
    assert.deepEqual(j.records.map((r) => r.id).sort(), ['r-ghost', 'r-old']);
    assert.deepEqual(j.skipped.map((t) => t.name), ['burrow-todo-api']);
    j = await (await d.get('/api/cleanup?includeActive=1')).json();
    assert.ok(j.tunnels.some((t) => t.name === 'burrow-todo-api'));

    assert.equal((await d.post('/api/cleanup', { tunnelIds: ['t-old'] })).status, 400, 'needs the typed confirmation');
    assert.equal((await d.post('/api/cleanup', { confirm: 'delete' })).status, 400, 'needs a selection');

    // acme-shop's real tunnel and the active one are not orphans: never deleted, even if asked.
    let r = await d.post('/api/cleanup', { confirm: 'delete', tunnelIds: ['t-old', acme.id, 't-active'], recordIds: ['r-ghost'] });
    j = await r.json();
    assert.equal(r.status, 200, j.output);
    assert.deepEqual(j.deleted, { tunnels: 1, records: 2 });
    assert.equal(j.skipped, 2);
    assert.deepEqual(cf.live().map((t) => t.name).sort(), ['burrow-acme-shop', 'burrow-gone-demo', 'burrow-todo-api']);
    assert.deepEqual(cf.state.records.map((x) => x.id).filter((id) => id.startsWith('r-')), ['r-active']);
    assert.ok(cf.state.records.some((x) => x.name === 'acme-shop.example.dev'));

    j = await (await d.get('/api/cleanup')).json();
    assert.deepEqual(j.tunnels.map((t) => t.name), ['burrow-gone-demo']);
    assert.match(await (await d.get('/')).text(), /Delete from Cloudflare\?/);
  } finally { await d.close(); }
});

test('HTTP: cleanup without Cloudflare config says so', async () => {
  const keep = process.env.BURROW_CONFIG;
  process.env.BURROW_CONFIG = '/nonexistent/burrow.env';
  const d = await startDashboard();
  try {
    const r = await d.get('/api/cleanup');
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /not configured/);
  } finally { await d.close(); process.env.BURROW_CONFIG = keep; }
});
