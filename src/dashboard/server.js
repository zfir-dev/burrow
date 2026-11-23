import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadConfig } from '../config.js';
import { assertLabel } from '../naming.js';
import { logFile } from '../process.js';
import { collect, invalidateCloudflare } from './data.js';
import { readTail, combinedText, downloadName, streamAll } from './logs.js';
import {
  passwordMatches, sessionKey, signSession, verifySession, RateLimiter, parseCookies, newSecret, MIN_PASSWORD_LENGTH,
} from './auth.js';
import { LOGIN_HTML, renderApp, APP_CSS, APP_JS, LOGIN_JS } from './ui.js';
import { totpEnabled, verifyCode } from './totp.js';
import { openSessionStore } from './session-store.js';
import { loadPanels, sortPanels, panelJs, panelCss, panelVendor, events } from './panels.js';

// Vendored front-end libraries, served from node_modules (no CDN, works offline).
const require = createRequire(import.meta.url);
export const VENDOR = {
  '/vendor/alpine.min.js': { pkg: '@alpinejs/csp/dist/cdn.min.js', type: 'text/javascript; charset=utf-8' },
  '/vendor/pico.min.css': { pkg: '@picocss/pico/css/pico.min.css', type: 'text/css; charset=utf-8' },
};
const vendorCache = new Map();
function vendorAsset(path, entry = VENDOR[path]) {
  if (!vendorCache.has(path)) vendorCache.set(path, readFileSync(require.resolve(entry.pkg)));
  return vendorCache.get(path);
}

const BIN = fileURLToPath(new URL('../../bin/burrow.js', import.meta.url));
const COOKIE = 'burrow_session';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const BLOCKED_LOG_MS = 60 * 1000;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

// BURROW_SOURCE tells the CLI (e.g. the event history) that the dashboard ran it.
export function runCli(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BURROW_SOURCE: 'dashboard' },
    });
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

// Panels (see ./panels/README.md) are loaded from ./panels/*.js, or passed in (tests).
function buildPanels(list) {
  return { list, html: renderApp(list), js: panelJs(list), css: panelCss(list), vendor: panelVendor(list) };
}

