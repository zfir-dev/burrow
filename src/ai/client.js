import { hostname, platform } from 'node:os';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION, MAX_MESSAGE_BYTES, CloseCode, ErrorCode, ProtocolError, parseMessage, serverMessage,
} from './protocol.js';

export function connectUrl(server) {
  const u = new URL('/v1/connect', server);
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  else throw new Error(`server must be an http(s) URL, got ${server}`);
  return u.toString();
}

export const UPDATE_HINT = 'update burrow-cli with "npm i -g burrow-cli@latest"';

// Dials out to the server, keeps the connection alive, reconnects with backoff, and
// hands validated "call" messages to the executor. Invalid messages are dropped.
// start() resolves on stop() and rejects on a fatal error (revoked token, protocol
// mismatch, replaced by another connector).
export class ConnectorClient {
  constructor({ creds, executor, version, burrowVersion = version ?? null, log = () => {}, minBackoffMs = 1000, maxBackoffMs = 30_000 }) {
    this.creds = creds;
    this.executor = executor;
    this.version = String(version ?? burrowVersion ?? 'unknown').slice(0, 64);
    this.burrowVersion = burrowVersion;
    this.log = log;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.attempt = 0;
    this.stopped = false;
    this.ws = null;
    this.watchdog = null;
    this.heartbeatMs = 15_000;
    this.done = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
  }
  #resolve;
  #reject;

  start() { this.#connect(); return this.done; }

  stop() {
    this.stopped = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.retryTimer);
    this.ws?.close(1000, 'connector stopping');
    this.#resolve();
  }

  #fail(err) {
    this.stopped = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.retryTimer);
    this.ws?.terminate();
    this.#reject(err);
  }

  #connect() {
    if (this.stopped) return;
    const ws = new WebSocket(connectUrl(this.creds.server), {
      headers: { authorization: `Bearer ${this.creds.deviceToken}` },
      maxPayload: MAX_MESSAGE_BYTES,
      handshakeTimeout: 15_000,
    });
    this.ws = ws;
    let fatal = null;

    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) fatal = new Error('the server rejected this device token (revoked?); run "burrow ai login" again');
      this.log('connect_rejected', { status: res.statusCode });
      ws.terminate();
    });
    ws.on('open', () => {
      this.log('connected', { server: this.creds.server });
      this.#send({ type: 'hello', protocol: PROTOCOL_VERSION, connectorVersion: this.version, burrowVersion: this.burrowVersion, platform: `${platform()}/${hostname()}`.slice(0, 64) });
      this.#arm();
    });
    ws.on('message', (raw) => {
      this.#arm();
      const m = parseMessage(serverMessage, raw);
      if (!m.ok) { this.log('dropped_message', { error: m.error }); return; }
      const msg = m.value;
      if (msg.type === 'welcome') {
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.#fail(new Error(`the server speaks burrow-ai protocol ${msg.protocol}, this burrow-cli speaks ${PROTOCOL_VERSION}; ${UPDATE_HINT}`));
          return;
        }
        this.attempt = 0;
        this.heartbeatMs = msg.heartbeatMs;
        this.log('ready', { deviceId: msg.deviceId });
        this.#arm();
      } else if (msg.type === 'ping') {
        this.#send({ type: 'pong', ts: msg.ts });
      } else if (msg.type === 'call') {
        this.#call(msg);
      }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(this.watchdog);
      const why = String(reason || '');
      if (code === CloseCode.REVOKED) fatal = new Error('this device was removed on the server; run "burrow ai login" again');
      if (code === CloseCode.REPLACED) fatal = new Error('another "burrow ai connect" with this device token connected; only one may run per device');
      if (code === CloseCode.PROTOCOL_MISMATCH) fatal = new Error(`the server needs a different burrow-ai protocol (${why || 'version mismatch'}; this burrow-cli speaks ${PROTOCOL_VERSION}); ${UPDATE_HINT}`);
      if (this.ws !== ws) return;
      if (fatal) { this.stopped = true; this.#reject(fatal); return; }
      if (this.stopped) return;
      const delay = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
      this.attempt += 1;
      this.log('disconnected', { code, reason: why, retryInMs: Math.round(delay) });
      this.retryTimer = setTimeout(() => this.#connect(), delay);
    });
    ws.on('error', (e) => this.log('socket_error', { error: e.message }));
  }

  // No traffic from the server for 3 heartbeats: assume the link is dead and reconnect.
  #arm() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => { this.log('heartbeat_lost'); this.ws?.terminate(); }, this.heartbeatMs * 3);
  }

  #send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async #call({ id, op, args }) {
    this.log('call', { id, op, name: args?.name });
    try {
      const data = await this.executor.handle(op, args);
      this.#send({ type: 'result', id, ok: true, data });
    } catch (e) {
      const err = e instanceof ProtocolError ? e : new ProtocolError(ErrorCode.CONNECTOR_ERROR, e.message || 'connector error');
      this.log('call_failed', { id, op, code: err.code, error: err.message });
      this.#send({ type: 'result', id, ok: false, error: { code: err.code, message: String(err.message).slice(0, 4000) } });
    }
  }
}
