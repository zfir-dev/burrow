import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, EXAMPLE } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const seen = [];
let fail = null;
const cf = await mockCloudflare({ routes: async ({ p, body, send }) => {
  if (p !== '/graphql') return false;
  seen.push(body);
  if (fail) { send(200, { data: null, errors: [{ message: 'not authorized for that zone' }] }); return true; }
  const now = Date.now();
  const hour = (h) => new Date(Math.floor(now / 3600e3) * 3600e3 - h * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
  const series = /datetimeHour/.test(body.query);
  const G = (host, status, count, h) => ({ count, sum: { edgeResponseBytes: count * 10 },
    dimensions: { clientRequestHTTPHost: host, edgeResponseStatus: status, ...(series ? { datetimeHour: hour(h) } : {}) } });
  send(200, { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [
    G('acme-shop.example.dev', 200, 100, 2), G('acme-shop.example.dev', 503, 5, 2),
    G('mail-acme-shop.example.dev', 404, 7, 1), G('blog.example.dev', 200, 999, 1),
  ] }] } } });
  return true;
} });
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { aggregateSeries, bucketSpec } = await import('../src/stats.js');
const { clearCache } = await import('../src/dashboard/panels/stats.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

test('aggregateSeries fills empty buckets and splits 4xx/5xx per hostname', () => {
  const since = new Date('2026-11-21T00:00:00Z');
  const until = new Date('2026-11-21T04:00:00Z');
  assert.deepEqual(bucketSpec(since.getTime(), until.getTime()), { dim: 'datetimeFifteenMinutes', step: 900000 });
  assert.equal(bucketSpec(0, 7 * 3600e3).dim, 'datetimeHour');
  const s = aggregateSeries([
    { count: 3, sum: { edgeResponseBytes: 30 }, dimensions: { datetimeHour: '2026-11-21T01:00:00Z', clientRequestHTTPHost: 'a.example.dev', edgeResponseStatus: 502 } },
    { count: 4, sum: { edgeResponseBytes: 40 }, dimensions: { datetimeHour: '2026-11-21T01:00:00Z', clientRequestHTTPHost: 'b.example.dev', edgeResponseStatus: 404 } },
    { count: 9, dimensions: { datetimeHour: '2026-11-21T02:00:00Z', clientRequestHTTPHost: 'other.example.dev', edgeResponseStatus: 200 } },
  ], ['a.example.dev', 'b.example.dev'], { since, until, dim: 'datetimeHour', step: 3600e3 });
  assert.equal(s.all.length, 4);
  assert.deepEqual(s.all[1], { t: Date.parse('2026-11-21T01:00:00Z'), requests: 7, e4xx: 4, e5xx: 3, bytes: 70 });
  assert.equal(s['a.example.dev'][1].e5xx, 3);
  assert.equal(s.all[2].requests, 0, 'other hostnames are ignored');
});

test('HTTP: /api/stats returns totals and a series, caches, and reports analytics errors', async () => {
  writeFileSync(join(sb.state, 'acme-shop.json'), JSON.stringify({ project: 'acme-shop', file: EXAMPLE }));
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/stats/acme-shop`)).status, 401);
    assert.equal((await d.get('/api/stats/acme-shop?since=99y')).status, 400);
    let r = await d.get('/api/stats/acme-shop?since=24h');
    let j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(seen.length, 2, 'one totals query and one series query');
    assert.match(seen[1].query, /datetimeHour/);
    const acme = j.hostnames.find((h) => h.hostname === 'acme-shop.example.dev');
    assert.equal(acme.requests, 105);
    assert.equal(acme.classes['5xx'], 5);
    assert.equal(j.total.requests, 112);
    assert.equal(j.step, 3600e3);
    assert.equal(j.series.all.length >= 24, true);
    assert.equal(j.series.all.reduce((a, b) => a + b.requests, 0), 112);
    assert.ok(!j.series['blog.example.dev']);

    r = await d.get('/api/stats/acme-shop?since=24h');
    assert.equal((await r.json()).cached, true);
    assert.equal(seen.length, 2);

    fail = true;
    clearCache();
    r = await d.get('/api/stats/acme-shop?since=1h');
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /Zone > Analytics > Read/);
    assert.match(await (await d.get('/')).text(), /class="chart"/);
  } finally { await d.close(); }
});
