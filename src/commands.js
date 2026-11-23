import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { projectDomain, zoneIdFor, recordsEverywhere, inZone, zoneErrorCollector, zoneErrorFor } from './zones.js';
import { loadConfig, requireConfig, writeTemplate, configPath } from './config.js';
import { Cloudflare } from './cloudflare.js';
import { syncAccess, removeAccessApps, privateHosts } from './access.js';
import { tunnelName, recordComment, tunnelTarget, assertLabel } from './naming.js';
import {
  findProjectFile, loadProjectFile, buildIngress, hostnames, DASHBOARD_PROJECT, dashboardProject,
} from './project.js';
import {
  runningPid, startConnector, stopConnector, logFile, pidFile, saveMeta, readMeta, removeMeta, localProjects,
} from './process.js';
import { runHook, hookContext, beforeDown, afterDown, stopBackground } from './hooks.js';
import { isShare, removeShare } from './share.js';
import { addPending } from './pending.js';

const log = (...a) => console.log(...a);
const step = (dry, msg) => log(`${dry ? '[dry-run] ' : ''}${msg}`);

// Resolve the project file: -f, ./tunnel.yml, or the path remembered from a
// previous `burrow up <project>`.
function resolveProject(projectArg, opts) {
  if (projectArg === DASHBOARD_PROJECT && !opts.file) {
    return { proj: dashboardProject(loadConfig().dashboardPort), file: '(built-in dashboard)' };
  }
  let file = findProjectFile(opts.file);
  if (!file && projectArg) {
    const meta = readMeta(projectArg);
    if (meta?.file && existsSync(meta.file)) file = meta.file;
  }
  if (!file) {
    throw new Error(
      `No tunnel.yml found${opts.file ? ` at ${opts.file}` : ' in the current directory'}` +
        (projectArg ? ` and no remembered file for "${projectArg}"` : '') + '. Use -f <path>.'
    );
  }
  const proj = loadProjectFile(file);
  if (projectArg && projectArg !== proj.project) {
    throw new Error(`${file} is for project "${proj.project}", not "${projectArg}".`);
  }
  return { proj, file };
}

// For commands that only need a name (down/status/logs).
function resolveName(projectArg, opts) {
  if (projectArg) { assertLabel(projectArg, 'project name'); return projectArg; }
  const file = findProjectFile(opts.file);
  if (!file) throw new Error('Pass a project name or run inside a directory with tunnel.yml.');
  return loadProjectFile(file).project;
}

function client(cfg) {
  return new Cloudflare({ token: cfg.token, accountId: cfg.accountId, zoneId: cfg.zoneId });
}

export async function init(opts) {
  const path = configPath();
  if (!existsSync(path)) {
    writeTemplate(path);
    log(`Wrote config template to ${path} (mode 600). Fill it in, then run "burrow init" again to verify.`);
    return;
  }
  const cfg = loadConfig();
  log(`Config: ${path}`);
  requireConfig(cfg, ['token', 'accountId', 'domain']);
  const cf = client(cfg);
  const v = await cf.verifyToken();
  log(`Token: ${v?.status || 'unknown'}${v?.expires_on ? ` (expires ${v.expires_on})` : ''}`);
  const zoneId = await cf.resolveZoneId(cfg.domain);
  log(`Domain: ${cfg.domain} (zone ${zoneId})`);
  await cf.listTunnels();
  log('Tunnel API access: ok');
  await cf.recordsByCommentPrefix('burrow:');
  log('DNS API access: ok');
  if (opts.quiet) return;
}

