import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sandbox, EXAMPLE } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

test('the vendored QR library makes a data URL (no eval, works offline)', () => {
  const qrcode = createRequire(import.meta.url)('qrcode-generator');
  const q = qrcode(0, 'M');
  q.addData('https://acme-shop.example.dev');
  q.make();
  assert.ok(q.getModuleCount() >= 21);
  assert.match(q.createDataURL(6, 2), /^data:image\/gif;base64,/);
});

test('HTTP: QR script is served; restart needs a session, CSRF header and a real project', async () => {
  const d = await startDashboard();
  try {
    let r = await fetch(`${d.base}/vendor/qrcode.js`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /var qrcode = function/);

    assert.equal((await fetch(`${d.base}/api/tunnels/acme-shop/restart`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${d.base}/api/tunnels/acme-shop/restart`, { method: 'POST', headers: { cookie: d.cookie } })).status, 403);
    assert.equal((await d.post('/api/tunnels/burrow/restart')).status, 400);
    assert.equal((await d.post('/api/tunnels/BAD..x/restart')).status, 400);

    r = await d.post('/api/tunnels/acme-shop/restart');
    assert.equal(r.status, 500);
    assert.match((await r.json()).output, /no remembered file for "acme-shop"/);

    const up = await sb.run(['up', '-f', EXAMPLE]);
    assert.equal(up.code, 0, up.stderr);
    r = await d.post('/api/tunnels/acme-shop/restart');
    const j = await r.json();
    assert.equal(r.status, 200, j.output);
    assert.match(j.output, /Stopped previous cloudflared/);
    assert.match(j.output, /cloudflared started/);

    const page = await (await d.get('/')).text();
    assert.match(page, /@click="showQr\(h\)"/);
    assert.match(page, /@click="restart\(p\)"/);
  } finally { await d.close(); }
});
