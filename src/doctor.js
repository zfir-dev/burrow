import { existsSync, statSync, readdirSync, accessSync, constants, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { connect } from 'node:net';
import { loadConfig, stateDir } from './config.js';
import { Cloudflare } from './cloudflare.js';
import { assertDomain } from './naming.js';
import { findProjectFile, loadProjectFile } from './project.js';
import { readMeta } from './process.js';
import { loadHooks } from './hooks.js';
import { parseCommands, isAssignment } from './shell-words.js';
import { zoneIdFor } from './zones.js';

// Shell builtins and keywords that need no file; cd is followed so later commands are checked
// in the right directory.
const SHELL_BUILTINS = new Set(['cd', 'export', 'set', 'unset', 'test', '[', 'true', 'false', ':', '.', 'source', 'echo', 'printf',
  'exit', 'trap', 'wait', 'read', 'shift', 'umask', 'ulimit', 'alias', 'eval', 'return', 'local', 'readonly', 'type', 'hash', 'kill', 'pwd']);
// Prefixes that run the command after them.
const WRAPPERS = new Set(['exec', 'nohup', 'command', 'time', 'env', 'nice', 'setsid']);
const executable = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
const onPath = (word, path) => {
  for (const dir of path.split(delimiter)) if (dir && executable(join(dir, word))) return join(dir, word);
  return null;
};

function packageScripts(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts || {}; } catch { return null; }
}

// `npm run x`, `npm start|test|stop|restart`, `yarn [run] x`, `pnpm [run] x`: is script x in
// package.json? Returns a problem string or null.
function scriptProblem(tool, args, cwd) {
  const rest = args.filter((a) => !a.startsWith('-'));
  let script = null;
  if (tool === 'npm') {
    if (['run', 'run-script', 'rum', 'urn'].includes(rest[0])) script = rest[1];
    else if (['start', 'test', 't', 'stop', 'restart'].includes(rest[0])) script = rest[0] === 't' ? 'test' : rest[0];
    if (!script) return null;
  } else {
    const builtin = ['install', 'add', 'remove', 'i', 'exec', 'dlx', 'create', 'init', 'why', 'list', 'ls', 'outdated', 'upgrade', 'up', 'update', 'link', 'unlink', 'config', 'cache', 'store', 'audit', 'info', 'publish', 'pack'];
    if (rest[0] === 'run') script = rest[1];
    else if (rest[0] && !builtin.includes(rest[0])) script = rest[0];
    if (!script) return null;
  }
  const scripts = packageScripts(cwd);
  if (!scripts) return { problem: `${tool} ${rest.join(' ')}: no package.json in ${cwd}` };
  if (script in scripts) return null;
  // npm's default: with no start script, `npm start` runs `node server.js`.
  if (tool === 'npm' && script === 'start' && rest[0] === 'start' && existsSync(join(cwd, 'server.js'))) {
    return { note: `npm start: no "start" script, so npm runs "node server.js" (${join(cwd, 'server.js')})` };
  }
  return { problem: `${tool}: no "${script}" script in ${join(cwd, 'package.json')}` };
}