export async function up(projectArg, opts) {
  const dry = !!opts.dryRun;
  const cfg = loadConfig();
  const { proj, file } = resolveProject(projectArg, opts);
  requireConfig(cfg, (dry ? [] : ['token', 'accountId']).concat(proj.domain ? [] : ['domain']));
  const name = tunnelName(proj.project);
  const comment = recordComment(proj.project);
  const domain = projectDomain(proj, cfg);
  const hosts = hostnames(proj, domain);
  const ingress = buildIngress(proj, domain);

  log(`Project ${proj.project} (${file})`);
  await runHook('pre_up', hookContext(proj, file, hosts), { dry, enabled: opts.hooks !== false });
  if (dry) {
    step(dry, `would create or reuse remotely-managed tunnel ${name}`);
    if (proj.domain) step(dry, `would use domain ${domain} from ${file} (checking its zone is on the account)`);
    step(dry, 'would PUT ingress config:');
    log(JSON.stringify({ config: { ingress } }, null, 2));
    for (const h of hosts) {
      step(dry, `would upsert DNS CNAME ${h.hostname} -> <tunnel-id>.cfargotunnel.com (proxied, comment "${comment}")`);
    }
    step(dry, `would delete other DNS records tagged "${comment}" not listed above`);
    await syncAccess(null, cfg, proj, hosts, { dry });
    const pid = runningPid(proj.project);
    step(dry, pid ? `cloudflared already running (pid ${pid}); would restart it` : `would start cloudflared, pid ${pidFile(proj.project)}, log ${logFile(proj.project)}`);
    return;
  }

  const cf = client(cfg);
  cf.zoneId = await zoneIdFor(cf, cfg, domain);

  privateHosts(proj, hosts, cfg); // fail before changing anything if an allow list is missing
  let tunnel = await cf.findTunnel(name);
  if (tunnel) log(`Tunnel ${name} exists (${tunnel.id})`);
  else {
    tunnel = await cf.createTunnel(name, randomBytes(32).toString('base64'));
    log(`Created tunnel ${name} (${tunnel.id})`);
  }

  await cf.putTunnelConfig(tunnel.id, ingress);
  log(`Ingress config set (${ingress.length} rules)`);

  const target = tunnelTarget(tunnel.id);
  const wanted = new Set(hosts.map((h) => h.hostname));
  for (const h of hosts) {
    const existing = await cf.recordsByName(h.hostname);
    const rec = { type: 'CNAME', name: h.hostname, content: target, proxied: true, ttl: 1, comment };
    const ours = existing.find((r) => r.comment === comment);
    const foreign = existing.filter((r) => r.comment !== comment);
    if (foreign.length && !opts.force) {
      throw new Error(
        `${h.hostname} already has a DNS record not managed by burrow (${foreign.map((r) => r.type).join(', ')}). ` +
          'Remove it or rerun with --force to replace it.'
      );
    }
    for (const r of foreign) { await cf.deleteRecord(r.id); log(`Removed foreign ${r.type} record ${r.name}`); }
    if (ours && ours.type === 'CNAME') {
      if (ours.content !== target || !ours.proxied) { await cf.updateRecord(ours.id, rec); log(`Updated DNS ${h.hostname}`); }
      else log(`DNS ${h.hostname} ok`);
    } else {
      if (ours) await cf.deleteRecord(ours.id);
      await cf.createRecord(rec);
      log(`Created DNS ${h.hostname}`);
    }
  }
  // The domain changed since the last up: clear this project's records in the old zone.
  const prev = readMeta(proj.project);
  const prevZone = prev ? prev.zoneId || (cfg.domain ? await zoneIdFor(cf, cfg, cfg.domain) : null) : null;
  if (prevZone && prevZone !== cf.zoneId) {
    const old = inZone(cf, prevZone);
    for (const r of await old.recordsByComment(comment)) { await old.deleteRecord(r.id); log(`Removed DNS ${r.name} (previous domain)`); }
  }
  for (const r of await cf.recordsByComment(comment)) {
    if (!wanted.has(r.name)) { await cf.deleteRecord(r.id); log(`Removed stale DNS ${r.name}`); }
  }
  await syncAccess(cf, cfg, proj, hosts);

  const old = await stopConnector(proj.project);
  if (old) log(`Stopped previous cloudflared (pid ${old})`);
  const token = await cf.getTunnelToken(tunnel.id);
  const pid = startConnector(proj.project, token, cfg.cloudflared);
  saveMeta(proj.project, { project: proj.project, file, tunnelId: tunnel.id, tunnelName: name, hostnames: [...wanted], domain, zoneId: cf.zoneId });
  log(`cloudflared started (pid ${pid}), log ${logFile(proj.project)}`);
  for (const h of hosts) log(`  ${h.service.padEnd(10)} https://${h.hostname}`);
  await runHook('post_up', hookContext(proj, file, hosts, { BURROW_TUNNEL_ID: tunnel.id }), { enabled: opts.hooks !== false, soft: true });
}

// Stop cloudflared only. Tunnel and DNS stay, so the next `burrow up` is fast.
// With no project (and no -f), stops every running burrow connector.
export async function down(projectArg, opts) {
  const dry = !!opts.dryRun;
  if (opts.purge) return destroy(projectArg, opts);
  const projects = projectArg || opts.file ? [resolveName(projectArg, opts)] : localProjects();
  if (!projects.length) { log('No burrow connectors found.'); return; }
  for (const project of projects) {
    const pid = runningPid(project);
    const temp = isShare(project);
    if (dry) {
      step(dry, pid ? `would stop ${project} cloudflared (pid ${pid})` : `${project}: not running`);
      if (temp) step(dry, `would delete share ${project} (tunnel and DNS)`);
      await beforeDown(project, opts);
      continue;
    }
    const hookCtx = await beforeDown(project, opts);
    const stopped = await stopConnector(project);
    log(stopped ? `${project}: stopped cloudflared (pid ${stopped})` : `${project}: not running`);
    await afterDown(project, hookCtx, opts);
    if (temp) {
      await removeShare(project);
      log(`${project}: share removed (tunnel and DNS deleted)`);
    }
  }
  if (!dry) log('Tunnels and DNS records are kept. Use "burrow destroy" to delete them.');
}

