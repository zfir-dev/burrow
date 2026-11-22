import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';

const sb = sandbox();
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_SYSTEMCTL = '/bin/true';
process.env.BURROW_SYSTEMD_DIR = join(sb.dir, 'systemd');
for (const k of ['BURROW_ALERT_WEBHOOK', 'BURROW_ALERT_NTFY', 'BURROW_ALERT_NTFY_TOKEN']) delete process.env[k];
const { setConfigValues } = await import('../src/config-file.js');
const { validate, webhookKind } = await import('../src/dashboard/panels/alerts.js');
const { parseEnv } = await import('../src/config.js');
const { startDashboard } = await import('./helpers/dash.js');

const got = [];
let status = 200;
const hook = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  got.push({ url: req.url, headers: req.headers, body });
  res.writeHead(status); res.end();
});
await new Promise((r) => hook.listen(0, '127.0.0.1', r));
const hookUrl = `http://127.0.0.1:${hook.address().port}`;
test.after(async () => { hook.close(); await sb.cleanup(); });

test('setConfigValues replaces, appends and de-duplicates keys, keeps comments and mode 600', () => {
  const file = join(sb.dir, 'other.env');
  writeFileSync(file, '# keep me\nA=1\nB=2\nB=3\n', { mode: 0o644 });
  setConfigValues({ B: 'x', C: 'y' }, file);
  assert.equal(readFileSync(file, 'utf8'), '# keep me\nA=1\nB=x\nC=y\n');
  assert.equal((statSync(file).mode & 0o777).toString(8), '600');
  setConfigValues({ C: '' }, file);
  assert.deepEqual(parseEnv(readFileSync(file, 'utf8')), { A: '1', B: 'x', C: '' });
  assert.throws(() => setConfigValues({ A: 'x\nCF_API_TOKEN=evil' }, file), /single line/);
  assert.throws(() => setConfigValues({ 'bad key': 'x' }, file), /bad config key/);
});

test('channel validation and webhook kinds', () => {
  assert.throws(() => validate('webhook', 'ftp://x'), /http\(s\) URL/);
  assert.throws(() => validate('webhook', 'https://a b'), /no spaces/);
  assert.throws(() => validate('ntfy', 'bad#topic!'), /topic name/);
  validate('ntfy', 'burrow-alerts');
  validate('ntfy', 'https://ntfy.example.dev/burrow');
  validate('webhook', '');
  assert.equal(webhookKind('https://hooks.slack.com/services/T/B/x'), 'Slack');
  assert.equal(webhookKind('https://discord.com/api/webhooks/1/x'), 'Discord');
  assert.equal(webhookKind('https://example.dev/hook'), 'JSON');
});

test('HTTP: configure channels without echoing them, send a test alert, manage the unit', async () => {
  const d = await startDashboard();
  const secretPath = '/T000/B000/s3cr3t-hook-path';
  try {
    assert.equal((await fetch(`${d.base}/api/alerts`)).status, 401);
    assert.equal((await fetch(`${d.base}/api/alerts/test`, { method: 'POST', headers: { cookie: d.cookie } })).status, 403);
    let j = await (await d.get('/api/alerts')).json();
    assert.equal(j.channels.webhook.set, false);
    assert.equal((await d.post('/api/alerts/test', {})).status, 400);

    assert.equal((await d.post('/api/alerts/config', { webhook: 'https://x\nCF_API_TOKEN=evil' })).status, 400);
    let r = await d.post('/api/alerts/config', { webhook: hookUrl + secretPath, ntfy: `${hookUrl}/burrow-topic`, ntfyToken: 'tk_secret_123' });
    const text = await r.text();
    assert.equal(r.status, 200, text);
    assert.ok(!text.includes('s3cr3t') && !text.includes('burrow-topic') && !text.includes('tk_secret_123'), 'secrets are never sent back');
    j = JSON.parse(text);
    assert.deepEqual([j.channels.webhook.set, j.channels.webhook.kind, j.channels.ntfy.set, j.channels.ntfyToken.set], [true, 'JSON', true, true]);
    const cfg = parseEnv(readFileSync(sb.config, 'utf8'));
    assert.equal(cfg.BURROW_ALERT_WEBHOOK, hookUrl + secretPath);
    assert.equal(cfg.CF_API_TOKEN, 'test-token', 'other settings are kept');
    assert.ok(!d.logs.join('\n').includes('s3cr3t'));

    r = await d.post('/api/alerts/test', {});
    assert.equal(r.status, 200);
    assert.equal(got.length, 2);
    const wh = got.find((g) => g.url === secretPath);
    assert.match(JSON.parse(wh.body).text, /burrow-test is degraded: this is a test alert/);
    const nt = got.find((g) => g.url === '/burrow-topic');
    assert.equal(nt.headers.authorization, 'Bearer tk_secret_123');

    status = 500;
    r = await d.post('/api/alerts/test', {});
    assert.equal(r.status, 502);
    assert.equal((await r.json()).errors.length, 2);

    r = await d.post('/api/alerts/config', { ntfy: null, ntfyToken: null });
    j = await r.json();
    assert.deepEqual([j.channels.ntfy.set, j.channels.ntfyToken.set, j.channels.webhook.set], [false, false, true]);

    mkdirSync(join(sb.state, 'watch'), { recursive: true });
    writeFileSync(join(sb.state, 'watch', 'state.json'), JSON.stringify({ 'acme-shop': { status: 'down', pending: null, count: 0, since: 1 } }), { flag: 'w' });
    j = await (await d.get('/api/alerts')).json();
    assert.deepEqual(j.watch.map((w) => [w.project, w.status]), [['acme-shop', 'down']]);

    assert.equal((await d.post('/api/alerts/service', { action: 'install', interval: 1 })).status, 400);
    r = await d.post('/api/alerts/service', { action: 'install', interval: 120, debounce: 3 });
    j = await r.json();
    assert.equal(r.status, 200, j.output);
    const unit = readFileSync(join(sb.dir, 'systemd', 'burrow-watch.service'), 'utf8');
    assert.match(unit, /watch --interval 120 --debounce 3/);
    assert.equal(j.service.installed, true);
    assert.equal((await d.post('/api/alerts/service', { action: 'uninstall' })).status, 400);
    r = await d.post('/api/alerts/service', { action: 'uninstall', confirm: true });
    assert.equal(r.status, 200);
    assert.ok(!existsSync(join(sb.dir, 'systemd', 'burrow-watch.service')));
  } finally { await d.close(); }
});
