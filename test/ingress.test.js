import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProject, buildIngress, hostnames, pathRegex } from '../src/project.js';

const example = readFileSync(new URL('../examples/acme-shop.tunnel.yml', import.meta.url), 'utf8');

test('pathRegex anchors plain prefixes and passes regex through', () => {
  assert.equal(pathRegex('/auth/v1'), '^/auth/v1(/.*)?$');
  assert.equal(pathRegex('rest/v1/'), '^/rest/v1(/.*)?$');
  assert.equal(pathRegex('^/api/.*'), '^/api/.*');
  const re = new RegExp(pathRegex('/auth/v1'));
  assert.ok(re.test('/auth/v1'));
  assert.ok(re.test('/auth/v1/token'));
  assert.ok(!re.test('/auth/v10'));
  assert.ok(!re.test('/x/auth/v1'));
});

test('acme-shop example hostnames', () => {
  const proj = parseProject(example);
  assert.deepEqual(hostnames(proj, 'example.dev'), [
    { service: 'app', hostname: 'acme-shop.example.dev' },
    { service: 'mail', hostname: 'mail-acme-shop.example.dev' },
    { service: 'studio', hostname: 'studio-acme-shop.example.dev' },
  ]);
});

test('acme-shop example ingress: path rules first, then hosts, then 404', () => {
  const ingress = buildIngress(parseProject(example), 'example.dev');
  assert.deepEqual(ingress, [
    { hostname: 'acme-shop.example.dev', path: '^/auth/v1(/.*)?$', service: 'http://localhost:54321' },
    { hostname: 'acme-shop.example.dev', path: '^/rest/v1(/.*)?$', service: 'http://localhost:54321' },
    { hostname: 'acme-shop.example.dev', path: '^/storage/v1(/.*)?$', service: 'http://localhost:54321' },
    { hostname: 'acme-shop.example.dev', path: '^/realtime/v1(/.*)?$', service: 'http://localhost:54321' },
    { hostname: 'acme-shop.example.dev', service: 'http://localhost:3100' },
    { hostname: 'mail-acme-shop.example.dev', service: 'http://localhost:54324' },
    { hostname: 'studio-acme-shop.example.dev', service: 'http://localhost:54323' },
    { service: 'http_status:404' },
  ]);
});

test('explicit root flag overrides the "app" convention', () => {
  const proj = parseProject(`project: blog
services:
  - name: web
    root: true
    url: http://localhost:3000
  - name: app
    url: http://localhost:4000
`);
  assert.deepEqual(hostnames(proj, 'example.dev').map((h) => h.hostname), ['blog.example.dev', 'app-blog.example.dev']);
});

test('originRequest is passed through', () => {
  const proj = parseProject(`project: p
services:
  - name: app
    url: https://localhost:8443
    originRequest: { noTLSVerify: true }
`);
  assert.deepEqual(buildIngress(proj, 'example.dev')[0], {
    hostname: 'p.example.dev', service: 'https://localhost:8443', originRequest: { noTLSVerify: true },
  });
});

test('validation errors', () => {
  assert.throws(() => parseProject('services: []'), /project name/);
  assert.throws(() => parseProject('project: p\nservices: []'), /non-empty/);
  assert.throws(() => parseProject('project: p\nservices:\n  - name: app\n'), /url/);
  assert.throws(() => parseProject('project: p\nservices:\n  - {name: app, url: "ftp://x"}\n'), /scheme/);
  assert.throws(
    () => parseProject('project: p\nservices:\n  - {name: mail, url: "http://a"}\n  - {name: mail, url: "http://b"}\n'),
    /duplicate/
  );
});
