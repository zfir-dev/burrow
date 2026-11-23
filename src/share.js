import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { loadConfig, requireConfig, stateDir } from './config.js';
import { Cloudflare } from './cloudflare.js';
import { tunnelName, recordComment, tunnelTarget, assertLabel } from './naming.js';
import { startConnector, stopConnector, runningPid, saveMeta, readMeta, removeMeta, logFile } from './process.js';

// A share is a throwaway project: tunnel burrow-share-<label>, hostname
// <label>.<domain>, DNS comment burrow:share-<label>, state share-<label>.*
export const SHARE_PREFIX = 'share-';
const log = (...a) => console.log(...a);

// --expires: 30m, 2h, 1d, 7d (at least 1 minute, at most 30 days). Returns milliseconds.
const EXPIRY_UNITS = { m: 60e3, min: 60e3, h: 3600e3, d: 24 * 3600e3 };
export function parseExpires(value) {
  const m = String(value ?? '').trim().match(/^(\d+)\s*(m|min|h|d)$/i);
  const ms = m ? Number(m[1]) * EXPIRY_UNITS[m[2].toLowerCase()] : NaN;
  if (!(ms >= 60e3 && ms <= 30 * 24 * 3600e3)) throw new Error(`Invalid --expires "${value}". Use e.g. 30m, 2h, 1d (1 minute to 30 days).`);
  return ms;
}

// The dashboard (or anything else) asks a foreground `burrow share` to stop by setting
// stopRequestedAt in the share's state file; that process checks it every 2 seconds.
export function requestStop(project) {
  const meta = readMeta(project);
  if (!meta?.share) return false;
  saveMeta(project, { ...meta, stopRequestedAt: new Date().toISOString() });
  return true;
}

// Why a foreground share should stop now, or null.
export function stopReason(meta, now = Date.now()) {
  if (!meta) return 'its state was removed';
  if (meta.stopRequestedAt) return 'stop requested from the dashboard';
  if (meta.expiresAt && Date.parse(meta.expiresAt) <= now) return `it expired at ${meta.expiresAt}`;
  return null;
}

export function isShare(project) {
  return project.startsWith(SHARE_PREFIX) && readMeta(project)?.share === true;
}

export function randomLabel(length = 10) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const chars = letters + '0123456789';
  const bytes = randomBytes(length);
  let s = letters[bytes[0] % letters.length];
  for (let i = 1; i < length; i++) s += chars[bytes[i] % chars.length];
  return s;
}

