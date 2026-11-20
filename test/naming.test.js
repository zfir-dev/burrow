import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostnameFor, tunnelName, recordComment, tunnelTarget } from '../src/naming.js';

test('root service uses <project>.<domain>', () => {
  assert.equal(hostnameFor('acme-shop', { name: 'app', root: true }, 'example.dev'), 'acme-shop.example.dev');
});

test('sub-services use flat <service>-<project>.<domain>', () => {
  assert.equal(hostnameFor('acme-shop', { name: 'mail' }, 'example.dev'), 'mail-acme-shop.example.dev');
  assert.equal(hostnameFor('acme-shop', { name: 'studio' }, 'example.dev'), 'studio-acme-shop.example.dev');
});

test('rejects dotted or invalid labels (would need deeper certs)', () => {
  assert.throws(() => hostnameFor('ink.tion', { name: 'app', root: true }, 'example.dev'));
  assert.throws(() => hostnameFor('acme-shop', { name: 'mail.x' }, 'example.dev'));
  assert.throws(() => hostnameFor('AcmeShop', { name: 'app', root: true }, 'example.dev'));
  assert.throws(() => hostnameFor('acme-shop', { name: '-mail' }, 'example.dev'));
});

test('requires a domain', () => {
  assert.throws(() => hostnameFor('acme-shop', { name: 'app', root: true }, ''), /BURROW_DOMAIN/);
});

test('rejects labels over 63 chars', () => {
  assert.throws(() => hostnameFor('p'.repeat(40), { name: 's'.repeat(30) }, 'example.dev'), /63/);
});

test('tunnel name, comment tag and target', () => {
  assert.equal(tunnelName('acme-shop'), 'burrow-acme-shop');
  assert.equal(recordComment('acme-shop'), 'burrow:acme-shop');
  assert.equal(tunnelTarget('abc'), 'abc.cfargotunnel.com');
});
