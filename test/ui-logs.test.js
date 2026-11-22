import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'burrow-logs-'));
const state = join(dir, 'state');
mkdirSync(state);
process.env.BURROW_STATE_DIR = state;
process.env.BURROW_CONFIG = join(dir, 'none.env');
const { mergeByTime, logProjects, combinedText, readTail } = await import('../src/dashboard/logs.js');
const { APP_JS, APP_HTML } = await import('../src/dashboard/ui.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(state, 'acme-shop.log'), '2026-11-21T10:00:00Z INF acme one\n  continued\n2026-11-21T10:00:05Z ERR acme two\n');
writeFileSync(join(state, 'blog.log'), '2026-11-21T10:00:02Z WRN blog one\n');
writeFileSync(join(state, 'notes.txt'), 'not a log\n');

test('logs interleave by timestamp; lines without one stay with their predecessor', () => {
  assert.deepEqual(logProjects(), ['acme-shop', 'blog']);
  const merged = mergeByTime([['acme-shop', ['2026-11-21T10:00:00Z a', 'cont', '2026-11-21T10:00:05Z b']], ['blog', ['2026-11-21T10:00:02Z c']]]);
  assert.deepEqual(merged.map((e) => e.line), ['2026-11-21T10:00:00Z a', 'cont', '2026-11-21T10:00:02Z c', '2026-11-21T10:00:05Z b']);
  assert.equal(combinedText(), '[acme-shop] 2026-11-21T10:00:00Z INF acme one\n[acme-shop]   continued\n[blog] 2026-11-21T10:00:02Z WRN blog one\n[acme-shop] 2026-11-21T10:00:05Z ERR acme two\n');
  assert.equal(readTail(join(state, 'acme-shop.log'), 40), '2026-11-21T10:00:05Z ERR acme two\n');
});

test('the browser level parser understands cloudflared levels', () => {
  const src = APP_JS.slice(APP_JS.indexOf('function levelOf'), APP_JS.indexOf('\n}\n', APP_JS.indexOf('function levelOf')) + 2);
  const levelOf = new Function(`${src}; return levelOf;`)();
  assert.equal(levelOf('2026-11-21T10:00:05Z ERR Unable to reach the origin'), 'error');
  assert.equal(levelOf('2026-11-21T10:00:05Z WRN Retrying'), 'warn');
  assert.equal(levelOf('2026-11-21T10:00:05Z DBG detail'), 'debug');
  assert.equal(levelOf('time=x level=error msg=boom'), 'error');
  assert.equal(levelOf('2026-11-21T10:00:05Z INF Registered tunnel connection'), 'info');
  assert.equal(levelOf('NERVOUS but fine'), 'info');
  assert.match(APP_HTML, /x-model="logQuery"/);
  assert.match(APP_HTML, /x-model="logLevel"/);
});

test('HTTP: downloads and the combined stream need a session', async () => {
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/logs/acme-shop/download`)).status, 401);
    assert.equal((await fetch(`${d.base}/api/logs-all`)).status, 401);
    let r = await d.get('/api/logs/acme-shop/download');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="burrow-acme-shop-\d{8}-\d{6}\.log"$/);
    assert.match(await r.text(), /acme two/);
    assert.equal((await d.get('/api/logs/todo-api/download')).status, 404);
    assert.equal((await d.get('/api/logs/BAD..x/download')).status, 400);
    r = await d.get('/api/logs-all/download');
    assert.match(r.headers.get('content-disposition'), /burrow-all-/);
    assert.match(await r.text(), /^\[acme-shop\] /);

    const ctrl = new AbortController();
    const res = await fetch(`${d.base}/api/logs-all`, { headers: { cookie: d.cookie }, signal: ctrl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader();
    let text = '';
    const until = async (re) => { while (!re.test(text)) text += new TextDecoder().decode((await reader.read()).value); };
    await until(/acme two/);
    const events = text.split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => JSON.parse(e.slice(6)));
    assert.deepEqual(events.map((e) => e.p), ['acme-shop', 'acme-shop', 'blog', 'acme-shop']);
    appendFileSync(join(state, 'blog.log'), '2026-11-21T10:01:00Z INF blog later\n');
    writeFileSync(join(state, 'todo-api.log'), '2026-11-21T10:01:01Z INF new project\n');
    await until(/new project/);
    assert.match(text, /"p":"blog","l":"2026-11-21T10:01:00Z INF blog later"/);
    assert.match(text, /"p":"todo-api"/);
    ctrl.abort();
  } finally { await d.close(); }
});
