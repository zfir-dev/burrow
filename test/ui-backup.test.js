import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { readMeta } = await import('../src/process.js');
const { defaultImportDir } = await import('../src/transfer.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

function remember(name, port, extra = '') {
  const dir = join(sb.dir, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'tunnel.yml');
  writeFileSync(file, `project: ${name}\nservices:\n  - name: app\n    url: http://localhost:${port}\n${extra}`);
  writeFileSync(join(sb.state, `${name}.json`), JSON.stringify({ project: name, file }));
  return file;
}

test('HTTP: download a backup, preview a restore, restore with confirmation', async () => {
  const blogFile = remember('blog', 4000, 'hooks:\n  post_up: echo secret-command\n');
  remember('acme-shop', 3000);
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/backup/export`)).status, 401);
    let r = await d.get('/api/backup/export');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="burrow-projects-\d{4}-\d\d-\d\d\.yml"/);
    const text = await r.text();
    assert.ok(!text.includes('secret-command'), 'hooks are never exported');
    assert.ok(!text.includes('test-token'));
    const bundle = YAML.parse(text);
    assert.deepEqual(bundle.projects.map((p) => p.project), ['acme-shop', 'blog']);

    // A bundle from "another machine": blog (known here), todo-api (new), one invalid entry.
    bundle.projects.push({ project: 'todo-api', services: [{ name: 'app', url: 'http://localhost:5000' }] });
    bundle.projects.push({ project: 'Bad Name', services: [] });
    bundle.projects = bundle.projects.filter((p) => p.project !== 'acme-shop');
    bundle.projects[0].services[0].url = 'http://localhost:4100';
    const backup = YAML.stringify(bundle);

    assert.equal((await fetch(`${d.base}/api/backup/preview`, { method: 'POST', headers: { cookie: d.cookie }, body: JSON.stringify({ text: backup }) })).status, 403);
    assert.equal((await d.post('/api/backup/preview', { text: 'just: yaml' })).status, 400);
    r = await d.post('/api/backup/preview', { text: backup });
    let j = await r.json();
    assert.equal(r.status, 200, j.error);
    assert.deepEqual(j.projects.map((p) => [p.project, p.status]), [['blog', 'known'], ['todo-api', 'new'], ['Bad Name', 'invalid']]);
    assert.deepEqual(j.projects[1].hostnames, ['todo-api.example.dev']);
    assert.equal(j.projects[0].knownAt, blogFile);

    assert.equal((await d.post('/api/backup/restore', { text: backup, projects: ['todo-api'] })).status, 400, 'needs the typed confirmation');
    assert.equal((await d.post('/api/backup/restore', { text: backup, projects: [], confirm: 'restore' })).status, 400);
    r = await d.post('/api/backup/restore', { text: backup, projects: ['todo-api', 'blog', 'Bad Name'], confirm: 'restore' });
    j = await r.json();
    assert.equal(r.status, 200);
    assert.deepEqual(j.written.map((w) => w.project), ['todo-api']);
    assert.deepEqual(j.skipped.map((s) => s.project), ['blog', 'Bad Name']);
    const todoFile = join(defaultImportDir(), 'todo-api.tunnel.yml');
    assert.ok(existsSync(todoFile));
    assert.equal(readMeta('todo-api').file, todoFile);
    assert.match(readFileSync(blogFile, 'utf8'), /localhost:4000/, 'blog untouched without replace');
    assert.equal(cf.live().length, 0, 'nothing is started');

    r = await d.post('/api/backup/restore', { text: backup, projects: ['blog'], replace: true, confirm: 'restore' });
    j = await r.json();
    assert.deepEqual(j.written.map((w) => [w.project, w.replaced]), [['blog', true]]);
    assert.equal(readMeta('blog').file, join(defaultImportDir(), 'blog.tunnel.yml'));
    assert.match(readFileSync(readMeta('blog').file, 'utf8'), /localhost:4100/);
    assert.match(await (await d.get('/')).text(), /Download backup/);
  } finally { await d.close(); }
});
