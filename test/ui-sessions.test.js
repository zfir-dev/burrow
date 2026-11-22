import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { sandbox } from './helpers/cli.js';

const sb = sandbox({ api: 'http://127.0.0.1:1' });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
const { base32Encode, base32Decode, hotp, totp, matchStep, otpauthUri, totpFile } = await import('../src/dashboard/totp.js');
const { startDashboard, PASSWORD } = await import('./helpers/dash.js');
test.after(() => sb.cleanup());

test('TOTP matches RFC 6238 (SHA-1) and refuses replays and stale codes', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(totp(secret, 59 * 1000), '287082');
  assert.equal(totp(secret, 1111111109 * 1000), '081804');
  assert.equal(totp(secret, 1234567890 * 1000), '005924');
  const now = 1234567890 * 1000;
  const step = Math.floor(now / 30000);
  assert.equal(matchStep(secret, '005924', { now }), step);
  assert.equal(matchStep(secret, '005 924', { now }), step);
  assert.equal(matchStep(secret, hotp(secret, step - 1), { now }), step - 1, 'one step of clock drift');
  assert.equal(matchStep(secret, hotp(secret, step - 2), { now }), null);
  assert.equal(matchStep(secret, '005924', { now, lastStep: step }), null, 'a used code is refused');
  assert.equal(matchStep(secret, 'abcdef', { now }), null);
  assert.match(otpauthUri(secret), /^otpauth:\/\/totp\/burrow%3Adashboard\?secret=GEZD.*&issuer=burrow&algorithm=SHA1&digits=6&period=30$/);
});

async function login(base, password, code) {
  const body = new URLSearchParams({ password, ...(code !== undefined ? { code } : {}) });
  const r = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
  });
  const j = await r.json();
  return { status: r.status, j, cookie: r.headers.get('set-cookie')?.split(';')[0] || null };
}
const as = (d, cookie) => ({
  get: (p) => fetch(d.base + p, { headers: { cookie } }),
  post: (p, body) => fetch(d.base + p, { method: 'POST', headers: { cookie, 'X-Burrow': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
});

test('HTTP: list sessions, sign out others, two-factor setup/sign-in/turn off, sign out everywhere', async () => {
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/sessions`)).status, 401);
    let j = await (await d.get('/api/sessions')).json();
    assert.equal(j.sessions.length, 1);
    assert.equal(j.sessions[0].current, true);
    assert.match(j.sessions[0].handle, /^[0-9a-f]{16}$/);
    assert.ok(!d.cookie.includes(j.sessions[0].handle));
    assert.deepEqual(j.twoFactor, { enabled: false, enabledAt: null, pending: false });

    const other = await login(d.base, PASSWORD);
    assert.equal(other.status, 200);
    const b = as(d, other.cookie);
    assert.equal((await b.get('/api/sessions')).status, 200);
    j = await (await d.get('/api/sessions')).json();
    assert.equal(j.sessions.length, 2);
    assert.equal((await fetch(`${d.base}/api/sessions/revoke-others`, { method: 'POST', headers: { cookie: d.cookie } })).status, 403, 'CSRF');
    j = await (await d.post('/api/sessions/revoke-others', {})).json();
    assert.equal(j.revoked, 1);
    assert.equal((await b.get('/api/sessions')).status, 401, 'the other browser is signed out');

    // Two-factor: setup shows the secret once; a wrong code doesn't turn it on.
    let r = await d.post('/api/two-factor/setup', {});
    const setup = await r.json();
    assert.match(setup.secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.uri, /^otpauth:\/\/totp\//);
    assert.equal(statSync(totpFile()).mode & 0o777, 0o600);
    assert.equal((await d.post('/api/two-factor/enable', { code: '000000' })).status, 400);
    j = await (await d.get('/api/sessions')).json();
    assert.equal(j.twoFactor.enabled, false);
    assert.equal(j.twoFactor.pending, true);
    r = await d.post('/api/two-factor/enable', { code: totp(setup.secret) });
    j = await r.json();
    assert.equal(r.status, 200, j.error);
    assert.equal(j.twoFactor.enabled, true);
    assert.ok(!JSON.stringify(j).includes(setup.secret), 'never shown again');
    assert.ok(!(await (await d.get('/api/sessions')).text()).includes(setup.secret));
    assert.equal((await d.post('/api/two-factor/setup', {})).status, 409, 'no new secret while on');

    // Sign-in now needs the code; each code works once.
    assert.match(await (await fetch(`${d.base}/login`)).text(), /name="code"/);
    let l = await login(d.base, PASSWORD);
    assert.deepEqual([l.status, l.j.twoFactor], [401, true]);
    assert.equal((await login(d.base, PASSWORD, '123456')).status, 401);
    const next = totp(setup.secret, Date.now() + 30000); // the enable step's code is already used
    l = await login(d.base, PASSWORD, next);
    assert.equal(l.status, 200, l.j.error);
    assert.equal((await login(d.base, PASSWORD, next)).status, 401, 'replayed code');
    assert.equal((await login(d.base, 'wrong password!!', totp(setup.secret, Date.now() - 30000))).status, 401);

    // Turning it off needs confirmation and a fresh code.
    assert.equal((await d.post('/api/two-factor/disable', { code: '111111' })).status, 400);
    assert.equal((await d.post('/api/two-factor/disable', { code: next, confirm: true })).status, 400, 'used code');
    r = await d.post('/api/two-factor/disable', { code: totp(setup.secret, Date.now() - 30000), confirm: true });
    j = await r.json();
    assert.equal(r.status, 400, 'older than the last used step');
    // Wait for a fresh step is too slow for a test: rewrite lastStep instead.
    const st = JSON.parse(readFileSync(totpFile(), 'utf8'));
    st.lastStep -= 3;
    (await import('node:fs')).writeFileSync(totpFile(), JSON.stringify(st));
    r = await d.post('/api/two-factor/disable', { code: totp(setup.secret), confirm: true });
    j = await r.json();
    assert.equal(r.status, 200, j.error);
    assert.equal(j.twoFactor.enabled, false);
    assert.ok(!existsSync(totpFile()), 'the secret is deleted');
    assert.doesNotMatch(await (await fetch(`${d.base}/login`)).text(), /name="code"/);

    // Sign out everywhere (confirmation; clears this cookie too).
    const c = as(d, l.cookie);
    assert.equal((await d.post('/api/sessions/revoke-all', {})).status, 400);
    r = await d.post('/api/sessions/revoke-all', { confirm: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await d.get('/api/sessions')).status, 401);
    assert.equal((await c.get('/api/sessions')).status, 401);
  } finally { await d.close(); }
});

test('HTTP: wrong two-factor codes are rate limited', async () => {
  const d = await startDashboard();
  try {
    const setup = await (await d.post('/api/two-factor/setup', {})).json();
    for (let i = 0; i < 5; i++) assert.equal((await d.post('/api/two-factor/enable', { code: '000000' })).status, 400);
    const r = await d.post('/api/two-factor/enable', { code: totp(setup.secret) });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  } finally { await d.close(); }
});
