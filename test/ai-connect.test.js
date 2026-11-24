// burrow ai login/connect against a fake burrow-ai server (pairing + connector WebSocket).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { pair } from '../src/ai/pair.js';
import { loadCredentials, removeCredentials } from '../src/ai/credentials.js';
import { credentialsFile } from '../src/ai/paths.js';
import { Executor } from '../src/ai/executor.js';
import { ConnectorClient, connectUrl } from '../src/ai/client.js';
import { renderAiUnit } from '../src/ai/service.js';
import { PROTOCOL_VERSION } from '../src/ai/protocol.js';
import { aiSandbox, fakeServer, FakeBurrow, waitFor, sleep } from './helpers/ai.js';

const BIN = fileURLToPath(new URL('../bin/burrow.js', import.meta.url));
// Async on purpose: the fake server runs in this process, so a spawnSync would block it.
const cli = (args, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end();
  child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});

// Credentials helpers read process.env paths; point them at a sandbox for the in-process tests.
function useEnv(t, env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('pair stores the device token with mode 600 in a 700 dir next to the burrow config', async (t) => {
  const sb = aiSandbox();
  t.after(() => sb.cleanup());
  const srv = await fakeServer();
  t.after(() => srv.close());
  const p = await pair({ code: srv.code, server: srv.base, deviceName: 'acme-laptop', env: sb.env });
  assert.equal(p.file, credentialsFile(sb.env));
  assert.ok(p.file.startsWith(sb.home));
  assert.equal(statSync(p.file).mode & 0o777, 0o600);
  assert.equal(statSync(sb.env.BURROW_AI_CONFIG_DIR).mode & 0o777, 0o700);
  const saved = JSON.parse(readFileSync(p.file, 'utf8'));
  assert.equal(saved.deviceToken, srv.token);
  assert.equal(saved.deviceName, 'acme-laptop');
  assert.equal(saved.server, srv.base);
  await assert.rejects(pair({ code: 'NOPE-NOPE', server: srv.base, env: sb.env }), /pairing failed \(400\): pairing code is unknown/);
  await assert.rejects(pair({ code: 'AAAA-BBBB', server: 'http://api.example.dev', env: sb.env }), /must use https/);
  assert.equal(connectUrl('https://api.example.dev'), 'wss://api.example.dev/v1/connect');
  useEnv(t, { BURROW_AI_CONFIG_DIR: sb.env.BURROW_AI_CONFIG_DIR });
  assert.equal(loadCredentials().deviceId, 'dev_acme1');
  assert.equal(removeCredentials(), true);
  assert.equal(loadCredentials(), null);
});

test('connector says hello with the protocol version and serves calls', async (t) => {
  const sb = aiSandbox();
  t.after(() => sb.cleanup());
  const srv = await fakeServer();
  t.after(() => srv.close());
  const burrow = new FakeBurrow();
  const executor = new Executor({ burrow, env: sb.env });
  const client = new ConnectorClient({ creds: { server: srv.base, deviceId: 'dev_acme1', deviceToken: srv.token }, executor, version: '0.2.0' });
  const running = client.start();
  t.after(async () => { client.stop(); await running; await executor.close(); });
  await waitFor(srv.online);
  const hello = srv.received.find((m) => m.type === 'hello');
  assert.equal(hello.protocol, PROTOCOL_VERSION);
  assert.equal(hello.connectorVersion, '0.2.0');
  assert.equal(hello.burrowVersion, '0.2.0');
  const ex = await srv.call('expose', { name: 'todo-api', port: 3100 });
  assert.deepEqual([ex.ok, ex.data.url], [true, 'https://todo-api.example.dev']);
  assert.equal((await srv.call('status', { name: 'todo-api' })).data.tunnel.connections, 4);
  assert.equal((await srv.call('logs', { name: 'todo-api', lines: 2 })).data.lines.length, 2);
  assert.equal((await srv.call('stop', { name: 'todo-api' })).data.stopped, true);
  const nope = await srv.call('stop', { name: 'todo-api' });
  assert.deepEqual([nope.ok, nope.error.code], [false, 'TUNNEL_NOT_FOUND']);
  assert.deepEqual(burrow.calls.map((c) => c[0]), ['share', 'status', 'logs', 'stop']);

  // Reconnects after the server drops the socket.
  const before = srv.received.filter((m) => m.type === 'hello').length;
  for (const ws of srv.sockets) ws.terminate();
  await waitFor(() => srv.received.filter((m) => m.type === 'hello').length > before, { timeoutMs: 8000 });
});

test('connector drops messages that are not in the protocol', async (t) => {
  const sb = aiSandbox();
  t.after(() => sb.cleanup());
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise((r) => wss.close(r)));
  const results = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'hello') {
        ws.send(JSON.stringify({ type: 'welcome', protocol: 1, deviceId: 'dev_x', heartbeatMs: 1000 }));
        ws.send(JSON.stringify({ type: 'call', id: 'a1', op: 'shell', args: { cmd: 'id' } }));
        ws.send(JSON.stringify({ type: 'exec', cmd: 'id' }));
        ws.send('{{{');
        ws.send(JSON.stringify({ type: 'call', id: 'a2', op: 'expose', args: { name: 'acme-shop', port: 3100, cmd: 'id' } }));
        ws.send(JSON.stringify({ type: 'call', id: 'a3', op: 'list', args: {} }));
      }
      if (m.type === 'result') results.push(m);
    });
  });
  await new Promise((r) => wss.once('listening', r));
  const burrow = new FakeBurrow();
  const executor = new Executor({ burrow, env: sb.env });
  const client = new ConnectorClient({ creds: { server: `http://127.0.0.1:${wss.address().port}`, deviceId: 'dev_x', deviceToken: 'bad_x' }, executor, version: '0.2.0' });
  const running = client.start();
  await waitFor(() => results.length >= 2);
  await sleep(100);
  client.stop();
  await running;
  for (const ws of wss.clients) ws.terminate();
  assert.deepEqual(results.map((r) => [r.id, r.ok, r.error?.code]), [['a2', false, 'INVALID_ARGUMENT'], ['a3', true, undefined]]);
  assert.deepEqual(burrow.calls, [], 'burrow was never called');
});

