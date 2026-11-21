import { randomBytes } from 'node:crypto';
import { loadConfig, requireConfig } from './config.js';
import { Cloudflare } from './cloudflare.js';
import { tunnelName, recordComment, tunnelTarget, assertLabel } from './naming.js';
import { startConnector, stopConnector, runningPid, saveMeta, readMeta, removeMeta, logFile } from './process.js';

// A share is a throwaway project: tunnel burrow-share-<label>, hostname
// <label>.<domain>, DNS comment burrow:share-<label>, state share-<label>.*
export const SHARE_PREFIX = 'share-';
const log = (...a) => console.log(...a);

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

  if (dry) {
    log(`[dry-run] would create tunnel ${tunnelName(project)} with ingress ${JSON.stringify(ingress)}`);
    log(`[dry-run] would create DNS CNAME ${hostname} (comment "${recordComment(project)}")`);
    log(`[dry-run] would start cloudflared and share ${url} at https://${hostname}`);
    return;
  }
  if (readMeta(project)) throw new Error(`Share "${label}" already exists. Remove it with "burrow down ${project}".`);

  const cf = await client(cfg);
  if ((await cf.recordsByName(hostname)).length) throw new Error(`${hostname} already has DNS records; pick another --name.`);
  const tunnel = await cf.createTunnel(tunnelName(project), randomBytes(32).toString('base64'));
  saveMeta(project, {
    project, share: true, hostname, target: url, tunnelId: tunnel.id, tunnelName: tunnelName(project),
    hostnames: [hostname], createdAt: new Date().toISOString(),
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
  if (opts.detach) {
    log(`Running in the background. Remove it with "burrow down ${project}" (or "burrow down").`);
    return;
  }
  // Register the signal handlers before telling the user to press Ctrl+C.
  const stopped = new Promise((resolve) => {
    const done = () => { clearInterval(watch); process.off('SIGINT', done); process.off('SIGTERM', done); resolve(); };
    const watch = setInterval(() => { if (!runningPid(project)) { log('cloudflared exited.'); done(); } }, 2000);
    process.on('SIGINT', done);
    process.on('SIGTERM', done);
  });
  log('Press Ctrl+C to stop sharing and remove the hostname.');
  await stopped;
  log('Removing share…');
  await removeShare(project, cf);
  log(`Removed https://${hostname}`);
}
