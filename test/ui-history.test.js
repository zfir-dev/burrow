import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { sandbox, EXAMPLE } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { recordEvent, readEvents, historyFile, MAX_BYTES, KEEP_LINES } = await import('../src/history.js');
const { startDashboard } = await import('./helpers/dash.js');
const { events } = await import('../src/dashboard/panels.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

test('CLI: state-changing commands are recorded with source and result; read-only and dry runs are not', async () => {
  let r = await sb.run(['up', '-f', EXAMPLE]);
  assert.equal(r.code, 0, r.stderr);
  r = await sb.run(['up', '--dry-run', '-f', EXAMPLE]);
  r = await sb.run(['status', 'acme-shop']);
  r = await sb.run(['down', 'acme-shop'], { env: { BURROW_SOURCE: 'dashboard' } });
  assert.equal(r.code, 0, r.stderr);
  r = await sb.run(['destroy']);
  assert.equal(r.code, 1);
  r = await sb.run(['autostart']);
  const list = readEvents();
  assert.deepEqual(list.map((e) => [e.action, e.project, e.source, e.ok]), [
    ['autostart', null, 'boot', true],
    ['destroy', null, 'cli', false],
    ['down', 'acme-shop', 'dashboard', true],
    ['up', 'acme-shop', 'cli', true],
  ]);
  assert.ok(list.every((e) => !Number.isNaN(Date.parse(e.at)) && e.durationMs >= 0));
  assert.equal((statSync(historyFile()).mode & 0o777).toString(8), '600');
  assert.ok(!readFileSync(historyFile(), 'utf8').includes('test-token'), 'never records secrets');
});

test('readEvents filters, newest first; the file rotates', () => {
  recordEvent({ action: 'restart', project: 'blog', source: 'dashboard', detail: 'x'.repeat(500) });
  assert.equal(readEvents({ project: 'blog' })[0].detail.length, 300);
  assert.equal(readEvents({ source: 'boot' }).length, 1);
  assert.equal(readEvents({ limit: 2 }).length, 2);
  writeFileSync(historyFile(), `${JSON.stringify({ at: new Date().toISOString(), action: 'up', project: 'blog', source: 'cli', ok: true, detail: 'p'.repeat(250) })}\n`.repeat(Math.ceil(MAX_BYTES / 300) + 10));
  recordEvent({ action: 'down', project: 'todo-api' });
  assert.ok(statSync(historyFile()).size < MAX_BYTES);
  const all = readEvents({ limit: 100000 });
  assert.equal(all.length, KEEP_LINES);
  assert.equal(all[0].project, 'todo-api');
});

test('HTTP: /api/history needs a session; dashboard-only actions are recorded too', async () => {
  writeFileSync(historyFile(), '');
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/history`)).status, 401);
    // Loading the real panels registers the listener for in-process events.
    assert.match(await (await d.get('/')).text(), /Event history/);
    events.emit('event', { action: 'edit', project: 'acme-shop', ok: true, detail: '/tmp/acme-shop.tunnel.yml' });
    let j = await (await d.get('/api/history')).json();
    const notSignIn = (e) => e.action !== 'sign-in';
    assert.deepEqual(j.events.filter(notSignIn).map((e) => [e.action, e.project, e.source]), [['edit', 'acme-shop', 'dashboard']]);
    assert.equal((await d.get('/api/history?project=BAD..x')).status, 400);
    assert.equal((await d.get('/api/history?source=evil')).status, 400);
    j = await (await d.get('/api/history?project=blog')).json();
    assert.deepEqual(j.events, []);
    assert.ok(existsSync(historyFile()));
  } finally { await d.close(); }
});

test('trackCommand: records on finish, on process.exit() and on a signal, once', async () => {
  const { trackCommand } = await import('../src/history.js');
  const { EventEmitter } = await import('node:events');
  const cmd = (name, args = [], opts = {}) => ({ name: () => name, args, opts: () => opts });
  const fakeProc = () => {
    const p = new EventEmitter();
    p.exitCode = undefined;
    p.exit = (code) => { p.exited = code; p.emit('exit', code); };
    return p;
  };
  writeFileSync(historyFile(), '');
  assert.equal(trackCommand(cmd('status', ['blog']), { proc: fakeProc() }), null, 'read-only commands are not tracked');

  let proc = fakeProc();
  let t = trackCommand(cmd('down', ['blog']), { proc, env: {} });
  assert.equal(proc.listenerCount('SIGINT'), 1);
  t.finish(0);
  proc.emit('exit', 0);
  assert.equal(proc.listenerCount('SIGINT'), 0, 'listeners are removed after the command');
  assert.equal(proc.listenerCount('exit'), 0);

  proc = fakeProc();
  trackCommand(cmd('up', ['acme-shop']), { proc, env: {} });
  proc.emit('SIGTERM');
  assert.equal(proc.exited, 143, 'nothing else listens, so the signal ends the process as before');

  proc = fakeProc();
  trackCommand(cmd('restart', ['todo-api']), { proc, env: { BURROW_SOURCE: 'dashboard' } });
  proc.exit(3);

  proc = fakeProc();
  t = trackCommand(cmd('share', [], { name: 'demo' }), { proc, env: {} });
  proc.on('SIGINT', () => {}); // the command's own Ctrl+C cleanup
  proc.emit('SIGINT');
  assert.equal(proc.exited, undefined, 'a command with its own handler keeps control');
  t.finish(0);

  const got = readEvents().reverse().map((e) => [e.action, e.project, e.ok, e.detail || '', e.source]);
  assert.deepEqual(got, [
    ['down', 'blog', true, '', 'cli'],
    ['up', 'acme-shop', false, 'stopped by SIGTERM', 'cli'],
    ['restart', 'todo-api', false, 'exited before finishing (code 3)', 'dashboard'],
    ['share', 'share demo', true, 'stopped by SIGINT', 'cli'],
  ]);
});

test('a real process killed with SIGTERM or SIGINT still leaves an entry', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const mod = fileURLToPath(new URL('../src/history.js', import.meta.url));
  writeFileSync(historyFile(), '');
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const script = `
      const { trackCommand } = await import(${JSON.stringify(mod)});
      trackCommand({ name: () => 'up', args: ['blog'], opts: () => ({}) });
      setInterval(() => {}, 1000);
      process.stdout.write('ready\\n');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, BURROW_STATE_DIR: sb.state }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve) => child.stdout.once('data', resolve));
    child.kill(sig);
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
    assert.equal(code, sig === 'SIGTERM' ? 143 : 130);
  }
  assert.deepEqual(readEvents().map((e) => [e.action, e.project, e.ok, e.detail]), [
    ['up', 'blog', false, 'stopped by SIGINT'],
    ['up', 'blog', false, 'stopped by SIGTERM'],
  ]);
});

test('HTTP: dashboard sign-ins and sign-outs are recorded, never the password', async () => {
  const d = await startDashboard();
  try {
    await d.get('/'); // loads the panels, which registers the history listener
    writeFileSync(historyFile(), '');
    const login = (password) => fetch(`${d.base}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password }),
    });
    assert.equal((await login('not-the-password-123')).status, 401);
    const { PASSWORD } = await import('./helpers/dash.js');
    assert.equal((await login(PASSWORD)).status, 303);
    assert.equal((await d.post('/logout')).status, 200);
    const got = readEvents().reverse();
    assert.deepEqual(got.map((e) => [e.action, e.ok, e.source]), [
      ['sign-in', false, 'dashboard'], ['sign-in', true, 'dashboard'], ['sign-out', true, 'dashboard'],
    ]);
    assert.match(got[0].detail, /^wrong password from 127\.0\.0\.1$/);
    const raw = readFileSync(historyFile(), 'utf8');
    assert.ok(!raw.includes('not-the-password-123') && !raw.includes(PASSWORD), 'no password in the history');
  } finally { await d.close(); }
});
