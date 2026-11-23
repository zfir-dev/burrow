import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, EXAMPLE } from './helpers/cli.js';
import { mockCloudflare } from './helpers/mock-cf.js';
import { pickEditor } from '../src/edit.js';

// Fake editor: logs its arguments, then replaces the file with $FAKE_EDIT_SOURCE (if set).
function fakeEditor(dir, name = 'fake-editor') {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, name);
  writeFileSync(path, '#!/bin/sh\nfor f; do last="$f"; done\necho "$@" >> "$FAKE_EDIT_LOG"\n' +
    'if [ -n "$FAKE_EDIT_SOURCE" ]; then cat "$FAKE_EDIT_SOURCE" > "$last"; fi\n');
  chmodSync(path, 0o755);
  return path;
}

function setup(api) {
  const sb = sandbox({ api });
  const project = join(sb.dir, 'acme-shop');
  mkdirSync(project);
  const file = join(project, 'tunnel.yml');
  copyFileSync(EXAMPLE, file);
  const editor = fakeEditor(sb.dir);
  const logFile = join(sb.dir, 'editor.log');
  // TMPDIR inside the sandbox, so kept edit copies are removed with it.
  const env = (extra = {}) => ({ VISUAL: '', EDITOR: editor, FAKE_EDIT_LOG: logFile, FAKE_EDIT_SOURCE: '', TMPDIR: sb.dir, ...extra });
  const content = (name, text) => { const p = join(sb.dir, name); writeFileSync(p, text); return p; };
  return { sb, project, file, editor, logFile, env, content };
}

const withDocs = (text) => text + '  - name: docs\n    url: http://localhost:4100\n';

test('pickEditor prefers VISUAL, then EDITOR, then vi or nano on PATH', () => {
  assert.equal(pickEditor({ VISUAL: 'code --wait', EDITOR: 'nano', PATH: '' }), 'code --wait');
  assert.equal(pickEditor({ VISUAL: '', EDITOR: 'micro', PATH: '' }), 'micro');
  assert.equal(pickEditor({ PATH: '' }), null);
});

