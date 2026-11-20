import { readdirSync, statSync, existsSync } from 'node:fs';
import { stateDir } from '../config.js';
import { Cloudflare } from '../cloudflare.js';
import { recordComment, tunnelName } from '../naming.js';
import { localProjects, runningPid, pidFile, readMeta } from '../process.js';
import { DASHBOARD_PROJECT } from '../project.js';

function metaProjects() {
  try {
    return readdirSync(stateDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

let cache = { at: 0, data: null, error: null };
export function invalidateCloudflare() {
  cache = { at: 0, data: null, error: null };
}

async function cloudflareState(cfg) {
  if (!(cfg.token && cfg.accountId && cfg.domain)) return { data: null, error: 'Cloudflare not configured' };
  if (Date.now() - cache.at < 10000) return cache;
  try {
    const cf = new Cloudflare({ token: cfg.token, accountId: cfg.accountId, zoneId: cfg.zoneId });
    await cf.resolveZoneId(cfg.domain);
    const [tunnels, records] = await Promise.all([cf.listTunnels(), cf.recordsByCommentPrefix('burrow:')]);
    cache = { at: Date.now(), data: { tunnels: tunnels.filter((t) => t.name.startsWith('burrow-')), records }, error: null };
  } catch (e) {
    cache = { at: Date.now(), data: null, error: e.message };
  }
  return cache;
}

export async function collect(cfg) {
  const cf = await cloudflareState(cfg);
  const names = new Set([...localProjects(), ...metaProjects()]);
  for (const t of cf.data?.tunnels || []) names.add(t.name.slice('burrow-'.length));
  for (const r of cf.data?.records || []) names.add(String(r.comment).slice('burrow:'.length));
  const projects = [...names].sort().map((project) => {
    const meta = readMeta(project);
    const pid = runningPid(project);
    let startedAt = null;
    if (pid) { try { startedAt = statSync(pidFile(project)).mtimeMs; } catch {} }
    const tunnel = cf.data?.tunnels.find((t) => t.name === tunnelName(project)) || null;
    const recs = (cf.data?.records || []).filter((r) => r.comment === recordComment(project)).map((r) => r.name);
    return {
      project,
      builtIn: project === DASHBOARD_PROJECT,
      hostnames: recs.length ? recs.sort() : meta?.hostnames || [],
      running: !!pid,
      pid,
      startedAt,
      canUp: project === DASHBOARD_PROJECT || !!(meta?.file && existsSync(meta.file)),
      tunnel: tunnel && {
        id: tunnel.id,
        status: tunnel.status || 'unknown',
        connections: (tunnel.connections || []).map((c) => ({
          colo: c.colo_name, openedAt: c.opened_at, version: c.client_version,
        })),
      },
    };
  });
  return { projects, cloudflare: { configured: !!cf.data || cf.error !== 'Cloudflare not configured', error: cf.error }, now: Date.now() };
}
