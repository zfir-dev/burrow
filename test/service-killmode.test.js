import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';

const cf = await mockCloudflare();
const sb = sandbox({ api: cf.url });
const unitDir = join(sb.dir, 'systemd');
mkdirSync(unitDir);
const calls = join(sb.dir, 'systemctl.log');
const fake = join(sb.dir, 'fake-systemctl');
writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${calls}"\ncase "$2" in is-enabled) echo enabled;; is-active) echo active;; esac\n`);
chmodSync(fake, 0o755);
const env = { BURROW_SYSTEMD_DIR: unitDir, BURROW_SYSTEMCTL: fake, BURROW_SYSTEMD_RUN: 'none' };
process.env.BURROW_CONFIG = sb.config;
process.env.BURROW_STATE_DIR = sb.state;
process.env.BURROW_CF_API_BASE = cf.url;
process.env.BURROW_SYSTEMD_DIR = unitDir;
process.env.BURROW_SYSTEMCTL = fake;
process.env.BURROW_SYSTEMD_RUN = 'none';
const { unitOutdated } = await import('../src/service.js');
const { startDashboard } = await import('./helpers/dash.js');
test.after(async () => { await sb.cleanup(); await cf.close(); });

// What "burrow service install" wrote before KillMode=process.
const OLD_UNIT = `[Unit]\nDescription=burrow\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/node /opt/burrow/bin/burrow.js autostart\nExecStop=/usr/bin/node /opt/burrow/bin/burrow.js down\n\n[Install]\nWantedBy=default.target\n`;

test('an older unit is reported as outdated and "service install" upgrades it', async () => {
  writeFileSync(join(unitDir, 'burrow.service'), OLD_UNIT);
  assert.equal(unitOutdated(join(unitDir, 'burrow.service')), true);
  let r = await sb.run(['service', 'status'], { env });
  assert.match(r.stdout, /Outdated: written by an older burrow: stopping or restarting it also kills shares/);
  r = await sb.run(['service', 'install'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /replaced an older unit/);
  const unit = readFileSync(join(unitDir, 'burrow.service'), 'utf8');
  assert.match(unit, /^KillMode=process$/m);
  assert.match(unit, /burrow\.js down --keep-shares$/m);
  assert.equal(unitOutdated(join(unitDir, 'burrow.service')), false);
  r = await sb.run(['service', 'status'], { env });
  assert.doesNotMatch(r.stdout, /Outdated/);
  r = await sb.run(['service', 'install'], { env });
  assert.doesNotMatch(r.stdout, /replaced/);
});

test('HTTP: the boot bar reports an outdated unit and offers Update', async () => {
  writeFileSync(join(unitDir, 'burrow.service'), OLD_UNIT);
  const d = await startDashboard();
  try {
    let j = await (await d.get('/api/boot')).json();
    assert.equal(j.outdated, true);
    const r = await d.post('/api/boot', { action: 'install' });
    j = await r.json();
    assert.equal(r.status, 200, j.output);
    assert.equal(j.outdated, false);
    assert.match(await (await d.get('/panels.js')).text(), /'Update'/);
  } finally { await d.close(); }
});

test('down --keep-shares (the service stop command) stops projects but leaves shares running', async () => {
  const dir = join(sb.dir, 'acme-shop');
  mkdirSync(dir);
  writeFileSync(join(dir, 'tunnel.yml'), 'project: acme-shop\nservices:\n  - name: app\n    url: http://localhost:4000\n');
  let r = await sb.run(['up'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  r = await sb.run(['share', '3000', '--name', 'pixel-demo', '--detach']);
  assert.equal(r.code, 0, r.stderr);
  r = await sb.run(['down', '--keep-shares']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /acme-shop: stopped cloudflared/);
  assert.doesNotMatch(r.stdout, /share-pixel-demo/);
  r = await sb.run(['status', 'share-pixel-demo', '--json']);
  assert.equal(JSON.parse(r.stdout).running, true, 'share still running');
  assert.ok(cf.state.records.some((x) => x.name === 'pixel-demo.example.dev'));
  r = await sb.run(['down']);
  assert.match(r.stdout, /share-pixel-demo: share removed/);
});
