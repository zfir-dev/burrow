import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

// Three zones on the account; example.net's DNS can't be read with this token.
const ZONES = [
  { id: 'zone-1', name: 'example.dev', status: 'active', account: { id: 'acct-1' } },
  { id: 'zone-2', name: 'example.org', status: 'active', account: { id: 'acct-1' } },
  { id: 'zone-3', name: 'example.net', status: 'active', account: { id: 'acct-1' } },
];
const cf = await mockCloudflare({
  zones: ZONES,
  routes: ({ p, fail }) => (p.startsWith('/zones/zone-3/') ? (fail(403, 'Authentication error'), true) : false),
});
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

const R = (id, zone, name, target, project) =>
  ({ id, zone_id: zone, type: 'CNAME', name, content: `${target}.cfargotunnel.com`, comment: `burrow:${project}` });

test('HTTP: cleanup finds and deletes orphans in per-project zones too', async () => {
  // todo-api lives on example.org (domain: in its tunnel.yml).
  const dir = join(sb.dir, 'todo-api');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tunnel.yml'), 'project: todo-api\ndomain: example.org\nservices:\n  - name: app\n    url: http://localhost:4000\n');
  const up = await sb.run(['up'], { cwd: dir });
  assert.equal(up.code, 0, up.stderr);
  // A domain used once and cached, whose DNS this token can no longer read.
  const cache = join(sb.state, 'cache', 'zones.json');
  const known = JSON.parse((await import('node:fs')).readFileSync(cache, 'utf8'));
  known['example.net'] = { id: 'zone-3', accountId: known['example.org'].accountId, checkedAt: Date.now() };
  writeFileSync(cache, JSON.stringify(known));

  cf.state.records.push(
    R('r-dev', 'zone-1', 'old-blog.example.dev', 'gone-1', 'old-blog'),
    R('r-org', 'zone-2', 'acme-shop.example.org', 'gone-2', 'acme-shop'),
  );
  const d = await startDashboard();
  try {
    let j = await (await d.get('/api/cleanup')).json();
    assert.deepEqual(j.zones, ['example.dev', 'example.org', 'example.net']);
    assert.deepEqual(j.records.map((r) => [r.id, r.zone]).sort(), [['r-dev', 'example.dev'], ['r-org', 'example.org']]);
    assert.deepEqual(j.zoneErrors.map((z) => z.zone), ['example.net']);
    assert.ok(!j.records.some((r) => r.name === 'todo-api.example.org'), 'live project records are kept');

    const r = await d.post('/api/cleanup', { confirm: 'delete', recordIds: ['r-dev', 'r-org'] });
    j = await r.json();
    assert.equal(r.status, 200, j.output);
    assert.deepEqual(j.deleted, { tunnels: 0, records: 2 });
    assert.match(j.output, /Couldn't read DNS in example\.net/);
    assert.ok(cf.state.calls.includes('DELETE /zones/zone-1/dns_records/r-dev'));
    assert.ok(cf.state.calls.includes('DELETE /zones/zone-2/dns_records/r-org'), 'deleted in its own zone');
    assert.deepEqual(cf.state.records.map((x) => x.name), ['todo-api.example.org']);
    assert.match(await (await d.get('/')).text(), /not scanned/);
  } finally { await d.close(); }
});
