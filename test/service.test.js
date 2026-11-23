import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderUnit } from '../src/service.js';
import { parseProject } from '../src/project.js';
import { sandbox } from './helpers/cli.js';

test('renderUnit', () => {
  const unit = renderUnit({
    node: '/opt/node/bin/node', bin: '/opt/burrow/bin/burrow.js', projects: ['acme-shop', 'todo-api'],
    env: { PATH: '/usr/bin:/bin', BURROW_CONFIG: '/home/me/my config.env', HOME: '/home/me' },
    systemdRun: null,
  });
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^RemainAfterExit=yes$/m);
  assert.match(unit, /^ExecStart=\/opt\/node\/bin\/node \/opt\/burrow\/bin\/burrow\.js autostart acme-shop todo-api$/m);
  assert.match(unit, /^ExecStop=\/opt\/node\/bin\/node \/opt\/burrow\/bin\/burrow\.js down --keep-shares$/m);
  assert.match(unit, /^KillMode=process$/m, 'stopping the unit leaves its detached children (shares, dashboard) alone');
  assert.match(unit, /^Environment=PATH=\/usr\/bin:\/bin$/m);
  assert.match(unit, /^Environment="BURROW_CONFIG=\/home\/me\/my config\.env"$/m);
  assert.doesNotMatch(unit, /HOME=/);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test('tunnel.yml autostart flag', () => {
  assert.equal(parseProject('project: blog\nautostart: true\nservices:\n  - {name: app, url: "http://localhost:4000"}\n').autostart, true);
  assert.equal(parseProject('project: blog\nservices:\n  - {name: app, url: "http://localhost:4000"}\n').autostart, false);
});

function remember(sb, project, yml) {
  const file = join(sb.dir, `${project}.yml`);
  writeFileSync(file, yml);
  writeFileSync(join(sb.state, `${project}.json`), JSON.stringify({ project, file }));
}

test('autostart picks BURROW_AUTOSTART plus autostart: true projects', async () => {
  const sb = sandbox({ extra: { BURROW_AUTOSTART: 'pixel-notes, todo-api' } });
  try {
    remember(sb, 'acme-shop', 'project: acme-shop\nautostart: true\nservices:\n  - {name: app, url: "http://localhost:3100"}\n');
    remember(sb, 'blog', 'project: blog\nservices:\n  - {name: app, url: "http://localhost:4000"}\n');
    let r = await sb.run(['autostart', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /would bring up: pixel-notes, todo-api, acme-shop$/m);
    r = await sb.run(['autostart', 'blog', '--dry-run']);
    assert.match(r.stdout, /would bring up: blog$/m);
  } finally {
    await sb.cleanup();
  }
});

test('service install / status / uninstall with a fake systemctl', async () => {
  const sb = sandbox();
  try {
    const unitDir = join(sb.dir, 'systemd');
    const calls = join(sb.dir, 'systemctl.log');
    const fake = join(sb.dir, 'fake-systemctl');
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${calls}"\ncase "$2" in is-enabled) echo enabled;; is-active) echo active;; esac\n`);
    chmodSync(fake, 0o755);
    mkdirSync(unitDir);
    const env = { BURROW_SYSTEMD_DIR: unitDir, BURROW_SYSTEMCTL: fake };

    let r = await sb.run(['service', 'install', '--dry-run', '--projects', 'acme-shop'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /autostart acme-shop/);
    assert.ok(!existsSync(join(unitDir, 'burrow.service')));

    r = await sb.run(['service', 'install', '--projects', 'acme-shop,todo-api', '--now'], { env });
    assert.equal(r.code, 0, r.stderr);
    const unit = readFileSync(join(unitDir, 'burrow.service'), 'utf8');
    assert.match(unit, /autostart acme-shop todo-api$/m);
    assert.match(unit, new RegExp(`BURROW_STATE_DIR=${sb.state.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['--user daemon-reload', '--user enable --now burrow.service']);

    r = await sb.run(['service', 'status'], { env });
    assert.match(r.stdout, /Enabled: enabled/);
    assert.match(r.stdout, /Active: active/);

    r = await sb.run(['service', 'uninstall'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(unitDir, 'burrow.service')));
    assert.match(readFileSync(calls, 'utf8'), /--user disable --now burrow\.service/);

    r = await sb.run(['service', 'bogus'], { env });
    assert.equal(r.code, 1);
  } finally {
    await sb.cleanup();
  }
});
