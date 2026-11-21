import { existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { loadConfig, stateDir } from './config.js';
import { Cloudflare } from './cloudflare.js';
import { assertDomain } from './naming.js';
import { findProjectFile, loadProjectFile } from './project.js';
import { readMeta } from './process.js';

const MARK = { pass: '✓', warn: '!', fail: '✗', skip: '-' };

// Can we open a TCP connection to the service behind a tunnel ingress URL?
export function checkTarget(url, timeoutMs = 1500) {
  if (/^(http_status:\d+|hello_world)$/.test(url)) return Promise.resolve({ ok: true, detail: 'built-in' });
  let u;
  try { u = new URL(url); } catch { return Promise.resolve({ ok: false, detail: 'invalid URL' }); }
  if (u.protocol === 'unix:') {
    const ok = existsSync(u.pathname);
    return Promise.resolve({ ok, detail: ok ? 'socket exists' : 'socket missing' });
  }
  const defaults = { 'http:': 80, 'ws:': 80, 'https:': 443, 'wss:': 443, 'ssh:': 22 };
  const port = Number(u.port || defaults[u.protocol]);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const finish = (ok, detail) => { sock.destroy(); resolve({ ok, detail }); };
    sock.setTimeout(timeoutMs, () => finish(false, 'timed out'));
    sock.once('connect', () => finish(true, 'reachable'));
    sock.once('error', (e) => finish(false, e.code === 'ECONNREFUSED' ? 'connection refused' : e.code || e.message));
  });
}

function projectsToCheck(projectArg, opts) {
  const file = findProjectFile(opts.file);
  if (file && (!projectArg || loadProjectFile(file).project === projectArg)) return [file];
  if (projectArg) {
    const meta = readMeta(projectArg);
    if (meta?.file && existsSync(meta.file)) return [meta.file];
    throw new Error(`No tunnel.yml known for "${projectArg}". Run burrow up -f <file> once, or pass -f.`);
  }
  // No project given and no ./tunnel.yml: every remembered project.
  let names = [];
  try { names = readdirSync(stateDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch {}
  return [...new Set(names.map((n) => readMeta(n)?.file).filter((f) => f && existsSync(f)))];
}

export async function doctor(projectArg, opts = {}) {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  const report = (status, label, detail = '') => {
    counts[status]++;
    console.log(`  ${MARK[status]} ${label}${detail ? ` - ${detail}` : ''}`);
  };
  const section = (title) => console.log(`\n${title}`);
  const cfg = loadConfig();

  section('Config');
  if (cfg.exists) {
    report('pass', 'config file', cfg.path);
    const mode = statSync(cfg.path).mode & 0o777;
    if (mode & 0o077) report('warn', 'config permissions', `${mode.toString(8)}; run chmod 600 ${cfg.path}`);
    else report('pass', 'config permissions', mode.toString(8));
  } else {
    report('fail', 'config file', `${cfg.path} missing; run burrow init`);
  }
  report(cfg.token ? 'pass' : 'fail', 'CF_API_TOKEN', cfg.token ? 'set' : 'missing');
  report(cfg.accountId ? 'pass' : 'fail', 'CF_ACCOUNT_ID', cfg.accountId ? 'set' : 'missing');
  try {
    assertDomain(cfg.domain);
    report('pass', 'BURROW_DOMAIN', cfg.domain);
  } catch {
    report('fail', 'BURROW_DOMAIN', cfg.domain ? `invalid: ${cfg.domain}` : 'missing');
  }

  section('Cloudflare API');
  if (opts.offline) {
    report('skip', 'API checks', '--offline');
  } else if (!cfg.token || !cfg.accountId || !cfg.domain) {
    report('skip', 'API checks', 'config incomplete');
  } else {
    const cf = new Cloudflare({ token: cfg.token, accountId: cfg.accountId, zoneId: cfg.zoneId });
    const tryCheck = async (label, fn) => {
      try { report('pass', label, await fn()); return true; } catch (e) { report('fail', label, e.message); return false; }
    };
    await tryCheck('token', async () => {
      const v = await cf.verifyToken();
      if (v?.status && v.status !== 'active') throw new Error(`status ${v.status}`);
      return `${v?.status || 'ok'}${v?.expires_on ? `, expires ${v.expires_on}` : ''}`;
    });
    if (await tryCheck('zone', async () => `${cfg.domain} (${await cf.resolveZoneId(cfg.domain)})`)) {
      await tryCheck('tunnel access', async () => `${(await cf.listTunnels()).length} tunnel(s) in the account`);
      await tryCheck('DNS access', async () => `${(await cf.recordsByCommentPrefix('burrow:')).length} burrow record(s)`);
    }
  }

  section('cloudflared');
  const v = spawnSync(cfg.cloudflared, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (v.error || v.status !== 0) report('fail', 'cloudflared', `${cfg.cloudflared} not runnable (${v.error?.code || `exit ${v.status}`})`);
  else report('pass', 'cloudflared', (v.stdout || v.stderr).trim().split('\n')[0]);

  const files = projectsToCheck(projectArg, opts);
  for (const file of files) {
    let proj;
    try { proj = loadProjectFile(file); } catch (e) {
      section(`Project file ${file}`);
      report('fail', 'tunnel.yml', e.message);
      continue;
    }
    section(`Project ${proj.project} (${file})`);
    for (const s of proj.services) {
      for (const p of s.paths) {
        const r = await checkTarget(p.url);
        report(r.ok ? 'pass' : 'fail', `${s.name} ${p.path} -> ${p.url}`, r.detail);
      }
      const r = await checkTarget(s.url);
      report(r.ok ? 'pass' : 'fail', `${s.name} -> ${s.url}`, r.detail);
    }
  }
  if (!files.length) { section('Projects'); report('skip', 'local services', 'no tunnel.yml here and no remembered projects'); }

  console.log(`\n${counts.pass} passed, ${counts.warn} warning(s), ${counts.fail} failed${counts.skip ? `, ${counts.skip} skipped` : ''}`);
  if (counts.fail) process.exitCode = 1;
  return counts;
}
