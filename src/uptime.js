// Uptime timeline: turn the event history (up/down/restart/destroy from the CLI and the
// dashboard, health transitions from `burrow watch`) into per-project segments.
// Statuses: up | degraded | down (not on purpose) | stopped (on purpose) | unknown.
import { readFileSync } from 'node:fs';
import { readEvents } from './history.js';
import { watchStateFile } from './watch.js';

export const WINDOWS = { '1h': 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };

// The status an event leaves a project in, or null when it says nothing about it.
export function statusAfter(e) {
  const a = String(e.action || '');
  if (a === 'health') {
    const m = String(e.detail || '').match(/^(ok|degraded|down)\b/);
    return m ? (m[1] === 'ok' ? 'up' : m[1]) : null;
  }
  if (a === 'up' || a === 'restart' || a === 'autostart' || a === 'dashboard up') return e.ok ? 'up' : 'down';
  if (a === 'down' || a === 'destroy' || a === 'rename' || a === 'dashboard down') return e.ok ? 'stopped' : null;
  return null;
}

export function readWatchState() {
  try { return JSON.parse(readFileSync(watchStateFile(), 'utf8')); } catch { return {}; }
}

// events: oldest first, for one project. current: status now (from the watch state or the
// process), or null to keep the last event's status. Returns segments clipped to the window.
export function buildTimeline(events, { now = Date.now(), windowMs = WINDOWS['24h'], current = null, currentSince = null } = {}) {
  const start = now - windowMs;
  const points = [];
  let status = 'unknown';
  for (const e of events) {
    const s = statusAfter(e);
    if (!s) continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || at > now) continue;
    if (at <= start) { status = s; continue; }
    points.push({ at, status: s, event: e });
  }
  const segments = [];
  let from = start;
  const push = (to, st) => {
    if (to <= from) return;
    const last = segments[segments.length - 1];
    if (last && last.status === st) last.to = to;
    else segments.push({ from, to, status: st });
    from = to;
  };
  for (const p of points) { push(p.at, status); status = p.status; }
  // What the project is doing now wins over the last event (a crash isn't an event), from
  // `currentSince` (the watch state) when known. A stopped project that isn't running is just stopped.
  if (current && current !== status && !(status === 'stopped' && current === 'down')) {
    if (Number.isFinite(currentSince) && currentSince > from && currentSince < now) push(currentSince, status);
    status = current;
  }
  push(now, status);
  const known = segments.filter((s) => s.status !== 'unknown' && s.status !== 'stopped');
  const total = known.reduce((n, s) => n + (s.to - s.from), 0);
  const upMs = known.filter((s) => s.status === 'up').reduce((n, s) => n + (s.to - s.from), 0);
  const incidents = points.filter((p) => p.status === 'down' || p.status === 'degraded')
    .map((p) => ({ at: new Date(p.at).toISOString(), status: p.status, detail: p.event.detail || p.event.action, source: p.event.source }))
    .reverse();
  return {
    segments: segments.map((s) => ({ ...s, pct: ((s.to - s.from) / windowMs) * 100 })),
    uptimePct: total ? Math.round((upMs / total) * 10000) / 100 : null,
    incidents,
  };
}

// { project: timeline } for [{ project, running, startedAt, crashed }] (crashed: a pid file but no process).
export function timelines(projects, { now = Date.now(), windowMs = WINDOWS['24h'] } = {}) {
  const all = readEvents({ limit: 5000 }).reverse();
  const watch = readWatchState();
  const out = {};
  for (const p of projects) {
    const evs = all.filter((e) => e.project === p.project);
    const w = watch[p.project];
    let current = null;
    let currentSince = null;
    if (p.running === false) {
      current = p.crashed ? 'down' : 'stopped';
      if (p.crashed && w?.status === 'down') currentSince = w.since;
    }
    else if (w?.status) { current = w.status === 'ok' ? 'up' : w.status; currentSince = w.since; }
    else if (p.running) { current = 'up'; currentSince = p.startedAt; }
    out[p.project] = buildTimeline(evs, { now, windowMs, current, currentSince });
  }
  return out;
}
