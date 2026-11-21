import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { openerCommand } from '../src/open.js';
import { sandbox, EXAMPLE } from './helpers/cli.js';

test('openerCommand', () => {
  assert.deepEqual(openerCommand('https://a.example.dev', 'linux', {}), ['xdg-open', ['https://a.example.dev']]);
  assert.deepEqual(openerCommand('https://a.example.dev', 'darwin', {}), ['open', ['https://a.example.dev']]);
  assert.deepEqual(openerCommand('https://a.example.dev', 'linux', { BROWSER: 'firefox' }), ['firefox', ['https://a.example.dev']]);
});

test('burrow url', async () => {
  const sb = sandbox();
  try {
    let r = await sb.run(['url', '-f', EXAMPLE]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, [
      'app     https://acme-shop.example.dev',
      'mail    https://mail-acme-shop.example.dev',
      'studio  https://studio-acme-shop.example.dev', ''].join('\n'));
    r = await sb.run(['url', '-f', EXAMPLE, '--plain']);
    assert.equal(r.stdout.split('\n')[0], 'https://acme-shop.example.dev');

    // by name, from the remembered file
    writeFileSync(join(sb.state, 'acme-shop.json'), JSON.stringify({ project: 'acme-shop', file: EXAMPLE }));
    r = await sb.run(['url', 'acme-shop']);
    assert.match(r.stdout, /mail +https:\/\/mail-acme-shop\.example\.dev/);

    // only saved hostnames (file gone)
    writeFileSync(join(sb.state, 'todo-api.json'), JSON.stringify({ project: 'todo-api', file: '/nope.yml', hostnames: ['todo-api.example.dev'] }));
    r = await sb.run(['url', 'todo-api', '--plain']);
    assert.equal(r.stdout, 'https://todo-api.example.dev\n');

    r = await sb.run(['url', 'unknown-project']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unknown project/);
    r = await sb.run(['url', 'burrow', '--plain']);
    assert.equal(r.stdout, 'https://burrow.example.dev\n');
  } finally {
    await sb.cleanup();
  }
});

test('burrow open', async () => {
  const sb = sandbox();
  try {
    const opened = join(sb.dir, 'opened.txt');
    const browser = join(sb.dir, 'fake-browser');
    writeFileSync(browser, `#!/bin/sh\necho "$1" >> "${opened}"\n`);
    chmodSync(browser, 0o755);
    copyFileSync(EXAMPLE, join(sb.dir, 'tunnel.yml'));
    const env = { BROWSER: browser };

    let r = await sb.run(['open'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Opening https:\/\/acme-shop\.example\.dev/);
    r = await sb.run(['open', 'acme-shop', 'studio'], { env });
    assert.equal(r.code, 0, r.stderr);
    r = await sb.run(['open', 'mail'], { env }); // single arg = service of ./tunnel.yml
    assert.equal(r.code, 0, r.stderr);
    for (let i = 0; i < 20 && !(existsSync(opened) && readFileSync(opened, 'utf8').split('\n').length > 3); i++) await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(readFileSync(opened, 'utf8').trim().split('\n'), [
      'https://acme-shop.example.dev', 'https://studio-acme-shop.example.dev', 'https://mail-acme-shop.example.dev',
    ]);

    r = await sb.run(['open', 'acme-shop', 'nope', '--print']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /has no service "nope" \(has: app, mail, studio\)/);
    r = await sb.run(['open', '--print', 'acme-shop', 'mail']);
    assert.equal(r.stdout, 'https://mail-acme-shop.example.dev\n');
    r = await sb.run(['open', '--print'], { env: { BROWSER: '/nonexistent/browser' } });
    assert.equal(r.stdout, 'https://acme-shop.example.dev\n');
    r = await sb.run(['open'], { env: { BROWSER: '/nonexistent/browser' } });
    assert.match(r.stdout, /Couldn't start a browser .* Open https:\/\/acme-shop\.example\.dev/);
  } finally {
    await sb.cleanup();
  }
});
