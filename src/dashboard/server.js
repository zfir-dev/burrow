import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { assertLabel } from '../naming.js';
import { logFile } from '../process.js';
import { collect, invalidateCloudflare } from './data.js';
import {
  passwordMatches, sessionKey, signSession, verifySession, RateLimiter, parseCookies, newSecret, MIN_PASSWORD_LENGTH,
} from './auth.js';
import { LOGIN_HTML, APP_HTML, APP_CSS, APP_JS } from './ui.js';

const BIN = fileURLToPath(new URL('../../bin/burrow.js', import.meta.url));
const COOKIE = 'burrow_session';
const SESSION_TTL = 12 * 60 * 60 * 1000;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
  res.end(body);
}
const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json', extra);

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// cloudflared connects from loopback; only then trust CF-Connecting-IP.
export function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const cf = req.headers['cf-connecting-ip'];
  return loopback && typeof cf === 'string' && cf ? cf : remote;
}

function runCli(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.slice(-20000) }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
  });
}

function streamLog(req, res, project) {
  const file = logFile(project);
  res.writeHead(200, {
    ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  let pos = 0;
  let partial = '';
  const emit = (text) => {
    const lines = (partial + text).split('\n');
    partial = lines.pop();
    for (const line of lines) res.write(`data: ${line.replace(/\r/g, '')}\n\n`);
  };
  const readRange = (from, to) => {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(to - from);
      readSync(fd, buf, 0, buf.length, from);
      return buf.toString('utf8');
    } finally { closeSync(fd); }
  };
  if (existsSync(file)) {
    const size = statSync(file).size;
    const start = Math.max(0, size - 64 * 1024);
    let text = readRange(start, size);
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    emit(text);
    pos = size;
  } else {
    res.write(`data: (no log yet at ${file})\n\n`);
  }
  const poll = setInterval(() => {
    try {
      if (!existsSync(file)) return;
      const size = statSync(file).size;
      if (size < pos) { pos = 0; partial = ''; res.write('data: (log truncated)\n\n'); }
      if (size > pos) {
        const to = Math.min(size, pos + 256 * 1024);
        emit(readRange(pos, to));
        pos = to;
      }
    } catch {}
  }, 1000);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(poll); clearInterval(ping); });
}

export function createDashboard({ password, log = console.log } = {}) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Set BURROW_DASHBOARD_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters) in the burrow config.`);
  }
  const key = sessionKey(newSecret(), password);
  const sessions = new Map(); // id -> exp (server-side, so logout really ends a session)
  const limiter = new RateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
  const busy = new Set();

  const authed = (req) => {
    const id = verifySession(key, parseCookies(req.headers.cookie)[COOKIE]);
    if (!id) return false;
    const exp = sessions.get(id);
    if (!exp || exp < Date.now()) { sessions.delete(id); return false; }
    return id;
  };
  const cookie = (value, maxAge) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/app.css') return send(res, 200, APP_CSS, 'text/css; charset=utf-8');
    if (req.method === 'GET' && path === '/healthz') return send(res, 200, 'ok');

    if (path === '/login') {
      if (req.method === 'GET') return send(res, 200, LOGIN_HTML(''), 'text/html; charset=utf-8');
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
      const ip = clientIp(req);
      const lim = limiter.check(ip);
      if (!lim.allowed) {
        log(`login rate-limited for ${ip}`);
        return send(res, 429, LOGIN_HTML(`Too many attempts. Try again in ${Math.ceil(lim.retryAfter / 60)} min.`),
          'text/html; charset=utf-8', { 'Retry-After': String(lim.retryAfter) });
      }
      let given = '';
      try { given = new URLSearchParams(await readBody(req)).get('password') || ''; } catch { return send(res, 413, 'Too large'); }
      if (!passwordMatches(given, password)) {
        limiter.fail(ip);
        log(`login failed from ${ip}`);
        return send(res, 401, LOGIN_HTML('Wrong password.'), 'text/html; charset=utf-8');
      }
      limiter.reset(ip);
      const s = signSession(key, SESSION_TTL);
      sessions.set(s.id, s.exp);
      log(`login ok from ${ip}`);
      return send(res, 303, '', 'text/plain', { Location: '/', 'Set-Cookie': cookie(s.value, SESSION_TTL / 1000) });
    }

    const sid = authed(req);
    if (!sid) {
      if (path.startsWith('/api/')) return json(res, 401, { error: 'login required' });
      return send(res, 303, '', 'text/plain', { Location: '/login' });
    }

    // State-changing requests need a custom header: browsers can't send it
    // cross-site without a CORS preflight, which this server never allows.
    if (req.method === 'POST' && req.headers['x-burrow'] !== '1') return json(res, 403, { error: 'missing X-Burrow header' });

    if (req.method === 'POST' && path === '/logout') {
      sessions.delete(sid);
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    }
    if (req.method === 'GET' && path === '/') return send(res, 200, APP_HTML, 'text/html; charset=utf-8');
    if (req.method === 'GET' && path === '/app.js') return send(res, 200, APP_JS, 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && path === '/api/tunnels') return json(res, 200, await collect(loadConfig()));

    let m = path.match(/^\/api\/logs\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      try { assertLabel(m[1], 'project'); } catch { return json(res, 400, { error: 'bad project' }); }
      return streamLog(req, res, m[1]);
    }

    m = path.match(/^\/api\/tunnels\/([^/]+)\/(up|down|destroy)$/);
    if (req.method === 'POST' && m) {
      const [, project, action] = m;
      try { assertLabel(project, 'project'); } catch { return json(res, 400, { error: 'bad project' }); }
      if (action === 'destroy') {
        let body = {};
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch {}
        if (body.confirm !== project) return json(res, 400, { error: 'type the project name to confirm' });
      }
      if (busy.has(project)) return json(res, 409, { error: `${project} is busy` });
      busy.add(project);
      log(`${action} ${project} (requested from ${clientIp(req)})`);
      try {
        const r = await runCli([action, project]);
        invalidateCloudflare();
        return json(res, r.ok ? 200 : 500, r);
      } finally { busy.delete(project); }
    }
    return json(res, 404, { error: 'not found' });
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`error: ${e.message}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
}

export function runDashboard({ port, host = '127.0.0.1' }) {
  const cfg = loadConfig();
  const server = createDashboard({ password: cfg.dashboardPassword });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`burrow dashboard on http://${host}:${port} (pid ${process.pid})`);
      resolve(server);
    });
  });
}
