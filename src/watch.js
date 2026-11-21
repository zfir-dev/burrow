import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig, parseEnv, stateDir } from './config.js';
import { Cloudflare } from './cloudflare.js';
import { tunnelName } from './naming.js';
import { DASHBOARD_PROJECT, dashboardProject, loadProjectFile } from './project.js';
import { localProjects, readMeta, readPid, runningPid } from './process.js';
import { isShare } from './share.js';
import { unitDir } from './service.js';

const log = (...a) => console.log(...a);
const BIN = fileURLToPath(new URL('../bin/burrow.js', import.meta.url));
export const WATCH_UNIT = 'burrow-watch.service';
export const watchStateFile = () => join(stateDir(), 'watch', 'state.json');

// Alert settings come from the environment or the burrow config file.
export function settings(env = process.env) {
  let file = {};
  try { if (existsSync(configPath())) file = parseEnv(readFileSync(configPath(), 'utf8')); } catch {}
  const get = (k) => env[k] || file[k] || '';
  return { webhook: get('BURROW_ALERT_WEBHOOK'), ntfy: get('BURROW_ALERT_NTFY'), ntfyToken: get('BURROW_ALERT_NTFY_TOKEN') };
}

// host:port pairs a project's services listen on, from its tunnel.yml.
export function localTargets(project, cfg = loadConfig()) {
  let proj = null;
  if (project === DASHBOARD_PROJECT) proj = dashboardProject(cfg.dashboardPort);
  else {
    const file = readMeta(project)?.file;
    if (file && existsSync(file)) { try { proj = loadProjectFile(file); } catch {} }
  }
  if (!proj) return [];
  const out = new Map();
  const add = (service, url) => {
    let u;
    try { u = new URL(url); } catch { return; }
    const port = Number(u.port) || { 'http:': 80, 'ws:': 80, 'https:': 443, 'wss:': 443, 'ssh:': 22 }[u.protocol];
    if (!port || !u.hostname) return;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!out.has(`${host}:${port}`)) out.set(`${host}:${port}`, { service, host, port });
  };
  for (const s of proj.services) {
    add(s.name, s.url);
    for (const p of s.paths) add(s.name, p.url);
  }
  return [...out.values()];
}

