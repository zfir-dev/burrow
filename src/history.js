// Event history: an append-only JSON Lines file of the actions that change state
// (up, down, destroy, restart, share, prune, …) with when, where from and the result.
// Recording is best effort and never makes a command fail.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants as osConstants } from 'node:os';
import { stateDir } from './config.js';
import { findProjectFile, loadProjectFile } from './project.js';

// In a subdirectory so it is never mistaken for a project state file.
export const historyFile = () => join(stateDir(), 'history', 'events.jsonl');
export const MAX_BYTES = 1024 * 1024;
export const KEEP_LINES = 2000;
export const SOURCES = ['cli', 'dashboard', 'boot'];

export const sourceFromEnv = (env = process.env, fallback = 'cli') =>
  (SOURCES.includes(env.BURROW_SOURCE) ? env.BURROW_SOURCE : fallback);

function rotate(file) {
  try {
    if (statSync(file).size <= MAX_BYTES) return;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    writeFileSync(file, lines.slice(-KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
  } catch {}
}

export function recordEvent(e) {
  try {
    const file = historyFile();
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    const entry = {
      at: new Date(e.at || Date.now()).toISOString(),
      action: String(e.action || 'unknown'),
      project: e.project ? String(e.project) : null,
      source: SOURCES.includes(e.source) ? e.source : 'cli',
      ok: e.ok !== false,
      ...(e.detail ? { detail: String(e.detail).slice(0, 300) } : {}),
      ...(Number.isFinite(e.durationMs) ? { durationMs: Math.round(e.durationMs) } : {}),
    };
    appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    rotate(file);
    return entry;
  } catch {
    return null;
  }
}

// Newest first.
export function readEvents({ limit = 200, project, source, action } = {}) {
  const file = historyFile();
  if (!existsSync(file)) return [];
  const out = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (project && e.project !== project) continue;
    if (source && e.source !== source) continue;
    if (action && e.action !== action) continue;
    out.push(e);
  }
  return out;
}

// Commands that change state. Read-only ones (ls, status, logs, stats, url, …) aren't recorded.
const RECORDED = new Set(['up', 'down', 'destroy', 'restart', 'share', 'prune', 'add', 'edit', 'import', 'service', 'autostart', 'dashboard', 'update']);
const SUB_ACTIONS = { dashboard: ['up', 'down'], service: ['install', 'uninstall'] };

// What a command would be recorded as, or null when it isn't recorded.
export function describeCommand(command, env = process.env) {
  const name = command.name();
  if (!RECORDED.has(name)) return null;
  const opts = command.opts();
  if (opts.dryRun || opts.check) return null;
  const args = command.args || [];
  let action = name;
  if (SUB_ACTIONS[name]) {
    if (!SUB_ACTIONS[name].includes(args[0])) return null;
    action = `${name} ${args[0]}`;
  }
  let project = null;
  if (['up', 'down', 'destroy', 'restart', 'edit', 'add'].includes(name)) {
    if (args[0]) project = args[0];
    else if (opts.all) project = '(all)';
    else if (name === 'up' || name === 'edit' || opts.file) {
      try { const f = findProjectFile(opts.file); if (f) project = loadProjectFile(f).project; } catch {}
    } else if (name === 'down' || name === 'restart') project = '(all running)';
  }
  if (name === 'share') project = opts.name ? `share ${opts.name}` : null;
  if (name === 'dashboard') project = 'burrow';
  const detail = [
    ...(SUB_ACTIONS[name] ? args.slice(1) : name === 'share' ? [] : args.slice(project === args[0] ? 1 : 0)),
    ...['purge', 'all', 'force', 'includeActive', 'now'].filter((k) => opts[k]).map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`),
  ].join(' ');
  return { action, project, detail, source: sourceFromEnv(env, name === 'autostart' ? 'boot' : 'cli') };
}

export function recordCommand(command, startedAt, { env = process.env, exitCode = process.exitCode, note = '' } = {}) {
  const d = describeCommand(command, env);
  if (!d) return null;
  return recordEvent({ ...d, ok: !exitCode, detail: [d.detail, note].filter(Boolean).join(' · '), durationMs: Date.now() - startedAt });
}

export const TRACKED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// Called from bin/burrow.js before a command runs (commander preAction hook). Returns
// { finish() } for the postAction hook. If the process ends first, the event is still
// written from the 'exit' handler: on process.exit() inside a command, or on SIGINT /
// SIGTERM / SIGHUP. A signal only ends the process here when nothing else listens for it
// (e.g. `share` has its own Ctrl+C cleanup, which then exits or returns normally), so
// the default "terminate" behaviour is kept, with exit code 128 + signal number.
// SIGKILL can't be caught: such a run leaves no entry.
export function trackCommand(command, { env = process.env, proc = process } = {}) {
  const d = describeCommand(command, env);
  if (!d) return null;
  const startedAt = Date.now();
  let done = false;
  let signal = null;
  const handlers = {};
  const cleanup = () => {
    proc.removeListener('exit', onExit);
    for (const sig of TRACKED_SIGNALS) proc.removeListener(sig, handlers[sig]);
  };
  const finish = (exitCode, note) => {
    if (done) return null;
    done = true;
    cleanup();
    return recordEvent({ ...d, ok: !exitCode, detail: [d.detail, note].filter(Boolean).join(' · '), durationMs: Date.now() - startedAt });
  };
  function onExit(code) {
    finish(code, signal ? `stopped by ${signal}` : `exited before finishing (code ${code})`);
  }
  for (const sig of TRACKED_SIGNALS) {
    handlers[sig] = () => {
      signal = sig;
      if (proc.listenerCount(sig) <= 1) proc.exit(128 + (osConstants.signals[sig] || 0));
    };
    proc.on(sig, handlers[sig]);
  }
  proc.on('exit', onExit);
  return {
    finish: (exitCode = proc.exitCode) => finish(exitCode, signal ? `stopped by ${signal}` : ''),
  };
}
