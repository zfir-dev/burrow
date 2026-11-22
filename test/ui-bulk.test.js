import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url, extra: { BURROW_AUTOSTART: 'todo-api' } });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
process.env.BURROW_SYSTEMCTL = '/bin/true';
process.env.BURROW_SYSTEMD_DIR = join(sb.dir, 'systemd');
const { setAutostart } = await import('../src/dashboard/panels/bulk.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

const projects = join(sb.dir, 'projects');
mkdirSync(projects);
for (const [name, port] of [['acme-shop', 3100], ['blog', 4000]]) {
  const file = join(projects, `${name}.tunnel.yml`);
  writeFileSync(file, `# ${name}\nproject: ${name}\nservices:\n  - name: app\n    url: http://localhost:${port}\n`);
  writeFileSync(join(sb.state, `${name}.json`), JSON.stringify({ project: name, file }));
}

test('setAutostart toggles the key and keeps comments', () => {
  const on = setAutostart('# hi\nproject: blog\nservices:\n  - {name: app, url: "http://localhost:1"}\n', true);
  assert.match(on, /^# hi\n/);
  assert.match(on, /autostart: true/);
  assert.doesNotMatch(setAutostart(on, false), /autostart/);
});

test('HTTP: bulk start and stop, autostart switch and the boot unit', async () => {
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/bulk`, { method: 'POST', headers: { cookie: d.cookie }, body: '{}' })).status, 403);
    assert.equal((await d.post('/api/bulk', { action: 'destroy', projects: ['blog'] })).status, 400);
    assert.equal((await d.post('/api/bulk', { action: 'up', projects: [] })).status, 400);
    assert.equal((await d.post('/api/bulk', { action: 'up', projects: ['burrow'] })).status, 400);
    assert.equal((await d.post('/api/bulk', { action: 'up', projects: ['../x'] })).status, 400);

    let r = await d.post('/api/bulk', { action: 'up', projects: ['acme-shop', 'blog'] });
    let j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.deepEqual(j.results.map((x) => [x.project, x.ok]), [['acme-shop', true], ['blog', true]]);
    assert.equal(cf.live().length, 2);
    let list = (await (await d.get('/api/tunnels')).json()).projects;
    assert.deepEqual(list.filter((p) => p.running).map((p) => p.project), ['acme-shop', 'blog']);

    r = await d.post('/api/bulk', { action: 'down', projects: ['acme-shop', 'blog', 'ghost'] });
    j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j), 'down of an unknown project is a no-op');
    list = (await (await d.get('/api/tunnels')).json()).projects;
    assert.deepEqual(list.filter((p) => p.running), []);

    const blog = list.find((p) => p.project === 'blog');
    assert.deepEqual([blog.autostart, blog.autostartEditable], [false, true]);
    r = await d.post('/api/autostart/blog', { enabled: true });
    assert.equal(r.status, 200);
    assert.match(readFileSync(join(projects, 'blog.tunnel.yml'), 'utf8'), /^# blog\n[\s\S]*autostart: true/);
    list = (await (await d.get('/api/tunnels')).json()).projects;
    assert.equal(list.find((p) => p.project === 'blog').autostartSource, 'file');
    assert.equal((await d.post('/api/autostart/blog', { enabled: 'yes' })).status, 400);
    assert.equal((await d.post('/api/autostart/todo-api', { enabled: false })).status, 409, 'set in BURROW_AUTOSTART');
    assert.equal((await d.post('/api/autostart/ghost', { enabled: true })).status, 404);

    j = await (await d.get('/api/boot')).json();
    assert.equal(j.installed, false);
    assert.deepEqual(j.projects, ['todo-api', 'blog']);
    r = await d.post('/api/boot', { action: 'install' });
    j = await r.json();
    assert.equal(r.status, 200, j.output);
    assert.equal(j.installed, true);
    assert.ok(existsSync(join(sb.dir, 'systemd', 'burrow.service')));
    assert.equal((await d.post('/api/boot', { action: 'uninstall' })).status, 400, 'needs confirm');
    r = await d.post('/api/boot', { action: 'uninstall', confirm: true });
    assert.equal(r.status, 200);
    assert.ok(!existsSync(join(sb.dir, 'systemd', 'burrow.service')));
  } finally { await d.close(); }
});
