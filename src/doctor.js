import { existsSync, statSync, readdirSync, accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { connect } from 'node:net';
import { loadConfig, stateDir } from './config.js';
import { Cloudflare } from './cloudflare.js';
import { assertDomain } from './naming.js';
import { findProjectFile, loadProjectFile } from './project.js';
import { readMeta } from './process.js';
import { loadHooks } from './hooks.js';
import { zoneIdFor } from './zones.js';

const SHELL_BUILTINS = new Set(['cd', 'exec', 'export', 'set', 'test', '[', 'true', 'false', ':', '.', 'source', 'echo', 'printf', 'exit', 'trap', 'wait', 'sleep', 'if', 'for', 'while', 'case', '{', '(']);
const executable = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };

// Can the first word of a hook command be found? Best effort: a hook is a shell command, so
// anything with leading variable assignments, builtins or shell syntax is not second-guessed.
export function hookCommandFound(run, cwd, path = process.env.PATH || '') {
  const word = String(run).trim().split(/\s+/)[0] || '';
  if (!word || /[=$`'"*?;|&<>(){}]/.test(word) || SHELL_BUILTINS.has(word)) return { ok: true, detail: 'not checked (shell syntax)' };
  if (word.includes('/')) {
    const p = isAbsolute(word) ? word : join(cwd, word);
    return executable(p) ? { ok: true, detail: word } : { ok: false, detail: `${word} not found or not executable in ${cwd}` };
  }
  for (const dir of path.split(delimiter)) if (dir && executable(join(dir, word))) return { ok: true, detail: join(dir, word) };
  return { ok: false, detail: `${word} not found on PATH` };
}

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
  const file = opts.all ? null : findProjectFile(opts.file);
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

// opts.json: print one JSON line { counts, checks: [{ section, status, label, detail, fix }] }
// instead of the text report (the dashboard's Doctor panel reads it). opts.all: check every
// remembered project and ignore ./tunnel.yml.
export async function doctor(projectArg, opts = {}) {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  const checks = [];
  let current = '';
  const out = opts.json ? () => {} : (...a) => console.log(...a);
  const report = (status, label, detail = '', fix = '') => {
    counts[status]++;
    checks.push({ section: current, status, label, detail, ...(fix && (status === 'fail' || status === 'warn') ? { fix } : {}) });
    out(`  ${MARK[status]} ${label}${detail ? ` - ${detail}` : ''}`);
  };
  const section = (title) => { current = title; out(`\n${title}`); };
  const cfg = loadConfig();

  section('Config');
  if (cfg.exists) {
    report('pass', 'config file', cfg.path);
    const mode = statSync(cfg.path).mode & 0o777;
    if (mode & 0o077) report('warn', 'config permissions', `${mode.toString(8)}; run chmod 600 ${cfg.path}`, `Run: chmod 600 ${cfg.path}`);
    else report('pass', 'config permissions', mode.toString(8));
  } else {
    report('fail', 'config file', `${cfg.path} missing; run burrow init`, 'Run "burrow init" on the server, then fill in the token, account ID and domain.');
  }
  report(cfg.token ? 'pass' : 'fail', 'CF_API_TOKEN', cfg.token ? 'set' : 'missing', 'Create an API token (Account > Cloudflare Tunnel > Edit, Zone > DNS > Edit) and set CF_API_TOKEN in the config.');
  report(cfg.accountId ? 'pass' : 'fail', 'CF_ACCOUNT_ID', cfg.accountId ? 'set' : 'missing', 'Copy the account ID from the Cloudflare dashboard into CF_ACCOUNT_ID.');
  try {
    assertDomain(cfg.domain);
    report('pass', 'BURROW_DOMAIN', cfg.domain);
  } catch {
    report('fail', 'BURROW_DOMAIN', cfg.domain ? `invalid: ${cfg.domain}` : 'missing', 'Set BURROW_DOMAIN to a domain (zone) on your Cloudflare account, e.g. example.dev.');
  }

  section('Cloudflare API');
  if (opts.offline) {
    report('skip', 'API checks', '--offline');
  } else if (!cfg.token || !cfg.accountId || !cfg.domain) {
    report('skip', 'API checks', 'config incomplete');
  } else {
    const cf = new Cloudflare({ token: cfg.token, accountId: cfg.accountId, zoneId: cfg.zoneId });
    const tryCheck = async (label, fn, fix) => {
      try { report('pass', label, await fn()); return true; } catch (e) { report('fail', label, e.message, fix); return false; }
    };
    await tryCheck('token', async () => {
      const v = await cf.verifyToken();
      if (v?.status && v.status !== 'active') throw new Error(`status ${v.status}`);
      return `${v?.status || 'ok'}${v?.expires_on ? `, expires ${v.expires_on}` : ''}`;
    }, 'The token is wrong, expired or disabled: create a new one and update CF_API_TOKEN.');
    if (await tryCheck('zone', async () => `${cfg.domain} (${await cf.resolveZoneId(cfg.domain)})`,
      `Add ${cfg.domain} to the account in CF_ACCOUNT_ID, or give the token Zone > Zone > Read for it.`)) {
      await tryCheck('tunnel access', async () => `${(await cf.listTunnels()).length} tunnel(s) in the account`,
        'Give the token Account > Cloudflare Tunnel > Edit.');
      await tryCheck('DNS access', async () => `${(await cf.recordsByCommentPrefix('burrow:')).length} burrow record(s)`,
        `Give the token Zone > DNS > Edit for ${cfg.domain}.`);
    }
  }

  section('cloudflared');
  const v = spawnSync(cfg.cloudflared, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (v.error || v.status !== 0) report('fail', 'cloudflared', `${cfg.cloudflared} not runnable (${v.error?.code || `exit ${v.status}`})`, 'Install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or set CLOUDFLARED_BIN to its path.');
  else report('pass', 'cloudflared', (v.stdout || v.stderr).trim().split('\n')[0]);

  const files = projectsToCheck(projectArg, opts);
  for (const file of files) {
    let proj;
    try { proj = loadProjectFile(file); } catch (e) {
      section(`Project file ${file}`);
      report('fail', 'tunnel.yml', e.message, `Fix ${file} (burrow up prints the same error).`);
      continue;
    }
    section(`Project ${proj.project} (${file})`);
    // The project's own domain: is a separate zone; the API section only checked BURROW_DOMAIN's.
    if (proj.domain && proj.domain !== cfg.domain) {
      if (opts.offline) report('skip', `domain ${proj.domain}`, '--offline');
      else if (!cfg.token || !cfg.accountId) report('skip', `domain ${proj.domain}`, 'config incomplete');
      else {
        try {
          const cf = new Cloudflare({ token: cfg.token, accountId: cfg.accountId });
          report('pass', `domain ${proj.domain}`, `zone ${await zoneIdFor(cf, cfg, proj.domain, { refresh: true })}`);
        } catch (e) {
          report('fail', `domain ${proj.domain}`, e.message, `Add ${proj.domain} to the account in CF_ACCOUNT_ID and give the token Zone > Zone > Read and Zone > DNS > Edit for it, or remove domain: from ${file}.`);
        }
      }
    }
    let hooks = {};
    try { hooks = loadHooks(file); } catch (e) {
      report('fail', 'hooks', e.message, `Fix the hooks: section of ${file} (burrow up stops on the same error).`);
    }
    for (const [name, h] of Object.entries(hooks)) {
      const cwd = dirname(file);
      const r = hookCommandFound(h.run, cwd);
      report(r.ok ? 'pass' : 'warn', `hook ${name}${h.background ? ' (background)' : ''}`, r.detail,
        `Install the command or fix hooks.${name} in ${file}; hooks run with /bin/sh in ${cwd}.`);
    }
    for (const s of proj.services) {
      for (const p of s.paths) {
        const r = await checkTarget(p.url);
        report(r.ok ? 'pass' : 'fail', `${s.name} ${p.path} -> ${p.url}`, r.detail, `Start the app behind ${p.url}, or fix the URL in tunnel.yml.`);
      }
      const r = await checkTarget(s.url);
      report(r.ok ? 'pass' : 'fail', `${s.name} -> ${s.url}`, r.detail, `Start the app behind ${s.url}, or fix the URL in tunnel.yml.`);
    }
  }
  if (!files.length) { section('Projects'); report('skip', 'local services', 'no tunnel.yml here and no remembered projects'); }

  out(`\n${counts.pass} passed, ${counts.warn} warning(s), ${counts.fail} failed${counts.skip ? `, ${counts.skip} skipped` : ''}`);
  if (opts.json) console.log(JSON.stringify({ counts, checks }));
  if (counts.fail) process.exitCode = 1;
  return counts;
}