export function targetUrl(target) {
  const t = String(target ?? '').trim();
  if (/^\d+$/.test(t)) {
    const port = Number(t);
    if (port < 1 || port > 65535) throw new Error(`Invalid port ${t}`);
    return `http://localhost:${port}`;
  }
  let u;
  try { u = new URL(t); } catch { throw new Error(`Expected a port or an http(s) URL, got "${t}"`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`Expected an http(s) URL, got "${t}"`);
  return t;
}

async function client(cfg) {
  const cf = new Cloudflare({ token: cfg.token, accountId: cfg.accountId, zoneId: cfg.zoneId });
  await cf.resolveZoneId(cfg.domain);
  return cf;
}

// Stop the connector and delete the share's DNS records, tunnel and state.
export async function removeShare(project, cf) {
  const meta = readMeta(project);
  if (!cf) {
    const cfg = loadConfig();
    requireConfig(cfg, ['token', 'accountId', 'domain']);
    cf = await client(cfg);
  }
  await stopConnector(project);
  for (const r of await cf.recordsByComment(recordComment(project))) await cf.deleteRecord(r.id);
  const id = meta?.tunnelId || (await cf.findTunnel(tunnelName(project)))?.id;
  if (id) {
    await cf.deleteTunnelConnections(id);
    await cf.deleteTunnel(id);
  }
  removeMeta(project);
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
// Is the foreground `burrow share` that owns this share still running?
export const ownerAlive = (meta) => !!meta?.ownerPid && meta.ownerPid !== process.pid && alive(meta.ownerPid);

// All shares this machine knows about (state files with share: true).
export function shareNames() {
  let names = [];
  try { names = readdirSync(stateDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch {}
  return names.filter((n) => isShare(n)).sort();
}

// `burrow restart` for a share: re-apply its ingress, make sure its CNAME is there and
// restart cloudflared on the same tunnel and hostname. A share whose `burrow share`
// process is still in the foreground is skipped (that process owns it), and a share whose
// tunnel is gone on Cloudflare is cleaned up locally instead of being recreated.
export async function restartShare(project, opts = {}) {
  const meta = readMeta(project);
  if (!meta?.share) throw new Error(`${project} is not a share.`);
  const label = project.slice(SHARE_PREFIX.length);
  if (meta.ownerPid && meta.ownerPid !== process.pid && alive(meta.ownerPid)) {
    log(`${project}: skipped; it belongs to a running "burrow share" (pid ${meta.ownerPid}). Stop that with Ctrl+C and share again to change it.`);
    return 'skipped';
  }
  const ingress = [{ hostname: meta.hostname, service: meta.target }, { service: 'http_status:404' }];
  if (opts.dryRun) {
    log(`[dry-run] ${project}: would re-apply ${meta.hostname} -> ${meta.target}, check its DNS record and restart cloudflared`);
    return 'planned';
  }
  const cfg = loadConfig();
  requireConfig(cfg, ['token', 'accountId', 'domain']);
  const cf = await client(cfg);
  const tunnel = await cf.findTunnel(tunnelName(project));
  if (!tunnel) {
    await stopConnector(project);
    removeMeta(project);
    log(`${project}: its tunnel is gone on Cloudflare; removed the local share. Share again with: burrow share ${meta.target} --name ${label}`);
    return 'removed';
  }
  await cf.putTunnelConfig(tunnel.id, ingress);
  const comment = recordComment(project);
  const target = tunnelTarget(tunnel.id);
  const records = await cf.recordsByComment(comment);
  if (!records.some((r) => r.name === meta.hostname && r.type === 'CNAME' && r.content === target)) {
    for (const r of records) await cf.deleteRecord(r.id);
    await cf.createRecord({ type: 'CNAME', name: meta.hostname, content: target, proxied: true, ttl: 1, comment });
    log(`${project}: recreated DNS ${meta.hostname}`);
  }
  await stopConnector(project);
  const pid = startConnector(project, await cf.getTunnelToken(tunnel.id), cfg.cloudflared);
  saveMeta(project, { ...meta, tunnelId: tunnel.id, ownerPid: null });
  log(`${project}: restarted cloudflared (pid ${pid}) for https://${meta.hostname} -> ${meta.target}`);
  return 'restarted';
}

export async function share(target, opts = {}) {
  const dry = !!opts.dryRun;
  const cfg = loadConfig();
  requireConfig(cfg, dry ? ['domain'] : ['token', 'accountId', 'domain']);
  const url = targetUrl(target);
  const label = opts.name || randomLabel();
  assertLabel(label, 'share name');
  const project = SHARE_PREFIX + label;
  const hostname = `${label}.${cfg.domain}`;
  const ingress = [{ hostname, service: url }, { service: 'http_status:404' }];
  const expiresMs = opts.expires === undefined ? null : parseExpires(opts.expires);
  const expiresAt = expiresMs ? new Date(Date.now() + expiresMs).toISOString() : null;

  if (dry) {
    log(`[dry-run] would create tunnel ${tunnelName(project)} with ingress ${JSON.stringify(ingress)}`);
    log(`[dry-run] would create DNS CNAME ${hostname} (comment "${recordComment(project)}")`);
    log(`[dry-run] would start cloudflared and share ${url} at https://${hostname}${expiresAt ? ` until ${expiresAt}` : ''}`);
    return;
  }
  if (readMeta(project)) throw new Error(`Share "${label}" already exists. Remove it with "burrow down ${project}".`);

  const cf = await client(cfg);
  if ((await cf.recordsByName(hostname)).length) throw new Error(`${hostname} already has DNS records; pick another --name.`);
  const tunnel = await cf.createTunnel(tunnelName(project), randomBytes(32).toString('base64'));
  saveMeta(project, {
    project, share: true, hostname, target: url, tunnelId: tunnel.id, tunnelName: tunnelName(project),
    hostnames: [hostname], createdAt: new Date().toISOString(), expiresAt,
    // A share in the foreground belongs to this process; restart leaves it alone.
    ownerPid: opts.detach ? null : process.pid,
  });
  let pid;
  try {
    await cf.putTunnelConfig(tunnel.id, ingress);
    await cf.createRecord({
      type: 'CNAME', name: hostname, content: tunnelTarget(tunnel.id), proxied: true, ttl: 1, comment: recordComment(project),
    });
    pid = startConnector(project, await cf.getTunnelToken(tunnel.id), cfg.cloudflared);
  } catch (e) {
    await removeShare(project, cf).catch(() => {});
    throw e;
  }
  log(`Sharing ${url} at https://${hostname} (cloudflared pid ${pid}, log ${logFile(project)})`);
  if (expiresAt) log(`Expires at ${expiresAt}${opts.detach ? ' (the dashboard stops it then, if it is running)' : ''}.`);
  if (opts.detach) {
    log(`Running in the background. Remove it with "burrow down ${project}" (or "burrow down").`);
    return;
  }
  // Register the signal handlers before telling the user to press Ctrl+C. The state file is
  // re-read every 2 s: the dashboard can extend the expiry or ask this process to stop.
  const stopped = new Promise((resolve) => {
    const done = () => { clearInterval(watch); process.off('SIGINT', done); process.off('SIGTERM', done); resolve(); };
    const watch = setInterval(() => {
      if (!runningPid(project)) { log('cloudflared exited.'); done(); return; }
      const why = stopReason(readMeta(project));
      if (why) { log(`Stopping: ${why}.`); done(); }
    }, Number(process.env.BURROW_SHARE_POLL_MS) || 2000);
    process.on('SIGINT', done);
    process.on('SIGTERM', done);
  });
  log('Press Ctrl+C to stop sharing and remove the hostname.');
  await stopped;
  log('Removing share…');
  await removeShare(project, cf);
  log(`Removed https://${hostname}`);
}
