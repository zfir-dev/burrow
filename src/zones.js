import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from './config.js';
import { Cloudflare } from './cloudflare.js';
import { readMeta } from './process.js';

// Per-project domains: `domain:` in tunnel.yml overrides BURROW_DOMAIN. Each domain is a
// Cloudflare zone; its ID is looked up once, checked to be on CF_ACCOUNT_ID, and cached.
export const zoneCacheFile = () => join(stateDir(), 'cache', 'zones.json');
const TTL = 7 * 24 * 3600 * 1000;

export const projectDomain = (proj, cfg) => proj?.domain || cfg.domain;
export const inZone = (cf, zoneId) => new Cloudflare({ token: cf.token, accountId: cf.accountId, zoneId });

export function readZoneCache() {
  try { return JSON.parse(readFileSync(zoneCacheFile(), 'utf8')); } catch { return {}; }
}
function writeZoneCache(cache) {
  mkdirSync(dirname(zoneCacheFile()), { recursive: true, mode: 0o700 });
  writeFileSync(zoneCacheFile(), JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
}

// CF_ZONE_ID only ever applies to BURROW_DOMAIN.
export async function zoneIdFor(cf, cfg, domain, { refresh = false } = {}) {
  if (!domain) throw new Error('No domain: set BURROW_DOMAIN or "domain:" in tunnel.yml.');
  if (domain === cfg.domain && cfg.zoneId) return cfg.zoneId;
  const cache = readZoneCache();
  const hit = cache[domain];
  if (!refresh && hit?.id && hit.accountId === cfg.accountId && Date.now() - hit.checkedAt < TTL) return hit.id;
  const zones = await cf.all('/zones', { name: domain, 'account.id': cfg.accountId });
  const zone = zones.find((z) => z.name === domain && (!z.account?.id || z.account.id === cfg.accountId));
  if (!zone) {
    throw new Error(
      `Zone ${domain} is not on Cloudflare account ${cfg.accountId}, or the token can't see it. ` +
        'Add the domain to that account and give the token Zone > DNS > Edit and Zone > Zone > Read for it.'
    );
  }
  if (zone.status && zone.status !== 'active') console.error(`burrow: warning: zone ${domain} is ${zone.status}, not active yet.`);
  cache[domain] = { id: zone.id, accountId: cfg.accountId, checkedAt: Date.now() };
  writeZoneCache(cache);
  return zone.id;
}

function metas() {
  let names = [];
  try { names = readdirSync(stateDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch {}
  return names.map((n) => readMeta(n)).filter(Boolean);
}

// Every zone burrow may have records in: BURROW_DOMAIN's, the cached ones, and the zones
// remembered for projects. [{ id, domain }], unique by id.
export async function knownZones(cf, cfg, { onError } = {}) {
  const out = new Map();
  if (cfg.domain) {
    // With onError, a failing lookup of BURROW_DOMAIN's zone is reported (id null) instead of
    // stopping the other zones from being read.
    try { out.set(await zoneIdFor(cf, cfg, cfg.domain), cfg.domain); } catch (e) {
      if (!onError) throw e;
      onError({ id: null, domain: cfg.domain }, e);
    }
  }
  for (const [domain, z] of Object.entries(readZoneCache())) {
    if (z.id && z.accountId === cfg.accountId && !out.has(z.id)) out.set(z.id, domain);
  }
  for (const m of metas()) if (m.zoneId && !out.has(m.zoneId)) out.set(m.zoneId, m.domain || m.zoneId);
  return [...out].map(([id, domain]) => ({ id, domain }));
}

// DNS records matching { comment } or { prefix } in every known zone, each with zoneId.
// Without onError, one unreadable zone throws; with onError(zone, err), it's skipped.
export async function recordsEverywhere(cf, cfg, { comment, prefix, onError }) {
  const out = [];
  for (const z of await knownZones(cf, cfg, { onError })) {
    const zc = inZone(cf, z.id);
    let recs;
    try {
      recs = comment ? await zc.recordsByComment(comment) : await zc.recordsByCommentPrefix(prefix);
    } catch (e) {
      if (!onError) throw e;
      onError(z, e);
      continue;
    }
    for (const r of recs) out.push({ ...r, zoneId: z.id, zoneName: z.domain });
  }
  return out;
}

// Zone read errors as [{ zone, zoneId, error }] (the shape `ls --json`, `status --json` and the
// dashboard report), and which of them hides a project's DNS records: the zone remembered
// for it by `burrow up` (zoneId / domain), else BURROW_DOMAIN's zone.
export const zoneErrorCollector = () => {
  const list = [];
  return { list, onError: (z, e) => list.push({ zone: z.domain, zoneId: z.id, error: e.message }) };
};
export function zoneErrorFor(project, zoneErrors, cfg) {
  if (!zoneErrors?.length) return null;
  const meta = readMeta(project);
  const hit = meta?.zoneId
    ? zoneErrors.find((z) => z.zoneId === meta.zoneId || (meta.domain && z.zone === meta.domain))
    : zoneErrors.find((z) => z.zone === (meta?.domain || cfg.domain));
  return hit ? { zone: hit.zone, error: hit.error } : null;
}