export function isYes(answer) {
  return /^y(es)?$/i.test(String(answer || '').trim());
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return isYes(await rl.question(`${question} [y/N] `)); } finally { rl.close(); }
}

async function destroyOne(cf, project, dry) {
  const name = tunnelName(project);
  const comment = recordComment(project);
  if (dry) {
    const pid = runningPid(project);
    step(dry, pid ? `would stop cloudflared (pid ${pid})` : `${project}: cloudflared not running locally`);
    step(dry, `would delete DNS records tagged "${comment}"`);
    step(dry, `would delete connections and tunnel ${name}`);
    return;
  }
  const stopped = await stopConnector(project);
  const bg = await stopBackground(project);
  if (bg) log(`${project}: stopped pre_up background process (pid ${bg})`);
  log(stopped ? `${project}: stopped cloudflared (pid ${stopped})` : `${project}: cloudflared was not running`);
  // A zone that can't be read now (token lost access, Cloudflare error) doesn't stop the
  // rest: the deletion is queued and retried by `burrow prune` or the dashboard's Cleanup.
  const unread = (z, e) => {
    addPending({ zoneId: z.id, domain: z.domain, comment, project, error: e.message });
    console.error(`burrow: warning: ${project}: couldn't read DNS in ${z.domain} (${e.message}); ` +
      `its records there are queued for deletion. Run "burrow prune" to retry.`);
  };
  for (const r of await recordsEverywhere(cf, loadConfig(), { comment, onError: unread })) {
    await inZone(cf, r.zoneId).deleteRecord(r.id);
    log(`${project}: deleted DNS ${r.type} ${r.name}`);
  }
  const tunnel = await cf.findTunnel(name);
  if (tunnel) {
    await cf.deleteTunnelConnections(tunnel.id);
    await cf.deleteTunnel(tunnel.id);
    log(`${project}: deleted tunnel ${name} (${tunnel.id})`);
  } else log(`${project}: tunnel ${name} not found`);
  await removeAccessApps(cf, project);
  removeMeta(project);
}

// Stop cloudflared AND delete the tunnel and its DNS records.
// No project needs --all, and asks for confirmation unless --yes.
export async function destroy(projectArg, opts) {
  const dry = !!opts.dryRun;
  const cfg = loadConfig();
  const single = projectArg || opts.file;
  if (!single && !opts.all) {
    throw new Error('Pass a project, -f <tunnel.yml>, or --all to destroy every burrow tunnel.');
  }
  if (single) {
    const project = resolveName(projectArg, opts);
    if (dry) return destroyOne(null, project, true);
    requireConfig(cfg, ['token', 'accountId']);
    return destroyOne(client(cfg), project, false);
  }

  // --all
  if (dry && !(cfg.token && cfg.accountId && cfg.domain)) {
    for (const p of localProjects()) step(dry, `would stop ${p} cloudflared (pid ${runningPid(p) || '-'})`);
    step(dry, 'would delete every burrow-* tunnel and every DNS record tagged burrow:*');
    return;
  }
  requireConfig(cfg, ['token', 'accountId']);
  const cf = client(cfg);
  const tunnels = (await cf.listTunnels()).filter((t) => t.name.startsWith('burrow-'));
  const unreadable = [];
  const records = await recordsEverywhere(cf, cfg, { prefix: 'burrow:', onError: (z) => unreadable.push(z.domain) });
  if (unreadable.length) console.error(`burrow: warning: couldn't read DNS in ${unreadable.join(', ')}; records there are queued per project.`);
  const projects = new Set([
    ...tunnels.map((t) => t.name.slice('burrow-'.length)),
    ...records.map((r) => r.comment.slice('burrow:'.length)),
    ...localProjects(),
  ]);
  if (!projects.size) { log('Nothing to destroy.'); return; }
  log(`This deletes ${tunnels.length} tunnel(s) and ${records.length} DNS record(s) for: ${[...projects].join(', ')}`);
  if (dry) { for (const p of projects) await destroyOne(cf, p, true); return; }
  if (!opts.yes && !(await confirm('Destroy all of them?'))) {
    log('Aborted. (Non-interactive shells need --yes.)');
    process.exitCode = 1;
    return;
  }
  for (const p of projects) await destroyOne(cf, p, false);
}

