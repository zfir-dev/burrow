import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readMeta, saveMeta, isAlive } from './process.js';
import { recordEvent } from './history.js';

// Expiry for detached shares that doesn't need the dashboard. Each detached share with an
// expiresAt gets a tiny watcher process (`burrow _share-expire share-<label>`, detached, no
// terminal). It sleeps until the expiry, re-reading the share's state file at least every
// 15 s so an extend, a "never" or a removal is picked up, then removes the share like
// `burrow down share-<label>` and records "share expired" in the history. A foreground
// `burrow share` enforces its own expiry instead, and the dashboard's sweeper stays as a
// second line. After a reboot, `burrow restart` (or autostart) starts the watcher again.
const BIN = fileURLToPath(new URL('../bin/burrow.js', import.meta.url));
export const WATCHER_COMMAND = '_share-expire';

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const ownerRunning = (meta) => !!meta.ownerPid && meta.ownerPid !== process.pid && pidAlive(meta.ownerPid);
export const watcherAlive = (meta) => !!meta?.expiryPid && isAlive(meta.expiryPid, WATCHER_COMMAND);

// Start the watcher for a detached share with an expiry, unless one is already running.
// Returns its pid, or null when none is needed.
export function ensureExpiryWatcher(project, { env = process.env } = {}) {
  const meta = readMeta(project);
  if (!meta?.share || !meta.expiresAt || ownerRunning(meta)) return null;
  if (watcherAlive(meta)) return meta.expiryPid;
  const child = spawn(process.execPath, [BIN, WATCHER_COMMAND, project], { detached: true, stdio: 'ignore', env });
  child.unref();
  const now = readMeta(project);
  if (now) saveMeta(project, { ...now, expiryPid: child.pid });
  return child.pid;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The watcher's loop. `remove(project)` deletes the share (bin uses `burrow down`).
export async function watchExpiry(project, { remove, poll = Number(process.env.BURROW_SHARE_EXPIRY_POLL_MS) || 15000 } = {}) {
  for (;;) {
    const meta = readMeta(project);
    if (!meta?.share) return 'gone';
    if (meta.expiryPid && meta.expiryPid !== process.pid) return 'superseded';
    const done = (why) => { const { expiryPid, ...rest } = meta; saveMeta(project, rest); return why; };
    if (!meta.expiresAt) return done('no expiry');
    if (ownerRunning(meta)) return done('foreground');
    const left = Date.parse(meta.expiresAt) - Date.now();
    if (!(left > 0)) {
      let ok = true;
      try { await remove(project); } catch { ok = false; }
      recordEvent({ action: 'share expired', project, source: 'cli', ok, detail: `${meta.hostname || project} (expiry watcher)` });
      return ok ? 'expired' : 'failed';
    }
    await sleep(Math.min(poll, left));
  }
}
