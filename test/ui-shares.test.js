import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
process.env.BURROW_SHARE_HANDOFF_MS = '600';
const { readMeta, saveMeta, removeMeta } = await import('../src/process.js');
const { listShares, sweepExpired } = await import('../src/dashboard/panels/shares.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

// Runs first: the dashboard in the next test starts the background sweeper.
test('sweepExpired stops expired shares; a live terminal owner is asked first', async () => {
  const { spawn } = await import('node:child_process');
  const owner = spawn('sleep', ['30'], { stdio: 'ignore' }); // stands in for a terminal "burrow share"
  try {
    saveMeta('share-old', { share: true, hostname: 'old.example.dev', target: 'http://localhost:1', expiresAt: new Date(Date.now() - 1000).toISOString() });
    saveMeta('share-fresh', { share: true, hostname: 'fresh.example.dev', target: 'http://localhost:2', expiresAt: new Date(Date.now() + 60e3).toISOString() });
    saveMeta('share-fg', { share: true, hostname: 'fg.example.dev', target: 'http://localhost:3', ownerPid: owner.pid, expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.ok(listShares().find((s) => s.project === 'share-old').expired);
    assert.equal(listShares().find((s) => s.project === 'share-fg').foreground, true);
    const calls = [];
    const stopped = await sweepExpired({ run: async (args) => { calls.push(args); return { ok: true, output: '' }; } });
    // share-fg: its owner was asked (stopRequestedAt) and, as it didn't react in time, burrow down.
    assert.ok(readMeta('share-fg').stopRequestedAt);
    assert.deepEqual(calls, [['down', 'share-fg'], ['down', 'share-old']]);
    assert.deepEqual(stopped, [{ project: 'share-fg', ok: true }, { project: 'share-old', ok: true }]);
  } finally {
    owner.kill();
    for (const p of ['share-old', 'share-fresh', 'share-fg']) removeMeta(p);
  }
});

test('HTTP: start a share with an expiry, extend it, stop it with confirmation', async () => {
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/shares`)).status, 401);
    let r = await d.get('/api/shares');
    assert.deepEqual((await r.json()).shares, []);
    assert.equal((await fetch(`${d.base}/api/shares`, { method: 'POST', headers: { cookie: d.cookie }, body: '{"target":"3000"}' })).status, 403, 'CSRF');
    assert.equal((await d.post('/api/shares', { target: 'ftp://x' })).status, 400);
    assert.equal((await d.post('/api/shares', { target: '3000', name: 'Bad Name' })).status, 400);
    assert.equal((await d.post('/api/shares', { target: '3000', expiresIn: 7 })).status, 400);

    const before = Date.now();
    r = await d.post('/api/shares', { target: '3000', name: 'acme-preview', expiresIn: 60 });
    let j = await r.json();
    assert.equal(r.status, 200, j.output || j.error);
    assert.equal(j.share.hostname, 'acme-preview.example.dev');
    assert.equal(j.share.target, 'http://localhost:3000');
    const exp = Date.parse(j.share.expiresAt);
    assert.ok(exp >= before + 3600e3 - 1000 && exp <= Date.now() + 3600e3 + 1000);
    assert.deepEqual(cf.live().map((t) => t.name), ['burrow-share-acme-preview']);
    assert.equal((await d.post('/api/shares', { target: '3001', name: 'acme-preview' })).status, 400, 'name taken');

    r = await d.post('/api/shares', { target: '4000', expiresIn: 0 });
    j = await r.json();
    assert.equal(r.status, 200, j.output);
    assert.match(j.share.label, /^[a-z][a-z0-9]{9}$/);
    assert.equal(j.share.expiresAt, null);
    const random = j.share.project;

    r = await d.post('/api/shares/share-acme-preview/extend', { expiresIn: 1440 });
    assert.ok(Date.parse((await r.json()).share.expiresAt) > Date.now() + 23 * 3600e3);
    assert.equal((await d.post('/api/shares/blog/stop', { confirm: true })).status, 404, 'only shares');
    assert.equal((await d.post('/api/shares/share-acme-preview/stop', {})).status, 400, 'needs confirmation');
    r = await d.post('/api/shares/share-acme-preview/stop', { confirm: true });
    assert.equal(r.status, 200, (await r.json()).output);
    assert.equal(readMeta('share-acme-preview'), null);
    assert.deepEqual(cf.live().map((t) => t.name), [`burrow-${random}`]);
    assert.ok(!cf.state.records.some((x) => x.name === 'acme-preview.example.dev'), 'DNS deleted');

    // A share whose terminal process is gone (pid 999999) is extended and stopped like a detached one.
    saveMeta('share-terminal', { share: true, hostname: 'terminal.example.dev', target: 'http://localhost:5000', ownerPid: 999999 });
    assert.equal(listShares().find((s) => s.project === 'share-terminal').foreground, false);
    assert.equal((await d.post('/api/shares/share-terminal/extend', { expiresIn: 60 })).status, 200);
    r = await d.post('/api/shares/share-terminal/stop', { confirm: true });
    assert.equal(r.status, 200, (await r.json()).output);
    assert.equal(readMeta('share-terminal'), null);
    assert.match(await (await d.get('/')).text(), /Stop sharing/);
  } finally { await d.close(); }
});