// Check a hook command without running it: for every simple command (each part of a
// pipeline, && / || / ; list), skip VAR=value prefixes and wrappers (env, exec, nohup, …),
// follow `cd <dir>`, and look the command up (builtin, ./script relative to the current
// directory, or PATH); `npm run x` and friends also need script x in package.json.
// Commands inside $(…), backticks, ( … ), { …; }, if/while/until/for/case are checked too
// (see shell-words.js): a cd in a subshell or $(…) stays there, and a cd inside an if/loop/case
// body makes the directory unknown after the block.
// -> { ok, detail, problems: [...], checked: [...], unchecked: [...], notes: [...] }
export function checkHookCommand(run, cwd, path = process.env.PATH || '') {
  const problems = [];
  const checked = [];
  const unchecked = [];
  const notes = [];
  // Current directory per scope (a subshell or $(…) starts in its parent's directory).
  const dirs = new Map([['', cwd]]);
  const cdInBlock = new Set();
  const lastDepth = new Map(); // scope -> depth of its previous command
  const entryDirs = new Map(); // scope -> [directory when each block depth was entered]
  const parentOf = (s) => s.slice(0, s.lastIndexOf('/'));
  for (const cmd of parseCommands(run)) {
    const scope = cmd.scope || '';
    if (!dirs.has(scope)) dirs.set(scope, dirs.get(parentOf(scope)) ?? null);
    if (cmd.depth === 0 && cdInBlock.has(scope)) { cdInBlock.delete(scope); dirs.set(scope, null); }
    const entry = entryDirs.get(scope) || [];
    entryDirs.set(scope, entry);
    for (let d = (lastDepth.get(scope) ?? 0) + 1; d <= cmd.depth; d++) entry[d] = dirs.get(scope);
    lastDepth.set(scope, cmd.depth);
    // A then/else/case-arm body starts where the block began, not where the last branch cd'd to.
    if (cmd.branchStart && cmd.depth > 0 && entry[cmd.depth] !== undefined) dirs.set(scope, entry[cmd.depth]);
    let dir = dirs.get(scope);
    const setDir = (d) => { dir = d; dirs.set(scope, d); if (cmd.depth > 0) cdInBlock.add(scope); };
    if (cmd.unsupported) { unchecked.push(cmd.unsupported); continue; }
    let words = cmd.words.slice();
    while (words.length && isAssignment(words[0])) words.shift();
    while (words.length && !words[0].quoted && WRAPPERS.has(words[0].text)) {
      const w = words.shift().text;
      while (words.length && (words[0].text.startsWith('-') || (w === 'env' && isAssignment(words[0])))) {
        const opt = words.shift().text;
        if (w === 'nice' && opt === '-n') words.shift();
      }
    }
    if (!words.length) continue;
    const [head, ...args] = words;
    if (head.expands) { unchecked.push(`${head.text} (${/[`(]/.test(head.text) ? 'command output' : 'variable'})`); continue; }
    const name = head.text;
    if (name === 'cd') {
      const target = args[0];
      if (!target) { setDir(process.env.HOME || dir); continue; }
      if (target.expands || target.text === '-') { unchecked.push(`cd ${target.text}`); setDir(null); continue; }
      if (dir === null && !isAbsolute(target.text)) { unchecked.push(`cd ${target.text}`); continue; }
      const next = isAbsolute(target.text) ? target.text : join(dir, target.text);
      if (!existsSync(next)) problems.push(`cd ${target.text}: no such directory in ${dir}`);
      setDir(next);
      continue;
    }
    if (SHELL_BUILTINS.has(name)) { checked.push(name); continue; }
    if (name.includes('/')) {
      if (dir === null && !isAbsolute(name)) { unchecked.push(name); continue; }
      const p = isAbsolute(name) ? name : join(dir, name);
      if (executable(p)) checked.push(name); else problems.push(`${name} not found or not executable in ${dir}`);
      continue;
    }
    if (!onPath(name, path)) { problems.push(`${name} not found on PATH`); continue; }
    checked.push(name);
    if (['npm', 'yarn', 'pnpm'].includes(name) && dir !== null) {
      const p = scriptProblem(name, args.map((a) => a.text), dir);
      if (p?.problem) problems.push(p.problem);
      if (p?.note) notes.push(p.note);
    }
  }
  const ok = problems.length === 0;
  const parts = ok ? [checked.length ? `found: ${[...new Set(checked)].join(', ')}` : ''] : [...problems];
  if (notes.length) parts.push(`note: ${[...new Set(notes)].join(', ')}`);
  if (unchecked.length) parts.push(`not checked: ${[...new Set(unchecked)].join(', ')}`);
  return { ok, detail: parts.filter(Boolean).join('; ') || 'nothing to check', problems, checked, unchecked, notes };
}

// Kept for callers of the first version: the result of checkHookCommand.
export const hookCommandFound = (run, cwd, path) => checkHookCommand(run, cwd, path);

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
      const r = checkHookCommand(h.run, cwd);
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
