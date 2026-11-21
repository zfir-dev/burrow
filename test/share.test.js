import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomLabel, targetUrl } from '../src/share.js';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

test('randomLabel and targetUrl', () => {
  for (let i = 0; i < 50; i++) assert.match(randomLabel(), /^[a-z][a-z0-9]{9}$/);
  assert.equal(targetUrl('8080'), 'http://localhost:8080');
  assert.equal(targetUrl('https://localhost:8443'), 'https://localhost:8443');
  assert.throws(() => targetUrl('70000'), /Invalid port/);
  assert.throws(() => targetUrl('ftp://x'), /http/);
});

test('share --dry-run is offline', async () => {
  const sb = sandbox({ api: 'http://127.0.0.1:1' });
  try {
    const r = await sb.run(['share', '8080', '--name', 'demo', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /demo\.example\.dev/);
    assert.match(r.stdout, /burrow-share-demo/);
  } finally {
    await sb.cleanup();
  }
});

test('share --detach creates tunnel + DNS; burrow down removes them', async () => {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  try {
    let r = await sb.run(['share', '8080', '--name', 'pixel-demo', '--detach']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /https:\/\/pixel-demo\.example\.dev/);
    assert.deepEqual(cf.live().map((t) => t.name), ['burrow-share-pixel-demo']);
    assert.deepEqual(cf.state.records.map((r) => [r.name, r.comment, r.proxied]), [
      ['pixel-demo.example.dev', 'burrow:share-pixel-demo', true],
    ]);
    assert.deepEqual(cf.state.configs[cf.live()[0].id].ingress, [
      { hostname: 'pixel-demo.example.dev', service: 'http://localhost:8080' },
      { service: 'http_status:404' },
    ]);
    assert.ok(existsSync(join(sb.state, 'share-pixel-demo.pid')));

    r = await sb.run(['share', '9090', '--name', 'pixel-demo', '--detach']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already exists/);

    r = await sb.run(['down']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /share removed/);
    assert.equal(cf.live().length, 0);
    assert.equal(cf.state.records.length, 0);
    assert.ok(!existsSync(join(sb.state, 'share-pixel-demo.json')));
  } finally {
    await sb.cleanup();
    await cf.close();
  }
});

test('Ctrl+C on a foreground share removes it', async () => {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  try {
    const child = sb.start(['share', '3000']);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no prompt: ${out}`)), 15000);
      child.stdout.on('data', () => { if (out.includes('Ctrl+C')) { clearTimeout(t); resolve(); } });
    });
    assert.match(out, /https:\/\/[a-z][a-z0-9]{9}\.example\.dev/);
    assert.equal(cf.live().length, 1);
    child.kill('SIGINT');
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0);
    assert.match(out, /Removed https:/);
    assert.equal(cf.live().length, 0);
    assert.equal(cf.state.records.length, 0);
  } finally {
    await sb.cleanup();
    await cf.close();
  }
});

test('burrow destroy also removes a share', async () => {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  try {
    await sb.run(['share', '8080', '--name', 'blog-preview', '--detach']);
    const r = await sb.run(['destroy', 'share-blog-preview']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(cf.live().length, 0);
    assert.equal(cf.state.records.length, 0);
  } finally {
    await sb.cleanup();
    await cf.close();
  }
});
