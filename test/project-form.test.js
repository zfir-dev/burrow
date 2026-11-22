import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
// The dashboard (and the CLI it spawns) use the sandbox config, state and mock API.
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;

const { normalizeForm, formFromText, renderNew, renderEdit } = await import('../src/project-form.js');
const { startDashboard } = await import('./helpers/dash.js');
const { parseProject } = await import('../src/project.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

test('normalizeForm validates names, targets and paths', () => {
  assert.throws(() => normalizeForm({ project: 'Bad Name', app: '3000' }), /Invalid project name/);
  assert.throws(() => normalizeForm({ project: 'blog' }), /app port or at least one/);
  assert.throws(() => normalizeForm({ project: 'blog', services: [{ name: 'mail', target: '' }] }), /needs a name and a port/);
  assert.throws(() => normalizeForm({ project: 'blog', app: '3000', paths: [{ path: 'api', target: '1' }] }), /must start with \//);
  assert.throws(() => normalizeForm({ project: 'blog', services: [{ name: 'x', target: '1' }], paths: [{ path: '/a', target: '2' }] }), /paths need an app/);
  assert.throws(() => normalizeForm({ project: 'blog', app: '1', services: [{ name: 'app', target: '2' }] }), /root service/);
  const f = normalizeForm({ project: 'blog', app: '4000', paths: [{ path: '', target: '' }], services: [{ name: 'Mail Box', target: '8025' }] });
  assert.deepEqual(f, { project: 'blog', app: '4000', paths: [], services: [{ name: 'mail-box', target: '8025' }], autostart: false });
});

test('renderNew matches burrow add, and the form round-trips', () => {
  const text = renderNew({ project: 'acme-shop', app: '3000', paths: [{ path: '/api', target: '3001' }],
    services: [{ name: 'mail', target: 'http://127.0.0.1:8025' }], autostart: true });
  const proj = parseProject(text);
  assert.equal(proj.autostart, true);
  assert.deepEqual(proj.services.map((s) => s.url), ['http://localhost:3000', 'http://127.0.0.1:8025']);
  assert.deepEqual(formFromText(text), {
    project: 'acme-shop', app: '3000', paths: [{ path: '/api', target: '3001' }],
    services: [{ name: 'mail', target: 'http://127.0.0.1:8025' }], autostart: true,
  });
});

test('renderEdit keeps comments, unknown keys and per-service extras', () => {
  const before = `# acme-shop tunnel
project: acme-shop
domain: example.dev
hooks:
  pre_up: npm run build
services:
  - name: web
    root: true
    url: http://localhost:3000
    originRequest: { noTLSVerify: true }
    paths:
      - path: /api
        url: http://localhost:3001
        originRequest: { httpHostHeader: api.local }
  - name: admin
    url: http://localhost:3002
    private: true
  - name: old
    url: http://localhost:3009
`;
  const after = renderEdit(before, {
    project: 'acme-shop', app: '3100', paths: [{ path: '/api', target: '3101' }, { path: '/ws', target: '3102' }],
    services: [{ name: 'admin', target: '3202' }, { name: 'mail', target: '8025' }], autostart: true,
  });
  assert.match(after, /^# acme-shop tunnel/);
  const doc = YAML.parse(after);
  assert.equal(doc.domain, 'example.dev');
  assert.equal(doc.hooks.pre_up, 'npm run build');
  assert.equal(doc.autostart, true);
  assert.deepEqual(doc.services, [
    { name: 'web', url: 'http://localhost:3100', root: true, originRequest: { noTLSVerify: true }, paths: [
      { path: '/api', url: 'http://localhost:3101', originRequest: { httpHostHeader: 'api.local' } },
      { path: '/ws', url: 'http://localhost:3102' },
    ] },
    { name: 'admin', url: 'http://localhost:3202', private: true },
    { name: 'mail', url: 'http://localhost:8025' },
  ]);
  assert.equal(YAML.parse(renderEdit(after, { ...formFromText(after), autostart: false })).autostart, undefined);
  assert.throws(() => renderEdit(before, { project: 'blog', app: '1' }), /renaming/);
});

test('HTTP: create, check, read and edit a project; up runs the CLI', async () => {
  const d = await startDashboard();
  try {
    const form = { project: 'todo-api', app: '5000', services: [{ name: 'mail', target: '8025' }] };
    let r = await d.post('/api/projects/check', { form });
    let j = await r.json();
    assert.equal(r.status, 200);
    assert.deepEqual(j.hostnames, ['todo-api.example.dev', 'mail-todo-api.example.dev']);
    assert.equal((await d.post('/api/projects/check', { form: { project: 'todo-api' } })).status, 400);

    assert.equal((await fetch(`${d.base}/api/projects`, { method: 'POST', headers: { cookie: d.cookie }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${d.base}/api/projects/todo-api/config`)).status, 401);

    r = await d.post('/api/projects', { form, up: false });
    j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.file, join(sb.dir, 'projects', 'todo-api.tunnel.yml'));
    assert.ok(existsSync(j.file));
    assert.equal(JSON.parse(readFileSync(join(sb.state, 'todo-api.json'), 'utf8')).file, j.file);
    assert.match((await (await d.post('/api/projects', { form })).json()).error, /already exists/);
    assert.equal((await d.post('/api/projects', { form: { ...form, project: 'burrow' } })).status, 400);

    const list = await (await d.get('/api/tunnels')).json();
    assert.equal(list.projects.find((p) => p.project === 'todo-api').editable, true);

    j = await (await d.get('/api/projects/todo-api/config')).json();
    assert.deepEqual(j.form, { project: 'todo-api', app: '5000', paths: [], services: [{ name: 'mail', target: '8025' }], autostart: false });
    assert.equal((await d.get('/api/projects/blog/config')).status, 404);

    r = await d.post('/api/projects/todo-api/config', { form: { ...j.form, app: '5001' }, up: true });
    j = await r.json();
    assert.equal(r.status, 200, j.output);
    assert.match(j.output, /cloudflared started/);
    assert.match(readFileSync(j.file, 'utf8'), /localhost:5001/);
    assert.equal(cf.live().filter((t) => t.name === 'burrow-todo-api').length, 1);
    assert.equal((await d.post('/api/projects/todo-api/config', { form: { project: 'todo-api' } })).status, 400);

    writeFileSync(j.file, 'project: todo-api\nservices: nope\n');
    assert.equal((await d.get('/api/projects/todo-api/config')).status, 422);
  } finally { await d.close(); }
});
