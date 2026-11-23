import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

function project(sb, name, port) {
  const dir = join(sb.dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tunnel.yml'), `project: ${name}
services:
  - name: app
    url: http://localhost:${port}
hooks:
  pre_up: echo "pre_up|${name}" >> hooks.log
  post_up: echo "post_up|${name}" >> hooks.log
`);
  return dir;
}
const lines = (dir) => (existsSync(join(dir, 'hooks.log')) ? readFileSync(join(dir, 'hooks.log'), 'utf8').trim().split('\n') : []);

test('restart --no-hooks skips pre_up/post_up, for one project and for all; plain restart runs them', async () => {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  try {
    const blog = project(sb, 'blog', 4100);
    const shop = project(sb, 'acme-shop', 4200);
    for (const dir of [blog, shop]) {
      const r = await sb.run(['up'], { cwd: dir });
      assert.equal(r.code, 0, r.stderr);
    }
    assert.deepEqual(lines(blog), ['pre_up|blog', 'post_up|blog']);

    let r = await sb.run(['restart', 'blog', '--no-hooks']);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Running pre_up hook/);
    r = await sb.run(['restart', '--no-hooks']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /== acme-shop[\s\S]*== blog/);
    r = await sb.run(['restart', '--no-hooks', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /would run pre_up hook/);
    assert.deepEqual(lines(blog), ['pre_up|blog', 'post_up|blog'], 'no hook ran');
    assert.deepEqual(lines(shop), ['pre_up|acme-shop', 'post_up|acme-shop']);

    r = await sb.run(['restart']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(lines(blog), ['pre_up|blog', 'post_up|blog', 'pre_up|blog', 'post_up|blog']);
    r = await sb.run(['restart', 'acme-shop']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(lines(shop).length, 6);
  } finally { await sb.cleanup(); await cf.close(); }
});
