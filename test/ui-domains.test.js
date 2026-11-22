import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare({ zones: [
  { id: 'zone-1', name: 'example.dev', status: 'active' },
  { id: 'zone-2', name: 'example.org', status: 'active' },
  { id: 'zone-3', name: 'example.net', status: 'pending' },
] });
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { normalizeDomain, formFromText, renderNew, renderEdit } = await import('../src/project-form.js');
const { readMeta } = await import('../src/process.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

test('the form reads and writes domain:', () => {
  assert.equal(normalizeDomain(undefined), undefined);
  assert.equal(normalizeDomain(' '), '');
  assert.equal(normalizeDomain('Example.ORG.'), 'example.org');
  assert.throws(() => normalizeDomain('nodot'), /invalid domain/);
  const text = renderNew({ project: 'todo-api', domain: 'example.org', app: '4000' });
  assert.deepEqual(Object.keys(YAML.parse(text)), ['project', 'domain', 'services']);
  assert.equal(formFromText(text).domain, 'example.org');
  assert.equal(YAML.parse(renderNew({ project: 'blog', app: '4000' })).domain, undefined);

  const withComment = `# todo api\nproject: todo-api\ndomain: example.org # second zone\nservices:\n  - name: app\n    url: http://localhost:4000\n`;
  const kept = renderEdit(withComment, { project: 'todo-api', app: '4001' });
  assert.match(kept, /domain: example.org # second zone/, 'no domain field: left alone');
  assert.equal(YAML.parse(renderEdit(withComment, { project: 'todo-api', domain: 'example.net', app: '4001' })).domain, 'example.net');
  assert.equal(YAML.parse(renderEdit(withComment, { project: 'todo-api', domain: '', app: '4001' })).domain, undefined, "'' = default");
});

test('HTTP: domain choices, per-domain previews and a rename preview on the project domain', async () => {
  const dir = join(sb.dir, 'blog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tunnel.yml'), 'project: blog\ndomain: example.info\nservices:\n  - name: app\n    url: http://localhost:4000\n  - name: admin\n    url: http://localhost:4001\n');
  writeFileSync(join(sb.state, 'blog.json'), JSON.stringify({ project: 'blog', file: join(dir, 'tunnel.yml') }));
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/domains`)).status, 401);
    let j = await (await d.get('/api/domains')).json();
    assert.equal(j.default, 'example.dev');
    assert.equal(j.error, null);
    assert.deepEqual(j.domains.map((x) => [x.name, x.sources, x.status]), [
      ['example.info', ['in use'], null],
      ['example.net', ['cloudflare'], 'pending'],
      ['example.org', ['cloudflare'], 'active'],
    ]);

    let r = await d.post('/api/projects/check', { form: { project: 'todo-api', domain: 'example.org', app: '5000', services: [{ name: 'mail', target: '8025' }] } });
    j = await r.json();
    assert.equal(r.status, 200, j.error);
    assert.equal(j.domain, 'example.org');
    assert.deepEqual(j.hostnames, ['todo-api.example.org', 'mail-todo-api.example.org']);
    assert.equal((await d.post('/api/projects/check', { form: { project: 'todo-api', domain: 'bad', app: '5000' } })).status, 400);
    r = await d.post('/api/projects', { form: { project: 'todo-api', domain: 'example.org', app: '5000' } });
    j = await r.json();
    assert.equal(r.status, 200, j.error);
    assert.deepEqual(j.hostnames, ['todo-api.example.org']);
    assert.match(readFileSync(readMeta('todo-api').file, 'utf8'), /^domain: example.org$/m);

    j = await (await d.get('/api/projects/blog/config')).json();
    assert.equal(j.form.domain, 'example.info');
    r = await d.post('/api/projects/blog/rename', { to: 'acme-blog', dryRun: true });
    j = await r.json();
    assert.equal(r.status, 200, j.error);
    assert.deepEqual(j.hosts, [
      { from: 'blog.example.info', to: 'acme-blog.example.info' },
      { from: 'admin-blog.example.info', to: 'admin-acme-blog.example.info' },
    ]);
    // Back to the default domain.
    r = await d.post('/api/projects/check', { editing: true, form: { project: 'blog', domain: '', app: '4000' } });
    j = await r.json();
    assert.deepEqual(j.hostnames, ['blog.example.dev']);
    assert.ok(!/domain:/.test(j.yaml));
    assert.match(await (await d.get('/')).text(), /Other domain…/);
    assert.equal(cf.live().length, 0, 'nothing started');
  } finally { await d.close(); }
});
