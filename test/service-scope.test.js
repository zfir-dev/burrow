import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers/cli.js';
import { renderUnit, findSystemdRun, unitProblem, unitOutdated } from '../src/service.js';

const sb = sandbox();
const unitDir = join(sb.dir, 'systemd');
mkdirSync(unitDir);
const fakeCtl = join(sb.dir, 'fake-systemctl');
writeFileSync(fakeCtl, '#!/bin/sh\ncase "$2" in is-enabled) echo enabled;; is-active) echo active;; esac\n');
chmodSync(fakeCtl, 0o755);
const fakeRun = join(sb.dir, 'systemd-run');
writeFileSync(fakeRun, '#!/bin/sh\nexit 0\n');
chmodSync(fakeRun, 0o755);
const unit = join(unitDir, 'burrow.service');
const envWith = (run) => ({ BURROW_SYSTEMD_DIR: unitDir, BURROW_SYSTEMCTL: fakeCtl, BURROW_SYSTEMD_RUN: run });
test.after(() => sb.cleanup());

test('findSystemdRun honours BURROW_SYSTEMD_RUN, "none" and PATH', () => {
  assert.equal(findSystemdRun({ BURROW_SYSTEMD_RUN: 'none' }), null);
  assert.equal(findSystemdRun({ BURROW_SYSTEMD_RUN: '/opt/sd/systemd-run' }), '/opt/sd/systemd-run');
  assert.equal(findSystemdRun({ PATH: `/nonexistent:${sb.dir}` }), fakeRun);
  assert.equal(findSystemdRun({ PATH: '/nonexistent' }), null);
});

test('renderUnit starts the boot command in a transient scope when systemd-run exists', () => {
  const opts = { node: '/opt/node/bin/node', bin: '/opt/burrow/bin/burrow.js', projects: ['acme-shop'], env: {} };
  const scoped = renderUnit({ ...opts, systemdRun: '/usr/bin/systemd-run' });
  assert.match(scoped, /^ExecStart=\/usr\/bin\/systemd-run --user --scope --quiet "--description=burrow: tunnels, dashboard and shares" \/opt\/node\/bin\/node \/opt\/burrow\/bin\/burrow\.js autostart acme-shop$/m);
  assert.match(scoped, /^ExecStop=\/opt\/node\/bin\/node \/opt\/burrow\/bin\/burrow\.js down --keep-shares$/m, 'stop is not scoped');
  assert.match(scoped, /^KillMode=process$/m);
  const plain = renderUnit({ ...opts, systemdRun: null });
  assert.match(plain, /^ExecStart=\/opt\/node\/bin\/node \/opt\/burrow\/bin\/burrow\.js autostart acme-shop$/m);
  assert.doesNotMatch(plain, /systemd-run|--scope/);
});

test('install writes a scoped unit with the mocked systemd-run, and falls back without it', async () => {
  let r = await sb.run(['service', 'install'], { env: envWith(fakeRun) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(readFileSync(unit, 'utf8'), new RegExp(`^ExecStart=${fakeRun.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --user --scope `, 'm'));
  r = await sb.run(['service', 'install'], { env: envWith('none') });
  assert.equal(r.code, 0, r.stderr);
  const text = readFileSync(unit, 'utf8');
  assert.doesNotMatch(text, /--scope/);
  assert.match(text, /^KillMode=process$/m);
});

test('a KillMode=process unit without a scope is outdated only when systemd-run is available', async () => {
  await sb.run(['service', 'install'], { env: envWith('none') });
  assert.equal(unitProblem(unit, null), null);
  assert.equal(unitOutdated(unit, null), false);
  assert.equal(unitProblem(unit, fakeRun), 'scope');
  let r = await sb.run(['service', 'status'], { env: envWith(fakeRun) });
  assert.match(r.stdout, /Outdated: its boot command is not started in a systemd scope/);
  r = await sb.run(['service', 'status'], { env: envWith('none') });
  assert.doesNotMatch(r.stdout, /Outdated/);
  r = await sb.run(['service', 'install'], { env: envWith(fakeRun) });
  assert.match(r.stdout, /replaced an older unit/);
  assert.equal(unitProblem(unit, fakeRun), null);
  r = await sb.run(['service', 'status'], { env: envWith(fakeRun) });
  assert.doesNotMatch(r.stdout, /Outdated/);
});

test('a unit with no KillMode keeps the original outdated message', async () => {
  writeFileSync(unit, '[Service]\nExecStart=/usr/bin/node /x/burrow.js autostart\n');
  assert.equal(unitProblem(unit, fakeRun), 'killmode');
  const r = await sb.run(['service', 'status'], { env: envWith(fakeRun) });
  assert.match(r.stdout, /Outdated: written by an older burrow/);
});
