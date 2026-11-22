import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, EXAMPLE } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';
import { aggregate, formatBytes, parseSince } from '../src/stats.js';

const G = (host, status, count, bytes) => ({ count, sum: { edgeResponseBytes: bytes }, dimensions: { clientRequestHTTPHost: host, edgeResponseStatus: status } });

function analytics({ groups = [], errors = null, status = 200 } = {}) {
  const seen = [];
  const routes = async ({ method, p, body, send }) => {
    if (p !== '/graphql') return false;
    assert.equal(method, 'POST');
    seen.push(body);
    if (errors) send(status, { data: null, errors });
    else send(200, { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: groups }] } }, errors: null });
    return true;
  };
  return { routes, seen };
}

test('parseSince accepts durations and ISO dates', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  assert.equal(parseSince('24h', now).toISOString(), '2026-11-20T12:00:00.000Z');
  assert.equal(parseSince('30m', now).toISOString(), '2026-11-21T11:30:00.000Z');
  assert.equal(parseSince('7d', now).toISOString(), '2026-11-14T12:00:00.000Z');
  assert.equal(parseSince('2026-11-01', now).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.throws(() => parseSince('yesterday', now), /Invalid --since/);
  assert.throws(() => parseSince('2027-01-01', now), /Invalid --since/);
});

test('aggregate sums requests, bytes and status classes per hostname', () => {
  const rows = aggregate([
    G('acme-shop.example.dev', 200, 90, 9000), G('acme-shop.example.dev', 404, 10, 100),
    G('mail-acme-shop.example.dev', 502, 3, 30), G('blog.example.dev', 200, 999, 1),
  ], ['acme-shop.example.dev', 'mail-acme-shop.example.dev', 'studio-acme-shop.example.dev']);
  assert.deepEqual(rows.map((r) => [r.hostname, r.requests, r.bytes, r.classes['2xx'], r.classes['4xx'], r.classes['5xx']]), [
    ['acme-shop.example.dev', 100, 9100, 90, 10, 0],
    ['mail-acme-shop.example.dev', 3, 30, 0, 0, 3],
    ['studio-acme-shop.example.dev', 0, 0, 0, 0, 0],
  ]);
  assert.deepEqual(rows[0].status, { 200: 90, 404: 10 });
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(12_345_678), '12.3 MB');
});

test('stats queries httpRequestsAdaptiveGroups for the project hostnames and prints a table', async () => {
  const a = analytics({ groups: [
    G('acme-shop.example.dev', 200, 1200, 12_000_000), G('acme-shop.example.dev', 304, 50, 1000),
    G('acme-shop.example.dev', 404, 40, 4000), G('studio-acme-shop.example.dev', 500, 2, 200),
  ] });
  const cf = await mockCloudflare({ routes: a.routes });
  const sb = sandbox({ api: cf.url });
  try {
    const r = await sb.run(['stats', '-f', EXAMPLE, '--since', '7d']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(a.seen.length, 1);
    const { query, variables } = a.seen[0];
    assert.match(query, /httpRequestsAdaptiveGroups/);
    assert.match(query, /clientRequestHTTPHost/);
    assert.equal(variables.zoneTag, 'zone-1');
    assert.deepEqual(variables.filter.clientRequestHTTPHost_in.sort(),
      ['acme-shop.example.dev', 'mail-acme-shop.example.dev', 'studio-acme-shop.example.dev']);
    const span = Date.parse(variables.filter.datetime_lt) - Date.parse(variables.filter.datetime_geq);
    assert.ok(Math.abs(span - 7 * 86400e3) < 5000, `window is 7 days (${span})`);
    assert.match(variables.filter.datetime_geq, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.match(r.stdout, /HOSTNAME\s+REQUESTS\s+BANDWIDTH\s+2xx\s+3xx\s+4xx\s+5xx/);
    assert.match(r.stdout, /acme-shop\.example\.dev\s+1,290\s+12\.0 MB\s+1,200\s+50\s+40\s+0/);
    assert.match(r.stdout, /mail-acme-shop\.example\.dev\s+0\s+0 B/);
    assert.match(r.stdout, /total\s+1,292/);
    assert.match(r.stdout, /Status codes: 200 1,200, 304 50, 404 40, 500 2/);
  } finally { await sb.cleanup(); await cf.close(); }
});

test('stats --json and a remembered project', async () => {
  const a = analytics({ groups: [G('acme-shop.example.dev', 200, 7, 700), G('mail-acme-shop.example.dev', 503, 1, 10)] });
  const cf = await mockCloudflare({ routes: a.routes });
  const sb = sandbox({ api: cf.url });
  try {
    let r = await sb.run(['up', '-f', EXAMPLE]);
    assert.equal(r.code, 0, r.stderr);
    r = await sb.run(['stats', 'acme-shop', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.project, 'acme-shop');
    assert.equal(j.hostnames.length, 3);
    assert.deepEqual(j.total, { requests: 8, bytes: 710, status: { 200: 7, 503: 1 }, classes: { '1xx': 0, '2xx': 7, '3xx': 0, '4xx': 0, '5xx': 1 } });
    assert.ok(Date.parse(j.until) - Date.parse(j.since) <= 86400e3 + 5000);
    assert.ok(!r.stdout.includes('test-token'));
  } finally { await sb.cleanup(); await cf.close(); }
});

test('permission errors point at Zone > Analytics > Read', async () => {
  const a = analytics({ errors: [{ message: 'not authorized for that account' }] });
  const cf = await mockCloudflare({ routes: a.routes });
  const sb = sandbox({ api: cf.url });
  try {
    const r = await sb.run(['stats', '-f', EXAMPLE]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /GraphQL Analytics query failed: not authorized/);
    assert.match(r.stderr, /Zone > Analytics > Read/);
    const bad = await sb.run(['stats', '-f', EXAMPLE, '--since', 'soon']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Invalid --since/);
  } finally { await sb.cleanup(); await cf.close(); }
});
