import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { checkTarget, hookCommandFound } from '../src/doctor.js';
import { mkdirSync } from 'node:fs';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

async function openPort() {
  const srv = createServer((s) => s.end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}
async function closedPort() {
  const p = await openPort();
  await p.close();
  return p.port;
}

test('checkTarget', async () => {
  const open = await openPort();
  try {
    assert.deepEqual(await checkTarget(`http://127.0.0.1:${open.port}`), { ok: true, detail: 'reachable' });
    const closed = await closedPort();
    const r = await checkTarget(`http://127.0.0.1:${closed}`);
    assert.equal(r.ok, false);
    assert.equal(r.detail, 'connection refused');
    assert.equal((await checkTarget('http_status:404')).ok, true);
    assert.equal((await checkTarget('unix:/nonexistent/socket')).ok, false);
  } finally {
    await open.close();
  }
});

test('doctor: all green against the mock API with a reachable service', async () => {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  const app = await openPort();
  try {
    writeFileSync(join(sb.dir, 'tunnel.yml'), `project: todo-api\nservices:\n  - name: app\n    url: http://127.0.0.1:${app.port}\n`);
    const r = await sb.run(['doctor']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    for (const re of [/✓ config file/, /✓ config permissions - 600/, /✓ CF_API_TOKEN - set/, /✓ BURROW_DOMAIN - example\.dev/,
      /✓ token - active/, /✓ zone - example\.dev \(zone-1\)/, /✓ tunnel access/, /✓ DNS access/,
      /✓ cloudflared - cloudflared version 2026\.1\.0 \(fake\)/, /Project todo-api/, /✓ app -> http:\/\/127\.0\.0\.1:\d+ - reachable/,
      /0 failed/]) {
      assert.match(r.stdout, re);
    }
    assert.ok(!r.stdout.includes('test-token'), 'token must never be printed');
  } finally {
    await app.close();
    await sb.cleanup();
    await cf.close();
  }
});

test('doctor: reports unreachable services, bad permissions and fails', async () => {
  const sb = sandbox();
  const app = await openPort();
  try {
    const closed = await closedPort();
    chmodSync(sb.config, 0o644);
    writeFileSync(join(sb.dir, 'acme.yml'), `project: acme-shop
services:
  - name: app
    url: http://127.0.0.1:${app.port}
    paths:
      - { path: /auth/v1, url: "http://127.0.0.1:${closed}" }
  - name: mail
    url: http://127.0.0.1:${closed}
`);
    const r = await sb.run(['doctor', '-f', 'acme.yml', '--offline']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /! config permissions - 644/);
    assert.match(r.stdout, /- API checks - --offline/);
    assert.match(r.stdout, /✓ app -> .* - reachable/);
    assert.match(r.stdout, /✗ app \^\/auth\/v1\(\/\.\*\)\?\$ -> .* - connection refused/);
    assert.match(r.stdout, /✗ mail -> .* - connection refused/);
    assert.match(r.stdout, /2 failed/);
  } finally {
    await app.close();
    await sb.cleanup();
  }
});

test('doctor: missing config and cloudflared', async () => {
  const sb = sandbox({ extra: { CLOUDFLARED_BIN: '/nonexistent/cloudflared' } });
  try {
    const r = await sb.run(['doctor'], { env: { BURROW_CONFIG: join(sb.dir, 'missing.env'), CLOUDFLARED_BIN: '/nonexistent/cloudflared' } });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /✗ config file - .*missing\.env missing; run burrow init/);
    assert.match(r.stdout, /✗ CF_API_TOKEN - missing/);
    assert.match(r.stdout, /- API checks - config incomplete/);
    assert.match(r.stdout, /✗ cloudflared - \/nonexistent\/cloudflared not runnable/);
  } finally {
    await sb.cleanup();
  }
});

test('hookCommandFound', () => {
  const dir = join(process.cwd(), 'test');
  assert.equal(hookCommandFound('sh -c true', dir).ok, true);
  assert.equal(hookCommandFound('no-such-command-for-burrow --x', dir, '/usr/bin:/bin').ok, false);
  assert.match(hookCommandFound('no-such-command-for-burrow', dir, '/usr/bin').detail, /not found on PATH/);
  assert.equal(hookCommandFound('./missing.sh', dir).ok, false);
  // Shell syntax is parsed now (details in shell-words.test.js), not skipped.
  assert.equal(hookCommandFound('FOO=1 sh -c true', dir).ok, true);
  assert.deepEqual(hookCommandFound('cd no-such-dir && sh -c true', dir).problems, [`cd no-such-dir: no such directory in ${dir}`]);
  assert.deepEqual(hookCommandFound('sh -c "$(no-such-command-for-burrow)"', dir, '/usr/bin:/bin').problems, ['no-such-command-for-burrow not found on PATH']);
});

test('doctor: checks the project domain: zone and its hooks', async () => {
  const cf = await mockCloudflare({ zones: [
    { id: 'zone-1', name: 'example.dev', status: 'active', account: { id: 'acct-1' } },
    { id: 'zone-2', name: 'example.org', status: 'active', account: { id: 'acct-1' } },
  ] });
  const sb = sandbox({ api: cf.url });
  const app = await openPort();
  try {
    const yml = (domain, hooks) => `project: acme-shop\ndomain: ${domain}\nservices:\n  - name: app\n    url: http://127.0.0.1:${app.port}\n${hooks}`;
    mkdirSync(join(sb.dir, 'scripts'));
    writeFileSync(join(sb.dir, 'scripts', 'warm.sh'), '#!/bin/sh\n');
    chmodSync(join(sb.dir, 'scripts', 'warm.sh'), 0o755);
    writeFileSync(join(sb.dir, 'tunnel.yml'), yml('example.org',
      'hooks:\n  pre_up: ./scripts/warm.sh\n  post_up: no-such-command-for-burrow --notify\n  pre_down: ./scripts/missing.sh\n'));
    let r = await sb.run(['doctor']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /✓ domain example\.org - zone zone-2/);
    assert.match(r.stdout, /✓ hook pre_up - found: \.\/scripts\/warm\.sh/);
    assert.match(r.stdout, /! hook post_up - no-such-command-for-burrow not found on PATH/);
    assert.match(r.stdout, /! hook pre_down - \.\/scripts\/missing\.sh not found or not executable/);

    r = await sb.run(['doctor', '--json']);
    const j = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.ok(j.checks.find((c) => c.label === 'hook post_up').fix.includes('hooks.post_up'));

    r = await sb.run(['doctor', '--offline']);
    assert.match(r.stdout, /- domain example\.org - --offline/);

    writeFileSync(join(sb.dir, 'tunnel.yml'), yml('example.net', 'hooks:\n  pre_upp: echo typo\n'));
    r = await sb.run(['doctor']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /✗ domain example\.net - Zone example\.net is not on Cloudflare account/);
  } finally {
    await app.close();
    await sb.cleanup();
    await cf.close();
  }
});

