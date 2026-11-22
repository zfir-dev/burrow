import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { renameText } = await import('../src/project-form.js');
const { readMeta } = await import('../src/process.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

const names = () => cf.live().map((t) => t.name).sort();
const recordNames = () => cf.state.records.map((r) => r.name).sort();

test('renameText changes only project: and keeps comments and other keys', () => {
  const src = '# acme shop\nproject: acme-shop # the name\nservices:\n  - name: app\n    url: http://localhost:3000\n    originRequest: {noTLSVerify: true}\n';
  const out = renameText(src, 'acme-store');
  assert.match(out, /^# acme shop\nproject: acme-store # the name\n/);
  assert.match(out, /noTLSVerify: true/);
  assert.throws(() => renameText(src, 'acme-shop'), /already called/);
  assert.throws(() => renameText(src, 'Bad Name'), /Invalid/);
  assert.throws(() => renameText(src, 'burrow'), /reserved/);
});

test('HTTP: rename needs the project stopped, then moves tunnel, DNS and state to the new name', async () => {
  const dir = join(sb.dir, 'acme');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'tunnel.yml');
  writeFileSync(file, '# acme shop\nproject: acme-shop\nservices:\n  - name: app\n    url: http://localhost:3000\n  - name: api\n    url: http://localhost:3001\n');
  let r = await sb.run(['up', '-f', file]);
  assert.equal(r.code, 0, r.stderr);
  const d = await startDashboard();
  const url = '/api/projects/acme-shop/rename';
  try {
    assert.equal((await fetch(d.base + url, { method: 'POST', headers: { cookie: d.cookie }, body: '{}' })).status, 403, 'CSRF header');
    assert.equal((await d.post('/api/projects/ghost/rename', { to: 'x' })).status, 404);
    assert.equal((await d.post(url, { to: 'Bad Name', dryRun: true })).status, 400);
    assert.equal((await d.post(url, { to: 'burrow', dryRun: true })).status, 400);
    assert.equal((await d.post(url, { to: 'acme-shop', dryRun: true })).status, 400);

    let j = await (await d.post(url, { to: 'acme-store', dryRun: true })).json();
    assert.deepEqual(j.hosts, [
      { from: 'acme-shop.example.dev', to: 'acme-store.example.dev' },
      { from: 'api-acme-shop.example.dev', to: 'api-acme-store.example.dev' },
    ]);
    assert.equal(j.file, file);
    assert.equal(j.running, true);
    assert.equal((await d.post(url, { to: 'acme-store' })).status, 400, 'needs confirm');
    assert.equal((await d.post(url, { to: 'acme-store', confirm: true })).status, 409, 'running: stop it first');
    assert.deepEqual(names(), ['burrow-acme-shop'], 'nothing changed');

    assert.equal((await d.post('/api/tunnels/acme-shop/down')).status, 200);
    cf.state.tunnels.push({ id: 't-taken', name: 'burrow-taken', status: 'inactive', connections: [] });
    assert.equal((await d.post(url, { to: 'taken', confirm: true })).status, 409, 'an existing Cloudflare tunnel is never taken over');

    r = await d.post(url, { to: 'acme-store', confirm: true, up: true });
    j = await r.json();
    assert.equal(r.status, 200, j.output || j.error);
    assert.equal(j.renamed, true);
    assert.deepEqual(names(), ['burrow-acme-store', 'burrow-taken']);
    assert.deepEqual(recordNames(), ['acme-store.example.dev', 'api-acme-store.example.dev']);
    assert.match(readFileSync(file, 'utf8'), /^# acme shop\nproject: acme-store\n/);
    assert.equal(readMeta('acme-shop'), null);
    assert.equal(readMeta('acme-store').file, file);
    const list = (await (await d.get('/api/tunnels')).json()).projects;
    assert.ok(list.some((p) => p.project === 'acme-store' && p.running && p.editable));
    assert.ok(!list.some((p) => p.project === 'acme-shop'));
    assert.match(await (await d.get('/')).text(), /Rename…/);
    const { Script } = await import('node:vm');
    const js = await (await d.get('/panels.js')).text();
    assert.doesNotThrow(() => new Script(js), 'the panel script parses');
  } finally { await d.close(); }
});

test('HTTP: a project file in the import directory is renamed with the project', async () => {
  const d = await startDashboard();
  try {
    let r = await d.post('/api/projects', { form: { project: 'blog', app: '4000' }, up: false });
    let j = await r.json();
    assert.equal(r.status, 200, j.error);
    const oldFile = j.file;
    assert.ok(oldFile.endsWith('/blog.tunnel.yml'));
    r = await d.post('/api/projects/blog/rename', { to: 'acme-shop', confirm: true });
    j = await r.json();
    assert.equal(r.status, 200, j.output || j.error);
    assert.ok(j.file.endsWith('/acme-shop.tunnel.yml'));
    assert.ok(!existsSync(oldFile));
    assert.match(readFileSync(j.file, 'utf8'), /project: acme-shop/);
    assert.equal(readMeta('blog'), null);
    assert.equal(readMeta('acme-shop').file, j.file);
    assert.ok(!cf.live().some((t) => t.name === 'burrow-acme-shop'), 'not started unless asked');
  } finally { await d.close(); }
});
