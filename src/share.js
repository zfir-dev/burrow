import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, requireConfig, stateDir } from './config.js';
import { Cloudflare } from './cloudflare.js';
import { tunnelName, recordComment, tunnelTarget, assertLabel, assertDomain } from './naming.js';
import { startConnector, stopConnector, runningPid, saveMeta, readMeta, removeMeta, logFile } from './process.js';
import { loadProjectFile } from './project.js';
import { zoneIdFor, inZone } from './zones.js';
import { runHook, beforeDown, afterDown, stopBackground } from './hooks.js';

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

// The client for a share's zone: the one remembered in its state (--domain or the project's
// domain:), else BURROW_DOMAIN's.
async function shareClient(cfg, meta) {
  if (meta?.zoneId) return inZone(new Cloudflare({ token: cfg.token, accountId: cfg.accountId }), meta.zoneId);
  requireConfig(cfg, ['domain']);
  return client(cfg);
}

// Which tunnel.yml a share is for: -f <path>, or --project <name> (the file its last
// `burrow up` remembered). Gives its domain: and hooks to the share.
function shareProject(opts) {
  let file = null;
  if (opts.file) file = resolve(opts.file);
  else if (opts.project) {
    file = readMeta(opts.project)?.file || null;
    if (!file) throw new Error(`No tunnel.yml known for "${opts.project}". Run burrow up for it once, or pass -f.`);
  }
  if (!file) return null;
  if (!existsSync(file)) throw new Error(`${file} not found.`);
  return { file, proj: loadProjectFile(file) };
}

// Hook context for a share: its own project name (so a background pre_up gets its own pid
// file), the project's tunnel.yml for the commands and their directory.
const shareHookContext = (project, file, hostname, of) => ({
  project, file, hostnames: [hostname], url: `https://${hostname}`, extra: { BURROW_SHARE: '1', BURROW_SHARE_OF: of },
});

// Stop the connector and delete the share's DNS records, tunnel and state.
export async function removeShare(project, cf) {
  const meta = readMeta(project);
  if (!cf) {
    const cfg = loadConfig();
    requireConfig(cfg, ['token', 'accountId']);
    cf = await shareClient(cfg, meta);
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
  requireConfig(cfg, ['token', 'accountId']);
  const cf = await shareClient(cfg, meta);
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
  const url = targetUrl(target);
  const of = shareProject(opts);
  // --domain, else the project's domain:, else BURROW_DOMAIN.
  const domain = opts.domain || of?.proj.domain || cfg.domain;
  if (opts.domain) assertDomain(opts.domain);
  requireConfig(cfg, (dry ? [] : ['token', 'accountId']).concat(domain ? [] : ['domain']));
  const label = opts.name || randomLabel();
  assertLabel(label, 'share name');
  const project = SHARE_PREFIX + label;
  const hostname = `${label}.${domain}`;
  const ingress = [{ hostname, service: url }, { service: 'http_status:404' }];
  const hooks = { enabled: opts.hooks !== false };
  const hookCtx = of && shareHookContext(project, of.file, hostname, of.proj.project);

  if (dry) {
    if (domain !== cfg.domain) log(`[dry-run] would use domain ${domain}${opts.domain ? '' : ` from ${of.file}`} (checking its zone is on the account)`);
    if (hookCtx) await runHook('pre_up', hookCtx, { dry: true, ...hooks });
    log(`[dry-run] would create tunnel ${tunnelName(project)} with ingress ${JSON.stringify(ingress)}`);
    log(`[dry-run] would create DNS CNAME ${hostname} (comment "${recordComment(project)}")`);
    log(`[dry-run] would start cloudflared and share ${url} at https://${hostname}`);
    if (hookCtx) await runHook('post_up', hookCtx, { dry: true, ...hooks });
    return;
  }
  if (readMeta(project)) throw new Error(`Share "${label}" already exists. Remove it with "burrow down ${project}".`);

  let cf;
  let zoneId = null;
  if (domain === cfg.domain) cf = await client(cfg);
  else {
    const base = new Cloudflare({ token: cfg.token, accountId: cfg.accountId });
    zoneId = await zoneIdFor(base, cfg, domain);
    cf = inZone(base, zoneId);
  }
  if ((await cf.recordsByName(hostname)).length) throw new Error(`${hostname} already has DNS records; pick another --name.`);
  if (hookCtx) await runHook('pre_up', hookCtx, hooks);
  let tunnel;
  try { tunnel = await cf.createTunnel(tunnelName(project), randomBytes(32).toString('base64')); } catch (e) {
    await stopBackground(project);
    throw e;
  }
  saveMeta(project, {
    project, share: true, hostname, target: url, tunnelId: tunnel.id, tunnelName: tunnelName(project),
    hostnames: [hostname], createdAt: new Date().toISOString(),
    // Not `file`: a share is never `burrow up`-able. projectFile gives down its hooks.
    ...(zoneId ? { domain, zoneId } : {}),
    ...(of ? { projectFile: of.file, shareOf: of.proj.project, hooks: hooks.enabled } : {}),
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
    await stopBackground(project);
    throw e;
  }
  log(`Sharing ${url} at https://${hostname} (cloudflared pid ${pid}, log ${logFile(project)})`);
  if (hookCtx) await runHook('post_up', { ...hookCtx, extra: { ...hookCtx.extra, BURROW_TUNNEL_ID: tunnel.id } }, { ...hooks, soft: true });
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
  if (of) {
    const ctx = await beforeDown(project, opts);
    await stopConnector(project);
    await afterDown(project, ctx, opts);
  }
  await removeShare(project, cf);
  log(`Removed https://${hostname}`);
}
