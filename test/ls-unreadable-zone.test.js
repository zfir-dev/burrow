import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

// example.org's DNS can be made unreadable (403), as when the token loses access to it.
const ZONES = [
  { id: 'zone-1', name: 'example.dev', status: 'active', account: { id: 'acct-1' } },
  { id: 'zone-2', name: 'example.org', status: 'active', account: { id: 'acct-1' } },
];
let deny = false;
const cf = await mockCloudflare({
  zones: ZONES,
  routes: ({ p, fail }) => (deny && p.startsWith('/zones/zone-2/') ? (fail(403, 'Authentication error'), true) : false),
});
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { startDashboard } = await import('./helpers/dash.js');
const { invalidateCloudflare } = await import('../src/dashboard/data.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

async function project(name, domain) {
  const dir = join(sb.dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tunnel.yml'), `project: ${name}\n${domain ? `domain: ${domain}\n` : ''}services:\n  - name: app\n    url: http://localhost:4000\n`);
  const r = await sb.run(['up'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  await sb.run(['down'], { cwd: dir });
}

test('setup: one project per zone', async () => {
  await project('acme-shop', 'example.org');
  await project('blog');
});

test('ls: an unreadable zone marks its projects unknown, warns and exits 1', async () => {
  deny = true;
  try {
    let r = await sb.run(['ls']);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /couldn't read DNS in example\.org \(.*Authentication error.*\); hostnames there are unknown/);
    assert.match(r.stdout, /acme-shop .*\n  hostnames unknown: zone example\.org unreadable/);
    assert.match(r.stdout, /blog .*\n  https:\/\/blog\.example\.dev/);

    r = await sb.run(['ls', '--json']);
    assert.equal(r.code, 1);
    const list = JSON.parse(r.stdout);
    const acme = list.find((x) => x.project === 'acme-shop');
    const blog = list.find((x) => x.project === 'blog');
    assert.equal(acme.hostnamesKnown, false);
    assert.equal(acme.zoneError.zone, 'example.org');
    assert.match(acme.zoneError.error, /Authentication error/);
    assert.deepEqual([blog.hostnamesKnown, blog.zoneError, blog.hostnames], [true, null, ['blog.example.dev']]);
  } finally { deny = false; }
  const r = await sb.run(['ls', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).every((x) => x.hostnamesKnown && x.zoneError === null));
});

test('status: only a project in the unreadable zone is affected', async () => {
  deny = true;
  try {
    let r = await sb.run(['status', 'acme-shop']);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /DNS: unknown, zone example\.org unreadable/);
    r = await sb.run(['status', 'acme-shop', '--json']);
    const j = JSON.parse(r.stdout);
    assert.equal(j.recordsKnown, false);
    assert.deepEqual(j.zoneErrors.map((z) => z.zone), ['example.org']);
    r = await sb.run(['status', 'blog']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /https:\/\/blog\.example\.dev/);
  } finally { deny = false; }
});

test('HTTP: the dashboard table keeps working and flags the affected project', async () => {
  const d = await startDashboard();
  deny = true;
  invalidateCloudflare();
  try {
    const j = await (await d.get('/api/tunnels')).json();
    assert.equal(j.cloudflare.error, null, 'Cloudflare still connected');
    assert.deepEqual(j.cloudflare.zoneErrors.map((z) => z.zone), ['example.org']);
    const acme = j.projects.find((p) => p.project === 'acme-shop');
    const blog = j.projects.find((p) => p.project === 'blog');
    assert.equal(acme.zoneError.zone, 'example.org');
    assert.ok(acme.tunnel, 'tunnel state still shown');
    assert.deepEqual(acme.hostnames, ['acme-shop.example.org'], 'remembered hostnames');
    assert.equal(blog.zoneError, null);
    assert.ok(blog.tunnel);
    assert.match(await (await d.get('/')).text(), /zoneErrorText\(p\)/);
  } finally { deny = false; invalidateCloudflare(); await d.close(); }
});
