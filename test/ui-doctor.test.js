import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { parseReport, groupChecks } = await import('../src/dashboard/panels/doctor.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

async function closedPort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}
// A remembered project whose app isn't running, and a ./tunnel.yml that --all ignores.
const port = await closedPort();
const dir = join(sb.dir, 'blog');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'tunnel.yml'), `project: blog\nservices:\n  - name: app\n    url: http://127.0.0.1:${port}\n`);
writeFileSync(join(sb.state, 'blog.json'), JSON.stringify({ project: 'blog', file: join(dir, 'tunnel.yml') }));
writeFileSync(join(sb.dir, 'tunnel.yml'), 'project: acme-shop\nservices:\n  - name: app\n    url: http://127.0.0.1:1\n');

test('parseReport and groupChecks', () => {
  assert.equal(parseReport('noise\nmore'), null);
  const r = parseReport('warning: x\n{"counts":{"pass":1,"warn":0,"fail":0,"skip":0},"checks":[{"section":"Config","status":"pass","label":"a"}]}\n');
  assert.equal(r.counts.pass, 1);
  assert.deepEqual(groupChecks([{ section: 'A', label: 1 }, { section: 'A', label: 2 }, { section: 'B', label: 3 }]).map((g) => [g.title, g.checks.length]), [['A', 2], ['B', 1]]);
});

test('CLI: doctor --json --all reports checks with fixes, and the text report is unchanged', async () => {
  let r = await sb.run(['doctor', '--json', '--all']);
  assert.equal(r.code, 1, 'a failed check still exits 1');
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'only the JSON line on stdout');
  const j = JSON.parse(lines[0]);
  const app = j.checks.find((c) => c.section.startsWith('Project blog'));
  assert.equal(app.status, 'fail');
  assert.match(app.fix, /Start the app behind http:\/\/127\.0\.0\.1:\d+/);
  assert.ok(!j.checks.some((c) => c.section.includes('acme-shop')), '--all ignores ./tunnel.yml');
  assert.ok(j.checks.filter((c) => c.status === 'pass').every((c) => !c.fix), 'fixes only for problems');
  assert.ok(!r.stdout.includes('test-token'));
  r = await sb.run(['doctor', '--all']);
  assert.match(r.stdout, /✗ app -> http:\/\/127\.0\.0\.1:\d+ - connection refused/);
  assert.match(r.stdout, /1 failed/);
});

test('HTTP: Doctor runs behind login and CSRF, and keeps the last report', async () => {
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/doctor`)).status, 401);
    assert.equal((await fetch(`${d.base}/api/doctor`, { method: 'POST', headers: { cookie: d.cookie }, body: '{}' })).status, 403);
    assert.deepEqual(await (await d.get('/api/doctor')).json(), { ran: false });
    let r = await d.post('/api/doctor', {});
    let j = await r.json();
    assert.equal(r.status, 200, j.error || j.output);
    assert.ok(j.counts.pass >= 5);
    assert.equal(j.counts.fail, 1);
    const titles = j.groups.map((g) => g.title);
    assert.deepEqual(titles.slice(0, 3), ['Config', 'Cloudflare API', 'cloudflared']);
    assert.ok(titles.some((t) => t.startsWith('Project blog')));
    assert.ok(!JSON.stringify(j).includes('test-token'), 'no secrets');
    const calls = cf.state.calls.length;
    r = await d.post('/api/doctor', { offline: true });
    j = await r.json();
    assert.equal(cf.state.calls.length, calls, 'offline makes no API calls');
    assert.equal(j.groups.find((g) => g.title === 'Cloudflare API').checks[0].status, 'skip');
    assert.equal((await (await d.get('/api/doctor')).json()).offline, true);
    assert.match(await (await d.get('/')).text(), /Run checks/);
  } finally { await d.close(); }
});
