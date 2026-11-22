import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

// In-memory Cloudflare Access (apps, policies, tags), as in access.test.js.
const st = { apps: [], policies: {}, tags: [] };
const routes = async ({ method, p, body, ok, fail }) => {
  let m;
  if (!p.includes('/access/')) return false;
  if ((m = p.match(/\/access\/tags(?:\/([^/]+))?$/))) {
    if (method === 'POST') { st.tags.push(body.name); ok({ name: body.name }); } else if (st.tags.includes(m[1])) ok({ name: m[1] }); else fail(404, 'tag not found');
    return true;
  }
  if (/\/access\/apps$/.test(p)) {
    if (method === 'POST') { const app = { id: randomUUID(), ...body }; st.apps.push(app); st.policies[app.id] = []; ok(app); } else ok(st.apps);
    return true;
  }
  if ((m = p.match(/\/access\/apps\/([^/]+)\/policies(?:\/([^/]+))?$/))) {
    const list = st.policies[m[1]];
    if (method === 'POST') { const pol = { id: randomUUID(), ...body }; list.push(pol); ok(pol); return true; }
    if (method === 'PUT') { const i = list.findIndex((x) => x.id === m[2]); list[i] = { id: m[2], ...body }; ok(list[i]); return true; }
    ok(list);
    return true;
  }
  if ((m = p.match(/\/access\/apps\/([^/]+)$/))) {
    const i = st.apps.findIndex((a) => a.id === m[1]);
    if (method === 'DELETE') { st.apps.splice(i, 1); ok({ id: m[1] }); } else ok(st.apps[i]);
    return true;
  }
  return false;
};

const cf = await mockCloudflare({ routes });
const sb = sandbox({ api: cf.url, extra: { BURROW_ACCESS_EMAILS: 'ops@example.dev' } });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { applyAccess } = await import('../src/dashboard/panels/access.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

const TEXT = `# acme shop
project: acme-shop
services:
  - name: app
    url: http://localhost:3000 # storefront
  - name: studio
    url: http://localhost:3001
    originRequest:
      noTLSVerify: true
`;

test('applyAccess edits private:/allow: in place and reports services made public', () => {
  const cfg = { domain: 'example.dev', accessEmails: '' };
  let r = applyAccess(TEXT, [{ service: 'studio', private: true, allow: 'Ana@example.dev, @example.dev' }], cfg);
  assert.match(r.text, /# acme shop/);
  assert.match(r.text, /# storefront/);
  const studio = YAML.parse(r.text).services[1];
  assert.deepEqual(studio, { name: 'studio', url: 'http://localhost:3001', originRequest: { noTLSVerify: true }, private: true, allow: ['ana@example.dev', '@example.dev'] });
  assert.deepEqual(r.toPublic, []);
  assert.throws(() => applyAccess(TEXT, [{ service: 'studio', private: true }], cfg), /BURROW_ACCESS_EMAILS is empty/);
  assert.throws(() => applyAccess(TEXT, [{ service: 'studio', private: true, allow: 'not-an-email' }], cfg), /invalid allow/);
  assert.throws(() => applyAccess(TEXT, [{ service: 'nope', private: true, allow: 'a@example.dev' }], cfg), /no service "nope"/);
  const back = applyAccess(r.text, [{ service: 'studio', private: false }], cfg);
  assert.deepEqual(back.toPublic, ['studio']);
  assert.equal(YAML.parse(back.text).services[1].allow, undefined);
});

test('HTTP: make a service private and apply it, then public again only with confirmation', async () => {
  const dir = join(sb.dir, 'acme-shop');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'tunnel.yml');
  writeFileSync(file, TEXT);
  writeFileSync(join(sb.state, 'acme-shop.json'), JSON.stringify({ project: 'acme-shop', file }));
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/access/acme-shop`)).status, 401);
    let j = await (await d.get('/api/access/acme-shop')).json();
    assert.deepEqual(j.services.map((s) => [s.service, s.hostname, s.private, s.applied]), [
      ['app', 'acme-shop.example.dev', false, false], ['studio', 'studio-acme-shop.example.dev', false, false],
    ]);
    assert.deepEqual(j.defaults, ['ops@example.dev']);
    assert.equal((await d.get('/api/access/blog')).status, 404);
    assert.equal((await fetch(`${d.base}/api/access/acme-shop`, { method: 'POST', headers: { cookie: d.cookie }, body: '{}' })).status, 403);

    // Private with the default allow list, saved but not applied.
    let r = await d.post('/api/access/acme-shop', { services: [{ service: 'studio', private: true, allow: '' }] });
    j = await r.json();
    assert.equal(r.status, 200, j.error);
    assert.equal(j.pending, true);
    assert.deepEqual(j.services[1].effective, ['ops@example.dev']);
    assert.equal(st.apps.length, 0, 'not applied without up');
    let t = await (await d.get('/api/tunnels')).json();
    let row = t.projects.find((p) => p.project === 'acme-shop');
    assert.deepEqual([row.privateCount, row.accessPending], [1, true]);

    r = await d.post('/api/access/acme-shop', { services: [{ service: 'studio', private: true, allow: 'ana@example.dev' }], up: true });
    j = await r.json();
    assert.equal(r.status, 200, j.output);
    assert.deepEqual(st.apps.map((a) => [a.name, a.domain]), [['burrow:acme-shop:studio', 'studio-acme-shop.example.dev']]);
    assert.deepEqual(st.policies[st.apps[0].id][0].include, [{ email: { email: 'ana@example.dev' } }]);
    assert.equal(j.pending, false);
    assert.equal(j.services[1].applied, true);

    r = await d.post('/api/access/acme-shop', { services: [{ service: 'studio', private: false }], up: true });
    j = await r.json();
    assert.equal(r.status, 400);
    assert.deepEqual(j.toPublic, ['studio']);
    assert.match(readFileSync(file, 'utf8'), /private: true/, 'unchanged without confirmation');
    r = await d.post('/api/access/acme-shop', { services: [{ service: 'studio', private: false }], up: true, confirmPublic: true });
    j = await r.json();
    assert.equal(r.status, 200, j.output);
    assert.equal(st.apps.length, 0, 'the Access app is deleted');
    assert.ok(!/private:/.test(readFileSync(file, 'utf8')));
    t = await (await d.get('/api/tunnels')).json();
    row = t.projects.find((p) => p.project === 'acme-shop');
    assert.equal(row.privateCount, 0);
    assert.match(await (await d.get('/')).text(), /I understand, make them public/);
  } finally { await d.close(); }
});