test('a protocol mismatch stops the connector with an update hint', async (t) => {
  const sb = aiSandbox();
  t.after(() => sb.cleanup());
  const creds = (srv) => ({ server: srv.base, deviceId: 'dev_acme1', deviceToken: srv.token });
  // The server closes with 4003 (what burrow-ai does when hello.protocol differs).
  const s1 = await fakeServer({ protocol: 2 });
  t.after(() => s1.close());
  const c1 = new ConnectorClient({ creds: creds(s1), executor: new Executor({ burrow: new FakeBurrow(), env: sb.env }), version: '0.2.0' });
  await assert.rejects(c1.start(), /different burrow-ai protocol \(protocol 2 required.*npm i -g burrow-cli@latest/);
  // The server welcomes with another version.
  const s2 = await fakeServer({ onHello: (ws) => ws.send(JSON.stringify({ type: 'welcome', protocol: 2, deviceId: 'dev_acme1', heartbeatMs: 1000 })) });
  t.after(() => s2.close());
  const c2 = new ConnectorClient({ creds: creds(s2), executor: new Executor({ burrow: new FakeBurrow(), env: sb.env }), version: '0.2.0' });
  await assert.rejects(c2.start(), /speaks burrow-ai protocol 2, this burrow-cli speaks 1/);
});

test('a rejected or revoked token stops the connector', async (t) => {
  const sb = aiSandbox();
  t.after(() => sb.cleanup());
  const srv = await fakeServer();
  t.after(() => srv.close());
  const ex = () => new Executor({ burrow: new FakeBurrow(), env: sb.env });
  const bad = new ConnectorClient({ creds: { server: srv.base, deviceId: 'dev_acme1', deviceToken: 'bad_revoked' }, executor: ex(), version: '0.2.0' });
  await assert.rejects(bad.start(), /rejected this device token.*burrow ai login/);
  const s2 = await fakeServer({ onHello: (ws) => ws.close(4001, 'device revoked') });
  t.after(() => s2.close());
  const revoked = new ConnectorClient({ creds: { server: s2.base, deviceId: 'dev_acme1', deviceToken: s2.token }, executor: ex(), version: '0.2.0' });
  await assert.rejects(revoked.start(), /removed on the server/);
});

test('CLI: burrow ai login, status, connect and logout', async (t) => {
  const sb = aiSandbox();
  t.after(() => sb.cleanup());
  const srv = await fakeServer();
  t.after(() => srv.close());
  let r = await cli(['ai', 'status'], sb.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Not logged in/);
  r = await cli(['ai', 'connect'], sb.env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not logged in; run "burrow ai login" first/);
  r = await cli(['ai', 'login', '--server', srv.base], sb.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`${srv.base}/app/devices`));
  assert.match(r.stderr, /pairing code required/);
  r = await cli(['ai', 'login', srv.code, '--server', srv.base, '--name', 'acme-laptop'], sb.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Paired as "acme-laptop" \(dev_acme1\)/);
  assert.ok(!r.stdout.includes(srv.token), 'the token is never printed');
  r = await cli(['ai', 'status', '--json'], sb.env);
  const st = JSON.parse(r.stdout);
  assert.equal(st.paired, true);
  assert.equal(st.deviceName, 'acme-laptop');
  assert.equal(st.protocol, PROTOCOL_VERSION);
  assert.ok(!r.stdout.includes(srv.token));

  // connect runs in the foreground until SIGTERM and answers calls.
  const child = spawn(process.execPath, [BIN, 'ai', 'connect', '--json'], { env: sb.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  t.after(() => child.kill('SIGKILL'));
  await waitFor(srv.online, { timeoutMs: 10000 });
  const hello = srv.received.find((m) => m.type === 'hello');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(hello.burrowVersion, pkg.version);
  const list = await srv.call('list', {});
  assert.deepEqual(list.data, { exposures: [] });
  assert.match(stdout, /"event":"warning".*burrow init/, 'warns that burrow is not configured');
  const exited = new Promise((r) => child.on('exit', r));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.match(stdout, /"event":"stopped"/);
  assert.ok(!stdout.includes(srv.token));

  r = await cli(['ai', 'logout'], sb.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Removed .*device\.json/);
  assert.ok(!existsSync(credentialsFile(sb.env)));
});

test('systemd unit runs "burrow ai connect" with the current node', async (t) => {
  const sb = aiSandbox();
  t.after(() => sb.cleanup());
  const unit = renderAiUnit({ env: { PATH: '/usr/bin:/bin', BURROW_CONFIG: '/home/acme/.config/burrow/config.env' } });
  assert.ok(unit.includes(`ExecStart=${process.execPath} ${BIN} ai connect`));
  assert.match(unit, /Restart=always/);
  assert.match(unit, /Environment=BURROW_CONFIG=\/home\/acme\/\.config\/burrow\/config\.env/);
  const r = await cli(['ai', 'connect', '--install-service', '--dry-run'], sb.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[dry-run\] would write .*burrow-ai-connect\.service/);
  assert.ok(r.stdout.includes(sb.home), 'unit path is inside the sandbox');
});
