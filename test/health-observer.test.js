import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
const { observe, observedStatus, readObserved, observedFile, CONFIRM_MS } = await import('../src/health-observer.js');
const { watchStateFile } = await import('../src/watch.js');
const { readEvents, historyFile } = await import('../src/history.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

const T0 = Date.parse('2026-11-22T12:00:00Z');
const row = (project, running, tunnel = 'healthy', extra = {}) => ({ project, running, tunnel: tunnel && { status: tunnel, connections: [] }, ...extra });
const reset = () => { rmSync(observedFile(), { force: true }); rmSync(watchStateFile(), { force: true }); };

test('observedStatus: crashed, stopped on purpose, tunnel down/degraded, the dashboard itself', () => {
  const pid = (names) => ({ pidFileExists: (n) => names.includes(n) });
  assert.deepEqual(observedStatus(row('todo-api', false), pid(['todo-api'])).status, 'down');
  assert.equal(observedStatus(row('blog', false), pid([])), null, 'stopped with burrow down: not tracked');
  assert.equal(observedStatus(row('acme-shop', true, 'inactive'), pid([])).status, 'down');
  assert.equal(observedStatus(row('acme-shop', true, 'degraded'), pid([])).status, 'degraded');
  assert.equal(observedStatus(row('acme-shop', true, null), pid([])).status, 'ok', 'Cloudflare unknown: process counts');
  assert.equal(observedStatus(row('burrow', true, 'healthy', { builtIn: true }), pid([])), null);
});

test('observe: a change counts once seen twice CONFIRM_MS apart, and is recorded as a health event', () => {
  reset();
  const events = [];
  const record = (e) => events.push(e);
  const crashed = { pidFileExists: (n) => n === 'todo-api' };
  const at = (s) => T0 + s * 1000;
  assert.deepEqual(observe([row('todo-api', false), row('blog', false)], { now: at(0), record, ...crashed }), []);
  assert.equal(readObserved()['todo-api'].pending, 'down');
  assert.ok(!readObserved().blog, 'stopped projects are not tracked');
  assert.deepEqual(observe([row('todo-api', false)], { now: at(5), record, ...crashed }), [], 'not yet confirmed');
  const c = observe([row('todo-api', false)], { now: at(5) + CONFIRM_MS, record, ...crashed });
  assert.deepEqual(c, [{ project: 'todo-api', from: 'ok', to: 'down' }]);
  assert.deepEqual(events.map((e) => [e.action, e.project, e.source, e.ok]), [['health', 'todo-api', 'dashboard', false]]);
  assert.equal(events[0].detail, 'down: cloudflared is not running (it exited or crashed) (was ok)');
  assert.equal(readObserved()['todo-api'].since, at(0), 'since = first sighting');

  // A blip (one observation) is ignored; a real recovery is recorded.
  observe([row('todo-api', true)], { now: at(60), record });
  observe([row('todo-api', false)], { now: at(70), record, ...crashed });
  assert.equal(events.length, 1);
  observe([row('todo-api', true)], { now: at(80), record });
  observe([row('todo-api', true)], { now: at(100), record });
  assert.deepEqual(events.map((e) => e.detail), ['down: cloudflared is not running (it exited or crashed) (was ok)', 'ok (was down)']);
});

test('observe records nothing while burrow watch is active', () => {
  reset();
  mkdirSync(join(watchStateFile(), '..'), { recursive: true });
  writeFileSync(watchStateFile(), '{}'); // written just now: watch is running
  const events = [];
  const crashed = { pidFileExists: () => true };
  observe([row('todo-api', false)], { now: Date.now(), record: (e) => events.push(e), ...crashed });
  observe([row('todo-api', false)], { now: Date.now() + CONFIRM_MS + 1, record: (e) => events.push(e), ...crashed });
  assert.equal(events.length, 0);
  assert.deepEqual(readObserved(), {});
  reset();
});

test('HTTP: the dashboard observes a crash without burrow watch and /api/uptime shows it', async () => {
  reset();
  mkdirSync(join(historyFile(), '..'), { recursive: true });
  writeFileSync(historyFile(), '');
  writeFileSync(join(sb.state, 'todo-api.json'), JSON.stringify({ project: 'todo-api', hostnames: ['todo-api.example.dev'] }));
  writeFileSync(join(sb.state, 'todo-api.pid'), '999999'); // pid file, no process: crashed
  const d = await startDashboard();
  try {
    await d.get('/api/tunnels'); // first sighting
    assert.equal(readObserved()['todo-api'].pending, 'down');
    // Pretend the first sighting was CONFIRM_MS ago, then refresh again.
    const st = readObserved();
    st['todo-api'].pendingAt -= CONFIRM_MS + 1000;
    writeFileSync(observedFile(), JSON.stringify(st));
    await d.get('/api/tunnels');
    const [h] = readEvents({ action: 'health' });
    assert.equal(h.source, 'dashboard');
    assert.match(h.detail, /^down: cloudflared is not running/);
    const j = await (await d.get('/api/uptime?window=1h')).json();
    const r = j.projects.find((p) => p.project === 'todo-api');
    assert.equal(r.segments.at(-1).status, 'down');
    assert.equal(r.incidents[0].source, 'dashboard');
  } finally { await d.close(); rmSync(join(sb.state, 'todo-api.pid'), { force: true }); }
});

test('panel start(ctx) runs once the server listens and its stop function runs on close', async () => {
  let started = 0;
  let stopped = 0;
  let collected = null;
  const panel = { id: 'demo-bg', start: (ctx) => { started++; ctx.collect().then((d) => { collected = d; }); return () => { stopped++; }; } };
  const d = await startDashboard({ panels: [panel] });
  for (let i = 0; i < 50 && !collected; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(started, 1);
  assert.ok(Array.isArray(collected.projects));
  await d.close();
  assert.equal(stopped, 1);
});
