import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { stateDir } from './config.js';
import { readMeta, runningPid } from './process.js';

// tunnel.yml `hooks:` — shell commands run in the project directory around up and down.
export const HOOK_NAMES = ['pre_up', 'post_up', 'pre_down', 'post_down'];
export const DEFAULT_TIMEOUT = 120; // seconds
const KEYS = ['run', 'timeout', 'background', 'wait_for'];
const log = (...a) => console.log(...a);

// The background pre_up process lives in a subdirectory, so its pid file is never
// mistaken for a project's cloudflared pid file.
export const hookDir = () => join(stateDir(), 'hooks');
export const backgroundPidFile = (project) => join(hookDir(), `${project}.pid`);
export const backgroundLogFile = (project) => join(hookDir(), `${project}.log`);

export function parseHooks(doc, source = 'tunnel.yml') {
  const raw = doc?.hooks;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${source}: "hooks" must be a mapping of ${HOOK_NAMES.join(', ')}`);
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    const where = `${source}: hooks.${name}`;
    if (!HOOK_NAMES.includes(name)) throw new Error(`${where}: unknown hook (use ${HOOK_NAMES.join(', ')})`);
    const h = typeof value === 'string' ? { run: value } : value;
    if (!h || typeof h !== 'object' || Array.isArray(h) || typeof h.run !== 'string' || !h.run.trim()) {
      throw new Error(`${where}: expected a command string or { run: "<command>" }`);
    }
    const unknown = Object.keys(h).filter((k) => !KEYS.includes(k));
    if (unknown.length) throw new Error(`${where}: unknown key(s) ${unknown.join(', ')} (use ${KEYS.join(', ')})`);
    const timeout = h.timeout === undefined ? DEFAULT_TIMEOUT : Number(h.timeout);
    if (!(timeout > 0 && timeout <= 3600)) throw new Error(`${where}: timeout must be 1-3600 seconds`);
    if (h.background !== undefined && typeof h.background !== 'boolean') throw new Error(`${where}: background must be true or false`);
    const background = h.background === true;
    if (background && name !== 'pre_up') throw new Error(`${where}: only pre_up can run in the background`);
    let waitFor = null;
    if (h.wait_for !== undefined) {
      if (!background) throw new Error(`${where}: wait_for needs background: true`);
      const m = String(h.wait_for).match(/^(?:([^:\s]+):)?(\d{1,5})$/);
      if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new Error(`${where}: wait_for must be a port or host:port`);
      waitFor = { host: m[1] || '127.0.0.1', port: Number(m[2]) };
    }
    out[name] = { run: h.run, timeout, background, waitFor };
  }
  return out;
}

export function loadHooks(file) {
  if (!file || !existsSync(file)) return {};
  return parseHooks(YAML.parse(readFileSync(file, 'utf8')) || {}, file);
}

// What a hook gets to know: project, its tunnel.yml directory and hostnames.
export function hookContext(proj, file, hosts, extra = {}) {
  const root = hosts.find((h, i) => proj.services[i]?.root) || hosts[0];
  return { project: proj.project, file, hostnames: hosts.map((h) => h.hostname), url: root ? `https://${root.hostname}` : '', extra };
}

// The same, for down: from the file remembered by the last `burrow up`.
export function downContext(project, fileOpt) {
  const meta = readMeta(project);
  const file = fileOpt ? resolve(fileOpt) : meta?.file;
  const hostnames = meta?.hostnames || [];
  return { project, file, hostnames, url: hostnames[0] ? `https://${hostnames[0]}` : '', extra: {} };
}

function env(ctx, name) {
  return {
    ...process.env,
    BURROW_PROJECT: ctx.project,
    BURROW_HOSTNAMES: ctx.hostnames.join(','),
    BURROW_URL: ctx.url,
    BURROW_HOOK: name,
    ...ctx.extra,
  };
}

const killGroup = (pid, sig) => {
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
};
const groupAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Foreground hook: own process group, killed (TERM, then KILL) when it runs out of time.
function runForeground(name, hook, ctx) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/sh', ['-c', hook.run], {
      cwd: dirname(ctx.file), env: env(ctx, name), stdio: ['ignore', 'inherit', 'inherit'], detached: true,
    });
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 3000);
    }, hook.timeout * 1000);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`${name} hook could not start: ${e.message}`)); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) { killGroup(child.pid, 'SIGKILL'); return reject(new Error(`${name} hook timed out after ${hook.timeout}s: ${hook.run}`)); }
      if (code !== 0) return reject(new Error(`${name} hook failed (${signal || `exit ${code}`}): ${hook.run}`));
      resolvePromise();
    });
  });
}

function readBackgroundPid(project) {
  try {
    const pid = parseInt(readFileSync(backgroundPidFile(project), 'utf8'), 10);
    return pid > 0 ? pid : null;
  } catch { return null; }
}
export const backgroundPid = (project) => {
  const pid = readBackgroundPid(project);
  return groupAlive(pid) ? pid : null;
};

