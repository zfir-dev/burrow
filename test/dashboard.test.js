import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'burrow-dash-'));
process.env.BURROW_STATE_DIR = join(dir, 'state');
process.env.BURROW_CONFIG = join(dir, 'none.env');

const { passwordMatches, sessionKey, signSession, verifySession, RateLimiter, parseCookies } =
  await import('../src/dashboard/auth.js');
const { createDashboard } = await import('../src/dashboard/server.js');
const { dashboardProject, buildIngress, parseProject } = await import('../src/project.js');

const PASSWORD = 'correct horse battery';
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('passwordMatches', () => {
  assert.ok(passwordMatches(PASSWORD, PASSWORD));
  assert.ok(!passwordMatches('wrong', PASSWORD));
  assert.ok(!passwordMatches('', ''));
  assert.ok(!passwordMatches(undefined, PASSWORD));
});

test('session cookies: valid, tampered, expired, other key', () => {
  const key = sessionKey(Buffer.alloc(32, 1), PASSWORD);
  const s = signSession(key, 60000, 1000);
  assert.equal(verifySession(key, s.value, 2000), s.id);
  assert.equal(verifySession(key, s.value, 62000), null);
  const [exp, id, sig] = s.value.split('.');
  assert.equal(verifySession(key, `${Number(exp) + 1}.${id}.${sig}`, 2000), null);
  assert.equal(verifySession(key, `${exp}.${id}.${sig.slice(0, -2)}AA`, 2000), null);
  assert.equal(verifySession(sessionKey(Buffer.alloc(32, 1), 'other password!'), s.value, 2000), null);
  assert.equal(verifySession(key, 'garbage', 2000), null);
});

test('rate limiter blocks after max failures and resets', () => {
  const rl = new RateLimiter({ max: 3, windowMs: 1000 });
  for (let i = 0; i < 3; i++) { assert.ok(rl.check('ip', 0).allowed); rl.fail('ip', 0); }
  assert.equal(rl.check('ip', 10).allowed, false);
  assert.ok(rl.check('other', 10).allowed);
  assert.ok(rl.check('ip', 1000).allowed);
  rl.fail('ip', 0); rl.reset('ip');
  assert.ok(rl.check('ip', 10).allowed);
});

test('parseCookies', () => {
  assert.deepEqual(parseCookies('a=1; burrow_session=x.y.z'), { a: '1', burrow_session: 'x.y.z' });
});

test('dashboard tunnel is burrow.<domain> and the name is reserved', () => {
  assert.deepEqual(buildIngress(dashboardProject(7070), 'example.dev'), [
    { hostname: 'burrow.example.dev', service: 'http://localhost:7070' },
    { service: 'http_status:404' },
  ]);
  assert.throws(() => parseProject('project: burrow\nservices:\n  - {name: app, url: "http://x"}\n'), /reserved/);
});

test('refuses to start without a strong password', () => {
  assert.throws(() => createDashboard({ password: '' }), /BURROW_DASHBOARD_PASSWORD/);
  assert.throws(() => createDashboard({ password: 'short' }), /12/);
});

test('HTTP: login flow, auth, CSRF header, rate limit, logout', async () => {
  const logs = [];
  const server = createDashboard({ password: PASSWORD, log: (m) => logs.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (pw, ip = '203.0.113.9') => fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip },
    body: new URLSearchParams({ password: pw }),
  });
  try {
    let r = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/login');
    assert.equal((await fetch(`${base}/api/tunnels`)).status, 401);
    assert.equal((await fetch(`${base}/app.js`, { redirect: 'manual' })).status, 303);

    assert.equal((await login('nope')).status, 401);
    r = await login(PASSWORD);
    assert.equal(r.status, 303);
    const setCookie = r.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0];

    r = await fetch(`${base}/api/tunnels`, { headers: { cookie } });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.deepEqual(data.projects, []);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');

    assert.equal((await fetch(`${base}/api/tunnels/x/down`, { method: 'POST', headers: { cookie } })).status, 403);
    r = await fetch(`${base}/api/tunnels/x/destroy`, { method: 'POST', headers: { cookie, 'X-Burrow': '1' }, body: '{}' });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/api/tunnels/BAD..name/down`, { method: 'POST', headers: { cookie, 'X-Burrow': '1' } });
    assert.ok([400, 404].includes(r.status));

    // rate limit: 5 failures from one IP, then 429 even with the right password
    for (let i = 0; i < 5; i++) assert.equal((await login('bad', '198.51.100.7')).status, 401);
    r = await login(PASSWORD, '198.51.100.7');
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);

    // logout ends the session server-side
    r = await fetch(`${base}/logout`, { method: 'POST', headers: { cookie, 'X-Burrow': '1' } });
    assert.equal(r.status, 200);
    assert.equal((await fetch(`${base}/api/tunnels`, { headers: { cookie } })).status, 401);

    assert.ok(!logs.join('\n').includes(PASSWORD), 'password must never be logged');
  } finally {
    server.close();
  }
});

test('HTTP: SSE log stream sends existing lines', async () => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(process.env.BURROW_STATE_DIR, { recursive: true });
  writeFileSync(join(process.env.BURROW_STATE_DIR, 'demo.log'), 'line one\nline two\n');
  const server = createDashboard({ password: PASSWORD, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASSWORD }),
    });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/logs/demo`, { headers: { cookie }, signal: ctrl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('line two')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /data: line one\n\ndata: line two\n\n/);
    ctrl.abort();
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
