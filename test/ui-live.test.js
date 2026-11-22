import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
process.env.BURROW_LIVE_MS = '150';
process.env.BURROW_LIVE_MAX_CLIENTS = '2';
const { payloadHash } = await import('../src/dashboard/panels/live.js');
const { events } = await import('../src/dashboard/panels.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

// Read server-sent events from a fetch response; read(until) collects new events until until(events).
function sse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  return {
    cancel: () => reader.cancel(),
    async read(until, ms = 5000) {
      const out = [];
      const deadline = Date.now() + ms;
      while (!until(out)) {
        if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(out.map((e) => e.event))}`);
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = { event: 'message', data: '' };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
            else if (line.startsWith('retry: ')) ev.retry = Number(line.slice(7));
          }
          out.push(ev);
        }
      }
      return out;
    },
  };
}

test('payloadHash ignores now', () => {
  assert.equal(payloadHash({ now: 1, projects: [] }), payloadHash({ now: 2, projects: [] }));
  assert.notEqual(payloadHash({ projects: [] }), payloadHash({ projects: [{ project: 'blog' }] }));
});

test('HTTP: /api/stream needs a session, ticks, sends changed, and caps clients', async () => {
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/stream`)).status, 401);
    const a = await d.get('/api/stream');
    assert.equal(a.status, 200);
    assert.match(a.headers.get('content-type'), /^text\/event-stream/);
    const stream = sse(a);
    let got = await stream.read((ev) => ev.filter((e) => e.event === 'tick').length >= 2);
    assert.equal(got[0].event, 'hello');
    assert.equal(got[0].retry, 3000);
    assert.ok(got.filter((e) => e.event === 'tick').every((e) => typeof e.data.now === 'number'));
    assert.ok(!got.some((e) => e.event === 'changed'), 'nothing changed yet');

    // A new remembered project changes the payload.
    const dir = join(sb.dir, 'todo-api');
    writeFileSync(join(sb.state, 'todo-api.json'), JSON.stringify({ project: 'todo-api', file: join(dir, 'tunnel.yml') }));
    writeFileSync(join(sb.state, 'todo-api.pid'), '999999');
    got = await stream.read((ev) => ev.some((e) => e.event === 'changed'));
    assert.ok(got.some((e) => e.event === 'changed'));

    const b = await d.get('/api/stream');
    assert.equal(b.status, 200);
    const c = await d.get('/api/stream');
    assert.equal(c.status, 503, 'capped at BURROW_LIVE_MAX_CLIENTS');
    assert.equal(c.headers.get('retry-after'), '30');
    await stream.cancel();
    await b.body.cancel();
    events.emit('event', { action: 'up', project: 'blog' });
  } finally { await d.close(); }
});

test('BURROW_DASHBOARD_LIVE=off disables the stream; the page still has the indicator', async () => {
  process.env.BURROW_DASHBOARD_LIVE = 'off';
  const d = await startDashboard();
  try {
    assert.equal((await d.get('/api/stream')).status, 404);
    assert.match(await (await d.get('/')).text(), /class="live-status"/);
    assert.match(await (await d.get('/panels.js')).text(), /new EventSource\('\/api\/stream'\)/);
  } finally { delete process.env.BURROW_DASHBOARD_LIVE; await d.close(); }
});
