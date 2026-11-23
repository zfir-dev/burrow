import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const ZONES = [
  { id: 'zone-1', name: 'example.dev', status: 'active', account: { id: 'acct-1' } },
  { id: 'zone-2', name: 'example.org', status: 'active', account: { id: 'acct-1' } },
];
const cf = await mockCloudflare({ zones: ZONES });
const sb = sandbox({ api: cf.url });
test.after(async () => { await sb.cleanup(); await cf.close(); });

const HOOK = (name) => `  ${name}: echo "$BURROW_HOOK $BURROW_PROJECT $BURROW_URL $BURROW_SHARE_OF" >> hooks.log\n`;
function project(name, { domain = 'example.org', hooks = true } = {}) {
  const dir = join(sb.dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tunnel.yml'), `project: ${name}\n${domain ? `domain: ${domain}\n` : ''}services:\n  - name: app\n    url: http://localhost:4000\n` +
    (hooks ? `hooks:\n${['pre_up', 'post_up', 'pre_down', 'post_down'].map(HOOK).join('')}` : ''));
  return dir;
}
const hookLog = (dir) => (existsSync(join(dir, 'hooks.log')) ? readFileSync(join(dir, 'hooks.log'), 'utf8').trim().split('\n') : []);
const meta = (label) => JSON.parse(readFileSync(join(sb.state, `share-${label}.json`), 'utf8'));
const inZone = (zone) => cf.state.records.filter((r) => r.zone_id === zone).map((r) => r.name);

test('share --domain uses that zone for DNS, restart and down', async () => {
  let r = await sb.run(['share', '3000', '--domain', 'example.org', '--name', 'acme-review', '--detach']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /https:\/\/acme-review\.example\.org/);
  assert.deepEqual(inZone('zone-2'), ['acme-review.example.org']);
  assert.deepEqual([meta('acme-review').domain, meta('acme-review').zoneId], ['example.org', 'zone-2']);
  assert.equal(meta('acme-review').file, undefined, 'a share never looks like an up-able project');

  // restart recreates a missing CNAME in the share's zone, not BURROW_DOMAIN's.
  cf.state.records.length = 0;
  r = await sb.run(['restart', 'share-acme-review']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(inZone('zone-2'), ['acme-review.example.org']);
  assert.deepEqual(inZone('zone-1'), []);

  r = await sb.run(['down', 'share-acme-review']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(cf.state.calls.some((c) => /^DELETE \/zones\/zone-2\/dns_records\//.test(c)));
  assert.deepEqual(cf.state.records, []);
  assert.equal(cf.live().length, 0);
});

test('share --domain refuses a zone that is not on the account', async () => {
  const r = await sb.run(['share', '3000', '--domain', 'example.net', '--name', 'nope', '--detach']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Zone example\.net is not on Cloudflare account/);
  assert.equal(cf.live().length, 0);
  assert.equal(existsSync(join(sb.state, 'share-nope.json')), false);
});

test('share -f uses the project domain: and runs its hooks on share and down', async () => {
  const dir = project('blog');
  let r = await sb.run(['share', '3000', '-f', join(dir, 'tunnel.yml'), '--name', 'blog-preview', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /would use domain example\.org from .*tunnel\.yml/);
  assert.match(r.stdout, /would run pre_up hook/);
  assert.match(r.stdout, /blog-preview\.example\.org/);
  assert.deepEqual(hookLog(dir), [], 'dry-run runs nothing');

  r = await sb.run(['share', '3000', '-f', join(dir, 'tunnel.yml'), '--name', 'blog-preview', '--detach']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(inZone('zone-2'), ['blog-preview.example.org']);
  assert.deepEqual(hookLog(dir), [
    'pre_up share-blog-preview https://blog-preview.example.org blog',
    'post_up share-blog-preview https://blog-preview.example.org blog',
  ]);
  assert.equal(meta('blog-preview').shareOf, 'blog');
  r = await sb.run(['down', 'share-blog-preview']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(hookLog(dir).slice(2).map((l) => l.split(' ')[0]), ['pre_down', 'post_down']);
  assert.deepEqual(cf.state.records, []);
});

test('share --project (remembered tunnel.yml) and --no-hooks', async () => {
  const dir = project('todo-api');
  let r = await sb.run(['up'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  await sb.run(['down'], { cwd: dir });
  writeFileSync(join(dir, 'hooks.log'), '');
  r = await sb.run(['share', '3000', '--project', 'todo-api', '--no-hooks', '--name', 'todo-review', '--detach']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(inZone('zone-2').includes('todo-review.example.org'));
  r = await sb.run(['down', 'share-todo-review']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(hookLog(dir).filter(Boolean), [], 'no hooks on share or on down');
  r = await sb.run(['share', '3000', '--project', 'ghost-project', '--detach']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No tunnel\.yml known for "ghost-project"/);
});

test('Ctrl+C on a foreground share made for a project runs its down hooks', async () => {
  const dir = project('pixel-app', { domain: null });
  const child = sb.start(['share', '3000', '-f', join(dir, 'tunnel.yml'), '--name', 'pixel-live']);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no prompt: ${out}`)), 15000);
    child.stdout.on('data', () => { if (out.includes('Ctrl+C')) { clearTimeout(t); resolve(); } });
  });
  assert.match(out, /pixel-live\.example\.dev/, 'no domain: falls back to BURROW_DOMAIN');
  child.kill('SIGINT');
  assert.equal(await new Promise((r) => child.on('close', r)), 0, out);
  assert.deepEqual(hookLog(dir).map((l) => l.split(' ')[0]), ['pre_up', 'post_up', 'pre_down', 'post_down']);
  assert.ok(!cf.live().some((t) => t.name === 'burrow-share-pixel-live'));
});
