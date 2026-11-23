import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from './config.js';
import { inZone } from './zones.js';
import { readMeta, runningPid } from './process.js';

// DNS deletions that couldn't happen yet. When `burrow destroy` (or a dashboard delete)
// can't read one of the zones a project may have records in, the tunnel still goes, and
// { zoneId, domain, comment, project, at, error } is queued here so the records aren't
// silently left behind. `burrow prune` and the dashboard's Cleanup panel retry them.
export const pendingFile = () => join(stateDir(), 'cleanup', 'pending.json');

export function listPending() {
  try {
    const list = JSON.parse(readFileSync(pendingFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function savePending(list) {
  const file = pendingFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

const same = (a, b) => a.zoneId === b.zoneId && a.comment === b.comment;

export function addPending({ zoneId, domain, comment, project, error }, now = Date.now()) {
  const list = listPending().filter((e) => !same(e, { zoneId, comment }));
  list.push({ zoneId, domain: domain || zoneId, comment, project, at: new Date(now).toISOString(), error: String(error || '') });
  savePending(list);
}

// A project that is back (state file or running connector) owns its records again.
const isBack = (project) => !!(readMeta(project) || runningPid(project));

// Retry every queued deletion. Returns { done: [...], dropped: [...], left: [...] } with
// human-readable `lines`. Entries stay queued (with the new error) when the zone still can't
// be read.
export async function retryPending(cf, { log = () => {} } = {}) {
  const done = [];
  const dropped = [];
  const left = [];
  const lines = [];
  for (const e of listPending()) {
    if (isBack(e.project)) {
      dropped.push(e);
      lines.push(`${e.project}: is set up again; kept its DNS records in ${e.domain}`);
      continue;
    }
    try {
      const zc = inZone(cf, e.zoneId);
      const recs = await zc.recordsByComment(e.comment);
      for (const r of recs) {
        await zc.deleteRecord(r.id);
        lines.push(`${e.project}: deleted DNS ${r.type} ${r.name}`);
      }
      if (!recs.length) lines.push(`${e.project}: no DNS records left in ${e.domain}`);
      done.push(e);
    } catch (err) {
      left.push({ ...e, error: err.message, retriedAt: new Date().toISOString() });
      lines.push(`${e.project}: still can't clean up DNS in ${e.domain}: ${err.message}`);
    }
  }
  // Keep anything queued meanwhile by another process.
  const handled = [...done, ...dropped, ...left];
  savePending([...left, ...listPending().filter((e) => !handled.some((h) => same(h, e)))]);
  for (const l of lines) log(l);
  return { done, dropped, left, lines };
}
