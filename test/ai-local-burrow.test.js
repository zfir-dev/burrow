// LocalBurrow runs burrow's own share/status/logs/down code in-process, here against the
// mock Cloudflare API and a fake cloudflared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';
import { LocalBurrow, toError } from '../src/ai/local-burrow.js';
import { logFile, readMeta, runningPid } from '../src/process.js';
import { historyFile } from '../src/history.js';

test('share, status, logs and stop a share-<name> in-process', async (t) => {
  const cf = await mockCloudflare();
  t.after(() => cf.close?.());
  const sb = sandbox({ api: cf.url });
  const keys = ['BURROW_CONFIG', 'BURROW_STATE_DIR', 'BURROW_CF_API_BASE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = sb.env[k];
  t.after(async () => {
    await sb.cleanup();
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  const burrow = new LocalBurrow();
  const r = await burrow.share('pixel-demo', 8080);
  assert.deepEqual(r, { url: 'https://pixel-demo.example.dev', hostname: 'pixel-demo.example.dev', project: 'share-pixel-demo' });
  assert.deepEqual(cf.live().map((x) => x.name), ['burrow-share-pixel-demo']);
  assert.ok(runningPid('share-pixel-demo'), 'cloudflared (fake) is running');
  assert.equal(readMeta('share-pixel-demo').share, true);

  const st = await burrow.status('pixel-demo');
  assert.equal(st.running, true);
  assert.deepEqual(st.hostnames, ['pixel-demo.example.dev']);
  assert.ok(st.tunnel);

  appendFileSync(logFile('share-pixel-demo'), 'INF line one\nINF token=abcdef123 two\n');
  const lines = await burrow.logs('pixel-demo', 2);
  assert.deepEqual(lines, ['INF line one', 'INF token=[redacted] two']);

  await assert.rejects(burrow.share('pixel-demo', 8081), { code: 'NAME_TAKEN' });
  await burrow.stop('pixel-demo');
  assert.deepEqual(cf.live(), []);
  assert.deepEqual(cf.state.records, []);
  assert.equal(readMeta('share-pixel-demo'), null);
  await burrow.stop('pixel-demo'); // already gone: no error
  await assert.rejects(burrow.logs('never-made', 5), { code: 'TUNNEL_NOT_FOUND' });

  const events = readFileSync(historyFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => [e.action, e.project, e.detail]), [
    ['share', 'share pixel-demo', 'burrow ai: port 8080'],
    ['down', 'share-pixel-demo', 'burrow ai'],
  ]);
});

test('stop refuses a non-share project that happens to be named share-*', async (t) => {
  const sb = sandbox();
  const saved = process.env.BURROW_STATE_DIR;
  process.env.BURROW_STATE_DIR = sb.env.BURROW_STATE_DIR;
  t.after(async () => { await sb.cleanup(); if (saved === undefined) delete process.env.BURROW_STATE_DIR; else process.env.BURROW_STATE_DIR = saved; });
  const { saveMeta } = await import('../src/process.js');
  saveMeta('share-acme-shop', { project: 'share-acme-shop', file: '/srv/acme/tunnel.yml' });
  await assert.rejects(new LocalBurrow().stop('acme-shop'), { code: 'NOT_ALLOWED' });
  assert.ok(existsSync(join(sb.env.BURROW_STATE_DIR, 'share-acme-shop.json')));
});

test('toError maps burrow messages to protocol codes and redacts', () => {
  assert.equal(toError(new Error('acme.example.dev already has DNS records; pick another --name.')).code, 'NAME_TAKEN');
  const e = toError(new Error(`Cloudflare API error: token=${'x'.repeat(10)}`));
  assert.equal(e.code, 'BURROW_ERROR');
  assert.ok(!e.message.includes('xxxxxxxxxx'));
});
