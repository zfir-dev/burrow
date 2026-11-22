import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, EXAMPLE } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';
import { parseProject, hostnames } from '../src/project.js';

const ZONES = [
  { id: 'zone-1', name: 'example.dev', status: 'active', account: { id: 'acct-1' } },
  { id: 'zone-2', name: 'example.org', status: 'active', account: { id: 'acct-1' } },
  { id: 'zone-9', name: 'example.net', status: 'active', account: { id: 'acct-other' } },
];

function todoApi(sb, domain) {
  const dir = join(sb.dir, 'todo-api');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tunnel.yml'), `project: todo-api\n${domain ? `domain: ${domain}\n` : ''}services:\n  - name: app\n    url: http://localhost:4000\n  - name: docs\n    url: http://localhost:4001\n`);
  return dir;
}
const recs = (cf, project) => cf.state.records.filter((r) => r.comment === `burrow:${project}`).map((r) => `${r.zone_id} ${r.name}`).sort();
const zoneLookups = (cf) => cf.state.calls.filter((c) => c === 'GET /zones').length;

test('domain: in tunnel.yml is validated and used for hostnames', () => {
  const p = parseProject('project: todo-api\ndomain: Example.ORG.\nservices:\n  - name: app\n    url: http://localhost:4000\n');
  assert.equal(p.domain, 'example.org');
  assert.deepEqual(hostnames(p, p.domain).map((h) => h.hostname), ['todo-api.example.org']);
  assert.equal(parseProject('project: blog\nservices:\n  - name: app\n    url: http://localhost:4000\n').domain, undefined);
  assert.throws(() => parseProject('project: x\ndomain: localhost\nservices:\n  - name: app\n    url: http://localhost:1\n'), /invalid domain "localhost"/);
});

test('up --dry-run works offline without BURROW_DOMAIN', async () => {
  const sb = sandbox({ api: 'http://127.0.0.1:1', domain: '' });
  try {
    const dir = todoApi(sb, 'example.org');
    const r = await sb.run(['up', '--dry-run'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /would use domain example\.org/);
    assert.match(r.stdout, /CNAME todo-api\.example\.org/);
    assert.match(r.stdout, /CNAME docs-todo-api\.example\.org/);
  } finally { await sb.cleanup(); }
});

test('up, ls, status, url and destroy use the project zone; the zone ID is cached', async () => {
  const cf = await mockCloudflare({ zones: ZONES });
  const sb = sandbox({ api: cf.url });
  try {
    let r = await sb.run(['up', '-f', EXAMPLE]);
    assert.equal(r.code, 0, r.stderr);
    const dir = todoApi(sb, 'example.org');
    r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(recs(cf, 'todo-api'), ['zone-2 docs-todo-api.example.org', 'zone-2 todo-api.example.org']);
    assert.ok(cf.state.calls.includes('POST /zones/zone-2/dns_records'));
    assert.ok(recs(cf, 'acme-shop').every((x) => x.startsWith('zone-1 ')));
    const cfgId = cf.live().find((t) => t.name === 'burrow-todo-api').id;
    assert.equal(cf.state.configs[cfgId].ingress[0].hostname, 'todo-api.example.org');
    const meta = JSON.parse(readFileSync(join(sb.state, 'todo-api.json'), 'utf8'));
    assert.equal(meta.domain, 'example.org');
    assert.equal(meta.zoneId, 'zone-2');
    const cache = JSON.parse(readFileSync(join(sb.state, 'cache', 'zones.json'), 'utf8'));
    assert.equal(cache['example.org'].id, 'zone-2');

    const lookups = zoneLookups(cf);
    r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(zoneLookups(cf), lookups, 'the cached zone ID is reused');

    r = await sb.run(['ls', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const ls = Object.fromEntries(JSON.parse(r.stdout).map((x) => [x.project, x.hostnames]));
    assert.deepEqual(ls['todo-api'], ['docs-todo-api.example.org', 'todo-api.example.org']);
    assert.equal(ls['acme-shop'].length, 3);

    r = await sb.run(['status', 'todo-api']);
    assert.match(r.stdout, /CNAME https:\/\/todo-api\.example\.org/);
    r = await sb.run(['url', 'todo-api', '--plain']);
    assert.deepEqual(r.stdout.trim().split('\n'), ['https://todo-api.example.org', 'https://docs-todo-api.example.org']);

    r = await sb.run(['destroy', 'todo-api']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(recs(cf, 'todo-api'), []);
    assert.ok(cf.state.calls.some((c) => c.startsWith('DELETE /zones/zone-2/dns_records/')));
    assert.equal(recs(cf, 'acme-shop').length, 3, 'other projects are untouched');
  } finally { await sb.cleanup(); await cf.close(); }
});

test('changing domain: moves the records to the new zone', async () => {
  const cf = await mockCloudflare({ zones: ZONES });
  const sb = sandbox({ api: cf.url });
  try {
    let dir = todoApi(sb, 'example.org');
    let r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    dir = todoApi(sb, '');
    r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Removed DNS todo-api\.example\.org \(previous domain\)/);
    assert.deepEqual(recs(cf, 'todo-api'), ['zone-1 docs-todo-api.example.dev', 'zone-1 todo-api.example.dev']);
    assert.equal(cf.live().length, 1, 'same tunnel');
  } finally { await sb.cleanup(); await cf.close(); }
});

test('a domain whose zone is not on the account is refused before anything is created', async () => {
  const cf = await mockCloudflare({ zones: ZONES });
  const sb = sandbox({ api: cf.url });
  try {
    for (const domain of ['example.net', 'example.com']) {
      const dir = todoApi(sb, domain);
      const r = await sb.run(['up'], { cwd: dir });
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`Zone ${domain.replace('.', '\\.')} is not on Cloudflare account acct-1`));
    }
    assert.equal(cf.live().length, 0);
    assert.equal(cf.state.records.length, 0);
  } finally { await sb.cleanup(); await cf.close(); }
});

test('prune and the dashboard see records in every known zone', async () => {
  const cf = await mockCloudflare({ zones: ZONES });
  const sb = sandbox({ api: cf.url });
  try {
    const dir = todoApi(sb, 'example.org');
    let r = await sb.run(['up'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    cf.state.records.push({ id: 'orphan', zone_id: 'zone-2', type: 'CNAME', name: 'old-blog.example.org', content: 'gone.cfargotunnel.com', comment: 'burrow:old-blog' });
    r = await sb.run(['prune', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /DNS CNAME old-blog\.example\.org/);
    assert.ok(cf.state.calls.includes('DELETE /zones/zone-2/dns_records/orphan'));
    assert.equal(recs(cf, 'todo-api').length, 2);

    process.env.BURROW_STATE_DIR = sb.state;
    process.env.BURROW_CF_API_BASE = cf.url;
    const { collect } = await import('../src/dashboard/data.js');
    const data = await collect({ token: 't', accountId: 'acct-1', zoneId: 'zone-1', domain: 'example.dev' });
    const todo = data.projects.find((x) => x.project === 'todo-api');
    assert.deepEqual(todo.hostnames, ['docs-todo-api.example.org', 'todo-api.example.org']);
    assert.ok(existsSync(join(sb.state, 'cache', 'zones.json')));
  } finally {
    delete process.env.BURROW_STATE_DIR;
    delete process.env.BURROW_CF_API_BASE;
    await sb.cleanup();
    await cf.close();
  }
});
