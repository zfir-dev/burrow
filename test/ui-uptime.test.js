import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { buildTimeline, statusAfter } = await import('../src/uptime.js');
const { readEvents, historyFile } = await import('../src/history.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

const H = 3600e3;
const NOW = Date.parse('2026-11-22T12:00:00Z');
const ev = (hoursAgo, action, extra = {}) => ({ at: new Date(NOW - hoursAgo * H).toISOString(), action, ok: true, source: 'cli', ...extra });

test('statusAfter maps events to statuses', () => {
  assert.equal(statusAfter({ action: 'up', ok: true }), 'up');
  assert.equal(statusAfter({ action: 'up', ok: false }), 'down');
  assert.equal(statusAfter({ action: 'down', ok: true }), 'stopped');
  assert.equal(statusAfter({ action: 'health', detail: 'degraded: app: nothing listening (was ok)' }), 'degraded');
  assert.equal(statusAfter({ action: 'health', detail: 'ok (was down)' }), 'up');
  assert.equal(statusAfter({ action: 'edit', ok: true }), null);
});

test('buildTimeline: segments, uptime % (stopped time excluded) and incidents', () => {
  const events = [
    ev(30, 'up'), // before the window: the window starts "up"
    ev(20, 'health', { source: 'watch', ok: false, detail: 'down: cloudflared is not running (was ok)' }),
    ev(19, 'health', { source: 'watch', detail: 'ok (was down)' }),
    ev(10, 'down'),
    ev(6, 'up', { source: 'dashboard' }),
    ev(5, 'edit'),
  ];
  const t = buildTimeline(events, { now: NOW, windowMs: 24 * H, current: 'up' });
  assert.deepEqual(t.segments.map((s) => [s.status, (s.to - s.from) / H]), [['up', 4], ['down', 1], ['up', 9], ['stopped', 4], ['up', 6]]);
  assert.equal(Math.round(t.segments.reduce((n, s) => n + s.pct, 0)), 100);
  assert.equal(t.uptimePct, 95, '19 of 20 watched hours were up');
  assert.deepEqual(t.incidents.map((i) => [i.status, i.source]), [['down', 'watch']]);

  // No history: unknown, then what it is doing now from the watch state's "since".
  const w = buildTimeline([], { now: NOW, windowMs: 24 * H, current: 'degraded', currentSince: NOW - 2 * H });
  assert.deepEqual(w.segments.map((s) => s.status), ['unknown', 'degraded']);
  assert.equal(w.uptimePct, 0);
  // Stopped on purpose and not running stays "stopped", not "down".
  const s = buildTimeline([ev(3, 'down')], { now: NOW, windowMs: H * 24, current: 'down' });
  assert.equal(s.segments.at(-1).status, 'stopped');
  assert.equal(buildTimeline([], { now: NOW }).uptimePct, null);
});

test('burrow watch records health changes as history events; /api/uptime serves timelines', async () => {
  const dir = join(sb.dir, 'todo-api');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tunnel.yml'), 'project: todo-api\nservices:\n  - name: app\n    url: http://127.0.0.1:9\n');
  writeFileSync(join(sb.state, 'todo-api.json'), JSON.stringify({ project: 'todo-api', file: join(dir, 'tunnel.yml'), hostnames: ['todo-api.example.dev'] }));
  writeFileSync(join(sb.state, 'todo-api.pid'), '999999'); // crashed
  mkdirSync(join(historyFile(), '..'), { recursive: true });
  writeFileSync(historyFile(), JSON.stringify({ at: new Date(Date.now() - 2 * H).toISOString(), action: 'up', project: 'todo-api', source: 'cli', ok: true }) + '\n');

  const r = await sb.run(['watch', '--once', '--debounce', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /todo-api is DOWN/);
  const [h] = readEvents({ action: 'health' });
  assert.equal(h.source, 'watch');
  assert.equal(h.ok, false);
  assert.match(h.detail, /^down: cloudflared is not running/);
  assert.match(h.detail, /\(was ok\)$/);
  const again = await sb.run(['watch', '--once', '--debounce', '1']);
  assert.equal(again.code, 0);
  assert.equal(readEvents({ action: 'health' }).length, 1, 'only changes are recorded');
  const dry = await sb.run(['watch', '--once', '--debounce', '1', '--dry-run', 'todo-api']);
  assert.equal(dry.code, 0);

  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/uptime`)).status, 401);
    assert.equal((await d.get('/api/uptime?window=1y')).status, 400);
    const j = await (await d.get('/api/uptime?window=24h')).json();
    const row = j.projects.find((p) => p.project === 'todo-api');
    assert.deepEqual(row.segments.map((s) => s.status), ['unknown', 'up', 'down']);
    assert.ok(row.uptimePct > 99 && row.uptimePct < 100);
    assert.equal(row.incidents[0].status, 'down');
    assert.ok(!j.projects.some((p) => p.project === 'burrow'), 'no dashboard row');
    assert.match(await (await d.get('/')).text(), /Last 7 days/);
  } finally { await d.close(); }
});
