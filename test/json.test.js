import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, EXAMPLE } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

test('ls --json and status --json', async () => {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  try {
    let r = await sb.run(['ls', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), []);

    const blog = join(sb.dir, 'blog.yml');
    writeFileSync(blog, 'project: blog\nservices:\n  - {name: app, url: "http://localhost:4000"}\n');
    assert.equal((await sb.run(['up', '-f', EXAMPLE])).code, 0);
    assert.equal((await sb.run(['up', '-f', blog])).code, 0);
    assert.equal((await sb.run(['down', 'blog'])).code, 0);
    const acme = cf.live().find((t) => t.name === 'burrow-acme-shop');
    acme.status = 'healthy';
    acme.connections = [{ colo_name: 'AMS', opened_at: '2026-01-01T00:00:00Z', client_version: '2026.1.0', origin_ip: '203.0.113.5' }];

    r = await sb.run(['ls', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const list = JSON.parse(r.stdout);
    assert.deepEqual(list.map((p) => [p.project, p.running, p.tunnel.status]), [['acme-shop', true, 'healthy'], ['blog', false, 'inactive']]);
    assert.deepEqual(list[0].hostnames, ['acme-shop.example.dev', 'mail-acme-shop.example.dev', 'studio-acme-shop.example.dev']);
    assert.deepEqual(list[0].tunnel.connections, [{ colo: 'AMS', openedAt: '2026-01-01T00:00:00Z', version: '2026.1.0' }]);
    assert.equal(typeof list[0].pid, 'number');
    assert.equal(list[1].pid, null);

    r = await sb.run(['status', 'acme-shop', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.project, 'acme-shop');
    assert.equal(s.running, true);
    assert.equal(s.tunnel.id, acme.id);
    assert.deepEqual(s.records.map((x) => x.name).sort(), list[0].hostnames);
    assert.ok(s.records.every((x) => x.type === 'CNAME' && x.proxied && x.content === `${acme.id}.cfargotunnel.com`));
    assert.match(s.log, /acme-shop\.log$/);

    r = await sb.run(['status', 'pixel-notes', '--json']);
    assert.deepEqual(JSON.parse(r.stdout).tunnel, null);

    // human output still works
    r = await sb.run(['ls']);
    assert.match(r.stdout, /acme-shop {2}tunnel=healthy {2}local=running/);
  } finally {
    await sb.cleanup();
    await cf.close();
  }
});

test('status --json without Cloudflare config', async () => {
  const sb = sandbox({ extra: { CF_API_TOKEN: '' } });
  try {
    const r = await sb.run(['status', 'acme-shop', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      project: 'acme-shop', running: false, pid: null, log: JSON.parse(r.stdout).log, cloudflare: false, tunnel: null, records: [],
    });
  } finally {
    await sb.cleanup();
  }
});
