import { loadConfig, requireConfig } from './config.js';
import { Cloudflare } from './cloudflare.js';
import { projectUrls } from './open.js';

// Cloudflare GraphQL Analytics. BURROW_CF_API_BASE (tests only) moves it to the mock API.
const endpoint = () => `${process.env.BURROW_CF_API_BASE || 'https://api.cloudflare.com/client/v4'}/graphql`;
const log = (...a) => console.log(...a);

export const QUERY = `query BurrowStats($zoneTag: string, $filter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(limit: 5000, filter: $filter) {
        count
        sum { edgeResponseBytes }
        dimensions { clientRequestHTTPHost edgeResponseStatus }
      }
    }
  }
}`;

const UNITS = { m: 60e3, min: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };
export function parseSince(value = '24h', now = Date.now()) {
  const v = String(value).trim();
  const m = v.match(/^(\d+)\s*(m|min|h|d|w)$/i);
  if (m && Number(m[1]) > 0) return new Date(now - Number(m[1]) * UNITS[m[2].toLowerCase()]);
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime()) && d.getTime() < now) return d;
  }
  throw new Error(`Invalid --since "${v}". Use 30m, 24h, 7d, 2w or an ISO date in the past.`);
}

// Cloudflare wants RFC 3339 without milliseconds.
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function aggregate(groups, hosts) {
  const rows = new Map(hosts.map((h) => [h, {
    hostname: h, requests: 0, bytes: 0, status: {}, classes: { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
  }]));
  for (const g of groups || []) {
    const row = rows.get(g.dimensions?.clientRequestHTTPHost);
    if (!row) continue;
    const n = Number(g.count) || 0;
    row.requests += n;
    row.bytes += Number(g.sum?.edgeResponseBytes) || 0;
    const code = String(g.dimensions?.edgeResponseStatus ?? '');
    if (code) row.status[code] = (row.status[code] || 0) + n;
    const cls = `${code[0]}xx`;
    if (cls in row.classes) row.classes[cls] += n;
  }
  return [...rows.values()];
}

export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return i === 0 ? `${v} B` : `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

const num = (n) => Number(n).toLocaleString('en-US');

async function graphql(token, variables) {
  let res;
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`GraphQL Analytics request failed: ${e.name === 'TimeoutError' ? 'timed out after 30s' : e.message}`);
  }
  let json = null;
  try { json = await res.json(); } catch {}
  const errors = json?.errors || [];
  if (!res.ok || !json || errors.length) {
    const msg = errors.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    const auth = res.status === 401 || res.status === 403 || /authori[sz]|permission|forbidden|access/i.test(msg);
    throw new Error(`GraphQL Analytics query failed: ${msg}${auth ? '. The API token needs Zone > Analytics > Read for this zone.' : ''}`);
  }
  return json.data;
}

export async function stats(projectArg, opts = {}) {
  const cfg = loadConfig();
  requireConfig(cfg, ['token', 'domain']);
  const { project, urls } = projectUrls(projectArg, opts, cfg);
  const hosts = [...new Set(urls.map((u) => new URL(u.url).hostname))];
  const until = new Date();
  const since = parseSince(opts.since, until.getTime());
  const cf = new Cloudflare({ token: cfg.token, accountId: cfg.accountId, zoneId: cfg.zoneId });
  const zoneTag = await cf.resolveZoneId(cfg.domain);
  const data = await graphql(cfg.token, {
    zoneTag,
    filter: { datetime_geq: iso(since), datetime_lt: iso(until), clientRequestHTTPHost_in: hosts },
  });
  const rows = aggregate(data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups, hosts);
  const total = aggregate(rows.flatMap((r) => Object.entries(r.status).map(([code, count]) => ({
    count, dimensions: { clientRequestHTTPHost: 'total', edgeResponseStatus: code },
  }))), ['total'])[0];
  total.bytes = rows.reduce((a, r) => a + r.bytes, 0);

  if (opts.json) {
    log(JSON.stringify({
      project, since: iso(since), until: iso(until), zone: zoneTag, sampled: true,
      hostnames: rows, total: { requests: total.requests, bytes: total.bytes, status: total.status, classes: total.classes },
    }, null, 2));
    return;
  }
  log(`${project}: ${iso(since)} -> ${iso(until)} (Cloudflare analytics, sampled)`);
  const width = Math.max(8, ...rows.map((r) => r.hostname.length));
  const line = (name, r) => [
    name.padEnd(width), num(r.requests).padStart(10), formatBytes(r.bytes).padStart(10),
    ...['2xx', '3xx', '4xx', '5xx'].map((c) => num(r.classes[c]).padStart(8)),
  ].join('  ');
  log(['HOSTNAME'.padEnd(width), 'REQUESTS'.padStart(10), 'BANDWIDTH'.padStart(10), ...['2xx', '3xx', '4xx', '5xx'].map((c) => c.padStart(8))].join('  '));
  for (const r of rows) log(line(r.hostname, r));
  if (rows.length > 1) log(line('total', total));
  const top = Object.entries(total.status).sort((a, b) => b[1] - a[1]).slice(0, 8);
  log(top.length ? `Status codes: ${top.map(([c, n]) => `${c} ${num(n)}`).join(', ')}` : 'No requests in this window.');
}
