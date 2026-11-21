import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toUrl, slug, parsePair, buildDoc, renderYaml, add } from '../src/add.js';
import { parseProject, buildIngress } from '../src/project.js';
import { sandbox } from './helpers/cli.js';

test('toUrl and slug', () => {
  assert.equal(toUrl('3100'), 'http://localhost:3100');
  assert.equal(toUrl('db.local:5432'), 'http://db.local:5432');
  assert.equal(toUrl('https://localhost:8443'), 'https://localhost:8443');
  assert.equal(slug('Acme Shop!'), 'acme-shop');
  assert.deepEqual(parsePair('mail=54324', '--service'), ['mail', 'http://localhost:54324']);
  assert.throws(() => parsePair('mail', '--service'), /name=port-or-url/);
});

test('buildDoc + renderYaml produce a valid tunnel.yml', () => {
  const doc = buildDoc({
    project: 'acme-shop', app: '3100',
    paths: [['/auth/v1', '54321'], ['/rest/v1', '54321']],
    services: [['mail', '54324'], ['studio', '54323']],
  });
  const proj = parseProject(renderYaml(doc));
  assert.deepEqual(buildIngress(proj, 'example.dev').map((r) => [r.hostname, r.path, r.service]), [
    ['acme-shop.example.dev', '^/auth/v1(/.*)?$', 'http://localhost:54321'],
    ['acme-shop.example.dev', '^/rest/v1(/.*)?$', 'http://localhost:54321'],
    ['acme-shop.example.dev', undefined, 'http://localhost:3100'],
    ['mail-acme-shop.example.dev', undefined, 'http://localhost:54324'],
    ['studio-acme-shop.example.dev', undefined, 'http://localhost:54323'],
    [undefined, undefined, 'http_status:404'],
  ]);
  assert.throws(() => buildDoc({ project: 'x', paths: [['/a', '1']] }), /app/);
  assert.throws(() => renderYaml({ project: 'Bad.Name', services: [{ name: 'app', url: 'http://localhost:1' }] }));
});

test('interactive prompts (scripted answers)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'burrow-add-'));
  try {
    const answers = ['todo-api', '8080', '/docs', '8081', '', 'metrics', '9100', ''];
    const asked = [];
    const ask = async (q, def = '') => { asked.push(q); const a = answers.shift(); return a === '' ? def : a; };
    const { file } = await add(undefined, { file: join(dir, 'tunnel.yml') }, ask);
    const proj = parseProject(readFileSync(file, 'utf8'));
    assert.equal(proj.project, 'todo-api');
    assert.deepEqual(proj.services.map((s) => [s.name, s.url, s.paths.length]), [
      ['app', 'http://localhost:8080', 1],
      ['metrics', 'http://localhost:9100', 0],
    ]);
    assert.equal(answers.length, 0);
    assert.match(asked[0], /Project name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: non-interactive flags write tunnel.yml and refuse to overwrite', async () => {
  const sb = sandbox();
  try {
    const args = ['add', 'acme-shop', '--app', '3100', '--path', '/auth/v1=54321', '--service', 'mail=54324'];
    let r = await sb.run(args);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /mail-acme-shop\.example\.dev/);
    const proj = parseProject(readFileSync(join(sb.dir, 'tunnel.yml'), 'utf8'));
    assert.deepEqual(proj.services.map((s) => s.name), ['app', 'mail']);

    r = await sb.run(args);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already exists/);
    r = await sb.run([...args, '--force']);
    assert.equal(r.code, 0, r.stderr);

    // piped stdin (not a TTY) without flags must not hang
    r = await sb.run(['add', '-f', 'other.yml']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Not a terminal/);
    r = await sb.run(['add', '-f', 'other.yml', '--yes']);
    assert.match(r.stderr, /--app/);

    // the generated file works with `up --dry-run`
    r = await sb.run(['up', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /burrow-acme-shop/);
  } finally {
    await sb.cleanup();
  }
});
