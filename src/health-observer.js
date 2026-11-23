// Health changes seen by the dashboard, for when `burrow watch` isn't running.
// Every refresh of the project list (and a timer in the dashboard, so it works with no browser
// open) compares what each project is doing with the last observation and records a change in
// the event history as action `health`, source `dashboard`, e.g.
// `down: cloudflared is not running (it exited or crashed) (was ok)`. The uptime timeline reads
// these like the ones `burrow watch` writes. While `burrow watch` is active (its state file was
// written in the last WATCH_FRESH_MS) it owns health changes and the dashboard records nothing.
// No port probes here: only the connector process and the tunnel status from Cloudflare.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from './config.js';
import { recordEvent } from './history.js';
import { readPid } from './process.js';
import { isShare } from './share.js';
import { watchStateFile } from './watch.js';

export const observedFile = () => join(stateDir(), 'watch', 'observed.json');
export const WATCH_FRESH_MS = 5 * 60 * 1000;
// A new status must be seen twice, at least this far apart, before it counts (a restart briefly
// looks like a crash).
export const CONFIRM_MS = 15 * 1000;

export function watchActive(now = Date.now()) {
  try { return now - statSync(watchStateFile()).mtimeMs < WATCH_FRESH_MS; } catch { return false; }
}

// { status: ok|degraded|down, reason } for a /api/tunnels project row, or null when the project
// is stopped on purpose (no pid file) or is the dashboard itself.
export function observedStatus(p, { pidFileExists = (name) => !!readPid(name) } = {}) {
  if (!p || p.builtIn || isShare(p.project)) return null;
  if (!p.running) {
    return pidFileExists(p.project) ? { status: 'down', reason: 'cloudflared is not running (it exited or crashed)' } : null;
  }
  const t = p.tunnel?.status;
  if (t === 'down' || t === 'inactive') return { status: 'down', reason: `tunnel is ${t} (no connections)` };
  if (t === 'degraded') return { status: 'degraded', reason: `tunnel is degraded (${(p.tunnel.connections || []).length} connection(s))` };
  return { status: 'ok', reason: '' };
}

export function readObserved() {
  try { return JSON.parse(readFileSync(observedFile(), 'utf8')) || {}; } catch { return {}; }
}
function writeObserved(st) {
  mkdirSync(dirname(observedFile()), { recursive: true, mode: 0o700 });
  writeFileSync(observedFile(), JSON.stringify(st, null, 2) + '\n', { mode: 0o600 });
}

// projects: /api/tunnels rows. Returns the changes recorded ([{ project, from, to }]).
export function observe(projects, { now = Date.now(), record = recordEvent, pidFileExists } = {}) {
  if (watchActive(now)) return [];
  const prev = readObserved();
  const next = {};
  const changes = [];
  for (const p of projects || []) {
    const s = observedStatus(p, pidFileExists ? { pidFileExists } : undefined);
    if (!s) continue; // stopped on purpose: not tracked (a later start is an `up` event)
    // First sighting counts as coming from ok, like `burrow watch`, so an already broken project shows.
    const cur = prev[p.project] || { status: 'ok', since: now, pending: null, pendingAt: null };
    if (s.status === cur.status) { next[p.project] = { ...cur, pending: null, pendingAt: null }; continue; }
    if (cur.pending !== s.status) { next[p.project] = { ...cur, pending: s.status, pendingAt: now }; continue; }
    if (now - cur.pendingAt < CONFIRM_MS) { next[p.project] = cur; continue; }
    next[p.project] = { status: s.status, since: cur.pendingAt, pending: null, pendingAt: null };
    changes.push({ project: p.project, from: cur.status, to: s.status });
    record({
      action: 'health', project: p.project, source: 'dashboard', ok: s.status === 'ok',
      detail: `${s.status}${s.reason ? `: ${s.reason}` : ''} (was ${cur.status})`,
    });
  }
  // Only write when something changed, so a quiet dashboard doesn't touch the disk every refresh.
  if (JSON.stringify(next) !== JSON.stringify(prev)) writeObserved(next);
  return changes;
}

// The per-project health state the uptime timeline uses for "now": the watch state while
// `burrow watch` is active, else what the dashboard observed.
export function healthState(now = Date.now()) {
  if (watchActive(now)) {
    try { return JSON.parse(readFileSync(watchStateFile(), 'utf8')); } catch { return {}; }
  }
  return readObserved();
}
