import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';
import { evaluate, webhookBody, alertText } from '../src/watch.js';

const listen = (handler) => new Promise((resolve) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });

// Collects webhook and ntfy posts.
async function receiver(status = 200) {
  const posts = [];
  const server = await listen(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    posts.push({ path: req.url, headers: req.headers, body });
    res.writeHead(status);
    res.end();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { posts, base, close: () => close(server) };
}

async function project(sb, cf) {
  const app = await listen((q, s) => s.end('ok'));
  const port = app.address().port;
  const dir = join(sb.dir, 'blog');
  mkdirSync(dir);
  writeFileSync(join(dir, 'tunnel.yml'), `project: blog\nservices:\n  - name: app\n    url: http://127.0.0.1:${port}\n`);
  const r = await sb.run(['up'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const t = cf.live().find((x) => x.name === 'burrow-blog');
  t.status = 'healthy';
  t.connections = [{ colo_name: 'AMS' }];
  return { app, port, dir, tunnel: t };
}

test('evaluate debounces status changes', () => {
  let r = evaluate(undefined, 'ok', 2);
  assert.equal(r.change, null);
  r = evaluate(r.next, 'down', 2);
  assert.equal(r.change, null);
  assert.equal(r.next.pending, 'down');
  r = evaluate(r.next, 'ok', 2);
  assert.equal(r.change, null, 'a blip resets the counter');
  r = evaluate(evaluate(r.next, 'down', 2).next, 'down', 2);
  assert.deepEqual(r.change, { from: 'ok', to: 'down' });
  r = evaluate(r.next, 'ok', 1);
  assert.deepEqual(r.change, { from: 'down', to: 'ok' });
});

test('webhook payload: Slack {text}, Discord {content}, generic JSON otherwise', () => {
  const a = { project: 'blog', from: 'ok', to: 'down', problems: ['cloudflared is not running'], hostnames: ['blog.example.dev'], at: 0 };
  assert.equal(alertText(a), 'burrow: blog is DOWN: cloudflared is not running');
  assert.deepEqual(webhookBody('https://hooks.slack.com/services/T/B/x', a), { text: alertText(a) });
  assert.deepEqual(webhookBody('https://discord.com/api/webhooks/1/x', a), { content: alertText(a) });
  const g = webhookBody('https://alerts.example.dev/hook', a);
  assert.equal(g.project, 'blog');
  assert.equal(g.status, 'down');
  assert.equal(g.previous, 'ok');
  assert.deepEqual(g.hostnames, ['blog.example.dev']);
  assert.equal(alertText({ ...a, from: 'down', to: 'ok' }), 'burrow: blog recovered (was down)');
});

test('watch --once alerts on degraded, down and recovery (webhook + ntfy)', async () => {
  const cf = await mockCloudflare();
  const rx = await receiver();
  const sb = sandbox({ api: cf.url, extra: {
    BURROW_ALERT_WEBHOOK: `${rx.base}/hook`, BURROW_ALERT_NTFY: `${rx.base}/burrow-alerts`, BURROW_ALERT_NTFY_TOKEN: 'tk_example',
  } });
  let p;
  try {
    p = await project(sb, cf);
    const once = async () => { const r = await sb.run(['watch', '--once', '--debounce', '1']); assert.equal(r.code, 0, r.stderr); return r; };
    let r = await once();
    assert.match(r.stdout, /blog: ok/);
    assert.equal(rx.posts.length, 0);
    assert.ok(existsSync(join(sb.state, 'watch', 'state.json')));

    await close(p.app);
    r = await once();
    assert.match(r.stdout, /alert: burrow: blog is degraded: app: nothing listening on 127\.0\.0\.1:\d+/);
    const hook = rx.posts.find((x) => x.path === '/hook');
    const body = JSON.parse(hook.body);
    assert.equal(body.status, 'degraded');
    assert.equal(body.previous, 'ok');
    assert.deepEqual(body.hostnames, ['blog.example.dev']);
    const ntfy = rx.posts.find((x) => x.path === '/burrow-alerts');
    assert.equal(ntfy.headers.title, 'burrow: blog degraded');
    assert.equal(ntfy.headers.authorization, 'Bearer tk_example');
    assert.match(ntfy.body, /https:\/\/blog\.example\.dev/);
    assert.ok(!r.stdout.includes('tk_example') && !r.stdout.includes('/hook'), 'secrets are never printed');

    process.kill(Number(readFileSync(join(sb.state, 'blog.pid'), 'utf8')), 'SIGKILL');
    await new Promise((res) => setTimeout(res, 300));
    rx.posts.length = 0;
    r = await once();
    assert.match(r.stdout, /blog is DOWN: cloudflared is not running \(it exited or crashed\)/);
    assert.equal(rx.posts.find((x) => x.path === '/burrow-alerts').headers.priority, 'high');

    p.app = await new Promise((resolve) => { const s = createServer((q, res) => res.end('ok')); s.listen(p.port, '127.0.0.1', () => resolve(s)); });
    r = await sb.run(['up'], { cwd: p.dir });
    assert.equal(r.code, 0, r.stderr);
    rx.posts.length = 0;
    r = await once();
    assert.match(r.stdout, /alert: burrow: blog recovered \(was down\)/);
    assert.equal(JSON.parse(rx.posts.find((x) => x.path === '/hook').body).status, 'ok');

    rx.posts.length = 0;
    r = await sb.run(['down', 'blog']);
    r = await once();
    assert.equal(rx.posts.length, 0, 'a project stopped with burrow down is not watched');
  } finally { await sb.cleanup(); await cf.close(); await rx.close(); if (p?.app) await close(p.app); }
});

test('debounce across --once runs, tunnel status, and a failing webhook', async () => {
  const cf = await mockCloudflare();
  const rx = await receiver(500);
  const sb = sandbox({ api: cf.url, extra: { BURROW_ALERT_WEBHOOK: `${rx.base}/hook` } });
  let p;
  try {
    p = await project(sb, cf);
    p.tunnel.status = 'down';
    p.tunnel.connections = [];
    let r = await sb.run(['watch', '--once']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /blog: down \(tunnel is down \(no connections\)\) \[down 1\/2\]/);
    assert.equal(rx.posts.length, 0);
    r = await sb.run(['watch', '--once']);
    assert.equal(r.code, 0);
    assert.equal(rx.posts.length, 1);
    assert.match(r.stderr, /webhook alert failed: HTTP 500/);
  } finally { await sb.cleanup(); await cf.close(); await rx.close(); if (p?.app) await close(p.app); }
});

test('watch runs until Ctrl+C', async () => {
  const sb = sandbox({ api: 'http://127.0.0.1:1' });
  try {
    const child = sb.start(['watch', '--interval', '1', '--dry-run']);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.end();
    await new Promise((r) => setTimeout(r, 1500));
    child.kill('SIGINT');
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 8000);
      child.on('close', (c) => { clearTimeout(t); resolve(c); });
    });
    assert.equal(code, 0, out);
    assert.match(out, /Watching running projects every 1s/);
    assert.match(out, /Stopped watching/);
  } finally { await sb.cleanup(); }
});

