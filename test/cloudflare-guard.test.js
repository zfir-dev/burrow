import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, Cloudflare, CloudflareError } from '../src/cloudflare.js';
import { sandbox, DEAD_API } from './helpers/cli.js';

const REAL = 'https://api.cloudflare.com/client/v4';

test('apiBase refuses the real Cloudflare API while tests run', () => {
  assert.throws(() => apiBase({ NODE_TEST_CONTEXT: 'child' }), CloudflareError);
  assert.throws(() => apiBase({ NODE_TEST_CONTEXT: 'child', BURROW_CF_API_BASE: REAL }), /Refusing to call the real Cloudflare API/);
  assert.equal(apiBase({ NODE_TEST_CONTEXT: 'child', BURROW_CF_API_BASE: 'http://127.0.0.1:9999' }), 'http://127.0.0.1:9999');
  assert.equal(apiBase({}), REAL, 'normal use still talks to Cloudflare');
});

test('a Cloudflare client in a test fails before any request goes out', async () => {
  const saved = { base: process.env.BURROW_CF_API_BASE, ctx: process.env.NODE_TEST_CONTEXT, fetch: globalThis.fetch };
  const calls = [];
  globalThis.fetch = async (...a) => { calls.push(a); throw new Error('network'); };
  delete process.env.BURROW_CF_API_BASE;
  process.env.NODE_TEST_CONTEXT ||= 'child';
  try {
    const cf = new Cloudflare({ token: 'test-token', accountId: 'acct-1', zoneId: 'zone-1' });
    await assert.rejects(cf.req('GET', '/user/tokens/verify'), /Refusing to call the real Cloudflare API/);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.base === undefined) delete process.env.BURROW_CF_API_BASE; else process.env.BURROW_CF_API_BASE = saved.base;
    if (saved.ctx === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = saved.ctx;
  }
});

test('the CLI sandbox never uses the real config, state or API', async () => {
  const sb = sandbox();
  try {
    assert.equal(sb.env.BURROW_CF_API_BASE, DEAD_API);
    assert.ok(sb.env.BURROW_CONFIG.startsWith(sb.dir));
    assert.ok(sb.env.BURROW_STATE_DIR.startsWith(sb.dir));
    // Even with the mock unset, a spawned CLI under test refuses the real API.
    const r = await sb.run(['ls'], { env: { BURROW_CF_API_BASE: '', NODE_TEST_CONTEXT: 'child' } });
    assert.notEqual(r.code, 0);
    assert.match(r.stdout + r.stderr, /Refusing to call the real Cloudflare API/);
  } finally { await sb.cleanup(); }
});
