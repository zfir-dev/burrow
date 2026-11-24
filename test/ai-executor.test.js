import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Executor } from '../src/ai/executor.js';
import { redact } from '../src/ai/local-burrow.js';
import { aiSandbox, FakeBurrow } from './helpers/ai.js';

function make(t, policy) {
  const sb = aiSandbox();
  t.after(() => sb.cleanup());
  const burrow = new FakeBurrow();
  const ex = new Executor({ burrow, env: sb.env, ...(policy ? { policy: { home: sb.home, folderRoots: [sb.home], denyPorts: [], allowPorts: null, ...policy } } : {}) });
  t.after(() => ex.close());
  return { sb, ex, burrow };
}

test('expose a port shares it as share-<name> and records it (mode 600)', async (t) => {
  const { sb, ex, burrow } = make(t);
  const r = await ex.handle('expose', { name: 'acme-shop', port: 3100 });
  assert.deepEqual(r, { url: 'https://acme-shop.example.dev', hostname: 'acme-shop.example.dev', project: 'share-acme-shop', target: 'http://localhost:3100' });
  assert.deepEqual(burrow.calls, [['share', 'acme-shop', 3100]]);
  assert.equal(statSync(join(sb.env.BURROW_AI_STATE_DIR, 'exposures.json')).mode & 0o777, 0o600);
  assert.deepEqual((await ex.handle('list', {})).exposures, [{ name: 'acme-shop', url: 'https://acme-shop.example.dev', kind: 'port', port: 3100 }]);
});

test('status, logs and stop only target exposures it created, and redact secrets', async (t) => {
  const { ex, burrow } = make(t);
  await ex.handle('expose', { name: 'todo-api', port: 3100 });
  const st = await ex.handle('status', { name: 'todo-api' });
  assert.equal(st.running, true);
  assert.deepEqual(st.tunnel, { status: 'healthy', connections: 4 });
  assert.equal(st.url, 'https://todo-api.example.dev');
  const logs = await ex.handle('logs', { name: 'todo-api', lines: 3 });
  assert.equal(logs.lines.length, 3);
  assert.ok(!logs.lines.join('\n').includes('eyJ'));
  assert.ok(logs.lines[0].includes('[redacted]'));
  assert.deepEqual(await ex.handle('stop', { name: 'todo-api' }), { name: 'todo-api', stopped: true });
  assert.deepEqual(burrow.calls.at(-1), ['stop', 'todo-api']);
  await assert.rejects(ex.handle('stop', { name: 'todo-api' }), { code: 'TUNNEL_NOT_FOUND' });
});

test('refuses to touch tunnels it did not create', async (t) => {
  const { ex, burrow } = make(t);
  for (const op of ['stop', 'status']) await assert.rejects(ex.handle(op, { name: 'acme-shop' }), { code: 'TUNNEL_NOT_FOUND' });
  await assert.rejects(ex.handle('logs', { name: 'acme-shop', lines: 5 }), { code: 'TUNNEL_NOT_FOUND' });
  assert.deepEqual(burrow.calls, []);
});