test('--install-service writes a systemd user unit', async () => {
  const sb = sandbox();
  try {
    const units = join(sb.dir, 'units');
    const calls = join(sb.dir, 'systemctl.log');
    const fake = join(sb.dir, 'fake-systemctl');
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${calls}"\n`);
    chmodSync(fake, 0o755);
    const env = { BURROW_SYSTEMD_DIR: units, BURROW_SYSTEMCTL: fake };
    let r = await sb.run(['watch', '--install-service', '--interval', '30', '--dry-run'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /ExecStart=.*watch --interval 30 --debounce 2/);
    assert.ok(!existsSync(units));
    r = await sb.run(['watch', '--install-service', '--interval', '30'], { env });
    assert.equal(r.code, 0, r.stderr);
    const unit = readFileSync(join(units, 'burrow-watch.service'), 'utf8');
    assert.match(unit, /Type=simple/);
    assert.match(unit, /Restart=on-failure/);
    assert.match(unit, /Environment=BURROW_CONFIG=/);
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['--user daemon-reload', '--user enable --now burrow-watch.service']);
    assert.match(r.stdout, /No alert channel set yet/);
    r = await sb.run(['watch', '--uninstall-service'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(units, 'burrow-watch.service')));
  } finally { await sb.cleanup(); }
});