test('no changes leaves the file alone', async () => {
  const t = setup();
  try {
    const before = readFileSync(t.file, 'utf8');
    const r = await t.sb.run(['edit'], { cwd: t.project, env: t.env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /No changes/);
    assert.equal(readFileSync(t.file, 'utf8'), before);
    assert.match(readFileSync(t.logFile, 'utf8'), /tunnel\.yml/);
  } finally { await t.sb.cleanup(); }
});

test('a valid edit is saved; a stopped project is not started', async () => {
  const t = setup();
  try {
    const next = withDocs(readFileSync(t.file, 'utf8'));
    const r = await t.sb.run(['edit'], { cwd: t.project, env: t.env({ FAKE_EDIT_SOURCE: t.content('next.yml', next) }) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Saved .*4 service\(s\)/);
    assert.match(r.stdout, /not running\. Start it with: burrow up -f /);
    assert.equal(readFileSync(t.file, 'utf8'), next);
  } finally { await t.sb.cleanup(); }
});

test('an invalid hooks: section is rejected like any other error', async () => {
  const t = setup();
  try {
    const before = readFileSync(t.file, 'utf8');
    for (const [hooks, error] of [
      ['hooks:\n  after_up: echo hi\n', /hooks\.after_up: unknown hook/],
      ['hooks:\n  post_up:\n    run: echo hi\n    background: true\n', /only pre_up can run in the background/],
      ['hooks:\n  pre_up:\n    run: npm run migrate\n    timout: 30\n', /unknown key\(s\) timout/],
      ['hooks: echo hi\n', /"hooks" must be a mapping/],
    ]) {
      const r = await t.sb.run(['edit'], { cwd: t.project, env: t.env({ FAKE_EDIT_SOURCE: t.content('bad-hooks.yml', before + hooks) }) });
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stderr, error);
      assert.match(r.stderr, /unchanged\. Your edits are in /);
      assert.equal(readFileSync(t.file, 'utf8'), before);
    }
    const good = before + 'hooks:\n  pre_up: npm run migrate\n  post_down:\n    run: echo bye\n    timeout: 10\n';
    const r = await t.sb.run(['edit'], { cwd: t.project, env: t.env({ FAKE_EDIT_SOURCE: t.content('good-hooks.yml', good) }) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(t.file, 'utf8'), good);
  } finally { await t.sb.cleanup(); }
});

test('an invalid edit is rejected and the original is kept', async () => {
  const t = setup();
  try {
    const before = readFileSync(t.file, 'utf8');
    const bad = t.content('bad.yml', 'project: Acme Shop\nservices: []\n');
    const r = await t.sb.run(['edit'], { cwd: t.project, env: t.env({ FAKE_EDIT_SOURCE: bad }) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Invalid project name/);
    assert.match(r.stderr, /unchanged\. Your edits are in /);
    assert.equal(readFileSync(t.file, 'utf8'), before);
    const kept = r.stderr.match(/Your edits are in (\S+)/)[1];
    assert.equal(readFileSync(kept, 'utf8'), readFileSync(bad, 'utf8'));
  } finally { await t.sb.cleanup(); }
});

test('running project: --yes applies, --no-apply and non-TTY do not', async () => {
  const cf = await mockCloudflare();
  const t = setup(cf.url);
  try {
    let r = await t.sb.run(['up'], { cwd: t.project });
    assert.equal(r.code, 0, r.stderr);
    const hosts = () => cf.state.configs[cf.live()[0].id].ingress.map((x) => x.hostname).filter(Boolean);
    assert.ok(!hosts().includes('docs-acme-shop.example.dev'));

    const v1 = t.content('v1.yml', withDocs(readFileSync(t.file, 'utf8')));
    r = await t.sb.run(['edit', '--no-apply'], { cwd: t.project, env: t.env({ FAKE_EDIT_SOURCE: v1 }) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Not applied \(--no-apply\)/);
    assert.ok(!hosts().includes('docs-acme-shop.example.dev'));

    const v2 = t.content('v2.yml', readFileSync(v1, 'utf8').replace('4100', '4200'));
    r = await t.sb.run(['edit'], { cwd: t.project, env: t.env({ FAKE_EDIT_SOURCE: v2 }) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /not a terminal\. Pass --yes/);
    assert.ok(!hosts().includes('docs-acme-shop.example.dev'));

    const v3 = t.content('v3.yml', readFileSync(v2, 'utf8').replace('4200', '4300'));
    r = await t.sb.run(['edit', 'acme-shop', '--yes'], { cwd: t.sb.dir, env: t.env({ FAKE_EDIT_SOURCE: v3 }) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Stopped previous cloudflared/);
    assert.ok(hosts().includes('docs-acme-shop.example.dev'));
    assert.equal(cf.live().length, 1);
    const docs = cf.state.configs[cf.live()[0].id].ingress.find((x) => x.hostname === 'docs-acme-shop.example.dev');
    assert.equal(docs.service, 'http://localhost:4300');
  } finally { await t.sb.cleanup(); await cf.close(); }
});

test('falls back to vi on PATH and passes EDITOR arguments through', async () => {
  const t = setup();
  try {
    const vi = fakeEditor(t.sb.dir, 'vi');
    let r = await t.sb.run(['edit', '-f', t.file], {
      env: t.env({ EDITOR: '', PATH: `${join(t.sb.dir, 'bin')}:/usr/bin:/bin` }),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(vi));
    assert.match(readFileSync(t.logFile, 'utf8'), /acme-shop\.tunnel\.yml|tunnel\.yml/);

    r = await t.sb.run(['edit', '-f', t.file], { env: t.env({ EDITOR: `${t.editor} --wait` }) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(t.logFile, 'utf8'), /--wait \S+tunnel\.yml/);
  } finally { await t.sb.cleanup(); }
});

test('editor exit code aborts without saving; unknown project errors', async () => {
  const t = setup();
  try {
    const before = readFileSync(t.file, 'utf8');
    let r = await t.sb.run(['edit'], { cwd: t.project, env: t.env({ EDITOR: 'false' }) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Editor exited with code 1/);
    assert.equal(readFileSync(t.file, 'utf8'), before);
    r = await t.sb.run(['edit', 'todo-api'], { cwd: t.sb.dir, env: t.env() });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no remembered file for "todo-api"/);
  } finally { await t.sb.cleanup(); }
});
