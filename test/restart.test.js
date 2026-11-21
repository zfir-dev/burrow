import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, EXAMPLE } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const pidOf = (sb, p) => Number(readFileSync(join(sb.state, `${p}.pid`), 'utf8'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('restart one project gives it a new connector', async () => {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  try {
    let r = await sb.run(['up', '-f', EXAMPLE]);
    assert.equal(r.code, 0, r.stderr);
    const before = pidOf(sb, 'acme-shop');
    r = await sb.run(['restart', 'acme-shop']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Stopped previous cloudflared/);
    const after = pidOf(sb, 'acme-shop');
    assert.notEqual(after, before);
    assert.ok(alive(after));
    await new Promise((res) => setTimeout(res, 300));
    assert.ok(!alive(before));
    assert.equal(cf.live().length, 1, 'the tunnel is reused, not recreated');
  } finally {
    await sb.cleanup();
    await cf.close();
  }
});

test('restart without a project restarts every running connector', async () => {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  try {
    let r = await sb.run(['restart']);
    assert.match(r.stdout, /No running burrow connectors/);

    const blog = join(sb.dir, 'blog.yml');
    writeFileSync(blog, 'project: blog\nservices:\n  - {name: app, url: "http://localhost:4000"}\n');
    assert.equal((await sb.run(['up', '-f', EXAMPLE])).code, 0);
    assert.equal((await sb.run(['up', '-f', blog])).code, 0);
    assert.equal((await sb.run(['down', 'blog'])).code, 0);
    const acme = pidOf(sb, 'acme-shop');

    r = await sb.run(['restart', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /== acme-shop/);
    assert.doesNotMatch(r.stdout, /== blog/);
    assert.equal(pidOf(sb, 'acme-shop'), acme);

    r = await sb.run(['restart']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /== acme-shop/);
    assert.doesNotMatch(r.stdout, /== blog/);
    assert.notEqual(pidOf(sb, 'acme-shop'), acme);
  } finally {
    await sb.cleanup();
    await cf.close();
  }
});
