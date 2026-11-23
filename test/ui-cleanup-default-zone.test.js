import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

// BURROW_DOMAIN is example.gone, which is no longer on the account (and no CF_ZONE_ID pins it);
// example.org, used earlier and cached, is still readable.
const cf = await mockCloudflare({ zones: [{ id: 'zone-2', name: 'example.org', status: 'active', account: { id: 'acct-1' } }] });
const sb = sandbox({ api: cf.url, domain: 'example.gone', extra: { CF_ZONE_ID: '' } });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

test('HTTP: cleanup scans the zones it can and lists the default zone as not scanned', async () => {
  mkdirSync(join(sb.state, 'cache'), { recursive: true });
  writeFileSync(join(sb.state, 'cache', 'zones.json'), JSON.stringify({ 'example.org': { id: 'zone-2', accountId: 'acct-1', checkedAt: Date.now() } }));
  cf.state.records.push({ id: 'r-old', zone_id: 'zone-2', type: 'CNAME', name: 'old-demo.example.org', content: 'gone.cfargotunnel.com', comment: 'burrow:old-demo' });
  const d = await startDashboard();
  try {
    let r = await d.get('/api/cleanup');
    let j = await r.json();
    assert.equal(r.status, 200, j.error);
    assert.deepEqual(j.zones, ['example.org']);
    assert.deepEqual(j.zoneErrors.map((z) => z.zone), ['example.gone']);
    assert.match(j.zoneErrors[0].error, /Zone example\.gone is not on Cloudflare account/);
    assert.deepEqual(j.records.map((x) => x.id), ['r-old']);
    r = await d.post('/api/cleanup', { confirm: 'delete', recordIds: ['r-old'] });
    j = await r.json();
    assert.equal(r.status, 200, j.output);
    assert.match(j.output, /Deleted DNS old-demo\.example\.org/);
    assert.match(j.output, /Couldn't read DNS in example\.gone/);
    assert.deepEqual(cf.state.records, []);
  } finally { await d.close(); }
});