export async function ls(opts = {}) {
  const cfg = loadConfig();
  requireConfig(cfg, ['token', 'accountId']);
  const cf = client(cfg);
  const tunnels = (await cf.listTunnels()).filter((t) => t.name.startsWith('burrow-'));
  // A zone whose DNS can't be read doesn't stop the listing: its projects are shown with
  // their hostnames unknown, a warning goes to stderr and the exit code is 1.
  const zones = zoneErrorCollector();
  const records = await recordsEverywhere(cf, cfg, { prefix: 'burrow:', onError: zones.onError });
  warnZones(zones.list);
  const zoneError = (t) => zoneErrorFor(t.name.slice('burrow-'.length), zones.list, cfg);
  if (tunnels.some(zoneError)) process.exitCode = 1;
  if (opts.json) {
    log(JSON.stringify(tunnels.map((t) => tunnelJson(t, records, zoneError(t))), null, 2));
    return;
  }
  if (!tunnels.length) { log('No burrow tunnels.'); return; }
  for (const t of tunnels) {
    const project = t.name.slice('burrow-'.length);
    const pid = runningPid(project);
    const hosts = records.filter((r) => r.comment === recordComment(project)).map((r) => r.name);
    log(`${project}  tunnel=${t.status || 'unknown'}  local=${pid ? `running (pid ${pid})` : 'stopped'}`);
    for (const h of hosts) log(`  https://${h}`);
    const ze = zoneError(t);
    if (ze) log(`  hostnames unknown: zone ${ze.zone} unreadable`);
  }
}

function warnZones(list) {
  for (const z of list) console.error(`burrow: warning: couldn't read DNS in ${z.zone} (${z.error}); hostnames there are unknown.`);
}

// JSON shape shared by `ls --json` and `status --json`. No secrets, no origin IPs.
// zoneError ({ zone, error }) is set, and hostnames may be incomplete, when the zone holding
// the project's DNS couldn't be read.
function tunnelJson(t, records, zoneError = null) {
  const project = t.name.slice('burrow-'.length);
  const pid = runningPid(project);
  return {
    project,
    running: !!pid,
    pid: pid || null,
    hostnames: records.filter((r) => r.comment === recordComment(project)).map((r) => r.name).sort(),
    hostnamesKnown: !zoneError,
    zoneError,
    tunnel: {
      id: t.id,
      name: t.name,
      status: t.status || 'unknown',
      connections: (t.connections || []).map((c) => ({ colo: c.colo_name, openedAt: c.opened_at, version: c.client_version })),
    },
  };
}

export async function status(projectArg, opts = {}) {
  const project = resolveName(projectArg, opts);
  const cfg = loadConfig();
  const pid = runningPid(project);
  const configured = !!(cfg.token && cfg.accountId && cfg.domain);
  let t = null;
  let records = [];
  const zones = zoneErrorCollector();
  if (configured) {
    const cf = client(cfg);
    t = await cf.findTunnel(tunnelName(project));
    if (t) records = await recordsEverywhere(cf, cfg, { comment: recordComment(project), onError: zones.onError });
  }
  warnZones(zones.list);
  const zoneError = zoneErrorFor(project, zones.list, cfg);
  if (zoneError) process.exitCode = 1;
  if (opts.json) {
    log(JSON.stringify({
      project, running: !!pid, pid: pid || null, log: logFile(project), cloudflare: configured,
      tunnel: t && { id: t.id, name: t.name, status: t.status || 'unknown', connections: tunnelJson(t, []).tunnel.connections },
      records: records.map((r) => ({ type: r.type, name: r.name, content: r.content, proxied: !!r.proxied })),
      recordsKnown: !zoneError, zoneError, zoneErrors: zones.list.map(({ zone, error }) => ({ zone, error })),
    }, null, 2));
    return;
  }
  log(`Project: ${project}`);
  log(`Local cloudflared: ${pid ? `running (pid ${pid})` : 'stopped'}`);
  log(`Log: ${logFile(project)}`);
  if (!configured) { log('Cloudflare: not configured (run "burrow init")'); return; }
  if (!t) { log(`Tunnel ${tunnelName(project)}: not found`); return; }
  log(`Tunnel ${t.name}: ${t.status} (${t.id}), ${t.connections?.length || 0} connection(s)`);
  for (const r of records) log(`  ${r.type} https://${r.name} -> ${r.content}${r.proxied ? ' (proxied)' : ''}`);
  if (zoneError) log(`  DNS: unknown, zone ${zoneError.zone} unreadable (${zoneError.error})`);
}

export async function logs(projectArg, opts) {
  const project = resolveName(projectArg, opts);
  const file = logFile(project);
  if (!existsSync(file)) throw new Error(`No log at ${file}`);
  const n = String(parseInt(opts.lines, 10) || 100);
  if (opts.follow) {
    await new Promise((res) => spawn('tail', ['-n', n, '-f', file], { stdio: 'inherit' }).on('exit', res));
  } else {
    const lines = readFileSync(file, 'utf8').split('\n');
    process.stdout.write(lines.slice(-Number(n) - 1).join('\n'));
  }
}
