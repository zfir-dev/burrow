import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, EXAMPLE } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';
import { parseProject } from '../src/project.js';
import { includeRules, privateHosts } from '../src/access.js';

// In-memory Cloudflare Access: apps, app policies and tags.
function accessApi({ deny = false } = {}) {
  const st = { apps: [], policies: {}, tags: [] };
  const routes = async ({ method, p, body, ok, fail }) => {
    let m;
    if (!p.includes('/access/')) return false;
    if (deny) { fail(403, 'Authentication error'); return true; }
    if ((m = p.match(/\/access\/tags(?:\/([^/]+))?$/))) {
      if (method === 'POST') { st.tags.push(body.name); ok({ name: body.name }); return true; }
      if (st.tags.includes(m[1])) ok({ name: m[1] }); else fail(404, 'tag not found');
      return true;
    }
    if (/\/access\/apps$/.test(p)) {
      if (method === 'POST') {
        const app = { id: randomUUID(), ...body };
        st.apps.push(app);
        st.policies[app.id] = [];
        ok(app);
      } else ok(st.apps);
      return true;
    }
    if ((m = p.match(/\/access\/apps\/([^/]+)\/policies(?:\/([^/]+))?$/))) {
      const list = st.policies[m[1]];
      if (!list) { fail(404, 'app not found'); return true; }
      if (method === 'POST') { const pol = { id: randomUUID(), ...body }; list.push(pol); ok(pol); return true; }
      if (method === 'PUT') { const i = list.findIndex((x) => x.id === m[2]); list[i] = { id: m[2], ...body }; ok(list[i]); return true; }
      ok(list);
      return true;
    }
    if ((m = p.match(/\/access\/apps\/([^/]+)$/))) {
      const i = st.apps.findIndex((a) => a.id === m[1]);
      if (i < 0) { fail(404, 'app not found'); return true; }
      if (method === 'DELETE') { st.apps.splice(i, 1); delete st.policies[m[1]]; ok({ id: m[1] }); return true; }
      if (method === 'PUT') { st.apps[i] = { ...body, id: m[1] }; ok(st.apps[i]); return true; }
      ok(st.apps[i]);
      return true;
    }
    return false;
  };
  return { st, routes };
}

function projectFile(sb, studio) {
  const dir = join(sb.dir, 'acme-shop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tunnel.yml'), `project: acme-shop
services:
  - name: app
    url: http://localhost:3100
  - name: studio
    url: http://localhost:54323
${studio}`);
  return dir;
}

test('private and allow are validated; allow entries become Access include rules', () => {
  const p = parseProject('project: blog\nservices:\n  - name: app\n    url: http://localhost:4000\n    private: true\n    allow: [Ana@Example.dev, "@example.dev"]\n');
  assert.deepEqual(p.services[0].allow, ['ana@example.dev', '@example.dev']);
  assert.deepEqual(includeRules(p.services[0].allow), [{ email: { email: 'ana@example.dev' } }, { email_domain: { domain: 'example.dev' } }]);
  assert.throws(() => parseProject('project: blog\nservices:\n  - name: app\n    url: http://localhost:4000\n    allow: [a@example.dev]\n'), /only applies with private: true/);
  assert.throws(() => parseProject('project: blog\nservices:\n  - name: app\n    url: http://localhost:4000\n    private: true\n    allow: [nobody]\n'), /invalid "allow" entries nobody/);
  assert.throws(() => parseProject('project: blog\nservices:\n  - name: app\n    url: http://localhost:4000\n    private: "yes"\n'), /"private" must be true or false/);
  const q = parseProject('project: blog\nservices:\n  - name: app\n    url: http://localhost:4000\n    private: true\n');
  const hosts = [{ service: 'app', hostname: 'blog.example.dev' }];
  assert.deepEqual(privateHosts(q, hosts, { accessEmails: 'ops@example.dev' })[0].allow, ['ops@example.dev']);
  assert.throws(() => privateHosts(q, hosts, { accessEmails: '' }), /no "allow" list, and BURROW_ACCESS_EMAILS is empty/);
});

