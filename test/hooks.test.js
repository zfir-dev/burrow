import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';
import { parseHooks } from '../src/hooks.js';

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const fetchText = (port) => new Promise((resolve) => {
  const req = get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => resolve(b));
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function project(sb, hooks) {
  const dir = join(sb.dir, 'blog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tunnel.yml'), `project: blog
services:
  - name: app
    url: http://localhost:4100
  - name: docs
    url: http://localhost:4200
${hooks}`);
  return dir;
}
const lines = (dir, f = 'hooks.log') => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim().split('\n') : []);

test('parseHooks validates names, background, timeouts and wait_for', () => {
  assert.deepEqual(parseHooks({}), {});
  assert.deepEqual(parseHooks({ hooks: { pre_up: 'npm run migrate' } }).pre_up, { run: 'npm run migrate', timeout: 120, background: false, waitFor: null });
  assert.deepEqual(parseHooks({ hooks: { pre_up: { run: 'next dev', background: true, wait_for: 3100, timeout: 30 } } }).pre_up.waitFor, { host: '127.0.0.1', port: 3100 });
  assert.throws(() => parseHooks({ hooks: { after_up: 'x' } }), /unknown hook/);
  assert.throws(() => parseHooks({ hooks: { post_up: { run: 'x', background: true } } }), /only pre_up can run in the background/);
  assert.throws(() => parseHooks({ hooks: { pre_up: { run: 'x', timeout: 0 } } }), /timeout must be/);
  assert.throws(() => parseHooks({ hooks: { pre_up: { run: 'x', wait_for: 3000 } } }), /wait_for needs background/);
  assert.throws(() => parseHooks({ hooks: { pre_up: { run: 'x', bg: true } } }), /unknown key/);
  assert.throws(() => parseHooks({ hooks: { pre_down: { run: '' } } }), /expected a command/);
});

test('hooks run in the project dir with BURROW_* env, in order, and --no-hooks skips them', async () => {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  try {
    const dir = project(sb, `hooks:
  pre_up: echo "pre_up|$BURROW_PROJECT|$BURROW_HOSTNAMES|$BURROW_URL|$(pwd)" >> hooks.log
  post_up: echo "post_up|$BURROW_TUNNEL_ID" >> hooks.log
  pre_down: echo "pre_down|$BURROW_HOSTNAMES" >> hooks.log
  post_down: echo post_down >> hooks.log
`);
    let r = await sb.run(['up', '--dry-run'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[dry-run\] would run pre_up hook in .*blog: echo/);
    assert.deepEqual(lines(dir), []);

    r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    r = await sb.run(['down', 'blog'], { cwd: sb.dir });
    assert.equal(r.code, 0, r.stderr);
    const id = cf.live()[0].id;
    assert.deepEqual(lines(dir), [
      `pre_up|blog|blog.example.dev,docs-blog.example.dev|https://blog.example.dev|${realpathSync(dir)}`,
      `post_up|${id}`,
      'pre_down|blog.example.dev,docs-blog.example.dev',
      'post_down',
    ]);

    r = await sb.run(['down', 'blog']);
    assert.equal(lines(dir).length, 4, 'nothing running: down hooks are skipped');

    r = await sb.run(['up', '--no-hooks'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    r = await sb.run(['down', '--no-hooks']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(lines(dir).length, 4);
  } finally { await sb.cleanup(); await cf.close(); }
});

test('a failing pre_up stops up before anything is created; a failing post_up only warns', async () => {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  try {
    let dir = project(sb, 'hooks:\n  pre_up: exit 3\n');
    let r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /pre_up hook failed \(exit 3\): exit 3/);
    assert.equal(cf.live().length, 0);
    assert.ok(!existsSync(join(sb.state, 'blog.pid')));

    dir = project(sb, 'hooks:\n  post_up: echo oops >&2; exit 1\n');
    r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /post_up hook failed \(exit 1\)/);
    assert.match(r.stdout, /cloudflared started/);
    assert.ok(existsSync(join(sb.state, 'blog.pid')));
  } finally { await sb.cleanup(); await cf.close(); }
});

test('a hook that runs too long is killed', async () => {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  try {
    const dir = project(sb, 'hooks:\n  pre_up: { run: "sleep 30", timeout: 1 }\n');
    const started = Date.now();
    const r = await sb.run(['up'], { cwd: dir, timeout: 20000 });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /pre_up hook timed out after 1s: sleep 30/);
    assert.ok(Date.now() - started < 10000);
    assert.equal(cf.live().length, 0);
  } finally { await sb.cleanup(); await cf.close(); }
});

test('background pre_up: waits for its port, is kept on re-up and stopped on down', async () => {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  try {
    const port = await freePort();
    const dir = project(sb, `hooks:
  pre_up:
    run: 'exec "${process.execPath}" dev-server.cjs ${port}'
    background: true
    wait_for: ${port}
    timeout: 20
`);
    writeFileSync(join(dir, 'dev-server.cjs'),
      "require('http').createServer((q, s) => s.end('dev server')).listen(Number(process.argv[2]), '127.0.0.1');\n");
    let r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`pre_up \\(background\\) is listening on 127\\.0\\.0\\.1:${port}`));
    assert.equal(await fetchText(port), 'dev server');
    const pid = Number(readFileSync(join(sb.state, 'hooks', 'blog.pid'), 'utf8'));
    assert.ok(alive(pid));

    r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`already running \\(pid ${pid}\\); keeping it`));

    r = await sb.run(['down', '--dry-run']);
    assert.match(r.stdout, new RegExp(`would stop the pre_up background process \\(pid ${pid}\\)`));
    r = await sb.run(['down']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`blog: stopped pre_up background process \\(pid ${pid}\\)`));
    await new Promise((res) => setTimeout(res, 300));
    assert.ok(!alive(pid));
    assert.equal(await fetchText(port), null);
    assert.ok(!existsSync(join(sb.state, 'hooks', 'blog.pid')));
  } finally { await sb.cleanup(); await cf.close(); }
});

test('background pre_up that never opens its port fails up and is stopped', async () => {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  try {
    const port = await freePort();
    const dir = project(sb, `hooks:\n  pre_up: { run: "sleep 60", background: true, wait_for: ${port}, timeout: 1 }\n`);
    const r = await sb.run(['up'], { cwd: dir, timeout: 20000 });
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`127\\.0\\.0\\.1:${port} didn't open within 1s; stopped it`));
    assert.equal(cf.live().length, 0);
    assert.ok(!existsSync(join(sb.state, 'hooks', 'blog.pid')));
  } finally { await sb.cleanup(); await cf.close(); }
});

test('invalid hooks fail up early', async () => {
  const sb = sandbox({ api: 'http://127.0.0.1:1' });
  try {
    const dir = project(sb, 'hooks:\n  post_up: { run: "x", background: true }\n');
    const r = await sb.run(['up', '--dry-run'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /hooks\.post_up: only pre_up can run in the background/);
  } finally { await sb.cleanup(); }
});
