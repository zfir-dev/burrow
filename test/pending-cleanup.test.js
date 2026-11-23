import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

// example.org's DNS can be switched to unreadable (403), like a token that lost access.
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
const { pendingFile, listPending, addPending } = await import('../src/pending.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

function project(name, domain) {
  const dir = join(sb.dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tunnel.yml'), `project: ${name}\n${domain ? `domain: ${domain}\n` : ''}services:\n  - name: app\n    url: http://localhost:4000\n`);
  return dir;
}
const names = () => cf.state.records.map((r) => r.name).sort();

test('destroy with an unreadable zone deletes the tunnel, queues the DNS, and prune retries it', async () => {
  const dir = project('acme-shop', 'example.org');
  let r = await sb.run(['up'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  r = await sb.run(['down'], { cwd: dir });
  assert.deepEqual(names(), ['acme-shop.example.org']);

  deny = true;
  r = await sb.run(['destroy', 'acme-shop']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /couldn't read DNS in example\.org \(.*Authentication error.*\); its records there are queued/);
  assert.match(r.stdout, /deleted tunnel burrow-acme-shop/);
  assert.equal(cf.live().length, 0);
  assert.deepEqual(names(), ['acme-shop.example.org'], 'record still there');
  const q = listPending();
  assert.equal(q.length, 1);
  assert.deepEqual([q[0].project, q[0].zoneId, q[0].domain, q[0].comment], ['acme-shop', 'zone-2', 'example.org', 'burrow:acme-shop']);
  assert.equal(statSync(pendingFile()).mode & 0o777, 0o600);

  // Still unreadable: prune keeps it queued and exits 1.
  r = await sb.run(['prune', '--yes']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /still can't clean up DNS in example\.org/);
  assert.equal(listPending().length, 1);

  deny = false;
  r = await sb.run(['prune', '--dry-run']);
  assert.match(r.stdout, /\[dry-run\] would retry 1 queued DNS cleanup/);
  assert.deepEqual(names(), ['acme-shop.example.org']);
  r = await sb.run(['prune', '--yes']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /acme-shop: deleted DNS CNAME acme-shop\.example\.org/);
  assert.deepEqual(names(), []);
  assert.deepEqual(listPending(), []);
});

test('a queued deletion is dropped, not run, when the project is set up again', async () => {
  const dir = project('blog', 'example.org');
  let r = await sb.run(['up'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  addPending({ zoneId: 'zone-2', domain: 'example.org', comment: 'burrow:blog', project: 'blog', error: 'old' });
  r = await sb.run(['prune', '--yes']);
  assert.match(r.stdout, /blog: is set up again; kept its DNS records/);
  assert.deepEqual(names(), ['blog.example.org']);
  assert.deepEqual(listPending(), []);
  r = await sb.run(['destroy', 'blog']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(names(), []);
});

test('HTTP: the cleanup panel lists queued deletions and retries them', async () => {
  const dir = project('todo-api', 'example.org');
  let r = await sb.run(['up'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  await sb.run(['down'], { cwd: dir });
  deny = true;
  r = await sb.run(['destroy', 'todo-api']);
  assert.equal(r.code, 0, r.stderr);
  const d = await startDashboard();
  try {
    let j = await (await d.get('/api/cleanup')).json();
    assert.deepEqual(j.pending.map((e) => [e.project, e.domain]), [['todo-api', 'example.org']]);
    // Still denied: 502, stays queued.
    let res = await d.post('/api/cleanup/pending/retry', {});
    assert.equal(res.status, 502);
    assert.equal(listPending().length, 1);
    deny = false;
    res = await d.post('/api/cleanup/pending/retry', {});
    j = await res.json();
    assert.equal(res.status, 200, j.output);
    assert.match(j.output, /todo-api: deleted DNS CNAME todo-api\.example\.org/);
    assert.deepEqual(j.pending, []);
    assert.deepEqual(names(), []);
    assert.match(await (await d.get('/')).text(), /Queued DNS deletions/);
  } finally { await d.close(); }
});

test('pending store tolerates a missing or broken file', () => {
  writeFileSync(pendingFile(), 'not json');
  assert.deepEqual(listPending(), []);
  addPending({ zoneId: 'z', domain: 'example.net', comment: 'burrow:old-demo', project: 'old-demo', error: 'x' });
  addPending({ zoneId: 'z', domain: 'example.net', comment: 'burrow:old-demo', project: 'old-demo', error: 'y' });
  const q = JSON.parse(readFileSync(pendingFile(), 'utf8'));
  assert.equal(q.length, 1, 'deduplicated by zone and comment');
  assert.equal(q[0].error, 'y');
  writeFileSync(pendingFile(), '[]');
});
