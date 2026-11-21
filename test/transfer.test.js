import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanProject } from '../src/transfer.js';
import { sandbox, EXAMPLE } from './helpers/cli.js';

function remember(sb, project, file) {
  writeFileSync(join(sb.state, `${project}.json`), JSON.stringify({ project, file, tunnelId: 'x' }));
}

test('cleanProject drops unknown keys and validates', () => {
  const out = cleanProject({
    project: 'todo-api', token: 'nope', autostart: true,
    services: [{ name: 'app', url: 'http://localhost:8080', password: 'x', paths: [{ path: '/docs', url: 'http://localhost:8081', secret: 1 }] }],
  });
  assert.deepEqual(out, {
    project: 'todo-api', autostart: true,
    services: [{ name: 'app', url: 'http://localhost:8080', paths: [{ path: '/docs', url: 'http://localhost:8081' }] }],
  });
  assert.throws(() => cleanProject({ project: 'Bad.Name', services: [] }));
});

test('export -> import round trip, never includes secrets', async () => {
  const src = sandbox({ extra: { BURROW_DASHBOARD_PASSWORD: 'super-secret-password' } });
  const dst = sandbox();
  try {
    const blog = join(src.dir, 'blog.yml');
    writeFileSync(blog, 'project: blog\nservices:\n  - {name: app, url: "http://localhost:4000"}\n');
    remember(src, 'acme-shop', EXAMPLE);
    remember(src, 'blog', blog);
    writeFileSync(join(src.state, 'share-x1.json'), JSON.stringify({ project: 'share-x1', share: true, file: blog }));

    let r = await src.run(['export']);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /test-token|super-secret|acct-1|CF_API_TOKEN/);
    const bundle = YAML.parse(r.stdout);
    assert.deepEqual(bundle.projects.map((p) => p.project), ['acme-shop', 'blog']);
    assert.equal(bundle.projects[0].services[0].paths[0].path, '/auth/v1');

    const file = join(dst.dir, 'projects.json');
    r = await src.run(['export', file, '--project', 'acme-shop']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).projects.map((p) => p.project), ['acme-shop']);
    r = await src.run(['export', '--project', 'nope']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unknown project/);

    const all = join(dst.dir, 'all.yml');
    writeFileSync(all, (await src.run(['export'])).stdout);
    const into = join(dst.dir, 'imported');
    r = await dst.run(['import', all, '--dir', into, '--dry-run']);
    assert.match(r.stderr, /would write .*acme-shop\.tunnel\.yml/);
    assert.ok(!existsSync(into));
    r = await dst.run(['import', all, '--dir', into]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /2 imported, 0 skipped/);
    assert.ok(existsSync(join(into, 'acme-shop.tunnel.yml')));

    // remembered: `up <project>` works from anywhere now
    r = await dst.run(['up', 'acme-shop', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /mail-acme-shop\.example\.dev/);

    r = await dst.run(['import', all, '--dir', into]);
    assert.match(r.stderr, /0 imported, 2 skipped/);
    r = await dst.run(['import', all, '--dir', into, '--force']);
    assert.match(r.stderr, /2 imported, 0 skipped/);
  } finally {
    await src.cleanup();
    await dst.cleanup();
  }
});

test('import ignores unknown keys and rejects non-bundles', async () => {
  const sb = sandbox();
  try {
    const evil = join(sb.dir, 'evil.yml');
    writeFileSync(evil, YAML.stringify({
      burrow: 'projects', version: 1, CF_API_TOKEN: 'leak',
      projects: [{ project: 'pixel-notes', token: 'leak', services: [{ name: 'app', url: 'http://localhost:5173', apiKey: 'leak' }] }],
    }));
    let r = await sb.run(['import', evil, '--dir', join(sb.dir, 'p')]);
    assert.equal(r.code, 0, r.stderr);
    const written = readFileSync(join(sb.dir, 'p', 'pixel-notes.tunnel.yml'), 'utf8');
    assert.doesNotMatch(written, /leak|token|apiKey/);

    const bad = join(sb.dir, 'bad.yml');
    writeFileSync(bad, 'project: acme-shop\nservices: []\n');
    r = await sb.run(['import', bad]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a burrow export/);
  } finally {
    await sb.cleanup();
  }
});