test('rejects unknown operations and invalid arguments without calling burrow', async (t) => {
  const { ex, burrow } = make(t);
  await assert.rejects(ex.handle('exec', { cmd: 'rm -rf ~' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(ex.handle('expose', { name: 'x; rm -rf ~', port: 1 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(ex.handle('expose', { name: 'ok-name', port: '3100' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(ex.handle('expose', { name: '--all', port: 3100 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(ex.handle('stop', { name: 'ok', extra: 1 }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(burrow.calls, []);
});

test('burrow errors keep their protocol codes; duplicates are NAME_TAKEN', async (t) => {
  const { ex } = make(t);
  await assert.rejects(ex.handle('expose', { name: 'taken-name', port: 3100 }), { code: 'NAME_TAKEN' });
  await assert.rejects(ex.handle('expose', { name: 'broken', port: 3100 }), { code: 'BURROW_ERROR' });
  await ex.handle('expose', { name: 'dup', port: 3100 });
  await assert.rejects(ex.handle('expose', { name: 'dup', port: 3101 }), { code: 'NAME_TAKEN' });
});

test('default local policy blocks database ports; policy.json can allow-list', async (t) => {
  const { ex } = make(t);
  await assert.rejects(ex.handle('expose', { name: 'pg', port: 5432 }), { code: 'PORT_NOT_ALLOWED' });
  const sb = aiSandbox();
  t.after(() => sb.cleanup());
  mkdirSync(sb.env.BURROW_AI_CONFIG_DIR, { recursive: true });
  writeFileSync(join(sb.env.BURROW_AI_CONFIG_DIR, 'policy.json'), JSON.stringify({ allowPorts: [3100] }));
  const ex2 = new Executor({ burrow: new FakeBurrow(), env: sb.env });
  await assert.rejects(ex2.handle('expose', { name: 'acme-shop', port: 4000 }), { code: 'PORT_NOT_ALLOWED' });
  assert.equal((await ex2.handle('expose', { name: 'acme-shop', port: 3100 })).url, 'https://acme-shop.example.dev');
});

test('expose a folder serves it read-only on 127.0.0.1', async (t) => {
  const { sb, ex, burrow } = make(t);
  const site = join(sb.home, 'sites', 'acme-shop');
  mkdirSync(join(site, 'sub'), { recursive: true });
  writeFileSync(join(site, 'index.html'), '<h1>hello</h1>');
  writeFileSync(join(site, '.env'), 'SECRET=1');
  writeFileSync(join(sb.home, 'outside.txt'), 'nope');
  const r = await ex.handle('expose', { name: 'acme-shop', folder: site });
  const port = Number(r.target.split(':').at(-1));
  assert.deepEqual(burrow.calls[0], ['share', 'acme-shop', port]);
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);
  assert.equal(await (await get('/')).text(), '<h1>hello</h1>');
  assert.equal((await get('/.env')).status, 404);
  assert.equal((await get('/../outside.txt')).status, 404);
  assert.equal((await get('/%2e%2e/outside.txt')).status, 404);
  assert.equal((await get('/sub/')).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' })).status, 405);
  await ex.handle('stop', { name: 'acme-shop' });
  await assert.rejects(get('/'));
});

test('folder guardrails: allowed roots, home itself and hidden folders', async (t) => {
  const { sb, ex, burrow } = make(t);
  mkdirSync(join(sb.home, '.ssh'), { recursive: true });
  await assert.rejects(ex.handle('expose', { name: 'acme-shop', folder: '/etc' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(ex.handle('expose', { name: 'acme-shop', folder: sb.home }), { code: 'NOT_ALLOWED' });
  await assert.rejects(ex.handle('expose', { name: 'acme-shop', folder: join(sb.home, '.ssh') }), { code: 'NOT_ALLOWED' });
  await assert.rejects(ex.handle('expose', { name: 'acme-shop', folder: join(sb.home, 'missing') }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(ex.handle('expose', { name: 'acme-shop', folder: 'relative/www' }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(burrow.calls, []);
});

test('folder exposures are served again after a restart', async (t) => {
  const { sb, ex } = make(t);
  const site = join(sb.home, 'www');
  mkdirSync(site);
  writeFileSync(join(site, 'index.html'), 'hi');
  const r = await ex.handle('expose', { name: 'acme-shop', folder: site });
  await ex.close();
  const port = Number(r.target.split(':').at(-1));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  const ex2 = new Executor({ burrow: ex.burrow, env: sb.env });
  t.after(() => ex2.close());
  await ex2.restore();
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'hi');
});

test('redact()', () => {
  assert.equal(redact('token=abc123 ok'), 'token=[redacted] ok');
  assert.ok(redact(`x ${'A'.repeat(60)} y`).includes('[redacted]'));
  assert.equal(redact('INF Registered tunnel connection connIndex=0 location=mrs01'), 'INF Registered tunnel connection connIndex=0 location=mrs01');
});
