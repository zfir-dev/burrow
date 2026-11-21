import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findOrphans } from '../src/prune.js';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const T = (id, name, connections = []) => ({ id, name, connections });
const R = (id, name, tunnelId, project) => ({ id, type: 'CNAME', name, content: `${tunnelId}.cfargotunnel.com`, comment: `burrow:${project}` });

test('findOrphans', () => {
  const tunnels = [T('t1', 'burrow-acme-shop'), T('t2', 'burrow-old-blog'), T('t3', 'burrow-todo-api', [{ colo_name: 'AMS' }]), T('t4', 'not-burrow')];
  const records = [
    R('r1', 'acme-shop.example.dev', 't1', 'acme-shop'),
    R('r2', 'mail-acme-shop.example.dev', 'stale', 'acme-shop'),
    R('r3', 'ghost.example.dev', 'gone', 'ghost'),
    R('r4', 'old-blog.example.dev', 't2', 'old-blog'),
    R('r5', 'todo-api.example.dev', 't3', 'todo-api'),
  ];
  const plan = findOrphans({ tunnels, records, local: new Set(['acme-shop']) });
  assert.deepEqual(plan.orphanTunnels.map((t) => t.id), ['t2']);
  assert.deepEqual(plan.skipped.map((t) => t.id), ['t3']);
  assert.deepEqual(plan.orphanRecords.map((r) => r.id), ['r2', 'r3', 'r4']);
  const all = findOrphans({ tunnels, records, local: new Set(['acme-shop']), includeActive: true });
  assert.deepEqual(all.orphanTunnels.map((t) => t.id), ['t2', 't3']);
  assert.deepEqual(all.orphanRecords.map((r) => r.id), ['r2', 'r3', 'r4', 'r5']);
});

async function seeded() {
  const cf = await mockCloudflare();
  const sb = sandbox({ api: cf.url });
  // acme-shop: up for real against the mock, so it has state and valid records
  const up = await sb.run(['up', '-f', (await import('./helpers/cli.js')).EXAMPLE]);
  assert.equal(up.code, 0, up.stderr);
  const acme = cf.live()[0];
  cf.state.tunnels.push(T('t-old', 'burrow-old-blog'), T('t-active', 'burrow-todo-api', [{ colo_name: 'AMS' }]));
  cf.state.records.push(
    R('r-ghost', 'ghost.example.dev', 'gone', 'ghost'),
    R('r-old', 'old-blog.example.dev', 't-old', 'old-blog'),
    R('r-stale', 'docs-acme-shop.example.dev', 'stale', 'acme-shop'),
    { id: 'r-foreign', type: 'A', name: 'www.example.dev', content: '192.0.2.1', comment: 'not ours' },
  );
  return { cf, sb, acme };
}

test('prune --dry-run lists orphans and deletes nothing; no TTY without --yes aborts', async () => {
  const { cf, sb } = await seeded();
  try {
    const before = cf.state.records.length;
    let r = await sb.run(['prune', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /tunnel burrow-old-blog/);
    assert.match(r.stdout, /DNS CNAME ghost\.example\.dev/);
    assert.match(r.stdout, /DNS CNAME docs-acme-shop\.example\.dev/);
    assert.match(r.stdout, /Skipping burrow-todo-api/);
    assert.doesNotMatch(r.stdout, /tunnel burrow-acme-shop/);
    assert.match(r.stdout, /would delete 1 tunnel\(s\) and 3 DNS record\(s\)/);
    assert.equal(cf.state.records.length, before);

    r = await sb.run(['prune']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Aborted/);
    assert.equal(cf.state.records.length, before);
  } finally {
    await sb.cleanup();
    await cf.close();
  }
});

test('prune --yes deletes only orphans', async () => {
  const { cf, sb, acme } = await seeded();
  try {
    const r = await sb.run(['prune', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(cf.live().map((t) => t.name).sort(), ['burrow-acme-shop', 'burrow-todo-api']);
    const names = cf.state.records.map((x) => x.name).sort();
    assert.deepEqual(names, ['acme-shop.example.dev', 'mail-acme-shop.example.dev', 'studio-acme-shop.example.dev', 'todo-api.example.dev', 'www.example.dev'].filter((n) => names.includes(n)));
    assert.ok(!names.includes('ghost.example.dev'));
    assert.ok(!names.includes('old-blog.example.dev'));
    assert.ok(!names.includes('docs-acme-shop.example.dev'));
    assert.ok(names.includes('www.example.dev'), 'records burrow does not own are never touched');
    assert.ok(cf.state.records.filter((x) => x.comment === 'burrow:acme-shop').every((x) => x.content === `${acme.id}.cfargotunnel.com`));

    const again = await sb.run(['prune', '--yes']);
    assert.match(again.stdout, /Nothing to prune/);
  } finally {
    await sb.cleanup();
    await cf.close();
  }
});

test('prune --include-active also removes tunnels with live connections', async () => {
  const { cf, sb } = await seeded();
  try {
    writeFileSync(join(sb.state, 'unrelated.txt'), '');
    const r = await sb.run(['prune', '--yes', '--include-active']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(cf.live().map((t) => t.name), ['burrow-acme-shop']);
  } finally {
    await sb.cleanup();
    await cf.close();
  }
});