function portOpen({ host, port }) {
  return new Promise((done) => {
    const s = createConnection({ host, port });
    const end = (ok) => { s.destroy(); done(ok); };
    s.setTimeout(1000, () => end(false));
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
}

async function startBackground(hook, ctx) {
  const running = backgroundPid(ctx.project);
  if (running) { log(`pre_up (background) already running (pid ${running}); keeping it`); return; }
  mkdirSync(hookDir(), { recursive: true, mode: 0o700 });
  const out = openSync(backgroundLogFile(ctx.project), 'a', 0o600);
  const child = spawn('/bin/sh', ['-c', hook.run], {
    cwd: dirname(ctx.file), env: env(ctx, 'pre_up'), stdio: ['ignore', out, out], detached: true,
  });
  closeSync(out);
  child.on('error', () => {});
  child.unref();
  if (!child.pid) throw new Error(`pre_up (background) could not start: ${hook.run}`);
  writeFileSync(backgroundPidFile(ctx.project), String(child.pid), { mode: 0o600 });
  log(`pre_up (background) started (pid ${child.pid}), log ${backgroundLogFile(ctx.project)}`);
  if (!hook.waitFor) return;
  const { host, port } = hook.waitFor;
  const deadline = Date.now() + hook.timeout * 1000;
  for (;;) {
    if (await portOpen(hook.waitFor)) { log(`pre_up (background) is listening on ${host}:${port}`); return; }
    if (!groupAlive(child.pid)) {
      rmSync(backgroundPidFile(ctx.project), { force: true });
      throw new Error(`pre_up (background) exited before ${host}:${port} opened; see ${backgroundLogFile(ctx.project)}`);
    }
    if (Date.now() > deadline) {
      await stopBackground(ctx.project);
      throw new Error(`pre_up (background): ${host}:${port} didn't open within ${hook.timeout}s; stopped it. See ${backgroundLogFile(ctx.project)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Stops the background pre_up process group. Returns its pid, or null.
export async function stopBackground(project) {
  const pid = readBackgroundPid(project);
  if (!pid) return null;
  if (!groupAlive(pid)) { rmSync(backgroundPidFile(project), { force: true }); return null; }
  killGroup(pid, 'SIGTERM');
  for (let i = 0; i < 25 && groupAlive(pid); i++) await new Promise((r) => setTimeout(r, 200));
  if (groupAlive(pid)) killGroup(pid, 'SIGKILL');
  rmSync(backgroundPidFile(project), { force: true });
  return pid;
}

// Runs one hook if tunnel.yml defines it. pre_* failures throw (up stops there);
// with soft: true a failure is reported and sets the exit code instead.
export async function runHook(name, ctx, { dry = false, enabled = true, soft = false } = {}) {
  if (!enabled || !ctx.file) return;
  const hook = loadHooks(ctx.file)[name];
  if (!hook) return;
  const label = `${name}${hook.background ? ' (background)' : ''}`;
  if (dry) { log(`[dry-run] would run ${label} hook in ${dirname(ctx.file)}: ${hook.run}`); return; }
  log(`Running ${label} hook: ${hook.run}`);
  const started = Date.now();
  try {
    if (hook.background) await startBackground(hook, ctx);
    else await runForeground(name, hook, ctx);
    recordHookResult({ project: ctx.project, hook: name, background: hook.background, ok: true, started });
  } catch (e) {
    recordHookResult({ project: ctx.project, hook: name, background: hook.background, ok: false, started, error: e.message.split(`: ${hook.run}`).join('') });
    if (!soft) throw e;
    console.error(`burrow: ${e.message}`);
    process.exitCode = 1;
  }
}

// Hook results (for the dashboard): JSON Lines, newest last, without the command or its
// output (both can hold secrets). Best effort; never fails the command.
export const hookResultsFile = () => join(hookDir(), 'results.jsonl');
const KEEP_RESULTS = 500;
export function recordHookResult({ project, hook, background, ok, started, error }) {
  try {
    mkdirSync(hookDir(), { recursive: true, mode: 0o700 });
    const file = hookResultsFile();
    const entry = {
      at: new Date(started).toISOString(), project, hook, background: !!background, ok,
      durationMs: Date.now() - started, source: process.env.BURROW_SOURCE || 'cli',
      ...(error ? { error: String(error).slice(0, 300) } : {}),
    };
    appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > KEEP_RESULTS * 2) writeFileSync(file, lines.slice(-KEEP_RESULTS).join('\n') + '\n', { mode: 0o600 });
  } catch {}
}
export function readHookResults({ limit = 100, project } = {}) {
  let lines = [];
  try { lines = readFileSync(hookResultsFile(), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (project && e.project !== project) continue;
    out.push(e);
  }
  return out;
}

// down: pre_down runs while cloudflared is still up. Hooks only run for a project that
// has something running (its connector or a background pre_up process).
export async function beforeDown(project, opts = {}) {
  const ctx = downContext(project, opts.file);
  const enabled = opts.hooks !== false;
  const active = !!(runningPid(project) || backgroundPid(project));
  if (opts.dryRun) {
    if (active) await runHook('pre_down', ctx, { dry: true, enabled });
    const bg = backgroundPid(project);
    if (bg) log(`[dry-run] would stop the pre_up background process (pid ${bg})`);
    if (active) await runHook('post_down', ctx, { dry: true, enabled });
    return ctx;
  }
  ctx.active = active;
  if (active) await runHook('pre_down', ctx, { enabled, soft: true });
  return ctx;
}

// down: after cloudflared stopped, stop the background process, then post_down.
export async function afterDown(project, ctx, opts = {}) {
  const bg = await stopBackground(project);
  if (bg) log(`${project}: stopped pre_up background process (pid ${bg})`);
  if (ctx.active) await runHook('post_down', ctx, { enabled: opts.hooks !== false, soft: true });
}
