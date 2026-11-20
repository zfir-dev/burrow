import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostnameFor, tunnelName, recordComment, tunnelTarget } from '../src/naming.js';

test('root service uses <project>.<domain>', () => {
  assert.equal(hostnameFor('inktion', { name: 'app', root: true }, 'example.dev'), 'inktion.example.dev');
});

test('sub-services use flat <service>-<project>.<domain>', () => {
  assert.equal(hostnameFor('inktion', { name: 'mail' }, 'example.dev'), 'mail-inktion.example.dev');
  assert.equal(hostnameFor('inktion', { name: 'studio' }, 'example.dev'), 'studio-inktion.example.dev');
});

test('rejects dotted or invalid labels (would need deeper certs)', () => {
  assert.throws(() => hostnameFor('ink.tion', { name: 'app', root: true }, 'example.dev'));
  assert.throws(() => hostnameFor('inktion', { name: 'mail.x' }, 'example.dev'));
  assert.throws(() => hostnameFor('InkTion', { name: 'app', root: true }, 'example.dev'));
  assert.throws(() => hostnameFor('inktion', { name: '-mail' }, 'example.dev'));
});

test('requires a domain', () => {
  assert.throws(() => hostnameFor('inktion', { name: 'app', root: true }, ''), /BURROW_DOMAIN/);
});

test('rejects labels over 63 chars', () => {
  assert.throws(() => hostnameFor('p'.repeat(40), { name: 's'.repeat(30) }, 'example.dev'), /63/);
});

test('tunnel name, comment tag and target', () => {
  assert.equal(tunnelName('inktion'), 'burrow-inktion');
  assert.equal(recordComment('inktion'), 'burrow:inktion');
  assert.equal(tunnelTarget('abc'), 'abc.cfargotunnel.com');
});
