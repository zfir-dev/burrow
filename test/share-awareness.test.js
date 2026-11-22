import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, EXAMPLE } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const pidOf = (sb, p) => Number(readFileSync(join(sb.state, `${p}.pid`), 'utf8'));
const metaPath = (sb, p) => join(sb.state, `${p}.json`);

async function withShare(fn) {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  try {
    let r = await sb.run(['up', '-f', EXAMPLE]);
    assert.equal(r.code, 0, r.stderr);
    r = await sb.run(['share', '8080', '--name', 'demo', '--detach']);
    assert.equal(r.code, 0, r.stderr);
    await fn({ cf, sb });
  } finally { await sb.cleanup(); await cf.close(); }
}

test('restart with no project restarts detached shares on the same tunnel', async () => {
  await withShare(async ({ cf, sb }) => {
    const before = { app: pidOf(sb, 'acme-shop'), share: pidOf(sb, 'share-demo') };
    const tunnels = cf.live().length;
    let r = await sb.run(['restart', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[dry-run\] share-demo: would re-apply demo\.example\.dev -> http:\/\/localhost:8080/);

    r = await sb.run(['restart']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /share-demo: restarted cloudflared .*https:\/\/demo\.example\.dev/);
    assert.notEqual(pidOf(sb, 'share-demo'), before.share);
    assert.notEqual(pidOf(sb, 'acme-shop'), before.app);
    assert.equal(cf.live().length, tunnels, 'no tunnel is recreated');
    const share = cf.live().find((t) => t.name === 'burrow-share-demo');
    assert.deepEqual(cf.state.configs[share.id].ingress[0], { hostname: 'demo.example.dev', service: 'http://localhost:8080' });
  });
});

test('restart share-<label> recreates a missing CNAME', async () => {
  await withShare(async ({ cf, sb }) => {
    cf.state.records = cf.state.records.filter((x) => x.comment !== 'burrow:share-demo');
    const r = await sb.run(['restart', 'share-demo']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /recreated DNS demo\.example\.dev/);
    assert.equal(cf.state.records.filter((x) => x.comment === 'burrow:share-demo').length, 1);
  });
});

test('a share owned by a running "burrow share" is skipped', async () => {
  await withShare(async ({ sb }) => {
    const meta = JSON.parse(readFileSync(metaPath(sb, 'share-demo'), 'utf8'));
    writeFileSync(metaPath(sb, 'share-demo'), JSON.stringify({ ...meta, ownerPid: process.pid }));
    const before = pidOf(sb, 'share-demo');
    const r = await sb.run(['restart']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`share-demo: skipped; it belongs to a running "burrow share" \\(pid ${process.pid}\\)`));
    assert.equal(pidOf(sb, 'share-demo'), before);
  });
});

test('a share whose tunnel is gone is cleaned up instead of failing', async () => {
  await withShare(async ({ cf, sb }) => {
    cf.live().find((t) => t.name === 'burrow-share-demo').deleted = true;
    const r = await sb.run(['restart', 'share-demo']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /tunnel is gone on Cloudflare; removed the local share\. Share again with: burrow share http:\/\/localhost:8080 --name demo/);
    let gone = false;
    try { readFileSync(metaPath(sb, 'share-demo')); } catch { gone = true; }
    assert.ok(gone);
  });
});

test('completion offers shares only where they work', async () => {
  await withShare(async ({ sb }) => {
    let r = await sb.run(['__complete', 'projects']);
    assert.ok(r.stdout.split('\n').includes('acme-shop'));
    assert.ok(!r.stdout.includes('share-demo'), r.stdout);
    r = await sb.run(['__complete', 'targets']);
    assert.ok(r.stdout.split('\n').includes('share-demo'));
    assert.ok(r.stdout.split('\n').includes('acme-shop'));
    r = await sb.run(['__complete', 'shares']);
    assert.equal(r.stdout.trim(), 'share-demo');
    r = await sb.run(['completion', 'bash']);
    assert.match(r.stdout, /down\)\n.*\n.*burrow __complete targets/);
    assert.match(r.stdout, /up\)\n.*\n.*burrow __complete projects/);
    r = await sb.run(['completion', 'zsh']);
    assert.match(r.stdout, /restart\)\n.*\n.*burrow __complete targets/);
  });
});

test('export skips shares with a note and refuses to export one by name', async () => {
  await withShare(async ({ sb }) => {
    let r = await sb.run(['export']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Note: 1 temporary share\(s\) not exported \(share-demo\)/);
    assert.match(r.stdout, /^# 1 temporary share\(s\) not exported/m);
    assert.match(r.stdout, /project: acme-shop/);
    assert.ok(!/project: share-demo/.test(r.stdout));
    r = await sb.run(['export', '--json']);
    assert.ok(!JSON.parse(r.stdout).projects.some((p) => p.project === 'share-demo'));
    r = await sb.run(['export', '--project', 'share-demo']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /share-demo: temporary share\(s\) from "burrow share" can't be exported/);
  });
});
