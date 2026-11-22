import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;

// A fake git: canned answers for `update --check`, every call logged. No network.
const gitLog = join(sb.dir, 'git.log');
const fakeGit = join(sb.dir, 'fake-git');
writeFileSync(fakeGit, `#!/bin/sh
echo "$*" >> "${gitLog}"
case "$*" in
  "rev-parse --show-toplevel") pwd -P ;;
  "rev-parse --abbrev-ref HEAD") echo main ;;
  "rev-parse --abbrev-ref --symbolic-full-name @{u}") echo origin/main ;;
  "fetch --quiet") [ -n "$FAKE_GIT_FAIL" ] && { echo "fatal: unable to access 'https://user:hunter2@example.dev/burrow.git/'" >&2; exit 128; }; true ;;
  "rev-parse HEAD") echo 1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  "rev-parse @{u}") echo 2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
  "rev-list --count HEAD..@{u}") echo 2 ;;
  "rev-list --count @{u}..HEAD") echo 0 ;;
  log*) printf '2222222 feat: something new\\n1a2b3c4 fix: something else\\n' ;;
  "show @{u}:package.json") echo '{"version":"9.9.9"}' ;;
  *) echo "fake git: $*" >&2; exit 1 ;;
esac
`);
chmodSync(fakeGit, 0o755);
process.env.BURROW_GIT = fakeGit;

const { readHookResults, hookResultsFile } = await import('../src/hooks.js');
const { parseCheck, scrub, cacheFile } = await import('../src/dashboard/panels/updates.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

test('hook runs are recorded without the command; failures keep the reason', async () => {
  const dir = join(sb.dir, 'acme-shop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tunnel.yml'), `project: acme-shop
services:
  - name: app
    url: http://localhost:3000
hooks:
  pre_up: echo SECRET_TOKEN=abc123 > /dev/null
  post_up: exit 3
  pre_down: "true"
`);
  let r = await sb.run(['up'], { cwd: dir });
  assert.equal(r.code, 1, 'post_up failure sets the exit code');
  r = await sb.run(['down', 'acme-shop']);
  assert.equal(r.code, 0, r.stderr);
  const got = readHookResults();
  assert.deepEqual(got.map((x) => [x.hook, x.ok]), [['pre_down', true], ['post_up', false], ['pre_up', true]]);
  assert.equal(got[1].error, 'post_up hook failed (exit 3)');
  assert.ok(got.every((x) => x.project === 'acme-shop' && x.source === 'cli' && x.durationMs >= 0));
  const raw = readFileSync(hookResultsFile(), 'utf8');
  assert.ok(!raw.includes('SECRET_TOKEN') && !raw.includes('(exit 3): exit 3'), 'no commands in the results');
  await sb.run(['up', '--dry-run'], { cwd: dir });
  assert.equal(readHookResults().length, 3, 'dry runs are not recorded');
});

test('update --check --json uses BURROW_GIT; parseCheck and scrub', async () => {
  const env = { env: { BURROW_GIT: fakeGit } }; // the sandbox env predates BURROW_GIT
  const r = await sb.run(['update', '--check', '--json'], env);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.mode, 'git');
  assert.equal(j.available, true);
  assert.deepEqual([j.head, j.latest, j.behind, j.remoteVersion], ['1111111', '2222222', 2, '9.9.9']);
  assert.deepEqual(j.commits, ['2222222 feat: something new', '1a2b3c4 fix: something else']);
  assert.match(readFileSync(gitLog, 'utf8'), /^fetch --quiet$/m, 'the fake git did the fetch');
  assert.equal((await sb.run(['update', '--json'], env)).code, 1, '--json needs --check');
  assert.deepEqual(parseCheck('noise\n{"available":false,"version":"1.0.0"}\n'), { available: false, version: '1.0.0' });
  assert.equal(parseCheck('nothing'), null);
  assert.equal(scrub("unable to access 'https://user:hunter2@example.dev/x.git/'"), "unable to access 'https://example.dev/x.git/'");
});

test('HTTP: /api/hooks and lastHook; /api/update caches the check and can be turned off', async () => {
  const d = await startDashboard();
  try {
    assert.equal((await fetch(`${d.base}/api/hooks`)).status, 401);
    let j = await (await d.get('/api/hooks?project=acme-shop')).json();
    assert.equal(j.results.length, 3);
    assert.equal((await d.get('/api/hooks?project=Bad%20Name')).status, 400);
    const t = await (await d.get('/api/tunnels')).json();
    assert.deepEqual(t.projects.find((p) => p.project === 'acme-shop').lastHook.hook, 'pre_down');

    assert.equal((await fetch(`${d.base}/api/update`)).status, 401);
    assert.equal((await fetch(`${d.base}/api/update/check`, { method: 'POST', headers: { cookie: d.cookie } })).status, 403);
    let r = await d.post('/api/update/check', {});
    j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.result.available, true);
    assert.equal(j.error, null);
    assert.ok(existsSync(cacheFile()));
    const fetches = () => readFileSync(gitLog, 'utf8').split('\n').filter((l) => l === 'fetch --quiet').length;
    const before = fetches();
    j = await (await d.get('/api/update')).json();
    assert.equal(j.checking, false, 'fresh cache: no new check');
    assert.equal(j.result.latest, '2222222');
    assert.equal(fetches(), before);

    // A failing check keeps the last result and never shows credentials.
    process.env.FAKE_GIT_FAIL = '1';
    j = await (await d.post('/api/update/check', {})).json();
    delete process.env.FAKE_GIT_FAIL;
    assert.match(j.error, /unable to access 'https:\/\/example\.dev\/burrow\.git\/'/);
    assert.ok(!JSON.stringify(j).includes('hunter2'));
    assert.equal(j.result.latest, '2222222');

    process.env.BURROW_UPDATE_CHECK = 'off';
    const n = fetches();
    j = await (await d.get('/api/update')).json();
    assert.equal(j.enabled, false);
    assert.equal((await d.post('/api/update/check', {})).status, 200);
    assert.equal(fetches(), n, 'off means no git calls');
    delete process.env.BURROW_UPDATE_CHECK;
    const page = await (await d.get('/')).text();
    assert.match(page, /Update available/);
    assert.match(page, /Hook runs/);
  } finally { await d.close(); }
});
