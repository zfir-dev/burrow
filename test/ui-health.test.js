import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'burrow-health-'));
const state = join(dir, 'state');
mkdirSync(state);
process.env.BURROW_STATE_DIR = state;
process.env.BURROW_CONFIG = join(dir, 'config.env');
writeFileSync(process.env.BURROW_CONFIG, 'BURROW_DOMAIN=example.dev\nBURROW_DASHBOARD_PORT=1\n');

const { probeAll } = await import('../src/dashboard/panels/health.js');
const { startDashboard } = await import('./helpers/dash.js');
const { loadConfig } = await import('../src/config.js');

const listen = () => new Promise((r) => { const s = createServer((c) => c.end()); s.listen(0, '127.0.0.1', () => r(s)); });
const freePort = async () => { const s = await listen(); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('probeAll maps every service to its hostname and checks its ports', async () => {
  const app = await listen();
  const dead = await freePort();
  const file = join(dir, 'acme-shop.tunnel.yml');
  writeFileSync(file, `project: acme-shop
services:
  - name: app
    url: http://127.0.0.1:${app.address().port}
    paths:
      - path: /api
        url: http://127.0.0.1:${dead}
  - name: mail
    url: http://127.0.0.1:${app.address().port}
  - name: status
    url: http_status:204
`);
  writeFileSync(join(state, 'acme-shop.json'), JSON.stringify({ project: 'acme-shop', file }));
  writeFileSync(join(state, 'blog.json'), JSON.stringify({ project: 'blog', file: join(dir, 'missing.yml') }));
  try {
    const r = await probeAll(loadConfig());
    assert.deepEqual(Object.keys(r).sort(), ['acme-shop', 'burrow']);
    const [root, mail, status] = r['acme-shop'];
    assert.equal(root.hostname, 'acme-shop.example.dev');
    assert.equal(root.up, false, 'one of the app targets (/api) is closed');
    assert.deepEqual(root.targets.map((t) => t.up), [true, false]);
    assert.equal(mail.hostname, 'mail-acme-shop.example.dev');
    assert.equal(mail.up, true);
    assert.equal(status.up, null);
    assert.equal(r.burrow[0].hostname, 'burrow.example.dev');
  } finally { app.close(); }
});

test('HTTP: /api/health needs a session and returns the probe', async () => {
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/health`)).status, 401);
    const r = await d.get('/api/health');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.projects['acme-shop']);
    assert.match(await (await d.get('/')).text(), /class="dot"/);
    assert.match(await (await d.get('/panels.js')).text(), /loadHealth/);
  } finally { await d.close(); }
});