export function tcpOpen(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// One project's health: ok | degraded | down, with the reasons.
export async function checkProject(project, { tunnels, cfg }) {
  const problems = [];
  const pid = runningPid(project);
  if (!pid) problems.push(['down', readPid(project) ? 'cloudflared is not running (it exited or crashed)' : 'cloudflared is not running']);
  if (tunnels) {
    const t = tunnels.find((x) => x.name === tunnelName(project));
    if (!t) problems.push(['down', `tunnel ${tunnelName(project)} not found on Cloudflare`]);
    else if (t.status === 'down' || t.status === 'inactive') problems.push(['down', `tunnel is ${t.status} (no connections)`]);
    else if (t.status === 'degraded') problems.push(['degraded', `tunnel is degraded (${(t.connections || []).length} connection(s))`]);
  }
  for (const t of localTargets(project, cfg)) {
    if (!(await tcpOpen(t.host, t.port))) problems.push(['degraded', `${t.service}: nothing listening on ${t.host}:${t.port}`]);
  }
  const status = problems.some(([l]) => l === 'down') ? 'down' : problems.length ? 'degraded' : 'ok';
  return { project, status, problems: problems.map(([, what]) => what), hostnames: readMeta(project)?.hostnames || [] };
}

// Debounce: a new status has to be seen `debounce` times in a row before it counts.
// The first observation is compared with "ok", so a project that is already broken alerts.
export function evaluate(prev, observed, debounce, now = Date.now()) {
  const cur = prev || { status: 'ok', pending: null, count: 0, since: now };
  if (observed === cur.status) return { next: { ...cur, pending: null, count: 0 }, change: null };
  const count = cur.pending === observed ? cur.count + 1 : 1;
  if (count >= debounce) {
    return { next: { status: observed, pending: null, count: 0, since: now }, change: { from: cur.status, to: observed } };
  }
  return { next: { ...cur, pending: observed, count }, change: null };
}

export function alertText(a) {
  if (a.to === 'ok') return `burrow: ${a.project} recovered (was ${a.from})`;
  return `burrow: ${a.project} is ${a.to === 'down' ? 'DOWN' : 'degraded'}: ${a.problems.join('; ')}`;
}

// Slack and Discord want {text} and {content}; anything else gets the full JSON payload.
export function webhookBody(url, a) {
  const text = alertText(a);
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  if (/(^|\.)discord(app)?\.com$/.test(host)) return { content: text };
  if (host === 'hooks.slack.com') return { text };
  return {
    text, content: text, project: a.project, status: a.to, previous: a.from,
    problems: a.problems, hostnames: a.hostnames, at: new Date(a.at).toISOString(),
  };
}

async function post(url, body, headers) {
  const res = await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// Never prints the webhook URL or the ntfy token: both are secrets.
// `report` gets delivery failures (the dashboard shows them); returns how many failed.
export async function sendAlert(a, s, { dry = false, report = (m) => console.error(m) } = {}) {
  let failed = 0;
  log(`${dry ? '[dry-run] ' : ''}alert: ${alertText(a)}`);
  if (dry) return 0;
  if (s.webhook) {
    try { await post(s.webhook, JSON.stringify(webhookBody(s.webhook, a)), { 'Content-Type': 'application/json' }); } catch (e) {
      failed++;
      report(`burrow: webhook alert failed: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
    }
  }
  if (s.ntfy) {
    const url = /^https?:\/\//.test(s.ntfy) ? s.ntfy : `https://ntfy.sh/${encodeURIComponent(s.ntfy)}`;
    const headers = {
      Title: `burrow: ${a.project} ${a.to === 'ok' ? 'recovered' : a.to}`,
      Priority: a.to === 'down' ? 'high' : 'default',
      Tags: a.to === 'ok' ? 'white_check_mark' : a.to === 'down' ? 'rotating_light' : 'warning',
      'Content-Type': 'text/plain; charset=utf-8',
    };
    if (s.ntfyToken) headers.Authorization = `Bearer ${s.ntfyToken}`;
    const body = [alertText(a), ...a.hostnames.map((h) => `https://${h}`)].join('\n');
    try { await post(url, body, headers); } catch (e) {
      failed++;
      report(`burrow: ntfy alert failed: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
    }
  }
  return failed;
}

function readState() { try { return JSON.parse(readFileSync(watchStateFile(), 'utf8')); } catch { return {}; } }
function writeState(st) {
  mkdirSync(dirname(watchStateFile()), { recursive: true, mode: 0o700 });
  writeFileSync(watchStateFile(), JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
}

// Projects with a pid file (running, or crashed). `burrow down` removes the pid file,
// so a project you stopped on purpose is no longer watched.
function watched(args) {
  return args.length ? args : localProjects().filter((p) => !isShare(p));
}

async function tick(args, { debounce, dry, verbose }) {
  const cfg = loadConfig();
  let tunnels = null;
  if (cfg.token && cfg.accountId) {
    try {
      tunnels = await new Cloudflare({ token: cfg.token, accountId: cfg.accountId }).listTunnels();
    } catch (e) {
      console.error(`burrow: Cloudflare API check skipped: ${e.message}`);
    }
  }
  const s = settings();
  const prev = readState();
  const next = {};
  const projects = watched(args);
  if (!projects.length && verbose) log('No running burrow projects to watch.');
  for (const project of projects) {
    const r = await checkProject(project, { tunnels, cfg });
    const { next: st, change } = evaluate(prev[project], r.status, debounce);
    next[project] = st;
    if (verbose) log(`${project}: ${r.status}${r.problems.length ? ` (${r.problems.join('; ')})` : ''}${st.pending ? ` [${st.pending} ${st.count}/${debounce}]` : ''}`);
    if (change) await sendAlert({ ...change, project, problems: r.problems, hostnames: r.hostnames, at: Date.now() }, s, { dry });
  }
  writeState(next);
}

function renderUnit({ interval, debounce, env = process.env }) {
  const q = (v) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `"${String(v).replace(/(["\\])/g, '\\$1')}"`);
  const keep = ['PATH', 'BURROW_CONFIG', 'BURROW_STATE_DIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'];
  const envLines = keep.filter((k) => env[k]).map((k) => `Environment=${q(`${k}=${env[k]}`)}`);
  return `# Generated by "burrow watch --install-service". Remove with "burrow watch --uninstall-service".
[Unit]
Description=burrow watch: alerts for Cloudflare Tunnel projects
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
${envLines.join('\n')}
ExecStart=${[process.execPath, BIN, 'watch', '--interval', String(interval), '--debounce', String(debounce)].map(q).join(' ')}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

function systemctl(...args) {
  const r = spawnSync(process.env.BURROW_SYSTEMCTL || 'systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  return { ok: !r.error && r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), error: r.error };
}

async function serviceAction(opts, interval, debounce) {
  const path = join(unitDir(), WATCH_UNIT);
  if (opts.uninstallService) {
    if (opts.dryRun) { log(`[dry-run] would disable ${WATCH_UNIT} and remove ${path}`); return; }
    systemctl('disable', '--now', WATCH_UNIT);
    rmSync(path, { force: true });
    systemctl('daemon-reload');
    log(`Removed ${WATCH_UNIT}.`);
    return;
  }
  const unit = renderUnit({ interval, debounce });
  if (opts.dryRun) { log(`[dry-run] would write ${path}:\n`); log(unit); return; }
  mkdirSync(unitDir(), { recursive: true });
  writeFileSync(path, unit);
  for (const args of [['daemon-reload'], ['enable', '--now', WATCH_UNIT]]) {
    const r = systemctl(...args);
    if (!r.ok) throw new Error(`systemctl --user ${args.join(' ')} failed: ${r.error?.message || r.out}`);
  }
  log(`Wrote ${path} and started ${WATCH_UNIT} (every ${interval}s, debounce ${debounce}).`);
  const s = settings();
  if (!s.webhook && !s.ntfy) log('No alert channel set yet: add BURROW_ALERT_WEBHOOK or BURROW_ALERT_NTFY to the config.');
}

export async function watch(projectArgs = [], opts = {}) {
  const interval = parseInt(opts.interval ?? '60', 10);
  const debounce = parseInt(opts.debounce ?? '2', 10);
  if (!(interval >= 1)) throw new Error(`Invalid --interval "${opts.interval}" (seconds, at least 1)`);
  if (!(debounce >= 1)) throw new Error(`Invalid --debounce "${opts.debounce}" (at least 1)`);
  if (opts.installService || opts.uninstallService) return serviceAction(opts, interval, debounce);
  const s = settings();
  if (!s.webhook && !s.ntfy && !opts.dryRun) log('No alert channel set (BURROW_ALERT_WEBHOOK or BURROW_ALERT_NTFY); changes are only printed.');
  if (opts.once) { await tick(projectArgs, { debounce, dry: !!opts.dryRun, verbose: true }); return; }

  log(`Watching ${projectArgs.length ? projectArgs.join(', ') : 'running projects'} every ${interval}s (debounce ${debounce}). Ctrl+C to stop.`);
  let stop = false;
  let wake = () => {};
  const onSignal = () => { stop = true; wake(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let first = true;
  while (!stop) {
    try { await tick(projectArgs, { debounce, dry: !!opts.dryRun, verbose: first }); } catch (e) { console.error(`burrow: watch: ${e.message}`); }
    first = false;
    if (stop) break;
    await new Promise((resolve) => { const t = setTimeout(resolve, interval * 1000); wake = () => { clearTimeout(t); resolve(); }; });
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  log('Stopped watching.');
}