test('up protects private services, keeps it idempotent, follows allow changes, destroy removes the app', async () => {
  const a = accessApi();
  const cf = await mockCloudflare({ routes: a.routes });
  const sb = sandbox({ api: cf.url });
  try {
    let dir = projectFile(sb, '    private: true\n    allow: [ana@example.dev]\n');
    let r = await sb.run(['up', '--dry-run'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /would protect https:\/\/studio-acme-shop\.example\.dev with Cloudflare Access \(allow: ana@example\.dev\)/);

    r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Access: protected https:\/\/studio-acme-shop\.example\.dev/);
    assert.deepEqual(a.st.tags, ['burrow']);
    assert.equal(a.st.apps.length, 1);
    const app = a.st.apps[0];
    assert.deepEqual([app.name, app.domain, app.type, app.tags], ['burrow:acme-shop:studio', 'studio-acme-shop.example.dev', 'self_hosted', ['burrow']]);
    assert.deepEqual(a.st.policies[app.id].map((x) => [x.name, x.decision, x.include]), [['burrow:allow', 'allow', [{ email: { email: 'ana@example.dev' } }]]]);
    assert.ok(existsSync(join(sb.state, 'access', 'acme-shop.json')));

    r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(a.st.apps.length, 1);
    assert.equal(a.st.policies[app.id].length, 1);
    assert.doesNotMatch(r.stdout, /Access:/, 'nothing to change');

    dir = projectFile(sb, '    private: true\n    allow: [ana@example.dev, "@example.dev"]\n');
    r = await sb.run(['up'], { cwd: dir });
    assert.match(r.stdout, /now allows ana@example\.dev, @example\.dev/);
    assert.equal(a.st.policies[app.id][0].include.length, 2);

    r = await sb.run(['destroy', 'acme-shop'], { cwd: sb.dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /deleted Access app burrow:acme-shop:studio/);
    assert.equal(a.st.apps.length, 0);
    assert.ok(!existsSync(join(sb.state, 'access', 'acme-shop.json')));
  } finally { await sb.cleanup(); await cf.close(); }
});

test('BURROW_ACCESS_EMAILS is the default; dropping private: true removes the app', async () => {
  const a = accessApi();
  const cf = await mockCloudflare({ routes: a.routes });
  const sb = sandbox({ api: cf.url, extra: { BURROW_ACCESS_EMAILS: 'ops@example.dev, @example.dev' } });
  try {
    let dir = projectFile(sb, '    private: true\n');
    let r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const app = a.st.apps[0];
    assert.deepEqual(a.st.policies[app.id][0].include, [{ email: { email: 'ops@example.dev' } }, { email_domain: { domain: 'example.dev' } }]);
    dir = projectFile(sb, '');
    r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Access: removed burrow:acme-shop:studio; https:\/\/studio-acme-shop\.example\.dev is public again/);
    assert.equal(a.st.apps.length, 0);
  } finally { await sb.cleanup(); await cf.close(); }
});

test('public projects never call the Access API; a missing allow list fails before any change', async () => {
  const a = accessApi();
  const cf = await mockCloudflare({ routes: a.routes });
  const sb = sandbox({ api: cf.url });
  try {
    let r = await sb.run(['up', '-f', EXAMPLE]);
    assert.equal(r.code, 0, r.stderr);
    r = await sb.run(['destroy', 'acme-shop']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!cf.state.calls.some((c) => c.includes('/access/')), cf.state.calls.join('\n'));

    const dir = projectFile(sb, '    private: true\n');
    r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /service "studio" is private but has no "allow" list/);
    assert.equal(cf.live().length, 0);
  } finally { await sb.cleanup(); await cf.close(); }
});

test('apps not owned by burrow are left alone; prune deletes orphaned burrow apps', async () => {
  const a = accessApi();
  a.st.apps.push(
    { id: 'foreign', name: 'Team wiki', domain: 'studio-acme-shop.example.dev', type: 'self_hosted', tags: [] },
    { id: 'old', name: 'burrow:old-blog:app', domain: 'old-blog.example.dev', type: 'self_hosted', tags: ['burrow'] },
    { id: 'lookalike', name: 'burrow:todo-api:app', domain: 'todo-api.example.dev', type: 'self_hosted', tags: [] },
  );
  a.st.policies.foreign = []; a.st.policies.old = []; a.st.policies.lookalike = [];
  const cf = await mockCloudflare({ routes: a.routes });
  const sb = sandbox({ api: cf.url });
  try {
    const dir = projectFile(sb, '    private: true\n    allow: [ana@example.dev]\n');
    let r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /already has an Access app not managed by burrow \("Team wiki"\); leaving it alone/);
    assert.deepEqual(a.st.apps.map((x) => x.id).sort(), ['foreign', 'lookalike', 'old']);

    r = await sb.run(['prune', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Access app burrow:old-blog:app \(old-blog\.example\.dev\)/);
    assert.match(r.stdout, /and 1 Access app\(s\)/);
    r = await sb.run(['prune', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Deleted Access app burrow:old-blog:app/);
    assert.deepEqual(a.st.apps.map((x) => x.id).sort(), ['foreign', 'lookalike']);
  } finally { await sb.cleanup(); await cf.close(); }
});

test('a token without Access permission gets a clear error', async () => {
  const a = accessApi({ deny: true });
  const cf = await mockCloudflare({ routes: a.routes });
  const sb = sandbox({ api: cf.url });
  try {
    const dir = projectFile(sb, '    private: true\n    allow: [ana@example.dev]\n');
    let r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Cloudflare Access: .*HTTP 403.*Account > Access: Apps and Policies > Edit/);
    r = await sb.run(['prune', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Skipping Access apps/);
  } finally { await sb.cleanup(); await cf.close(); }
});