// persistSessions: keep sessions (and their signing secret) in the state dir so they survive
// a restart (see session-store.js). On for `burrow dashboard`; off by default (tests).
export function createDashboard({ password, log = console.log, panels, persistSessions = false } = {}) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Set BURROW_DASHBOARD_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters) in the burrow config.`);
  }
  let store = null;
  if (persistSessions) {
    try { store = openSessionStore(); } catch (e) { log(`warning: sessions are kept in memory only (${e.message})`); }
  }
  const key = sessionKey(store ? store.secret : newSecret(), password);
  const sessions = new Map(); // id -> exp (server-side, so logout really ends a session)
  const sessionInfo = new Map(); // id -> { createdAt, lastSeen, ip, agent } (for the Sessions panel)
  if (store) for (const [id, s] of store.sessions) { sessions.set(id, s.exp); sessionInfo.set(id, s.info); }
  const saveSessions = (touchOnly = false) => {
    if (!store) return;
    try { (touchOnly ? store.touch : store.save)(sessions, sessionInfo); } catch (e) { log(`warning: could not save sessions: ${e.message}`); }
  };
  const limiter = new RateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
  // Sign-ins refused by the rate limit go to the event history, at most one entry per IP per
  // minute (with how many were left out), so a flood of attempts can't flood the history.
  const blockedSeen = new Map(); // ip -> { at, suppressed }
  const recordBlocked = (ip, retryAfter, now = Date.now()) => {
    const b = blockedSeen.get(ip);
    if (b && now - b.at < BLOCKED_LOG_MS) { b.suppressed++; return; }
    const more = b?.suppressed ? ` (${b.suppressed} more since the last entry)` : '';
    events.emit('event', { action: 'sign-in', ok: false, detail: `blocked by the rate limit from ${ip}${more}; retry in ${retryAfter}s` });
    blockedSeen.set(ip, { at: now, suppressed: 0 });
    if (blockedSeen.size > 10000) for (const [k, v] of blockedSeen) if (now - v.at >= BLOCKED_LOG_MS) blockedSeen.delete(k);
  };
  const busy = new Set();
  const ready = (panels ? Promise.resolve(sortPanels(panels)) : loadPanels()).then(buildPanels);
  ready.catch((e) => log(`error: dashboard panels failed to load: ${e.message}`));
  // Run fn while holding the per-project lock; null when the project is busy.
  const withBusy = async (project, fn) => {
    if (busy.has(project)) return null;
    busy.add(project);
    try { return await fn(); } finally { busy.delete(project); }
  };
  const panelCtx = (req, res, url) => ({
    req, res, url, method: req.method, path: url.pathname, log, events, withBusy, runCli, loadConfig,
    invalidate: invalidateCloudflare,
    // The /api/tunnels payload (with every panel's enrich), for panels that push updates.
    async snapshot() {
      const data = await collect(loadConfig());
      for (const p of (await ready).list) {
        if (!p.enrich) continue;
        try { await p.enrich(data.projects, this); } catch (e) { log(`error: panel ${p.id}: ${e.message}`); }
      }
      return data;
    },
    clientIp: clientIp(req),
    json: (status, obj, extra) => json(res, status, obj, extra),
    send: (status, body, type, extra) => send(res, status, body, type, extra),
    readJson: async (limit = 16384) => {
      const text = await readBody(req, limit);
      try { return text ? JSON.parse(text) : {}; } catch { return null; }
    },
    // Signed-in sessions (ids never leave the server; panels see opaque handles).
    sessions: {
      current: () => authed(req) || null,
      list: () => [...sessions].filter(([, exp]) => exp > Date.now()).map(([id, exp]) => ({ id, exp, ...(sessionInfo.get(id) || {}) })),
      revoke: (id) => { sessionInfo.delete(id); const had = sessions.delete(id); saveSessions(); return had; },
      clearCookie: () => cookie('', 0),
    },
  });

  const authed = (req) => {
    const id = verifySession(key, parseCookies(req.headers.cookie)[COOKIE]);
    if (!id) return false;
    const exp = sessions.get(id);
    if (!exp || exp < Date.now()) { sessions.delete(id); sessionInfo.delete(id); saveSessions(); return false; }
    const info = sessionInfo.get(id) || { createdAt: Date.now(), ip: clientIp(req), agent: String(req.headers['user-agent'] || '').slice(0, 200) };
    info.lastSeen = Date.now();
    info.ip = clientIp(req);
    sessionInfo.set(id, info);
    saveSessions(true);
    return id;
  };
  const cookie = (value, maxAge) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    const P = await ready;

    if (req.method === 'GET' && path === '/app.css') return send(res, 200, APP_CSS, 'text/css; charset=utf-8');
    if (req.method === 'GET' && path === '/healthz') return send(res, 200, 'ok');
    if (req.method === 'GET' && path === '/favicon.ico') return send(res, 204, '');
    if (req.method === 'GET' && path === '/login.js') return send(res, 200, LOGIN_JS, 'text/javascript; charset=utf-8');
    const vendor = VENDOR[path] || P.vendor[path];
    if (req.method === 'GET' && vendor) {
      return send(res, 200, vendorAsset(path, vendor), vendor.type, { 'Cache-Control': 'public, max-age=86400' });
    }

    if (path === '/login') {
      if (req.method === 'GET') return send(res, 200, LOGIN_HTML(''), 'text/html; charset=utf-8');
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
      const ip = clientIp(req);
      const wantsJson = String(req.headers.accept || '').includes('application/json');
      const lim = limiter.check(ip);
      if (!lim.allowed) {
        log(`login rate-limited for ${ip}`);
        recordBlocked(ip, lim.retryAfter);
        const msg = `Too many attempts. Try again in ${Math.ceil(lim.retryAfter / 60)} min.`;
        if (wantsJson) return json(res, 429, { error: msg, retryAfter: lim.retryAfter }, { 'Retry-After': String(lim.retryAfter) });
        return send(res, 429, LOGIN_HTML(`Too many attempts. Try again in ${Math.ceil(lim.retryAfter / 60)} min.`),
          'text/html; charset=utf-8', { 'Retry-After': String(lim.retryAfter) });
      }
      let given = '';
      let code = '';
      try {
        const form = new URLSearchParams(await readBody(req));
        given = form.get('password') || '';
        code = form.get('code') || '';
      } catch { return send(res, 413, 'Too large'); }
      if (!passwordMatches(given, password)) {
        limiter.fail(ip);
        log(`login failed from ${ip}`);
        events.emit('event', { action: 'sign-in', ok: false, detail: `wrong password from ${ip}` });
        if (wantsJson) return json(res, 401, { error: 'Wrong password.' });
        return send(res, 401, LOGIN_HTML('Wrong password.'), 'text/html; charset=utf-8');
      }
      // Optional second factor (see totp.js): counts against the same rate limit.
      if (totpEnabled() && !verifyCode(code)) {
        limiter.fail(ip);
        log(`login failed from ${ip}: two-factor code`);
        events.emit('event', { action: 'sign-in', ok: false, detail: `${code ? 'wrong' : 'missing'} two-factor code from ${ip}` });
        const msg = code ? 'Wrong two-factor code.' : 'Enter the code from your authenticator app.';
        if (wantsJson) return json(res, 401, { error: msg, twoFactor: true });
        return send(res, 401, LOGIN_HTML(msg), 'text/html; charset=utf-8');
      }
      limiter.reset(ip);
      const s = signSession(key, SESSION_TTL);
      sessions.set(s.id, s.exp);
      saveSessions();
      log(`login ok from ${ip}`);
      events.emit('event', { action: 'sign-in', detail: `from ${ip}` });
      if (wantsJson) return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(s.value, SESSION_TTL / 1000) });
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
      sessionInfo.delete(sid);
      saveSessions();
      events.emit('event', { action: 'sign-out', detail: `from ${clientIp(req)}` });
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    }
    if (req.method === 'GET' && path === '/') return send(res, 200, P.html, 'text/html; charset=utf-8');
    if (req.method === 'GET' && path === '/app.js') return send(res, 200, APP_JS, 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && path === '/panels.js') return send(res, 200, P.js, 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && path === '/panels.css') return send(res, 200, P.css, 'text/css; charset=utf-8');
    if (req.method === 'GET' && path === '/api/tunnels') {
      const data = await collect(loadConfig());
      const ctx = panelCtx(req, res, url);
      for (const p of P.list) {
        if (!p.enrich) continue;
        try { await p.enrich(data.projects, ctx); } catch (e) { log(`error: panel ${p.id}: ${e.message}`); }
      }
      return json(res, 200, data);
    }

    let m = path.match(/^\/api\/logs\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      try { assertLabel(m[1], 'project'); } catch { return json(res, 400, { error: 'bad project' }); }
      return streamLog(req, res, m[1]);
    }
    if (req.method === 'GET' && path === '/api/logs-all') return streamAll(req, res, SECURITY_HEADERS);
    if (req.method === 'GET' && path === '/api/logs-all/download') {
      return send(res, 200, combinedText(), 'text/plain; charset=utf-8',
        { 'Content-Disposition': `attachment; filename="${downloadName('all')}"` });
    }
    m = path.match(/^\/api\/logs\/([^/]+)\/download$/);
    if (req.method === 'GET' && m) {
      try { assertLabel(m[1], 'project'); } catch { return json(res, 400, { error: 'bad project' }); }
      if (!existsSync(logFile(m[1]))) return json(res, 404, { error: 'no log yet' });
      return send(res, 200, readTail(logFile(m[1]), 10 * 1024 * 1024), 'text/plain; charset=utf-8',
        { 'Content-Disposition': `attachment; filename="${downloadName(m[1])}"` });
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
    for (const p of P.list) {
      if (p.route && (await p.route(panelCtx(req, res, url)))) return;
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
  const server = createDashboard({ password: cfg.dashboardPassword, persistSessions: true });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`burrow dashboard on http://${host}:${port} (pid ${process.pid})`);
      resolve(server);
    });
  });
}
