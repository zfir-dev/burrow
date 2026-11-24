// Test helpers for burrow ai: a sandboxed env, a fake burrow (in-process stand-in for the
// share/status/logs/stop calls) and a fake burrow-ai server (HTTP pairing + connector
// WebSocket). Nothing here talks to Cloudflare or a real burrow-ai service.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { ErrorCode, ProtocolError, PROTOCOL_VERSION, parseMessage, connectorMessage } from '../../src/ai/protocol.js';
import { redact } from '../../src/ai/local-burrow.js';

export function aiSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'burrow-ai-cli-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    BURROW_CONFIG: join(home, '.config', 'burrow', 'config.env'),
    BURROW_STATE_DIR: join(home, '.local', 'state', 'burrow'),
    BURROW_AI_CONFIG_DIR: join(home, '.config', 'burrow', 'ai'),
    BURROW_AI_STATE_DIR: join(home, '.local', 'state', 'burrow', 'ai'),
    BURROW_CF_API_BASE: 'http://127.0.0.1:1',
    BURROW_SYSTEMCTL: '/nonexistent/systemctl',
  };
  return { root, home, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const LOG = [
  '2026-11-20T10:00:00Z INF Starting tunnel tunnelID=abc',
  '2026-11-20T10:00:01Z INF token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk',
  '2026-11-20T10:00:02Z INF Registered tunnel connection connIndex=0 location=mrs01',
  '2026-11-20T10:00:03Z INF Registered tunnel connection connIndex=1 location=cdg02',
].join('\n');

// Records calls the way the real LocalBurrow would make them.
export class FakeBurrow {
  constructor() { this.calls = []; }
  version() { return '9.9.9'; }
  async share(name, port) {
    this.calls.push(['share', name, port]);
    if (name === 'taken-name') throw new ProtocolError(ErrorCode.NAME_TAKEN, `hostname is already in use: ${name}.example.dev already has DNS records`);
    if (name === 'broken') throw new ProtocolError(ErrorCode.BURROW_ERROR, 'Cloudflare API error 10000: Authentication error');
    return { url: `https://${name}.example.dev`, hostname: `${name}.example.dev`, project: `share-${name}` };
  }
  async status(name) {
    this.calls.push(['status', name]);
    return { running: true, pid: 4242, tunnel: { status: 'healthy', connections: 4 }, hostnames: [`${name}.example.dev`] };
  }
  async logs(name, lines) {
    this.calls.push(['logs', name, lines]);
    return redact(LOG).split('\n').slice(-lines);
  }
  async stop(name) { this.calls.push(['stop', name]); }
}

// A minimal burrow-ai server: POST /v1/pair and the /v1/connect WebSocket.
// onHello(ws, hello) decides what to answer; the default welcomes protocol 1.
export async function fakeServer({ code = 'K7QM-3XRA', token = 'bad_test_device_token', onHello, protocol = PROTOCOL_VERSION } = {}) {
  const received = [];
  const sockets = new Set();
  const http = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.method === 'POST' && req.url === '/v1/pair') {
      const body = JSON.parse(raw || '{}');
      if (body.code !== code) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'PAIRING_INVALID', message: 'pairing code is unknown, used or expired; create a new one' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ deviceId: 'dev_acme1', deviceName: body.deviceName, deviceToken: token }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if (req.url !== '/v1/connect' || req.headers.authorization !== `Bearer ${token}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (raw) => {
        const m = parseMessage(connectorMessage, raw);
        received.push(m.ok ? m.value : { invalid: m.error });
        if (m.ok && m.value.type === 'hello') {
          if (onHello) onHello(ws, m.value);
          else if (m.value.protocol !== protocol) ws.close(4003, `protocol ${protocol} required`);
          else ws.send(JSON.stringify({ type: 'welcome', protocol, deviceId: 'dev_acme1', heartbeatMs: 1000 }));
        }
      });
    });
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${http.address().port}`;
  let n = 0;
  // Send a call to the (first) connected connector and wait for its result.
  const call = (op, args) => new Promise((resolve, reject) => {
    const ws = [...sockets][0];
    if (!ws) { reject(new Error('no connector connected')); return; }
    const id = `c${++n}`;
    const t = setTimeout(() => reject(new Error(`no result for ${op}`)), 10000);
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'result' && m.id === id) { clearTimeout(t); ws.off('message', onMsg); resolve(m); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'call', id, op, args }));
  });
  const close = async () => {
    for (const ws of sockets) ws.terminate();
    wss.close();
    http.closeAllConnections?.();
    await new Promise((r) => http.close(r));
  };
  return { base, code, token, received, sockets, call, close, online: () => received.some((m) => m.type === 'hello') && sockets.size > 0 };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(stepMs);
  }
}
