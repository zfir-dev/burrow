import { readdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { loadConfig, requireConfig, stateDir } from './config.js';
import { Cloudflare } from './cloudflare.js';
import { tunnelTarget } from './naming.js';
import { recordsEverywhere, inZone } from './zones.js';
import { listPending, retryPending } from './pending.js';

const TUNNEL_PREFIX = 'burrow-';
const COMMENT_PREFIX = 'burrow:';
const log = (...a) => console.log(...a);

// Names of projects this machine knows about (state files).
export function localProjectNames(dir = stateDir()) {
  try {
    return new Set(readdirSync(dir).filter((f) => /\.(json|pid)$/.test(f)).map((f) => f.replace(/\.(json|pid)$/, '')));
  } catch {
    return new Set();
  }
}

// Pure planning step, easy to test.
//  - orphan tunnel: burrow-<p> with no local state for <p> and no live connections
//  - orphan record: burrow:<p> record whose tunnel is missing, points elsewhere,
//    or belongs to an orphan tunnel
export function findOrphans({ tunnels, records, local, includeActive = false }) {
  const byProject = new Map();
  for (const t of tunnels) if (t.name.startsWith(TUNNEL_PREFIX)) byProject.set(t.name.slice(TUNNEL_PREFIX.length), t);
  const orphanTunnels = [];
  const skipped = [];
  for (const [project, t] of byProject) {
    if (local.has(project)) continue;
    if ((t.connections || []).length && !includeActive) skipped.push(t);
    else orphanTunnels.push(t);
  }
  const doomed = new Set(orphanTunnels.map((t) => t.id));
  const orphanRecords = records.filter((r) => {
    if (!String(r.comment || '').startsWith(COMMENT_PREFIX)) return false;
    const t = byProject.get(r.comment.slice(COMMENT_PREFIX.length));
    return !t || doomed.has(t.id) || r.content !== tunnelTarget(t.id);
  });
  return { orphanTunnels, orphanRecords, skipped };
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
}

export async function prune(opts = {}) {
  const cfg = loadConfig();
  requireConfig(cfg, ['token', 'accountId', 'domain']);
  const cf = new Cloudflare({ token: cfg.token, accountId: cfg.accountId, zoneId: cfg.zoneId });
  // DNS deletions queued by an earlier destroy that couldn't read a zone. They were already
  // asked for, so they're retried without another confirmation.
  const pending = listPending();
  if (pending.length && opts.dryRun) {
    log(`[dry-run] would retry ${pending.length} queued DNS cleanup(s):`);
    for (const e of pending) log(`  ${e.project}: records tagged "${e.comment}" in ${e.domain} (queued ${e.at}: ${e.error})`);
  } else if (pending.length) {
    log(`Retrying ${pending.length} queued DNS cleanup(s):`);
    const r = await retryPending(cf, { log: (l) => log(`  ${l}`) });
    if (r.left.length) process.exitCode = 1;
  }
  const tunnels = (await cf.listTunnels()).filter((t) => t.name.startsWith(TUNNEL_PREFIX));
  const records = await recordsEverywhere(cf, cfg, {
    prefix: COMMENT_PREFIX,
    onError: (z, e) => console.error(`burrow: warning: couldn't read DNS in ${z.domain} (${e.message}); skipped it.`),
  });
  const { orphanTunnels, orphanRecords, skipped } = findOrphans({
    tunnels, records, local: localProjectNames(), includeActive: !!opts.includeActive,
  });
  const access = await import('./access.js');
  const orphanApps = await access.orphanAccessApps(cf, localProjectNames());

  for (const t of skipped) {
    log(`Skipping ${t.name}: no local state, but it has ${t.connections.length} live connection(s) (another machine?). Use --include-active to prune it.`);
  }
  if (!orphanTunnels.length && !orphanRecords.length && !orphanApps.length) { log('Nothing to prune.'); return; }
  log('Orphans:');
  for (const t of orphanTunnels) log(`  tunnel ${t.name} (${t.id})`);
  for (const r of orphanRecords) log(`  DNS ${r.type} ${r.name} -> ${r.content} (${r.comment})`);
  for (const a of orphanApps) log(`  Access app ${a.name} (${a.domain})`);
  const apps = orphanApps.length ? ` and ${orphanApps.length} Access app(s)` : '';
  if (opts.dryRun) { log(`[dry-run] would delete ${orphanTunnels.length} tunnel(s) and ${orphanRecords.length} DNS record(s)${apps}`); return; }
  if (!opts.yes && !(await confirm(`Delete ${orphanTunnels.length} tunnel(s) and ${orphanRecords.length} DNS record(s)${apps}?`))) {
    log('Aborted. (Non-interactive shells need --yes.)');
    process.exitCode = 1;
    return;
  }
  for (const r of orphanRecords) { await inZone(cf, r.zoneId).deleteRecord(r.id); log(`Deleted DNS ${r.name}`); }
  for (const t of orphanTunnels) {
    await cf.deleteTunnelConnections(t.id);
    await cf.deleteTunnel(t.id);
    log(`Deleted tunnel ${t.name}`);
  }
  for (const a of orphanApps) { await access.deleteAccessApp(cf, a); log(`Deleted Access app ${a.name}`); }
}
